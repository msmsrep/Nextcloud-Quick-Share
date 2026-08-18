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
`chrome.storage.sync` に保存され、次回以降は確認なしで実行されます。登録済みのサイトは
ポップアップ下部に一覧表示され、「削除」で登録を解除できます。

Nextcloud と判定できないページでも、**警告を確認したうえで登録して実行できます**
（ボタンが「警告を承知で登録して続行」に変わります）。判定はあくまで誤操作防止のための
目安で、続行するかどうかはユーザーが決める設計です。

## セキュリティ設計

- **常時注入はしない。** コンテンツスクリプトを全サイトに登録する代わりに、
  `activeTab` + `chrome.scripting.executeScript` で「ユーザーがアイコンを押したタブに、
  その瞬間だけ」注入します。事前のホスト権限宣言も不要です。
- **パスワードを渡す前に対象を確認する。** まず副作用のない検出関数
  (`detectNextcloud`) だけを注入し、Nextcloud だと確認できた場合にのみ
  パスワードを引数として渡します。
- **トップフレームのみ。** `executeScript` の既定の対象はトップフレームなので、
  ページ内の第三者 iframe に入力値が渡ることはありません。
- 未登録のオリジンでは二段階の確認を求めます。承認済みの一覧はポップアップから
  確認・削除できます。

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

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | MV3 マニフェスト（`content_scripts` は使わない） |
| `src/popup.html` | 入力 UI |
| `src/popup.js` | タブ判定・注入・結果表示 |
| `src/uploader.js` | ページへ注入される `detectNextcloud` / `runUpload` |
| `test/harness.js` | uploader.js を Node で動かすためのフェイク環境 |
| `test/*.test.js` | 自動テスト（`npm test`） |
| `test/ui/` | ポップアップ UI の手動確認用サーバーとスタブ（`npm run test:ui`） |

### `src/uploader.js` を編集するときの注意

`runUpload` と `detectNextcloud` は `Function.prototype.toString()` で文字列化されて
ページへ注入されるため、**外側のスコープを一切参照できません**。ヘルパ関数や定数は
必ず関数の内側に入れ子で定義してください。戻り値も構造化クローン可能な値に限られます。

## 判定と webroot の推定について

対象ページの判定は `<head>` の属性で行います。これは `core/templates/layout.*.php` が
出力するもので、公式の `@nextcloud/auth` も同じ場所からトークンを読んでいます。

- `data-requesttoken` … 全レイアウト（`layout.user.php` / `layout.base.php` /
  `layout.public.php`）にあります
- `data-user` … ログイン済みレイアウトにしかありません。無い場合は公開共有ページや
  ログイン画面の可能性が高いと判断します

**どちらも「警告」であって中断条件ではありません。** 検出に失敗しても、ユーザーが
明示的に承認すれば登録・実行できます。Nextcloud 30 以降は `OCS-APIRequest` ヘッダだけで
CSRF チェックを通過できるため、トークンが取れないページでも成功する場合があるためです
（30 未満では 401 になり、その旨をエラーメッセージで案内します）。

webroot（サブディレクトリ設置）は `<head>` からは取れないため（`data-webroot` 属性は
存在しません）、同一オリジンの `script[src]` / `link[href]` を走査して
`{webroot}/dist/`・`/core/`・`/apps/` の手前を webroot とみなしています。
取れない場合は `/index.php/` の手前、それも無ければ空文字（ルート設置）です。

## CSRF 対策との関係

WebDAV / OCS のどちらも、Cookie 認証のリクエストにはサーバ側で CSRF チェックが入ります
（WebDAV で通らないと `NotAuthenticated: CSRF check not passed.` で 401）。
本拡張はどのバージョンでも通るよう、両方のヘッダを送っています。

| ヘッダ | 効く条件 |
| --- | --- |
| `requesttoken` | 全バージョン。`<head data-requesttoken>` から実行直前に読み直す |
| `OCS-APIRequest: true` | Nextcloud 30 以降。`passesCSRFCheck()` がこのヘッダだけで通す |

`OCS-APIRequest` は CORS のセーフリスト外のヘッダで、クロスオリジンからは付けられないため、
それ自体が CSRF 防御として機能するという設計です。NC 30 未満では効かないので、
トークンの送信も併用しています。

## 制限事項

- アップロード先はユーザーのルートフォルダ固定です。
- 判定はあくまで UX 上のガードです。任意のサイトが `data-requesttoken` を名乗れるため、
  セキュリティ上の保護はオリジン許可リストが担っています。
- ownCloud も同じ属性・同じ API を持つため判定を通過します。
- 同名ファイルがある場合は `If-None-Match: *` により上書きを避け、`名前-1.ext` の
  ように連番を付けて保存します。
- 大きなファイルはメモリ上に読み込むため、チャンクアップロードには未対応です。
