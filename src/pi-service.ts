import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ChatMessage, ModelSummary, SessionStatus, SessionSummary } from "./types.js";

interface PiSessionHandle {
  session: AgentSession;
  dispose: () => void;
}

interface PiSessionOptions {
  cwd: string;
  sessionPath?: string;
}

type UnknownRecord = Record<string, unknown>;

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
type AvailableModel = ReturnType<typeof modelRegistry.getAvailable>[number];

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = asRecord(part);
      return typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function textFromMessage(message: unknown): string {
  const record = asRecord(message);
  return textFromContent(record.content) || textFromContent(record.message) || "";
}

function serializeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return String(value);
  }
}

function textFromToolPayload(value: unknown): string {
  const record = asRecord(value);
  return (
    textFromContent(record.content) ||
    textFromContent(record.stdout) ||
    textFromContent(record.stderr) ||
    serializeValue(record.output) ||
    serializeValue(record.result) ||
    serializeValue(value)
  );
}

function roleFromMessage(message: unknown): string {
  const role = asRecord(message).role;
  return typeof role === "string" ? role : "assistant";
}

function titleFromSession(info: unknown): string {
  const record = asRecord(info);
  const firstMessage = typeof record.firstMessage === "string" ? record.firstMessage : "";
  const name = typeof record.name === "string" ? record.name : "";
  return name || firstMessage.slice(0, 80) || "Untitled Pi session";
}

function modelLabel(model: AvailableModel): string {
  const record = asRecord(model);
  const name = typeof record.name === "string" ? record.name : "";
  const displayName = typeof record.displayName === "string" ? record.displayName : "";
  const id = typeof record.id === "string" ? record.id : "unknown";
  return displayName || name || id;
}

export function summarizeModel(model: AvailableModel | undefined): ModelSummary | undefined {
  if (!model) return undefined;
  return {
    provider: String(model.provider),
    id: String(model.id),
    label: modelLabel(model),
  };
}

export function getSessionStatus(session: AgentSession): SessionStatus {
  return {
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    model: summarizeModel(session.model),
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isRetrying: session.isRetrying,
    isBashRunning: session.isBashRunning,
    pendingMessageCount: session.pendingMessageCount,
    messageCount: session.messages.length,
    activeTools: session.getActiveToolNames(),
    promptTemplates: session.promptTemplates.map((template) => template.name),
  };
}

function isDeprecatedDefault(model: AvailableModel | undefined): boolean {
  if (!model) return true;
  return String(model.provider) === "google" && String(model.id).startsWith("gemini-2.0");
}

function configuredPreferredModel(): AvailableModel | undefined {
  const configured = process.env.PI_MOBILE_WEB_MODEL?.trim();
  if (!configured) return undefined;

  const [provider, ...modelParts] = configured.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId) return undefined;

  return modelRegistry.find(provider, modelId);
}

function preferredModel(): AvailableModel | undefined {
  const available = modelRegistry.getAvailable();
  return (
    configuredPreferredModel() ??
    available.find((model) => model.provider === "openai" && model.id === "gpt-5.5") ??
    available.find((model) => model.provider === "openai-codex" && model.id === "gpt-5.4") ??
    available.find((model) => model.provider === "google" && model.id === "gemini-3.1-pro-preview") ??
    available.find((model) => model.provider === "google" && model.id === "gemini-2.5-pro") ??
    available.find((model) => !isDeprecatedDefault(model)) ??
    available[0]
  );
}

export async function listAvailableModels(): Promise<ModelSummary[]> {
  const preferred = preferredModel();
  return modelRegistry
    .getAvailable()
    .filter((model) => !isDeprecatedDefault(model))
    .sort((left, right) => {
      if (preferred && left.provider === preferred.provider && left.id === preferred.id) return -1;
      if (preferred && right.provider === preferred.provider && right.id === preferred.id) return 1;
      return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
    })
    .map((model) => summarizeModel(model))
    .filter((model): model is ModelSummary => Boolean(model));
}

export async function setSessionModel(session: AgentSession, provider: string, modelId: string): Promise<ModelSummary> {
  const model = modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  await session.setModel(model);
  const summary = summarizeModel(session.model);
  if (!summary) throw new Error("Model switch failed");
  return summary;
}

export function simplifyMessages(messages: unknown[]): ChatMessage[] {
  return messages
    .map((message, index) => ({
      id: `${index}`,
      role: roleFromMessage(message),
      text: textFromMessage(message),
    }))
    .filter((message) => message.text.trim().length > 0);
}

function sessionCwds(cwd: string): string[] {
  const macWork = "/Users/iliagerman/Work/personal_projects";
  const homeserverWork = "/home/ilia/Work/personal_projects";
  if (cwd.startsWith(`${homeserverWork}/`)) return [cwd, `${macWork}${cwd.slice(homeserverWork.length)}`];
  return [cwd];
}

async function summarizeSession(sessionInfo: unknown): Promise<SessionSummary> {
  const record = asRecord(sessionInfo);
  const sessionPath = String(record.path ?? "");
  const fileStat = sessionPath ? await stat(sessionPath) : undefined;
  return {
    id: String(record.id ?? record.path ?? randomUUID()),
    path: sessionPath,
    title: titleFromSession(record),
    createdAt: typeof record.created === "string" ? record.created : fileStat?.birthtime.toISOString(),
    updatedAt: typeof record.modified === "string" ? record.modified : fileStat?.mtime.toISOString(),
    firstMessage: typeof record.firstMessage === "string" ? record.firstMessage : undefined,
  };
}

export async function listPiSessions(cwd: string): Promise<SessionSummary[]> {
  const sessions = (await Promise.all(sessionCwds(cwd).map((sessionCwd) => SessionManager.list(sessionCwd)))) as unknown[][];
  const summaries = await Promise.all(sessions.flat().map(summarizeSession));
  const seen = new Set<string>();
  return summaries
    .filter((session) => {
      if (!session.path || seen.has(session.path)) return false;
      seen.add(session.path);
      return true;
    })
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? ""))
    .slice(0, 20);
}

export async function createPiSession(options: PiSessionOptions): Promise<PiSessionHandle> {
  const sessionManager = options.sessionPath
    ? SessionManager.open(options.sessionPath)
    : SessionManager.create(options.cwd);
  const result = await createAgentSession({ cwd: options.cwd, sessionManager, authStorage, modelRegistry });
  const session = result.session;
  if (isDeprecatedDefault(session.model)) {
    const model = preferredModel();
    if (model) await session.setModel(model);
  }

  if ("bindExtensions" in session && typeof session.bindExtensions === "function") {
    await session.bindExtensions({});
  }

  return {
    session,
    dispose: () => session.dispose(),
  };
}

export function eventPayload(event: AgentSessionEvent): UnknownRecord {
  const record = asRecord(event);
  if (event.type === "message_update") {
    const assistantEvent = asRecord(record.assistantMessageEvent);
    if (assistantEvent.type === "text_delta") {
      return { type: "textDelta", text: String(assistantEvent.delta ?? "") };
    }
    if (assistantEvent.type === "thinking_delta") {
      return { type: "thinkingDelta", text: String(assistantEvent.delta ?? "") };
    }
    if (assistantEvent.type === "thinking_start") {
      return { type: "thinkingStart" };
    }
    if (assistantEvent.type === "thinking_end") {
      return { type: "thinkingEnd" };
    }
  }

  if (event.type === "tool_execution_start") {
    return {
      type: "toolStart",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      args: record.args,
    };
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "toolUpdate",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      text: textFromToolPayload(record.partialResult),
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      type: "toolEnd",
      toolCallId: String(record.toolCallId ?? "tool"),
      toolName: String(record.toolName ?? "tool"),
      text: textFromToolPayload(record.result),
      isError: Boolean(record.isError),
    };
  }

  if (event.type === "message_end" || event.type === "turn_end") {
    const message = asRecord(record.message);
    if (typeof message.errorMessage === "string" && message.errorMessage) {
      return { type: "assistantError", error: message.errorMessage };
    }
    if (event.type === "message_end" && message.role === "assistant") {
      const text = textFromMessage(message);
      if (text) return { type: "assistantFinal", text };
    }
  }

  if (event.type === "agent_start" || event.type === "agent_end") {
    return { type: event.type };
  }

  if (event.type === "session_info_changed") {
    return { type: "sessionInfoChanged", name: record.name };
  }

  if (event.type === "thinking_level_changed") {
    return { type: "thinkingLevelChanged", level: record.level };
  }

  if (event.type === "queue_update") {
    const steering = Array.isArray(record.steering) ? record.steering.length : 0;
    const followUp = Array.isArray(record.followUp) ? record.followUp.length : 0;
    return { type: "queueUpdate", pending: steering + followUp };
  }

  return { type: event.type };
}
