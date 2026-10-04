import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const TARGETS = [
  { key: 'n1::api-https', node: 'n1', kind: 'api', label: 'api-https', url: 'https://a.test:3001' },
  { key: 'n1::peer', node: 'n1', kind: 'peer', label: 'peer', host: 'a.test', port: 7900 },
];

const emptyState = () => ({ version: 1, updatedAt: null, lastWeeklySummaryAt: '2026-10-04T12:00:00.000Z', targets: {} });

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
      dispatch: async () => ({ channels: 1, delivered: 1 }),
      now: () => new Date('2026-10-04T13:00:00.000Z'),
      logger: silentLogger,
      env: {},
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

test('通知先が未設定（channels 0）なら 0 を返し state を書く', async () => {
  const { written, overrides } = deps({
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }),
    dispatch: async () => ({ channels: 0, delivered: 0 }),
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written.length, 1);
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

test('イベントが無ければ dispatch を呼ばずに state を書く', async () => {
  let called = false;
  const { written, overrides } = deps({
    dispatch: async () => { called = true; return { channels: 0, delivered: 0 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(called, false);
  assert.equal(written.length, 1);
});
