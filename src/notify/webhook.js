import { TIMEOUT_MS } from '../checks/retry.js';

/**
 * Webhook へ順番に POST する。2xx 以外が返ったら即座に throw する。
 * body の組み立て（embeds / attachments の形と1通あたりの上限）は呼び出し側の責務。
 *
 * 1 リクエストごとに AbortSignal で期限を切る。同じ signal が応答本文の読み取りにも
 * 効くので、ヘッダだけ返して本文を返し切らない相手でも必ず有限時間で終わる。
 */
export async function postWebhook(url, bodies, channelName, fetchImpl, timeoutMs = TIMEOUT_MS) {
  for (const body of bodies) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`${channelName} への送信に失敗しました: ${err.message}`);
    }

    if (!response.ok) {
      let detail;
      try {
        detail = await response.text();
      } catch {
        detail = '(本文を取得できませんでした)';
      }
      throw new Error(`${channelName} への送信に失敗しました (HTTP ${response.status}): ${detail}`);
    }
  }
}
