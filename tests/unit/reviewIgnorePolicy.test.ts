import { describe, expect, it } from 'vitest';

const {
  DEFAULT_MAX_FILE_DIFF_CHARS,
  MAX_FILE_DIFF_CHARS_CAP,
  REVIEW_IGNORE_RULES,
} = require('../../src/review/reviewIgnoreCatalog');
const {
  classifyReviewFile,
  matchReviewGlob,
  measureReviewDiffChars,
  resolveMaxFileDiffChars,
} = require('../../src/review/reviewIgnorePolicy');

describe('review ignore catalog', () => {
  it('exports the shared default limits and curated rules', () => {
    expect(DEFAULT_MAX_FILE_DIFF_CHARS).toBe(5_000);
    expect(MAX_FILE_DIFF_CHARS_CAP).toBe(2_000_000);
    expect(Array.isArray(REVIEW_IGNORE_RULES)).toBe(true);
    expect(REVIEW_IGNORE_RULES.length).toBeGreaterThan(0);
  });
});

describe('classifyReviewFile', () => {
  it('skips lockfiles, snapshots, generated sources, build output, cached assets, minified assets, sourcemaps, and binaries with stable categories', () => {
    expect(classifyReviewFile({ path: 'package-lock.json' }, [])).toEqual({
      kind: 'skipped',
      category: 'lockfile',
      reason: 'Dependency lockfiles are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'Gemfile.lock' }, [])).toEqual({
      kind: 'skipped',
      category: 'lockfile',
      reason: 'Dependency lockfiles are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'mix.lock' }, [])).toEqual({
      kind: 'skipped',
      category: 'lockfile',
      reason: 'Dependency lockfiles are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'tests/__snapshots__/x.snap' }, [])).toEqual({
      kind: 'skipped',
      category: 'snapshot',
      reason: 'Test snapshots are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'src/api/client.generated.ts' }, [])).toEqual({
      kind: 'skipped',
      category: 'generated',
      reason: 'Generated files are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'src/x.pb.go' }, [])).toEqual({
      kind: 'skipped',
      category: 'generated',
      reason: 'Generated files are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'dist/app.js' }, [])).toEqual({
      kind: 'skipped',
      category: 'build_output',
      reason: 'Build output is skipped by default.',
    });
    expect(classifyReviewFile({ path: 'node_modules/x.js' }, [])).toEqual({
      kind: 'skipped',
      category: 'dependency_cache',
      reason: 'Generated dependency caches are skipped by default.',
    });
    expect(classifyReviewFile({ path: '.next/static/x.js' }, [])).toEqual({
      kind: 'skipped',
      category: 'dependency_cache',
      reason: 'Generated dependency caches are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'public/app.min.js' }, [])).toEqual({
      kind: 'skipped',
      category: 'minified',
      reason: 'Minified assets are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'public/app.js.map' }, [])).toEqual({
      kind: 'skipped',
      category: 'source_map',
      reason: 'Source maps are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'docs/spec.pdf' }, [])).toEqual({
      kind: 'skipped',
      category: 'binary',
      reason: 'Binary files are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'assets/logo.png' }, [])).toEqual({
      kind: 'skipped',
      category: 'binary',
      reason: 'Binary files are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'src/app.ts', patch: 'Binary files a/src/app.ts and b/src/app.ts differ' }, [])).toEqual({
      kind: 'skipped',
      category: 'binary',
      reason: 'Binary files are skipped by default.',
    });
  });

  it('restores the established lockfile defaults at any repository depth', () => {
    for (const path of [
      'Cargo.lock',
      'packages/rust/Cargo.lock',
      'go.sum',
      'services/api/go.sum',
      'poetry.lock',
      'packages/python/poetry.lock',
      'Pipfile.lock',
      'services/web/Pipfile.lock',
      'composer.lock',
      'packages/php/composer.lock',
      'npm-shrinkwrap.json',
      'packages/web/npm-shrinkwrap.json',
      'bun.lockb',
      'packages/bun/bun.lockb',
      'packages.lock.json',
      'packages/web/packages.lock.json',
    ]) {
      expect(classifyReviewFile({ path }, [])).toEqual({
        kind: 'skipped',
        category: 'lockfile',
        reason: 'Dependency lockfiles are skipped by default.',
      });
    }
  });

  it('skips nested build and dependency caches without broadening source, bin, or vendor paths', () => {
    expect(classifyReviewFile({ path: 'packages/ui/dist/app.js' }, [])).toEqual({
      kind: 'skipped',
      category: 'build_output',
      reason: 'Build output is skipped by default.',
    });
    expect(classifyReviewFile({ path: 'packages/web/node_modules/pkg/index.js' }, [])).toEqual({
      kind: 'skipped',
      category: 'dependency_cache',
      reason: 'Generated dependency caches are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'packages/ui/src/app.ts' }, [])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'packages/ui/bin/deploy.sh' }, [])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'packages/ui/vendor/library.js' }, [])).toEqual({ kind: 'included' });
  });

  it('restores nested catalog matches with negated patterns regardless of list order', () => {
    expect(classifyReviewFile({ path: 'packages/ui/dist/app.js' }, ['!packages/ui/dist/app.js'])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'packages/ui/dist/app.js' }, ['!packages/ui/dist/app.js', '**/dist/**'])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'packages/ui/dist/app.js' }, ['**/dist/**', '!packages/ui/dist/app.js'])).toEqual({ kind: 'included' });
  });

  it('keeps ordinary source, hand-written bin scripts, generated-token checks, and hand-written SVGs included by default', () => {
    expect(classifyReviewFile({ path: 'src/app.ts' }, [])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'src/security/generated-token-check.ts' }, [])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'bin/deploy.sh' }, [])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'assets/logo.svg', patch: '<svg><!-- hand written --></svg>' }, [])).toEqual({ kind: 'included' });
  });

  it('skips generated OpenAPI artifacts while keeping ordinary OpenAPI source files included', () => {
    expect(classifyReviewFile({ path: 'openapi.generated.json' }, [])).toEqual({
      kind: 'skipped',
      category: 'generated',
      reason: 'Generated files are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'schema.generated.yaml' }, [])).toEqual({
      kind: 'skipped',
      category: 'generated',
      reason: 'Generated files are skipped by default.',
    });
    expect(classifyReviewFile({ path: 'openapi.yaml' }, [])).toEqual({ kind: 'included' });
  });

  it('restores a built-in match with a negated pattern regardless of list order', () => {
    expect(classifyReviewFile({ path: 'src/keep.generated.ts' }, ['!src/keep.generated.ts'])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'src/keep.generated.ts' }, ['!src/keep.generated.ts', '**/*.generated.ts'])).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'src/keep.generated.ts' }, ['**/*.generated.ts', '!src/keep.generated.ts'])).toEqual({ kind: 'included' });
  });

  it('excludes a complete per-file diff only above the inclusive 5000-char boundary', () => {
    expect(classifyReviewFile({ path: 'src/app.ts', patch: 'x'.repeat(5_000) }, [], 5_000)).toEqual({ kind: 'included' });
    expect(classifyReviewFile({ path: 'src/app.ts', patch: 'x'.repeat(5_001) }, [], 5_000)).toEqual({
      kind: 'oversized',
      category: 'oversized',
      reason: 'File diff exceeds the per-file review limit.',
      diffChars: 5_001,
    });
  });
});

describe('matchReviewGlob', () => {
  it('matches filename-only patterns at any depth and ignores case', () => {
    expect(matchReviewGlob('package-lock.json', 'package-lock.json')).toBe(true);
    expect(matchReviewGlob('package-lock.json', 'src/web/PACKAGE-LOCK.JSON')).toBe(true);
  });

  it('respects path separators for slash-bearing path patterns', () => {
    expect(matchReviewGlob('src/generated/*.ts', 'src/generated/file.ts')).toBe(true);
    expect(matchReviewGlob('src/generated/*.ts', 'src/generated/nested/file.ts')).toBe(false);
  });

  it('matches *, **, and ? path segments', () => {
    expect(matchReviewGlob('src/**/client?.ts', 'src/api/internal/client1.ts')).toBe(true);
    expect(matchReviewGlob('src/**/client?.ts', 'src/api/internal/client10.ts')).toBe(false);
  });
});

describe('measureReviewDiffChars', () => {
  it('measures patch content first and falls back to file content when patch is absent', () => {
    expect(measureReviewDiffChars({ path: 'src/app.ts', patch: 'abcd', content: 'xyz' })).toBe(4);
    expect(measureReviewDiffChars({ path: 'src/app.ts', content: 'xyz' })).toBe(3);
    expect(measureReviewDiffChars({ path: 'src/app.ts' })).toBe(0);
  });
});

describe('resolveMaxFileDiffChars', () => {
  it('uses the MAX_FILE_DIFF_CHARS environment override when it is non-empty', () => {
    expect(resolveMaxFileDiffChars({
      parsed: { limits: { max_file_diff_chars: 7_000 } },
      env: { MAX_FILE_DIFF_CHARS: '6000' },
    })).toBe(6_000);
  });

  it('falls back to YAML and then the default when the action override is empty or unset', () => {
    expect(resolveMaxFileDiffChars({
      parsed: { limits: { max_file_diff_chars: 7_000 } },
      env: { MAX_FILE_DIFF_CHARS: '' },
    })).toBe(7_000);
    expect(resolveMaxFileDiffChars({
      parsed: {},
      env: {},
    })).toBe(5_000);
    expect(resolveMaxFileDiffChars({
      env: {},
    })).toBe(5_000);
  });

  it('rejects decimal, negative, zero, and nonnumeric values with descriptive validation errors', () => {
    expect(() => resolveMaxFileDiffChars({ env: { MAX_FILE_DIFF_CHARS: '12.5' } })).toThrow('MAX_FILE_DIFF_CHARS must be a positive integer.');
    expect(() => resolveMaxFileDiffChars({ env: { MAX_FILE_DIFF_CHARS: '-1' } })).toThrow('MAX_FILE_DIFF_CHARS must be a positive integer.');
    expect(() => resolveMaxFileDiffChars({ env: { MAX_FILE_DIFF_CHARS: '0' } })).toThrow('MAX_FILE_DIFF_CHARS must be a positive integer.');
    expect(() => resolveMaxFileDiffChars({ env: { MAX_FILE_DIFF_CHARS: 'abc' } })).toThrow('MAX_FILE_DIFF_CHARS must be a positive integer.');
  });

  it('rejects zero values with leading zeroes instead of coercing them to the default', () => {
    expect(() => resolveMaxFileDiffChars({ env: { MAX_FILE_DIFF_CHARS: '00' } })).toThrow('MAX_FILE_DIFF_CHARS must be a positive integer.');
  });

  it('rejects an environment override above the hard cap before any model call', () => {
    expect(() => resolveMaxFileDiffChars({
      parsed: { limits: { max_file_diff_chars: 7_000 } },
      env: { MAX_FILE_DIFF_CHARS: String(MAX_FILE_DIFF_CHARS_CAP + 1) },
    })).toThrow(`MAX_FILE_DIFF_CHARS must be less than or equal to ${MAX_FILE_DIFF_CHARS_CAP}.`);
  });

  it('rejects a YAML value above the hard cap when no environment override is provided', () => {
    expect(() => resolveMaxFileDiffChars({
      parsed: { limits: { max_file_diff_chars: MAX_FILE_DIFF_CHARS_CAP + 1 } },
      env: {},
    })).toThrow(`limits.max_file_diff_chars must be less than or equal to ${MAX_FILE_DIFF_CHARS_CAP}.`);
  });
});
