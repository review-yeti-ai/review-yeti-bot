#!/usr/bin/env node

if (process.env.REVIEW_YETI_LIVE_SMOKE !== '1') {
  console.log(JSON.stringify({ status: 'not_run', reason: 'REVIEW_YETI_LIVE_SMOKE=1 is required; no live evidence claimed' }));
  process.exit(0);
}
console.error('Live smoke orchestration is intentionally external to the deterministic evaluator; no live evidence was produced.');
process.exit(2);
