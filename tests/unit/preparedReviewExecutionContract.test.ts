import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintEffectiveReviewConfig } from '../../src/review/authoritativeReviewIdentity';
import { parsePreparedReviewExecution } from '../../src/review/preparedPublishingPolicy';

interface ContractCase {
  name: string;
  json: string;
  padToBytes?: number;
  envelopeAccepted: boolean;
  typescriptAccepted: boolean;
  integrityOnly?: string;
  digestMismatch?: boolean;
  actualTransport?: { baseUrl: string; model: string };
}

// Kept within the Go module so standalone operator tests also carry the corpus.
// The Go BuildWorkerJob test reads this same file, not a mirrored copy.
const corpus = JSON.parse(readFileSync(resolve(__dirname,
  '../../k8s-operator/pkg/job/testdata/prepared-review-execution.json'), 'utf8')) as {
  version: string; configJson: string; cases: ContractCase[];
};

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
    let decoded: { config: unknown; transport: { baseUrl: string; model: string } } | undefined;
    try {
      decoded = JSON.parse(raw);
      if (decoded && !fixture.digestMismatch) digest = fingerprintEffectiveReviewConfig({
        config: decoded.config, transport: decoded.transport,
      });
    } catch { /* Malformed envelopes still reach the public parser below. */ }
    const parse = () => parsePreparedReviewExecution(raw, digest, fixture.actualTransport);
    if (fixture.typescriptAccepted) {
      const result = parse();
      expect(result).toEqual(decoded);
      // No URL/model normalization or mutation is permitted across the seam.
      expect(result.transport).toEqual(decoded?.transport);
    } else {
      expect(parse).toThrow(new Error('Prepared review execution does not match its admitted identity'));
    }
  });
});
