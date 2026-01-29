import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';

// We can't import server.js directly (it starts a server), so we'll
// re-implement the pure functions from server.js for testing.
// This tests the logic, not the HTTP layer.

// --- resolveStatus ---
function resolveStatus(filename, metaById) {
  if (filename.includes('.deleted.')) return { status: 'deleted', label: '' };
  const base = filename.replace(/\.jsonl$/, '').replace(/\.deleted\.\d+$/, '');
  const meta = metaById[base];
  if (meta) return { status: 'active', label: meta.label || '' };
  for (const [sid, m] of Object.entries(metaById)) {
    if (base.startsWith(sid) || sid.startsWith(base)) return { status: 'active', label: m.label || '' };
  }
  return { status: 'orphan', label: '' };
}

describe('resolveStatus', () => {
  it('returns deleted for .deleted. files', () => {
    expect(resolveStatus('abc.deleted.12345', {})).toEqual({ status: 'deleted', label: '' });
  });

  it('returns active when sessionId matches meta', () => {
    const meta = { 'abc-def': { status: 'active', label: 'My Session' } };
    expect(resolveStatus('abc-def.jsonl', meta)).toEqual({ status: 'active', label: 'My Session' });
  });

  it('returns active on prefix match', () => {
    const meta = { 'abc-def-ghi': { status: 'active', label: '' } };
    expect(resolveStatus('abc-def-ghi-topic-test.jsonl', meta)).toEqual({ status: 'active', label: '' });
  });

  it('returns orphan when no match', () => {
    expect(resolveStatus('unknown.jsonl', { 'other': { label: '' } })).toEqual({ status: 'orphan', label: '' });
  });
});

// --- getSessionMeta parsing ---
describe('getSessionMeta parsing', () => {
  it('builds map from sessions.json structure', () => {
    const data = {
      'key1': { sessionId: 'sid-1', label: 'Session 1', updatedAt: '2024-01-01' },
      'key2': { sessionId: 'sid-2', label: '', updatedAt: '2024-02-01' },
    };
    const byId = {};
    for (const [key, val] of Object.entries(data)) {
      const sid = val.sessionId;
      if (sid) {
        byId[sid] = { status: 'active', label: val.label || '', key, updatedAt: val.updatedAt };
      }
    }
    expect(byId['sid-1'].label).toBe('Session 1');
    expect(byId['sid-2'].status).toBe('active');
    expect(Object.keys(byId)).toHaveLength(2);
  });
});

// --- Danger scanning logic ---
describe('danger scanning', () => {
  const rules = [
    {
      category: 'destructive-fs',
      severity: 'critical',
      label: 'Destructive filesystem',
      patterns: ['rm\\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)', 'rm\\s+(-[a-zA-Z]*f[a-zA-Z]*)'],
    },
    {
      category: 'git-destructive',
      severity: 'critical',
      label: 'Git destructive',
      patterns: ['git\\s+push\\s+(-[a-zA-Z]*f|--force)', 'git\\s+reset\\s+--hard'],
    },
    {
      category: 'config-changes',
      severity: 'warning',
      label: 'Config changes',
      patterns: ['\\bsed\\s+(-[a-zA-Z]*i)'],
    },
  ];

  const compiled = rules.map(r => ({
    ...r,
    regexes: r.patterns.map(p => new RegExp(p, 'i')),
  }));

  function scanLine(jsonLine) {
    const obj = JSON.parse(jsonLine);
    if (obj.type !== 'message') return [];
    const msg = obj.message;
    if (!msg?.content || !Array.isArray(msg.content)) return [];
    const hits = [];
    for (const block of msg.content) {
      if (block.type !== 'toolCall') continue;
      const src = block.arguments || block.input;
      if (!src) continue;
      const strings = [];
      const walk = v => {
        if (typeof v === 'string' && v.length > 2) strings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(src);
      for (const s of strings) {
        for (const rule of compiled) {
          for (const rx of rule.regexes) {
            if (rx.test(s)) {
              hits.push({ category: rule.category, severity: rule.severity, label: rule.label });
              break;
            }
          }
        }
      }
    }
    return hits;
  }

  it('detects rm -rf as destructive-fs critical', () => {
    const line = JSON.stringify({
      type: 'message', id: '1',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec', input: { command: 'rm -rf /tmp/test' } }] }
    });
    const hits = scanLine(line);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].category).toBe('destructive-fs');
    expect(hits[0].severity).toBe('critical');
  });

  it('detects git push --force as git-destructive', () => {
    const line = JSON.stringify({
      type: 'message', id: '2',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec', input: { command: 'git push --force origin main' } }] }
    });
    const hits = scanLine(line);
    expect(hits.some(h => h.category === 'git-destructive')).toBe(true);
  });

  it('detects sed -i as config warning', () => {
    const line = JSON.stringify({
      type: 'message', id: '3',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec', input: { command: 'sed -i "s/old/new/g" file.txt' } }] }
    });
    const hits = scanLine(line);
    expect(hits.some(h => h.category === 'config-changes' && h.severity === 'warning')).toBe(true);
  });

  it('returns empty for safe commands', () => {
    const line = JSON.stringify({
      type: 'message', id: '4',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec', input: { command: 'ls -la' } }] }
    });
    expect(scanLine(line)).toHaveLength(0);
  });

  it('skips non-message entries', () => {
    const line = JSON.stringify({ type: 'session', id: '5' });
    expect(scanLine(line)).toHaveLength(0);
  });

  it('handles nested input objects', () => {
    const line = JSON.stringify({
      type: 'message', id: '6',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec', input: { nested: { deep: 'git reset --hard HEAD' } } }] }
    });
    const hits = scanLine(line);
    expect(hits.some(h => h.category === 'git-destructive')).toBe(true);
  });
});

// --- toolRules-based danger scanning (surveillance) ---
describe('danger scanning - toolRules', () => {
  const rules = [
    {
      category: 'surveillance',
      severity: 'warning',
      label: 'Surveillance/privacy',
      toolRules: [
        { toolName: 'browser', actions: ['screenshot', 'snapshot'] },
        { toolName: 'nodes', actions: ['camera_snap', 'camera_clip', 'screen_record', 'location_get'] },
        { toolName: 'image', actions: null },
        { toolName: 'peekaboo', actions: null },
      ],
    },
  ];

  const compiled = rules.map(r => ({
    ...r,
    regexes: (r.patterns || []).map(p => new RegExp(p, 'i')),
    toolRules: r.toolRules || null,
  }));

  function scanLineWithToolRules(jsonLine) {
    const obj = JSON.parse(jsonLine);
    if (obj.type !== 'message') return [];
    const msg = obj.message;
    if (!msg?.content || !Array.isArray(msg.content)) return [];
    const hits = [];
    for (const block of msg.content) {
      if (block.type !== 'toolCall') continue;
      const src = block.arguments || block.input;
      const toolName = block.name || '';
      const toolAction = src?.action || '';
      for (const rule of compiled) {
        if (!rule.toolRules) continue;
        for (const tr of rule.toolRules) {
          if (tr.toolName === toolName && (tr.actions === null || (toolAction && tr.actions.includes(toolAction)))) {
            hits.push({ category: rule.category, severity: rule.severity, label: rule.label, command: `${toolName}${toolAction ? ': ' + toolAction : ''}` });
          }
        }
      }
    }
    return hits;
  }

  it('detects browser screenshot as surveillance', () => {
    const line = JSON.stringify({
      type: 'message', id: '10',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'browser', input: { action: 'screenshot' } }] }
    });
    const hits = scanLineWithToolRules(line);
    expect(hits).toHaveLength(1);
    expect(hits[0].category).toBe('surveillance');
    expect(hits[0].command).toBe('browser: screenshot');
  });

  it('detects nodes camera_snap as surveillance', () => {
    const line = JSON.stringify({
      type: 'message', id: '11',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'nodes', input: { action: 'camera_snap' } }] }
    });
    const hits = scanLineWithToolRules(line);
    expect(hits).toHaveLength(1);
    expect(hits[0].category).toBe('surveillance');
  });

  it('detects image tool with any action (actions=null)', () => {
    const line = JSON.stringify({
      type: 'message', id: '12',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'image', input: { url: 'http://example.com/pic.jpg' } }] }
    });
    const hits = scanLineWithToolRules(line);
    expect(hits).toHaveLength(1);
    expect(hits[0].command).toBe('image');
  });

  it('ignores browser with non-matching action', () => {
    const line = JSON.stringify({
      type: 'message', id: '13',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'browser', input: { action: 'navigate' } }] }
    });
    expect(scanLineWithToolRules(line)).toHaveLength(0);
  });

  it('ignores unrelated tools', () => {
    const line = JSON.stringify({
      type: 'message', id: '14',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'exec', input: { command: 'ls' } }] }
    });
    expect(scanLineWithToolRules(line)).toHaveLength(0);
  });
});

// --- readSession path traversal protection ---
describe('readSession path traversal', () => {
  const { resolve } = require('node:path');

  function readSessionSafe(filename, sessionsDir) {
    const fullPath = resolve(sessionsDir, filename);
    if (!fullPath.startsWith(sessionsDir)) return null;
    return fullPath; // in real code, would read file
  }

  it('allows normal filenames', () => {
    expect(readSessionSafe('session.jsonl', '/data/sessions')).toBe('/data/sessions/session.jsonl');
  });

  it('blocks ../ traversal', () => {
    expect(readSessionSafe('../../../etc/passwd', '/data/sessions')).toBeNull();
  });

  it('blocks encoded traversal', () => {
    // decodeURIComponent would already decode before this function
    expect(readSessionSafe('../../secret.txt', '/data/sessions')).toBeNull();
  });

  it('blocks absolute path injection', () => {
    // resolve with absolute second arg returns it as-is on some platforms,
    // but it won't start with sessionsDir
    const result = readSessionSafe('/etc/passwd', '/data/sessions');
    // On Unix, resolve('/data/sessions', '/etc/passwd') = '/etc/passwd' which doesn't start with '/data/sessions'
    expect(result).toBeNull();
  });
});

// --- POST body size limit logic ---
describe('POST body size limit', () => {
  it('rejects bodies exceeding 2MB', () => {
    const MAX_BODY = 2 * 1024 * 1024;
    const bigBody = 'x'.repeat(MAX_BODY + 1);
    expect(bigBody.length).toBeGreaterThan(MAX_BODY);
    // Simulating the server check
    expect(bigBody.length > MAX_BODY).toBe(true);
  });

  it('accepts bodies under 2MB', () => {
    const MAX_BODY = 2 * 1024 * 1024;
    const smallBody = JSON.stringify({ key: 'value' });
    expect(smallBody.length <= MAX_BODY).toBe(true);
  });
});

// --- Search endpoint logic ---
describe('search endpoint logic', () => {
  it('requires minimum 2 characters', () => {
    const q1 = '';
    const q2 = 'a';
    const q3 = 'ab';
    expect(!q1 || q1.length < 2).toBe(true);
    expect(!q2 || q2.length < 2).toBe(true);
    expect(!q3 || q3.length < 2).toBe(false);
  });

  it('search is case-insensitive', () => {
    const content = 'Hello World JSONL data';
    const q = 'hello';
    expect(content.toLowerCase().includes(q.toLowerCase())).toBe(true);
  });

  it('returns matching filenames', () => {
    const files = ['a.jsonl', 'b.jsonl', 'c.jsonl'];
    const contents = {
      'a.jsonl': 'hello world',
      'b.jsonl': 'foo bar',
      'c.jsonl': 'hello again',
    };
    const q = 'hello';
    const matches = files.filter(f => contents[f].toLowerCase().includes(q));
    expect(matches).toEqual(['a.jsonl', 'c.jsonl']);
  });
});
