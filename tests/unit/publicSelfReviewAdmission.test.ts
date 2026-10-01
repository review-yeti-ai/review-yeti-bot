import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/review-bot.yaml'), 'utf8');
type Step = { name?: string; uses?: string; with?: Record<string, string>; run?: string };
type Workflow = {
  on: { pull_request?: { types: string[] }; repository_dispatch?: { types: string[] } };
  jobs: Record<string, { name?: string; if?: string; steps: Step[] }>;
};
const workflow = yaml.load(source) as Workflow;

type Event = { name: string; action: string; draft?: boolean; state?: string };

function admitted(event: Event, candidate: Workflow = workflow): boolean {
  const selector = event.name === 'pull_request' ? candidate.on.pull_request
    : event.name === 'repository_dispatch' ? candidate.on.repository_dispatch : undefined;
  if (!selector?.types.includes(event.action)) return false;
  const guard = candidate.jobs.review.if;
  if (!guard) return true; // GitHub's default when a configured job has no if.

  // Evaluate the actual configured guard, not a duplicate admission function.
  // For these boolean/string fields the supported GitHub operators have JS
  // semantics. Whitelist the entire expression before using the isolated VM:
  // no functions, arbitrary properties, paid action, network or child process.
  const expression = guard.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/gu, '');
  const tokens = expression.match(/\s+|github\.event_name|github\.event\.pull_request\.(?:state|draft)|'(?:[^'\\]|\\.)*'|true|false|==|!=|\|\||&&|[!()]/gu) ?? [];
  if (tokens.join('') !== expression) throw new Error('Unsupported workflow guard syntax');
  return Boolean(vm.runInNewContext(expression, {
    github: { event_name: event.name, event: { pull_request: event.name === 'pull_request'
      ? { state: event.state, draft: event.draft } : undefined } },
  }, { timeout: 100 }));
}

function assertPublicTriggerSet(candidate: Workflow): void {
  expect(candidate.on.pull_request?.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review']);
}

describe('public native self-review admission', () => {
  it('admits exactly the declared public pull request trigger set', () => {
    assertPublicTriggerSet(workflow);
  });

  it.each(['opened', 'synchronize', 'reopened'])('idle draft %s does not admit the paid job', (action) => {
    expect(admitted({ name: 'pull_request', action, state: 'open', draft: true })).toBe(false);
  });

  it.each(['opened', 'synchronize', 'reopened', 'ready_for_review'])('open ready %s admits the public job', (action) => {
    expect(admitted({ name: 'pull_request', action, state: 'open', draft: false })).toBe(true);
  });

  it.each(['opened', 'synchronize', 'reopened', 'ready_for_review'])('closed PR cannot admit through %s', (action) => {
    expect(admitted({ name: 'pull_request', action, state: 'closed', draft: false })).toBe(false);
  });

  it.each(['converted_to_draft', 'closed', 'edited'])('%s is not a new paid admission event', (action) => {
    expect(admitted({ name: 'pull_request', action, state: 'open', draft: false })).toBe(false);
  });

  it('detects an unwanted edited trigger planted into the actual workflow configuration', () => {
    const planted = yaml.load(source) as Workflow;
    planted.on.pull_request?.types.push('edited');
    const event = { name: 'pull_request', action: 'edited', state: 'open', draft: false };
    expect(admitted(event, planted)).toBe(true);
    expect(() => assertPublicTriggerSet(planted)).toThrow();
    expect(() => expect(admitted(event, planted)).toBe(false)).toThrow();
  });

  it('rejects a stale ready event whose current event payload still says draft', () => {
    expect(admitted({ name: 'pull_request', action: 'ready_for_review', state: 'open', draft: true })).toBe(false);
  });

  it.each(['review-requested', 're-review-requested', 'dispatch-review'])('preserves explicit authorized %s without a PR readiness payload', (action) => {
    expect(admitted({ name: 'repository_dispatch', action })).toBe(true);
  });

  it.each([
    { name: 'repository_dispatch', action: 'unrelated-request' },
    { name: 'workflow_dispatch', action: 'review-requested' },
    { name: 'pull_request_target', action: 'ready_for_review', draft: false, state: 'open' },
  ])('unregistered event %j cannot admit a paid review', (event) => {
    expect(admitted(event)).toBe(false);
  });

  it('keeps the public native check and explicitly selects its existing local engine', () => {
    expect(workflow.jobs.review.name).toBe('Execute AI Review Pipeline');
    const panel = workflow.jobs.review.steps.filter(step => step.uses === './');
    expect(panel).toHaveLength(1);
    expect(panel[0].with?.['execution-backend']).toBe('local');
  });

  it('retires the prohibited internal caller instead of granting it public credentials', () => {
    expect(fs.existsSync(path.join(root, '.github/workflows/ct-review-bot.yml'))).toBe(false);
    const files = fs.readdirSync(path.join(root, '.github/workflows')).filter(file => /\.ya?ml$/u.test(file));
    let nativePaths = 0;
    for (const file of files) {
      const candidate = yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as Workflow;
      for (const job of Object.values(candidate.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses === './') nativePaths++;
          expect(step.run ?? '').not.toContain('repos/exampleorg/example-review-actions/dispatches');
          expect(step.with?.repositories).not.toBe('example-review-actions');
        }
      }
    }
    expect(nativePaths).toBe(1);
  });

  it('retains exact-head verdict enforcement rather than treating runner completion as approval', () => {
    const enforce = workflow.jobs.review.steps.find(step => step.name === 'Enforce Verdict');
    expect(enforce).toBeDefined();
    expect(enforce?.run).toContain('${GATE_DECISION:-}');
    expect(enforce?.run).toContain('${MERGE_ELIGIBLE:-}');
    expect(enforce?.run).toContain('${FILES_OMITTED:-0}');
    expect(enforce?.run).toContain('exit 1');
  });
});
