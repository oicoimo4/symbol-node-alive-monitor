/**
 * Webhook へ順番に POST する。2xx 以外が返ったら即座に throw する。
 * body の組み立て（embeds / attachments の形と1通あたりの上限）は呼び出し側の責務。
 */
export async function postWebhook(url, bodies, channelName, fetchImpl) {
  for (const body of bodies) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `${channelName} への送信に失敗しました (HTTP ${response.status}): ${await response.text()}`,
      );
    }
  }
}
