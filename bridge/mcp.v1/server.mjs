import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectsDirectory = path.resolve(serverDirectory, '../../projects');
const projectsDirectory = path.resolve(process.env.NEUPCUT_PROJECTS_DIR || defaultProjectsDirectory);
const mediaDirectory = path.resolve(process.env.NEUPCUT_MEDIA_DIR || path.resolve(process.cwd(), 'media'));
const server = new McpServer({ name: 'neup-cut-video-editor', version: '1.0.0' });

/** Runs FFmpeg or FFprobe without a shell and returns its captured output. */
function runMediaCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`${command} could not start: ${error.message}`)));
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed: ${stderr.trim() || `exit code ${code}`}`)));
  });
}

/** Resolves a user supplied media filename while keeping it inside the media directory. */
function resolveMediaPath(fileName) {
  const resolvedPath = path.resolve(mediaDirectory, fileName);
  if (!resolvedPath.startsWith(`${mediaDirectory}${path.sep}`)) throw new Error('Media paths must stay inside the configured media directory.');
  return resolvedPath;
}

/** Checks canonical paths without allowing a sibling or parent directory through a prefix match. */
function isInsideDirectory(directoryPath, candidatePath) {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

/** Requires an existing regular media file inside the configured media directory. */
async function requireInputMedia(fileName) {
  const filePath = resolveMediaPath(fileName);
  const actualPath = await realpath(filePath).catch(() => null);
  const actualDirectory = await realpath(mediaDirectory).catch(() => null);
  if (!actualPath || !actualDirectory || !isInsideDirectory(actualDirectory, actualPath)) throw new Error(`Input media file was not found inside the media directory: ${fileName}`);
  const fileInfo = await stat(actualPath).catch(() => null);
  if (!fileInfo?.isFile()) throw new Error(`Input media file was not found: ${fileName}`);
  return actualPath;
}

/** Reserves a new output path and only permits common video container extensions. */
async function requireNewVideoOutput(fileName) {
  const filePath = resolveMediaPath(fileName);
  if (!/\.(mp4|mov|mkv|webm)$/i.test(filePath)) throw new Error('Output filename must end in .mp4, .mov, .mkv, or .webm.');
  const parentPath = await realpath(path.dirname(filePath)).catch(() => null);
  const actualDirectory = await realpath(mediaDirectory).catch(() => null);
  if (!parentPath || !actualDirectory || !isInsideDirectory(actualDirectory, parentPath)) throw new Error('Output directory must exist inside the configured media directory.');
  if (await stat(filePath).then(() => true, () => false)) throw new Error(`Output already exists: ${fileName}`);
  return filePath;
}

/** Selects video and audio codecs that match the requested output container. */
function videoEncodingArguments(outputFile, quality) {
  if (/\.webm$/i.test(outputFile)) return ['-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus'];
  const fastStart = /\.(mp4|mov)$/i.test(outputFile) ? ['-movflags', '+faststart'] : [];
  return ['-c:v', 'libx264', '-crf', String(quality), '-preset', 'medium', '-c:a', 'aac', ...fastStart];
}

/** Converts command failures into the standard MCP error response. */
function mediaErrorResult(error) {
  return errorResult(error);
}

/** Escapes user text for FFmpeg's drawtext filter syntax. */
function escapeDrawtext(value) {
  return value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll('%', '\\%').replaceAll(',', '\\,').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll(';', '\\;').replaceAll('\n', ' ');
}

/** Resolves a project path while ensuring it stays inside the configured project directory. */
function resolveProjectPath(fileName) {
  const resolvedPath = path.resolve(projectsDirectory, fileName);
  if (!resolvedPath.startsWith(`${projectsDirectory}${path.sep}`)) throw new Error('Project path must stay inside the configured projects directory.');
  if (!resolvedPath.endsWith('.neupcut.json')) throw new Error('Project files must use the .neupcut.json extension.');
  return resolvedPath;
}

/** Reads and validates a portable Neup Cut project file. */
async function readProject(fileName) {
  const filePath = resolveProjectPath(fileName);
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (parsed.format !== 'neupcut-project' || parsed.version !== 1 || !parsed.project?.id || !Array.isArray(parsed.project.assets) || !Array.isArray(parsed.project.clips)) {
    throw new Error('Unsupported or invalid Neup Cut project file.');
  }
  return { filePath, archive: parsed, project: parsed.project };
}

/** Converts thrown errors into the standard MCP text result. */
function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
}

/** Returns a concise project summary that is safe to display in the tool response. */
function summarizeProject(project) {
  return {
    id: project.id,
    name: project.name,
    assets: project.assets.map(({ id, name, kind, duration, size }) => ({ id, name, kind, duration, size })),
    clips: project.clips.map(({ id, assetId, name, track, trackIndex, start, duration, sourceStart, muted, animation, effects }) => ({ id, assetId, name, track, trackIndex, start, duration, sourceStart, muted, animation, effects })),
  };
}

/** Writes an edited project to a new file unless the caller explicitly chooses an output filename. */
async function writeProject(archive, project, outputFile) {
  const destinationName = outputFile || `${path.basename(archive.project.name || 'project').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'project'}.edited.neupcut.json`;
  const destinationPath = resolveProjectPath(destinationName);
  await writeFile(destinationPath, JSON.stringify({ ...archive, project: { ...project, updatedAt: Date.now() } }, null, 2), { flag: 'wx' });
  return destinationName;
}

server.registerTool('list_projects', {
  description: 'List portable .neupcut.json project files in the configured projects directory.',
  inputSchema: {},
}, async () => {
  try {
    const entries = await readdir(projectsDirectory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.neupcut.json')).map((entry) => entry.name);
    return { content: [{ type: 'text', text: JSON.stringify({ directory: projectsDirectory, projects: files }, null, 2) }] };
  } catch (error) { return errorResult(error); }
});

server.registerTool('get_project', {
  description: 'Inspect a portable Neup Cut project, including its assets and timeline clips.',
  inputSchema: { file: z.string().min(1).describe('Project filename inside the configured projects directory.') },
}, async ({ file }) => {
  try { const { project } = await readProject(file); return { content: [{ type: 'text', text: JSON.stringify(summarizeProject(project), null, 2) }] }; }
  catch (error) { return errorResult(error); }
});

server.registerTool('list_media', {
  description: 'List video and audio files in the configured media directory (NEUPCUT_MEDIA_DIR).',
  inputSchema: {},
}, async () => {
  try {
    const entries = await readdir(mediaDirectory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const files = entries.filter((entry) => entry.isFile() && /\.(mp4|mov|mkv|webm|m4v|avi|mp3|wav|m4a|aac)$/i.test(entry.name)).map((entry) => entry.name);
    return { content: [{ type: 'text', text: JSON.stringify({ directory: mediaDirectory, files }, null, 2) }] };
  } catch (error) { return mediaErrorResult(error); }
});

server.registerTool('inspect_video', {
  description: 'Read duration, dimensions, frame rate, and stream details for a media file.',
  inputSchema: { file: z.string().min(1).describe('Media filename inside NEUPCUT_MEDIA_DIR.') },
}, async ({ file }) => {
  try {
    const filePath = await requireInputMedia(file);
    const { stdout } = await runMediaCommand('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath]);
    return { content: [{ type: 'text', text: JSON.stringify(JSON.parse(stdout), null, 2) }] };
  } catch (error) { return mediaErrorResult(error); }
});

server.registerTool('trim_video', {
  description: 'Create a trimmed video file with FFmpeg. Times are seconds; the input is preserved and output must be a new filename.',
  inputSchema: {
    inputFile: z.string().min(1), outputFile: z.string().min(1), start: z.number().nonnegative(), duration: z.number().positive(),
    quality: z.number().int().min(0).max(51).optional().describe('Encoder quality value; lower is higher quality (default 20).'),
  },
}, async ({ inputFile, outputFile, start, duration, quality }) => {
  try {
    const inputPath = await requireInputMedia(inputFile);
    const outputPath = await requireNewVideoOutput(outputFile);
    await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', inputPath, '-t', String(duration), '-map', '0:v:0', '-map', '0:a?', ...videoEncodingArguments(outputFile, quality ?? 20), outputPath]);
    return { content: [{ type: 'text', text: JSON.stringify({ outputFile, start, duration }) }] };
  } catch (error) { return mediaErrorResult(error); }
});

server.registerTool('resize_video', {
  description: 'Resize a video to fit within the requested dimensions, preserving aspect ratio and padding to the exact output size.',
  inputSchema: {
    inputFile: z.string().min(1), outputFile: z.string().min(1), width: z.number().int().min(2).max(7680), height: z.number().int().min(2).max(4320),
    quality: z.number().int().min(0).max(51).optional(),
  },
}, async ({ inputFile, outputFile, width, height, quality }) => {
  try {
    if (width % 2 || height % 2) throw new Error('Width and height must be even numbers for the selected video encoder.');
    const inputPath = await requireInputMedia(inputFile);
    const outputPath = await requireNewVideoOutput(outputFile);
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vf', filter, '-map', '0:v:0', '-map', '0:a?', ...videoEncodingArguments(outputFile, quality ?? 20), outputPath]);
    return { content: [{ type: 'text', text: JSON.stringify({ outputFile, width, height }) }] };
  } catch (error) { return mediaErrorResult(error); }
});

server.registerTool('overlay_text', {
  description: 'Burn text onto a video with FFmpeg. Use a filename or path to a font installed on the server.',
  inputSchema: {
    inputFile: z.string().min(1), outputFile: z.string().min(1), text: z.string().min(1).max(500),
    fontFile: z.string().optional(), fontSize: z.number().int().min(8).max(240).optional(), color: z.string().regex(/^[a-zA-Z]+$|^#[0-9a-fA-F]{6}$/).optional(),
    position: z.enum(['top', 'center', 'bottom']).optional(), quality: z.number().int().min(0).max(51).optional(),
  },
}, async ({ inputFile, outputFile, text, fontFile, fontSize, color, position, quality }) => {
  try {
    const inputPath = await requireInputMedia(inputFile);
    const outputPath = await requireNewVideoOutput(outputFile);
    const y = position === 'top' ? '40' : position === 'center' ? '(h-text_h)/2' : 'h-text_h-40';
    const fontOption = fontFile ? `fontfile='${escapeDrawtext(fontFile)}':` : '';
    const filter = `drawtext=${fontOption}text='${escapeDrawtext(text)}':fontcolor=${color ?? 'white'}:fontsize=${fontSize ?? 48}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.45:boxborderw=12`;
    await runMediaCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vf', filter, '-map', '0:v:0', '-map', '0:a?', ...videoEncodingArguments(outputFile, quality ?? 20), outputPath]);
    return { content: [{ type: 'text', text: JSON.stringify({ outputFile, text, position: position ?? 'bottom' }) }] };
  } catch (error) { return mediaErrorResult(error); }
});

server.registerTool('add_clip', {
  description: 'Add a timeline clip using an existing project asset and save the edited project as a new file.',
  inputSchema: {
    file: z.string().min(1), assetId: z.string().min(1), start: z.number().nonnegative(),
    duration: z.number().positive().optional(), trackIndex: z.number().int().nonnegative().optional(), outputFile: z.string().optional(),
  },
}, async ({ file, assetId, start, duration, trackIndex, outputFile }) => {
  try {
    const { archive, project } = await readProject(file);
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error(`Asset not found: ${assetId}`);
    const clipDuration = duration ?? asset.duration;
    if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new Error('Clip duration must be a positive number.');
    const clip = {
      id: crypto.randomUUID(), assetId: asset.id, name: asset.name,
      track: asset.kind === 'audio' ? 'audio' : 'video', trackIndex: trackIndex ?? 0,
      start, duration: clipDuration, sourceStart: 0,
    };
    const updatedProject = { ...project, clips: [...project.clips, clip] };
    const savedAs = await writeProject(archive, updatedProject, outputFile);
    return { content: [{ type: 'text', text: JSON.stringify({ clip, savedAs }, null, 2) }] };
  } catch (error) { return errorResult(error); }
});

server.registerTool('update_clip', {
  description: 'Move or trim a timeline clip and save the edited project as a new file.',
  inputSchema: {
    file: z.string().min(1), clipId: z.string().min(1), start: z.number().nonnegative().optional(),
    duration: z.number().positive().optional(), sourceStart: z.number().nonnegative().optional(),
    track: z.enum(['video', 'audio']).optional(), trackIndex: z.number().int().nonnegative().optional(),
    muted: z.boolean().optional(), outputFile: z.string().optional(),
  },
}, async ({ file, clipId, outputFile, ...changes }) => {
  try {
    const { archive, project } = await readProject(file);
    if (!project.clips.some((clip) => clip.id === clipId)) throw new Error(`Clip not found: ${clipId}`);
    const updatedProject = { ...project, clips: project.clips.map((clip) => clip.id === clipId ? { ...clip, ...changes } : clip) };
    const savedAs = await writeProject(archive, updatedProject, outputFile);
    return { content: [{ type: 'text', text: JSON.stringify({ clip: updatedProject.clips.find((clip) => clip.id === clipId), savedAs }, null, 2) }] };
  } catch (error) { return errorResult(error); }
});

server.registerTool('delete_clip', {
  description: 'Delete a timeline clip and save the edited project as a new file.',
  inputSchema: { file: z.string().min(1), clipId: z.string().min(1), outputFile: z.string().optional() },
}, async ({ file, clipId, outputFile }) => {
  try {
    const { archive, project } = await readProject(file);
    const clips = project.clips.filter((clip) => clip.id !== clipId);
    if (clips.length === project.clips.length) throw new Error(`Clip not found: ${clipId}`);
    const savedAs = await writeProject(archive, { ...project, clips }, outputFile);
    return { content: [{ type: 'text', text: JSON.stringify({ deletedClipId: clipId, savedAs }, null, 2) }] };
  } catch (error) { return errorResult(error); }
});

server.registerTool('set_clip_look', {
  description: 'Set a clip animation and/or visual effect, replacing effects of the same preset, then save as a new project file.',
  inputSchema: {
    file: z.string().min(1), clipId: z.string().min(1), outputFile: z.string().optional(),
    effectPresetId: z.string().optional(), effectAmount: z.number().min(0).max(1).optional(),
    animationPresetId: z.string().optional(), animationDuration: z.number().positive().optional(),
  },
}, async ({ file, clipId, outputFile, effectPresetId, effectAmount, animationPresetId, animationDuration }) => {
  try {
    const { archive, project } = await readProject(file);
    const existingClip = project.clips.find((clip) => clip.id === clipId);
    if (!existingClip) throw new Error(`Clip not found: ${clipId}`);
    let updatedClip = { ...existingClip };
    if (effectPresetId) {
      if (effectAmount === undefined) throw new Error('effectAmount is required with effectPresetId.');
      updatedClip = { ...updatedClip, effects: [...(updatedClip.effects ?? []).filter((effect) => effect.presetId !== effectPresetId), { presetId: effectPresetId, amount: effectAmount }] };
    }
    if (animationPresetId) {
      if (animationDuration === undefined) throw new Error('animationDuration is required with animationPresetId.');
      updatedClip = { ...updatedClip, animation: { presetId: animationPresetId, duration: animationDuration } };
    }
    const updatedProject = { ...project, clips: project.clips.map((clip) => clip.id === clipId ? updatedClip : clip) };
    const savedAs = await writeProject(archive, updatedProject, outputFile);
    return { content: [{ type: 'text', text: JSON.stringify({ clip: updatedClip, savedAs }, null, 2) }] };
  } catch (error) { return errorResult(error); }
});

/** Starts the MCP server over stdio for MCP-compatible clients. */
async function startServer() {
  await server.connect(new StdioServerTransport());
}

startServer().catch((error) => {
  process.stderr.write(`Neup Cut MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
