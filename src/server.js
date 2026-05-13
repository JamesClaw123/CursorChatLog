import http from "node:http";
import { URL } from "node:url";
import {
  deleteRecords,
  filterRecords,
  findRecord,
  loadCursorStore,
  recordDetails,
  recordSummary,
  renderMarkdown,
} from "./cli.js";

export function startServer({ cursorUserDir, port = 4317 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, renderAppHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/records") {
        const query = url.searchParams.get("query") || "";
        const store = loadCursorStore(cursorUserDir, {
          bubbleMode: query ? "matching" : "count",
          query,
        });
        const records = filterRecords(store.records, query).map(recordSummary);
        sendJson(res, { stats: store.stats, records });
        return;
      }

      const recordMatch = /^\/api\/records\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && recordMatch) {
        const id = decodeURIComponent(recordMatch[1]);
        const store = loadCursorStore(cursorUserDir, { bubbleMode: "target", composerId: id });
        const record = findRecord(store.records, id);
        if (!record) {
          sendJson(res, { error: "Record not found" }, 404);
          return;
        }
        sendJson(res, { record: recordDetails(record) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/export") {
        const query = url.searchParams.get("query") || "";
        const store = loadCursorStore(cursorUserDir, {
          bubbleMode: query ? "matching" : "full",
          query,
        });
        const records = filterRecords(store.records, query);
        const markdown = renderMarkdown(records);
        sendText(res, markdown, "text/markdown; charset=utf-8", {
          "Content-Disposition": "attachment; filename=\"cursor-history.md\"",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/delete") {
        const body = await readJson(req);
        const ids = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);
        const dryRun = body.dryRun !== false;
        const result = deleteRecords(cursorUserDir, ids, { dryRun });
        sendJson(res, { result });
        return;
      }

      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      sendJson(res, { error: error.message || String(error) }, 500);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Cursor Browser Web UI: http://127.0.0.1:${port}`);
  });

  return server;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, body, status = 200) {
  sendText(res, JSON.stringify(body), "application/json; charset=utf-8", {}, status);
}

function sendHtml(res, html) {
  sendText(res, html, "text/html; charset=utf-8");
}

function sendText(res, text, contentType, headers = {}, status = 200) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

function renderAppHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cursor Chat Log</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f5;
      --panel: #ffffff;
      --ink: #202124;
      --muted: #69716b;
      --line: #dfe4dc;
      --accent: #176b65;
      --accent-2: #c7422f;
      --soft: #edf4f1;
      --shadow: 0 12px 30px rgba(32, 33, 36, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
    }
    button, input {
      font: inherit;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(340px, 430px) minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: #fbfcfa;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .topbar {
      padding: 18px;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 12px;
    }
    h1 {
      font-size: 20px;
      line-height: 1.2;
      margin: 0;
      letter-spacing: 0;
    }
    .stats {
      color: var(--muted);
      font-size: 13px;
      min-height: 18px;
    }
    .search-row {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 8px;
      align-items: center;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      min-height: 38px;
      padding: 8px 10px;
      border-radius: 6px;
    }
    button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      min-height: 38px;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { border-color: #b7c2bb; }
    .primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .danger {
      background: #fff6f3;
      color: var(--accent-2);
      border-color: #efc8bf;
    }
    .records {
      overflow: auto;
      padding: 10px;
    }
    .record {
      width: 100%;
      text-align: left;
      border: 1px solid transparent;
      background: transparent;
      display: grid;
      gap: 5px;
      padding: 11px 10px;
      border-radius: 8px;
      min-height: 84px;
    }
    .record:hover, .record.active {
      background: var(--soft);
      border-color: #d0ddd7;
    }
    .record-title {
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta, .preview {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    main {
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .detail-head {
      min-height: 98px;
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
      background: #fff;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
    }
    .detail-title {
      font-size: 22px;
      line-height: 1.25;
      margin: 0 0 8px;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .messages {
      padding: 18px 22px 36px;
      overflow: auto;
      display: grid;
      gap: 14px;
    }
    .message {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .role {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      padding: 9px 12px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfa;
      text-transform: uppercase;
    }
    pre {
      margin: 0;
      padding: 13px 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.48;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .empty {
      color: var(--muted);
      padding: 32px;
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: min(520px, calc(100vw - 36px));
      background: #202124;
      color: #fff;
      padding: 12px 14px;
      border-radius: 8px;
      box-shadow: var(--shadow);
      display: none;
      white-space: pre-wrap;
    }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { min-height: 45vh; border-right: 0; border-bottom: 1px solid var(--line); }
      .detail-head { grid-template-columns: 1fr; }
      .actions { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="topbar">
        <div>
          <h1>Cursor Chat Log</h1>
          <div id="stats" class="stats"></div>
        </div>
        <div class="search-row">
          <input id="query" placeholder="搜索标题、workspace 或本地正文">
          <button id="search">搜索</button>
          <button id="export">导出</button>
        </div>
      </div>
      <div id="records" class="records"></div>
    </aside>
    <main>
      <div id="detailHead" class="detail-head">
        <div>
          <h2 class="detail-title">选择一条记录</h2>
          <div class="meta">本地读取 Cursor 缓存；删除会先创建数据库备份。</div>
        </div>
      </div>
      <div id="messages" class="messages">
        <div class="empty">从左侧选择一条会话查看正文。</div>
      </div>
    </main>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    const state = { records: [], selectedId: "", query: "" };
    const els = {
      query: document.querySelector("#query"),
      search: document.querySelector("#search"),
      export: document.querySelector("#export"),
      records: document.querySelector("#records"),
      stats: document.querySelector("#stats"),
      detailHead: document.querySelector("#detailHead"),
      messages: document.querySelector("#messages"),
      toast: document.querySelector("#toast"),
    };

    els.search.addEventListener("click", () => loadRecords());
    els.query.addEventListener("keydown", (event) => {
      if (event.key === "Enter") loadRecords();
    });
    els.export.addEventListener("click", () => {
      const qs = new URLSearchParams({ query: els.query.value.trim() });
      location.href = "/api/export?" + qs.toString();
    });

    async function loadRecords() {
      state.query = els.query.value.trim();
      els.records.innerHTML = "<div class='empty'>读取中...</div>";
      const data = await requestJson("/api/records?" + new URLSearchParams({ query: state.query }));
      state.records = data.records || [];
      els.stats.textContent = [
        state.records.length + " 条记录",
        (data.stats?.globalBubbles || 0) + " 条本地正文",
      ].join(" · ");
      renderRecords();
      if (state.records[0]) selectRecord(state.records[0].composerId);
    }

    function renderRecords() {
      if (!state.records.length) {
        els.records.innerHTML = "<div class='empty'>没有匹配记录。</div>";
        return;
      }
      els.records.innerHTML = state.records.map((record) => \`
        <button class="record \${record.composerId === state.selectedId ? "active" : ""}" data-id="\${escapeAttr(record.composerId)}">
          <span class="record-title">\${escapeHtml(record.name)}</span>
          <span class="meta">\${escapeHtml(record.lastUpdatedAt)} · \${escapeHtml(record.mode || "-")} · \${record.bubbleCount}/\${record.conversationHeaderCount}</span>
          <span class="preview">\${escapeHtml(record.workspacePath || record.textPreview || record.subtitle || "")}</span>
        </button>
      \`).join("");
      for (const button of els.records.querySelectorAll(".record")) {
        button.addEventListener("click", () => selectRecord(button.dataset.id));
      }
    }

    async function selectRecord(id) {
      state.selectedId = id;
      renderRecords();
      els.messages.innerHTML = "<div class='empty'>读取正文中...</div>";
      const data = await requestJson("/api/records/" + encodeURIComponent(id));
      renderDetail(data.record);
    }

    function renderDetail(record) {
      els.detailHead.innerHTML = \`
        <div>
          <h2 class="detail-title">\${escapeHtml(record.name)}</h2>
          <div class="meta">\${escapeHtml(record.composerId)} · \${escapeHtml(record.lastUpdatedAt)} · \${escapeHtml(record.workspacePath || "-")}</div>
        </div>
        <div class="actions">
          <button class="danger" id="deleteBtn">删除</button>
        </div>
      \`;
      document.querySelector("#deleteBtn").addEventListener("click", () => deleteRecord(record));

      const messages = record.messages || [];
      if (!messages.length) {
        els.messages.innerHTML = "<div class='empty'>这条记录没有找到本地正文，可能只缓存了 header。</div>";
        return;
      }
      els.messages.innerHTML = messages.map((message) => \`
        <article class="message">
          <div class="role">\${escapeHtml(message.role)}</div>
          <pre>\${escapeHtml(message.text)}</pre>
        </article>
      \`).join("");
    }

    async function deleteRecord(record) {
      const preview = await requestJson("/api/delete", {
        method: "POST",
        body: JSON.stringify({ ids: [record.composerId], dryRun: true }),
      });
      const count = preview.result?.operations?.filter((op) => op.count > 0).map((op) => op.count).join(", ") || "0";
      const ok = confirm("确认删除这条 Cursor 本地记录？\\n\\n" + record.name + "\\n" + record.composerId + "\\n\\n将影响的条目数：" + count + "\\n删除前会自动备份数据库。");
      if (!ok) return;
      const done = await requestJson("/api/delete", {
        method: "POST",
        body: JSON.stringify({ ids: [record.composerId], dryRun: false }),
      });
      showToast("已删除。备份目录：\\n" + (done.result?.backupDir || "-"));
      state.selectedId = "";
      await loadRecords();
    }

    async function requestJson(url, options = {}) {
      const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    function showToast(text) {
      els.toast.textContent = text;
      els.toast.style.display = "block";
      setTimeout(() => { els.toast.style.display = "none"; }, 6000);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\n/g, " ");
    }

    loadRecords().catch((error) => {
      els.records.innerHTML = "<div class='empty'>" + escapeHtml(error.message) + "</div>";
    });
  </script>
</body>
</html>`;
}
