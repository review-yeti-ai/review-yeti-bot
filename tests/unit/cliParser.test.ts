import { describe, expect, it } from 'vitest';
import { parseCLIArgs, runCLI, generateHelpText } from '../../src/analytics/cliParser';

describe('cliParser Unit Tests', () => {
  it('parseCLIArgs correctly parses commands and flags', () => {
    const args = [
      'stats',
      '--owner',
      'cisco-cdr',
      '--repo',
      'ct-review-bot',
      '--pr',
      '42',
      '--verdict',
      'SHIP',
      '--min-turns',
      '2',
      '--max-turns',
      '5',
      '--query',
      'analytics',
      '--format',
      'json',
      '--out',
      'output.json',
      '--dir',
      'custom-sessions',
    ];

    const parsed = parseCLIArgs(args);

    expect(parsed.command).toBe('stats');
    expect(parsed.options.owner).toBe('cisco-cdr');
    expect(parsed.options.repo).toBe('ct-review-bot');
    expect(parsed.options.prNumber).toBe(42);
    expect(parsed.options.verdict).toBe('SHIP');
    expect(parsed.options.minTurns).toBe(2);
    expect(parsed.options.maxTurns).toBe(5);
    expect(parsed.options.query).toBe('analytics');
    expect(parsed.formatterOptions.format).toBe('json');
    expect(parsed.formatterOptions.out).toBe('output.json');
    expect(parsed.baseDir).toBe('custom-sessions');
  });

  it('parseCLIArgs handles positional target ID for inspect and search', () => {
    const inspectParsed = parseCLIArgs(['inspect', 'owner/repo#99']);
    expect(inspectParsed.command).toBe('inspect');
    expect(inspectParsed.targetId).toBe('owner/repo#99');

    const searchParsed = parseCLIArgs(['search', 'refactor']);
    expect(searchParsed.command).toBe('search');
    expect(searchParsed.options.query).toBe('refactor');
  });

  it('runCLI returns help text when --help flag is provided', () => {
    const res = runCLI(['--help']);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('Session Analytics CLI Tool');
  });

  it('runCLI executes stats command and formats output', () => {
    const res = runCLI(['stats', '--format', 'json']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.output)).toHaveProperty('kpis');
  });

  it('runCLI returns exit code 1 for inspect without session ID', () => {
    const res = runCLI(['inspect']);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('Error');
  });
});
