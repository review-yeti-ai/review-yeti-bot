'use strict';

const { createMem0MemoryProvider } = require('./mem0MemoryProvider.js');
const { createHindsightMemoryProvider } = require('./hindsightMemoryProvider.js');
const { createSupermemoryMemoryProvider } = require('./supermemoryMemoryProvider.js');
const { createRetainDbMemoryProvider } = require('./retaindbMemoryProvider.js');

const FACTORIES = {
  mem0: createMem0MemoryProvider,
  hindsight: createHindsightMemoryProvider,
  supermemory: createSupermemoryMemoryProvider,
  retaindb: createRetainDbMemoryProvider,
};

function createMemoryProvider({ id, profile = {}, env = process.env, fetchImplementation = globalThis.fetch, secretManager } = {}) {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`unknown native memory provider: ${id}`);
  return factory({ profile: { ...profile, secretManager }, env, fetchImplementation });
}

function listMemoryProviderIds() {
  return Object.keys(FACTORIES);
}

module.exports = { createMemoryProvider, listMemoryProviderIds, FACTORIES };
