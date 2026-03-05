/**
 * QuickJS Sandbox for MCP Code Mode
 *
 * Executes user-provided JavaScript code in a sandboxed QuickJS WASM runtime.
 * Injects `warm.*` functions that delegate to a `callApi` callback.
 */

import { newAsyncContext } from 'quickjs-emscripten';

const MEMORY_LIMIT = 16 * 1024 * 1024; // 16MB
const TIMEOUT_MS = 30_000; // 30s

export async function executeSandboxedCode(
  code: string,
  callApi: (tool: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<{ output: string; error?: string }> {
  const ctx = await newAsyncContext();
  const outputLines: string[] = [];

  try {
    // Set memory limit
    const rt = ctx.runtime;
    rt.setMemoryLimit(MEMORY_LIMIT);

    // Set execution timeout
    let expired = false;
    const deadline = Date.now() + TIMEOUT_MS;
    rt.setInterruptHandler(() => {
      if (Date.now() > deadline) {
        expired = true;
        return true; // interrupt
      }
      return false;
    });

    // Inject console.log
    const consoleObj = ctx.newObject();
    const logFn = ctx.newFunction('log', (...args) => {
      const parts = args.map((arg) => {
        const str = ctx.getString(arg);
        return str;
      });
      outputLines.push(parts.join(' '));
    });
    ctx.setProp(consoleObj, 'log', logFn);
    ctx.setProp(ctx.global, 'console', consoleObj);
    logFn.dispose();
    consoleObj.dispose();

    // Inject __callApi as a native async function
    const callApiFn = ctx.newAsyncifiedFunction('__callApi', async (toolHandle, paramsHandle) => {
      const tool = ctx.getString(toolHandle);
      const paramsJson = ctx.getString(paramsHandle);
      const params = paramsJson ? JSON.parse(paramsJson) : {};
      const result = await callApi(tool, params);
      return ctx.newString(JSON.stringify(result));
    });
    ctx.setProp(ctx.global, '__callApi', callApiFn);
    callApiFn.dispose();

    // Wrapper code that creates the warm.* API using __callApi
    const wrappedCode = `
async function __run() {
  const warm = {
    getAccounts: () => __callApi('get_accounts', '{}').then(JSON.parse),
    getTransactions: (p) => __callApi('get_transactions', JSON.stringify(p || {})).then(JSON.parse),
    getSnapshots: (p) => __callApi('get_snapshots', JSON.stringify(p || {})).then(JSON.parse),
  };
  ${code}
}
__run();
`;

    const result = await ctx.evalCodeAsync(wrappedCode);

    if (expired) {
      result.dispose();
      return { output: outputLines.join('\n'), error: `Execution timed out after ${TIMEOUT_MS / 1000}s` };
    }

    if (result.error) {
      const errorMsg = ctx.getString(result.error);
      result.error.dispose();
      return { output: outputLines.join('\n'), error: errorMsg };
    }

    // If the result is a promise, await it
    const promiseResult = await ctx.resolvePromise(result.value);
    if (promiseResult.error) {
      const errorMsg = ctx.getString(promiseResult.error);
      promiseResult.error.dispose();
      result.value.dispose();
      return { output: outputLines.join('\n'), error: errorMsg };
    }

    promiseResult.value.dispose();
    result.value.dispose();

    return { output: outputLines.join('\n') };
  } finally {
    ctx.dispose();
  }
}
