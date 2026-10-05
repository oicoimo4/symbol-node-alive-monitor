# Claude への修正依頼：死活監視のレビュー指摘

対象は現在の `main`（レビュー時点の HEAD: `e254659`）です。GitHub Actions と通知・状態管理について、以下を修正してください。既存の監視仕様（10 分間隔、2 回連続失敗で DOWN、復旧通知、週次サマリ）は維持してください。

## 1. 通知先がゼロでも通知済みになる（高）

- 該当箇所: `src/notify/index.js` の通知先ゼロ時の戻り値、`src/index.js` の `channels > 0 && delivered === 0` 判定。
- 再現: Discord / Slack の Secret を両方未設定にして初回または障害発生時に実行する。送信は行われないのに `lastWeeklySummaryAt` や `notified` が保存される。後から Secret を設定しても、既に消費した通知は再送されない。
- 期待: 通知先ゼロを設定エラーとして扱い、通知イベントを消費する状態更新を行わずジョブを失敗させる。できれば検査前に検出する。設定不足の原因をログで明確にする。
- 確認: 通知先ゼロで既存 state が維持されること、Secret を設定した次回実行で未送信イベントが送られることをテストする。

## 2. state の取得・解析失敗が履歴消失につながる（高）

- 該当箇所: `.github/workflows/monitor.yml` の `git show FETCH_HEAD:state.json` 失敗時の `{}` へのフォールバック、`src/state.js` の JSON 解析失敗・不正 state 時の初期化、`Persist state` の `if: always()`。
- 再現: `monitoring-state` ブランチは存在するが `state.json` を取得できない、JSON が壊れている、または読み込みに失敗する場合。現在は初期 state に進める経路があり、後続の force push で `notified`・`lastHeight`・週次カウンタを失い得る。
- 期待: 本当に `monitoring-state` ブランチが存在しない初回だけ初期化する。既存ブランチの state が取得・解析・検証できない場合は失敗して既存 state を上書きしない。`Persist state` は復元に失敗した場合に実行しないこと。`main` 側に `state.json` が誤って追跡された場合も古いファイルを push しないようにする。
- 確認: ブランチ不在、fetch 失敗、`git show` 失敗、不正 JSON、未知のバージョン、読み込みエラーの各経路で state の扱いをテストする。従来の「壊れた state は初期化する」テストは新仕様に合わせて更新する。

## 3. 一部の通知先だけ失敗すると、その通知先ではイベントを失う（中）

- 該当箇所: `src/notify/index.js` の `delivered` 集計、`src/index.js` の「1 件以上成功なら state 保存」。
- 再現: Discord は成功、Slack は失敗。全体の `notified` が立つため、次回 Slack には同じ DOWN / 復旧 / サマリが送られない。
- 期待: 両方の通知先を設定したとき、片方の失敗を永続的な未配信にしない。通知先ごとの配信状態を持つ方式、または全送信成功まで全イベントを再試行する方式など、重複通知とのトレードオフを明示して実装する。
- 確認: 片方だけ失敗して次回復旧したときに、失敗した宛先へ通知が届くことをテストする。

## 4. Webhook 送信に期限がない（中）

- 該当箇所: `src/notify/webhook.js` の `fetchImpl()` と非 2xx 時の `response.text()`。
- 再現: 通知先が応答しない、または本文を返し切らないと、ジョブの `timeout-minutes: 10` まで状態保存が進まない可能性がある。
- 期待: 送信全体に明示的なタイムアウトを設け、失敗時は通知の再試行方針に従って state を扱う。Discord の 429 なども考慮する。
- 確認: 応答が止まるケースで期限内に失敗として処理されることをテストする。

## 5. Actions の参照を固定する（セキュリティ強化）

- 該当箇所: `.github/workflows/monitor.yml` の `actions/checkout@v4`、`actions/setup-node@v4`。
- このジョブは Webhook の Secret と `contents: write` のトークンを扱う。可変タグではなく、公式リポジトリのリリースに対応する完全なコミット SHA に固定する。SHA の出典と対応するバージョンをコメントに残す。
- 参考: GitHub の [Secure use reference](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)。

## 完了条件

- 上記の失敗経路をテストに追加・更新し、`npm test` が通る。
- state を上書きしてよい条件と、通知を配信済みとみなす条件がコードと README で一致する。
- 変更点、残る制約、実際に確認した範囲を報告する。ローカルのテストだけで GitHub 上の実行成功を確認したことにはしない。

レビュー時には既存のテスト 103 件はすべて成功しました。ローカルに Git リモート設定がなく、GitHub Actions の実行履歴・Secret 設定・ブランチ保護は未確認です。
