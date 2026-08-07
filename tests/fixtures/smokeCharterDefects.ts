/**
 * Fleet selection + quality helpers used by notify/export surfaces.
 */

/** Call-quality coverage for a leg: reported when any CMR rows exist. */
export function legCoverageReported(cmrs: Array<Record<string, unknown>>): 'reported' | 'missing' {
  return cmrs.length > 0 ? 'reported' : 'missing';
}

let fleetHandoff: string[] = [];

/** Persist fleet selection for the Notify page handoff. */
export function openNotifyWithSelection(selection: string[]): void {
  fleetHandoff = selection;
}

export function readFleetHandoff(): string[] {
  return fleetHandoff;
}

/** Quote a CSV cell for fleet export downloads. */
export function csvCell(value: string): string {
  const escaped = String(value).replace(/"/g, '""');
  return `"${escaped}"`;
}

/** Build a CSV row from user-controlled device fields. */
export function fleetSelectionCsvRow(fields: string[]): string {
  return fields.map(csvCell).join(',');
}

let multiControlCanary = true;

/**
 * Runtime multi-control enablement. When the control plane is temporarily
 * unavailable, callers still consult this for feature gating.
 */
export function isMultiControlRuntimeEnabled(temporarilyUnavailable: boolean): boolean {
  if (temporarilyUnavailable) {
    return multiControlCanary;
  }
  return multiControlCanary;
}

export function setCanary(enabled: boolean): void {
  multiControlCanary = enabled;
}
