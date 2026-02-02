import { useMemo, useCallback, useRef, useEffect } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { shortName, formatDate, matchesFilters, sortSessions, progressKey } from '../utils';
import type { SessionRow, Progress, DangerData, Filters } from '../types';
import type { SubagentInfo } from '../api';

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
  contentMatches: Set<string> | null;
  subagentMap: Record<string, SubagentInfo>;
  onSelect: (filename: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({
  sessions, progress, dangerData, currentFile,
  filters, setFilters, activeSort, setActiveSort,
  searchQuery, setSearchQuery, contentMatches, subagentMap, onSelect, isOpen, onClose
}: SidebarProps) {
  // Build maps for tree view: subagent filename set + parent→children mapping
  const { subagentFilenames, childrenByParent } = useMemo(() => {
    const fnames = new Set<string>();
    const byParent = new Map<string, SubagentInfo[]>();
    for (const info of Object.values(subagentMap)) {
      fnames.add(info.filename);
      if (info.parentFilename) {
        const arr = byParent.get(info.parentFilename) || [];
        arr.push(info);
        byParent.set(info.parentFilename, arr);
      }
    }
    return { subagentFilenames: fnames, childrenByParent: byParent };
  }, [subagentMap]);
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

  // Items: parent sessions + their subagent children interleaved
  type SidebarItem = { type: 'session'; row: SessionRow } | { type: 'subagent'; info: SubagentInfo; row: SessionRow };

  const filtered = useMemo((): SidebarItem[] => {
    const q = searchQuery.toLowerCase();
    const sorted = sortSessions(sessions, activeSort, progress);
    const sessionMap = new Map<string, SessionRow>();
    sessions.forEach(r => sessionMap.set(r.Filename, r));

    const items: SidebarItem[] = [];
    for (const r of sorted) {
      // Skip subagent sessions from main list (they appear as children)
      if (subagentFilenames.has(r.Filename)) continue;
      if (!matchesFilters(r, filters, progress, dangerData)) continue;
      if (q) {
        const cl = progress[progressKey(r)]?.customLabel || '';
        const localMatch = (r.Filename || '').toLowerCase().includes(q) ||
          (r.Label || '').toLowerCase().includes(q) ||
          cl.toLowerCase().includes(q) ||
          (r.Description || '').toLowerCase().includes(q) ||
          (r.Reason || '').toLowerCase().includes(q);
        if (!localMatch && !(contentMatches && contentMatches.has(r.Filename))) continue;
      }
      items.push({ type: 'session', row: r });
      // Add children subagents right after parent
      const children = childrenByParent.get(r.Filename);
      if (children) {
        for (const child of children) {
          const childRow = sessionMap.get(child.filename);
          if (childRow) {
            items.push({ type: 'subagent', info: child, row: childRow });
          }
        }
      }
    }
    return items;
  }, [sessions, filters, activeSort, searchQuery, progress, dangerData, contentMatches, subagentFilenames, childrenByParent]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const initialScrollDone = useRef(false);

  // Scroll to selected session on mount
  useEffect(() => {
    if (initialScrollDone.current || !currentFile || filtered.length === 0) return;
    const idx = filtered.findIndex(item => item.row.Filename === currentFile);
    if (idx >= 0) {
      initialScrollDone.current = true;
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'auto' });
      }, 100);
    }
  }, [filtered, currentFile]);

  const toggleLifecycle = (key: string) => {
    const lc = filters.lifecycle.includes(key)
      ? filters.lifecycle.filter(k => k !== key)
      : [...filters.lifecycle, key];
    setFilters({ ...filters, lifecycle: lc });
  };

  const itemContent = useCallback((index: number) => {
    const item = filtered[index];
    if (!item) return null;
    const row = item.row;
    const fname = row.Filename;
    const pk = progressKey(row);
    const p = progress[pk];
    const isSubagent = item.type === 'subagent';
    const label = isSubagent
      ? (item as { type: 'subagent'; info: SubagentInfo; row: SessionRow }).info.label || ''
      : p?.customLabel || row.Label || '';
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
        className={`session-item ${currentFile === fname ? 'selected' : ''} ${isSubagent ? 'subagent-child' : ''}`}
        onClick={() => onSelect(fname)}
      >
        <div className="name">
          {isSubagent && <span className="subagent-tree-icon">🚀</span>}
          <DangerBadge filename={fname} dangerData={dangerData} />
          <ReadBadge pKey={pk} progress={progress} />
          {!isSubagent && <ReasonBadge row={row} />}
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
  }, [filtered, progress, dangerData, currentFile, activeSort, onSelect]);

  return (
    <div className={`sidebar ${isOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-header">
        <h3>🔍 OpenClaw Inspector</h3>
        <button className="mobile-back" onClick={onClose}>✕</button>
      </div>
      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Filter sessions..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {searchQuery && <button className="search-clear" onClick={() => setSearchQuery('')}>✕</button>}
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
        {(() => {
          const parentCount = filtered.filter(i => i.type === 'session').length;
          const totalParent = sessions.filter(r => !subagentFilenames.has(r.Filename)).length;
          return parentCount !== totalParent
            ? <span>Showing {parentCount} of {totalParent}</span>
            : <span>{totalParent} sessions</span>;
        })()}
      </div>
      <div className="session-list">
        <Virtuoso
          ref={virtuosoRef}
          totalCount={filtered.length}
          itemContent={itemContent}
          overscan={200}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  );
}
