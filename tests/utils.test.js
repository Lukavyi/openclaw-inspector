import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatDate, shortName, progressKey, parseCSV, matchesFilter, sortSessions } from '../src/utils.js';

// --- formatDate ---
describe('formatDate', () => {
  it('returns empty string for falsy/invalid input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate(new Date('invalid'))).toBe('');
  });

  it('returns time only for today', () => {
    const now = new Date();
    now.setHours(14, 30, 0, 0);
    expect(formatDate(now)).toBe('14:30');
  });

  it('returns dd.mm HH:MM for same year but different day', () => {
    const now = new Date();
    const d = new Date(now.getFullYear(), 0, 5, 9, 5);
    // Skip if Jan 5 is today
    if (d.toDateString() === now.toDateString()) return;
    expect(formatDate(d)).toBe('05.01 09:05');
  });

  it('returns dd.mm.yyyy HH:MM for different year', () => {
    const d = new Date(2020, 5, 15, 18, 45);
    expect(formatDate(d)).toBe('15.06.2020 18:45');
  });
});

// --- shortName ---
describe('shortName', () => {
  it('extracts topic name from topic filenames', () => {
    expect(shortName('abc123-topic-my-cool-topic.jsonl')).toBe('topic-my-cool-topic');
  });

  it('returns first 8 chars for regular filenames', () => {
    expect(shortName('abcdefghijklmnop.jsonl')).toBe('abcdefgh');
  });
});

// --- progressKey ---
describe('progressKey', () => {
  it('returns SessionId when present', () => {
    expect(progressKey({ SessionId: 'sid-123', Filename: 'f.jsonl' })).toBe('sid-123');
  });

  it('falls back to Filename', () => {
    expect(progressKey({ Filename: 'f.jsonl' })).toBe('f.jsonl');
  });

  it('returns empty string for null/undefined', () => {
    expect(progressKey(null)).toBe('');
    expect(progressKey(undefined)).toBe('');
  });
});

// --- parseCSV ---
describe('parseCSV', () => {
  it('parses normal CSV', () => {
    const csv = 'Name,Age\nAlice,30\nBob,25';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe('Alice');
    expect(rows[1].Age).toBe('25');
  });

  it('handles quoted fields', () => {
    const csv = 'Name,Desc\nAlice,"Hello, world"\nBob,"Test"';
    const rows = parseCSV(csv);
    expect(rows[0].Desc).toBe('Hello, world');
  });

  it('returns empty for empty/header-only input', () => {
    expect(parseCSV('')).toEqual([]);
    expect(parseCSV('Name,Age')).toEqual([]);
  });

  it('skips blank lines', () => {
    const csv = 'A,B\n1,2\n\n3,4';
    expect(parseCSV(csv)).toHaveLength(2);
  });
});

// --- matchesFilter ---
describe('matchesFilter', () => {
  const base = { Filename: 'test.jsonl', SessionId: 'sid', Reason: '', Disk: '' };
  const prog = {};

  it('all returns true', () => {
    expect(matchesFilter(base, 'all', prog, {})).toBe(true);
  });

  it('unread: no progress = unread', () => {
    expect(matchesFilter(base, 'unread', {}, {})).toBe(true);
    expect(matchesFilter(base, 'unread', { sid: { lastReadId: 'x' } }, {})).toBe(false);
  });

  it('partial: has lastReadId but not readAll', () => {
    expect(matchesFilter(base, 'partial', { sid: { lastReadId: 'x' } }, {})).toBe(true);
    expect(matchesFilter(base, 'partial', { sid: { lastReadId: 'x', readAll: true } }, {})).toBe(false);
  });

  it('done: readAll is true', () => {
    expect(matchesFilter(base, 'done', { sid: { readAll: true } }, {})).toBe(true);
    expect(matchesFilter(base, 'done', {}, {})).toBeFalsy();
  });

  it('active: reason starts with active', () => {
    expect(matchesFilter({ ...base, Reason: 'active' }, 'active', prog, {})).toBe(true);
    expect(matchesFilter({ ...base, Reason: 'orphan' }, 'active', prog, {})).toBe(false);
  });

  it('orphan', () => {
    expect(matchesFilter({ ...base, Reason: 'orphan' }, 'orphan', prog, {})).toBe(true);
    expect(matchesFilter(base, 'orphan', prog, {})).toBe(false);
  });

  it('deleted: reason or Disk=DEL', () => {
    expect(matchesFilter({ ...base, Reason: 'deleted' }, 'deleted', prog, {})).toBe(true);
    expect(matchesFilter({ ...base, Disk: 'DEL' }, 'deleted', prog, {})).toBe(true);
    expect(matchesFilter(base, 'deleted', prog, {})).toBe(false);
  });

  it('danger: has danger data', () => {
    expect(matchesFilter(base, 'danger', prog, { 'test.jsonl': [{ severity: 'critical' }] })).toBe(true);
    expect(matchesFilter(base, 'danger', prog, {})).toBe(false);
  });
});

// --- sortSessions ---
describe('sortSessions', () => {
  const sessions = [
    { _createdAt: '2024-01-01', _lastModified: 100, SessionId: 'a', Filename: 'a.jsonl' },
    { _createdAt: '2024-06-01', _lastModified: 300, SessionId: 'b', Filename: 'b.jsonl' },
    { _createdAt: '2024-03-01', _lastModified: 200, SessionId: 'c', Filename: 'c.jsonl' },
  ];
  const progress = {
    a: { totalMsgs: 10, unreadCount: 5 },
    b: { totalMsgs: 3, unreadCount: 0 },
    c: { totalMsgs: 7, unreadCount: 2 },
  };

  it('created-asc', () => {
    const r = sortSessions(sessions, 'created-asc', progress);
    expect(r[0].SessionId).toBe('a');
    expect(r[2].SessionId).toBe('b');
  });

  it('created-desc', () => {
    const r = sortSessions(sessions, 'created-desc', progress);
    expect(r[0].SessionId).toBe('b');
  });

  it('updated-asc', () => {
    const r = sortSessions(sessions, 'updated-asc', progress);
    expect(r[0]._lastModified).toBe(100);
  });

  it('updated-desc', () => {
    const r = sortSessions(sessions, 'updated-desc', progress);
    expect(r[0]._lastModified).toBe(300);
  });

  it('msgs-desc', () => {
    const r = sortSessions(sessions, 'msgs-desc', progress);
    expect(r[0].SessionId).toBe('a');
  });

  it('msgs-asc', () => {
    const r = sortSessions(sessions, 'msgs-asc', progress);
    expect(r[0].SessionId).toBe('b');
  });

  it('unread-desc', () => {
    const r = sortSessions(sessions, 'unread-desc', progress);
    expect(r[0].SessionId).toBe('a');
  });

  it('unread-asc', () => {
    const r = sortSessions(sessions, 'unread-asc', progress);
    expect(r[0].SessionId).toBe('b');
  });

  it('does not mutate original array', () => {
    const copy = [...sessions];
    sortSessions(sessions, 'created-desc', progress);
    expect(sessions).toEqual(copy);
  });
});
