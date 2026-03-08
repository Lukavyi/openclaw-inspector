import { useMemo } from 'react';
import type { Pin } from '../types';

interface PinnedViewProps {
  pins: Pin[];
  onNavigate: (filename: string, msgId: string) => void;
  onRemovePin: (pinId: string) => void;
}

export default function PinnedView({ pins, onNavigate, onRemovePin }: PinnedViewProps) {
  const sorted = useMemo(() =>
    [...pins].sort((a, b) => new Date(b.pinnedAt).getTime() - new Date(a.pinnedAt).getTime()),
    [pins]
  );

  if (sorted.length === 0) {
    return (
      <div className="pinned-view">
        <div className="pinned-header">
          <h2>📌 Pinned Messages</h2>
        </div>
        <div className="pinned-empty">
          No pinned messages yet. Click the 📌 icon on any message to pin it.
        </div>
      </div>
    );
  }

  // Group by session
  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; pins: Pin[] }>();
    for (const pin of sorted) {
      const key = pin.filename;
      if (!map.has(key)) {
        map.set(key, { label: pin.sessionLabel || pin.filename.substring(0, 8), pins: [] });
      }
      map.get(key)!.pins.push(pin);
    }
    return Array.from(map.entries());
  }, [sorted]);

  return (
    <div className="pinned-view">
      <div className="pinned-header">
        <h2>📌 Pinned Messages</h2>
        <span className="pinned-count">{sorted.length} pinned</span>
      </div>
      <div className="pinned-list">
        {grouped.map(([filename, { label, pins: groupPins }]) => (
          <div key={filename} className="pinned-group">
            <div className="pinned-group-label">{label}</div>
            {groupPins.map(pin => (
              <div
                key={pin.id}
                className="pinned-item"
                onClick={() => onNavigate(pin.filename, pin.msgId)}
              >
                <div className="pinned-item-header">
                  <span className={`pinned-role ${pin.role}`}>
                    {pin.role === 'user' ? '👤' : '🤖'} {pin.role}
                  </span>
                  {pin.timestamp && (
                    <span className="pinned-time">
                      {new Date(pin.timestamp).toLocaleString()}
                    </span>
                  )}
                  <button
                    className="pinned-remove"
                    onClick={e => { e.stopPropagation(); onRemovePin(pin.id); }}
                    title="Unpin"
                  >✕</button>
                </div>
                <div className="pinned-preview">{pin.preview}</div>
                {pin.note && <div className="pinned-note">💬 {pin.note}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
