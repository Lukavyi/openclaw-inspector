import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchSessions, fetchCounts, fetchCSV, fetchDanger, fetchProgress, saveProgress as saveProgressApi, fetchSession, connectSSE, searchSessions } from './api';
import { parseCSV, shortName, progressKey } from './utils';
import { useLocalStorage } from './hooks/useLocalStorage';
import Sidebar from './components/Sidebar';
import MessageViewer from './components/MessageViewer';
import Toast from './components/Toast';
import type { SessionRow, Progress, DangerData, SessionEntry, ParseError, Toast as ToastType, Filters } from './types';

const DEFAULT_FILTERS: Filters = { read: 'all', lifecycle: [], dangerOnly: false };

const KNOWN_TYPES = new Set([
  'session', 'message', 'model_change',
  'thinking_level_change', 'compaction', 'custom',
]);

function parseJSONL(text: string): { entries: SessionEntry[]; parseErrors: ParseError[]; totalLines: number } {
  const lines = text.split('\n');
  const entries: SessionEntry[] = [];
  const parseErrors: ParseError[] = [];
  let totalLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    totalLines++;
    try {
      const obj = JSON.parse(line) as SessionEntry;
      obj._lineNumber = i + 1;
      entries.push(obj);
    } catch (e) {
      const err: ParseError = {
        line: i + 1,
        raw: line.length > 200 ? line.slice(0, 200) + '…' : line,
        error: e instanceof Error ? e.message : String(e),
      };
      parseErrors.push(err);
      // Add a synthetic entry so it's visible in the UI
      entries.push({
        type: '_parseError',
        _parseError: err,
        _lineNumber: i + 1,
      });
    }
  }
  return { entries, parseErrors, totalLines };
}

export default function App() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [progress, setProgress] = useState<Progress>({});
  const [dangerData, setDangerData] = useState<DangerData>({});
  const [currentFile, setCurrentFile] = useLocalStorage<string | null>('inspector_currentFile', null);
  const [currentEntries, setCurrentEntries] = useState<SessionEntry[]>([]);
  const [currentRow, setCurrentRow] = useState<SessionRow | null>(null);
  const [filters, setFilters] = useLocalStorage<Filters>('inspector_filters', DEFAULT_FILTERS);
  const [activeSort, setActiveSort] = useLocalStorage<string>('inspector_sort', 'created-asc');
  const [allExpanded, setAllExpanded] = useLocalStorage<boolean>('inspector_expanded', true);
  const [dangerOnly, setDangerOnly] = useLocalStorage<boolean>('inspector_dangerOnly', false);
  const [sidebarSearch, setSidebarSearch] = useLocalStorage<string>('inspector_sidebarSearch', '');
  const [detailsOpen, setDetailsOpen] = useLocalStorage<boolean>('inspector_detailsOpen', false);
  const [msgSearch, setMsgSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastType[]>([]);
  const [loading, setLoading] = useState(false);
  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);
  const [totalLines, setTotalLines] = useState(0);
  const [contentMatches, setContentMatches] = useState<Set<string> | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced content search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = sidebarSearch.trim();
    if (q.length < 2) { setContentMatches(null); return; }
    searchTimerRef.current = setTimeout(async () => {
      const results = await searchSessions(q);
      setContentMatches(new Set(results));
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [sidebarSearch]);

  const progressRef = useRef(progress);
  progressRef.current = progress;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const currentFileRef = useRef(currentFile);
  currentFileRef.current = currentFile;

  const saveProgress = useCallback((newProgress: Progress) => {
    setProgress(newProgress);
    progressRef.current = newProgress;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveProgressApi(newProgress);
    }, 300);
  }, []);

  const addToast = useCallback((message: string) => {
    const id = Date.now();
    setToasts(t => [...t, { id, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  // Load initial data
  useEffect(() => {
    (async () => {
      const [sessData, counts, csvText, danger, prog] = await Promise.all([
        fetchSessions(), fetchCounts(), fetchCSV(), fetchDanger(), fetchProgress()
      ]);

      const csvRows = csvText ? parseCSV(csvText) : [];
      const csvMap: Record<string, Record<string, string | undefined>> = {};
      csvRows.forEach(r => { csvMap[r.Filename] = r; });

      // Migrate progress from filename-keyed to sessionId-keyed
      const migratedProg: Progress = { ...prog };
      const sidMap: Record<string, string> = {};
      sessData.forEach(s => {
        if (s.sessionId) sidMap[s.filename] = s.sessionId;
      });
      for (const [key, val] of Object.entries(prog)) {
        if (key.endsWith('.jsonl') || key.includes('.deleted.')) {
          const sid = sidMap[key];
          if (sid && !migratedProg[sid]) {
            migratedProg[sid] = val;
          }
          delete migratedProg[key];
        }
      }

      const built: SessionRow[] = sessData.map(s => {
        const csv = csvMap[s.filename] || {};
        const total = counts[s.filename] || 0;
        const pKey = s.sessionId || s.filename;
        if (!migratedProg[pKey]) migratedProg[pKey] = {};
        migratedProg[pKey].totalMsgs = total;
        if (!migratedProg[pKey].lastReadId) migratedProg[pKey].unreadCount = total;
        return {
          Filename: s.filename,
          SessionId: s.sessionId || s.filename,
          Disk: s.deleted ? 'DEL' : 'LIVE',
          'Web UI': csv['Web UI'] || '',
          Reason: s.status || csv.Reason || (s.deleted ? 'deleted' : '') || '',
          Label: s.label || csv.Label || '',
          Description: csv.Description || '',
          _size: s.size,
          _mtime: s.mtime,
          _createdAt: s.createdAt,
          _lastModified: s.mtime,
        };
      });
      Object.assign(prog, migratedProg);

      setSessions(built);
      setProgress(prog);
      progressRef.current = prog;
      setDangerData(danger);

      if (currentFile) {
        const row = built.find(r => r.Filename === currentFile);
        if (row) {
          loadSessionData(currentFile, row, prog);
        }
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE
  useEffect(() => {
    const sse = connectSSE(async (data) => {
      const { filename } = data;

      try {
        const [counts, sessData] = await Promise.all([fetchCounts(), fetchSessions()]);
        const csvText = await fetchCSV();
        const csvRows = csvText ? parseCSV(csvText) : [];
        const csvMap: Record<string, Record<string, string | undefined>> = {};
        csvRows.forEach(r => { csvMap[r.Filename] = r; });

        const newProg: Progress = { ...progressRef.current };
        const sidMap: Record<string, string> = {};
        sessData.forEach(s => { if (s.sessionId) sidMap[s.filename] = s.sessionId; });

        const built: SessionRow[] = sessData.map(s => {
          const csv = csvMap[s.filename] || {};
          const total = counts[s.filename] || 0;
          const pk = s.sessionId || s.filename;
          const oldTotal = newProg[pk]?.totalMsgs || 0;
          if (!newProg[pk]) newProg[pk] = {};
          newProg[pk].totalMsgs = total;
          if (!newProg[pk].lastReadId) newProg[pk].unreadCount = total;
          else {
            newProg[pk].unreadCount = Math.max(0, total - (oldTotal - (newProg[pk].unreadCount || 0)));
          }
          return {
            Filename: s.filename,
            SessionId: s.sessionId || s.filename,
            Disk: s.deleted ? 'DEL' : 'LIVE',
            'Web UI': csv['Web UI'] || '',
            Reason: s.status || csv.Reason || (s.deleted ? 'deleted' : '') || '',
            Label: s.label || csv.Label || '',
            Description: csv.Description || '',
            _size: s.size,
            _mtime: s.mtime,
            _createdAt: s.createdAt,
            _lastModified: s.mtime,
          };
        });

        const oldSessions = sessionsRef.current;
        const oldEntry = oldSessions.find(s => s.Filename === filename);
        const pk = sidMap[filename] || filename;
        const oldCount = oldEntry ? (progressRef.current[pk]?.totalMsgs || 0) : 0;
        const newCount = counts[filename] || 0;
        if (newCount > oldCount && oldEntry) {
          const diff = newCount - oldCount;
          const label = newProg[pk]?.customLabel || oldEntry.Label || shortName(filename);
          if (filename !== currentFileRef.current) {
            addToast(`+${diff} new message${diff > 1 ? 's' : ''} in ${label}`);
          }
        } else if (!oldEntry && counts[filename]) {
          addToast(`New session: ${shortName(filename)}`);
        }

        newProg[pk] = newProg[pk] || {};
        newProg[pk].totalMsgs = counts[filename] || 0;

        setSessions(built);
        setProgress(newProg);
        progressRef.current = newProg;

        if (currentFileRef.current === filename) {
          const row = built.find(r => r.Filename === filename);
          loadSessionData(filename, row || null, newProg);
        }
      } catch (e) {
        console.error('SSE refresh error:', e);
      }
    });
    return () => sse.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSessionData(filename: string, row: SessionRow | null | undefined, prog?: Progress) {
    setLoading(true);
    const pk = row?.SessionId || filename;
    try {
      const text = await fetchSession(filename);
      const { entries, parseErrors: errors, totalLines: total } = parseJSONL(text);
      setParseErrors(errors);
      setTotalLines(total);
      const msgs = entries.filter(e => e.type === 'message');

      const p = prog || progressRef.current;
      const newProg: Progress = { ...p };
      if (!newProg[pk]) newProg[pk] = {};
      newProg[pk].totalMsgs = msgs.length;
      const lastId = newProg[pk].lastReadId;
      if (!lastId) {
        newProg[pk].unreadCount = msgs.length;
      } else {
        const idx = msgs.findIndex(e => e.id === lastId);
        newProg[pk].unreadCount = idx === -1 ? msgs.length : msgs.length - idx - 1;
      }

      setCurrentEntries(entries);
      setCurrentRow(row || null);
      setProgress(newProg);
      progressRef.current = newProg;
    } catch {
      setCurrentEntries([]);
    }
    setLoading(false);
  }

  function handleSelectSession(filename: string) {
    setCurrentFile(filename);
    const row = sessions.find(r => r.Filename === filename);
    setCurrentRow(row || null);
    loadSessionData(filename, row);
    setSidebarOpen(false);
    setDangerOnly(false);
    setMsgSearch('');
  }

  function handleMarkRead(filename: string, messageId: string) {
    if (dangerOnly) return;
    const row = sessions.find(r => r.Filename === filename);
    const pk = row?.SessionId || filename;
    const msgs = currentEntries.filter(e => e.type === 'message');
    const lastMsg = msgs[msgs.length - 1];
    const isLast = !!lastMsg && lastMsg.id === messageId;
    const idx = msgs.findIndex(e => e.id === messageId);
    const unread = idx === -1 ? msgs.length : msgs.length - idx - 1;

    const newProg: Progress = { ...progressRef.current };
    newProg[pk] = {
      ...newProg[pk],
      lastReadId: messageId,
      lastReadAt: new Date().toISOString(),
      totalMsgs: msgs.length,
      unreadCount: unread,
      readAll: isLast,
    };
    saveProgress(newProg);
  }

  function handleRename(filename: string, newLabel: string) {
    const row = sessions.find(r => r.Filename === filename);
    const pk = row?.SessionId || filename;
    const newProg: Progress = { ...progressRef.current };
    if (!newProg[pk]) newProg[pk] = {};
    if (newLabel) {
      newProg[pk].customLabel = newLabel;
    } else {
      delete newProg[pk].customLabel;
    }
    saveProgress(newProg);
  }

  return (
    <div className="container">
      <Sidebar
        sessions={sessions}
        progress={progress}
        dangerData={dangerData}
        currentFile={currentFile}
        filters={filters}
        setFilters={setFilters}
        activeSort={activeSort}
        setActiveSort={setActiveSort}
        searchQuery={sidebarSearch}
        setSearchQuery={setSidebarSearch}
        contentMatches={contentMatches}
        onSelect={handleSelectSession}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="main">
        {currentFile ? (
          <MessageViewer
            filename={currentFile}
            entries={currentEntries}
            row={currentRow}
            progress={progress}
            dangerData={dangerData}
            allExpanded={allExpanded}
            setAllExpanded={setAllExpanded}
            dangerOnly={dangerOnly}
            setDangerOnly={setDangerOnly}
            msgSearch={msgSearch}
            setMsgSearch={setMsgSearch}
            onMarkRead={handleMarkRead}
            onRename={handleRename}
            detailsOpen={detailsOpen}
            setDetailsOpen={setDetailsOpen}
            loading={loading}
            parseErrors={parseErrors}
            totalLines={totalLines}
          />
        ) : (
          <div className="empty">🔍 OpenClaw Inspector — select a session</div>
        )}
      </div>
      <button className="mobile-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
      <Toast toasts={toasts} />
    </div>
  );
}
