'use strict';

const MANIFESTS = new Set(['package.json', 'mix.exs', 'pyproject.toml', 'go.mod', 'cargo.toml', 'pom.xml']);
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'mix.lock', 'poetry.lock', 'go.sum', 'cargo.lock']);

function classifyDependencySurface(file = {}) {
  const name = String(file.path || '').split('/').pop().toLowerCase();
  if (MANIFESTS.has(name)) return 'manifest-change';
  if (LOCKFILES.has(name)) return 'lockfile-change';
  if (/^[+-].*(?:import|require\(|use\s+\w|alias\s+\w)/mu.test(String(file.patch || ''))) return 'import-contract-change';
  return null;
}

function buildDependencyRiskHints({ files = [], unitIdsByPath = {} } = {}) {
  const hints = [];
  for (const file of Array.isArray(files) ? files : []) {
    const path = String(file?.path || '').trim();
    const kind = classifyDependencySurface(file);
    if (!kind || !path || path.length > 500) continue;
    const unitValue = unitIdsByPath instanceof Map ? unitIdsByPath.get(path) : unitIdsByPath[path];
    const unitId = Array.isArray(unitValue) ? unitValue[0] : unitValue;
    hints.push({
      kind,
      path,
      ...(unitId ? { unitId: String(unitId).slice(0, 100) } : {}),
      reason: kind === 'manifest-change'
        ? 'The changed dependency manifest may alter runtime or build behavior.'
        : kind === 'lockfile-change'
          ? 'The changed lockfile may alter the resolved dependency graph.'
          : 'The changed import or module contract may depend on a dependency surface.',
    });
  }
  return hints.slice(0, 50);
}

module.exports = { classifyDependencySurface, buildDependencyRiskHints, MANIFESTS, LOCKFILES };
