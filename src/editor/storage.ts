import type { EditorProject, MediaAsset, ProjectSummary } from './types';

type ApiResponse<T> = { success: boolean; result?: T; error?: { code: string; description: string } };
type StoredProject = Omit<EditorProject, 'assets'> & {
  assets: Array<Omit<MediaAsset, 'blob'> & { blob?: Blob }>;
  mediaLocations?: Record<string, string>;
};

const uploadedMedia = new Map<string, Blob>();
let legacyMigration: Promise<void> | undefined;

/** Builds an unambiguous key for one project's uploaded media asset. */
function getMediaKey(projectId: string, assetId: string): string {
  return `${projectId}:${assetId}`;
}

/** Reads saved projects from the editor's former browser-only database. */
async function readLegacyProjects(): Promise<EditorProject[]> {
  if (!('indexedDB' in globalThis)) return [];
  if (indexedDB.databases) {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === 'neupcut-editor')) return [];
  }
  return new Promise((resolve) => {
    const request = indexedDB.open('neupcut-editor');
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) request.transaction?.abort();
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('projects')) { database.close(); resolve([]); return; }
      const readRequest = database.transaction('projects', 'readonly').objectStore('projects').getAll();
      readRequest.onsuccess = () => { database.close(); resolve(readRequest.result as EditorProject[]); };
      readRequest.onerror = () => { database.close(); resolve([]); };
    };
    request.onerror = () => resolve([]);
  });
}

/** Moves legacy browser projects to PostgreSQL once, preserving their media blobs. */
async function migrateLegacyProjects(): Promise<void> {
  if (!legacyMigration) {
    legacyMigration = (async () => {
      const projects = await readLegacyProjects();
      for (const project of projects) {
        const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`);
        if (response.status === 404) await saveProject(project);
        else await readApiResult<StoredProject>(response);
      }
    })().catch((error) => {
      legacyMigration = undefined;
      throw error;
    });
  }
  await legacyMigration;
}

/** Reads a typed result from the project API and surfaces its error description. */
async function readApiResult<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok || !payload.success) throw new Error(payload.error?.description || `Project request failed (${response.status}).`);
  return payload.result as T;
}

/** Loads a project and its binary media from the database-backed API. */
export async function loadProject(id: string): Promise<EditorProject | undefined> {
  await migrateLegacyProjects();
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (response.status === 404) return undefined;
  const stored = await readApiResult<StoredProject>(response);
  const assets = await Promise.all(stored.assets.map(async (asset) => {
    const location = stored.mediaLocations?.[asset.id];
    if (!location) return asset;
    const mediaResponse = await fetch(location);
    if (!mediaResponse.ok) throw new Error(`Could not load project media: ${asset.name}`);
    const blob = await mediaResponse.blob();
    uploadedMedia.set(getMediaKey(stored.id, asset.id), blob);
    return { ...asset, blob };
  }));
  const project = { ...stored };
  delete project.mediaLocations;
  return { ...project, assets } as EditorProject;
}

/** Uploads project media and saves the project JSON and media locations in PostgreSQL. */
export async function saveProject(project: EditorProject): Promise<void> {
  const mediaLocations: Record<string, string> = {};
  await Promise.all(project.assets.filter((asset) => asset.blob).map(async (asset) => {
    const location = `/api/projects/${encodeURIComponent(project.id)}/media/${encodeURIComponent(asset.id)}`;
    const mediaKey = getMediaKey(project.id, asset.id);
    if (uploadedMedia.get(mediaKey) !== asset.blob) {
      const response = await fetch(location, { method: 'PUT', headers: { 'content-type': asset.mimeType || 'application/octet-stream' }, body: asset.blob });
      await readApiResult<{ assetId: string }>(response);
      uploadedMedia.set(mediaKey, asset.blob as Blob);
    }
    mediaLocations[asset.id] = location;
  }));
  const { assets, ...projectData } = project;
  const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: { ...projectData, assets: assets.map(({ blob: _blob, ...asset }) => asset) }, mediaLocations }),
  });
  await readApiResult<{ id: string }>(response);
}

/** Returns the account's projects in recently edited order. */
export async function listProjects(): Promise<ProjectSummary[]> {
  await migrateLegacyProjects();
  const response = await fetch('/api/projects');
  return readApiResult<ProjectSummary[]>(response);
}

/** Removes a saved project and its uploaded media from server storage. */
export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await readApiResult<{ id: string }>(response);
}
