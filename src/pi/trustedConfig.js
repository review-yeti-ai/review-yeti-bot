'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_HOST = 'api.github.com';
const READ_ONLY_SCOPES = new Set(['contents:read', 'pull_requests:read', 'metadata:read']);
const STABLE_READ_ONLY_TOOLS = Object.freeze(['github_get_file', 'github_list_changed_files', 'github_read_blob', 'review_get_identity']);
const RESOLVED_CONFIGS = new WeakSet();
const TRUSTED_BASE_SOURCES = new WeakSet();
const MAX_ARTIFACT_BYTES = 64 * 1024;

function validateEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch (_) { throw new Error('Pi MCP endpoint is invalid'); }
  if (endpoint.protocol !== 'https:') throw new Error('Pi MCP endpoint must use HTTPS');
  if (endpoint.hostname !== ALLOWED_HOST || endpoint.port || endpoint.username || endpoint.password || !['', '/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash) {
    throw new Error('Pi MCP endpoint host is not allowlisted');
  }
  return endpoint.origin;
}

function credentialReference(value) {
  const reference = String(value || '').trim();
  if (!/^[A-Z][A-Z0-9_]*$/u.test(reference)) throw new Error('Pi MCP credential must be an environment reference');
  return reference;
}

function immutableSha(value, name) {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(sha)) throw new Error(`Pi MCP trusted ${name} SHA is invalid`);
  return sha;
}

function readTrustedArtifactFromEnvironment() {
  const artifactPath = String(process.env.REVIEW_YETI_TRUSTED_CONFIG_PATH || '').trim();
  const expectedDigest = String(process.env.REVIEW_YETI_TRUSTED_CONFIG_SHA || '').trim().toLowerCase();
  const expectedBaseSha = immutableSha(process.env.REVIEW_YETI_TRUSTED_BASE_SHA, 'base');
  const expectedProvenance = String(process.env.REVIEW_YETI_TRUSTED_CONFIG_PROVENANCE || '').trim();
  if (!path.isAbsolute(artifactPath)) throw new Error('Pi MCP trusted config artifact path must be absolute');
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) throw new Error('Pi MCP trusted config artifact SHA is invalid');
  if (expectedProvenance !== 'trusted_base') throw new Error('Pi MCP trusted config provenance proof is invalid');

  const before = fs.lstatSync(artifactPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ARTIFACT_BYTES) throw new Error('Pi MCP trusted config artifact must be a bounded regular file');
  const descriptor = fs.openSync(artifactPath, 'r');
  let contents;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_ARTIFACT_BYTES) throw new Error('Pi MCP trusted config artifact changed during read');
    contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (!bytesRead) throw new Error('Pi MCP trusted config artifact changed during read');
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('Pi MCP trusted config artifact changed during read');
  } finally {
    fs.closeSync(descriptor);
  }
  const actualDigest = crypto.createHash('sha256').update(contents).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actualDigest, 'hex'), Buffer.from(expectedDigest, 'hex'))) throw new Error('Pi MCP trusted config artifact SHA mismatch');
  let artifact;
  try { artifact = JSON.parse(contents.toString('utf8')); } catch (_) { throw new Error('Pi MCP trusted config artifact is invalid JSON'); }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
    || artifact.provenance !== 'trusted_base' || immutableSha(artifact.baseSha, 'artifact base') !== expectedBaseSha) {
    throw new Error('Pi MCP trusted config artifact provenance does not match base proof');
  }
  return artifact;
}

function mintTrustedBaseSource(artifact) {
  const source = Object.freeze({ trustedBase: artifact });
  TRUSTED_BASE_SOURCES.add(source);
  return source;
}

function resolveTrustedBaseSource(source) {
  if (!source || !TRUSTED_BASE_SOURCES.has(source)) throw new Error('Pi MCP configuration requires a trusted base source');
  const trustedBase = source.trustedBase;
  const endpoint = validateEndpoint(trustedBase.endpoint || `https://${ALLOWED_HOST}`);
  const authScopes = Array.isArray(trustedBase.authScopes) ? [...new Set(trustedBase.authScopes.map((value) => String(value).trim()).filter(Boolean))] : [];
  if (!authScopes.length || authScopes.some((scope) => !READ_ONLY_SCOPES.has(scope))) throw new Error('Pi MCP authorization scope is not read-only');
  const selectedTools = Array.isArray(trustedBase.readOnlyTools) ? trustedBase.readOnlyTools.map((value) => String(value).trim()) : [];
  if (!selectedTools.length || selectedTools.some((tool) => !STABLE_READ_ONLY_TOOLS.includes(tool))) throw new Error('Pi MCP read-only tools must use the stable allowlist');
  const envDisabled = ['0', 'false', 'off', 'no'].includes(String(process.env.PI_MCP_ENABLED || '').trim().toLowerCase());
  const resolved = Object.freeze({
    enabled: trustedBase.enabled === true && !envDisabled,
    endpoint,
    credentialRef: credentialReference(trustedBase.credentialEnv),
    authScopes: Object.freeze(authScopes),
    readOnlyTools: Object.freeze([...new Set(selectedTools)]),
    provenance: Object.freeze({ config: 'trusted_base', endpoint: 'trusted_base', credential: 'environment_reference' }),
  });
  RESOLVED_CONFIGS.add(resolved);
  return resolved;
}

// The sole public construction path: immutable runner context selects an exact artifact and binds
// it to an independently supplied base SHA/provenance proof. Callers cannot supply a document/path.
function loadTrustedBaseArtifactFromTrustedContext() {
  if (arguments.length !== 0) throw new Error('Pi MCP trusted config artifact path must come from trusted context');
  return resolveTrustedBaseSource(mintTrustedBaseSource(readTrustedArtifactFromEnvironment()));
}

function validateResolvedTrustedConfig(config) {
  if (!config || typeof config !== 'object' || !RESOLVED_CONFIGS.has(config)) {
    throw new Error('Pi MCP adapter requires resolver-produced trusted configuration');
  }
  const endpoint = validateEndpoint(config.endpoint);
  const authScopes = Array.isArray(config.authScopes) ? [...new Set(config.authScopes.map((value) => String(value).trim()).filter(Boolean))] : [];
  if (!authScopes.length || authScopes.some((scope) => !READ_ONLY_SCOPES.has(scope))) throw new Error('Pi MCP authorization scope is not read-only');
  const readOnlyTools = Array.isArray(config.readOnlyTools) ? [...new Set(config.readOnlyTools.map((value) => String(value).trim()).filter(Boolean))] : [];
  if (!readOnlyTools.length || readOnlyTools.some((tool) => !STABLE_READ_ONLY_TOOLS.includes(tool))) throw new Error('Pi MCP read-only tools must use the stable allowlist');
  if (config.provenance?.config !== 'trusted_base' || config.provenance?.endpoint !== 'trusted_base' || config.provenance?.credential !== 'environment_reference') {
    throw new Error('Pi MCP configuration provenance is invalid');
  }
  return Object.freeze({
    enabled: config.enabled === true,
    endpoint,
    credentialRef: credentialReference(config.credentialRef),
    authScopes: Object.freeze(authScopes),
    readOnlyTools: Object.freeze(readOnlyTools),
    provenance: Object.freeze({ config: 'trusted_base', endpoint: 'trusted_base', credential: 'environment_reference' }),
  });
}

module.exports = {
  loadTrustedBaseArtifactFromTrustedContext,
  validateResolvedTrustedConfig,
  STABLE_READ_ONLY_TOOLS,
  READ_ONLY_SCOPES,
};
