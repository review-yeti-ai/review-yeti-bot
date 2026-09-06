import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

/**
 * Every tracked file under k8s/, at any depth and whatever it is named.
 *
 * No path or extension filter, deliberately. Both narrowings are the same
 * fail-open shape: a non-recursive pathspec hides a nested manifest, and an
 * extension allowlist hides a JSON manifest (Kubernetes accepts those) or one
 * saved under an unusual name. An unaudited grant is indistinguishable from no
 * grant, so the audit set is defined by "tracked under k8s/" and nothing else.
 *
 * Everything here is a manifest today. If a non-manifest ever lands, `documents()`
 * raises rather than skipping, and whoever adds it decides explicitly.
 */
function trackedManifests(): string[] {
  return execFileSync('git', ['ls-files', 'k8s/'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * Render a template's placeholders so it parses as YAML.
 *
 * Deliberately has no fallback. An earlier version returned [] for anything it
 * could not parse and for anything containing `{{`, which is an evasion hole in a
 * security guard: a manifest widening `prreviewjobs: create` that also carried a
 * syntax error or a stray Go-template snippet would be dropped from the audit and
 * the assertion would pass with fewer subjects scanned. A guard must fail when it
 * cannot evaluate its input, not treat unevaluable input as clean.
 */
function documents(relativePath: string): Array<Record<string, any>> {
  const source = readFileSync(path.join(root, relativePath), 'utf8')
    .replace(/\$\{[A-Z_]+(:-[^}]*)?\}/gu, 'placeholder');
  if (source.includes('{{')) {
    throw new Error(
      `${relativePath} contains Go-template syntax and cannot be audited as YAML. `
      + 'Helm templates belong in charts/, which is audited separately by rendering. '
      + 'If this file must live here, extend this guard deliberately rather than skipping it.',
    );
  }
  return (yaml.loadAll(source) as Array<Record<string, any>>).filter(Boolean);
}

/**
 * A rule grants create on PRReviewJob if it names the resource *or wildcards it*.
 * `resources: ['*'], verbs: ['*']` is a materially equivalent grant, and matching
 * only the literal resource name would let that form walk straight past the pin --
 * the same evasion class `documents()` refuses elsewhere.
 */
function grantsCreate(rule: Record<string, any>): boolean {
  const resources: string[] = rule.resources || [];
  const verbs: string[] = rule.verbs || [];
  const apiGroups: string[] = rule.apiGroups || [];
  const groupMatches = apiGroups.includes('review-yeti.ai') || apiGroups.includes('*');
  const resourceMatches = resources.includes('prreviewjobs') || resources.includes('*');
  const verbMatches = verbs.includes('create') || verbs.includes('*');
  return groupMatches && resourceMatches && verbMatches;
}

function createSubjectsFor(docs: Array<Record<string, any>>): string[] {
  const rolesGrantingCreate = new Set<string>();
  for (const doc of docs) {
    if (doc?.kind !== 'Role' && doc?.kind !== 'ClusterRole') continue;
    if ((doc.rules || []).some(grantsCreate)) rolesGrantingCreate.add(String(doc.metadata?.name));
  }
  const subjects = new Set<string>();
  for (const doc of docs) {
    if (doc?.kind !== 'RoleBinding' && doc?.kind !== 'ClusterRoleBinding') continue;
    if (!rolesGrantingCreate.has(String(doc.roleRef?.name))) continue;
    // Deduplicated: binding the same account twice is a valid configuration and
    // must not read as two creators.
    for (const subject of doc.subjects || []) subjects.add(String(subject.name));
  }
  return [...subjects].sort();
}

/**
 * REL-586 / the P1 raised on #538.
 *
 * The operator performs no authorisation check of its own: it reads
 * `Spec.PublicationMode` off the PRReviewJob and, for `app-gate`, builds a worker
 * that receives a `checks: write` token. That is only safe because the CR is not a
 * user-writable surface — exactly one service account may create one, and the value
 * it writes traces back through Postgres to an OIDC-validated admission gated by
 * `allowAppGate`.
 *
 * That control was defended by RBAC and asserted nowhere, so widening
 * `prreviewjobs: create` would silently turn publication mode into an
 * attacker-chosen input. This pins it.
 */
describe('PRReviewJob create authority (REL-586)', () => {
  const manifests = trackedManifests();

  it('is granted by exactly one subject across every tracked manifest', () => {
    // Resolved across the WHOLE tree at once, not per file. RBAC binds a
    // RoleBinding to a Role by name, and the two need not share a file -- so a
    // per-file scan never connects them and a grant split across two files evades
    // the check completely. That is the same fail-open class as skipping an
    // unparseable file, just expressed structurally.
    const subjects = createSubjectsFor(manifests.flatMap(documents));
    expect(subjects).toEqual(['ct-review-job-dispatcher']);
  });

  it('is never granted to the operator, which only reconciles existing reviews', () => {
    // The operator trusts the CR's publication mode. If it could also create one it
    // would be able to select its own lane, collapsing the separation entirely.
    // Resolved tree-wide so a Role here bound from elsewhere still counts.
    expect(createSubjectsFor(manifests.flatMap(documents)))
      .not.toContain('ct-review-yeti-operator');
  });

  it('is never granted cluster-wide, by name or by wildcard', () => {
    // A ClusterRole would extend the authority past ct-review-system. Wildcards
    // count: resources: ['*'] reaches prreviewjobs just as surely as naming it.
    for (const file of manifests) {
      for (const doc of documents(file)) {
        if (doc?.kind !== 'ClusterRole') continue;
        for (const rule of doc.rules || []) {
          expect(grantsCreate(rule), `${file} ClusterRole ${doc.metadata?.name} grants create`).toBe(false);
        }
      }
    }
  });

  it('is not granted by the Helm chart either', () => {
    // The chart renders the operator's RBAC; it must not add a second creator.
    const rendered = execFileSync('helm', ['template', 'rv', path.join(root, 'charts/review-yeti')], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const docs = (yaml.loadAll(rendered) as Array<Record<string, any>>).filter(Boolean);
    expect(createSubjectsFor(docs)).toEqual([]);
  });
});
