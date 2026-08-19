"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUploader, makeEnv } = require("./harness.js");

const detect = (opts) => loadUploader(makeEnv(opts)).detectNextcloud();

test("ログイン済み Nextcloud を判定できる", () => {
    const r = detect({ headAttrs: { "data-requesttoken": "T", "data-user": "alice" } });
    assert.equal(r.hasToken, true);
    assert.equal(r.loggedIn, true);
    assert.equal(r.user, "alice");
    assert.equal(r.origin, "https://cloud.example.com");
});

test("requesttoken が無くてもブロックせず情報を返す（案3の前提）", () => {
    const r = detect({ headAttrs: {} });
    assert.equal(r.hasToken, false);
    assert.equal(r.loggedIn, false);
    assert.equal(r.user, null);
    // origin は返る = ポップアップ側で手動登録できる
    assert.equal(r.origin, "https://cloud.example.com");
});

test("data-user が無い場合は loggedIn=false（公開共有ページ / ログイン画面）", () => {
    const r = detect({ headAttrs: { "data-requesttoken": "T" } });
    assert.equal(r.hasToken, true);
    assert.equal(r.loggedIn, false);
});

test("webroot: ルート設置は空文字", () => {
    const r = detect({ assets: ["/dist/core-common.js"] });
    assert.equal(r.webroot, "");
});

test("webroot: サブディレクトリ設置を script src から推定する", () => {
    const r = detect({ assets: ["/nextcloud/dist/core-common.js"] });
    assert.equal(r.webroot, "/nextcloud");
});

test("webroot: /core/ や /apps/ からも推定できる", () => {
    assert.equal(detect({ assets: [{ tag: "link", href: "/cloud/apps/theming/css/default.css" }] }).webroot, "/cloud");
    assert.equal(detect({ assets: ["/a/b/core/js/main.js"] }).webroot, "/a/b");
});

test("webroot: index.php 経由で配信されるアセットから index.php を除去する", () => {
    assert.equal(detect({ assets: ["/index.php/apps/theming/theme/default.css"] }).webroot, "");
    assert.equal(detect({ assets: ["/nc/index.php/apps/theming/theme/default.css"] }).webroot, "/nc");
});

test("webroot: 別オリジンのアセットは無視する", () => {
    const r = detect({
        assets: ["https://cdn.example.net/wrong/dist/x.js", "/nextcloud/dist/core-common.js"],
    });
    assert.equal(r.webroot, "/nextcloud");
});

test("webroot: アセットが無ければ URL の /index.php/ 手前を使う", () => {
    const r = detect({ assets: [], pathname: "/nextcloud/index.php/apps/files" });
    assert.equal(r.webroot, "/nextcloud");
});

test("webroot: 旧 Nextcloud / ownCloud の data-webroot を優先する", () => {
    const r = detect({
        headAttrs: { "data-requesttoken": "T", "data-user": "alice", "data-webroot": "/legacy/" },
        assets: ["/nextcloud/dist/core-common.js"],
    });
    assert.equal(r.webroot, "/legacy", "末尾スラッシュは落とす");
});

test("webroot: /index.php/css/ 経由のアセットを webroot と誤認しない（405 の原因）", () => {
    // Nextcloud は CSS / JS を {webroot}/index.php/css/{app}/... でも配信する。
    // ここを webroot と誤認すると PUT 先が /index.php/css/remote.php/... になる。
    assert.equal(detect({ assets: ["/index.php/css/core/css/server.css"] }).webroot, "");
    assert.equal(detect({ assets: ["/index.php/js/core/merged-template.js"] }).webroot, "");
    assert.equal(detect({ assets: ["/nc/index.php/css/core/css/server.css"] }).webroot, "/nc");
});

test("webroot: 候補の最後は必ずルート（空文字）", () => {
    const r = detect({ assets: ["/nextcloud/dist/core-common.js"] });
    assert.deepEqual(r.webrootCandidates, ["/nextcloud", ""]);
});

test("webroot: 候補は確度順に並び、先頭が webroot と一致する", () => {
    const r = detect({
        headAttrs: { "data-requesttoken": "T", "data-webroot": "/legacy/" },
        assets: ["/nextcloud/dist/core-common.js"],
        pathname: "/other/index.php/apps/files",
    });
    assert.equal(r.webroot, r.webrootCandidates[0]);
    assert.deepEqual(r.webrootCandidates, ["/legacy", "/nextcloud", "/other", ""]);
});

test("webroot: 重複した候補はまとめる", () => {
    const r = detect({
        assets: ["/nc/dist/a.js", "/nc/core/b.js", "/nc/apps/files/c.js"],
        pathname: "/nc/index.php/apps/files",
    });
    assert.deepEqual(r.webrootCandidates, ["/nc", ""]);
});
