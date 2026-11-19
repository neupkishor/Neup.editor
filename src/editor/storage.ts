import type { EditorProject, ProjectSummary } from './types';

const DATABASE_NAME = 'neupcut-editor';
const DATABASE_VERSION = 1;
const PROJECT_STORE = 'projects';

/** Opens the local project database and creates its object store on first run. */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local project storage.'));
  });
}

/** Reads one complete project, including the media blobs stored with it. */
export async function loadProject(id: string): Promise<EditorProject | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(PROJECT_STORE, 'readonly').objectStore(PROJECT_STORE).get(id);
    request.onsuccess = () => resolve(request.result as EditorProject | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Writes a project and its media blobs atomically to browser storage. */
export async function saveProject(project: EditorProject): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE, 'readwrite');
    transaction.objectStore(PROJECT_STORE).put(project);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save project.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Project save was canceled.'));
  });
}

/** Returns saved projects in most recently edited order. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(PROJECT_STORE, 'readonly').objectStore(PROJECT_STORE).getAll();
    request.onsuccess = () => {
      const projects = (request.result as EditorProject[])
        .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      resolve(projects);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Removes one saved project from local browser storage. */
export async function deleteProject(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(PROJECT_STORE, 'readwrite').objectStore(PROJECT_STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
