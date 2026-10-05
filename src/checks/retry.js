export const RETRY_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 5_000;

/** 1 リクエストあたりのタイムアウト。api.js と peer.js が共有する。 */
export const TIMEOUT_MS = 10_000;

/**
 * 再試行する価値がある失敗理由。
 * ネットワーク層の一時的な揺らぎだけを対象とし、
 * ノード自身が返した確定的な異常（health-down / chain-stalled）は再試行しない。
 */
export const RETRYABLE_REASONS = new Set(['unreachable', 'bad-response']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry(probe, options = {}) {
  const {
    attempts = RETRY_ATTEMPTS,
    delayMs = RETRY_DELAY_MS,
    sleep = defaultSleep,
    retryable = RETRYABLE_REASONS,
  } = options;

  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await probe();
    if (last.ok || !retryable.has(last.reason)) return last;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return last;
}
