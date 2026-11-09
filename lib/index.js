/**
 * Host half of the workspace move plugin: the route the Client dialog calls, the
 * agent tool, and the in-memory record that makes a move undoable until the
 * Harness restarts.
 * @module @reed-io/dsh-workspace-move
 */
export { apply, inject, name, undoState } from "./plugin.js";
