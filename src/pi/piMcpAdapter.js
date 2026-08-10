'use strict';

const { createReadOnlyRegistry } = require('./readOnlyRegistry.js');
const { validateResolvedTrustedConfig } = require('./trustedConfig.js');

const MAX_RESULT_BYTES = 8192;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 16;
const MAX_STRING_CODE_UNITS = 4096;

function retryable(error) {
  return ['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(error?.code) || error?.name === 'AbortError';
}

function summarizeUntrustedResult(value) {
  const state = { byteLength: 0, truncated: false };
  const add = (count) => {
    state.byteLength = Math.min(MAX_RESULT_BYTES, state.byteLength + Math.max(0, Number(count) || 0));
    if (state.byteLength >= MAX_RESULT_BYTES) state.truncated = true;
  };
  const measureString = (text) => {
    const sample = text.length > MAX_STRING_CODE_UNITS ? text.slice(0, MAX_STRING_CODE_UNITS) : text;
    // This serializes only the bounded primitive sample; it never invokes provider toJSON hooks.
    add(Buffer.byteLength(JSON.stringify(sample), 'utf8'));
    if (sample.length !== text.length) state.truncated = true;
  };
  const measure = (candidate, depth = 0, arrayValue = false) => {
    if (state.truncated || depth > MAX_DEPTH) { state.truncated = true; return; }
    if (candidate === null) { add(4); return; }
    if (typeof candidate === 'string') { measureString(candidate); return; }
    if (typeof candidate === 'boolean') { add(candidate ? 4 : 5); return; }
    if (typeof candidate === 'number') { add(Buffer.byteLength(Number.isFinite(candidate) ? String(candidate) : 'null', 'utf8')); return; }
    if (typeof candidate === 'bigint' || typeof candidate === 'function' || typeof candidate === 'symbol' || typeof candidate === 'undefined') {
      if (arrayValue) add(4);
      state.truncated = true;
      return;
    }
    if (Array.isArray(candidate)) {
      try {
        if (Object.getPrototypeOf(candidate) !== Array.prototype || candidate.length > MAX_ENTRIES) { state.truncated = true; return; }
        add(1);
        for (let index = 0; index < candidate.length && !state.truncated; index += 1) {
          if (index) add(1);
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) { state.truncated = true; break; }
          measure(descriptor.value, depth + 1, true);
        }
        add(1);
      } catch (_) { state.truncated = true; }
      return;
    }
    if (typeof candidate === 'object') {
      try {
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null) { state.truncated = true; return; }
        add(1);
        let ownEntries = 0;
        // Count each own enumerable key before reading its descriptor or value, and stop at the
        // cap instead of allocating a complete Object.keys/Reflect.ownKeys result.
        for (const key in candidate) {
          if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
          ownEntries += 1;
          if (ownEntries > MAX_ENTRIES) { state.truncated = true; break; }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) { state.truncated = true; break; }
          if (ownEntries > 1) add(1);
          measureString(key);
          add(1);
          measure(descriptor.value, depth + 1, false);
        }
        add(1);
      } catch (_) { state.truncated = true; }
      return;
    }
    state.truncated = true;
  };
  measure(value);
  const type = value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value);
  return Object.freeze({ trust: 'untrusted', type, byteLength: state.truncated ? MAX_RESULT_BYTES : state.byteLength, truncated: state.truncated });
}

async function closeConnection(connection) {
  if (typeof connection?.close === 'function') await connection.close();
}

function createPiMcpAdapter({ config, identity, connect } = {}) {
  const trustedConfig = validateResolvedTrustedConfig(config);
  if (typeof connect !== 'function') throw new Error('Pi MCP adapter requires a connection factory');
  const registry = createReadOnlyRegistry({ identity, enabledTools: trustedConfig.readOnlyTools });
  let connection = null;
  const connectionOptions = Object.freeze({ endpoint: trustedConfig.endpoint, credentialRef: trustedConfig.credentialRef, authScopes: trustedConfig.authScopes, tls: Object.freeze({ rejectUnauthorized: true, minVersion: 'TLSv1.2' }) });
  const getConnection = async (signal) => {
    if (!connection) {
      const candidate = await connect({ ...connectionOptions, signal });
      if (signal?.aborted) {
        try { await closeConnection(candidate); } catch (_) { /* cancellation remains authoritative */ }
        return null;
      }
      if (!candidate || typeof candidate.callReadOnly !== 'function') {
        try { await closeConnection(candidate); } catch (_) { /* invalid connection is discarded */ }
        throw new Error('Pi MCP connection does not implement read-only execution');
      }
      connection = candidate;
    }
    return connection;
  };
  const execute = async ({ tool, args = {}, identity: requestIdentity, signal } = {}) => {
    if (!trustedConfig.enabled) return { status: 'unavailable', reason: 'disabled' };
    if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
    const request = registry.request({ tool, args, requestIdentity, signal });
    if (!request) return { status: 'cancelled', reason: 'cancelled' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const active = await getConnection(signal);
        if (signal?.aborted || !active) return { status: 'cancelled', reason: 'cancelled' };
        const result = await active.callReadOnly(request);
        if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
        return { status: 'ok', tool, result: summarizeUntrustedResult(result) };
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') return { status: 'cancelled', reason: 'cancelled' };
        if (attempt === 0 && retryable(error)) {
          const failed = connection;
          connection = null;
          try { await closeConnection(failed); } catch (_) { /* reconnect failure stays bounded */ }
          continue;
        }
        return { status: 'unavailable', reason: 'read_only_execution_failed' };
      }
    }
    return { status: 'unavailable', reason: 'read_only_execution_failed' };
  };
  return Object.freeze({
    executeReadOnly: execute,
    listReadOnlyTools: () => registry.list(),
    refreshCapabilities: (capabilities) => registry.refresh(capabilities),
    async readiness() {
      if (!trustedConfig.enabled) return { status: 'disabled' };
      try {
        const active = await getConnection();
        if (!active) return { status: 'unavailable', reason: 'not_ready' };
        const status = typeof active.readiness === 'function' ? await active.readiness() : { ready: true };
        return status?.ready === true ? { status: 'ready' } : { status: 'unavailable', reason: 'not_ready' };
      } catch (_) {
        return { status: 'unavailable', reason: 'not_ready' };
      }
    },
    async close() {
      const active = connection;
      connection = null;
      await closeConnection(active);
    },
  });
}

module.exports = { createPiMcpAdapter, summarizeUntrustedResult };
