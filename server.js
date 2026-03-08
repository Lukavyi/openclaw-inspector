#!/usr/bin/env node
// Session Viewer Server — serves UI + watches JSONL files via SSE
// Multi-agent: discovers all agent dirs under ~/.openclaw/agents/*/sessions/ and ~/.clawdbot/agents/*/sessions/
import crypto from "node:crypto";
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

// Multi-agent discovery
// If SESSIONS_DIR is set, use it as single agent "custom"
// Otherwise discover all agents from ~/.openclaw/agents/*/sessions/ and ~/.clawdbot/agents/*/sessions/
const CUSTOM_SESSIONS_DIR = process.env.SESSIONS_DIR || null;

function discoverAgentDirs() {
  if (CUSTOM_SESSIONS_DIR) {
    return { custom: CUSTOM_SESSIONS_DIR };
  }
  const agents = {};
  const bases = [
    join(homedir(), ".openclaw", "agents"),
    join(homedir(), ".clawdbot", "agents"),
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (agents[name]) continue; // first found wins (openclaw > clawdbot)
      const sessDir = join(base, name, "sessions");
      if (existsSync(sessDir)) {
        agents[name] = sessDir;
      }
    }
  }
  return agents;
}

let agentDirs = discoverAgentDirs(); // { agentId: sessionsPath }

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

function gitCommitData(message) {
  try {
    execSync("git add -A", { cwd: DATA_DIR, stdio: "ignore" });
    execSync(`git diff --cached --quiet`, { cwd: DATA_DIR, stdio: "ignore" });
  } catch {
    try {
      execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: DATA_DIR, stdio: "ignore" });
    } catch {}
  }
}
const gitCommitProgress = gitCommitData;

// Pins storage (JSONL - one pin per line)
const PINS_PATH = join(DATA_DIR, "pins.jsonl");
function loadPins() {
  if (!existsSync(PINS_PATH)) return [];
  try {
    return readFileSync(PINS_PATH, "utf-8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch { return []; }
}
function savePins(pins) {
  writeFileSync(PINS_PATH, pins.map(p => JSON.stringify(p)).join("\n") + (pins.length ? "\n" : ""), "utf-8");
  gitCommitData("pins: update");
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
// IN-MEMORY CACHE (multi-agent aware)
// ============================================================

// cache["agentId:filename"] = { session, msgCount, dangers, subagentScanDone, hasSessionsSpawn, subagentKeys }
const cache = {};
// Aggregated results (rebuilt from cache)
let cachedSessions = [];    // array of session info objects (with agentId)
let cachedCounts = {};       // "agentId:filename" -> message count
let cachedDangers = {};      // "agentId:filename" -> danger hits array
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

function cacheKey(agentId, filename) {
  return `${agentId}:${filename}`;
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

// Session metadata from sessions.json (per agent)
function getSessionMeta(agentId) {
  const sessDir = agentDirs[agentId];
  if (!sessDir) return {};
  const metaPath = join(sessDir, "sessions.json");
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

function getAllSessionMeta() {
  const result = {};
  for (const agentId of Object.keys(agentDirs)) {
    result[agentId] = getSessionMeta(agentId);
  }
  return result;
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
async function scanFile(agentId, filename) {
  const sessDir = agentDirs[agentId];
  if (!sessDir) return null;
  const fullPath = join(sessDir, filename);
  let stat;
  try { stat = statSync(fullPath); } catch { return null; }

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
    agentId,
    size: stat.size,
    mtime: stat.mtimeMs,
    createdAt,
    sessionId,
    deleted: filename.includes(".deleted."),
  };

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

      if (line.includes('"type":"message"')) {
        msgCount++;
      }

      if (line.includes("sessions_spawn")) hasSessionsSpawn = true;
      if (line.includes("childSessionKey")) {
        subagentKeys.push(line);
      }

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
  const allMeta = getAllSessionMeta();
  const sessions = [];
  const counts = {};
  const dangers = {};

  for (const [ck, entry] of Object.entries(cache)) {
    const s = { ...entry.session };
    const meta = allMeta[s.agentId] || {};
    const info = resolveStatus(s.filename, meta);
    s.status = info.status;
    s.label = info.label;
    sessions.push(s);
    counts[ck] = entry.msgCount;
    if (entry.dangers.length > 0) dangers[ck] = entry.dangers;
  }

  cachedSessions = sessions;
  cachedCounts = counts;
  cachedDangers = dangers;

  rebuildSubagents(allMeta);
}

function rebuildSubagents(allMeta) {
  if (!allMeta) allMeta = getAllSessionMeta();
  const result = {};

  for (const agentId of Object.keys(agentDirs)) {
    const sessDir = agentDirs[agentId];
    const metaPath = join(sessDir, "sessions.json");
    const files = Object.keys(cache)
      .filter(k => k.startsWith(agentId + ":"))
      .map(k => k.slice(agentId.length + 1))
      .filter(f => f.endsWith(".jsonl"));

    if (existsSync(metaPath)) {
      try {
        const data = JSON.parse(readFileSync(metaPath, "utf-8"));
        for (const [key, val] of Object.entries(data)) {
          if (key.includes("subagent")) {
            const sid = val.sessionId;
            if (sid) {
              const file = files.find(f => f.startsWith(sid));
              if (file) {
                result[`${agentId}:${key}`] = { filename: file, agentId, sessionId: sid, label: val.label || "", parentFilename: null, parentAgentId: agentId };
              }
            }
          }
        }
      } catch {}
    }
  }

  // Find parent files from cached subagentKeys
  const subKeys = Object.keys(result);
  if (subKeys.length > 0) {
    for (const [ck, entry] of Object.entries(cache)) {
      if (!entry.hasSessionsSpawn) continue;
      const [entryAgentId] = ck.split(":", 1);
      for (const line of entry.subagentKeys) {
        for (const sk of subKeys) {
          if (result[sk].parentFilename) continue;
          // Extract the original key (without agentId prefix) for matching
          const origKey = sk.includes(":") ? sk.slice(sk.indexOf(":") + 1) : sk;
          if (line.includes(origKey)) {
            result[sk].parentFilename = entry.session.filename;
            result[sk].parentAgentId = entryAgentId;
          }
        }
      }
    }
  }

  cachedSubagents = result;
}

// Initial full scan across all agents
async function initialScan() {
  const start = Date.now();
  let totalFiles = 0;

  for (const [agentId, sessDir] of Object.entries(agentDirs)) {
    let files;
    try {
      files = readdirSync(sessDir).filter(
        (f) => f.endsWith(".jsonl") || f.includes(".deleted.")
      );
    } catch { continue; }

    console.log(`🔍 Scanning ${files.length} session files for agent "${agentId}"...`);
    totalFiles += files.length;

    const BATCH = 20;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(f => scanFile(agentId, f)));
      for (const result of results) {
        if (result) {
          cache[cacheKey(agentId, result.session.filename)] = result;
        }
      }
    }
  }

  rebuildAggregates();
  console.log(`✅ Cache built in ${Date.now() - start}ms (${totalFiles} files across ${Object.keys(agentDirs).length} agents)`);
}

// Incremental update for a single file
async function updateFile(agentId, filename) {
  const sessDir = agentDirs[agentId];
  if (!sessDir) return;
  const fullPath = join(sessDir, filename);
  const ck = cacheKey(agentId, filename);
  if (!existsSync(fullPath)) {
    delete cache[ck];
  } else {
    const result = await scanFile(agentId, filename);
    if (result) {
      cache[ck] = result;
    }
  }
  rebuildAggregates();
}

// --- Watch ALL agent session dirs ---
const fsWatchers = [];
for (const [agentId, sessDir] of Object.entries(agentDirs)) {
  try {
    const watcher = watch(sessDir, { persistent: true }, (eventType, filename) => {
      if (!filename) return;
      if (filename.endsWith(".jsonl") || filename.includes(".deleted.")) {
        updateFile(agentId, filename).catch(() => {});
        broadcast("file-change", { eventType, filename, agentId });
      }
    });
    fsWatchers.push(watcher);
    console.log(`👁️  Watching ${sessDir} (agent: ${agentId})`);
  } catch (e) {
    console.error(`Cannot watch ${sessDir}: ${e.message}`);
  }
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

  // API: list agents
  if (path === "/api/agents") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Object.keys(agentDirs)));
    return;
  }

  // API: list sessions (from cache) - includes agentId
  if (path === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedSessions));
    return;
  }

  // API: session meta
  if (path === "/api/meta") {
    const allMeta = getAllSessionMeta();
    const result = {};
    for (const [ck, entry] of Object.entries(cache)) {
      const agentId = entry.session.agentId;
      const meta = allMeta[agentId] || {};
      result[ck] = resolveStatus(entry.session.filename, meta);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // API: message counts (from cache) - keyed by agentId:filename
  if (path === "/api/counts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedCounts));
    return;
  }

  // API: danger scan (from cache) - keyed by agentId:filename
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

  // API: read session file - /api/session/:agentId/:filename
  if (path.startsWith("/api/session/")) {
    const rest = decodeURIComponent(path.slice("/api/session/".length));
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      // Backward compat: /api/session/:filename — assume "main" or "custom"
      const filename = rest;
      const agentId = CUSTOM_SESSIONS_DIR ? "custom" : "main";
      const sessDir = agentDirs[agentId];
      if (!sessDir) { res.writeHead(404); res.end("Not found"); return; }
      const fullPath = resolve(sessDir, filename);
      if (!fullPath.startsWith(sessDir) || !existsSync(fullPath)) {
        res.writeHead(404); res.end("Not found"); return;
      }
      readFile(fullPath, "utf-8", (err, content) => {
        if (err) { res.writeHead(500); res.end("Error"); return; }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(content);
      });
      return;
    }
    const agentId = rest.slice(0, slashIdx);
    const filename = rest.slice(slashIdx + 1);
    const sessDir = agentDirs[agentId];
    if (!sessDir) { res.writeHead(404); res.end("Agent not found"); return; }
    const fullPath = resolve(sessDir, filename);
    if (!fullPath.startsWith(sessDir) || !existsSync(fullPath)) {
      res.writeHead(404); res.end("Not found"); return;
    }
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

  // API: read progress (JSONL storage → JSON object API)
  if (path === "/api/progress" && req.method === "GET") {
    const progressPath = join(DATA_DIR, "progress.jsonl");
    // Migrate old progress.json → progress.jsonl
    const oldPath = join(DATA_DIR, "progress.json");
    if (!existsSync(progressPath) && existsSync(oldPath)) {
      try {
        const old = JSON.parse(readFileSync(oldPath, "utf-8"));
        const lines = Object.entries(old)
          .map(([k, v]) => JSON.stringify({ _key: k, ...v }))
          .join("\n");
        writeFileSync(progressPath, lines + "\n", "utf-8");
      } catch {}
    }
    if (!existsSync(progressPath)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    readFile(progressPath, "utf-8", (err, data) => {
      if (err) { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
      const obj = {};
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const key = row._key;
          if (!key) continue;
          delete row._key;
          obj[key] = row;
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    });
    return;
  }

  // API: save progress (JSON object API → JSONL storage)
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
        const obj = JSON.parse(body);
        const progressPath = join(DATA_DIR, "progress.jsonl");
        // Sort keys for stable git diffs
        const lines = Object.entries(obj)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => JSON.stringify({ _key: k, ...v }))
          .join("\n");
        writeFileSync(progressPath, lines + "\n", "utf-8");
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

  // API: pins
  if (path === "/api/pins" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadPins()));
    return;
  }
  if (path === "/api/pins" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const pin = {
          id: crypto.randomUUID(),
          agentId: data.agentId || "",
          filename: data.filename || "",
          msgId: data.msgId || "",
          pinnedAt: new Date().toISOString(),
          note: data.note || "",
          preview: (data.preview || "").substring(0, 500),
          role: data.role || "",
          timestamp: data.timestamp || "",
          sessionLabel: data.sessionLabel || "",
        };
        const pins = loadPins();
        pins.push(pin);
        savePins(pins);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pin));
      } catch {
        res.writeHead(400); res.end("Invalid JSON");
      }
    });
    return;
  }
  if (path.startsWith("/api/pins/") && req.method === "DELETE") {
    const pinId = decodeURIComponent(path.slice("/api/pins/".length));
    const pins = loadPins().filter(p => p.id !== pinId);
    savePins(pins);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  // API: full-text search across all sessions (all agents)
  if (path === "/api/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();
    if (!q || q.length < 2) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    const entries = Object.entries(cache).filter(([k]) => k.endsWith(".jsonl"));
    const matches = [];
    let pending = entries.length;
    if (pending === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    for (const [ck, entry] of entries) {
      const sessDir = agentDirs[entry.session.agentId];
      if (!sessDir) { if (--pending === 0) done(); continue; }
      const fullPath = resolve(sessDir, entry.session.filename);
      if (!fullPath.startsWith(sessDir)) { if (--pending === 0) done(); continue; }
      readFile(fullPath, "utf-8", (err, content) => {
        if (!err && content.toLowerCase().includes(q)) {
          matches.push({ agentId: entry.session.agentId, filename: entry.session.filename });
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
    console.log(`📂 Agents: ${Object.keys(agentDirs).join(", ")}`);
    console.log(`📊 CSV: ${CSV_PATH}`);
    console.log(`💾 Data: ${DATA_DIR}`);
  });
}).catch((err) => {
  console.error("Failed to build cache:", err);
  process.exit(1);
});
