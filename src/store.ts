import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ProjectRecord } from "./types.js";

interface StoreShape {
  projects: ProjectRecord[];
}

const dataDir = process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".pi-mobile-web");
const storePath = path.join(dataDir, "projects.json");

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

export async function addProject(name: string, folderPath: string): Promise<ProjectRecord> {
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
