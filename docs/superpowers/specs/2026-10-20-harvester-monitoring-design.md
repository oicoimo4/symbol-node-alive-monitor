# Harvester 増減監視 設計書

- 作成日: 2026-10-20
- ステータス: 設計確定（実装前）
- 既存設計: `2026-10-04-node-alive-monitoring-design.md`

## 1. 目的

Symbol ノードに委任されている harvester（delegated harvesting のアンロック済みアカウント）が
増減したことを検知し、Discord / Slack に通知する。

減少は委任が外れたことを意味し、ノード運用者の収益と評判に直結する。しかし現状では
ノードが正常に動いている限り何の通知も出ないため、気づく手段がない。

## 2. データソース

```
GET {api}/node/unlockedaccount
→ {"unlockedAccount": ["A1FE061806EA7484...", ...]}
```

- 64 文字の16進公開鍵の配列
- http(3000) / https(3001) のどちらでも取得できる（実測確認済み）
- **値はノード単位**。http と https の両方から取ると二重計上になる

## 3. スコープ

含むもの:

- harvester の参加・離脱の検知と通知（どの公開鍵が増減したかを含む）
- 週次サマリへの現在件数の表示

含まないもの（YAGNI）:

- harvester の最大スロット数（`maxUnlockedAccounts`）との比較。このエンドポイントからは取得できない
- 公開鍵からアドレスへの変換。Symbol SDK が必要になり「依存ゼロ」の制約に反する
- harvester ごとの報酬額や稼働状況の追跡

## 4. 設計方針

### 4.1 死活監視から独立させる

harvester の増減は**障害ではない**。既存の `consecutiveFailures` / `notified` /
DOWN 判定には一切関与させない。

`src/evaluate.js` は**一行も変更しない。** この判定ロジックはバグが「通知が来ない」という
無言の形でしか現れないため、17 件のテストで固めてある。別機能のために手を入れる価値はない。

harvester は `src/harvesters.js` の独立した純粋関数で扱う。

### 4.2 週次サマリへの表示は後付けで行う

サマリイベントは `evaluate` が生成する。そこに harvester 情報を含めるには
`buildSummaryEvent` の変更が必要になるが、4.1 の理由で避ける。

代わりに、`evaluate` が返したイベント列に対して**後処理で `harvesters` フィールドを付加する**。
`format.js` はそのフィールドが存在する場合だけ描画する。既存のサマリイベント
（フィールドなし）は従来どおり描画されるため、後方互換が保たれる。

```
evaluate() → events[]  →  annotateSummary(events, harvesterState)  →  dispatch()
             （無変更）      （新規・サマリにだけ追記）
```

## 5. 設定

```json
{
  "name": "oimonode_ex_on_Contabo",
  "host": "vmi2627658.contaboserver.net",
  "api": { "http": 3000, "https": 3001 },
  "peer": { "port": 7900 },
  "harvesters": true
}
```

- `harvesters` は任意。省略時は `false` 扱いで、既存の設定は何も変わらない
- **明示的なオプトインとする。** 他人のノードを死活監視しているだけの場合に、その
  ノードの harvester 変動まで通知されるのは望ましくない
- `harvesters: true` なのに `api` が無い場合は**起動時エラー**（エンドポイントに到達できない）
- 取得先は **https を優先し、無ければ http** を使う。両方設定されていても 1 回だけ取得する

## 6. 監視対象への展開

`parseConfig` は従来どおり `Target[]` を返す。harvester は `kind: 'harvesters'` の
エントリとして同じ配列に含める。

```js
{ key: 'oimonode_ex_on_Contabo::harvesters',
  node: 'oimonode_ex_on_Contabo',
  kind: 'harvesters',
  label: 'harvesters',
  url: 'https://vmi2627658.contaboserver.net:3001' }
```

`src/index.js` は `kind` で振り分ける。

```js
const liveness = targets.filter((t) => t.kind !== 'harvesters');
const harvesterTargets = targets.filter((t) => t.kind === 'harvesters');
```

**`harvesters` の結果を `evaluate` に渡してはならない。** 渡すと死活監視の state に
エントリが作られ、DOWN 判定の対象になってしまう。

## 7. 検査

`src/checks/harvesters.js`:

```js
checkHarvesters(target, opts?) -> Promise<HarvesterObservation>
```

```js
{ node: 'oimonode_ex_on_Contabo',
  ok: true,
  accounts: ['A1FE...', ...],   // 失敗時は null
  detail: 'harvester 6 件' }
```

- `GET {url}/node/unlockedaccount`、タイムアウトは既存の `TIMEOUT_MS`（10 秒）
- `withRetry` を使い、`unreachable` / `bad-response` のみ再試行する（既存と同じ方針）
- `unlockedAccount` が文字列配列でなければ `bad-response`
- 取得した配列は**ソートして保持する**。ノード側の順序が安定している保証がないため、
  順序違いを変化として誤検知しないようにする

## 8. 比較条件

**そのノードの api 検査が今回の実行で成功しているときだけ比較する。**

ノードが停止しているとエンドポイントも失敗するため、素朴に比較すると「全員離脱」という
誤報になる。また、ノード再起動直後は REST が応答しても harvester の読み込みが
終わっていない可能性がある。

判定に使う条件:

```
そのノードの api-http または api-https の CheckResult が ok: true
  かつ
checkHarvesters 自体も ok: true
```

どちらかでも満たさない場合は、**前回の一覧をそのまま保持し、イベントを出さない。**

## 9. 状態

`state.json` に追加するフィールド（既存の `targets` は変更しない）:

```json
{
  "version": 1,
  "updatedAt": "...",
  "lastWeeklySummaryAt": "...",
  "targets": { ... },
  "harvesters": {
    "oimonode_ex_on_Contabo": {
      "accounts": ["A1FE061806EA7484...", "..."],
      "observedAt": "2026-10-20T14:00:00.000Z"
    }
  }
}
```

- **`version` は上げない。** 追加フィールドのみで後方互換があり、バージョンを上げると
  既存の state が「未知のバージョン」として初期化されてしまう
- `normalizeState` は `harvesters` が無い state に対して `{}` を補う
- 設定から外されたノードのエントリは、`targets` と同様に自動的に除去する

## 10. 判定ロジック

`src/harvesters.js`:

```js
evaluateHarvesters({ prevHarvesters, observations, now }) -> { nextHarvesters, events }
```

対象ごとの処理:

| 状況 | イベント | 新しい状態 |
|---|---|---|
| 観測失敗（ノード停止など） | なし | 前回のエントリをそのまま保持 |
| 観測成功・前回の記録なし | なし | 今回の一覧を記録（初回は比較対象がない） |
| 観測成功・前回と同一 | なし | `observedAt` のみ更新 |
| 観測成功・差分あり | `harvesters` を 1 件 | 今回の一覧を記録 |

差分は集合演算で求める。`added = 今回 − 前回`、`removed = 前回 − 今回`。
両方が空でない場合（入れ替わり）は 1 つのイベントに両方を載せる。

`evaluate` と同じく**純粋関数**とし、現在時刻は引数で受け取る。

## 11. イベント

既存の Event 形に合わせ、harvester 固有のフィールドを追加する。

```js
{ type: 'harvesters',
  key: 'oimonode_ex_on_Contabo::harvesters',
  node: 'oimonode_ex_on_Contabo',
  target: 'harvesters',
  reason: null,
  detail: '6 → 7 件',
  hint: null,
  downSince: null,
  occurredAt: '2026-10-20T14:00:00.000Z',
  snapshot: null,
  added: ['9D4B2C01A7F3...'],
  removed: [],
  before: 6,
  after: 7 }
```

## 12. 通知

| 種類 | 色 | 見出し |
|---|---|---|
| 既存 DOWN | 赤 `0xe01e5a` | 🔴 DOWN |
| 既存 復旧 | 緑 `0x2eb67d` | 🟢 復旧 |
| 既存 週次サマリ | 青 `0x1d9bd1` | 📊 週次サマリ |
| **harvester 変化** | **琥珀 `0xecb22e`** | **🌾 Harvester 変化: {node}** |

本文:

```
6 → 7 件

参加: 9D4B2C01A7F3…

確認時刻: 2026-10-20T14:00:00.000Z
```

公開鍵は 64 文字あるため**先頭 12 文字 + 「…」**で表示する。
参加・離脱が複数ある場合は同じ行にカンマ区切りで並べる。
**空のほう（参加だけで離脱が無い等）は行ごと出さない。**「離脱: （なし）」のような
情報量のない行は、本当に見るべき行を埋もれさせる。

### 12.1 週次サマリへの追記

サマリイベントに `harvesters` フィールドがある場合、既存の対象一覧の後に追記する。

```
🟢 oimonode_ex_on_Contabo / api-https — 障害 0 回 — height 5839xxx — 最終正常 ...
🟢 oimonode_ex_on_Contabo / peer — 障害 0 回 — 最終正常 ...

🌾 oimonode_ex_on_Contabo — harvester 6 件
```

`harvesters: true` のノードが 1 つも無い場合はこの節自体を出さない。一覧を一度も取得できていないノードは `🌾 {node} — harvester 未取得` と出す（設定したのに監視できていない状態を無言にしないため）。

## 13. テスト方針

`evaluateHarvesters`（最重要・純粋関数）:

- 初回観測では イベントが出ないこと
- 同一の一覧では イベントが出ないこと
- 順序だけが違う一覧で イベントが出ないこと（ソート保持の検証）
- 参加のみ / 離脱のみ / 入れ替わり の各ケース
- 観測失敗時に前回の一覧が保持され、イベントが出ないこと
- 設定から消えたノードのエントリが除去されること
- `prevHarvesters` を変更しないこと

`checkHarvesters`: 正常応答 / 非 2xx / 非 JSON / `unlockedAccount` が配列でない / タイムアウト。
`fetch` は注入でモックする。

`config.js`: `harvesters: true` の展開、https 優先、`api` 無しでのエラー。

`state.js`: `harvesters` が無い state に `{}` が補われること、往復で保持されること。

`format.js`: harvester イベントの整形、公開鍵の切り詰め、サマリへの追記、
`harvesters` フィールドが無いサマリが従来どおり描画されること。

`index.js`: `kind: 'harvesters'` が `evaluate` に渡らないこと、api が異常なノードでは
比較が行われないこと。

## 14. 既存コードへの影響

| ファイル | 変更内容 |
|---|---|
| `src/evaluate.js` | **変更なし** |
| `src/checks/api.js` / `peer.js` / `retry.js` | **変更なし** |
| `src/notify/{webhook,discord,slack,index}.js` | **変更なし**（色の追加のみ discord/slack） |
| `src/config.js` | `harvesters` の解析と展開を追加 |
| `src/state.js` | `normalizeState` に `harvesters` を追加 |
| `src/notify/format.js` | harvester イベントとサマリ追記の描画を追加 |
| `src/index.js` | 振り分けと結線 |
| `src/checks/harvesters.js` | 新規 |
| `src/harvesters.js` | 新規 |
