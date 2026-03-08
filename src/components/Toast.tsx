import type { Toast as ToastType } from '../types';

interface ToastProps {
  toasts: ToastType[];
}

export default function Toast({ toasts }: ToastProps) {
  if (!toasts.length) return null;
  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 100,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: '#2a2520', color: '#faf8f5', padding: '10px 16px',
          borderRadius: 12, fontSize: 13, boxShadow: '0 4px 16px rgba(26,22,18,.2), 0 2px 4px rgba(26,22,18,.1)',
          animation: 'fadeIn 0.3s ease',
        }}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
