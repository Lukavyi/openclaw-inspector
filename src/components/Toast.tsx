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
          background: '#1a1a1a', color: '#fff', padding: '10px 16px',
          borderRadius: 8, fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          animation: 'fadeIn 0.3s ease',
        }}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
