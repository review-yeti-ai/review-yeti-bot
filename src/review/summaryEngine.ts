import { PersonaFinding } from '../github/commentPublisher';

export interface ModuleChangeset {
  module: string;
  files: string[];
  summary: string;
}

export function parseDiffModules(diff: string): Map<string, { files: string[]; additions: number; deletions: number }> {
  const moduleMap = new Map<string, { files: string[]; additions: number; deletions: number }>();
  if (!diff || typeof diff !== 'string') return moduleMap;

  // Match diff --git a/... b/... or --- a/... +++ b/...
  const fileHeaderMatches = Array.from(
    diff.matchAll(/diff --git a\/(.*?) b\/(.*?)|(?:--- a\/(.*?)\n\+\+\+ b\/(.*?))(?=\n|$)/g)
  );

  const filePaths = new Set<string>();
  for (const match of fileHeaderMatches) {
    const path = match[2] || match[1] || match[4] || match[3];
    if (path && path !== '/dev/null') {
      filePaths.add(path);
    }
  }

  // Fallback: search for path patterns in diff lines
  if (filePaths.size === 0) {
    const lines = diff.split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/(?:^|\s)([a-zA-Z0-9_\-\./]+\.[a-zA-Z0-9]+)/);
      if (lineMatch && !lineMatch[1].startsWith('http') && lineMatch[1].includes('/')) {
        filePaths.add(lineMatch[1]);
      }
    }
  }

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    const moduleName = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : 'root';

    if (!moduleMap.has(moduleName)) {
      moduleMap.set(moduleName, { files: [], additions: 0, deletions: 0 });
    }
    const entry = moduleMap.get(moduleName)!;
    if (!entry.files.includes(filePath)) {
      entry.files.push(filePath);
    }
  }

  return moduleMap;
}

/**
 * Generates CodeRabbit-grade PR summary containing Executive Overview, Walkthrough, and Changesets.
 */
export function generatePRSummary(
  diff: string,
  findings: PersonaFinding[] = [],
  _repoConfig?: any,
): string {
  const moduleMap = parseDiffModules(diff);
  const totalFiles = Array.from(moduleMap.values()).reduce((sum, m) => sum + m.files.length, 0);
  const totalModules = moduleMap.size;

  // Executive Overview
  let overview = '';
  if (totalFiles === 0) {
    overview = 'This pull request includes updates to repository configurations and metadata. ';
    if (findings.length > 0) {
      overview += `Automated review detected ${findings.length} finding(s) requiring attention.`;
    } else {
      overview += 'All persona checks passed with zero findings detected.';
    }
  } else {
    overview = `This pull request introduces changes across ${totalFiles} file(s) in ${totalModules} module(s). `;
    if (findings.length > 0) {
      const criticalCount = findings.filter(
        (f) => String(f.severity).toLowerCase() === 'critical' || String(f.severity) === 'P0'
      ).length;
      const majorCount = findings.filter(
        (f) => String(f.severity).toLowerCase() === 'major' || String(f.severity) === 'P1'
      ).length;
      overview += `Automated review detected ${findings.length} finding(s) (${criticalCount} critical, ${majorCount} major) requiring attention.`;
    } else {
      overview += 'All persona checks passed with zero findings detected.';
    }
  }

  // Walkthrough
  const walkthroughBullets: string[] = [];
  if (moduleMap.size === 0) {
    walkthroughBullets.push('- Update core components and system configuration.');
  } else {
    for (const [moduleName, entry] of moduleMap.entries()) {
      const fileList = entry.files.map((f) => f.split('/').pop()).join(', ');
      walkthroughBullets.push(`- **${moduleName}**: Updated ${entry.files.length} file(s) (\`${fileList}\`).`);
    }
  }

  if (findings.length > 0) {
    walkthroughBullets.push('- **Review Findings Summary**:');
    for (const f of findings.slice(0, 5)) {
      const file = f.filePath || (f as any).path || 'codebase';
      const line = f.lineNumber || (f as any).line || 1;
      walkthroughBullets.push(
        `  - [${f.persona}] ${String(f.severity).toUpperCase()} at \`${file}:${line}\`: ${
          f.comment || (f as any).body || (f as any).title || ''
        }`
      );
    }
  }

  // Module-level Changesets
  const changesetSections: string[] = [];
  if (moduleMap.size === 0) {
    changesetSections.push('### `root`');
    changesetSections.push('- General updates and baseline configuration changes.');
  } else {
    for (const [moduleName, entry] of moduleMap.entries()) {
      changesetSections.push(`### \`${moduleName}\``);
      for (const file of entry.files) {
        changesetSections.push(`- \`${file}\`: Modified in pull request.`);
      }
    }
  }

  return [
    '## Executive Overview',
    overview,
    '',
    '## Walkthrough',
    ...walkthroughBullets,
    '',
    '## Changesets',
    ...changesetSections,
  ].join('\n');
}
