// アップロード後に「ページ内の一覧だけ」を更新するためのサービスワーカー。
//
// ページ側の Files アプリ（OCA.Files.*）は MAIN world にしか居ないため、
// uploader.js（executeScript で注入 = isolated world）からは直接呼べない。
// CSP（nonce）があるので <script> を差し込んで入ることもできない。
// MAIN world へ入れる chrome.scripting を呼べるのは拡張機能のページだけだが、
// ポップアップはファイル選択ダイアログを開いた時点で閉じてしまう。
// そこで注入先 → SW → executeScript(world:"MAIN") と橋渡しする。
//
// 権限は増えない（activeTab + scripting のまま）。activeTab の許可は
// 「ユーザーがアイコンを押したタブ」に対して拡張機能へ与えられているので、
// そのタブが遷移しない限り SW からも使える。

/**
 * ページ側の Files アプリに一覧の再取得をさせる。
 * MAIN world へ注入されるので、外側のスコープは一切参照できない。
 * ページの JS を壊さないよう、例外は全て握って結果だけ返す。
 */
function refreshFilesApp() {
    const files = window.OCA && window.OCA.Files;
    if (!files || !files.App) return { ok: false, reason: "no-files-app" };

    // 旧 Files アプリ（NC 27 以前）。fileList.reload() が PROPFIND をやり直す。
    let list = null;
    try {
        list = files.App.fileList
            || (typeof files.App.getCurrentFileList === "function" && files.App.getCurrentFileList())
            || null;
    } catch (e) { /* 取得に失敗したら未対応として扱う */ }

    if (!list || typeof list.reload !== "function") return { ok: false, reason: "no-filelist" };

    try {
        list.reload();
    } catch (e) {
        return { ok: false, reason: (e && e.message) || String(e) };
    }

    // サイト UI もアップロード後にここ（getstoragestats.php）を叩いて
    // 左下の使用量バーを更新している。一覧と足並みを揃える。
    try {
        if (files.Files && typeof files.Files.updateStorageStatistics === "function") {
            files.Files.updateStorageStatistics(true);
        }
    } catch (e) { /* 使用量バーが古いままでも一覧の更新は済んでいる */ }

    return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 送り主は自分が注入したコードだけ。externally_connectable を宣言していない
    // ので Web ページからは届かないが、念のため確認する。
    if (sender.id !== chrome.runtime.id) return;
    if (!message || message.type !== "refreshFileList") return;

    // 対象タブはメッセージ本文ではなく sender から取る
    // （本文の tabId を信じると別タブへの注入に使われうる）。
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== "number") {
        sendResponse({ ok: false, reason: "no-tab" });
        return;
    }

    chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN", // ページ側の OCA.Files を触るためここだけ MAIN world
        func: refreshFilesApp,
    })
        .then(([injection]) => sendResponse((injection && injection.result) || { ok: false }))
        .catch((e) => sendResponse({ ok: false, reason: e.message }));

    return true; // 非同期に応答する
});
