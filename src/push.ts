import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import webpush, { type PushSubscription } from "web-push";

interface PushRecord {
  subscription: PushSubscription;
  projectId: string;
  sessionPath: string;
  title: string;
}

interface PushStore {
  vapidKeys: { publicKey: string; privateKey: string };
  subscriptions: PushRecord[];
}

const dataDir = process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".pi-mobile-web");
const storePath = path.join(dataDir, "push.json");

async function readStore(): Promise<PushStore> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8")) as PushStore;
    return { vapidKeys: parsed.vapidKeys, subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [] };
  } catch {
    const vapidKeys = webpush.generateVAPIDKeys();
    const store = { vapidKeys, subscriptions: [] };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
    return store;
  }
}

async function writeStore(store: PushStore): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

async function configureWebPush(): Promise<PushStore> {
  const store = await readStore();
  webpush.setVapidDetails("mailto:pi-mobile-web@localhost", store.vapidKeys.publicKey, store.vapidKeys.privateKey);
  return store;
}

export async function getVapidPublicKey(): Promise<string> {
  const store = await configureWebPush();
  return store.vapidKeys.publicKey;
}

export async function savePushSubscription(subscription: PushSubscription, projectId: string, sessionPath: string, title: string): Promise<void> {
  const store = await configureWebPush();
  store.subscriptions = store.subscriptions.filter((record) => record.subscription.endpoint !== subscription.endpoint);
  store.subscriptions.push({ subscription, projectId, sessionPath, title });
  await writeStore(store);
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const store = await configureWebPush();
  store.subscriptions = store.subscriptions.filter((record) => record.subscription.endpoint !== endpoint);
  await writeStore(store);
}

export async function notifySessionFinished(projectId: string, sessionPath: string, title: string): Promise<void> {
  const store = await configureWebPush();
  const records = store.subscriptions.filter((record) => record.projectId === projectId && record.sessionPath === sessionPath);
  if (!records.length) return;

  const payload = JSON.stringify({
    title: `${title || "Pi"} finished`,
    body: "Tap to open the conversation and review the result.",
    url: `/?projectId=${encodeURIComponent(projectId)}&sessionPath=${encodeURIComponent(sessionPath)}`,
  });

  const deadEndpoints = new Set<string>();
  await Promise.all(records.map(async (record) => {
    try {
      await webpush.sendNotification(record.subscription, payload);
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
      if (statusCode === 404 || statusCode === 410) deadEndpoints.add(record.subscription.endpoint);
      else console.warn("Push notification failed", error);
    }
  }));

  if (deadEndpoints.size) {
    store.subscriptions = store.subscriptions.filter((record) => !deadEndpoints.has(record.subscription.endpoint));
    await writeStore(store);
  }
}
