import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createMcpHttpHandler } from '../bridge/mcp.v1/server.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HOST || process.env.NEUPCUT_HTTP_HOST || '0.0.0.0';
const port = Number(process.env.PORT || process.env.NEUPCUT_HTTP_PORT || 5173);
const endpoint = process.env.NEUPCUT_HTTP_PATH || '/bridge/mcp.v1';

/** Starts Vite and Streamable HTTP MCP behind one Node HTTP listener. */
async function startApplication() {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  if (!endpoint.startsWith('/')) throw new Error('NEUPCUT_HTTP_PATH must start with /.');

  const httpServer = createHttpServer();
  const vite = await createViteServer({
    configFile: path.join(projectDirectory, 'vite.config.ts'),
    root: projectDirectory,
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  const handleMcpRequest = createMcpHttpHandler();

  httpServer.on('request', async (request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
    if (requestUrl.pathname === endpoint) {
      await handleMcpRequest(request, response);
      return;
    }
    vite.middlewares(request, response, (error) => {
      if (error) {
        process.stderr.write(`Vite request failed: ${error instanceof Error ? error.message : String(error)}\n`);
        if (!response.headersSent) response.writeHead(500).end('Internal server error');
        else response.destroy();
      }
    });
  });

  httpServer.listen(port, host, () => {
    const address = httpServer.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    process.stdout.write(`Neup Cut editor: http://${host}:${actualPort}\n`);
    process.stdout.write(`Neup Cut MCP: http://${host}:${actualPort}${endpoint}\n`);
  });

  /** Closes the HTTP listener and Vite cleanly on process shutdown. */
  async function shutdown() {
    httpServer.close();
    await vite.close();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

startApplication().catch((error) => {
  process.stderr.write(`Neup Cut failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
