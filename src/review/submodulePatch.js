'use strict';

const SUBMODULE_MODE_HEADER_RE = /^(?:index [0-9a-fA-F]+\.\.[0-9a-fA-F]+ 160000|(?:new|deleted) file mode 160000|(?:old|new) mode 160000)\b/m;
const SUBPROJECT_COMMIT_RE = /^[+-]Subproject commit [0-9a-fA-F]{7,40}\b/m;

/**
 * Identify whether diff patch text represents a git submodule / gitlink change.
 * Matches git index/mode headers for mode 160000 and valid Subproject commit SHA lines,
 * while safely rejecting ordinary source code or markdown text.
 */
function isSubmodulePatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return false;
  return SUBMODULE_MODE_HEADER_RE.test(patch) || SUBPROJECT_COMMIT_RE.test(patch);
}

module.exports = {
  isSubmodulePatch,
  SUBMODULE_MODE_HEADER_RE,
  SUBPROJECT_COMMIT_RE,
};
