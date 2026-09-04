import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// REL-559: the release-contract lane. These tests pack, install and attest the published action
// end to end against the real npm registry. They are the gate in front of publishing and in front
// of moving the rolling v1 consumer channel -- not a per-pull-request check. The base config's
// `include` deliberately does not list `tests/release/**`, so this config is the only way to run
// them and `npm test` can never pick them up by accident.
//
// Spread rather than `mergeConfig`: mergeConfig CONCATENATES array options, so merging an
// `include` onto the base appends to it and the lane silently runs the entire suite (369 files
// instead of 2). `include` here must replace the base's, not extend it.
const base = baseConfig as ReturnType<typeof defineConfig>;

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/release/**/*.test.ts'],
    // Packing and installing a ~41 MB tarball is minutes of work, not seconds.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    coverage: {
      // The lane proves a packaging contract, not line coverage of the product.
      ...(base.test?.coverage ?? {}),
      enabled: false,
    },
  },
});
