# Symbol ノード死活監視システム 設計書

- 作成日: 2026-10-04
- ステータス: 設計確定（実装前）

## 1. 目的と前提

Symbol ブロックチェーンの API ノード / Peer ノードが停止・同期停止した際に、できるだけ早く気づけるようにする。

前提条件:

- **有料のサーバーを一切立てない。** 実行基盤は GitHub Actions の無料枠のみ。
- **通知も無料手段のみ。** Discord Incoming Webhook と Slack Incoming Webhook。
- リポジトリは **Public**（Actions の実行時間が無制限のため）。
- 監視対象は自分が運用するノードと、指定した他人の公開ノード。

## 2. スコープ

含むもの:

- API ノードの HTTP 疎通確認（http / https それぞれ独立）
- API ノードのチェーン高進行確認
- Peer ノードの TCP 疎通確認
- 障害・復旧・週次サマリの通知
- 障害継続中の通知抑制（スパム防止）

含まないもの（YAGNI、将来の拡張余地として記録のみ）:

- ファイナライズ遅延の監視
- Peer ポートの TLS ハンドシェイク検証（相互認証のため証明書が必要）
- Symbol ネットワーク全体の統計収集
- メトリクスの時系列保存・可視化
- 自動復旧（ノードの再起動など）

## 3. アーキテクチャ

GitHub Actions の cron（10分間隔）で Node.js スクリプトを1回実行する。1回の実行は「状態の読込 → 検査 → 判定 → 通知 → 状態の保存」で完結し、実行間でサーバープロセスは一切存在しない。

実行間で引き継ぐ必要がある情報（前回のチェーン高、連続失敗回数、通知済みフラグ）は、同一リポジトリの `monitoring-state` ブランチに `state.json` として force push で保存する。

```
[cron 10分] → [checkout] → [state.json を fetch]
                               ↓
                        [全ノードを並列検査]
                               ↓
                 [evaluate(): 前回state + 検査結果 → 新state + 通知イベント]
                               ↓
                     [Discord / Slack へ送信]
                               ↓
                 [state.json を monitoring-state へ force push]
```

### 3.1 実装言語

**Node.js 20、外部依存ゼロ。**

GitHub Actions の ubuntu runner には Node 20 が標準搭載されており、必要なものはすべて標準ライブラリで揃う。

- HTTP: グローバル `fetch`（`AbortSignal.timeout()` でタイムアウト）
- TCP: `node:net`
- テスト: `node:test` + `node:assert`

`npm install` が不要なため実行が数秒で終わり、依存パッケージの脆弱性アラートにも悩まされない。bash + curl + jq だと BigInt でのチェーン高比較や状態遷移の分岐が壊れやすいため採用しない。

### 3.2 ディレクトリ構成

```
.github/workflows/monitor.yml   # cron */10 + workflow_dispatch
config/nodes.json               # 監視対象の定義（運用時はここだけ編集する）
src/
  index.js            # 全体の流れ。副作用はここに集約する
  config.js           # nodes.json の読込・検証・監視対象への展開
  checks/api.js       # API ノードの検査
  checks/peer.js      # Peer ノードの検査
  state.js            # state.json の読み書きとスキーマ移行
  evaluate.js         # 判定ロジック（純粋関数）
  notify/index.js     # 通知のディスパッチ
  notify/discord.js   # Discord 用の整形と送信
  notify/slack.js     # Slack 用の整形と送信
test/
  evaluate.test.js
  config.test.js
  checks.test.js
  notify.test.js
.gitignore            # state.json を main に混入させない
package.json          # type: module, scripts.test
README.md             # セットアップ手順
```

### 3.3 モジュールの責務

各モジュールは「何をするか / どう使うか / 何に依存するか」が独立して説明できる単位に切ってある。

| モジュール | 責務 | 依存 |
|---|---|---|
| `config.js` | `nodes.json` を読み、検証し、フラットな監視対象リストに展開する | ファイルシステムのみ |
| `checks/api.js` | 1つの API エンドポイントを検査し `CheckResult` を返す | `fetch`（注入可能） |
| `checks/peer.js` | 1つの Peer ポートを検査し `CheckResult` を返す | `node:net`（注入可能） |
| `evaluate.js` | 前回 state と `CheckResult[]` から、新 state と通知イベント列を算出する | **なし（純粋関数）** |
| `state.js` | `state.json` の読み書き。欠損時は初期状態を返す | ファイルシステムのみ |
| `notify/*.js` | 通知イベントを各サービスのペイロードに整形して送信する | `fetch`（注入可能） |
| `index.js` | 上記を順に呼び出し、終了コードを決める | 全モジュール |

**`evaluate.js` を純粋関数にすることが設計の肝。** ネットワークもファイルも時刻取得も行わない（現在時刻は引数で受け取る）ため、状態遷移の全パターンをテストで総当たりできる。障害判定のバグは「通知が来ない」という最も気づきにくい形で現れるため、ここだけはテストで固める。

## 4. 監視対象の定義

`config/nodes.json`:

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
      "name": "friend-node",
      "host": "node2.example.com",
      "api": { "https": 3001 }
    },
    {
      "name": "peer-only-node",
      "host": "node3.example.com",
      "peer": { "port": 7900 }
    }
  ]
}
```

ルール:

- `name` は監視対象の識別子。state のキーに使うため**一意かつ変更しない**。変更すると履歴が切れて新規ノード扱いになる。
- `api.http` / `api.https` / `peer.port` は**それぞれ任意**。記述されたものだけを検査する。
- Symbol ノードは通常 3000(http) と 3001(https) を同時に公開するため、両方書けば両方が独立した監視対象になる。https だけが落ちる（TLS 証明書の期限切れ）パターンを検知するにはこの分離が必要。

### 4.1 監視対象への展開

`config.js` は上記を以下のフラットなリストに展開する。

```js
[
  { key: 'my-node-01::api-http',  node: 'my-node-01', kind: 'api',  url: 'http://node1.example.com:3000' },
  { key: 'my-node-01::api-https', node: 'my-node-01', kind: 'api',  url: 'https://node1.example.com:3001' },
  { key: 'my-node-01::peer',      node: 'my-node-01', kind: 'peer', host: 'node1.example.com', port: 7900 },
]
```

以降のすべての処理は `key` 単位で動く。

### 4.2 設定の検証

起動時に以下を検証し、1つでも違反があればエラーを出して**終了コード 1 で異常終了**する（設定ミスで監視が無言で停止するのを防ぐため）。

- `name` が存在し、一意であること
- `host` が存在し、空文字でないこと
- `api` と `peer` の少なくとも一方が存在すること
- ポート番号が 1〜65535 の整数であること

## 5. 検査ロジック

### 5.1 CheckResult

すべての検査は以下の形を返す。

```js
{
  key: 'my-node-01::api-https',
  ok: true | false,
  reason: null | 'unreachable' | 'health-down' | 'chain-stalled' | 'bad-response',
  detail: '人間向けの説明文',
  height: '3456789' | null   // API 検査が成功したときのみ
}
```

### 5.2 API ノードの検査

1. **ヘルスチェック**: `GET {url}/node/health`
   - レスポンス例: `{"status":{"apiNode":"up","db":"up"}}`
   - HTTP ステータスが 2xx **かつ** `status.apiNode === "up"` **かつ** `status.db === "up"` のときのみ合格。
   - symbol-rest はコンポーネント障害時に 503 を返すため、ステータスコードと本文の両方を見る。
   - 不合格なら `reason: 'health-down'` で終了（`/chain/info` は叩かない）。

2. **チェーン高の取得**: `GET {url}/chain/info`
   - レスポンス例: `{"height":"3456789", "scoreHigh":"...", "latestFinalizedBlock":{...}}`
   - `height` を**文字列のまま取得し、比較は `BigInt` で行う**。Symbol のチェーン高は将来的に `Number.MAX_SAFE_INTEGER` には達しないが、API が文字列で返す以上、文字列比較の罠（`"9" > "10"`）を避けるため BigInt を使う。
   - 前回の `lastHeight` が存在し、`BigInt(height) <= BigInt(lastHeight)` なら `reason: 'chain-stalled'`。
   - `lastHeight` が存在しない（初回）場合は進行チェックをスキップし、合格扱いで height だけ記録する。

**チェーン高で判定する理由**: Symbol は約30秒で1ブロック生成されるため、10分間隔なら20ブロック前後進むのが正常。進んでいなければ「プロセスは生きているが同期が止まっている」状態を検知できる。判定を「経過時間」ではなく「前回値からの増加」にしてあるため、後述する cron の遅延に対して頑健である。

**ロールバックについて**: チェーンが数ブロック巻き戻ると一時的に `height <= lastHeight` になりうる。しかし30秒/ブロックで追いつくため次回実行時には回復しており、通知には連続2回の失敗が必要なため誤報にはならない。

### 5.3 Peer ノードの検査

`node:net` で `{host}:{port}` へ TCP 接続し、10秒以内に `connect` イベントが発火すれば合格。発火後は即座にソケットを破棄する。

Symbol の Peer ポート(7900)は**相互 TLS 認証**であり、Symbol PKI で署名されたクライアント証明書なしに完全なハンドシェイクは成立しない。したがって「TCP 接続が確立する = プロセスが生きて listen している」ところまでを担保範囲とする。

将来 TLS ハンドシェイクまで検証する場合は、`tls.connect({ rejectUnauthorized: false })` でサーバー証明書の受信までを確認する方式が考えられるが、今回は実装しない。

### 5.4 タイムアウトとリトライ

- 1回のリクエストのタイムアウトは **10秒**（HTTP は `AbortSignal.timeout(10_000)`、TCP は `socket.setTimeout(10_000)`）。
- 失敗した場合は **5秒待って最大2回リトライ**（合計3回試行）。一時的なネットワークの揺らぎを吸収する。
- すべての監視対象は `Promise.all` で**並列**に検査する。最悪ケースでも 3回 × (10秒 + 5秒) ≒ 45秒で全体が完了する。

## 6. 状態管理

### 6.1 state.json のスキーマ

```json
{
  "version": 1,
  "updatedAt": "2026-10-04T13:00:00.000Z",
  "lastWeeklySummaryAt": "2026-09-29T00:10:00.000Z",
  "targets": {
    "my-node-01::api-https": {
      "status": "up",
      "consecutiveFailures": 0,
      "lastHeight": "3456789",
      "lastOkAt": "2026-10-04T13:00:00.000Z",
      "downSince": null,
      "notified": false,
      "incidentsThisWeek": 0
    }
  }
}
```

- `version` はスキーマ変更時の移行用。読み込んだ内容が `{}`（state ブランチが存在しない初回実行）、JSON として不正、または未知のバージョンである場合は、いずれも初期状態 `{ version: 1, lastWeeklySummaryAt: null, targets: {} }` から開始する。
- `notified` は「DOWN 通知を送信済みか」。障害継続中の再通知を防ぐ。
- `incidentsThisWeek` は週次サマリ送信時に 0 にリセットする。
- 設定から削除された監視対象のエントリは、評価時に自動的に破棄する（state の肥大化を防ぐ）。

### 6.2 保存先

同一リポジトリの **`monitoring-state` ブランチ**（orphan branch、`state.json` のみを含み、常に1コミット）に force push する。

**この方式を選ぶ最大の理由は、Public リポジトリの scheduled workflow が「60日間リポジトリ活動がないと自動停止する」という GitHub の仕様を回避できること。** 毎回の実行が push を発生させるため活動が途切れず、監視が無言で止まる事故を構造的に防げる。Actions Cache 方式ではこの問題を回避できず、さらに7日で消える。

force push で毎回履歴を作り直すため、`main` の履歴は汚れず、state ブランチのコミット数も常に1に保たれる。

### 6.3 読み込み時の注意

**`raw.githubusercontent.com` を使ってはならない。** CDN キャッシュにより最大数分古い値が返る可能性があり、10分間隔の監視では致命的な誤動作（古い height との比較、通知済みフラグの喪失による重複通知）を招く。

必ず `git fetch --depth=1 origin monitoring-state` で取得する。

## 7. 判定ロジック（evaluate.js）

### 7.1 シグネチャ

```js
evaluate({ prevState, results, now }) -> { nextState, events }
```

`now` は `Date` を引数で受け取る。これにより週次サマリの発火条件をテストで制御できる。

### 7.2 監視対象ごとの状態遷移

検査が**成功**した場合:

| 条件 | 発火するイベント | 新しい状態 |
|---|---|---|
| 前回 `notified === true` | `recovered` | `status: 'up'`, 各カウンタをリセット |
| それ以外 | なし | `status: 'up'`, 各カウンタをリセット |

成功時は `lastHeight` を今回の値で更新し、`lastOkAt` を `now`、`downSince` と `notified` をクリアする。

検査が**失敗**した場合:

```
failures = prev.consecutiveFailures + 1
downSince = prev.downSince ?? now

if (failures >= 2 && !prev.notified) {
    → 'down' イベントを発火
    → notified = true
    → incidentsThisWeek += 1
}
```

- `status` は `failures >= 2` のとき `'down'`、それ未満は `'up'` のまま。
- **`lastHeight` は失敗時に更新しない。** これにより、停滞から復旧したと判定するには実際に前回の正常値を超える必要がある。
- `notified` が既に `true` なら何も発火しない（障害継続中は沈黙）。

**連続2回で初めて通知する理由**: 10分間隔なので、約20分継続した障害でのみ通知が飛ぶ。リトライ3回でも吸収できない瞬断や、GitHub runner 側の一時的なネットワーク障害による誤報を防ぐ。

### 7.3 TLS 証明書切れの推定

イベント列の生成後、以下の後処理を行う。

`{node}::api-https` が `down` イベントを発火しており、かつ同じノードの `{node}::api-http` が**今回の実行の `CheckResult` で `ok: true`** である場合（state 上の `status` ではなく今回の検査結果で判定する）、通知本文に次の一文を付加する。

> HTTP(3000) は正常です。TLS 証明書の期限切れの可能性があります。

Symbol ノードで最も多い「静かな死に方」であり、この情報があるかないかで復旧までの時間が大きく変わるため組み込む。

### 7.4 週次サマリ

- `lastWeeklySummaryAt` が `null`（初回実行）の場合、**即座にサマリを送信する**。これにより Webhook の設定が正しいことをセットアップ直後に確認できる。
- `now - lastWeeklySummaryAt >= 7日` の場合にサマリを送信する。
- 送信後、`lastWeeklySummaryAt = now` とし、全対象の `incidentsThisWeek` を 0 にリセットする。

サマリの内容: 全監視対象の現在の状態（up/down）、直近7日の障害発生回数、最終正常確認時刻、API ノードの現在のチェーン高。

**このサマリが届かなくなったら監視自体が死んだサイン**、という位置づけ。無料監視における最大の落とし穴は「監視が止まっていることに気づかない」ことなので、これを唯一の生存信号とする。

## 8. 通知

### 8.1 通知イベント

```js
{
  type: 'down' | 'recovered' | 'summary',
  key: 'my-node-01::api-https',
  node: 'my-node-01',
  target: 'api-https',
  reason: 'health-down',
  detail: '...',
  hint: null | 'TLS 証明書の期限切れの可能性があります',
  downSince: '2026-10-04T12:40:00.000Z',
  occurredAt: '2026-10-04T13:00:00.000Z'
}
```

`summary` 型のみ、全対象のスナップショットを `snapshot` フィールドに持つ。

### 8.2 送信先

| 環境変数 | 用途 |
|---|---|
| `DISCORD_WEBHOOK_URL` | Discord Incoming Webhook |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook |

**両方とも任意。** 設定されている方にのみ送信する。両方未設定の場合は、イベント内容を警告として標準出力に書き出したうえで検査を続行し、state も通常どおり保存する（配信先がゼロなのは設定上の意図とみなし、異常終了はしない）。

### 8.3 整形

| イベント | 色 | 見出し |
|---|---|---|
| `down` | 赤 (`0xE01E5A`) | `🔴 DOWN: {node} ({target})` |
| `recovered` | 緑 (`0x2EB67D`) | `🟢 復旧: {node} ({target})` |
| `summary` | 青 (`0x1D9BD1`) | `📊 週次サマリ` |

Discord は embeds、Slack は attachments の `color` 付きで送る。整形ロジックは各アダプタに閉じ込め、`evaluate.js` が返すイベントは通知先を知らない。

### 8.4 送信失敗時の扱い

通知の送信は **state の保存より前**に行う。

- 送信すべきイベントがあり、**設定済みの全チャンネルで送信に失敗**した場合は、`state.json` を書き換えずに終了コード 1 で異常終了する。これにより次回実行時に同じイベントが再評価され、通知が再試行される（`notified` フラグが立たないため）。
- 1つでも成功したチャンネルがあれば配信済みとみなし、state を保存して正常終了する。

## 9. GitHub Actions ワークフロー

`.github/workflows/monitor.yml`:

```yaml
name: node-alive-monitor

on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
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
        run: |
          if git fetch --depth=1 origin monitoring-state 2>/dev/null \
             && git show FETCH_HEAD:state.json > state.json 2>/dev/null; then
            echo "state restored"
          else
            echo '{}' > state.json
            echo "no previous state; starting fresh"
          fi

      - name: Run checks
        env:
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: node src/index.js

      - name: Persist state
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

設計上の要点:

- `concurrency` で同時実行を防ぎ、state の書き込み競合を回避する。
- `permissions: contents: write` は state ブランチへの push に必要。
- **ノードが落ちていてもワークフローは成功（終了コード 0）で終わる。** ワークフロー失敗を node down の通知手段にすると、GitHub からの失敗メールと Discord/Slack 通知が二重に飛び、かつ内部エラーと区別がつかなくなる。ワークフローが失敗するのは「設定ファイルが不正」「全通知チャンネルへの送信失敗」など**監視システム自体の異常時のみ**とし、その場合は GitHub の標準の失敗通知メールが最後の砦として機能する。
- `Persist state` は `if: always()` で必ず実行する。検査が途中でクラッシュした場合は復元した古い state がそのまま push し直されるだけで、害はない。
- `${{ secrets.GITHUB_TOKEN }}` はログ上でマスクされる。

## 10. 無料運用の制約と対策

| 制約 | 対策 |
|---|---|
| Public リポジトリは60日間活動がないと scheduled workflow が自動停止する | 毎回 state を push するため活動が途切れない（6.2 節） |
| cron は公称5分が最短だが、実際には10〜30分遅延したりスキップされる | 間隔を10分とし、判定を経過時間ではなく「height の増加」に基づかせる（5.2 節） |
| 一時的なネットワーク障害による誤報 | 3回リトライ + 連続2回失敗で初めて通知（5.4, 7.2 節） |
| 障害継続中の通知スパム | `notified` フラグで抑制（7.2 節） |
| 監視システム自体の停止に気づけない | 週次サマリを生存信号とする（7.4 節） |
| state の読み込みでキャッシュによる古い値を掴む | `raw.githubusercontent.com` を使わず `git fetch` で取得（6.3 節） |
| 同時実行による state の競合 | `concurrency` グループ（9 節） |

## 11. テスト方針

`node:test` を使い、`npm test` で全件実行する。ネットワークアクセスは一切行わない。

**`evaluate.js`（最重要）** — 純粋関数なので状態遷移を総当たりする。

- 初回実行（前回 state なし）で height の進行チェックがスキップされること
- 1回目の失敗では通知が発火しないこと
- 2回連続の失敗で `down` イベントが1回だけ発火すること
- 3回目以降の失敗では何も発火しないこと
- 復旧時に `recovered` が発火し、カウンタがリセットされること
- 通知前（1回失敗）の状態から復旧した場合、`recovered` が発火**しない**こと
- height が増えない場合に `chain-stalled` となること
- 失敗時に `lastHeight` が更新されないこと
- https が down かつ http が up のとき、証明書切れの hint が付くこと
- `lastWeeklySummaryAt` が null のときサマリが発火すること
- 7日経過でサマリが発火し、`incidentsThisWeek` がリセットされること
- 設定から消えた監視対象のエントリが state から除去されること

**`config.js`** — 正常な設定の展開、`name` 重複・ポート範囲外・`api`/`peer` 両方欠落の各エラー検出。

**`checks/*.js`** — `fetch` と `net` を関数注入でモックし、正常応答 / 503 / 不正 JSON / タイムアウト / リトライ回数を検証する。

**`notify/*.js`** — 各イベント型が期待どおりのペイロードに整形されること、片方の Webhook URL のみ設定された場合の挙動。

## 12. セットアップ手順（README に記載する内容）

1. リポジトリを Public で作成して push する
2. Discord サーバー設定 → 連携サービス → ウェブフック から URL を取得
3. Slack App の Incoming Webhook から URL を取得
4. リポジトリの Settings → Secrets and variables → Actions に `DISCORD_WEBHOOK_URL` と `SLACK_WEBHOOK_URL` を登録
5. `config/nodes.json` を自分のノードに合わせて編集
6. Actions タブから `node-alive-monitor` を手動実行（`workflow_dispatch`）し、初回サマリが両方のチャンネルに届くことを確認する

## 13. 実装の分担

- 設計・計画・ワークフロー YAML のレビュー: Opus
- `config.js` / `checks/` / `notify/` / `evaluate.js` の実装とテスト: Sonnet サブエージェントに分割して並列実行

モジュール間の依存が薄いため並列化できる。ただし `.github/workflows/monitor.yml` の state 保存部分は、壊れても通知が飛ばず無言で監視が劣化するため、必ず人間ないし Opus がレビューする。
