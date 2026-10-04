import { TIMEOUT_MS, withRetry } from './retry.js';

/**
 * API ノードを検査する。
 * 1) /node/health が apiNode と db の両方で up を返すか
 * 2) /chain/info の height が前回より進んでいるか
 */
export async function checkApi(target, options = {}) {
  const {
    lastHeight = null,
    fetchImpl = fetch,
    sleep,
    timeoutMs = TIMEOUT_MS,
  } = options;

  const probe = () => probeApi(target, lastHeight, fetchImpl, timeoutMs);
  const result = await withRetry(probe, sleep ? { sleep } : {});

  return { key: target.key, node: target.node, label: target.label, ...result };
}

async function probeApi(target, lastHeight, fetchImpl, timeoutMs) {
  const health = await fetchJson(`${target.url}/node/health`, fetchImpl, timeoutMs);
  if (health.error) return health.error;

  const apiNode = health.body?.status?.apiNode;
  const db = health.body?.status?.db;
  if (!health.response.ok || apiNode !== 'up' || db !== 'up') {
    return fail(
      'health-down',
      `/node/health が異常です (HTTP ${health.response.status}, apiNode=${apiNode}, db=${db})`,
    );
  }

  const chain = await fetchJson(`${target.url}/chain/info`, fetchImpl, timeoutMs);
  if (chain.error) return chain.error;

  const height = chain.body?.height;
  if (!chain.response.ok || typeof height !== 'string' || !/^\d+$/.test(height)) {
    return fail(
      'bad-response',
      `/chain/info の height が不正です (HTTP ${chain.response.status}, height=${JSON.stringify(height)})`,
    );
  }

  // lastHeight は state.json 由来で検証されていない。BigInt() は 'abc' で例外を投げ、
  // '0x10' や true は黙って別の数値に化けて比較結果を狂わせる。
  // 10進数字列でなければ「前回値なし」として進行チェックを省く。
  const previous = /^\d+$/.test(String(lastHeight)) ? lastHeight : null;
  if (previous !== null && BigInt(height) <= BigInt(previous)) {
    return {
      ok: false,
      reason: 'chain-stalled',
      detail: `チェーン高が進んでいません (前回 ${previous} → 今回 ${height})`,
      height,
    };
  }

  return { ok: true, reason: null, detail: `正常 (height=${height})`, height };
}

/** 取得と JSON 解析をまとめて行い、失敗時は検査結果の形でエラーを返す。 */
async function fetchJson(url, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { error: fail('unreachable', `${url} に接続できません: ${err.message}`) };
  }

  try {
    return { response, body: await response.json() };
  } catch {
    return { error: fail('bad-response', `${url} の応答が JSON ではありません (HTTP ${response.status})`) };
  }
}

function fail(reason, detail) {
  return { ok: false, reason, detail, height: null };
}
