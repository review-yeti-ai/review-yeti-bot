import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Node's built-in fetch is undici. Its default headersTimeout/bodyTimeout is
// 300s and is independent of AbortSignal. 0 disables those client timers so a
// 15-minute Ollama generation clock can actually wait for headers.
export const STREAMING_FETCH_DISPATCHER_OPTIONS = Object.freeze({
  headersTimeout: 0,
  bodyTimeout: 0,
});

const require = createRequire(import.meta.url);
let streamingFetchDispatcher = null;

function loadUndiciAgentClass() {
  try {
    return require('undici').Agent;
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const nested = join(
    dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    'npm',
    'node_modules',
    'undici',
  );
  try {
    return require(nested).Agent;
  } catch (error) {
    throw new Error(
      `undici Agent is required to disable the 300s headersTimeout on streaming fetches: ${error?.message || error}`,
    );
  }
}

export function getStreamingFetchDispatcher() {
  if (!streamingFetchDispatcher) {
    const Agent = loadUndiciAgentClass();
    streamingFetchDispatcher = new Agent(STREAMING_FETCH_DISPATCHER_OPTIONS);
  }
  return streamingFetchDispatcher;
}
