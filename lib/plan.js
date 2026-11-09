/**
 * Planning a move before anything is written: which workspace is the subject,
 * where it lands, which nested registrations must follow it, and why a request
 * has to be refused.
 *
 * A plan is pure data. Everything it claims was read from the filesystem and the
 * registry, so the UI can show exactly what will happen and the engine can later
 * refuse a plan whose preconditions no longer hold.
 * @module @reed-io/dsh-workspace-move
 */
import { basename, join, resolve } from "node:path";
import { canonicalPath, exists, isInside, samePath } from "./fsx.js";
import { recordOf } from "./registry-ops.js";
import { collectSessions, isWithin } from "./sessions.js";

/**
 * Build one failure object the surfaces can render.
 * @param code - stable machine-readable reason.
 * @param message - human-readable explanation.
 * @param details - extra structured context.
 * @returns the failure.
 */
export function fail(code, message, details = {}) {
  return { code, message, details };
}

/**
 * Problems that make a folder name unusable as a workspace folder.
 * @param name - proposed folder name.
 * @returns a failure, or undefined when the name is fine.
 */
export function nameProblem(name) {
  if (typeof name !== "string" || name.trim() === "") return fail("name-empty", "Enter a folder name.");
  if (name !== name.trim()) return fail("name-padded", "A folder name cannot start or end with a space.");
  if (name === "." || name === "..") return fail("name-relative", "A folder name cannot be '.' or '..'.");
  if (/[\\/:*?"<>|\u0000-\u001F]/u.test(name)) return fail("name-invalid", "A folder name cannot contain \\ / : * ? \" < > |.");
  if (/[. ]$/u.test(name)) return fail("name-trailing", "A folder name cannot end with a dot or a space.");
  return undefined;
}

/**
 * Describe where a workspace lives and where a move would send it.
 * @param sourcePath - the workspace's current directory.
 * @param targetParent - the destination parent folder.
 * @param folderName - the folder name at the destination (defaults to the current name).
 * @returns the resolved destination paths.
 */
export async function resolveTarget(sourcePath, targetParent, folderName) {
  const parent = resolve(targetParent);
  if (!isAbsolute(targetParent)) return { failure: fail("target-relative", "Choose an absolute destination folder.") };
  if (!(await exists(parent))) return { failure: fail("target-missing", `The folder '${parent}' does not exist.`, { parent }) };
  const name = typeof folderName === "string" && folderName.trim() !== "" ? folderName.trim() : basename(sourcePath);
  const problem = nameProblem(name);
  if (problem !== undefined) return { failure: problem };
  const destination = join(parent, name);
  if (samePath(destination, sourcePath)) {
    return { failure: fail("target-same", "The workspace is already in that folder.") };
  }
  if (isInside(destination, sourcePath)) {
    return { failure: fail("target-inside", "A workspace cannot be moved into its own folder.") };
  }
  if (isInside(sourcePath, destination)) {
    return { failure: fail("target-ancestor", "That destination is inside the workspace's own current folder chain.") };
  }
  if (await exists(destination)) {
    return { failure: fail("target-exists", `'${destination}' already exists. Pick another name.`, { destination }) };
  }
  return { canonicalParent: await canonicalPath(parent), destination, folderName: name, renamed: !samePath(destination, sourcePath) && basename(sourcePath) !== name };
}

/**
 * Whether a path is absolute on the running platform.
 * @param value - candidate path.
 * @returns whether it is absolute.
 */
function isAbsolute(value) {
  if (typeof value !== "string" || value === "") return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
  return value.startsWith("/");
}

/**
 * Nested registrations whose path lives inside the moving folder.
 * @param registry - workspace registry service.
 * @param workspaceId - the workspace being moved.
 * @param sourcePath - the folder that will move.
 * @param destination - where that folder will be.
 * @returns one entry per affected registration, with its planned path and title.
 */
export function nestedMoves(registry, workspaceId, sourcePath, destination) {
  return registry
    .list()
    .filter((entity) => entity.id !== workspaceId && isWithin(entity.path, sourcePath))
    .map((entity) => {
      const next = join(destination, entity.path.slice(sourcePath.length).replace(/^[\\/]+/u, ""));
      return { id: entity.id, from: entity.path, to: next, title: entity.title };
    });
}

/**
 * Sessions of one workspace that currently have running work.
 * @param ctx - Host context.
 * @param sessionIds - sessions to check.
 * @returns the active sessions with the kind of work each reports.
 */
export async function activeSessions(ctx, sessionIds) {
  const active = [];
  for (const sessionId of sessionIds) {
    let activities = [];
    try {
      activities = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
    } catch {
      activities = [];
    }
    const kinds = (Array.isArray(activities) ? activities : []).flat().map((item) => item?.kind ?? "busy").filter(Boolean);
    if (kinds.length > 0) active.push({ sessionId, kinds: [...new Set(kinds)] });
  }
  return active;
}

/**
 * Build the full plan for one requested move.
 * @param ctx - Host context.
 * @param request - workspace id, destination parent and optional folder name.
 * @returns `{ plan }` or `{ failure }`.
 */
export async function buildPlan(ctx, request) {
  const registry = ctx.workspaceRegistry;
  if (registry === undefined) return { failure: fail("registry-unavailable", "The workspace registry is unavailable.") };
  const workspaceId = typeof request?.workspaceId === "string" ? request.workspaceId : "";
  const entity = registry.list().find((candidate) => candidate.id === workspaceId);
  const record = recordOf(registry, workspaceId);
  if (entity === undefined || record === undefined) return { failure: fail("workspace-unknown", "That workspace is no longer registered.") };
  const resolved = await resolveTarget(record.path, request?.targetParent ?? "", request?.folderName);
  if (resolved.failure !== undefined) return { failure: resolved.failure };
  const active = await activeSessions(ctx, record.sessionIds);
  const sessions = await collectSessions(ctx, record);
  const nested = nestedMoves(registry, workspaceId, record.path, resolved.destination);
  const currentName = basename(record.path);
  return {
    plan: {
      workspaceId,
      title: record.title,
      source: record.path,
      sourceCanonical: await canonicalPath(record.path),
      destination: resolved.destination,
      targetParent: resolved.canonicalParent,
      folderName: resolved.folderName,
      renamed: resolved.folderName !== currentName,
      sessionIds: [...record.sessionIds],
      sessions: sessions.map((session) => ({ id: session.id, listed: session.listed, path: session.path })),
      nested,
      active
    }
  };
}
