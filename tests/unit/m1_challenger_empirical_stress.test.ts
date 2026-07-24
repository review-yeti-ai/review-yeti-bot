import { describe, it, expect } from 'vitest';
import { parseAndValidateConfig, ConfigValidationError, deepMergeConfig, convertCodeRabbitConfig } from '../../src/config/configLoader';
import { DEFAULT_ORG_CONFIG } from '../../src/config/defaultOrgConfig';
import { validateTicketLinkage } from '../../src/ticket/ticketValidator';
import { parseConstitution, evaluateConstitution } from '../../src/constitution/constitutionEngine';

describe('Challenger M1 Empirical Stress Test Suite', () => {

  describe('1. Config Loader Empirical Stress Tests', () => {
    it('1.1 Malformed YAML syntax throws ConfigValidationError', () => {
      const malformedCases = [
        'quorum:\n  minApprovals: [unclosed bracket',
        'key: "unclosed string',
        ': invalid mapping:',
        '{ bad yaml: [ 1, 2, }',
        'quorum: : : invalid',
      ];

      for (const yamlContent of malformedCases) {
        expect(() => parseAndValidateConfig(yamlContent), `Failed to reject malformed YAML: ${yamlContent}`).toThrow(ConfigValidationError);
      }
    });

    it('1.2 Invalid Zod schema values throw ConfigValidationError', () => {
      const invalidSchemas = [
        'quorum:\n  minApprovals: 0',
        'quorum:\n  minApprovals: -5',
        'quorum:\n  minApprovals: 3.14',
        'quorum:\n  personas: ["invalid_persona"]',
        'quorum:\n  personas: []',
        'quorum:\n  effortLevel: "ultra_high"',
        'ticketEnforcement:\n  providers: ["bitbucket"]',
      ];

      for (const yamlContent of invalidSchemas) {
        expect(() => parseAndValidateConfig(yamlContent), `Failed to reject invalid schema: ${yamlContent}`).toThrow(ConfigValidationError);
      }
    });

    it('1.3 Handles primitive, null, and scalar YAML documents gracefully, rejecting arrays', () => {
      const scalarYamls = [
        'just a string',
        '12345',
        'true',
        'null',
        '~',
      ];

      for (const scalarYaml of scalarYamls) {
        const config = parseAndValidateConfig(scalarYaml);
        expect(config.quorum.minApprovals).toBe(DEFAULT_ORG_CONFIG.quorum.minApprovals);
        expect(config.quorum.effortLevel).toBe(DEFAULT_ORG_CONFIG.quorum.effortLevel);
      }

      expect(() => parseAndValidateConfig('- item1\n- item2')).toThrow(ConfigValidationError);
    });

    it('1.4 CodeRabbit config conversion handles all profiles and missing sections', () => {
      expect(convertCodeRabbitConfig({})).toEqual({});

      const chillRes = convertCodeRabbitConfig({ reviews: { profile: 'chill' } });
      expect(chillRes.quorum?.effortLevel).toBe('low');

      const assertiveRes = convertCodeRabbitConfig({ reviews: { profile: 'assertive' } });
      expect(assertiveRes.quorum?.effortLevel).toBe('high');

      const customRes = convertCodeRabbitConfig({ reviews: { profile: 'balanced' } });
      expect(customRes.quorum?.effortLevel).toBe('medium');

      const emptyReviews = convertCodeRabbitConfig({ reviews: {} });
      expect(emptyReviews.quorum?.effortLevel).toBe('medium');
    });

    it('1.5 deepMergeConfig preserves source defaults when target specifies undefined/null', () => {
      const target = {
        quorum: {
          minApprovals: undefined,
          effortLevel: null,
        },
      };
      const source = DEFAULT_ORG_CONFIG;
      const merged = deepMergeConfig(target, source);

      expect(merged.quorum.minApprovals).toBe(2);
      expect(merged.quorum.effortLevel).toBe('medium');
    });
  });

  describe('2. Ticket Linkage Engine Empirical Stress Tests', () => {
    const baseConfig = {
      required: true,
      providers: ['linear', 'jira', 'github'] as ('linear' | 'jira' | 'github')[],
      patterns: [],
    };

    it('2.1 Complex bracketed ticket formats are correctly extracted', () => {
      const bracketTestCases = [
        { text: '[PROJ-123]', expected: 'PROJ-123' },
        { text: '[[PROJ-456]]', expected: 'PROJ-456' },
        { text: '[PROJ-789: Implement auth]', expected: 'PROJ-789' },
        { text: '[PROJ-101/fix-bug]', expected: 'PROJ-101' },
        { text: '[#123]', expected: '#123' },
        { text: '(#456)', expected: '#456' },
        { text: '[acme/repo#789]', expected: 'acme/repo#789' },
        { text: '[GH-999]', expected: 'GH-999' },
      ];

      for (const tc of bracketTestCases) {
        const result = validateTicketLinkage({
          title: tc.text,
          body: '',
          config: baseConfig,
        });
        expect(result.valid).toBe(true);
        expect(result.ticketsFound, `Failed to extract ticket from ${tc.text}`).toContain(tc.expected);
      }
    });

    it('2.2 Handles custom patterns with escaped dots, slashes, and backslashes', () => {
      const customConfig = {
        ...baseConfig,
        patterns: [
          '\\[RELEASE-\\d+\\.\\d+\\\]',
          'FEATURE\\/\\d+',
          'CUSTOM-\\d+',
        ],
      };

      const result = validateTicketLinkage({
        title: 'feat: deploy [RELEASE-1.0] and FEATURE/42',
        body: 'Refers to CUSTOM-99',
        config: customConfig,
      });

      expect(result.valid).toBe(true);
      expect(result.ticketsFound).toContain('[RELEASE-1.0]');
      expect(result.ticketsFound).toContain('FEATURE/42');
      expect(result.ticketsFound).toContain('CUSTOM-99');
    });

    it('2.3 Invalid regexes in config.patterns do not crash ticket validation', () => {
      const invalidPatternConfig = {
        ...baseConfig,
        patterns: [
          '[unclosed bracket',
          '(unclosed paren',
          '*invalid_start_quantifier',
          'VALID-\\d+',
        ],
      };

      expect(() => {
        const result = validateTicketLinkage({
          title: 'feat: reference VALID-123 ticket',
          body: 'Testing resilience to bad regex patterns in config',
          config: invalidPatternConfig,
        });

        expect(result.valid).toBe(true);
        expect(result.ticketsFound).toContain('VALID-123');
      }).not.toThrow();
    });

    it('2.4 Prefix length boundaries (<=32 chars vs >32 chars)', () => {
      const char32 = 'A'.repeat(32) + '-100'; // 32 prefix chars
      const char33 = 'A'.repeat(33) + '-200'; // 33 prefix chars

      const result32 = validateTicketLinkage({
        title: `feat: ticket ${char32}`,
        body: '',
        config: baseConfig,
      });
      expect(result32.ticketsFound).toContain(char32);

      const result33 = validateTicketLinkage({
        title: `feat: ticket ${char33}`,
        body: '',
        config: baseConfig,
      });
      expect(result33.ticketsFound).not.toContain(char33);
    });

    it('2.5 Empty and invalid input fields return valid: false in strict mode', () => {
      const emptyResult = validateTicketLinkage({
        title: '',
        body: '',
        config: baseConfig,
      });

      expect(emptyResult.valid).toBe(false);
      expect(emptyResult.ticketsFound).toEqual([]);
      expect(emptyResult.mode).toBe('strict');
      expect(emptyResult.error).toContain('No ticket linkage found');
    });
  });

  describe('3. Operational Constitution Engine Empirical Stress Tests', () => {
    it('3.1 Parses backtick regexes with escaped slashes, dots, and flags', () => {
      const markdown = `
# Security Constitution

## Forbidden Patterns
- Prohibit hardcoded local URLs \`/http:\\/\\/localhost:\\d+\\/\`.
- Prohibit API route leaks \`/\\/api\\/v[0-9]+\\/\`.
- Prohibit dot env file references \`/\\.env(\\.\\w+)?$/i\`.
`;

      const parsed = parseConstitution(markdown);
      expect(parsed.rules).toHaveLength(3);

      const rule1 = parsed.rules[0];
      const rule2 = parsed.rules[1];
      const rule3 = parsed.rules[2];

      expect(rule1.pattern).toBeDefined();
      expect(rule1.pattern?.test('http://localhost:8080/')).toBe(true);

      expect(rule2.pattern).toBeDefined();
      expect(rule2.pattern?.test('/api/v2/')).toBe(true);

      expect(rule3.pattern).toBeDefined();
      expect(rule3.pattern?.test('.env.local')).toBe(true);
    });

    it('3.2 Invalid regexes in backticks handle RegExp compilation error gracefully', () => {
      const malformedRegexMd = `
# Bad Regex Constitution

## Forbidden Patterns
- Broken regex 1 \`/(unclosed_paren/\`
- Broken regex 2 \`/[a-z/\`
- Broken regex 3 \`/*bad_quantifier/\`
- Valid regex \`/valid_pattern/\`
`;

      let parsed: ReturnType<typeof parseConstitution> | undefined;
      expect(() => {
        parsed = parseConstitution(malformedRegexMd);
      }).not.toThrow();

      expect(parsed).toBeDefined();
      expect(parsed?.rules).toHaveLength(4);

      const brokenRule1 = parsed?.rules[0];
      const validRule = parsed?.rules[3];

      expect(brokenRule1?.pattern).toBeUndefined();
      expect(validRule?.pattern).toBeDefined();
      expect(validRule?.pattern?.test('valid_pattern')).toBe(true);
    });

    it('3.3 Evaluates all bullet point formats (- , * , + , 1. , - [ ])', () => {
      const multiBulletMd = `
# Multi-bullet Rules

## Forbidden Patterns
- Hyphen rule \`/forbidden_hyphen/\`
* Asterisk rule \`/forbidden_asterisk/\`
+ Plus rule \`/forbidden_plus/\`
1. Numbered rule \`/forbidden_numbered/\`
- [ ] Checkbox rule \`/forbidden_checkbox/\`
`;

      const parsed = parseConstitution(multiBulletMd);
      expect(parsed.rules).toHaveLength(5);

      for (const rule of parsed.rules) {
        expect(rule.pattern).toBeDefined();
        expect(rule.type).toBe('forbidden_pattern');
      }
    });

    it('3.4 Evaluates bypass flag (config.enabled = false)', () => {
      const markdown = `
# Security Policy
## Forbidden Patterns
- Prohibit eval \`/eval\\(.*?\\)/\`.
`;

      const parsed = parseConstitution(markdown);
      const result = evaluateConstitution({
        constitution: parsed,
        config: { enabled: false },
        changedFiles: [{ path: 'src/bad.ts', content: 'eval("1+1")' }],
      });

      expect(result.compliant).toBe(true);
      expect(result.bypassed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('3.5 Evaluates conventional commit titles and description directives', () => {
      const directiveMd = `
# PR Rules
## Directives
- MUST: PR title must follow conventional commits format.
- MUST: PR description must contain testing steps.
- MUST: PR description must include risk assessment.
`;

      const parsed = parseConstitution(directiveMd);

      const failingResult = evaluateConstitution({
        constitution: parsed,
        prTitle: 'bad title format',
        prBody: 'Short description',
      });

      expect(failingResult.compliant).toBe(false);
      expect(failingResult.violations).toHaveLength(3);

      const passingResult = evaluateConstitution({
        constitution: parsed,
        prTitle: 'feat(api): add new authentication endpoint',
        prBody: 'Comprehensive description containing testing steps and risk assessment details.',
      });

      expect(passingResult.compliant).toBe(true);
      expect(passingResult.violations).toEqual([]);
    });
  });
});
