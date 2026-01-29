import { useMemo } from 'react';
import { shortName, formatDate, matchesFilters, sortSessions, progressKey } from '../utils';
import type { SessionRow, Progress, DangerData, Filters } from '../types';

const READ_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: '📬 Unread' },
  { key: 'partial', label: '📖 In Progress' },
  { key: 'done', label: '✅ Reviewed' },
] as const;

const LIFECYCLE_FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'orphan', label: 'Orphan' },
  { key: 'deleted', label: '🗑 Deleted' },
] as const;

const SORTS = [
  { value: 'created-asc', label: 'Created ↑' },
  { value: 'created-desc', label: 'Created ↓' },
  { value: 'updated-asc', label: 'Last msg ↑' },
  { value: 'updated-desc', label: 'Last msg ↓' },
  { value: 'msgs-desc', label: 'Messages ↓' },
  { value: 'msgs-asc', label: 'Messages ↑' },
  { value: 'unread-desc', label: 'Unread ↓' },
  { value: 'unread-asc', label: 'Unread ↑' },
] as const;

function ReasonBadge({ row }: { row: SessionRow }) {
  const reason = (row.Reason || '').toLowerCase();
  if (reason.startsWith('active')) return <span className="badge active">active</span>;
  if (reason.startsWith('soft-deleted') || reason.includes('deleted')) return <span className="badge deleted">deleted</span>;
  if (reason.includes('superseded')) return <span className="badge superseded">superseded</span>;
  if (reason.includes('orphan')) return <span className="badge orphan">orphan</span>;
  if ((row.Disk || '').toUpperCase() === 'DEL') return <span className="badge deleted">deleted</span>;
  return null;
}

function ReadBadge({ pKey, progress }: { pKey: string; progress: Progress }) {
  const p = progress[pKey];
  if (!p || !p.lastReadId) return null;
  if (p.readAll) return <span className="badge read-done">✓</span>;
  return <span className="badge partial">…</span>;
}

function DangerBadge({ filename, dangerData }: { filename: string; dangerData: DangerData }) {
  const dangers = dangerData[filename];
  if (!dangers) return null;
  const crit = dangers.filter(d => d.severity === 'critical').length;
  const warn = dangers.filter(d => d.severity === 'warning').length;
  if (crit > 0) return <span className="badge danger">⚠ {crit + warn}</span>;
  if (warn > 0) return <span className="badge danger-warn">⚠ {warn}</span>;
  return null;
}

interface SidebarProps {
  sessions: SessionRow[];
  progress: Progress;
  dangerData: DangerData;
  currentFile: string | null;
  filters: Filters;
  setFilters: (f: Filters) => void;
  activeSort: string;
  setActiveSort: (s: string) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onSelect: (filename: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  sessions, progress, dangerData, currentFile,
  filters, setFilters, activeSort, setActiveSort,
  searchQuery, setSearchQuery, onSelect, isOpen, onClose
}: SidebarProps) {
  // Count sessions per filter for badges
  const counts = useMemo(() => {
    const c = { all: 0, unread: 0, partial: 0, done: 0, active: 0, orphan: 0, deleted: 0, danger: 0 };
    sessions.forEach(row => {
      const reason = (row.Reason || '').toLowerCase();
      const p = progress[progressKey(row)];
      c.all++;
      if (!p || !p.lastReadId) c.unread++;
      else if (p.readAll) c.done++;
      else c.partial++;
      if (reason.startsWith('active')) c.active++;
      if (reason.includes('orphan')) c.orphan++;
      if (reason.includes('deleted') || (row.Disk || '').toUpperCase() === 'DEL') c.deleted++;
      if (dangerData[row.Filename]) c.danger++;
    });
    return c;
  }, [sessions, progress, dangerData]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const sorted = sortSessions(sessions, activeSort, progress);
    return sorted.filter(r => {
      if (!matchesFilters(r, filters, progress, dangerData)) return false;
      if (!q) return true;
      const cl = progress[progressKey(r)]?.customLabel || '';
      return (r.Filename || '').toLowerCase().includes(q) ||
        (r.Label || '').toLowerCase().includes(q) ||
        cl.toLowerCase().includes(q) ||
        (r.Description || '').toLowerCase().includes(q) ||
        (r.Reason || '').toLowerCase().includes(q);
    });
  }, [sessions, filters, activeSort, searchQuery, progress, dangerData]);

  const toggleLifecycle = (key: string) => {
    const lc = filters.lifecycle.includes(key)
      ? filters.lifecycle.filter(k => k !== key)
      : [...filters.lifecycle, key];
    setFilters({ ...filters, lifecycle: lc });
  };

  return (
    <div className={`sidebar ${isOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-header">
        <h3>🔍 Moltbot Inspector</h3>
        <button className="mobile-back" onClick={onClose}>✕</button>
      </div>
      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Filter sessions..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="sidebar-filters">
        <div className="filter-group">
          <div className="filter-label">Review status</div>
          <div className="filter-row">
            {READ_FILTERS.map(f => (
              <button
                key={f.key}
                className={`filter-btn ${f.key === filters.read ? 'active' : ''}`}
                onClick={() => setFilters({ ...filters, read: f.key as Filters['read'] })}
              >
                {f.label} ({counts[f.key as keyof typeof counts]})
              </button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <div className="filter-label">Session type</div>
          <div className="filter-row">
            {LIFECYCLE_FILTERS.map(f => (
              <button
                key={f.key}
                className={`filter-btn toggle ${filters.lifecycle.includes(f.key) ? 'active' : ''}`}
                onClick={() => toggleLifecycle(f.key)}
              >
                {f.label} ({counts[f.key as keyof typeof counts]})
              </button>
            ))}
          </div>
        </div>
        <div className="filter-row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <label className="danger-checkbox" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: filters.dangerOnly ? '#dc2626' : '#666' }}>
            <input
              type="checkbox"
              checked={filters.dangerOnly}
              onChange={() => setFilters({ ...filters, dangerOnly: !filters.dangerOnly })}
              style={{ accentColor: '#dc2626' }}
            />
            ⚠ Dangerous only ({counts.danger})
          </label>
          <select
            className="sort-select"
            value={activeSort}
            onChange={e => setActiveSort(e.target.value)}
          >
            {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </div>
      <div className="stats">
        {filtered.length !== sessions.length
          ? <span>Showing {filtered.length} of {sessions.length}</span>
          : <span>{sessions.length} sessions</span>}
      </div>
      <div className="session-list">
        {filtered.map(row => {
          const fname = row.Filename;
          const pk = progressKey(row);
          const p = progress[pk];
          const label = p?.customLabel || row.Label || '';
          const totalMsgs = p?.totalMsgs || '';
          const unreadCount = p?.unreadCount ?? 0;
          let dateStr = '';
          if (activeSort.startsWith('updated') && row._lastModified) {
            dateStr = formatDate(new Date(row._lastModified));
          } else if (row._createdAt) {
            dateStr = formatDate(new Date(row._createdAt));
          }

          return (
            <div
              key={fname}
              className={`session-item ${currentFile === fname ? 'selected' : ''}`}
              onClick={() => onSelect(fname)}
            >
              <div className="name">
                <DangerBadge filename={fname} dangerData={dangerData} />
                <ReadBadge pKey={pk} progress={progress} />
                <ReasonBadge row={row} />
                {shortName(fname)}
                {totalMsgs ? <span style={{ fontSize: 11, color: '#999', fontWeight: 400 }}>{totalMsgs} msgs</span> : null}
              </div>
              {label && <div className="label">{label}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                {dateStr && <span style={{ fontSize: 11, color: '#aaa' }}>{dateStr}</span>}
                {unreadCount > 0 && (
                  <span style={{ fontSize: 11, background: '#4f46e5', color: '#fff', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>
                    +{unreadCount}
                  </span>
                )}
              </div>
              {row.Description && <div className="desc">{row.Description}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
