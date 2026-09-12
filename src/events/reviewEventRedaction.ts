import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { types as nodeTypes } from 'node:util';
import { z } from 'zod';
import type { LiveStreamEvent, ReviewEventIdentity } from '../types/live';
import {
  REVIEW_EVENT_MAX_BYTES,
  REVIEW_EVENT_SCHEMA,
  progressDataSchema,
  reviewEventIdentitySchema,
  reviewEventTimestampSchema,
  reviewYetiEventV1Schema,
  type ReviewYetiProgressEventV1,
} from './reviewYetiEvent';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LIVE_EVENT_FIELDS = new Set(['jobId', 'timestamp', 'type', 'persona', 'data']);
const IDENTITY_INPUT_FIELDS = new Set([
  'repositoryId',
  'repository_id',
  'prNumber',
  'pr_number',
  'baseSha',
  'base_sha',
  'headSha',
  'head_sha',
  'attemptId',
  'attempt_id',
  'runId',
  'run_id',
  'sequence',
  'correlationId',
  'correlation_id',
  'traceId',
  'trace_id',
  'eventId',
  'event_id',
]);
const OMITTED_LEGACY_FIELDS = new Set([
  'repo',
  'prnumber',
  'personaid',
  'charter',
  'required',
  'paths',
  'decision',
  'requestedmodel',
  'resolvedmodel',
  'iserror',
  'stream',
]);
const FORBIDDEN_LEGACY_FIELDS = new Map<string, string>([
  ['authorization', 'credential-shaped field'],
  ['apikey', 'credential-shaped field'],
  ['authheaders', 'credential-shaped field'],
  ['authorizationheaders', 'credential-shaped field'],
  ['headers', 'credential-shaped field'],
  ['accesstoken', 'credential-shaped field'],
  ['refreshtoken', 'credential-shaped field'],
  ['clientsecret', 'credential-shaped field'],
  ['secret', 'credential-shaped field'],
  ['password', 'credential-shaped field'],
  ['privatekey', 'credential-shaped field'],
  ['credential', 'credential-shaped field'],
  ['cookie', 'credential-shaped field'],
  ['prompt', 'prompt'],
  ['promptsnippet', 'prompt'],
  ['diff', 'diff'],
  ['diffbody', 'diff'],
  ['diffsnippet', 'diff'],
  ['patch', 'diff'],
  ['source', 'source body'],
  ['sourcebody', 'source body'],
  ['filepath', 'repository-relative path'],
  ['path', 'repository-relative path'],
  ['token', 'raw token text'],
  ['tokentext', 'raw token text'],
  ['rawtoken', 'raw token text'],
  ['rawmodeloutput', 'raw model output'],
  ['modeloutput', 'raw model output'],
  ['chunk', 'raw model output'],
  ['rationale', 'raw model output'],
  ['error', 'unbounded error'],
  ['errormessage', 'unbounded error'],
  ['exception', 'unbounded error'],
  ['stack', 'unbounded error'],
  ['stderr', 'unbounded error'],
  ['message', 'message without safe provenance'],
]);
const legacyFieldName = (field: string) => field.replace(/[^a-z0-9]/giu, '').toLowerCase();
const INERT_MAX_DEPTH = 8;
const INERT_MAX_OBJECT_KEYS = 64;
const INERT_MAX_ARRAY_ITEMS = 64;
const INERT_MAX_STRING_CODE_UNITS = 32_768;
const INERT_MAX_PROPERTY_NAME_CODE_UNITS = 32_768;
const INERT_MAX_TOTAL_NODES = 512;
const INERT_MAX_TOTAL_KEY_CODE_UNITS = 32_768;
const CREDENTIAL_ASSIGNMENT_LABELS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'xapikey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'password',
  'secret',
  'privatekey',
  'token',
]);
const CREDENTIAL_ASSIGNMENT_RAW_LABEL_MAX = 64;

const legacyProgressFields = new Set([
  'personaId',
  'provider',
  'model',
  'requestedModel',
  'resolvedModel',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'tokensUsed',
  'durationMs',
  'totalDurationMs',
  'latencyMs',
  'findingsCount',
  'totalFindings',
  'costUSD',
  'totalCostUSD',
  'status',
  'stage',
  'errorClass',
  'verdict',
  'quorumSatisfied',
  'distinctProviders',
  'totalPersonasExecuted',
  ...OMITTED_LEGACY_FIELDS,
]);

export type ReviewEventRejectionCode =
  | 'invalid_live_event'
  | 'invalid_identity'
  | 'unknown_field'
  | 'forbidden_field'
  | 'invalid_field'
  | 'not_serializable'
  | 'payload_too_large';

declare const sanitizedProgressEventBrand: unique symbol;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/**
 * An event that has crossed the legacy-event redaction boundary. The brand is
 * deliberately private at runtime: consumers can receive this type, but they
 * cannot turn a parser result or a permissive live event into one by shape.
 */
export type SanitizedProgressEvent = DeepReadonly<ReviewYetiProgressEventV1> & {
  readonly [sanitizedProgressEventBrand]: true;
};

const sanitizedProgressEvents = new WeakSet<object>();

export function isSanitizedProgressEvent(value: unknown): value is SanitizedProgressEvent {
  return typeof value === 'object' && value !== null && sanitizedProgressEvents.has(value);
}

type InertJsonValue = null | boolean | number | string | readonly InertJsonValue[] | InertJsonObject;
type InertJsonObject = { [key: string]: InertJsonValue };

type InertSnapshotResult =
  | { ok: true; value: InertJsonValue }
  | { ok: false };

interface InertSnapshotState {
  readonly seen: WeakSet<object>;
  nodes: number;
  keyCodeUnits: number;
}

const INERT_SNAPSHOT_FAILURE = Object.freeze({ ok: false as const });

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiWordCharacter(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 95;
}

function isWhitespace(code: number): boolean {
  return code === 9
    || code === 10
    || code === 11
    || code === 12
    || code === 13
    || code === 32
    || code === 160
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function isUrlAuthoritySeparator(code: number): boolean {
  return code === 47 || code === 92;
}

function isUrlSchemeCharacter(code: number): boolean {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 43 || code === 45 || code === 46;
}

function isUrlSpanDelimiter(code: number): boolean {
  return code <= 31 || code === 127 || isWhitespace(code);
}

function isEmbeddedUrlStartBoundary(code: number): boolean {
  return code === 34
    || code === 39
    || code === 40
    || code === 41
    || code === 44
    || code === 59
    || code === 60
    || code === 61
    || code === 62
    || code === 91
    || code === 93
    || code === 96
    || code === 123
    || code === 125
    || code === 58;
}

function isClosingWrapper(code: number): boolean {
  return code === 41 || code === 62 || code === 93 || code === 125;
}

function isAmbiguousAuthorityStart(code: number): boolean {
  return code === 34
    || code === 39
    || code === 40
    || code === 41
    || code === 44
    || code === 58
    || code === 59
    || code === 60
    || code === 61
    || code === 62
    || code === 93
    || code === 96
    || code === 123
    || code === 125;
}

function isOpeningWrapper(code: number): boolean {
  return code === 40 || code === 60 || code === 91 || code === 123;
}

function isQuoteWrapper(code: number): boolean {
  return code === 34 || code === 39 || code === 96;
}

const URL_WRAPPER_DEPTH_LIMIT = 64;

function isClearWrapperListBoundary(
  value: string,
  index: number,
  spanStart: number,
): boolean {
  if (index <= spanStart) return false;

  const delimiter = value.charCodeAt(index - 1);
  if (isClosingWrapper(delimiter)) return true;

  if (isQuoteWrapper(delimiter)) return true;

  if (delimiter === 44 || delimiter === 58 || delimiter === 59 || delimiter === 61) return true;

  if (!isOpeningWrapper(delimiter)) return false;
  let wrapperStart = index - 1;
  let depth = 0;
  while (wrapperStart >= spanStart && isOpeningWrapper(value.charCodeAt(wrapperStart))) {
    depth += 1;
    if (depth > URL_WRAPPER_DEPTH_LIMIT) return true;
    wrapperStart -= 1;
  }
  if (wrapperStart < spanStart) return true;
  const preceding = value.charCodeAt(wrapperStart);
  return preceding === 44
    || preceding === 58
    || preceding === 59
    || preceding === 61
    || isQuoteWrapper(preceding)
    || isClosingWrapper(preceding);
}

const WHATWG_SPECIAL_PROTOCOLS = new Set(['file:', 'ftp:', 'http:', 'https:', 'ws:', 'wss:']);
const URL_CANDIDATE_LIMIT = 64;

function isRootOrLabelPrefixedCandidate(value: string, index: number, spanStart: number): boolean {
  let cursor = spanStart;
  let labels = 0;
  while (cursor < index && labels < URL_CANDIDATE_LIMIT) {
    if (!isAsciiLetter(value.charCodeAt(cursor))) return false;
    let labelEnd = cursor + 1;
    while (labelEnd < index && isUrlSchemeCharacter(value.charCodeAt(labelEnd))) {
      labelEnd += 1;
    }
    if (value.charCodeAt(labelEnd) !== 58) return false;
    cursor = labelEnd + 1;
    labels += 1;
  }
  return cursor === index;
}

type ParsedUrlInspection = {
  readonly hasUserinfo: boolean;
  readonly ownsComponents: boolean;
};

function inspectParsedUrl(
  candidate: string,
  schemeRelative: boolean,
  canonicalCustomAuthority: boolean,
): ParsedUrlInspection | undefined {
  try {
    const parsed = schemeRelative
      ? new URL(candidate, 'https://review-yeti.invalid/')
      : new URL(candidate);
    return {
      hasUserinfo: parsed.username.length > 0 || parsed.password.length > 0,
      ownsComponents: schemeRelative
        || WHATWG_SPECIAL_PROTOCOLS.has(parsed.protocol)
        || (canonicalCustomAuthority && parsed.host.length > 0),
    };
  } catch {
    return undefined;
  }
}

type UrlCandidateStart = {
  readonly index: number;
  readonly nextIndex: number;
  readonly requiresParse: boolean;
  readonly schemeRelative: boolean;
  readonly canonicalCustomAuthority: boolean;
};

type UrlCandidateSearchOptions = {
  readonly clearBoundaryOnly?: boolean;
};

function findUrlCandidateStart(
  value: string,
  searchStart: number,
  spanStart: number,
  spanEnd: number,
  options: UrlCandidateSearchOptions = {},
): UrlCandidateStart | undefined {
  let index = searchStart;
  while (index < spanEnd) {
    const atBoundary = index === spanStart
      || isEmbeddedUrlStartBoundary(value.charCodeAt(index - 1));
    if (!atBoundary) {
      index += 1;
      continue;
    }

    const code = value.charCodeAt(index);
    if (isAsciiLetter(code)) {
      let schemeEnd = index + 1;
      while (schemeEnd < spanEnd && isUrlSchemeCharacter(value.charCodeAt(schemeEnd))) {
        schemeEnd += 1;
      }
      if (value.charCodeAt(schemeEnd) === 58) {
        if (options.clearBoundaryOnly
          && !isClearWrapperListBoundary(value, index, spanStart)) {
          index = schemeEnd + 1;
          continue;
        }
        const protocol = `${value.slice(index, schemeEnd).toLowerCase()}:`;
        let nextIndex = schemeEnd + 1;
        while (nextIndex < spanEnd && isUrlAuthoritySeparator(value.charCodeAt(nextIndex))) {
          nextIndex += 1;
        }
        return {
          index,
          nextIndex,
          requiresParse: WHATWG_SPECIAL_PROTOCOLS.has(protocol) || nextIndex > schemeEnd + 1,
          schemeRelative: false,
          canonicalCustomAuthority: !WHATWG_SPECIAL_PROTOCOLS.has(protocol)
            && value.charCodeAt(schemeEnd + 1) === 47
            && value.charCodeAt(schemeEnd + 2) === 47
            && !isUrlAuthoritySeparator(value.charCodeAt(schemeEnd + 3)),
        };
      }
      index = schemeEnd;
      continue;
    }

    if (
      isUrlAuthoritySeparator(code)
      && isUrlAuthoritySeparator(value.charCodeAt(index + 1))
    ) {
      if (options.clearBoundaryOnly
        && !isClearWrapperListBoundary(value, index, spanStart)) {
        index += 2;
        continue;
      }
      let nextIndex = index + 2;
      while (nextIndex < spanEnd && isUrlAuthoritySeparator(value.charCodeAt(nextIndex))) {
        nextIndex += 1;
      }
      return {
        index,
        nextIndex,
        requiresParse: true,
        schemeRelative: true,
        canonicalCustomAuthority: false,
      };
    }

    index += 1;
  }
  return undefined;
}

/**
 * A parsed special URL owns the rest of its whitespace-free span, so URL-like
 * path/query text is never restarted as a new authority. Non-special labels
 * and opaque paths advance through a bounded candidate sequence; canonical
 * custom authorities are parsed directly. Invalid credential-shaped candidates
 * and exhausted candidate budgets fail closed instead of certifying a suffix.
 */
function hasUrlAuthorityUserinfo(value: string): boolean {
  if (value.indexOf('@') < 0) return false;

  let spanStart = 0;
  while (spanStart < value.length) {
    while (spanStart < value.length && isUrlSpanDelimiter(value.charCodeAt(spanStart))) {
      spanStart += 1;
    }
    if (spanStart >= value.length) break;

    let spanEnd = spanStart;
    while (spanEnd < value.length && !isUrlSpanDelimiter(value.charCodeAt(spanEnd))) {
      spanEnd += 1;
    }

    let searchStart = spanStart;
    let candidateCount = 0;
    while (searchStart < spanEnd) {
      const candidateStart = findUrlCandidateStart(value, searchStart, spanStart, spanEnd);
      if (!candidateStart) break;

      candidateCount += 1;
      if (candidateCount > URL_CANDIDATE_LIMIT) return true;

      if (candidateStart.requiresParse) {
        const candidate = value.slice(candidateStart.index, spanEnd);
        const inspection = inspectParsedUrl(
          candidate,
          candidateStart.schemeRelative,
          candidateStart.canonicalCustomAuthority,
        );
        if (inspection?.hasUserinfo) return true;
        if (inspection?.ownsComponents) {
          const authorityStart = value.charCodeAt(candidateStart.nextIndex);
          if (
            candidateStart.nextIndex >= spanEnd
            || !isAmbiguousAuthorityStart(authorityStart)
          ) {
            if (isRootOrLabelPrefixedCandidate(value, candidateStart.index, spanStart)) break;
            const laterExplicitScheme = findUrlCandidateStart(
              value,
              candidateStart.nextIndex,
              spanStart,
              spanEnd,
              { clearBoundaryOnly: true },
            );
            if (!laterExplicitScheme) break;
            searchStart = laterExplicitScheme.index;
            continue;
          }
        }
        if (!inspection && value.indexOf('@', candidateStart.index) < spanEnd) return true;
      }

      searchStart = Math.max(candidateStart.nextIndex, candidateStart.index + 1);
    }
    spanStart = spanEnd + 1;
  }
  return false;
}

function isCredentialAssignmentDelimiter(code: number): boolean {
  return isWhitespace(code) || code === 34 || code === 39 || code === 96;
}

function isCredentialLabelCharacter(code: number): boolean {
  return isAsciiWordCharacter(code) || code === 45;
}

function hasCredentialAssignment(value: string): boolean {
  let nextColon = value.indexOf(':');
  let nextEquals = value.indexOf('=');
  while (nextColon >= 0 || nextEquals >= 0) {
    const marker = nextColon < 0
      ? nextEquals
      : nextEquals < 0
        ? nextColon
        : Math.min(nextColon, nextEquals);
    if (marker === nextColon) nextColon = value.indexOf(':', marker + 1);
    if (marker === nextEquals) nextEquals = value.indexOf('=', marker + 1);

    let labelEnd = marker;
    let delimiterCount = 0;
    while (
      labelEnd > 0
      && delimiterCount <= CREDENTIAL_ASSIGNMENT_RAW_LABEL_MAX
      && isCredentialAssignmentDelimiter(value.charCodeAt(labelEnd - 1))
    ) {
      labelEnd -= 1;
      delimiterCount += 1;
    }
    if (delimiterCount > CREDENTIAL_ASSIGNMENT_RAW_LABEL_MAX) continue;

    let labelStart = labelEnd;
    while (
      labelStart > 0
      && labelEnd - labelStart <= CREDENTIAL_ASSIGNMENT_RAW_LABEL_MAX
      && isCredentialLabelCharacter(value.charCodeAt(labelStart - 1))
    ) {
      labelStart -= 1;
    }
    if (labelEnd - labelStart > CREDENTIAL_ASSIGNMENT_RAW_LABEL_MAX) continue;

    let normalizedLabel = '';
    for (let characterIndex = labelStart; characterIndex < labelEnd; characterIndex += 1) {
      const labelCode = value.charCodeAt(characterIndex);
      if (labelCode === 45 || labelCode === 95) continue;
      normalizedLabel += String.fromCharCode(
        labelCode >= 65 && labelCode <= 90 ? labelCode + 32 : labelCode,
      );
    }
    if (CREDENTIAL_ASSIGNMENT_LABELS.has(normalizedLabel)) return true;
  }
  return false;
}

function isBareAuthorityPrefixBoundary(code: number): boolean {
  return isUrlSpanDelimiter(code)
    || isUrlAuthoritySeparator(code)
    || code === 63
    || code === 35;
}

function isBareAuthorityHostBoundary(code: number): boolean {
  return isBareAuthorityPrefixBoundary(code)
    || code === 44
    || code === 59
    || code === 61;
}

function hasRootOwnedExplicitUrl(value: string, spanStart: number, spanEnd: number): boolean {
  let searchStart = spanStart;
  let candidates = 0;
  while (searchStart < spanEnd) {
    const candidate = findUrlCandidateStart(value, searchStart, spanStart, spanEnd);
    if (!candidate) return false;

    candidates += 1;
    if (candidates > URL_CANDIDATE_LIMIT) return false;

    if (candidate.requiresParse) {
      const inspection = inspectParsedUrl(
        value.slice(candidate.index, spanEnd),
        candidate.schemeRelative,
        candidate.canonicalCustomAuthority,
      );
      if (
        inspection?.ownsComponents
        && (
          candidate.nextIndex >= spanEnd
          || !isAmbiguousAuthorityStart(value.charCodeAt(candidate.nextIndex))
        )
        && isRootOrLabelPrefixedCandidate(value, candidate.index, spanStart)
      ) {
        return true;
      }
    }

    searchStart = Math.max(candidate.nextIndex, candidate.index + 1);
  }
  return false;
}

function isSimpleMailtoEmail(value: string, spanStart: number, spanEnd: number): boolean {
  const prefix = 'mailto:';
  if (spanEnd - spanStart <= prefix.length) return false;
  if (value.slice(spanStart, spanStart + prefix.length).toLowerCase() !== prefix) return false;

  const addressStart = spanStart + prefix.length;
  const at = value.indexOf('@', addressStart);
  if (at <= addressStart || at + 1 >= spanEnd) return false;
  for (let index = addressStart; index < at; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !isAsciiWordCharacter(code)
      && code !== 43
      && code !== 45
      && code !== 46
    ) return false;
  }
  for (let index = at + 1; index < spanEnd; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiLetter(code) && !isAsciiDigit(code) && code !== 45 && code !== 46) {
      return false;
    }
  }
  return true;
}

/**
 * Reject a scheme-less `username:password@host` authority without turning
 * ordinary emails or slash-qualified model revisions into credential findings.
 * Explicit URLs are handled by hasUrlAuthorityUserinfo(), whose parsed owner
 * semantics intentionally keep path and query content opaque to this check.
 */
function hasBareAuthorityUserinfo(value: string): boolean {
  if (value.indexOf('@') < 0 || value.indexOf(':') < 0) return false;

  let whitespaceSpanStart = 0;
  while (whitespaceSpanStart < value.length) {
    while (
      whitespaceSpanStart < value.length
      && isUrlSpanDelimiter(value.charCodeAt(whitespaceSpanStart))
    ) {
      whitespaceSpanStart += 1;
    }
    if (whitespaceSpanStart >= value.length) break;

    let whitespaceSpanEnd = whitespaceSpanStart;
    while (
      whitespaceSpanEnd < value.length
      && !isUrlSpanDelimiter(value.charCodeAt(whitespaceSpanEnd))
    ) {
      whitespaceSpanEnd += 1;
    }

    if (
      !isSimpleMailtoEmail(value, whitespaceSpanStart, whitespaceSpanEnd)
      && !hasRootOwnedExplicitUrl(value, whitespaceSpanStart, whitespaceSpanEnd)
    ) {
      let candidateStart = whitespaceSpanStart;
      let passwordSeparator = -1;
      for (let index = whitespaceSpanStart; index < whitespaceSpanEnd; index += 1) {
        const code = value.charCodeAt(index);
        if (isBareAuthorityPrefixBoundary(code)) {
          candidateStart = index + 1;
          passwordSeparator = -1;
          continue;
        }
        if (code === 58 && passwordSeparator < candidateStart) {
          passwordSeparator = index;
          continue;
        }
        if (
          code === 64
          && passwordSeparator >= candidateStart
          && (
            candidateStart < passwordSeparator
            || passwordSeparator + 1 < index
          )
          && index + 1 < whitespaceSpanEnd
          && !isBareAuthorityHostBoundary(value.charCodeAt(index + 1))
        ) {
          return true;
        }
        if (code === 64) {
          candidateStart = index + 1;
          passwordSeparator = -1;
        }
      }
    }
    whitespaceSpanStart = whitespaceSpanEnd + 1;
  }
  return false;
}

function containsCredentialLikeValue(value: string): boolean {
  if (value.length > INERT_MAX_STRING_CODE_UNITS) return true;
  return hasUrlAuthorityUserinfo(value)
    || hasBareAuthorityUserinfo(value)
    || hasCredentialAssignment(value);
}

function isInertJsonObject(value: InertJsonValue): value is InertJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotInertJson(
  value: unknown,
  state: InertSnapshotState = { seen: new WeakSet<object>(), nodes: 0, keyCodeUnits: 0 },
  depth = 0,
): InertSnapshotResult {
  state.nodes += 1;
  if (state.nodes > INERT_MAX_TOTAL_NODES || depth > INERT_MAX_DEPTH) return INERT_SNAPSHOT_FAILURE;
  if (value === null || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : INERT_SNAPSHOT_FAILURE;
  }
  if (typeof value === 'string') {
    return value.length <= INERT_MAX_STRING_CODE_UNITS
      ? { ok: true, value }
      : INERT_SNAPSHOT_FAILURE;
  }
  if (typeof value !== 'object') return INERT_SNAPSHOT_FAILURE;
  try {
    if (nodeTypes.isProxy(value)) return INERT_SNAPSHOT_FAILURE;
  } catch {
    return INERT_SNAPSHOT_FAILURE;
  }
  if (state.seen.has(value)) return INERT_SNAPSHOT_FAILURE;
  state.seen.add(value);

  let prototype: object | null;
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return INERT_SNAPSHOT_FAILURE;
  }
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return INERT_SNAPSHOT_FAILURE;
  }

  let arrayLength: number | undefined;
  if (isArray) {
    try {
      arrayLength = (value as unknown[]).length;
    } catch {
      return INERT_SNAPSHOT_FAILURE;
    }
    if (
      !Number.isSafeInteger(arrayLength)
      || arrayLength < 0
      || arrayLength > INERT_MAX_ARRAY_ITEMS
    ) {
      return INERT_SNAPSHOT_FAILURE;
    }
  }

  const enumerableKeys: string[] = [];
  const enumerableLimit = isArray ? INERT_MAX_ARRAY_ITEMS : INERT_MAX_OBJECT_KEYS;
  try {
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      enumerableKeys.push(key);
      if (enumerableKeys.length > enumerableLimit) return INERT_SNAPSHOT_FAILURE;
    }
  } catch {
    return INERT_SNAPSHOT_FAILURE;
  }

  if (isArray) {
    const length = arrayLength as number;
    if (enumerableKeys.length !== length) {
      return INERT_SNAPSHOT_FAILURE;
    }

    const clone: InertJsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        return INERT_SNAPSHOT_FAILURE;
      }
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return INERT_SNAPSHOT_FAILURE;
      }
      const nested = snapshotInertJson(descriptor.value, state, depth + 1);
      if (!nested.ok) return nested;
      clone[index] = nested.value;
    }
    return { ok: true, value: Object.freeze(clone) };
  }

  const clone: InertJsonObject = Object.create(null);
  for (const key of enumerableKeys) {
    state.keyCodeUnits += key.length;
    if (
      key.length > INERT_MAX_PROPERTY_NAME_CODE_UNITS
      || state.keyCodeUnits > INERT_MAX_TOTAL_KEY_CODE_UNITS
    ) {
      return INERT_SNAPSHOT_FAILURE;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return INERT_SNAPSHOT_FAILURE;
    }
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return INERT_SNAPSHOT_FAILURE;
    }
    const nested = snapshotInertJson(descriptor.value, state, depth + 1);
    if (!nested.ok) return nested;
    clone[key] = nested.value;
  }
  return { ok: true, value: Object.freeze(clone) };
}

function freezeInert<T extends object>(value: T): T {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor && descriptor.value !== null && typeof descriptor.value === 'object') {
      freezeInert(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function markSanitizedProgressEvent(event: ReviewYetiProgressEventV1): SanitizedProgressEvent {
  const immutableEvent = freezeInert(event) as SanitizedProgressEvent;
  sanitizedProgressEvents.add(immutableEvent);
  return immutableEvent;
}

export class ReviewEventRejection extends Error {
  public readonly name = 'ReviewEventRejection';

  public get ok(): false { return false; }
  public get accepted(): false { return false; }
  public get error(): ReviewEventRejection { return this; }
  public get rejection(): ReviewEventRejection { return this; }

  constructor(
    public readonly code: ReviewEventRejectionCode,
    public readonly field?: string,
    message = `Review progress event rejected: ${code}${field ? ` (${field})` : ''}`,
  ) {
    super(message);
  }
}

type PlainObjectInspection =
  | { kind: 'plain'; keys: string[] }
  | { kind: 'other' }
  | { kind: 'unsafe' };

function inspectEnumerablePlainObject(value: unknown): PlainObjectInspection {
  if (value === null || typeof value !== 'object') return { kind: 'other' };

  let prototype: object | null;
  try {
    if (nodeTypes.isProxy(value)) return { kind: 'unsafe' };
    if (Array.isArray(value)) return { kind: 'other' };
    prototype = Object.getPrototypeOf(value);
  } catch {
    return { kind: 'unsafe' };
  }
  if (prototype !== Object.prototype && prototype !== null) return { kind: 'unsafe' };

  const keys: string[] = [];
  let keyCodeUnits = 0;
  try {
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      keyCodeUnits += key.length;
      if (
        keys.length > INERT_MAX_OBJECT_KEYS
        || key.length > INERT_MAX_PROPERTY_NAME_CODE_UNITS
        || keyCodeUnits > INERT_MAX_TOTAL_KEY_CODE_UNITS
      ) {
        return { kind: 'unsafe' };
      }
    }
  } catch {
    return { kind: 'unsafe' };
  }
  return { kind: 'plain', keys };
}

type OwnDataRead =
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false };

function readEnumerableOwnData(
  value: object,
  enumerableKeys: readonly string[],
  key: string,
): OwnDataRead {
  if (!enumerableKeys.includes(key)) return { ok: true, present: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return { ok: false };
    return { ok: true, present: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

function preflightLegacyData(
  liveEvent: object,
  liveEventKeys: readonly string[],
): ReviewEventRejection | undefined {
  const dataRead = readEnumerableOwnData(liveEvent, liveEventKeys, 'data');
  if (!dataRead.ok) return new ReviewEventRejection('not_serializable');
  if (!dataRead.present) return undefined;

  const inspection = inspectEnumerablePlainObject(dataRead.value);
  if (inspection.kind === 'unsafe') return new ReviewEventRejection('not_serializable');
  if (inspection.kind === 'other') return undefined;

  for (const field of inspection.keys) {
    const normalized = legacyFieldName(field);
    if (FORBIDDEN_LEGACY_FIELDS.has(normalized)) {
      return new ReviewEventRejection(
        'forbidden_field',
        field,
        `Review progress event contains a ${FORBIDDEN_LEGACY_FIELDS.get(normalized)}`,
      );
    }
    if (!legacyProgressFields.has(field) && !OMITTED_LEGACY_FIELDS.has(normalized)) {
      return new ReviewEventRejection('unknown_field', field);
    }
  }
  return undefined;
}

export interface ReviewEventIdentityWire {
  repository_id: number;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  attempt_id: string;
  run_id: string;
  sequence: number;
  correlation_id: string;
  trace_id: string;
}

export type ReviewEventIdentityInput = (ReviewEventIdentity | ReviewEventIdentityWire) & {
  eventId?: string;
  event_id?: string;
};

function normalizeIdentity(value: InertJsonObject): Record<string, unknown> {
  const identity: Record<string, unknown> = Object.create(null);
  identity.repository_id = value.repositoryId ?? value.repository_id;
  identity.pr_number = value.prNumber ?? value.pr_number;
  identity.base_sha = value.baseSha ?? value.base_sha;
  identity.head_sha = value.headSha ?? value.head_sha;
  identity.attempt_id = value.attemptId ?? value.attempt_id;
  identity.run_id = value.runId ?? value.run_id;
  identity.sequence = value.sequence;
  identity.correlation_id = value.correlationId ?? value.correlation_id;
  identity.trace_id = value.traceId ?? value.trace_id;
  return identity;
}

function newUlid(timestamp: string): string {
  const parsedMilliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(parsedMilliseconds) || parsedMilliseconds < 0) {
    throw new Error('invalid event timestamp');
  }
  const milliseconds = BigInt(parsedMilliseconds);
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Number(milliseconds), 0, 6);
  randomBytes(10).copy(bytes, 6);

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let result = '';
  for (let index = 0; index < 26; index++) {
    result = ULID_ALPHABET[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function copyIfPresent(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: string = inputKey,
): void {
  if (hasOwn(input, inputKey) && input[inputKey] !== undefined) output[outputKey] = input[inputKey];
}

function copyNumber(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: string,
): void {
  if (hasOwn(input, inputKey) && input[inputKey] !== undefined) output[outputKey] = input[inputKey];
}

function buildProgressData(liveEvent: InertJsonObject): Record<string, unknown> | ReviewEventRejection {
  const source = liveEvent.data;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return new ReviewEventRejection('invalid_live_event', 'data');
  }
  const data = source as Record<string, unknown>;

  for (const field of Object.keys(data)) {
    const normalized = legacyFieldName(field);
    if (FORBIDDEN_LEGACY_FIELDS.has(normalized)) {
      return new ReviewEventRejection('forbidden_field', field, `Review progress event contains a ${FORBIDDEN_LEGACY_FIELDS.get(normalized)}`);
    }
    if (!legacyProgressFields.has(field) && !OMITTED_LEGACY_FIELDS.has(normalized)) {
      return new ReviewEventRejection('unknown_field', field);
    }
  }

  const output: Record<string, unknown> = Object.create(null);
  const persona = typeof liveEvent.persona === 'string' && liveEvent.persona.length > 0
    ? liveEvent.persona
    : data.personaId;
  if (persona !== undefined) output.persona = persona;
  copyIfPresent(output, data, 'stage');
  copyIfPresent(output, data, 'status');
  copyIfPresent(output, data, 'provider');
  const model = data.resolvedModel ?? data.model ?? data.requestedModel;
  if (model !== undefined) output.model = model;

  const tokensUsed = data.tokensUsed;
  if (tokensUsed !== undefined) {
    const tokenShape = z.object({ prompt: z.number(), completion: z.number(), total: z.number() }).strict().safeParse(tokensUsed);
    if (typeof tokensUsed !== 'object' || tokensUsed === null || Array.isArray(tokensUsed)) {
      if (typeof tokensUsed !== 'number') return new ReviewEventRejection('invalid_field', 'tokensUsed');
      output.total_tokens = tokensUsed;
    } else if (!tokenShape.success) {
      return new ReviewEventRejection('invalid_field', 'tokensUsed');
    } else {
      output.prompt_tokens = tokenShape.data.prompt;
      output.completion_tokens = tokenShape.data.completion;
      output.total_tokens = tokenShape.data.total;
    }
  }
  copyNumber(output, data, 'promptTokens', 'prompt_tokens');
  copyNumber(output, data, 'completionTokens', 'completion_tokens');
  copyNumber(output, data, 'totalTokens', 'total_tokens');
  copyNumber(output, data, 'durationMs', 'duration_ms');
  copyNumber(output, data, 'totalDurationMs', 'total_duration_ms');
  copyNumber(output, data, 'latencyMs', 'latency_ms');
  copyNumber(output, data, 'findingsCount', 'findings_count');
  copyNumber(output, data, 'totalFindings', 'total_findings');
  copyNumber(output, data, 'costUSD', 'cost_usd');
  copyNumber(output, data, 'totalCostUSD', 'total_cost_usd');
  copyIfPresent(output, data, 'errorClass', 'error_class');
  copyIfPresent(output, data, 'verdict');
  copyIfPresent(output, data, 'quorumSatisfied', 'quorum_satisfied');
  copyIfPresent(output, data, 'distinctProviders', 'distinct_providers');
  copyIfPresent(output, data, 'totalPersonasExecuted', 'total_personas_executed');

  for (const [field, value] of Object.entries(output)) {
    let hasCredential = typeof value === 'string' && containsCredentialLikeValue(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && !hasCredential; index += 1) {
        hasCredential = typeof value[index] === 'string' && containsCredentialLikeValue(value[index]);
      }
    }
    if (hasCredential) {
      return new ReviewEventRejection('forbidden_field', field, 'Review progress event contains credential-shaped value');
    }
  }

  return output;
}

const EVENT_KIND_BY_TYPE: Record<string, string> = {
  'persona:start': 'review.progress.persona_started',
  'persona:chunk': 'review.progress.persona_progress',
  'persona:complete': 'review.progress.persona_completed',
  'llm:prompt': 'review.progress.llm_prompt',
  'llm:token': 'review.progress.token_metrics',
  'llm:error': 'review.progress.llm_error',
  'omniroute:metric': 'review.progress.provider_metric',
  'openrouter:metric': 'review.progress.provider_metric',
  'ast:lookup': 'review.progress.analysis_lookup',
  'nit:suppression': 'review.progress.finding_suppression',
  'job:queued': 'review.progress.job_queued',
  'job:dispatched': 'review.progress.job_dispatched',
  'job:complete': 'review.progress.job_completed',
  agent_start: 'review.progress.persona_started',
  llm_chunk: 'review.progress.persona_progress',
  agent_done: 'review.progress.persona_completed',
  indexer_lookup: 'review.progress.analysis_lookup',
  quorum_verdict: 'review.progress.quorum_verdict',
};
const NEVER_FORWARD_EVENT_TYPES = new Set(['persona:chunk', 'llm:prompt', 'llm_chunk']);
const CANONICAL_MESSAGE_BY_EVENT_KIND: Record<string, string> = {
  'review.progress.persona_started': 'Persona review started',
  'review.progress.persona_completed': 'Persona review completed',
  'review.progress.token_metrics': 'Token metrics updated',
  'review.progress.llm_error': 'LLM request failed',
  'review.progress.provider_metric': 'Provider metrics updated',
  'review.progress.analysis_lookup': 'Analysis lookup completed',
  'review.progress.finding_suppression': 'Finding suppression evaluated',
  'review.progress.job_queued': 'Review queued',
  'review.progress.job_dispatched': 'Review dispatched',
  'review.progress.job_completed': 'Review completed',
  'review.progress.quorum_verdict': 'Quorum verdict recorded',
};

/**
 * Convert the legacy in-process event shape to the closed progress contract.
 * The returned envelope is the only value permitted to cross a future durable
 * event sink; the permissive legacy data map is never copied wholesale.
 */
export function sanitizeProgressEvent(
  liveEvent: LiveStreamEvent,
  identity: ReviewEventIdentityInput,
): SanitizedProgressEvent | ReviewEventRejection {
  if (!liveEvent || typeof liveEvent !== 'object') {
    return new ReviewEventRejection('invalid_live_event');
  }
  const liveInspection = inspectEnumerablePlainObject(liveEvent);
  if (liveInspection.kind === 'other') return new ReviewEventRejection('invalid_live_event');
  if (liveInspection.kind === 'unsafe') return new ReviewEventRejection('not_serializable');
  const unknownEventField = liveInspection.keys.find((field) => !LIVE_EVENT_FIELDS.has(field));
  if (unknownEventField) return new ReviewEventRejection('unknown_field', unknownEventField);

  const liveSnapshot = snapshotInertJson(liveEvent);
  if (!liveSnapshot.ok) {
    return new ReviewEventRejection('not_serializable');
  }
  if (!isInertJsonObject(liveSnapshot.value)) return new ReviewEventRejection('invalid_live_event');
  const eventRecord = liveSnapshot.value;

  const eventType = eventRecord.type;
  const eventKind = typeof eventType === 'string' ? EVENT_KIND_BY_TYPE[eventType] : undefined;
  if (!eventKind) return new ReviewEventRejection('invalid_live_event', 'type');
  if (NEVER_FORWARD_EVENT_TYPES.has(eventType as string)) {
    return new ReviewEventRejection('forbidden_field', 'type', 'Review progress event type carries non-sanitizable content');
  }

  if (!identity || typeof identity !== 'object') {
    return new ReviewEventRejection('invalid_identity');
  }
  const identityInspection = inspectEnumerablePlainObject(identity);
  if (identityInspection.kind === 'other') return new ReviewEventRejection('invalid_identity');
  if (identityInspection.kind === 'unsafe') return new ReviewEventRejection('not_serializable');
  if (identityInspection.keys.some((field) => !IDENTITY_INPUT_FIELDS.has(field))) {
    return new ReviewEventRejection('invalid_identity');
  }
  const identitySnapshot = snapshotInertJson(identity);
  if (!identitySnapshot.ok) {
    return new ReviewEventRejection('not_serializable');
  }
  if (!isInertJsonObject(identitySnapshot.value)) return new ReviewEventRejection('invalid_identity');
  const wireIdentity = normalizeIdentity(identitySnapshot.value);
  const identityResult = reviewEventIdentitySchema.safeParse(wireIdentity);
  if (!identityResult.success) return new ReviewEventRejection('invalid_identity');
  for (const [field, value] of Object.entries(identityResult.data)) {
    if (typeof value === 'string' && containsCredentialLikeValue(value)) {
      return new ReviewEventRejection(
        'forbidden_field',
        field,
        'Review progress event contains credential-shaped value',
      );
    }
  }

  const dataPreflight = preflightLegacyData(liveEvent, liveInspection.keys);
  if (dataPreflight) return dataPreflight;

  const data = buildProgressData(eventRecord);
  if (data instanceof ReviewEventRejection) return data;
  const canonicalMessage = CANONICAL_MESSAGE_BY_EVENT_KIND[eventKind];
  if (!canonicalMessage) return new ReviewEventRejection('invalid_live_event', 'type');
  data.message = canonicalMessage;
  const dataResult = progressDataSchema.safeParse(data);
  if (!dataResult.success) {
    const issuePath = dataResult.error.issues[0]?.path.join('.');
    return new ReviewEventRejection('invalid_field', issuePath ? `data.${issuePath}` : 'data');
  }

  const timestampResult = reviewEventTimestampSchema.safeParse(eventRecord.timestamp);
  if (!timestampResult.success) {
    return new ReviewEventRejection('invalid_field', 'timestamp');
  }

  let eventId: unknown;
  try {
    eventId = identitySnapshot.value.eventId
      ?? identitySnapshot.value.event_id
      ?? newUlid(timestampResult.data);
  } catch {
    return new ReviewEventRejection('invalid_field', 'timestamp');
  }

  const event: Record<string, unknown> = Object.create(null);
  event.schema = REVIEW_EVENT_SCHEMA;
  event.event_id = eventId;
  event.event_kind = eventKind;
  event.occurred_at = timestampResult.data;
  for (const [field, value] of Object.entries(identityResult.data)) event[field] = value;
  event.visibility = 'internal';
  event.data = data;

  try {
    const validation = reviewYetiEventV1Schema.safeParse(event);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      const field = issue?.path.length ? issue.path.join('.') : undefined;
      return new ReviewEventRejection('invalid_field', field);
    }
    const serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized, 'utf8') > REVIEW_EVENT_MAX_BYTES) {
      return new ReviewEventRejection('payload_too_large');
    }
    return markSanitizedProgressEvent(event as ReviewYetiProgressEventV1);
  } catch {
    return new ReviewEventRejection('invalid_live_event');
  }
}
