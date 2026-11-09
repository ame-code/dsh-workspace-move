/**
 * Transport between the Client surface and this Host plugin.
 *
 * The Host owns every filesystem and registry write, so the Client dialog talks
 * to it over a same-origin JSON route. The route only answers requests a page
 * served by this same Harness instance could make: the request must arrive from
 * the loopback interface, carry the plugin header, come from a same-origin
 * fetch or a non-browser client, and name this Host in an Origin header when it
 * sends one. Anything else is refused, so the route stays inert for other
 * origins a browser might visit.
 * @module @reed-io/dsh-workspace-move
 */

import { API_HEADER, API_PREFIX } from "./host-api-client.js";

export { API_HEADER, API_PREFIX };

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Whether an address literal belongs to the loopback interface.
 * @param address - socket remote address.
 * @returns whether it is loopback.
 */
function isLoopbackAddress(address) {
  if (typeof address !== "string" || address === "") return false;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  return address.startsWith("::ffff:127.");
}

/**
 * Resolve the http origin part of a header value.
 * @param value - header value such as `http://127.0.0.1:4379`.
 * @returns the origin, or undefined when the value is not an origin.
 */
function originOf(value) {
  if (typeof value !== "string" || value === "" || value === "null") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether one request may reach the Host API.
 * @param request - incoming request.
 * @returns whether the request is trusted.
 */
export function isTrustedRequest(request) {
  if (request.headers[API_HEADER] !== "1") return false;
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const host = request.headers.host;
  if (typeof host !== "string" || host === "") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const parsed = originOf(origin);
  if (parsed === undefined) return false;
  try {
    return new URL(parsed).host === host;
  } catch {
    return false;
  }
}

/**
 * Read a request body, refusing oversized payloads.
 * @param request - incoming request.
 * @returns the decoded UTF-8 body.
 */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Write one JSON reply.
 * @param response - server response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable payload.
 * @returns nothing.
 */
function send(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

/**
 * Build the request handler over one action table.
 * @param actions - map of action name to async function of the parsed body.
 * @param logger - Host logger used for contained failures.
 * @returns a node request handler.
 */
export function createHandler(actions, logger) {
  return (request, response) => {
    const run = async () => {
      if (request.method !== "POST") {
        send(response, 405, { ok: false, code: "method-not-allowed" });
        return;
      }
      if (!isTrustedRequest(request)) {
        send(response, 403, { ok: false, code: "untrusted-request" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const name = url.pathname.slice(API_PREFIX.length).replace(/^\//u, "");
      const action = actions[name];
      if (action === undefined) {
        send(response, 404, { ok: false, code: "unknown-action" });
        return;
      }
      let body;
      try {
        const text = await readBody(request);
        body = text === "" ? {} : JSON.parse(text);
      } catch (error) {
        send(response, 400, { ok: false, code: "bad-request", message: String(error) });
        return;
      }
      try {
        const result = await action(body);
        send(response, 200, { ok: true, result });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        logger?.warn?.(`workspace-move: action '${name}' failed: ${failure.message}`);
        send(response, 200, {
          ok: false,
          code: failure.code ?? "failed",
          message: failure.message,
          details: failure.details ?? {}
        });
      }
    };
    run().catch((error) => {
      logger?.warn?.(`workspace-move: request handling failed: ${String(error)}`);
      try {
        send(response, 500, { ok: false, code: "internal" });
      } catch {
        response.destroy?.();
      }
    });
  };
}
