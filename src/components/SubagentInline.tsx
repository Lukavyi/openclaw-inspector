import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchSession } from '../api';
import type { SubagentInfo } from '../api';
import Message from './Message';
import type { SessionEntry, DangerHit, Progress } from '../types';

interface SubagentInlineProps {
  childSessionKey: string;
  filename: string;
  label: string;
  task: string;
  progress: Progress;
  dangerData: Record<string, DangerHit[]>;
  allExpanded: boolean;
  subagentMap: Record<string, SubagentInfo>;
  onMarkRead: (progressKey: string, messageId: string) => void;
}

export default function SubagentInline({
  childSessionKey, filename, label, task,
  progress, dangerData, allExpanded, subagentMap, onMarkRead,
}: SubagentInlineProps) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const expanded = manualToggle !== null ? manualToggle : allExpanded;
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
        try { parsed.push(JSON.parse(line) as SessionEntry); } catch {}
      }
      setEntries(parsed);
      setLoaded(true);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [expanded, loaded, filename]);

  const msgs = useMemo(() => entries.filter(e => e.type === 'message'), [entries]);
  const visibleEntries = useMemo(() => entries.filter(e => e.type !== 'session'), [entries]);
  const fileDangers: DangerHit[] = dangerData[filename] || [];

  // Detect nested subagents in this subagent's entries
  const nestedSubagents = useMemo(() => {
    const map = new Map<string, { childSessionKey: string; info: SubagentInfo; task: string }>();
    for (const e of entries) {
      if (e.type !== 'message' || e.message?.role !== 'toolResult') continue;
      if (e.message.toolName !== 'sessions_spawn') continue;
      const text = (e.message.content || []).map(c => ('text' in c ? (c as { text: string }).text : '')).join('');
      try {
        const parsed = JSON.parse(text);
        const key = parsed.childSessionKey;
        if (key && subagentMap[key]) {
          let nestedTask = '';
          for (const e2 of entries) {
            if (e2.type !== 'message' || e2.message?.role !== 'assistant') continue;
            for (const b of e2.message.content || []) {
              if (b.type === 'toolCall' && (b as { id?: string }).id === e.message!.toolCallId) {
                nestedTask = ((b as { arguments?: { task?: string } }).arguments?.task) || '';
              }
            }
          }
          map.set(e.id!, { childSessionKey: key, info: subagentMap[key], task: nestedTask });
        }
      } catch {}
    }
    return map;
  }, [entries, subagentMap]);

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
      <div className="subagent-header" onClick={() => setManualToggle(!expanded)}>
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
          {loading && <div style={{ padding: 12, color: 'var(--text-muted)' }}>Loading...</div>}
          {!loading && visibleEntries.map((e, i) => {
            if (e.type === 'message') {
              const isRead = !!lastReadId && readEntryIds.has(e.id!);
              const lastMsg = msgs[msgs.length - 1];
              const showMarker = !!lastReadId && e.id === lastReadId && e.id !== lastMsg?.id;
              const nested = e.id ? nestedSubagents.get(e.id) : undefined;
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
                  {nested && (
                    <SubagentInline
                      childSessionKey={nested.childSessionKey}
                      filename={nested.info.filename}
                      label={nested.info.label}
                      task={nested.task}
                      progress={progress}
                      dangerData={dangerData}
                      allExpanded={allExpanded}
                      subagentMap={subagentMap}
                      onMarkRead={onMarkRead}
                    />
                  )}
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
