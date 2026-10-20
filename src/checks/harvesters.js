import { TIMEOUT_MS, withRetry } from './retry.js';

/**
 * ノードに委任されている harvester（アンロック済みアカウント）の公開鍵一覧を取得する。
 * 値はノード単位なので、1 ノードにつき 1 回だけ呼ぶこと。
 *
 * 一覧は重複を除いてソートして返す。ノード側の並び順が安定している保証はなく、
 * 順序の違いを増減として誤検知しないようにするため。
 */
export async function checkHarvesters(target, options = {}) {
  const { fetchImpl = fetch, sleep, timeoutMs = TIMEOUT_MS } = options;

  const probe = () => probeHarvesters(target, fetchImpl, timeoutMs);
  const result = await withRetry(probe, sleep ? { sleep } : {});

  return { key: target.key, node: target.node, label: target.label, ...result };
}

async function probeHarvesters(target, fetchImpl, timeoutMs) {
  const url = `${target.url}/node/unlockedaccount`;

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return fail('unreachable', `${url} に接続できません: ${err.message}`);
  }

  if (!response.ok) {
    return fail('bad-response', `${url} が異常なステータスを返しました (HTTP ${response.status})`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return fail('bad-response', `${url} の応答が JSON ではありません (HTTP ${response.status})`);
  }

  const list = body?.unlockedAccount;
  if (!Array.isArray(list) || !list.every((account) => typeof account === 'string')) {
    return fail('bad-response', `${url} の unlockedAccount が文字列の配列ではありません`);
  }

  const accounts = [...new Set(list)].sort();
  return { ok: true, reason: null, detail: `harvester ${accounts.length} 件`, accounts };
}

function fail(reason, detail) {
  return { ok: false, reason, detail, accounts: null };
}
