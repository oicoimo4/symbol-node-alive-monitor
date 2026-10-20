import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';
import { evaluate as realEvaluate } from '../src/evaluate.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const TARGETS = [
  { key: 'n1::api-https', node: 'n1', kind: 'api', label: 'api-https', url: 'https://a.test:3001' },
  { key: 'n1::peer', node: 'n1', kind: 'peer', label: 'peer', host: 'a.test', port: 7900 },
];

const emptyState = () => ({ version: 1, updatedAt: null, lastWeeklySummaryAt: '2026-10-04T12:00:00.000Z', targets: {} });

const HARVESTER_TARGET = { key: 'n1::harvesters', node: 'n1', kind: 'harvesters', label: 'harvesters', url: 'https://a.test:3001' };

/** 指定した一覧を返す checkHarvesters のモックを作る。 */
const harvested = (accounts) => async (target) => ({
  key: target.key, node: target.node, label: target.label,
  ok: true, reason: null, detail: `harvester ${accounts.length} 件`, accounts,
});

/** harvester の前回記録を持つ state を返す readState のモックを作る。 */
const withHarvesters = (harvesters, over = {}) => async () => ({ ...emptyState(), harvesters, ...over });

/** すべての依存をモックした main の既定引数を作る。 */
function deps(over = {}) {
  const written = [];
  return {
    written,
    overrides: {
      loadConfig: async () => TARGETS,
      readState: async () => emptyState(),
      writeState: async (_path, state) => { written.push(state); },
      checkApi: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: '正常', height: '200' }),
      checkPeer: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: '正常', height: null }),
      checkHarvesters: harvested([]),
      dispatch: async () => ({ channels: 1, delivered: 1 }),
      now: () => new Date('2026-10-04T13:00:00.000Z'),
      logger: silentLogger,
      env: { DISCORD_WEBHOOK_URL: 'https://d.test' },
      ...over,
    },
  };
}

test('全て正常なら 0 を返し state を書く', async () => {
  const { written, overrides } = deps();
  assert.equal(await main(overrides), 0);
  assert.equal(written.length, 1);
  assert.equal(written[0].targets['n1::api-https'].lastHeight, '200');
  assert.equal(written[0].targets['n1::peer'].status, 'up');
});

test('kind に応じて checkApi と checkPeer を使い分ける', async () => {
  const seen = { api: [], peer: [] };
  const { overrides } = deps({
    checkApi: async (target) => { seen.api.push(target.key); return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: '200' }; },
    checkPeer: async (target) => { seen.peer.push(target.key); return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: null }; },
  });
  await main(overrides);
  assert.deepEqual(seen, { api: ['n1::api-https'], peer: ['n1::peer'] });
});

test('前回の lastHeight が checkApi に渡される', async () => {
  let passed;
  const { overrides } = deps({
    readState: async () => ({
      ...emptyState(),
      targets: { 'n1::api-https': { status: 'up', consecutiveFailures: 0, lastHeight: '150', lastOkAt: null, downSince: null, notified: false, incidentsThisWeek: 0 } },
    }),
    checkApi: async (target, opts) => { passed = opts.lastHeight; return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: '200' }; },
  });
  await main(overrides);
  assert.equal(passed, '150');
});

/** lastOkAt だけ差し替えた、正常な api ターゲットの state を作る。 */
const okStateAt = (lastOkAt) => ({
  status: 'up', consecutiveFailures: 0, lastHeight: '150',
  lastOkAt, downSince: null, notified: false, incidentsThisWeek: 0,
});

test('前回の正常取得から間がない場合はチェーン高の判定を見送る', async () => {
  let passed = 'UNSET';
  const { overrides } = deps({
    // now は 13:00:00。その 30 秒前 = 最小間隔 90 秒に満たない
    readState: async () => ({ ...emptyState(), targets: { 'n1::api-https': okStateAt('2026-10-04T12:59:30.000Z') } }),
    checkApi: async (target, opts) => {
      passed = opts.lastHeight;
      return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: '200' };
    },
  });
  await main(overrides);
  assert.equal(passed, null);
});

test('前回の正常取得から十分経っていればチェーン高を判定する', async () => {
  let passed = 'UNSET';
  const { overrides } = deps({
    readState: async () => ({ ...emptyState(), targets: { 'n1::api-https': okStateAt('2026-10-04T12:55:00.000Z') } }),
    checkApi: async (target, opts) => {
      passed = opts.lastHeight;
      return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: '200' };
    },
  });
  await main(overrides);
  assert.equal(passed, '150');
});

test('lastOkAt が壊れている場合はチェーン高の判定を見送る', async () => {
  let passed = 'UNSET';
  const { overrides } = deps({
    readState: async () => ({ ...emptyState(), targets: { 'n1::api-https': okStateAt('garbage') } }),
    checkApi: async (target, opts) => {
      passed = opts.lastHeight;
      return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: '200' };
    },
  });
  await main(overrides);
  assert.equal(passed, null);
});

test('ノードが落ちていても終了コードは 0', async () => {
  const { overrides } = deps({
    checkApi: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: false, reason: 'unreachable', detail: 'ng', height: null }),
    checkPeer: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: false, reason: 'unreachable', detail: 'ng', height: null }),
  });
  assert.equal(await main(overrides), 0);
});

test('設定が読めなければ 1 を返し state を書かない', async () => {
  const { written, overrides } = deps({
    loadConfig: async () => { throw new Error('config: 壊れています'); },
  });
  assert.equal(await main(overrides), 1);
  assert.equal(written.length, 0);
});

test('通知先がありながら全て送信失敗なら 1 を返し state を書かない', async () => {
  const { written, overrides } = deps({
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }), // サマリを発火させる
    dispatch: async () => ({ channels: 2, delivered: 0 }),
  });
  assert.equal(await main(overrides), 1);
  assert.equal(written.length, 0);
});

test('通知先が未設定なら検査せず 1 を返し state を書かない', async () => {
  let checked = false;
  const { written, overrides } = deps({
    env: {},
    checkApi: async () => { checked = true; throw new Error('呼ばれてはいけない'); },
    checkPeer: async () => { checked = true; throw new Error('呼ばれてはいけない'); },
  });
  assert.equal(await main(overrides), 1);
  assert.equal(checked, false);
  assert.equal(written.length, 0);
});

test('DRY_RUN なら通知先が無くても 0 を返すが state は書かない', async () => {
  let dispatched = false;
  const { written, overrides } = deps({
    env: { DRY_RUN: '1' },
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }),
    dispatch: async () => { dispatched = true; return { channels: 0, delivered: 0 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(dispatched, false);
  assert.equal(written.length, 0);
});

test('Webhook URL を環境変数から dispatch に渡す', async () => {
  let received;
  const { overrides } = deps({
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }),
    env: { DISCORD_WEBHOOK_URL: 'https://d.test', SLACK_WEBHOOK_URL: 'https://s.test' },
    dispatch: async (_events, opts) => { received = opts; return { channels: 2, delivered: 2 }; },
  });
  await main(overrides);
  assert.equal(received.discordUrl, 'https://d.test');
  assert.equal(received.slackUrl, 'https://s.test');
});

test('検査が例外を投げても他の対象を巻き込まず state を書く', async () => {
  const { written, overrides } = deps({
    checkApi: async () => { throw new Error('BigInt 変換に失敗'); },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written.length, 1);
  // 例外を投げた対象は異常として記録される（黙殺しない）
  assert.equal(written[0].targets['n1::api-https'].consecutiveFailures, 1);
  // 正常だった対象は巻き込まれない
  assert.equal(written[0].targets['n1::peer'].status, 'up');
  assert.equal(written[0].targets['n1::peer'].lastOkAt, '2026-10-04T13:00:00.000Z');
});

test('通知が1件でも届けば 0 を返し state を書く', async () => {
  const { written, overrides } = deps({
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }),
    dispatch: async () => ({ channels: 2, delivered: 1 }),
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written.length, 1);
  assert.equal(written[0].lastWeeklySummaryAt, '2026-10-04T13:00:00.000Z');
});

test('障害が通知され state に notified が残る', async () => {
  const down = {
    status: 'up', consecutiveFailures: 1, lastHeight: '150',
    lastOkAt: '2026-10-04T12:00:00.000Z', downSince: '2026-10-04T12:50:00.000Z',
    notified: false, incidentsThisWeek: 0,
  };
  let sent = null;
  const { written, overrides } = deps({
    readState: async () => ({ ...emptyState(), targets: { 'n1::api-https': down } }),
    checkApi: async (target) => ({
      key: target.key, node: target.node, label: target.label,
      ok: false, reason: 'health-down', detail: '/node/health が異常です', height: null,
    }),
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });

  assert.equal(await main(overrides), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'down');
  assert.equal(sent[0].key, 'n1::api-https');
  assert.equal(sent[0].downSince, '2026-10-04T12:50:00.000Z');
  assert.equal(written.length, 1);
  assert.equal(written[0].targets['n1::api-https'].notified, true);
  assert.equal(written[0].targets['n1::api-https'].status, 'down');
});

test('イベントが無ければ dispatch を呼ばずに state を書く', async () => {
  let called = false;
  const { written, overrides } = deps({
    dispatch: async () => { called = true; return { channels: 0, delivered: 0 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(called, false);
  assert.equal(written.length, 1);
});

test('harvesters の対象は evaluate に渡さず、死活監視の state も作らない', async () => {
  let evaluatedKeys;
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    checkHarvesters: harvested(['AA']),
    evaluate: (args) => {
      evaluatedKeys = args.results.map((r) => r.key);
      return realEvaluate(args);
    },
  });
  // readState は harvesters を持たない、harvester 監視を入れる前の形の state を返す
  assert.equal(await main(overrides), 0);
  assert.deepEqual(evaluatedKeys, ['n1::api-https', 'n1::peer']);
  assert.equal('n1::harvesters' in written[0].targets, false);
  assert.deepEqual(written[0].harvesters, {
    n1: { accounts: ['AA'], observedAt: '2026-10-04T13:00:00.000Z' },
  });
});

test('harvesters の対象が混ざっていても、例外を投げた検査は正しい対象に紐づく', async () => {
  const { written, overrides } = deps({
    // harvesters を先頭に置き、設定上の並びと死活監視の対象の並びで添字がずれる状況を作る
    loadConfig: async () => [HARVESTER_TARGET, ...TARGETS],
    checkPeer: async () => { throw new Error('想定外の例外'); },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written[0].targets['n1::peer'].consecutiveFailures, 1);
  assert.equal(written[0].targets['n1::api-https'].consecutiveFailures, 0);
  assert.equal('n1::harvesters' in written[0].targets, false);
});

test('harvester が増えたら通知し、state に新しい一覧を残す', async () => {
  let sent = null;
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkHarvesters: harvested(['AA', 'BB']),
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'harvesters');
  assert.deepEqual(sent[0].added, ['BB']);
  assert.deepEqual(written[0].harvesters.n1.accounts, ['AA', 'BB']);
});

test('api が異常なノードでは harvester を比較せず、前回の一覧を残す', async () => {
  let sent = [];
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA', 'BB'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkApi: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: false, reason: 'health-down', detail: 'ng', height: null }),
    // ノードの不調で空の一覧が返ってきた状況
    checkHarvesters: harvested([]),
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.deepEqual(sent.filter((e) => e.type === 'harvesters'), []);
  assert.deepEqual(written[0].harvesters.n1, { accounts: ['AA', 'BB'], observedAt: '2026-10-04T12:00:00.000Z' });
});

test('harvester の取得が例外を投げても、他の検査と state の更新を巻き込まない', async () => {
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkHarvesters: async () => { throw new Error('想定外の例外'); },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written[0].targets['n1::api-https'].status, 'up');
  assert.deepEqual(written[0].harvesters.n1, { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' });
});

test('週次サマリに今回確認した harvester の件数が載る', async () => {
  let sent = null;
  const { overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({}, { lastWeeklySummaryAt: null }),
    checkHarvesters: harvested(['AA', 'BB']),
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });
  assert.equal(await main(overrides), 0);
  const summary = sent.find((e) => e.type === 'summary');
  assert.deepEqual(summary.harvesters, [{ node: 'n1', count: 2, observedAt: '2026-10-04T13:00:00.000Z' }]);
});

test('一覧を一度も取得できていないノードも週次サマリに未取得として載る', async () => {
  let sent = null;
  const { overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({}, { lastWeeklySummaryAt: null }),
    checkHarvesters: async () => { throw new Error('想定外の例外'); },
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });
  assert.equal(await main(overrides), 0);
  const summary = sent.find((e) => e.type === 'summary');
  assert.deepEqual(summary.harvesters, [{ node: 'n1', count: null, observedAt: null }]);
});

test('harvester の変化を 1 件も届けられなければ state を更新せず次回に持ち越す', async () => {
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkHarvesters: harvested(['AA', 'BB']),
    dispatch: async () => ({ channels: 1, delivered: 0 }),
  });
  assert.equal(await main(overrides), 1);
  assert.equal(written.length, 0);
});
