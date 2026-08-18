"use strict";

// ポップアップ UI を手で確認するための静的サーバー。
//
//   npm run test:ui   →  http://localhost:8731/
//
// src/popup.html をその場で読み込み、chrome API スタブの <script> を差し込んで
// 配信する。HTML/JS はコピーせず src から直接読むので、実装と食い違わない。

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "src");
const PORT = Number(process.env.PORT || 8731);

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

const send = (res, status, type, body) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "popup.html";

    // ポップアップ本体: スタブを uploader.js の前に差し込む
    if (name === "popup.html") {
        let html;
        try {
            html = fs.readFileSync(path.join(SRC, "popup.html"), "utf8");
        } catch (e) {
            return send(res, 500, TYPES[".html"], "src/popup.html を読めません: " + e.message);
        }
        const injected = html.replace(
            '<script src="uploader.js"></script>',
            '<script src="chrome-stub.js"></script>\n    <script src="uploader.js"></script>'
        );
        if (injected === html) {
            return send(res, 500, TYPES[".html"],
                "uploader.js の script タグが見つかりません。popup.html の変更に合わせて serve.js を更新してください。");
        }
        return send(res, 200, TYPES[".html"], injected);
    }

    if (name === "chrome-stub.js") {
        return send(res, 200, TYPES[".js"], fs.readFileSync(path.join(__dirname, "chrome-stub.js")));
    }

    // それ以外は src/ から素通しで配信（popup.js / uploader.js）
    const file = path.join(SRC, name);
    if (!file.startsWith(SRC) || !fs.existsSync(file)) {
        return send(res, 404, "text/plain; charset=utf-8", "404 " + name);
    }
    return send(res, 200, TYPES[path.extname(file)] || "text/plain; charset=utf-8", fs.readFileSync(file));
});

server.listen(PORT, () => {
    console.log(`ポップアップ UI: http://localhost:${PORT}/`);
    console.log("シナリオ切り替え:");
    for (const s of ["ok", "unknown", "public", "fresh"]) {
        console.log(`  http://localhost:${PORT}/?scenario=${s}`);
    }
    console.log("停止するには Ctrl+C");
});
