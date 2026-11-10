/**
 * Executing a move: take the sessions down, move the folder once, put the
 * sessions back where the new path says they live, then re-point every affected
 * registration. Every step records how to reverse itself, and a failure walks
 * that record backwards, so a move either lands completely or leaves nothing
 * behind.
 * @module @reed-io/dsh-workspace-move
 */
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { exists, isInside, moveDirectory, removeIfEmpty, samePath } from "./fsx.js";
import { buildPlan, fail } from "./plan.js";
import { attachOrdered, retargetWorkspace, snapshotWorkspace } from "./registry-ops.js";
import { collectSessions, dropBackup, locateSession, persistenceInfo, pruneProjectDirs, restoreSession, takeDownSession, writeBackSession } from "./sessions.js";

/** Backup folder name — distinct from other plugins' folders beside it. */
const BACKUP_LEAF = "dshwm-move-backup";

/**
 * The backup area used while a move is in flight, beside the persistence root so
 * it always shares a volume with the artifacts it holds.
 * @param ctx - Host context.
 * @returns the absolute backup root.
 */
export function backupRootOf(ctx) {
  const { root } = persistenceInfo(ctx.sessionPersistence);
  return join(dirname(root), BACKUP_LEAF);
}

/**
 * Build a unique label for one move attempt.
 * @returns a filesystem-safe tag.
 */
function newTag() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Move a workspace, its folder tree, nested registrations and sessions.
 * @param ctx - Host context.
 * @param request - workspace id, destination parent, optional folder name and rename flags.
 * @returns the record kept for undo.
 */
export async function performMove(ctx, request) {
  const built = await buildPlan(ctx, request);
  if (built.failure !== undefined) throw toError(built.failure);
  const plan = built.plan;
  if (plan.active.length > 0) {
    const failure = fail("sessions-running", "Stop the running sessions before moving this workspace.", { active: plan.active });
    throw toError(failure);
  }
  const registry = ctx.workspaceRegistry;
  const workspace = registry.list().find((entity) => entity.id === plan.workspaceId);
  if (workspace === undefined) throw toError(fail("workspace-unknown", "That workspace is no longer registered."));
  const record = snapshotWorkspace(registry, plan.workspaceId);
  const listedOrder = [...record.sessionIds];
  const sessions = await collectSessions(ctx, { ...record, path: plan.sourceCanonical });
  const backupRoot = backupRootOf(ctx);
  const tag = newTag();
  const undo = {
    tag,
    allowed: request?.allowUndo !== false,
    workspaceId: plan.workspaceId,
    title: record.title,
    source: record.path,
    sourceCanonical: plan.sourceCanonical,
    destination: plan.destination,
    folderName: plan.folderName,
    titleChanged: false,
    nested: plan.nested.map((entry) => ({ ...entry })),
    sessions: sessions.map((session) => ({ id: session.id, dir: session.dir, path: session.path, cwd: session.header.cwd, listed: session.listed }))
  };
  const takenDown = [];
  let moved = undefined;
  try {
    for (const session of sessions) {
      const archived = await takeDownSession(backupRoot, tag, session).catch(async (error) => {
        if (error?.code !== "ENOENT") throw error;
        return undefined;
      });
      if (archived !== undefined) takenDown.push({ session, archived });
    }
    const how = await moveDirectory(plan.sourceCanonical, plan.destination);
    moved = { from: plan.sourceCanonical, to: plan.destination, how };
    const canonicalDestination = await canonicalOf(plan.destination);
    for (const { session, archived } of takenDown) {
      const relative = session.header.cwd.slice(plan.sourceCanonical.length).replace(/^[\\/]+/u, "");
      const cwd = relative === "" ? canonicalDestination : join(canonicalDestination, relative);
      await writeBackSession(session, archived, cwd);
    }
    await applyRegistry(registry, plan, canonicalDestination, workspace, listedOrder, undo);
    await dropBackup(backupRoot, tag);
    await pruneProjectDirs(takenDown.map(({ session }) => dirname(session.dir)), takenDown[0]?.session.root);
    await removeIfEmpty(plan.sourceCanonical);
    return undo;
  } catch (error) {
    await rollback(ctx, undo, takenDown, moved);
    throw error;
  }
}

/**
 * Repoint several registrations in one durable step, then rebuild the entity
 * cache once so every lookup sees the new paths.
 * @param registry - workspace registry service.
 * @param moves - `{ id, path }` pairs.
 * @returns nothing.
 */
async function applyRetargets(registry, moves) {
  for (const move of moves) await retargetWorkspace(registry, move.id, move.path, { rebuild: false });
  registry.rebuildEntities?.();
}

/**
 * Canonicalize a directory that exists.
 * @param path - directory path.
 * @returns its real path.
 */
async function canonicalOf(path) {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

/**
 * Re-point the moved registration, the nested ones, and the session account.
 * @param registry - workspace registry service.
 * @param plan - the executed plan.
 * @param destination - canonical destination folder.
 * @param workspace - the moved entity.
 * @param listedOrder - the workspace's session order before the move.
 * @param undo - the undo record being filled in.
 * @returns nothing.
 */
async function applyRegistry(registry, plan, destination, workspace, listedOrder, undo) {
  const moves = [
    { id: plan.workspaceId, path: destination },
    ...plan.nested.map((nested) => ({ id: nested.id, path: join(destination, nested.from.slice(plan.sourceCanonical.length).replace(/^[\\/]+/u, "")) }))
  ];
  await applyRetargets(registry, moves);
  const entity = registry.list().find((candidate) => candidate.id === plan.workspaceId) ?? workspace;
  await attachOrdered(registry, entity, listedOrder);
  const members = new Set(listedOrder);
  for (const session of undo.sessions) {
    if (!session.listed && !members.has(session.id)) await entity.attachSession(session.id).catch(() => {});
  }
  const wantTitle = plan.renamed;
  if (wantTitle) {
    const currentTitle = registry.list().find((candidate) => candidate.id === plan.workspaceId)?.title;
    const previousName = basename(plan.source);
    if (currentTitle === undefined || currentTitle === previousName) {
      await entity.setTitle(plan.folderName);
      undo.titleChanged = true;
    }
  }
}

/**
 * Reverse a partially applied move.
 * @param ctx - Host context.
 * @param undo - the record describing the move.
 * @param takenDown - sessions already archived.
 * @param moved - folder move description, when it happened.
 * @returns nothing; rollback problems are logged, not thrown.
 */
async function rollback(ctx, undo, takenDown, moved) {
  const registry = ctx.workspaceRegistry;
  const problems = [];
  try {
    if (moved !== undefined) {
      if (await exists(moved.to)) {
        if (await exists(moved.from)) await rm(moved.to, { recursive: true, force: true }).catch((error) => problems.push(String(error)));
        else await moveDirectory(moved.to, moved.from).catch((error) => problems.push(String(error)));
      }
      await mkdir(moved.from, { recursive: true }).catch(() => {});
      await applyRetargets(registry, [{ id: undo.workspaceId, path: undo.sourceCanonical }, ...undo.nested.map((nested) => ({ id: nested.id, path: nested.from }))]).catch((error) => problems.push(String(error)));
      if (undo.titleChanged) {
        const entity = registry.list().find((candidate) => candidate.id === undo.workspaceId);
        if (entity !== undefined) await entity.setTitle(undo.title).catch((error) => problems.push(String(error)));
      }
    }
    for (const { session, archived } of [...takenDown].reverse()) {
      await restoreSession(session, session.header.cwd, archived).catch((error) => problems.push(String(error)));
    }
    await pruneProjectDirs(takenDown.map(({ session }) => dirname(session.dir)), takenDown[0]?.session.root);
  } finally {
    if (problems.length > 0) ctx.logger?.warn?.(`workspace-move: rollback left problems: ${problems.join("; ")}`);
  }
}

/**
 * Undo one recorded move: everything returns to where it was.
 * @param ctx - Host context.
 * @param undo - the record kept by {@link performMove}.
 * @returns nothing.
 */
export async function undoMove(ctx, undo) {
  const registry = ctx.workspaceRegistry;
  if (undo === undefined) throw toError(fail("nothing-to-undo", "There is no move to undo."));
  const current = registry.list().find((entity) => entity.id === undo.workspaceId);
  if (current === undefined) throw toError(fail("workspace-unknown", "The workspace is no longer registered, so this move cannot be undone."));
  if (!samePath(current.path, undo.destination)) throw toError(fail("undo-stale", "The workspace has moved again since; this move can no longer be undone."));
  if (await exists(undo.source)) throw toError(fail("undo-blocked", `'${undo.source}' is occupied again.`, { path: undo.source }));
  const sessions = [];
  for (const session of undo.sessions) {
    const fallback = { id: session.id, dir: session.dir, path: session.path, header: { id: session.id, cwd: session.cwd, version: 4 }, ...persistenceInfo(ctx.sessionPersistence) };
    const found = await locateSession(ctx, session.id).catch(() => undefined);
    sessions.push({ entry: found ?? fallback, original: session });
  }
  const takenDown = [];
  const backupRoot = backupRootOf(ctx);
  const tag = `${undo.tag}-undo`;
  let moved;
  try {
    for (const { entry } of sessions) {
      const archived = await takeDownSession(backupRoot, tag, entry).catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
      takenDown.push({ entry, archived });
    }
    await moveDirectory(undo.destination, undo.source);
    moved = { from: undo.destination, to: undo.source };
    for (const { entry, original } of sessions) {
      const source = takenDown.find((item) => item.entry.id === entry.id)?.archived ?? original.dir;
      await restoreSession({ ...entry, dir: original.dir, path: original.path }, original.cwd, source);
    }
    await applyRetargets(registry, [{ id: undo.workspaceId, path: undo.sourceCanonical }, ...undo.nested.map((nested) => ({ id: nested.id, path: nested.from }))]);
    if (undo.titleChanged) {
      const entity = registry.list().find((candidate) => candidate.id === undo.workspaceId);
      if (entity !== undefined) await entity.setTitle(undo.title).catch(() => {});
    }
    await dropBackup(backupRoot, tag);
    await pruneProjectDirs(sessions.map(({ entry }) => dirname(entry.dir)), sessions[0]?.entry.root);
    await removeIfEmpty(undo.destination);
  } catch (error) {
    if (moved !== undefined && !(await exists(undo.destination)) && (await exists(undo.source))) {
      await moveDirectory(undo.source, undo.destination).catch(() => {});
    }
    for (const { entry, archived } of [...takenDown].reverse()) {
      const cwd = entry.header?.cwd ?? entry.cwd;
      if (cwd !== undefined) await restoreSession(entry, cwd, archived).catch(() => {});
    }
    throw error;
  }
}

/**
 * Turn a structured failure into a thrown error carrying its code.
 * @param failure - the structured failure.
 * @returns an Error with `code` and `details`.
 */
export function toError(failure) {
  const error = new Error(failure.message);
  error.code = failure.code;
  error.details = failure.details ?? {};
  return error;
}

/**
 * Guard: a path that is the workspace itself or an ancestor of it.
 * @param path - candidate path.
 * @param workspacePath - workspace directory.
 * @returns whether path is unsafe as a destination parent.
 */
export function isUnsafeParent(path, workspacePath) {
  return samePath(path, workspacePath) || isInside(path, workspacePath);
}
