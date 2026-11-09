/**
 * Unit tests for the parts that do not need a running Harness: path encoding,
 * workspace folder naming rules, containment checks and session log rewriting.
 *
 *   node test/unit.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { copyArtifactWithCwd, isZstdFramed, readArtifactHeader, scanFrames } from "../lib/artifact.js";
import { folderNameProblem, isInside, samePath } from "../lib/fsx.js";
import { encodeSegment, logFilename, logPath, projectKey } from "../lib/paths.js";

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

const throws = (label, fn, pattern) => {
  try {
    fn();
  } catch (error) {
    if (pattern.test(String(error.message))) {
      passed += 1;
      return;
    }
    failed += 1;
    console.log(`FAIL ${label}: unexpected message ${JSON.stringify(String(error.message))}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${label}: did not throw`);
};

// --- path encoding -------------------------------------------------------

check("encodeSegment keeps plain names", encodeSegment("session-1"), "session-1");
check("encodeSegment keeps single dots", encodeSegment("a.b"), "a.b");
check("encodeSegment escapes '..'", encodeSegment(".."), "~002E~002E");
check("encodeSegment escapes separators", encodeSegment("a/b"), "a~002Fb");
check("encodeSegment escapes non-ascii", encodeSegment("中文"), "~4E2D~6587");

check("projectKey folds separators", projectKey("E:/work/x"), "--E-work-x--");
check("projectKey folds backslashes", projectKey("E:\\work\\x"), "--E-work-x--");
check("projectKey escapes odd characters", projectKey("E:/a b"), "--E-a~0020b--");
throws("projectKey rejects an empty path", () => projectKey(""), /empty project path/);
throws("projectKey rejects a missing path", () => projectKey(undefined), /length|empty project path/);

check("logFilename zstd", logFilename(4, "zstd"), "session.v4.jsonl.zstd");
check("logPath lays out the store", logPath("C:/root", "E:/work/x", "s1"), join("C:/root", "--E-work-x--", "s1", "session.v4.jsonl.zstd"));

// --- folder names and containment ---------------------------------------

check("plain folder name is fine", folderNameProblem("proj"), undefined);
check("spaces inside a name are fine", folderNameProblem("my proj"), undefined);
check("colons are rejected", folderNameProblem("a:b"), "name-invalid");
check("slashes are rejected", folderNameProblem("a/b"), "name-invalid");
check("empty names are rejected", folderNameProblem(""), "name-invalid");
check("dot names are rejected", folderNameProblem("."), "name-invalid");
check("dotdot names are rejected", folderNameProblem(".."), "name-invalid");
check("trailing dots are rejected", folderNameProblem("x."), "name-invalid");

check("child is inside parent", isInside("E:/a/b", "E:/a"), true);
check("deep child is inside parent", isInside("E:/a/b/c/d", "E:/a"), true);
check("prefix sibling is not inside", isInside("E:/a2", "E:/a"), false);
check("a path is not inside itself", isInside("E:/a", "E:/a"), false);
check("everything is inside a drive root", isInside("E:/a", "E:/"), true);

check("samePath folds separators", samePath("E:\\a\\b", "E:/a/b"), true);
check("samePath ignores a trailing slash", samePath("E:/a/b/", "E:/a/b"), true);
check("samePath keeps different paths apart", samePath("E:/a/b", "E:/a/c"), false);

// --- session logs --------------------------------------------------------

const header = (cwd, id) => ({
  version: 4,
  id,
  createdAt: 1_700_000_000_000,
  isSeeded: false,
  delegationDepth: 0,
  cwd,
  agentPreset: "cordis",
});

const frame = (text) => zstdCompressSync(Buffer.from(text, "utf8"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const payload = '{"type":"event","kind":"message","text":"hello"}\n{"type":"event","kind":"message","text":"bye"}\n';

const buildLog = (cwd, id) => Buffer.concat([frame(`${JSON.stringify(header(cwd, id))}\n`), frame(payload)]);

const work = await mkdtemp(join(tmpdir(), "dshwm-unit-"));
try {
  const source = join(work, "source.zstd");
  const target = join(work, "target.zstd");
  const original = buildLog("E:/old/place", "session-a");
  await writeFile(source, original);

  check("zstd magic is detected", isZstdFramed(original), true);
  check("plain text is not a zstd frame", isZstdFramed(Buffer.from("hello")), false);
  check("two frames are scanned", scanFrames(original).frames.length, 2);
  check("no torn tail in a complete log", scanFrames(original).tornStart, undefined);

  const before = await readArtifactHeader(source);
  check("header id is read", before.id, "session-a");
  check("header cwd is read", before.cwd, "E:/old/place");

  await copyArtifactWithCwd(source, target, "E:/new/place", "session-a");
  const after = await readArtifactHeader(target);
  check("copied header carries the new cwd", after.cwd, "E:/new/place");
  check("copied header keeps its id", after.id, "session-a");

  const copied = await readFile(target);
  const frames = scanFrames(copied).frames;
  check("copy keeps both frames", frames.length, 2);
  const events = zstdDecompressSync(copied.subarray(frames[1].start, frames[1].end)).toString("utf8");
  check("payload survives byte for byte", events, payload);
  check("source is untouched", (await readArtifactHeader(source)).cwd, "E:/old/place");

  const torn = Buffer.concat([original, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])]);
  check("torn tail is detected", scanFrames(torn).tornStart !== undefined, true);

  const mismatched = join(work, "mismatch.zstd");
  await writeFile(mismatched, buildLog("E:/old/place", "session-b"));
  let refused = false;
  await copyArtifactWithCwd(mismatched, join(work, "mismatch-out.zstd"), "E:/new", "session-a").catch(() => {
    refused = true;
  });
  check("a log for another session is refused", refused, true);
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED, ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
