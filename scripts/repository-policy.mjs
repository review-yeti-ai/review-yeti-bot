// BIFROST GATEWAY IS THE DEFAULT POLICY FOR EVERY REPOSITORY (Operator directive 2026-09-03:
// Bifrost internal LLM gateway is the primary OpenAI-compatible provider with dedicated virtual key
// and usage/cost tracking).
export const EXAMPLE_API_REPOSITORY = 'exampleorg/example-api';
export const EXAMPLE_API_TRANSPORT_ORDER = Object.freeze(['bifrost']);
// Retired vocabulary: this set once selected repositories into the Ollama
// policy. Kept as an empty set so historical imports keep resolving while
// every guard now reads the default-order contract instead.
export const OLLAMA_REPOSITORIES = Object.freeze(new Set([]));

// EMERGENCY MAINTENANCE PASSTHROUGH (Operator directive 2026-09-03):
// When active centrally at the dispatch level (REVIEW_YETI_PASSTHROUGH="true"),
// completely bypasses LLM inference for ALL repositories dispatched to example-review-actions,
// delivering an immediate SHIP verdict and maintenance comment to PRs.
export function isPassthroughRepository(repository = '') {
  const envToggle = (process.env.REVIEW_YETI_PASSTHROUGH || '').trim().toLowerCase();
  if (envToggle === 'true' || envToggle === '1') return true;
  if (envToggle === 'false' || envToggle === '0') return false;
  if (envToggle.length > 0) {
    const list = envToggle.split(',').map((s) => s.trim().toLowerCase());
    const target = repository.toLowerCase();
    const shortTarget = target.includes('/') ? target.split('/')[1] : target;
    if (list.includes(target) || list.includes(shortTarget)) return true;
  }
  return false;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OVERRIDE_KEYS = new Set(['dispatch_mode', 'enabled_transports']);

export function resolvePolicyForRepository(policy, repository = '') {
  const resolved = structuredClone(policy);
  const overrides = resolved?.repository_overrides ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('repository_overrides must be an object');
  }
  for (const [target, override] of Object.entries(overrides)) {
    if (!REPOSITORY_PATTERN.test(target)) throw new Error(`invalid repository override target: ${target}`);
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      throw new Error(`repository override ${target} must be an object`);
    }
    const unknown = Object.keys(override).filter((key) => !OVERRIDE_KEYS.has(key)).sort();
    if (unknown.length > 0) {
      throw new Error(`repository override ${target} contains unknown keys: ${unknown.join(', ')}`);
    }
    if (!['ordered', 'striped'].includes(override.dispatch_mode)) {
      throw new Error(`repository override ${target} dispatch_mode must be ordered or striped`);
    }
    if (!Array.isArray(override.enabled_transports)
        || override.enabled_transports.length === 0
        || override.enabled_transports.some((name) => typeof name !== 'string' || name.length === 0)
        || new Set(override.enabled_transports).size !== override.enabled_transports.length) {
      throw new Error(`repository override ${target} enabled_transports must be a non-empty unique string array`);
    }
  }

  const override = repository ? overrides[repository] : undefined;
  delete resolved.repository_overrides;
  if (!override) return resolved;

  const declared = new Set((resolved.review_yeti?.transports ?? []).map((transport) => transport.name));
  for (const name of override.enabled_transports) {
    if (!declared.has(name)) throw new Error(`repository override ${repository} names unknown transport: ${name}`);
  }
  resolved.review_yeti.dispatch_mode = override.dispatch_mode;
  const byName = new Map(
    (resolved.review_yeti.transports ?? []).map((transport) => [transport.name, transport]),
  );
  const enabledOrder = override.enabled_transports;
  const enabledSet = new Set(enabledOrder);
  const enabledTransports = enabledOrder.map((name) => ({
    ...byName.get(name),
    enabled: true,
  }));
  const disabledTransports = (resolved.review_yeti.transports ?? [])
    .filter((transport) => !enabledSet.has(transport.name))
    .map((transport) => ({
      ...transport,
      enabled: false,
    }));
  resolved.review_yeti.transports = [...enabledTransports, ...disabledTransports];
  return resolved;
}
