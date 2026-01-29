import type { SessionRow, Progress, DangerData, CSVRow } from './types';

export function formatDate(d: Date): string {
  if (!d || isNaN(d.getTime())) return '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`;
  return `${date} ${time}`;
}

export function progressKey(row: SessionRow | null | undefined): string {
  return row?.SessionId || row?.Filename || '';
}

export function shortName(fname: string): string {
  if (fname.includes('-topic-')) return 'topic-' + fname.split('-topic-')[1].split('.jsonl')[0];
  return fname.substring(0, 8);
}

export function parseCSV(text: string): CSVRow[] {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: CSVRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => row[h] = (vals[idx] || '').replace(/^"|"$/g, ''));
    rows.push(row as unknown as CSVRow);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const r: string[] = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { r.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  r.push(cur.trim());
  return r;
}

export function matchesFilter(row: SessionRow, filterKey: string, progress: Progress, dangerData: DangerData): boolean {
  if (filterKey === 'all') return true;
  const reason = (row.Reason || '').toLowerCase();
  const p = progress[progressKey(row)];

  if (filterKey === 'unread') return !p || !p.lastReadId;
  if (filterKey === 'partial') return !!p && !!p.lastReadId && !p.readAll;
  if (filterKey === 'done') return !!p && !!p.readAll;
  if (filterKey === 'active') return reason.startsWith('active');
  if (filterKey === 'orphan') return reason.includes('orphan');
  if (filterKey === 'deleted') return reason.includes('deleted') || (row.Disk || '').toUpperCase() === 'DEL';
  if (filterKey === 'danger') return !!dangerData[row.Filename];
  return true;
}

import type { Filters } from './types';

export function matchesFilters(row: SessionRow, filters: Filters, progress: Progress, dangerData: DangerData): boolean {
  const reason = (row.Reason || '').toLowerCase();
  const p = progress[progressKey(row)];

  // Read progress filter
  if (filters.read === 'unread' && p?.lastReadId) return false;
  if (filters.read === 'partial' && (!p || !p.lastReadId || p.readAll)) return false;
  if (filters.read === 'done' && (!p || !p.readAll)) return false;

  // Lifecycle filter (empty = show all)
  if (filters.lifecycle.length > 0) {
    const isActive = reason.startsWith('active');
    const isOrphan = reason.includes('orphan');
    const isDeleted = reason.includes('deleted') || (row.Disk || '').toUpperCase() === 'DEL';
    const matchesAny = (filters.lifecycle.includes('active') && isActive) ||
      (filters.lifecycle.includes('orphan') && isOrphan) ||
      (filters.lifecycle.includes('deleted') && isDeleted);
    if (!matchesAny) return false;
  }

  // Danger filter
  if (filters.dangerOnly && !dangerData[row.Filename]) return false;

  return true;
}

export function sortSessions(sessions: SessionRow[], sortKey: string, progress: Progress): SessionRow[] {
  const sorted = [...sessions];
  sorted.sort((a, b) => {
    if (sortKey.startsWith('created')) {
      const da = a._createdAt ? new Date(a._createdAt).getTime() : 0;
      const db = b._createdAt ? new Date(b._createdAt).getTime() : 0;
      return sortKey === 'created-asc' ? da - db : db - da;
    } else if (sortKey.startsWith('updated')) {
      const da = a._lastModified || 0;
      const db = b._lastModified || 0;
      return sortKey === 'updated-asc' ? da - db : db - da;
    } else if (sortKey.startsWith('msgs')) {
      const da = progress[progressKey(a)]?.totalMsgs || 0;
      const db = progress[progressKey(b)]?.totalMsgs || 0;
      return sortKey === 'msgs-desc' ? db - da : da - db;
    } else if (sortKey.startsWith('unread')) {
      const da = progress[progressKey(a)]?.unreadCount || 0;
      const db = progress[progressKey(b)]?.unreadCount || 0;
      return sortKey === 'unread-desc' ? db - da : da - db;
    }
    return 0;
  });
  return sorted;
}
