import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchSessions, fetchCounts, fetchCSV, fetchDanger, fetchProgress, saveProgress as saveProgressApi, fetchSession, connectSSE, searchSessions, fetchSubagents, fetchAgents, fetchPins, addPin as addPinApi, removePin as removePinApi } from './api';
import type { SubagentInfo, SearchMatch } from './api';
import { parseCSV, shortName, progressKey, extractTopicId, fileCacheKey } from './utils';
import { useLocalStorage } from './hooks/useLocalStorage';
import Sidebar from './components/Sidebar';
import PinnedView from './components/PinnedView';
import MessageViewer from './components/MessageViewer';
import Toast from './components/Toast';
import type { SessionRow, Progress, DangerData, SessionEntry, ParseError, Toast as ToastType, Filters, Pin } from './types';

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
  const [agents, setAgents] = useState<string[]>([]);
  const [agentFilter, setAgentFilter] = useLocalStorage<string>('inspector_agentFilter', '__all__');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [progress, setProgress] = useState<Progress>({});
  const [dangerData, setDangerData] = useState<DangerData>({});
  const [currentFile, setCurrentFile] = useLocalStorage<string | null>('inspector_currentFile', null);
  const [currentAgentId, setCurrentAgentId] = useLocalStorage<string | null>('inspector_currentAgentId', null);
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
  const [subagentMap, setSubagentMap] = useState<Record<string, SubagentInfo>>({});
  const [pins, setPins] = useState<Pin[]>([]);
  const [showPinned, setShowPinned] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced content search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = sidebarSearch.trim();
    if (q.length < 2) { setContentMatches(null); return; }
    searchTimerRef.current = setTimeout(async () => {
      const results: SearchMatch[] = await searchSessions(q);
      // Build set of "agentId:filename" for matching
      setContentMatches(new Set(results.map(r => fileCacheKey(r.agentId, r.filename))));
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
  const currentAgentIdRef = useRef(currentAgentId);
  currentAgentIdRef.current = currentAgentId;
  const currentEntriesRef = useRef(currentEntries);
  currentEntriesRef.current = currentEntries;

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
      const [agentList, sessData, counts, csvText, danger, prog, subs, pinsData] = await Promise.all([
        fetchAgents(), fetchSessions(), fetchCounts(), fetchCSV(), fetchDanger(), fetchProgress(), fetchSubagents(), fetchPins()
      ]);
      setAgents(agentList);
      setSubagentMap(subs);
      setPins(pinsData);

      const csvRows = csvText ? parseCSV(csvText) : [];
      const csvMap: Record<string, Record<string, string | undefined>> = {};
      csvRows.forEach(r => { csvMap[r.Filename] = r; });

      // Migrate progress: old keys (without agentId prefix) → new keys with agentId
      const migratedProg: Progress = { ...prog };
      const sidMap: Record<string, { sessionId: string; agentId: string }> = {};
      sessData.forEach(s => {
        if (s.sessionId) sidMap[s.filename] = { sessionId: s.sessionId, agentId: s.agentId };
      });

      // Step 1: migrate old filename keys → new agentId-prefixed keys
      for (const [key, val] of Object.entries(prog)) {
        if (key.endsWith('.jsonl') || key.includes('.deleted.')) {
          const info = sidMap[key];
          const agentId = info?.agentId || 'main';
          const sid = info?.sessionId || key;
          const topicId = extractTopicId(key);
          const newKey = topicId ? `${agentId}:${sid}:${topicId}` : `${agentId}:${sid}`;
          if (!migratedProg[newKey]) {
            migratedProg[newKey] = val;
          }
          delete migratedProg[key];
        }
      }

      // Step 2: migrate old sessionId-only keys to agentId-prefixed
      for (const s of sessData) {
        if (!s.sessionId) continue;
        const topicId = extractTopicId(s.filename);
        const oldKey = topicId ? `${s.sessionId}:${topicId}` : s.sessionId;
        const newKey = topicId ? `${s.agentId}:${s.sessionId}:${topicId}` : `${s.agentId}:${s.sessionId}`;
        if (migratedProg[oldKey] && !migratedProg[newKey]) {
          migratedProg[newKey] = migratedProg[oldKey];
        }
        // Keep old key for now to avoid data loss, will be cleaned up naturally
      }

      const built: SessionRow[] = sessData.map(s => {
        const csv = csvMap[s.filename] || {};
        const ck = fileCacheKey(s.agentId, s.filename);
        const total = counts[ck] || 0;
        const topicId = extractTopicId(s.filename);
        const pKey = topicId && s.sessionId
          ? `${s.agentId}:${s.sessionId}:${topicId}`
          : `${s.agentId}:${s.sessionId || s.filename}`;
        if (!migratedProg[pKey]) migratedProg[pKey] = {};
        migratedProg[pKey].totalMsgs = total;
        if (!migratedProg[pKey].lastReadId) migratedProg[pKey].unreadCount = total;
        return {
          Filename: s.filename,
          agentId: s.agentId,
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

      if (currentFile && currentAgentId) {
        const row = built.find(r => r.Filename === currentFile && r.agentId === currentAgentId);
        if (row) {
          loadSessionData(currentAgentId, currentFile, row, prog);
        }
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE
  useEffect(() => {
    const sse = connectSSE(async (data) => {
      const { filename, agentId } = data;

      try {
        const [counts, sessData] = await Promise.all([fetchCounts(), fetchSessions()]);
        const csvText = await fetchCSV();
        const csvRows = csvText ? parseCSV(csvText) : [];
        const csvMap: Record<string, Record<string, string | undefined>> = {};
        csvRows.forEach(r => { csvMap[r.Filename] = r; });

        const newProg: Progress = { ...progressRef.current };
        const sidMap: Record<string, { sessionId: string; agentId: string }> = {};
        sessData.forEach(s => { if (s.sessionId) sidMap[s.filename] = { sessionId: s.sessionId, agentId: s.agentId }; });

        const built: SessionRow[] = sessData.map(s => {
          const csv = csvMap[s.filename] || {};
          const ck = fileCacheKey(s.agentId, s.filename);
          const total = counts[ck] || 0;
          const topicId = extractTopicId(s.filename);
          const pk = topicId && s.sessionId
            ? `${s.agentId}:${s.sessionId}:${topicId}`
            : `${s.agentId}:${s.sessionId || s.filename}`;
          const oldTotal = newProg[pk]?.totalMsgs || 0;
          if (!newProg[pk]) newProg[pk] = {};
          newProg[pk].totalMsgs = total;
          if (!newProg[pk].lastReadId) newProg[pk].unreadCount = total;
          else {
            newProg[pk].unreadCount = Math.max(0, total - (oldTotal - (newProg[pk].unreadCount || 0)));
          }
          return {
            Filename: s.filename,
            agentId: s.agentId,
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
        const oldEntry = oldSessions.find(s => s.Filename === filename && s.agentId === agentId);
        const ck = fileCacheKey(agentId, filename);
        const topicId = extractTopicId(filename);
        const info = sidMap[filename];
        const sid = info?.sessionId || filename;
        const pk = topicId && info?.sessionId
          ? `${agentId}:${info.sessionId}:${topicId}`
          : `${agentId}:${sid}`;
        const oldCount = oldEntry ? (progressRef.current[pk]?.totalMsgs || 0) : 0;
        const newCount = counts[ck] || 0;
        if (newCount > oldCount && oldEntry) {
          const diff = newCount - oldCount;
          const label = newProg[pk]?.customLabel || oldEntry.Label || shortName(filename);
          if (filename !== currentFileRef.current || agentId !== currentAgentIdRef.current) {
            addToast(`+${diff} new message${diff > 1 ? 's' : ''} in ${label}`);
          }
        } else if (!oldEntry && counts[ck]) {
          addToast(`New session: ${shortName(filename)} (${agentId})`);
        }

        newProg[pk] = newProg[pk] || {};
        newProg[pk].totalMsgs = counts[ck] || 0;

        setSessions(built);
        setProgress(newProg);
        progressRef.current = newProg;

        if (currentFileRef.current === filename && currentAgentIdRef.current === agentId) {
          const row = built.find(r => r.Filename === filename && r.agentId === agentId);
          loadSessionData(agentId, filename, row || null, newProg, true);
        }
      } catch (e) {
        console.error('SSE refresh error:', e);
      }
    });
    return () => sse.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSessionData(agentId: string, filename: string, row: SessionRow | null | undefined, prog?: Progress, incremental?: boolean) {
    if (!incremental) setLoading(true);
    const pk = row ? progressKey(row) : `${agentId}:${filename}`;
    try {
      const text = await fetchSession(agentId, filename);
      const { entries, parseErrors: errors, totalLines: total } = parseJSONL(text);

      if (incremental) {
        const prev = currentEntriesRef.current;
        if (entries.length <= prev.length) {
          setCurrentRow(row || null);
          return;
        }
        const newEntries = entries.slice(prev.length);
        setCurrentEntries(prevEntries => [...prevEntries, ...newEntries]);
      } else {
        setCurrentEntries(entries);
      }

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

      setCurrentRow(row || null);
      setProgress(newProg);
      progressRef.current = newProg;
    } catch {
      if (!incremental) setCurrentEntries([]);
    }
    if (!incremental) setLoading(false);
  }

  function handleSelectSession(filename: string, agentId: string) {
    setCurrentFile(filename);
    setCurrentAgentId(agentId);
    const row = sessions.find(r => r.Filename === filename && r.agentId === agentId);
    setCurrentRow(row || null);
    loadSessionData(agentId, filename, row);
    setSidebarOpen(false);
    setDangerOnly(false);
    setMsgSearch('');
  }

  function handleMarkRead(filename: string, messageId: string) {
    if (dangerOnly) return;
    const row = sessions.find(r => r.Filename === filename && r.agentId === currentAgentId);
    const pk = row ? progressKey(row) : `${currentAgentId}:${filename}`;
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

    };
    saveProgress(newProg);
  }

  function handleSubagentMarkRead(pKey: string, messageId: string) {
    const newProg: Progress = { ...progressRef.current };
    if (!newProg[pKey]) newProg[pKey] = {};
    newProg[pKey] = {
      ...newProg[pKey],
      lastReadId: messageId,
      lastReadAt: new Date().toISOString(),
    };
    saveProgress(newProg);
  }

  function handleRename(filename: string, newLabel: string) {
    const row = sessions.find(r => r.Filename === filename && r.agentId === currentAgentId);
    const pk = row ? progressKey(row) : `${currentAgentId}:${filename}`;
    const newProg: Progress = { ...progressRef.current };
    if (!newProg[pk]) newProg[pk] = {};
    if (newLabel) {
      newProg[pk].customLabel = newLabel;
    } else {
      delete newProg[pk].customLabel;
    }
    saveProgress(newProg);
  }

  function handlePinChat(filename: string) {
    const row = sessions.find(r => r.Filename === filename && r.agentId === currentAgentId);
    const pk = row ? progressKey(row) : `${currentAgentId}:${filename}`;
    const newProg: Progress = { ...progressRef.current };
    if (!newProg[pk]) newProg[pk] = {};
    newProg[pk].pinnedChat = !newProg[pk].pinnedChat;
    saveProgress(newProg);
    addToast(newProg[pk].pinnedChat ? '📌 Chat pinned' : 'Chat unpinned');
  }

  function handleMarkAllRead(filename: string) {
    const msgs = currentEntries.filter(e => e.type === 'message');
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg?.id) return;
    handleMarkRead(filename, lastMsg.id);
    addToast('Marked all as read');
  }

  async function handlePinMessage(filename: string, entry: SessionEntry) {
    if (!entry.id || !entry.message) return;
    const row = sessions.find(r => r.Filename === filename && r.agentId === currentAgentId);
    const preview = (entry.message.content || [])
      .filter(c => c.type === 'text')
      .map(c => (c as { text: string }).text)
      .join('\n')
      .substring(0, 300);
    const pin = await addPinApi({
      agentId: currentAgentId || 'main',
      filename,
      msgId: entry.id,
      preview,
      role: entry.message.role || 'unknown',
      timestamp: entry.timestamp,
      sessionLabel: row ? (progressRef.current[progressKey(row)]?.customLabel || row.Label || shortName(filename)) : shortName(filename),
    });
    if (pin) {
      setPins(prev => [...prev, pin]);
      addToast('📌 Pinned');
    }
  }

  async function handleUnpinMessage(pinId: string) {
    await removePinApi(pinId);
    setPins(prev => prev.filter(p => p.id !== pinId));
    addToast('Unpinned');
  }

  function handleNavigateToPin(filename: string, msgId: string) {
    // Find the pin to get agentId
    const pin = pins.find(p => p.filename === filename && p.msgId === msgId);
    const agentId = pin?.agentId || currentAgentId || 'main';
    setShowPinned(false);
    if (agentId !== currentAgentId) {
      setAgentFilter(agentId);
    }
    setCurrentFile(filename);
    setCurrentAgentId(agentId);
    const row = sessions.find(r => r.Filename === filename && r.agentId === agentId);
    setCurrentRow(row || null);
    loadSessionData(agentId, filename, row).then(() => {
      setTimeout(() => {
        handleMarkRead(filename, msgId);
      }, 200);
    });
  }

  return (
    <div className="container">
      <Sidebar
        sessions={sessions}
        agents={agents}
        agentFilter={agentFilter}
        setAgentFilter={setAgentFilter}
        progress={progress}
        dangerData={dangerData}
        currentFile={currentFile}
        currentAgentId={currentAgentId}
        filters={filters}
        setFilters={setFilters}
        activeSort={activeSort}
        setActiveSort={setActiveSort}
        searchQuery={sidebarSearch}
        setSearchQuery={setSidebarSearch}
        contentMatches={contentMatches}
        subagentMap={subagentMap}
        onSelect={(f, a) => { setShowPinned(false); handleSelectSession(f, a); }}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        pinCount={pins.length}
        showPinned={showPinned}
        onTogglePinned={() => setShowPinned(!showPinned)}
      />
      <div className="main">
        {showPinned ? (
          <PinnedView
            pins={pins}
            onNavigate={handleNavigateToPin}
            onRemovePin={handleUnpinMessage}
          />
        ) : currentFile ? (
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
            onMarkAllRead={handleMarkAllRead}
            onPinChat={handlePinChat}
            onMarkRead={handleMarkRead}
            onSubagentMarkRead={handleSubagentMarkRead}
            onRename={handleRename}
            subagentMap={subagentMap}
            pins={pins}
            onPin={handlePinMessage}
            onUnpin={handleUnpinMessage}
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
