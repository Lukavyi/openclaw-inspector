import type { SessionApiResponse, DangerData, Progress, Pin } from './types';

const BASE = '';

export async function fetchAgents(): Promise<string[]> {
  const res = await fetch(`${BASE}/api/agents`);
  return res.ok ? res.json() : [];
}

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

export async function fetchSession(agentId: string, filename: string): Promise<string> {
  const res = await fetch(`${BASE}/api/session/${encodeURIComponent(agentId)}/${encodeURIComponent(filename)}`);
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

export interface SearchMatch {
  agentId: string;
  filename: string;
}

export async function searchSessions(query: string): Promise<SearchMatch[]> {
  if (!query || query.length < 2) return [];
  const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`);
  return res.ok ? res.json() : [];
}

export interface SubagentInfo {
  filename: string;
  agentId: string;
  sessionId: string;
  label: string;
  parentFilename: string | null;
  parentAgentId: string | null;
}

export async function fetchSubagents(): Promise<Record<string, SubagentInfo>> {
  const res = await fetch(`${BASE}/api/subagents`);
  return res.ok ? res.json() : {};
}

export async function fetchPins(): Promise<Pin[]> {
  const res = await fetch(`${BASE}/api/pins`);
  return res.ok ? res.json() : [];
}

export async function addPin(pin: Omit<Pin, 'id' | 'pinnedAt'>): Promise<Pin | null> {
  const res = await fetch(`${BASE}/api/pins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pin),
  });
  return res.ok ? res.json() : null;
}

export async function removePin(pinId: string): Promise<void> {
  await fetch(`${BASE}/api/pins/${encodeURIComponent(pinId)}`, { method: 'DELETE' });
}

export function connectSSE(onFileChange: (data: { filename: string; agentId: string }) => void): EventSource {
  const sse = new EventSource(`${BASE}/api/events`);
  sse.addEventListener('file-change', (e: MessageEvent) => {
    onFileChange(JSON.parse(e.data));
  });
  return sse;
}
