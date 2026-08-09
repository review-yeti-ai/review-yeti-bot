import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

describe('review workflow artifact wiring', () => {
  it('uploads session/outbox artifacts with bounded retention and exposes the output path', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/review-bot.yaml'), 'utf8');
    const action = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('sessions/');
    expect(workflow).toContain('retention-days: 14');
    expect(action).toContain('memory-outbox-path:');
    expect(action).toContain('memory-query-status:');
  });
});
