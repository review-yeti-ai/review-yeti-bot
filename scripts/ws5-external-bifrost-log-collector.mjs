import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const LOG_RESPONSE_LIMIT_BYTES = 1_048_576;
const LOG_COLLECTION_KEYS = new Set(['logs', 'data', 'rows', 'results']);
const LOG_STRING_FIELDS = new Map([
  ['id', 'id'], ['parentrequestid', 'parent_request_id'], ['provider', 'provider'],
  ['model', 'model'], ['alias', 'alias'], ['servedmodel', 'served_model'],
  ['finishreason', 'finish_reason'], ['status', 'status'], ['servicetier', 'service_tier'],
  ['timestamp', 'timestamp'], ['createdat', 'created_at'],
]);
const LOG_NUMBER_FIELDS = new Map([
  ['fallbackindex', 'fallback_index'], ['upstreamlatencyms', 'upstream_latency_ms'],
  ['duration', 'duration'], ['latency', 'latency'], ['cost', 'cost'],
]);
const LOG_USAGE_FIELDS = new Map([
  ['prompttokens', 'prompt_tokens'], ['completiontokens', 'completion_tokens'],
  ['totaltokens', 'total_tokens'], ['inputtokens', 'input_tokens'], ['outputtokens', 'output_tokens'],
  ['cachedtokens', 'cached_tokens'], ['cachereadinputtokens', 'cache_read_input_tokens'],
  ['cachereadtokens', 'cache_read_tokens'], ['cachecreationtokens', 'cache_creation_tokens'],
  ['cachewritetokens', 'cache_write_tokens'], ['reasoningtokens', 'reasoning_tokens'],
  ['thoughttokens', 'thought_tokens'], ['audiotokens', 'audio_tokens'], ['imagetokens', 'image_tokens'],
]);
const CONTENT_FIELDS = new Set([
  'prompt', 'prompts', 'messages', 'inputmessages', 'outputmessage', 'rawrequest', 'rawresponse',
  'requestbody', 'responsebody', 'completion', 'analysis', 'reasoning', 'thoughts', 'choices',
  'inputhistory', 'responsesinputhistory', 'inputaudio', 'audioinput', 'inputimage', 'imageinput', 'inputvideo',
  'videoinput', 'inputfile', 'fileinput', 'inputtext', 'textinput', 'modalityinput', 'modalityinputs',
  'contentsummary', 'speechinput', 'transcriptioninput', 'imagegenerationinput', 'videogenerationinput',
  'audio', 'image', 'video', 'file', 'content',
]);
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/u;
const STORE_ROOT = '/workspace/.review-yeti';
const LOG_TIMEOUT_MS = 10_000;
const MAX_CONCURRENCY = 8;
const SHA256_RE = /^[a-f0-9]{64}$/u;

function normalizedKey(value) { return value.toLowerCase().replace(/[^a-z0-9]/gu, ''); }
function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function cancelBody(response) { try { await response?.body?.cancel(); } catch {} }

class BoundedMetadataJsonProjector {
  constructor(body, maximumBytes = 1_048_576) {
    this.reader = body?.getReader?.();
    if (!this.reader) throw new Error('bifrost_log_response_stream_invalid');
    this.maximumBytes = maximumBytes;
    this.totalRead = 0;
    this.source = null;
    this.sourceOffset = 0;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    this.done = false;
    this.depthLimit = 64;
    this.bodyHasher = createHash('sha256');
  }

  async fill() {
    if (this.offset < this.buffer.length) return true;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    while (!this.source || this.sourceOffset >= this.source.byteLength) {
      if (this.done) return false;
      let next;
      try { next = await this.reader.read(); } catch { throw new Error('bifrost_log_response_read_failed'); }
      if (next.done) { this.done = true; return false; }
      if (!(next.value instanceof Uint8Array)) throw new Error('bifrost_log_response_stream_invalid');
      this.source = next.value;
      this.bodyHasher.update(next.value);
      this.sourceOffset = 0;
      if (this.source.byteLength === 0) continue;
    }
    const remaining = this.maximumBytes + 1 - this.totalRead;
    if (remaining <= 0) throw new Error('bifrost_log_response_too_large');
    const limit = Math.min(64 * 1024, remaining, this.source.byteLength - this.sourceOffset);
    const end = this.sourceOffset + limit;
    this.buffer = Buffer.from(this.source.subarray(this.sourceOffset, end));
    this.sourceOffset = end;
    this.totalRead += this.buffer.byteLength;
    if (this.totalRead > this.maximumBytes) throw new Error('bifrost_log_response_too_large');
    return this.buffer.length > 0;
  }

  async peek() {
    if (!await this.fill()) return null;
    return this.buffer[this.offset];
  }

  async take() {
    const value = await this.peek();
    if (value === null) throw new Error('bifrost_log_json_truncated');
    this.offset += 1;
    return value;
  }

  async expect(value) {
    if (await this.take() !== value) throw new Error('bifrost_log_json_syntax_invalid');
  }

  async space() {
    while ([0x20, 0x09, 0x0a, 0x0d].includes(await this.peek())) this.offset += 1;
  }

  async string(decode, maxEncodedBytes = 2048) {
    await this.expect(0x22);
    const encoded = decode ? [] : null;
    let encodedLength = 0;
    for (;;) {
      const byte = await this.take();
      if (byte === 0x22) break;
      if (byte === 0x5c) {
        const escape = await this.take();
        let unicode = [];
        if (escape === 0x75) {
          for (let index = 0; index < 4; index += 1) {
            const digit = await this.take();
            if (!'0123456789abcdefABCDEF'.includes(String.fromCharCode(digit))) {
              throw new Error('bifrost_log_json_escape_invalid');
            }
            unicode.push(digit);
          }
          encodedLength += 6;
        } else if ('"\\/bfnrt'.includes(String.fromCharCode(escape))) encodedLength += 2;
        else throw new Error('bifrost_log_json_escape_invalid');
        if (encoded) {
          if (encodedLength > maxEncodedBytes) throw new Error('bifrost_log_metadata_string_too_large');
          encoded.push(0x5c, escape, ...unicode);
        }
      } else {
        if (byte < 0x20) throw new Error('bifrost_log_json_control_character_invalid');
        encodedLength += 1;
        if (encoded) {
          if (encodedLength > maxEncodedBytes) throw new Error('bifrost_log_metadata_string_too_large');
          encoded.push(byte);
        }
      }
    }
    if (!encoded) return null;
    let value;
    try { value = JSON.parse(Buffer.from([0x22, ...encoded, 0x22]).toString('utf8')); }
    catch { throw new Error('bifrost_log_metadata_string_invalid'); }
    if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) {
      throw new Error('bifrost_log_metadata_string_invalid');
    }
    return value;
  }

  async scalar() {
    const token = [];
    for (;;) {
      const byte = await this.peek();
      if (byte === null || [0x2c, 0x5d, 0x7d, 0x20, 0x09, 0x0a, 0x0d].includes(byte)) break;
      token.push(await this.take());
      if (token.length > 128) throw new Error('bifrost_log_json_scalar_too_large');
    }
    const raw = Buffer.from(token).toString('ascii');
    if (!['true', 'false', 'null'].includes(raw)
      && !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(raw)) {
      throw new Error('bifrost_log_json_scalar_invalid');
    }
    try { return JSON.parse(raw); } catch { throw new Error('bifrost_log_json_scalar_invalid'); }
  }

  async skipValue(depth = 0) {
    if (depth > this.depthLimit) throw new Error('bifrost_log_json_depth_exceeded');
    await this.space();
    const first = await this.peek();
    if (first === 0x22) { await this.string(false); return; }
    if (first === 0x7b) {
      await this.take();
      await this.space();
      if (await this.peek() === 0x7d) { await this.take(); return; }
      for (;;) {
        await this.space();
        await this.string(false);
        await this.space();
        await this.expect(0x3a);
        await this.skipValue(depth + 1);
        await this.space();
        const delimiter = await this.take();
        if (delimiter === 0x7d) return;
        if (delimiter !== 0x2c) throw new Error('bifrost_log_json_syntax_invalid');
      }
    }
    if (first === 0x5b) {
      await this.take();
      await this.space();
      if (await this.peek() === 0x5d) { await this.take(); return; }
      for (;;) {
        await this.skipValue(depth + 1);
        await this.space();
        const delimiter = await this.take();
        if (delimiter === 0x5d) return;
        if (delimiter !== 0x2c) throw new Error('bifrost_log_json_syntax_invalid');
      }
    }
    if (first === null) throw new Error('bifrost_log_json_truncated');
    await this.scalar();
  }

  async safeStringValue() {
    await this.space();
    if (await this.peek() === 0x22) return this.string(true, 1024);
    await this.skipValue();
    return null;
  }

  async safeNumberValue() {
    await this.space();
    const first = await this.peek();
    if (first === null || [0x22, 0x7b, 0x5b, 0x74, 0x66, 0x6e].includes(first)) {
      await this.skipValue();
      return null;
    }
    const value = await this.scalar();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  async usageObject() {
    const values = Object.create(null);
    await this.space();
    if (await this.peek() !== 0x7b) { await this.skipValue(); return values; }
    await this.take();
    await this.space();
    if (await this.peek() === 0x7d) { await this.take(); return values; }
    for (;;) {
      await this.space();
      const key = normalizedKey(await this.string(true, 128) || '');
      await this.space();
      await this.expect(0x3a);
      if (LOG_USAGE_FIELDS.has(key)) {
        const value = await this.safeNumberValue();
        if (value !== null && value >= 0) values[LOG_USAGE_FIELDS.get(key)] = value;
      } else await this.skipValue();
      await this.space();
      const delimiter = await this.take();
      if (delimiter === 0x7d) return values;
      if (delimiter !== 0x2c) throw new Error('bifrost_log_json_syntax_invalid');
    }
  }

  async rowObject() {
    const row = Object.create(null);
    await this.expect(0x7b);
    await this.space();
    if (await this.peek() === 0x7d) { await this.take(); return row; }
    for (;;) {
      await this.space();
      const key = normalizedKey(await this.string(true, 256) || '');
      await this.space();
      await this.expect(0x3a);
      if (LOG_STRING_FIELDS.has(key)) {
        const value = await this.safeStringValue();
        if (typeof value === 'string') row[LOG_STRING_FIELDS.get(key)] = value;
      } else if (LOG_NUMBER_FIELDS.has(key)) {
        const value = await this.safeNumberValue();
        if (value !== null) row[LOG_NUMBER_FIELDS.get(key)] = value;
      } else if (key === 'tokenusage') {
        const usage = await this.usageObject();
        if (Object.keys(usage).length) row.token_usage = usage;
      } else {
        if (CONTENT_FIELDS.has(key)) row.contentFieldsPresent = true;
        await this.skipValue();
      }
      await this.space();
      const delimiter = await this.take();
      if (delimiter === 0x7d) return row;
      if (delimiter !== 0x2c) throw new Error('bifrost_log_json_syntax_invalid');
    }
  }

  async rowsArray() {
    await this.space();
    await this.expect(0x5b);
    await this.space();
    let count = 0;
    const rows = [];
    if (await this.peek() === 0x5d) { await this.take(); return { count, rows }; }
    for (;;) {
      await this.space();
      const row = await this.peek() === 0x7b ? await this.rowObject() : (await this.skipValue(), Object.create(null));
      count += 1;
      if (rows.length < 2) rows.push(row);
      await this.space();
      const delimiter = await this.take();
      if (delimiter === 0x5d) return { count, rows };
      if (delimiter !== 0x2c) throw new Error('bifrost_log_json_syntax_invalid');
    }
  }

  async parse() {
    await this.space();
    const candidates = [];
    const first = await this.peek();
    if (first === 0x5b) candidates.push(await this.rowsArray());
    else if (first === 0x7b) {
      await this.take();
      await this.space();
      if (await this.peek() !== 0x7d) {
        for (;;) {
          await this.space();
          const key = normalizedKey(await this.string(true, 256) || '');
          await this.space();
          await this.expect(0x3a);
          if (LOG_COLLECTION_KEYS.has(key) && (await this.peekAfterSpace()) === 0x5b) {
            candidates.push(await this.rowsArray());
          } else await this.skipValue();
          await this.space();
          const delimiter = await this.take();
          if (delimiter === 0x7d) break;
          if (delimiter !== 0x2c) throw new Error('bifrost_log_json_syntax_invalid');
        }
      } else await this.take();
    } else throw new Error('bifrost_log_response_shape_unknown');
    await this.space();
    if (await this.peek() !== null || candidates.length !== 1) throw new Error('bifrost_log_response_shape_unknown');
    return { ...candidates[0], bodySha256: this.bodyHasher.digest('hex') };
  }

  async peekAfterSpace() {
    await this.space();
    return this.peek();
  }

  async close() {
    try { await this.reader.cancel(); } catch {}
  }
}

function assertManagementAuth(value) {
  if (!value || typeof value !== 'object' || typeof value.username !== 'string' || !value.username
    || typeof value.password !== 'string' || !value.password || /[\r\n]/u.test(value.username) || /[\r\n]/u.test(value.password)) {
    throw new Error('external_normal_v2_management_auth_unavailable');
  }
  return value;
}

async function canonicalStoreRoot(rootDirectory) {
  const requested = path.resolve(rootDirectory);
  const canonical = await realpath(requested);
  const rootInfo = await lstat(requested);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('external_normal_v2_provider_store_root_invalid');
  return canonical;
}

async function readPrivateIdentifierSidecar(root, reference) {
  const expectedPrefix = 'normal-engine-qualification-store/';
  const relative = reference?.path;
  if (typeof relative !== 'string' || !relative.startsWith(expectedPrefix)
    || !relative.endsWith('/provider-identifiers.record/provider-identifiers.json')
    || !SHA256_RE.test(reference.sha256 || '')) throw new Error('external_normal_v2_provider_identifier_reference_invalid');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('external_normal_v2_provider_identifier_path_escape');
  let cursor = root;
  for (const part of path.relative(root, absolute).split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('external_normal_v2_provider_identifier_symlink_forbidden');
    if (cursor !== absolute && !info.isDirectory()) throw new Error('external_normal_v2_provider_identifier_parent_invalid');
    if (cursor === absolute && !info.isFile()) throw new Error('external_normal_v2_provider_identifier_file_invalid');
  }
  const bytes = await readFile(absolute);
  if (digest(bytes.toString('utf8')) !== reference.sha256) throw new Error('external_normal_v2_provider_identifier_digest_mismatch');
  const privateHashPath = path.join(path.dirname(absolute), 'provider-identifiers.sha256');
  const checksumInfo = await lstat(privateHashPath);
  if (checksumInfo.isSymbolicLink() || !checksumInfo.isFile() || (checksumInfo.mode & 0o077) !== 0) {
    throw new Error('external_normal_v2_provider_identifier_checksum_invalid');
  }
  const privateHashBytes = await readFile(privateHashPath, 'utf8');
  if (privateHashBytes.trim() !== reference.sha256) throw new Error('external_normal_v2_provider_identifier_checksum_mismatch');
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed)) throw new Error('external_normal_v2_provider_identifier_rows_invalid');
  return parsed;
}

async function readCallerIdBindings(root, stepReceipts, calls) {
  const wanted = new Map(calls.map((call) => [call.clientRequestIdSha256, call]));
  if (wanted.size !== calls.length) throw new Error('external_normal_v2_client_cid_duplicate');
  const matches = new Map();
  for (const receipt of stepReceipts) {
    for (const artifact of receipt.artifactReferences || []) {
      if (!String(artifact.path).endsWith('/provider-identifiers.record/provider-identifiers.json')) continue;
      const rows = await readPrivateIdentifierSidecar(root, artifact);
      for (const row of rows) {
        if (typeof row?.callerRequestId !== 'string' || typeof row?.bifrostLogRequestId !== 'string'
          || !REQUEST_ID_RE.test(row.callerRequestId) || !REQUEST_ID_RE.test(row.bifrostLogRequestId)) {
          throw new Error('external_normal_v2_private_cid_row_invalid');
        }
        const callerSha = digest(row.callerRequestId.toLowerCase());
        const bifrostSha = digest(row.bifrostLogRequestId.toLowerCase());
        if (!wanted.has(callerSha)) continue;
        if (matches.has(callerSha) || wanted.get(callerSha).bifrostLogRequestIdSha256 !== bifrostSha) {
          throw new Error('external_normal_v2_private_cid_binding_ambiguous');
        }
        const upstreamResponseRequestId = row.upstreamResponseRequestId;
        if (upstreamResponseRequestId !== null && upstreamResponseRequestId !== undefined
          && (typeof upstreamResponseRequestId !== 'string' || !REQUEST_ID_RE.test(upstreamResponseRequestId))) {
          throw new Error('external_normal_v2_upstream_response_cid_invalid');
        }
        const upstreamResponseSha = upstreamResponseRequestId ? digest(upstreamResponseRequestId.toLowerCase()) : null;
        if ((wanted.get(callerSha).upstreamResponseRequestIdSha256 ?? null) !== upstreamResponseSha) {
          throw new Error('external_normal_v2_upstream_response_cid_binding_mismatch');
        }
        matches.set(callerSha, { callerRequestId: row.callerRequestId, bifrostLogRequestId: row.bifrostLogRequestId,
          upstreamResponseRequestId, upstreamResponseRequestIdSha256: upstreamResponseSha });
      }
    }
  }
  if (matches.size !== wanted.size) throw new Error('external_normal_v2_private_cid_binding_missing');
  return matches;
}

async function collectOneExactLog({ fetchImpl, auth, binding, managementOrigin, signal, deadlineAt }) {
  const { callerRequestId, bifrostLogRequestId, upstreamResponseRequestIdSha256 } = binding;
  if (!REQUEST_ID_RE.test(callerRequestId) || !REQUEST_ID_RE.test(bifrostLogRequestId)) {
    throw new Error('external_normal_v2_caller_cid_invalid');
  }
  const url = new URL('/api/logs', managementOrigin);
  url.searchParams.set('request_id', callerRequestId);
  url.searchParams.set('limit', '1');
  const basic = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('external_normal_v2_capture_deadline_exceeded');
  const response = await fetchImpl(url, {
    method: 'GET', headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
    redirect: 'manual', signal: timeoutSignal(signal, Math.min(LOG_TIMEOUT_MS, remainingMs)),
  });
  if (response.status !== 200) { await cancelBody(response); throw new Error('external_normal_v2_exact_log_http_rejected'); }
  const projector = new BoundedMetadataJsonProjector(response.body, LOG_RESPONSE_LIMIT_BYTES);
  let projected;
  try { projected = await projector.parse(); }
  catch { await projector.close(); throw new Error('external_normal_v2_exact_log_metadata_projection_failed'); }
  const row = projected.count === 1 && projected.rows.length === 1 ? projected.rows[0] : null;
  if (!row || row.id !== callerRequestId) throw new Error('external_normal_v2_exact_log_row_missing_or_mismatch');
  const prompt = row.token_usage?.prompt_tokens ?? row.token_usage?.input_tokens ?? null;
  const completion = row.token_usage?.completion_tokens ?? row.token_usage?.output_tokens ?? null;
  const total = row.token_usage?.total_tokens ?? (Number.isSafeInteger(prompt) && Number.isSafeInteger(completion) ? prompt + completion : null);
  const bifrostLogStatus = ['processing', 'success', 'error'].includes(row.status) ? row.status : null;
  const safeRow = {
    id: row.id, parent_request_id: row.parent_request_id ?? null, provider: row.provider ?? null,
    alias: row.alias ?? null,
    model: row.model ?? null, served_model: row.served_model ?? null, status: row.status ?? null,
    service_tier: row.service_tier ?? null, fallback_index: row.fallback_index ?? null,
    upstream_latency_ms: row.upstream_latency_ms ?? null, token_usage: row.token_usage ?? null,
    bifrostCalculatedCostUsd: typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : null,
    contentFieldsPresent: row.contentFieldsPresent === true,
  };
  return {
    clientRequestIdSha256: digest(callerRequestId.toLowerCase()),
    bifrostLogRequestIdSha256: digest(bifrostLogRequestId.toLowerCase()),
    bifrostLogRowIdSha256: digest(row.id.toLowerCase()),
    upstreamResponseRequestIdSha256,
    bifrostParentRequestIdSha256: row.parent_request_id && REQUEST_ID_RE.test(row.parent_request_id)
      ? digest(row.parent_request_id.toLowerCase()) : null,
    exactRowCount: 1,
    exactLogRowSha256: digest(canonicalJson(safeRow)),
    exactLogResponseSha256: projected.bodySha256,
    bifrostLogStatus,
    provider: typeof row.provider === 'string' && SAFE_ROUTE_RE.test(row.provider) ? row.provider : null,
    bifrostAlias: typeof row.alias === 'string' && SAFE_ROUTE_RE.test(row.alias) ? row.alias : null,
    resolvedModel: typeof row.model === 'string' && SAFE_ROUTE_RE.test(row.model) ? row.model : null,
    servedModel: typeof row.served_model === 'string' && SAFE_ROUTE_RE.test(row.served_model) ? row.served_model : null,
    serviceTier: typeof row.service_tier === 'string' && SAFE_ROUTE_RE.test(row.service_tier) ? row.service_tier : null,
    speed: null, inferenceGeo: null,
    gatewayTokenUsage: { prompt, completion, total },
    bifrostCalculatedCostUsd: safeRow.bifrostCalculatedCostUsd,
  };
}

/** Parent-side log join. Raw CIDs and Basic credentials are callback-local and never returned. */
export function createExternalNormalV2ExactLogCollector({
  managementBaseUrl, readManagementAuthInMemory, fetchImpl = globalThis.fetch, storeRoot = STORE_ROOT,
} = {}) {
  if (typeof readManagementAuthInMemory !== 'function' || typeof fetchImpl !== 'function') {
    throw new Error('external_normal_v2_exact_log_collector_bindings_missing');
  }
  let managementOrigin;
  try {
    const parsedOrigin = new URL(managementBaseUrl);
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.username || parsedOrigin.password
      || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.pathname !== '/') {
      throw new Error('invalid');
    }
    managementOrigin = parsedOrigin.origin;
  } catch { throw new Error('external_normal_v2_management_origin_invalid'); }
  return async ({ phaseId, planSha256, artifactStoreRoot, calls, stepReceipts, signal, deadlineAt } = {}) => {
    if (phaseId !== 'ws5-current-source-external-v2' || !SHA256_RE.test(planSha256 || '')
      || typeof artifactStoreRoot !== 'string' || !path.isAbsolute(artifactStoreRoot)
      || !Array.isArray(calls) || !Array.isArray(stepReceipts) || !Number.isFinite(deadlineAt)) {
      throw new Error('external_normal_v2_exact_log_capture_request_invalid');
    }
    const root = await canonicalStoreRoot(storeRoot);
    const requestedArtifactRoot = await canonicalStoreRoot(artifactStoreRoot);
    if (root !== requestedArtifactRoot) throw new Error('external_normal_v2_capture_artifact_store_root_mismatch');
    let cidBindings;
    try {
      cidBindings = await readCallerIdBindings(root, stepReceipts, calls);
    } catch (error) {
      const allIds = calls.map((call) => call.clientRequestIdSha256).sort();
      return { status: 'unavailable', queriedCallCount: 0, matchedRows: 0,
        unqueriedCallCount: allIds.length, unqueriedCidSetSha256: digest(canonicalJson(allIds)),
        unqueriedCidSha256: allIds, queriedCidSha256: [],
        failureCode: error?.message && /^[a-z0-9_]{1,100}$/u.test(error.message)
          ? error.message : 'exact_log_input_unavailable', rows: [] };
    }
    let auth;
    try { auth = assertManagementAuth(await readManagementAuthInMemory({ signal })); }
    catch {
      const allIds = calls.map((call) => call.clientRequestIdSha256).sort();
      return { status: 'unavailable', queriedCallCount: 0, matchedRows: 0,
        unqueriedCallCount: allIds.length, unqueriedCidSetSha256: digest(canonicalJson(allIds)),
        unqueriedCidSha256: allIds, queriedCidSha256: [],
        failureCode: 'exact_log_management_auth_unavailable', rows: [] };
    }
    const work = [...cidBindings.values()];
    const rows = [];
    const queriedCids = new Set();
    const stop = new AbortController();
    const stopSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    let next = 0;
    let failureCode = null;
    const worker = async () => {
      while (!failureCode && !signal?.aborted && next < work.length) {
        const index = next++;
        const callerRequestId = work[index].callerRequestId;
        queriedCids.add(digest(callerRequestId.toLowerCase()));
        try {
          rows.push(await collectOneExactLog({ fetchImpl, auth, binding: work[index], managementOrigin, signal: stopSignal, deadlineAt }));
        } catch (error) {
          if (!failureCode) {
            const message = String(error?.message || '');
            failureCode = /^[a-z0-9_]{1,100}$/u.test(message) ? message : 'exact_log_query_failed';
            stop.abort(new Error('external_normal_v2_capture_stopped_after_first_failure'));
          }
          return;
        }
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(MAX_CONCURRENCY, work.length) }, worker));
    const sortedRows = rows.sort((a, b) => a.clientRequestIdSha256.localeCompare(b.clientRequestIdSha256));
    const unqueried = calls.map((call) => call.clientRequestIdSha256).filter((cid) => !queriedCids.has(cid)).sort();
    if (failureCode || signal?.aborted || sortedRows.length !== calls.length) {
      return { status: 'unavailable', queriedCallCount: queriedCids.size, matchedRows: sortedRows.length,
        unqueriedCallCount: unqueried.length, unqueriedCidSetSha256: digest(canonicalJson(unqueried)),
        queriedCidSha256: [...queriedCids].sort(), unqueriedCidSha256: unqueried,
        failureCode: failureCode || 'capture_deadline_or_parent_abort',
        partialRowSetSha256: digest(canonicalJson(sortedRows.map((row) => row.exactLogRowSha256))), rows: sortedRows };
    }
    return { status: 'captured', artifactCount: sortedRows.length,
      artifactSetSha256: digest(canonicalJson(sortedRows.map((row) => row.exactLogRowSha256))),
      queriedCidSha256: [...queriedCids].sort(), unqueriedCidSha256: [], rows: sortedRows };
  };
}
