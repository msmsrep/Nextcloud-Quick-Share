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
        return {
            origin: location.origin, hasToken: false, loggedIn: false, user: null,
            webroot: "", webrootCandidates: [""],
        };
    }

    // core/templates/layout.*.php が出力する属性。全レイアウトにあるため
    // 「Nextcloud らしさ」の目安になる。公式の @nextcloud/auth も同じ場所を読む。
    const token = head.getAttribute("data-requesttoken");

    // data-user はログイン済みレイアウト (layout.user.php) にしか無い。
    // 無い場合は公開共有ページ / ログイン画面の可能性が高い。
    const user = head.getAttribute("data-user");

    // webroot（サブディレクトリ設置）の解決。
    // head に data-webroot は無いことが多いので DOM と URL から推定するが、
    // 1 つに決め打ちすると外したときに見当違いの URL へ PUT してしまう
    // （例: {webroot}/index.php/css/core/... を読んで webroot を
    // 「/index.php/css」と誤認する）。ここでは候補を確度順に並べるだけにして、
    // 実際に使う 1 つは runUpload が status.php で確かめてから決める。

    // webroot の直下に生える Nextcloud のパス。アセットもページの URL も必ず
    // このいずれかで始まるので、最初に現れた位置の手前が webroot になる。
    const NC_ENTRY = /\/(?:index\.php|remote\.php|status\.php|public\.php|cron\.php|ocs|ocs-provider|dist|core|apps|css|js|settings|login|logout|s|f|u|call)(?:\/|$)/;

    const cutAtEntry = (path) => {
        const m = NC_ENTRY.exec(path);
        return m ? path.slice(0, m.index) : null;
    };

    const candidates = [];
    const addCandidate = (value) => {
        if (value === null || value === undefined) return;
        const root = String(value).replace(/\/+$/, "");
        if (!candidates.includes(root)) candidates.push(root);
    };

    // 1) 旧 Nextcloud / ownCloud は head に持っていることがある
    addCandidate(head.getAttribute("data-webroot"));

    // 2) Nextcloud のアセットは webroot 直下から配信される
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
        addCandidate(cutAtEntry(path));
    }

    // 3) 今開いているページ自身の URL
    addCandidate(cutAtEntry(location.pathname));

    // 4) 最後の砦。ルート設置が最も多い。
    addCandidate("");

    return {
        origin: location.origin,
        hasToken: !!token,
        loggedIn: !!user,
        user: user || null,
        // 従来どおりの単一値（最有力候補）。実際の決定は runUpload 側で行う。
        webroot: candidates[0],
        webrootCandidates: candidates,
    };
}

/**
 * アップロード〜共有リンク作成〜設定反映までの本処理。
 * 例外は投げずに { ok, ... } を返す（executeScript の戻り値は構造化クローン可能な値のみ）。
 */
function runUpload(webrootCandidates, password, expireDate) {
    return (async () => {
        // ポップアップからは webroot の候補が確度順の配列で渡る。
        // 文字列で渡された場合（旧シグネチャ）も受け付ける。
        const roots = Array.isArray(webrootCandidates)
            ? webrootCandidates.slice()
            : [webrootCandidates || ""];
        if (!roots.includes("")) roots.push(""); // ルート設置は常に最後の砦
        // 確定前の暫定値。resolveWebroot() が実際に使う値へ差し替える。
        let webroot = roots[0];
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
            if (status === 400) return "リクエストを受け付けてもらえませんでした (400)。";
            if (status === 507) return "サーバの空き容量が不足しています (507)。";
            if (status === 404 || status === 405) {
                return "URL が Nextcloud の WebDAV ではありませんでした (" + status + ")。"
                    + "インストール先（webroot）を特定できていない可能性があります。";
            }
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

        // --- 0) webroot の確定 ------------------------------------------------
        // 候補は DOM からの推定なので外すことがある。誤った webroot のまま PUT すると
        // 見当違いの URL（例: /index.php/css/remote.php/webdav/...）へ飛んで
        // 404 / 405 になるため、送信前に status.php で実在を確かめる。
        // status.php は未ログインでも JSON を返す Nextcloud の素性表明エンドポイント。
        const isNextcloudRoot = async (root) => {
            let res;
            try {
                res = await fetch(root + "/status.php", {
                    credentials: "omit", // 素性確認だけなので Cookie は送らない
                    headers: { "Accept": "application/json" },
                });
            } catch { return false; }
            if (res.status !== 200) return false;
            let json;
            try {
                json = JSON.parse(await res.text());
            } catch { return false; } // 別アプリの 200 や SPA の index.html を弾く
            if (!json || typeof json !== "object") return false;
            return json.installed !== undefined || typeof json.version === "string";
        };

        const resolveWebroot = async () => {
            for (const root of roots) {
                if (await isNextcloudRoot(root)) return root;
            }
            // status.php を塞いでいる環境もある。その場合は最有力候補のまま進む。
            return roots[0];
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
                throw new Error("アップロードに失敗しました: " + httpError(res.status)
                    + "\n宛先: " + base + encodePath(name));
            }
            throw new Error("同名ファイルが多すぎるため、別名を決められませんでした。");
        };

        // --- 2) 公開共有リンクを作成（パスワード / 有効期限もここで渡す）-------
        // 作成してから PUT /shares/{id} で後追い設定はしない。理由は 2 つある。
        //
        // 1. 後追いだと「無防備な公開リンクが実在する瞬間」ができてしまう。
        // 2. OCS の PUT は本文が x-www-form-urlencoded のときだけパラメータとして
        //    読まれるが、Nextcloud の Request は Content-Type を完全一致で見る
        //    実装があり、"; charset=UTF-8" を添えただけで本文が無視される。
        //    その結果「更新する項目が無い」と判断されて 400 になる。
        //    作成時の POST(multipart) なら PHP が普通に解釈するので踏まない。
        //
        // 空欄の項目は送らない（空文字を送るとサーバ設定によってはエラーになる）。
        const createShare = (remoteName) => {
            const form = new FormData();
            form.append("path", "/" + remoteName);
            form.append("shareType", "3");   // public link
            form.append("permissions", "1"); // read only
            if (password) form.append("password", password);
            if (expireDate) form.append("expireDate", expireDate);
            return ocsFetch("/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json", {
                method: "POST",
                body: form,
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
            return box;
        };

        // --- アップロード後の一覧更新 -----------------------------------------
        // サイト UI でアップロードしたときと同じように、ページの一覧にも今置いた
        // ファイルを出したい。手段は 2 段構え。
        //
        // 1) ページ内更新: OCA.Files.App.fileList.reload() を呼ぶ。ただしこの
        //    コードは isolated world で動くのでページ側の JS には触れられない。
        //    MAIN world へ注入できる chrome.scripting はサービスワーカーにしか
        //    無いため、background.js に依頼する（ポップアップはもう閉じている）。
        // 2) 駄目なら再読み込み: 新しい Files アプリ（NC 28 以降）のように
        //    fileList が無い作りでも、ページごと読み込み直せば一覧は最新になる。

        // 表示中のフォルダ。新旧どちらの Files アプリも ?dir= に入れている。
        // 省略時（NC 28+ の /apps/files/files/{fileid} など）はルート扱い。
        const currentDir = () => {
            const dir = new URLSearchParams(location.search || "").get("dir");
            return dir ? dir : "/";
        };

        // 置き場所は常に WebDAV のルート直下なので、別フォルダを開いている画面を
        // 読み込み直しても見た目は変わらない。無駄な再読み込みはしない。
        const listShowsUpload = () =>
            location.pathname.includes("/apps/files") && currentDir() === "/";

        // 1) ページ内更新の依頼。SW が居ない / 旧 Files アプリでない場合は false。
        const refreshInPage = async () => {
            try {
                const res = await chrome.runtime.sendMessage({ type: "refreshFileList" });
                return !!(res && res.ok);
            } catch {
                return false; // 受け手が居ないときは例外になる
            }
        };

        // 2) 予告してから再読み込みする。共有 URL を載せたトーストごと消えるため、
        // 読む時間を取り、ユーザーが止められるようにする（URL はクリップボードと
        // ポップアップ側の storage.session にも残るので、消えても失われない）。
        const scheduleReload = (box, seconds) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:8px;color:#555;";

            const label = document.createElement("span");
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = "更新しない";
            cancel.style.cssText = "font:inherit;padding:2px 8px;cursor:pointer;";

            let left = seconds;
            let stopped = false;
            // clearTimeout に頼らずフラグで止める（タイマー ID を持ち回らない）。
            const tick = () => {
                if (stopped) return;
                if (left <= 0) { location.reload(); return; }
                label.textContent = "一覧を更新します（" + left + "）";
                left -= 1;
                setTimeout(tick, 1000);
            };
            cancel.addEventListener("click", () => { stopped = true; row.remove(); });

            row.appendChild(label);
            row.appendChild(cancel);
            box.appendChild(row);
            tick();
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

            // 通信はここから。キャンセル時に status.php も叩かないよう順序を守る。
            webroot = await resolveWebroot();

            const remoteName = await putFile(file, await file.arrayBuffer());

            let share;
            try {
                share = await createShare(remoteName);
            } catch (e) {
                // ここで失敗しても公開リンクは 1 つも作られていない（安全側）。
                // ただしファイルは既に置かれているので、それは正直に伝える。
                const detail = (e && e.message) ? e.message : String(e);
                throw new Error(
                    "「" + remoteName + "」のアップロードは成功しましたが、共有リンクを作成できませんでした: " + detail
                    + ((password || expireDate)
                        ? "\nパスワード / 有効期限がサーバの設定（パスワードポリシーや期限の上限）に"
                          + "合わない可能性があります。空欄にして試すと切り分けられます。"
                        : "")
                );
            }
            const shareUrl = share.url;

            let copied = false;
            try {
                // ポップアップにフォーカスがあると失敗するため、成否を呼び出し元へ返す。
                await navigator.clipboard.writeText(shareUrl);
                copied = true;
            } catch { /* コピー失敗はリンク表示でフォローする */ }

            const box = toast(copied ? "共有リンクをコピーしました" : "共有リンクを作成しました", shareUrl);

            // 追加したファイルが載るはずの画面なら、サイト UI と同じく最新化する。
            // ページ内で更新できたなら再読み込みはしない（共有 URL の通知も残る）。
            let refresh = "none";
            if (listShowsUpload()) {
                if (await refreshInPage()) {
                    refresh = "list";
                } else {
                    refresh = "reload";
                    scheduleReload(box, 5);
                }
            }

            return remember({
                ok: true,
                url: shareUrl,
                name: remoteName,
                renamed: remoteName !== file.name,
                copied,
                // 作成時に一緒に渡しているので、共有が作れた = 設定も入っている。
                passwordSet: !!password,
                expireSet: !!expireDate,
                refresh, // "list"（ページ内更新） / "reload"（再読み込み） / "none"
            });
        } catch (e) {
            const message = e && e.message ? e.message : String(e);
            toast("エラー: " + message);
            return remember({ ok: false, error: message });
        }
    })();
}
