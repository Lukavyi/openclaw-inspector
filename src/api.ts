import type { SessionApiResponse, DangerData, Progress } from './types';

const BASE = '';

export async function fetchSessions(): Promise<SessionApiResponse[]> {
  const res = await fetch(`${BASE}/api/sessions`);
  return res.ok ? res.json() : [];
}

export async function fetchCounts(): Promise<Record<string, number>> {
  const res = await fetch(`${BASE}/api/counts`);
  return res.ok ? res.json() : {};
}

export async function fetchCSV(): Promise<string> {
  const res = await fetch(`${BASE}/api/csv`);
  return res.ok ? res.text() : '';
}

export async function fetchSession(filename: string): Promise<string> {
  const res = await fetch(`${BASE}/api/session/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error('Not found');
  return res.text();
}

export async function fetchDanger(): Promise<DangerData> {
  const res = await fetch(`${BASE}/api/danger`);
  return res.ok ? res.json() : {};
}

export async function fetchProgress(): Promise<Progress> {
  const res = await fetch(`${BASE}/api/progress`);
  return res.ok ? res.json() : {};
}

export async function saveProgress(data: Progress): Promise<void> {
  await fetch(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function connectSSE(onFileChange: (data: { filename: string }) => void): EventSource {
  const sse = new EventSource(`${BASE}/api/events`);
  sse.addEventListener('file-change', (e: MessageEvent) => {
    onFileChange(JSON.parse(e.data));
  });
  return sse;
}
