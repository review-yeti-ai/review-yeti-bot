import { describe, it, expect, vi } from 'vitest';
import { ConfigResolver, RepositoryContentClient } from '../../src/config/configResolver';
import { ConfigValidationError } from '../../src/config/configLoader';
import { R4_ALLOWED_MODELS } from '../../src/config/schema';

describe('ConfigResolver Unit Tests (Milestone 39)', () => {
  const mockClient = (files: Record<string, string>): RepositoryContentClient => ({
    getFileContent: async (_owner: string, _repo: string, path: string) => {
      return files[path] || null;
    },
  });

  it('resolves system defaults when no repository or org YAML exists', async () => {
    const resolver = new ConfigResolver();
    const client = mockClient({});

    const config = await resolver.resolveConfig({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      ref: 'main',
      client,
    });

    expect(config.version).toBe(3);
    expect(config.profile).toBe('balanced');
    expect(config.personas).toHaveLength(10);
    const personaIds = config.personas.map((p) => p.id);
    expect(personaIds).toEqual([
      'sec-lane',
      'arch-lane',
      'perf-lane',
      'qual-lane',
      'db-lane',
      'api-lane',
      'sre-lane',
      'devops-lane',
      'docs-lane',
      'finops-lane',
    ]);
  });

  it('applies 3-tier precedence hierarchy: Repo > Org > System', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
profile: assertive
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["src/security/**"]
    providers: [codex]
`;

    const orgYaml = `
version: 3
profile: chill
quorum: 2
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["src/**"]
    providers: [codex, claude]
  - id: finops-lane
    enabled: false
`;

    const client: RepositoryContentClient = {
      getFileContent: async (_owner: string, repo: string, path: string) => {
        if (repo === 'myrepo' && path === '.ct-review.yaml') return repoYaml;
        if (repo === '.github' && path === '.ct-review.yaml') return orgYaml;
        return null;
      },
    };

    const config = await resolver.resolveConfig({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'main',
      client,
    });

    // Profile from Repo (assertive) overrides Org (chill) and System (balanced)
    expect(config.profile).toBe('assertive');
    // Quorum from Org (2) overrides System (1)
    expect(config.quorum).toBe(2);

    const secLane = config.personas.find((p) => p.id === 'sec-lane');
    expect(secLane).toBeDefined();
    // Paths from Repo override Org
    expect(secLane?.paths).toEqual(['src/security/**']);
    // Providers from Repo override Org
    expect(secLane?.providers).toEqual(['codex']);

    const finopsLane = config.personas.find((p) => p.id === 'finops-lane');
    expect(finopsLane).toBeDefined();
    // Inherits enabled: false from Org
    expect(finopsLane?.enabled).toBe(false);
  });

  it('performs key-based deep merging for all 10 persona lanes', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
personas:
  - id: perf-lane
    model: gpt-5.6-sol
  - id: docs-lane
    enabled: false
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    const config = await resolver.resolveConfig({
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      ref: 'main',
      client,
    });

    expect(config.personas).toHaveLength(10);

    const perfLane = config.personas.find((p) => p.id === 'perf-lane');
    expect(perfLane?.model).toBe('gpt-5.6-sol');
    expect(perfLane?.charter).toBe('builtin:performance');

    const docsLane = config.personas.find((p) => p.id === 'docs-lane');
    expect(docsLane?.enabled).toBe(false);

    // Other lanes maintain system defaults
    const archLane = config.personas.find((p) => p.id === 'arch-lane');
    expect(archLane?.enabled).toBe(true);
    expect(archLane?.charter).toBe('builtin:constitutional-goals');
  });

  it('validates per-persona model overrides against R4_ALLOWED_MODELS', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
    model: claude-5-sonnet
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    const config = await resolver.resolveConfig({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'main',
      client,
    });

    const secLane = config.personas.find((p) => p.id === 'sec-lane');
    expect(secLane?.model).toBe('claude-5-sonnet');
    expect(R4_ALLOWED_MODELS).toContain('claude-5-sonnet');
  });

  it('rejects per-persona model overrides not in R4_ALLOWED_MODELS allowlist', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
    model: unauthorized-model-v9
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    await expect(
      resolver.resolveConfig({
        owner: 'myorg',
        repo: 'myrepo',
        ref: 'main',
        client,
      })
    ).rejects.toThrow(/is not in R4_ALLOWED_MODELS/);
  });

  it('applies global dials.persona_model to personas without explicit model', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
dials:
  persona_model: claude-5-sonnet
personas:
  - id: perf-lane
    model: gpt-5.6-sol
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    const config = await resolver.resolveConfig({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'main',
      client,
    });

    const perfLane = config.personas.find((p) => p.id === 'perf-lane');
    expect(perfLane?.model).toBe('gpt-5.6-sol'); // Explicit model takes precedence

    const secLane = config.personas.find((p) => p.id === 'sec-lane');
    expect(secLane?.model).toBe('claude-5-sonnet'); // Inherits global persona_model
  });

  it('applies systemSettingsOverride when provided to resolveConfig', async () => {
    const resolver = new ConfigResolver();
    const client = mockClient({});

    const config = await resolver.resolveConfig({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'main',
      client,
      systemSettingsOverride: {
        defaultModelOverrides: {
          codex: 'gpt-5.6-sol',
        },
      },
    });

    const codexProvider = config.reviewers.providers.find((p) => p.id === 'codex');
    expect(codexProvider?.model).toBe('gpt-5.6-sol');
  });
});
