import { sendDiscord } from './discord.js';
import { sendSlack } from './slack.js';

/**
 * 設定されているチャンネルすべてにイベントを送る。
 * 1つでも成功すれば配信済みとみなす（呼び出し側が delivered === 0 で異常終了を判断する）。
 */
export async function dispatch(events, options = {}) {
  const { discordUrl, slackUrl, fetchImpl = fetch, logger = console } = options;

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
    try {
      await channel.send();
      delivered += 1;
      logger.log(`${channel.name} に ${events.length} 件のイベントを送信しました`);
    } catch (err) {
      logger.error(`${channel.name} への送信に失敗しました: ${err.message}`);
    }
  }

  return { channels: channels.length, delivered };
}
