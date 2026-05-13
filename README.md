# cursor-browser

一个本地 Cursor 历史对话浏览工具原型，包含 CLI 和 Web UI。

它会读取 macOS 上 Cursor 的本地存储目录，优先解析：

- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- `~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb`

当前原型可以列出 Cursor composer/chat 的本地索引、按关键词搜索、查看单条记录、导出 Markdown，并删除指定记录。它会尽量读取 `bubbleId:<composerId>:<bubbleId>` 里的本地正文；如果 Cursor 只缓存了 header，也会如实显示。Cursor 的内部存储格式不是公开稳定 API，所以删除功能只处理明确指定的 `composerId`，并在写入前自动备份相关数据库。

## 使用

```bash
npm run scan
npm run list
npm run web
node ./src/cli.js list --query 关键词
node ./src/cli.js show <composerId>
node ./src/cli.js export --out ./cursor-history.md
node ./src/cli.js delete <composerId>          # dry run
node ./src/cli.js delete <composerId> --confirm
```

如果 Cursor 数据目录不在默认位置：

```bash
node ./src/cli.js list --cursor-dir "/path/to/Cursor/User"
```

## 依赖

需要本机可用：

- Node.js 20+
- `sqlite3` 命令行工具

## Web UI

```bash
npm run web
```

然后打开：

```text
http://127.0.0.1:4317
```

Web UI 支持搜索、查看正文、导出 Markdown 和删除当前记录。删除前会先 dry-run 预览，并要求浏览器确认。

## 删除范围

删除指定 `composerId` 时会尝试清理：

- `globalStorage/state.vscdb` 里的 `composer.composerHeaders`
- `globalStorage/state.vscdb` 里的 `composerData:<composerId>`
- `globalStorage/state.vscdb` 里的 `bubbleId:<composerId>:*`
- `workspaceStorage/*/state.vscdb` 里的 `composer.composerData`

备份会写入当前项目的 `backups/` 目录；该目录已被 `.gitignore` 排除。
