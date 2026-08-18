// ポップアップ側の制御。
// 実際の処理はユーザーがアイコンを押したタブにだけ、その瞬間だけ注入する
// （activeTab）。全サイトへの常時注入は行わない。

const $ = (id) => document.getElementById(id);

// 実行結果（共有URLを含む）はディスクに残さず storage.session に置く。
// 注入したスクリプトは content script 扱い = untrusted context なので、
// 既定では session に書けない。注入より前にアクセスレベルを開けておく。
const sessionReady = chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch(() => { /* 未対応環境でも本処理は続行する */ });

const setStatus = (text, kind) => {
    const el = $("status");
    el.textContent = text;
    el.className = kind || "";
};

const showShareUrl = (url) => {
    $("shareUrl").value = url;
    $("result").style.display = "block";
};

// 初回のオリジンは「もう一度押す」ことで明示的に信頼させる。
// （window.confirm はポップアップを閉じてしまうため使わない）
let pendingTrust = null;

// 登録済みオリジンの一覧を描画する。
// 値は storage 由来なので textContent で入れる（innerHTML は使わない）。
const renderOrigins = async () => {
    const { knownOrigins = [] } = await chrome.storage.sync.get("knownOrigins");
    const list = $("originList");
    list.textContent = "";
    $("origins").style.display = knownOrigins.length ? "block" : "none";

    for (const origin of knownOrigins) {
        const li = document.createElement("li");

        const label = document.createElement("span");
        label.textContent = origin;
        li.appendChild(label);

        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "削除";
        del.title = origin + " の登録を解除";
        del.addEventListener("click", async () => {
            const { knownOrigins: current = [] } = await chrome.storage.sync.get("knownOrigins");
            await chrome.storage.sync.set({
                knownOrigins: current.filter((o) => o !== origin),
            });
            // 削除直後に同じサイトで実行した場合、再度の承認を求める
            if (pendingTrust === origin) resetTrustPrompt();
            setStatus("登録を解除しました: " + origin);
            renderOrigins();
        });
        li.appendChild(del);

        list.appendChild(li);
    }
};

const resetTrustPrompt = () => {
    pendingTrust = null;
    $("runBtn").textContent = "アップロードする";
};

const describeResult = (res) => {
    if (!res) {
        setStatus("結果を取得できませんでした。", "error");
        return;
    }
    if (res.cancelled) {
        setStatus("キャンセルしました。");
        return;
    }
    if (!res.ok) {
        setStatus(res.error || "失敗しました。", "error");
        return;
    }

    const lines = [];
    if (res.renamed) lines.push(`同名ファイルがあったため "${res.name}" として保存しました。`);
    if (res.settingsError) {
        lines.push("警告: パスワード / 有効期限を設定できませんでした。");
        lines.push(res.settingsError);
        lines.push("リンクは保護されていません。Nextcloud 側で設定を確認してください。");
        setStatus(lines.join("\n"), "error");
    } else {
        lines.push("アップロードと共有設定が完了しました。");
        if (res.passwordSet) lines.push("・パスワード設定済み");
        if (res.expireSet) lines.push("・有効期限設定済み");
        lines.push(res.copied ? "・共有URLをコピーしました" : "・下のボタンでURLをコピーできます");
        setStatus(lines.join("\n"), "ok");
    }
    if (res.url) showShareUrl(res.url);
};

$("runBtn").addEventListener("click", async () => {
    const password = $("password").value;
    const expireDate = $("expireDate").value;

    $("result").style.display = "none";
    setStatus("ページを確認しています…");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
        setStatus("対象のタブを取得できませんでした。", "error");
        return;
    }

    // 1) まず検出だけを注入する。ここではパスワードを渡さない。
    let detected;
    try {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, // 既定でトップフレームのみ = iframe には配信されない
            func: detectNextcloud,
        });
        detected = injection.result;
    } catch (e) {
        setStatus("このページでは実行できません。\n" + e.message, "error");
        return;
    }

    if (!detected) {
        resetTrustPrompt();
        setStatus("ページの情報を取得できませんでした。", "error");
        return;
    }

    // 判定結果は「警告」であって中断理由ではない。Nextcloud らしくないページでも
    // ユーザーが明示的に承認すれば実行できる（NC 30+ ならトークン無しでも通る）。
    const warnings = [];
    if (!detected.hasToken) {
        warnings.push("requesttoken が見つかりません。Nextcloud のページではない可能性があります。");
        warnings.push("Nextcloud 30 未満ではトークンが必須のため、この状態では失敗します。");
    } else if (!detected.loggedIn) {
        warnings.push("ログイン済みの画面ではないようです（公開共有ページ / ログイン画面）。");
    }

    // 2) 未登録のオリジンなら、パスワードを渡す前に明示的な確認を挟む。
    const { knownOrigins = [] } = await chrome.storage.sync.get("knownOrigins");
    if (!knownOrigins.includes(detected.origin)) {
        if (pendingTrust !== detected.origin) {
            pendingTrust = detected.origin;
            $("runBtn").textContent = warnings.length
                ? "警告を承知で登録して続行"
                : "このサイトを信頼して続行";
            setStatus(
                [detected.origin, "は未登録のサイトです。自分の Nextcloud であることを確認してから、もう一度押してください。"]
                    .concat(warnings.length ? [""].concat(warnings) : [])
                    .join("\n"),
                "error"
            );
            return;
        }
        await chrome.storage.sync.set({ knownOrigins: knownOrigins.concat(detected.origin) });
        renderOrigins();
    } else if (warnings.length) {
        // 登録済みオリジンなら中断しない。失敗する可能性だけ伝えて続行する。
        setStatus(warnings.join("\n"), "error");
    }
    resetTrustPrompt();

    // 3) 確認できたタブにだけ本処理を注入する。
    setStatus("ファイルを選択してください…");
    await sessionReady; // 注入先が結果を書き戻せる状態にしてから実行する
    try {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: runUpload,
            args: [detected.webroot, password, expireDate],
        });
        describeResult(injection.result);
    } catch (e) {
        // ファイル選択ダイアログを開いた時点でポップアップが閉じることがある。
        // その場合の結果は次回起動時に storage 経由で表示する。
        setStatus("実行に失敗しました。\n" + e.message, "error");
    }
});

$("copyBtn").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText($("shareUrl").value);
        setStatus("共有URLをコピーしました。", "ok");
    } catch (e) {
        $("shareUrl").select();
        setStatus("コピーできませんでした。手動でコピーしてください。", "error");
    }
});

(async function init() {
    // 過去日は Nextcloud 側で拒否されるため、明日以降しか選べないようにする。
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    $("expireDate").min = tomorrow.toISOString().slice(0, 10);

    renderOrigins();

    // v1.1 では storage.local に置いていた。ディスク上の残骸を掃除する。
    chrome.storage.local.remove("lastResult");

    // ファイル選択ダイアログを開くとポップアップは閉じてしまうため、
    // 前回の実行結果が残っていれば表示して消す。
    await sessionReady;
    const { lastResult } = await chrome.storage.session.get("lastResult");
    if (lastResult) {
        await chrome.storage.session.remove("lastResult");
        describeResult(lastResult);
    }
})();
