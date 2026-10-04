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
