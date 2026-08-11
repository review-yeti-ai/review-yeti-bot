import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const RELATIVE_PATH = /^(?!\/)(?!.*\.\.)(?!.*\s).+$/;
const RUN_ARM = new Set(["baseline", "candidate"]);
const MANIFEST_FIELDS = new Set(["schema", "units"]);
const MANIFEST_UNIT_FIELDS = new Set([
  "unit_id",
  "status",
  "files",
  "persona",
  "rule_id",
  "omission_reason",
  "bundle_key",
]);
const FORBIDDEN_FIELDS = new Set([
  "prompt",
  "prompt_text",
  "prompt_messages",
  "raw_prompt",
  "source",
  "source_text",
  "source_contents",
  "tool_output",
  "tool_outputs",
  "provider_error",
  "provider_errors",
  "error_payload",
  "error_response",
  "credential",
  "credentials",
  "api_key",
  "access_token",
  "secret",
  "secrets",
  "reasoning",
  "hidden_reasoning",
  "chain_of_thought",
  "cot",
  "stack",
  "trace",
]);

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function digestUtf8(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function digestCanonicalJson(value) {
  return digestUtf8(JSON.stringify(canonicalize(value)));
}

export function reviewYetiRunReceiptDigest(receipt) {
  return digestCanonicalJson(receipt);
}

function boundedString(value, label, errors, {
  maxLength = 200,
  pattern,
} = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (value.length > maxLength) errors.push(`${label} must be ${maxLength} characters or fewer`);
  if (pattern && !pattern.test(value)) errors.push(`${label} has invalid format`);
}

function nonNegativeInteger(value, label, errors, { max = 1_000_000 } = {}) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    errors.push(`${label} must be a non-negative integer`);
  }
}

function nullableNonNegativeInteger(value, label, errors) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    errors.push(`${label} must be a non-negative integer or null`);
  }
}

function nullableNonNegativeNumber(value, label, errors) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    errors.push(`${label} must be a non-negative number or null`);
  }
}

function exactSha(value, label, errors) {
  if (typeof value !== "string" || !SHA.test(value)) errors.push(`${label} must be a full 40-hex SHA`);
}

function exactDigest(value, label, errors) {
  if (typeof value !== "string" || !DIGEST.test(value)) errors.push(`${label} must be a 64-hex digest`);
}

function pushForbiddenFieldErrors(value, path, errors) {
  if (!isObject(value) && !Array.isArray(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => pushForbiddenFieldErrors(entry, `${path}[${index}]`, errors));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_FIELDS.has(String(key).toLowerCase())) {
      errors.push(`${childPath} must not contain raw prompt/source/tool output/credential/provider error/hidden reasoning data`);
    }
    pushForbiddenFieldErrors(child, childPath, errors);
  }
}

function requireNoUnknownFields(value, allowedFields, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path || "receipt"} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) errors.push(`${path ? `${path}.` : ""}${key} is an unknown field`);
  }
}

function parseManifestArtifact(manifestArtifactText, errors) {
  if (typeof manifestArtifactText !== "string" || manifestArtifactText.trim() === "") {
    errors.push("expected identity manifestArtifactText is required to verify the complete manifest artifact");
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestArtifactText);
  } catch (error) {
    errors.push(`manifest artifact must be valid JSON: ${error.message}`);
    return null;
  }
  if (!isObject(manifest)) {
    errors.push("manifest artifact must be a JSON object");
    return null;
  }
  requireNoUnknownFields(manifest, MANIFEST_FIELDS, "manifest", errors);
  boundedString(manifest.schema, "manifest.schema", errors, { maxLength: 80 });
  if (!Array.isArray(manifest.units)) {
    errors.push("manifest.units must be an array");
    return null;
  }
  manifest.units.forEach((unit, index) => {
    const path = `manifest.units[${index}]`;
    requireNoUnknownFields(unit, MANIFEST_UNIT_FIELDS, path, errors);
    if (!isObject(unit)) {
      errors.push(`${path} must be an object`);
      return;
    }
    boundedString(unit.unit_id, `${path}.unit_id`, errors, { maxLength: 120 });
    if (!["emitted", "omitted"].includes(unit.status)) {
      errors.push(`${path}.status must be emitted or omitted`);
    }
    if (!Array.isArray(unit.files) || unit.files.length === 0) {
      errors.push(`${path}.files must be a non-empty array`);
    } else {
      unit.files.forEach((filePath, fileIndex) => {
        if (typeof filePath !== "string" || filePath.length > 240 || !RELATIVE_PATH.test(filePath)) {
          errors.push(`${path}.files[${fileIndex}] must be a bounded relative path`);
        }
      });
    }
    for (const field of ["persona", "rule_id", "omission_reason", "bundle_key"]) {
      if (unit[field] !== undefined) boundedString(unit[field], `${path}.${field}`, errors, { maxLength: 120 });
    }
  });
  return manifest;
}

function validateExpectedIdentity(expectedIdentity, receipt, errors) {
  if (expectedIdentity === undefined) return;
  if (!isObject(expectedIdentity)) {
    errors.push("expected identity must be an object when provided");
    return;
  }

  const requiredFields = [
    "repository",
    "pr_number",
    "base_sha",
    "head_sha",
    "action_sha",
    "policy_digest",
    "plan_digest",
    "manifest_digest",
    "manifest_artifact_digest",
  ];
  for (const field of requiredFields) {
    if (!Object.hasOwn(expectedIdentity, field)) {
      errors.push(`expected identity ${field} is required`);
    }
  }
  if (!Object.hasOwn(expectedIdentity, "diff_digest") && !Object.hasOwn(expectedIdentity, "diffText")) {
    errors.push("expected identity diff_digest or diffText is required");
  }

  if (typeof expectedIdentity.repository === "string" && receipt.repository !== expectedIdentity.repository) {
    errors.push("receipt repository must match expected identity");
  }
  if (Number.isInteger(expectedIdentity.pr_number) && receipt.pr_number !== expectedIdentity.pr_number) {
    errors.push("receipt pr_number must match expected identity");
  }
  for (const field of ["base_sha", "head_sha", "action_sha", "policy_digest", "plan_digest", "manifest_digest", "manifest_artifact_digest"]) {
    if (typeof expectedIdentity[field] === "string" && receipt[field] !== expectedIdentity[field]) {
      errors.push(`receipt ${field} must match expected identity`);
    }
  }

  if (typeof expectedIdentity.diffText === "string") {
    const diffDigest = digestUtf8(expectedIdentity.diffText);
    if (typeof expectedIdentity.diff_digest === "string" && diffDigest !== expectedIdentity.diff_digest) {
      errors.push("expected identity diff_digest must match diffText bytes");
    }
    if (receipt.diff_digest !== diffDigest) errors.push("receipt diff_digest must match the exact diff bytes");
  } else if (typeof expectedIdentity.diff_digest === "string" && receipt.diff_digest !== expectedIdentity.diff_digest) {
    errors.push("receipt diff_digest must match expected identity");
  }

  const manifest = parseManifestArtifact(expectedIdentity.manifestArtifactText, errors);
  if (manifest) {
    const canonicalDigest = digestCanonicalJson(manifest);
    const artifactDigest = digestUtf8(expectedIdentity.manifestArtifactText);
    if (typeof expectedIdentity.manifest_digest === "string" && canonicalDigest !== expectedIdentity.manifest_digest) {
      errors.push("expected identity manifest_digest must match manifestArtifactText");
    }
    if (typeof expectedIdentity.manifest_artifact_digest === "string" && artifactDigest !== expectedIdentity.manifest_artifact_digest) {
      errors.push("expected identity manifest_artifact_digest must match manifestArtifactText bytes");
    }
    if (receipt.manifest_digest !== canonicalDigest) {
      errors.push("receipt manifest_digest must match the canonical manifest artifact");
    }
    if (receipt.manifest_artifact_digest !== artifactDigest) {
      errors.push("receipt manifest_artifact_digest must match the manifest artifact bytes");
    }
    const emitted = manifest.units.filter((unit) => unit?.status === "emitted").length;
    const omitted = manifest.units.filter((unit) => unit?.status === "omitted").length;
    if (manifest.units.length !== receipt.units_total
      || emitted !== receipt.units_emitted
      || omitted !== receipt.units_omitted) {
      errors.push("complete manifest artifact must prove units_total, units_emitted, and units_omitted");
    }
  }
}

export function validateReviewYetiRunReceipt(receipt, expectedIdentity) {
  const errors = [];
  if (!isObject(receipt)) return { valid: false, errors: ["review-yeti run receipt must be an object"] };

  pushForbiddenFieldErrors(receipt, "", errors);
  requireNoUnknownFields(receipt, new Set([
    "schema",
    "run_id",
    "run_attempt",
    "arm",
    "repository",
    "pr_number",
    "base_sha",
    "head_sha",
    "action_sha",
    "model",
    "provider_route_digest",
    "prompt_template_digest",
    "tool_policy_digest",
    "diff_digest",
    "policy_digest",
    "plan_digest",
    "manifest_digest",
    "manifest_artifact_digest",
    "units_total",
    "units_emitted",
    "units_omitted",
    "files_changed",
    "files_baseline_covered",
    "coverage_gaps",
    "rule_ids",
    "stage_durations_ms",
    "reflection",
    "usage",
    "latency_ms",
  ]), "", errors);

  if (receipt.schema !== "review-dispatch-run.v1") {
    errors.push("receipt schema must be review-dispatch-run.v1");
  }
  boundedString(receipt.run_id, "receipt.run_id", errors, { maxLength: 120 });
  if (!Number.isInteger(receipt.run_attempt) || receipt.run_attempt < 1 || receipt.run_attempt > 1000) {
    errors.push("receipt.run_attempt must be an integer from 1 through 1000");
  }
  if (!RUN_ARM.has(receipt.arm)) errors.push("receipt.arm must be baseline or candidate");
  if (typeof receipt.repository !== "string" || !REPOSITORY.test(receipt.repository)) {
    errors.push("receipt.repository must be OWNER/REPO");
  }
  if (!Number.isInteger(receipt.pr_number) || receipt.pr_number < 1) {
    errors.push("receipt.pr_number must be a positive integer");
  }
  for (const field of ["base_sha", "head_sha", "action_sha"]) exactSha(receipt[field], `receipt.${field}`, errors);
  boundedString(receipt.model, "receipt.model", errors, { maxLength: 200 });
  for (const field of [
    "provider_route_digest",
    "prompt_template_digest",
    "tool_policy_digest",
    "diff_digest",
    "policy_digest",
    "plan_digest",
    "manifest_digest",
    "manifest_artifact_digest",
  ]) {
    exactDigest(receipt[field], `receipt.${field}`, errors);
  }
  for (const field of [
    "units_total",
    "units_emitted",
    "units_omitted",
    "files_changed",
    "files_baseline_covered",
    "coverage_gaps",
  ]) {
    nonNegativeInteger(receipt[field], `receipt.${field}`, errors);
  }
  if (Number.isInteger(receipt.units_total)
    && Number.isInteger(receipt.units_emitted)
    && Number.isInteger(receipt.units_omitted)
    && receipt.units_emitted + receipt.units_omitted !== receipt.units_total) {
    errors.push("receipt units_emitted plus units_omitted must equal units_total");
  }
  if (!Array.isArray(receipt.rule_ids)) {
    errors.push("receipt.rule_ids must be an array");
  } else {
    if (receipt.rule_ids.length > 128) errors.push("receipt.rule_ids must contain at most 128 items");
    if (new Set(receipt.rule_ids).size !== receipt.rule_ids.length) errors.push("receipt.rule_ids must be unique");
    receipt.rule_ids.forEach((ruleId, index) => boundedString(ruleId, `receipt.rule_ids[${index}]`, errors, { maxLength: 120 }));
  }

  requireNoUnknownFields(receipt.stage_durations_ms, new Set(["planning", "investigation", "reflection", "publication"]), "stage_durations_ms", errors);
  for (const field of ["planning", "investigation", "reflection", "publication"]) {
    nonNegativeInteger(receipt.stage_durations_ms?.[field], `stage_durations_ms.${field}`, errors, { max: 86_400_000 });
  }

  requireNoUnknownFields(receipt.reflection, new Set(["candidates", "kept", "downgraded", "dropped", "needs_review"]), "reflection", errors);
  for (const field of ["candidates", "kept", "downgraded", "dropped", "needs_review"]) {
    nonNegativeInteger(receipt.reflection?.[field], `reflection.${field}`, errors);
  }
  if (Number.isInteger(receipt.reflection?.candidates)) {
    const tallied = ["kept", "downgraded", "dropped", "needs_review"]
      .map((field) => receipt.reflection?.[field])
      .every(Number.isInteger)
      ? receipt.reflection.kept + receipt.reflection.downgraded + receipt.reflection.dropped + receipt.reflection.needs_review
      : null;
    if (tallied !== null && tallied > receipt.reflection.candidates) {
      errors.push("reflection tallies must not exceed reflection.candidates");
    }
  }

  requireNoUnknownFields(receipt.usage, new Set(["prompt_tokens", "completion_tokens", "cost_usd"]), "usage", errors);
  nullableNonNegativeInteger(receipt.usage?.prompt_tokens, "usage.prompt_tokens", errors);
  nullableNonNegativeInteger(receipt.usage?.completion_tokens, "usage.completion_tokens", errors);
  nullableNonNegativeNumber(receipt.usage?.cost_usd, "usage.cost_usd", errors);
  nullableNonNegativeInteger(receipt.latency_ms, "receipt.latency_ms", errors);

  validateExpectedIdentity(expectedIdentity, receipt, errors);

  return { valid: errors.length === 0, errors };
}

export function adaptReviewYetiRunReceipt(receipt) {
  const validation = validateReviewYetiRunReceipt(receipt);
  if (!validation.valid) {
    throw new TypeError(`invalid review-dispatch-run.v1 receipt: ${validation.errors.join("; ")}`);
  }

  const receiptDigest = reviewYetiRunReceiptDigest(receipt);
  return {
    schema: "review-yeti-provider-fact.v1",
    provider: "review-yeti",
    run_id: receipt.run_id,
    run_attempt: receipt.run_attempt,
    arm: receipt.arm,
    repository: receipt.repository,
    pr_number: receipt.pr_number,
    base_sha: receipt.base_sha,
    head_sha: receipt.head_sha,
    action_sha: receipt.action_sha,
    model: receipt.model,
    digests: {
      receipt_digest: receiptDigest,
      provider_route_digest: receipt.provider_route_digest,
      prompt_template_digest: receipt.prompt_template_digest,
      tool_policy_digest: receipt.tool_policy_digest,
      diff_digest: receipt.diff_digest,
      policy_digest: receipt.policy_digest,
      plan_digest: receipt.plan_digest,
      manifest_digest: receipt.manifest_digest,
      manifest_artifact_digest: receipt.manifest_artifact_digest,
    },
    coverage: {
      units_total: receipt.units_total,
      units_emitted: receipt.units_emitted,
      units_omitted: receipt.units_omitted,
      files_changed: receipt.files_changed,
      files_baseline_covered: receipt.files_baseline_covered,
      coverage_gaps: receipt.coverage_gaps,
      rule_ids: [...receipt.rule_ids],
    },
    stage_durations_ms: { ...receipt.stage_durations_ms },
    reflection: { ...receipt.reflection },
    usage: { ...receipt.usage },
    latency_ms: receipt.latency_ms,
    review_receipt_binding: {
      base_sha: receipt.base_sha,
      action_sha: receipt.action_sha,
      policy_digest: receipt.policy_digest,
      plan_digest: receipt.plan_digest,
      manifest_digest: receipt.manifest_digest,
      provider_receipt_digests: [receiptDigest],
    },
  };
}
