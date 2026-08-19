"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUploader, makeEnv, makeFile, ocsOk, ocsFail, callsMatching } = require("./harness.js");

/** env を作って runUpload を実行し、結果と env を返す。 */
async function run(opts = {}, args = {}) {
    const env = makeEnv(opts);
    const { runUpload } = loadUploader(env);
    const result = await runUpload(
        args.webroot ?? "",
        args.password ?? "",
        args.expireDate ?? ""
    );
    return { result, env };
}

const put = (env) => callsMatching(env, "PUT", "/remote.php/webdav/");
const createShare = (env) => callsMatching(env, "POST", "/shares");
// 後追い設定の PUT。廃止したので「1 本も出ていないこと」の確認に使う。
const updateShare = (env) => env.calls.filter((c) => c.method === "PUT" && /\/shares\/\d+/.test(c.url));

test("正常系: アップロード → 共有作成（設定込み）→ クリップボード", async () => {
    const { result, env } = await run({}, { password: "pw", expireDate: "2026-12-31" });

    assert.equal(result.ok, true);
    assert.equal(result.url, "https://cloud.example.com/s/TOKEN");
    assert.equal(result.name, "report.pdf");
    assert.equal(result.renamed, false);
    assert.equal(result.copied, true);
    assert.equal(result.passwordSet, true);
    assert.equal(result.expireSet, true);
    assert.equal(env.copied, "https://cloud.example.com/s/TOKEN");

    assert.equal(put(env).length, 1);
    assert.equal(createShare(env).length, 1);
    assert.equal(updateShare(env).length, 0, "後追いの PUT は送らない");
});

test("パスワードと有効期限は共有作成時に一緒に送る（無防備な瞬間を作らない）", async () => {
    const { env } = await run({}, { password: "pw", expireDate: "2026-12-31" });

    const body = createShare(env)[0].body;
    assert.equal(body.get("shareType"), "3");
    assert.equal(body.get("permissions"), "1");
    assert.equal(body.get("password"), "pw");
    assert.equal(body.get("expireDate"), "2026-12-31");
    assert.equal(updateShare(env).length, 0);
});

test("ファイル名を URL エンコードする（# や空白や日本語で壊れない）", async () => {
    const name = "報 告書 #1 & 2.pdf";
    const { env } = await run({ file: makeFile(name, "application/pdf") });

    const url = put(env)[0].url;
    assert.equal(url, "/remote.php/webdav/" + encodeURIComponent(name));
    assert.ok(!url.includes("#"), "# が生のまま入るとパスが切れる");
    assert.ok(!url.includes(" "), "空白が生のまま入ってはいけない");
});

test("webroot がサブディレクトリなら全リクエストに前置される", async () => {
    const { env } = await run({}, { webroot: "/nextcloud" });

    assert.ok(put(env)[0].url.startsWith("/nextcloud/remote.php/webdav/"));
    assert.ok(createShare(env)[0].url.startsWith("/nextcloud/ocs/v2.php/"));
});

test("同名ファイルがあれば上書きせず連番で退避する", async () => {
    let firstPut = true;
    const { result, env } = await run({
        handler: (call) => {
            if (call.method === "PUT" && call.url.includes("/remote.php/webdav/")) {
                if (firstPut) { firstPut = false; return { status: 412, body: "" }; }
                return { status: 201, body: "" };
            }
            if (call.method === "POST") return ocsOk({ id: 7, url: "https://cloud.example.com/s/X" });
            return ocsOk({ id: 7 });
        },
    });

    assert.equal(result.ok, true);
    assert.equal(result.name, "report-1.pdf");
    assert.equal(result.renamed, true);

    const puts = put(env);
    assert.equal(puts.length, 2);
    assert.equal(puts[0].headers["If-None-Match"], "*", "上書き防止ヘッダが必要");
    assert.ok(puts[1].url.endsWith("report-1.pdf"));

    // 共有はアップロードした実際の名前に対して作る
    assert.ok(String(createShare(env)[0].body.get("path")).endsWith("report-1.pdf"));
});

test("CSRF ヘッダ: トークンがあれば requesttoken と OCS-APIRequest の両方を送る", async () => {
    const { env } = await run();
    for (const call of [put(env)[0], createShare(env)[0]]) {
        assert.equal(call.headers["requesttoken"], "TOKEN123");
        assert.equal(call.headers["OCS-APIRequest"], "true");
    }
});

test("CSRF ヘッダ: トークンが無くても中断せず OCS-APIRequest だけで試す（NC30+）", async () => {
    const { result, env } = await run({ headAttrs: {} });

    assert.equal(result.ok, true, "トークン非依存で実行できること");
    const call = put(env)[0];
    assert.equal(call.headers["OCS-APIRequest"], "true");
    assert.ok(!("requesttoken" in call.headers), "無いトークンを空で送ってはいけない");
});

test("トークン無しで 401 なら NC30 未満である旨を案内する", async () => {
    const { result } = await run({
        headAttrs: {},
        handler: () => ({ status: 401, body: "" }),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /401/);
    assert.match(result.error, /Nextcloud 30/);
});

test("OCS がエラーを返したら（HTTP 200 でも）失敗として扱う", async () => {
    const { result } = await run({
        handler: (call) =>
            call.method === "PUT" && call.url.includes("webdav")
                ? { status: 201, body: "" }
                : ocsFail(403, "Public upload disabled by the administrator"),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Public upload disabled/);
});

test("セッション切れでログイン HTML が返っても JSON パースで落ちない", async () => {
    const { result } = await run({
        handler: (call) =>
            call.method === "PUT" && call.url.includes("webdav")
                ? { status: 201, body: "" }
                : { status: 200, body: "<!DOCTYPE html><html>login</html>" },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /JSON/);
});

test("パスワードも期限も未入力なら共有作成にも含めない", async () => {
    const { result, env } = await run({}, { password: "", expireDate: "" });

    assert.equal(result.ok, true);
    const body = createShare(env)[0].body;
    assert.equal(body.get("password"), null, "空の値を送るとサーバ設定によっては失敗する");
    assert.equal(body.get("expireDate"), null);
    assert.equal(updateShare(env).length, 0);
    assert.equal(result.passwordSet, false);
    assert.equal(result.expireSet, false);
});

test("入力された項目だけを共有作成リクエストに含める", async () => {
    const { env } = await run({}, { password: "secret", expireDate: "" });

    const body = createShare(env)[0].body;
    assert.equal(body.get("password"), "secret");
    assert.equal(body.get("expireDate"), null, "未入力の項目は送らない");
});

test("パスワードが弾かれたら共有リンクを作らずに失敗する（無防備なリンクを残さない）", async () => {
    const { result, env } = await run({
        handler: (call) => {
            if (call.url.endsWith("/status.php")) return { status: 404, body: "" };
            if (call.method === "PUT" && call.url.includes("webdav")) return { status: 201, body: "" };
            return ocsFail(400, "Password policy violated");
        },
    }, { password: "weak" });

    assert.equal(result.ok, false, "保護されていないリンクを作って成功と言ってはいけない");
    assert.match(result.error, /Password policy/);
    assert.match(result.error, /report\.pdf/, "アップロード済みであることを伝える");
    assert.match(result.error, /パスワード/);
    assert.equal(updateShare(env).length, 0);
});

test("ファイル選択をキャンセルしても固まらず cancelled を返す", async () => {
    const { result, env } = await run({ file: null });

    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(env.calls.length, 0, "キャンセル時は通信しない");
});

test("クリップボードが使えなくても処理は成功扱いで URL を返す", async () => {
    const { result } = await run({ clipboard: false });

    assert.equal(result.ok, true);
    assert.equal(result.copied, false);
    assert.equal(result.url, "https://cloud.example.com/s/TOKEN");
});

test("結果は storage.session に保存される（ポップアップが閉じても表示できる）", async () => {
    const { result, env } = await run();

    assert.deepEqual(env.stored.lastResult, result);
});

test("アップロード失敗時は共有を作らない", async () => {
    const { result, env } = await run({
        handler: () => ({ status: 507, body: "" }),
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /507/);
    assert.equal(createShare(env).length, 0);
});

test("webroot: 候補を status.php で検証してから使う（推定を外しても復帰できる）", async () => {
    const { result, env } = await run({
        handler: (call) => {
            // 実体はルート設置。誤検出した候補の下に status.php は無い。
            if (call.url.endsWith("/status.php")) {
                return call.url === "/status.php"
                    ? { status: 200, body: { installed: true, version: "30.0.0.0" } }
                    : { status: 404, body: "not found" };
            }
            if (call.method === "PUT" && call.url.includes("/remote.php/webdav/")) return { status: 201, body: "" };
            if (call.method === "POST") return ocsOk({ id: 1, url: "https://cloud.example.com/s/Z" });
            return ocsOk({ id: 1 });
        },
    }, { webroot: ["/index.php/css", ""] });

    assert.equal(result.ok, true);
    assert.equal(put(env)[0].url, "/remote.php/webdav/report.pdf");
    assert.ok(
        !env.calls.some((c) => c.method === "PUT" && c.url.startsWith("/index.php/css")),
        "検証に失敗した候補へは送らない"
    );
    assert.ok(createShare(env)[0].url.startsWith("/ocs/"), "OCS も確定した webroot を使う");
});

test("webroot: status.php が 200 でも Nextcloud の JSON でなければ採用しない", async () => {
    const { result, env } = await run({
        handler: (call) => {
            if (call.url.endsWith("/status.php")) {
                // 前段のリバースプロキシや別アプリが 200 + HTML を返すことがある
                return call.url === "/status.php"
                    ? { status: 200, body: { installed: true, version: "30.0.0.0" } }
                    : { status: 200, body: "<!DOCTYPE html><html>hello</html>" };
            }
            if (call.method === "PUT" && call.url.includes("/remote.php/webdav/")) return { status: 201, body: "" };
            if (call.method === "POST") return ocsOk({ id: 3, url: "https://cloud.example.com/s/V" });
            return ocsOk({ id: 3 });
        },
    }, { webroot: ["/wrong", ""] });

    assert.equal(result.ok, true);
    assert.equal(put(env)[0].url, "/remote.php/webdav/report.pdf");
});

test("webroot: status.php が使えない環境では先頭候補のまま実行する（従来動作）", async () => {
    const { result, env } = await run({
        handler: (call) => {
            if (call.url.endsWith("/status.php")) return { status: 404, body: "" };
            if (call.method === "PUT" && call.url.includes("/remote.php/webdav/")) return { status: 201, body: "" };
            if (call.method === "POST") return ocsOk({ id: 2, url: "https://cloud.example.com/s/W" });
            return ocsOk({ id: 2 });
        },
    }, { webroot: ["/nextcloud"] });

    assert.equal(result.ok, true);
    assert.equal(put(env)[0].url, "/nextcloud/remote.php/webdav/report.pdf");
});

test("WebDAV でない URL に当たったら 405 の意味と実際の宛先を伝える", async () => {
    const { result } = await run({
        handler: (call) =>
            call.url.endsWith("/status.php") ? { status: 404, body: "" } : { status: 405, body: "" },
    }, { webroot: ["/index.php/apps/files"] });

    assert.equal(result.ok, false);
    assert.match(result.error, /405/);
    assert.match(result.error, /webroot/);
    assert.match(result.error, /\/index\.php\/apps\/files\/remote\.php\/webdav\/report\.pdf/);
});

test("webroot の確定はファイル選択より後（キャンセル時は一切通信しない）", async () => {
    const { result, env } = await run({ file: null }, { webroot: ["/nc", ""] });

    assert.equal(result.cancelled, true);
    assert.equal(env.calls.length, 0);
});
