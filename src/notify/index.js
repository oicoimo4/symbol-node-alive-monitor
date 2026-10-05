import { sendDiscord } from './discord.js';
import { sendSlack } from './slack.js';

const NOTIFY_ATTEMPTS = 3;
const NOTIFY_RETRY_DELAY_MS = 2_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 設定されているチャンネルすべてにイベントを送る。
 * 1つでも成功すれば配信済みとみなす（呼び出し側が delivered === 0 で異常終了を判断する）。
 */
export async function dispatch(events, options = {}) {
  const { discordUrl, slackUrl, fetchImpl = fetch, logger = console, sleep = defaultSleep } = options;

  if (events.length === 0) return { channels: 0, delivered: 0 };

  const channels = [];
  if (discordUrl) channels.push({ name: 'Discord', send: () => sendDiscord(discordUrl, events, { fetchImpl }) });
  if (slackUrl) channels.push({ name: 'Slack', send: () => sendSlack(slackUrl, events, { fetchImpl }) });

  if (channels.length === 0) {
    logger.warn(
      `通知先が未設定のため ${events.length} 件のイベントを送信できません: ` +
      events.map((e) => `${e.type}:${e.key ?? 'summary'}`).join(', '),
    );
    return { channels: 0, delivered: 0 };
  }

  let delivered = 0;
  for (const channel of channels) {
    if (await sendWithRetry(channel, events.length, logger, sleep)) delivered += 1;
  }

  return { channels: channels.length, delivered };
}

/**
 * 1 つの通知先へ送る。失敗しても同一実行内で再試行する。
 * 通知先ごとの配信状態は持っていないため、ここで諦めたイベントはその通知先では失われる。
 */
async function sendWithRetry(channel, eventCount, logger, sleep) {
  for (let attempt = 1; attempt <= NOTIFY_ATTEMPTS; attempt += 1) {
    try {
      await channel.send();
      logger.log(`${channel.name} に ${eventCount} 件のイベントを送信しました`);
      return true;
    } catch (err) {
      logger.error(
        `${channel.name} への送信に失敗しました (${attempt}/${NOTIFY_ATTEMPTS}): ${err.message}`,
      );
      if (attempt < NOTIFY_ATTEMPTS) await sleep(NOTIFY_RETRY_DELAY_MS);
    }
  }
  return false;
}
