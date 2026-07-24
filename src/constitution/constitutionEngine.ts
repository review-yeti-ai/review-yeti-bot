export type RuleType = 'directive' | 'forbidden_pattern' | 'mandatory_guideline';

export interface ConstitutionRule {
  id: string;
  type: RuleType;
  description: string;
  rawText: string;
  pattern?: RegExp;
}

export interface ParsedConstitution {
  title?: string;
  rules: ConstitutionRule[];
  rawContent: string;
}

export interface ConstitutionEvaluationInput {
  constitution: ParsedConstitution;
  config?: {
    enabled?: boolean;
    path?: string;
  };
  prTitle?: string;
  prBody?: string;
  changedFiles?: Array<{
    path: string;
    patch?: string;
    content?: string;
  }>;
}

export interface ConstitutionEvaluationResult {
  compliant: boolean;
  violations: string[];
  bypassed?: boolean;
}

export function parseConstitution(rawMarkdown: string): ParsedConstitution {
  if (!rawMarkdown || typeof rawMarkdown !== 'string') {
    return {
      title: 'Repository Constitution',
      rules: [],
      rawContent: '',
    };
  }

  const lines = rawMarkdown.split('\n');
  const rules: ConstitutionRule[] = [];
  let currentType: RuleType = 'mandatory_guideline';
  let title = 'Repository Constitution';
  let ruleCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (/^#{1,3}\s+/.test(line)) {
      const headingText = line.replace(/^#+\s*/, '').trim();
      const lowerHeading = headingText.toLowerCase();
      if (line.startsWith('# ') && (i === 0 || lowerHeading.includes('constitution'))) {
        title = headingText;
      }
      if (lowerHeading.includes('forbidden') || lowerHeading.includes('prohibited') || lowerHeading.includes('never')) {
        currentType = 'forbidden_pattern';
      } else if (lowerHeading.includes('directive') || lowerHeading.includes('mandatory') || lowerHeading.includes('must')) {
        currentType = 'directive';
      } else {
        currentType = 'mandatory_guideline';
      }
      continue;
    }

    const bulletMatch = line.match(/^(?:[-*+]|\d+\.|\-\s*\[[ xX]\])\s+(.+)$/);
    if (bulletMatch) {
      const ruleContent = bulletMatch[1].trim();
      ruleCount++;

      let type = currentType;
      if (/\b(forbidden|never|must not|do not|prohibit|prohibited)\b/i.test(ruleContent)) {
        type = 'forbidden_pattern';
      } else if (/\b(must|required|shall|mandatory)\b/i.test(ruleContent)) {
        type = 'directive';
      }

      let pattern: RegExp | undefined;
      const regexMatch = ruleContent.match(/`\\?\/((?:\\\/|\\.|[^\/])+?)\\?\/([gimsuy]*)`/);
      if (regexMatch) {
        type = 'forbidden_pattern';
        try {
          pattern = new RegExp(regexMatch[1], regexMatch[2] || 'g');
        } catch {
          // Ignore invalid regex
        }
      }

      rules.push({
        id: `rule-${ruleCount}`,
        type,
        description: ruleContent,
        rawText: line,
        pattern,
      });
    }
  }

  return {
    title,
    rules,
    rawContent: rawMarkdown,
  };
}

function checkNonRegexForbiddenRule(description: string, targetText: string): boolean {
  let cleaned = description.toLowerCase().trim();
  cleaned = cleaned.replace(/^(?:[-*+]|\d+\.)\s*/, '');
  cleaned = cleaned.replace(/^(?:forbidden:?|prohibit(?:ed)?|never(?:\s+use)?|do\s+not(?:\s+use)?|must\s+not(?:\s+use)?|no)\s+/i, '').trim();
  cleaned = cleaned.replace(/\s+(?:in\s+code(?:base)?|in\s+pr|in\s+production\s+files|statements?|execution)$/i, '').trim();

  if (!cleaned) return false;

  const lowerText = targetText.toLowerCase();

  // Direct phrase match
  if (lowerText.includes(cleaned)) {
    return true;
  }

  // Exact word boundary match for short keywords like "eval"
  if (cleaned.length <= 10 && /^[a-z0-9_.-]+$/i.test(cleaned)) {
    const wordBoundaryRegex = new RegExp(`\\b${cleaned.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (wordBoundaryRegex.test(targetText)) {
      return true;
    }
  }

  // Multi-word phrase keyword checking per line (e.g. "hardcoded jwt secrets")
  const keywords = cleaned.split(/[\s,._/-]+/).filter(w => w.length > 2 && !['use', 'the', 'and', 'for', 'with', 'code', 'in'].includes(w));
  if (keywords.length >= 2) {
    const lines = targetText.split('\n');
    for (const lineStr of lines) {
      const lowerLine = lineStr.toLowerCase();
      if (keywords.every(kw => lowerLine.includes(kw))) {
        return true;
      }
    }
  }

  return false;
}

export function evaluateConstitution(input: ConstitutionEvaluationInput): ConstitutionEvaluationResult {
  if (input.config?.enabled === false) {
    return {
      compliant: true,
      violations: [],
      bypassed: true,
    };
  }

  const { constitution, prTitle = '', prBody = '', changedFiles = [] } = input;
  const violations: string[] = [];
  const combinedPRText = `${prTitle}\n${prBody}`;

  for (const rule of constitution.rules) {
    if (rule.type === 'forbidden_pattern') {
      if (rule.pattern) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(combinedPRText)) {
          violations.push(`Forbidden pattern matched in PR title/body [Rule ${rule.id}]: ${rule.description}`);
        }

        for (const file of changedFiles) {
          const fileText = `${file.path}\n${file.content || ''}\n${file.patch || ''}`;
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(fileText)) {
            violations.push(`Forbidden pattern matched in file '${file.path}' [Rule ${rule.id}]: ${rule.description}`);
          }
        }
      } else {
        // Evaluate natural language non-regex forbidden rules against files and PR title/body
        for (const file of changedFiles) {
          const fileText = `${file.path}\n${file.content || ''}\n${file.patch || ''}`;
          if (checkNonRegexForbiddenRule(rule.description, fileText)) {
            violations.push(`Forbidden pattern matched in file '${file.path}' [Rule ${rule.id}]: ${rule.description}`);
          }
        }
      }
    } else if (rule.type === 'directive') {
      const lowerDesc = rule.description.toLowerCase();

      // Check PR Title directives
      if (lowerDesc.includes('pr title') || lowerDesc.includes('title')) {
        if (!prTitle || prTitle.trim().length < 3) {
          violations.push(`Directive violation [Rule ${rule.id}]: PR title is missing or insufficient (Rule: ${rule.description})`);
        } else if (lowerDesc.includes('conventional') && !/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_-]+\))?!?:/i.test(prTitle)) {
          violations.push(`Directive violation [Rule ${rule.id}]: PR title does not follow conventional commits format (Rule: ${rule.description})`);
        }
      }

      // Check PR Description / Summary directives
      if (
        lowerDesc.includes('pr description') ||
        lowerDesc.includes('description') ||
        lowerDesc.includes('pr summary') ||
        lowerDesc.includes('summary') ||
        lowerDesc.includes('pr body') ||
        lowerDesc.includes('must contain') ||
        lowerDesc.includes('must include') ||
        lowerDesc.includes('required')
      ) {
        if (!prBody || prBody.trim().length < 10) {
          violations.push(`Directive violation [Rule ${rule.id}]: PR description is missing or insufficient (Rule: ${rule.description})`);
        } else {
          // Verify required sub-sections if specified in directive
          if ((lowerDesc.includes('testing steps') || lowerDesc.includes('test plan')) && !/test/i.test(prBody)) {
            violations.push(`Directive violation [Rule ${rule.id}]: PR description missing testing steps (Rule: ${rule.description})`);
          } else if (lowerDesc.includes('risk assessment') && !/risk/i.test(prBody)) {
            violations.push(`Directive violation [Rule ${rule.id}]: PR description missing risk assessment (Rule: ${rule.description})`);
          }
        }
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}
