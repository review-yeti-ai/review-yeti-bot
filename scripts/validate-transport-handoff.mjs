import { readFileSync } from 'node:fs';
import { resolvePolicyForRepository } from './repository-policy.mjs';

const policyPath = process.env.REVIEW_YETI_POLICY_PATH
  || new URL('../policy/review-yeti.json', import.meta.url);
const encodedPlan = process.env.TRANSPORT_PLAN_B64;

if (!encodedPlan) throw new Error('TRANSPORT_PLAN_B64 is required');

let policy;
let plan;
try {
  policy = resolvePolicyForRepository(
    JSON.parse(readFileSync(policyPath, 'utf8')),
    process.env.REVIEW_REPOSITORY || '',
  );
} catch (error) {
  throw new Error(`could not read Review Yeti policy: ${error.message}`);
}
try {
  const decodedPlan = Buffer.from(encodedPlan, 'base64');
  if (decodedPlan.toString('base64') !== encodedPlan) {
    throw new Error('transport handoff must be canonical base64');
  }
  plan = JSON.parse(decodedPlan.toString('utf8'));
} catch (error) {
  if (error.message === 'transport handoff must be canonical base64') throw error;
  throw new Error(`could not decode transport handoff: ${error.message}`);
}

const configuredPolicyTransports = policy.review_yeti?.transports;
if (!Array.isArray(configuredPolicyTransports) || configuredPolicyTransports.length === 0) {
  throw new Error('policy must define at least one transport');
}
if (configuredPolicyTransports.some((transport) => typeof transport?.enabled !== 'boolean')) {
  throw new Error('every policy transport must declare enabled as a boolean');
}
const policyTransports = Array.isArray(configuredPolicyTransports)
  ? configuredPolicyTransports.filter((transport) => transport.enabled === true)
  : configuredPolicyTransports;
if (!Array.isArray(policyTransports) || policyTransports.length === 0) {
  throw new Error('policy must enable at least one transport');
}
if (!Array.isArray(plan) || plan.length === 0) {
  throw new Error('transport handoff must contain at least one transport');
}

const names = plan.map((entry) => entry?.name);
if (names.some((name) => typeof name !== 'string' || name.length === 0)) {
  throw new Error('every transport must have a name');
}
if (new Set(names).size !== names.length) {
  throw new Error('transport names must be unique');
}
if (plan.some((entry) => entry?.stream !== true)) {
  throw new Error('all transports must stream');
}
for (const key of ['timeout_ms', 'connect_timeout_ms', 'ttft_ms', 'stall_ms']) {
  if (plan.some((entry) => !Number.isSafeInteger(entry?.[key]) || entry[key] < 1)) {
    throw new Error(`every transport must carry ${key} as a positive safe integer`);
  }
}
if (process.env.ALLOW_POLICY_SUBSET === 'true') {
  const admittedPolicyTransports = policyTransports.filter((transport) => names.includes(transport.name));
  const quotaBoundSubset = plan.length === admittedPolicyTransports.length
    && plan.every((transport, index) => {
      const configured = admittedPolicyTransports[index];
      if (JSON.stringify(transport) === JSON.stringify(configured)) return true;
      if (configured?.quota_probe !== 'synthetic-v2'
          || transport?.name !== configured.name
          || !Number.isSafeInteger(transport.max_in_flight)
          || transport.max_in_flight < 1
          || transport.max_in_flight > configured.max_in_flight) {
        return false;
      }
      return JSON.stringify(transport) === JSON.stringify({
        ...configured,
        max_in_flight: transport.max_in_flight,
      });
    });
  if (!quotaBoundSubset) {
    throw new Error('admitted transport handoff is not an exact ordered subset of policy');
  }
} else if (JSON.stringify(plan) !== JSON.stringify(policyTransports)) {
  throw new Error('transport handoff does not exactly match policy');
}
if (plan.some((entry) => ['connect_timeout_ms', 'ttft_ms', 'stall_ms']
  .some((key) => entry[key] > entry.timeout_ms))) {
  throw new Error('transport handoff deadlines must not exceed timeout_ms');
}

console.log(`transport_plan_entries=${plan.length} stream=true`);
