import * as yaml from 'js-yaml';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: Array<{ type: 'add' | 'delete' | 'context'; content: string }>;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  isNew?: boolean;
  isDeleted?: boolean;
  isRenamed?: boolean;
  hunks: DiffHunk[];
}

export interface CtReviewConfigFixtureOptions {
  version?: string;
  quorum?: {
    minApprovals?: number;
    personas?: Array<'security' | 'architecture' | 'performance' | 'quality'>;
    effortLevel?: 'low' | 'medium' | 'high' | 'reasoning';
  };
  ticketEnforcement?: {
    required?: boolean;
    providers?: Array<'linear' | 'jira' | 'github'>;
    patterns?: string[];
  };
  constitution?: {
    enabled?: boolean;
    path?: string;
  };
}

export interface ConstitutionRule {
  id: string;
  category: 'security' | 'architecture' | 'quality' | 'compliance';
  title: string;
  directive: string;
  forbiddenPatterns?: string[];
  mandatoryGuidelines?: string[];
}

export class FixtureGenerator {
  /**
   * Builds a Git unified diff string from structured file diff definitions.
   */
  static buildUnifiedDiff(files: FileDiff[]): string {
    let diff = '';
    for (const file of files) {
      const oldHeader = file.isNew ? '/dev/null' : `a/${file.oldPath}`;
      const newHeader = file.isDeleted ? '/dev/null' : `b/${file.newPath}`;

      diff += `diff --git a/${file.oldPath} b/${file.newPath}\n`;
      if (file.isNew) diff += `new file mode 100644\n`;
      if (file.isDeleted) diff += `deleted file mode 100644\n`;
      diff += `--- ${oldHeader}\n`;
      diff += `+++ ${newHeader}\n`;

      for (const hunk of file.hunks) {
        diff += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
        for (const change of hunk.changes) {
          const prefix = change.type === 'add' ? '+' : change.type === 'delete' ? '-' : ' ';
          diff += `${prefix}${change.content}\n`;
        }
      }
    }
    return diff;
  }

  /**
   * Pre-canned scenario diffs
   */
  static getScenarioDiff(scenario: 'security_vuln' | 'arch_violation' | 'clean' | 'incremental_a' | 'incremental_b'): string {
    switch (scenario) {
      case 'security_vuln':
        return this.buildUnifiedDiff([
          {
            oldPath: 'src/auth/login.ts',
            newPath: 'src/auth/login.ts',
            hunks: [
              {
                oldStart: 10,
                oldLines: 3,
                newStart: 10,
                newLines: 5,
                changes: [
                  { type: 'context', content: 'export async function login(req: Request) {' },
                  { type: 'delete', content: '  const user = await db.findUser(req.body.id);' },
                  { type: 'add', content: '  const apiKey = "AKIAIOSFODNN7EXAMPLE"; // HARDCODED SECRET' },
                  { type: 'add', content: '  const user = await db.raw(`SELECT * FROM users WHERE id = ${req.body.id}`);' },
                  { type: 'context', content: '  return user;' },
                ],
              },
            ],
          },
        ]);
      case 'arch_violation':
        return this.buildUnifiedDiff([
          {
            oldPath: 'src/ui/Component.tsx',
            newPath: 'src/ui/Component.tsx',
            hunks: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 4,
                changes: [
                  { type: 'context', content: 'import React from "react";' },
                  { type: 'add', content: 'import { directDatabaseQuery } from "../db/rawDriver";' },
                  { type: 'context', content: 'export const Component = () => {' },
                  { type: 'add', content: '  directDatabaseQuery("DELETE FROM audit_logs");' },
                ],
              },
            ],
          },
        ]);
      case 'clean':
        return this.buildUnifiedDiff([
          {
            oldPath: 'src/utils/math.ts',
            newPath: 'src/utils/math.ts',
            hunks: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 4,
                changes: [
                  { type: 'context', content: 'export function add(a: number, b: number): number {' },
                  { type: 'add', content: '  // Helper add method' },
                  { type: 'context', content: '  return a + b;' },
                  { type: 'add', content: '}' },
                ],
              },
            ],
          },
        ]);
      case 'incremental_a':
        return this.buildUnifiedDiff([
          {
            oldPath: 'src/service.ts',
            newPath: 'src/service.ts',
            hunks: [
              {
                oldStart: 12,
                oldLines: 2,
                newStart: 12,
                newLines: 3,
                changes: [
                  { type: 'context', content: 'function processData(input: string) {' },
                  { type: 'add', content: '  eval(input); // Finding #1: Dangerous eval' },
                  { type: 'add', content: '  console.log(input); // Finding #2: Console log nit' },
                  { type: 'context', content: '}' },
                ],
              },
            ],
          },
        ]);
      case 'incremental_b':
        return this.buildUnifiedDiff([
          {
            oldPath: 'src/service.ts',
            newPath: 'src/service.ts',
            hunks: [
              {
                oldStart: 12,
                oldLines: 3,
                newStart: 12,
                newLines: 3,
                changes: [
                  { type: 'context', content: 'function processData(input: string) {' },
                  { type: 'add', content: '  JSON.parse(input); // Fixed eval -> JSON.parse' },
                  { type: 'context', content: '  console.log(input); // Finding #2: Console log nit remains' },
                  { type: 'context', content: '}' },
                ],
              },
            ],
          },
        ]);
      default:
        return '';
    }
  }

  /**
   * Builds YAML config string from structured options.
   */
  static buildConfigYaml(options: CtReviewConfigFixtureOptions = {}): string {
    const config = {
      version: options.version ?? '1.0',
      quorum: {
        minApprovals: options.quorum?.minApprovals ?? 2,
        personas: options.quorum?.personas ?? ['security', 'architecture', 'performance', 'quality'],
        effortLevel: options.quorum?.effortLevel ?? 'medium',
      },
      ticketEnforcement: {
        required: options.ticketEnforcement?.required ?? true,
        providers: options.ticketEnforcement?.providers ?? ['linear', 'jira', 'github'],
        patterns: options.ticketEnforcement?.patterns ?? ['\\[[A-Z]+-\\d+\\]', '#\\d+'],
      },
      constitution: {
        enabled: options.constitution?.enabled ?? true,
        path: options.constitution?.path ?? '.github/constitution.md',
      },
    };
    return yaml.dump(config);
  }

  /**
   * Builds constitution.md content string.
   */
  static buildConstitutionMarkdown(rules: ConstitutionRule[]): string {
    let md = `# Operational Constitution\n\n`;
    for (const rule of rules) {
      md += `## Rule ${rule.id}: ${rule.title}\n`;
      md += `- **Category**: ${rule.category}\n`;
      md += `- **Directive**: ${rule.directive}\n`;
      if (rule.forbiddenPatterns && rule.forbiddenPatterns.length > 0) {
        md += `- **Forbidden Patterns**:\n`;
        for (const pattern of rule.forbiddenPatterns) {
          md += `  - \`${pattern}\` \n`;
        }
      }
      if (rule.mandatoryGuidelines && rule.mandatoryGuidelines.length > 0) {
        md += `- **Mandatory Guidelines**:\n`;
        for (const guideline of rule.mandatoryGuidelines) {
          md += `  - ${guideline}\n`;
        }
      }
      md += `\n`;
    }
    return md;
  }
}
