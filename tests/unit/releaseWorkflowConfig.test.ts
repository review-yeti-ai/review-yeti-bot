import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/release-please.yml');
const configPath = path.join(root, 'release-please-config.json');
const manifestPath = path.join(root, '.release-please-manifest.json');

describe('Release Please configuration', () => {
  it('runs on main pushes with write permissions needed for a reviewed release PR', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toMatch(/on:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- main/u);
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN');
    expect(workflow).toMatch(/googleapis\/release-please-action@[0-9a-f]{40}/u);
    expect(workflow).toContain('target-branch: main');
  });

  it('uses the Node strategy and keeps a valid release manifest', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    expect(config.packages['.']).toMatchObject({
      'release-type': 'node',
      'package-name': 'ct-review-bot',
    });
    expect(manifest).toHaveProperty('.', expect.stringMatching(/^\d+\.\d+\.\d+$/u));
    // The first migration starts from the historical v1.8.5 tag. Thereafter
    // Release Please advances the manifest with package.json on each release PR.
    expect(manifest['.'] === '1.8.5' || manifest['.'] === packageVersion).toBe(true);
  });
});
