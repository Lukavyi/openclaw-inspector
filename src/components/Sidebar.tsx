import { useMemo, useCallback, useRef, useEffect } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { shortName, formatDate, formatDateFull, matchesFilters, sortSessions, progressKey, fileCacheKey } from '../utils';
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

// Deterministic colors for agent badges
const AGENT_COLORS: Record<string, string> = {};
const PALETTE = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16'];
function agentColor(agentId: string): string {
  if (!AGENT_COLORS[agentId]) {
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
    AGENT_COLORS[agentId] = PALETTE[Math.abs(hash) % PALETTE.length];
  }
  return AGENT_COLORS[agentId];
}

function AgentBadge({ agentId }: { agentId: string }) {
  return (
    <span
      className="badge"
      style={{
        background: agentColor(agentId),
        color: '#fff',
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 6,
        fontWeight: 600,
        letterSpacing: 0.3,
      }}
      title={`Agent: ${agentId}`}
    >
      {agentId}
    </span>
  );
}

function ReasonBadge({ row }: { row: SessionRow }) {
  const reason = (row.Reason || '').toLowerCase();
  if (reason.startsWith('active')) return <span className="badge active">active</span>;
  if (reason.startsWith('soft-deleted') || reason.includes('deleted')) return <span className="badge deleted">deleted</span>;
  if (reason.includes('superseded')) return <span className="badge superseded">superseded</span>;
  if (reason.includes('orphan')) return <span className="badge orphan">orphan</span>;
  if ((row.Disk || '').toUpperCase() === 'DEL') return <span className="badge deleted">deleted</span>;
  return null;
}

function PinnedChatIcon({ pKey, progress }: { pKey: string; progress: Progress }) {
  if (!progress[pKey]?.pinnedChat) return null;
  return <span className="badge pinned-chat" title="Pinned">📌</span>;
}

function ReadBadge({ pKey, progress }: { pKey: string; progress: Progress }) {
  const p = progress[pKey];
  if (!p || !p.lastReadId) return null;
  if ((p.unreadCount || 0) === 0) return <span className="badge read-done">✓</span>;
  return <span className="badge partial">…</span>;
}

function DangerBadge({ cacheKey, dangerData }: { cacheKey: string; dangerData: DangerData }) {
  const dangers = dangerData[cacheKey];
  if (!dangers) return null;
  const crit = dangers.filter(d => d.severity === 'critical').length;
  const warn = dangers.filter(d => d.severity === 'warning').length;
  if (crit > 0) return <span className="badge danger">⚠ {crit + warn}</span>;
  if (warn > 0) return <span className="badge danger-warn">⚠ {warn}</span>;
  return null;
}

interface SidebarProps {
  sessions: SessionRow[];
  agents: string[];
  agentFilter: string;
  setAgentFilter: (a: string) => void;
  progress: Progress;
  dangerData: DangerData;
  currentFile: string | null;
  currentAgentId: string | null;
  filters: Filters;
  setFilters: (f: Filters) => void;
  activeSort: string;
  setActiveSort: (s: string) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  contentMatches: Set<string> | null;
  subagentMap: Record<string, SubagentInfo>;
  onSelect: (filename: string, agentId: string) => void;
  isOpen: boolean;
  onClose: () => void;
  pinCount: number;
  showPinned: boolean;
  onTogglePinned: () => void;
}

export default function Sidebar({
  sessions, agents, agentFilter, setAgentFilter, progress, dangerData, currentFile, currentAgentId,
  filters, setFilters, activeSort, setActiveSort,
  searchQuery, setSearchQuery, contentMatches, subagentMap, onSelect, isOpen, onClose,
  pinCount, showPinned, onTogglePinned
}: SidebarProps) {
  // Filter sessions by agent
  const agentSessions = useMemo(() => {
    if (agentFilter === '__all__') return sessions;
    return sessions.filter(s => s.agentId === agentFilter);
  }, [sessions, agentFilter]);

  // Build maps for tree view: subagent filename set + parent→children mapping
  const { subagentFilenames, childrenByParent } = useMemo(() => {
    const fnames = new Set<string>();
    const byParent = new Map<string, SubagentInfo[]>();
    for (const info of Object.values(subagentMap)) {
      fnames.add(fileCacheKey(info.agentId, info.filename));
      if (info.parentFilename && info.parentAgentId) {
        const parentKey = fileCacheKey(info.parentAgentId, info.parentFilename);
        const arr = byParent.get(parentKey) || [];
        arr.push(info);
        byParent.set(parentKey, arr);
      }
    }
    return { subagentFilenames: fnames, childrenByParent: byParent };
  }, [subagentMap]);

  // Count sessions per filter for badges
  const counts = useMemo(() => {
    const c = { all: 0, unread: 0, partial: 0, done: 0, active: 0, orphan: 0, deleted: 0, danger: 0 };
    agentSessions.forEach(row => {
      const reason = (row.Reason || '').toLowerCase();
      const p = progress[progressKey(row)];
      const ck = fileCacheKey(row.agentId, row.Filename);
      c.all++;
      if (!p || !p.lastReadId) c.unread++;
      else if ((p.unreadCount || 0) === 0) c.done++;
      else c.partial++;
      if (reason.startsWith('active')) c.active++;
      if (reason.includes('orphan')) c.orphan++;
      if (reason.includes('deleted') || (row.Disk || '').toUpperCase() === 'DEL') c.deleted++;
      if (dangerData[ck]) c.danger++;
    });
    return c;
  }, [agentSessions, progress, dangerData]);

  type SidebarItem = { type: 'session'; row: SessionRow; dimmed?: boolean } | { type: 'subagent'; info: SubagentInfo; row: SessionRow; dimmed?: boolean };

  const matchesSearch = useCallback((row: SessionRow, q: string): boolean => {
    if (!q) return true;
    const cl = progress[progressKey(row)]?.customLabel || '';
    const localMatch = (row.Filename || '').toLowerCase().includes(q) ||
      (row.Label || '').toLowerCase().includes(q) ||
      cl.toLowerCase().includes(q) ||
      (row.Description || '').toLowerCase().includes(q) ||
      (row.Reason || '').toLowerCase().includes(q);
    if (localMatch) return true;
    if (contentMatches && contentMatches.has(fileCacheKey(row.agentId, row.Filename))) return true;
    return false;
  }, [progress, contentMatches]);

  const filtered = useMemo((): SidebarItem[] => {
    const q = searchQuery.toLowerCase();
    const sorted = sortSessions(agentSessions, activeSort, progress);
    const sessionMap = new Map<string, SessionRow>();
    agentSessions.forEach(r => sessionMap.set(fileCacheKey(r.agentId, r.Filename), r));

    const items: SidebarItem[] = [];
    for (const r of sorted) {
      const rck = fileCacheKey(r.agentId, r.Filename);
      if (subagentFilenames.has(rck)) continue;
      if (!matchesFilters(r, filters, progress, dangerData)) continue;

      const children = childrenByParent.get(rck) || [];
      const childItems: { info: SubagentInfo; row: SessionRow; matches: boolean }[] = [];
      for (const child of children) {
        const childKey = fileCacheKey(child.agentId, child.filename);
        const childRow = sessionMap.get(childKey);
        if (childRow) {
          childItems.push({ info: child, row: childRow, matches: matchesSearch(childRow, q) });
        }
      }

      const parentMatches = matchesSearch(r, q);
      const anyChildMatches = childItems.some(c => c.matches);

      if (q && !parentMatches && !anyChildMatches) continue;

      items.push({ type: 'session', row: r });
      for (const child of childItems) {
        const dimmed = q ? !child.matches : false;
        items.push({ type: 'subagent', info: child.info, row: child.row, dimmed });
      }
    }
    return items;
  }, [agentSessions, filters, activeSort, searchQuery, progress, dangerData, contentMatches, subagentFilenames, childrenByParent, matchesSearch]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const initialScrollDone = useRef(false);

  useEffect(() => {
    if (initialScrollDone.current || !currentFile || filtered.length === 0) return;
    const idx = filtered.findIndex(item => item.row.Filename === currentFile && item.row.agentId === currentAgentId);
    if (idx >= 0) {
      initialScrollDone.current = true;
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'auto' });
      }, 100);
    }
  }, [filtered, currentFile, currentAgentId]);

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
    const ck = fileCacheKey(row.agentId, fname);
    const p = progress[pk];
    const isSubagent = item.type === 'subagent';
    const isDimmed = !!item.dimmed;
    const subInfo = isSubagent ? (item as { type: 'subagent'; info: SubagentInfo; row: SessionRow }).info : null;
    const label = isSubagent
      ? subInfo?.label || ''
      : p?.customLabel || row.Label || '';
    const parentLabel = isSubagent && subInfo?.parentFilename && subInfo?.parentAgentId
      ? (() => {
          const parentRow = sessions.find(r => r.Filename === subInfo.parentFilename && r.agentId === subInfo.parentAgentId);
          if (!parentRow) return '';
          const parentPk = progressKey(parentRow);
          return progress[parentPk]?.customLabel || parentRow.Label || shortName(subInfo.parentFilename);
        })()
      : '';
    const totalMsgs = p?.totalMsgs || '';
    const unreadCount = p?.unreadCount ?? 0;
    const createdStr = row._createdAt ? formatDate(new Date(row._createdAt)) : '';
    const createdFull = row._createdAt ? formatDateFull(new Date(row._createdAt)) : '';
    const lastMsgStr = row._lastModified ? formatDate(new Date(row._lastModified)) : '';
    const lastMsgFull = row._lastModified ? formatDateFull(new Date(row._lastModified)) : '';
    const showAgentBadge = agentFilter === '__all__';

    return (
      <div
        className={`session-item ${currentFile === fname && currentAgentId === row.agentId ? 'selected' : ''} ${isSubagent ? 'subagent-child' : ''} ${isDimmed ? 'dimmed' : ''}`}
        onClick={() => onSelect(fname, row.agentId)}
      >
        {isSubagent && parentLabel && <div className="subagent-parent-ref">↳ {parentLabel}</div>}
        <div className="name">
          {isSubagent && <span className="subagent-tree-icon">🚀</span>}
          <DangerBadge cacheKey={ck} dangerData={dangerData} />
          <PinnedChatIcon pKey={pk} progress={progress} />
          <ReadBadge pKey={pk} progress={progress} />
          {!isSubagent && <ReasonBadge row={row} />}
          {showAgentBadge && <AgentBadge agentId={row.agentId} />}
          {shortName(fname)}
          {totalMsgs ? <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>{totalMsgs} msgs</span> : null}
        </div>
        {label && <div className="label">{label}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
            {createdStr && <span title={`Created: ${createdFull}`}>⏱ {createdStr}</span>}
            {lastMsgStr && lastMsgStr !== createdStr && <span title={`Last message: ${lastMsgFull}`}>💬 {lastMsgStr}</span>}
          </span>
          {unreadCount > 0 && (
            <span style={{ fontSize: 11, background: 'var(--accent)', color: '#fff', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>
              +{unreadCount}
            </span>
          )}
        </div>
        {row.Description && <div className="desc">{row.Description}</div>}
      </div>
    );
  }, [filtered, progress, dangerData, currentFile, currentAgentId, onSelect, sessions, agentFilter]);

  return (
    <div className={`sidebar ${isOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-header">
        <h3>🔍 OpenClaw Inspector <span style={{ fontSize: '9px', opacity: 0.5, fontWeight: 400 }}>{typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''}</span></h3>
        <button className="mobile-back" onClick={onClose}>✕</button>
      </div>

      {/* Agent filter pills */}
      {agents.length > 1 && (
        <div className="sidebar-agents" style={{ padding: '4px 8px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            className={`filter-btn ${agentFilter === '__all__' ? 'active' : ''}`}
            onClick={() => setAgentFilter('__all__')}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            All ({sessions.length})
          </button>
          {agents.map(a => {
            const count = sessions.filter(s => s.agentId === a).length;
            return (
              <button
                key={a}
                className={`filter-btn ${agentFilter === a ? 'active' : ''}`}
                onClick={() => setAgentFilter(a)}
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderColor: agentFilter === a ? agentColor(a) : undefined,
                  color: agentFilter === a ? agentColor(a) : undefined,
                }}
              >
                {a} ({count})
              </button>
            );
          })}
        </div>
      )}

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
          <label className="danger-checkbox" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: filters.dangerOnly ? 'var(--danger)' : 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={filters.dangerOnly}
              onChange={() => setFilters({ ...filters, dangerOnly: !filters.dangerOnly })}
              style={{ accentColor: 'var(--danger)' }}
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
          const totalParent = agentSessions.filter(r => !subagentFilenames.has(fileCacheKey(r.agentId, r.Filename))).length;
          return parentCount !== totalParent
            ? <span>Showing {parentCount} of {totalParent}</span>
            : <span>{totalParent} sessions</span>;
        })()}
        <button
          className={`filter-btn ${showPinned ? 'active' : ''}`}
          onClick={onTogglePinned}
          style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 12px' }}
        >
          📌 Pinned{pinCount > 0 ? ` (${pinCount})` : ''}
        </button>
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
