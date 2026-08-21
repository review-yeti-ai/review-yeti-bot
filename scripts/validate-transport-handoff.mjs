import { readFileSync } from 'node:fs';

const policyPath = process.env.REVIEW_YETI_POLICY_PATH
  || new URL('../policy/review-yeti.json', import.meta.url);
const encodedPlan = process.env.TRANSPORT_PLAN_B64;

if (!encodedPlan) throw new Error('TRANSPORT_PLAN_B64 is required');

let policy;
let plan;
try {
  policy = JSON.parse(readFileSync(policyPath, 'utf8'));
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

const policyTransports = policy.review_yeti?.transports;
if (!Array.isArray(policyTransports) || policyTransports.length === 0) {
  throw new Error('policy must define at least one transport');
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
if (process.env.ALLOW_POLICY_SUBSET === 'true') {
  const admittedPolicyTransports = policyTransports.filter((transport) => names.includes(transport.name));
  if (JSON.stringify(plan) !== JSON.stringify(admittedPolicyTransports)) {
    throw new Error('admitted transport handoff is not an exact ordered subset of policy');
  }
} else if (JSON.stringify(plan) !== JSON.stringify(policyTransports)) {
  throw new Error('transport handoff does not exactly match policy');
}

console.log(`transport_plan_entries=${plan.length} stream=true`);
