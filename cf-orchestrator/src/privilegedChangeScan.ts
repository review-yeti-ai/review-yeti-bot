/**
 * Privileged-change detection for operator-passthrough publications.
 *
 * REL-3357: a passthrough SHIP is not review evidence. When the paused publisher
 * publishes that check on a pull request that changes privileged or
 * runtime-sensitive manifests, the check summary must name those changes so the
 * merge is not silently green. This module only classifies the diff; it never
 * starts a review or changes the passthrough disposition (ADR 0769 suppresses
 * ordinary admission and dispatch while the pause is on).
 */

export const PRIVILEGED_CHANGE_SCAN_VERSION = 'PrivilegedChangeScan.v1' as const;

/** Upper bound keeps the check summary readable and the audit record bounded. */
export const PRIVILEGED_CHANGE_FINDING_LIMIT = 20;

export type PrivilegedChangeRule =
  | 'privileged-container'
  | 'root-user'
  | 'added-capability'
  | 'host-network'
  | 'host-namespace'
  | 'host-path'
  | 'rbac-change'
  | 'network-policy-removal';

export interface PrivilegedChangeFinding {
  rule: PrivilegedChangeRule;
  file: string;
  detail: string;
}

export interface PrivilegedChangeScanFile {
  filename: string;
  status: string;
  patch?: string | null;
}

export interface PrivilegedChangeScanOptions {
  /** True when the listing stopped at the page cap before exhausting the diff. */
  truncated?: boolean;
}

export type PrivilegedChangeScan =
  | {
    version: typeof PRIVILEGED_CHANGE_SCAN_VERSION;
    status: 'complete';
    filesScanned: number;
    truncated: boolean;
    findings: PrivilegedChangeFinding[];
  }
  | {
    version: typeof PRIVILEGED_CHANGE_SCAN_VERSION;
    status: 'unavailable';
    reason: string;
  };

const MANIFEST_PATH = /\.(?:ya?ml|json)$/iu;
const MAX_DETAIL_LENGTH = 120;

function normalizeDetail(line: string): string {
  const trimmed = line.replace(/\s+/gu, ' ').trim();
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH - 1)}…` : trimmed;
}

function changedLines(patch: string | null | undefined): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  if (typeof patch !== 'string' || patch.length === 0) return { added, removed };
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

function classifyLine(line: string): PrivilegedChangeRule | null {
  if (/^\s*privileged:\s*true\s*(?:#.*)?$/iu.test(line)) return 'privileged-container';
  if (/^\s*runAsUser:\s*0\s*(?:#.*)?$/u.test(line)) return 'root-user';
  if (/^\s*hostNetwork:\s*true\s*(?:#.*)?$/iu.test(line)) return 'host-network';
  if (/^\s*(?:hostPID|hostIPC):\s*true\s*(?:#.*)?$/iu.test(line)) return 'host-namespace';
  if (/^\s*hostPath:\s*\S*/u.test(line)) return 'host-path';
  return null;
}

function isCapabilityAdd(line: string, patch: string | null | undefined): boolean {
  if (!/^\s*add:\s*(?:\[.*\]|)$/u.test(line)) return false;
  return typeof patch === 'string' && /^\s*\+\s*.*capabilities:/mu.test(patch);
}

function kindOf(line: string): string | null {
  const match = /^\s*-?\s*kind:\s*['"]?([A-Za-z][A-Za-z0-9]*)['"]?\s*$/u.exec(line);
  return match ? match[1] : null;
}

/**
 * Classify a GitHub pull-request file list. Findings are stable for an exact
 * head/base pair: they derive only from the immutable diff and file metadata.
 */
export function scanPrivilegedChanges(
  files: readonly PrivilegedChangeScanFile[],
  options: PrivilegedChangeScanOptions = {}
): PrivilegedChangeScan {
  const findings: PrivilegedChangeFinding[] = [];
  const seen = new Set<string>();
  let filesScanned = 0;

  const record = (rule: PrivilegedChangeRule, file: string, detail: string): void => {
    const key = `${rule}\u0000${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (findings.length >= PRIVILEGED_CHANGE_FINDING_LIMIT) return;
    findings.push({ rule, file, detail: normalizeDetail(detail) });
  };

  for (const file of files) {
    const filename = typeof file?.filename === 'string' ? file.filename : '';
    if (!filename || !MANIFEST_PATH.test(filename)) continue;
    filesScanned += 1;
    const status = typeof file.status === 'string' ? file.status : 'modified';
    const { added, removed } = changedLines(file.patch);

    for (const line of added) {
      const rule = classifyLine(line);
      if (rule) record(rule, filename, line);
      else if (isCapabilityAdd(line, file.patch)) record('added-capability', filename, line);
    }

    for (const line of [...added, ...removed]) {
      const kind = kindOf(line);
      if (kind === 'Role' || kind === 'ClusterRole' || kind === 'RoleBinding' || kind === 'ClusterRoleBinding') {
        record('rbac-change', filename, line);
      }
      if (kind === 'NetworkPolicy' && (removed.includes(line) || status === 'removed')) {
        record('network-policy-removal', filename, line);
      }
    }

    if (status === 'removed' && /network[-_]?polic/iu.test(filename) && !seen.has(`network-policy-removal\u0000${filename}`)) {
      record('network-policy-removal', filename, 'NetworkPolicy manifest removed');
    }
  }

  return {
    version: PRIVILEGED_CHANGE_SCAN_VERSION,
    status: 'complete',
    filesScanned,
    truncated: options.truncated === true,
    findings,
  };
}

function marker(scan: PrivilegedChangeScan): string {
  if (scan.status === 'unavailable') return 'privileged-change-scan=unavailable';
  if (scan.findings.length === 0) return 'privileged-change-scan=clear';
  const rules = Array.from(new Set(scan.findings.map((finding) => finding.rule))).sort().join(',');
  return `privileged-change-scan=escalated;rules=${rules}`;
}

/**
 * Rendered into the passthrough `Review Yeti` and `Review Yeti Gate` summaries.
 * The passthrough verdict and conclusion are unchanged; the escalation is a
 * visible, machine-readable notice that no semantic review covered the change.
 */
export function formatPrivilegedChangeScan(scan: PrivilegedChangeScan): string {
  if (scan.status === 'unavailable') {
    return [
      `${marker(scan)}. Privileged change scan unavailable (${scan.reason}); privileged or runtime-sensitive changes were not checked.`,
    ].join('\n');
  }

  const scope = `${scan.filesScanned} changed manifest file(s)${scan.truncated ? ' (scan truncated at the file cap)' : ''}`;
  if (scan.findings.length === 0) {
    return [`${marker(scan)}. No privileged or runtime-sensitive changes detected in ${scope}.`].join('\n');
  }

  const lines = [
    `${marker(scan)}. ${scan.findings.length} privileged or runtime-sensitive change(s) detected in ${scope}. `
      + 'This passthrough SHIP is not review evidence: obtain an independent review or an explicit operator acknowledgement before merge (REL-3357).',
    ...scan.findings.map((finding) => `  - [${finding.rule}] ${finding.file}: ${finding.detail}`),
  ];
  return lines.join('\n');
}
