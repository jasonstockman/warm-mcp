import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createWarmServer } from './server.js';

export interface WarmHttpServerOptions {
  host?: string;
  port?: number;
  path?: string;
  allowedHosts?: string[];
}

type HttpRequest = IncomingMessage & {
  body?: unknown;
};

type HttpResponse = ServerResponse & {
  json: (body: unknown) => HttpResponse;
  set: (name: string, value: string) => HttpResponse;
  status: (code: number) => HttpResponse;
};

const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_PATH = '/mcp';

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
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: null,
  };
}

function sendMethodNotAllowed(res: HttpResponse): void {
  res.status(405).set('Allow', 'POST').json(jsonRpcError('Method not allowed.'));
}

export function resolveHttpServerOptions(
  overrides: WarmHttpServerOptions = {}
): Required<WarmHttpServerOptions> {
  return {
    host:
      overrides.host ||
      process.env.WARM_MCP_HTTP_HOST ||
      process.env.MCP_HOST ||
      process.env.HOST ||
      DEFAULT_HTTP_HOST,
    port:
      overrides.port ??
      parsePort(
        process.env.WARM_MCP_HTTP_PORT || process.env.MCP_PORT || process.env.PORT,
        DEFAULT_HTTP_PORT
      ),
    path: normalizePath(
      overrides.path || process.env.WARM_MCP_HTTP_PATH || process.env.MCP_PATH || DEFAULT_HTTP_PATH
    ),
    allowedHosts:
      overrides.allowedHosts ??
      parseAllowedHosts(process.env.WARM_MCP_ALLOWED_HOSTS || process.env.MCP_ALLOWED_HOSTS),
  };
}

export async function startHttpServer(options: WarmHttpServerOptions = {}): Promise<HttpServer> {
  const resolved = resolveHttpServerOptions(options);
  const app = createMcpExpressApp({
    host: resolved.host,
    ...(resolved.allowedHosts.length > 0 ? { allowedHosts: resolved.allowedHosts } : {}),
  });

  app.post(resolved.path, async (req: HttpRequest, res: HttpResponse) => {
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

  app.get(resolved.path, (_req: HttpRequest, res: HttpResponse) => {
    sendMethodNotAllowed(res);
  });

  app.delete(resolved.path, (_req: HttpRequest, res: HttpResponse) => {
    sendMethodNotAllowed(res);
  });

  const listener = await new Promise<HttpServer>((resolve, reject) => {
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
    listener.close((error) => {
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
