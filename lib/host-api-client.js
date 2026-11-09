/**
 * The Host API transport contract: the route prefix, the header every call
 * carries, and the one call helper. Host code imports the constants only; the
 * Client half carries its own copy of both the constants and the helper, because
 * it is bundled for the browser and cannot import this module.
 * @module @reed-io/dsh-workspace-move
 */

/** Stable route prefix of the Host API. */
export const API_PREFIX = "/dsh-workspace-move/api";

/** Header every Client call carries. */
export const API_HEADER = "x-dsh-workspace-move";

/**
 * POST one action to the Host and unwrap its envelope.
 * @param action - action name.
 * @param body - JSON body.
 * @returns the action result.
 */
export async function callHost(action, body = {}) {
  const response = await fetch(`${API_PREFIX}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", [API_HEADER]: "1" },
    body: JSON.stringify(body),
    credentials: "same-origin"
  });
  if (!response.ok) {
    const error = new Error(`request failed with status ${response.status}`);
    error.code = `http-${response.status}`;
    throw error;
  }
  const envelope = await response.json();
  if (envelope.ok !== true) {
    const error = new Error(envelope.message ?? envelope.code ?? "request failed");
    error.code = envelope.code;
    error.details = envelope.details ?? {};
    throw error;
  }
  return envelope.result;
}
