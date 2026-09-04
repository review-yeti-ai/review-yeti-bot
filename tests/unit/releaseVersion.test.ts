import { describe, expect, it, beforeAll } from 'vitest';

// The probe tsconfig targets CommonJS, which disallows top-level await; load
// the ESM script inside beforeAll instead (vitest guarantees it completes
// before any `it` in this file runs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped .mjs script export
let validateReleaseVersion: (input: any) => any;

const MAIN_SHA = 'a'.repeat(40);
const TAG_SHA = 'b'.repeat(40);

describe('release version contract', () => {
  beforeAll(async () => {
    ({ validateReleaseVersion } = await import('../../scripts/validate-release-version.mjs'));
  });

  it('accepts a matching semver tag and package version on main', () => {
    expect(validateReleaseVersion({
      tag: 'v1.8.6',
      packageVersion: '1.8.6',
      mainSha: MAIN_SHA,
      checkedOutSha: TAG_SHA,
      taggedSha: TAG_SHA,
      tagReachableFromMain: true,
    })).toEqual({ normalizedVersion: '1.8.6', major: 1, minor: 8, patch: 6 });
  });

  it('rejects tags without the v-prefixed three-part semver shape', () => {
    expect(() => validateReleaseVersion({
      tag: '1.8.6',
      packageVersion: '1.8.6',
      mainSha: MAIN_SHA,
      checkedOutSha: TAG_SHA,
      taggedSha: TAG_SHA,
      tagReachableFromMain: true,
    })).toThrow(/vMAJOR\.MINOR\.PATCH/i);
  });

  it('rejects a package/tag version mismatch', () => {
    expect(() => validateReleaseVersion({
      tag: 'v1.8.6',
      packageVersion: '1.8.5',
      mainSha: MAIN_SHA,
      checkedOutSha: TAG_SHA,
      taggedSha: TAG_SHA,
      tagReachableFromMain: true,
    })).toThrow(/package\.json version/i);
  });

  it('rejects a tag that does not point at the checked-out commit', () => {
    expect(() => validateReleaseVersion({
      tag: 'v1.8.6',
      packageVersion: '1.8.6',
      mainSha: MAIN_SHA,
      checkedOutSha: TAG_SHA,
      taggedSha: 'c'.repeat(40),
      tagReachableFromMain: true,
    })).toThrow(/tagged commit/i);
  });

  it('rejects a tag target that is not known to be the main tip', () => {
    expect(() => validateReleaseVersion({
      tag: 'v1.8.6',
      packageVersion: '1.8.6',
      mainSha: 'd'.repeat(40),
      checkedOutSha: TAG_SHA,
      taggedSha: TAG_SHA,
      tagReachableFromMain: false,
    })).toThrow(/main/i);
  });
});
