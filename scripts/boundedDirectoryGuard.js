const os = require('node:os');
const path = require('node:path');

/**
 * Return true only for a path that is specific enough to be a disposable
 * runtime directory. This is intentionally side-effect free so the Action
 * installer can test the safety boundary without touching the filesystem.
 */
function isBoundedDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) return false;

  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());

  return resolved !== root && resolved !== home && resolved.length >= root.length + 8;
}

module.exports = { isBoundedDirectory };
