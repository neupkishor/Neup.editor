import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const mediaRoot = path.resolve(process.env.NEUPCUT_PROJECT_MEDIA_DIR || path.resolve(process.cwd(), 'media/projects'));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Creates a JSON API response using the project's standard success envelope. */
function sendJson(response, statusCode, result, error) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(error
    ? { success: false, error, result: null }
    : { success: true, result }));
}

/** Reads and validates a project identifier before using it in a file path. */
function requireUuid(value, label) {
  if (!uuidPattern.test(value || '')) throw Object.assign(new Error(`${label} must be a UUID.`), { statusCode: 400, code: 'invalid_id' });
  return value;
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

/** Returns a URL-to-disk path after validating both resource identifiers. */
function getMediaPath(projectId, assetId) {
  requireUuid(projectId, 'Project id');
  requireUuid(assetId, 'Asset id');
  return path.join(mediaRoot, projectId, assetId);
}

/** Stores one uploaded asset file and limits uploads to 2 GB. */
async function saveMediaFile(request, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let size = 0;
  const limiter = async function* (source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024 * 1024) throw Object.assign(new Error('Media upload exceeds 2 GB.'), { statusCode: 413, code: 'media_too_large' });
      yield chunk;
    }
  };
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await pipeline(limiter(request), createWriteStream(temporaryPath, { flags: 'w' }));
    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Serves project persistence and media endpoints; returns false for other paths. */
export async function handleProjectApi(request, response, requestUrl) {
  const match = requestUrl.pathname.match(/^\/api\/projects(?:\/([^/]+)(?:\/media\/([^/]+))?)?\/?$/);
  if (!match) return false;

  try {
    const projectId = match[1] ? requireUuid(match[1], 'Project id') : null;
    const assetId = match[2] ? requireUuid(match[2], 'Asset id') : null;

    if (assetId && request.method === 'PUT') {
      const filePath = getMediaPath(projectId, assetId);
      await saveMediaFile(request, filePath);
      sendJson(response, 200, { assetId, location: `/api/projects/${projectId}/media/${assetId}` });
      return true;
    }

    if (assetId && request.method === 'GET') {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { data: true, mediaLocations: true } });
      if (!project) { sendJson(response, 404, null, { code: 'project_not_found', description: 'Project was not found.' }); return true; }
      const assets = project.data?.assets;
      const asset = Array.isArray(assets) ? assets.find((item) => item.id === assetId) : null;
      if (!asset || !project.mediaLocations?.[assetId]) { sendJson(response, 404, null, { code: 'media_not_found', description: 'Project media was not found.' }); return true; }
      const filePath = getMediaPath(projectId, assetId);
      const media = await readFile(filePath).catch(() => null);
      if (!media) { sendJson(response, 404, null, { code: 'media_not_found', description: 'Project media file was not found.' }); return true; }
      response.writeHead(200, { 'content-type': asset.mimeType || 'application/octet-stream', 'content-length': media.length, 'cache-control': 'private, max-age=3600' });
      response.end(media);
      return true;
    }

    if (!projectId && request.method === 'GET') {
      const projects = await prisma.project.findMany({ select: { id: true, name: true, updatedAt: true }, orderBy: { updatedAt: 'desc' } });
      sendJson(response, 200, projects);
      return true;
    }

    if (projectId && request.method === 'GET') {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) { sendJson(response, 404, null, { code: 'project_not_found', description: 'Project was not found.' }); return true; }
      sendJson(response, 200, { ...project.data, id: project.id, name: project.name, updatedAt: project.updatedAt.getTime(), mediaLocations: project.mediaLocations });
      return true;
    }

    if (projectId && request.method === 'PUT') {
      const body = await readJsonBody(request);
      const project = body?.project;
      if (!project || project.id !== projectId || typeof project.name !== 'string' || !Array.isArray(project.assets) || !Array.isArray(project.clips)) {
        sendJson(response, 400, null, { code: 'invalid_project', description: 'Project data must include a matching id, name, assets, and clips.' });
        return true;
      }
      const submittedLocations = body.mediaLocations && typeof body.mediaLocations === 'object' ? body.mediaLocations : {};
      const assetIds = new Set(project.assets.map((asset) => asset.id));
      const mediaLocations = Object.fromEntries(Object.entries(submittedLocations).filter(([assetId, location]) =>
        uuidPattern.test(assetId) && assetIds.has(assetId) && location === `/api/projects/${projectId}/media/${assetId}`));
      const data = { ...project, assets: project.assets.map(({ blob, ...asset }) => asset) };
      const saved = await prisma.project.upsert({
        where: { id: projectId },
        create: { id: projectId, name: project.name, data, mediaLocations, ...(body.accountId ? { accountId: requireUuid(body.accountId, 'Account id') } : {}) },
        update: { name: project.name, data, mediaLocations, updatedAt: new Date(), ...(body.accountId ? { accountId: requireUuid(body.accountId, 'Account id') } : {}) },
      });
      const mediaDirectory = path.join(mediaRoot, projectId);
      const retainedAssetIds = new Set(Object.keys(mediaLocations));
      const existingFiles = await readdir(mediaDirectory).catch(() => []);
      await Promise.all(existingFiles.filter((file) => !retainedAssetIds.has(file)).map((file) => rm(path.join(mediaDirectory, file), { force: true })));
      sendJson(response, 200, { id: saved.id, updatedAt: saved.updatedAt.getTime() });
      return true;
    }

    if (projectId && request.method === 'DELETE') {
      await prisma.project.deleteMany({ where: { id: projectId } });
      await rm(path.join(mediaRoot, projectId), { recursive: true, force: true });
      sendJson(response, 200, { id: projectId });
      return true;
    }

    sendJson(response, 405, null, { code: 'method_not_allowed', description: 'This method is not supported for the project endpoint.' });
    return true;
  } catch (error) {
    const statusCode = error.statusCode || (error.code === 'P2025' ? 404 : 500);
    sendJson(response, statusCode, null, { code: error.code || 'project_api_error', description: error.message || 'Project request failed.' });
    return true;
  }
}

/** Releases the PostgreSQL connection pool during process shutdown. */
export async function closeProjectApi() {
  await prisma.$disconnect();
}
