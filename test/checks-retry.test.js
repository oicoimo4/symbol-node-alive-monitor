import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_ATTEMPTS, TIMEOUT_MS, withRetry } from '../src/checks/retry.js';

const noSleep = async () => {};

test('試行回数の既定値は 3 である', () => {
  assert.equal(RETRY_ATTEMPTS, 3);
});

test('タイムアウトの既定値は 10000ms である', () => {
  assert.equal(TIMEOUT_MS, 10_000);
});

test('1回目で成功すればそれ以上呼ばない', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: true, reason: null, detail: 'ok', height: null }; };
  const result = await withRetry(probe, { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test('unreachable は最大 3 回まで再試行する', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: false, reason: 'unreachable', detail: 'ng', height: null }; };
  const result = await withRetry(probe, { sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
});

test('再試行の途中で成功すればそこで止まる', async () => {
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return calls < 2
      ? { ok: false, reason: 'unreachable', detail: 'ng', height: null }
      : { ok: true, reason: null, detail: 'ok', height: null };
  };
  const result = await withRetry(probe, { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('chain-stalled は再試行しない', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: false, reason: 'chain-stalled', detail: 'ng', height: '1' }; };
  await withRetry(probe, { sleep: noSleep });
  assert.equal(calls, 1);
});

test('health-down は再試行しない', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: false, reason: 'health-down', detail: 'ng', height: null }; };
  await withRetry(probe, { sleep: noSleep });
  assert.equal(calls, 1);
});

test('再試行の間に指定した待ち時間で sleep する', async () => {
  const waited = [];
  const probe = async () => ({ ok: false, reason: 'unreachable', detail: 'ng', height: null });
  await withRetry(probe, { sleep: async (ms) => { waited.push(ms); }, delayMs: 5000 });
  // 3回試行なので sleep は 2回
  assert.deepEqual(waited, [5000, 5000]);
});
