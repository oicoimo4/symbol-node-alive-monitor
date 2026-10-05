import { describeEvent, titleOf } from './format.js';
import { postWebhook } from './webhook.js';

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
  await postWebhook(url, formatDiscord(events), 'Discord', fetchImpl);
}
