/**
 * Per-session work of a move: locate a session's artifact, take it down before
 * the workspace folder travels, and write it back at the path its new working
 * directory implies.
 *
 * Taking every session down first is what makes a half-moved session impossible
 * to observe: no live handle points at a folder that is being renamed, and no
 * index entry can claim a path that has not been written yet.
 * @module @reed-io/dsh-workspace-move
 */
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { copyArtifactWithCwd, isZstdFramed, readArtifactHeader, scanFrames, transcodeArtifactWithCwd } from "./artifact.js";
import { exists, foldCase } from "./fsx.js";
import { logPath, projectDir, sessionDir } from "./paths.js";

/**
 * Resolve the persistence root and compression the backend uses.
 * @param persistence - session persistence service.
 * @returns the root directory and the raw compression setting.
 */
export function persistenceInfo(persistence) {
  const root = persistence.root ?? persistence.config?.root;
  if (typeof root !== "string" || root === "") throw new Error("session persistence root is unknown");
  const raw = persistence.compression ?? persistence.config?.compression ?? "zstd";
  return { root, compression: raw === "none" || raw === undefined ? "none" : "zstd" };
}

/**
 * Compare two paths the way the running platform does.
 * @param value - path to normalize.
 * @returns a comparison key.
 */
function comparisonKey(value) {
  return foldCase(value.replace(/[\\/]+$/u, ""));
}

/**
 * Whether one path is the parent itself or lives underneath it.
 * @param child - candidate path.
 * @param parent - containing path.
 * @returns true when child is inside parent.
 */
export function isWithin(child, parent) {
  const inner = comparisonKey(child);
  const outer = comparisonKey(parent);
  if (inner === outer) return true;
  if (inner.startsWith(`${outer}\\`)) return true;
  return inner.startsWith(`${outer}/`);
}

/**
 * Locate one stored session: its artifact, the folder holding it, and its header.
 * @param ctx - Host context.
 * @param id - session id.
 * @returns the location, or undefined when the session is not stored.
 */
export async function locateSession(ctx, id) {
  const persistence = ctx.sessionPersistence;
  if (persistence === undefined) return undefined;
  const { root, compression } = persistenceInfo(persistence);
  const snapshot = await persistence.stat(id).catch(() => undefined);
  if (snapshot === undefined || snapshot.location === undefined) return undefined;
  const header = snapshot.header;
  const path = typeof snapshot.location.path === "string" ? snapshot.location.path : logPath(root, header.cwd, id, header.version ?? 4, compression);
  if (!isWithin(path, root)) return undefined;
  return { id, path, dir: dirname(path), header, root, compression };
}

/**
 * Collect the sessions one move carries: the ones the workspace lists, plus any
 * stored session whose header records a working directory inside the folder.
 * @param ctx - Host context.
 * @param workspace - the registry record being moved.
 * @returns located sessions, listed ones first.
 */
export async function collectSessions(ctx, workspace) {
  const located = [];
  const seen = new Set();
  for (const id of workspace.sessionIds) {
    const found = await locateSession(ctx, id).catch(() => undefined);
    if (found === undefined) continue;
    located.push({ ...found, listed: true });
    seen.add(id);
  }
  const persistence = ctx.sessionPersistence;
  if (persistence !== undefined) {
    const { root, compression } = persistenceInfo(persistence);
    const snapshots = await persistence.list().catch(() => []);
    for (const snapshot of snapshots) {
      const header = snapshot.header;
      const id = header?.id;
      const cwd = header?.cwd;
      if (typeof id !== "string" || typeof cwd !== "string" || seen.has(id)) continue;
      if (!isWithin(cwd, workspace.path)) continue;
      const path = logPath(root, cwd, id, header.version ?? 4, compression);
      located.push({ id, path, dir: dirname(path), header, root, compression, listed: false });
      seen.add(id);
    }
  }
  return located;
}

/**
 * Take one session down for the duration of the folder move: its folder is
 * renamed into the plugin's backup area, so nothing can read a half-written log.
 * @param backupRoot - plugin-owned backup directory.
 * @param tag - unique label for this move.
 * @param entry - located session.
 * @returns where the archived folder now lives.
 */
export async function takeDownSession(backupRoot, tag, entry) {
  const target = join(backupRoot, tag, basename(entry.dir));
  await mkdir(dirname(target), { recursive: true });
  await rename(entry.dir, target);
  return target;
}

/**
 * Delete the backup area of one move.
 * @param backupRoot - plugin-owned backup directory.
 * @param tag - unique label for this move.
 * @returns nothing.
 */
export async function dropBackup(backupRoot, tag) {
  await rm(join(backupRoot, tag), { recursive: true, force: true }).catch(() => {});
}

/**
 * Find the log inside one archived session folder.
 * @param folder - archived session folder.
 * @returns the log path and the log filename.
 */
async function logIn(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const log = entries.find((entry) => entry.isFile() && entry.name.startsWith("session.") && entry.name.includes(".jsonl"));
  if (log === undefined) throw new Error(`archived session '${folder}' holds no log`);
  return { path: join(folder, log.name), name: log.name };
}

/**
 * Write one taken-down session at the path its new working directory implies,
 * keeping every payload byte, then move any companion files next to it.
 * @param entry - located session (original location).
 * @param archived - archived session folder.
 * @param cwd - the new working directory.
 * @returns the log path at the new location.
 */
export async function writeBackSession(entry, archived, cwd) {
  const log = await logIn(archived);
  const targetDir = sessionDir(entry.root, cwd, entry.id);
  await mkdir(targetDir, { recursive: true });
  const target = join(targetDir, log.name);
  await rm(target, { force: true }).catch(() => {});
  await copyArtifactWithCwd(log.path, target, cwd, entry.id);
  const companions = await readdir(archived, { withFileTypes: true });
  for (const companion of companions) {
    if (companion.name === log.name) continue;
    const from = join(archived, companion.name);
    const to = join(targetDir, companion.name);
    await rm(to, { recursive: true, force: true }).catch(() => {});
    await renameOrCopy(from, to);
  }
  const header = await readArtifactHeader(target);
  if (header.cwd !== cwd) throw new Error(`session '${entry.id}' did not adopt cwd '${cwd}'`);
  return target;
}

/**
 * Rename a companion file or folder, falling back to a copy across devices.
 * @param from - source path.
 * @param to - destination path.
 * @returns nothing.
 */
async function renameOrCopy(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await mkdir(dirname(to), { recursive: true });
    await moveAcrossDevices(from, to);
  }
}

/**
 * Copy one path tree across devices and drop the source.
 * @param from - source path.
 * @param to - destination path.
 * @returns nothing.
 */
async function moveAcrossDevices(from, to) {
  const stat = await (await import("node:fs/promises")).stat(from);
  if (!stat.isDirectory()) {
    await copyFile(from, to);
    await rm(from, { force: true });
    return;
  }
  await mkdir(to, { recursive: true });
  for (const child of await readdir(from)) await moveAcrossDevices(join(from, child), join(to, child));
  await rm(from, { recursive: true, force: true });
}

/**
 * Put one session back exactly where it was, with its original working directory.
 * Accepts both the original folder and the backup copy as the source.
 * @param entry - located session describing the original location.
 * @param cwd - the working directory to record in the header.
 * @param fallbackFolder - backup folder holding the intact original, if any.
 * @returns nothing.
 */
export async function restoreSession(entry, cwd, fallbackFolder) {
  const usable = fallbackFolder !== undefined && (await exists(fallbackFolder)) && (await logIn(fallbackFolder).then(() => true).catch(() => false));
  if (!usable) fallbackFolder = undefined;
  if (fallbackFolder !== undefined) {
    await rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    await mkdir(dirname(entry.dir), { recursive: true });
    await renameOrCopy(fallbackFolder, entry.dir);
  }
  const log = await logIn(entry.dir);
  await normalizeLog(log.path, cwd, entry.id);
  return;
}

/**
 * Rewrite one log's header in place, re-encoding every frame only when the log
 * cannot be copied verbatim.
 * @param path - log path.
 * @param cwd - working directory to record.
 * @param id - expected session id.
 * @returns nothing.
 */
async function normalizeLog(path, cwd, id) {
  const header = await readArtifactHeader(path);
  if (header.cwd === cwd) return;
  const bytes = await (await import("node:fs/promises")).readFile(path);
  const frames = isZstdFramed(bytes) ? scanFrames(bytes).frames.length : 1;
  const stage = join(dirname(path), `.dshwm-transcode-${process.pid}-${Date.now()}`);
  if (frames <= 2) {
    await copyArtifactWithCwd(path, stage, cwd, id);
  } else {
    await transcodeArtifactWithCwd(path, stage, cwd, id);
  }
  await rm(path, { force: true });
  await rename(stage, path);
}

/**
 * Every stored session folder whose working directory lives under one path.
 * @param ctx - Host context.
 * @param path - the folder about to move.
 * @returns located sessions.
 */
export async function sessionsUnder(ctx, path) {
  const persistence = ctx.sessionPersistence;
  if (persistence === undefined) return [];
  const snapshots = await persistence.list().catch(() => []);
  const { root, compression } = persistenceInfo(persistence);
  const found = [];
  for (const snapshot of snapshots) {
    const header = snapshot.header;
    if (typeof header?.cwd !== "string" || !isWithin(header.cwd, path)) continue;
    found.push({ id: header.id, header, cwd: header.cwd, root, compression, project: projectDir(root, header.cwd) });
  }
  return found;
}
