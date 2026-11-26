/**
 * Unit tests for the parts that do not need a running Harness: path encoding,
 * workspace folder naming rules, containment checks and session log rewriting.
 *
 *   node test/unit.mjs
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { copyArtifactWithCwd, isZstdFramed, readArtifactHeader, scanFrames } from "../lib/artifact.js";
import { folderNameProblem, isInside, samePath } from "../lib/fsx.js";
import { browse, createFolder } from "../lib/directory-browse.js";
import { encodeSegment, logFilename, logPath, projectKey } from "../lib/paths.js";
import { releaseScratch, scratch } from "./support/scratch.mjs";

let failed = 0;
let passed = 0;
const WINDOWS = process.platform === "win32";
// An absolute root on this platform, so the containment checks below describe
// the same thing on Windows, macOS and Linux.
const ROOT = WINDOWS ? "E:/" : "/";

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
check("colons follow the platform's rules", folderNameProblem("a:b"), WINDOWS ? "name-invalid" : undefined);
check("slashes are rejected", folderNameProblem("a/b"), "name-invalid");
check("empty names are rejected", folderNameProblem(""), "name-invalid");
check("dot names are rejected", folderNameProblem("."), "name-invalid");
check("dotdot names are rejected", folderNameProblem(".."), "name-invalid");
check("trailing dots follow the platform's rules", folderNameProblem("x."), WINDOWS ? "name-invalid" : undefined);

check("child is inside parent", isInside(join(ROOT, "a", "b"), join(ROOT, "a")), true);
check("deep child is inside parent", isInside(join(ROOT, "a", "b", "c", "d"), join(ROOT, "a")), true);
check("prefix sibling is not inside", isInside(join(ROOT, "a2"), join(ROOT, "a")), false);
check("a path is not inside itself", isInside(join(ROOT, "a"), join(ROOT, "a")), false);
check("everything is inside a volume root", isInside(join(ROOT, "a"), ROOT), true);

check("samePath resolves dot segments", samePath(join(ROOT, "a", ".", "b"), join(ROOT, "a", "b")), true);
check("samePath ignores a trailing slash", samePath(`${join(ROOT, "a", "b")}/`, join(ROOT, "a", "b")), true);
check("samePath keeps different paths apart", samePath(join(ROOT, "a", "b"), join(ROOT, "a", "c")), false);

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

const work = await scratch("unit");
try {
  // 使用真实目录验证根列表、跨根导航入口和手动路径的错误反馈。
  const overview = await browse(null);
  check("drive overview has no selectable parent", overview.path, "");
  check("drive overview is explicitly marked", overview.overview, true);
  check("drive overview lists all roots as entries", overview.entries.map((entry) => entry.path), overview.roots);
  check("drive overview has no parent breadcrumbs", overview.crumbs, []);
  const browser = await browse(work);
  check("browser lists the current filesystem root", browser.roots.some((root) => samePath(root, parse(work).root)), true);
  check("browser roots are unique", new Set(browser.roots).size, browser.roots.length);
  const created = await createFolder(work, "目标目录");
  const refreshed = await browse(work);
  check("browser lists newly created folders", refreshed.entries.some((entry) => samePath(entry.path, created)), true);
  const child = await browse(created);
  check("manual folder paths resolve to their canonical destination", samePath(child.path, created), true);
  check("folder breadcrumbs lead to the filesystem root", samePath(child.crumbs[0].path, parse(child.path).root), true);
  for (const root of browser.roots) {
    const listing = await browse(root);
    check(`browser can enter root ${root}`, samePath(listing.path, root), true);
  }
  let missingCode;
  await browse(join(work, "missing-folder")).catch((error) => { missingCode = error.code; });
  check("manual missing paths report a directory error", missingCode, "directory-missing");

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
  // 临时目录由 scratch() 统一登记，这里核对确实删干净了，残留算一条失败
  const left = await releaseScratch();
  if (left.length > 0) {
    failed += 1;
    console.error(`scratch directory left behind: ${left.join(", ")}`);
  }
}

console.log(failed === 0 ? `ALL PASS (${passed})` : `${failed} FAILED, ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
