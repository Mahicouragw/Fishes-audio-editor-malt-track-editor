import type { Project, AppSettings, StoredAsset } from '../types';

const DB_NAME = 'wishes-audio-editor';
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recent')) db.createObjectStore('recent', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  }));
}

export async function saveProject(project: Project): Promise<void> {
  await transaction('projects', 'readwrite', (s) => s.put({ ...project, updatedAt: Date.now() }));
  await transaction('recent', 'readwrite', (s) => s.put({ id: project.id, updatedAt: Date.now() }));
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    const request = tx.objectStore('projects').getAll();
    request.onsuccess = () => resolve((request.result as Project[]).sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function getProject(id: string): Promise<Project | undefined> {
  return transaction('projects', 'readonly', (s) => s.get(id));
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects', 'recent'], 'readwrite');
    tx.objectStore('projects').delete(id);
    tx.objectStore('recent').delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function duplicateProject(id: string, title: string): Promise<Project> {
  const original = await getProject(id);
  if (!original) throw new Error('Project not found');
  const copy: Project = { ...original, id: `project-${Date.now()}`, title, createdAt: Date.now(), updatedAt: Date.now() };
  await saveProject(copy);
  return copy;
}

export async function saveAsset(asset: StoredAsset): Promise<void> {
  await transaction('assets', 'readwrite', (s) => s.put(asset));
}

export async function getAsset(id: string): Promise<StoredAsset | undefined> {
  return transaction('assets', 'readonly', (s) => s.get(id));
}

export async function listAssets(): Promise<StoredAsset[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('assets', 'readonly');
    const request = tx.objectStore('assets').getAll();
    request.onsuccess = () => resolve(request.result as StoredAsset[]);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function deleteAsset(id: string): Promise<void> {
  await transaction('assets', 'readwrite', (s) => s.delete(id));
}

export async function deleteAssetsForProject(project: Project): Promise<void> {
  const ids = new Set(project.media.map((m) => m.assetId).concat(project.tracks.flatMap((t) => t.clips.map((c) => c.assetId))));
  for (const id of ids) {
    try { await deleteAsset(id); } catch { /* ignore */ }
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await transaction('settings', 'readwrite', (s) => s.put({ id: 'app', ...settings }));
}

export async function loadSettings(): Promise<AppSettings | null> {
  const result = await transaction<{ id: string } & AppSettings>('settings', 'readonly', (s) => s.get('app'));
  if (!result) return null;
  const { id: _id, ...rest } = result as { id: string } & AppSettings;
  return rest as AppSettings;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['projects', 'assets', 'settings', 'recent'], 'readwrite');
    tx.objectStore('projects').clear();
    tx.objectStore('assets').clear();
    tx.objectStore('settings').clear();
    tx.objectStore('recent').clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
