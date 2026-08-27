import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('direct Review Bot workflow budget', () => {
  it('keeps pull-request and repository-dispatch execution below fifteen minutes', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows/review-bot.yaml'),
      'utf8',
    );
    expect(workflow).toMatch(/\n    timeout-minutes: 15\n/u);
    expect(workflow).not.toMatch(/\n    timeout-minutes: (?:1[6-9]|[2-9]\d|\d{3,})\n/u);
  });
});
