import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_TARGET_STATE, createInitialState } from '../src/state.js';
import { evaluate, FAILURE_THRESHOLD } from '../src/evaluate.js';

const NOW = new Date('2026-10-04T13:00:00.000Z');
const NOW_ISO = NOW.toISOString();

/** 既定で「正常な api-https の検査結果」を作る。 */
const ok = (over = {}) => ({
  key: 'n1::api-https', node: 'n1', label: 'api-https',
  ok: true, reason: null, detail: '正常', height: '200', ...over,
});

/** 既定で「失敗した api-https の検査結果」を作る。 */
const ng = (over = {}) => ok({ ok: false, reason: 'unreachable', detail: '接続できません', height: null, ...over });

/** lastWeeklySummaryAt を「直前」に設定した state を作る（サマリを発火させないため）。 */
const stateWith = (targets = {}) => ({
  version: 1,
  updatedAt: null,
  lastWeeklySummaryAt: '2026-10-04T12:00:00.000Z',
  targets,
});

const eventsOfType = (events, type) => events.filter((e) => e.type === type);

test('しきい値は 2 である', () => {
  assert.equal(FAILURE_THRESHOLD, 2);
});

test('初回の成功では通知が発火せず height が記録される', () => {
  const { nextState, events } = evaluate({ prevState: stateWith(), results: [ok()], now: NOW });
  assert.deepEqual(events, []);
  assert.equal(nextState.targets['n1::api-https'].lastHeight, '200');
  assert.equal(nextState.targets['n1::api-https'].lastOkAt, NOW_ISO);
  assert.equal(nextState.targets['n1::api-https'].status, 'up');
});

test('1回目の失敗では通知が発火しない', () => {
  const { nextState, events } = evaluate({ prevState: stateWith(), results: [ng()], now: NOW });
  assert.deepEqual(events, []);
  assert.equal(nextState.targets['n1::api-https'].consecutiveFailures, 1);
  assert.equal(nextState.targets['n1::api-https'].status, 'up');
  assert.equal(nextState.targets['n1::api-https'].downSince, NOW_ISO);
});

test('2回連続の失敗で down イベントが1回だけ発火する', () => {
  const first = evaluate({ prevState: stateWith(), results: [ng()], now: NOW });
  const second = evaluate({ prevState: first.nextState, results: [ng()], now: NOW });

  const downs = eventsOfType(second.events, 'down');
  assert.equal(downs.length, 1);
  assert.equal(downs[0].key, 'n1::api-https');
  assert.equal(downs[0].reason, 'unreachable');
  assert.equal(downs[0].downSince, NOW_ISO);
  assert.equal(second.nextState.targets['n1::api-https'].status, 'down');
  assert.equal(second.nextState.targets['n1::api-https'].notified, true);
  assert.equal(second.nextState.targets['n1::api-https'].incidentsThisWeek, 1);
});

test('障害が続く間 downSince は最初の失敗時刻に固定される', () => {
  // 2回の実行で別々の now を渡すこと。同じ now だと
  // downSince: occurredAt に退化しても気づけない。
  const LATER = new Date('2026-10-04T13:10:00.000Z');
  const first = evaluate({ prevState: stateWith(), results: [ng()], now: NOW });
  const second = evaluate({ prevState: first.nextState, results: [ng()], now: LATER });

  assert.equal(second.nextState.targets['n1::api-https'].downSince, NOW_ISO);
  assert.equal(eventsOfType(second.events, 'down')[0].downSince, NOW_ISO);
  assert.equal(second.nextState.updatedAt, LATER.toISOString());
});

test('3回目以降の失敗では何も発火しない', () => {
  let state = stateWith();
  for (let i = 0; i < 2; i += 1) {
    state = evaluate({ prevState: state, results: [ng()], now: NOW }).nextState;
  }
  const third = evaluate({ prevState: state, results: [ng()], now: NOW });
  assert.deepEqual(third.events, []);
  assert.equal(third.nextState.targets['n1::api-https'].consecutiveFailures, 3);
  assert.equal(third.nextState.targets['n1::api-https'].incidentsThisWeek, 1);
});

test('通知済みの状態から成功すると recovered が発火する', () => {
  const down = {
    ...INITIAL_TARGET_STATE,
    status: 'down', consecutiveFailures: 2, notified: true,
    downSince: '2026-10-04T12:40:00.000Z', incidentsThisWeek: 1,
  };
  const { nextState, events } = evaluate({
    prevState: stateWith({ 'n1::api-https': down }), results: [ok()], now: NOW,
  });

  const recovered = eventsOfType(events, 'recovered');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].downSince, '2026-10-04T12:40:00.000Z');
  assert.equal(nextState.targets['n1::api-https'].status, 'up');
  assert.equal(nextState.targets['n1::api-https'].notified, false);
  assert.equal(nextState.targets['n1::api-https'].consecutiveFailures, 0);
  assert.equal(nextState.targets['n1::api-https'].downSince, null);
  // 障害回数は週次サマリまで保持する
  assert.equal(nextState.targets['n1::api-https'].incidentsThisWeek, 1);
});

test('未通知（1回失敗）から成功しても recovered は発火しない', () => {
  const partial = { ...INITIAL_TARGET_STATE, consecutiveFailures: 1, downSince: '2026-10-04T12:50:00.000Z' };
  const { events } = evaluate({
    prevState: stateWith({ 'n1::api-https': partial }), results: [ok()], now: NOW,
  });
  assert.deepEqual(events, []);
});

test('失敗時に lastHeight は更新されない', () => {
  const prev = { ...INITIAL_TARGET_STATE, lastHeight: '150', lastOkAt: '2026-10-04T12:00:00.000Z' };
  const { nextState } = evaluate({
    prevState: stateWith({ 'n1::api-https': prev }),
    // 失敗した検査が返した height は前回値と必ず違う値にする。
    // 同じ値にすると lastHeight: result.height ?? prev.lastHeight に退化しても通ってしまう。
    results: [ng({ reason: 'chain-stalled', height: '999' })],
    now: NOW,
  });
  assert.equal(nextState.targets['n1::api-https'].lastHeight, '150');
  assert.equal(nextState.targets['n1::api-https'].lastOkAt, '2026-10-04T12:00:00.000Z');
});

test('https が down かつ http が ok なら証明書切れの hint が付く', () => {
  const downState = { ...INITIAL_TARGET_STATE, consecutiveFailures: 1, downSince: '2026-10-04T12:50:00.000Z' };
  const { events } = evaluate({
    prevState: stateWith({ 'n1::api-https': downState }),
    results: [
      ng({ key: 'n1::api-https', label: 'api-https' }),
      ok({ key: 'n1::api-http', label: 'api-http' }),
    ],
    now: NOW,
  });
  const down = eventsOfType(events, 'down')[0];
  assert.match(down.hint, /証明書/);
});

test('http も down なら hint は付かない', () => {
  const downState = { ...INITIAL_TARGET_STATE, consecutiveFailures: 1, downSince: '2026-10-04T12:50:00.000Z' };
  const { events } = evaluate({
    prevState: stateWith({ 'n1::api-https': downState, 'n1::api-http': downState }),
    results: [
      ng({ key: 'n1::api-https', label: 'api-https' }),
      ng({ key: 'n1::api-http', label: 'api-http' }),
    ],
    now: NOW,
  });
  for (const event of eventsOfType(events, 'down')) {
    assert.equal(event.hint, null);
  }
});

test('lastWeeklySummaryAt が null なら初回サマリが発火する', () => {
  const { nextState, events } = evaluate({
    prevState: createInitialState(), results: [ok()], now: NOW,
  });
  const summaries = eventsOfType(events, 'summary');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].snapshot.length, 1);
  assert.equal(summaries[0].snapshot[0].key, 'n1::api-https');
  assert.equal(summaries[0].snapshot[0].status, 'up');
  assert.equal(nextState.lastWeeklySummaryAt, NOW_ISO);
});

test('7日経過でサマリが発火し incidentsThisWeek がリセットされる', () => {
  const prev = {
    version: 1, updatedAt: null,
    lastWeeklySummaryAt: '2026-09-27T13:00:00.000Z',
    targets: { 'n1::api-https': { ...INITIAL_TARGET_STATE, incidentsThisWeek: 3 } },
  };
  const { nextState, events } = evaluate({ prevState: prev, results: [ok()], now: NOW });
  const summary = eventsOfType(events, 'summary')[0];
  // スナップショットにはリセット前の値が入る
  assert.equal(summary.snapshot[0].incidentsThisWeek, 3);
  assert.equal(nextState.targets['n1::api-https'].incidentsThisWeek, 0);
  assert.equal(nextState.lastWeeklySummaryAt, NOW_ISO);
});

test('7日未満ではサマリが発火しない', () => {
  const prev = {
    version: 1, updatedAt: null,
    lastWeeklySummaryAt: '2026-09-28T13:00:00.001Z',
    targets: {},
  };
  const { events } = evaluate({ prevState: prev, results: [ok()], now: NOW });
  assert.deepEqual(eventsOfType(events, 'summary'), []);
});

test('設定から消えた監視対象は state から除去される', () => {
  const prev = stateWith({
    'n1::api-https': { ...INITIAL_TARGET_STATE },
    'removed::peer': { ...INITIAL_TARGET_STATE },
  });
  const { nextState } = evaluate({ prevState: prev, results: [ok()], now: NOW });
  assert.deepEqual(Object.keys(nextState.targets), ['n1::api-https']);
});

test('nextState は version と updatedAt を持つ', () => {
  const { nextState } = evaluate({ prevState: stateWith(), results: [ok()], now: NOW });
  assert.equal(nextState.version, 1);
  assert.equal(nextState.updatedAt, NOW_ISO);
});

test('prevState を変更しない', () => {
  const prev = stateWith({ 'n1::api-https': { ...INITIAL_TARGET_STATE } });
  const snapshot = structuredClone(prev);
  evaluate({ prevState: prev, results: [ng()], now: NOW });
  assert.deepEqual(prev, snapshot);
});
