import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintEffectiveReviewConfig } from '../../src/review/authoritativeReviewIdentity';
import { parsePreparedReviewExecution } from '../../src/review/preparedPublishingPolicy';
import { ctReviewConfigV3Schema } from '../../src/config/schema';

interface ContractCase {
  name: string;
  json: string;
  padToBytes?: number;
  envelopeAccepted: boolean;
  typescriptAccepted: boolean;
  integrityOnly?: string;
  digestMismatch?: boolean;
  actualTransport?: { baseUrl: string; model: string };
  workerImage?: string;
}

// Kept within the Go module so standalone operator tests also carry the corpus.
// The Go BuildWorkerJob test reads this same file, not a mirrored copy.
const corpus = JSON.parse(readFileSync(resolve(__dirname,
  '../../k8s-operator/pkg/job/testdata/prepared-review-execution.json'), 'utf8')) as {
  version: string; configJson: string; cases: ContractCase[];
};

function expectedConfigForV1Envelope(value: unknown) {
  const parsed = ctReviewConfigV3Schema.parse(value);
  const source = value as Record<string, unknown>;
  if (!Object.hasOwn(source, 'swarm_context_isolation')) {
    delete (parsed as unknown as Record<string, unknown>).swarm_context_isolation;
  }
  const sourceComposed = source.composed as Record<string, unknown> | undefined;
  const parsedComposed = parsed.composed as unknown as Record<string, unknown> | undefined;
  if (parsedComposed) {
    for (const field of ['swarm_context_isolation', 'quorum_policy']) {
      if (!sourceComposed || !Object.hasOwn(sourceComposed, field)) delete parsedComposed[field];
    }
  }
  return parsed;
}

describe('shared Go/TypeScript prepared execution contract', () => {
  it('has non-vacuous unique fixtures and explicitly documents TS-only integrity checks', () => {
    expect(corpus.version).toBe('prepared-review-execution-contract.v1');
    expect(corpus.cases.length).toBeGreaterThan(0);
    expect(new Set(corpus.cases.map((fixture) => fixture.name)).size).toBe(corpus.cases.length);
    for (const fixture of corpus.cases) {
      if (fixture.envelopeAccepted !== fixture.typescriptAccepted) {
        expect(fixture.envelopeAccepted).toBe(true);
        expect(fixture.typescriptAccepted).toBe(false);
        expect(fixture.integrityOnly).toBeTruthy();
      } else expect(fixture.integrityOnly).toBeUndefined();
    }
  });

  it('binds the service-prepared capability fixture to the exact projected worker image digest', () => {
    const fixture = corpus.cases.find((candidate) => candidate.workerImage !== undefined);
    expect(fixture).toBeDefined();
    const raw = fixture!.json.replaceAll('$CONFIG', corpus.configJson);
    const decoded = JSON.parse(raw) as { config: unknown; transport: { baseUrl: string; model: string };
      qualificationRuntimeImageDigest?: string };
    const digest = decoded.qualificationRuntimeImageDigest;
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(fixture!.workerImage).toBe(`registry.digitalocean.com/exampleorg/review-yeti-worker@${digest}`);
    const configDigest = fingerprintEffectiveReviewConfig({ config: decoded.config, transport: decoded.transport,
      qualificationRuntimeImageDigest: digest });

    expect(parsePreparedReviewExecution(raw, configDigest)).toMatchObject({
      qualificationRuntimeImageDigest: digest,
    });
  });

  it('validates a legacy v1 config digest before applying current schema defaults', () => {
    const fixture = corpus.cases.find((candidate) => candidate.name === 'valid');
    expect(fixture).toBeDefined();
    const raw = fixture!.json.replaceAll('$CONFIG', corpus.configJson);
    const decoded = JSON.parse(raw) as { config: unknown; transport: { baseUrl: string; model: string } };
    expect(decoded.config).not.toHaveProperty('swarm_context_isolation');
    const digest = fingerprintEffectiveReviewConfig({ config: decoded.config, transport: decoded.transport });

    const parsed = parsePreparedReviewExecution(raw, digest);

    expect(parsed.config).toEqual(expectedConfigForV1Envelope(decoded.config));
    expect(parsed.config).not.toHaveProperty('swarm_context_isolation');
    expect(parsed.transport).toEqual(decoded.transport);
  });

  it.each(corpus.cases)('$name', (fixture) => {
    let raw = fixture.json.replaceAll('$CONFIG', corpus.configJson);
    if (fixture.padToBytes !== undefined) {
      expect(fixture.padToBytes).toBeGreaterThanOrEqual(Buffer.byteLength(raw, 'utf8'));
      raw += ' '.repeat(fixture.padToBytes - Buffer.byteLength(raw, 'utf8'));
      expect(Buffer.byteLength(raw, 'utf8')).toBe(fixture.padToBytes);
    }
    // A matching digest removes config-binding noise from the shared envelope
    // cases. Only the named digest-mismatch case deliberately uses another one.
    let digest = '0'.repeat(64);
    let decoded: { config: unknown; transport: { baseUrl: string; model: string };
      qualificationRuntimeImageDigest?: string } | undefined;
    try {
      decoded = JSON.parse(raw);
      if (decoded && !fixture.digestMismatch) digest = fingerprintEffectiveReviewConfig({
        config: decoded.config, transport: decoded.transport,
        ...(decoded.qualificationRuntimeImageDigest === undefined ? {} : {
          qualificationRuntimeImageDigest: decoded.qualificationRuntimeImageDigest,
        }),
      });
    } catch { /* Malformed envelopes still reach the public parser below. */ }
    const parse = () => parsePreparedReviewExecution(raw, digest, fixture.actualTransport);
    if (fixture.typescriptAccepted) {
      const result = parse();
      if (!decoded) throw new Error('accepted fixture JSON must decode');
      expect(result).toEqual({ ...decoded, config: expectedConfigForV1Envelope(decoded.config) });
      // No URL/model normalization or mutation is permitted across the seam.
      expect(result.transport).toEqual(decoded?.transport);
    } else {
      expect(parse).toThrow(new Error('Prepared review execution does not match its admitted identity'));
    }
  });
});
