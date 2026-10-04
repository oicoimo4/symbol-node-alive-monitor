import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INITIAL_TARGET_STATE,
  createInitialState,
  normalizeState,
  readState,
  writeState,
} from '../src/state.js';

test('createInitialState は毎回新しいオブジェクトを返す', () => {
  const a = createInitialState();
  const b = createInitialState();
  assert.notEqual(a, b);
  assert.deepEqual(a, { version: 1, updatedAt: null, lastWeeklySummaryAt: null, targets: {} });
});

test('INITIAL_TARGET_STATE は凍結されている', () => {
  assert.equal(Object.isFrozen(INITIAL_TARGET_STATE), true);
  assert.equal(INITIAL_TARGET_STATE.consecutiveFailures, 0);
  assert.equal(INITIAL_TARGET_STATE.notified, false);
});

test('空オブジェクトは初期状態に正規化される', () => {
  assert.deepEqual(normalizeState({}), createInitialState());
});

test('null は初期状態に正規化される', () => {
  assert.deepEqual(normalizeState(null), createInitialState());
});

test('未知のバージョンは初期状態に正規化される', () => {
  const raw = { version: 99, lastWeeklySummaryAt: '2026-01-01T00:00:00.000Z', targets: { a: {} } };
  assert.deepEqual(normalizeState(raw), createInitialState());
});

test('正しい state はそのまま保持される', () => {
  const raw = {
    version: 1,
    updatedAt: '2026-10-04T13:00:00.000Z',
    lastWeeklySummaryAt: '2026-09-29T00:00:00.000Z',
    targets: {
      'n1::peer': {
        status: 'down',
        consecutiveFailures: 3,
        lastHeight: '100',
        lastOkAt: '2026-10-04T12:00:00.000Z',
        downSince: '2026-10-04T12:10:00.000Z',
        notified: true,
        incidentsThisWeek: 2,
      },
    },
  };
  assert.deepEqual(normalizeState(raw), raw);
});

test('target の欠けたフィールドは初期値で補われる', () => {
  const normalized = normalizeState({
    version: 1,
    targets: { 'n1::peer': { consecutiveFailures: 5 } },
  });
  assert.deepEqual(normalized.targets['n1::peer'], {
    ...INITIAL_TARGET_STATE,
    consecutiveFailures: 5,
  });
});

test('readState は存在しないファイルに対して初期状態を返す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  assert.deepEqual(await readState(join(dir, 'missing.json')), createInitialState());
});

test('readState は壊れた JSON に対して初期状態を返す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const path = join(dir, 'broken.json');
  await writeFile(path, 'not json at all', 'utf8');
  assert.deepEqual(await readState(path), createInitialState());
});

test('writeState で書いたものを readState で読み戻せる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const path = join(dir, 'state.json');
  const state = {
    version: 1,
    updatedAt: '2026-10-04T13:00:00.000Z',
    lastWeeklySummaryAt: null,
    targets: { 'n1::peer': { ...INITIAL_TARGET_STATE, consecutiveFailures: 1 } },
  };
  await writeState(path, state);
  assert.deepEqual(await readState(path), state);
  assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
});
