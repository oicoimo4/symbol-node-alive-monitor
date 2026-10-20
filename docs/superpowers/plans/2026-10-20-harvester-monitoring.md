# Harvester 増減監視 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `harvesters: true` を指定したノードについて、委任されている harvester の参加・離脱を検知して Discord / Slack に通知し、週次サマリに現在件数を載せる。

**Architecture:** 死活監視（`evaluate.js`）には一切手を入れず、harvester を独立した経路で扱う。`config.js` が `kind: 'harvesters'` の Target を展開し、`index.js` がそれを死活監視の Target から振り分けて `checks/harvesters.js` で取得、`harvesters.js` の純粋関数で前回の一覧と比較する。結果は `state.harvesters` に保存し、イベントは死活監視のイベントの後ろに連結し、週次サマリには後処理で件数を付け加える。

**Tech Stack:** Node.js 20 以上（外部依存ゼロ）、ESM、`node:test`、GitHub Actions

**Spec:** `docs/superpowers/specs/2026-10-20-harvester-monitoring-design.md`（実装者はこの計画と設計書の両方を読むこと）

## 実行前の準備

```bash
git switch -c feat/harvester-monitoring
git add docs/superpowers/plans/2026-10-20-harvester-monitoring.md
git commit -m "docs: harvester 増減監視の実装計画を追加"
```

現時点のテストは **114 件すべて成功**する。各タスクの「期待する件数」はここからの累計。

## Global Constraints

これらは全タスクの要件に暗黙に含まれる。

- **外部依存を一切追加しない。** Symbol SDK も使わない（公開鍵からアドレスへの変換はスコープ外）。HTTP は global `fetch`、テストは `node:test` + `node:assert/strict` のみ。
- **`src/evaluate.js` は一行も変更しない。**
- **`src/checks/api.js` / `peer.js` / `retry.js`、`src/notify/webhook.js` / `src/notify/index.js` は変更しない。** `src/notify/discord.js` / `slack.js` は `COLORS` に `harvesters` の 1 キーを足すだけ。
- **state の `version` は 1 のまま上げない。** 上げると既存の state が「未知のバージョン」として初期化され、通知済みフラグや週次カウンタが消える。
- **harvester の Target は `{ key: `${name}::harvesters`, node, kind: 'harvesters', label: 'harvesters', url }`。** `state.harvesters` はノード名をキーにする。
- **`harvesters` は省略時 `false`（明示的なオプトイン）。** `true` なのに `api` のポートが無ければ起動時エラー。取得先は https を優先し、無ければ http。1 ノードにつき 1 回だけ取得する。
- **タイムアウトは `TIMEOUT_MS`（`src/checks/retry.js` から import）、再試行は `withRetry`**（`unreachable` / `bad-response` のみ再試行）。
- **通知の見た目:** 色は Discord `0xecb22e` / Slack `'#ecb22e'`、見出しは `🌾 Harvester 変化: {node}`、公開鍵は **先頭 12 文字 + `…`**。参加・離脱のうち空のほうは行ごと出さない。
- **テストの起動:** 全体は引数なしの `node --test`。1 ファイルだけなら `node --test test/<name>.test.js`。**ディレクトリを引数に渡さない**（Node 26 系で誤解釈される）。
- **テストはネットワークに触れない。** `fetch` は必ず `fetchImpl` で注入してモックする。
- **コメント・エラーメッセージ・通知文は日本語。** 変数名と関数名は英語。周囲のコードのコメント密度と書き方に合わせる。
- **コミットは各タスクの最後に 1 回。** メッセージは `feat:` / `test:` / `docs:` / `config:` で始める。ハーネスが指示する `Co-Authored-By` 行があれば末尾に付ける。
- **`config/nodes.json` に `harvesters: true` を書くのは Task 7 だけ。** Task 6 より前の `index.js` は `kind: 'harvesters'` の Target を `checkPeer` に渡してしまい、偽の DOWN 通知になる。

## 設計書からの補足（計画で確定させたこと）

設計書の方針は変えず、設計書が名前や形を決めていなかった部分をここで確定させる。

- **api 成功の判定（設計書 8 章）は `gateByApiHealth(observations, results)` として `src/harvesters.js` に置く。** `index.js` に書くと純粋関数として単体テストできないため。
- **`checkHarvesters` の戻り値は設計書の `{ node, ok, accounts, detail }` に `key` / `label` / `reason` を足したもの。** `checkApi` と同じ形に揃えるため。
- **`evaluateHarvesters` も一覧を集合として扱い、重複を除いてソートして保存する。** `checkHarvesters` もソートするが、判定側が入力の並びに依存しないようにする。
- **週次サマリの harvester 行に `— 最終確認 {observedAt}` を足す**（設計書 12.1 の行の末尾に追加）。一覧の取得が失敗し続けていても件数だけは前回の値で出続けるため、古さが見えないと気づけない。既存の対象行の `最終正常` と同じ考え方。
- **壊れた `state.harvesters` のエントリ（`accounts` が文字列の配列でない等）は `normalizeState` で捨てる。** 捨てられたノードは次回「初回観測」として黙って記録し直される。

## Review Focus

設計書が直接は書いていないが、利用者が踏むと最も困る入力・状況。各行のテストは担当タスクに入れてある。

1. **ノードが止まっている・不調な回に、取得失敗や空の一覧で「全員離脱」の誤報が出ないこと。** 同じ実行で api 検査が成功したノードだけを比較し、それ以外は前回の一覧を保持する。→ Task 4「api が落ちている回に空の一覧が返っても全員離脱の誤報を出さない」、Task 6「api が異常なノードでは harvester を比較せず、前回の一覧を残す」
2. **harvester の Target が死活監視の経路に漏れて偽の DOWN 通知にならないこと。** `evaluate` にも `checkPeer` にも渡らず、例外時の合成結果が添字ずれで別の対象に付かない。→ Task 6「harvesters の対象は evaluate に渡さず…」「harvesters の対象が混ざっていても、例外を投げた検査は正しい対象に紐づく」
3. **通知が 1 件も届かなかった回の harvester 変化が state に吸収されて消えないこと。** state を書かずに終了し、次回もう一度同じ変化を通知する。→ Task 6「harvester の変化を 1 件も届けられなければ state を更新せず次回に持ち越す」
4. **harvester 監視を入れる前の state や壊れた state でも落ちず、誤った差分も出さないこと。** `harvesters` が無ければ `{}`、`accounts` が文字列なら捨てる（残すと 1 文字ずつの集合として比較され全員入れ替わりの誤報になる）。→ Task 2「harvesters が無い state には…」「壊れた harvester エントリは捨てられる」「harvesters がオブジェクトでなければ…」
5. **設定の書き間違いが黙って無視されないこと。** `"harvesters": "true"`（文字列）や `api` の無いノードへの指定は起動時エラーにする。黙って無視すると、監視しているつもりで何も起きない。→ Task 1「harvesters が真偽値でなければ失敗する」「harvesters: true で api が無ければ失敗する」

---

### Task 1: 設定に `harvesters` を追加する

**Files:**
- Modify: `src/config.js`（peer 展開の直後に harvester 展開を追加、`harvesterTarget` 関数を追加）
- Test: `test/config.test.js`（末尾に 6 件追加）

**Interfaces:**
- Consumes: なし
- Produces: `parseConfig(raw)` が、`harvesters: true` のノードについて次の Target を api・peer の後ろに 1 件追加して返す。
  `{ key: 'n1::harvesters', node: 'n1', kind: 'harvesters', label: 'harvesters', url: 'https://example.com:3001' }`

- [ ] **Step 1: 失敗するテストを書く**

`test/config.test.js` の末尾に追加する。

```js
test('harvesters: true は https を優先して 1 件だけ展開する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { http: 3000, https: 3001 }, harvesters: true }],
  });
  assert.deepEqual(targets, [
    { key: 'n1::api-http', node: 'n1', kind: 'api', label: 'api-http', url: 'http://example.com:3000' },
    { key: 'n1::api-https', node: 'n1', kind: 'api', label: 'api-https', url: 'https://example.com:3001' },
    { key: 'n1::harvesters', node: 'n1', kind: 'harvesters', label: 'harvesters', url: 'https://example.com:3001' },
  ]);
});

test('harvesters: true で https が無ければ http から取得する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { http: 3000 }, peer: { port: 7900 }, harvesters: true }],
  });
  const harvester = targets.find((t) => t.kind === 'harvesters');
  assert.equal(harvester.url, 'http://example.com:3000');
});

test('harvesters: false なら harvester を展開しない', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { https: 3001 }, harvesters: false }],
  });
  assert.deepEqual(targets.map((t) => t.kind), ['api']);
});

test('harvesters: true で api が無ければ失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', peer: { port: 7900 }, harvesters: true }] }),
    /harvesters/,
  );
});

test('harvesters: true で api にポートが無ければ失敗する', () => {
  assert.throws(
    () => parseConfig({
      nodes: [{ name: 'n1', host: 'a.example.com', api: {}, peer: { port: 7900 }, harvesters: true }],
    }),
    /harvesters/,
  );
});

test('harvesters が真偽値でなければ失敗する', () => {
  // 文字列の "true" を黙って無視すると、監視しているつもりで何も起きない
  assert.throws(
    () => parseConfig({
      nodes: [{ name: 'n1', host: 'a.example.com', api: { https: 3001 }, harvesters: 'true' }],
    }),
    /true か false/,
  );
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/config.test.js`
Expected: 19 件中 5 件が FAIL（「harvesters: false なら…」は実装前から通る）。

- [ ] **Step 3: 実装する**

`src/config.js` の peer 展開ブロックの直後に追加する。

置き換え前:

```js
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
```

置き換え後:

```js
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

    if (node.harvesters !== undefined && typeof node.harvesters !== 'boolean') {
      throw new Error(
        `${where}.harvesters: true か false が必要です (受け取った値: ${JSON.stringify(node.harvesters)})`,
      );
    }
    if (node.harvesters) {
      targets.push(harvesterTarget(node, where));
    }

    if (targets.length === before) {
```

`loadConfig` と `assertPort` の間に関数を追加する。

置き換え前:

```js
export async function loadConfig(path) {
  const text = await readFile(path, 'utf8');
  return parseConfig(JSON.parse(text));
}

function assertPort(port, where) {
```

置き換え後:

```js
export async function loadConfig(path) {
  const text = await readFile(path, 'utf8');
  return parseConfig(JSON.parse(text));
}

/**
 * harvester 一覧の取得先を作る。一覧はノード単位の値なので、http と https の両方から
 * 取ると二重計上になる。https を優先し、無ければ http から 1 回だけ取得する。
 * ポート番号は api の展開時に検証済み。
 */
function harvesterTarget(node, where) {
  const scheme = node.api?.https !== undefined ? 'https' : 'http';
  const port = node.api?.[scheme];
  if (port === undefined) {
    throw new Error(`${where}.harvesters: harvester の一覧は REST から取得するため "api" の http か https が必要です`);
  }
  return {
    key: `${node.name}::harvesters`,
    node: node.name,
    kind: 'harvesters',
    label: 'harvesters',
    url: `${scheme}://${node.host}:${port}`,
  };
}

function assertPort(port, where) {
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test test/config.test.js`
Expected: 19 件すべて PASS

Run: `node --test`
Expected: tests 120 / pass 120 / fail 0

- [ ] **Step 5: コミットする**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: 設定に harvesters を追加し、harvester 取得用の監視対象に展開する"
```

---

### Task 2: state に `harvesters` を追加する

**Files:**
- Modify: `src/state.js`（`createInitialState` と `normalizeState`、`normalizeHarvesters` を追加）
- Test: `test/state.test.js`（既存 3 件を修正、3 件追加）

**Interfaces:**
- Consumes: なし
- Produces:
  - `createInitialState()` → `{ version: 1, updatedAt: null, lastWeeklySummaryAt: null, targets: {}, harvesters: {} }`
  - `normalizeState(raw)` の戻り値に `harvesters: { [nodeName]: { accounts: string[], observedAt: string | null } }` が必ず含まれる

- [ ] **Step 1: 既存テストを新しい形に合わせ、失敗するテストを書く**

`test/state.test.js` の既存テスト 3 件を修正する。

「createInitialState は毎回新しいオブジェクトを返す」の期待値:

```js
  assert.deepEqual(a, { version: 1, updatedAt: null, lastWeeklySummaryAt: null, targets: {}, harvesters: {} });
```

「正しい state はそのまま保持される」の `raw` の `targets` の後ろに追加する:

```js
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
```

「writeState で書いたものを readState で読み戻せる」の `state` を次にする:

```js
  const state = {
    version: 1,
    updatedAt: '2026-10-04T13:00:00.000Z',
    lastWeeklySummaryAt: null,
    targets: { 'n1::peer': { ...INITIAL_TARGET_STATE, consecutiveFailures: 1 } },
    harvesters: { n1: { accounts: ['AA'], observedAt: '2026-10-04T13:00:00.000Z' } },
  };
```

「target の欠けたフィールドは初期値で補われる」の直後に 3 件追加する:

```js
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/state.test.js`
Expected: 修正した 3 件と追加した 3 件が FAIL（`harvesters` が戻り値に無い）

- [ ] **Step 3: 実装する**

`src/state.js` の `createInitialState` を置き換える。

```js
export function createInitialState() {
  return { version: CURRENT_VERSION, updatedAt: null, lastWeeklySummaryAt: null, targets: {}, harvesters: {} };
}
```

`normalizeState` の return を置き換える。

置き換え前:

```js
  return {
    version: CURRENT_VERSION,
    updatedAt: raw.updatedAt ?? null,
    lastWeeklySummaryAt: raw.lastWeeklySummaryAt ?? null,
    targets,
  };
}
```

置き換え後:

```js
  return {
    version: CURRENT_VERSION,
    updatedAt: raw.updatedAt ?? null,
    lastWeeklySummaryAt: raw.lastWeeklySummaryAt ?? null,
    targets,
    harvesters: normalizeHarvesters(raw.harvesters),
  };
}

/**
 * harvester の記録を正規化する。harvester 監視を入れる前の state には無いので {} を補う。
 * 壊れたエントリは捨てて「前回の記録なし」に戻す。残すと誤った差分で誤報になるが、
 * 記録なしなら次回は初回観測として黙って記録し直されるだけで済む。
 */
function normalizeHarvesters(raw) {
  const harvesters = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return harvesters;

  for (const [node, entry] of Object.entries(raw)) {
    const accounts = entry?.accounts;
    if (!Array.isArray(accounts) || !accounts.every((account) => typeof account === 'string')) continue;
    harvesters[node] = { accounts: [...accounts], observedAt: entry.observedAt ?? null };
  }
  return harvesters;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test test/state.test.js`
Expected: 16 件すべて PASS

Run: `node --test`
Expected: tests 123 / pass 123 / fail 0（`evaluate.test.js` と `index.test.js` は変更不要）

- [ ] **Step 5: コミットする**

```bash
git add src/state.js test/state.test.js
git commit -m "feat: state に harvester の記録を追加し、旧形式と破損エントリを正規化する"
```

---

### Task 3: harvester 一覧を取得する `checkHarvesters`

**Files:**
- Create: `src/checks/harvesters.js`
- Test: `test/checks-harvesters.test.js`（新規、8 件）

**Interfaces:**
- Consumes: `TIMEOUT_MS`, `withRetry` from `src/checks/retry.js`（変更しない）
- Produces: `checkHarvesters(target, { fetchImpl?, sleep?, timeoutMs? }) -> Promise<HarvesterObservation>`
  - 成功: `{ key, node, label, ok: true, reason: null, detail: 'harvester 3 件', accounts: ['AA', 'BB', 'CC'] }`（重複を除きソート済み）
  - 失敗: `{ key, node, label, ok: false, reason: 'unreachable' | 'bad-response', detail: string, accounts: null }`

- [ ] **Step 1: 失敗するテストを書く**

`test/checks-harvesters.test.js` を作成する。

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHarvesters } from '../src/checks/harvesters.js';

const TARGET = {
  key: 'n1::harvesters', node: 'n1', kind: 'harvesters',
  label: 'harvesters', url: 'https://example.com:3001',
};

const UNLOCKED_URL = 'https://example.com:3001/node/unlockedaccount';

const noSleep = async () => {};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** 毎回同じ応答を返し、呼ばれた URL を記録する fetch のモックを作る。 */
function mockFetch(response) {
  const calls = [];
  const impl = async (url) => { calls.push(url); return response; };
  return { impl, calls };
}

test('一覧をソートして返す', async () => {
  const { impl, calls } = mockFetch(jsonResponse(200, { unlockedAccount: ['CC', 'AA', 'BB'] }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(result, {
    key: 'n1::harvesters', node: 'n1', label: 'harvesters',
    ok: true, reason: null, detail: 'harvester 3 件', accounts: ['AA', 'BB', 'CC'],
  });
  assert.deepEqual(calls, [UNLOCKED_URL]);
});

test('重複は 1 件として数える', async () => {
  const { impl } = mockFetch(jsonResponse(200, { unlockedAccount: ['BB', 'AA', 'BB'] }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.deepEqual(result.accounts, ['AA', 'BB']);
  assert.equal(result.detail, 'harvester 2 件');
});

test('空の一覧も成功として扱う', async () => {
  // 委任が 1 件も無いのは正常な状態。失敗扱いにすると全員の離脱を検知できない
  const { impl } = mockFetch(jsonResponse(200, { unlockedAccount: [] }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, true);
  assert.deepEqual(result.accounts, []);
});

test('2xx でなければ bad-response になり 3 回試行する', async () => {
  const { impl, calls } = mockFetch(jsonResponse(404, { code: 'ResourceNotFound' }));
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-response');
  assert.equal(result.accounts, null);
  assert.match(result.detail, /404/);
  assert.equal(calls.length, 3);
});

test('応答が JSON でなければ bad-response になる', async () => {
  const impl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'bad-response');
  assert.equal(result.accounts, null);
});

test('unlockedAccount が文字列の配列でなければ bad-response になる', async () => {
  for (const body of [{}, null, { unlockedAccount: 'AA' }, { unlockedAccount: ['AA', 1] }]) {
    const { impl } = mockFetch(jsonResponse(200, body));
    const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
    assert.equal(result.reason, 'bad-response', `body: ${JSON.stringify(body)}`);
    assert.equal(result.accounts, null);
  }
});

test('接続できなければ unreachable になり 3 回試行する', async () => {
  let calls = 0;
  const impl = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep });
  assert.equal(result.reason, 'unreachable');
  assert.equal(calls, 3);
  assert.match(result.detail, /ECONNREFUSED/);
});

test('応答が遅ければタイムアウトして unreachable になる', async () => {
  // 1 秒後に応答する遅いノード。signal で中断されなければ成功してしまい、テストが落ちる。
  // AbortSignal.timeout のタイマーはイベントループを保持しないので、
  // 応答側のタイマーで保持しておかないとテストが途中で打ち切られる。
  const impl = (_url, { signal }) => new Promise((resolve, reject) => {
    const late = setTimeout(() => resolve(jsonResponse(200, { unlockedAccount: [] })), 1_000);
    signal.addEventListener('abort', () => { clearTimeout(late); reject(signal.reason); });
  });
  const result = await checkHarvesters(TARGET, { fetchImpl: impl, sleep: noSleep, timeoutMs: 10 });
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /timeout/i);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/checks-harvesters.test.js`
Expected: FAIL（`Cannot find module '.../src/checks/harvesters.js'`）

- [ ] **Step 3: 実装する**

`src/checks/harvesters.js` を作成する。`api.js` の取得処理は失敗時の形（`height: null`）が違い、設計上 `api.js` を変更しないため、取得処理はここに独立して書く。

```js
import { TIMEOUT_MS, withRetry } from './retry.js';

/**
 * ノードに委任されている harvester（アンロック済みアカウント）の公開鍵一覧を取得する。
 * 値はノード単位なので、1 ノードにつき 1 回だけ呼ぶこと。
 *
 * 一覧は重複を除いてソートして返す。ノード側の並び順が安定している保証はなく、
 * 順序の違いを増減として誤検知しないようにするため。
 */
export async function checkHarvesters(target, options = {}) {
  const { fetchImpl = fetch, sleep, timeoutMs = TIMEOUT_MS } = options;

  const probe = () => probeHarvesters(target, fetchImpl, timeoutMs);
  const result = await withRetry(probe, sleep ? { sleep } : {});

  return { key: target.key, node: target.node, label: target.label, ...result };
}

async function probeHarvesters(target, fetchImpl, timeoutMs) {
  const url = `${target.url}/node/unlockedaccount`;

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return fail('unreachable', `${url} に接続できません: ${err.message}`);
  }

  if (!response.ok) {
    return fail('bad-response', `${url} が異常なステータスを返しました (HTTP ${response.status})`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return fail('bad-response', `${url} の応答が JSON ではありません (HTTP ${response.status})`);
  }

  const list = body?.unlockedAccount;
  if (!Array.isArray(list) || !list.every((account) => typeof account === 'string')) {
    return fail('bad-response', `${url} の unlockedAccount が文字列の配列ではありません`);
  }

  const accounts = [...new Set(list)].sort();
  return { ok: true, reason: null, detail: `harvester ${accounts.length} 件`, accounts };
}

function fail(reason, detail) {
  return { ok: false, reason, detail, accounts: null };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test test/checks-harvesters.test.js`
Expected: 8 件すべて PASS

Run: `node --test`
Expected: tests 131 / pass 131 / fail 0

- [ ] **Step 5: コミットする**

```bash
git add src/checks/harvesters.js test/checks-harvesters.test.js
git commit -m "feat: ノードから harvester の公開鍵一覧を取得する checkHarvesters を追加"
```

---

### Task 4: 判定ロジック `src/harvesters.js`

**Files:**
- Create: `src/harvesters.js`
- Test: `test/harvesters.test.js`（新規、23 件）

**Interfaces:**
- Consumes: Task 3 の `HarvesterObservation` の形（`{ node, ok, accounts, detail, ... }`）。死活監視の `CheckResult`（`{ key, node, label, ok, ... }`、`label` は `'api-http' | 'api-https' | 'peer'`）。
- Produces:
  - `evaluateHarvesters({ prevHarvesters, observations, now: Date }) -> { nextHarvesters, events }`
    - `nextHarvesters`: `{ [node]: { accounts: string[] /* ソート済み */, observedAt: string | null } }`
    - `events`: 次の形の配列
      ```js
      { type: 'harvesters', key: 'n1::harvesters', node: 'n1', target: 'harvesters',
        reason: null, detail: '1 → 2 件', hint: null, downSince: null,
        occurredAt: '<ISO>', snapshot: null,
        added: ['BB'], removed: [], before: 1, after: 2 }
      ```
  - `gateByApiHealth(observations, results) -> observations`（api が今回成功していないノードの観測を `ok: false, accounts: null` に置き換えた新しい配列）
  - `annotateSummary(events, harvesters) -> events`（`type: 'summary'` のイベントにだけ `harvesters: [{ node, count, observedAt }]` を付けた新しい配列。記録が空なら何も付けない）

- [ ] **Step 1: 失敗するテストを書く**

`test/harvesters.test.js` を作成する。

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateSummary, evaluateHarvesters, gateByApiHealth } from '../src/harvesters.js';

const NOW = new Date('2026-10-20T14:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const EARLIER = '2026-10-20T13:00:00.000Z';

/** 取得に成功した観測を作る。 */
const seen = (accounts, over = {}) => ({
  key: 'n1::harvesters', node: 'n1', label: 'harvesters',
  ok: true, reason: null, detail: `harvester ${accounts.length} 件`, accounts, ...over,
});

/** 取得に失敗した観測を作る。 */
const missed = (over = {}) => ({
  key: 'n1::harvesters', node: 'n1', label: 'harvesters',
  ok: false, reason: 'unreachable', detail: '接続できません', accounts: null, ...over,
});

/** 前回の記録を作る。 */
const record = (accounts, observedAt = EARLIER) => ({ accounts, observedAt });

const run = (prevHarvesters, observations) => evaluateHarvesters({ prevHarvesters, observations, now: NOW });

/** 既定で「正常な api-https の検査結果」を作る。 */
const apiResult = (over = {}) => ({
  key: 'n1::api-https', node: 'n1', label: 'api-https',
  ok: true, reason: null, detail: '正常', height: '200', ...over,
});

// --- evaluateHarvesters ---

test('初回の観測ではイベントを出さず一覧を記録する', () => {
  const { nextHarvesters, events } = run({}, [seen(['BB', 'AA'])]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters, { n1: { accounts: ['AA', 'BB'], observedAt: NOW_ISO } });
});

test('一覧が同じならイベントを出さず observedAt だけ更新する', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, [seen(['AA', 'BB'])]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters.n1, { accounts: ['AA', 'BB'], observedAt: NOW_ISO });
});

test('並び順だけが違う一覧ではイベントを出さない', () => {
  const { events } = run({ n1: record(['AA', 'BB']) }, [seen(['BB', 'AA'])]);
  assert.deepEqual(events, []);
});

test('参加だけなら added に載せたイベントを 1 件出す', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA']) }, [seen(['AA', 'BB'])]);
  assert.deepEqual(events, [{
    type: 'harvesters',
    key: 'n1::harvesters',
    node: 'n1',
    target: 'harvesters',
    reason: null,
    detail: '1 → 2 件',
    hint: null,
    downSince: null,
    occurredAt: NOW_ISO,
    snapshot: null,
    added: ['BB'],
    removed: [],
    before: 1,
    after: 2,
  }]);
  assert.deepEqual(nextHarvesters.n1.accounts, ['AA', 'BB']);
});

test('離脱だけなら removed に載せたイベントを 1 件出す', () => {
  const { events } = run({ n1: record(['AA', 'BB']) }, [seen(['AA'])]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].added, []);
  assert.deepEqual(events[0].removed, ['BB']);
  assert.equal(events[0].detail, '2 → 1 件');
});

test('入れ替わりは参加と離脱を 1 つのイベントにまとめる', () => {
  const { events } = run({ n1: record(['AA', 'BB']) }, [seen(['AA', 'CC'])]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].added, ['CC']);
  assert.deepEqual(events[0].removed, ['BB']);
  assert.equal(events[0].detail, '2 → 2 件');
});

test('一覧が空になれば全員の離脱として通知する', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, [seen([])]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].removed, ['AA', 'BB']);
  assert.equal(events[0].detail, '2 → 0 件');
  assert.deepEqual(nextHarvesters.n1.accounts, []);
});

test('観測に重複があっても件数は重複を除いて数える', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA']) }, [seen(['AA', 'BB', 'BB'])]);
  assert.equal(events[0].detail, '1 → 2 件');
  assert.deepEqual(nextHarvesters.n1.accounts, ['AA', 'BB']);
});

test('観測に失敗したら前回の一覧を保持しイベントを出さない', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, [missed()]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters, { n1: { accounts: ['AA', 'BB'], observedAt: EARLIER } });
});

test('観測に失敗し前回の記録も無ければ何も記録しない', () => {
  const { nextHarvesters, events } = run({}, [missed()]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters, {});
});

test('観測の無いノード（設定から外したノード）の記録は除去する', () => {
  const { nextHarvesters } = run(
    { n1: record(['AA']), retired: record(['ZZ']) },
    [seen(['AA'])],
  );
  assert.deepEqual(Object.keys(nextHarvesters), ['n1']);
});

test('ノードごとに独立して判定する', () => {
  const { events } = run(
    { n1: record(['AA']), n2: record(['XX']) },
    [seen(['AA', 'BB']), seen(['XX'], { key: 'n2::harvesters', node: 'n2' })],
  );
  assert.deepEqual(events.map((e) => e.node), ['n1']);
});

test('prevHarvesters を変更しない', () => {
  const prev = { n1: record(['AA', 'BB']), n2: record(['XX']) };
  const snapshot = structuredClone(prev);
  const { nextHarvesters } = run(prev, [
    seen(['AA', 'CC']),
    missed({ key: 'n2::harvesters', node: 'n2' }),
  ]);
  // 返した記録を書き換えても前回の記録に波及しないこと（配列を共有していないこと）
  nextHarvesters.n1.accounts.push('MUTATED');
  nextHarvesters.n2.accounts.push('MUTATED');
  assert.deepEqual(prev, snapshot);
});

// --- gateByApiHealth ---

test('api-https が成功しているノードの観測はそのまま通す', () => {
  const observation = seen(['AA']);
  const [gated] = gateByApiHealth([observation], [apiResult()]);
  assert.equal(gated, observation);
});

test('api-http だけが成功していても観測を通す', () => {
  const [gated] = gateByApiHealth(
    [seen(['AA'])],
    [apiResult({ ok: false, reason: 'unreachable' }), apiResult({ key: 'n1::api-http', label: 'api-http' })],
  );
  assert.equal(gated.ok, true);
});

test('api が失敗しているノードの観測は失敗に置き換える', () => {
  const [gated] = gateByApiHealth([seen(['AA'])], [apiResult({ ok: false, reason: 'chain-stalled' })]);
  assert.equal(gated.ok, false);
  assert.equal(gated.accounts, null);
  assert.match(gated.detail, /api/);
});

test('peer だけが成功していても観測を通さない', () => {
  const [gated] = gateByApiHealth(
    [seen(['AA'])],
    [{ key: 'n1::peer', node: 'n1', label: 'peer', ok: true, reason: null, detail: '正常', height: null }],
  );
  assert.equal(gated.ok, false);
});

test('別のノードの api が成功していても観測を通さない', () => {
  const [gated] = gateByApiHealth([seen(['AA'])], [apiResult({ key: 'n2::api-https', node: 'n2' })]);
  assert.equal(gated.ok, false);
});

test('gateByApiHealth は受け取った観測を変更しない', () => {
  const observation = seen(['AA']);
  gateByApiHealth([observation], []);
  assert.equal(observation.ok, true);
  assert.deepEqual(observation.accounts, ['AA']);
});

test('api が落ちている回に空の一覧が返っても全員離脱の誤報を出さない', () => {
  const observations = gateByApiHealth([seen([])], [apiResult({ ok: false, reason: 'health-down' })]);
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, observations);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters.n1.accounts, ['AA', 'BB']);
});

// --- annotateSummary ---

const summaryEvent = () => ({
  type: 'summary', key: null, node: null, target: null, reason: null,
  detail: '監視対象 1 件', hint: null, downSince: null, occurredAt: NOW_ISO, snapshot: [],
});

const downEvent = () => ({
  type: 'down', key: 'n1::peer', node: 'n1', target: 'peer', reason: 'unreachable',
  detail: '接続できません', hint: null, downSince: EARLIER, occurredAt: NOW_ISO, snapshot: null,
});

test('サマリにだけ harvester の件数を付ける', () => {
  const down = downEvent();
  const result = annotateSummary([down, summaryEvent()], { n1: record(['AA', 'BB'], NOW_ISO) });
  assert.equal(result[0], down);
  assert.deepEqual(result[1].harvesters, [{ node: 'n1', count: 2, observedAt: NOW_ISO }]);
});

test('harvester の記録が無ければサマリに何も付けない', () => {
  const [summary] = annotateSummary([summaryEvent()], {});
  assert.equal('harvesters' in summary, false);
});

test('annotateSummary は受け取ったイベントを変更しない', () => {
  const events = [summaryEvent()];
  annotateSummary(events, { n1: record(['AA']) });
  assert.equal('harvesters' in events[0], false);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/harvesters.test.js`
Expected: FAIL（`Cannot find module '.../src/harvesters.js'`）

- [ ] **Step 3: 実装する**

`src/harvesters.js` を作成する。

```js
/** そのノードが今回「健全」だと判断する根拠にしてよい検査のラベル。 */
const API_LABELS = new Set(['api-http', 'api-https']);

/**
 * 前回の harvester 記録と今回の観測から、新しい記録と送るべきイベントを求める。
 * evaluate と同じく副作用を持たない純粋関数で、現在時刻も引数で受け取る。
 * 死活監視の state（targets）には一切関与しない。
 *
 * observations は gateByApiHealth を通したものを渡すこと。
 */
export function evaluateHarvesters({ prevHarvesters, observations, now }) {
  const occurredAt = now.toISOString();
  const nextHarvesters = {};
  const events = [];

  for (const observation of observations) {
    const { node } = observation;
    const prev = prevHarvesters?.[node];

    if (!observation.ok) {
      // 観測できなかった回は比較せず、前回の記録をそのまま引き継ぐ。
      if (prev) nextHarvesters[node] = { accounts: [...prev.accounts], observedAt: prev.observedAt };
      continue;
    }

    // 並び順や重複に左右されないよう、集合として扱う。
    const current = new Set(observation.accounts);
    nextHarvesters[node] = { accounts: [...current].sort(), observedAt: occurredAt };

    // 初回は比較対象がないので記録だけする。
    if (!prev) continue;

    const previous = new Set(prev.accounts);
    const added = [...current].filter((account) => !previous.has(account)).sort();
    const removed = [...previous].filter((account) => !current.has(account)).sort();
    if (added.length === 0 && removed.length === 0) continue;

    events.push({
      type: 'harvesters',
      key: `${node}::harvesters`,
      node,
      target: 'harvesters',
      reason: null,
      detail: `${previous.size} → ${current.size} 件`,
      hint: null,
      downSince: null,
      occurredAt,
      snapshot: null,
      added,
      removed,
      before: previous.size,
      after: current.size,
    });
  }

  return { nextHarvesters, events };
}

/**
 * 同じ実行で api 検査が成功していないノードの観測を、失敗した観測に置き換える。
 *
 * ノードが止まっていたり不調だったりすると、一覧の取得が失敗するか空の一覧が返る。
 * それをそのまま比較すると「全員離脱」の誤報になるため、ノードが健全だと
 * 確認できた回の観測だけを比較に使う。
 */
export function gateByApiHealth(observations, results) {
  const healthyNodes = new Set(
    results.filter((result) => result.ok && API_LABELS.has(result.label)).map((result) => result.node),
  );
  return observations.map((observation) => {
    if (!observation.ok || healthyNodes.has(observation.node)) return observation;
    return {
      ...observation,
      ok: false,
      accounts: null,
      detail: 'api 検査が成功していないため harvester の比較を見送りました',
    };
  });
}

/**
 * 週次サマリに harvester の現在件数を付け加える。
 * サマリは evaluate が作るが、evaluate を変更しないためにここで後から付ける。
 * 記録が 1 件も無ければ何も付けない。受け取った配列もイベントも変更しない。
 */
export function annotateSummary(events, harvesters) {
  const entries = Object.entries(harvesters ?? {});
  if (entries.length === 0) return [...events];

  const summary = entries.map(([node, entry]) => ({
    node,
    count: entry.accounts.length,
    observedAt: entry.observedAt,
  }));
  return events.map((event) => (event.type === 'summary' ? { ...event, harvesters: summary } : event));
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test test/harvesters.test.js`
Expected: 23 件すべて PASS

Run: `node --test`
Expected: tests 154 / pass 154 / fail 0

- [ ] **Step 5: コミットする**

```bash
git add src/harvesters.js test/harvesters.test.js
git commit -m "feat: harvester の増減を判定する純粋関数と、api 成功時だけ比較するゲートを追加"
```

---

### Task 5: 通知の整形

**Files:**
- Modify: `src/notify/format.js`（全体を置き換え）
- Modify: `src/notify/discord.js:4`（`COLORS` に 1 キー追加）
- Modify: `src/notify/slack.js:4`（`COLORS` に 1 キー追加）
- Test: `test/notify.test.js`（末尾に 7 件追加）

**Interfaces:**
- Consumes: Task 4 の harvester イベントの形（`added` / `removed` は 64 文字の公開鍵の配列）。サマリイベントの任意フィールド `harvesters: [{ node, count, observedAt }]`。
- Produces: `titleOf(event)` / `describeEvent(event)` が `type: 'harvesters'` を描画する。`harvesters` フィールドの無いサマリの描画は一字一句変わらない。

- [ ] **Step 1: 失敗するテストを書く**

`test/notify.test.js` の末尾に追加する。

```js
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/notify.test.js`
Expected: 追加した 7 件のうち 6 件が FAIL（「harvesters の無い summary は従来どおり描画される」は実装前から通る。これは後方互換を固定するためのテスト）

- [ ] **Step 3: 実装する**

`src/notify/format.js` を全体置き換えする。

```js
const TYPE_LABELS = {
  down: '🔴 DOWN',
  recovered: '🟢 復旧',
  summary: '📊 週次サマリ',
  harvesters: '🌾 Harvester 変化',
};
const STATUS_ICONS = { up: '🟢', down: '🔴' };

/** 公開鍵（64 文字）のうち通知に出す先頭の文字数。見分けるにはこれで足りる。 */
const ACCOUNT_PREFIX_LENGTH = 12;

export function titleOf(event) {
  if (event.type === 'summary') return TYPE_LABELS.summary;
  // harvester はノード単位の値なので、監視対象（api-https など）を見出しに出さない。
  if (event.type === 'harvesters') return `${TYPE_LABELS.harvesters}: ${event.node}`;
  return `${TYPE_LABELS[event.type]}: ${event.node} (${event.target})`;
}

export function describeEvent(event) {
  if (event.type === 'summary') return describeSummary(event);
  if (event.type === 'harvesters') return describeHarvesters(event);

  const lines = [event.detail];
  if (event.hint) lines.push('', event.hint);
  if (event.downSince) lines.push('', `障害開始: ${event.downSince}`);
  lines.push(`確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

function describeSummary(event) {
  const lines = event.snapshot.map((item) => {
    const icon = STATUS_ICONS[item.status] ?? '❔';
    const parts = [`${icon} ${item.node} / ${item.target}`, `障害 ${item.incidentsThisWeek} 回`];
    if (item.lastHeight) parts.push(`height ${item.lastHeight}`);
    parts.push(`最終正常 ${item.lastOkAt ?? '未確認'}`);
    return parts.join(' — ');
  });
  // harvesters はサマリを作った後で index.js が付け加える（evaluate を変更しないため）。
  // 最終確認時刻が古いままなら、一覧を取得できない状態が続いている。
  if (event.harvesters?.length > 0) {
    lines.push('', ...event.harvesters.map((item) =>
      `🌾 ${item.node} — harvester ${item.count} 件 — 最終確認 ${item.observedAt ?? '未確認'}`));
  }
  lines.push('', `確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

/**
 * 参加・離脱のうち空のほうは行ごと出さない。
 * 「離脱: （なし）」のような情報量のない行は、本当に見るべき行を埋もれさせる。
 */
function describeHarvesters(event) {
  const lines = [event.detail, ''];
  if (event.added.length > 0) lines.push(`参加: ${event.added.map(shortAccount).join(', ')}`);
  if (event.removed.length > 0) lines.push(`離脱: ${event.removed.map(shortAccount).join(', ')}`);
  lines.push('', `確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

function shortAccount(publicKey) {
  return `${publicKey.slice(0, ACCOUNT_PREFIX_LENGTH)}…`;
}

/** Discord の description は 4096 文字が上限なので余裕を持って切る。 */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(省略)`;
}
```

`src/notify/discord.js` の 4 行目を置き換える。

```js
const COLORS = { down: 0xe01e5a, recovered: 0x2eb67d, summary: 0x1d9bd1, harvesters: 0xecb22e };
```

`src/notify/slack.js` の 4 行目を置き換える。

```js
const COLORS = { down: '#e01e5a', recovered: '#2eb67d', summary: '#1d9bd1', harvesters: '#ecb22e' };
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test test/notify.test.js`
Expected: 31 件すべて PASS

Run: `node --test`
Expected: tests 161 / pass 161 / fail 0

- [ ] **Step 5: コミットする**

```bash
git add src/notify/format.js src/notify/discord.js src/notify/slack.js test/notify.test.js
git commit -m "feat: harvester 変化の通知とサマリへの件数表示を追加"
```

---

### Task 6: `index.js` で結線する

**Files:**
- Modify: `src/index.js`（import、依存の差し替え口、検査〜判定の部分、合成結果の関数）
- Test: `test/index.test.js`（import とフィクスチャを追加、末尾に 7 件追加）

**Interfaces:**
- Consumes:
  - Task 1: `kind: 'harvesters'` の Target
  - Task 2: `prevState.harvesters`（ただしテストの `readState` モックは持たない形を返すことがあるので `?? {}` で受ける）
  - Task 3: `checkHarvesters(target) -> Promise<HarvesterObservation>`
  - Task 4: `evaluateHarvesters`, `gateByApiHealth`, `annotateSummary`
- Produces: `main(overrides)` が新たに `overrides.checkHarvesters` を受け付ける。書き込む state に `harvesters` が含まれる。`dispatch` に渡すイベント列は「死活監視のイベント（サマリには harvester 件数付き）→ harvester イベント」の順。

- [ ] **Step 1: 失敗するテストを書く**

`test/index.test.js` の import に 1 行追加する。

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';
import { evaluate as realEvaluate } from '../src/evaluate.js';
```

`emptyState` の定義（12 行目）の直後にフィクスチャを追加する。

```js
const HARVESTER_TARGET = { key: 'n1::harvesters', node: 'n1', kind: 'harvesters', label: 'harvesters', url: 'https://a.test:3001' };

/** 指定した一覧を返す checkHarvesters のモックを作る。 */
const harvested = (accounts) => async (target) => ({
  key: target.key, node: target.node, label: target.label,
  ok: true, reason: null, detail: `harvester ${accounts.length} 件`, accounts,
});

/** harvester の前回記録を持つ state を返す readState のモックを作る。 */
const withHarvesters = (harvesters, over = {}) => async () => ({ ...emptyState(), harvesters, ...over });
```

`deps` の既定値に `checkHarvesters` を追加する（`checkPeer` の行の直後）。本物の `checkHarvesters` がネットワークに出ないようにするため。

```js
      checkHarvesters: harvested([]),
```

ファイル末尾に 7 件追加する。

```js
test('harvesters の対象は evaluate に渡さず、死活監視の state も作らない', async () => {
  let evaluatedKeys;
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    checkHarvesters: harvested(['AA']),
    evaluate: (args) => {
      evaluatedKeys = args.results.map((r) => r.key);
      return realEvaluate(args);
    },
  });
  // readState は harvesters を持たない、harvester 監視を入れる前の形の state を返す
  assert.equal(await main(overrides), 0);
  assert.deepEqual(evaluatedKeys, ['n1::api-https', 'n1::peer']);
  assert.equal('n1::harvesters' in written[0].targets, false);
  assert.deepEqual(written[0].harvesters, {
    n1: { accounts: ['AA'], observedAt: '2026-10-04T13:00:00.000Z' },
  });
});

test('harvesters の対象が混ざっていても、例外を投げた検査は正しい対象に紐づく', async () => {
  const { written, overrides } = deps({
    // harvesters を先頭に置き、設定上の並びと死活監視の対象の並びで添字がずれる状況を作る
    loadConfig: async () => [HARVESTER_TARGET, ...TARGETS],
    checkPeer: async () => { throw new Error('想定外の例外'); },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written[0].targets['n1::peer'].consecutiveFailures, 1);
  assert.equal(written[0].targets['n1::api-https'].consecutiveFailures, 0);
  assert.equal('n1::harvesters' in written[0].targets, false);
});

test('harvester が増えたら通知し、state に新しい一覧を残す', async () => {
  let sent = null;
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkHarvesters: harvested(['AA', 'BB']),
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'harvesters');
  assert.deepEqual(sent[0].added, ['BB']);
  assert.deepEqual(written[0].harvesters.n1.accounts, ['AA', 'BB']);
});

test('api が異常なノードでは harvester を比較せず、前回の一覧を残す', async () => {
  let sent = [];
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA', 'BB'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkApi: async (target) => ({ key: target.key, node: target.node, label: target.label, ok: false, reason: 'health-down', detail: 'ng', height: null }),
    // ノードの不調で空の一覧が返ってきた状況
    checkHarvesters: harvested([]),
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });
  assert.equal(await main(overrides), 0);
  assert.deepEqual(sent.filter((e) => e.type === 'harvesters'), []);
  assert.deepEqual(written[0].harvesters.n1, { accounts: ['AA', 'BB'], observedAt: '2026-10-04T12:00:00.000Z' });
});

test('harvester の取得が例外を投げても、他の検査と state の更新を巻き込まない', async () => {
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkHarvesters: async () => { throw new Error('想定外の例外'); },
  });
  assert.equal(await main(overrides), 0);
  assert.equal(written[0].targets['n1::api-https'].status, 'up');
  assert.deepEqual(written[0].harvesters.n1, { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' });
});

test('週次サマリに今回確認した harvester の件数が載る', async () => {
  let sent = null;
  const { overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({}, { lastWeeklySummaryAt: null }),
    checkHarvesters: harvested(['AA', 'BB']),
    dispatch: async (events) => { sent = events; return { channels: 1, delivered: 1 }; },
  });
  assert.equal(await main(overrides), 0);
  const summary = sent.find((e) => e.type === 'summary');
  assert.deepEqual(summary.harvesters, [{ node: 'n1', count: 2, observedAt: '2026-10-04T13:00:00.000Z' }]);
});

test('harvester の変化を 1 件も届けられなければ state を更新せず次回に持ち越す', async () => {
  const { written, overrides } = deps({
    loadConfig: async () => [...TARGETS, HARVESTER_TARGET],
    readState: withHarvesters({ n1: { accounts: ['AA'], observedAt: '2026-10-04T12:00:00.000Z' } }),
    checkHarvesters: harvested(['AA', 'BB']),
    dispatch: async () => ({ channels: 1, delivered: 0 }),
  });
  assert.equal(await main(overrides), 1);
  assert.equal(written.length, 0);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test test/index.test.js`
Expected: 追加した 7 件すべてが FAIL（現状は harvester の Target が `checkPeer` に渡り、`targets` に `n1::harvesters` が作られ、`state.harvesters` も書かれない）。既存の 16 件は PASS のまま。

- [ ] **Step 3: 実装する**

`src/index.js` の import に 2 行追加する。

置き換え前:

```js
import { checkPeer as defaultCheckPeer } from './checks/peer.js';
import { dispatch as defaultDispatch } from './notify/index.js';
```

置き換え後:

```js
import { checkPeer as defaultCheckPeer } from './checks/peer.js';
import { checkHarvesters as defaultCheckHarvesters } from './checks/harvesters.js';
import { annotateSummary, evaluateHarvesters, gateByApiHealth } from './harvesters.js';
import { dispatch as defaultDispatch } from './notify/index.js';
```

`main` の依存の差し替え口に 1 行追加する。

置き換え前:

```js
    checkPeer = defaultCheckPeer,
    dispatch = defaultDispatch,
```

置き換え後:

```js
    checkPeer = defaultCheckPeer,
    checkHarvesters = defaultCheckHarvesters,
    dispatch = defaultDispatch,
```

検査から判定・ログまでを置き換える。

置き換え前:

```js
  const prevState = await readState(statePath, { logger });
  const startedAt = now();

  const settled = await Promise.allSettled(
    targets.map((target) =>
      (target.kind === 'api'
        ? checkApi(target, { lastHeight: comparableHeight(prevState.targets[target.key], startedAt) })
        : checkPeer(target))),
  );

  // 1件の検査が予期せず例外を投げても、他の対象の結果と state 更新を道連れにしない。
  // Promise.all だと fail-fast で全滅し、壊れた state が残り続けて監視が永久に死ぬ。
  const results = settled.map((outcome, index) =>
    (outcome.status === 'fulfilled' ? outcome.value : crashedResult(targets[index], outcome.reason)));

  const { nextState, events } = evaluate({ prevState, results, now: startedAt });

  const downCount = results.filter((r) => !r.ok).length;
  logger.log(`監視対象 ${results.length} 件を検査しました（異常 ${downCount} 件、通知 ${events.length} 件）`);
```

置き換え後:

```js
  const prevState = await readState(statePath, { logger });
  const startedAt = now();

  // harvester は障害の監視対象ではない。evaluate に渡すと targets にエントリが作られ、
  // DOWN 判定の対象になってしまうため、ここで振り分けて別の経路で扱う。
  const liveness = targets.filter((target) => target.kind !== 'harvesters');
  const harvesterTargets = targets.filter((target) => target.kind === 'harvesters');

  const [settled, harvesterSettled] = await Promise.all([
    Promise.allSettled(
      liveness.map((target) =>
        (target.kind === 'api'
          ? checkApi(target, { lastHeight: comparableHeight(prevState.targets[target.key], startedAt) })
          : checkPeer(target))),
    ),
    Promise.allSettled(harvesterTargets.map((target) => checkHarvesters(target))),
  ]);

  // 1件の検査が予期せず例外を投げても、他の対象の結果と state 更新を道連れにしない。
  // Promise.all だと fail-fast で全滅し、壊れた state が残り続けて監視が永久に死ぬ。
  // 添字は振り分け後の配列のものなので、targets ではなく liveness / harvesterTargets を引くこと。
  const results = settled.map((outcome, index) =>
    (outcome.status === 'fulfilled' ? outcome.value : crashedResult(liveness[index], outcome.reason)));
  const observations = harvesterSettled.map((outcome, index) =>
    (outcome.status === 'fulfilled'
      ? outcome.value
      : crashedObservation(harvesterTargets[index], outcome.reason)));

  const { nextState: livenessState, events: livenessEvents } = evaluate({ prevState, results, now: startedAt });
  const { nextHarvesters, events: harvesterEvents } = evaluateHarvesters({
    prevHarvesters: prevState.harvesters ?? {},
    observations: gateByApiHealth(observations, results),
    now: startedAt,
  });

  // evaluate は harvester を知らないので、state とサマリにはここで合流させる。
  const nextState = { ...livenessState, harvesters: nextHarvesters };
  const events = [...annotateSummary(livenessEvents, nextHarvesters), ...harvesterEvents];

  const downCount = results.filter((r) => !r.ok).length;
  logger.log(`監視対象 ${results.length} 件を検査しました（異常 ${downCount} 件、通知 ${events.length} 件）`);
  for (const observation of observations) {
    if (!observation.ok) {
      logger.warn(`harvester の一覧を取得できませんでした (${observation.node}): ${observation.detail}`);
    }
  }
```

`crashedResult` の直後に関数を追加する。

置き換え前:

```js
    detail: `検査が例外で失敗しました: ${error?.message ?? error}`,
    height: null,
  };
}
```

置き換え後:

```js
    detail: `検査が例外で失敗しました: ${error?.message ?? error}`,
    height: null,
  };
}

/**
 * harvester の取得そのものが例外で落ちたときの合成結果。
 * 失敗した観測として扱い、前回の一覧を保持させる（比較して誤報を出さないため）。
 */
function crashedObservation(target, error) {
  return {
    key: target.key,
    node: target.node,
    label: target.label,
    ok: false,
    reason: 'bad-response',
    detail: `検査が例外で失敗しました: ${error?.message ?? error}`,
    accounts: null,
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test test/index.test.js`
Expected: 23 件すべて PASS

Run: `node --test`
Expected: tests 168 / pass 168 / fail 0

Run: `git diff main --stat -- src/evaluate.js src/checks/api.js src/checks/peer.js src/checks/retry.js src/notify/webhook.js src/notify/index.js`
Expected: 出力なし（変更してはいけないファイルが無変更であること）

- [ ] **Step 5: コミットする**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: harvester の取得・判定を死活監視と別経路で結線し、state とサマリに合流させる"
```

---

### Task 7: README と設定で機能を有効にする

**Files:**
- Modify: `README.md`（設定リファレンス、通知の種類、state の仕組み、ディレクトリ構成、設計資料）
- Modify: `config/nodes.json`（2 ノードに `"harvesters": true` を追加）

**Interfaces:**
- Consumes: Task 1〜6 の挙動（この README が利用者向けの説明になる）
- Produces: なし

- [ ] **Step 1: 設定リファレンスを更新する**

`README.md` の `### \`config/nodes.json\`` の表に 1 行追加し、表の下の箇条書きに 1 項目追加する。

置き換え前:

```markdown
| `nodes[].peer.port` | | 整数 | Peer ポート（通常 7900） |

- `api` と `peer` は**少なくとも一方**が必要。書いたものだけが検査される。
```

置き換え後:

```markdown
| `nodes[].peer.port` | | 整数 | Peer ポート（通常 7900） |
| `nodes[].harvesters` | | 真偽値 | `true` で、このノードに委任されている harvester の増減を通知する（既定 `false`） |

- `api` と `peer` は**少なくとも一方**が必要。書いたものだけが検査される。
- `harvesters: true` には `api` の http か https が必要（一覧を REST から取得するため）。詳しくは[harvester の増減](#harvester-の増減)。
```

- [ ] **Step 2: 通知の種類を更新する**

`## 通知の種類` の表に 1 行追加する。

置き換え前:

```markdown
| 📊 週次サマリ | 前回サマリから 7 日経過したとき、および初回実行時 | 青 |
```

置き換え後:

```markdown
| 📊 週次サマリ | 前回サマリから 7 日経過したとき、および初回実行時 | 青 |
| 🌾 Harvester 変化 | `harvesters: true` のノードで、委任されている harvester が増減したとき | 琥珀 |
```

`### 失敗理由の読み方` の表の直後（`---` の前）に節を追加する。

置き換え前:

```markdown
| `bad-response` | 応答が解釈できない | 別のサービスが同じポートを使っている、プロキシの誤設定 |

---

## 状態（state）の仕組み
```

置き換え後:

````markdown
| `bad-response` | 応答が解釈できない | 別のサービスが同じポートを使っている、プロキシの誤設定 |

### harvester の増減

ノードに `"harvesters": true` を書くと、そのノードに委任されている harvester
（delegated harvesting でアンロック済みのアカウント）の増減を通知する。
委任が外れてもノードは正常に動き続けるため、死活監視だけでは気づけない。

```
🌾 Harvester 変化: my-node-01

6 → 7 件

参加: 9D4B2C01A7F3…

確認時刻: 2026-10-20T14:00:00.000Z
```

- 一覧は `/node/unlockedaccount` から取得する。https を優先し、無ければ http から 1 回だけ取る
- 公開鍵は先頭 12 文字だけを出す。アドレスへの変換はしない（外部依存が必要になるため）
- **初回は記録するだけで通知しない**（比較対象が無いため）
- **同じ実行で api 検査（http か https）が成功したときだけ比較する。** ノードが落ちている回は
  前回の一覧をそのまま残すので、障害のたびに「全員離脱」の誤報が出ることはない
- harvester の増減は障害ではないので、DOWN 判定や週次サマリの障害回数には影響しない
- 週次サマリの末尾に、ノードごとの現在件数と最終確認時刻が載る。**最終確認時刻が古いままなら、
  一覧を取得できない状態が続いている**
- 他人のノードを監視しているだけなら書かないこと（既定は `false`）

---

## 状態（state）の仕組み
````

- [ ] **Step 3: state の仕組みを更新する**

`### 中身を見る` の JSON 例の末尾に `harvesters` を追加する。

置き換え前:

````markdown
      "notified": false,
      "incidentsThisWeek": 0
    }
  }
}
```
````

置き換え後:

````markdown
      "notified": false,
      "incidentsThisWeek": 0
    }
  },
  "harvesters": {
    "my-node-01": {
      "accounts": ["0A1B2C3D4E5F...", "9D4B2C01A7F3..."],
      "observedAt": "2026-10-05T13:00:00.000Z"
    }
  }
}
```
````

フィールド表の直後に段落を追加する。

置き換え前:

```markdown
| `incidentsThisWeek` | 週次サマリ送信時にリセットされる障害回数 |
```

置き換え後:

```markdown
| `incidentsThisWeek` | 週次サマリ送信時にリセットされる障害回数 |

`harvesters` は `harvesters: true` のノードにだけ作られる。`accounts` は前回確認できた
harvester の公開鍵（ソート済み）、`observedAt` はそれを確認した時刻。ノードや api が落ちていて
確認できなかった回は更新されない。設定から `harvesters` を外すと、次の実行でエントリが消える。
```

- [ ] **Step 4: ディレクトリ構成と設計資料を更新する**

置き換え前:

```
  evaluate.js         判定ロジック（純粋関数）
  checks/retry.js     再試行と共有定数
  checks/api.js       API ノードの検査
  checks/peer.js      Peer ノードの検査
```

置き換え後:

```
  evaluate.js         判定ロジック（純粋関数）
  harvesters.js       harvester 増減の判定（純粋関数）
  checks/retry.js     再試行と共有定数
  checks/api.js       API ノードの検査
  checks/peer.js      Peer ノードの検査
  checks/harvesters.js harvester 一覧の取得
```

置き換え前:

```
test/                 node:test（103 件）
```

置き換え後:

```
test/                 node:test（168 件）
```

`### 設計資料` の箇条書きの末尾に追加する。

```markdown
- harvester 増減監視の設計書: `docs/superpowers/specs/2026-10-20-harvester-monitoring-design.md`
- harvester 増減監視の実装計画: `docs/superpowers/plans/2026-10-20-harvester-monitoring.md`
```

- [ ] **Step 5: 自分のノードで harvester 監視を有効にする**

`config/nodes.json` を次の内容にする（2 ノードとも `"harvesters": true` を追加）。

```json
{
  "nodes": [
    {
      "name": "oimonode_on_Contabo",
      "host": "vmi2130738.contaboserver.net",
      "api": { "http": 3000, "https": 3001 },
      "peer": { "port": 7900 },
      "harvesters": true
    },
    {
      "name": "oimonode_ex_on_Contabo",
      "host": "vmi2627658.contaboserver.net",
      "api": { "http": 3000, "https": 3001 },
      "peer": { "port": 7900 },
      "harvesters": true
    }
  ]
}
```

- [ ] **Step 6: 実際の設定で通すことを確認する**

Run: `node --test`
Expected: tests 168 / pass 168 / fail 0

Run: `node -e "import('./src/config.js').then(async (m) => console.log((await m.loadConfig('config/nodes.json')).filter((t) => t.kind === 'harvesters')))"`
Expected: 2 件の Target が表示され、どちらも `url` が `https://...:3001`

Run: `DRY_RUN=1 STATE_PATH="$(mktemp -d)/state.json" node src/index.js`
Expected: 終了コード 0。実ノードに接続できる環境なら「監視対象 6 件を検査しました」と出る。harvester の一覧を取得できなかったノードがあれば `harvester の一覧を取得できませんでした` の警告が出る（ネットワークの無い環境では警告が出てよい）。state は保存されない。

- [ ] **Step 7: コミットする**

```bash
git add README.md config/nodes.json
git commit -m "docs: harvester 増減監視の使い方を README に追記し、自分のノードで有効化する"
```
