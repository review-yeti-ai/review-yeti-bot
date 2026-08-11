import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { verifyActionCliEquivalence } = await import('../../scripts/verify-action-cli-equivalence.mjs');

describe('Action and CLI authority receipt equivalence', () => {
  it('projects identical immutable authority fields to an equivalent receipt', () => {
    const action = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/cli/action-receipt.json'), 'utf8'));
    const cli = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/cli/cli-receipt.json'), 'utf8'));
    const result = verifyActionCliEquivalence(action, cli);
    expect(result).toMatchObject({ schemaVersion: 'action-cli-equivalence-v1', equivalent: true, differences: [] });
  });
});
