import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  getPreparedPublishingPolicy,
  MAX_PREPARED_REVIEW_BYTES,
  PREPARED_REVIEW_SCHEMA_SQL,
  savePreparedPublishingPolicy,
  type PreparedReviewQueryable,
} from '../../src/persistence/preparedReviewRepository';
import { preparePublishingPolicy, type PreparedPublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const OWNED_SCHEMA = /^prepared_review_test_[0-9a-f]{16}$/u;
const RAW_SECRET = 'synthetic-policy-credential-do-not-retain';
const SAVE_ERROR = 'Prepared review policy could not be saved';
const READ_ERROR = 'Prepared review policy is invalid or unavailable';

function preparedPolicy(turns = 20): PreparedPublishingPolicy {
  const content = JSON.stringify({
    schema: 'calltelemetry.review-policy.v1',
    review_yeti: { personas: 'security,testing', budget: { max_investigation_turns: turns }, api_key: RAW_SECRET },
  });
  return preparePublishingPolicy({
    content,
    source: {
      repositoryId: 123, repository: 'example/central-policy', sha: 'a'.repeat(40),
      path: 'policy/review-yeti.json', contentDigest: createHash('sha256').update(content).digest('hex'),
    },
  }, { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
}

// Deliberately compute even for malformed fixtures: rehashing a malicious
// prepared object must not bypass semantic/schema checks in the repository.
function rehashConfig(prepared: PreparedPublishingPolicy): void {
  prepared.policy.effectiveConfigDigest = sha256({
    version: 'ReviewConfigFingerprint.v1', config: { config: prepared.config, transport: prepared.transport },
  });
}

function preparedDigest(prepared: PreparedPublishingPolicy): string {
  return sha256({ version: 'PreparedReviewContent.v1', prepared });
}

describeWithPostgres('prepared review policy immutable Postgres storage', () => {
  let pool: Pool | undefined;
  let schemaName: string | undefined;

  beforeAll(async () => {
    schemaName = `prepared_review_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error('Generated schema is not owned by this test');
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schemaName},public` });
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    await pool.query(PREPARED_REVIEW_SCHEMA_SQL);
  });

  afterEach(async () => {
    await pool?.query('TRUNCATE prepared_review_policies');
  });

  afterAll(async () => {
    if (!schemaName) return;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error('Refusing to drop unowned schema');
    try {
      await pool?.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await pool?.end();
      pool = undefined;
    }
  });

  async function rows() {
    return (await pool!.query('SELECT * FROM prepared_review_policies ORDER BY effective_policy_digest')).rows;
  }

  async function overwriteStored(prepared: PreparedPublishingPolicy): Promise<void> {
    await pool!.query(`UPDATE prepared_review_policies SET config = $2::jsonb, transport = $3::jsonb,
      sources = $4::jsonb, expected_persona_ids = $5::jsonb, effective_config_digest = $6,
      prepared_content_digest = $7 WHERE effective_policy_digest = $1`, [
      prepared.policy.effectivePolicyDigest, JSON.stringify(prepared.config), JSON.stringify(prepared.transport),
      JSON.stringify(prepared.policy.sources), JSON.stringify(prepared.expectedPersonaIds),
      prepared.policy.effectiveConfigDigest, preparedDigest(prepared),
    ]);
  }

  it('installs additively and inserts/reads normalized config, transport, provenance and persona IDs', async () => {
    await pool!.query(PREPARED_REVIEW_SCHEMA_SQL);
    const prepared = preparedPolicy();
    expect(await getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).toBeNull();
    expect(await savePreparedPublishingPolicy(pool!, prepared)).toEqual(prepared);
    expect(await getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).toEqual(prepared);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      effective_policy_digest: prepared.policy.effectivePolicyDigest,
      effective_config_digest: prepared.policy.effectiveConfigDigest,
      version: prepared.version, config: prepared.config, transport: prepared.transport,
      sources: prepared.policy.sources, expected_persona_ids: ['sec-lane', 'qual-lane'],
      prepared_content_digest: preparedDigest(prepared),
    });
    expect(JSON.stringify(stored)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(stored)).not.toContain('api_key');
    expect(stored[0]).not.toHaveProperty('raw_policy');
  });

  it('preserves exact immutable rows across concurrent identical saves and reordered object keys', async () => {
    const prepared = preparedPolicy();
    const results = await Promise.all([
      savePreparedPublishingPolicy(pool!, prepared),
      savePreparedPublishingPolicy(pool!, JSON.parse(canonicalJson(prepared))),
    ]);
    expect(results).toEqual([prepared, prepared]);
    const initial = await rows();
    await savePreparedPublishingPolicy(pool!, structuredClone(prepared));
    expect(await rows()).toEqual(initial);
  });

  it('normalizes provenance order without mutating the caller or changing persona order', async () => {
    const prepared = preparedPolicy();
    prepared.policy.sources.unshift({ ...prepared.policy.sources[0], repositoryId: 124 });
    const original = structuredClone(prepared);
    const saved = await savePreparedPublishingPolicy(pool!, prepared);
    expect(prepared).toEqual(original);
    expect(saved.policy.sources.map((source) => source.repositoryId)).toEqual([123, 124]);
    expect(saved.expectedPersonaIds).toEqual(original.expectedPersonaIds);
    expect(await savePreparedPublishingPolicy(pool!, saved)).toEqual(saved);
  });

  it('binds an opaque trusted policy digest independently of the rederived config fingerprint', async () => {
    const prepared = preparedPolicy();
    // The raw central policy is deliberately absent. Persistence can bind this
    // trusted supplied digest but cannot authenticate/rederive it independently.
    prepared.policy.effectivePolicyDigest = 'b'.repeat(64);
    await savePreparedPublishingPolicy(pool!, prepared);
    expect(await getPreparedPublishingPolicy(pool!, 'b'.repeat(64))).toEqual(prepared);
    await pool!.query('UPDATE prepared_review_policies SET effective_policy_digest = $1', ['c'.repeat(64)]);
    await expect(getPreparedPublishingPolicy(pool!, 'c'.repeat(64))).rejects.toThrow(READ_ERROR);
  });

  it.each(['config', 'transport', 'source'] as const)('rejects a conflicting %s for the same policy key without overwriting', async (field) => {
    const prepared = preparedPolicy();
    await savePreparedPublishingPolicy(pool!, prepared);
    const initial = await rows();
    const conflicting = structuredClone(prepared);
    if (field === 'config') conflicting.config.default_max_turns = 2;
    if (field === 'transport') conflicting.transport.baseUrl = 'https://other-gateway.example.invalid/v1';
    if (field === 'source') conflicting.policy.sources[0].sha = 'b'.repeat(40);
    rehashConfig(conflicting);
    await expect(savePreparedPublishingPolicy(pool!, conflicting)).rejects.toThrow(SAVE_ERROR);
    expect(await rows()).toEqual(initial);
  });

  it('serializes conflicting concurrent inserts so exactly one immutable body wins', async () => {
    const first = preparedPolicy();
    const second = structuredClone(first);
    second.config.default_max_turns = 2;
    rehashConfig(second);
    const results = await Promise.allSettled([
      savePreparedPublishingPolicy(pool!, first), savePreparedPublishingPolicy(pool!, second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('No insert winner');
    expect(await getPreparedPublishingPolicy(pool!, first.policy.effectivePolicyDigest)).toEqual(winner.value);
    expect(await rows()).toHaveLength(1);
  });

  const corruptions: Array<[string, (prepared: PreparedPublishingPolicy) => void]> = [
    ['config fingerprint', (p) => { p.policy.effectiveConfigDigest = 'f'.repeat(64); }],
    ['transport fingerprint', (p) => { p.transport.baseUrl = 'https://changed.example.invalid/v1'; }],
    ['provider model binding', (p) => { p.transport.model = 'different-model'; rehashConfig(p); }],
    ['non-Bifrost provider', (p) => {
      p.config.reviewers.providers[0].id = 'openrouter';
      p.config.reviewers.arbiter.order = ['openrouter'];
      p.config.personas.forEach((persona) => { persona.providers = ['openrouter']; });
      rehashConfig(p);
    }],
    ['unknown config root', (p) => { p.config.unexpected = true; rehashConfig(p); }],
    ['silently stripped provider metadata', (p) => { Object.assign(p.config.reviewers.providers[0], { unexpected: true }); }],
    ['unnormalized defaults', (p) => { Reflect.deleteProperty(p.config.auto_review, 'triggers'); }],
    ['missing expected persona', (p) => { p.expectedPersonaIds.pop(); }],
    ['duplicate expected persona', (p) => { p.expectedPersonaIds[1] = p.expectedPersonaIds[0]; }],
    ['unknown expected persona', (p) => { p.expectedPersonaIds[1] = 'other-lane'; }],
    ['noncanonical expected persona', (p) => { p.expectedPersonaIds[1] = 'Security'; }],
    ['reordered expected personas', (p) => { p.expectedPersonaIds.reverse(); }],
    ['mutable source ref', (p) => { p.policy.sources[0].sha = 'main'; }],
    ['unsafe source path', (p) => { p.policy.sources[0].path = '../policy.json'; }],
    ['duplicate source', (p) => { p.policy.sources.push({ ...p.policy.sources[0] }); }],
    ['missing source', (p) => { p.policy.sources = []; }],
    ['malformed source content digest', (p) => { p.policy.sources[0].contentDigest = 'invalid'; }],
    ['plaintext transport', (p) => { p.transport.baseUrl = 'http://gateway.example.invalid'; rehashConfig(p); }],
    ['transport userinfo', (p) => { p.transport.baseUrl = `https://user:${RAW_SECRET}@gateway.example.invalid`; rehashConfig(p); }],
    ['transport query credential', (p) => { p.transport.baseUrl += `?token=${RAW_SECRET}`; rehashConfig(p); }],
    ['config credential container', (p) => { p.config.mcps = [{ name: 'test', enabled: true, options: { api_key: RAW_SECRET } }]; rehashConfig(p); }],
  ];

  it.each(corruptions)('rejects %s on save before any SQL', async (_label, corrupt) => {
    const prepared = preparedPolicy();
    corrupt(prepared);
    const query = vi.fn((sql: string, values?: unknown[]) => pool!.query(sql, values));
    await expect(savePreparedPublishingPolicy({ query }, prepared)).rejects.toThrow(SAVE_ERROR);
    expect(query).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it.each(corruptions)('rejects persisted %s even with a recomputed content hash', async (_label, corrupt) => {
    const prepared = preparedPolicy();
    await savePreparedPublishingPolicy(pool!, prepared);
    corrupt(prepared);
    await overwriteStored(prepared);
    await expect(getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).rejects.toThrow(READ_ERROR);
  });

  it.each(['config', 'transport', 'sources', 'expected_persona_ids', 'prepared_content_digest'] as const)(
    'detects tampering in stored %s before returning evidence', async (column) => {
      const prepared = preparedPolicy();
      await savePreparedPublishingPolicy(pool!, prepared);
      const values = {
        config: { ...prepared.config, default_max_turns: 2 },
        transport: { ...prepared.transport, model: 'other-model' },
        sources: [{ ...prepared.policy.sources[0], sha: 'f'.repeat(40) }],
        expected_persona_ids: ['sec-lane'],
        prepared_content_digest: 'f'.repeat(64),
      };
      // Column names come only from this fixed test-case list.
      await pool!.query(`UPDATE prepared_review_policies SET ${column} = $1`, [
        column === 'prepared_content_digest' ? values[column] : JSON.stringify(values[column]),
      ]);
      await expect(getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).rejects.toThrow(READ_ERROR);
      await expect(savePreparedPublishingPolicy(pool!, prepared)).rejects.toThrow(SAVE_ERROR);
    },
  );

  it.each([
    ['body bytes', (p: PreparedPublishingPolicy) => { p.config.rules = [{ id: 'rule', rule: 'x'.repeat(MAX_PREPARED_REVIEW_BYTES), scope: ['**'], severity: 'P1' }]; }],
    ['multibyte bytes', (p: PreparedPublishingPolicy) => { p.config.rules = [{ id: 'rule', rule: 'é'.repeat(MAX_PREPARED_REVIEW_BYTES / 2), scope: ['**'], severity: 'P1' }]; }],
    ['JSON depth', (p: PreparedPublishingPolicy) => {
      let deep: Record<string, unknown> = {}; for (let index = 0; index < 34; index++) deep = { option: deep };
      p.config.mcps = [{ name: 'test', enabled: true, options: deep }];
    }],
    ['JSON nodes', (p: PreparedPublishingPolicy) => { p.config.path_filters = Array.from({ length: 16_385 }, () => ''); }],
    ['source count', (p: PreparedPublishingPolicy) => { p.policy.sources = Array.from({ length: 17 }, (_, i) => ({ ...p.policy.sources[0], repositoryId: 123 + i })); }],
    ['persona count', (p: PreparedPublishingPolicy) => {
      p.config.personas = Array.from({ length: 65 }, (_, i) => ({ ...p.config.personas[0], id: `lane-${i}` }));
      p.expectedPersonaIds = p.config.personas.map((persona) => persona.id);
    }],
  ] as const)('enforces %s bounds on save and read', async (_label, expand) => {
    const prepared = preparedPolicy();
    await savePreparedPublishingPolicy(pool!, prepared);
    expand(prepared);
    rehashConfig(prepared);
    await expect(savePreparedPublishingPolicy(pool!, prepared)).rejects.toThrow(SAVE_ERROR);
    await overwriteStored(prepared);
    await expect(getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).rejects.toThrow(READ_ERROR);
  });

  it('round-trips a normalized object at the exact UTF-8 byte limit and rejects one extra byte', async () => {
    const prepared = preparedPolicy();
    prepared.config.rules = [{ id: 'rule', rule: '', scope: ['**'], severity: 'P1' }];
    rehashConfig(prepared);
    const remaining = MAX_PREPARED_REVIEW_BYTES - Buffer.byteLength(JSON.stringify(prepared), 'utf8');
    prepared.config.rules[0].rule = 'x'.repeat(remaining);
    rehashConfig(prepared);
    expect(Buffer.byteLength(JSON.stringify(prepared), 'utf8')).toBe(MAX_PREPARED_REVIEW_BYTES);
    expect(await savePreparedPublishingPolicy(pool!, prepared)).toEqual(prepared);
    expect(await getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).toEqual(prepared);
    prepared.config.rules[0].rule += 'x';
    rehashConfig(prepared);
    await expect(savePreparedPublishingPolicy(pool!, prepared)).rejects.toThrow(SAVE_ERROR);
  });

  it('rejects lossy or executable JSON without invoking accessors or retaining raw input', async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const getter = vi.fn(() => RAW_SECRET);
    const accessor = Object.defineProperty({}, 'value', { get: getter, enumerable: true });
    class ExecutableArray extends Array { toJSON() { return getter(); } }
    for (const value of [undefined, Number.NaN, Infinity, new Date(), () => RAW_SECRET, cycle, accessor,
      JSON.parse('{"__proto__":{"unsafe":true}}'), new Array(2), new ExecutableArray(), Symbol('test')]) {
      const prepared = preparedPolicy();
      prepared.config.mcps = [{ name: 'test', enabled: true, options: { option: value } }];
      await expect(savePreparedPublishingPolicy(pool!, prepared)).rejects.toThrow(SAVE_ERROR);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('rejects raw policy/credential additions at every prepared boundary before sending values to SQL', async () => {
    for (const target of ['prepared', 'policy', 'config', 'provider', 'transport', 'source'] as const) {
      const prepared = preparedPolicy();
      const objects = {
        prepared, policy: prepared.policy, config: prepared.config,
        provider: prepared.config.reviewers.providers[0], transport: prepared.transport, source: prepared.policy.sources[0],
      };
      Object.assign(objects[target], { apiKey: RAW_SECRET, rawPolicy: { confidential: RAW_SECRET } });
      const query = vi.fn((sql: string, values?: unknown[]) => pool!.query(sql, values));
      await expect(savePreparedPublishingPolicy({ query }, prepared)).rejects.toThrow(SAVE_ERROR);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('allows the caller to commit or roll back prepared storage with its transaction', async () => {
    const prepared = preparedPolicy();
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await savePreparedPublishingPolicy(client, prepared);
      expect(await getPreparedPublishingPolicy(client, prepared.policy.effectivePolicyDigest)).toEqual(prepared);
      expect(await getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).toBeNull();
      await client.query('ROLLBACK');
      expect(await getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).toBeNull();
      await client.query('BEGIN');
      await savePreparedPublishingPolicy(client, prepared);
      await client.query('COMMIT');
      expect(await getPreparedPublishingPolicy(pool!, prepared.policy.effectivePolicyDigest)).toEqual(prepared);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('lets an immutable conflict roll back other prepared admission writes in the same transaction', async () => {
    const original = preparedPolicy();
    await savePreparedPublishingPolicy(pool!, original);
    const initial = await rows();
    const additional = preparedPolicy(2);
    const conflicting = structuredClone(original);
    conflicting.config.default_max_turns = 2;
    rehashConfig(conflicting);
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await savePreparedPublishingPolicy(client, additional);
      await expect(savePreparedPublishingPolicy(client, conflicting)).rejects.toThrow(SAVE_ERROR);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect(await getPreparedPublishingPolicy(pool!, additional.policy.effectivePolicyDigest)).toBeNull();
    expect(await rows()).toEqual(initial);
  });

  it('does not swallow SQL failures or retain driver messages, details or causes', async () => {
    const prepared = preparedPolicy();
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query("ALTER TABLE prepared_review_policies ADD CONSTRAINT synthetic_failure CHECK (effective_config_digest = 'impossible')");
      await expect(savePreparedPublishingPolicy(client, prepared)).rejects.toThrow(SAVE_ERROR);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect(await rows()).toEqual([]);
    const unavailable: PreparedReviewQueryable = {
      query: async () => { throw Object.assign(new Error(RAW_SECRET), { detail: RAW_SECRET, cause: RAW_SECRET }); },
    };
    for (const operation of [
      () => savePreparedPublishingPolicy(unavailable, prepared),
      () => getPreparedPublishingPolicy(unavailable, prepared.policy.effectivePolicyDigest),
    ]) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(RAW_SECRET);
      expect(JSON.stringify(error)).not.toContain(RAW_SECRET);
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('detail');
    }
  });

  it('rejects malformed lookup keys before SQL', async () => {
    const query = vi.fn((sql: string, values?: unknown[]) => pool!.query(sql, values));
    for (const key of ['', 'main', 'A'.repeat(64), "'; DROP TABLE prepared_review_policies; --"]) {
      await expect(getPreparedPublishingPolicy({ query }, key)).rejects.toThrow(READ_ERROR);
    }
    expect(query).not.toHaveBeenCalled();
  });
});
