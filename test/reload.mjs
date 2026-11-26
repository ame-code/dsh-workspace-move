import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "../lib/plugin.js";
import { API_PREFIX } from "../lib/host-api.js";

// 模拟 WebServer 的显式 disposer 与 Tools 的自动 effect，保留真实插件 handler。
function harness() {
  const routes = new Map();
  const tools = new Map();
  function context() {
    let active = true;
    let reads = 0;
    const disposers = [];
    const ctx = {
      logger: { warn() {} },
      effect(callback) {
        const dispose = callback();
        if (dispose !== undefined) disposers.push(dispose);
        return dispose;
      },
      get workspaceRegistry() {
        assert.equal(active, true, "handler must use an active context");
        reads += 1;
        return { list: () => [] };
      },
      webServer: {
        register(route) {
          if (routes.has(route.path)) throw new Error("duplicate prefix route");
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        }
      },
      tools: {
        register(tool) {
          return ctx.effect(() => {
            if (tools.has(tool.name)) throw new Error("already registered");
            tools.set(tool.name, tool);
            return () => tools.delete(tool.name);
          });
        }
      }
    };
    return { ctx, get reads() { return reads; }, dispose() {
      active = false;
      for (const dispose of disposers.reverse()) dispose();
    } };
  }
  return { routes, tools, context };
}

function plan(handler) {
  return new Promise((resolve, reject) => {
    const request = {
      method: "POST", url: `${API_PREFIX}/plan`,
      headers: { "x-dsh-workspace-move": "1", host: "127.0.0.1:4379" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ workspaceId: "missing", targetParent: process.cwd() })); }
    };
    handler(request, { writeHead() {}, end(body) {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    }, destroy: reject });
  });
}

test("reload removes registrations and binds requests to the new active context", async () => {
  const host = harness();
  const old = host.context();
  apply(old.ctx);
  const oldHandler = host.routes.get(API_PREFIX).handler;
  assert.equal((await plan(oldHandler)).code, "workspace-unknown");
  old.dispose();
  assert.equal(host.routes.size, 0);
  assert.equal(host.tools.size, 0);
  const fresh = host.context();
  try {
    apply(fresh.ctx);
    assert.notEqual(host.routes.get(API_PREFIX).handler, oldHandler);
    assert.equal((await plan(host.routes.get(API_PREFIX).handler)).code, "workspace-unknown");
    assert.equal(old.reads, 1);
    assert.equal(fresh.reads, 1);
    assert.equal(host.tools.size, 1);
  } finally { fresh.dispose(); }
  assert.equal(host.routes.size, 0);
  assert.equal(host.tools.size, 0);
});

test("a pre-existing route collision is reported instead of retaining a stale handler", () => {
  const host = harness();
  host.routes.set(API_PREFIX, {});
  const instance = host.context();
  assert.throws(() => apply(instance.ctx), /duplicate prefix route/);
  instance.dispose();
  assert.equal(host.tools.size, 0);
  assert.equal(host.routes.size, 1);
});

test("a tool collision is reported and the owned route remains disposable", () => {
  const host = harness();
  host.tools.set("move_workspace", {});
  const instance = host.context();
  assert.throws(() => apply(instance.ctx), /already registered/);
  instance.dispose();
  assert.equal(host.routes.size, 0);
  assert.equal(host.tools.size, 1);
});
