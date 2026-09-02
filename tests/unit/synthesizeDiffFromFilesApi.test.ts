import { describe, expect, it } from 'vitest';
import path from 'path';

const modulePath = path.resolve(__dirname, '../../scripts/synthesize-diff-from-files-api.mjs');

describe('synthesizeDiffFromFilesApi', () => {
  it('reassembles diff --git headers around each file patch', async () => {
    const { synthesizeDiffFromFilesApi } = await import(modulePath);
    const result = synthesizeDiffFromFilesApi([
      {
        filename: 'src/foo.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ]);

    expect(result.text).toContain('diff --git a/src/foo.ts b/src/foo.ts');
    expect(result.text).toContain('--- a/src/foo.ts');
    expect(result.text).toContain('+++ b/src/foo.ts');
    expect(result.text).toContain('@@ -1 +1 @@');
    expect(result.fileCount).toBe(1);
    expect(result.omitted).toEqual([]);
  });

  it('uses /dev/null for the removed side of an added file', async () => {
    const { synthesizeDiffFromFilesApi } = await import(modulePath);
    const result = synthesizeDiffFromFilesApi([
      { filename: 'new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+new' },
    ]);
    expect(result.text).toContain('--- /dev/null');
    expect(result.text).toContain('+++ b/new.ts');
  });

  it('uses /dev/null for the added side of a removed file', async () => {
    const { synthesizeDiffFromFilesApi } = await import(modulePath);
    const result = synthesizeDiffFromFilesApi([
      { filename: 'gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-gone' },
    ]);
    expect(result.text).toContain('--- a/gone.ts');
    expect(result.text).toContain('+++ /dev/null');
  });

  it('honestly reports files GitHub omitted the patch for (binary/rename-only/oversized)', async () => {
    const { synthesizeDiffFromFilesApi } = await import(modulePath);
    const result = synthesizeDiffFromFilesApi([
      { filename: 'image.png', status: 'modified' },
      { filename: 'src/foo.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
    ]);
    expect(result.fileCount).toBe(1);
    expect(result.omitted).toEqual(['image.png']);
  });

  it('handles an empty file list', async () => {
    const { synthesizeDiffFromFilesApi } = await import(modulePath);
    const result = synthesizeDiffFromFilesApi([]);
    expect(result.text).toBe('');
    expect(result.fileCount).toBe(0);
    expect(result.omitted).toEqual([]);
  });

  it('uses the previous filename for a rename with a patch', async () => {
    const { synthesizeDiffFromFilesApi } = await import(modulePath);
    const result = synthesizeDiffFromFilesApi([
      {
        filename: 'src/new-name.ts',
        previous_filename: 'src/old-name.ts',
        status: 'renamed',
        patch: '@@ -1 +1 @@\n-a\n+b',
      },
    ]);
    expect(result.text).toContain('diff --git a/src/old-name.ts b/src/new-name.ts');
    expect(result.text).toContain('--- a/src/old-name.ts');
    expect(result.text).toContain('+++ b/src/new-name.ts');
  });
});
