/**
 * Validates whether a repository full name is included in the deployment pilot scope.
 * Supports comma-separated lists and wildcard `all`. Case-insensitive and defensive.
 */
export function isPilotRepository(repoFullName: string, pilotList?: string): boolean {
  if (!repoFullName || typeof repoFullName !== 'string') return false;
  if (!pilotList || pilotList.trim() === '') return false;
  if (pilotList.trim().toLowerCase() === 'all') return true;
  const pilots = pilotList
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return pilots.includes(repoFullName.toLowerCase());
}
