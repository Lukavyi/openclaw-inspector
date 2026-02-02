export interface SessionRow {
  Filename: string;
  SessionId: string;
  Disk: string;
  Reason: string;
  Label: string;
  Description: string;
  'Web UI': string;
  _size: number;
  _mtime: number;
  _createdAt: string;
  _lastModified: number;
}

export interface Filters {
  read: 'all' | 'unread' | 'partial' | 'done';
  lifecycle: string[];  // ['active', 'orphan', 'deleted'] — empty = all
  dangerOnly: boolean;
}

export interface ProgressEntry {
  lastReadId?: string;
  lastReadAt?: string;
  totalMsgs?: number;
  unreadCount?: number;
  readAll?: boolean;
  customLabel?: string;
  _lastReadIdx?: number;
}

export type Progress = Record<string, ProgressEntry>;

export interface DangerHit {
  msgId: string;
  command: string;
  category: string;
  severity: string;
  label: string;
}

export type DangerData = Record<string, DangerHit[]>;

export interface ParseError {
  line: number;
  raw: string;
  error: string;
}

export interface SessionEntry {
  type: string;
  id?: string;
  timestamp?: string;
  message?: SessionMessage;
  modelId?: string;
  thinkingLevel?: string;
  tokensBefore?: number;
  summary?: string;
  customType?: string;
  cwd?: string;
  _parseError?: ParseError;
  _lineNumber?: number;
  [key: string]: unknown;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface ToolCallContent {
  type: 'toolCall';
  name?: string;
  input?: Record<string, unknown>;
}

export interface ImageContent {
  type: 'image';
  mimeType?: string;
  data?: string;
  url?: string;
}

export type MessageContent = TextContent | ThinkingContent | ToolCallContent | ImageContent | { type: string; [key: string]: unknown };

export interface SessionMessage {
  role: string;
  content: MessageContent[];
  isError?: boolean;
  toolName?: string;
  toolCallId?: string;
  usage?: {
    totalTokens?: number;
    input?: number;
    output?: number;
  };
}

export interface Toast {
  id: number;
  message: string;
}

export interface SessionApiResponse {
  filename: string;
  sessionId?: string;
  deleted?: boolean;
  status?: string;
  label?: string;
  size: number;
  mtime: number;
  createdAt: string;
}

export interface CSVRow {
  Filename: string;
  'Web UI'?: string;
  Reason?: string;
  Label?: string;
  Description?: string;
  [key: string]: string | undefined;
}
