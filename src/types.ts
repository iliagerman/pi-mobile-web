export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  path: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  firstMessage?: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  text: string;
}

export interface ModelSummary {
  provider: string;
  id: string;
  label: string;
}

export interface SessionStatus {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  model?: ModelSummary;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  messageCount: number;
  activeTools: string[];
  promptTemplates: string[];
}

export interface ApiErrorBody {
  error: string;
}
