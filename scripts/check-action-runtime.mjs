#!/usr/bin/env node
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listMemoryProviderIds } = require('../src/memory/providers/index.js');
const pipeline = require('../.github/workflows/pipelines/review-pipeline.js');
const loadedTypescript = Object.keys(require.cache).some((filePath) => /\.(ts|tsx)$/u.test(filePath));
if (loadedTypescript) throw new Error('Action runtime loaded a TypeScript module');
const cliLoaded = Object.keys(require.cache).some((filePath) => /[\\/]src[\\/]cli[\\/]/u.test(filePath));
if (cliLoaded) throw new Error('Action runtime loaded local CLI code');

const receipt = {
  node: process.version,
  providers: ['honcho', ...listMemoryProviderIds()],
  pipelineExports: ['runReviewPipeline', 'resolveActionReviewPolicy', 'resolveTrustedReviewPolicy', 'createReviewMemoryRouter'].every((key) => typeof pipeline[key] === 'function'),
  loadedTypescript,
  cliLoaded,
};
if (!receipt.pipelineExports || receipt.providers.length !== 5) throw new Error('Action runtime registry contract failed');
console.log(JSON.stringify(receipt));
