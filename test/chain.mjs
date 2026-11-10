// Real-host chain check: boots `dsh web` with an isolated DSH_HOME and a profile that
// contains this plugin, builds a workspace through the host's own bootstrap, then drives
// plan/move/undo over the plugin's HTTP API and asserts the tree, the registry and the
// session log header.
//
// It is the counterpart of test/e2e.mjs: e2e.mjs replaces the host with fakes and runs on
// every platform, this one talks to the real CLI and is therefore slower. It runs in CI on
// macOS and Linux, where the desktop app is not available.
//
// Prerequisites: `dsh` and `pnpm` on PATH, network access for the first pnpm install.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readArtifactHeader } from "../lib/artifact.js";
import { encodeSegment, logPath, projectKey } from "../lib/paths.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DSH = process.env.DSH_CHAIN_BIN ?? (process.platform === "win32" ? "dsh.cmd" : "dsh");
const PROFILE = "chain";
const HEADER = { "x-dsh-workspace-move": "1", "content-type": "application/json" };

const failures = [];
const pass = [];
function check(name, condition, detail) {
  if (condition) {
    pass.push(name);
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function log(message) {
  console.log(`$ ${message}`);
}

/** Run a command and resolve with its combined output; rejects on a non-zero exit unless `allowFailure`. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${options.timeoutMs ?? 600000}ms`));
    }, options.timeoutMs ?? 600000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      options.onOutput?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      options.onOutput?.(String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || options.allowFailure) resolvePromise({ code, output });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`));
    });
  });
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.output = "";
  child.stdout.on("data", (chunk) => {
    child.output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk;
  });
  return child;
}

function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function waitFor(description, predicate, timeoutMs = 60000, interval = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve()
      .then(() => predicate())
      .catch(() => undefined);
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((done) => setTimeout(done, interval));
  }
}

async function workspaceRegistry(home) {
  const path = join(home, "storages", "workspace.json");
  return JSON.parse(await readFile(path, "utf8"));
}

function recordOf(registry, workspaceId) {
  return registry.tables?.workspaces?.[workspaceId];
}

const root = await mkdtemp(join(tmpdir(), "dshwm-chain-"));
const home = join(root, "home");
const demo = join(root, "demo");
const source = join(demo, "a");
const parent = join(demo, "b");
const host = { child: undefined, port: undefined };

try {
  console.log(`chain check in ${root}`);
  await mkdir(home, { recursive: true });
  await mkdir(join(source, "src", "deep"), { recursive: true });
  await mkdir(join(source, "empty"), { recursive: true });
  await mkdir(join(parent, "occupied"), { recursive: true });
  await writeFile(join(source, "README.md"), "chain check\n");
  await writeFile(join(source, "src", "deep", "x.js"), "export default 1;\n");
  await writeFile(join(parent, "occupied", "keep.txt"), "keep\n");

  log("pack the plugin");
  await run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], { timeoutMs: 300000 });
  const tarball = (await readdir(root)).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("npm pack produced no tarball");

  log("install the plugin into an isolated profile");
  const env = { DSH_HOME: home };
  await run(DSH, ["plugin", "--profile", PROFILE, "add", join(root, tarball)], { env, timeoutMs: 600000 });
  await run(DSH, ["plugin", "--profile", PROFILE, "add", "@deepseek-ai/dsh-web-app@0.2.2-rc.1"], {
    env,
    timeoutMs: 600000
  });

  log("create a session whose cwd is the workspace folder");
  await run(DSH, ["headless", "reply with the single word ok"], {
    cwd: source,
    env: { ...env, DEEPSEEK_API_KEY: "sk-chain-placeholder" },
    allowFailure: true,
    timeoutMs: 300000
  });

  log("boot the host");
  host.port = await freePort();
  host.child = start(DSH, ["--profile", PROFILE, "--port", String(host.port), "--no-open"], { cwd: root, env });
  const base = await waitFor(
    "the host token",
    () => {
      const match = /token=([A-Za-z0-9_-]+)/u.exec(host.child.output);
      return match === null ? undefined : `http://127.0.0.1:${host.port}/?token=${match[1]}`;
    },
    180000
  );
  const call = async (action, body = {}, headers = HEADER) => {
    const response = await fetch(`${base.split("/?")[0]}/dsh-workspace-move/api/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${action} returned ${response.status} with unparsable body: ${text.slice(0, 200)}`);
    }
    if (payload.ok !== true) throw Object.assign(new Error(payload.message), { code: payload.code, payload });
    return payload.result;
  };

  const workspaceId = await waitFor(
    `${source} in the registry`,
    async () => {
      const registry = await workspaceRegistry(home);
      const found = Object.entries(registry.tables?.workspaces ?? {}).find(([, record]) => record.path === source);
      return found?.[0];
    },
    60000
  );
  check("the host bootstrapped a workspace for the session cwd", workspaceId !== undefined, workspaceId);

  const unauthorized = await fetch(`${base.split("/?")[0]}/dsh-workspace-move/api/undoInfo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  check("a request without the plugin header is refused", unauthorized.status === 403, `status ${unauthorized.status}`);

  const destination = join(parent, "a-moved");
  const plan = await call("plan", { workspaceId, targetParent: parent, folderName: "a-moved" });
  check("plan reports the rename", plan.renamed === true, JSON.stringify(plan.renamed));
  check("plan lists the sessions to move", plan.sessions?.length === 1, JSON.stringify(plan.sessions));

  const moved = await call("move", { workspaceId, targetParent: parent, folderName: "a-moved" });
  check("move returns the destination", moved.destination === destination, moved.destination);
  check("move is undoable", moved.undoable === true);

  check("the source folder is gone", await stat(source).then(() => false, () => true));
  check("the files arrived", (await readFile(join(destination, "README.md"), "utf8")) === "chain check\n");
  check("the deep file arrived", (await stat(join(destination, "src", "deep", "x.js"))).isFile());
  check("the empty folder arrived", (await stat(join(destination, "empty"))).isDirectory());

  const afterMove = recordOf(await workspaceRegistry(home), workspaceId);
  check("the registry path follows", afterMove?.path === destination, afterMove?.path);
  check("the registry title follows the folder name", afterMove?.title === "a-moved", afterMove?.title);

  const sessionId = afterMove?.sessionIds?.[0];
  const movedLog = logPath(home + "/sessions", destination, sessionId);
  check("the session log moved with the folder", await stat(movedLog).then(() => true, () => false), movedLog);
  const movedHeader = await readArtifactHeader(movedLog);
  check("the session header cwd follows", movedHeader?.cwd === destination, movedHeader?.cwd);
  check(
    "the old session project folder is gone",
    await readdir(join(home, "sessions")).then(
      (names) => !names.includes(projectKey(source)),
      () => true
    )
  );

  await waitFor("the undo entry", async () => (await call("undoInfo")).available === true);
  const undone = await call("undo");
  check("undo reports the restored path", undone.restored === source, undone.restored);

  check("the files came back", (await readFile(join(source, "README.md"), "utf8")) === "chain check\n");
  check("the destination is gone", await stat(destination).then(() => false, () => true));

  const afterUndo = recordOf(await workspaceRegistry(home), workspaceId);
  check("the registry path came back", afterUndo?.path === source, afterUndo?.path);
  check("the registry title came back", afterUndo?.title === "a", afterUndo?.title);

  const restoredHeader = await readArtifactHeader(movedLog.replace(projectKey(destination), projectKey(source)));
  check("the session header cwd came back", restoredHeader?.cwd === source, restoredHeader?.cwd);
  check("undo is no longer offered", (await call("undoInfo")).available === false);

  check(
    "no transcode scratch files are left",
    await readdir(join(home, "sessions"), { recursive: true }).then(
      (names) => !names.some((name) => String(name).includes(".dshwm-")),
      () => true
    )
  );
} catch (error) {
  failures.push(`chain aborted: ${error?.message ?? error}`);
  console.error(error);
} finally {
  stop(host.child);
  await new Promise((done) => setTimeout(done, 500));
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${pass.length} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("CHAIN PASS");
