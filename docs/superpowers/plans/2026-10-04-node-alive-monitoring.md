# Symbol ノード死活監視システム 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actions の無料枠だけで Symbol の API / Peer ノードを10分おきに監視し、障害・復旧・週次サマリを Discord と Slack に通知する。

**Architecture:** cron で起動する Node.js スクリプト1本。`monitoring-state` ブランチの `state.json` で実行間の状態を引き継ぐ。判定ロジック `evaluate.js` を副作用ゼロの純粋関数に切り出し、そこにテストを集中させる。

**Tech Stack:** Node.js 20（外部依存ゼロ）、ESM、`node:test`、GitHub Actions

**設計書:** `docs/superpowers/specs/2026-10-04-node-alive-monitoring-design.md`

## Global Constraints

これらは全タスクの要件に暗黙に含まれる。

- **外部依存を一切追加しない。** `package.json` の `dependencies` と `devDependencies` は常に空。HTTP は global `fetch`、TCP は `node:net`、テストは `node:test` + `node:assert/strict` のみを使う。
- **ESM のみ。** `package.json` に `"type": "module"`。`require` は使わない。
- **Node.js 20 以上を前提にする。** `AbortSignal.timeout()`、`structuredClone()`、`node --test` を使用する。
- **コメント・エラーメッセージ・通知文はすべて日本語で書く。** 変数名と関数名は英語。
- **テストはネットワークにも実ファイルシステムにもアクセスしない。** `fetch` と `net.connect` は必ず引数で注入してモックする。ファイル I/O を伴うテストは `node:os` の `tmpdir()` 配下のみを使う。
- **定数は以下の値を使う**（マジックナンバーを散らさず、定義元から import する）:
  - `FAILURE_THRESHOLD = 2`（この回数の連続失敗で DOWN 通知）
  - `TIMEOUT_MS = 10_000`
  - `RETRY_DELAY_MS = 5_000`
  - `RETRY_ATTEMPTS = 3`
  - `WEEK_MS = 7 * 24 * 60 * 60 * 1000`
- **state のキーは `` `${node.name}::${label}` ``** という形式。`label` は `api-http` / `api-https` / `peer` のいずれか。この形式を変えると過去の state との互換が切れる。
- **コミットは各タスクの最後に1回。** コミットメッセージは `feat:` / `test:` / `chore:` / `docs:` で始める。

---

## 共通データ型

全タスクがこれらの形を共有する。**フィールド名を1文字でも変えないこと。**

### Target（`config.js` が生成）

```js
// kind === 'api' のとき
{ key: 'my-node-01::api-https', node: 'my-node-01', kind: 'api',
  label: 'api-https', url: 'https://node1.example.com:3001' }

// kind === 'peer' のとき
{ key: 'my-node-01::peer', node: 'my-node-01', kind: 'peer',
  label: 'peer', host: 'node1.example.com', port: 7900 }
```

### CheckResult（`checks/*.js` が生成）

```js
{ key: 'my-node-01::api-https',
  node: 'my-node-01',
  label: 'api-https',
  ok: true,
  reason: null,          // 失敗時は 'unreachable' | 'health-down' | 'chain-stalled' | 'bad-response'
  detail: '正常 (height=3456789)',
  height: '3456789' }    // API 検査以外は null
```

### TargetState（`state.json` 内）

```js
{ status: 'up',               // 'up' | 'down'
  consecutiveFailures: 0,
  lastHeight: '3456789',      // 未取得なら null
  lastOkAt: '2026-10-04T13:00:00.000Z',  // 未確認なら null
  downSince: null,            // 障害継続中なら ISO 文字列
  notified: false,
  incidentsThisWeek: 0 }
```

### State（`state.json` 全体）

```js
{ version: 1,
  updatedAt: '2026-10-04T13:00:00.000Z',
  lastWeeklySummaryAt: '2026-09-29T00:10:00.000Z',  // 未送信なら null
  targets: { 'my-node-01::api-https': { /* TargetState */ } } }
```

### Event（`evaluate.js` が生成、`notify/*` が消費）

```js
{ type: 'down',               // 'down' | 'recovered' | 'summary'
  key: 'my-node-01::api-https',   // summary では null
  node: 'my-node-01',             // summary では null
  target: 'api-https',            // summary では null（label と同じ値）
  reason: 'health-down',          // summary / recovered では null
  detail: '...',
  hint: null,                     // TLS 証明書切れの推定文が入ることがある
  downSince: '2026-10-04T12:40:00.000Z',  // summary では null
  occurredAt: '2026-10-04T13:00:00.000Z',
  snapshot: null }                // summary のときのみ配列

// snapshot の各要素
{ key, node, target, status, incidentsThisWeek, lastOkAt, lastHeight }
```

---

## ファイル構成

| ファイル | 責務 | タスク |
|---|---|---|
| `package.json` | ESM 宣言、`npm test` | 1 |
| `config/nodes.json` | 監視対象の定義 | 1 |
| `src/config.js` | 設定の読込・検証・Target への展開 | 1 |
| `src/state.js` | `state.json` の読み書きと正規化、初期状態の定義 | 2 |
| `src/evaluate.js` | 判定ロジック（純粋関数） | 3 |
| `src/checks/retry.js` | 再試行の共通処理と検査系の共有定数 | 4 |
| `src/checks/api.js` | API ノードの検査 | 4 |
| `src/checks/peer.js` | Peer ノードの検査 | 5 |
| `src/notify/format.js` | 通知先に依存しない文面の生成 | 6 |
| `src/notify/discord.js` | Discord 用の整形と送信 | 6 |
| `src/notify/slack.js` | Slack 用の整形と送信 | 6 |
| `src/notify/index.js` | 通知のディスパッチ | 6 |
| `src/index.js` | 全体の結線と終了コード決定 | 7 |
| `.github/workflows/monitor.yml` | cron 実行と state の永続化 | 8 |
| `README.md` | セットアップ手順 | 8 |

依存の向き: `index.js` → 全モジュール。`evaluate.js` → `state.js`（定数のみ）。`checks/api.js`・`checks/peer.js` → `checks/retry.js`。`notify/discord.js`・`notify/slack.js` → `notify/format.js`。`notify/index.js` → 各アダプタ。それ以外に相互依存はない。

**`checks/api.js` と `checks/peer.js` は互いを import しないこと。** 共有する定数（`TIMEOUT_MS` など）は必ず `checks/retry.js` 側に置く。

---

## Task 1: プロジェクト基盤と設定ローダ

**Files:**
- Create: `package.json`
- Create: `config/nodes.json`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `parseConfig(raw: object): Target[]` — 検証に失敗したら `Error` を throw
  - `loadConfig(path: string): Promise<Target[]>` — ファイルを読んで `parseConfig` に渡す

- [ ] **Step 1: `package.json` を作る**

```json
{
  "name": "node-alive-monitoring",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Symbol の API / Peer ノードを GitHub Actions で死活監視する",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: `config/nodes.json` を作る**

これはサンプル値。利用者が自分のノードに書き換える前提のファイル。

```json
{
  "nodes": [
    {
      "name": "my-node-01",
      "host": "node1.example.com",
      "api": { "http": 3000, "https": 3001 },
      "peer": { "port": 7900 }
    },
    {
      "name": "peer-only-node",
      "host": "node2.example.com",
      "peer": { "port": 7900 }
    }
  ]
}
```

- [ ] **Step 3: 失敗するテストを書く**

`test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

test('api の http と https を別々の Target に展開する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { http: 3000, https: 3001 } }],
  });
  assert.deepEqual(targets, [
    { key: 'n1::api-http', node: 'n1', kind: 'api', label: 'api-http', url: 'http://example.com:3000' },
    { key: 'n1::api-https', node: 'n1', kind: 'api', label: 'api-https', url: 'https://example.com:3001' },
  ]);
});

test('api の片方だけでも展開できる', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { https: 3001 } }],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].key, 'n1::api-https');
});

test('peer を Target に展開する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', peer: { port: 7900 } }],
  });
  assert.deepEqual(targets, [
    { key: 'n1::peer', node: 'n1', kind: 'peer', label: 'peer', host: 'example.com', port: 7900 },
  ]);
});

test('複数ノードをすべて展開する', () => {
  const targets = parseConfig({
    nodes: [
      { name: 'n1', host: 'a.example.com', api: { https: 3001 } },
      { name: 'n2', host: 'b.example.com', peer: { port: 7900 } },
    ],
  });
  assert.deepEqual(targets.map((t) => t.key), ['n1::api-https', 'n2::peer']);
});

test('nodes が配列でなければ失敗する', () => {
  assert.throws(() => parseConfig({}), /nodes/);
});

test('name が重複していれば失敗する', () => {
  assert.throws(
    () => parseConfig({
      nodes: [
        { name: 'dup', host: 'a.example.com', peer: { port: 7900 } },
        { name: 'dup', host: 'b.example.com', peer: { port: 7900 } },
      ],
    }),
    /重複/,
  );
});

test('name が空文字なら失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: '', host: 'a.example.com', peer: { port: 7900 } }] }),
    /name/,
  );
});

test('host が無ければ失敗する', () => {
  assert.throws(() => parseConfig({ nodes: [{ name: 'n1', peer: { port: 7900 } }] }), /host/);
});

test('api も peer も無ければ失敗する', () => {
  assert.throws(() => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com' }] }), /api/);
});

test('api が空オブジェクトで peer も無ければ失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', api: {} }] }),
    /監視対象/,
  );
});

test('ポート番号が範囲外なら失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', peer: { port: 70000 } }] }),
    /65535/,
  );
});

test('ポート番号が整数でなければ失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', api: { http: '3000' } }] }),
    /整数/,
  );
});

test('監視対象が1件も無ければ失敗する', () => {
  assert.throws(() => parseConfig({ nodes: [] }), /監視対象/);
});
```

- [ ] **Step 4: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/config.js'`）

- [ ] **Step 5: `src/config.js` を実装する**

```js
import { readFile } from 'node:fs/promises';

/**
 * 設定オブジェクトを検証し、フラットな監視対象リストに展開する。
 * 検証に失敗した場合は Error を throw する（設定ミスで監視が無言で止まるのを防ぐため）。
 */
export function parseConfig(raw) {
  if (!raw || !Array.isArray(raw.nodes)) {
    throw new Error('config: トップレベルに "nodes" 配列が必要です');
  }

  const targets = [];
  const seenNames = new Set();

  for (const [index, node] of raw.nodes.entries()) {
    const where = `nodes[${index}]`;

    if (typeof node?.name !== 'string' || node.name === '') {
      throw new Error(`${where}: "name" は空でない文字列が必要です`);
    }
    if (seenNames.has(node.name)) {
      throw new Error(`${where}: "name" が重複しています: ${node.name}`);
    }
    seenNames.add(node.name);

    if (typeof node.host !== 'string' || node.host === '') {
      throw new Error(`${where}: "host" は空でない文字列が必要です`);
    }
    if (!node.api && !node.peer) {
      throw new Error(`${where}: "api" か "peer" の少なくとも一方が必要です`);
    }

    const before = targets.length;

    for (const scheme of ['http', 'https']) {
      const port = node.api?.[scheme];
      if (port === undefined) continue;
      assertPort(port, `${where}.api.${scheme}`);
      targets.push({
        key: `${node.name}::api-${scheme}`,
        node: node.name,
        kind: 'api',
        label: `api-${scheme}`,
        url: `${scheme}://${node.host}:${port}`,
      });
    }

    if (node.peer) {
      assertPort(node.peer.port, `${where}.peer.port`);
      targets.push({
        key: `${node.name}::peer`,
        node: node.name,
        kind: 'peer',
        label: 'peer',
        host: node.host,
        port: node.peer.port,
      });
    }

    if (targets.length === before) {
      throw new Error(`${where}: 監視対象が1件も展開されませんでした`);
    }
  }

  if (targets.length === 0) {
    throw new Error('config: 監視対象が1件もありません');
  }

  return targets;
}

export async function loadConfig(path) {
  const text = await readFile(path, 'utf8');
  return parseConfig(JSON.parse(text));
}

function assertPort(port, where) {
  if (!Number.isInteger(port)) {
    throw new Error(`${where}: ポート番号は整数が必要です (受け取った値: ${JSON.stringify(port)})`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`${where}: ポート番号は 1〜65535 の範囲が必要です (受け取った値: ${port})`);
  }
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（13件）

- [ ] **Step 7: コミット**

```bash
git add package.json config/nodes.json src/config.js test/config.test.js
git commit -m "feat: 設定ローダと監視対象の展開を追加"
```

---

## Task 2: 状態ストア

**Files:**
- Create: `src/state.js`
- Test: `test/state.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `INITIAL_TARGET_STATE: TargetState` — 凍結された初期値。Task 3 が import する
  - `createInitialState(): State` — 毎回新しいオブジェクトを返す
  - `normalizeState(raw: unknown): State`
  - `readState(path: string): Promise<State>` — 読めない・壊れている場合は初期状態
  - `writeState(path: string, state: State): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`test/state.test.js`:

```js
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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/state.js'`）

- [ ] **Step 3: `src/state.js` を実装する**

```js
import { readFile, writeFile } from 'node:fs/promises';

export const CURRENT_VERSION = 1;

/** 新規に監視対象を発見したときの初期状態。 */
export const INITIAL_TARGET_STATE = Object.freeze({
  status: 'up',
  consecutiveFailures: 0,
  lastHeight: null,
  lastOkAt: null,
  downSince: null,
  notified: false,
  incidentsThisWeek: 0,
});

export function createInitialState() {
  return { version: CURRENT_VERSION, updatedAt: null, lastWeeklySummaryAt: null, targets: {} };
}

/**
 * 外部から読み込んだ値を State に正規化する。
 * 空・不正・未知バージョンのいずれも初期状態として扱う
 * （state ブランチが存在しない初回実行では "{}" が渡ってくる）。
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== CURRENT_VERSION) {
    return createInitialState();
  }
  if (!raw.targets || typeof raw.targets !== 'object') {
    return createInitialState();
  }

  const targets = {};
  for (const [key, value] of Object.entries(raw.targets)) {
    targets[key] = { ...INITIAL_TARGET_STATE, ...(value ?? {}) };
  }

  return {
    version: CURRENT_VERSION,
    updatedAt: raw.updatedAt ?? null,
    lastWeeklySummaryAt: raw.lastWeeklySummaryAt ?? null,
    targets,
  };
}

export async function readState(path) {
  try {
    return normalizeState(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return createInitialState();
  }
}

export async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（Task 1 の13件 + 10件 = 23件）

- [ ] **Step 5: コミット**

```bash
git add src/state.js test/state.test.js
git commit -m "feat: state.json の読み書きと正規化を追加"
```

---

## Task 3: 判定ロジック（最重要）

**Files:**
- Create: `src/evaluate.js`
- Test: `test/evaluate.test.js`

**Interfaces:**
- Consumes: `INITIAL_TARGET_STATE`, `CURRENT_VERSION`（`src/state.js` から）
- Produces:
  - `FAILURE_THRESHOLD: 2`
  - `WEEK_MS: number`
  - `evaluate({ prevState: State, results: CheckResult[], now: Date }): { nextState: State, events: Event[] }`

**このタスクの注意:** `evaluate` はネットワーク・ファイル・`Date.now()` のいずれにも触れてはならない。現在時刻は必ず引数 `now` から取る。ここを守らないとテストが時刻依存になり、週次サマリの検証ができなくなる。

- [ ] **Step 1: 失敗するテストを書く**

`test/evaluate.test.js`:

```js
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
    results: [ng({ reason: 'chain-stalled', height: '150' })],
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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/evaluate.js'`）

- [ ] **Step 3: `src/evaluate.js` を実装する**

```js
import { CURRENT_VERSION, INITIAL_TARGET_STATE } from './state.js';

/** この回数の連続失敗で初めて DOWN 通知を送る（瞬断による誤報を防ぐ）。 */
export const FAILURE_THRESHOLD = 2;

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const TLS_HINT = 'HTTP(3000) は正常に応答しています。TLS 証明書の期限切れの可能性があります。';

/**
 * 前回の state と今回の検査結果から、新しい state と送るべき通知イベントを求める。
 * 副作用を持たず、現在時刻も引数で受け取る純粋関数であること。
 */
export function evaluate({ prevState, results, now }) {
  const occurredAt = now.toISOString();
  const targets = {};
  const events = [];

  for (const result of results) {
    const prev = prevState.targets?.[result.key] ?? INITIAL_TARGET_STATE;

    if (result.ok) {
      if (prev.notified) {
        events.push(makeEvent('recovered', result, {
          occurredAt,
          downSince: prev.downSince,
          detail: result.detail,
        }));
      }
      targets[result.key] = {
        status: 'up',
        consecutiveFailures: 0,
        lastHeight: result.height ?? prev.lastHeight,
        lastOkAt: occurredAt,
        downSince: null,
        notified: false,
        incidentsThisWeek: prev.incidentsThisWeek,
      };
      continue;
    }

    const consecutiveFailures = prev.consecutiveFailures + 1;
    const downSince = prev.downSince ?? occurredAt;
    const shouldNotify = consecutiveFailures >= FAILURE_THRESHOLD && !prev.notified;

    if (shouldNotify) {
      events.push(makeEvent('down', result, {
        occurredAt,
        downSince,
        detail: result.detail,
        reason: result.reason,
      }));
    }

    targets[result.key] = {
      status: consecutiveFailures >= FAILURE_THRESHOLD ? 'down' : 'up',
      consecutiveFailures,
      // 失敗時は lastHeight を更新しない。復旧判定に前回の正常値を使うため。
      lastHeight: prev.lastHeight,
      lastOkAt: prev.lastOkAt,
      downSince,
      notified: prev.notified || shouldNotify,
      incidentsThisWeek: prev.incidentsThisWeek + (shouldNotify ? 1 : 0),
    };
  }

  annotateTlsHint(events, results);

  let lastWeeklySummaryAt = prevState.lastWeeklySummaryAt ?? null;
  const summaryDue =
    lastWeeklySummaryAt === null ||
    now.getTime() - Date.parse(lastWeeklySummaryAt) >= WEEK_MS;

  if (summaryDue) {
    events.push(buildSummaryEvent(targets, results, occurredAt));
    lastWeeklySummaryAt = occurredAt;
    for (const key of Object.keys(targets)) {
      targets[key].incidentsThisWeek = 0;
    }
  }

  return {
    nextState: { version: CURRENT_VERSION, updatedAt: occurredAt, lastWeeklySummaryAt, targets },
    events,
  };
}

function makeEvent(type, result, { occurredAt, downSince, detail, reason = null }) {
  return {
    type,
    key: result.key,
    node: result.node,
    target: result.label,
    reason,
    detail,
    hint: null,
    downSince,
    occurredAt,
    snapshot: null,
  };
}

/**
 * https だけが落ちていて http が生きている場合、
 * TLS 証明書の期限切れを疑う一文を通知に添える。
 */
function annotateTlsHint(events, results) {
  const okByKey = new Map(results.map((r) => [r.key, r.ok]));
  for (const event of events) {
    if (event.type !== 'down' || event.target !== 'api-https') continue;
    if (okByKey.get(`${event.node}::api-http`) === true) {
      event.hint = TLS_HINT;
    }
  }
}

function buildSummaryEvent(targets, results, occurredAt) {
  const resultByKey = new Map(results.map((r) => [r.key, r]));
  const snapshot = Object.entries(targets).map(([key, state]) => ({
    key,
    node: resultByKey.get(key)?.node ?? null,
    target: resultByKey.get(key)?.label ?? null,
    status: state.status,
    incidentsThisWeek: state.incidentsThisWeek,
    lastOkAt: state.lastOkAt,
    lastHeight: state.lastHeight,
  }));

  return {
    type: 'summary',
    key: null,
    node: null,
    target: null,
    reason: null,
    detail: `監視対象 ${snapshot.length} 件`,
    hint: null,
    downSince: null,
    occurredAt,
    snapshot,
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（累計 39件）

- [ ] **Step 5: コミット**

```bash
git add src/evaluate.js test/evaluate.test.js
git commit -m "feat: 障害判定と通知イベント生成の純粋関数を追加"
```

---

## Task 4: 再試行処理と API ノードの検査

**Files:**
- Create: `src/checks/retry.js`
- Create: `src/checks/api.js`
- Test: `test/checks-retry.test.js`
- Test: `test/checks-api.test.js`

**Interfaces:**
- Consumes: Target（`kind: 'api'`、`url` を持つ）
- Produces:
  - `src/checks/retry.js`: `RETRY_ATTEMPTS: 3`, `RETRY_DELAY_MS: 5000`, `TIMEOUT_MS: 10000`, `RETRYABLE_REASONS: Set<string>`
  - `withRetry(probe: () => Promise<Probe>, opts?): Promise<Probe>`
    - `Probe` は `{ ok, reason, detail, height }`（`key`/`node`/`label` を含まない中間形）
  - `checkApi(target: Target, opts?): Promise<CheckResult>`
    - `opts`: `{ lastHeight?: string|null, fetchImpl?: Function, sleep?: Function, timeoutMs?: number }`

**再試行の方針:** `unreachable` と `bad-response` のみ再試行する。`health-down` と `chain-stalled` はノード自身が返した確定的な回答であり、5秒後に変わる見込みが薄いうえ、連続2回の実行で判定するため再試行する意味がない。無駄に実行時間を延ばさないための判断。

- [ ] **Step 1: 再試行の失敗するテストを書く**

`test/checks-retry.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_ATTEMPTS, TIMEOUT_MS, withRetry } from '../src/checks/retry.js';

const noSleep = async () => {};

test('試行回数の既定値は 3 である', () => {
  assert.equal(RETRY_ATTEMPTS, 3);
});

test('タイムアウトの既定値は 10000ms である', () => {
  assert.equal(TIMEOUT_MS, 10_000);
});

test('1回目で成功すればそれ以上呼ばない', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: true, reason: null, detail: 'ok', height: null }; };
  const result = await withRetry(probe, { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test('unreachable は最大 3 回まで再試行する', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: false, reason: 'unreachable', detail: 'ng', height: null }; };
  const result = await withRetry(probe, { sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
});

test('再試行の途中で成功すればそこで止まる', async () => {
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return calls < 2
      ? { ok: false, reason: 'unreachable', detail: 'ng', height: null }
      : { ok: true, reason: null, detail: 'ok', height: null };
  };
  const result = await withRetry(probe, { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('chain-stalled は再試行しない', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: false, reason: 'chain-stalled', detail: 'ng', height: '1' }; };
  await withRetry(probe, { sleep: noSleep });
  assert.equal(calls, 1);
});

test('health-down は再試行しない', async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return { ok: false, reason: 'health-down', detail: 'ng', height: null }; };
  await withRetry(probe, { sleep: noSleep });
  assert.equal(calls, 1);
});

test('再試行の間に指定した待ち時間で sleep する', async () => {
  const waited = [];
  const probe = async () => ({ ok: false, reason: 'unreachable', detail: 'ng', height: null });
  await withRetry(probe, { sleep: async (ms) => { waited.push(ms); }, delayMs: 5000 });
  // 3回試行なので sleep は 2回
  assert.deepEqual(waited, [5000, 5000]);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/checks/retry.js'`）

- [ ] **Step 3: `src/checks/retry.js` を実装する**

```js
export const RETRY_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 5_000;

/** 1 リクエストあたりのタイムアウト。api.js と peer.js が共有する。 */
export const TIMEOUT_MS = 10_000;

/**
 * 再試行する価値がある失敗理由。
 * ネットワーク層の一時的な揺らぎだけを対象とし、
 * ノード自身が返した確定的な異常（health-down / chain-stalled）は再試行しない。
 */
export const RETRYABLE_REASONS = new Set(['unreachable', 'bad-response']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry(probe, options = {}) {
  const {
    attempts = RETRY_ATTEMPTS,
    delayMs = RETRY_DELAY_MS,
    sleep = defaultSleep,
    retryable = RETRYABLE_REASONS,
  } = options;

  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await probe();
    if (last.ok || !retryable.has(last.reason)) return last;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return last;
}
```

- [ ] **Step 4: 再試行のテストが通ることを確認する**

Run: `npm test`
Expected: PASS（累計 47件）

- [ ] **Step 5: API 検査の失敗するテストを書く**

`test/checks-api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApi } from '../src/checks/api.js';

const TARGET = {
  key: 'n1::api-https', node: 'n1', kind: 'api',
  label: 'api-https', url: 'https://example.com:3001',
};

const noSleep = async () => {};

/** URL ごとに応答を返す fetch のモックを作る。 */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`想定外の URL: ${url}`);
    if (typeof route === 'function') return route();
    return route;
  };
  return { impl, calls };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const HEALTH_URL = 'https://example.com:3001/node/health';
const CHAIN_URL = 'https://example.com:3001/chain/info';

const healthyRoutes = (height) => ({
  [HEALTH_URL]: jsonResponse(200, { status: { apiNode: 'up', db: 'up' } }),
  [CHAIN_URL]: jsonResponse(200, { height }),
});

test('health が up で height が進んでいれば成功する', async () => {
  const { impl } = mockFetch(healthyRoutes('200'));
  const result = await checkApi(TARGET, { lastHeight: '100', fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(result, {
    key: 'n1::api-https', node: 'n1', label: 'api-https',
    ok: true, reason: null, detail: '正常 (height=200)', height: '200',
  });
});

test('初回（lastHeight が null）は進行チェックをせず成功する', async () => {
  const { impl } = mockFetch(healthyRoutes('200'));
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(result.height, '200');
});

test('height が前回と同じなら chain-stalled になる', async () => {
  const { impl } = mockFetch(healthyRoutes('100'));
  const result = await checkApi(TARGET, { lastHeight: '100', fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'chain-stalled');
  assert.match(result.detail, /100/);
});

test('height が巻き戻っていても chain-stalled になる', async () => {
  const { impl } = mockFetch(healthyRoutes('99'));
  const result = await checkApi(TARGET, { lastHeight: '100', fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'chain-stalled');
});

test('height は文字列比較ではなく数値として比較される', async () => {
  // 文字列比較だと "9" > "10" となり誤判定する
  const { impl } = mockFetch(healthyRoutes('10'));
  const result = await checkApi(TARGET, { lastHeight: '9', fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, true);
});

test('apiNode が down なら health-down になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(503, { status: { apiNode: 'down', db: 'up' } }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'health-down');
});

test('db が down なら health-down になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(503, { status: { apiNode: 'up', db: 'down' } }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'health-down');
});

test('health が 2xx でなければ health-down になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(500, { status: { apiNode: 'up', db: 'up' } }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'health-down');
});

test('health が異常なら chain/info は呼ばない', async () => {
  const { impl, calls } = mockFetch({
    [HEALTH_URL]: jsonResponse(503, { status: { apiNode: 'down', db: 'up' } }),
  });
  await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(calls, [HEALTH_URL]);
});

test('接続できなければ unreachable になり 3 回試行する', async () => {
  let calls = 0;
  const impl = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'unreachable');
  assert.equal(calls, 3);
  assert.match(result.detail, /ECONNREFUSED/);
});

test('応答が JSON でなければ bad-response になる', async () => {
  const impl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'bad-response');
});

test('height が数字文字列でなければ bad-response になる', async () => {
  const { impl } = mockFetch({
    [HEALTH_URL]: jsonResponse(200, { status: { apiNode: 'up', db: 'up' } }),
    [CHAIN_URL]: jsonResponse(200, { height: 12345 }),
  });
  const result = await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'bad-response');
});

test('health-down は再試行しない', async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return jsonResponse(503, { status: { apiNode: 'down', db: 'up' } });
  };
  await checkApi(TARGET, { lastHeight: null, fetchImpl: impl, sleep: noSleep });
  assert.equal(calls, 1);
});
```

- [ ] **Step 6: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/checks/api.js'`）

- [ ] **Step 7: `src/checks/api.js` を実装する**

```js
import { TIMEOUT_MS, withRetry } from './retry.js';

/**
 * API ノードを検査する。
 * 1) /node/health が apiNode と db の両方で up を返すか
 * 2) /chain/info の height が前回より進んでいるか
 */
export async function checkApi(target, options = {}) {
  const {
    lastHeight = null,
    fetchImpl = fetch,
    sleep,
    timeoutMs = TIMEOUT_MS,
  } = options;

  const probe = () => probeApi(target, lastHeight, fetchImpl, timeoutMs);
  const result = await withRetry(probe, sleep ? { sleep } : {});

  return { key: target.key, node: target.node, label: target.label, ...result };
}

async function probeApi(target, lastHeight, fetchImpl, timeoutMs) {
  const health = await fetchJson(`${target.url}/node/health`, fetchImpl, timeoutMs);
  if (health.error) return health.error;

  const apiNode = health.body?.status?.apiNode;
  const db = health.body?.status?.db;
  if (!health.response.ok || apiNode !== 'up' || db !== 'up') {
    return fail(
      'health-down',
      `/node/health が異常です (HTTP ${health.response.status}, apiNode=${apiNode}, db=${db})`,
    );
  }

  const chain = await fetchJson(`${target.url}/chain/info`, fetchImpl, timeoutMs);
  if (chain.error) return chain.error;

  const height = chain.body?.height;
  if (!chain.response.ok || typeof height !== 'string' || !/^\d+$/.test(height)) {
    return fail(
      'bad-response',
      `/chain/info の height が不正です (HTTP ${chain.response.status}, height=${JSON.stringify(height)})`,
    );
  }

  if (lastHeight !== null && BigInt(height) <= BigInt(lastHeight)) {
    return {
      ok: false,
      reason: 'chain-stalled',
      detail: `チェーン高が進んでいません (前回 ${lastHeight} → 今回 ${height})`,
      height,
    };
  }

  return { ok: true, reason: null, detail: `正常 (height=${height})`, height };
}

/** 取得と JSON 解析をまとめて行い、失敗時は検査結果の形でエラーを返す。 */
async function fetchJson(url, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { error: fail('unreachable', `${url} に接続できません: ${err.message}`) };
  }

  try {
    return { response, body: await response.json() };
  } catch {
    return { error: fail('bad-response', `${url} の応答が JSON ではありません (HTTP ${response.status})`) };
  }
}

function fail(reason, detail) {
  return { ok: false, reason, detail, height: null };
}
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（累計 60件）

- [ ] **Step 9: コミット**

```bash
git add src/checks/retry.js src/checks/api.js test/checks-retry.test.js test/checks-api.test.js
git commit -m "feat: 再試行処理と API ノードの検査を追加"
```

---

## Task 5: Peer ノードの検査

**Files:**
- Create: `src/checks/peer.js`
- Test: `test/checks-peer.test.js`

**Interfaces:**
- Consumes: `withRetry`（`src/checks/retry.js`）、Target（`kind: 'peer'`、`host` と `port` を持つ）
- Produces: `checkPeer(target: Target, opts?): Promise<CheckResult>`
  - `opts`: `{ connectImpl?: Function, sleep?: Function, timeoutMs?: number }`
  - `connectImpl({ host, port })` は `net.Socket` 互換（`setTimeout`/`destroy`/`once` を持つ EventEmitter）を返す

**背景:** Symbol の Peer ポート(7900)は相互 TLS 認証であり、Symbol PKI で署名されたクライアント証明書なしに完全なハンドシェイクは成立しない。そのため「TCP 接続が確立する = プロセスが生きて listen している」ところまでを担保範囲とする。

- [ ] **Step 1: 失敗するテストを書く**

`test/checks-peer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkPeer } from '../src/checks/peer.js';

const TARGET = { key: 'n1::peer', node: 'n1', kind: 'peer', label: 'peer', host: 'example.com', port: 7900 };

const noSleep = async () => {};

/** net.Socket の最小限の代用品。`behavior` で発火させるイベントを決める。 */
class FakeSocket extends EventEmitter {
  constructor(behavior) {
    super();
    this.destroyed = false;
    this.timeoutMs = null;
    queueMicrotask(() => behavior(this));
  }

  setTimeout(ms) {
    this.timeoutMs = ms;
  }

  destroy() {
    this.destroyed = true;
  }
}

const connecting = () => (socket) => socket.emit('connect');
const timingOut = () => (socket) => socket.emit('timeout');
const erroring = (message) => (socket) => socket.emit('error', new Error(message));

test('接続できれば成功する', async () => {
  const result = await checkPeer(TARGET, { connectImpl: () => new FakeSocket(connecting()), sleep: noSleep });
  assert.deepEqual(result, {
    key: 'n1::peer', node: 'n1', label: 'peer',
    ok: true, reason: null,
    detail: 'TCP example.com:7900 に接続できました', height: null,
  });
});

test('接続先の host と port が渡される', async () => {
  let received = null;
  await checkPeer(TARGET, {
    connectImpl: (opts) => { received = opts; return new FakeSocket(connecting()); },
    sleep: noSleep,
  });
  assert.deepEqual(received, { host: 'example.com', port: 7900 });
});

test('成功後にソケットを破棄する', async () => {
  let socket = null;
  await checkPeer(TARGET, {
    connectImpl: () => { socket = new FakeSocket(connecting()); return socket; },
    sleep: noSleep,
  });
  assert.equal(socket.destroyed, true);
});

test('タイムアウトすれば unreachable になる', async () => {
  const result = await checkPeer(TARGET, { connectImpl: () => new FakeSocket(timingOut()), sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /タイムアウト/);
});

test('エラーなら unreachable になりメッセージが残る', async () => {
  const result = await checkPeer(TARGET, {
    connectImpl: () => new FakeSocket(erroring('ECONNREFUSED')),
    sleep: noSleep,
  });
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /ECONNREFUSED/);
});

test('失敗したら 3 回試行する', async () => {
  let calls = 0;
  await checkPeer(TARGET, {
    connectImpl: () => { calls += 1; return new FakeSocket(erroring('ECONNREFUSED')); },
    sleep: noSleep,
  });
  assert.equal(calls, 3);
});

test('タイムアウト値がソケットに設定される', async () => {
  let socket = null;
  await checkPeer(TARGET, {
    connectImpl: () => { socket = new FakeSocket(connecting()); return socket; },
    sleep: noSleep,
    timeoutMs: 1234,
  });
  assert.equal(socket.timeoutMs, 1234);
});

test('connectImpl が同期的に throw しても unreachable になる', async () => {
  const result = await checkPeer(TARGET, {
    connectImpl: () => { throw new Error('EAI_AGAIN'); },
    sleep: noSleep,
  });
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /EAI_AGAIN/);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/checks/peer.js'`）

- [ ] **Step 3: `src/checks/peer.js` を実装する**

```js
import net from 'node:net';
import { TIMEOUT_MS, withRetry } from './retry.js';

/**
 * Peer ノードを検査する。
 * Symbol の 7900 番は相互 TLS 認証のため完全なハンドシェイクは証明書なしに成立しない。
 * ここでは TCP 接続が確立するか（= プロセスが生きて listen しているか）までを確認する。
 */
export async function checkPeer(target, options = {}) {
  const { connectImpl = net.connect, sleep, timeoutMs = TIMEOUT_MS } = options;

  const probe = () => probePeer(target, connectImpl, timeoutMs);
  const result = await withRetry(probe, sleep ? { sleep } : {});

  return { key: target.key, node: target.node, label: target.label, ...result };
}

function probePeer(target, connectImpl, timeoutMs) {
  const where = `TCP ${target.host}:${target.port}`;

  return new Promise((resolve) => {
    let socket;
    try {
      socket = connectImpl({ host: target.host, port: target.port });
    } catch (err) {
      resolve(fail(`${where} に接続できません: ${err.message}`));
      return;
    }

    const settle = (result) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle({
      ok: true, reason: null, detail: `${where} に接続できました`, height: null,
    }));
    socket.once('timeout', () => settle(fail(`${where} がタイムアウトしました (${timeoutMs}ms)`)));
    socket.once('error', (err) => settle(fail(`${where} に接続できません: ${err.message}`)));
  });
}

function fail(detail) {
  return { ok: false, reason: 'unreachable', detail, height: null };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（累計 68件）

- [ ] **Step 5: コミット**

```bash
git add src/checks/peer.js test/checks-peer.test.js
git commit -m "feat: Peer ノードの TCP 疎通検査を追加"
```

---

## Task 6: 通知アダプタ

**Files:**
- Create: `src/notify/format.js`
- Create: `src/notify/discord.js`
- Create: `src/notify/slack.js`
- Create: `src/notify/index.js`
- Test: `test/notify.test.js`

**Interfaces:**
- Consumes: Event（`src/evaluate.js` が生成）
- Produces:
  - `titleOf(event: Event): string`, `describeEvent(event: Event): string`（`format.js`。通知先に依存しない文面を作る）
  - `formatDiscord(events: Event[]): object[]` — Discord Webhook のリクエストボディ配列（embeds を10件ずつに分割）
  - `sendDiscord(url: string, events: Event[], opts?): Promise<void>` — 失敗時は throw
  - `formatSlack(events: Event[]): object[]` — Slack Webhook のリクエストボディ配列（attachments を20件ずつに分割）
  - `sendSlack(url: string, events: Event[], opts?): Promise<void>` — 失敗時は throw
  - `dispatch(events: Event[], opts?): Promise<{ channels: number, delivered: number }>`
    - `opts`: `{ discordUrl?, slackUrl?, fetchImpl?, logger? }`

**1リクエストにまとめる理由:** 多数のノードが同時に落ちた場合にイベント単位で送ると Webhook のレート制限に当たる。Discord は1メッセージあたり embeds 10件、Slack は attachments 20件を上限として分割する。

- [ ] **Step 1: 失敗するテストを書く**

`test/notify.test.js`:

```js
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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/notify/discord.js'`）

- [ ] **Step 3: `src/notify/format.js`（通知先に依存しない文面生成）を実装する**

```js
const TYPE_LABELS = { down: '🔴 DOWN', recovered: '🟢 復旧', summary: '📊 週次サマリ' };
const STATUS_ICONS = { up: '🟢', down: '🔴' };

export function titleOf(event) {
  if (event.type === 'summary') return TYPE_LABELS.summary;
  return `${TYPE_LABELS[event.type]}: ${event.node} (${event.target})`;
}

export function describeEvent(event) {
  if (event.type === 'summary') return describeSummary(event);

  const lines = [event.detail];
  if (event.hint) lines.push('', event.hint);
  if (event.downSince) lines.push('', `障害開始: ${event.downSince}`);
  lines.push(`確認時刻: ${event.occurredAt}`);
  return lines.join('\n');
}

function describeSummary(event) {
  const lines = event.snapshot.map((item) => {
    const icon = STATUS_ICONS[item.status] ?? '❔';
    const parts = [`${icon} ${item.node} / ${item.target}`, `障害 ${item.incidentsThisWeek} 回`];
    if (item.lastHeight) parts.push(`height ${item.lastHeight}`);
    parts.push(`最終正常 ${item.lastOkAt ?? '未確認'}`);
    return parts.join(' — ');
  });
  lines.push('', `確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

/** Discord の description は 4096 文字が上限なので余裕を持って切る。 */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(省略)`;
}
```

- [ ] **Step 4: `src/notify/discord.js` を実装する**

```js
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
```

- [ ] **Step 5: `src/notify/slack.js` を実装する**

```js
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
```

- [ ] **Step 6: `src/notify/index.js` を実装する**

```js
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
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（累計 86件）

- [ ] **Step 8: コミット**

```bash
git add src/notify/ test/notify.test.js
git commit -m "feat: Discord と Slack への通知アダプタを追加"
```

---

## Task 7: エントリポイントの結線

**Files:**
- Create: `src/index.js`
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `readState`, `writeState`, `evaluate`, `checkApi`, `checkPeer`, `dispatch`
- Produces: `main(overrides?): Promise<number>` — プロセスの終了コードを返す

**終了コードの規約:**

| 状況 | 終了コード | 理由 |
|---|---|---|
| 正常（ノードが落ちていても） | 0 | ノード障害は通知で伝える。ワークフロー失敗にすると GitHub の失敗メールと二重になり、監視システム自体の異常と区別できなくなる |
| 設定ファイルが不正・読めない | 1 | 監視システム自体の異常。GitHub の失敗メールが最後の砦になる |
| 送信先が1つ以上あるのに全て失敗 | 1 | **state を書かずに終了する。** `notified` が立たないため次回実行で通知が再試行される |

- [ ] **Step 1: 失敗するテストを書く**

`test/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const TARGETS = [
  { key: 'n1::api-https', node: 'n1', kind: 'api', label: 'api-https', url: 'https://a.test:3001' },
  { key: 'n1::peer', node: 'n1', kind: 'peer', label: 'peer', host: 'a.test', port: 7900 },
];

const emptyState = () => ({ version: 1, updatedAt: null, lastWeeklySummaryAt: '2026-10-04T12:00:00.000Z', targets: {} });

/** すべての依存をモックした main の既定引数を作る。 */
function deps(over = {}) {
  const written = [];
  return {
    written,
    overrides: {
      loadConfig: async () => TARGETS,
      readState: async () => emptyState(),
      writeState: async (_path, state) => { written.push(state); },
      checkApi: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: '正常', height: '200' }),
      checkPeer: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: '正常', height: null }),
      dispatch: async () => ({ channels: 1, delivered: 1 }),
      now: () => new Date('2026-10-04T13:00:00.000Z'),
      logger: silentLogger,
      env: {},
      ...over,
    },
  };
}

test('全て正常なら 0 を返し state を書く', async () => {
  const { written, overrides } = deps();
  assert.equal(await main(overrides), 0);
  assert.equal(written.length, 1);
  assert.equal(written[0].targets['n1::api-https'].lastHeight, '200');
  assert.equal(written[0].targets['n1::peer'].status, 'up');
});

test('kind に応じて checkApi と checkPeer を使い分ける', async () => {
  const seen = { api: [], peer: [] };
  const { overrides } = deps({
    checkApi: async (target) => { seen.api.push(target.key); return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: '200' }; },
    checkPeer: async (target) => { seen.peer.push(target.key); return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: null }; },
  });
  await main(overrides);
  assert.deepEqual(seen, { api: ['n1::api-https'], peer: ['n1::peer'] });
});

test('前回の lastHeight が checkApi に渡される', async () => {
  let passed;
  const { overrides } = deps({
    readState: async () => ({
      ...emptyState(),
      targets: { 'n1::api-https': { status: 'up', consecutiveFailures: 0, lastHeight: '150', lastOkAt: null, downSince: null, notified: false, incidentsThisWeek: 0 } },
    }),
    checkApi: async (target, opts) => { passed = opts.lastHeight; return { key: target.key, node: target.node, label: target.label, ok: true, reason: null, detail: 'ok', height: '200' }; },
  });
  await main(overrides);
  assert.equal(passed, '150');
});

test('ノードが落ちていても終了コードは 0', async () => {
  const { overrides } = deps({
    checkApi: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: false, reason: 'unreachable', detail: 'ng', height: null }),
    checkPeer: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: false, reason: 'unreachable', detail: 'ng', height: null }),
  });
  assert.equal(await main(overrides), 0);
});

test('設定が読めなければ 1 を返し state を書かない', async () => {
  const { written, overrides } = deps({
    loadConfig: async () => { throw new Error('config: 壊れています'); },
  });
  assert.equal(await main(overrides), 1);
  assert.equal(written.length, 0);
});

test('通知先がありながら全て送信失敗なら 1 を返し state を書かない', async () => {
  const { written, overrides } = deps({
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }), // サマリを発火させる
    dispatch: async () => ({ channels: 2, delivered: 0 }),
  });
  assert.equal(await main(overrides), 1);
  assert.equal(written.length, 0);
});

test('通知先が未設定（channels 0）なら 0 を返し state を書く', async () => {
  const { written, overrides } = deps({
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }),
    dispatch: async () => ({ channels: 0, delivered: 0 }),
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written.length, 1);
});

test('Webhook URL を環境変数から dispatch に渡す', async () => {
  let received;
  const { overrides } = deps({
    readState: async () => ({ ...emptyState(), lastWeeklySummaryAt: null }),
    env: { DISCORD_WEBHOOK_URL: 'https://d.test', SLACK_WEBHOOK_URL: 'https://s.test' },
    dispatch: async (_events, opts) => { received = opts; return { channels: 2, delivered: 2 }; },
  });
  await main(overrides);
  assert.equal(received.discordUrl, 'https://d.test');
  assert.equal(received.slackUrl, 'https://s.test');
});

test('イベントが無ければ dispatch を呼ばずに state を書く', async () => {
  let called = false;
  const { written, overrides } = deps({
    dispatch: async () => { called = true; return { channels: 0, delivered: 0 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(called, false);
  assert.equal(written.length, 1);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../src/index.js'`）

- [ ] **Step 3: `src/index.js` を実装する**

```js
import { pathToFileURL } from 'node:url';
import { loadConfig as defaultLoadConfig } from './config.js';
import { readState as defaultReadState, writeState as defaultWriteState } from './state.js';
import { evaluate as defaultEvaluate } from './evaluate.js';
import { checkApi as defaultCheckApi } from './checks/api.js';
import { checkPeer as defaultCheckPeer } from './checks/peer.js';
import { dispatch as defaultDispatch } from './notify/index.js';

/**
 * 1回分の監視を実行し、プロセスの終了コードを返す。
 * 依存はすべて引数で差し替えられるようにしてある（テストでネットワークを使わないため）。
 */
export async function main(overrides = {}) {
  const {
    loadConfig = defaultLoadConfig,
    readState = defaultReadState,
    writeState = defaultWriteState,
    evaluate = defaultEvaluate,
    checkApi = defaultCheckApi,
    checkPeer = defaultCheckPeer,
    dispatch = defaultDispatch,
    now = () => new Date(),
    logger = console,
    env = process.env,
  } = overrides;

  const configPath = env.CONFIG_PATH ?? 'config/nodes.json';
  const statePath = env.STATE_PATH ?? 'state.json';

  let targets;
  try {
    targets = await loadConfig(configPath);
  } catch (err) {
    logger.error(`設定の読み込みに失敗しました (${configPath}): ${err.message}`);
    return 1;
  }

  const prevState = await readState(statePath);

  const results = await Promise.all(
    targets.map((target) =>
      target.kind === 'api'
        ? checkApi(target, { lastHeight: prevState.targets[target.key]?.lastHeight ?? null })
        : checkPeer(target)),
  );

  const { nextState, events } = evaluate({ prevState, results, now: now() });

  const downCount = results.filter((r) => !r.ok).length;
  logger.log(`監視対象 ${results.length} 件を検査しました（異常 ${downCount} 件、通知 ${events.length} 件）`);

  if (events.length > 0) {
    const { channels, delivered } = await dispatch(events, {
      discordUrl: env.DISCORD_WEBHOOK_URL,
      slackUrl: env.SLACK_WEBHOOK_URL,
      logger,
    });

    // 送信先があるのに1つも届かなかった場合は state を更新しない。
    // notified が立たないまま次回実行に持ち越し、通知を再試行させる。
    if (channels > 0 && delivered === 0) {
      logger.error('すべての通知先への送信に失敗したため state を更新せず終了します');
      return 1;
    }
  }

  await writeState(statePath, nextState);
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`想定外のエラーで終了しました: ${err.stack ?? err.message}`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（累計 95件）

- [ ] **Step 5: コミット**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: エントリポイントを結線し終了コードの規約を実装"
```

---

## Task 8: GitHub Actions ワークフローと README

**Files:**
- Create: `.github/workflows/monitor.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `src/index.js`（`node src/index.js` で起動）、`config/nodes.json`
- Produces: なし（最終タスク）

**このタスクの注意:** ここが壊れると監視が無言で停止し、通知が来ないことを「ノードが正常」と誤解する最悪の失敗モードになる。`Persist state` の挙動は必ず実機で確認すること。

- [ ] **Step 1: `.github/workflows/monitor.yml` を作る**

```yaml
name: node-alive-monitor

on:
  schedule:
    # GitHub Actions の cron は公称 5 分が最短だが、実際には 10〜30 分遅延したり
    # スキップされたりする。判定を経過時間ではなく height の増加に基づかせているため、
    # 遅延しても誤検知にはならない。
    - cron: '*/10 * * * *'
  workflow_dispatch:

permissions:
  # monitoring-state ブランチへの push に必要
  contents: write

concurrency:
  # state の書き込み競合を防ぐ
  group: node-alive-monitor
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Restore state
        # raw.githubusercontent.com は CDN キャッシュで古い値を返すため使わない。
        run: |
          if git fetch --depth=1 origin monitoring-state 2>/dev/null \
             && git show FETCH_HEAD:state.json > state.json 2>/dev/null; then
            echo "既存の state を復元しました"
          else
            echo '{}' > state.json
            echo "既存の state がないため初期状態から開始します"
          fi

      - name: Run checks
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: node src/index.js

      - name: Persist state
        # 検査が途中で落ちた場合は復元した古い state をそのまま push し直すだけで害はない。
        # この push が「リポジトリ活動」となり、Public リポジトリの
        # scheduled workflow が 60 日で自動停止する仕様を回避する。
        if: always()
        run: |
          test -f state.json || exit 0
          tmp="$(mktemp -d)"
          cp state.json "$tmp/state.json"
          cd "$tmp"
          git init -q
          git add state.json
          git -c user.name='node-alive-monitor' \
              -c user.email='actions@users.noreply.github.com' \
              commit -q -m "state: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
          git push -q --force \
            "https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/${{ github.repository }}.git" \
            HEAD:monitoring-state
```

- [ ] **Step 2: `README.md` を作る**

````markdown
# node_alive_monitoring

Symbol の API ノード / Peer ノードを GitHub Actions だけで死活監視し、
異常を Discord と Slack に通知する。サーバーもデータベースも不要。

## 仕組み

10 分ごとに cron で Node.js スクリプトを 1 回実行する。
実行間の状態（前回のチェーン高、連続失敗回数、通知済みフラグ）は
`monitoring-state` ブランチの `state.json` に force push して引き継ぐ。

## 監視内容

| 対象 | 確認すること |
|---|---|
| API (http / https) | `/node/health` が `apiNode` と `db` の両方で `up` を返すか |
| API (http / https) | `/chain/info` の `height` が前回より進んでいるか |
| Peer | 7900 番への TCP 接続が確立するか |

2 回連続で失敗したときに初めて通知する（瞬断による誤報を防ぐため、実質 20 分継続した障害が対象）。
障害が続いている間は再通知しない。復旧したら復旧通知を送る。

## セットアップ

### 1. リポジトリを Public で作成する

Public にすると GitHub Actions の実行時間が無制限になり、完全に無料で運用できる。
ノードのホスト名は公開されるが、Symbol ノードはもともと公開情報である。
Webhook URL は Secrets に入れるため漏れない。

### 2. Webhook URL を取得する

- **Discord**: サーバー設定 → 連携サービス → ウェブフック → 新しいウェブフック → URL をコピー
- **Slack**: Slack App を作成 → Incoming Webhooks を有効化 → チャンネルを選んで URL をコピー

### 3. Secrets に登録する

リポジトリの Settings → Secrets and variables → Actions → New repository secret:

| 名前 | 値 |
|---|---|
| `DISCORD_WEBHOOK_URL` | Discord の Webhook URL |
| `SLACK_WEBHOOK_URL` | Slack の Webhook URL |

どちらも任意。片方だけでも動作する。

### 4. 監視対象を設定する

`config/nodes.json` を編集する。

```json
{
  "nodes": [
    {
      "name": "my-node-01",
      "host": "node1.example.com",
      "api": { "http": 3000, "https": 3001 },
      "peer": { "port": 7900 }
    },
    {
      "name": "peer-only-node",
      "host": "node2.example.com",
      "peer": { "port": 7900 }
    }
  ]
}
```

- `name` は状態管理のキーに使うため、一意かつ変更しないこと。変更すると履歴が切れて新規ノード扱いになる。
- `api.http` / `api.https` / `peer.port` はそれぞれ任意。書いたものだけを検査する。
- http と https を両方書くと別々に監視される。https だけが落ちる（TLS 証明書の期限切れ）パターンを検知できる。

### 5. 動作確認する

Actions タブ → `node-alive-monitor` → Run workflow で手動実行する。
初回実行では必ずサマリ通知が送られるので、Discord / Slack に届くことを確認する。

## 通知の種類

| 種類 | 発火条件 |
|---|---|
| 🔴 DOWN | 2 回連続で検査に失敗したとき（1 回だけ） |
| 🟢 復旧 | DOWN 通知済みの対象が正常に戻ったとき |
| 📊 週次サマリ | 前回サマリから 7 日経過したとき、および初回実行時 |

**週次サマリが届かなくなったら監視システム自体が止まったサイン。**
無料監視の最大の落とし穴は「監視が止まっていることに気づかない」ことなので、
これを唯一の生存信号としている。

## ローカルでの実行

```bash
npm test                              # テストを実行する（ネットワークアクセスなし）
DISCORD_WEBHOOK_URL=... node src/index.js   # 実際に 1 回検査する
```

環境変数 `CONFIG_PATH`（既定 `config/nodes.json`）と `STATE_PATH`（既定 `state.json`）で
パスを差し替えられる。

## 終了コードの意味

| コード | 意味 |
|---|---|
| 0 | 正常終了。ノードが落ちていてもこちら（障害は通知で伝える） |
| 1 | 監視システム自体の異常（設定不正、全通知先への送信失敗）。GitHub から失敗メールが届く |

## 設計資料

- 設計書: `docs/superpowers/specs/2026-10-04-node-alive-monitoring-design.md`
- 実装計画: `docs/superpowers/plans/2026-10-04-node-alive-monitoring.md`
````

- [ ] **Step 3: テストが全て通ることを最終確認する**

Run: `npm test`
Expected: PASS（95件、失敗 0件）

- [ ] **Step 4: 実際に 1 回動かして確認する**

`config/nodes.json` を実在する Symbol ノードに書き換えてから実行する。

Run: `node src/index.js`
Expected: `監視対象 N 件を検査しました` が出力され、終了コードが 0。`state.json` が生成されている。

- [ ] **Step 5: コミット**

```bash
git add .github/workflows/monitor.yml README.md
git commit -m "feat: GitHub Actions ワークフローと README を追加"
```

---

## 完了条件

- [ ] `npm test` が 95 件すべて通る
- [ ] `node src/index.js` がローカルで実在ノードに対して完走する
- [ ] GitHub に Public リポジトリとして push されている
- [ ] Secrets に Webhook URL が登録されている
- [ ] `workflow_dispatch` での手動実行が成功し、初回サマリが Discord / Slack に届く
- [ ] `monitoring-state` ブランチが作成され `state.json` が入っている
- [ ] 2 回目の手動実行で前回の height と比較した判定が行われている（ログで確認）
