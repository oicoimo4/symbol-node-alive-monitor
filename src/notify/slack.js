import { describeEvent, titleOf } from './format.js';

const COLORS = { down: '#e01e5a', recovered: '#2eb67d', summary: '#1d9bd1' };
const MAX_ATTACHMENTS_PER_MESSAGE = 20;

export function formatSlack(events) {
  const attachments = events.map((event) => ({
    color: COLORS[event.type],
    title: titleOf(event),
    text: describeEvent(event),
    ts: Math.floor(Date.parse(event.occurredAt) / 1000),
  }));

  const bodies = [];
  for (let i = 0; i < attachments.length; i += MAX_ATTACHMENTS_PER_MESSAGE) {
    bodies.push({ attachments: attachments.slice(i, i + MAX_ATTACHMENTS_PER_MESSAGE) });
  }
  return bodies;
}

export async function sendSlack(url, events, options = {}) {
  const { fetchImpl = fetch } = options;
  for (const body of formatSlack(events)) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Slack への送信に失敗しました (HTTP ${response.status}): ${await response.text()}`);
    }
  }
}
