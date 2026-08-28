import fs from 'node:fs';
import path from 'node:path';

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
    /** Optional wire chunks used to replay streaming responses at chunk boundaries. */
    streamChunks?: string[];
  };
}

export interface CassetteFetchOptions {
  cassettePath: string;
  mode?: 'replay' | 'record';
  fetchImplementation?: FetchImplementation;
  allowedRecordOrigins?: string[];
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
  if (Array.isArray(value)) return value.map((item) => sortJson(item, parentKey));
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
  url.username = '';
  url.password = '';
  const normalizedParams = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    normalizedParams.append(key, SENSITIVE_KEY.test(key) ? '<redacted>' : value);
  }
  url.search = normalizedParams.toString();
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

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>')
    .replace(/gh[psuor]_[A-Za-z0-9_]+/g, '<redacted>')
    .replace(/(api[_-]?key=)[^&"'\s]+/gi, '$1<redacted>');
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
  if (!fs.existsSync(cassettePath)) throw new Error(`Cassette file not found in replay mode: ${cassettePath}`);
  const parsed = JSON.parse(fs.readFileSync(cassettePath, 'utf8')) as { version?: number; interactions?: CassetteInteraction[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.interactions)) {
    throw new Error(`Invalid cassette format in ${cassettePath}`);
  }
  return parsed.interactions.map((interaction) => ({
    ...interaction,
    request: {
      ...interaction.request,
      method: interaction.request.method.toUpperCase(),
      url: normalizeUrl(interaction.request.url),
      headers: allowlistedHeaders(new Headers(interaction.request.headers), REQUEST_HEADER_ALLOWLIST),
      body: sortJson(interaction.request.body),
    },
  }));
}

function writeCassette(cassettePath: string, interactions: CassetteInteraction[]): void {
  fs.mkdirSync(path.dirname(cassettePath), { recursive: true });
  fs.writeFileSync(cassettePath, `${JSON.stringify({ version: 1, interactions }, null, 2)}\n`, 'utf8');
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
      if (process.env.CT_REVIEW_VCR !== 'record') {
        throw new Error('Cassette recording requires CT_REVIEW_VCR=record');
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
      writeCassette(options.cassettePath, recorded);
      return response;
    }

    const request = await normalizeRequest(input, init);
    const fingerprint = requestFingerprint(request);
    observedFingerprints.push(fingerprint);
    const interactionIndex = loaded.findIndex((interaction, index) => (
      !consumed.has(index) && requestFingerprint(interaction.request) === fingerprint
    ));
    if (interactionIndex === -1) {
      throw new Error(redactDiagnostic(
        `No cassette interaction matches request fingerprint ${fingerprint}; consumed ${consumed.size}/${loaded.length} interaction(s)`,
      ));
    }
    consumed.add(interactionIndex);
    const interaction = loaded[interactionIndex];
    const streamChunks = interaction.response.streamChunks;
    if (Array.isArray(streamChunks)) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of streamChunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(body, {
        status: interaction.response.status,
        headers: interaction.response.headers,
      });
    }
    const body = interaction.response.body === null || typeof interaction.response.body === 'string'
      ? interaction.response.body
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

export { normalizeUrl, requestFingerprint };
