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
