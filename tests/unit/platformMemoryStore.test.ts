import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PlatformMemoryStore } from '../../src/memory/platformMemoryStore';
import { GraphLearningEngine } from '../../src/memory/graphLearningEngine';

describe('PlatformMemoryStore & Cross-Repo Collective Intelligence', () => {
  let platformStore: PlatformMemoryStore;

  beforeEach(() => {
    platformStore = new PlatformMemoryStore(':memory:');
  });

  afterEach(() => {
    platformStore.close();
  });

  it('records new platform patterns and sanitizes sensitive tokens', async () => {
    const pattern = await platformStore.recordPlatformPattern(
      'security',
      'no-customer-identifiers',
      'No customer names or IPs like 192.168.1.1 or ghp_1234567890abcdef in code',
      'calltelemetry/ct-meta'
    );

    expect(pattern.category).toBe('security');
    expect(pattern.pattern).toBe('no-customer-identifiers');
    expect(pattern.sanitizedDescription).not.toContain('192.168.1.1');
    expect(pattern.sanitizedDescription).toContain('[IP_ADDRESS]');
    expect(pattern.sourceRepoCount).toBe(1);
    expect(pattern.confidenceScore).toBe(80);
  });

  it('elevates pattern confidence when observed across multiple repositories', async () => {
    await platformStore.recordPlatformPattern(
      'architecture',
      'bash-3.2-safe',
      'NO mapfile, NO declare -A',
      'calltelemetry/ct-meta'
    );

    const elevated = await platformStore.recordPlatformPattern(
      'architecture',
      'bash-3.2-safe',
      'NO mapfile, NO declare -A',
      'calltelemetry/ct-review-bot'
    );

    expect(elevated.sourceRepoCount).toBe(2);
    expect(elevated.occurrenceCount).toBe(2);
    expect(elevated.confidenceScore).toBe(85);
  });

  it('queries platform patterns by category and minimum confidence', async () => {
    await platformStore.recordPlatformPattern('security', 'fail-closed-gates', 'Gates fail closed', 'repo-a');
    await platformStore.recordPlatformPattern('performance', 'no-sync-file-io', 'Avoid Sync I/O in event loop', 'repo-b');

    const securityPatterns = await platformStore.queryPlatformPatterns('security');
    expect(securityPatterns.length).toBe(1);
    expect(securityPatterns[0].pattern).toBe('fail-closed-gates');

    const allPatterns = await platformStore.queryPlatformPatterns();
    expect(allPatterns.length).toBe(2);
  });

  it('integrates with GraphLearningEngine to learn locally and elevate globally', async () => {
    const engine = new GraphLearningEngine(undefined, undefined, platformStore);

    await engine.learnAndElevatePattern(
      'calltelemetry/ct-meta',
      'security',
      'no-hardcoded-secrets',
      'Never commit API keys or private RSA keys'
    );

    const patterns = await platformStore.queryPlatformPatterns('security');
    expect(patterns.length).toBe(1);
    expect(patterns[0].pattern).toBe('no-hardcoded-secrets');
  });
});
