import { parseAndValidateConfig, ConfigValidationError, deepMergeConfig, convertCodeRabbitConfig } from '../../src/config/configLoader';
import { validateTicketLinkage, TICKET_PATTERNS } from '../../src/ticket/ticketValidator';
import { parseConstitution, evaluateConstitution } from '../../src/constitution/constitutionEngine';

console.log('================================================================');
console.log('  MILESTONE 1 EMPIRICAL STRESS TEST SUITE (CHALLENGER 1 GEN 2)');
console.log('================================================================\n');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const findings: string[] = [];

function assert(condition: boolean, testName: string, failureDetail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failedTests++;
    console.log(`  ❌ FAIL: ${testName}`);
    if (failureDetail) {
      console.log(`     Detail: ${failureDetail}`);
    }
    findings.push(`[${testName}] ${failureDetail || 'Assertion failed'}`);
  }
}

// -----------------------------------------------------------------------------
// 1. CONFIG PARSER STRESS TESTS
// -----------------------------------------------------------------------------
console.log('--- 1. CONFIG PARSER STRESS TESTS ---');

// Test 1.1: Malformed YAML syntax
try {
  parseAndValidateConfig('quorum:\n  minApprovals: : invalid');
  assert(false, 'ConfigParser: Malformed YAML syntax throws ConfigValidationError', 'Did not throw');
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: Malformed YAML syntax throws ConfigValidationError');
}

// Test 1.2: YAML Array root `[1, 2, 3]`
try {
  const result = parseAndValidateConfig('- item1\n- item2');
  const isDefaultObj = result.version === '1.0' && result.quorum.minApprovals === 2;
  assert(isDefaultObj, 'ConfigParser: YAML Array root handled gracefully', `Returned: ${JSON.stringify(result)}`);
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: YAML Array root throws validation error');
}

// Test 1.3: Schema type mismatches
// 1.3a: minApprovals string
try {
  parseAndValidateConfig('quorum:\n  minApprovals: "2"');
  assert(false, 'ConfigParser: Reject string minApprovals "2"', 'Allowed string for minApprovals');
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: Reject string minApprovals "2"');
}

// 1.3b: minApprovals 0
try {
  parseAndValidateConfig('quorum:\n  minApprovals: 0');
  assert(false, 'ConfigParser: Reject minApprovals 0', 'Allowed 0 minApprovals');
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: Reject minApprovals 0');
}

// 1.3c: minApprovals negative
try {
  parseAndValidateConfig('quorum:\n  minApprovals: -1');
  assert(false, 'ConfigParser: Reject negative minApprovals', 'Allowed negative minApprovals');
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: Reject negative minApprovals');
}

// 1.3d: invalid persona
try {
  parseAndValidateConfig('quorum:\n  personas:\n    - hacker');
  assert(false, 'ConfigParser: Reject invalid persona "hacker"', 'Allowed invalid persona');
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: Reject invalid persona "hacker"');
}

// 1.3e: empty personas array
try {
  parseAndValidateConfig('quorum:\n  personas: []');
  assert(false, 'ConfigParser: Reject empty personas array', 'Allowed empty personas array');
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: Reject empty personas array');
}

// 1.3f: invalid provider
try {
  parseAndValidateConfig('ticketEnforcement:\n  providers:\n    - bitbucket');
  assert(false, 'ConfigParser: Reject invalid provider "bitbucket"', 'Allowed invalid provider');
} catch (err: any) {
  assert(err instanceof ConfigValidationError, 'ConfigParser: Reject invalid provider "bitbucket"');
}


// -----------------------------------------------------------------------------
// 2. TICKET LINKAGE ENGINE STRESS TESTS
// -----------------------------------------------------------------------------
console.log('\n--- 2. TICKET LINKAGE ENGINE STRESS TESTS ---');

const defaultConfig = {
  required: true,
  providers: ['linear', 'jira', 'github'] as ('linear' | 'jira' | 'github')[],
  patterns: [],
};

// Test 2.1: Mixed uppercase tickets
const res21 = validateTicketLinkage({
  title: 'feat: add auth [PROJ-123] and [KEY-456]',
  body: 'Closes #789 and LINEAR-999',
  config: defaultConfig,
});
assert(
  res21.valid && ['PROJ-123', 'KEY-456', '#789', 'LINEAR-999'].every(t => res21.ticketsFound.includes(t)),
  'TicketEngine: Extracts mixed uppercase tickets ([PROJ-123], [KEY-456], #789, LINEAR-999)',
  `Found: ${JSON.stringify(res21.ticketsFound)}`
);

// Test 2.2: Lowercase ticket keys (proj-123, key-456, linear-999)
const res22 = validateTicketLinkage({
  title: 'fix: resolves proj-123 and key-456',
  body: 'See linear-999 for details',
  config: defaultConfig,
});
const foundProj123 = res22.ticketsFound.includes('PROJ-123') || res22.ticketsFound.includes('proj-123');
assert(
  foundProj123,
  'TicketEngine: Handles lowercase ticket keys (proj-123, key-456)',
  `Found: ${JSON.stringify(res22.ticketsFound)}`
);

// Test 2.3: Tickets in parentheses (#789)
const res23 = validateTicketLinkage({
  title: 'fix: security patch (#789)',
  body: 'Resolves issue',
  config: defaultConfig,
});
assert(
  res23.ticketsFound.includes('#789'),
  'TicketEngine: Handles ticket in parentheses "(#789)"',
  `Found: ${JSON.stringify(res23.ticketsFound)}`
);

// Test 2.4: Tickets in brackets [#789]
const res24 = validateTicketLinkage({
  title: 'fix: security patch [#789]',
  body: '',
  config: defaultConfig,
});
assert(
  res24.ticketsFound.includes('#789'),
  'TicketEngine: Handles ticket in brackets "[#789]"',
  `Found: ${JSON.stringify(res24.ticketsFound)}`
);

// Test 2.5: Tickets in URLs (https://jira.company.com/browse/PROJ-100)
const res25 = validateTicketLinkage({
  title: 'docs: update spec',
  body: 'Ref https://jira.company.com/browse/PROJ-100',
  config: defaultConfig,
});
assert(
  res25.ticketsFound.includes('PROJ-100'),
  'TicketEngine: Extracts tickets embedded in URL',
  `Found: ${JSON.stringify(res25.ticketsFound)}`
);

// Test 2.6: Long ticket prefix (SUPERLONGPREFIXNAME-123)
const res26 = validateTicketLinkage({
  title: 'feat: SUPERLONGPREFIXNAME-123 feature',
  body: '',
  config: defaultConfig,
});
assert(
  res26.ticketsFound.includes('SUPERLONGPREFIXNAME-123'),
  'TicketEngine: Handles ticket prefix length > 10 chars',
  `Found: ${JSON.stringify(res26.ticketsFound)}`
);

// Test 2.7: Invalid custom regex pattern handling
const res27 = validateTicketLinkage({
  title: 'feat: TICKET-101',
  body: '',
  config: {
    required: true,
    providers: [],
    patterns: ['[unclosed-bracket-regex'],
  },
});
assert(
  res27.valid === false,
  'TicketEngine: Invalid custom regex handled gracefully without crashing',
  `Result: valid=${res27.valid}, error=${res27.error}`
);


// -----------------------------------------------------------------------------
// 3. CONSTITUTION ENGINE STRESS TESTS
// -----------------------------------------------------------------------------
console.log('\n--- 3. CONSTITUTION ENGINE STRESS TESTS ---');

// Test 3.1: H1 Heading treated as title vs heading section
const mdH1 = `
# Forbidden Rules
- Do not use console.log \`/console\\.log/g\`
`;
const parsedH1 = parseConstitution(mdH1);
const ruleH1Type = parsedH1.rules[0]?.type;
assert(
  ruleH1Type === 'forbidden_pattern',
  'ConstitutionEngine: H1 heading handled as title or correctly classifies rules',
  `Title="${parsedH1.title}", Rule type="${ruleH1Type}"`
);

// Test 3.2: Regex with escaped slashes in backticks e.g. `/\/api\/v1\//`
const mdEscapedSlash = '## Forbidden\n- Do not call v1 API `' + '/\\' + '/api\\' + '/v1\\' + '//`';
const parsedEscapedSlash = parseConstitution(mdEscapedSlash);
const patternEscaped = parsedEscapedSlash.rules[0]?.pattern;
assert(
  patternEscaped !== undefined && patternEscaped.test('/api/v1/'),
  'ConstitutionEngine: Parses backtick regex with escaped slashes `/\/api\/v1\//`',
  `Pattern extracted: ${patternEscaped ? patternEscaped.toString() : 'undefined'}`
);

// Test 3.3: Forbidden pattern without regex (string match fallback for non-console.log)
const mdNoRegex = `
## Forbidden
- Never use eval in code
- Prohibit hardcoded JWT secrets
`;
const parsedNoRegex = parseConstitution(mdNoRegex);
const evalNoRegex = evaluateConstitution({
  constitution: parsedNoRegex,
  prTitle: 'feat: add feature',
  prBody: 'impl',
  changedFiles: [
    { path: 'src/auth.ts', content: 'const secret = "hardcoded_jwt_secret"; eval(req);' }
  ],
});
assert(
  evalNoRegex.compliant === false,
  'ConstitutionEngine: Enforces non-regex forbidden rules (e.g. eval, hardcoded secrets)',
  `Compliant=${evalNoRegex.compliant}, Violations=${JSON.stringify(evalNoRegex.violations)}`
);

// Test 3.4: Indented bullet points / nested lists
const mdIndented = `
## Directives
  - PR description must contain full breakdown
  - Must include unit tests
`;
const parsedIndented = parseConstitution(mdIndented);
assert(
  parsedIndented.rules.length === 2,
  'ConstitutionEngine: Parses indented list items',
  `Found rules count: ${parsedIndented.rules.length}`
);

// Test 3.5: Directive rule matching for non-hardcoded wording
const mdDirectiveCustom = `
## Directives
- Every pull request must include unit tests
`;
const parsedDirectiveCustom = parseConstitution(mdDirectiveCustom);
const evalDirectiveCustom = evaluateConstitution({
  constitution: parsedDirectiveCustom,
  prTitle: 'feat: small change',
  prBody: 'short',
});
assert(
  evalDirectiveCustom.violations.length > 0,
  'ConstitutionEngine: Evaluates general directive rules',
  `Violations=${JSON.stringify(evalDirectiveCustom.violations)}`
);

// Test 3.6: Multiple file regex evaluation state (lastIndex statefulness across files)
const mdLastIndex = `
## Forbidden
- No TODO comments \`/TODO/g\`
`;
const parsedLastIndex = parseConstitution(mdLastIndex);
const evalLastIndex = evaluateConstitution({
  constitution: parsedLastIndex,
  prTitle: 'feat: title',
  prBody: 'body',
  changedFiles: [
    { path: 'file1.ts', content: '// TODO 1' },
    { path: 'file2.ts', content: '// TODO 2' },
    { path: 'file3.ts', content: '// TODO 3' },
  ],
});
assert(
  evalLastIndex.violations.length === 3,
  'ConstitutionEngine: Evaluates global regex across multiple files consistently',
  `Violations count: ${evalLastIndex.violations.length} out of 3 expected`
);

console.log('\n================================================================');
console.log(`  SUMMARY: Total=${totalTests}, Passed=${passedTests}, Failed=${failedTests}`);
console.log('================================================================\n');

if (findings.length > 0) {
  console.log('FINDINGS & BUGS DISCOVERED:');
  findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}

process.exit(failedTests > 0 ? 1 : 0);
