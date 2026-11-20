import { readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { editProject, getProject, listProjects } from '../../services/projects.mjs';

const mediaDirectory = path.resolve(process.env.NEUPCUT_MEDIA_DIR || path.resolve(process.cwd(), 'media'));

/** Creates a Streamable HTTP request handler for mounting at the editor origin. */
export function createMcpHttpHandler() {
  const sessions = new Map();
  return async (request, response) => {
    let transport = request.headers['mcp-session-id']
      ? sessions.get(String(request.headers['mcp-session-id']))
      : undefined;
    if (!transport && request.method === 'POST' && !request.headers['mcp-session-id']) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      const mcpServer = createMcpServer();
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        void mcpServer.close();
      };
      try {
        await mcpServer.connect(transport);
      } catch (error) {
        response.writeHead(500).end('Could not start MCP session');
        return;
      }
      const closeOnError = transport.onerror;
      transport.onerror = (error) => {
        closeOnError?.(error);
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const originalMessage = transport.onmessage;
      transport.onmessage = (message, extra) => {
        originalMessage?.(message, extra);
        if (transport.sessionId) sessions.set(transport.sessionId, transport);
      };
    }
    if (!transport) {
      response.writeHead(404).end('Unknown or missing MCP session');
      return;
    }
    try {
      await transport.handleRequest(request, response);
      if (transport.sessionId) sessions.set(transport.sessionId, transport);
    } catch (error) {
      process.stderr.write(`MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (!response.headersSent) response.writeHead(500).end('MCP request failed');
      else response.destroy();
    }
  };
}

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

/** Creates an MCP server instance with the editor's project and media tools registered. */
function createMcpServer() {
  const server = new McpServer({ name: 'neup-cut-video-editor', version: '1.0.0' });

  server.registerTool('list_projects', {
    description: 'List projects saved in the editor database.',
    inputSchema: {},
  }, async () => {
    try { return { content: [{ type: 'text', text: JSON.stringify({ projects: await listProjects() }, null, 2) }] }; }
    catch (error) { return errorResult(error); }
  });

  server.registerTool('get_project', {
    description: 'Inspect a database project, including its assets and timeline clips.',
    inputSchema: { projectId: z.string().uuid().describe('Project UUID returned by list_projects.') },
  }, async ({ projectId }) => {
    try {
      const project = await getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      return { content: [{ type: 'text', text: JSON.stringify(summarizeProject(project), null, 2) }] };
    }
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
    description: 'Add a timeline clip using an existing asset in a database project.',
    inputSchema: {
      projectId: z.string().uuid(), assetId: z.string().min(1), start: z.number().nonnegative(),
      duration: z.number().positive().optional(), trackIndex: z.number().int().nonnegative().optional(),
    },
  }, async ({ projectId, assetId, start, duration, trackIndex }) => {
    try {
      let clip;
      const result = await editProject(projectId, (project) => {
        const asset = project.assets.find((item) => item.id === assetId);
        if (!asset) throw new Error(`Asset not found: ${assetId}`);
        const clipDuration = duration ?? asset.duration;
        if (!Number.isFinite(clipDuration) || clipDuration <= 0) throw new Error('Clip duration must be a positive number.');
        clip = { id: randomUUID(), assetId: asset.id, name: asset.name, track: asset.kind === 'audio' ? 'audio' : 'video', trackIndex: trackIndex ?? 0, start, duration: clipDuration, sourceStart: 0 };
        return { ...project, clips: [...project.clips, clip] };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ projectId, clip, updatedAt: result.updatedAt }, null, 2) }] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('update_clip', {
    description: 'Move or trim a timeline clip in a database project.',
    inputSchema: {
      projectId: z.string().uuid(), clipId: z.string().min(1), start: z.number().nonnegative().optional(),
      duration: z.number().positive().optional(), sourceStart: z.number().nonnegative().optional(),
      track: z.enum(['video', 'audio']).optional(), trackIndex: z.number().int().nonnegative().optional(),
      muted: z.boolean().optional(),
    },
  }, async ({ projectId, clipId, ...changes }) => {
    try {
      const result = await editProject(projectId, (project) => {
        if (!project.clips.some((clip) => clip.id === clipId)) throw new Error(`Clip not found: ${clipId}`);
        return { ...project, clips: project.clips.map((clip) => clip.id === clipId ? { ...clip, ...changes } : clip) };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ projectId, clip: result.project.clips.find((clip) => clip.id === clipId), updatedAt: result.updatedAt }, null, 2) }] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('delete_clip', {
    description: 'Delete a timeline clip from a database project.',
    inputSchema: { projectId: z.string().uuid(), clipId: z.string().min(1) },
  }, async ({ projectId, clipId }) => {
    try {
      const result = await editProject(projectId, (project) => {
        const clips = project.clips.filter((clip) => clip.id !== clipId);
        if (clips.length === project.clips.length) throw new Error(`Clip not found: ${clipId}`);
        return { ...project, clips };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ projectId, deletedClipId: clipId, updatedAt: result.updatedAt }, null, 2) }] };
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('set_clip_look', {
    description: 'Set a clip animation and/or visual effect in a database project.',
    inputSchema: {
      projectId: z.string().uuid(), clipId: z.string().min(1),
      effectPresetId: z.string().optional(), effectAmount: z.number().min(0).max(1).optional(),
      animationPresetId: z.string().optional(), animationDuration: z.number().positive().optional(),
    },
  }, async ({ projectId, clipId, effectPresetId, effectAmount, animationPresetId, animationDuration }) => {
    try {
      let updatedClip;
      const result = await editProject(projectId, (project) => {
        const existingClip = project.clips.find((clip) => clip.id === clipId);
        if (!existingClip) throw new Error(`Clip not found: ${clipId}`);
        updatedClip = { ...existingClip };
        if (effectPresetId) {
          if (effectAmount === undefined) throw new Error('effectAmount is required with effectPresetId.');
          updatedClip = { ...updatedClip, effects: [...(updatedClip.effects ?? []).filter((effect) => effect.presetId !== effectPresetId), { presetId: effectPresetId, amount: effectAmount }] };
        }
        if (animationPresetId) {
          if (animationDuration === undefined) throw new Error('animationDuration is required with animationPresetId.');
          updatedClip = { ...updatedClip, animation: { presetId: animationPresetId, duration: animationDuration } };
        }
        return { ...project, clips: project.clips.map((clip) => clip.id === clipId ? updatedClip : clip) };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ projectId, clip: updatedClip, updatedAt: result.updatedAt }, null, 2) }] };
    } catch (error) { return errorResult(error); }
  });

  return server;
}

/** Starts the MCP server over stdio for MCP-compatible clients. */
async function startServer() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

/** Starts the MCP server over stateful Streamable HTTP sessions. */
async function startHttpServer() {
  const host = process.env.NEUPCUT_HTTP_HOST || '127.0.0.1';
  const port = Number(process.env.NEUPCUT_HTTP_PORT || 3001);
  const endpoint = process.env.NEUPCUT_HTTP_PATH || '/bridge/mcp.v1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('NEUPCUT_HTTP_PORT must be an integer between 0 and 65535.');
  if (!endpoint.startsWith('/')) throw new Error('NEUPCUT_HTTP_PATH must start with /.');
  const handleMcpRequest = createMcpHttpHandler();
  const httpServer = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
    if (requestUrl.pathname !== endpoint) {
      response.writeHead(404).end('Not found');
      return;
    }
    await handleMcpRequest(request, response);
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(`Neup Cut MCP Streamable HTTP listening at http://${host}:${port}${endpoint}\n`);
  });
}

/** Starts the standalone MCP transport only when this module is run directly. */
function startStandaloneServer() {
  const transportMode = process.env.NEUPCUT_TRANSPORT || (
    process.argv.includes('--transport=http') || (process.argv[2] === '--transport' && process.argv[3] === 'http')
      ? 'http'
      : 'stdio'
  );
  const start = transportMode === 'http' ? startHttpServer : startServer;
  start().catch((error) => {
    process.stderr.write(`Neup Cut MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startStandaloneServer();
