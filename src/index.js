import { pathToFileURL } from 'node:url';
import { loadConfig as defaultLoadConfig } from './config.js';
import { readState as defaultReadState, writeState as defaultWriteState } from './state.js';
import { evaluate as defaultEvaluate } from './evaluate.js';
import { checkApi as defaultCheckApi } from './checks/api.js';
import { checkPeer as defaultCheckPeer } from './checks/peer.js';
import { checkHarvesters as defaultCheckHarvesters } from './checks/harvesters.js';
import { annotateSummary, evaluateHarvesters, gateByApiHealth } from './harvesters.js';
import { dispatch as defaultDispatch } from './notify/index.js';

/**
 * チェーン高の進行を判定するのに必要な最小間隔。
 * Symbol は約 30 秒で 1 ブロックなので、これを下回る間隔で比較しても意味がない。
 */
export const MIN_STALL_INTERVAL_MS = 90_000;

/**
 * チェーン高の進行判定に使える「前回値」を返す。使えない場合は null。
 *
 * 前回の正常取得から間がないと、まだ 1 ブロックも生成されていないことがある。
 * その状態で height を比較すると、正常なノードを chain-stalled と誤判定する。
 * cron の遅延で実行が詰まり、前の実行の直後に次が走るときに起きる。
 * 間隔が短すぎる場合は進行判定だけを見送る（疎通とヘルスチェックは通常どおり行う）。
 *
 * 本当に停止しているノードは失敗時に lastOkAt が更新されないため、
 * 2 回目以降は間隔が開き、通常どおり検知される。
 */
function comparableHeight(targetState, now) {
  if (!targetState?.lastHeight) return null;
  if (!targetState.lastOkAt) return targetState.lastHeight;

  const elapsed = now.getTime() - Date.parse(targetState.lastOkAt);
  // lastOkAt が壊れていて計算できない場合も、誤検知しない側に倒す。
  return Number.isFinite(elapsed) && elapsed >= MIN_STALL_INTERVAL_MS ? targetState.lastHeight : null;
}

/**
 * 1回分の監視を実行し、プロセスの終了コードを返す。
 * 依存はすべて引数で差し替えられるようにしてある（テストでネットワークを使わないため）。
 */
export async function main(overrides = {}) {
  const {
    loadConfig = defaultLoadConfig,
    readState = defaultReadState,
    writeState = defaultWriteState,
    evaluate = defaultEvaluate,
    checkApi = defaultCheckApi,
    checkPeer = defaultCheckPeer,
    checkHarvesters = defaultCheckHarvesters,
    dispatch = defaultDispatch,
    now = () => new Date(),
    logger = console,
    env = process.env,
  } = overrides;

  const configPath = env.CONFIG_PATH ?? 'config/nodes.json';
  const statePath = env.STATE_PATH ?? 'state.json';

  let targets;
  try {
    targets = await loadConfig(configPath);
  } catch (err) {
    logger.error(`設定の読み込みに失敗しました (${configPath}): ${err.message}`);
    return 1;
  }

  const discordUrl = env.DISCORD_WEBHOOK_URL;
  const slackUrl = env.SLACK_WEBHOOK_URL;
  const dryRun = env.DRY_RUN === '1';

  if (!discordUrl && !slackUrl && !dryRun) {
    logger.error(
      '通知先が1つも設定されていません。DISCORD_WEBHOOK_URL か SLACK_WEBHOOK_URL の'
      + '少なくとも一方を設定してください。通知できないまま state を更新すると、'
      + '未送信の通知が「送信済み」として消費され、後から Secret を設定しても'
      + '二度と送られません。検査を行わずに終了します。'
      + '（送信せずに動作確認したい場合は DRY_RUN=1 を指定してください）',
    );
    return 1;
  }

  const prevState = await readState(statePath, { logger });
  const startedAt = now();

  // harvester は障害の監視対象ではない。evaluate に渡すと targets にエントリが作られ、
  // DOWN 判定の対象になってしまうため、ここで振り分けて別の経路で扱う。
  const liveness = targets.filter((target) => target.kind !== 'harvesters');
  const harvesterTargets = targets.filter((target) => target.kind === 'harvesters');

  const [settled, harvesterSettled] = await Promise.all([
    Promise.allSettled(
      liveness.map((target) =>
        (target.kind === 'api'
          ? checkApi(target, { lastHeight: comparableHeight(prevState.targets[target.key], startedAt) })
          : checkPeer(target))),
    ),
    Promise.allSettled(harvesterTargets.map((target) => checkHarvesters(target))),
  ]);

  // 1件の検査が予期せず例外を投げても、他の対象の結果と state 更新を道連れにしない。
  // Promise.all だと fail-fast で全滅し、壊れた state が残り続けて監視が永久に死ぬ。
  // 添字は振り分け後の配列のものなので、targets ではなく liveness / harvesterTargets を引くこと。
  const results = settled.map((outcome, index) =>
    (outcome.status === 'fulfilled' ? outcome.value : crashedResult(liveness[index], outcome.reason)));
  const observations = harvesterSettled.map((outcome, index) =>
    (outcome.status === 'fulfilled'
      ? outcome.value
      : crashedObservation(harvesterTargets[index], outcome.reason)));

  const { nextState: livenessState, events: livenessEvents } = evaluate({ prevState, results, now: startedAt });
  const { nextHarvesters, events: harvesterEvents } = evaluateHarvesters({
    prevHarvesters: prevState.harvesters ?? {},
    observations: gateByApiHealth(observations, results),
    now: startedAt,
  });

  // evaluate は harvester を知らないので、state とサマリにはここで合流させる。
  const nextState = { ...livenessState, harvesters: nextHarvesters };
  const harvesterNodes = harvesterTargets.map((target) => target.node);
  const events = [...annotateSummary(livenessEvents, nextHarvesters, harvesterNodes), ...harvesterEvents];

  const downCount = results.filter((r) => !r.ok).length;
  logger.log(`監視対象 ${results.length} 件を検査しました（異常 ${downCount} 件、通知 ${events.length} 件）`);
  for (const observation of observations) {
    if (!observation.ok) {
      logger.warn(`harvester の一覧を取得できませんでした (${observation.node}): ${observation.detail}`);
    }
  }

  if (dryRun) {
    logger.warn(`DRY_RUN: ${events.length} 件のイベントを送信せず、state も保存しません`);
    for (const event of events) {
      logger.log(`  ${event.type}: ${event.key ?? 'summary'} — ${event.detail}`);
    }
    return 0;
  }

  if (events.length > 0) {
    const { channels, delivered } = await dispatch(events, {
      discordUrl,
      slackUrl,
      logger,
    });

    // 送信先があるのに1つも届かなかった場合は state を更新しない。
    // notified が立たないまま次回実行に持ち越し、通知を再試行させる。
    if (channels > 0 && delivered === 0) {
      logger.error('すべての通知先への送信に失敗したため state を更新せず終了します');
      return 1;
    }
  }

  await writeState(statePath, nextState);
  return 0;
}

/**
 * 検査そのものが例外で落ちたときの合成結果。
 * 握りつぶさず異常として扱うので、2回続けば通知が飛び、detail に例外内容が載る。
 * 監視自体の不具合を無言にしないための判断。
 */
function crashedResult(target, error) {
  return {
    key: target.key,
    node: target.node,
    label: target.label,
    ok: false,
    reason: 'bad-response',
    detail: `検査が例外で失敗しました: ${error?.message ?? error}`,
    height: null,
  };
}

/**
 * harvester の取得そのものが例外で落ちたときの合成結果。
 * 失敗した観測として扱い、前回の一覧を保持させる（比較して誤報を出さないため）。
 */
function crashedObservation(target, error) {
  return {
    key: target.key,
    node: target.node,
    label: target.label,
    ok: false,
    reason: 'bad-response',
    detail: `検査が例外で失敗しました: ${error?.message ?? error}`,
    accounts: null,
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`想定外のエラーで終了しました: ${err.stack ?? err.message}`);
      process.exit(1);
    });
}
