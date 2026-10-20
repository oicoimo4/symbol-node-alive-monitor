import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHarvesters } from '../src/checks/harvesters.js';

const TARGET = {
  key: 'n1::harvesters', node: 'n1', kind: 'harvesters',
  label: 'harvesters', url: 'https://example.com:3001',
};

const UNLOCKED_URL = 'https://example.com:3001/node/unlockedaccount';

const noSleep = async () => {};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** 毎回同じ応答を返し、呼ばれた URL を記録する fetch のモックを作る。 */
function mockFetch(response) {
  const calls = [];
  const impl = async (url) => { calls.push(url); return response; };
  return { impl, calls };
}

test('一覧をソートして返す', async () => {
  const { impl, calls } = mockFetch(jsonResponse(200, { unlockedAccount: ['CC', 'AA', 'BB'] }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(result, {
    key: 'n1::harvesters', node: 'n1', label: 'harvesters',
    ok: true, reason: null, detail: 'harvester 3 件', accounts: ['AA', 'BB', 'CC'],
  });
  assert.deepEqual(calls, [UNLOCKED_URL]);
});

test('重複は 1 件として数える', async () => {
  const { impl } = mockFetch(jsonResponse(200, { unlockedAccount: ['BB', 'AA', 'BB'] }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(result.accounts, ['AA', 'BB']);
  assert.equal(result.detail, 'harvester 2 件');
});

test('空の一覧も成功として扱う', async () => {
  // 委任が 1 件も無いのは正常な状態。失敗扱いにすると全員の離脱を検知できない
  const { impl } = mockFetch(jsonResponse(200, { unlockedAccount: [] }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, true);
  assert.deepEqual(result.accounts, []);
});

test('2xx でなければ bad-response になり 3 回試行する', async () => {
  const { impl, calls } = mockFetch(jsonResponse(404, { code: 'ResourceNotFound' }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-response');
  assert.equal(result.accounts, null);
  assert.match(result.detail, /404/);
  assert.equal(calls.length, 3);
});

test('応答が JSON でなければ bad-response になる', async () => {
  const impl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'bad-response');
  assert.equal(result.accounts, null);
});

test('unlockedAccount が文字列の配列でなければ bad-response になる', async () => {
  for (const body of [{}, null, { unlockedAccount: 'AA' }, { unlockedAccount: ['AA', 1] }]) {
    const { impl } = mockFetch(jsonResponse(200, body));
    const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
    assert.equal(result.reason, 'bad-response', `body: ${JSON.stringify(body)}`);
    assert.equal(result.accounts, null);
  }
});

test('接続できなければ unreachable になり 3 回試行する', async () => {
  let calls = 0;
  const impl = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'unreachable');
  assert.equal(calls, 3);
  assert.match(result.detail, /ECONNREFUSED/);
});

test('応答が遅ければタイムアウトして unreachable になる', async () => {
  // 1 秒後に応答する遅いノード。signal で中断されなければ成功してしまい、テストが落ちる。
  // AbortSignal.timeout のタイマーはイベントループを保持しないので、
  // 応答側のタイマーで保持しておかないとテストが途中で打ち切られる。
  const impl = (_url, { signal }) => new Promise((resolve, reject) => {
    const late = setTimeout(() => resolve(jsonResponse(200, { unlockedAccount: [] })), 1_000);
    signal.addEventListener('abort', () => { clearTimeout(late); reject(signal.reason); });
  });
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep, timeoutMs: 10 });
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /timeout/i);
});
