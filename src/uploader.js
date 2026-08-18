// このファイルで定義する関数は chrome.scripting.executeScript の `func` として
// ページへ注入される。注入時に Function.prototype.toString() で文字列化されるため、
// 外側のスコープ（他の関数・定数・import）を一切参照できない。
// 依存するヘルパは必ず runUpload の内側に入れ子で定義すること。

/**
 * ページの素性を調べて返す。判定は行うが、ここでは何もブロックしない。
 * 続行するかどうかはポップアップ側（ユーザーの明示的な承認）が決める。
 *
 * 注意: これは UX 上のガードであってセキュリティ境界ではない。
 * 任意のサイトが data-requesttoken を名乗れるので、実際の保護は
 * ポップアップ側のオリジン許可リストが担う。
 */
function detectNextcloud() {
    const head = document.head;
    if (!head) {
        return { origin: location.origin, hasToken: false, loggedIn: false, user: null, webroot: "" };
    }

    // core/templates/layout.*.php が出力する属性。全レイアウトにあるため
    // 「Nextcloud らしさ」の目安になる。公式の @nextcloud/auth も同じ場所を読む。
    const token = head.getAttribute("data-requesttoken");

    // data-user はログイン済みレイアウト (layout.user.php) にしか無い。
    // 無い場合は公開共有ページ / ログイン画面の可能性が高い。
    const user = head.getAttribute("data-user");

    // webroot（サブディレクトリ設置）の解決。
    // head に data-webroot は存在しないため、DOM から推定する。
    const resolveWebroot = () => {
        // 旧 Nextcloud / ownCloud は head に持っていることがある
        const attr = head.getAttribute("data-webroot");
        if (attr !== null) return attr.replace(/\/$/, "");

        // Nextcloud のアセットは {webroot}/dist/, /core/, /apps/ 配下から読まれる
        const assets = document.querySelectorAll('script[src], link[rel="stylesheet"][href]');
        for (const el of assets) {
            const raw = el.getAttribute("src") || el.getAttribute("href");
            if (!raw) continue;
            let path;
            try {
                const u = new URL(raw, location.href);
                if (u.origin !== location.origin) continue;
                path = u.pathname;
            } catch { continue; }
            const m = path.match(/^(.*?)\/(?:dist|core|apps)\//);
            if (!m) continue;
            // テーマ CSS などは {webroot}/index.php/apps/... で配信されることがある
            return m[1].replace(/\/index\.php$/, "");
        }

        // index.php 経由の URL ならその手前が webroot
        const idx = location.pathname.indexOf("/index.php/");
        if (idx >= 0) return location.pathname.slice(0, idx);

        return "";
    };

    return {
        origin: location.origin,
        hasToken: !!token,
        loggedIn: !!user,
        user: user || null,
        webroot: resolveWebroot(),
    };
}

/**
 * アップロード〜共有リンク作成〜設定反映までの本処理。
 * 例外は投げずに { ok, ... } を返す（executeScript の戻り値は構造化クローン可能な値のみ）。
 */
function runUpload(webroot, password, expireDate) {
    return (async () => {
        // トークンは実行直前に読み直す（セッション更新で差し替わることがある）。
        // 無い場合も中断しない。NC 30+ なら OCS-APIRequest ヘッダだけで
        // CSRF チェックを通過できるため、まず試して結果で判断する。
        const head = document.head;
        const token = (head && head.getAttribute("data-requesttoken")) || null;

        // 認証系ヘッダ。トークンがあれば添え、無ければヘッダのみで試す。
        const authHeaders = () => {
            const h = { "OCS-APIRequest": "true" };
            if (token) h["requesttoken"] = token;
            return h;
        };

        // --- ファイル選択 ---------------------------------------------------
        // change だけでは「キャンセル」時に解決されず処理が止まったままになるため、
        // cancel イベントと window の focus 復帰の両方をフォールバックに使う。
        const pickFile = () => new Promise((resolve) => {
            const input = document.createElement("input");
            input.type = "file";
            input.style.display = "none";
            let settled = false;
            const finish = (file) => {
                if (settled) return;
                settled = true;
                input.remove();
                resolve(file);
            };
            input.addEventListener("change", () => finish(input.files[0] || null), { once: true });
            input.addEventListener("cancel", () => finish(null), { once: true });
            document.body.appendChild(input);
            input.click();
            // cancel 非対応環境向けの保険。ダイアログが閉じてもファイルが
            // 選ばれていなければキャンセルとみなす。
            window.addEventListener("focus", () => {
                setTimeout(() => { if (!input.files.length) finish(null); }, 1000);
            }, { once: true });
        });

        // --- 共通ユーティリティ ---------------------------------------------
        const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

        const addSuffix = (name, n) => {
            const dot = name.lastIndexOf(".");
            return dot > 0
                ? name.slice(0, dot) + "-" + n + name.slice(dot)
                : name + "-" + n;
        };

        const httpError = (status) => {
            if (status === 401 && !token) {
                return "認証エラー (401)。requesttoken の無いページから実行したため、"
                    + "CSRF チェックに通りませんでした（トークン無しで通るのは Nextcloud 30 以降のみです）。"
                    + "ログイン済みの Nextcloud 画面で実行してください。";
            }
            if (status === 401) return "認証エラー (401)。Nextcloud にログインし直してください。";
            if (status === 403) return "権限がありません (403)。";
            if (status === 507) return "サーバの空き容量が不足しています (507)。";
            return "HTTP " + status;
        };

        // OCS API は失敗時も HTTP 200 を返し、ocs.meta.statuscode にエラーを入れる。
        // セッション切れではログイン画面の HTML が返るため JSON パースも保護する。
        const ocsFetch = async (path, init) => {
            const options = Object.assign({ credentials: "include" }, init);
            options.headers = Object.assign(
                { "Accept": "application/json" },
                authHeaders(),
                (init && init.headers) || {}
            );

            const res = await fetch(webroot + path, options);
            const text = await res.text();
            let json;
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error("API が JSON を返しませんでした (" + httpError(res.status) + ")。ログイン状態を確認してください。");
            }
            const meta = json && json.ocs && json.ocs.meta;
            // OCS v1 は 100、v2 は 200 が成功を表す。
            if (!meta || (meta.statuscode !== 100 && meta.statuscode !== 200)) {
                throw new Error((meta && meta.message) || "API エラー (statuscode " + (meta ? meta.statuscode : "?") + ")");
            }
            return json.ocs.data;
        };

        // --- 1) WebDAV へアップロード ---------------------------------------
        // If-None-Match: * で既存ファイルの無言上書きを防ぎ、412 が返ったら
        // 連番を付けて再試行する。
        const putFile = async (file, buffer) => {
            const base = webroot + "/remote.php/webdav/";
            for (let i = 0; i < 20; i++) {
                const name = i === 0 ? file.name : addSuffix(file.name, i);
                const res = await fetch(base + encodePath(name), {
                    method: "PUT",
                    credentials: "include",
                    // NC 30+ の passesCSRFCheck() は OCS-APIRequest があれば
                    // トークン無しでも通る（CORS セーフリスト外のヘッダなので
                    // クロスオリジンからは付けられない = それ自体が CSRF 防御）。
                    // NC 30 未満では効かないため requesttoken も併せて送る。
                    headers: Object.assign({
                        "Content-Type": file.type || "application/octet-stream",
                        "If-None-Match": "*",
                    }, authHeaders()),
                    body: buffer,
                });
                if (res.status === 200 || res.status === 201 || res.status === 204) return name;
                if (res.status === 412) continue; // 同名ファイルあり → 別名で再試行
                throw new Error("アップロードに失敗しました: " + httpError(res.status));
            }
            throw new Error("同名ファイルが多すぎるため、別名を決められませんでした。");
        };

        // --- 2) 公開共有リンクを作成 -----------------------------------------
        const createShare = (remoteName) => {
            const form = new FormData();
            form.append("path", "/" + remoteName);
            form.append("shareType", "3");   // public link
            form.append("permissions", "1"); // read only
            return ocsFetch("/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json", {
                method: "POST",
                body: form,
            });
        };

        // --- 3) パスワード / 有効期限を設定 ----------------------------------
        // 空欄の項目は送らない（空文字を送るとサーバ設定によってはエラーになる）。
        const updateShare = (shareId) => {
            const params = new URLSearchParams();
            if (password) params.set("password", password);
            if (expireDate) params.set("expireDate", expireDate);
            if (Array.from(params.keys()).length === 0) return null;
            return ocsFetch("/ocs/v2.php/apps/files_sharing/api/v1/shares/" + encodeURIComponent(shareId) + "?format=json", {
                method: "PUT",
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body: params.toString(),
            });
        };

        // --- 画面右上の通知（alert の置き換え） -------------------------------
        const toast = (message, url) => {
            const box = document.createElement("div");
            box.style.cssText = "position:fixed;top:20px;right:20px;z-index:2147483647;max-width:360px;" +
                "padding:12px 14px;background:#fff;color:#222;border:1px solid #d0d0d0;border-radius:8px;" +
                "box-shadow:0 4px 16px rgba(0,0,0,.2);font:13px/1.5 sans-serif;word-break:break-all;";
            const line = document.createElement("div");
            line.textContent = message;
            box.appendChild(line);
            if (url) {
                const a = document.createElement("a");
                a.href = url;
                a.textContent = url;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.style.cssText = "display:block;margin-top:6px;color:#0078d4;";
                box.appendChild(a);
            }
            document.body.appendChild(box);
            setTimeout(() => box.remove(), 15000);
        };

        // ファイル選択ダイアログを開いた時点でポップアップは閉じ、executeScript の
        // 戻り値を受け取れなくなる。結果を残して次回起動時に表示できるようにする。
        // 共有URLを含むためディスクには書かず、ブラウザ終了で消える session を使う
        // （書き込みはポップアップ側の setAccessLevel で許可されている）。
        const remember = async (result) => {
            try {
                await chrome.storage.session.set({ lastResult: result });
            } catch { /* 保存できなくてもトーストで伝わる */ }
            return result;
        };

        // --- 実行 -------------------------------------------------------------
        try {
            const file = await pickFile();
            if (!file) return { ok: false, cancelled: true };

            const remoteName = await putFile(file, await file.arrayBuffer());
            const share = await createShare(remoteName);
            const shareUrl = share.url;

            let settingsError = null;
            try {
                await updateShare(share.id);
            } catch (e) {
                // 共有自体は作成済み。パスワード未設定のまま「完了」と伝えないよう記録する。
                settingsError = e && e.message ? e.message : String(e);
            }

            let copied = false;
            try {
                // ポップアップにフォーカスがあると失敗するため、成否を呼び出し元へ返す。
                await navigator.clipboard.writeText(shareUrl);
                copied = true;
            } catch { /* コピー失敗はリンク表示でフォローする */ }

            toast(
                settingsError
                    ? "共有リンクは作成しましたが、設定の反映に失敗しました: " + settingsError
                    : (copied ? "共有リンクをコピーしました" : "共有リンクを作成しました"),
                shareUrl
            );

            return remember({
                ok: true,
                url: shareUrl,
                name: remoteName,
                renamed: remoteName !== file.name,
                copied,
                settingsError,
                passwordSet: !!password && !settingsError,
                expireSet: !!expireDate && !settingsError,
            });
        } catch (e) {
            const message = e && e.message ? e.message : String(e);
            toast("エラー: " + message);
            return remember({ ok: false, error: message });
        }
    })();
}
