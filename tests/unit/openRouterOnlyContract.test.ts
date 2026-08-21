import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CommandDispatcher } from '../../src/chat/commandDispatcher';

describe('OpenRouter-only model boundary', () => {
  it('does not execute a deprecated OmniRoute-only chat alias', async () => {
    const deprecated = { complete: vi.fn() };
    const dispatcher = new CommandDispatcher('openrouter/auto');
    const result = await dispatcher.dispatchCommand('@ct-review ask Is this safe?', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      github: { getChangedFiles: async () => [], postIssueComment: async () => {} } as any,
      omniRoute: deprecated,
    });

    expect(result.success).toBe(true);
    expect(deprecated.complete).not.toHaveBeenCalled();
    expect(result.output).toContain('Answer to question');
  });

  it('keeps the Action endpoint and default model OpenRouter-only', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/pipelines/review-pipeline.js'), 'utf8');
    expect(source).toContain("https://openrouter.ai/api/v1");
    expect(source).toContain("'openrouter/auto'");
    expect(source).not.toContain('OMNIROUTE_API_KEY');
  });
});
