'use strict';

const { sha256 } = require('../review/reviewCore');

const REVIEW_WORKFLOW_SCHEMA_VERSION = 'review-yeti-pi-workflow.v1';

// This is executable policy owned by the pinned Review Yeti package/Action source. It is
// deliberately closed over no host values: all review data arrives through validated args.
const TRUSTED_REVIEW_WORKFLOW_SOURCE = `export const meta = {
  name: "review-yeti",
  description: "Run the deterministic Review Yeti persona panel",
  phases: [{ title: "Review" }],
}

phase("Review")
const results = await parallel(
  args.assignments.map((assignment) => () => agent(
    assignment.assignmentPrompt,
    {
      label: assignment.assignmentId,
      schema: assignment.personaResultSchema,
      timeoutMs: args.deadlineMs,
    },
  )),
)
return results
`;

const TRUSTED_REVIEW_WORKFLOW_DIGEST = sha256(TRUSTED_REVIEW_WORKFLOW_SOURCE);

function trustedReviewWorkflowScript() {
  return Object.freeze({
    source: TRUSTED_REVIEW_WORKFLOW_SOURCE,
    digest: TRUSTED_REVIEW_WORKFLOW_DIGEST,
  });
}

module.exports = {
  REVIEW_WORKFLOW_SCHEMA_VERSION,
  trustedReviewWorkflowScript,
};
