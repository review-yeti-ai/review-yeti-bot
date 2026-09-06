import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module identified by `entryUrl` is the process entrypoint.
 *
 * Node realpath-resolves `import.meta.url` but leaves `process.argv[1]` exactly
 * as invoked, so the common `argv[1] === fileURLToPath(import.meta.url)` guard
 * silently stops matching whenever the script is reached through a symlink:
 * `main()` never runs and the process exits 0 with no output, which every caller
 * reads as success. Both sides are canonicalised here so real and linked paths
 * agree.
 *
 * `entryUrl` is a parameter rather than read internally because a shared module
 * cannot see its importer's `import.meta.url` — callers pass their own.
 */
export function isEntrypoint(entryUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(entryUrl));
  } catch {
    return false;
  }
}
