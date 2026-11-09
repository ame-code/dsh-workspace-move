/**
 * Host half of the workspace move plugin: wires the move engine to the Client
 * dialog route, the agent tool, and the in-memory undo record.
 * @module @reed-io/dsh-workspace-move
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { exists, samePath } from "./fsx.js";
import { performMove, toError, undoMove } from "./engine.js";
import { API_PREFIX, createHandler } from "./host-api.js";
import { browse, createFolder } from "./directory-browse.js";
import { buildPlan } from "./plan.js";

/** Cordis plugin name. */
export const name = "workspace-move";

/** Services the plugin needs before it can answer a move request. */
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence", "tools"];

/**
 * The single move a running Harness can undo. Kept in memory on purpose: the
 * record describes live folders and a registry that only exist for this run.
 */
export const undoState = { last: undefined };

/**
 * Product view of one finished move: what a caller may report, and whether undo
 * is offered for it.
 * @param record - the undo record kept by the engine.
 * @returns the summarized outcome.
 */
function summarize(record) {
  undoState.last = record.allowed ? record : undefined;
  return {
    destination: record.destination,
    source: record.source,
    title: record.title,
    sessions: record.sessions.length,
    nested: record.nested.length,
    undoable: undoState.last !== undefined
  };
}

/**
 * Mount the plugin.
 * @param ctx - Cordis context.
 */
export function apply(ctx) {
  const logger = ctx.logger;
  const actions = {
    /**
     * Review a requested move without touching anything.
     * @param body - workspace id and destination.
     * @returns the plan or the reason it cannot proceed.
     */
    async plan(body) {
      const built = await buildPlan(ctx, body);
      if (built.failure !== undefined) throw toError(built.failure);
      return built.plan;
    },
    /**
     * Execute a requested move and remember it for undo.
     * @param body - workspace id and destination.
     * @returns the resulting locations.
     */
    async move(body) {
      return summarize(await performMove(ctx, body));
    },
    /**
     * Report what could be undone right now.
     * @returns the recorded move, or nothing.
     */
    async undoInfo() {
      const last = undoState.last;
      if (last === undefined) return { available: false };
      const registered = ctx.workspaceRegistry?.list().find((entity) => entity.id === last.workspaceId);
      const occupied = await exists(last.source).catch(() => false);
      const available = registered !== undefined && samePath(registered.path, last.destination) && !occupied;
      return { available, title: last.title, source: last.source, destination: last.destination, workspaceId: last.workspaceId, occupied };
    },
    /**
     * Undo the recorded move.
     * @returns nothing.
     */
    async undo() {
      const last = undoState.last;
      if (last === undefined) throw toError({ code: "nothing-to-undo", message: "There is no move to undo.", details: {} });
      await undoMove(ctx, last);
      undoState.last = undefined;
      return { restored: last.source };
    },
    /**
     * List the subfolders of one destination folder.
     * @param body - the folder to list.
     * @returns folders, breadcrumbs and the entry cap.
     */
    async browse(body) {
      return browse(body?.path);
    },
    /**
     * Create one folder inside a destination folder.
     * @param body - parent folder and new folder name.
     * @returns the new folder path.
     */
    async createFolder(body) {
      return { path: await createFolder(body?.parent, body?.name) };
    }
  };
  try {
    ctx.webServer.register({ kind: "prefix", path: API_PREFIX, handler: createHandler(actions, logger) });
  } catch (error) {
    // A hot reload can re-apply this plugin while the previous route is still
    // mounted. The handler only reads module-level state, so the existing route
    // serves the new instance just as well; failing here would take the plugin
    // down for no reason.
    if (!/duplicate prefix route/i.test(String(error?.message ?? error))) throw error;
    logger?.warn?.(`workspace-move: ${API_PREFIX} is already mounted; reusing the existing route`);
  }

  const tool = defineTool({
    name: "move_workspace",
    description:
      "Move one registered workspace to another folder, together with its folder tree, nested workspaces registered inside it, and its stored sessions. A different folder name renames the workspace. Fails while its sessions are running; the Harness GUI offers undo for the last move of this run.",
    parameters: {
      workspaceId: { type: "string", description: "Id of the workspace to move, as reported by the workspace list." },
      targetParent: { type: "string", description: "Absolute path of the folder that will contain the moved workspace." },
      folderName: { type: "string", description: "Folder name inside the destination parent. Omit to keep the current folder name." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          destination: { type: "string", required: true },
          source: { type: "string", required: true },
          title: { type: "string", required: true },
          sessions: { type: "number", required: true },
          nested: { type: "number", required: true },
          undoable: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
    },
    async execute(args) {
      return summarize(
        await performMove(ctx, { workspaceId: args.workspaceId, targetParent: args.targetParent, folderName: args.folderName })
      );
    },
    presentCall: (args) => ({ card: "generic", title: "move_workspace", rawInput: args })
  });

  try {
    ctx.tools.register(tool);
  } catch (error) {
    // Same reload situation as the route above: an earlier copy of this plugin
    // may still own the tool name.
    if (!/already (?:registered|exists)|duplicate/i.test(String(error?.message ?? error))) throw error;
    logger?.warn?.("workspace-move: move_workspace is already registered; keeping the existing tool");
  }
}
