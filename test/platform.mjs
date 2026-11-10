/**
 * Platform-semantics tests: the parts of a move whose outcome depends on the
 * filesystem underneath — case sensitivity, links, device boundaries, file
 * modes and name rules.
 *
 * The suite adapts to the machine it runs on, so it says something on Windows,
 * macOS and Linux alike and skips only what the volume genuinely cannot do.
 *
 *   node test/platform.mjs
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { compareTree, copyTree, folderNameProblem, moveDirectory, samePath } from "../lib/fsx.js";
import { resolveTarget } from "../lib/plan.js";

const WINDOWS = process.platform === "win32";

let failed = 0;
let passed = 0;

const check = (label, actual, expected) => {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failed += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

const skip = (label, why) => console.log(`SKIP ${label} (${why})`);

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** A second volume to cross into, when the machine has one. */
async function crossDeviceTarget(avoid) {
  const drives = WINDOWS
    ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
    : [];
  const candidates = [
    ...drives,
    "/dev/shm",
    "/run/shm",
    ...(await readdir("/mnt").then((names) => names.map((name) => join("/mnt", name))).catch(() => [])),
    join(tmpdir(), ".."),
    ...(process.env.HOME ? [process.env.HOME] : []),
  ];
  const base = await stat(avoid);
  for (const candidate of new Set(candidates)) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory() || info.dev === base.dev) continue;
      if (exists(await mkdtemp(join(candidate, "dshwm-xdev-")))) return candidate;
    } catch {
      // not present, not writable, or not a directory: try the next one
    }
  }
  return undefined;
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "dshwm-platform-"));
  try {
    // The volume decides; the platform only suggests.
    const probe = join(work, "CaseProbe");
    await mkdir(probe);
    let caseInsensitive = true;
    try {
      await stat(join(work, "caseprobe"));
    } catch {
      caseInsensitive = false;
    }
    console.log(`volume: ${caseInsensitive ? "case-insensitive" : "case-sensitive"} (${process.platform})`);

    check("samePath follows the volume's case behaviour", samePath(join(work, "Proj"), join(work, "proj")), caseInsensitive);

    // A rename that only changes case must work on both kinds of volume.
    const source = join(work, "proj");
    await mkdir(source);
    await writeFile(join(source, "keep.txt"), "payload");
    check("a case-only rename travels like a rename", await moveDirectory(source, join(work, "Proj")), "rename");
    check("the folder carries the requested case", (await readdir(work)).includes("Proj"), true);
    check("its content came along", await readFile(join(work, "Proj", "keep.txt"), "utf8"), "payload");

    // ... and the planner must read it as a rename, not as a collision.
    const casePlan = await resolveTarget(join(work, "Proj"), work, "proj");
    check("a case-only rename is planned", casePlan.failure, undefined);
    check("the plan marks it as a rename", casePlan.renamed, true);
    const samePlan = await resolveTarget(join(work, "Proj"), work, "Proj");
    check("the same name in the same place is still refused", samePlan.failure?.code, "target-same");

    const other = join(work, "other");
    await mkdir(other);
    const occupied = await resolveTarget(other, work, "proj");
    check("a sibling whose name differs only in case is a collision", occupied.failure?.code, caseInsensitive ? "target-exists" : undefined);

    // Links are moved as links: never followed, never dropped.
    const tree = join(work, "tree");
    await mkdir(join(tree, "nested"), { recursive: true });
    await writeFile(join(tree, "file.txt"), "content");
    let links = true;
    try {
      await symlink("file.txt", join(tree, "relative-link"));
      await symlink(join(tree, "file.txt"), join(tree, "absolute-link"));
      await symlink("does-not-exist.txt", join(tree, "dangling-link"));
    } catch (error) {
      links = false;
      skip("symlink preservation", error.code ?? "links unavailable");
    }
    if (links) {
      const copy = join(work, "tree-copy");
      await copyTree(tree, copy);
      check("copied links match the source", await compareTree(tree, copy), undefined);
      check("a relative link keeps its text", await readlink(join(copy, "relative-link")), "file.txt");
      check("a dangling link stays dangling", await readlink(join(copy, "dangling-link")), "does-not-exist.txt");
      check("following the link reaches the copied file", await readFile(join(copy, "relative-link"), "utf8"), "content");
    }

    // Executable bits survive a copy (a script must still run after a move).
    if (!WINDOWS) {
      const script = join(tree, "run.sh");
      await writeFile(script, "#!/bin/sh\n");
      await chmod(script, 0o755);
      const copy = join(work, "mode-copy");
      await copyTree(tree, copy);
      check("a copied script keeps its mode", (await stat(join(copy, "run.sh"))).mode & 0o777, 0o755);
    } else {
      skip("mode preservation", "POSIX modes do not exist here");
    }

    // Crossing a device boundary is a copy, a verification, then a removal.
    const parent = await crossDeviceTarget(work);
    if (parent === undefined) {
      skip("cross-device move", "only one filesystem is available");
    } else {
      const across = await mkdtemp(join(parent, "dshwm-across-"));
      const from = join(work, "traveller");
      await mkdir(join(from, "inner"), { recursive: true });
      await writeFile(join(from, "inner", "note.txt"), "hello");
      const how = await moveDirectory(from, join(across, "traveller"));
      check("a cross-device move reports a copy", how, "copy");
      check("the source is gone", await exists(from), false);
      check("the content arrived", await readFile(join(across, "traveller", "inner", "note.txt"), "utf8"), "hello");
      await rm(across, { recursive: true, force: true });
    }

    // Name rules follow the platform the folder will live on.
    check("a path separator is never a name", folderNameProblem("a/b"), "name-invalid");
    check("a colon follows the platform", folderNameProblem("a:b"), WINDOWS ? "name-invalid" : undefined);
    check("a trailing dot follows the platform", folderNameProblem("x."), WINDOWS ? "name-invalid" : undefined);
    check("a reserved device name follows the platform", folderNameProblem("CON"), WINDOWS ? "name-invalid" : undefined);
    check("an over-long name is refused everywhere", folderNameProblem("x".repeat(300)), "name-invalid");
    check("control characters are refused everywhere", folderNameProblem("a\u0001b"), "name-invalid");
    check("a plain name is accepted", folderNameProblem("proj"), undefined);
    check("the root is not a folder name", folderNameProblem(parse(work).root), "name-invalid");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED, ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
