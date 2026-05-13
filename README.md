# cursor-browser

一个本地只读 Cursor 历史对话扫描工具原型。

它会读取 macOS 上 Cursor 的本地存储目录，优先解析：

- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- `~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb`

当前原型可以列出 Cursor composer/chat 的本地索引、按关键词搜索、查看单条记录，并导出 Markdown。它会尽量读取 `bubbleId:<composerId>:<bubbleId>` 里的本地正文；如果 Cursor 只缓存了 header，也会如实显示。Cursor 的内部存储格式不是公开稳定 API，所以这个工具默认只读。

## 使用

```bash
npm run scan
npm run list
node ./src/cli.js list --query 关键词
node ./src/cli.js show <composerId>
node ./src/cli.js export --out ./cursor-history.md
```

如果 Cursor 数据目录不在默认位置：

```bash
node ./src/cli.js list --cursor-dir "/path/to/Cursor/User"
```

## 依赖

需要本机可用：

- Node.js 20+
- `sqlite3` 命令行工具

工具只读取 Cursor 本地文件，不会修改 Cursor 数据，也不会联网。
