import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAndValidateConfig } from '../../src/config/configLoader';

const fixture = (name: string) => fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'ct-meta',
  name,
), 'utf8');

describe('ct-meta canonical fixture conformance', () => {
  it('accepts the canonical v3 fixture unchanged', () => {
    expect(parseAndValidateConfig(fixture('panel-v3-valid.yaml')).version).toBe(3);
  });

  it('rejects the canonical silent-substitution fixture before execution', () => {
    expect(() => parseAndValidateConfig(fixture('panel-v3-invalid-substitution.yaml')))
      .toThrow(/exact allowlisted model/i);
  });
});
