#!/usr/bin/env node
// Session Viewer Server — serves UI + watches JSONL files via SSE
// Optimized: single-pass cache on startup, incremental updates on file change
import { createServer } from "node:http";
import {
  readFileSync, writeFileSync, readdirSync, statSync, watch, existsSync,
  mkdirSync, copyFileSync, openSync, readSync, closeSync, readFile,
} from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const PORT = parseInt(process.env.PORT || "9100", 10);
const SESSIONS_DIR = process.env.SESSIONS_DIR || (() => {
  const openclaw = join(homedir(), ".openclaw", "agents", "main", "sessions");
  const clawdbot = join(homedir(), ".clawdbot", "agents", "main", "sessions");
  if (existsSync(openclaw)) return openclaw;
  if (existsSync(clawdbot)) return clawdbot;
  return openclaw;
})();
const PROJECT_DIR = new URL(".", import.meta.url).pathname;
const STATIC_DIR = join(new URL(".", import.meta.url).pathname, "dist");
const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".openclaw-inspector");

// Ensure data dir exists and seed defaults
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`⚠️  Cannot create data dir ${DATA_DIR}: ${e.message}`);
  console.error("   Set DATA_DIR env to a writable path.");
  process.exit(1);
}
try {
  if (!existsSync(join(DATA_DIR, ".git"))) {
    execSync("git init", { cwd: DATA_DIR, stdio: "ignore" });
    console.log(`🗂️  Initialized git repo in ${DATA_DIR}`);
  }
} catch (e) {
  console.error(`⚠️  Could not init git in ${DATA_DIR}: ${e.message}`);
}

function gitCommitProgress(message) {
  try {
    execSync("git add progress.json danger-rules.json", { cwd: DATA_DIR, stdio: "ignore" });
    execSync(`git diff --cached --quiet`, { cwd: DATA_DIR, stdio: "ignore" });
  } catch {
    try {
      execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: DATA_DIR, stdio: "ignore" });
    } catch {}
  }
}

const defaultRulesPath = join(PROJECT_DIR, "danger-rules.json");
const userRulesPath = join(DATA_DIR, "danger-rules.json");
if (!existsSync(userRulesPath) && existsSync(defaultRulesPath)) {
  copyFileSync(defaultRulesPath, userRulesPath);
}
gitCommitProgress("init: initial state");

const CSV_PATH =
  process.env.CSV_PATH || join(new URL(".", import.meta.url).pathname, "sessions_table.csv");

// --- SSE clients ---
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ============================================================
// IN-MEMORY CACHE
// ============================================================

// Per-file cached data
// cache[filename] = { session, count, dangers, subagentScanDone }
const cache = {};
// Aggregated results (rebuilt from cache)
let cachedSessions = [];    // array of session info objects
let cachedCounts = {};       // filename -> message count
let cachedDangers = {};      // filename -> danger hits array
let cachedSubagents = {};    // key -> SubagentInfo

// Danger rules (loaded once, reloaded if file changes)
let dangerRules = loadDangerRules();

function loadDangerRules() {
  const rulesPath = existsSync(userRulesPath) ? userRulesPath : join(PROJECT_DIR, "danger-rules.json");
  if (!existsSync(rulesPath)) return [];
  try {
    const rules = JSON.parse(readFileSync(rulesPath, "utf-8")).rules;
    return rules.map((r) => ({
      ...r,
      regexes: (r.patterns || []).map((p) => new RegExp(p, "i")),
      toolRules: r.toolRules || null,
    }));
  } catch { return []; }
}

// Read first line of a file efficiently (only first 4KB)
function readFirstLine(fullPath) {
  try {
    const fd = openSync(fullPath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const text = buf.toString("utf-8", 0, bytesRead);
    const newline = text.indexOf("\n");
    return newline >= 0 ? text.slice(0, newline) : text;
  } catch { return null; }
}

// Session metadata from sessions.json
function getSessionMeta() {
  const metaPath = join(SESSIONS_DIR, "sessions.json");
  if (!existsSync(metaPath)) return {};
  try {
    const data = JSON.parse(readFileSync(metaPath, "utf-8"));
    const byId = {};
    for (const [key, val] of Object.entries(data)) {
      const sid = val.sessionId;
      if (sid) {
        byId[sid] = { status: "active", label: val.label || "", key, updatedAt: val.updatedAt };
      }
    }
    return byId;
  } catch { return {}; }
}

function resolveStatus(filename, metaById) {
  if (filename.includes(".deleted.")) return { status: "deleted", label: "" };
  const base = filename.replace(/\.jsonl$/, "").replace(/\.deleted\.\d+$/, "");
  const meta = metaById[base];
  if (meta) return { status: "active", label: meta.label || "" };
  for (const [sid, m] of Object.entries(metaById)) {
    if (base.startsWith(sid) || sid.startsWith(base)) return { status: "active", label: m.label || "" };
  }
  return { status: "orphan", label: "" };
}

// Scan a single file: extract session info, count messages, find dangers
// Uses streaming readline for memory efficiency
async function scanFile(filename) {
  const fullPath = join(SESSIONS_DIR, filename);
  let stat;
  try { stat = statSync(fullPath); } catch { return null; }

  // First line for session metadata (fast 4KB read)
  const firstLineText = readFirstLine(fullPath);
  let createdAt = null;
  let sessionId = null;
  if (firstLineText) {
    try {
      const obj = JSON.parse(firstLineText);
      if (obj.type === "session") {
        createdAt = obj.timestamp || null;
        sessionId = obj.sessionId || obj.id || null;
      }
    } catch {}
  }

  const session = {
    filename,
    size: stat.size,
    mtime: stat.mtimeMs,
    createdAt,
    sessionId,
    deleted: filename.includes(".deleted."),
  };

  // Stream the file line by line for counts + danger + subagent scanning
  let msgCount = 0;
  const dangers = [];
  let hasSessionsSpawn = false;
  const subagentKeys = [];

  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(fullPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line) return;

      // Fast message count via substring
      if (line.includes('"type":"message"')) {
        msgCount++;
      }

      // Subagent detection
      if (line.includes("sessions_spawn")) hasSessionsSpawn = true;
      if (line.includes("childSessionKey")) {
        subagentKeys.push(line);
      }

      // Danger scanning (needs JSON parse for toolCall analysis)
      if (!line.includes('"toolCall"')) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.type !== "message") return;
      const msg = obj.message;
      if (!msg || !msg.content || !Array.isArray(msg.content)) return;

      for (const block of msg.content) {
        if (block.type !== "toolCall") continue;
        const src = block.arguments || block.input;
        const toolName = block.name || "";
        const toolAction = src?.action || "";

        // Tool-based rules
        for (const rule of dangerRules) {
          if (!rule.toolRules) continue;
          for (const tr of rule.toolRules) {
            if (tr.toolName === toolName && (tr.actions === null || (toolAction && tr.actions.includes(toolAction)))) {
              dangers.push({
                msgId: obj.id,
                command: `${toolName}${toolAction ? ": " + toolAction : ""}`,
                category: rule.category,
                severity: rule.severity,
                label: rule.label,
              });
            }
          }
        }

        if (!src) continue;
        const strings = [];
        const walk = (v) => {
          if (typeof v === "string") { if (v.length > 2) strings.push(v); }
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") Object.values(v).forEach(walk);
        };
        walk(src);
        if (!strings.length) continue;
        const matched = new Set();
        for (const s of strings) {
          for (const rule of dangerRules) {
            if (rule.toolRules) continue;
            if (matched.has(rule.category + s)) continue;
            for (const rx of rule.regexes) {
              if (rx.test(s)) {
                matched.add(rule.category + s);
                dangers.push({
                  msgId: obj.id,
                  command: `${toolName || "?"}: ${s.substring(0, 200)}`,
                  category: rule.category,
                  severity: rule.severity,
                  label: rule.label,
                });
                break;
              }
            }
          }
        }
      }
    });

    rl.on("close", () => {
      resolve({ session, msgCount, dangers, hasSessionsSpawn, subagentKeys });
    });

    rl.on("error", () => {
      resolve({ session, msgCount, dangers, hasSessionsSpawn, subagentKeys });
    });
  });
}

// Build aggregated results from cache
function rebuildAggregates() {
  const meta = getSessionMeta();
  const sessions = [];
  const counts = {};
  const dangers = {};

  for (const [filename, entry] of Object.entries(cache)) {
    const s = { ...entry.session };
    const info = resolveStatus(filename, meta);
    s.status = info.status;
    s.label = info.label;
    sessions.push(s);
    counts[filename] = entry.msgCount;
    if (entry.dangers.length > 0) dangers[filename] = entry.dangers;
  }

  cachedSessions = sessions;
  cachedCounts = counts;
  cachedDangers = dangers;

  // Rebuild subagents
  rebuildSubagents(meta);
}

function rebuildSubagents(meta) {
  if (!meta) meta = getSessionMeta();
  const metaPath = join(SESSIONS_DIR, "sessions.json");
  const result = {};
  const files = Object.keys(cache).filter(f => f.endsWith(".jsonl"));

  if (existsSync(metaPath)) {
    try {
      const data = JSON.parse(readFileSync(metaPath, "utf-8"));
      for (const [key, val] of Object.entries(data)) {
        if (key.includes("subagent")) {
          const sid = val.sessionId;
          if (sid) {
            const file = files.find(f => f.startsWith(sid));
            if (file) {
              result[key] = { filename: file, sessionId: sid, label: val.label || "", parentFilename: null };
            }
          }
        }
      }
    } catch {}
  }

  // Find parent files from cached subagentKeys
  const subKeys = Object.keys(result);
  if (subKeys.length > 0) {
    for (const [filename, entry] of Object.entries(cache)) {
      if (!entry.hasSessionsSpawn) continue;
      for (const line of entry.subagentKeys) {
        for (const sk of subKeys) {
          if (result[sk].parentFilename) continue;
          if (line.includes(sk)) {
            result[sk].parentFilename = filename;
          }
        }
      }
    }
  }

  cachedSubagents = result;
}

// Initial full scan
async function initialScan() {
  const start = Date.now();
  const files = readdirSync(SESSIONS_DIR).filter(
    (f) => f.endsWith(".jsonl") || f.includes(".deleted.")
  );

  console.log(`🔍 Scanning ${files.length} session files...`);

  // Scan files in parallel batches of 20
  const BATCH = 20;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(f => scanFile(f)));
    for (const result of results) {
      if (result) {
        cache[result.session.filename] = result;
      }
    }
  }

  rebuildAggregates();
  console.log(`✅ Cache built in ${Date.now() - start}ms (${files.length} files)`);
}

// Incremental update for a single file
async function updateFile(filename) {
  const fullPath = join(SESSIONS_DIR, filename);
  if (!existsSync(fullPath)) {
    delete cache[filename];
  } else {
    const result = await scanFile(filename);
    if (result) {
      cache[filename] = result;
    }
  }
  rebuildAggregates();
}

// --- Watch sessions dir ---
let fsWatcher;
try {
  fsWatcher = watch(SESSIONS_DIR, { persistent: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.endsWith(".jsonl") || filename.includes(".deleted.")) {
      // Incremental cache update
      updateFile(filename).catch(() => {});
      broadcast("file-change", { eventType, filename });
    }
  });
  console.log(`👁️  Watching ${SESSIONS_DIR}`);
} catch (e) {
  console.error(`Cannot watch ${SESSIONS_DIR}: ${e.message}`);
}

// --- MIME ---
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

// --- Server ---
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS
  const origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  // SSE endpoint
  if (path === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: connected\ndata: "ok"\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // API: list sessions (from cache)
  if (path === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedSessions));
    return;
  }

  // API: session meta
  if (path === "/api/meta") {
    const files = Object.keys(cache);
    const meta = getSessionMeta();
    const result = {};
    for (const f of files) {
      result[f] = resolveStatus(f, meta);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // API: message counts (from cache)
  if (path === "/api/counts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedCounts));
    return;
  }

  // API: danger scan (from cache)
  if (path === "/api/danger") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedDangers));
    return;
  }

  // API: subagent map (from cache)
  if (path === "/api/subagents") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedSubagents));
    return;
  }

  // API: read session file (still reads from disk - individual file)
  if (path.startsWith("/api/session/")) {
    const filename = decodeURIComponent(path.slice("/api/session/".length));
    const fullPath = resolve(SESSIONS_DIR, filename);
    if (!fullPath.startsWith(SESSIONS_DIR) || !existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    // Async read for individual session
    readFile(fullPath, "utf-8", (err, content) => {
      if (err) { res.writeHead(500); res.end("Error"); return; }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(content);
    });
    return;
  }

  // API: CSV metadata
  if (path === "/api/csv") {
    if (!existsSync(CSV_PATH)) {
      res.writeHead(404);
      res.end("No CSV");
      return;
    }
    readFile(CSV_PATH, "utf-8", (err, csv) => {
      if (err) { res.writeHead(500); res.end("Error"); return; }
      res.writeHead(200, { "Content-Type": "text/csv" });
      res.end(csv);
    });
    return;
  }

  // API: read progress
  if (path === "/api/progress" && req.method === "GET") {
    const progressPath = join(DATA_DIR, "progress.json");
    if (!existsSync(progressPath)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    readFile(progressPath, "utf-8", (err, data) => {
      if (err) { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    });
    return;
  }

  // API: save progress
  if (path === "/api/progress" && req.method === "POST") {
    const MAX_BODY = 2 * 1024 * 1024;
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) { res.writeHead(413); res.end("Payload too large"); return; }
      try {
        JSON.parse(body);
        const progressPath = join(DATA_DIR, "progress.json");
        writeFileSync(progressPath, body, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        gitCommitProgress(`review: ${now}`);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
      }
    });
    return;
  }

  // API: full-text search across all sessions
  if (path === "/api/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();
    if (!q || q.length < 2) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    // Async search - don't block event loop
    const files = Object.keys(cache).filter(f => f.endsWith(".jsonl"));
    const matches = [];
    let pending = files.length;
    if (pending === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    for (const f of files) {
      const fullPath = resolve(SESSIONS_DIR, f);
      if (!fullPath.startsWith(SESSIONS_DIR)) { if (--pending === 0) done(); continue; }
      readFile(fullPath, "utf-8", (err, content) => {
        if (!err && content.toLowerCase().includes(q)) {
          matches.push(f);
        }
        if (--pending === 0) done();
      });
    }
    function done() {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(matches));
    }
    return;
  }

  // Static files
  let filePath = path === "/" ? "/index.html" : path;
  const fullPath = resolve(STATIC_DIR, "." + filePath);
  if (!fullPath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const content = readFileSync(fullPath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

const HOST = process.env.HOST || "127.0.0.1";

// Start: build cache first, then listen
initialScan().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`🖥️  Session Viewer: http://localhost:${PORT}`);
    console.log(`📂 Sessions: ${SESSIONS_DIR}`);
    console.log(`📊 CSV: ${CSV_PATH}`);
    console.log(`💾 Data: ${DATA_DIR}`);
  });
}).catch((err) => {
  console.error("Failed to build cache:", err);
  process.exit(1);
});
