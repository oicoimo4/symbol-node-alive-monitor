import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiscord, sendDiscord } from '../src/notify/discord.js';
import { formatSlack, sendSlack } from '../src/notify/slack.js';
import { dispatch } from '../src/notify/index.js';

const downEvent = (over = {}) => ({
  type: 'down', key: 'n1::api-https', node: 'n1', target: 'api-https',
  reason: 'health-down', detail: '/node/health が異常です', hint: null,
  downSince: '2026-10-04T12:40:00.000Z', occurredAt: '2026-10-04T13:00:00.000Z',
  snapshot: null, ...over,
});

const recoveredEvent = () => downEvent({ type: 'recovered', reason: null, detail: '正常 (height=200)' });

const summaryEvent = () => ({
  type: 'summary', key: null, node: null, target: null, reason: null,
  detail: '監視対象 2 件', hint: null, downSince: null,
  occurredAt: '2026-10-04T13:00:00.000Z',
  snapshot: [
    { key: 'n1::api-https', node: 'n1', target: 'api-https', status: 'up', incidentsThisWeek: 0, lastOkAt: '2026-10-04T13:00:00.000Z', lastHeight: '200' },
    { key: 'n1::peer', node: 'n1', target: 'peer', status: 'down', incidentsThisWeek: 2, lastOkAt: '2026-10-03T13:00:00.000Z', lastHeight: null },
  ],
});

const okResponse = { ok: true, status: 204, text: async () => '' };

// --- Discord ---

test('Discord: down は赤の embed になる', () => {
  const [body] = formatDiscord([downEvent()]);
  assert.equal(body.embeds.length, 1);
  assert.equal(body.embeds[0].color, 0xe01e5a);
  assert.match(body.embeds[0].title, /DOWN/);
  assert.match(body.embeds[0].title, /n1/);
  assert.match(body.embeds[0].title, /api-https/);
  assert.match(body.embeds[0].description, /health/);
});

test('Discord: hint があれば description に含まれる', () => {
  const [body] = formatDiscord([downEvent({ hint: 'TLS 証明書の期限切れの可能性があります。' })]);
  assert.match(body.embeds[0].description, /証明書/);
});

test('Discord: recovered は緑の embed になる', () => {
  const [body] = formatDiscord([recoveredEvent()]);
  assert.equal(body.embeds[0].color, 0x2eb67d);
  assert.match(body.embeds[0].title, /復旧/);
});

test('Discord: summary は青の embed で全対象を列挙する', () => {
  const [body] = formatDiscord([summaryEvent()]);
  assert.equal(body.embeds[0].color, 0x1d9bd1);
  assert.match(body.embeds[0].title, /サマリ/);
  assert.match(body.embeds[0].description, /n1 \/ api-https/);
  assert.match(body.embeds[0].description, /n1 \/ peer/);
});

test('Discord: embeds は 10 件ごとに分割される', () => {
  const events = Array.from({ length: 23 }, (_, i) => downEvent({ key: `n${i}::peer`, node: `n${i}`, target: 'peer' }));
  const bodies = formatDiscord(events);
  assert.deepEqual(bodies.map((b) => b.embeds.length), [10, 10, 3]);
});

test('Discord: 送信が 2xx なら throw しない', async () => {
  await sendDiscord('https://discord.test/hook', [downEvent()], { fetchImpl: async () => okResponse });
});

test('Discord: 送信が 2xx でなければ throw する', async () => {
  await assert.rejects(
    () => sendDiscord('https://discord.test/hook', [downEvent()], {
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
    }),
    /429/,
  );
});

test('Discord: JSON を POST する', async () => {
  let captured = null;
  await sendDiscord('https://discord.test/hook', [downEvent()], {
    fetchImpl: async (url, init) => { captured = { url, init }; return okResponse; },
  });
  assert.equal(captured.url, 'https://discord.test/hook');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  assert.ok(JSON.parse(captured.init.body).embeds);
});

// --- Slack ---

test('Slack: down は赤の attachment になる', () => {
  const [body] = formatSlack([downEvent()]);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].color, '#e01e5a');
  assert.match(body.attachments[0].title, /DOWN/);
});

test('Slack: summary は全対象を列挙する', () => {
  const [body] = formatSlack([summaryEvent()]);
  assert.equal(body.attachments[0].color, '#1d9bd1');
  assert.match(body.attachments[0].text, /n1 \/ peer/);
});

test('Slack: attachments は 20 件ごとに分割される', () => {
  const events = Array.from({ length: 25 }, (_, i) => downEvent({ key: `n${i}::peer`, node: `n${i}` }));
  const bodies = formatSlack(events);
  assert.deepEqual(bodies.map((b) => b.attachments.length), [20, 5]);
});

test('Slack: 送信が 2xx でなければ throw する', async () => {
  await assert.rejects(
    () => sendSlack('https://slack.test/hook', [downEvent()], {
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'oops' }),
    }),
    /500/,
  );
});

// --- dispatch ---

test('dispatch: 設定された両方のチャンネルに送る', async () => {
  const urls = [];
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    slackUrl: 'https://slack.test/hook',
    fetchImpl: async (url) => { urls.push(url); return okResponse; },
  });
  assert.deepEqual(result, { channels: 2, delivered: 2 });
  assert.deepEqual(urls.sort(), ['https://discord.test/hook', 'https://slack.test/hook']);
});

test('dispatch: 片方だけ設定されていればそちらにのみ送る', async () => {
  const urls = [];
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    fetchImpl: async (url) => { urls.push(url); return okResponse; },
  });
  assert.deepEqual(result, { channels: 1, delivered: 1 });
  assert.deepEqual(urls, ['https://discord.test/hook']);
});

test('dispatch: 片方が失敗してももう片方が成功すれば delivered は 1', async () => {
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    slackUrl: 'https://slack.test/hook',
    fetchImpl: async (url) =>
      url.includes('discord') ? { ok: false, status: 500, text: async () => 'x' } : okResponse,
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.deepEqual(result, { channels: 2, delivered: 1 });
});

test('dispatch: 全て失敗すれば delivered は 0', async () => {
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'x' }),
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.deepEqual(result, { channels: 1, delivered: 0 });
});

test('dispatch: チャンネル未設定なら警告を出して channels 0 を返す', async () => {
  const warnings = [];
  const result = await dispatch([downEvent()], {
    fetchImpl: async () => { throw new Error('呼ばれてはいけない'); },
    logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
  });
  assert.deepEqual(result, { channels: 0, delivered: 0 });
  assert.equal(warnings.length > 0, true);
});

test('dispatch: イベントが空なら何も送らない', async () => {
  const result = await dispatch([], {
    discordUrl: 'https://discord.test/hook',
    fetchImpl: async () => { throw new Error('呼ばれてはいけない'); },
  });
  assert.deepEqual(result, { channels: 0, delivered: 0 });
});
