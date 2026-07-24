import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { validateTicketLinkage, TicketValidationResult } from '@src/ticket/ticketValidator';
import { CtReviewConfig } from '@src/config/schema';
import { TicketProviderClient } from '@src/ticket/ticketProviderClient';

describe('Tier 1 Feature Coverage: Ticket Linkage Verification Engine', () => {
  let harness: E2ETestHarness;
  let mockTicketUrl: string;
  let client: TicketProviderClient;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier1-ticket-suite',
    });
    mockTicketUrl = `http://127.0.0.1:${harness.mockTicket.port}`;
    client = new TicketProviderClient(mockTicketUrl);
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.mockTicket.resetState();
  });

  test('1. Linear ticket linkage pattern extraction and GraphQL API query', async () => {
    const config: CtReviewConfig['ticketEnforcement'] = {
      required: true,
      providers: ['linear'],
      patterns: [],
    };

    const title = 'feat(auth): add OAuth2 token refresh flow [PROJ-123]';
    const body = 'This PR implements Linear issue PROJ-123 for authentication.';

    const result = validateTicketLinkage({ title, body, config });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('PROJ-123');

    // Query via TicketProviderClient
    const data = await client.queryLinear('PROJ-123');

    expect(data.data.issue.id).toBe('PROJ-123');
    expect(data.data.issue.title).toBe('Fix authentication token leak');
    expect(data.data.issue.state.name).toBe('In Progress');
  });

  test('2. Jira ticket linkage pattern extraction and REST v3 API query', async () => {
    const config: CtReviewConfig['ticketEnforcement'] = {
      required: true,
      providers: ['jira'],
      patterns: [],
    };

    const title = 'fix(persistence): resolve state lock bug KEY-456';
    const body = 'Fixes Jira ticket KEY-456 in diff state storage.';

    const result = validateTicketLinkage({ title, body, config });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('KEY-456');

    // Query via TicketProviderClient
    const data = await client.queryJira('KEY-456');

    expect(data.key).toBe('KEY-456');
    expect(data.fields.summary).toBe('Implement diff state persistence');
    expect(data.fields.status.name).toBe('Open');
  });

  test('3. GitHub Issue linkage pattern extraction and REST v3 API query', async () => {
    const config: CtReviewConfig['ticketEnforcement'] = {
      required: true,
      providers: ['github'],
      patterns: [],
    };

    const title = 'chore(k8s): update deployment manifests #789';
    const body = 'Resolves GitHub issue #789 for deployment updates.';

    const result = validateTicketLinkage({ title, body, config });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound.length).toBeGreaterThan(0);

    // Query via TicketProviderClient
    const data = await client.queryGithub('calltelemetry', 'ai-workspace', 789);

    expect(data.number).toBe(789);
    expect(data.title).toBe('Update Kubernetes deployment manifests');
  });

  test('4. Title & body pattern matching with custom regex patterns', () => {
    const config: CtReviewConfig['ticketEnforcement'] = {
      required: true,
      providers: ['linear', 'jira'],
      patterns: ['\\[CUSTOM-\\d+\\]', 'TASK-\\d+'],
    };

    const title = 'feat(ui): add new dashboard widget [CUSTOM-999]';
    const body = 'Also references TASK-888 for mobile views.';

    const result = validateTicketLinkage({ title, body, config });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('[CUSTOM-999]');
    expect(result.ticketsFound).toContain('TASK-888');
  });

  test('5. Ticket validation result structure - strict mode validation enforcement', () => {
    const configStrict: CtReviewConfig['ticketEnforcement'] = {
      required: true,
      providers: ['linear', 'jira', 'github'],
      patterns: [],
    };

    const invalidPrText = {
      title: 'refactor: clean up unused helper methods',
      body: 'Minor refactoring without any ticket reference in title or body.',
    };

    const resultStrict = validateTicketLinkage({
      title: invalidPrText.title,
      body: invalidPrText.body,
      config: configStrict,
    });

    expect(resultStrict.valid).toBe(false);
    expect(resultStrict.mode).toBe('strict');
    expect(resultStrict.ticketsFound).toEqual([]);
    expect(resultStrict.error).toContain('No ticket linkage found in PR title or body');

    const validPrText = {
      title: 'refactor: clean up unused helper methods [PROJ-100]',
      body: 'Resolves PROJ-100.',
    };

    const resultValid = validateTicketLinkage({
      title: validPrText.title,
      body: validPrText.body,
      config: configStrict,
    });

    expect(resultValid.valid).toBe(true);
    expect(resultValid.ticketsFound).toContain('PROJ-100');
  });

  test('6. Ticket validation result structure - advisory mode (non-blocking)', () => {
    const configAdvisory: CtReviewConfig['ticketEnforcement'] = {
      required: false,
      providers: ['linear', 'jira', 'github'],
      patterns: [],
    };

    const prWithoutTicket = {
      title: 'docs: update README with setup commands',
      body: 'No ticket reference attached.',
    };

    const result = validateTicketLinkage({
      title: prWithoutTicket.title,
      body: prWithoutTicket.body,
      config: configAdvisory,
    });

    expect(result.valid).toBe(true);
    expect(result.mode).toBe('advisory');
    expect(result.ticketsFound).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});
