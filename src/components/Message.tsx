import React, { useState, useMemo, useCallback } from 'react';
import type { SessionEntry, DangerHit, SessionMessage, MessageContent } from '../types';

interface ToolChipProps {
  name: string;
  input: Record<string, unknown>;
  isError?: boolean;
  allExpanded: boolean;
}

function ToolChip({ name, input, isError, allExpanded }: ToolChipProps) {
  const [open, setOpen] = useState(false);
  const isOpen = allExpanded || open;
  const isExec = name === 'exec' || name === 'Exec';
  const cmdPreview = isExec && input?.command ? String(input.command) : '';

  const summary = (() => {
    if (isExec && cmdPreview) return `$ ${cmdPreview.substring(0, 80)}${cmdPreview.length > 80 ? '…' : ''}`;
    // Show key params for common tools
    const p = input || {};
    if (name === 'web_fetch' && p.url) return `🌐 ${String(p.url).substring(0, 80)}`;
    if (name === 'web_search' && p.query) return `🔍 ${String(p.query).substring(0, 80)}`;
    if ((name === 'Read' || name === 'read') && (p.path || p.file_path)) return `📄 ${String(p.path || p.file_path).substring(0, 80)}`;
    if ((name === 'Write' || name === 'write') && (p.path || p.file_path)) return `✏️ ${String(p.path || p.file_path).substring(0, 80)}`;
    if ((name === 'Edit' || name === 'edit') && (p.path || p.file_path)) return `✂️ ${String(p.path || p.file_path).substring(0, 80)}`;
    if (name === 'browser' && p.action) return `🖥 ${String(p.action)}${p.targetUrl ? ' → ' + String(p.targetUrl).substring(0, 60) : ''}`;
    if (name === 'memory_search' && p.query) return `🧠 ${String(p.query).substring(0, 80)}`;
    if (name === 'message' && p.action) return `💬 ${String(p.action)}${p.target ? ' → ' + String(p.target) : ''}`;
    if (name === 'nodes' && p.action) return `📱 ${String(p.action)}`;
    if (name === 'image' && p.image) return `🖼 ${String(p.image).substring(0, 60)}`;
    if (name === 'tts' && p.text) return `🔊 ${String(p.text).substring(0, 60)}`;
    if (name === 'cron' && p.action) return `⏰ ${String(p.action)}`;
    if (name === 'gateway' && p.action) return `⚙ ${String(p.action)}`;
    if (name === 'sessions_spawn' && p.task) return `🚀 ${String(p.task).substring(0, 60)}`;
    return `⚙ ${name}`;
  })();

  const label = summary;

  return (
    <>
      <span
        className={`tool-chip ${isError ? 'error' : ''}`}
        onClick={e => { e.stopPropagation(); setOpen(!open); }}
      >{isError ? '✗' : name ? '' : '✓'} {label}</span>
      <div className={`tool-detail ${isOpen ? 'open' : ''}`}>
        {JSON.stringify(input, null, 2)}
      </div>
    </>
  );
}

interface ToolResultChipProps {
  msg: SessionMessage;
  allExpanded: boolean;
}

function ToolResultChip({ msg, allExpanded }: ToolResultChipProps) {
  const [open, setOpen] = useState(false);
  const isOpen = allExpanded || open;
  const text = (msg.content || []).map(c => ('text' in c ? c.text : '') || '').join('\n');

  return (
    <>
      <span
        className={`tool-chip ${msg.isError ? 'error' : ''}`}
        onClick={e => { e.stopPropagation(); setOpen(!open); }}
      >{msg.isError ? '✗' : '✓'} {msg.toolName || 'tool'}</span>
      <div className={`tool-detail ${isOpen ? 'open' : ''}`}>{text}</div>
    </>
  );
}

interface ThinkingBlockProps {
  text: string;
  allExpanded: boolean;
}

function ThinkingBlock({ text, allExpanded }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false);
  const isOpen = allExpanded || open;

  return (
    <>
      <span className="thinking-toggle" onClick={e => { e.stopPropagation(); setOpen(!open); }}>
        🧠 Thinking...
      </span>
      <div className={`thinking-content ${isOpen ? 'open' : ''}`}>{text}</div>
    </>
  );
}

interface MessageProps {
  entry: SessionEntry;
  isRead: boolean;
  dangerOnly: boolean;
  fileDangers: DangerHit[];
  allExpanded: boolean;
  onClick: (entryId: string) => void;
}

export default React.memo(function Message({ entry, isRead, dangerOnly, fileDangers, allExpanded, onClick }: MessageProps) {
  const msg = entry.message;
  if (!msg) return null;

  const role = msg.role === 'toolResult' ? 'assistant' : msg.role;
  const msgDangers = useMemo(() => fileDangers.filter(d => d.msgId === entry.id), [fileDangers, entry.id]);
  const hasCritical = msgDangers.some(d => d.severity === 'critical');
  const hasWarning = msgDangers.length > 0;

  const handleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.tool-chip, .tool-detail, .thinking-toggle, .thinking-content')) return;
    onClick(entry.id!);
  }, [entry.id, onClick]);

  const time = entry.timestamp ? (() => {
    const d = new Date(entry.timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  })() : '';

  const bubbleClass = `bubble${hasCritical ? ' has-danger' : hasWarning ? ' has-warning' : ''}`;
  const title = dangerOnly
    ? '⚠ Switch to All Messages to mark as reviewed'
    : '✓ Click to mark all messages up to here as reviewed';

  return (
    <div className={`msg ${role}${isRead ? ' read' : ''}`}>
      <div className="msg-row">
      {!dangerOnly && role === 'user' && (
        <button className="mark-read-btn" onClick={handleClick}>Checked to here</button>
      )}
      <div className={bubbleClass}>
        {time && <div className="time">{time}</div>}

        {msg.role === 'toolResult' ? (
          <ToolResultChip msg={msg} allExpanded={allExpanded} />
        ) : Array.isArray(msg.content) ? msg.content.map((block: MessageContent, i: number) => {
          if (block.type === 'text' && 'text' in block) {
            return <div key={i} className="content">{(block as { type: 'text'; text: string }).text}</div>;
          }
          if (block.type === 'thinking' && 'thinking' in block) {
            return <ThinkingBlock key={i} text={(block as { type: 'thinking'; thinking: string }).thinking} allExpanded={allExpanded} />;
          }
          if (block.type === 'toolCall') {
            const tc = block as { type: 'toolCall'; name?: string; input?: Record<string, unknown> };
            return <ToolChip key={i} name={tc.name || 'tool'} input={tc.input || {}} allExpanded={allExpanded} />;
          }
          if (block.type === 'image') {
            const img = block as { type: 'image'; mimeType?: string; data?: string; url?: string };
            const mime = img.mimeType || 'image/png';
            const data = img.data || '';
            if (data) {
              return <img key={i} src={`data:${mime};base64,${data}`} style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 8, margin: '8px 0', cursor: 'pointer' }} onClick={e => { e.stopPropagation(); window.open((e.target as HTMLImageElement).src, '_blank'); }} />;
            }
            if (img.url) {
              return <img key={i} src={img.url} style={{ maxWidth: '100%', maxHeight: 400, borderRadius: 8, margin: '8px 0', cursor: 'pointer' }} onClick={e => { e.stopPropagation(); window.open((e.target as HTMLImageElement).src, '_blank'); }} />;
            }
            return <div key={i} className="content" style={{ opacity: 0.5 }}>🖼 [image - no data]</div>;
          }
          return null;
        }) : null}

        {msgDangers.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {msgDangers.map((d, i) => (
              <span key={i} className={`danger-chip ${d.severity}`}>
                ⚠ {d.label}: {d.command}
              </span>
            ))}
          </div>
        )}

        {msg.role === 'assistant' && msg.usage && (() => {
          const u = msg.usage;
          const total = u.totalTokens || ((u.input || 0) + (u.output || 0));
          if (total <= 0) return null;
          const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
          return (
            <div style={{ fontSize: 10, color: '#aaa', marginTop: 6, textAlign: 'right' }}>
              {fmt(total)} tokens{u.input ? ` (in:${fmt(u.input)} out:${fmt(u.output || 0)})` : ''}
            </div>
          );
        })()}
      </div>
      {!dangerOnly && role !== 'user' && (
        <button className="mark-read-btn" onClick={handleClick}>Checked to here</button>
      )}
      </div>
    </div>
  );
});
