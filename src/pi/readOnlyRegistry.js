'use strict';

const { STABLE_READ_ONLY_TOOLS } = require('./trustedConfig.js');

function sameIdentity(actual, candidate) {
  if (!candidate) return true;
  return candidate.repository === actual.repository
    && String(candidate.prNumber) === String(actual.prNumber)
    && candidate.headSha === actual.headSha;
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
    && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validateArguments(tool, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be an object');
  const allowed = {
    github_get_file: ['path'],
    github_list_changed_files: [],
    github_read_blob: ['blobSha'],
    review_get_identity: [],
  }[tool];
  if (!allowed) throw new Error('tool is not allowlisted');
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('unsupported argument for read-only tool');
  if (tool === 'github_get_file' && !validPath(args.path)) throw new Error('invalid path');
  if (tool === 'github_read_blob' && !/^[a-f0-9]{40,64}$/iu.test(String(args.blobSha || ''))) throw new Error('invalid blob SHA');
  return { ...args };
}

function createReadOnlyRegistry({ identity, enabledTools = [] } = {}) {
  if (!identity?.repository || !identity?.prNumber || !/^[a-f0-9]{40,64}$/iu.test(String(identity.headSha || ''))) throw new Error('read-only registry requires immutable review identity');
  let tools = new Set(enabledTools.filter((tool) => STABLE_READ_ONLY_TOOLS.includes(tool)));
  return Object.freeze({
    list: () => [...tools].sort(),
    refresh(providerCapabilities) {
      const claimed = new Set(Array.isArray(providerCapabilities) ? providerCapabilities.filter((tool) => STABLE_READ_ONLY_TOOLS.includes(tool)) : []);
      tools = new Set([...tools].filter((tool) => claimed.has(tool)));
      return [...tools].sort();
    },
    request({ tool, args, requestIdentity, signal } = {}) {
      if (!tools.has(tool)) throw new Error('tool is not allowlisted');
      if (!sameIdentity(identity, requestIdentity)) throw new Error('review identity mismatch');
      if (signal?.aborted) return null;
      return { tool, args: validateArguments(tool, args), identity: { ...identity }, signal };
    },
  });
}

module.exports = { createReadOnlyRegistry, validateArguments };
