import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ProjectRecord } from "./types.js";

interface AddProjectOptions {
  synced?: boolean;
  macPath?: string;
}

interface StoreShape {
  projects: ProjectRecord[];
}

const dataDir = process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".pi-mobile-web");
const storePath = path.join(dataDir, "projects.json");
const syncthingUrl = process.env.PI_MOBILE_WEB_SYNCTHING_URL ?? "";
const syncthingApiKey = process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY ?? "";
const syncthingMacDeviceId = process.env.PI_MOBILE_WEB_SYNCTHING_MAC_DEVICE_ID ?? "";
const syncthingMacBasePath = process.env.PI_MOBILE_WEB_SYNCTHING_MAC_BASE_PATH ?? "";

async function ensureStore(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify({ projects: [] }, null, 2), { mode: 0o600 });
  }
}

async function readStore(): Promise<StoreShape> {
  await ensureStore();
  const raw = await fs.readFile(storePath, "utf8");
  const parsed = JSON.parse(raw) as StoreShape;
  return { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
}

async function writeStore(store: StoreShape): Promise<void> {
  await ensureStore();
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const store = await readStore();
  return store.projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getProject(projectId: string): Promise<ProjectRecord | undefined> {
  const projects = await listProjects();
  return projects.find((project) => project.id === projectId);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function syncthingFolderId(project: ProjectRecord): string {
  return `pi-mobile-web-${slug(project.name)}-${project.id}`;
}

function syncInstructions(project: ProjectRecord, macPath: string): string {
  return `# Agent setup notes

This project was created from Pi Mobile Web on the homeserver.

## Syncthing

- Homeserver path: \`${project.path}\`
- Intended Mac path: \`${macPath || "choose a local Mac project path"}\`
- If Syncthing is not already configured, add this folder on the homeserver and share it with the Mac device.
- On the Mac, accept the Syncthing folder and set the local path above.
- After the initial sync, verify changes flow both ways by editing a small file on each machine.
- Once Syncthing is working, remove this Syncthing section from AGENTS.md so future agents do not repeat the setup.

Do not commit secrets or machine-specific Syncthing API keys.
`;
}

async function writeProjectInstructions(project: ProjectRecord, macPath: string): Promise<void> {
  const filePath = path.join(project.path, "AGENTS.md");
  try {
    await fs.writeFile(filePath, syncInstructions(project, macPath), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function addSyncthingFolder(project: ProjectRecord, macPath: string): Promise<void> {
  if (!syncthingUrl || !syncthingApiKey || !syncthingMacDeviceId) return;
  const url = new URL("/rest/config/folders", syncthingUrl);
  const folder = {
    id: syncthingFolderId(project),
    label: project.name,
    path: project.path,
    type: "sendreceive",
    devices: [{ deviceID: syncthingMacDeviceId }],
    markerName: ".stfolder",
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": syncthingApiKey },
    body: JSON.stringify(folder),
  });
  if (!response.ok && response.status !== 409) throw new Error(`Syncthing folder setup failed: ${response.statusText}`);
  await writeProjectInstructions(project, macPath);
}

export async function addProject(name: string, folderPath: string, options: AddProjectOptions = {}): Promise<ProjectRecord> {
  const resolvedPath = path.resolve(folderPath);
  await fs.mkdir(resolvedPath, { recursive: true });
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) throw new Error("Project path must be a directory");

  const store = await readStore();
  const duplicate = store.projects.find((project) => project.path === resolvedPath);
  if (duplicate) return duplicate;

  const now = new Date().toISOString();
  const project: ProjectRecord = {
    id: nanoid(10),
    name: name.trim() || path.basename(resolvedPath) || resolvedPath,
    path: resolvedPath,
    createdAt: now,
    updatedAt: now,
  };
  if (options.synced) {
    const macPath = options.macPath || (syncthingMacBasePath ? path.posix.join(syncthingMacBasePath, path.basename(resolvedPath)) : "");
    await writeProjectInstructions(project, macPath);
    await addSyncthingFolder(project, macPath);
  }
  store.projects.push(project);
  await writeStore(store);
  return project;
}

export async function removeProject(projectId: string): Promise<void> {
  const store = await readStore();
  store.projects = store.projects.filter((project) => project.id !== projectId);
  await writeStore(store);
}

export async function touchProject(projectId: string): Promise<void> {
  const store = await readStore();
  const project = store.projects.find((candidate) => candidate.id === projectId);
  if (!project) return;
  project.updatedAt = new Date().toISOString();
  await writeStore(store);
}
