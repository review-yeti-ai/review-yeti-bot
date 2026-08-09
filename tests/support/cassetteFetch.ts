import fs from 'node:fs';
import path from 'node:path';
import { assertCassetteSafe, type CassetteManifest } from './cassetteManifest';

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CassetteInteraction {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: JsonValue;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: JsonValue;
  };
}

export interface CassetteFetchOptions {
  cassettePath: string;
  mode?: 'replay' | 'record';
  fetchImplementation?: FetchImplementation;
  allowedRecordOrigins?: string[];
  fixtureId?: string;
  provider?: string;
}

export interface CassetteFetch {
  fetchImplementation: FetchImplementation;
  assertComplete(): void;
  interactions: readonly CassetteInteraction[];
  observedFingerprints: readonly string[];
}

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'authorization',
  'content-type',
  'user-agent',
  'x-api-key',
  'x-github-api-version',
  'x-goog-api-key',
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'location',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]);

const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|password|private[-_]?key)/i;

function sortJson(value: unknown, parentKey?: string): JsonValue {
  if (parentKey && SENSITIVE_KEY.test(parentKey)) return '<redacted>';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value as JsonValue;
  }
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item, key)]),
    ) as JsonValue;
  }
  return String(value);
}

function parseBody(text: string): JsonValue {
  if (!text) return null;
  try {
    return sortJson(JSON.parse(text));
  } catch {
    return text;
  }
}

function normalizeUrl(input: string | URL): string {
  const url = new URL(String(input));
  url.hash = '';
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function allowlistedHeaders(headers: Headers, allowed: Set<string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (!allowed.has(lower)) continue;
    normalized[lower] = lower === 'authorization' || lower.includes('api-key') || lower === 'x-api-key'
      ? '<redacted>'
      : value;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function requestFingerprint(request: CassetteInteraction['request']): string {
  return JSON.stringify({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
  });
}

async function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<CassetteInteraction['request']> {
  const request = new Request(input, init);
  return {
    method: request.method.toUpperCase(),
    url: normalizeUrl(request.url),
    headers: allowlistedHeaders(request.headers, REQUEST_HEADER_ALLOWLIST),
    body: parseBody(await request.text()),
  };
}

function loadCassette(cassettePath: string): CassetteInteraction[] {
  if (!fs.existsSync(cassettePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(cassettePath, 'utf8')) as { version?: number; interactions?: CassetteInteraction[] };
  if (parsed.version === 2) assertCassetteSafe(parsed);
  if (![1, 2].includes(parsed.version || 0) || !Array.isArray(parsed.interactions)) {
    throw new Error(`Invalid cassette format in ${cassettePath}`);
  }
  return parsed.interactions.map((interaction) => ({
    ...interaction,
    request: {
      ...interaction.request,
      method: interaction.request.method.toUpperCase(),
      url: normalizeUrl(interaction.request.url),
      headers: sortJson(interaction.request.headers) as Record<string, string>,
      body: sortJson(interaction.request.body),
    },
  }));
}

function writeCassette(cassettePath: string, interactions: CassetteInteraction[]): void {
  fs.mkdirSync(path.dirname(cassettePath), { recursive: true });
  fs.writeFileSync(cassettePath, `${JSON.stringify({ version: 1, interactions }, null, 2)}\n`, 'utf8');
}

function writeVersionedCassette(cassettePath: string, options: CassetteFetchOptions, interactions: CassetteInteraction[]): void {
  const manifest: CassetteManifest = {
    version: 2,
    fixtureId: options.fixtureId || path.basename(cassettePath, path.extname(cassettePath)),
    provider: options.provider || 'unknown',
    allowedOrigins: options.allowedRecordOrigins || [],
    interactions,
  };
  assertCassetteSafe(manifest);
  fs.mkdirSync(path.dirname(cassettePath), { recursive: true });
  fs.writeFileSync(cassettePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function createCassetteFetch(options: CassetteFetchOptions): CassetteFetch {
  const mode = options.mode ?? 'replay';
  const loaded = mode === 'replay' ? loadCassette(options.cassettePath) : [];
  const recorded: CassetteInteraction[] = [];
  const consumed = new Set<number>();
  const observedFingerprints: string[] = [];
  const underlying = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);

  const fetchImplementation: FetchImplementation = async (input, init) => {
    if (mode === 'record') {
      if (process.env.CI === 'true') {
        throw new Error('Cassette replay is mandatory in CI; recording is disabled');
      }
      if (process.env.REVIEW_YETI_VCR !== 'record' || process.env.REVIEW_YETI_RECORD_APPROVED !== 'true') {
        throw new Error('Cassette recording requires REVIEW_YETI_VCR=record and REVIEW_YETI_RECORD_APPROVED=true');
      }
      const request = await normalizeRequest(input, init);
      observedFingerprints.push(requestFingerprint(request));
      const origin = new URL(request.url).origin;
      if (!options.allowedRecordOrigins?.includes(origin)) {
        throw new Error(`Cassette recording endpoint ${origin} is not allowlisted`);
      }
      const response = await underlying(input, init);
      const responseText = await response.clone().text();
      recorded.push({
        request,
        response: {
          status: response.status,
          headers: allowlistedHeaders(response.headers, RESPONSE_HEADER_ALLOWLIST),
          body: parseBody(responseText),
        },
      });
      writeVersionedCassette(options.cassettePath, options, recorded);
      return response;
    }

    const request = await normalizeRequest(input, init);
    const loadedManifest = loadCassetteManifestIfPresent(options.cassettePath);
    if (loadedManifest) {
      const origin = new URL(request.url).origin;
      if (!loadedManifest.allowedOrigins.includes(origin)) throw new Error(`Cassette replay endpoint ${origin} is not allowlisted`);
    }
    const fingerprint = requestFingerprint(request);
    observedFingerprints.push(fingerprint);
    const interactionIndex = loaded.findIndex((interaction, index) => (
      !consumed.has(index) && requestFingerprint(interaction.request) === fingerprint
    ));
    if (interactionIndex === -1) {
      throw new Error(`No cassette interaction matches ${fingerprint}`);
    }
    consumed.add(interactionIndex);
    const interaction = loaded[interactionIndex];
    const body = interaction.response.body === null || typeof interaction.response.body === 'string'
      ? interaction.response.body ?? ''
      : JSON.stringify(interaction.response.body);
    return new Response(body, {
      status: interaction.response.status,
      headers: interaction.response.headers,
    });
  };

  return {
    fetchImplementation,
    interactions: loaded,
    observedFingerprints,
    assertComplete() {
      if (mode === 'record') return;
      const unconsumed = loaded
        .map((interaction, index) => consumed.has(index) ? null : index)
        .filter((index): index is number => index !== null);
      if (unconsumed.length > 0) {
        throw new Error(`Unconsumed cassette interactions: ${unconsumed.join(', ')}`);
      }
    },
  };
}

function loadCassetteManifestIfPresent(cassettePath: string): CassetteManifest | null {
  if (!fs.existsSync(cassettePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(cassettePath, 'utf8')) as { version?: number };
  if (parsed.version !== 2) return null;
  assertCassetteSafe(parsed);
  return parsed;
}

export { normalizeUrl, requestFingerprint };
