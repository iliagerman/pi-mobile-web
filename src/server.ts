import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { addProject, getProject, listProjects, removeProject, touchProject } from "./store.js";
import {
  createPiSession,
  eventPayload,
  getSessionStatus,
  listAvailableModels,
  listPiSessions,
  loadClaudeMessages,
  setSessionModel,
  simplifyMessages,
} from "./pi-service.js";
import { deletePushSubscription, getVapidPublicKey, notifySessionFinished, savePushSubscription } from "./push.js";

type PiSessionHandle = Awaited<ReturnType<typeof createPiSession>>;

interface SharedPiSession {
  handle: PiSessionHandle;
  unsubscribe: () => void;
  clients: Set<WebSocket>;
  key: string;
  projectId: string;
  idleTimer: NodeJS.Timeout | null;
}

const port = Number(process.env.PORT ?? 8787);
const authToken = process.env.PI_WEB_TOKEN ?? "";
const app = express();
const server = createServer(app);
const webSocketServer = new WebSocketServer({ server, path: "/ws" });
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const sharedSessions = new Map<string, SharedPiSession>();
const idleSessionTimeoutMs = 30 * 60 * 1000;

const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(1000),
  synced: z.boolean().optional(),
  macPath: z.string().trim().max(1000).optional(),
});
const imageAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  data: z.string().min(1).max(6_000_000),
});
const textAttachmentSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  content: z.string().max(120_000),
});
const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
const pushSubscribeSchema = z.object({
  subscription: pushSubscriptionSchema,
  projectId: z.string().min(1),
  sessionPath: z.string().min(1),
  title: z.string().trim().max(120).optional(),
});
const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});
const socketMessageSchema = z.object({
  type: z.string().max(40),
  message: z.string().max(100_000).optional(),
  name: z.string().trim().max(120).optional(),
  provider: z.string().max(80).optional(),
  modelId: z.string().max(200).optional(),
  level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  images: z.array(imageAttachmentSchema).max(4).optional(),
  textAttachments: z.array(textAttachmentSchema).max(6).optional(),
});

function sendError(response: Response, statusCode: number, message: string): void {
  response.status(statusCode).json({ error: message });
}

function securityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

function tokenMatches(candidate: string | null): boolean {
  if (!authToken) return true;
  if (!candidate) return false;
  const expected = Buffer.from(authToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function requestToken(request: Request): string | null {
  const header = request.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1];
  const queryToken = request.query.token;
  return typeof queryToken === "string" ? queryToken : null;
}

function requireHttpAuth(request: Request, response: Response, next: NextFunction): void {
  if (tokenMatches(requestToken(request))) {
    next();
    return;
  }
  sendError(response, 401, "Unauthorized");
}

function tokenFromSocketRequest(requestUrl: string | undefined): string | null {
  const url = new URL(requestUrl ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

app.use(securityHeaders);
app.use(express.static(publicDir));
app.use(express.json({ limit: "512kb" }));
app.use("/api", requireHttpAuth);

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/push/vapid-public-key", async (_request, response, next) => {
  try {
    response.json({ publicKey: await getVapidPublicKey() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/subscribe", async (request, response, next) => {
  try {
    const payload = pushSubscribeSchema.parse(request.body);
    await savePushSubscription(payload.subscription, payload.projectId, payload.sessionPath, payload.title || "Pi");
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/unsubscribe", async (request, response, next) => {
  try {
    const payload = pushUnsubscribeSchema.parse(request.body);
    await deletePushSubscription(payload.endpoint);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/models", async (_request, response, next) => {
  try {
    response.json({ models: await listAvailableModels() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (_request, response, next) => {
  try {
    response.json({ projects: await listProjects() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", async (request, response, next) => {
  try {
    const payload = projectSchema.parse(request.body);
    const project = await addProject(payload.name, payload.path, { synced: payload.synced, macPath: payload.macPath });
    response.status(201).json({ project });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId", async (request, response, next) => {
  try {
    await removeProject(request.params.projectId);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await touchProject(project.id);
    response.json({ sessions: await listPiSessions(project.path) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId/sessions", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const sessionPath = typeof request.query.sessionPath === "string" ? request.query.sessionPath : "";
    if (!sessionPath.trim()) {
      sendError(response, 400, "Session path is required");
      return;
    }
    await rm(path.resolve(sessionPath), { force: true });
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/file", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    if (!requestedPath.trim()) {
      sendError(response, 400, "File path is required");
      return;
    }
    const projectRoot = path.resolve(project.path);
    const resolved = path.resolve(projectRoot, requestedPath);
    const relative = path.relative(projectRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      sendError(response, 403, "File is outside the project directory");
      return;
    }
    let info;
    try {
      info = await stat(resolved);
    } catch {
      sendError(response, 404, "File not found");
      return;
    }
    if (!info.isFile()) {
      sendError(response, 400, "Path is not a file");
      return;
    }
    const fileName = path.basename(resolved);
    response.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/["\r\n]/g, "")}"`);
    response.setHeader("Content-Length", String(info.size));
    createReadStream(resolved).pipe(response);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  sendError(response, 500, message);
});

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(session: SharedPiSession, payload: unknown): void {
  for (const client of session.clients) send(client, payload);
}

function parseSessionPath(value: string | null): string | undefined {
  if (!value || value === "new") return undefined;
  return value;
}

function sendStatus(socket: WebSocket, handle: PiSessionHandle): void {
  send(socket, { type: "status", status: getSessionStatus(handle.session) });
}

function sessionKey(cwd: string, sessionPath: string | undefined): string {
  return `${cwd}\n${sessionPath ?? "new"}`;
}

function clearIdleTimer(session: SharedPiSession): void {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function disposeSharedSession(session: SharedPiSession): void {
  session.unsubscribe();
  session.handle.dispose();
  for (const [key, value] of sharedSessions.entries()) {
    if (value === session) sharedSessions.delete(key);
  }
}

function scheduleIdleDispose(session: SharedPiSession): void {
  clearIdleTimer(session);
  if (session.handle.session.isStreaming) return;
  session.idleTimer = setTimeout(() => {
    if (session.clients.size || session.handle.session.isStreaming) {
      scheduleIdleDispose(session);
      return;
    }
    disposeSharedSession(session);
  }, idleSessionTimeoutMs);
}

async function getSharedSession(projectId: string, cwd: string, sessionPath: string | undefined): Promise<SharedPiSession> {
  if (sessionPath) {
    const existing = sharedSessions.get(sessionKey(cwd, sessionPath));
    if (existing) {
      clearIdleTimer(existing);
      return existing;
    }
  }

  const handle = await createPiSession({ cwd, sessionPath });
  const key = sessionKey(cwd, sessionPath ?? handle.session.sessionFile ?? `new:${Date.now()}:${Math.random()}`);
  const session: SharedPiSession = {
    handle,
    unsubscribe: () => undefined,
    clients: new Set(),
    key,
    projectId,
    idleTimer: null,
  };
  session.unsubscribe = handle.session.subscribe((event) => {
    broadcast(session, eventPayload(event));
    if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
      broadcast(session, { type: "status", status: getSessionStatus(handle.session) });
      const finishedSessionPath = handle.session.sessionFile;
      if (finishedSessionPath) {
        notifySessionFinished(session.projectId, finishedSessionPath, handle.session.sessionName || "Pi").catch((error) => console.warn("Push notification failed", error));
      }
      if (!session.clients.size) scheduleIdleDispose(session);
    }
  });
  sharedSessions.set(key, session);
  if (handle.session.sessionFile) sharedSessions.set(sessionKey(cwd, handle.session.sessionFile), session);
  return session;
}

function promptDisplayText(message: string, imageNames: string[], textAttachmentNames: string[]): string {
  const body = message.trim();
  const attachmentNames = [...imageNames, ...textAttachmentNames];
  if (!attachmentNames.length) return body;
  const suffix = `Attached: ${attachmentNames.join(", ")}`;
  return body ? `${body}\n\n${suffix}` : suffix;
}

function promptTextWithAttachments(message: string, imageAttachments: Array<{ name: string; path: string }>, textAttachments: Array<{ name: string; content: string }>): string {
  const parts: string[] = [];
  const body = message.trim();
  if (body) parts.push(body);
  if (imageAttachments.length) {
    parts.push(`Image attachments:\n${imageAttachments.map((image) => `- ${image.name}: ${image.path}`).join("\n")}\nAnalyze them alongside the request. Use these paths when a tool needs the original image file.`);
  }
  for (const attachment of textAttachments) {
    parts.push(`Attachment: ${attachment.name}\n\n\`\`\`\n${attachment.content}\n\`\`\``);
  }
  return parts.join("\n\n").trim();
}

function safeAttachmentName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function persistImageAttachments(cwd: string, images: Array<{ name: string; data: string }>): Promise<Array<{ name: string; path: string }>> {
  if (!images.length) return [];
  const attachmentDir = path.join(cwd, ".pi-mobile-web-attachments");
  await mkdir(attachmentDir, { recursive: true });
  const savedImages: Array<{ name: string; path: string }> = [];
  for (const image of images) {
    const filePath = path.join(attachmentDir, `${Date.now()}-${randomUUID()}-${safeAttachmentName(image.name)}`);
    await writeFile(filePath, Buffer.from(image.data, "base64"));
    savedImages.push({ name: image.name, path: filePath });
  }
  return savedImages;
}

async function handleSocketCommand(socket: WebSocket, handle: PiSessionHandle, cwd: string, raw: Buffer): Promise<void> {
  const payload = socketMessageSchema.parse(JSON.parse(raw.toString()));

  if (payload.type === "prompt") {
    const textAttachments = payload.textAttachments ?? [];
    const imageAttachments = await persistImageAttachments(cwd, payload.images ?? []);
    const promptText = promptTextWithAttachments(payload.message ?? "", imageAttachments, textAttachments);
    if (!promptText) return;
    send(socket, { type: "userMessage", text: promptDisplayText(payload.message ?? "", imageAttachments.map((image) => image.name), textAttachments.map((attachment) => attachment.name)) });
    const options = {
      ...(handle.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      ...(payload.images?.length
        ? {
            images: payload.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          }
        : {}),
    };
    await handle.session.prompt(promptText, options);
    send(socket, { type: "sessionsChanged" });
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "rename") {
    handle.session.setSessionName(payload.name?.trim() ?? "");
    sendStatus(socket, handle);
    send(socket, { type: "sessionsChanged" });
    return;
  }

  if (payload.type === "models") {
    send(socket, { type: "models", models: await listAvailableModels() });
    return;
  }

  if (payload.type === "ping") {
    send(socket, { type: "pong" });
    return;
  }

  if (payload.type === "setModel") {
    if (!payload.provider || !payload.modelId) throw new Error("Missing model selection");
    await setSessionModel(handle.session, payload.provider, payload.modelId);
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "cycleModel") {
    await handle.session.cycleModel();
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "setThinking") {
    if (!payload.level) throw new Error("Missing thinking level");
    handle.session.setThinkingLevel(payload.level);
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "cycleThinking") {
    handle.session.cycleThinkingLevel();
    sendStatus(socket, handle);
    return;
  }

  if (payload.type === "abort") {
    handle.session.abortRetry();
    handle.session.abortCompaction();
    handle.session.abortBranchSummary();
    handle.session.abortBash();
    await handle.session.abort();
    sendStatus(socket, handle);
  }
}

webSocketServer.on("connection", async (socket, request) => {
  if (!tokenMatches(tokenFromSocketRequest(request.url))) {
    socket.close(1008, "Unauthorized");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const projectId = url.searchParams.get("projectId") ?? "";
  const project = await getProject(projectId);
  if (!project) {
    socket.close(1008, "Project not found");
    return;
  }

  const requestedSessionPath = parseSessionPath(url.searchParams.get("sessionPath"));
  if (requestedSessionPath?.startsWith("claude:")) {
    try {
      send(socket, {
        type: "ready",
        project,
        sessionId: requestedSessionPath,
        sessionFile: requestedSessionPath,
        messages: await loadClaudeMessages(requestedSessionPath),
        models: await listAvailableModels(),
        readOnly: true,
      });
    } catch (error) {
      send(socket, { type: "error", error: error instanceof Error ? error.message : "Could not load Claude session" });
    }
    return;
  }

  let sharedSession: SharedPiSession;
  try {
    sharedSession = await getSharedSession(project.id, project.path, requestedSessionPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start Pi session";
    send(socket, { type: "error", error: message });
    socket.close(1011, message);
    return;
  }

  const { handle } = sharedSession;
  sharedSession.clients.add(socket);
  send(socket, {
    type: "ready",
    project,
    sessionId: handle.session.sessionId,
    sessionFile: handle.session.sessionFile,
    messages: simplifyMessages(handle.session.messages as unknown[]),
    status: getSessionStatus(handle.session),
    models: await listAvailableModels(),
  });

  socket.on("message", async (raw) => {
    try {
      await handleSocketCommand(socket, handle, project.path, raw as Buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      send(socket, { type: "error", error: message });
      sendStatus(socket, handle);
    }
  });

  socket.on("close", () => {
    sharedSession.clients.delete(socket);
    scheduleIdleDispose(sharedSession);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Pi Mobile Web listening on http://0.0.0.0:${port}`);
});
