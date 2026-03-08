import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { shortName, progressKey } from '../utils';
import Message from './Message';
import SubagentInline from './SubagentInline';
import type { SessionEntry, SessionRow, Progress, DangerData, DangerHit, ParseError, Pin } from '../types';
import type { SubagentInfo } from '../api';

interface MessageViewerProps {
  filename: string;
  entries: SessionEntry[];
  row: SessionRow | null;
  progress: Progress;
  dangerData: DangerData;
  allExpanded: boolean;
  setAllExpanded: (v: boolean) => void;
  dangerOnly: boolean;
  setDangerOnly: (v: boolean) => void;
  msgSearch: string;
  setMsgSearch: (v: string) => void;
  onMarkRead: (filename: string, messageId: string) => void;
  onSubagentMarkRead: (progressKey: string, messageId: string) => void;
  onMarkAllRead: (filename: string) => void;
  onPinChat: (filename: string) => void;
  onRename: (filename: string, newLabel: string) => void;
  subagentMap: Record<string, SubagentInfo>;
  pins: Pin[];
  onPin: (filename: string, entry: SessionEntry) => void;
  onUnpin: (msgId: string) => void;
  detailsOpen: boolean;
  setDetailsOpen: (v: boolean) => void;
  loading: boolean;
  parseErrors: ParseError[];
  totalLines: number;
}

export default function MessageViewer({
  filename, entries, row, progress, dangerData,
  allExpanded, setAllExpanded, dangerOnly, setDangerOnly,
  msgSearch, setMsgSearch, onMarkAllRead, onPinChat, onMarkRead, onSubagentMarkRead, onRename, subagentMap, pins, onPin, onUnpin, detailsOpen, setDetailsOpen, loading,
  parseErrors, totalLines,
}: MessageViewerProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);

  const [showJumpBtn, setShowJumpBtn] = useState(false);
  const [msgTypeFilters, setMsgTypeFilters] = useState({
    user: true,
    assistant: true,
    tools: true,
    thinking: true,
    subagents: true,
    system: true,
  });
  const prevEntriesLen = useRef(0);
  const hasNewMessages = useRef(false);

  const pKey = row ? progressKey(row) : filename;
  const p = progress[pKey];
  const lastReadId = p?.lastReadId;
  const customLabel = p?.customLabel;
  const displayLabel = customLabel || row?.Label || shortName(filename);

  const session = entries.find(e => e.type === 'session') || {} as SessionEntry;
  const msgs = entries.filter(e => e.type === 'message');
  const userN = msgs.filter(m => m.message?.role === 'user').length;
  const asstN = msgs.filter(m => m.message?.role === 'assistant').length;
  const toolN = msgs.filter(m => m.message?.role === 'toolResult').length;
  const fileDangers: DangerHit[] = dangerData[filename] || [];
  const dangerMsgIds = useMemo(() => new Set(fileDangers.map(d => d.msgId)), [fileDangers]);

  // Check if all type filters are ON (no filtering needed)
  const allFiltersOn = Object.values(msgTypeFilters).every(Boolean);

  // Filter visible entries (exclude session type — it's metadata, not renderable)
  const visibleEntries = useMemo(() => {
    const renderable = entries.filter(e => e.type !== 'session');
    if (dangerOnly) {
      return renderable.filter(e => e.type === 'message' && dangerMsgIds.has(e.id!));
    }

    let filtered = renderable;

    // Apply type filters
    if (!allFiltersOn) {
      filtered = filtered.filter(e => {
        if (e.type !== 'message') {
          // system events: model_change, thinking_level_change, compaction, custom
          return msgTypeFilters.system;
        }
        const role = e.message?.role;
        if (role === 'user') return msgTypeFilters.user;
        if (role === 'toolResult') return msgTypeFilters.tools;
        if (role === 'assistant') {
          const content = e.message?.content || [];
          const hasText = content.some(c => c.type === 'text');
          const hasToolCall = content.some(c => c.type === 'toolCall');
          const hasThinking = content.some(c => c.type === 'thinking');
          const isSubagentCall = hasToolCall && content.some(c => c.type === 'toolCall' && (c as { name?: string }).name === 'sessions_spawn');

          // If it's purely a subagent spawn call
          if (isSubagentCall && !hasText) return msgTypeFilters.subagents;
          // If it's purely tool calls (no text)
          if (hasToolCall && !hasText && !hasThinking) return msgTypeFilters.tools;
          // If it's purely thinking
          if (hasThinking && !hasText && !hasToolCall) return msgTypeFilters.thinking;
          // Mixed: show if assistant text is on
          return msgTypeFilters.assistant;
        }
        return true;
      });
    }

    if (msgSearch) {
      const q = msgSearch.toLowerCase();
      filtered = filtered.filter(e => JSON.stringify(e).toLowerCase().includes(q));
    }
    return filtered;
  }, [entries, dangerOnly, dangerMsgIds, msgSearch, allFiltersOn, msgTypeFilters]);

  const lastMsgId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;

  // Pinned message ids for this file
  const pinnedMsgIds = useMemo(() => new Set(
    pins.filter(p => p.filename === filename).map(p => p.msgId)
  ), [pins, filename]);

  const handlePin = useCallback((entryId: string) => {
    const entry = entries.find(e => e.id === entryId);
    if (entry) onPin(filename, entry);
  }, [entries, filename, onPin]);

  const handleUnpin = useCallback((entryId: string) => {
    const pin = pins.find(p => p.filename === filename && p.msgId === entryId);
    if (pin) onUnpin(pin.id);
  }, [pins, filename, onUnpin]);

  // Build map: msgId (of toolResult for sessions_spawn) → subagent info
  const subagentEntries = useMemo(() => {
    const map = new Map<string, { childSessionKey: string; info: SubagentInfo; task: string }>();
    // Find all sessions_spawn toolResults and extract childSessionKey
    for (const e of entries) {
      if (e.type !== 'message' || e.message?.role !== 'toolResult') continue;
      if (e.message.toolName !== 'sessions_spawn') continue;
      const text = (e.message.content || []).map(c => ('text' in c ? (c as { text: string }).text : '')).join('');
      try {
        const parsed = JSON.parse(text);
        const key = parsed.childSessionKey;
        if (key && subagentMap[key]) {
          // Find the corresponding toolCall to get the task
          let task = '';
          for (const e2 of entries) {
            if (e2.type !== 'message' || e2.message?.role !== 'assistant') continue;
            for (const b of e2.message.content || []) {
              if (b.type === 'toolCall' && (b as { id?: string }).id === e.message.toolCallId) {
                task = ((b as { arguments?: { task?: string } }).arguments?.task) || '';
              }
            }
          }
          map.set(e.id!, { childSessionKey: key, info: subagentMap[key], task });
        }
      } catch {}
    }
    return map;
  }, [entries, subagentMap]);

  // Find last-read index in visible entries
  const lastReadIndex = useMemo(() => {
    if (!lastReadId) return -1;
    return visibleEntries.findIndex(e => e.id === lastReadId);
  }, [visibleEntries, lastReadId]);

  // Build set of "read" entry ids (all entries up to and including lastReadId)
  const readEntryIds = useMemo(() => {
    const set = new Set<string>();
    if (!lastReadId) return set;
    for (const e of visibleEntries) {
      if (e.id) set.add(e.id);
      if (e.id === lastReadId) break;
    }
    return set;
  }, [visibleEntries, lastReadId]);

  // Scroll to last-read marker on initial load
  const initialScrollDone = useRef(false);
  useEffect(() => {
    initialScrollDone.current = false;
    prevEntriesLen.current = 0;
    hasNewMessages.current = false;
    setAtBottom(false);
  }, [filename]);

  useEffect(() => {
    if (initialScrollDone.current) return;
    if (visibleEntries.length > 0) {
      initialScrollDone.current = true;
      if (lastReadIndex >= 0) {
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: lastReadIndex, align: 'center', behavior: 'auto' });
        }, 50);
      } else {
        // No last-read — scroll to top
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: 0, behavior: 'auto' });
        }, 50);
      }
    }
  }, [lastReadIndex, visibleEntries, filename]);

  // Handle new entries: auto-scroll or show button
  useEffect(() => {
    if (!initialScrollDone.current) return; // don't interfere with initial scroll
    const newLen = visibleEntries.length;
    if (newLen > prevEntriesLen.current && prevEntriesLen.current > 0) {
      if (atBottom) {
        hasNewMessages.current = false;
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: newLen - 1, behavior: 'smooth' });
        }, 50);
      } else {
        hasNewMessages.current = true;
      }
    }
    prevEntriesLen.current = newLen;
  }, [visibleEntries, atBottom]);

  // Show/hide jump-to-last-read button based on visibility
  const visibleRange = useRef({ startIndex: 0, endIndex: 0 });
  const handleRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    visibleRange.current = range;
    setScrolledFromTop(range.startIndex > 0);
    if (lastReadIndex >= 0 && (p?.unreadCount || 0) > 0 && lastReadId !== lastMsgId && !dangerOnly && !msgSearch) {
      const isVisible = lastReadIndex >= range.startIndex && lastReadIndex <= range.endIndex;
      setShowJumpBtn(!isVisible);
    } else {
      setShowJumpBtn(false);
    }
  }, [lastReadIndex, p?.unreadCount, lastReadId, lastMsgId, dangerOnly, msgSearch]);

  const handleStartRename = () => {
    setEditValue(customLabel || row?.Label || '');
    setIsEditing(true);
  };

  const handleSaveRename = () => {
    onRename(filename, editValue.trim());
    setIsEditing(false);
  };

  const handleClick = useCallback((entryId: string) => {
    onMarkRead(filename, entryId);
  }, [filename, onMarkRead]);

  const jumpToLastRead = () => {
    if (lastReadIndex >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: lastReadIndex, align: 'center', behavior: 'smooth' });
    }
  };

  // Render a single item
  const itemContent = useCallback((index: number) => {
    const e = visibleEntries[index];
    if (!e) return null;

    if (e.type === 'message') {
      const isRead = !!lastReadId && readEntryIds.has(e.id!);
      const showMarker = !!lastReadId && e.id === lastReadId && e.id !== lastMsgId && !dangerOnly && !msgSearch;
      const sub = e.id ? subagentEntries.get(e.id) : undefined;

      return (
        <>
          <Message
            entry={e}
            isRead={isRead}
            dangerOnly={dangerOnly}
            fileDangers={fileDangers}
            allExpanded={allExpanded}
            hideThinking={!msgTypeFilters.thinking}
            onClick={handleClick}
            isPinned={pinnedMsgIds.has(e.id!)}
            onPin={handlePin}
            onUnpin={handleUnpin}
          />
          {sub && (
            <SubagentInline
              childSessionKey={sub.childSessionKey}
              filename={sub.info.filename}
              agentId={sub.info.agentId}
              label={sub.info.label}
              task={sub.task}
              progress={progress}
              dangerData={dangerData}
              allExpanded={allExpanded}
              subagentMap={subagentMap}
              onMarkRead={onSubagentMarkRead}
            />
          )}
          {showMarker && (
            <div className="read-marker">
              Last read{p?.lastReadAt ? ` · ${new Date(p.lastReadAt).toLocaleString()}` : ''}
            </div>
          )}
        </>
      );
    }
    if (e.type === 'model_change') return <div className="sys-msg">Model → {e.modelId || '?'}</div>;
    if (e.type === 'thinking_level_change') return <div className="sys-msg">Thinking → {e.thinkingLevel || '?'}</div>;
    if (e.type === 'compaction') return (
      <div className="compaction-msg">
        <div className="title">⚡ Compaction{e.tokensBefore ? ` (${e.tokensBefore} tokens before)` : ''}</div>
        <div className="summary" style={{ whiteSpace: 'pre-wrap' }}>{e.summary || ''}</div>
      </div>
    );
    if (e.type === 'custom') return <div className="custom-msg">{e.customType || 'custom'}</div>;
    if (e.type === '_parseError') {
      const pe = e._parseError!;
      return (
        <div className="parse-error-msg">
          <span className="badge">⚠️ Parse error</span> Line {pe.line}: {pe.error}
          <pre className="raw-line">{pe.raw}</pre>
        </div>
      );
    }
    // Unknown type placeholder
    return (
      <div className="unknown-type-msg">
        ⚠️ Unknown type: <code>{e.type}</code> (line {e._lineNumber || '?'})
      </div>
    );
  }, [visibleEntries, lastReadId, readEntryIds, lastMsgId, dangerOnly, msgSearch, fileDangers, allExpanded, handleClick, p?.lastReadAt, subagentEntries, progress, dangerData, onSubagentMarkRead, pinnedMsgIds, handlePin, handleUnpin, msgTypeFilters.thinking]);

  return (
    <>
      <div className="main-toolbar">
        <div className="toolbar-top">
          <h2 style={{ cursor: 'pointer', margin: 0 }} onClick={handleStartRename} title="Click to rename">
            {isEditing ? (
              <input
                autoFocus
                type="text"
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveRename(); if (e.key === 'Escape') setIsEditing(false); }}
                onBlur={handleSaveRename}
                placeholder={shortName(filename)}
                style={{ fontSize: 15, fontWeight: 600, border: '1.5px solid var(--accent)', borderRadius: 4, padding: '4px 8px', outline: 'none', width: '100%', fontFamily: 'inherit' }}
              />
            ) : <>{displayLabel} <span style={{ fontSize: 14, opacity: 0.4 }}>✏️</span>
              <span
                className={`pin-chat-btn ${p?.pinnedChat ? 'pinned' : ''}`}
                onClick={e => { e.stopPropagation(); onPinChat(filename); }}
                title={p?.pinnedChat ? 'Unpin chat' : 'Pin chat to top'}
              >📌</span>
            </>}
          </h2>
          <div className="toolbar-controls">
            <div className="toolbar-search-wrap">
              <input
                type="text"
                className="toolbar-search"
                placeholder="Search..."
                value={msgSearch}
                onChange={e => { setMsgSearch(e.target.value); if (dangerOnly) setDangerOnly(false); }}
              />
              {msgSearch && <button className="search-clear" onClick={() => setMsgSearch('')}>✕</button>}
            </div>

            {!p?.readAll && (
              <button
                className="expand-btn"
                onClick={() => onMarkAllRead(filename)}
                title="Mark entire conversation as read"
              >
                ✓ Mark all read
              </button>
            )}
          </div>
        </div>
        <div className="type-filters">
          {!dangerOnly && ([
            ['user', '👤 User'],
            ['assistant', '🤖 Bot'],
            ['tools', '🔧 Tools'],
            ['thinking', '🧠 Think'],
            ['subagents', '🚀 Sub'],
            ['system', '⚡ Sys'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={`type-filter-btn ${msgTypeFilters[key] ? 'active' : ''}`}
              onClick={() => setMsgTypeFilters(prev => ({ ...prev, [key]: !prev[key] }))}
            >
              {label}
            </button>
          ))}
          {!dangerOnly && <span style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />}
          <button
            className={`type-filter-btn ${dangerOnly ? '' : 'active'}`}
            onClick={() => setDangerOnly(false)}
          >All</button>
          <button
            className={`type-filter-btn ${dangerOnly ? 'active' : ''}`}
            onClick={() => setDangerOnly(true)}
            style={dangerOnly ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}}
          >⚠ Danger</button>
          <span style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />
          <button
            className={`type-filter-btn ${allExpanded ? 'active' : ''}`}
            onClick={() => setAllExpanded(!allExpanded)}
            title="Expand/collapse tool calls, tool results, and thinking blocks"
            style={{ marginLeft: 4, borderStyle: 'dashed' }}
          >
            {allExpanded ? '▼ Expanded' : '▶ Collapsed'}
          </button>
          {!dangerOnly && !allFiltersOn && (
            <button
              className="type-filter-reset"
              onClick={() => setMsgTypeFilters({ user: true, assistant: true, tools: true, thinking: true, subagents: true, system: true })}
            >
              Reset
            </button>
          )}
        </div>
        <div className="toolbar-meta">
          <span className="meta-filename">{filename}</span>
          <button className="meta-toggle" onClick={() => setDetailsOpen(!detailsOpen)}>
            {detailsOpen ? '▴ Hide details' : '▾ Details'}
          </button>
        </div>
        {detailsOpen && (
          <div className="metadata-grid expanded">
            <div className="item"><span className="k">Started:</span> <span className="v">{session.timestamp ? new Date(session.timestamp).toLocaleString() : '—'}</span></div>
            <div className="item"><span className="k">Last activity:</span> <span className="v">{row?._lastModified ? new Date(row._lastModified).toLocaleString() : '—'}</span></div>
            <div className="item"><span className="k">Messages:</span> <span className="v">
              {msgs.length} ({userN} user · {asstN} bot · {toolN} tool)
              {(p?.unreadCount || 0) > 0 && <span style={{ color: 'var(--accent)', fontWeight: 700 }}> · {p!.unreadCount} unread</span>}
            </span></div>
            <div className="item"><span className="k">Status:</span> <span className="v">{row?.Reason || '—'}</span></div>
            <div className="item"><span className="k">Working directory:</span> <span className="v">{(session as SessionEntry).cwd as string || '—'}</span></div>
            <div className="item"><span className="k">Session ID:</span> <span className="v" style={{ fontSize: 11, opacity: 0.6 }}>{session.id || '—'}</span></div>
          </div>
        )}
      </div>
      <div className="messages" style={{ display: 'block', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={visibleEntries.length}
            itemContent={itemContent}
            atBottomStateChange={(bottom) => {
              setAtBottom(bottom);
              if (bottom) { hasNewMessages.current = false; }
            }}

            rangeChanged={handleRangeChanged}
            overscan={400}
            style={{ height: '100%' }}
            increaseViewportBy={{ top: 200, bottom: 200 }}
          />
        )}
        {!loading && totalLines > 0 && (
          <div className={`integrity-footer ${parseErrors.length > 0 ? 'has-errors' : ''}`}>
            {parseErrors.length === 0
              ? `✅ ${totalLines}/${totalLines} lines parsed`
              : `⚠️ ${totalLines - parseErrors.length}/${totalLines} lines parsed (${parseErrors.length} error${parseErrors.length > 1 ? 's' : ''})`
            }
          </div>
        )}
      </div>
      <div className="floating-nav">
        <button className={`nav-btn nav-top ${scrolledFromTop ? 'visible' : ''}`} onClick={() => virtuosoRef.current?.scrollToIndex({ index: 0, behavior: 'smooth' })}>↑</button>
        <button className={`nav-btn nav-jump ${showJumpBtn ? 'visible' : ''}`} onClick={jumpToLastRead}>🔖</button>
        <button className={`nav-btn nav-bottom ${!atBottom ? 'visible' : ''}`} onClick={() => virtuosoRef.current?.scrollToIndex({ index: visibleEntries.length - 1, behavior: 'smooth' })}>↓</button>
      </div>
    </>
  );
}
