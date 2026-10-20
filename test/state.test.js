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
  assert.deepEqual(a, { version: 1, updatedAt: null, lastWeeklySummaryAt: null, targets: {}, harvesters: {} });
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
    harvesters: {
      n1: { accounts: ['AA', 'BB'], observedAt: '2026-10-04T13:00:00.000Z' },
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

test('harvesters が無い state には空オブジェクトが補われる', () => {
  // harvester 監視を入れる前に保存された state。version は同じ 1 のまま読めること
  const normalized = normalizeState({ version: 1, targets: {} });
  assert.deepEqual(normalized.harvesters, {});
});

test('壊れた harvester エントリは捨てられる', () => {
  // accounts が文字列のまま残ると 1 文字ずつの集合として比較され、全員入れ替わりの誤報になる
  const normalized = normalizeState({
    version: 1,
    targets: {},
    harvesters: {
      text: { accounts: 'AABB', observedAt: '2026-10-04T13:00:00.000Z' },
      numbers: { accounts: [1, 2], observedAt: '2026-10-04T13:00:00.000Z' },
      empty: null,
      good: { accounts: ['AA'] },
    },
  });
  assert.deepEqual(normalized.harvesters, { good: { accounts: ['AA'], observedAt: null } });
});

test('harvesters がオブジェクトでなければ空として扱う', () => {
  for (const bad of ['oops', 42, ['AA']]) {
    const normalized = normalizeState({ version: 1, targets: {}, harvesters: bad });
    assert.deepEqual(normalized.harvesters, {}, `harvesters: ${JSON.stringify(bad)}`);
  }
});

test('__proto__ という名前のノードの記録も保持される', () => {
  // JSON.parse は __proto__ を自分自身のキーとして作る。{} への代入で写すと prototype の差し替えになり記録が消える
  const normalized = normalizeState(JSON.parse(
    '{"version":1,"targets":{},"harvesters":{"__proto__":{"accounts":["AA"],"observedAt":"2026-10-04T13:00:00.000Z"}}}',
  ));
  assert.equal(Object.hasOwn(normalized.harvesters, '__proto__'), true);
  assert.deepEqual(normalized.harvesters['__proto__'].accounts, ['AA']);
});

/** 警告を捕捉するロガー。テスト出力を汚さないために使う。 */
const captureLogger = () => {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
};

test('readState は存在しないファイルに対して初期状態を返し、警告を出さない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const logger = captureLogger();
  assert.deepEqual(await readState(join(dir, 'missing.json'), { logger }), createInitialState());
  assert.deepEqual(logger.warnings, []);
});

test('readState は壊れた JSON に対して初期状態を返し、警告を出す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const path = join(dir, 'broken.json');
  await writeFile(path, 'not json at all', 'utf8');
  const logger = captureLogger();
  assert.deepEqual(await readState(path, { logger }), createInitialState());
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /解析/);
});

test('readState は ENOENT 以外の読み込みエラーで警告を出す', async () => {
  // ディレクトリを読もうとすると EISDIR になる
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const logger = captureLogger();
  assert.deepEqual(await readState(dir, { logger }), createInitialState());
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /読み込み/);
});

test('未知のバージョンは警告を出して初期状態になる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ version: 99, targets: {} }), 'utf8');
  const logger = captureLogger();
  assert.deepEqual(await readState(path, { logger }), createInitialState());
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /version/);
});

test('空オブジェクトの state は警告を出さない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const path = join(dir, 'state.json');
  await writeFile(path, '{}', 'utf8');
  const logger = captureLogger();
  assert.deepEqual(await readState(path, { logger }), createInitialState());
  assert.deepEqual(logger.warnings, []);
});

test('writeState で書いたものを readState で読み戻せる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alive-'));
  const path = join(dir, 'state.json');
  const state = {
    version: 1,
    updatedAt: '2026-10-04T13:00:00.000Z',
    lastWeeklySummaryAt: null,
    targets: { 'n1::peer': { ...INITIAL_TARGET_STATE, consecutiveFailures: 1 } },
    harvesters: { n1: { accounts: ['AA'], observedAt: '2026-10-04T13:00:00.000Z' } },
  };
  await writeState(path, state);
  assert.deepEqual(await readState(path), state);
  assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
});
