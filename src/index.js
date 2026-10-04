import { pathToFileURL } from 'node:url';
import { loadConfig as defaultLoadConfig } from './config.js';
import { readState as defaultReadState, writeState as defaultWriteState } from './state.js';
import { evaluate as defaultEvaluate } from './evaluate.js';
import { checkApi as defaultCheckApi } from './checks/api.js';
import { checkPeer as defaultCheckPeer } from './checks/peer.js';
import { dispatch as defaultDispatch } from './notify/index.js';

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

  const prevState = await readState(statePath, { logger });

  const settled = await Promise.allSettled(
    targets.map((target) =>
      target.kind === 'api'
        ? checkApi(target, { lastHeight: prevState.targets[target.key]?.lastHeight ?? null })
        : checkPeer(target)),
  );

  // 1件の検査が予期せず例外を投げても、他の対象の結果と state 更新を道連れにしない。
  // Promise.all だと fail-fast で全滅し、壊れた state が残り続けて監視が永久に死ぬ。
  const results = settled.map((outcome, index) =>
    (outcome.status === 'fulfilled' ? outcome.value : crashedResult(targets[index], outcome.reason)));

  const { nextState, events } = evaluate({ prevState, results, now: now() });

  const downCount = results.filter((r) => !r.ok).length;
  logger.log(`監視対象 ${results.length} 件を検査しました（異常 ${downCount} 件、通知 ${events.length} 件）`);

  if (events.length > 0) {
    const { channels, delivered } = await dispatch(events, {
      discordUrl: env.DISCORD_WEBHOOK_URL,
      slackUrl: env.SLACK_WEBHOOK_URL,
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
