#!/usr/bin/env node
// Session Viewer Server — serves UI + watches JSONL files via SSE
import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, watch, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { homedir } from "node:os";

const PORT = parseInt(process.env.PORT || "9100", 10);
const SESSIONS_DIR =
  process.env.SESSIONS_DIR ||
  join(homedir(), ".clawdbot", "agents", "main", "sessions");
const PROJECT_DIR = new URL(".", import.meta.url).pathname;
const STATIC_DIR = join(new URL(".", import.meta.url).pathname, "dist");
const DATA_DIR = process.env.DATA_DIR || join(homedir(), ".moltbot-inspector");

// Ensure data dir exists and seed defaults
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`⚠️  Cannot create data dir ${DATA_DIR}: ${e.message}`);
  console.error("   Set DATA_DIR env to a writable path.");
  process.exit(1);
}
const defaultRulesPath = join(PROJECT_DIR, "danger-rules.json");
const userRulesPath = join(DATA_DIR, "danger-rules.json");
if (!existsSync(userRulesPath) && existsSync(defaultRulesPath)) {
  copyFileSync(defaultRulesPath, userRulesPath);
}
const CSV_PATH =
  process.env.CSV_PATH || join(new URL(".", import.meta.url).pathname, "sessions_table.csv");

// --- SSE clients ---
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

// --- Watch sessions dir ---
let fsWatcher;
try {
  fsWatcher = watch(SESSIONS_DIR, { persistent: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.endsWith(".jsonl") || filename.includes(".deleted.")) {
      broadcast("file-change", { eventType, filename });
    }
  });
  console.log(`👁️  Watching ${SESSIONS_DIR}`);
} catch (e) {
  console.error(`Cannot watch ${SESSIONS_DIR}: ${e.message}`);
}

// --- API ---
function listSessions() {
  const files = readdirSync(SESSIONS_DIR).filter(
    (f) => f.endsWith(".jsonl") || f.includes(".deleted.")
  );
  return files.map((f) => {
    const fullPath = join(SESSIONS_DIR, f);
    const stat = statSync(fullPath);
    // Read first line to get session timestamp and sessionId
    let createdAt = null;
    let sessionId = null;
    try {
      const content = readFileSync(fullPath, "utf-8");
      const firstLine = content.split("\n")[0];
      const obj = JSON.parse(firstLine);
      if (obj.type === "session") {
        if (obj.timestamp) createdAt = obj.timestamp;
        sessionId = obj.sessionId || obj.id || null;
      }
    } catch {}
    return {
      filename: f,
      size: stat.size,
      mtime: stat.mtimeMs,
      createdAt,
      sessionId,
      deleted: f.includes(".deleted."),
    };
  });
}

function readSession(filename) {
  // Sanitize — resolve and verify path stays inside SESSIONS_DIR
  const fullPath = resolve(SESSIONS_DIR, filename);
  if (!fullPath.startsWith(SESSIONS_DIR)) return null;
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf-8");
}

function readCSV() {
  if (!existsSync(CSV_PATH)) return null;
  return readFileSync(CSV_PATH, "utf-8");
}

// --- Session status from sessions.json ---
function getSessionMeta() {
  const metaPath = join(SESSIONS_DIR, "sessions.json");
  if (!existsSync(metaPath)) return {};
  try {
    const data = JSON.parse(readFileSync(metaPath, "utf-8"));
    // Build map: sessionId -> { status, label, key }
    const byId = {};
    for (const [key, val] of Object.entries(data)) {
      const sid = val.sessionId;
      if (sid) {
        byId[sid] = {
          status: "active",
          label: val.label || "",
          key,
          updatedAt: val.updatedAt,
        };
      }
    }
    return byId;
  } catch { return {}; }
}

function resolveStatus(filename, metaById) {
  if (filename.includes(".deleted.")) return { status: "deleted", label: "" };
  // Extract sessionId from filename (UUID part before -topic or .jsonl)
  const base = filename.replace(/\.jsonl$/, "").replace(/\.deleted\.\d+$/, "");
  const meta = metaById[base];
  if (meta) return { status: "active", label: meta.label || "" };
  // Try matching by sessionId prefix
  for (const [sid, m] of Object.entries(metaById)) {
    if (base.startsWith(sid) || sid.startsWith(base)) return { status: "active", label: m.label || "" };
  }
  return { status: "orphan", label: "" };
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

  // API: list sessions (now includes status + label)
  if (path === "/api/sessions") {
    const sessions = listSessions();
    const meta = getSessionMeta();
    for (const s of sessions) {
      const info = resolveStatus(s.filename, meta);
      s.status = info.status;
      s.label = info.label;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return;
  }

  // API: session meta (status + labels)
  if (path === "/api/meta") {
    const files = readdirSync(SESSIONS_DIR).filter(
      (f) => f.endsWith(".jsonl") || f.includes(".deleted.")
    );
    const meta = getSessionMeta();
    const result = {};
    for (const f of files) {
      result[f] = resolveStatus(f, meta);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // API: message counts for all sessions
  if (path === "/api/counts") {
    const files = readdirSync(SESSIONS_DIR).filter(
      (f) => f.endsWith(".jsonl") || f.includes(".deleted.")
    );
    const counts = {};
    for (const f of files) {
      try {
        const content = readFileSync(join(SESSIONS_DIR, f), "utf-8");
        let total = 0;
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "message") total++;
          } catch {}
        }
        counts[f] = total;
      } catch {}
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }

  // API: danger scan
  if (path === "/api/danger") {
    const rulesPath = existsSync(userRulesPath) ? userRulesPath : join(PROJECT_DIR, "danger-rules.json");
    if (!existsSync(rulesPath)) {
      res.writeHead(404);
      res.end("No rules");
      return;
    }
    const rules = JSON.parse(readFileSync(rulesPath, "utf-8")).rules;
    const compiled = rules.map((r) => ({
      ...r,
      regexes: (r.patterns || []).map((p) => new RegExp(p, "i")),
      toolRules: r.toolRules || null,
    }));

    const files = readdirSync(SESSIONS_DIR).filter(
      (f) => f.endsWith(".jsonl") || f.includes(".deleted.")
    );
    const results = {};
    for (const f of files) {
      const hits = [];
      try {
        const content = readFileSync(join(SESSIONS_DIR, f), "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type !== "message") continue;
          const msg = obj.message;
          if (!msg || !msg.content || !Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            // Check ALL string values in toolCall arguments/input recursively
            if (block.type === "toolCall") {
              const src = block.arguments || block.input;
              const toolName = block.name || "";
              const toolAction = src?.action || "";

              // Tool-based rules (surveillance etc.)
              for (const rule of compiled) {
                if (!rule.toolRules) continue;
                for (const tr of rule.toolRules) {
                  if (tr.toolName === toolName && (tr.actions === null || (toolAction && tr.actions.includes(toolAction)))) {
                    hits.push({
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
              // Collect all string values from the object tree
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
                for (const rule of compiled) {
                  if (rule.toolRules) continue; // skip tool-based rules here
                  if (matched.has(rule.category + s)) continue;
                  for (const rx of rule.regexes) {
                    if (rx.test(s)) {
                      matched.add(rule.category + s);
                      hits.push({
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
          }
        }
      } catch {}
      if (hits.length > 0) results[f] = hits;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
    return;
  }

  // API: read session file
  if (path.startsWith("/api/session/")) {
    const filename = decodeURIComponent(path.slice("/api/session/".length));
    const content = readSession(filename);
    if (content === null) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(content);
    return;
  }

  // API: CSV metadata
  if (path === "/api/csv") {
    const csv = readCSV();
    if (csv === null) {
      res.writeHead(404);
      res.end("No CSV");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/csv" });
    res.end(csv);
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(readFileSync(progressPath, "utf-8"));
    return;
  }

  // API: save progress
  if (path === "/api/progress" && req.method === "POST") {
    const MAX_BODY = 2 * 1024 * 1024; // 2MB
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) { res.writeHead(413); res.end("Payload too large"); return; }
      try {
        JSON.parse(body); // validate
        const progressPath = join(DATA_DIR, "progress.json");
        writeFileSync(progressPath, body, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
      }
    });
    return;
  }

  // Static files — with path traversal protection
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
server.listen(PORT, HOST, () => {
  console.log(`🖥️  Session Viewer: http://localhost:${PORT}`);
  console.log(`📂 Sessions: ${SESSIONS_DIR}`);
  console.log(`📊 CSV: ${CSV_PATH}`);
  console.log(`💾 Data: ${DATA_DIR}`);
});
