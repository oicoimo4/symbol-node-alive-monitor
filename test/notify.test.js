import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiscord, sendDiscord } from '../src/notify/discord.js';
import { formatSlack, sendSlack } from '../src/notify/slack.js';
import { dispatch } from '../src/notify/index.js';

/** dispatch は既定で console に書くため、全テストで差し替えてテスト出力を汚さない。 */
const silentLogger = { log() {}, warn() {}, error() {} };

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

test('Discord: 送信に signal が渡される', async () => {
  let captured = null;
  await sendDiscord('https://discord.test/hook', [downEvent()], {
    fetchImpl: async (_url, init) => { captured = init; return okResponse; },
  });
  assert.ok(captured.signal, 'signal が渡されていない');
});

test('Discord: fetch が例外を投げたらチャンネル名付きで throw する', async () => {
  await assert.rejects(
    () => sendDiscord('https://discord.test/hook', [downEvent()], {
      fetchImpl: async () => { throw new Error('TimeoutError'); },
    }),
    /Discord.*TimeoutError/s,
  );
});

test('Discord: 非2xx で本文取得が失敗してもステータスは残る', async () => {
  await assert.rejects(
    () => sendDiscord('https://discord.test/hook', [downEvent()], {
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => { throw new Error('aborted'); } }),
    }),
    /503/,
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

test('長すぎる detail は切り詰められる', () => {
  const [body] = formatDiscord([downEvent({ detail: 'あ'.repeat(5000) })]);
  assert.ok(body.embeds[0].description.length <= 3950);
  assert.match(body.embeds[0].description, /…\(省略\)$/);
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
    logger: silentLogger,
  });
  assert.deepEqual(result, { channels: 2, delivered: 2 });
  assert.deepEqual(urls.sort(), ['https://discord.test/hook', 'https://slack.test/hook']);
});

test('dispatch: 片方だけ設定されていればそちらにのみ送る', async () => {
  const urls = [];
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    fetchImpl: async (url) => { urls.push(url); return okResponse; },
    logger: silentLogger,
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
    logger: silentLogger,
    sleep: async () => {},
  });
  assert.deepEqual(result, { channels: 2, delivered: 1 });
});

test('dispatch: 全て失敗すれば delivered は 0', async () => {
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'x' }),
    logger: silentLogger,
    sleep: async () => {},
  });
  assert.deepEqual(result, { channels: 1, delivered: 0 });
});

test('dispatch: 送信に失敗しても同一実行内で3回まで再試行する', async () => {
  let calls = 0;
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    fetchImpl: async () => { calls += 1; return { ok: false, status: 500, text: async () => 'x' }; },
    logger: silentLogger,
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, { channels: 1, delivered: 0 });
});

test('dispatch: 再試行の途中で成功すればそこで止まる', async () => {
  let calls = 0;
  const result = await dispatch([downEvent()], {
    discordUrl: 'https://discord.test/hook',
    fetchImpl: async () => {
      calls += 1;
      return calls < 2 ? { ok: false, status: 500, text: async () => 'x' } : okResponse;
    },
    logger: silentLogger,
    sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { channels: 1, delivered: 1 });
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

// --- harvester ---

/** 64 文字の公開鍵を作る。通知に出るのは先頭 12 文字だけ。 */
const publicKey = (prefix) => prefix.padEnd(64, '0');

const harvestersEvent = (over = {}) => ({
  type: 'harvesters', key: 'n1::harvesters', node: 'n1', target: 'harvesters',
  reason: null, detail: '6 → 7 件', hint: null, downSince: null,
  occurredAt: '2026-10-20T14:00:00.000Z', snapshot: null,
  added: [publicKey('9D4B2C01A7F3')], removed: [], before: 6, after: 7, ...over,
});

test('Discord: harvester 変化は琥珀の embed で、見出しにノード名だけを出す', () => {
  const [body] = formatDiscord([harvestersEvent()]);
  assert.equal(body.embeds[0].color, 0xecb22e);
  assert.equal(body.embeds[0].title, '🌾 Harvester 変化: n1');
});

test('harvester 変化の本文は公開鍵を先頭 12 文字に切り詰め、空の離脱行を出さない', () => {
  const [body] = formatDiscord([harvestersEvent()]);
  assert.equal(body.embeds[0].description, [
    '6 → 7 件',
    '',
    '参加: 9D4B2C01A7F3…',
    '',
    '確認時刻: 2026-10-20T14:00:00.000Z',
  ].join('\n'));
});

test('harvester の参加と離脱が両方あれば両方の行を出し、複数はカンマ区切りにする', () => {
  const [body] = formatDiscord([harvestersEvent({
    detail: '1 → 2 件',
    added: [publicKey('AAAAAAAAAAAA'), publicKey('BBBBBBBBBBBB')],
    removed: [publicKey('CCCCCCCCCCCC')],
  })]);
  assert.match(body.embeds[0].description, /^参加: AAAAAAAAAAAA…, BBBBBBBBBBBB…$/m);
  assert.match(body.embeds[0].description, /^離脱: CCCCCCCCCCCC…$/m);
});

test('harvester の離脱だけなら参加の行を出さない', () => {
  const [body] = formatDiscord([harvestersEvent({
    detail: '7 → 6 件', added: [], removed: [publicKey('9D4B2C01A7F3')],
  })]);
  assert.doesNotMatch(body.embeds[0].description, /参加/);
  assert.match(body.embeds[0].description, /^離脱: 9D4B2C01A7F3…$/m);
});

test('Slack: harvester 変化は琥珀の attachment になる', () => {
  const [body] = formatSlack([harvestersEvent()]);
  assert.equal(body.attachments[0].color, '#ecb22e');
  assert.equal(body.attachments[0].title, '🌾 Harvester 変化: n1');
});

test('summary に harvesters があれば対象一覧の後に件数と最終確認時刻を追記する', () => {
  const event = { ...summaryEvent(), harvesters: [{ node: 'n1', count: 6, observedAt: '2026-10-04T13:00:00.000Z' }] };
  const [body] = formatDiscord([event]);
  assert.equal(body.embeds[0].description, [
    '🟢 n1 / api-https — 障害 0 回 — height 200 — 最終正常 2026-10-04T13:00:00.000Z',
    '🔴 n1 / peer — 障害 2 回 — 最終正常 2026-10-03T13:00:00.000Z',
    '',
    '🌾 n1 — harvester 6 件 — 最終確認 2026-10-04T13:00:00.000Z',
    '',
    '確認時刻: 2026-10-04T13:00:00.000Z',
  ].join('\n'));
});

test('harvesters の無い summary は従来どおり描画される', () => {
  const expected = [
    '🟢 n1 / api-https — 障害 0 回 — height 200 — 最終正常 2026-10-04T13:00:00.000Z',
    '🔴 n1 / peer — 障害 2 回 — 最終正常 2026-10-03T13:00:00.000Z',
    '',
    '確認時刻: 2026-10-04T13:00:00.000Z',
  ].join('\n');
  for (const event of [summaryEvent(), { ...summaryEvent(), harvesters: [] }]) {
    const [body] = formatDiscord([event]);
    assert.equal(body.embeds[0].description, expected);
  }
});
