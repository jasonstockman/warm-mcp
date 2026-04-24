import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createWarmServer } from './server.js';

const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_PATH = '/mcp';

export interface HttpServerOptions {
  allowedHosts?: string[];
  host?: string;
  path?: string;
  port?: number;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePath(value: string | undefined): string {
  if (!value) {
    return DEFAULT_HTTP_PATH;
  }

  return value.startsWith('/') ? value : `/${value}`;
}

function parseAllowedHosts(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

function jsonRpcError(message: string) {
  return {
    error: {
      code: -32000,
      message,
    },
    id: null,
    jsonrpc: '2.0',
  };
}

export function resolveHttpServerOptions(
  overrides: HttpServerOptions = {}
): Required<HttpServerOptions> {
  return {
    allowedHosts:
      overrides.allowedHosts ??
      parseAllowedHosts(process.env.WARM_MCP_ALLOWED_HOSTS || process.env.MCP_ALLOWED_HOSTS),
    host:
      overrides.host ||
      process.env.WARM_MCP_HTTP_HOST ||
      process.env.MCP_HOST ||
      process.env.HOST ||
      DEFAULT_HTTP_HOST,
    path: normalizePath(
      overrides.path || process.env.WARM_MCP_HTTP_PATH || process.env.MCP_PATH || DEFAULT_HTTP_PATH
    ),
    port:
      overrides.port ??
      parsePort(process.env.WARM_MCP_HTTP_PORT || process.env.MCP_PORT || process.env.PORT, DEFAULT_HTTP_PORT),
  };
}

function sendJsonMethodNotAllowed(res: {
  json: (body: unknown) => unknown;
  set: (name: string, value: string) => unknown;
  status: (statusCode: number) => unknown;
}): void {
  res.status(405);
  res.set('Allow', 'POST');
  res.json(jsonRpcError('Method not allowed.'));
}

export async function startHttpServer(options: HttpServerOptions = {}) {
  const resolved = resolveHttpServerOptions(options);
  const app = createMcpExpressApp({
    ...(resolved.allowedHosts.length > 0 ? { allowedHosts: resolved.allowedHosts } : {}),
    host: resolved.host,
  });

  app.post(resolved.path, async (req: any, res: any) => {
    const server = createWarmServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      await Promise.allSettled([transport.close(), server.close()]);
    };

    res.on('close', () => {
      void cleanup();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling Warm MCP HTTP request:', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError('Internal server error'));
      }
      void cleanup();
    }
  });

  app.get(resolved.path, (_req: unknown, res: any) => {
    sendJsonMethodNotAllowed(res);
  });

  app.delete(resolved.path, (_req: unknown, res: any) => {
    sendJsonMethodNotAllowed(res);
  });

  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const httpServer = app.listen(resolved.port, resolved.host, () => {
      resolve(httpServer);
    });
    httpServer.once('error', reject);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}, shutting down Warm MCP HTTP server...`);
    listener.close((error?: Error) => {
      if (error) {
        console.error('Failed to close Warm MCP HTTP server:', error);
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log(
    `Warm MCP Streamable HTTP server listening on http://${resolved.host}:${resolved.port}${resolved.path}`
  );

  return listener;
}
