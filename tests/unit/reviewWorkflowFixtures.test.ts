import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadReviewWorkflowFixture } from '../support/reviewWorkflowFixtures';

const fixtureDirectory = path.resolve(__dirname, '../fixtures/review-workflows');
const fixtureFiles = () => fs.readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => path.join(fixtureDirectory, file));

describe('review workflow fixtures', () => {
  it('loads a unique, complete deterministic contract for every scenario', () => {
    const fixtures = fixtureFiles().map(loadReviewWorkflowFixture);

    expect(fixtures).toHaveLength(12);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);

    for (const fixture of fixtures) {
      expect(fixture.event.repository).toBe('acme/review-yeti');
      expect(fixture.event.prNumber).toBe(42);
      expect(fixture.event.headSha).toMatch(/^[a-f0-9]{40}$/);
      expect(fixture.github.responses).toBeDefined();
      expect(fixture.model.responses).toBeDefined();
      expect(fixture.memory.providerResponse).toBeDefined();
      expect(fixture.expected).toMatchObject({
        verdict: expect.any(String),
        coverageStatus: expect.any(String),
        mergeEligible: expect.any(Boolean),
        publishedReviewCount: expect.any(Number),
        publishedThreadCount: expect.any(Number),
        memoryQueryStatus: expect.any(String),
        memoryWriteStatus: expect.any(String),
        outboxState: expect.any(String),
        forbiddenStrings: expect.any(Array),
      });
    }
  });

  it.each([
    ['api_key', 'fixture contains unsafe key: api_key'],
    ['authorization', 'fixture contains unsafe key: authorization'],
    ['private_key', 'fixture contains unsafe key: private_key'],
    ['reason', 'fixture contains raw command reason'],
  ])('rejects unsafe fixture content (%s)', (unsafeKey, message) => {
    const fixturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-fixture-')), 'unsafe.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      id: 'unsafe-fixture',
      event: { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) },
      config: {}, github: {}, model: {}, memory: {}, expected: {},
      [unsafeKey]: 'not-safe',
    }));

    expect(() => loadReviewWorkflowFixture(fixturePath)).toThrow(message);
  });

  it('rejects unsafe marker text anywhere in the fixture payload', () => {
    const fixturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-fixture-')), 'unsafe-value.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      id: 'unsafe-value',
      event: { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) },
      config: {}, github: { marker: 'api_key=not-safe' }, model: {}, memory: {}, expected: {},
    }));

    expect(() => loadReviewWorkflowFixture(fixturePath)).toThrow('fixture contains unsafe value: api_key');
  });

  it('rejects raw command reasons embedded in arbitrary strings', () => {
    const fixturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-fixture-')), 'unsafe-reason.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      id: 'unsafe-reason',
      event: { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) },
      config: {}, github: { note: 'maintainer command reason: accepted-risk' }, model: {}, memory: {}, expected: {},
    }));

    expect(() => loadReviewWorkflowFixture(fixturePath)).toThrow('fixture contains raw command reason');
  });

  it('rejects malformed section types at the fixture boundary', () => {
    const fixturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-fixture-')), 'wrong-type.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      id: 'wrong-type',
      event: { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) },
      config: [], github: {}, model: {}, memory: {}, expected: {},
    }));

    expect(() => loadReviewWorkflowFixture(fixturePath)).toThrow('fixture config must be an object');
  });

  it('rejects an oversized fixture body', () => {
    const fixturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-fixture-')), 'oversized.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      id: 'oversized-fixture',
      event: { repository: 'acme/review-yeti', prNumber: 42, headSha: 'a'.repeat(40) },
      config: {}, github: {}, model: {}, memory: {}, expected: {},
      body: 'x'.repeat(12_001),
    }));

    expect(() => loadReviewWorkflowFixture(fixturePath)).toThrow('fixture body exceeds 12000 characters');
  });
});
