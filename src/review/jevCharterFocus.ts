/**
 * The review focus Jev's lane question names for each builtin charter (REL-1126).
 *
 * Shadow-only: this text is used only in the Jev triage shadow's `lane__<persona>` noul
 * question. It never reaches the panel and never changes what is reviewed.
 *
 * Every builtin charter id that any roster can carry must have an entry here. A persona whose
 * charter is missing falls back to the generic `the "<id>" review charter` text, which Jev
 * cannot read as a review scope. The 2026-09-25 calibration found the documentation lane's
 * answers reversed for exactly that reason. `tests/unit/jevCharterFocus.test.ts` fails when a
 * `builtin:*` id appears anywhere in `src/` without an entry.
 *
 * Custom (non-builtin) charter text is repository-authored and is never forwarded to Jev.
 *
 * Each focus is written so that it completes both sentences of the question:
 * "Should the reviewer focused on <focus> review this file?" and
 * "The change could plausibly contain a problem in <focus>."
 */
export const JEV_CHARTER_FOCUS: Readonly<Record<string, string>> = Object.freeze({
  'builtin:security': 'security vulnerabilities, unsafe input handling, secrets, authentication and authorization',
  'builtin:performance': 'performance, resource usage, algorithmic complexity, and latency',
  'builtin:architecture': 'architecture, module boundaries, coupling, and design consistency',
  'builtin:consistency': 'test quality, test coverage, and consistency with existing conventions',
  'builtin:dependency-health': 'dependency changes, versions, supply chain, and license health',
  'builtin:contract': 'API and data contracts, compatibility, and interface changes',
  'builtin:policy-compliance': 'licensing and policy compliance',
  'builtin:correctness': 'logic errors and correctness bugs',
  // The documentation lane reviews documentation itself. The focus names the documentation
  // content (so an edited README or guide is in scope) as well as code whose public interface
  // could leave its docs stale, rather than asking about "risk to documentation".
  'builtin:docs': 'documentation accuracy and completeness: READMEs, guides, changelogs, API docs, docstrings and code comments, public interfaces whose documentation could become stale, and license notices',
  'builtin:docs-compliance': 'documentation accuracy and completeness: READMEs, guides, changelogs, API docs, docstrings and code comments, public interfaces whose documentation could become stale, and license notices',
  'builtin:database': 'database migrations, SQL and query safety, transactions, schema changes, and indexes',
  'builtin:devops': 'deployment and infrastructure: Kubernetes and Helm manifests, Dockerfiles, CI/CD workflows, IAM and runtime privileges',
  'builtin:finops': 'cost efficiency: cloud resource requests and limits, scaling settings, and LLM token or model spend',
  'builtin:red-team': 'adversarial failure scenarios: edge cases, race conditions, unhandled errors, and security bypasses',
  'builtin:skeptic': 'adversarial failure scenarios: edge cases, race conditions, unhandled errors, and security bypasses',
  'builtin:review-flowchart': 'control flow and component interactions that a sequence or flowchart diagram of the change should show',
  'builtin:constitutional-goals': 'repository governance: constitutional goals, system authority boundaries, auditability, and safety constraints',
});

/** The focus phrase for a persona's lane question. Custom charter text is never returned. */
export function jevCharterFocus(persona: { id: string; charter?: string }): string {
  const charter = String(persona.charter || '');
  if (Object.prototype.hasOwnProperty.call(JEV_CHARTER_FOCUS, charter)) return JEV_CHARTER_FOCUS[charter];
  return `the "${persona.id}" review charter`;
}
