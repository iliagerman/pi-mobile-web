import { renderMarkdown } from "./markdown.js";

const state = {
  projects: [],
  sessions: [],
  activeProjectId: localStorage.getItem("piWebActiveProjectId"),
  activeSessionPath: localStorage.getItem("piWebActiveSessionPath"),
  socket: null,
  reconnectTimer: null,
  heartbeatTimer: null,
  lastPongAt: 0,
  assistantBubble: null,
  thinkingBubble: null,
  toolBubbles: new Map(),
  models: [],
  activeModelKey: "",
  attachments: [],
  installPromptEvent: null,
  notificationsEnabled: localStorage.getItem("piWebNotifications") === "1",
  lastTurnStartedAt: 0,
  stickToBottom: true,
  token: new URLSearchParams(location.search).get("token") || localStorage.getItem("piWebToken") || "",
  initialProjectId: new URLSearchParams(location.search).get("projectId"),
  initialSessionPath: new URLSearchParams(location.search).get("sessionPath"),
};

const elements = {
  projectList: document.querySelector("#projectList"),
  sessionList: document.querySelector("#sessionList"),
  projectSearchInput: document.querySelector("#projectSearchInput"),
  projectName: document.querySelector("#projectName"),
  projectPath: document.querySelector("#projectPath"),
  sessionTitle: document.querySelector("#sessionTitle"),
  connectionStatus: document.querySelector("#connectionStatus"),
  messages: document.querySelector("#messages"),
  jumpLatestButton: document.querySelector("#jumpLatestButton"),
  composer: document.querySelector("#composer"),
  attachmentList: document.querySelector("#attachmentList"),
  attachmentInput: document.querySelector("#attachmentInput"),
  attachButton: document.querySelector("#attachButton"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  miniStatus: document.querySelector("#miniStatus"),
  modelShortcuts: document.querySelector("#modelShortcuts"),
  installAppButton: document.querySelector("#installAppButton"),
  cycleModelButton: document.querySelector("#cycleModelButton"),
  notifyButton: document.querySelector("#notifyButton"),
  renameSessionButton: document.querySelector("#renameSessionButton"),
  abortButton: document.querySelector("#abortButton"),
  newProjectButton: document.querySelector("#newProjectButton"),
  newSessionButton: document.querySelector("#newSessionButton"),
  projectDialog: document.querySelector("#projectDialog"),
  projectForm: document.querySelector("#projectForm"),
  cancelProjectButton: document.querySelector("#cancelProjectButton"),
  projectNameInput: document.querySelector("#projectNameInput"),
  projectPathInput: document.querySelector("#projectPathInput"),
  projectSyncedInput: document.querySelector("#projectSyncedInput"),
  projectMacPathInput: document.querySelector("#projectMacPathInput"),
  renameDialog: document.querySelector("#renameDialog"),
  renameForm: document.querySelector("#renameForm"),
  sessionNameInput: document.querySelector("#sessionNameInput"),
  cancelRenameButton: document.querySelector("#cancelRenameButton"),
  installBanner: document.querySelector("#installBanner"),
  installBannerButton: document.querySelector("#installBannerButton"),
  dismissInstallButton: document.querySelector("#dismissInstallButton"),
  toggleProjectsButton: document.querySelector("#toggleProjectsButton"),
  navProjectsButton: document.querySelector("#navProjectsButton"),
  navSessionsButton: document.querySelector("#navSessionsButton"),
  navChatButton: document.querySelector("#navChatButton"),
};

if (state.token) localStorage.setItem("piWebToken", state.token);

function headers() {
  return state.token ? { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  if (response.status === 204) return null;
  return response.json();
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 3200);
}

function notificationsSupported() {
  return typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function notificationPermissionGranted() {
  return notificationsSupported() && Notification.permission === "granted";
}

function syncNotifyButton() {
  const button = elements.notifyButton;
  const enabled = state.notificationsEnabled;
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  button.title = enabled ? "Notifications on — tap to turn off" : "Notify when Pi finishes";
  button.classList.toggle("active", enabled);
}

async function enableNotifications() {
  if (!notificationsSupported()) {
    toast("Push notifications are not supported on this browser");
    return;
  }
  if (Notification.permission !== "granted") {
    if (Notification.permission === "denied") {
      toast("Notifications are blocked. Enable them in your browser settings.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Notification permission was not granted");
      return;
    }
  }
  state.notificationsEnabled = true;
  localStorage.setItem("piWebNotifications", "1");
  syncNotifyButton();
  await subscribeToPush();
}

async function subscribeToPush() {
  if (!state.notificationsEnabled || !state.activeProjectId || !state.activeSessionPath || state.activeSessionPath === "new") return;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array((await api("/api/push/vapid-public-key")).publicKey),
  });
  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      projectId: state.activeProjectId,
      sessionPath: state.activeSessionPath,
      title: elements.sessionTitle.textContent || "Pi",
    }),
  });
}

async function disableNotifications() {
  state.notificationsEnabled = false;
  localStorage.setItem("piWebNotifications", "0");
  syncNotifyButton();
  if (!notificationsSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

async function maybeNotifyTurnComplete() {
  if (state.notificationsEnabled) await subscribeToPush();
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallButton() {
  const canInstall = Boolean(state.installPromptEvent);
  elements.installAppButton.hidden = !canInstall;
  const dismissed = sessionStorage.getItem("piWebInstallDismissed") === "1";
  elements.installBanner.hidden = !canInstall || dismissed || isStandalone();
}

function setStatus(text, live = false) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.classList.toggle("live", live);
}

function formatDate(value) {
  if (!value) return "recent";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function shortSessionTitle(session) {
  const title = session?.title || "Pi session";
  if (!session?.path) return title;
  if (title && !title.endsWith(".jsonl") && title !== "Untitled Pi session") return title;
  return `Pi session • ${formatDate(session.updatedAt || session.createdAt)}`;
}

function setMobileView(view) {
  localStorage.setItem("piWebActiveView", view);
  document.body.classList.remove("view-projects", "view-sessions", "view-chat");
  document.body.classList.add(`view-${view}`);
  document.body.classList.toggle("menu-open", view !== "chat");
  for (const [name, button] of [
    ["projects", elements.navProjectsButton],
    ["sessions", elements.navSessionsButton],
    ["chat", elements.navChatButton],
  ]) {
    button.classList.toggle("active", name === view);
  }
}

function selectedProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function normalizedQuery(value) {
  return value.trim().toLowerCase();
}

function filteredProjects() {
  const query = normalizedQuery(elements.projectSearchInput.value || "");
  if (!query) return state.projects;
  return state.projects.filter((project) => `${project.name}\n${project.path}`.toLowerCase().includes(query));
}

function isTextAttachment(file) {
  return file.type.startsWith("text/") || /\.(txt|md|markdown|json|ya?ml|csv|tsv|log|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|css|scss|html|xml|sh|env)$/i.test(file.name);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

function resetAttachmentInput() {
  elements.attachmentInput.value = "";
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  for (const attachment of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const label = document.createElement("span");
    label.textContent = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
    });
    chip.append(label, remove);
    elements.attachmentList.append(chip);
  }
}

async function addAttachments(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const nextAttachments = [];
  for (const file of files) {
    if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is too large. Keep files under 4MB.`);
    if (file.type.startsWith("image/")) {
      const dataUrl = await fileToDataUrl(file);
      const [, data = ""] = dataUrl.split(",", 2);
      nextAttachments.push({ id: crypto.randomUUID(), kind: "image", name: file.name, mimeType: file.type || "image/png", data });
      continue;
    }
    if (isTextAttachment(file)) {
      const content = await fileToText(file);
      nextAttachments.push({ id: crypto.randomUUID(), kind: "text", name: file.name, mimeType: file.type || "text/plain", content: content.slice(0, 120000) });
      continue;
    }
    throw new Error(`${file.name} is not supported yet. Attach images or text/code files.`);
  }
  state.attachments = [...state.attachments, ...nextAttachments];
  renderAttachments();
  resetAttachmentInput();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
  resetAttachmentInput();
}

function renderProjects() {
  const projects = filteredProjects();
  elements.projectList.replaceChildren();
  if (state.projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No projects yet.";
    elements.projectList.append(empty);
    return;
  }
  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No matching projects.";
    elements.projectList.append(empty);
    return;
  }

  for (const project of projects) {
    const row = document.createElement("div");
    row.className = `list-row${project.id === state.activeProjectId ? " active" : ""}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-card${project.id === state.activeProjectId ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = project.name;
    button.querySelector("span").textContent = project.path;
    button.addEventListener("click", () => selectProject(project.id));

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost danger icon-button row-action-button";
    removeButton.setAttribute("aria-label", `Remove ${project.name}`);
    removeButton.title = "Remove project";
    removeButton.textContent = "✕";
    removeButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`Remove ${project.name} from Pi Console? Files are not deleted.`)) return;
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      if (state.activeProjectId === project.id) {
        state.activeProjectId = null;
        state.activeSessionPath = null;
        state.sessions = [];
        localStorage.removeItem("piWebActiveProjectId");
        localStorage.removeItem("piWebActiveSessionPath");
      }
      await loadProjects();
    });

    row.append(button, removeButton);
    elements.projectList.append(row);
  }
}

function renderSessions() {
  elements.sessionList.replaceChildren();
  const project = selectedProject();
  elements.projectName.textContent = project?.name || "No project selected";
  elements.projectPath.textContent = project?.path || "Create or select a local folder.";
  elements.newSessionButton.disabled = !project;

  if (!project) return;
  const sessions = state.sessions;
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No Pi instances yet. Start one above.";
    elements.sessionList.append(empty);
    return;
  }

  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = `list-row${session.path === state.activeSessionPath ? " active" : ""}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-card${session.path === state.activeSessionPath ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = shortSessionTitle(session);
    button.querySelector("span").textContent = formatDate(session.updatedAt || session.createdAt);
    button.addEventListener("click", () => openSession(session.path, shortSessionTitle(session)));

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost danger icon-button row-action-button";
    removeButton.setAttribute("aria-label", `Remove ${shortSessionTitle(session)}`);
    removeButton.title = "Remove session";
    removeButton.textContent = "✕";
    removeButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`Remove session \"${shortSessionTitle(session)}\"?`)) return;
      await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions?sessionPath=${encodeURIComponent(session.path)}`, { method: "DELETE" });
      if (state.activeSessionPath === session.path) {
        closeSocket();
        clearChat();
        clearAttachments();
        state.activeSessionPath = null;
        localStorage.removeItem("piWebActiveSessionPath");
        elements.sessionTitle.textContent = "Select a Pi instance";
        setComposerEnabled(false);
        setMobileView("sessions");
      }
      await refreshSessionsQuietly();
    });

    row.append(button, removeButton);
    elements.sessionList.append(row);
  }
}

function clearThinkingBubble() {
  if (state.thinkingBubble) {
    state.thinkingBubble.remove();
    state.thinkingBubble = null;
  }
}

function clearChat() {
  elements.messages.replaceChildren(elements.jumpLatestButton);
  state.assistantBubble = null;
  state.thinkingBubble = null;
  state.toolBubbles.clear();
  state.stickToBottom = true;
  syncJumpButton();
}

function prettyText(text) {
  const normalized = `${text || ""}`;
  const trimmed = normalized.trim();
  if (!trimmed) return normalized;

  const prettyJson = (value) => {
    try {
      return `${JSON.stringify(JSON.parse(value), null, 2)}\n`;
    } catch {
      return "";
    }
  };

  if (["{", "["].includes(trimmed[0])) {
    return prettyJson(trimmed) || normalized;
  }

  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex === -1) return normalized;
  const header = normalized.slice(0, newlineIndex);
  const body = normalized.slice(newlineIndex + 1).trim();
  if (!["{", "["].includes(body[0] || "")) return normalized;
  return `${header}\n${prettyJson(body) || body}`;
}

function isNearBottom() {
  const node = elements.messages;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
}

function syncJumpButton() {
  elements.jumpLatestButton.hidden = state.stickToBottom;
}

// Follow the stream only while the user is at (or near) the bottom, so
// scrolling up to read is never hijacked by incoming deltas.
function stickyScroll(force = false) {
  if (force) state.stickToBottom = true;
  syncJumpButton();
  if (!state.stickToBottom) return;
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function toolDownloadUrl(filePath) {
  if (!state.activeProjectId || !filePath) return null;
  const url = `/api/projects/${encodeURIComponent(state.activeProjectId)}/file?path=${encodeURIComponent(filePath)}`;
  // Plain <a> clicks cannot send the Authorization header, so pass the token
  // as a query parameter (the server accepts both).
  return state.token ? `${url}&token=${encodeURIComponent(state.token)}` : url;
}

const FILE_PATH_RE = /(^|[\s()\[\]{}'"])((?:\.\/?|\.\.\/|(?:\/|[A-Z]:\\)?(?:[\w.-]+\/)+)[\w.-]+\.[A-Za-z0-9]{1,8})/g;
const TOOL_OUTPUT_DISPLAY_LIMIT = 20000;

function renderToolContent(container, text) {
  let source = String(text ?? "");
  if (source.length > TOOL_OUTPUT_DISPLAY_LIMIT) {
    source = `… showing last ${TOOL_OUTPUT_DISPLAY_LIMIT} characters …\n${source.slice(-TOOL_OUTPUT_DISPLAY_LIMIT)}`;
  }
  FILE_PATH_RE.lastIndex = 0;
  let last = 0;
  let match;
  const nodes = [];
  while ((match = FILE_PATH_RE.exec(source))) {
    const [full, prefix, candidate] = match;
    // Skip things that look like version numbers or URLs (contains :// ).
    if (candidate.includes("://") || /^\d+(\.\d+)+$/.test(candidate)) {
      nodes.push(document.createTextNode(source.slice(last, match.index + full.length)));
      last = match.index + full.length;
      continue;
    }
    if (match.index > last) nodes.push(document.createTextNode(source.slice(last, match.index)));
    if (prefix) nodes.push(document.createTextNode(prefix));
    const href = toolDownloadUrl(candidate);
    if (href) {
      const anchor = document.createElement("a");
      anchor.className = "tool-download";
      anchor.href = href;
      anchor.download = "";
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = candidate;
      nodes.push(anchor);
      nodes.push(document.createTextNode(" "));
      const open = document.createElement("a");
      open.className = "tool-download-open";
      open.textContent = "↓";
      open.title = `Download ${candidate}`;
      open.href = href;
      open.download = "";
      nodes.push(open);
    } else {
      nodes.push(document.createTextNode(candidate));
    }
    last = match.index + full.length;
  }
  if (last < source.length) nodes.push(document.createTextNode(source.slice(last)));
  container.replaceChildren(...nodes);
}

// Renders are coalesced with requestAnimationFrame so a burst of streaming
// deltas costs at most one re-render per frame, regardless of bubble type.
function renderBubbleContent(bubble, text) {
  bubble._raw = text;
  if (bubble._renderRaf) return;
  bubble._renderRaf = requestAnimationFrame(() => {
    bubble._renderRaf = 0;
    const content = bubble.querySelector(".message-content") || bubble;
    const role = bubble.dataset.role;
    if (role === "assistant" || role === "user") renderMarkdown(content, bubble._raw);
    else if (role === "tool-output") renderToolContent(content, bubble._raw);
    else content.textContent = prettyText(bubble._raw);
    stickyScroll();
  });
}

function appendMessage(role, text) {
  const bubble = document.createElement("article");
  bubble.className = `message ${role}`;
  bubble.dataset.role = role;
  const isMarkdown = role === "assistant" || role === "user";
  const content = document.createElement(isMarkdown ? "div" : "pre");
  content.className = `message-content${isMarkdown ? " md" : ""}`;
  bubble.append(content);
  renderBubbleContent(bubble, text);
  elements.messages.insertBefore(bubble, elements.jumpLatestButton);
  stickyScroll();
  return bubble;
}

function syncModelShortcutState() {
  const active = state.activeModelKey;
  for (const button of elements.modelShortcuts.querySelectorAll("button[data-model-key]")) {
    button.classList.toggle("active", button.dataset.modelKey === active);
  }
}

function setComposerEnabled(enabled) {
  elements.messageInput.disabled = !enabled;
  elements.sendButton.disabled = !enabled;
  elements.attachButton.disabled = !enabled;
  elements.attachmentInput.disabled = !enabled;
  elements.renameSessionButton.disabled = !enabled;
  elements.cycleModelButton.disabled = !enabled;
  for (const button of elements.modelShortcuts.querySelectorAll("button")) {
    button.disabled = !enabled;
  }
}

function sendSocket(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(payload));
  return true;
}

function updateStatus(status) {
  if (!status) return;
  if (!status.isStreaming) clearThinkingBubble();
  const model = status.model ? `${status.model.provider}/${status.model.label}` : "No model";
  const busy = status.isStreaming ? "working" : "ready";
  const queue = status.pendingMessageCount ? ` • ${status.pendingMessageCount} queued` : "";
  elements.miniStatus.textContent = `${model} • thinking ${status.thinkingLevel} • ${status.messageCount} msgs • ${status.activeTools.length} tools • ${busy}${queue}`;
  elements.abortButton.disabled = !status.isStreaming && !status.isBashRunning && !status.isCompacting && !status.isRetrying;
  if (status.sessionName) elements.sessionTitle.textContent = status.sessionName;
  state.activeModelKey = status.model ? `${status.model.provider}/${status.model.id}` : "";
  syncModelShortcutState();
}

function preferredUiModels(models) {
  const desired = [
    { provider: "zai", id: "glm-5.2" },
    { provider: "openai-codex", id: "gpt-5.5" },
    { provider: "openai-codex", id: "gpt-5.4" },
  ];
  return desired
    .map((target) => models.find((model) => model.provider === target.provider && model.id === target.id))
    .filter(Boolean);
}

function setModels(models) {
  state.models = preferredUiModels(models);
  elements.modelShortcuts.replaceChildren();
  if (!state.models.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = "No configured models";
    elements.modelShortcuts.append(empty);
    return;
  }
  for (const model of state.models) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.disabled = elements.cycleModelButton.disabled;
    chip.dataset.modelKey = `${model.provider}/${model.id}`;
    chip.textContent = model.label.replace(/^GPT-/, "G").replace(/^Gemini /, "Gm ");
    chip.addEventListener("click", () => sendSocket({ type: "setModel", provider: model.provider, modelId: model.id }));
    elements.modelShortcuts.append(chip);
  }
  syncModelShortcutState();
}

async function loadModels() {
  const body = await api("/api/models");
  setModels(body.models || []);
}

async function loadProjects() {
  const [, body] = await Promise.all([
    loadModels().catch((error) => console.warn("Could not load models", error)),
    api("/api/projects"),
  ]);
  state.projects = body.projects;

  if (state.initialProjectId) {
    state.activeProjectId = state.initialProjectId;
    localStorage.setItem("piWebActiveProjectId", state.initialProjectId);
  }
  if (state.initialSessionPath) {
    state.activeSessionPath = state.initialSessionPath;
    localStorage.setItem("piWebActiveSessionPath", state.initialSessionPath);
  }

  if (state.activeProjectId && !state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = null;
    state.activeSessionPath = null;
    localStorage.removeItem("piWebActiveProjectId");
    localStorage.removeItem("piWebActiveSessionPath");
  }

  renderProjects();
  if (!state.activeProjectId) {
    setMobileView("projects");
    return;
  }

  await selectProject(state.activeProjectId, false);
  if (state.activeSessionPath && state.sessions.some((session) => session.path === state.activeSessionPath)) {
    const session = state.sessions.find((item) => item.path === state.activeSessionPath);
    openSession(state.activeSessionPath, session ? shortSessionTitle(session) : "Pi session");
    return;
  }

  setMobileView("sessions");
}

async function selectProject(projectId, shouldRender = true) {
  state.activeProjectId = projectId;
  localStorage.setItem("piWebActiveProjectId", projectId);
  state.activeSessionPath = null;
  localStorage.removeItem("piWebActiveSessionPath");
  closeSocket();
  clearChat();
  clearAttachments();
  setComposerEnabled(false);
  elements.sessionTitle.textContent = "Select a Pi instance";
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  state.sessions = body.sessions;
  if (shouldRender) renderProjects();
  renderSessions();
  setMobileView("sessions");
}

function socketOpen() {
  return Boolean(state.socket && state.socket.readyState === WebSocket.OPEN);
}

function closeSocket() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  stopHeartbeat();
  const socket = state.socket;
  state.socket = null;
  if (socket) socket.close();
  setStatus("Idle");
}

function scheduleReconnect(sessionPath, delay = 1500) {
  if (!state.activeProjectId || !sessionPath) return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    openSession(sessionPath, elements.sessionTitle.textContent || "Pi session", true);
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  state.lastPongAt = Date.now();
  state.heartbeatTimer = setInterval(() => {
    if (!state.socket) return;
    if (state.socket.readyState === WebSocket.OPEN) {
      if (Date.now() - state.lastPongAt > 45000) {
        // Connection looks dead (no pong in 3+ intervals). Force a reconnect.
        resumeConnection(true);
        return;
      }
      state.socket.send(JSON.stringify({ type: "ping" }));
    } else if (state.socket.readyState === WebSocket.CLOSING || state.socket.readyState === WebSocket.CLOSED) {
      resumeConnection(true);
    }
  }, 15000);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

// Proactively restore the session connection. Mobile browsers freeze JS timers
// and kill sockets when the app is backgrounded or the screen locks, so the
// WebSocket "close" event often only fires after the user returns. This is
// called on visibilitychange / pageshow / online and from the heartbeat.
function resumeConnection(force = false) {
  if (!state.activeProjectId || !state.activeSessionPath) return;
  const fresh = Date.now() - state.lastPongAt < 40000;
  if (!force && socketOpen() && fresh) {
    // Looks healthy — probe anyway so we notice zombies quickly.
    sendSocket({ type: "ping" });
    return;
  }
  if (state.socket) {
    const stale = state.socket;
    state.socket = null;
    try {
      stale.close();
    } catch {
      /* ignore */
    }
  }
  setStatus("Reconnecting…", true);
  elements.miniStatus.textContent = "Reconnecting…";
  setComposerEnabled(false);
  scheduleReconnect(state.activeSessionPath, 250);
}

function websocketUrl(sessionPath) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("sessionPath", sessionPath || "new");
  if (state.token) url.searchParams.set("token", state.token);
  return url.toString();
}

function openSession(sessionPath, title = "New Pi instance", preserveChat = false) {
  closeSocket();
  if (!preserveChat) {
    clearChat();
    clearAttachments();
  }
  state.activeSessionPath = sessionPath || "new";
  localStorage.setItem("piWebActiveSessionPath", state.activeSessionPath);
  elements.sessionTitle.textContent = title;
  renderSessions();
  setMobileView("chat");
  setStatus("Connecting…", true);

  const socket = new WebSocket(websocketUrl(sessionPath));
  state.socket = socket;

  socket.addEventListener("open", () => {
    setStatus("Connected", true);
    startHeartbeat();
    loadModels().catch((error) => toast(error.message));
    sendSocket({ type: "models" });
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    setStatus("Reconnecting…");
    elements.miniStatus.textContent = "Disconnected — reconnecting…";
    setComposerEnabled(false);
    scheduleReconnect(state.activeSessionPath);
  });
  socket.addEventListener("error", () => toast("WebSocket connection failed"));
  socket.addEventListener("message", (event) => handleSocketMessage(JSON.parse(event.data)));
}

function handleSocketMessage(payload) {
  if (payload.type === "pong") {
    state.lastPongAt = Date.now();
    return;
  }
  if (payload.type === "ready") {
    setComposerEnabled(true);
    state.activeSessionPath = payload.sessionFile;
    if (payload.sessionFile) localStorage.setItem("piWebActiveSessionPath", payload.sessionFile);
    const matchingSession = state.sessions.find((session) => session.path === payload.sessionFile);
    elements.sessionTitle.textContent = matchingSession ? shortSessionTitle(matchingSession) : "Pi session";
    clearChat();
    for (const message of payload.messages || []) appendMessage(message.role === "user" ? "user" : "assistant", message.text);
    if (payload.models) setModels(payload.models);
    updateStatus(payload.status);
    subscribeToPush().catch((error) => console.warn("Push subscription failed", error));
    refreshSessionsQuietly();
    return;
  }
  if (payload.type === "models") {
    setModels(payload.models || []);
    return;
  }
  if (payload.type === "status") {
    updateStatus(payload.status);
    return;
  }
  if (payload.type === "userMessage") {
    appendMessage("user", payload.text);
    state.assistantBubble = null;
    state.thinkingBubble = null;
    return;
  }
  if (payload.type === "textDelta") {
    clearThinkingBubble();
    if (!state.assistantBubble) state.assistantBubble = appendMessage("assistant", "");
    const currentText = state.assistantBubble._raw || "";
    renderBubbleContent(state.assistantBubble, `${currentText}${payload.text}`);
    return;
  }
  if (payload.type === "assistantFinal") {
    clearThinkingBubble();
    if (!state.assistantBubble) state.assistantBubble = appendMessage("assistant", payload.text);
    else renderBubbleContent(state.assistantBubble, payload.text);
    return;
  }
  if (payload.type === "thinkingStart") {
    state.thinkingBubble = appendMessage("thinking", "Thinking…\n");
    return;
  }
  if (payload.type === "thinkingDelta") {
    if (!state.thinkingBubble) state.thinkingBubble = appendMessage("thinking", "Thinking…\n");
    const currentText = state.thinkingBubble._raw || "";
    renderBubbleContent(state.thinkingBubble, `${currentText}${payload.text}`);
    return;
  }
  if (payload.type === "thinkingEnd") {
    clearThinkingBubble();
    return;
  }
  if (payload.type === "toolStart") {
    clearThinkingBubble();
    const bubble = appendMessage("tool-output", `${payload.toolName}\n`);
    state.toolBubbles.set(payload.toolCallId, bubble);
    return;
  }
  if (payload.type === "toolUpdate") {
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendMessage("tool-output", `${payload.toolName}\n`);
    state.toolBubbles.set(payload.toolCallId, bubble);
    renderBubbleContent(bubble, `${payload.toolName}\n${payload.text || ""}`);
    return;
  }
  if (payload.type === "toolEnd") {
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendMessage("tool-output", `${payload.toolName}\n`);
    renderBubbleContent(bubble, `${payload.toolName}${payload.isError ? " failed" : " done"}\n${payload.text || ""}`);
    state.toolBubbles.delete(payload.toolCallId);
    return;
  }
  if (payload.type === "assistantError") {
    clearThinkingBubble();
    appendMessage("tool", `Pi error: ${payload.error}`);
  }
  if (payload.type === "agent_start") {
    setStatus("Pi is working", true);
    state.lastTurnStartedAt = Date.now();
  }
  if (payload.type === "agent_end") {
    clearThinkingBubble();
    setStatus("Connected", true);
    if (state.lastTurnStartedAt) {
      maybeNotifyTurnComplete().catch((error) => console.warn("Notification failed", error));
      state.lastTurnStartedAt = 0;
    }
  }
  if (payload.type === "queueUpdate") elements.miniStatus.textContent = `${payload.pending || 0} queued messages`;
  if (payload.type === "sessionInfoChanged" && payload.name) elements.sessionTitle.textContent = payload.name;
  if (payload.type === "thinkingLevelChanged") elements.miniStatus.textContent = `Thinking ${payload.level}`;
  if (payload.type === "sessionsChanged") refreshSessionsQuietly();
  if (payload.type === "error") toast(payload.error);
}

async function refreshSessionsQuietly() {
  if (!state.activeProjectId) return;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions`);
    state.sessions = body.sessions;
    renderSessions();
  } catch (error) {
    console.warn(error);
  }
}

elements.navProjectsButton.addEventListener("click", () => setMobileView("projects"));
elements.navSessionsButton.addEventListener("click", () => setMobileView("sessions"));
elements.navChatButton.addEventListener("click", () => setMobileView("chat"));
elements.toggleProjectsButton.addEventListener("click", () => setMobileView(selectedProject() ? "sessions" : "projects"));
elements.newProjectButton.addEventListener("click", () => elements.projectDialog.showModal());
elements.cancelProjectButton.addEventListener("click", () => elements.projectDialog.close());
elements.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const project = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: elements.projectNameInput.value,
        path: elements.projectPathInput.value,
        synced: elements.projectSyncedInput.checked,
        macPath: elements.projectMacPathInput.value,
      }),
    });
    elements.projectDialog.close();
    elements.projectForm.reset();
    await loadProjects();
    await selectProject(project.project.id);
  } catch (error) {
    toast(error.message);
  }
});

elements.newSessionButton.addEventListener("click", () => openSession(null, "New Pi instance"));
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = elements.messageInput.value.trim();
  if (!message && state.attachments.length === 0) return;
  const payload = {
    type: "prompt",
    message,
    images: state.attachments.filter((attachment) => attachment.kind === "image").map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    textAttachments: state.attachments.filter((attachment) => attachment.kind === "text").map(({ name, mimeType, content }) => ({ name, mimeType, content })),
  };
  if (!sendSocket(payload)) return;
  state.lastTurnStartedAt = Date.now();
  elements.messageInput.value = "";
  elements.messageInput.style.height = "auto";
  clearAttachments();
  stickyScroll(true);
});

elements.renameSessionButton.addEventListener("click", () => {
  elements.sessionNameInput.value = elements.sessionTitle.textContent || "";
  elements.renameDialog.showModal();
});
elements.cancelRenameButton.addEventListener("click", () => elements.renameDialog.close());
elements.renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendSocket({ type: "rename", name: elements.sessionNameInput.value });
  elements.renameDialog.close();
});
elements.cycleModelButton.addEventListener("click", () => sendSocket({ type: "cycleModel" }));
elements.notifyButton.addEventListener("click", () => {
  if (state.notificationsEnabled) disableNotifications().catch((error) => toast(error.message));
  else enableNotifications().catch((error) => toast(error.message));
});
elements.abortButton.addEventListener("click", () => sendSocket({ type: "abort" }));
elements.messages.addEventListener(
  "scroll",
  () => {
    state.stickToBottom = isNearBottom();
    syncJumpButton();
  },
  { passive: true },
);
elements.jumpLatestButton.addEventListener("click", () => stickyScroll(true));
async function promptInstall() {
  if (!state.installPromptEvent) return;
  const promptEvent = state.installPromptEvent;
  promptEvent.prompt();
  await promptEvent.userChoice.catch(() => null);
  state.installPromptEvent = null;
  updateInstallButton();
}

elements.installAppButton.addEventListener("click", promptInstall);
elements.installBannerButton.addEventListener("click", promptInstall);
elements.dismissInstallButton.addEventListener("click", () => {
  sessionStorage.setItem("piWebInstallDismissed", "1");
  updateInstallButton();
});
elements.projectSearchInput.addEventListener("input", () => renderProjects());
elements.attachButton.addEventListener("click", () => elements.attachmentInput.click());
elements.attachmentInput.addEventListener("change", async (event) => {
  try {
    await addAttachments(event.target.files || []);
  } catch (error) {
    toast(error.message);
    resetAttachmentInput();
  }
});
document.querySelectorAll(".command-strip button[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const command = button.dataset.command || "";
    elements.messageInput.value = command;
    elements.messageInput.focus();
    elements.messageInput.setSelectionRange(command.length, command.length);
  });
});

elements.messageInput.addEventListener("input", () => {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 160)}px`;
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  updateInstallButton();
});

window.addEventListener("appinstalled", () => {
  state.installPromptEvent = null;
  updateInstallButton();
  toast("App installed");
});

// Resume the WebSocket after the phone UI returns to the foreground, after a
// back/forward cache restore, or when the network comes back online. Without
// this the connection stays "dropped" until the user sends a follow-up message.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeConnection();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) resumeConnection(true);
});
window.addEventListener("online", () => resumeConnection(true));
window.addEventListener("focus", () => resumeConnection());

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Service worker registration failed", error));
  });
}

syncNotifyButton();
updateInstallButton();
loadProjects().catch((error) => toast(error.message));
