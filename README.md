# Nextcloud-Quick-Share

開いている Nextcloud のページからファイルをアップロードし、パスワード付き・期限付きの
公開共有リンクを作成して URL をクリップボードにコピーする Edge / Chrome 拡張機能です。

## しくみ

ログイン中のセッション（Cookie）と、ページに埋め込まれている `data-requesttoken` を
そのまま使うため、URL やアプリパスワードの登録は不要です。

1. WebDAV (`PUT /remote.php/webdav/<ファイル名>`) でアップロード
2. OCS API (`POST /ocs/v2.php/apps/files_sharing/api/v1/shares`) で公開リンクを作成
3. 同 API の `PUT` でパスワードと有効期限を設定

## インストール

1. `edge://extensions/`（Chrome は `chrome://extensions/`）を開く
2. 「開発者モード」を有効にする
3. 「展開して読み込み」でこのフォルダを選択する

## 使い方

1. 自分の Nextcloud を開き、ログインした状態にする
2. ツールバーの拡張機能アイコンを押す
3. 必要ならパスワードと有効期限を入力し、「アップロードする」を押す
4. ファイルを選ぶとアップロードされ、共有 URL がクリップボードにコピーされる

初めて使うサイトでは確認のためもう一度ボタンを押す必要があります。承認したオリジンは
`chrome.storage.sync` に保存され、次回以降は確認なしで実行されます。

## セキュリティ設計

- **常時注入はしない。** コンテンツスクリプトを全サイトに登録する代わりに、
  `activeTab` + `chrome.scripting.executeScript` で「ユーザーがアイコンを押したタブに、
  その瞬間だけ」注入します。事前のホスト権限宣言も不要です。
- **パスワードを渡す前に対象を確認する。** まず副作用のない検出関数
  (`detectNextcloud`) だけを注入し、Nextcloud だと確認できた場合にのみ
  パスワードを引数として渡します。
- **トップフレームのみ。** `executeScript` の既定の対象はトップフレームなので、
  ページ内の第三者 iframe に入力値が渡ることはありません。
- 未登録のオリジンでは二段階の確認を求めます。

### 保存しているデータ

| 領域 | キー | 内容 | 消えるタイミング |
| --- | --- | --- | --- |
| `storage.sync` | `knownOrigins` | 承認済みオリジンの配列 | アンインストール時（他デバイスにも伝播） |
| `storage.session` | `lastResult` | 直近の実行結果（共有URLを含む） | 次にポップアップを開いた時 / ブラウザ終了時 |

パスワードは保存しません（毎回入力）。共有URLは実質的なアクセス権を持つため、
ディスクに残る `storage.local` ではなくメモリ上の `storage.session` に置いています。
注入したスクリプトは untrusted context 扱いで既定では `session` に書けないため、
ポップアップ側で `setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })`
を呼んでから注入しています。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | MV3 マニフェスト（`content_scripts` は使わない） |
| `src/popup.html` | 入力 UI |
| `src/popup.js` | タブ判定・注入・結果表示 |
| `src/uploader.js` | ページへ注入される `detectNextcloud` / `runUpload` |

### `src/uploader.js` を編集するときの注意

`runUpload` と `detectNextcloud` は `Function.prototype.toString()` で文字列化されて
ページへ注入されるため、**外側のスコープを一切参照できません**。ヘルパ関数や定数は
必ず関数の内側に入れ子で定義してください。戻り値も構造化クローン可能な値に限られます。

## 制限事項

- アップロード先はユーザーのルートフォルダ固定です。
- 同名ファイルがある場合は `If-None-Match: *` により上書きを避け、`名前-1.ext` の
  ように連番を付けて保存します。
- 大きなファイルはメモリ上に読み込むため、チャンクアップロードには未対応です。
