import fs from 'node:fs';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const MAX_FIXTURE_BODY_LENGTH = 12_000;

export interface ReviewWorkflowFixture {
  id: string;
  event: {
    repository: string;
    prNumber: number;
    headSha: string;
    [key: string]: JsonValue;
  };
  config: Record<string, JsonValue>;
  github: Record<string, JsonValue>;
  model: Record<string, JsonValue>;
  memory: Record<string, JsonValue>;
  expected: {
    verdict: string;
    coverageStatus: string;
    mergeEligible: boolean;
    publishedReviewCount: number;
    publishedThreadCount: number;
    memoryQueryStatus: string;
    memoryWriteStatus: string;
    outboxState: string;
    forbiddenStrings: string[];
    [key: string]: JsonValue;
  };
}

const REQUIRED_KEYS = ['id', 'event', 'config', 'github', 'model', 'memory', 'expected'] as const;
const REQUIRED_EXPECTED_KEYS = [
  'verdict', 'coverageStatus', 'mergeEligible', 'publishedReviewCount', 'publishedThreadCount',
  'memoryQueryStatus', 'memoryWriteStatus', 'outboxState', 'forbiddenStrings',
] as const;
export const REQUIRED_REVIEW_WORKFLOW_FIXTURE_IDS = Object.freeze([
  'fresh-clean', 'ignored-authorized', 'ignored-unauthorized', 'intelligence-evaluation',
  'open-finding-carried', 'partial-review', 'provider-malformed', 'provider-unavailable',
  'publication-race', 'replay-dead-letter', 'resolved-and-reopened', 'runner-cancelled', 'stale-head',
]);
const UNSAFE_KEYS = new Set(['api_key', 'authorization', 'private_key']);
const UNSAFE_VALUE_MARKERS = ['api_key', 'authorization', 'private_key'];
const RAW_COMMAND_REASON_MARKERS = [
  /\/review-yeti\s+(ignore|unignore|reopen|resolve)/iu,
  /command\s+reason/iu,
  /accepted[-_ ]risk/iu,
];

function assertSafeJson(value: JsonValue, path = '$'): void {
  if (typeof value === 'string') {
    if (value.length > MAX_FIXTURE_BODY_LENGTH) {
      throw new Error(`fixture body exceeds ${MAX_FIXTURE_BODY_LENGTH} characters at ${path}`);
    }
    const marker = UNSAFE_VALUE_MARKERS.find((candidate) => value.toLowerCase().includes(candidate));
    if (marker) throw new Error(`fixture contains unsafe value: ${marker}`);
    if (RAW_COMMAND_REASON_MARKERS.some((markerPattern) => markerPattern.test(value))) {
      throw new Error('fixture contains raw command reason');
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (UNSAFE_KEYS.has(normalizedKey)) throw new Error(`fixture contains unsafe key: ${normalizedKey}`);
    if (normalizedKey === 'reason' || normalizedKey.endsWith('commandreason')) {
      throw new Error('fixture contains raw command reason');
    }
    assertSafeJson(nested, `${path}.${key}`);
  }
}

function assertContract(value: Record<string, JsonValue>): asserts value is ReviewWorkflowFixture {
  for (const key of REQUIRED_KEYS) {
    if (!(key in value)) throw new Error(`fixture is missing required field: ${key}`);
  }
  if (typeof value.id !== 'string' || !value.id) throw new Error('fixture id must be a non-empty string');
  if (!value.event || typeof value.event !== 'object' || Array.isArray(value.event)) {
    throw new Error('fixture event must be an object');
  }
  const event = value.event as Record<string, JsonValue>;
  if (typeof event.repository !== 'string' || !event.repository) throw new Error('fixture event.repository must be a string');
  if (typeof event.prNumber !== 'number' || !Number.isInteger(event.prNumber)) throw new Error('fixture event.prNumber must be an integer');
  if (typeof event.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(event.headSha)) {
    throw new Error('fixture event.headSha must be a 40-character lowercase SHA');
  }
  for (const key of ['config', 'github', 'model', 'memory'] as const) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
      throw new Error(`fixture ${key} must be an object`);
    }
  }
  if (!value.expected || typeof value.expected !== 'object' || Array.isArray(value.expected)) {
    throw new Error('fixture expected must be an object');
  }
  const expected = value.expected as Record<string, JsonValue>;
  for (const key of REQUIRED_EXPECTED_KEYS) {
    if (!(key in expected)) throw new Error(`fixture expected is missing required field: ${key}`);
  }
  if (typeof expected.verdict !== 'string' || typeof expected.coverageStatus !== 'string'
    || typeof expected.memoryQueryStatus !== 'string' || typeof expected.memoryWriteStatus !== 'string'
    || typeof expected.outboxState !== 'string') throw new Error('fixture expected status fields must be strings');
  if (typeof expected.mergeEligible !== 'boolean'
    || !Number.isInteger(expected.publishedReviewCount)
    || !Number.isInteger(expected.publishedThreadCount)
    || !Array.isArray(expected.forbiddenStrings)
    || expected.forbiddenStrings.some((item) => typeof item !== 'string')) {
    throw new Error('fixture expected result fields have invalid types');
  }
}

export function assertReviewWorkflowFixtureSet(ids: string[]): void {
  const actual = [...ids].sort();
  const required = [...REQUIRED_REVIEW_WORKFLOW_FIXTURE_IDS].sort();
  if (actual.length !== required.length || actual.some((id, index) => id !== required[index])) {
    throw new Error('review workflow fixture IDs do not match the required corpus');
  }
}

export function loadReviewWorkflowFixture(filePath: string): ReviewWorkflowFixture {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('fixture root must be an object');
  assertSafeJson(parsed as Record<string, JsonValue>);
  assertContract(parsed as Record<string, JsonValue>);
  return parsed as ReviewWorkflowFixture;
}
