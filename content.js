// ポップアップページからの値を受け取る
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "runUpload") {
        handleUploadClick(msg.password, msg.expireDate);
    }
});


// (function () {
console.log("Nextcloud WebDAV uploader loaded");

// requesttokenを取得する
function getRequestToken() {
    const head = document.querySelector("head");
    if (!head) return null;
    const token = head.getAttribute("data-requesttoken");
    return token || null;
}
// ファイル選択ダイアログを開く
function openFilePicker() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "*/*";
        input.style.display = "none";
        document.body.appendChild(input);

        input.onchange = () => resolve(input.files[0] || null);
        input.click();
    });
}


// ファイルをWebDAVアップロード
async function uploadFile(file, requesttoken) {
    const arrayBuffer = await file.arrayBuffer();
    const uploadUrl = "/remote.php/webdav/" + file.name;

    console.log("Uploading to:", uploadUrl);

    const res = await fetch(uploadUrl, {
        method: "PUT",
        credentials: "include",
        headers: {
            "Content-Type": file.type || "application/octet-stream",
            "Content-Disposition": `attachment; filename="${file.name}"`,
            "OCS-APIREQUEST": "true",
            "X-Requested-With": "XMLHttpRequest",
            "requesttoken": requesttoken
        },
        body: arrayBuffer
    });

    console.log("Upload status:", res.status);
    return res.status === 201 || res.status === 200;
}

// 共有リンク作成
async function createShare(filePath) {
    const requesttoken = getRequestToken();
    if (!requesttoken) {
        alert("requesttoken が取得できません。Nextcloudのページ内で実行してください。");
        return null;
    }

    const url = "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json";

    const form = new FormData();
    form.append("path", filePath);
    form.append("shareType", 3);
    form.append("permissions", 1);

    const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
            "OCS-APIREQUEST": "true",
            "requesttoken": requesttoken
        },
        body: form
    });

    const data = await res.json();
    console.log("Share API response:", data);
    return data;
}

// パスワードと有効期限を設定
async function updateShareSettings(shareId, password, expireDate) {
    const requesttoken = getRequestToken();
    if (!requesttoken) {
        alert("requesttoken が取得できません。Nextcloudのページ内で実行してください。");
        return null;
    }

    const url = `/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}?format=json`;

    const params = [];
    params.push(`password=${encodeURIComponent(password)}`);
    params.push(`expireDate=${encodeURIComponent(expireDate)}`);

    const body = params.join("&");

    const res = await fetch(url, {
        method: "PUT",
        credentials: "include",
        headers: {
            "OCS-APIREQUEST": "true",
            "requesttoken": requesttoken,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        body
    });

    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

// クリック時のメイン処理
async function handleUploadClick(password, expireDate) {
    const file = await openFilePicker();
    if (!file) return;

    const requesttoken = getRequestToken();
    if (!requesttoken) {
        alert("requesttoken が取得できません。Nextcloudのページ内で実行してください。");
        return;
    }

    const success = await uploadFile(file, requesttoken);
    if (!success) {
        alert("アップロード失敗");
        return;
    }

    const shareData = await createShare("/" + file.name);
    if (!shareData) {
        alert("共有リンク作成に失敗しました");
        return;
    }

    const shareId = shareData.ocs.data.id;

    // オプションページから受け取った値を使う
    const pwRes = await updateShareSettings(shareId, password, expireDate);
    console.log("Share settings updated:", pwRes);

    // 共有URLをクリップボードへコピー
    const shareUrl = shareData.ocs.data.url;
    try {
        await navigator.clipboard.writeText(shareUrl);
        // alert("共有URLをコピーしました:\n" + shareUrl);
    } catch (e) {
        alert("共有URLのコピーに失敗しました");
    }

    alert("アップロードと共有設定が完了しました！\nクリップボードへ共有URLをコピーしました。");
    location.reload();

}



// ボタン作成
const btn = document.createElement("button");
btn.textContent = "ファイルをアップロード";
btn.style.position = "fixed";
btn.style.top = "20px";
btn.style.right = "20px";
btn.style.zIndex = 999999;
btn.style.padding = "10px 16px";
btn.style.background = "#0078d4";
btn.style.color = "#fff";
btn.style.borderRadius = "6px";
btn.style.border = "none";
btn.style.cursor = "pointer";

document.body.appendChild(btn);

// クリック処理を関数に分離
btn.onclick = handleUploadClick;

// })();
