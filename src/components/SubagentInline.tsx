import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchSession } from '../api';
import Message from './Message';
import type { SessionEntry, DangerHit, Progress, ProgressEntry } from '../types';

interface SubagentInlineProps {
  childSessionKey: string;
  filename: string;
  label: string;
  task: string;
  progress: Progress;
  dangerData: Record<string, DangerHit[]>;
  allExpanded: boolean;
  onMarkRead: (progressKey: string, messageId: string) => void;
}

const KNOWN_TYPES = new Set([
  'session', 'message', 'model_change',
  'thinking_level_change', 'compaction', 'custom',
]);

export default function SubagentInline({
  childSessionKey, filename, label, task,
  progress, dangerData, allExpanded, onMarkRead,
}: SubagentInlineProps) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Progress key for this subagent = childSessionKey
  const pKey = childSessionKey;
  const p = progress[pKey];
  const lastReadId = p?.lastReadId;

  useEffect(() => {
    if (!expanded || loaded) return;
    setLoading(true);
    fetchSession(filename).then(text => {
      const parsed: SessionEntry[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as SessionEntry;
          parsed.push(obj);
        } catch {}
      }
      setEntries(parsed);
      setLoaded(true);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [expanded, loaded, filename]);

  const msgs = useMemo(() => entries.filter(e => e.type === 'message'), [entries]);
  const visibleEntries = useMemo(() => entries.filter(e => e.type !== 'session'), [entries]);
  const fileDangers: DangerHit[] = dangerData[filename] || [];

  const readEntryIds = useMemo(() => {
    const set = new Set<string>();
    if (!lastReadId) return set;
    for (const e of visibleEntries) {
      if (e.id) set.add(e.id);
      if (e.id === lastReadId) break;
    }
    return set;
  }, [visibleEntries, lastReadId]);

  const totalMsgs = msgs.length;
  const readCount = lastReadId
    ? (() => { const idx = msgs.findIndex(e => e.id === lastReadId); return idx >= 0 ? idx + 1 : 0; })()
    : 0;
  const unreadCount = totalMsgs - readCount;

  const handleClick = useCallback((entryId: string) => {
    onMarkRead(pKey, entryId);
  }, [pKey, onMarkRead]);

  const displayLabel = label || task.substring(0, 60) || 'Subagent';

  return (
    <div className={`subagent-inline ${expanded ? 'expanded' : ''}`}>
      <div className="subagent-header" onClick={() => setExpanded(!expanded)}>
        <span className="subagent-icon">🚀</span>
        <span className="subagent-label">{displayLabel}</span>
        {totalMsgs > 0 && (
          <span className="subagent-stats">
            {totalMsgs} msgs
            {unreadCount > 0 && <span className="subagent-unread"> · {unreadCount} unread</span>}
          </span>
        )}
        <span className="subagent-toggle">{expanded ? '▼' : '▶'}</span>
      </div>
      {expanded && (
        <div className="subagent-body">
          {loading && <div style={{ padding: 12, color: '#999' }}>Loading...</div>}
          {!loading && visibleEntries.map((e, i) => {
            if (e.type === 'message') {
              const isRead = !!lastReadId && readEntryIds.has(e.id!);
              const lastMsg = msgs[msgs.length - 1];
              const showMarker = !!lastReadId && e.id === lastReadId && e.id !== lastMsg?.id;
              return (
                <React.Fragment key={e.id || i}>
                  <Message
                    entry={e}
                    isRead={isRead}
                    dangerOnly={false}
                    fileDangers={fileDangers}
                    allExpanded={allExpanded}
                    onClick={handleClick}
                  />
                  {showMarker && (
                    <div className="read-marker">
                      Last read{p?.lastReadAt ? ` · ${new Date(p.lastReadAt).toLocaleString()}` : ''}
                    </div>
                  )}
                </React.Fragment>
              );
            }
            if (e.type === 'compaction') return (
              <div key={i} className="compaction-msg">
                <div className="title">⚡ Compaction</div>
                <div className="summary" style={{ whiteSpace: 'pre-wrap' }}>{e.summary || ''}</div>
              </div>
            );
            if (e.type === 'model_change') return <div key={i} className="sys-msg">Model → {e.modelId || '?'}</div>;
            if (e.type === 'thinking_level_change') return <div key={i} className="sys-msg">Thinking → {e.thinkingLevel || '?'}</div>;
            return null;
          })}
        </div>
      )}
    </div>
  );
}
