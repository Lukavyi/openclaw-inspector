import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { shortName } from '../utils';
import Message from './Message';
import type { SessionEntry, SessionRow, Progress, DangerData, DangerHit, ParseError } from '../types';

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
  onRename: (filename: string, newLabel: string) => void;
  detailsOpen: boolean;
  setDetailsOpen: (v: boolean) => void;
  loading: boolean;
  parseErrors: ParseError[];
  totalLines: number;
}

export default function MessageViewer({
  filename, entries, row, progress, dangerData,
  allExpanded, setAllExpanded, dangerOnly, setDangerOnly,
  msgSearch, setMsgSearch, onMarkRead, onRename, detailsOpen, setDetailsOpen, loading,
  parseErrors, totalLines,
}: MessageViewerProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [showNewBtn, setShowNewBtn] = useState(false);
  const [showJumpBtn, setShowJumpBtn] = useState(false);
  const prevEntriesLen = useRef(0);

  const pKey = row?.SessionId || filename;
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

  // Filter visible entries (exclude session type — it's metadata, not renderable)
  const visibleEntries = useMemo(() => {
    const renderable = entries.filter(e => e.type !== 'session');
    if (dangerOnly) {
      return renderable.filter(e => e.type === 'message' && dangerMsgIds.has(e.id!));
    }
    if (msgSearch) {
      const q = msgSearch.toLowerCase();
      return renderable.filter(e => JSON.stringify(e).toLowerCase().includes(q));
    }
    return renderable;
  }, [entries, dangerOnly, dangerMsgIds, msgSearch]);

  const lastMsgId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;

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
  }, [filename]);

  useEffect(() => {
    if (initialScrollDone.current) return;
    if (lastReadIndex >= 0 && visibleEntries.length > 0) {
      initialScrollDone.current = true;
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: lastReadIndex, align: 'center', behavior: 'smooth' });
      }, 100);
    }
  }, [lastReadIndex, visibleEntries, filename]);

  // Handle new entries: auto-scroll or show button
  useEffect(() => {
    const newLen = visibleEntries.length;
    if (newLen > prevEntriesLen.current && prevEntriesLen.current > 0) {
      if (atBottom) {
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: newLen - 1, behavior: 'smooth' });
        }, 50);
      } else {
        setShowNewBtn(true);
      }
    }
    prevEntriesLen.current = newLen;
  }, [visibleEntries, atBottom]);

  // Show/hide jump-to-last-read button based on visibility
  const visibleRange = useRef({ startIndex: 0, endIndex: 0 });
  const handleRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    visibleRange.current = range;
    if (lastReadIndex >= 0 && !p?.readAll && lastReadId !== lastMsgId && !dangerOnly && !msgSearch) {
      const isVisible = lastReadIndex >= range.startIndex && lastReadIndex <= range.endIndex;
      setShowJumpBtn(!isVisible);
    } else {
      setShowJumpBtn(false);
    }
  }, [lastReadIndex, p?.readAll, lastReadId, lastMsgId, dangerOnly, msgSearch]);

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

      return (
        <>
          <Message
            entry={e}
            isRead={isRead}
            dangerOnly={dangerOnly}
            fileDangers={fileDangers}
            allExpanded={allExpanded}
            onClick={handleClick}
          />
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
  }, [visibleEntries, lastReadId, readEntryIds, lastMsgId, dangerOnly, msgSearch, fileDangers, allExpanded, handleClick, p?.lastReadAt]);

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
                style={{ fontSize: 15, fontWeight: 600, border: '1px solid #4f46e5', borderRadius: 4, padding: '4px 8px', outline: 'none', width: '100%', fontFamily: 'inherit' }}
              />
            ) : <>{displayLabel} <span style={{ fontSize: 14, opacity: 0.4 }}>✏️</span></>}
          </h2>
          <div className="toolbar-controls">
            <input
              type="text"
              className="toolbar-search"
              placeholder="Search..."
              value={msgSearch}
              onChange={e => { setMsgSearch(e.target.value); if (dangerOnly) setDangerOnly(false); }}
            />
            <button
              className={`expand-btn ${allExpanded ? 'active' : ''}`}
              onClick={() => setAllExpanded(!allExpanded)}
              title="Expand/collapse tool calls, tool results, and thinking blocks"
            >
              {allExpanded ? '▼ Collapse tools' : '▶ Expand tools'}
            </button>
            <div className="msg-toggle">
              <button
                className={`toggle-opt ${!dangerOnly ? 'active' : ''}`}
                onClick={() => setDangerOnly(false)}
              >All</button>
              <button
                className={`toggle-opt ${dangerOnly ? 'active' : ''}`}
                onClick={() => setDangerOnly(true)}
              >⚠ Danger</button>
            </div>
          </div>
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
              {(p?.unreadCount || 0) > 0 && <span style={{ color: '#4f46e5', fontWeight: 700 }}> · {p!.unreadCount} unread</span>}
            </span></div>
            <div className="item"><span className="k">Status:</span> <span className="v">{row?.Reason || '—'}</span></div>
            <div className="item"><span className="k">Working directory:</span> <span className="v">{(session as SessionEntry).cwd as string || '—'}</span></div>
            <div className="item"><span className="k">Session ID:</span> <span className="v" style={{ fontSize: 11, opacity: 0.6 }}>{session.id || '—'}</span></div>
          </div>
        )}
      </div>
      <div className="messages" style={{ display: 'block', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>Loading...</div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={visibleEntries.length}
            itemContent={itemContent}
            atBottomStateChange={setAtBottom}
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
      {showJumpBtn && (
        <button
          className="floating-btn jump-btn"
          onClick={jumpToLastRead}
          title="Jump to last reviewed message"
        >🔖 Last reviewed</button>
      )}
      {showNewBtn && (
        <button
          className="floating-btn new-msg-btn"
          onClick={() => {
            virtuosoRef.current?.scrollToIndex({ index: visibleEntries.length - 1, behavior: 'smooth' });
            setShowNewBtn(false);
          }}
        >↓ New messages</button>
      )}
    </>
  );
}
