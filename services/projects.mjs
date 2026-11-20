import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const mediaRoot = path.resolve(process.env.NEUPCUT_PROJECT_MEDIA_DIR || path.resolve(process.cwd(), 'media/projects'));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates a database UUID before using it in queries or media paths. */
export function requireProjectUuid(value, label = 'Project id') {
  if (!uuidPattern.test(value || '')) throw Object.assign(new Error(`${label} must be a UUID.`), { statusCode: 400, code: 'invalid_id' });
  return value;
}

/** Lists project records from PostgreSQL for the editor and MCP clients. */
export async function listProjects() {
  const projects = await prisma.project.findMany({ select: { id: true, name: true, updatedAt: true }, orderBy: { updatedAt: 'desc' } });
  return projects.map(({ id, name, updatedAt }) => ({ id, name, updatedAt: updatedAt.getTime() }));
}

/** Loads one project and combines its JSON content with database metadata. */
export async function getProject(projectId) {
  requireProjectUuid(projectId);
  const row = await prisma.project.findUnique({ where: { id: projectId } });
  if (!row) return null;
  return { ...row.data, id: row.id, name: row.name, updatedAt: row.updatedAt.getTime(), mediaLocations: row.mediaLocations };
}

/** Saves project JSON while keeping media binaries outside PostgreSQL. */
export async function saveProject(projectId, project, options = {}) {
  requireProjectUuid(projectId);
  if (!project || project.id !== projectId || typeof project.name !== 'string' || !Array.isArray(project.assets) || !Array.isArray(project.clips)) {
    throw Object.assign(new Error('Project data must include a matching id, name, assets, and clips.'), { statusCode: 400, code: 'invalid_project' });
  }
  const submittedLocations = options.mediaLocations && typeof options.mediaLocations === 'object' ? options.mediaLocations : {};
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const mediaLocations = Object.fromEntries(Object.entries(submittedLocations).filter(([assetId, location]) =>
    uuidPattern.test(assetId) && assetIds.has(assetId) && location === `/api/projects/${projectId}/media/${assetId}`));
  const data = { ...project, assets: project.assets.map(({ blob, ...asset }) => asset) };
  const accountId = options.accountId ? requireProjectUuid(options.accountId, 'Account id') : undefined;
  const saved = await prisma.project.upsert({
    where: { id: projectId },
    create: { id: projectId, name: project.name, data, mediaLocations, ...(accountId ? { accountId } : {}) },
    update: { name: project.name, data, mediaLocations, updatedAt: new Date(), ...(accountId ? { accountId } : {}) },
  });
  await pruneProjectMedia(projectId, new Set(Object.keys(mediaLocations)));
  return { id: saved.id, updatedAt: saved.updatedAt.getTime() };
}

/** Applies a project edit in place and persists it through the shared service. */
export async function editProject(projectId, edit) {
  const project = await getProject(projectId);
  if (!project) throw Object.assign(new Error('Project was not found.'), { statusCode: 404, code: 'project_not_found' });
  const updatedProject = await edit(project);
  const saved = await saveProject(projectId, updatedProject, { mediaLocations: project.mediaLocations });
  return { project: { ...updatedProject, updatedAt: saved.updatedAt }, updatedAt: saved.updatedAt };
}

/** Removes a project and its server-side media files. */
export async function deleteProject(projectId) {
  requireProjectUuid(projectId);
  await prisma.project.deleteMany({ where: { id: projectId } });
  await rm(path.join(mediaRoot, projectId), { recursive: true, force: true });
  return { id: projectId };
}

/** Stores an uploaded project media asset and limits uploads to 2 GB. */
export async function saveProjectMedia(request, projectId, assetId) {
  requireProjectUuid(projectId);
  requireProjectUuid(assetId, 'Asset id');
  const filePath = path.join(mediaRoot, projectId, assetId);
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

/** Looks up media metadata and a verified disk file for a project asset. */
export async function getProjectMedia(projectId, assetId) {
  requireProjectUuid(projectId);
  requireProjectUuid(assetId, 'Asset id');
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { data: true, mediaLocations: true } });
  if (!row) return null;
  const assets = row.data?.assets;
  const asset = Array.isArray(assets) ? assets.find((item) => item.id === assetId) : null;
  if (!asset || !row.mediaLocations?.[assetId]) return null;
  const filePath = path.join(mediaRoot, projectId, assetId);
  const fileInfo = await stat(filePath).catch(() => null);
  if (!fileInfo?.isFile()) return null;
  return { filePath, mimeType: asset.mimeType || 'application/octet-stream', size: fileInfo.size, stream: createReadStream(filePath) };
}

/** Removes unreferenced media files after a project save. */
async function pruneProjectMedia(projectId, retainedAssetIds) {
  const mediaDirectory = path.join(mediaRoot, projectId);
  const existingFiles = await readdir(mediaDirectory).catch(() => []);
  await Promise.all(existingFiles.filter((file) => !retainedAssetIds.has(file)).map((file) => rm(path.join(mediaDirectory, file), { force: true })));
}

/** Releases the shared PostgreSQL connection pool during process shutdown. */
export async function closeDatabase() {
  await prisma.$disconnect();
}
