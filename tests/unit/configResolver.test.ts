import { describe, it, expect, vi } from 'vitest';
import { ConfigResolver, RepositoryContentClient } from '../../src/config/configResolver';
import { ConfigValidationError } from '../../src/config/configLoader';

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
    expect(config.personas.length).toBeGreaterThanOrEqual(4);
    const personaIds = config.personas.map((p) => p.id);
    expect(personaIds).toContain('sec-lane');
    expect(personaIds).toContain('arch-lane');
    expect(personaIds).toContain('qual-lane');
    expect(personaIds).toContain('devops-lane');
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
    providers: [claude]
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
    providers: [claude, synthetic]
  - id: devops-lane
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
    expect(secLane?.providers).toEqual(['claude']);

    const devopsLane = config.personas.find((p) => p.id === 'devops-lane');
    expect(devopsLane).toBeDefined();
    // Inherits enabled: false from Org
    expect(devopsLane?.enabled).toBe(false);
  });

  it('performs key-based deep merging for default persona lanes', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
personas:
  - id: qual-lane
    model: gpt-5.6-sol
  - id: devops-lane
    enabled: false
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    const config = await resolver.resolveConfig({
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      ref: 'main',
      client,
    });

    expect(config.personas.length).toBeGreaterThanOrEqual(4);

    const qualLane = config.personas.find((p) => p.id === 'qual-lane');
    expect(qualLane?.model).toBe('gpt-5.6-sol');
    expect(qualLane?.charter).toBe('builtin:consistency');

    const devopsLane = config.personas.find((p) => p.id === 'devops-lane');
    expect(devopsLane?.enabled).toBe(false);

    // Other lanes maintain system defaults
    const archLane = config.personas.find((p) => p.id === 'arch-lane');
    expect(archLane?.enabled).toBe(true);
    expect(archLane?.charter).toBe('builtin:constitutional-goals');
  });

  it('accepts any valid model string (open provider system)', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [claude]
    model: some-custom/model-v99
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    const config = await resolver.resolveConfig({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'main',
      client,
    });

    const secLane = config.personas.find((p) => p.id === 'sec-lane');
    expect(secLane?.model).toBe('some-custom/model-v99');
  });

  it('accepts custom provider IDs (any OmniRoute-supported provider)', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 180
  providers:
    - id: my-custom-provider
      enabled: true
      model: custom/my-model-v1
      effort: low
      review_timeout_s: 60
      arbiter_timeout_s: 45
  arbiter:
    order: [my-custom-provider]
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [my-custom-provider]
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    const config = await resolver.resolveConfig({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'main',
      client,
    });

    const customProvider = config.reviewers.providers.find((p) => p.id === 'my-custom-provider');
    expect(customProvider).toBeDefined();
    expect(customProvider?.model).toBe('custom/my-model-v1');
  });

  it('applies global dials.persona_model to personas without explicit model', async () => {
    const resolver = new ConfigResolver();
    const repoYaml = `
version: 3
dials:
  persona_model: claude-5-sonnet
personas:
  - id: qual-lane
    model: gpt-5.6-sol
`;

    const client = mockClient({ '.ct-review.yaml': repoYaml });

    const config = await resolver.resolveConfig({
      owner: 'myorg',
      repo: 'myrepo',
      ref: 'main',
      client,
    });

    const qualLane = config.personas.find((p) => p.id === 'qual-lane');
    expect(qualLane?.model).toBe('gpt-5.6-sol'); // Explicit model takes precedence

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
          claude: 'gpt-5.6-sol',
        },
      },
    });

    const claudeProvider = config.reviewers.providers.find((p) => p.id === 'claude');
    expect(claudeProvider?.model).toBe('gpt-5.6-sol');
  });
});
