/**
 * Warm MCP stdio entrypoint and compatibility exports.
 *
 * The typed MCP contract and Warm API helpers live in `warm-server.ts`.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  API_URL,
  WARM_SERVER_INFO,
  apiRequest,
  createWarmApiClient,
  createWarmServer,
  getConfiguredApiKey,
  verifyWarmApiKey,
} from './warm-server.js';

export {
  API_URL,
  WARM_SERVER_INFO,
  apiRequest,
  createWarmApiClient,
  createWarmServer,
  getConfiguredApiKey,
  verifyWarmApiKey,
};

export async function startStdioServer() {
  const server = createWarmServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
