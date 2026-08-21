'use strict';

const { canonicalJson, sha256 } = require('./reviewCore');

const REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA = 'review-yeti-assignment.v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVIEW_UNIT_ID = /^ru_[a-f0-9]{64}$/u;
const MAX_PASSES = 64;
const MAX_REVIEW_UNITS_PER_PASS = 10_000;
const MAX_SCHEMA_BYTES = 256_000;
const PERSONA_FIELDS = new Set(['personaId', 'enabled', 'assignmentPrompt', 'personaResultSchema', 'passes']);
const PASS_FIELDS = new Set(['passId', 'reviewUnitIds', 'prompt', 'outputSchema']);
const ASSIGNMENT_FIELDS = new Set([
  'schema',
  'assignmentId',
  'personaId',
  'passes',
  'assignmentPrompt',
  'assignmentPromptDigest',
  'personaResultSchema',
  'personaResultSchemaDigest',
]);
const ASSIGNMENT_PASS_FIELDS = new Set([
  'passId',
  'reviewUnitIds',
  'prompt',
  'promptDigest',
  'outputSchema',
  'outputSchemaDigest',
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function assertClosedObject(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`unknown ${label} field: ${unknown[0]}`);
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${label} must be a bounded stable identifier`);
}

function assertPrompt(value, label) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 2_000_000) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function canonicalClone(value, label) {
  assertPlainObject(value, label);
  let encoded;
  try {
    encoded = canonicalJson(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof encoded !== 'string') throw new TypeError(`${label} must be JSON serializable`);
  return JSON.parse(encoded);
}

function boundedObjectSchema(value, label) {
  const schema = canonicalClone(value, label);
  if (schema.type !== 'object') throw new TypeError(`${label} must be a top-level object schema`);
  if (schema.additionalProperties !== false) throw new TypeError(`${label} must set additionalProperties to false`);
  if (Buffer.byteLength(canonicalJson(schema), 'utf8') > MAX_SCHEMA_BYTES) throw new TypeError(`${label} exceeds the schema size limit`);
  return schema;
}

function validateReviewUnitIds(reviewUnitIds, label) {
  if (!Array.isArray(reviewUnitIds) || reviewUnitIds.length === 0) throw new TypeError(`${label} requires reviewUnitIds`);
  if (reviewUnitIds.length > MAX_REVIEW_UNITS_PER_PASS) throw new TypeError(`${label} has too many reviewUnitIds`);
  for (const value of reviewUnitIds) {
    if (typeof value !== 'string' || !REVIEW_UNIT_ID.test(value)) throw new TypeError(`${label} contains an invalid reviewUnitId`);
  }
  if (new Set(reviewUnitIds).size !== reviewUnitIds.length) throw new TypeError(`duplicate reviewUnitId in ${label}`);
  return reviewUnitIds;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assignmentIdentityPayload(assignment, policyDigest, manifestDigest) {
  return {
    schema: REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA,
    personaId: assignment.personaId,
    passes: assignment.passes,
    assignmentPromptDigest: assignment.assignmentPromptDigest,
    personaResultSchemaDigest: assignment.personaResultSchemaDigest,
    policyDigest,
    manifestDigest,
  };
}

function createPassDescriptor(pass, personaId) {
  assertClosedObject(pass, PASS_FIELDS, 'pass');
  assertSafeId(pass.passId, 'passId');
  const reviewUnitIds = validateReviewUnitIds(pass.reviewUnitIds, `persona ${personaId} pass ${pass.passId}`);
  assertPrompt(pass.prompt, 'pass prompt');
  const outputSchema = boundedObjectSchema(pass.outputSchema, 'pass outputSchema');
  const descriptor = {
    passId: pass.passId,
    reviewUnitIds,
    prompt: pass.prompt,
    promptDigest: sha256(pass.prompt),
    outputSchema,
    outputSchemaDigest: sha256(canonicalJson(outputSchema)),
  };
  return deepFreeze(descriptor);
}

function createReviewWorkflowAssignments(input) {
  assertPlainObject(input, 'assignment factory input');
  assertDigest(input.policyDigest, 'policyDigest');
  assertDigest(input.manifestDigest, 'manifestDigest');
  if (!Array.isArray(input.personas)) throw new TypeError('personas must be an array');

  const seenPersonas = new Set();
  const enabled = [];
  for (const persona of input.personas) {
    assertClosedObject(persona, PERSONA_FIELDS, 'persona');
    assertSafeId(persona.personaId, 'personaId');
    if (seenPersonas.has(persona.personaId)) throw new TypeError(`duplicate persona: ${persona.personaId}`);
    seenPersonas.add(persona.personaId);
    if (persona.enabled === false) continue;
    if (persona.enabled !== undefined && persona.enabled !== true) throw new TypeError('persona enabled must be boolean');
    assertPrompt(persona.assignmentPrompt, 'assignmentPrompt');
    const personaResultSchema = boundedObjectSchema(persona.personaResultSchema, 'personaResultSchema');
    if (!Array.isArray(persona.passes) || persona.passes.length === 0) throw new TypeError(`persona ${persona.personaId} requires at least one pass`);
    if (persona.passes.length > MAX_PASSES) throw new TypeError(`persona ${persona.personaId} has too many passes`);
    const passes = persona.passes.map((pass) => createPassDescriptor(pass, persona.personaId));
    if (new Set(passes.map((pass) => pass.passId)).size !== passes.length) throw new TypeError(`duplicate pass for persona ${persona.personaId}`);
    const assignment = {
      schema: REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA,
      assignmentId: '',
      personaId: persona.personaId,
      passes,
      assignmentPrompt: persona.assignmentPrompt,
      assignmentPromptDigest: sha256(persona.assignmentPrompt),
      personaResultSchema,
      personaResultSchemaDigest: sha256(canonicalJson(personaResultSchema)),
    };
    assignment.assignmentId = sha256(canonicalJson(assignmentIdentityPayload(assignment, input.policyDigest, input.manifestDigest)));
    enabled.push(deepFreeze(assignment));
  }

  enabled.sort((left, right) => left.personaId.localeCompare(right.personaId, 'en'));
  return deepFreeze(enabled);
}

function validateReviewWorkflowAssignments(assignments, identity = {}) {
  if (!Array.isArray(assignments) || assignments.length === 0 || assignments.length > 16) {
    throw new TypeError('assignments must contain 1..16 immutable persona assignments');
  }
  assertDigest(identity.policyDigest, 'immutableIdentity.policyDigest');
  assertDigest(identity.manifestDigest, 'immutableIdentity.manifestDigest');
  const ids = new Set();
  const personas = new Set();
  for (const assignment of assignments) {
    assertClosedObject(assignment, ASSIGNMENT_FIELDS, 'assignment');
    if (assignment.schema !== REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA) throw new TypeError('unknown assignment schema');
    assertDigest(assignment.assignmentId, 'assignmentId');
    assertSafeId(assignment.personaId, 'personaId');
    if (ids.has(assignment.assignmentId)) throw new TypeError(`duplicate assignment: ${assignment.assignmentId}`);
    if (personas.has(assignment.personaId)) throw new TypeError(`duplicate persona assignment: ${assignment.personaId}`);
    ids.add(assignment.assignmentId);
    personas.add(assignment.personaId);
    assertPrompt(assignment.assignmentPrompt, 'assignmentPrompt');
    if (sha256(assignment.assignmentPrompt) !== assignment.assignmentPromptDigest) throw new TypeError('assignment prompt digest mismatch');
    const resultSchema = boundedObjectSchema(assignment.personaResultSchema, 'personaResultSchema');
    if (sha256(canonicalJson(resultSchema)) !== assignment.personaResultSchemaDigest) throw new TypeError('persona result schema digest mismatch');
    if (!Array.isArray(assignment.passes) || assignment.passes.length === 0) throw new TypeError('assignment requires at least one pass');
    if (assignment.passes.length > MAX_PASSES) throw new TypeError(`assignment ${assignment.personaId} has too many passes`);
    const passIds = new Set();
    for (const pass of assignment.passes) {
      assertClosedObject(pass, ASSIGNMENT_PASS_FIELDS, 'assignment pass');
      assertSafeId(pass.passId, 'passId');
      if (passIds.has(pass.passId)) throw new TypeError(`duplicate pass for persona ${assignment.personaId}`);
      passIds.add(pass.passId);
      assertPrompt(pass.prompt, 'pass prompt');
      if (sha256(pass.prompt) !== pass.promptDigest) throw new TypeError('pass prompt digest mismatch');
      const outputSchema = boundedObjectSchema(pass.outputSchema, 'pass outputSchema');
      if (sha256(canonicalJson(outputSchema)) !== pass.outputSchemaDigest) throw new TypeError('pass output schema digest mismatch');
      validateReviewUnitIds(pass.reviewUnitIds, `assignment ${assignment.personaId} pass ${pass.passId}`);
    }
    const expectedId = sha256(canonicalJson(assignmentIdentityPayload(assignment, identity.policyDigest, identity.manifestDigest)));
    if (expectedId !== assignment.assignmentId) throw new TypeError(`assignment identity mismatch for ${assignment.personaId}`);
  }
  return assignments;
}

function digestReviewWorkflowAssignments(assignments) {
  if (!Array.isArray(assignments)) throw new TypeError('assignments must be an array');
  return sha256(canonicalJson(assignments));
}

module.exports = {
  REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA,
  createReviewWorkflowAssignments,
  validateReviewWorkflowAssignments,
  digestReviewWorkflowAssignments,
};
