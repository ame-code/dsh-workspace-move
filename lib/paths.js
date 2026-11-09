/**
 * Session artifact layout helpers. The jsonl backend derives the on-disk folder
 * from a session's `cwd` and its header; these mirrors let the move engine place
 * and verify artifacts without importing backend internals.
 * @module @reed-io/dsh-workspace-move
 */
import { join } from "node:path";

const PROJECT_KEY_LIMIT = 251;

/**
 * Encode one path segment the way the backend encodes session folders.
 * @param value - segment to encode.
 * @returns the portable segment.
 */
export function encodeSegment(value) {
  if (value.length === 0) throw new Error("cannot encode an empty path segment");
  if (value === ".") return "~002E";
  if (value === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char !== "~" && /^[A-Za-z0-9._-]$/u.test(char)) out += char;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * Fold a working directory into a project folder name.
 * @param cwd - session working directory.
 * @returns the project key used as a storage folder name.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === "/" || char === "\\" || char === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (char !== "~" && /^[A-Za-z0-9._-]$/u.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/u, "") || "root").slice(0, PROJECT_KEY_LIMIT)}--`;
}

/**
 * Locate the folder holding every session of one working directory.
 * @param root - persistence root.
 * @param cwd - session working directory, or undefined for the cwd-less group.
 * @returns absolute project folder.
 */
export function projectDir(root, cwd) {
  return cwd === undefined ? join(root, "_no-cwd") : join(root, projectKey(cwd));
}

/**
 * Locate one session's artifact folder.
 * @param root - persistence root.
 * @param cwd - session working directory.
 * @param id - session id.
 * @returns absolute session folder.
 */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

/**
 * Tag one artifact filename with its format version and compression.
 * @param version - session format version.
 * @param compression - artifact compression ("zstd" by default, "none" when raw).
 * @returns artifact filename.
 */
export function logFilename(version, compression = "zstd") {
  const suffix = compression === undefined || compression === "none" ? "" : `.${compression}`;
  return version === 0 ? `session.jsonl${suffix}` : `session.v${version}.jsonl${suffix}`;
}

/**
 * Locate one session's current-format artifact.
 * @param root - persistence root.
 * @param cwd - session working directory.
 * @param id - session id.
 * @param version - session format version.
 * @param compression - artifact compression.
 * @returns absolute artifact path.
 */
export function logPath(root, cwd, id, version = 4, compression = "zstd") {
  return join(sessionDir(root, cwd, id), logFilename(version, compression));
}
