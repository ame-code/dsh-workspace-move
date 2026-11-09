/**
 * Folder browsing for the destination picker. The Host answers from the same
 * filesystem the move will use, so a folder only appears when it is genuinely a
 * place a workspace can live.
 * @module @reed-io/dsh-workspace-move
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPath, isMissing } from "./fsx.js";

const MAX_ENTRIES = 2000;

/**
 * Describe the chain of folders leading to one directory.
 * @param path - absolute directory.
 * @returns breadcrumbs from the filesystem root to the directory.
 */
function crumbsOf(path) {
  const chain = [];
  let cursor = path;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      chain.unshift({ name: cursor, path: cursor, hidden: false });
      break;
    }
    const name = basename(cursor);
    chain.unshift({ name, path: cursor, hidden: name.startsWith(".") });
    cursor = parent;
  }
  return chain;
}

/**
 * List the subfolders of one directory for the destination picker.
 * @param requested - directory to list; empty selects the home directory.
 * @returns the canonical directory, its breadcrumbs, and its subfolders.
 */
export async function browse(requested) {
  const target = typeof requested === "string" && requested.trim() !== "" ? requested : homedir();
  const path = await canonicalPath(target);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      const failure = new Error(`folder '${path}' does not exist`);
      failure.code = "directory-missing";
      throw failure;
    }
    const failure = new Error(`folder '${path}' cannot be read`);
    failure.code = "directory-unreadable";
    throw failure;
  }
  const folders = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: join(path, entry.name),
      hidden: entry.name.startsWith("."),
      isSymbolicLink: entry.isSymbolicLink()
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  return {
    path,
    home: await canonicalPath(homedir()),
    crumbs: crumbsOf(path),
    entries: folders.slice(0, MAX_ENTRIES),
    truncated: folders.length > MAX_ENTRIES
  };
}

/**
 * Create one folder inside a directory for the destination picker.
 * @param parent - existing directory.
 * @param name - new folder name.
 * @returns the canonical new folder path.
 */
export async function createFolder(parent, name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "" || trimmed === "." || trimmed === ".." || /[\\/]/u.test(trimmed)) {
    const failure = new Error("folder name must be one path segment");
    failure.code = "directory-invalid-name";
    throw failure;
  }
  const base = await canonicalPath(parent);
  const target = resolve(base, trimmed);
  const { mkdir } = await import("node:fs/promises");
  try {
    await mkdir(target);
  } catch (error) {
    const failure = new Error(`folder '${target}' could not be created`);
    failure.code = error?.code === "EEXIST" ? "directory-exists" : "directory-create-failed";
    throw failure;
  }
  return canonicalPath(target);
}
