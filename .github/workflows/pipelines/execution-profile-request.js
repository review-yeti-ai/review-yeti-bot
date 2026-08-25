'use strict';

const crypto = require('crypto');

// This module is a credential-free parity harness. It is intentionally not
// imported by review-pipeline.js and cannot select a provider or alter a live
// action request. A later, separately approved field-family change may consume
// its projection after the fingerprints remain equal.

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeBody(body) {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error('request body must be valid JSON for credential-free fingerprinting');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('request body must be an object for credential-free fingerprinting');
  }
  return body;
}

function ownDataEntries(value) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('credential-free request view does not accept symbol keys');
  }

  return Object.getOwnPropertyNames(value).map((childKey) => {
    if (childKey === '__proto__' || childKey === 'constructor' || childKey === 'prototype') {
      throw new Error(`credential-free request view contains a forbidden key: ${childKey}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, childKey);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('credential-free request view does not accept accessor properties');
    }
    return [childKey, descriptor.value];
  });
}

function credentialFreeValue(value, key = '') {
  const normalizedKey = key.toLowerCase();
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    throw new Error(`credential-free request view contains a forbidden key: ${key}`);
  }
  if (/(?:api[_-]?key|authorization|credential|password|secret|token)/i.test(normalizedKey)) {
    return '<redacted-secret>';
  }
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) {
      throw new Error('credential-free request view does not accept accessor properties');
    }
    const safe = new Array(lengthDescriptor.value);
    for (const [childKey, childValue] of ownDataEntries(value)) {
      if (childKey === 'length') continue;
      if (childKey === '__proto__' || childKey === 'constructor' || childKey === 'prototype') {
        throw new Error(`credential-free request view contains a forbidden key: ${childKey}`);
      }
      if (!/^\d+$/.test(childKey) || Number(childKey) >= lengthDescriptor.value) {
        throw new Error(`credential-free request view contains an invalid array key: ${childKey}`);
      }
      Object.defineProperty(safe, childKey, {
        configurable: true,
        enumerable: true,
        value: credentialFreeValue(childValue, childKey),
        writable: true,
      });
    }
    return safe;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('credential-free request view requires plain objects');
    }
    // Validate every own string key before copying.  The null-prototype target
    // and defineProperty below make even a literal "__proto__" data key inert,
    // while this explicit preflight keeps the redaction contract fail-closed.
    const safe = Object.create(null);
    for (const [childKey, childValue] of ownDataEntries(value)) {
      Object.defineProperty(safe, childKey, {
        configurable: true,
        enumerable: true,
        value: credentialFreeValue(childValue, childKey),
        writable: true,
      });
    }
    return safe;
  }
  return value;
}

function credentialFreeBody(body) {
  const copy = credentialFreeValue(normalizeBody(body));

  if (Array.isArray(copy.messages)) {
    copy.messages = copy.messages.map((message) => ({
      role: message?.role,
      content: '<redacted-prompt>',
    }));
  }

  return copy;
}

function normalizeEndpoint(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_) {
    return url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function credentialFreeRequestView({ url, method = 'POST', headers = {}, body, timeoutMs } = {}) {
  const safeHeaders = Object.create(null);
  for (const [key, value] of ownDataEntries(headers || {})) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'content-type') safeHeaders['content-type'] = String(value);
  }

  const endpoint = normalizeEndpoint(url).replace(/\/chat\/completions$/, '');

  return {
    endpoint,
    method: String(method).toUpperCase(),
    headers: safeHeaders,
    timeout_ms: timeoutMs,
    body: credentialFreeBody(body),
  };
}

function credentialFreeRequestFingerprint(request) {
  return crypto.createHash('sha256')
    .update(canonicalJson(credentialFreeRequestView(request)), 'utf8')
    .digest('hex');
}

function buildExecutionProfileRequest(profile, currentRequest = {}) {
  if (!profile || typeof profile !== 'object' || !Object.isFrozen(profile) || typeof profile.profile_digest !== 'string') {
    throw new Error('execution profile request projection requires a canonical frozen profile');
  }

  const projected = structuredClone(currentRequest);
  if (!projected.model) projected.model = profile.model;

  if (profile.streaming === true) projected.stream = true;
  else delete projected.stream;

  if (profile.structured_output === 'strict') {
    projected.response_format = { type: 'json_object' };
  }

  if (profile.reasoning.effort !== 'runtime-default-uncharacterized') {
    if (profile.reasoning.wire_shape === 'reasoning.effort') {
      projected.reasoning = { effort: profile.reasoning.effort };
      delete projected.reasoning_effort;
    } else {
      projected.reasoning_effort = profile.reasoning.effort;
      delete projected.reasoning;
    }
  }

  if (profile.request_extensions.perf_metrics_in_response === true) {
    projected.perf_metrics_in_response = true;
  } else {
    delete projected.perf_metrics_in_response;
  }

  // The profile owns the privacy decision but not provider-specific routing knobs
  // in this parity slice. Preserve the existing OpenRouter policy object when it
  // is already present, and add only the validated data-collection denial when it
  // is absent. Direct profiles never carry gateway-only routing fields.
  if (profile.transport === 'openrouter' && profile.routing.provider !== null && !projected.provider) {
    projected.provider = { ...profile.routing.provider };
  }
  if (profile.transport !== 'openrouter') {
    delete projected.provider;
    delete projected.plugins;
  }

  return projected;
}

module.exports = {
  buildExecutionProfileRequest,
  credentialFreeRequestView,
  credentialFreeRequestFingerprint,
};
