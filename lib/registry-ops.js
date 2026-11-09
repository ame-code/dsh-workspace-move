/**
 * Registry-level primitives shared by plan, execute and undo: entity snapshots,
 * session-header index updates, and the two structural writes the public
 * registry API cannot express (retargeting one workspace's path, merging a
 * moved session group back into its old registration).
 *
 * These helpers operate on the registry's own serialized operation queue so they
 * never interleave with a concurrent create/delete/attach from other plugins.
 * @module @reed-io/dsh-workspace-move
 */
import { samePath } from "./fsx.js";

/**
 * Serialize one operation behind the registry's own write queue.
 * @param registry - workspace registry service.
 * @param operation - work to run inside the queue.
 * @returns the operation result.
 */
/**
 * Reach the registry's durable record table.
 * @param registry - workspace registry service.
 * @returns the storage-domain table, or undefined when the registry is not ready.
 */
export function tableOf(registry) {
  const table = registry?.table;
  return typeof table === "function" ? table.call(registry) : table;
}

export function enqueue(registry, operation) {
  if (typeof registry.enqueueOperation === "function") return registry.enqueueOperation(operation);
  return operation();
}

/**
 * Read one workspace's stored record without touching live entity state.
 * @param registry - workspace registry service.
 * @param id - workspace id.
 * @returns the stored record, or undefined.
 */
export function recordOf(registry, id) {
  const table = tableOf(registry);
  return table?.get(id);
}

/**
 * Snapshot one workspace registration for rollback and review.
 * @param registry - workspace registry service.
 * @param id - workspace id.
 * @returns a plain snapshot.
 */
export function snapshotWorkspace(registry, id) {
  const record = recordOf(registry, id);
  if (record === undefined) return undefined;
  return {
    id,
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * Every session id the registry knows about, live or stored.
 * @param registry - workspace registry service.
 * @returns session ids.
 */
export function knownSessionIds(registry) {
  return [...(registry.headers?.keys() ?? [])];
}

/**
 * Make the live header index agree with a session whose header now carries `cwd`.
 * @param registry - workspace registry service.
 * @param id - session id.
 * @param cwd - the working directory the stored header now records.
 * @returns nothing.
 */
export function indexSessionAt(registry, id, cwd) {
  const headers = registry.headers;
  if (headers !== undefined) {
    const current = headers.get(id);
    if (current !== undefined) headers.set(id, { ...current, cwd });
  }
  registry.sessionPaths?.set(id, cwd);
  registry.missingSessionPaths?.delete(id);
  registry.invalidSessionPaths?.delete(id);
}

/**
 * Drop one session from the live header index, mirroring an unmounted session.
 * @param registry - workspace registry service.
 * @param id - session id.
 * @returns nothing.
 */
export function forgetSession(registry, id) {
  registry.headers?.delete(id);
  registry.sessionPaths?.delete(id);
  registry.missingSessionPaths?.delete(id);
  registry.invalidSessionPaths?.delete(id);
}

/**
 * Retarget one existing registration to a new directory without recreating it:
 * the record keeps its id, title, creation stamp and session order, and the
 * entity cache is rebuilt in the registry's durable order.
 * @param registry - workspace registry service.
 * @param id - workspace id.
 * @param path - canonical new path.
 * @param options - pass `{ rebuild: false }` to skip the entity rebuild.
 * @returns nothing.
 */
export async function retargetWorkspace(registry, id, path, options = {}) {
  const write = async () => {
    const record = recordOf(registry, id);
    if (record === undefined) throw new Error(`workspace '${id}' is no longer registered`);
    if (record.path !== path) {
      await tableOf(registry).update(id, (current) => ({ ...current, path, updatedAt: new Date().toISOString() }));
    }
    for (const sessionId of record.sessionIds) indexSessionAt(registry, sessionId, path);
    if (options.rebuild !== false) registry.rebuildEntities?.();
  };
  return write();
}

/**
 * Detach one session from every other registration that still claims it.
 * @param registry - workspace registry service.
 * @param sessionId - session id.
 * @param keepId - the registration that should keep it.
 * @returns nothing.
 */
export async function detachFromOthers(registry, sessionId, keepId) {
  for (const entity of registry.list()) {
    if (entity.id === keepId) continue;
    const ids = recordOf(registry, entity.id)?.sessionIds ?? [];
    if (!ids.includes(sessionId)) continue;
    await entity.detachSession(sessionId).catch(() => {});
  }
}

/**
 * Attach sessions to one registration, preserving their relative order.
 * @param registry - workspace registry service.
 * @param entity - target workspace entity.
 * @param sessionIds - desired session order.
 * @returns nothing.
 */
export async function attachOrdered(registry, entity, sessionIds) {
  const existing = recordOf(registry, entity.id)?.sessionIds ?? [];
  const missing = sessionIds.filter((id) => !existing.includes(id));
  for (const sessionId of missing) await detachFromOthers(registry, sessionId, entity.id);
  for (const sessionId of [...missing].reverse()) await entity.attachSession(sessionId);
  const order = recordOf(registry, entity.id)?.sessionIds ?? [];
  let previous;
  for (const sessionId of order) {
    if (!sessionIds.includes(sessionId)) continue;
    if (previous !== undefined) await entity.insertSessionBefore(sessionId, previous);
    previous = sessionId;
  }
}

/**
 * Report the workspace whose registration already owns a path, if any.
 * @param registry - workspace registry service.
 * @param path - canonical path.
 * @param exceptId - registration to ignore.
 * @returns the owning workspace id, or undefined.
 */
export function ownerOfPath(registry, path, exceptId) {
  for (const entity of registry.list()) {
    if (entity.id === exceptId) continue;
    if (samePath(entity.path, path)) return entity.id;
  }
  return undefined;
}
