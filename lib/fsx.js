/**
 * Filesystem primitives shared by the move engine: JSON-friendly errors for the
 * HTTP boundary, existence checks, canonical-path normalization, and same-filesystem
 * rename with a verified copy fallback (the `mv` semantics the feature promises).
 * @module @reed-io/dsh-workspace-move
 */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

/** Failure carrying a stable machine code the Client maps onto localized text. */
export class MoveError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - operator-facing description.
   * @param details - optional structured context for the Client.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MoveError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Is the failure a missing-path rejection?
 * @param error - any rejection value.
 * @returns whether the error code is ENOENT.
 */
export function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Resolve whether a path exists, without following a dangling link into an error.
 * @param path - absolute path.
 * @returns whether anything (file, directory, or link) occupies the path.
 */
export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Resolve one path to its canonical form: the real path when it exists, and the
 * canonical form of the deepest existing ancestor joined with the remainder when
 * it does not (a target that is about to be created).
 * @param path - absolute path to canonicalize.
 * @returns canonical absolute path.
 */
export async function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const missing = [];
  let cursor = absolute;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ""));
    cursor = parent;
    try {
      return join(await realpath(cursor), ...missing);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

/**
 * Compare two paths after canonicalization, case-insensitively on Windows.
 * @param left - first path.
 * @param right - second path.
 * @returns whether they name the same location.
 */
export function samePath(left, right) {
  const normalize = (value) => {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

/** Is `child` strictly inside `parent` (case-insensitive on Windows)? */
export function isInside(child, parent) {
  const norm = (value) => {
    const absolute = resolve(value);
    return (process.platform === "win32" ? absolute.toLowerCase() : absolute).replace(/[\\/]+$/, "");
  };
  const inner = norm(child);
  const outer = norm(parent).replace(/^[\/]+/u, "");
  if (inner === outer) return false;
  if (outer === "") return true;
  return inner.length > outer.length && inner.startsWith(outer) && /[\\/]/.test(inner.charAt(outer.length));
}

/**
 * Whether two paths live on the same filesystem volume, where a rename is atomic.
 * Falls back to "same volume" on platforms without a dev field.
 * @param from - source path.
 * @param to - destination path.
 * @returns whether the paths share a device.
 */
export async function sameDevice(from, to) {
  const nearest = async (path) => {
    let cursor = path;
    for (;;) {
      try {
        const info = await stat(cursor);
        return info;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      cursor = parent;
    }
  };
  const [left, right] = await Promise.all([nearest(from), nearest(dirname(to))]);
  if (left === undefined || right === undefined) return true;
  if (typeof left.dev === "number" && typeof right.dev === "number") return left.dev === right.dev;
  return parse(resolve(from)).root.toLowerCase() === parse(resolve(to)).root.toLowerCase();
}

/**
 * Recursively copy a tree, preserving symlinks as links instead of following them.
 * @param from - source root.
 * @param to - destination root (must not exist).
 * @param progress - optional callback receiving the number of entries copied.
 */
export async function copyTree(from, to, progress) {
  let copied = 0;
  const walk = async (source, target) => {
    const info = await lstat(source);
    if (info.isSymbolicLink()) return; // links are reported by the caller, never followed
    if (info.isDirectory()) {
      await mkdir(target, { recursive: false });
      const entries = await readdir(source, { withFileTypes: true });
      for (const entry of entries) await walk(join(source, entry.name), join(target, entry.name));
      copied += 1;
      progress?.(copied);
      return;
    }
    await copyFile(source, target, constants.COPYFILE_EXCL);
    copied += 1;
    if (copied % 64 === 0) progress?.(copied);
  };
  await walk(from, to);
  return copied;
}

/**
 * Compare two trees entry by entry (names, kinds, sizes, link targets) without
 * reading file contents — the verification a cross-volume `mv` performs before
 * the source is removed.
 * @param left - original root.
 * @param right - copied root.
 * @returns the first mismatch description, or undefined when the trees agree.
 */
export async function compareTree(left, right) {
  const walk = async (source, target) => {
    const info = await lstat(source);
    const mirror = await lstat(target).catch(() => undefined);
    if (mirror === undefined) return `missing at destination: ${target}`;
    if (info.isSymbolicLink() || mirror.isSymbolicLink()) {
      if (!info.isSymbolicLink() || !mirror.isSymbolicLink()) return `entry type differs: ${source}`;
      const [leftTarget, rightTarget] = await Promise.all([readlinkOf(source), readlinkOf(target)]);
      return leftTarget === rightTarget ? undefined : `link target differs: ${source}`;
    }
    if (info.isDirectory() !== mirror.isDirectory()) return `entry type differs: ${source}`;
    if (!info.isDirectory()) return info.size === mirror.size ? undefined : `size differs: ${source}`;
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const mismatch = await walk(join(source, entry.name), join(target, entry.name));
      if (mismatch !== undefined) return mismatch;
    }
    return undefined;
  };
  return walk(left, right);
}

async function readlinkOf(path) {
  const { readlink } = await import("node:fs/promises");
  return readlink(path);
}

/**
 * Move a directory: a same-volume rename when possible, otherwise copy, verify,
 * then remove the source. The destination must not exist.
 * @param from - source directory.
 * @param to - destination directory.
 * @param progress - optional progress callback.
 * @returns how the directory travelled.
 */
export async function moveDirectory(from, to, progress) {
  await mkdir(dirname(to), { recursive: true });
  if (await sameDevice(from, to)) {
    await rename(from, to);
    return "rename";
  }
  await copyTree(from, to, progress);
  const mismatch = await compareTree(from, to);
  if (mismatch !== undefined) {
    await rm(to, { recursive: true, force: true }).catch(() => {});
    throw new MoveError("copy-mismatch", `copied tree did not match the source (${mismatch})`);
  }
  await rm(from, { recursive: true, force: true });
  return "copy";
}

/**
 * Remove a directory only when it is empty; a parent or a non-empty folder is
 * never touched, so whatever else lives there survives.
 * @param path - directory to remove if empty.
 * @returns whether it was removed.
 */
export async function removeIfEmpty(path) {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) return false;
    await rm(path, { recursive: false });
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    return false;
  }
}

/**
 * Validate a single folder-name segment the way the OS would refuse it.
 * @param name - candidate folder name.
 * @returns undefined when valid, otherwise a stable reason code.
 */
export function folderNameProblem(name) {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") return "name-invalid";
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(trimmed)) return "name-invalid";
  if (trimmed.endsWith(".") || trimmed.endsWith(" ")) return "name-invalid";
  if (isAbsolute(trimmed)) return "name-invalid";
  return undefined;
}
