// ポップアップを素の Web ページで動かすための chrome API スタブ（テスト専用）。
// src/popup.js / src/uploader.js には一切手を入れず、拡張機能 API だけを差し替える。
//
// シナリオは URL のクエリで切り替える:
//   ?scenario=ok       登録済みの Nextcloud（既定）
//   ?scenario=unknown  未登録 & requesttoken 無し（警告付き登録フロー）
//   ?scenario=public   登録済みだが公開共有ページ（loggedIn=false）
//   ?scenario=fresh    登録済みサイトが 1 件も無い状態

const SCENARIO = new URLSearchParams(location.search).get("scenario") || "ok";

const DETECTIONS = {
    ok: { origin: "https://cloud.example.com", hasToken: true, loggedIn: true, user: "alice", webroot: "" },
    unknown: { origin: "https://unknown.example.org", hasToken: false, loggedIn: false, user: null, webroot: "" },
    public: { origin: "https://cloud.example.com", hasToken: true, loggedIn: false, user: null, webroot: "" },
    fresh: { origin: "https://cloud.example.com", hasToken: true, loggedIn: true, user: "alice", webroot: "" },
};

const _store = {
    sync: {
        knownOrigins: SCENARIO === "fresh"
            ? []
            : ["https://cloud.example.com", "https://nc.test.local"],
    },
    local: {},
    session: {
        // 「ポップアップが閉じたあと次回開いたときの表示」を再現する
        lastResult: SCENARIO === "ok" ? {
            ok: true,
            url: "https://cloud.example.com/s/AbCdEf123",
            name: "報告書 2026.pdf",
            renamed: true,
            copied: false,
            settingsError: null,
            passwordSet: true,
            expireSet: true,
        } : undefined,
    },
};

const area = (name) => ({
    get: async (key) => {
        const out = {};
        if (typeof key === "string" && _store[name][key] !== undefined) out[key] = _store[name][key];
        console.log(`[stub] ${name}.get(${key}) ->`, JSON.stringify(out));
        return out;
    },
    set: async (obj) => {
        Object.assign(_store[name], obj);
        console.log(`[stub] ${name}.set`, JSON.stringify(obj));
    },
    remove: async (key) => {
        delete _store[name][key];
        console.log(`[stub] ${name}.remove(${key})`);
    },
    setAccessLevel: async (opts) => {
        console.log(`[stub] ${name}.setAccessLevel`, JSON.stringify(opts));
    },
});

window.chrome = {
    // 一覧更新の依頼先（実際は background.js）。ポップアップは使わないが、
    // 注入コードと同じ形を置いておく。
    runtime: {
        id: "stub",
        sendMessage: async (message) => {
            console.log("[stub] sendMessage:", JSON.stringify(message));
            return { ok: true };
        },
    },
    storage: { sync: area("sync"), local: area("local"), session: area("session") },
    tabs: {
        query: async () => [{ id: 1, url: DETECTIONS[SCENARIO].origin + "/apps/files" }],
    },
    scripting: {
        executeScript: async ({ func, args }) => {
            console.log("[stub] executeScript:", func.name, JSON.stringify(args || []));

            if (func.name === "detectNextcloud") {
                return [{ result: DETECTIONS[SCENARIO] }];
            }

            // 実際の通信はしない。成功時の表示を確認するためのダミー結果を返す。
            const [, password, expireDate] = args;
            return [{
                result: {
                    ok: true,
                    url: DETECTIONS[SCENARIO].origin + "/s/StubShare123",
                    name: "example.pdf",
                    renamed: false,
                    copied: false,
                    settingsError: null,
                    passwordSet: !!password,
                    expireSet: !!expireDate,
                    refresh: "list", // ページ内で一覧を更新できた場合の表示
                },
            }];
        },
    },
};

console.log("[stub] scenario =", SCENARIO);
