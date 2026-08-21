import { PersonaFinding } from '../github/commentPublisher';
import { PanelResult } from '../panel/panelEngine';
import { isRedTeamPersona } from '../personas/redTeamPersona';

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
 * Escapes table cell contents to prevent markdown table structure breakout and HTML disclosure corruption.
 */
export function escapeMarkdownTableCell(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats the collapsible Adversarial Attack & Defense Matrix markdown section.
 */
export function formatAdversarialMatrix(
  findings: PersonaFinding[] = [],
  panelResult?: PanelResult
): string {
  const redTeamFindings: Array<{
    persona: string;
    modelInfo?: string;
    filePath: string;
    lineNumber: number;
    severity: string;
    attackVector: string;
    failureMode: string;
    mitigation: string;
  }> = [];

  const crossExaminedModels = new Set<string>();

  if (panelResult && Array.isArray(panelResult.personas)) {
    for (const p of panelResult.personas.filter(Boolean)) {
      const isRed = p.isRedTeam || isRedTeamPersona(p.id);
      if (isRed) {
        if (p.crossExaminedModel) crossExaminedModels.add(p.crossExaminedModel);
        if (p.model) crossExaminedModels.add(p.model);
        if (p.findings && Array.isArray(p.findings)) {
          for (const pf of p.findings.filter(Boolean)) {
            redTeamFindings.push({
              persona: p.id,
              modelInfo: p.crossExaminedModel || p.model,
              filePath: pf.path || (pf as any).filePath || 'codebase',
              lineNumber: pf.line || (pf as any).line || (pf as any).lineNumber || 1,
              severity: String(pf.severity).toUpperCase(),
              attackVector: pf.title || (pf.body ? pf.body.split('\n')[0] : undefined) || 'Adversarial Vulnerability',
              failureMode: pf.body || 'Potential failure mode surfaced during cross-examination.',
              mitigation: pf.recommendation || pf.suggestion || 'Enforce boundary checks, sanitization, and defensive error handling.',
            });
          }
        }
      }
    }
  }

  if (findings && Array.isArray(findings)) {
    for (const f of findings.filter(Boolean)) {
      const isRed =
        f.isRedTeam ||
        isRedTeamPersona(f.persona) ||
        f.persona === 'red_team' ||
        f.persona === 'red-team' ||
        f.persona === 'skeptic';
      if (isRed) {
        if (f.crossExaminedModel) crossExaminedModels.add(f.crossExaminedModel);

        const path = f.filePath || (f as any).path || 'codebase';
        const line = f.lineNumber || (f as any).line || 1;
        const vectorTitle =
          f.attackVector || f.title || (f.comment ? f.comment.split('\n')[0] : undefined) || 'Adversarial Vulnerability';

        const isDup = redTeamFindings.some(
          (existing) =>
            existing.persona === f.persona &&
            existing.filePath === path &&
            existing.lineNumber === line &&
            existing.attackVector === vectorTitle
        );

        if (!isDup) {
          redTeamFindings.push({
            persona: f.persona,
            modelInfo: f.crossExaminedModel,
            filePath: path,
            lineNumber: line,
            severity: String(f.severity).toUpperCase(),
            attackVector: vectorTitle,
            failureMode: f.failureMode || f.comment || 'Potential failure mode surfaced during cross-examination.',
            mitigation: f.mitigation || f.recommendation || f.suggestion || 'Enforce boundary checks, sanitization, and defensive error handling.',
          });
        }
      }
    }
  }

  let modelListStr = '';
  if (crossExaminedModels.size > 0) {
    modelListStr = Array.from(crossExaminedModels)
      .map((m) => `\`${m}\``)
      .join(', ');
  } else {
    modelListStr = '`gpt-5.6-sol`';
  }

  const lines: string[] = [
    '<details>',
    '<summary><strong>🧬 Adversarial Attack & Defense Matrix</strong></summary>',
    '',
    '### 🛡️ Red-Team Cross-Examination Audit',
    `**Status**: 🧬 Active | **Cross-Examined Model(s)**: ${modelListStr}`,
    '',
  ];

  if (redTeamFindings.length === 0) {
    lines.push(
      'All persona checks and dual-model cross-examinations passed. Zero adversarial attack vectors or failure modes were detected in this pull request.'
    );
  } else {
    lines.push('| Persona / Model | Attack Vector / Target | Severity | Potential Failure Mode | Mitigation Recommendation |');
    lines.push('|---|---|---|---|---|');

    for (const item of redTeamFindings) {
      const personaModelCell = item.modelInfo
        ? `\`${escapeMarkdownTableCell(item.persona)}\` (\`${escapeMarkdownTableCell(item.modelInfo)}\`)`
        : `\`${escapeMarkdownTableCell(item.persona)}\``;
      const targetCell = `**${escapeMarkdownTableCell(item.attackVector)}**<br>\`${escapeMarkdownTableCell(item.filePath)}:${item.lineNumber}\``;
      const severityCell = `\`${escapeMarkdownTableCell(item.severity)}\``;
      const failureCell = escapeMarkdownTableCell(item.failureMode);
      const mitigationCell = escapeMarkdownTableCell(item.mitigation);

      lines.push(`| ${personaModelCell} | ${targetCell} | ${severityCell} | ${failureCell} | ${mitigationCell} |`);
    }
  }

  lines.push('</details>');

  return lines.join('\n');
}

/**
 * Generates CodeRabbit-grade PR summary containing Executive Overview, Walkthrough, Changesets, and Adversarial Matrix.
 */
export function generatePRSummary(
  diff: string,
  findings: PersonaFinding[] = [],
  optionsOrConfig?: any,
  panelResult?: PanelResult
): string {
  const actualPanelResult: PanelResult | undefined =
    optionsOrConfig && (optionsOrConfig.headSha || optionsOrConfig.distinctProviders || optionsOrConfig.arbiter || optionsOrConfig.moderator)
      ? optionsOrConfig
      : panelResult;

  const safeFindings = (findings || []).filter(Boolean);

  const moduleMap = parseDiffModules(diff);
  const totalFiles = Array.from(moduleMap.values()).reduce((sum, m) => sum + m.files.length, 0);
  const totalModules = moduleMap.size;

  // Executive Overview
  let overview = '';
  if (totalFiles === 0) {
    overview = 'This pull request includes updates to repository configurations and metadata. ';
    if (safeFindings.length > 0) {
      overview += `Automated review detected ${safeFindings.length} finding(s) requiring attention.`;
    } else {
      overview += 'All persona checks passed with zero findings detected.';
    }
  } else {
    overview = `This pull request introduces changes across ${totalFiles} file(s) in ${totalModules} module(s). `;
    if (safeFindings.length > 0) {
      const criticalCount = safeFindings.filter(
        (f) => String(f.severity).toLowerCase() === 'critical' || String(f.severity) === 'P0'
      ).length;
      const majorCount = safeFindings.filter(
        (f) => String(f.severity).toLowerCase() === 'major' || String(f.severity) === 'P1'
      ).length;
      overview += `Automated review detected ${safeFindings.length} finding(s) (${criticalCount} critical, ${majorCount} major) requiring attention.`;
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
      const displayModule = moduleName && moduleName.trim().length > 0 ? moduleName : 'root';
      const fileList = entry.files.map((f) => f.split('/').pop() || f).filter((f) => f && f.trim().length > 0).join(', ');
      walkthroughBullets.push(`- **${displayModule}**: Updated ${entry.files.length} file(s)${fileList ? ` (\`${fileList}\`)` : ''}.`);
    }
  }

  if (safeFindings.length > 0) {
    walkthroughBullets.push('- **Review Findings Summary**:');
    for (const f of safeFindings.slice(0, 5)) {
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
      const displayModule = moduleName && moduleName.trim().length > 0 ? moduleName : 'root';
      changesetSections.push(`### \`${displayModule}\``);
      for (const file of entry.files) {
        if (file && file.trim().length > 0) {
          changesetSections.push(`- \`${file}\`: Modified in pull request.`);
        }
      }
    }
  }

  const adversarialMatrix = formatAdversarialMatrix(safeFindings, actualPanelResult);

  return [
    '## Executive Overview',
    overview,
    '',
    '<details>',
    '<summary><strong>🔍 Walkthrough & Module Changesets</strong></summary>',
    '',
    '### Walkthrough',
    ...walkthroughBullets,
    '',
    '### Changesets',
    ...changesetSections,
    '</details>',
    '',
    adversarialMatrix,
  ].join('\n');
}

