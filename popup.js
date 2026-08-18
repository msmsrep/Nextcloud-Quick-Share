document.getElementById("runBtn").onclick = () => {
    const password = document.getElementById("password").value;
    const expireDate = document.getElementById("expireDate").value;

    // 現在のタブへメッセージ送信
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, {
            action: "runUpload",
            password,
            expireDate
        });
    });
};
