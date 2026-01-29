import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { shortName } from '../utils';
import Message from './Message';
import type { SessionEntry, SessionRow, Progress, DangerData, DangerHit } from '../types';

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
}

export default function MessageViewer({
  filename, entries, row, progress, dangerData,
  allExpanded, setAllExpanded, dangerOnly, setDangerOnly,
  msgSearch, setMsgSearch, onMarkRead, onRename, detailsOpen, setDetailsOpen, loading
}: MessageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [wasAtBottom, setWasAtBottom] = useState(true);
  const [showNewBtn, setShowNewBtn] = useState(false);
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

  // Track scroll position for auto-scroll on new messages
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      setWasAtBottom(atBottom);
      if (atBottom) setShowNewBtn(false);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Handle new entries: auto-scroll or show button
  useEffect(() => {
    const newLen = entries.length;
    if (newLen > prevEntriesLen.current && prevEntriesLen.current > 0) {
      if (wasAtBottom) {
        setTimeout(() => {
          containerRef.current?.scrollTo({ top: containerRef.current!.scrollHeight, behavior: 'smooth' });
        }, 50);
      } else {
        setShowNewBtn(true);
      }
    }
    prevEntriesLen.current = newLen;
  }, [entries, wasAtBottom]);

  // Scroll to read marker on initial load
  useEffect(() => {
    if (!lastReadId || !containerRef.current) return;
    const marker = containerRef.current.querySelector('.read-marker');
    if (marker) setTimeout(() => marker.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  }, [filename, lastReadId, entries]);

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

  // Filter visible entries
  const visibleEntries = useMemo(() => {
    if (dangerOnly) {
      return entries.filter(e => {
        if (e.type === 'message' && dangerMsgIds.has(e.id!)) return true;
        return false;
      });
    }
    if (msgSearch) {
      const q = msgSearch.toLowerCase();
      return entries.filter(e => {
        const text = JSON.stringify(e).toLowerCase();
        return text.includes(q);
      });
    }
    return entries;
  }, [entries, dangerOnly, dangerMsgIds, msgSearch]);

  const lastMsgId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;
  let markerInserted = false;

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
      <div className="messages" style={{ display: 'block' }} ref={containerRef}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>Loading...</div>
        ) : (
          visibleEntries.map((e, i) => {
            if (e.type === 'message') {
              const isRead = !!lastReadId && !markerInserted;
              const showMarker = !!lastReadId && e.id === lastReadId && e.id !== lastMsgId && !dangerOnly && !msgSearch;
              const el = (
                <React.Fragment key={e.id || i}>
                  <Message
                    entry={e}
                    isRead={isRead}
                    dangerOnly={dangerOnly}
                    fileDangers={fileDangers}
                    allExpanded={allExpanded}
                    onClick={handleClick}
                  />
                  {showMarker && (() => { markerInserted = true; return (
                    <div className="read-marker">
                      Last read{p?.lastReadAt ? ` · ${new Date(p.lastReadAt).toLocaleString()}` : ''}
                    </div>
                  ); })()}
                </React.Fragment>
              );
              if (showMarker) markerInserted = true;
              return el;
            }
            if (e.type === 'model_change') return <div key={i} className="sys-msg">Model → {e.modelId || '?'}</div>;
            if (e.type === 'thinking_level_change') return <div key={i} className="sys-msg">Thinking → {e.thinkingLevel || '?'}</div>;
            if (e.type === 'compaction') return (
              <div key={i} className="compaction-msg">
                <div className="title">⚡ Compaction{e.tokensBefore ? ` (${e.tokensBefore} tokens before)` : ''}</div>
                <div className="summary" style={{ whiteSpace: 'pre-wrap' }}>{e.summary || ''}</div>
              </div>
            );
            if (e.type === 'custom') return <div key={i} className="custom-msg">{e.customType || 'custom'}</div>;
            return null;
          })
        )}
      </div>
      {showNewBtn && (
        <button
          style={{
            position: 'absolute', bottom: 20, right: 20, zIndex: 10,
            background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 20,
            padding: '8px 16px', fontSize: 13, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
          }}
          onClick={() => {
            containerRef.current?.scrollTo({ top: containerRef.current!.scrollHeight, behavior: 'smooth' });
            setShowNewBtn(false);
          }}
        >↓ New messages</button>
      )}
    </>
  );
}
