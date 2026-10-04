import { describeEvent, titleOf } from './format.js';

const COLORS = { down: 0xe01e5a, recovered: 0x2eb67d, summary: 0x1d9bd1 };
const MAX_EMBEDS_PER_MESSAGE = 10;

export function formatDiscord(events) {
  const embeds = events.map((event) => ({
    title: titleOf(event),
    description: describeEvent(event),
    color: COLORS[event.type],
    timestamp: event.occurredAt,
  }));

  const bodies = [];
  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    bodies.push({ embeds: embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE) });
  }
  return bodies;
}

export async function sendDiscord(url, events, options = {}) {
  const { fetchImpl = fetch } = options;
  for (const body of formatDiscord(events)) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Discord への送信に失敗しました (HTTP ${response.status}): ${await response.text()}`);
    }
  }
}
