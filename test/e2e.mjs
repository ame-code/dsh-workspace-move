/**
 * End-to-end run of the move engine against a real (in-process) Harness: the
 * session, storage, persistence and workspace services are the shipped ones, the
 * web server and tool registry are stubs, and every step goes through the same
 * HTTP route the dialog uses.
 *
 *   npm install --no-save @deepseek-ai/cordis@4.1.0 @deepseek-ai/dsh-tools@0.2.2-rc.1 \
 *     @deepseek-ai/dsh-session@0.2.2-rc.1 @deepseek-ai/dsh-storage@0.2.2-rc.1 \
 *     @deepseek-ai/dsh-storage-json@0.2.2-rc.1 @deepseek-ai/dsh-storage-domain@0.2.2-rc.1 \
 *     @deepseek-ai/dsh-session-persistence-jsonl@0.2.2-rc.1 @deepseek-ai/dsh-workspace@0.2.2-rc.1
 *   node test/e2e.mjs
 */
import { Context } from "@deepseek-ai/cordis";
import * as session from "@deepseek-ai/dsh-session";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "@deepseek-ai/dsh-storage";
import * as storageJson from "@deepseek-ai/dsh-storage-json";
import * as storageDomain from "@deepseek-ai/dsh-storage-domain";
import * as persistenceJsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import * as workspace from "@deepseek-ai/dsh-workspace";
import * as plugin from "../lib/plugin.js";

// realpath up front: macOS hands out /var/... for /private/var/..., and the
// registry canonicalizes paths, so an un-canonical sandbox would fail every
// comparison for reasons that have nothing to do with moving.
const sandbox = await realpath(await mkdtemp(join(tmpdir(), "dshwm-e2e-")));
const storageRoot = join(sandbox, "storages");
const sessionRoot = join(sandbox, "sessions");
const home = join(sandbox, "work");
await mkdir(join(home, "proj", "src", "deep"), { recursive: true });
await mkdir(join(home, "proj", "docs"), { recursive: true });
await mkdir(join(home, "dest"), { recursive: true });
await mkdir(join(home, "dest", "occupied"), { recursive: true });
await writeFile(join(home, "dest", "occupied", "keep.txt"), "occupied");
await writeFile(join(home, "proj", "README.md"), "hello");
await writeFile(join(home, "proj", "src", "deep", "a.txt"), "deep file");

const ctx = new Context();
ctx.provide("logger", { info() {}, warn: (...a) => console.log("[warn]", ...a), error: console.error });
ctx.plugin(session.default ?? session);
ctx.plugin(storage.default ?? storage);
ctx.plugin(storageJson.default ?? storageJson, { root: storageRoot });
await new Promise((r) => setTimeout(r, 50));
ctx.plugin(persistenceJsonl.default ?? persistenceJsonl, { root: sessionRoot });
await new Promise((r) => setTimeout(r, 50));
await ctx.plugin(storageDomain.default ?? storageDomain, { backend: "json" });
ctx.plugin(workspace.default ?? workspace);
await new Promise((r) => setTimeout(r, 300));
const reg = ctx.workspaceRegistry;
const persist = ctx.sessionPersistence;

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (${JSON.stringify(actual)})`}`);
};

const makeSession = async (cwd, label) => {
  const header = { version: 4, id: `session-${label}`, createdAt: Date.now(), isSeeded: false, delegationDepth: 0, cwd, agentPreset: "cordis" };
  const handle = await persist.create(header);
  for (let seq = 0; seq < 5; seq += 1) {
    await handle.append([{ type: "session/title", seq, time: Date.now() + seq, data: { title: `${label}-${seq}`, messageSeqs: [], source: { kind: "user" } } }]);
  }
  await handle.flush();
  await handle.close();
  return `session-${label}`;
};

const s1 = await makeSession(join(home, "proj"), "alpha");
const s2 = await makeSession(join(home, "proj"), "beta");
const ws = await reg.create(join(home, "proj"), "proj");
await ws.attachSession(s1);
await ws.attachSession(s2);
const nested = await reg.create(join(home, "proj", "src", "deep"), "deep");

const registered = { routes: [] };
ctx.provide("webServer", { register(r) { registered.routes.push(r); } });
ctx.provide("tools", { register() {} });
await ctx.plugin(plugin);
const handler = registered.routes[0].handler;
const call = (action, body) => new Promise((resolve) => {
  const request = {
    method: "POST", url: `/dsh-workspace-move/api/${action}`,
    headers: { "x-dsh-workspace-move": "1", host: "127.0.0.1:4379" },
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() { return (async function* () { yield Buffer.from(JSON.stringify(body ?? {})); })(); }
  };
  const response = { writeHead(s) { this.status = s; }, end(d) { resolve(JSON.parse(d.toString())); }, destroy() {} };
  Promise.resolve(handler(request, response)).catch((e) => resolve({ threw: String(e?.stack ?? e) }));
});

try {
  // --- guard rails ---------------------------------------------------------
  const unknown = await call("plan", { workspaceId: "nope", targetParent: join(home, "dest") });
  check("unknown workspace rejected", unknown.code, "workspace-unknown");
  const occupied = await call("plan", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "occupied" });
  check("occupied target rejected", occupied.code, "target-exists");
  const intoSelf = await call("plan", { workspaceId: ws.id, targetParent: join(home, "proj", "src"), folderName: "move-me" });
  check("target inside source rejected", intoSelf.code, "target-inside");
  const badName = await call("plan", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "a/b" });
  check("bad folder name rejected", badName.code, "name-invalid");

  // --- plain move (no rename) ----------------------------------------------
  const plain = await call("move", { workspaceId: ws.id, targetParent: join(home, "dest") });
  check("plain move ok", plain.ok, true);
  check("plain move keeps name", plain.result.destination, join(home, "dest", "proj"));
  check("registry path follows", reg.list().find((w) => w.id === ws.id).path, join(home, "dest", "proj"));
  check("nested path follows", reg.list().find((w) => w.id === nested.id).path, join(home, "dest", "proj", "src", "deep"));
  check("session cwd follows", (await persist.stat(s1)).header.cwd, join(home, "dest", "proj"));
  check("payload preserved", (await readFile(join(home, "dest", "proj", "src", "deep", "a.txt"), "utf8")), "deep file");
  check("source removed", await readdir(home).then((v) => v.includes("proj")), false);
  const redo = await call("undo", {});
  check("undo plain ok", redo.ok, true);
  check("undo path restored", reg.list().find((w) => w.id === ws.id).path, join(home, "proj"));
  check("undo nested restored", reg.list().find((w) => w.id === nested.id).path, join(home, "proj", "src", "deep"));
  check("undo session cwd", (await persist.stat(s1)).header.cwd, join(home, "proj"));
  check("undo source back", await readdir(home).then((v) => v.includes("proj")), true);

  // --- move with rename ----------------------------------------------------
  const renamed = await call("move", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "proj-renamed" });
  check("rename move ok", renamed.ok, true);
  check("rename title follows", reg.list().find((w) => w.id === ws.id).title, "proj-renamed");
  check("rename destination", renamed.result.destination, join(home, "dest", "proj-renamed"));
  check("undoable reported", renamed.result.undoable, true);
  check("nested renamed path", reg.list().find((w) => w.id === nested.id).path, join(home, "dest", "proj-renamed", "src", "deep"));
  const reverted = await call("undo", {});

  check("undo rename ok", reverted.ok, true);
  check("undo rename title", reg.list().find((w) => w.id === ws.id).title, "proj");
  check("undo rename path", reg.list().find((w) => w.id === ws.id).path, join(home, "proj"));
  check("undo twice is refused", (await call("undo", {})).code, "nothing-to-undo");

  // --- failure path: destination collides after planning -------------------
  const planned = await call("plan", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "late" });
  check("plan succeeds", planned.ok, true);
  await mkdir(join(home, "dest", "late"));
  await writeFile(join(home, "dest", "late", "x.txt"), "x");
  const blocked = await call("move", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "late" });
  check("late collision refused", blocked.code, "target-exists");
  check("source intact after refusal", await readdir(join(home, "proj")).then((v) => v.sort()), ["README.md", "docs", "src"]);
  check("registry intact after refusal", reg.list().find((w) => w.id === ws.id).path, join(home, "proj"));
  check("session intact after refusal", (await persist.stat(s1)).header.cwd, join(home, "proj"));
  const leftovers = [];
  for (const name of await readdir(sandbox)) {
    if (!name.startsWith("dshwm")) continue;
    const entries = await readdir(join(sandbox, name));
    for (const tag of entries) leftovers.push(`${name}/${tag}/${(await readdir(join(sandbox, name, tag))).length}`);
  }
  check("no backup payload left", leftovers, []);
} finally {
  await ctx.stop?.().catch?.(() => {});
  await rm(sandbox, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "ALL PASS" : `FAILURES:\n${failures.join("\n")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
