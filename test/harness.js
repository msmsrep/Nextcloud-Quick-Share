"use strict";

// src/uploader.js を「実物のまま」Node 上で動かすためのテスト用ハーネス。
//
// uploader.js は拡張機能のビルド無しでページへ注入される素のスクリプトなので、
// require もできず export も持たない。そこでファイルを読み込んで new Function で
// 包み、ブラウザのグローバル（document / location / fetch など）を引数として
// 渡す。こうするとテスト対象は本番と同じソースのまま、グローバルを汚さずに
// 差し替えられる。

const fs = require("node:fs");
const path = require("node:path");

const UPLOADER_PATH = path.join(__dirname, "..", "src", "uploader.js");

/** uploader.js を読み込み、env のフェイクを注入した関数を返す。 */
function loadUploader(env) {
    const source = fs.readFileSync(UPLOADER_PATH, "utf8");
    const factory = new Function(
        "document", "location", "window", "navigator", "chrome", "fetch", "setTimeout",
        source + "\n;return { detectNextcloud, runUpload };"
    );
    return factory(
        env.document, env.location, env.window,
        env.navigator, env.chrome, env.fetch, env.setTimeout
    );
}

/** 最低限の DOM 要素もどき。 */
function makeElement(tag, attrs = {}) {
    return {
        tagName: String(tag).toUpperCase(),
        attrs: Object.assign({}, attrs),
        style: { cssText: "" },
        children: [],
        listeners: {},
        files: [],
        textContent: "",
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
        },
        setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener() {},
        dispatch(type) { for (const fn of this.listeners[type] || []) fn(); },
        appendChild(child) { this.children.push(child); return child; },
        remove() { this.removed = true; },
        click() {},
    };
}

/** File もどき。arrayBuffer() だけあれば uploader は動く。 */
function makeFile(name, type = "text/plain", contents = "hello") {
    const bytes = Buffer.from(contents, "utf8");
    return {
        name,
        type,
        size: bytes.length,
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); },
    };
}

/** OCS API の成功レスポンスを組み立てる。 */
function ocsOk(data) {
    return { status: 200, body: { ocs: { meta: { status: "ok", statuscode: 200, message: "OK" }, data } } };
}

/** OCS API の失敗レスポンスを組み立てる。HTTP は 200 のままなのが OCS の仕様。 */
function ocsFail(statuscode, message) {
    return { status: 200, body: { ocs: { meta: { status: "failure", statuscode, message }, data: [] } } };
}

/**
 * フェイク環境を作る。
 *
 * opts:
 *   headAttrs  <head> の属性
 *   assets     webroot 推定に使う script/link の src/href
 *   origin, pathname
 *   file       ファイル選択の結果（null ならキャンセル扱い）
 *   handler    (call, calls) => { status, body }  fetch の応答を決める
 *   clipboard  false にすると writeText を失敗させる
 */
function makeEnv(opts = {}) {
    const calls = [];
    const timeouts = [];
    const stored = {};

    const origin = opts.origin ?? "https://cloud.example.com";
    const pathname = opts.pathname ?? "/apps/files";

    const head = makeElement("head", opts.headAttrs ?? {
        "data-requesttoken": "TOKEN123",
        "data-user": "alice",
    });
    const body = makeElement("body");

    const assetElements = (opts.assets ?? []).map((a) =>
        typeof a === "string"
            ? makeElement("script", { src: a })
            : makeElement(a.tag ?? "script", a.href ? { href: a.href } : { src: a.src })
    );

    const file = opts.file === undefined ? makeFile("report.pdf", "application/pdf") : opts.file;

    const document = {
        head,
        body,
        createElement(tag) {
            const el = makeElement(tag);
            if (String(tag).toLowerCase() === "input") {
                // ファイル選択ダイアログの代わり。click() で change / cancel を発火する。
                el.click = () => {
                    queueMicrotask(() => {
                        if (file === null) {
                            el.dispatch("cancel");
                        } else {
                            el.files = [file];
                            el.dispatch("change");
                        }
                    });
                };
            }
            return el;
        },
        querySelectorAll() { return assetElements; },
    };

    const defaultHandler = (call) => {
        // webroot の実在確認。既定では「どの webroot でも Nextcloud がいる」ことにする。
        if (call.url.endsWith("/status.php")) {
            return { status: 200, body: { installed: true, version: "30.0.0.0", productname: "Nextcloud" } };
        }
        if (call.method === "PUT" && call.url.includes("/remote.php/webdav/")) {
            return { status: 201, body: "" };
        }
        if (call.method === "POST" && call.url.includes("/shares")) {
            return ocsOk({ id: 42, url: origin + "/s/TOKEN" });
        }
        if (call.method === "PUT" && call.url.includes("/shares/")) {
            return ocsOk({ id: 42 });
        }
        return { status: 404, body: "not found" };
    };

    const handler = opts.handler ?? defaultHandler;

    const env = {
        calls,
        timeouts,
        stored,
        makeFile,
        ocsOk,
        ocsFail,
        defaultHandler,

        document,
        location: { origin, pathname, href: origin + pathname },
        window: { addEventListener() {} },
        navigator: {
            clipboard: {
                async writeText(text) {
                    if (opts.clipboard === false) throw new Error("Document is not focused");
                    env.copied = text;
                },
            },
        },
        chrome: {
            storage: {
                session: { async set(obj) { Object.assign(stored, obj); } },
            },
        },
        // 実際には待たない。toast の後片付けタイマーでテストが止まらないようにする。
        setTimeout(fn, ms) { timeouts.push({ fn, ms }); return timeouts.length; },

        async fetch(url, init = {}) {
            const call = {
                url,
                method: init.method || "GET",
                headers: init.headers || {},
                body: init.body,
            };
            calls.push(call);
            const res = handler(call, calls) ?? { status: 500, body: "" };
            return {
                status: res.status,
                async text() {
                    return typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? {});
                },
            };
        },
    };

    return env;
}

/** 指定メソッド・URL 部分一致の fetch 呼び出しを取り出す。 */
function callsMatching(env, method, fragment) {
    return env.calls.filter((c) => c.method === method && c.url.includes(fragment));
}

module.exports = { loadUploader, makeEnv, makeElement, makeFile, ocsOk, ocsFail, callsMatching };
