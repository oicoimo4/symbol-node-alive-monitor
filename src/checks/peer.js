import net from 'node:net';
import { TIMEOUT_MS, withRetry } from './retry.js';

/**
 * Peer ノードを検査する。
 * Symbol の 7900 番は相互 TLS 認証のため完全なハンドシェイクは証明書なしに成立しない。
 * ここでは TCP 接続が確立するか（= プロセスが生きて listen しているか）までを確認する。
 */
export async function checkPeer(target, options = {}) {
  const { connectImpl = net.connect, sleep, timeoutMs = TIMEOUT_MS } = options;

  const probe = () => probePeer(target, connectImpl, timeoutMs);
  const result = await withRetry(probe, sleep ? { sleep } : {});

  return { key: target.key, node: target.node, label: target.label, ...result };
}

function probePeer(target, connectImpl, timeoutMs) {
  const where = `TCP ${target.host}:${target.port}`;

  return new Promise((resolve) => {
    let socket;
    try {
      socket = connectImpl({ host: target.host, port: target.port });
    } catch (err) {
      resolve(fail(`${where} に接続できません: ${err.message}`));
      return;
    }

    const settle = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle({
      ok: true, reason: null, detail: `${where} に接続できました`, height: null,
    }));
    socket.once('timeout', () => settle(fail(`${where} がタイムアウトしました (${timeoutMs}ms)`)));
    socket.once('error', (err) => settle(fail(`${where} に接続できません: ${err.message}`)));
  });
}

function fail(detail) {
  return { ok: false, reason: 'unreachable', detail, height: null };
}
