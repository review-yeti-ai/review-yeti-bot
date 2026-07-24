import { describe, it, expect } from 'vitest';
import { validateTicketLinkage } from '../../src/ticket/ticketValidator';

describe('Ticket Linkage Engine', () => {
  const baseConfig = {
    required: true,
    providers: ['linear', 'jira', 'github'] as ('linear' | 'jira' | 'github')[],
    patterns: [],
  };

  it('detects Linear tickets formatted as [PROJ-123] and PROJ-123', () => {
    const result = validateTicketLinkage({
      title: 'feat(auth): implement SSO login [PROJ-123]',
      body: 'Related work done in PROJ-456 and [PROJ-123].',
      config: baseConfig,
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('PROJ-123');
    expect(result.ticketsFound).toContain('PROJ-456');
    expect(result.mode).toBe('strict');
  });

  it('detects Jira tickets formatted as [KEY-456] and KEY-456', () => {
    const result = validateTicketLinkage({
      title: 'fix(db): resolve connection pool leak KEY-456',
      body: 'Fixes issue described in [JIRA-890].',
      config: baseConfig,
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('KEY-456');
    expect(result.ticketsFound).toContain('JIRA-890');
  });

  it('detects GitHub issue references #789 and owner/repo#101', () => {
    const result = validateTicketLinkage({
      title: 'fix: handle null pointer #789',
      body: 'Closes acme/repo#101 and GH-202.',
      config: baseConfig,
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('#789');
    expect(result.ticketsFound).toContain('acme/repo#101');
    expect(result.ticketsFound).toContain('GH-202');
  });

  it('fails validation in strict mode when no ticket reference is found', () => {
    const result = validateTicketLinkage({
      title: 'refactor: clean up logging code',
      body: 'No ticket reference here',
      config: { ...baseConfig, required: true },
    });

    expect(result.valid).toBe(false);
    expect(result.ticketsFound).toEqual([]);
    expect(result.error).toContain('No ticket linkage found');
    expect(result.mode).toBe('strict');
  });

  it('passes validation in advisory mode even when no ticket is found', () => {
    const result = validateTicketLinkage({
      title: 'docs: update README badge',
      body: 'Minor documentation update',
      config: { ...baseConfig, required: false },
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toEqual([]);
    expect(result.mode).toBe('advisory');
  });

  it('deduplicates identical ticket references across title and body', () => {
    const result = validateTicketLinkage({
      title: '[PROJ-100] Add feature',
      body: 'Resolves PROJ-100 and [PROJ-100].',
      config: baseConfig,
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toEqual(['PROJ-100']);
  });

  it('supports custom regex patterns provided in config', () => {
    const result = validateTicketLinkage({
      title: 'feat: add metrics support (CUSTOM-999)',
      body: 'Refers to CUSTOM-999',
      config: {
        ...baseConfig,
        patterns: ['CUSTOM-\\d+'],
      },
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('CUSTOM-999');
  });

  it('detects lowercase ticket keys and converts to uppercase', () => {
    const result = validateTicketLinkage({
      title: 'feat: lowercase proj-123 and key-456',
      body: 'See also [myproj-789]',
      config: baseConfig,
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('PROJ-123');
    expect(result.ticketsFound).toContain('KEY-456');
    expect(result.ticketsFound).toContain('MYPROJ-789');
  });

  it('detects GitHub issue references enclosed in parentheses, brackets, or after colons', () => {
    const result = validateTicketLinkage({
      title: 'fix: (#789) and [acme/repo#101] and fix: #202',
      body: 'Ref: GH-303',
      config: baseConfig,
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('#789');
    expect(result.ticketsFound).toContain('acme/repo#101');
    expect(result.ticketsFound).toContain('#202');
    expect(result.ticketsFound).toContain('GH-303');
  });

  it('supports ticket project prefixes longer than 10 characters', () => {
    const result = validateTicketLinkage({
      title: 'feat: VERYLONGPROJECTNAME-12345 update',
      body: 'RefERS to [another_very_long_project_prefix-999]',
      config: baseConfig,
    });

    expect(result.valid).toBe(true);
    expect(result.ticketsFound).toContain('VERYLONGPROJECTNAME-12345');
    expect(result.ticketsFound).toContain('ANOTHER_VERY_LONG_PROJECT_PREFIX-999');
  });
});
