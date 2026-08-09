import { describe, expect, it } from 'vitest';

const { runReviewPipeline } = require('../../src/runtime/reviewPipelineRuntime.js');

describe('review pipeline runtime boundary', () => {
  it('exports a dependency-injected runner without loading TypeScript at runtime', () => {
    expect(typeof runReviewPipeline).toBe('function');
    expect(require.resolve('../../src/runtime/reviewPipelineRuntime.js')).toContain('reviewPipelineRuntime.js');
  });
});
