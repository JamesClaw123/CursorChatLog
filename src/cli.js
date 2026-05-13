#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_CURSOR_USER_DIR = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Cursor",
  "User",
);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";

  if (args.help || command === "help") {
    printHelp();
    return;
  }

  const cursorUserDir = path.resolve(args["cursor-dir"] || DEFAULT_CURSOR_USER_DIR);

  if (command === "scan") {
    const store = loadCursorStore(cursorUserDir, { bubbleMode: "count" });
    printScan(store);
    return;
  }

  if (command === "list") {
    const store = loadCursorStore(cursorUserDir, {
      bubbleMode: args.query ? "matching" : "count",
      query: args.query,
    });
    const records = filterRecords(store.records, args.query);
    printList(records, Number(args.limit || 50));
    return;
  }

  if (command === "show") {
    const id = args._[1];
    if (!id) fail("Missing composerId. Example: node ./src/cli.js show <composerId>");
    const store = loadCursorStore(cursorUserDir, { bubbleMode: "target", composerId: id });
    const record = findRecord(store.records, id);
    if (!record) fail(`No local record found for composerId: ${id}`);
    printRecord(record, Boolean(args.raw));
    return;
  }

  if (command === "export") {
    const store = loadCursorStore(cursorUserDir, {
      bubbleMode: args.query ? "matching" : "full",
      query: args.query,
    });
    const records = filterRecords(store.records, args.query);
    const markdown = renderMarkdown(records);
    if (args.out) {
      const outPath = path.resolve(args.out);
      writeFileSync(outPath, markdown);
      console.log(`Exported ${records.length} records to ${outPath}`);
    } else {
      process.stdout.write(markdown);
    }
    return;
  }

  fail(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.trim();
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (["help", "raw"].includes(key)) {
      parsed[key] = true;
    } else {
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function loadCursorStore(cursorUserDir, options = {}) {
  if (!existsSync(cursorUserDir)) {
    fail(`Cursor user directory does not exist: ${cursorUserDir}`);
  }

  const globalDb = path.join(cursorUserDir, "globalStorage", "state.vscdb");
  const workspaceStorageDir = path.join(cursorUserDir, "workspaceStorage");
  const workspaceDbs = existsSync(workspaceStorageDir)
    ? readdirSync(workspaceStorageDir)
        .map((entry) => path.join(workspaceStorageDir, entry, "state.vscdb"))
        .filter((dbPath) => existsSync(dbPath))
    : [];

  const globalHeaders = existsSync(globalDb) ? loadGlobalHeaders(globalDb) : [];
  const globalData = existsSync(globalDb) ? loadGlobalComposerData(globalDb) : new Map();
  const globalBubbleCounts = existsSync(globalDb) ? loadGlobalBubbleCounts(globalDb) : new Map();
  const globalBubbles = existsSync(globalDb)
    ? loadGlobalBubbles(globalDb, options.bubbleMode, options.composerId, options.query)
    : new Map();
  const workspaceHeaders = workspaceDbs.flatMap(loadWorkspaceHeaders);

  const recordsById = new Map();
  for (const header of [...globalHeaders, ...workspaceHeaders]) {
    const existing = recordsById.get(header.composerId) || {};
    recordsById.set(header.composerId, mergeRecord(existing, header));
  }

  for (const [composerId, data] of globalData) {
    const existing = recordsById.get(composerId) || { composerId };
    recordsById.set(composerId, mergeRecord(existing, data));
  }

  for (const [composerId, count] of globalBubbleCounts) {
    const existing = recordsById.get(composerId) || { composerId };
    recordsById.set(composerId, mergeRecord(existing, { composerId, bubbleCount: count, sources: [] }));
  }

  for (const [composerId, bubbles] of globalBubbles) {
    const existing = recordsById.get(composerId) || { composerId };
    recordsById.set(
      composerId,
      mergeRecord(existing, {
        composerId,
        bubbles,
        ...(options.bubbleMode === "matching"
          ? { matchingBubbleCount: bubbles.length }
          : { bubbleCount: bubbles.length }),
        bubbleLoadMode: options.bubbleMode,
        sources: [{ source: "globalBubbles", dbPath: globalDb }],
      }),
    );
  }

  const records = [...recordsById.values()]
    .filter((record) => record.composerId)
    .sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));

  return {
    cursorUserDir,
    globalDb,
    workspaceDbs,
    records,
    stats: {
      globalHeaders: globalHeaders.length,
      globalComposerData: globalData.size,
      globalBubbles: [...globalBubbleCounts.values()].reduce((sum, count) => sum + count, 0),
      workspaceHeaders: workspaceHeaders.length,
    },
  };
}

function loadGlobalHeaders(dbPath) {
  const rows = querySqliteJson(
    dbPath,
    "select cast(value as text) as value from ItemTable where key = 'composer.composerHeaders';",
  );
  return rows.flatMap((row) => {
    const parsed = parseJson(row.value);
    return normalizeComposerHeaders(parsed?.allComposers || [], {
      source: "globalHeaders",
      dbPath,
    });
  });
}

function loadWorkspaceHeaders(dbPath) {
  const workspace = readWorkspaceInfo(path.dirname(dbPath));
  const rows = querySqliteJson(
    dbPath,
    "select cast(value as text) as value from ItemTable where key = 'composer.composerData';",
  );
  return rows.flatMap((row) => {
    const parsed = parseJson(row.value);
    return normalizeComposerHeaders(parsed?.allComposers || [], {
      source: "workspaceComposerData",
      dbPath,
      workspace,
    });
  });
}

function loadGlobalComposerData(dbPath) {
  const rows = querySqliteJson(
    dbPath,
    "select key, cast(value as text) as value from cursorDiskKV where key like 'composerData:%';",
  );
  const map = new Map();
  for (const row of rows) {
    const composerId = row.key.replace(/^composerData:/, "");
    const data = parseJson(row.value);
    if (!data) continue;
    map.set(composerId, normalizeComposerData(data, { source: "globalComposerData", dbPath }));
  }
  return map;
}

function loadGlobalBubbleCounts(dbPath) {
  const rows = querySqliteJson(
    dbPath,
    "select key from cursorDiskKV where key like 'bubbleId:%';",
  );
  const map = new Map();
  for (const row of rows) {
    const match = /^bubbleId:([^:]+):([^:]+)$/.exec(row.key);
    if (!match) continue;
    const [, composerId] = match;
    map.set(composerId, (map.get(composerId) || 0) + 1);
  }
  return map;
}

function loadGlobalBubbles(dbPath, mode = "count", composerIdPrefix = "", query = "") {
  if (mode === "count") return new Map();

  let where = "key like 'bubbleId:%'";
  if (mode === "target" && composerIdPrefix) {
    where = `key like 'bubbleId:${escapeSqlLike(composerIdPrefix)}%'`;
  } else if (mode === "matching" && query) {
    where = `key like 'bubbleId:%' and cast(value as text) like '%${escapeSqlLike(query)}%'`;
  }
  const rows = querySqliteJson(
    dbPath,
    `select key, cast(value as text) as value from cursorDiskKV where ${where};`,
  );
  const map = new Map();
  for (const row of rows) {
    const match = /^bubbleId:([^:]+):([^:]+)$/.exec(row.key);
    if (!match) continue;
    const [, composerId, bubbleId] = match;
    const data = parseJson(row.value);
    if (!data) continue;
    const bubbles = map.get(composerId) || [];
    bubbles.push(normalizeBubble({ ...data, bubbleId }));
    map.set(composerId, bubbles);
  }

  for (const bubbles of map.values()) {
    bubbles.sort((a, b) => {
      const at = Date.parse(a.createdAt || "") || 0;
      const bt = Date.parse(b.createdAt || "") || 0;
      return at - bt;
    });
  }
  return map;
}

function escapeSqlLike(value) {
  return String(value).replaceAll("'", "''").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function querySqliteJson(dbPath, sql) {
  try {
    const output = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 128,
    });
    return output.trim() ? JSON.parse(output) : [];
  } catch (error) {
    const message = error.stderr?.toString()?.trim() || error.message;
    console.warn(`Warning: failed to read ${dbPath}: ${message}`);
    return [];
  }
}

function normalizeComposerHeaders(headers, defaults) {
  return headers
    .filter((header) => header && header.composerId)
    .map((header) => ({
      ...header,
      workspacePath:
        header.workspaceIdentifier?.uri?.fsPath ||
        header.workspaceIdentifier?.uri?.path ||
        defaults.workspace?.folder ||
        undefined,
      workspaceId: header.workspaceIdentifier?.id || defaults.workspace?.id,
      sources: [defaults],
    }));
}

function normalizeComposerData(data, defaults) {
  const headers = Array.isArray(data.fullConversationHeadersOnly)
    ? data.fullConversationHeadersOnly
    : [];
  const conversationMap = data.conversationMap && typeof data.conversationMap === "object"
    ? data.conversationMap
    : {};
  return {
    composerId: data.composerId,
    version: data._v,
    status: data.status,
    draftText: data.text || "",
    conversationHeaderCount: headers.length,
    conversationMapCount: Object.keys(conversationMap).length,
    conversationHeaders: headers,
    conversationMap,
    hasLoaded: data.hasLoaded,
    sources: [defaults],
  };
}

function normalizeBubble(data) {
  return {
    bubbleId: data.bubbleId,
    type: data.type,
    role: bubbleRole(data),
    createdAt: data.createdAt,
    text: data.text || "",
    serviceStatus: data.serviceStatusUpdate?.message,
    capabilityType: data.capabilityType,
  };
}

function bubbleRole(bubble) {
  if (bubble.serviceStatusUpdate) return "system";
  if (bubble.type === 1) return "user";
  if (bubble.type === 2) return "assistant";
  return `type-${bubble.type ?? "unknown"}`;
}

function mergeRecord(a, b) {
  const merged = { ...a, ...b };
  merged.sources = [...(a.sources || []), ...(b.sources || [])];
  if (a.workspacePath && !b.workspacePath) merged.workspacePath = a.workspacePath;
  if (a.name && !b.name) merged.name = a.name;
  return merged;
}

function readWorkspaceInfo(workspaceStoragePath) {
  const workspaceJsonPath = path.join(workspaceStoragePath, "workspace.json");
  if (!existsSync(workspaceJsonPath)) return { id: path.basename(workspaceStoragePath) };
  const parsed = parseJson(readFileSync(workspaceJsonPath, "utf8"));
  return {
    id: path.basename(workspaceStoragePath),
    folder: parsed?.folder,
    workspace: parsed?.workspace,
  };
}

function parseJson(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function filterRecords(records, query) {
  if (!query) return records;
  const needle = query.toLowerCase();
  return records.filter((record) => searchableText(record).includes(needle));
}

function searchableText(record) {
  return [
    record.composerId,
    record.name,
    record.subtitle,
    record.status,
    record.unifiedMode,
    record.forceMode,
    record.workspacePath,
    record.draftText,
    ...(record.bubbles || []).map((bubble) => [bubble.text, bubble.serviceStatus].filter(Boolean).join("\n")),
    JSON.stringify(record.conversationMap || {}),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function findRecord(records, id) {
  return records.find((record) => record.composerId === id || record.composerId?.startsWith(id));
}

function printScan(store) {
  console.log(`Cursor user dir: ${store.cursorUserDir}`);
  console.log(`Global DB: ${existsSync(store.globalDb) ? store.globalDb : "not found"}`);
  console.log(`Workspace DBs: ${store.workspaceDbs.length}`);
  console.log(`Global headers: ${store.stats.globalHeaders}`);
  console.log(`Global composerData entries: ${store.stats.globalComposerData}`);
  console.log(`Global full bubble entries: ${store.stats.globalBubbles}`);
  console.log(`Workspace headers: ${store.stats.workspaceHeaders}`);
  console.log(`Merged records: ${store.records.length}`);
}

function printList(records, limit) {
  for (const record of records.slice(0, limit)) {
    const updated = formatTime(record.lastUpdatedAt || record.createdAt);
    const title = record.name || "(untitled)";
    const mode = [record.unifiedMode, record.forceMode].filter(Boolean).join("/");
    const workspace = record.workspacePath ? ` ${record.workspacePath}` : "";
    const bubbles = Number.isFinite(record.bubbleCount)
      ? ` bubbles=${record.bubbleCount}/${record.conversationHeaderCount ?? "?"}`
      : Number.isFinite(record.conversationHeaderCount)
        ? ` bubbles=${record.conversationHeaderCount}`
      : "";
    console.log(`${updated} ${record.composerId} ${mode} ${title}${bubbles}${workspace}`);
  }
  if (records.length > limit) {
    console.log(`... ${records.length - limit} more. Use --limit ${records.length} to show all.`);
  }
}

function printRecord(record, raw) {
  console.log(`# ${record.name || "(untitled)"}`);
  console.log(`composerId: ${record.composerId}`);
  console.log(`createdAt: ${formatTime(record.createdAt)}`);
  console.log(`lastUpdatedAt: ${formatTime(record.lastUpdatedAt)}`);
  console.log(`mode: ${[record.unifiedMode, record.forceMode].filter(Boolean).join("/") || "-"}`);
  console.log(`status: ${record.status || "-"}`);
  console.log(`workspace: ${record.workspacePath || "-"}`);
  console.log(`subtitle: ${record.subtitle || "-"}`);
  console.log(`conversation headers: ${record.conversationHeaderCount ?? "-"}`);
  console.log(`cached bubbles: ${record.bubbleCount ?? 0}`);
  console.log(`conversation map entries: ${record.conversationMapCount ?? "-"}`);
  console.log(`sources: ${(record.sources || []).map((source) => source.source).join(", ")}`);

  const extracted = extractConversationText(record);
  if (extracted.length) {
    console.log("\n## Local conversation text");
    for (const item of extracted) console.log(`\n[${item.role}] ${item.text}`);
  } else {
    console.log("\nNo full message bodies were found locally for this record. Cursor may only have cached headers for it.");
  }

  if (raw) {
    console.log("\n## Raw");
    console.log(JSON.stringify(record, null, 2));
  }
}

function renderMarkdown(records) {
  const lines = ["# Cursor History Export", ""];
  for (const record of records) {
    lines.push(`## ${escapeMarkdown(record.name || "(untitled)")}`);
    lines.push("");
    lines.push(`- composerId: \`${record.composerId}\``);
    lines.push(`- updated: ${formatTime(record.lastUpdatedAt || record.createdAt)}`);
    if (record.workspacePath) lines.push(`- workspace: \`${record.workspacePath}\``);
    if (record.subtitle) lines.push(`- subtitle: ${escapeMarkdown(record.subtitle)}`);
  if (Number.isFinite(record.conversationHeaderCount)) {
      lines.push(`- cached bubble headers: ${record.conversationHeaderCount}`);
    }
  if (Number.isFinite(record.bubbleCount)) {
      lines.push(`- cached full bubbles: ${record.bubbleCount}`);
    }
    if (record.bubbleLoadMode === "matching") {
      lines.push(`- matching local bubbles loaded: ${record.matchingBubbleCount ?? 0}`);
      lines.push("- note: query export includes matching local bubbles, not necessarily every bubble in the conversation");
    }

    const extracted = extractConversationText(record);
    if (extracted.length) {
      lines.push("");
      for (const item of extracted) {
        lines.push(`### ${item.role}`);
        lines.push("");
        lines.push(item.text);
        lines.push("");
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function extractConversationText(record) {
  const bubbles = (record.bubbles || [])
    .map((bubble) => ({
      role: bubble.role,
      text: bubble.text || bubble.serviceStatus || "",
    }))
    .filter((entry) => entry.text);
  if (bubbles.length) return bubbles;

  const entries = Object.values(record.conversationMap || {});
  return entries
    .map((entry) => ({
      role: entry.type || entry.role || entry.speaker || "message",
      text: findText(entry),
    }))
    .filter((entry) => entry.text);
}

function findText(value, depth = 0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value.length > 2 ? value : "";
  if (Array.isArray(value)) {
    return value.map((item) => findText(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    for (const key of ["text", "content", "markdown", "message", "response", "rawText"]) {
      const found = findText(value[key], depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function escapeMarkdown(text) {
  return String(text).replaceAll("|", "\\|");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`cursor-browser

Usage:
  node ./src/cli.js scan [--cursor-dir <path>]
  node ./src/cli.js list [--query <text>] [--limit <n>] [--cursor-dir <path>]
  node ./src/cli.js show <composerId> [--raw] [--cursor-dir <path>]
  node ./src/cli.js export [--query <text>] [--out <file>] [--cursor-dir <path>]

Commands:
  scan    Show discovered Cursor storage counts.
  list    List local composer/chat records.
  show    Show one record by full or prefix composerId.
  export  Export matching records to Markdown.
`);
}

main();
