import fs from 'node:fs';

export type CassetteManifest = {
  version: 2;
  fixtureId: string;
  provider: string;
  allowedOrigins: string[];
  interactions: Array<{
    request: { method: string; url: string; headers: Record<string, unknown>; body: unknown };
    response: { status: number; headers: Record<string, unknown>; body: unknown };
  }>;
};

const SECRET_KEY = /(authorization|api[-_]?key|token|secret|password|private[-_]?key|workspace[-_]?jwt)/iu;

function walk(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && SECRET_KEY.test(path.at(-1) || '') && value !== '<redacted>') {
      throw new Error(`cassette secret field ${path.join('.')} is not redacted`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
}

export function assertCassetteSafe(manifest: unknown): asserts manifest is CassetteManifest {
  if (!manifest || typeof manifest !== 'object') throw new Error('cassette manifest must be an object');
  const candidate = manifest as Partial<CassetteManifest>;
  if (candidate.version !== 2) throw new Error('cassette manifest version must be 2');
  if (!candidate.fixtureId || !/^[a-z0-9][a-z0-9._-]*$/u.test(candidate.fixtureId)) {
    throw new Error('cassette fixtureId must be a path-safe identifier');
  }
  if (!candidate.provider || !/^[a-z0-9][a-z0-9._-]*$/u.test(candidate.provider)) {
    throw new Error('cassette provider must be a path-safe identifier');
  }
  if (!Array.isArray(candidate.allowedOrigins) || candidate.allowedOrigins.length === 0) {
    throw new Error('cassette allowedOrigins must be non-empty');
  }
  for (const origin of candidate.allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(`cassette origin is not an origin: ${origin}`);
  }
  if (!Array.isArray(candidate.interactions)) throw new Error('cassette interactions must be an array');
  walk(candidate);
}

export function readCassetteManifest(filePath: string): CassetteManifest {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  assertCassetteSafe(parsed);
  return parsed;
}
