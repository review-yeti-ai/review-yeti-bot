/** Shared source-read payload ceiling, independent of either review engine's initialization. */
export const REPO_READ_FILE_MAX_CHARS = 512 * 1024;

export const READ_FILES_MAX_FILES = 8;
// Share the existing numeric source-read bound, measured in UTF-8 bytes across the batch.
export const READ_FILES_MAX_BYTES = REPO_READ_FILE_MAX_CHARS;
