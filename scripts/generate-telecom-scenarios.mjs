#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { HAYSTACK_SCENARIOS } from './telecom-scenarios/haystack.mjs';
import { CROSS_MODULE_SCENARIOS } from './telecom-scenarios/crossModule.mjs';
import { RACE_SCENARIOS } from './telecom-scenarios/races.mjs';
import { TRAP_SCENARIOS } from './telecom-scenarios/traps.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const { changedLineNumbers, sanitizeFindings, computeArbitration } = require('../src/review/reviewCore.js');
const { formatUnifiedDiff, validateScenario } = require('../src/evaluation/scenarios.ts');

const ALL_NEW_SCENARIOS = [
  ...HAYSTACK_SCENARIOS,
  ...CROSS_MODULE_SCENARIOS,
  ...RACE_SCENARIOS,
  ...TRAP_SCENARIOS,
];

console.log(`Loaded ${ALL_NEW_SCENARIOS.length} new evaluation scenarios.`);

if (ALL_NEW_SCENARIOS.length !== 96) {
  throw new Error(`Expected exactly 96 new scenarios, got ${ALL_NEW_SCENARIOS.length}`);
}

// 1. Verify PR number sequencing
for (let i = 0; i < 96; i++) {
  const expectedPr = 2101 + i;
  const s = ALL_NEW_SCENARIOS[i];
  if (s.prContext.prNumber !== expectedPr) {
    throw new Error(`Scenario index ${i} has PR number ${s.prContext.prNumber}, expected ${expectedPr}`);
  }
}

// 2. Validate each scenario thoroughly
for (const scenario of ALL_NEW_SCENARIOS) {
  const v = validateScenario(scenario);
  if (!v.valid) {
    throw new Error(`Scenario ${scenario.id} failed validation: ${v.errors.join(', ')}`);
  }

  // Check finding lines in diff changed lines
  for (const finding of scenario.expectedFindings) {
    const file = scenario.diffFiles.find(f => f.path === finding.path);
    if (!file) {
      throw new Error(`Scenario ${scenario.id}: Finding path ${finding.path} not in diffFiles`);
    }
    if (typeof finding.line === 'number') {
      const changed = changedLineNumbers(file.patch);
      if (!changed || !changed.has(finding.line)) {
        throw new Error(`Scenario ${scenario.id}: Finding line ${finding.line} in ${finding.path} is not in diff added lines! Changed lines: ${Array.from(changed || [])}`);
      }
    }
  }

  // Test sanitizeFindings
  const rawFindings = scenario.expectedFindings.map(ef => ({
    severity: ef.severity,
    path: ef.path,
    line: ef.line || 1,
    title: ef.title || 'Ground truth finding',
    body: ef.description || 'Ground truth description',
  }));
  const sanitized = sanitizeFindings(rawFindings, scenario.diffFiles);
  if (sanitized.length !== scenario.expectedFindings.length) {
    throw new Error(`Scenario ${scenario.id}: sanitizeFindings dropped findings (${sanitized.length} vs ${scenario.expectedFindings.length})`);
  }

  // Test arbitration verdict
  const personaResults = [
    {
      persona: 'synthetic-reviewer',
      status: 'SUCCESS',
      findings: sanitized,
    },
  ];
  const arb = computeArbitration(personaResults, 1, { changedFiles: scenario.diffFiles });
  if (arb.verdict !== scenario.expectedVerdict) {
    throw new Error(`Scenario ${scenario.id}: Arbitration verdict ${arb.verdict} does not match expectedVerdict ${scenario.expectedVerdict}`);
  }
}

console.log('All 96 scenarios passed all ground-truth validation checks!');

// 3. Generate .diff files in tests/fixtures/scenarios/
const fixturesDir = path.join(projectRoot, 'tests/fixtures/scenarios');
let fixturesWritten = 0;

for (const scenario of ALL_NEW_SCENARIOS) {
  const formattedUnified = formatUnifiedDiff(scenario.diffFiles).trimEnd() + '\n';
  
  // Write <id>.diff
  const idPath = path.join(fixturesDir, `${scenario.id}.diff`);
  fs.writeFileSync(idPath, formattedUnified, 'utf8');
  
  // Write <prNumber>.diff
  const prPath = path.join(fixturesDir, `${scenario.prContext.prNumber}.diff`);
  fs.writeFileSync(prPath, formattedUnified, 'utf8');
  
  fixturesWritten += 2;
}

console.log(`Generated ${fixturesWritten} diff fixture files in ${fixturesDir}`);

// 4. Update src/evaluation/scenarios.ts with all 96 scenarios
const scenariosTsPath = path.join(projectRoot, 'src/evaluation/scenarios.ts');
let scenariosTs = fs.readFileSync(scenariosTsPath, 'utf8');

// Ensure interface has workspaceRoot and requiredToolQueries
if (!scenariosTs.includes('workspaceRoot?: string;')) {
  scenariosTs = scenariosTs.replace(
    /export interface EvaluationScenario \{([\s\S]*?)tags\?: string\[\];([\s\S]*?)\}/,
    `export interface EvaluationScenario {$1tags?: string[];\n  workspaceRoot?: string;\n  requiredToolQueries?: Array<{ tool: string; query: string; expectedSubstring?: string }>;$2}`
  );
}

// Convert all 96 scenario objects to formatted TypeScript code
function formatScenarioToTs(s) {
  return JSON.stringify(s, null, 2);
}

// Check if telecom scenarios are already in scenarios.ts
if (!scenariosTs.includes('telecom-haystack-sip-dropped-tenant')) {
  const telecomScenariosCode = `
  // =========================================================================
  // 10. TELECOM BENCHMARK EXPANSION - HAYSTACK REFACTOR DIFFS (PR #2101-#2124)
  // =========================================================================
${HAYSTACK_SCENARIOS.map(s => '  ' + JSON.stringify(s, null, 2) + ',').join('\n')}

  // =========================================================================
  // 11. TELECOM BENCHMARK EXPANSION - CROSS-MODULE CONTRACT BREAKAGES (PR #2125-#2148)
  // =========================================================================
${CROSS_MODULE_SCENARIOS.map(s => '  ' + JSON.stringify(s, null, 2) + ',').join('\n')}

  // =========================================================================
  // 12. TELECOM BENCHMARK EXPANSION - DISTRIBUTED RACE CONDITIONS (PR #2149-#2172)
  // =========================================================================
${RACE_SCENARIOS.map(s => '  ' + JSON.stringify(s, null, 2) + ',').join('\n')}

  // =========================================================================
  // 13. TELECOM BENCHMARK EXPANSION - FALSE POSITIVE & HALLUCINATION TRAPS (PR #2173-#2196)
  // =========================================================================
${TRAP_SCENARIOS.map(s => '  ' + JSON.stringify(s, null, 2) + ',').join('\n')}
`;

  // Insert before `];` that closes `export const EVALUATION_SCENARIOS: EvaluationScenario[] = [`
  // Find the last scenario in EVALUATION_SCENARIOS
  const lastMarker = 'id: "adv-clean-adversarial-hardened-pipeline-ship"';
  const lastIndex = scenariosTs.indexOf(lastMarker);
  if (lastIndex === -1) {
    throw new Error('Could not find last marker in scenarios.ts');
  }
  const closeBracketIndex = scenariosTs.indexOf('];', lastIndex);
  if (closeBracketIndex === -1) {
    throw new Error('Could not find closing bracket in scenarios.ts');
  }

  scenariosTs = scenariosTs.slice(0, closeBracketIndex) + telecomScenariosCode + scenariosTs.slice(closeBracketIndex);

  // Update getScenarioById to also support lookup by prNumber
  if (!scenariosTs.includes('String(s.prContext?.prNumber) === id')) {
    scenariosTs = scenariosTs.replace(
      'return EVALUATION_SCENARIOS.find((s) => s.id === id);',
      'return EVALUATION_SCENARIOS.find((s) => s.id === id || String(s.prContext?.prNumber) === id);'
    );
  }

  fs.writeFileSync(scenariosTsPath, scenariosTs, 'utf8');
  console.log(`Updated ${scenariosTsPath} with 96 new scenarios.`);
} else {
  console.log(`${scenariosTsPath} already contains telecom scenarios.`);
}

console.log('Telecom scenario generation and sync completed successfully!');
