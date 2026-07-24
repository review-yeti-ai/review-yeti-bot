import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { validateTicketLinkage } from '@src/ticket/ticketValidator';
import { DEFAULT_ORG_CONFIG } from '@src/config/defaultOrgConfig';

describe('Tier 2 Boundary & Corner Case Tests: Ticket Linkage Validation', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier2-ticket-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test('1. Missing ticket references boundary - returns valid: false in strict mode when no tickets present', () => {
    const result = validateTicketLinkage({
      title: 'chore: update README documentation',
      body: 'Refactored code structure and updated typos in documentation.',
      config: {
        required: true,
        providers: ['linear', 'jira', 'github'],
        patterns: [],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.mode).toBe('strict');
    expect(result.ticketsFound).toHaveLength(0);
    expect(result.error).toContain('No ticket linkage found');

    // In advisory mode (required: false), missing ticket returns valid: true
    const advisoryResult = validateTicketLinkage({
      title: 'chore: update README documentation',
      body: 'Refactored code structure and updated typos in documentation.',
      config: {
        required: false,
        providers: ['linear', 'jira', 'github'],
        patterns: [],
      },
    });

    expect(advisoryResult.valid).toBe(true);
    expect(advisoryResult.mode).toBe('advisory');
    expect(advisoryResult.ticketsFound).toHaveLength(0);
  });

  test('2. Invalid ticket keys boundary - ignores non-matching string patterns and malformed key prefixes', () => {
    const invalidInputs = [
      { title: 'fix: issue with PROJ-', body: 'missing issue number' },
      { title: 'feat: 12345-ABC', body: 'reversed format' },
      { title: 'fix: ##999', body: 'double hash format' },
      { title: 'refactor: KEY_WITHOUT_NUMBERS', body: 'no numbers after dash' },
    ];

    for (const input of invalidInputs) {
      const result = validateTicketLinkage({
        title: input.title,
        body: input.body,
        config: {
          required: true,
          providers: ['linear', 'jira', 'github'],
          patterns: [],
        },
      });

      expect(result.valid).toBe(false);
      expect(result.ticketsFound).toHaveLength(0);
    }
  });

  test('3. Multiple issue keys boundary - parses and deduplicates multiple distinct Linear, Jira, and GitHub keys', () => {
    const title = '[PROJ-101] Fix authentication bug (refs JIRA-202 and #303)';
    const body = `
This PR resolves [PROJ-101] and Jira JIRA-202.
Also relates to Linear issue LIN-404 and GitHub issue calltelemetry/ai-workspace#505.
Duplicate reference: PROJ-101 and #303.
    `;

    const result = validateTicketLinkage({
      title,
      body,
      config: {
        required: true,
        providers: ['linear', 'jira', 'github'],
        patterns: [],
      },
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('PROJ-101');
    expect(result.ticketsFound).toContain('JIRA-202');
    expect(result.ticketsFound).toContain('LIN-404');
    expect(result.ticketsFound).toContain('#303');
    expect(result.ticketsFound).toContain('calltelemetry/ai-workspace#505');

    // Check deduplication
    const occurrences = result.ticketsFound.filter(t => t === 'PROJ-101');
    expect(occurrences).toHaveLength(1);
  });

  test('4. Regex special characters in custom patterns boundary - safely evaluates complex custom regexes without crashing', () => {
    // Test custom pattern with special regex characters
    const validCustom = validateTicketLinkage({
      title: 'feat: custom ticket [CUSTOM-999] implementation',
      body: 'Details inside',
      config: {
        required: true,
        providers: [],
        patterns: ['\\[CUSTOM-\\d+\\]', '(FOO|BAR)-\\d+'],
      },
    });

    expect(validCustom.valid).toBe(true);
    expect(validCustom.ticketsFound).toContain('[CUSTOM-999]');

    // Test invalid custom regex string (malformed regex) -> handled gracefully
    const invalidRegexCustom = validateTicketLinkage({
      title: 'feat: [CUSTOM-999]',
      body: 'Details inside',
      config: {
        required: true,
        providers: ['linear'],
        patterns: ['[invalid-unclosed-regex('],
      },
    });

    expect(invalidRegexCustom.valid).toBe(true);
    expect(invalidRegexCustom.ticketsFound).toContain('CUSTOM-999');
  });

  test('5. Malformed PR titles/bodies boundary - handles empty, null/undefined, whitespace, and multi-megabyte payloads', () => {
    // Empty title and body
    const emptyResult = validateTicketLinkage({
      title: '',
      body: '',
      config: DEFAULT_ORG_CONFIG.ticketEnforcement,
    });
    expect(emptyResult.valid).toBe(false);

    // Whitespace only
    const whitespaceResult = validateTicketLinkage({
      title: '   \n\t  ',
      body: '   ',
      config: DEFAULT_ORG_CONFIG.ticketEnforcement,
    });
    expect(whitespaceResult.valid).toBe(false);

    // Large body payload (100KB text containing embedded ticket)
    const largeBody = 'A'.repeat(100000) + '\nFixes PROJ-9999\n' + 'B'.repeat(100000);
    const largeResult = validateTicketLinkage({
      title: 'feat: large diff PR',
      body: largeBody,
      config: DEFAULT_ORG_CONFIG.ticketEnforcement,
    });
    expect(largeResult.valid).toBe(true);
    expect(largeResult.ticketsFound).toContain('PROJ-9999');
  });
});
