import { handleProjectRequest } from './projects-api.mjs';
import { closeDatabase } from '../services/projects.mjs';

/** Routes editor project requests into the shared persistence services. */
export async function handleProjectApi(request, response, requestUrl) {
  if (!requestUrl.pathname.startsWith('/api/projects')) return false;
  await handleProjectRequest(request, response, requestUrl);
  return true;
}

/** Releases the shared database connection pool during process shutdown. */
export async function closeProjectApi() {
  await closeDatabase();
}
