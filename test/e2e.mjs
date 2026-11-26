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
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as storage from "@deepseek-ai/dsh-storage";
import * as storageJson from "@deepseek-ai/dsh-storage-json";
import * as storageDomain from "@deepseek-ai/dsh-storage-domain";
import * as persistenceJsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import * as workspace from "@deepseek-ai/dsh-workspace";
import * as plugin from "../lib/plugin.js";
import { sessionDir } from "../lib/paths.js";
import { releaseScratch, scratch } from "./support/scratch.mjs";

// realpath up front: macOS hands out /var/... for /private/var/..., and the
// registry canonicalizes paths, so an un-canonical sandbox would fail every
// comparison for reasons that have nothing to do with moving.
const sandbox = await realpath(await scratch("e2e"));
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

const startHarness = async () => {
  const context = new Context();
  context.provide("logger", { info() {}, warn: (...a) => console.log("[warn]", ...a), error: console.error });
  context.plugin(session.default ?? session);
  context.plugin(storage.default ?? storage);
  context.plugin(storageJson.default ?? storageJson, { root: storageRoot });
  await new Promise((r) => setTimeout(r, 50));
  context.plugin(persistenceJsonl.default ?? persistenceJsonl, { root: sessionRoot });
  await new Promise((r) => setTimeout(r, 50));
  await context.plugin(storageDomain.default ?? storageDomain, { backend: "json" });
  context.plugin(workspace.default ?? workspace);
  await new Promise((r) => setTimeout(r, 300));
  return context;
};
const ctx = await startHarness();
const reg = ctx.workspaceRegistry;
const persist = ctx.sessionPersistence;

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (${JSON.stringify(actual)})`}`);
};

const makeSession = async (cwd, label, delegationDepth = 0) => {
  const header = { version: 4, id: `session-${label}`, createdAt: Date.now(), isSeeded: false, delegationDepth, cwd, agentPreset: "cordis" };
  const handle = await persist.create(header);
  for (let seq = 0; seq < 5; seq += 1) {
    await handle.append([{ type: "session/title", seq, time: Date.now() + seq, data: { title: `${label}-${seq}`, messageSeqs: [], source: { kind: "user" } } }]);
  }
  await handle.flush();
  await handle.close();
  const dir = sessionDir(sessionRoot, cwd, header.id);
  await mkdir(join(dir, "notes"));
  await writeFile(join(dir, "state.txt"), `${label} state`);
  await writeFile(join(dir, "notes", "payload.txt"), `${label} notes`);
  return `session-${label}`;
};

const s1 = await makeSession(join(home, "proj"), "alpha");
const s2 = await makeSession(join(home, "proj"), "beta");
const ws = await reg.create(join(home, "proj"), "proj");
await ws.attachSession(s1);
await ws.attachSession(s2);
const nested = await reg.create(join(home, "proj", "src", "deep"), "deep");
const nestedSession = await makeSession(nested.path, "nested");
await nested.attachSession(nestedSession);
const child = await makeSession(ws.path, "child", 1);
await reg.indexHeader((await persist.stat(child)).header);
const unlisted = await makeSession(nested.path, "unlisted");
await reg.indexHeader((await persist.stat(unlisted)).header);
const unrelated = await reg.create(join(home, "dest", "occupied"), "unrelated");
const unrelatedSession = await makeSession(unrelated.path, "unrelated");
await unrelated.attachSession(unrelatedSession);
const originalOrder = [...ws.sessionIds];
const unrelatedRecord = structuredClone(reg.table.get(unrelated.id));

// 检查真正落盘的格式和成员列表，避免只检查内存实体而遗漏损坏。
const checkRegistry = async (label) => {
  const text = await readFile(join(storageRoot, "workspace.json"), "utf8");
  const document = JSON.parse(text);
  const records = document.tables.workspaces;
  check(`${label}: all sessionIds remain arrays`, Object.values(records).every((record) => Array.isArray(record.sessionIds)), true);
  check(`${label}: original visible session order`, records[ws.id].sessionIds, originalOrder);
  check(`${label}: nested membership unchanged`, records[nested.id].sessionIds, [nestedSession]);
  check(`${label}: unrelated workspace unchanged`, records[unrelated.id], unrelatedRecord);
  check(`${label}: pretty JSON with trailing newline`, text, JSON.stringify(document, null, 2) + "\n");
  check(`${label}: live visible session order`, reg.list().find((entity) => entity.id === ws.id).sessionIds, originalOrder);
};

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
  await checkRegistry("move");
  check("child artifact moves without becoming visible", (await persist.stat(child)).header.cwd, join(home, "dest", "proj"));
  check("child header index follows move", reg.headers.get(child).cwd, join(home, "dest", "proj"));
  check("child path index follows move", reg.sessionPaths.get(child), join(home, "dest", "proj"));
  check("unlisted nested artifact follows move", (await persist.stat(unlisted)).header.cwd, join(home, "dest", "proj", "src", "deep"));
  check("unlisted nested index follows move", reg.sessionPaths.get(unlisted), join(home, "dest", "proj", "src", "deep"));
  check("plain move keeps name", plain.result.destination, join(home, "dest", "proj"));
  check("registry path follows", reg.list().find((w) => w.id === ws.id).path, join(home, "dest", "proj"));
  check("nested path follows", reg.list().find((w) => w.id === nested.id).path, join(home, "dest", "proj", "src", "deep"));
  check("session cwd follows", (await persist.stat(s1)).header.cwd, join(home, "dest", "proj"));
  check("payload preserved", (await readFile(join(home, "dest", "proj", "src", "deep", "a.txt"), "utf8")), "deep file");
  check("source removed", await readdir(home).then((v) => v.includes("proj")), false);
  const redo = await call("undo", {});
  check("undo plain ok", redo.ok, true);
  await checkRegistry("undo");
  check("child artifact returns on undo", (await persist.stat(child)).header.cwd, join(home, "proj"));
  check("child header index returns on undo", reg.headers.get(child).cwd, join(home, "proj"));
  check("child path index returns on undo", reg.sessionPaths.get(child), join(home, "proj"));
  check("unlisted nested artifact returns on undo", (await persist.stat(unlisted)).header.cwd, nested.path);
  check("unlisted nested index returns on undo", reg.sessionPaths.get(unlisted), nested.path);
  check("undo path restored", reg.list().find((w) => w.id === ws.id).path, join(home, "proj"));
  check("undo nested restored", reg.list().find((w) => w.id === nested.id).path, join(home, "proj", "src", "deep"));
  check("undo session cwd", (await persist.stat(s1)).header.cwd, join(home, "proj"));
  check("undo source back", await readdir(home).then((v) => v.includes("proj")), true);

  // --- move with rename ----------------------------------------------------
  const renamed = await call("move", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "proj-renamed" });
  check("rename move ok", renamed.ok, true);
  await checkRegistry("rename");
  check("rename title follows", reg.list().find((w) => w.id === ws.id).title, "proj-renamed");
  check("rename destination", renamed.result.destination, join(home, "dest", "proj-renamed"));
  check("undoable reported", renamed.result.undoable, true);
  check("nested renamed path", reg.list().find((w) => w.id === nested.id).path, join(home, "dest", "proj-renamed", "src", "deep"));
  const reverted = await call("undo", {});

  check("undo rename ok", reverted.ok, true);
  await checkRegistry("undo rename");
  check("undo rename title", reg.list().find((w) => w.id === ws.id).title, "proj");
  check("undo rename path", reg.list().find((w) => w.id === ws.id).path, join(home, "proj"));
  check("undo twice is refused", (await call("undo", {})).code, "nothing-to-undo");

  // 在迁移日志和索引后注入标题更新失败，确认真正的回滚路径能恢复隐藏会话。
  const entityPrototype = Object.getPrototypeOf(ws);
  const originalSetTitle = entityPrototype.setTitle;
  let injectedFailure = false;
  entityPrototype.setTitle = async function (title) {
    if (this.id === ws.id && title === "rollback-probe") {
      injectedFailure = true;
      check("hidden index migrated before injected failure", reg.sessionPaths.get(child), join(home, "dest", "rollback-probe"));
      throw new Error("injected title update failure");
    }
    return originalSetTitle.call(this, title);
  };
  try {
    const failedMove = await call("move", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "rollback-probe" });
    check("injected migration failure reported", failedMove.ok, false);
  } finally {
    entityPrototype.setTitle = originalSetTitle;
  }
  check("migration reached injected failure", injectedFailure, true);
  await checkRegistry("rollback");
  check("rollback restores workspace path", reg.list().find((entity) => entity.id === ws.id).path, join(home, "proj"));
  check("rollback restores nested path", reg.list().find((entity) => entity.id === nested.id).path, nested.path);
  check("rollback restores child artifact", (await persist.stat(child)).header.cwd, join(home, "proj"));
  check("rollback restores child header index", reg.headers.get(child).cwd, join(home, "proj"));
  check("rollback restores child path index", reg.sessionPaths.get(child), join(home, "proj"));
  check("rollback restores unlisted artifact", (await persist.stat(unlisted)).header.cwd, nested.path);
  check("rollback restores unlisted header index", reg.headers.get(unlisted).cwd, nested.path);
  check("rollback restores unlisted path index", reg.sessionPaths.get(unlisted), nested.path);
  check("rollback restores payload", await readFile(join(home, "proj", "src", "deep", "a.txt"), "utf8"), "deep file");
  const restoredChildDir = sessionDir(sessionRoot, join(home, "proj"), child);
  check("rollback restores companion file", await readFile(join(restoredChildDir, "state.txt"), "utf8"), "child state");
  check("rollback restores companion directory", await readFile(join(restoredChildDir, "notes", "payload.txt"), "utf8"), "child notes");

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

  // 停留在迁移后的目标路径重启，检查落盘配置确实可加载。
  check("move before restart succeeds", (await call("move", { workspaceId: ws.id, targetParent: join(home, "dest"), folderName: "restart-probe" })).ok, true);
  await checkRegistry("before restart");
  await ctx.fiber.dispose();
  const restarted = await startHarness();
  try {
    const reloaded = restarted.workspaceRegistry.list().find((entity) => entity.id === ws.id);
    check("registry reloads moved workspace", reloaded?.path, join(home, "dest", "restart-probe"));
    check("restart preserves visible membership and order", reloaded?.sessionIds, originalOrder);
    check("restart preserves durable membership", restarted.workspaceRegistry.table.get(ws.id)?.sessionIds, originalOrder);
    check("restart indexes hidden child at destination", restarted.workspaceRegistry.headers.get(child)?.cwd, join(home, "dest", "restart-probe"));
    check("registry reloads unrelated workspace", restarted.workspaceRegistry.list().find((entity) => entity.id === unrelated.id)?.path, unrelated.path);
    const created = await restarted.workspaceRegistry.create(join(home, "dest", "late"), "after restart");
    check("workspace creation works after restart", created.path, join(home, "dest", "late"));
  } finally {
    await restarted.fiber.dispose();
  }
} finally {
  await ctx.fiber.dispose();
  // 临时目录统一登记过，这里删除并核对，残留算一条失败
  const left = await releaseScratch();
  if (left.length > 0) failures.push(`scratch directory left behind: ${left.join(", ")}`);
}

console.log(failures.length === 0 ? "ALL PASS" : `FAILURES:\n${failures.join("\n")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
