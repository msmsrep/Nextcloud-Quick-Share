# test Nextcloud-Quick-Share

## テスト

依存パッケージはありません（Node 標準のテストランナーのみ）。`npm install` も不要です。

### 自動テスト

```bash
npm test
```

`src/uploader.js` を**実物のまま**読み込み、`document` / `location` / `fetch` /
`chrome` などのブラウザ API だけをフェイクに差し替えて実行します（`test/harness.js`）。
ロジックをテスト用に複製していないので、実装を変えれば必ずテストに反映されます。

| ファイル | 内容 |
| --- | --- |
| `test/detect.test.js` | 判定と webroot 推定（サブディレクトリ、`index.php` 経由、別オリジン除外など） |
| `test/upload.test.js` | アップロード〜共有〜設定の一連（ファイル名エンコード、412 での連番退避、OCS のエラー判定、CSRF ヘッダ、キャンセル、クリップボード失敗など） |

### ポップアップ UI の手動確認

```bash
npm run test:ui
```

`http://localhost:8731/` でポップアップが開きます。`src/popup.html` をその場で読んで
`chrome` API のスタブを差し込むだけなので、UI をコピーしておらず実装と食い違いません。
`?scenario=` で状況を切り替えられます。

| シナリオ | 状況 |
| --- | --- |
| `ok`（既定） | 登録済みサイト。前回結果の表示も再現 |
| `unknown` | 未登録かつ requesttoken 無し。警告付きの登録フロー |
| `public` | 登録済みだが公開共有ページ（`loggedIn=false`） |
| `fresh` | 登録済みサイトが 0 件 |

### テストしていない範囲

実サーバーとの通信は当然フェイクなので、**実機の Nextcloud でしか確認できない部分**は
残ります。特に `If-None-Match: *` に対する 412 応答、`OCS-APIRequest` による CSRF 通過
（NC 30 以降）、webroot 推定が実際のページで当たるかは、拡張機能を読み込んで確認してください。
