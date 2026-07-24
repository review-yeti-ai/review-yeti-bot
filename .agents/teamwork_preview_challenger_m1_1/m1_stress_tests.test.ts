import { describe, it, expect } from 'vitest';
import { parseAndValidateConfig, ConfigValidationError, deepMergeConfig, convertCodeRabbitConfig } from '../../src/config/configLoader';
import { validateTicketLinkage, TICKET_PATTERNS } from '../../src/ticket/ticketValidator';
import { parseConstitution, evaluateConstitution } from '../../src/constitution/constitutionEngine';

describe('Milestone 1 Empirical Stress Test Suite (Challenger 1)', () => {
  
  // =========================================================================
  // 1. CONFIG PARSER STRESS TESTS
  // =========================================================================
  describe('Config Parser Edge & Stress Cases', () => {
    it('handles malformed YAML syntax with ConfigValidationError', () => {
      const invalidYaml = `
quorum:
  minApprovals: : invalid yaml syntax
  personas: [
`;
      expect(() => parseAndValidateConfig(invalidYaml)).toThrow(ConfigValidationError);
    });

    it('handles non-object YAML root (e.g. array root)', () => {
      const arrayYaml = `
- item1
- item2
`;
      // Passing an array root
      try {
        const result = parseAndValidateConfig(arrayYaml);
        // Record behavior: Does it throw or fallback?
        expect(result).toBeDefined();
        console.log('[TEST LOG] Array YAML root result:', result);
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConfigValidationError);
      }
    });

    it('handles primitive YAML roots (string, scalar)', () => {
      const stringYaml = `just a plain string`;
      const result = parseAndValidateConfig(stringYaml);
      expect(result.quorum.minApprovals).toBe(2);
    });

    it('rejects minApprovals < 1 or floating points', () => {
      const zeroMin = `
quorum:
  minApprovals: 0
`;
      expect(() => parseAndValidateConfig(zeroMin)).toThrow(ConfigValidationError);

      const negativeMin = `
quorum:
  minApprovals: -5
`;
      expect(() => parseAndValidateConfig(negativeMin)).toThrow(ConfigValidationError);

      const floatMin = `
quorum:
  minApprovals: 2.5
`;
      expect(() => parseAndValidateConfig(floatMin)).toThrow(ConfigValidationError);
    });

    it('rejects invalid persona enum values', () => {
      const invalidPersona = `
quorum:
  personas:
    - security
    - invalid_persona_name
`;
      expect(() => parseAndValidateConfig(invalidPersona)).toThrow(ConfigValidationError);
    });

    it('rejects empty personas array', () => {
      const emptyPersonas = `
quorum:
  personas: []
`;
      expect(() => parseAndValidateConfig(emptyPersonas)).toThrow(ConfigValidationError);
    });

    it('rejects invalid effort level', () => {
      const invalidEffort = `
quorum:
  effortLevel: super_high
`;
      expect(() => parseAndValidateConfig(invalidEffort)).toThrow(ConfigValidationError);
    });

    it('rejects invalid ticket provider', () => {
      const invalidProvider = `
ticketEnforcement:
  providers:
    - linear
    - trello
`;
      expect(() => parseAndValidateConfig(invalidProvider)).toThrow(ConfigValidationError);
    });

    it('tests CodeRabbit config conversion edge cases', () => {
      expect(convertCodeRabbitConfig({})).toEqual({});
      expect(convertCodeRabbitConfig({ reviews: { profile: 'chill' } })).toEqual({
        quorum: {
          minApprovals: 2,
          personas: ['security', 'architecture', 'performance', 'quality'],
          effortLevel: 'low',
        },
      });
      expect(convertCodeRabbitConfig({ reviews: { profile: 'assertive' } })).toEqual({
        quorum: {
          minApprovals: 2,
          personas: ['security', 'architecture', 'performance', 'quality'],
          effortLevel: 'high',
        },
      });
      expect(convertCodeRabbitConfig({ reviews: { profile: 'other' } })).toEqual({
        quorum: {
          minApprovals: 2,
          personas: ['security', 'architecture', 'performance', 'quality'],
          effortLevel: 'medium',
        },
      });
    });

    it('deepMergeConfig array override vs object merge behavior', () => {
      const target = { quorum: { personas: ['security'] } };
      const source = { quorum: { personas: ['security', 'architecture'], minApprovals: 2 } };
      const merged = deepMergeConfig(target, source);
      expect(merged.quorum.personas).toEqual(['security']);
      expect(merged.quorum.minApprovals).toBe(2);
    });
  });

  // =========================================================================
  // 2. TICKET LINKAGE ENGINE STRESS TESTS
  // =========================================================================
  describe('Ticket Linkage Engine Edge & Stress Cases', () => {
    const defaultConfig = {
      required: true,
      providers: ['linear', 'jira', 'github'] as ('linear' | 'jira' | 'github')[],
      patterns: [],
    };

    it('extracts mixed ticket formats from PR title and body', () => {
      const res = validateTicketLinkage({
        title: 'feat: add auth [PROJ-123] and [KEY-456]',
        body: 'Closes #789 and linear issue LINEAR-999',
        config: defaultConfig,
      });

      expect(res.valid).toBe(true);
      expect(res.ticketsFound).toEqual(expect.arrayContaining(['PROJ-123', 'KEY-456', '#789', 'LINEAR-999']));
    });

    it('tests lowercase ticket keys (e.g. lowercase branch/PR title)', () => {
      const res = validateTicketLinkage({
        title: 'fix: resolving proj-123 bug',
        body: 'See key-456 for context',
        config: defaultConfig,
      });

      // Let's observe if lowercase ticket keys are extracted or missed
      console.log('[TEST LOG] Lowercase ticket results:', res);
      // expect(res.ticketsFound).toContain('PROJ-123');
    });

    it('tests tickets inside parentheses: (#789) or (PROJ-123)', () => {
      const res = validateTicketLinkage({
        title: 'fix: critical security issue (#789)',
        body: 'Related to (PROJ-123)',
        config: defaultConfig,
      });

      console.log('[TEST LOG] Parentheses ticket results:', res);
      expect(res.ticketsFound.length).toBeGreaterThan(0);
    });

    it('tests full repo github issue references (owner/repo#123)', () => {
      const res = validateTicketLinkage({
        title: 'refactor: sync with calltelemetry/ai-workspace#101',
        body: '',
        config: { ...defaultConfig, providers: ['github'] },
      });

      console.log('[TEST LOG] Full repo GitHub issue result:', res);
      expect(res.ticketsFound).toContain('calltelemetry/ai-workspace#101');
    });

    it('tests tickets inside URLs (e.g., https://jira.company.com/browse/PROJ-100)', () => {
      const res = validateTicketLinkage({
        title: 'docs: update architecture specs',
        body: 'Ref https://jira.company.com/browse/PROJ-100 and https://linear.app/team/issue/ENG-500',
        config: defaultConfig,
      });

      console.log('[TEST LOG] Ticket in URL result:', res);
      expect(res.ticketsFound.length).toBeGreaterThan(0);
    });

    it('handles custom regex patterns and invalid custom regex', () => {
      const res = validateTicketLinkage({
        title: 'feat: TICKET-ABC-123',
        body: 'CUSTOM-99',
        config: {
          required: true,
          providers: [],
          patterns: ['TICKET-[A-Z]+-\\d+', '[unclosed-regex-bracket'],
        },
      });

      expect(res.ticketsFound).toContain('TICKET-ABC-123');
    });

    it('handles advisory mode when ticket is missing', () => {
      const res = validateTicketLinkage({
        title: 'chore: typo fix',
        body: 'no ticket here',
        config: { ...defaultConfig, required: false },
      });

      expect(res.valid).toBe(true);
      expect(res.mode).toBe('advisory');
      expect(res.ticketsFound).toEqual([]);
    });

    it('handles strict mode when ticket is missing', () => {
      const res = validateTicketLinkage({
        title: 'chore: typo fix',
        body: 'no ticket here',
        config: defaultConfig,
      });

      expect(res.valid).toBe(false);
      expect(res.mode).toBe('strict');
      expect(res.error).toBeDefined();
    });

    it('handles ticket key length limits (1 char prefix vs 15 char prefix)', () => {
      const shortPrefix = validateTicketLinkage({
        title: 'A-123',
        body: '',
        config: defaultConfig,
      });

      const longPrefix = validateTicketLinkage({
        title: 'SUPERLONGPREFIXNAME-123',
        body: '',
        config: defaultConfig,
      });

      console.log('[TEST LOG] Short prefix (A-123):', shortPrefix.ticketsFound);
      console.log('[TEST LOG] Long prefix (SUPERLONGPREFIXNAME-123):', longPrefix.ticketsFound);
    });
  });

  // =========================================================================
  // 3. CONSTITUTION ENGINE STRESS TESTS
  // =========================================================================
  describe('Constitution Engine Edge & Stress Cases', () => {
    it('parses complex markdown constitution with various list formats and headings', () => {
      const md = `
# Engineering Constitution

## 1. Forbidden Patterns
- Never use \`console.log\` in production code \`/console\\.log/g\`
* Do not use \`eval()\` anywhere \`/eval\\(/g\`
+ Prohibit hardcoded passwords \`/password\\s*=\\s*['"][^'"]+['"]/i\`

### 2. Directives & Rules
1. PR description must contain detailed testing steps
- [ ] All database queries must be indexed \`/SELECT.*FROM/i\`
- [x] Must include unit tests for new modules

#### 3. Unhandled Heading Level
- Some item under h4
`;

      const parsed = parseConstitution(md);
      console.log('[TEST LOG] Parsed constitution rules:', parsed.rules.map(r => ({ id: r.id, type: r.type, desc: r.description, hasPattern: !!r.pattern })));
      expect(parsed.rules.length).toBeGreaterThan(0);
    });

    it('tests regex extraction with escaped slashes in backticks e.g. `/\\/api\\/v1\\//`', () => {
      const md = `
## Forbidden
- Do not call v1 API \`/\/api\/v1\//\`
`;
      const parsed = parseConstitution(md);
      console.log('[TEST LOG] Escaped slash regex pattern:', parsed.rules[0]?.pattern);
    });

    it('evaluates constitution rule violation for forbidden pattern with regex', () => {
      const md = `
## Forbidden
- Prohibit console.log \`/console\\.log/g\`
`;
      const parsed = parseConstitution(md);
      const evalRes = evaluateConstitution({
        constitution: parsed,
        prTitle: 'feat: new feature',
        prBody: 'impl details',
        changedFiles: [
          { path: 'src/index.ts', content: 'console.log("hello world");' }
        ],
      });

      expect(evalRes.compliant).toBe(false);
      expect(evalRes.violations.length).toBe(1);
    });

    it('evaluates constitution rule violation for forbidden pattern without regex (string match fallback)', () => {
      const md = `
## Forbidden Patterns
- Prohibit console.log usage
- Never use eval
`;
      const parsed = parseConstitution(md);
      const evalRes = evaluateConstitution({
        constitution: parsed,
        prTitle: 'feat: add eval',
        prBody: 'uses eval()',
        changedFiles: [
          { path: 'src/index.ts', content: 'eval("2 + 2");' }
        ],
      });

      console.log('[TEST LOG] String match fallback violation res:', evalRes);
    });

    it('evaluates directive rules (e.g. PR description missing)', () => {
      const md = `
## Directives
- PR description must contain adequate detail
`;
      const parsed = parseConstitution(md);
      const evalRes = evaluateConstitution({
        constitution: parsed,
        prTitle: 'feat: test',
        prBody: 'short', // less than 10 chars
      });

      console.log('[TEST LOG] Directive PR description test res:', evalRes);
    });

    it('handles empty or non-string constitution markdown', () => {
      const parsedEmpty = parseConstitution('');
      expect(parsedEmpty.rules).toEqual([]);

      // @ts-ignore
      const parsedNull = parseConstitution(null);
      expect(parsedNull.rules).toEqual([]);
    });

    it('handles stateful regex pattern evaluation across multiple files (lastIndex bug check)', () => {
      const md = `
## Forbidden
- No TODO comments \`/TODO/g\`
`;
      const parsed = parseConstitution(md);
      const evalRes = evaluateConstitution({
        constitution: parsed,
        prTitle: 'feat: test',
        prBody: 'body',
        changedFiles: [
          { path: 'src/file1.ts', content: '// TODO: fix' },
          { path: 'src/file2.ts', content: '// TODO: another fix' },
          { path: 'src/file3.ts', content: '// TODO: third fix' },
        ],
      });

      console.log('[TEST LOG] Stateful regex across multiple files violations count:', evalRes.violations.length);
      expect(evalRes.violations.length).toBe(3);
    });
  });
});
