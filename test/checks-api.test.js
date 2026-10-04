import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApi } from '../src/checks/api.js';

const TARGET = {
  key: 'n1::api-https', node: 'n1', kind: 'api',
  label: 'api-https', url: 'https://example.com:3001',
};

const noSleep = async () => {};

/** URL ごとに応答を返す fetch のモックを作る。 */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`想定外の URL: ${url}`);
    if (typeof route === 'function') return route();
    return route;
  };
  return { impl, calls };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const HEALTH_URL = 'https://example.com:3001/node/health';
const CHAIN_URL = 'https://example.com:3001/chain/info';

const healthyRoutes = (height) => ({
  [HEALTH_URL]: jsonResponse(200, { status: { apiNode: 'up', db: 'up' } }),
  [CHAIN_URL]: jsonResponse(200, { height }),
});

test('health が up で height が進んでいれば成功する', async () => {
  const { impl } = mockFetch(healthyRoutes('200'));
  const result = await checkApi(TARGET, { lastHeight: '100', fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(result, {
    key: 'n1::api-https', node: 'n1', label: 'api-https',
    ok: true, reason: null, detail: '正常 (height=200)', height: '200',
  });
});

test('初回（lastHeight が null）は進行チェックをせず成功する', async () => {
  const { impl } = mockFetch(healthyRoutes('200'));
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(result.height, '200');
});

test('height が前回と同じなら chain-stalled になる', async () => {
  const { impl } = mockFetch(healthyRoutes('100'));
  const result = await checkApi(TARGET, { lastHeight: '100', fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'chain-stalled');
  assert.match(result.detail, /100/);
});

test('height が巻き戻っていても chain-stalled になる', async () => {
  const { impl } = mockFetch(healthyRoutes('99'));
  const result = await checkApi(TARGET, { lastHeight: '100', fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'chain-stalled');
});

test('height は文字列比較ではなく数値として比較される', async () => {
  // 文字列比較だと "9" > "10" となり誤判定する
  const { impl } = mockFetch(healthyRoutes('10'));
  const result = await checkApi(TARGET, { lastHeight: '9', fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, true);
});

test('lastHeight が十進数字列でなければ進行チェックをスキップする', async () => {
  for (const bad of ['abc', '0x10', '12.5', true, {}]) {
    const { impl } = mockFetch(healthyRoutes('100'));
    const result = await checkApi(TARGET, { lastHeight: bad, fetchImpl: impl, sleep: noSleep });
    assert.equal(result.ok, true, `bad lastHeight: ${JSON.stringify(bad)}`);
  }
});

test('apiNode が down なら health-down になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(503, { status: { apiNode: 'down', db: 'up' } }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'health-down');
});

test('db が down なら health-down になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(503, { status: { apiNode: 'up', db: 'down' } }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'health-down');
});

test('health が 2xx でなければ health-down になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(500, { status: { apiNode: 'up', db: 'up' } }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'health-down');
});

test('health が異常なら chain/info は呼ばない', async () => {
  const { impl, calls } = mockFetch({
    [HEALTH_URL]: jsonResponse(503, { status: { apiNode: 'down', db: 'up' } }),
  });
  await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(calls, [HEALTH_URL]);
});

test('接続できなければ unreachable になり 3 回試行する', async () => {
  let calls = 0;
  const impl = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'unreachable');
  assert.equal(calls, 3);
  assert.match(result.detail, /ECONNREFUSED/);
});

test('応答が JSON でなければ bad-response になる', async () => {
  const impl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'bad-response');
});

test('height が数字文字列でなければ bad-response になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(200, { status: { apiNode: 'up', db: 'up' } }),
    [CHAIN_URL]: jsonResponse(200, { height: 12345 }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'bad-response');
});

test('health-down は再試行しない', async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return jsonResponse(503, { status: { apiNode: 'down', db: 'up' } });
  };
  await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(calls, 1);
});
