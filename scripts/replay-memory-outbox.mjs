#!/usr/bin/env node
import process from 'node:process';
import { createRequire } from 'node:module';
import { createMemoryOutbox } from '../src/memory/memoryOutbox.js';
import { replayMemoryOutbox } from '../src/memory/replayMemoryOutbox.js';
import { createHonchoMemoryProvider } from '../src/memory/honchoMemory.js';
import { createHonchoMemoryMcpAdapter } from '../src/mcp/honchoMemoryMcpAdapter.js';
import { createMemoryProviderRouter } from '../src/mcp/memoryProviderRouter.js';
import { createMemoryProvider } from '../src/memory/providers/index.js';
import { DopplerSecretManagerRuntime } from '../src/mcp/dopplerSecretManagerRuntime.js';

const require = createRequire(import.meta.url);
const arg = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };

async function main() {
  const filePath = arg('--path');
  const lease = arg('--lease');
  const providerId = arg('--provider') || 'honcho';
  const authorized = arg('--authorize') === 'yes' || process.env.REVIEW_YETI_REPLAY_AUTH === '1';
  if (!filePath || !lease || !authorized) {
    console.error('Usage: replay-memory-outbox.mjs --path <outbox> --lease <owner> --provider <selected-provider> --authorize yes');
    process.exitCode = 2;
    return;
  }
  const outbox = createMemoryOutbox({ baseDir: process.cwd() });
  const secretManager = new DopplerSecretManagerRuntime({ dopplerToken: process.env.DOPPLER_TOKEN, project: process.env.DOPPLER_PROJECT, config: process.env.DOPPLER_CONFIG });
  const selectedProvider = providerId;
  let adapter;
  if (selectedProvider === 'honcho') {
    const honcho = createHonchoMemoryProvider({ secretManager, config: { enabled: true } });
    adapter = createHonchoMemoryMcpAdapter({ honchoProvider: honcho, transport: 'mcp' });
  } else {
    adapter = createMemoryProvider({ id: selectedProvider, profile: { enabled: true, endpointEnv: `${selectedProvider.toUpperCase()}_URL`, credentialEnv: `${selectedProvider.toUpperCase()}_API_KEY`, namespaceEnv: `${selectedProvider.toUpperCase()}_NAMESPACE`, workspaceEnv: `${selectedProvider.toUpperCase()}_WORKSPACE`, secretManager }, secretManager });
  }
  const router = createMemoryProviderRouter({ providers: [adapter], defaultProviderId: selectedProvider, transport: selectedProvider === 'honcho' ? 'mcp' : 'rest', mode: 'single' });
  const receipt = await replayMemoryOutbox({
    outbox, filePath, lease, providerId: selectedProvider, authorize: authorized,
    appendEvents: (request) => router.appendEvents({ ...request, providerId: selectedProvider, transport: selectedProvider === 'honcho' ? 'mcp' : 'rest' }),
  });
  console.log(JSON.stringify(receipt));
  if (receipt.state === 'dead_letter') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

export { main };
