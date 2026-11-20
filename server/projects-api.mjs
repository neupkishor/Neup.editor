import { getProject, getProjectMedia, listProjects, requireProjectUuid, saveProject, saveProjectMedia, deleteProject } from '../services/projects.mjs';

/** Writes the project API success or error envelope. */
function sendJson(response, statusCode, result, error) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(error ? { success: false, error, result: null } : { success: true, result }));
}

/** Reads a bounded JSON request body. */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw Object.assign(new Error('Request body exceeds 20 MB.'), { statusCode: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400, code: 'invalid_json' }); }
}

/** Handles HTTP operations for projects and their media assets. */
export async function handleProjectRequest(request, response, requestUrl) {
  const match = requestUrl.pathname.match(/^\/api\/projects(?:\/([^/]+)(?:\/media\/([^/]+))?)?\/?$/);
  if (!match) { sendJson(response, 404, null, { code: 'not_found', description: 'Project endpoint was not found.' }); return; }
  try {
    const projectId = match[1] ? requireProjectUuid(match[1]) : null;
    const assetId = match[2] ? requireProjectUuid(match[2], 'Asset id') : null;
    if (assetId && request.method === 'PUT') {
      await saveProjectMedia(request, projectId, assetId);
      sendJson(response, 200, { assetId, location: `/api/projects/${projectId}/media/${assetId}` });
      return;
    }
    if (assetId && request.method === 'GET') {
      const media = await getProjectMedia(projectId, assetId);
      if (!media) { sendJson(response, 404, null, { code: 'media_not_found', description: 'Project media was not found.' }); return; }
      response.writeHead(200, { 'content-type': media.mimeType, 'content-length': media.size, 'cache-control': 'private, max-age=3600' });
      media.stream.on('error', () => response.destroy());
      media.stream.pipe(response);
      return;
    }
    if (!projectId && request.method === 'GET') { sendJson(response, 200, await listProjects()); return; }
    if (projectId && request.method === 'GET') {
      const project = await getProject(projectId);
      if (!project) { sendJson(response, 404, null, { code: 'project_not_found', description: 'Project was not found.' }); return; }
      sendJson(response, 200, project);
      return;
    }
    if (projectId && request.method === 'PUT') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await saveProject(projectId, body?.project, body));
      return;
    }
    if (projectId && request.method === 'DELETE') { sendJson(response, 200, await deleteProject(projectId)); return; }
    sendJson(response, 405, null, { code: 'method_not_allowed', description: 'This method is not supported for the project endpoint.' });
  } catch (error) {
    const statusCode = error.statusCode || (error.code === 'P2025' ? 404 : 500);
    sendJson(response, statusCode, null, { code: error.code || 'project_api_error', description: error.message || 'Project request failed.' });
  }
}
