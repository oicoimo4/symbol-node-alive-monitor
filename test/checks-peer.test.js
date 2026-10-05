import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkPeer } from '../src/checks/peer.js';

const TARGET = { key: 'n1::peer', node: 'n1', kind: 'peer', label: 'peer', host: 'example.com', port: 7900 };

const noSleep = async () => {};

/** net.Socket の最小限の代用品。`behavior` で発火させるイベントを決める。 */
class FakeSocket extends EventEmitter {
  constructor(behavior) {
    super();
    this.destroyed = false;
    this.timeoutMs = null;
    queueMicrotask(() => behavior(this));
  }

  setTimeout(ms) {
    this.timeoutMs = ms;
  }

  destroy() {
    this.destroyed = true;
  }
}

const connecting = () => (socket) => socket.emit('connect');
const timingOut = () => (socket) => socket.emit('timeout');
const erroring = (message) => (socket) => socket.emit('error', new Error(message));

test('接続できれば成功する', async () => {
  const result = await checkPeer(TARGET, { connectImpl: () => new FakeSocket(connecting()), sleep: noSleep });
  assert.deepEqual(result, {
    key: 'n1::peer', node: 'n1', label: 'peer',
    ok: true, reason: null,
    detail: 'TCP example.com:7900 に接続できました', height: null,
  });
});

test('接続先の host と port が渡される', async () => {
  let received = null;
  await checkPeer(TARGET, {
    connectImpl: (opts) => { received = opts; return new FakeSocket(connecting()); },
    sleep: noSleep,
  });
  assert.deepEqual(received, { host: 'example.com', port: 7900 });
});

test('成功後にソケットを破棄する', async () => {
  let socket = null;
  await checkPeer(TARGET, {
    connectImpl: () => { socket = new FakeSocket(connecting()); return socket; },
    sleep: noSleep,
  });
  assert.equal(socket.destroyed, true);
});

test('タイムアウトすれば unreachable になる', async () => {
  const result = await checkPeer(TARGET, { connectImpl: () => new FakeSocket(timingOut()), sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /タイムアウト/);
});

test('エラーなら unreachable になりメッセージが残る', async () => {
  const result = await checkPeer(TARGET, {
    connectImpl: () => new FakeSocket(erroring('ECONNREFUSED')),
    sleep: noSleep,
  });
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /ECONNREFUSED/);
});

test('失敗したら 3 回試行する', async () => {
  let calls = 0;
  await checkPeer(TARGET, {
    connectImpl: () => { calls += 1; return new FakeSocket(erroring('ECONNREFUSED')); },
    sleep: noSleep,
  });
  assert.equal(calls, 3);
});

test('タイムアウト値がソケットに設定される', async () => {
  let socket = null;
  await checkPeer(TARGET, {
    connectImpl: () => { socket = new FakeSocket(connecting()); return socket; },
    sleep: noSleep,
    timeoutMs: 1234,
  });
  assert.equal(socket.timeoutMs, 1234);
});

test('connectImpl が同期的に throw しても unreachable になる', async () => {
  const result = await checkPeer(TARGET, {
    connectImpl: () => { throw new Error('EAI_AGAIN'); },
    sleep: noSleep,
  });
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /EAI_AGAIN/);
});
