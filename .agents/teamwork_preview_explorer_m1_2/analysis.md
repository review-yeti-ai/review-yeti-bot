# Detailed Implementation Specification: Core Foundations & Engines (Milestone 1)

**Author**: Explorer 2  
**Target Directory**: `src/config/`, `src/ticket/`, `src/constitution/`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m1_2`

---

## Executive Summary

This document specifies the technical design, data contracts, validation rules, algorithms, and test strategies for three critical foundational modules of `ct-review-bot`:
1. **Config Loader & Parser** (`src/config/configLoader.ts`, `src/config/schema.ts`, `src/config/defaultOrgConfig.ts`)
2. **Ticket Linkage Engine** (`src/ticket/ticketValidator.ts`)
3. **Operational Constitution Engine** (`src/constitution/constitutionEngine.ts`)

---

## 1. Config Loader & Parser

### 1.1 Architectural Overview
The Config Loader component reads repository configuration files (`.ct-review.yaml` or `.coderabbit.yaml`), validates structure and types against a Zod schema matching the global `CtReviewConfig` interface contract, merges user-provided overrides over baseline organization defaults (`defaultOrgConfig.ts`), and exposes a clean, safe configuration object for downstream engines.

```
┌────────────────────────┐      ┌─────────────────────────┐
│   .ct-review.yaml      │  OR  │   .coderabbit.yaml      │
└───────────┬────────────┘      └────────────┬────────────┘
            │                                │
            ▼                                ▼
    ┌───────────────┐               ┌─────────────────┐
    │  js-yaml      │               │ CodeRabbit      │
    │  Raw Parser   │               │ Config Adapter  │
    └───────┬───────┘               └────────┬────────┘
            │                                │
            └────────────────┬───────────────┘
                             │
                             ▼
               ┌───────────────────────────┐
               │  Deep Merge with          │
               │  DEFAULT_ORG_CONFIG       │
               └─────────────┬─────────────┘
                             │
                             ▼
               ┌───────────────────────────┐
               │  Zod Schema Validation    │
               │  (ctReviewConfigSchema)   │
               └─────────────┬─────────────┘
                             │
                             ▼
               ┌───────────────────────────┐
               │  Validated CtReviewConfig │
               └───────────────────────────┘
```

---

### 1.2 File Layout & Modules

#### `src/config/schema.ts`
Defines the Zod schema `ctReviewConfigSchema`, exports TypeScript types, and handles `.coderabbit.yaml` schema transformation.

```typescript
import { z } from 'zod';

export const PersonaEnum = z.enum(['security', 'architecture', 'performance', 'quality']);
export type Persona = z.infer<typeof PersonaEnum>;

export const EffortLevelEnum = z.enum(['low', 'medium', 'high', 'reasoning']);
export type EffortLevel = z.infer<typeof EffortLevelEnum>;

export const TicketProviderEnum = z.enum(['linear', 'jira', 'github']);
export type TicketProvider = z.infer<typeof TicketProviderEnum>;

export const ctReviewConfigSchema = z.object({
  version: z.string().default('1.0'),
  quorum: z.object({
    minApprovals: z.number().int().min(1, 'minApprovals must be at least 1').default(2),
    personas: z.array(PersonaEnum).min(1, 'At least one persona is required').default([
      'security',
      'architecture',
      'performance',
      'quality',
    ]),
    effortLevel: EffortLevelEnum.default('medium'),
  }),
  ticketEnforcement: z.object({
    required: z.boolean().default(true),
    providers: z.array(TicketProviderEnum).default(['linear', 'jira', 'github']),
    patterns: z.array(z.string()).optional().default([]),
  }),
  constitution: z.object({
    enabled: z.boolean().default(true),
    path: z.string().optional().default('.github/constitution.md'),
  }),
});

export type CtReviewConfig = z.infer<typeof ctReviewConfigSchema>;

/**
 * Adapter schema for legacy or alternative `.coderabbit.yaml` configs.
 * Translates CodeRabbit format to standard CtReviewConfig shape.
 */
export const codeRabbitConfigSchema = z.object({
  language: z.string().optional(),
  early_access: z.boolean().optional(),
  reviews: z.object({
    profile: z.string().optional(),
    request_tools: z.array(z.string()).optional(),
    high_level_summary: z.boolean().optional(),
    auto_review: z.object({
      enabled: z.boolean().optional(),
      drafts: z.boolean().optional(),
    }).optional(),
  }).optional(),
  chat: z.object({
    auto_reply: z.boolean().optional(),
  }).optional(),
});

export type CodeRabbitConfig = z.infer<typeof codeRabbitConfigSchema>;
```

---

#### `src/config/defaultOrgConfig.ts`
Defines the baseline configuration for organization-wide defaults.

```typescript
import { CtReviewConfig } from './schema';

export const DEFAULT_ORG_CONFIG: CtReviewConfig = {
  version: '1.0',
  quorum: {
    minApprovals: 2,
    personas: ['security', 'architecture', 'performance', 'quality'],
    effortLevel: 'medium',
  },
  ticketEnforcement: {
    required: true,
    providers: ['linear', 'jira', 'github'],
    patterns: [],
  },
  constitution: {
    enabled: true,
    path: '.github/constitution.md',
  },
};
```

---

#### `src/config/configLoader.ts`
Provides reading, parsing, deep merging, adapter translation, and validation.

```typescript
import yaml from 'js-yaml';
import { DEFAULT_ORG_CONFIG } from './defaultOrgConfig';
import { ctReviewConfigSchema, codeRabbitConfigSchema, CtReviewConfig } from './schema';

export class ConfigValidationError extends Error {
  constructor(message: string, public readonly details: unknown) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Deep merge utility for config objects.
 * - Primitive values in target override source.
 * - Objects are recursively merged.
 * - Arrays in target override source (if target array is non-empty/defined).
 */
export function deepMergeConfig(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...source };
  
  for (const key of Object.keys(target)) {
    const targetVal = target[key];
    const sourceVal = source[key];
    
    if (targetVal === undefined || targetVal === null) {
      continue;
    }
    
    if (Array.isArray(targetVal)) {
      result[key] = targetVal;
    } else if (typeof targetVal === 'object' && !Array.isArray(targetVal) && targetVal !== null) {
      result[key] = deepMergeConfig(targetVal, typeof sourceVal === 'object' && sourceVal !== null ? sourceVal : {});
    } else {
      result[key] = targetVal;
    }
  }
  
  return result;
}

/**
 * Converts parsed `.coderabbit.yaml` config into equivalent `CtReviewConfig` overrides.
 */
export function convertCodeRabbitConfig(raw: Record<string, any>): Partial<CtReviewConfig> {
  const parsed = codeRabbitConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {};
  }

  const cr = parsed.data;
  const config: Partial<CtReviewConfig> = {};

  if (cr.reviews) {
    config.quorum = {
      minApprovals: 2,
      personas: ['security', 'architecture', 'performance', 'quality'],
      effortLevel: cr.reviews.profile === 'chill' ? 'low' : cr.reviews.profile === 'assertive' ? 'high' : 'medium',
    };
  }

  return config;
}

/**
 * Main Loader API
 */
export function parseAndValidateConfig(rawYaml: string, isCodeRabbitFormat = false): CtReviewConfig {
  let parsedRaw: unknown;
  try {
    parsedRaw = yaml.load(rawYaml);
  } catch (err: any) {
    throw new ConfigValidationError(`YAML syntax error: ${err.message}`, err);
  }

  if (typeof parsedRaw !== 'object' || parsedRaw === null) {
    parsedRaw = {};
  }

  let userOverrides: Record<string, any> = parsedRaw as Record<string, any>;
  if (isCodeRabbitFormat) {
    userOverrides = convertCodeRabbitConfig(userOverrides) as Record<string, any>;
  }

  const merged = deepMergeConfig(userOverrides, DEFAULT_ORG_CONFIG);

  const validationResult = ctReviewConfigSchema.safeParse(merged);
  if (!validationResult.success) {
    throw new ConfigValidationError(
      `Config validation failed: ${validationResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      validationResult.error.format()
    );
  }

  return validationResult.data;
}
```

---

## 2. Ticket Linkage Engine (`src/ticket/ticketValidator.ts`)

### 2.1 Requirements & Supported Formats
The Ticket Linkage Engine parses PR titles and descriptions/bodies to identify references to issues/tickets. It supports:
1. **Linear**: `[PROJ-123]` or `PROJ-123`
2. **Jira**: `[KEY-456]` or `KEY-456` (Uppercase 2-10 letter key prefix followed by hyphen and numbers)
3. **GitHub**: `#789` or `PROJ-789` or `owner/repo#789` or `Fixes #789` / `Closes #789`
4. **Custom Regex**: Optional regex pattern list provided in `ticketEnforcement.patterns`

It supports two operating modes based on configuration:
- **Strict Enforcement Mode** (`required: true`): Validates that at least one valid ticket pattern is matched. Returns `valid: false` with descriptive error if missing.
- **Advisory Mode** (`required: false`): Extracts tickets found without failing validation if no tickets are present (`valid: true`).

---

### 2.2 Implementation Specification

```typescript
import { CtReviewConfig } from '../config/schema';

export interface TicketValidationInput {
  title: string;
  body: string;
  config: CtReviewConfig['ticketEnforcement'];
}

export interface TicketValidationResult {
  valid: boolean;
  ticketsFound: string[];
  error?: string;
  mode: 'strict' | 'advisory';
}

/**
 * Standard Regex Patterns
 */
export const TICKET_PATTERNS = {
  /** Matches Linear formatted keys: [PROJ-123] or PROJ-123 */
  LINEAR: /\b([A-Z]{2,10}-\d+)\b|\[([A-Z]{2,10}-\d+)\]/g,
  
  /** Matches Jira formatted keys: [KEY-456] or KEY-456 */
  JIRA: /\b([A-Z][A-Z0-9_]{1,10}-\d+)\b|\[([A-Z][A-Z0-9_]{1,10}-\d+)\]/g,
  
  /** Matches GitHub issue references: #789, owner/repo#789, or GH-789 */
  GITHUB: /(?:^|\s)(?:#(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)|GH-(\d+))\b/gi,
};

/**
 * Validates PR title and body for ticket references according to configured providers and rules.
 */
export function validateTicketLinkage(input: TicketValidationInput): TicketValidationResult {
  const { title, body, config } = input;
  const combinedText = `${title || ''}\n${body || ''}`;
  const ticketsSet = new Set<string>();

  const mode: 'strict' | 'advisory' = config.required ? 'strict' : 'advisory';

  // 1. Scan for enabled standard providers
  for (const provider of config.providers) {
    if (provider === 'linear') {
      const matches = combinedText.matchAll(TICKET_PATTERNS.LINEAR);
      for (const m of matches) {
        const ticket = m[1] || m[2];
        if (ticket) ticketsSet.add(ticket.toUpperCase());
      }
    } else if (provider === 'jira') {
      const matches = combinedText.matchAll(TICKET_PATTERNS.JIRA);
      for (const m of matches) {
        const ticket = m[1] || m[2];
        if (ticket) ticketsSet.add(ticket.toUpperCase());
      }
    } else if (provider === 'github') {
      const matches = combinedText.matchAll(TICKET_PATTERNS.GITHUB);
      for (const m of matches) {
        const ticket = m[0]?.trim();
        if (ticket) ticketsSet.add(ticket);
      }
    }
  }

  // 2. Scan for custom regex patterns if configured
  if (config.patterns && config.patterns.length > 0) {
    for (const patternStr of config.patterns) {
      try {
        const customRegex = new RegExp(patternStr, 'g');
        const matches = combinedText.matchAll(customRegex);
        for (const m of matches) {
          if (m[0]) ticketsSet.add(m[0].trim());
        }
      } catch (err) {
        // Invalid regex pattern provided in config, skip or handle gracefully
      }
    }
  }

  const ticketsFound = Array.from(ticketsSet);
  const hasTickets = ticketsFound.length > 0;

  if (mode === 'strict' && !hasTickets) {
    return {
      valid: false,
      ticketsFound: [],
      error: `No ticket linkage found in PR title or body. Configured required providers: [${config.providers.join(', ')}]. Example formats: [PROJ-123], KEY-456, or #789.`,
      mode: 'strict',
    };
  }

  return {
    valid: true,
    ticketsFound,
    mode,
  };
}
```

---

## 3. Operational Constitution Engine (`src/constitution/constitutionEngine.ts`)

### 3.1 Overview & Requirements
The Operational Constitution Engine parses repository `constitution.md` files, extracts directives, forbidden code/architectural patterns, and mandatory guidelines, and evaluates PR metadata & code changes against those rules.

Output interface contract:
```typescript
export interface ConstitutionEvaluationResult {
  compliant: boolean;
  violations: string[];
}
```

---

### 3.2 Detailed Design & Implementation

#### 3.2.1 Data Models

```typescript
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
  prTitle?: string;
  prBody?: string;
  changedFiles?: Array<{
    path: string;
    patch?: string;
    content?: string;
  }>;
}
```

#### 3.2.2 Parser Logic (`parseConstitution`)
Extracts rules from markdown using AST/regex parsing:
- Headings (`## Forbidden Patterns`, `## Directives`, `## Guidelines`) set the active section type.
- Bullet points (`- `, `* `, `1. `) and checklist items (`- [ ]`, `- [x]`) are parsed as rules.
- Inline regex specifications (e.g. `` forbidden: `/eval\(.*\)/` ``) are compiled into `RegExp` objects for automated static scanning.
- Keywords (`FORBIDDEN:`, `MUST NOT:`, `NEVER:`, `REQUIRED:`, `MUST:`) automatically categorize rules if outside explicit section headings.

```typescript
export function parseConstitution(rawMarkdown: string): ParsedConstitution {
  const lines = rawMarkdown.split('\n');
  const rules: ConstitutionRule[] = [];
  let currentType: RuleType = 'mandatory_guideline';
  let title = 'Repository Constitution';
  let ruleCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Track Title
    if (line.startsWith('# ')) {
      title = line.substring(2).trim();
      continue;
    }

    // Track Section Headings
    if (line.startsWith('## ') || line.startsWith('### ')) {
      const headingText = line.replace(/^#+\s*/, '').toLowerCase();
      if (headingText.includes('forbidden') || headingText.includes('prohibited')) {
        currentType = 'forbidden_pattern';
      } else if (headingText.includes('directive') || headingText.includes('mandatory') || headingText.includes('must')) {
        currentType = 'directive';
      } else {
        currentType = 'mandatory_guideline';
      }
      continue;
    }

    // Track Bullet / List / Checklist Items
    const bulletMatch = line.match(/^(?:[-*+]|\d+\.|\-\s*\[[ xX]\])\s+(.+)$/);
    if (bulletMatch) {
      const ruleContent = bulletMatch[1].trim();
      ruleCount++;

      let type = currentType;
      if (/\b(forbidden|never|must not|do not)\b/i.test(ruleContent)) {
        type = 'forbidden_pattern';
      } else if (/\b(must|required|shall)\b/i.test(ruleContent)) {
        type = 'directive';
      }

      // Check for embedded regex inside backticks or pattern notation e.g., `/pattern/flags`
      let pattern: RegExp | undefined;
      const regexMatch = ruleContent.match(/`\/([^/]+)\/([gimsuy]*)`/);
      if (regexMatch) {
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
```

#### 3.2.3 Evaluation Logic (`evaluateConstitution`)

```typescript
export function evaluateConstitution(input: ConstitutionEvaluationInput): ConstitutionEvaluationResult {
  const { constitution, prTitle = '', prBody = '', changedFiles = [] } = input;
  const violations: string[] = [];

  const combinedPRText = `${prTitle}\n${prBody}`;

  for (const rule of constitution.rules) {
    if (rule.type === 'forbidden_pattern') {
      // 1. If rule has compiled pattern, test against PR metadata and changed file content
      if (rule.pattern) {
        if (rule.pattern.test(combinedPRText)) {
          violations.push(`Forbidden pattern matched in PR title/body [Rule ${rule.id}]: ${rule.description}`);
        }

        for (const file of changedFiles) {
          const fileText = `${file.path}\n${file.content || ''}\n${file.patch || ''}`;
          // Reset regex lastIndex if global flag is present
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(fileText)) {
            violations.push(`Forbidden pattern matched in file '${file.path}' [Rule ${rule.id}]: ${rule.description}`);
          }
        }
      }
    } else if (rule.type === 'directive') {
      // Directives can check for explicit presence of required checklist tags or sections
      if (rule.description.toLowerCase().includes('pr description must contain') || rule.description.toLowerCase().includes('requires description')) {
        if (!prBody || prBody.trim().length < 10) {
          violations.push(`Directive violation [Rule ${rule.id}]: PR description is missing or insufficient (Rule: ${rule.description})`);
        }
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}
```

---

## 4. Synthesis & Cross-Module Integration

The three modules fit directly into the core workflow execution pipeline:

```typescript
// Example Orchestration Flow in Milestone 1 Integration Test
const config = parseAndValidateConfig(rawYamlContent);

// 1. Ticket validation
const ticketResult = validateTicketLinkage({
  title: pr.title,
  body: pr.body,
  config: config.ticketEnforcement,
});

// 2. Constitution compliance
let constitutionResult = { compliant: true, violations: [] };
if (config.constitution.enabled) {
  const parsedConst = parseConstitution(rawConstitutionMarkdown);
  constitutionResult = evaluateConstitution({
    constitution: parsedConst,
    prTitle: pr.title,
    prBody: pr.body,
    changedFiles: pr.files,
  });
}
```

---

## 5. Comprehensive Unit & Integration Test Specifications

### 5.1 Config Loader Unit Tests (`tests/unit/config.test.ts`)
- **Valid .ct-review.yaml parsing**: Load complete YAML file, assert returned object strictly matches `CtReviewConfig`.
- **Partial config merge**: Pass minimal `.ct-review.yaml` (e.g. only `quorum.minApprovals = 3`), assert other properties retain `DEFAULT_ORG_CONFIG` defaults.
- **CodeRabbit config conversion**: Pass valid `.coderabbit.yaml`, assert translation to `CtReviewConfig`.
- **Invalid YAML error handling**: Pass broken YAML syntax, verify `ConfigValidationError` thrown.
- **Invalid Schema error handling**: Pass out-of-range value (e.g., `minApprovals: 0` or invalid persona string `'ninja'`), verify Zod validation error.

### 5.2 Ticket Validator Unit Tests (`tests/unit/ticket.test.ts`)
- **Linear Ticket Detection**: Test `[PROJ-123]` and `PROJ-123` in PR title and body.
- **Jira Ticket Detection**: Test `[KEY-456]` and `KEY-456`.
- **GitHub Issue Detection**: Test `#789` and `owner/repo#101`.
- **Strict Mode Failure**: `required: true`, no tickets present -> returns `valid: false`, `error` message populated.
- **Advisory Mode Pass**: `required: false`, no tickets present -> returns `valid: true`, empty `ticketsFound`.
- **Deduplication**: Same ticket in title and body returns single entry in `ticketsFound`.

### 5.3 Constitution Engine Unit Tests (`tests/unit/constitution.test.ts`)
- **Markdown Rule Parsing**: Parse markdown with directives, forbidden patterns, and guidelines. Verify rule types and counts.
- **Regex Pattern Extraction**: Parse forbidden pattern rule containing regex `` `/eval\(.*\)/` ``, verify `rule.pattern` compiled.
- **Forbidden Pattern Enforcement**: Pass code containing `eval(...)`, verify `compliant: false` and violation message logged.
- **Compliant Code**: Pass clean code and PR body, verify `compliant: true`, `violations: []`.

---
