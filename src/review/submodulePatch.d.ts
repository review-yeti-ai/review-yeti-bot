export declare const SUBMODULE_MODE_HEADER_RE: RegExp;
export declare const SUBPROJECT_COMMIT_RE: RegExp;

/**
 * Identify whether diff patch text represents a git submodule / gitlink change.
 * Matches git index/mode headers for mode 160000 and valid Subproject commit SHA lines,
 * while safely rejecting ordinary source code or markdown text.
 */
export declare function isSubmodulePatch(patch: unknown): boolean;
