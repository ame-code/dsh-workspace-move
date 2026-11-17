// 测试用临时目录的登记表。
//
// 规则：测试里凡是建临时目录，都走这里的 scratch()，它会把目录登记下来；
// 测试收尾时调用 releaseScratch()，它会删掉所有登记过的目录并把“删完还在”的路径返回，
// 由调用方当作失败处理。这样即使中间某条断言抛错，也不会把一个 dshwm-* 目录留在磁盘上。
//
// 另外提供 findScratch()/removeScratch()，供 scripts/scratch.mjs 做跨进程的兜底检查：
// 进程被强杀（比如 Ctrl+C）时登记表来不及跑，下次跑测试前能用它们扫地。

import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 所有测试临时目录都以 dshwm- 开头，后面接用途和 mkdtemp 生成的 6 位随机后缀。 */
export const SCRATCH_PREFIX = "dshwm-";
const SCRATCH_PATTERN = /^dshwm-[a-z0-9]+-[A-Za-z0-9]{6}$/;

const registered = new Set();

/** 建一个受管的临时目录；parent 默认是系统临时目录，跨卷测试会传入另一个卷的根。 */
export async function scratch(prefix, parent = tmpdir()) {
  const dir = await mkdtemp(join(parent, `${SCRATCH_PREFIX}${prefix}-`));
  registered.add(resolve(dir));
  return dir;
}

/** 删掉所有登记过的目录，返回删除后仍然存在的路径（正常情况下应该是空的）。 */
export async function releaseScratch() {
  const left = [];
  for (const dir of registered) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (existsSync(dir)) left.push(dir);
  }
  registered.clear();
  return left;
}

/** 把 releaseScratch() 的结果转成一条测试断言，返回残留数量。 */
export function assertNoScratchLeft(failures, left) {
  if (left.length === 0) return 0;
  failures.push(`测试临时目录没有删干净：${left.join(", ")}`);
  return left.length;
}

/** 可能需要扫的地方：系统临时目录、Windows 各盘根、POSIX 的共享内存与 /mnt 下的挂载点。 */
export async function scratchRoots() {
  const roots = new Set([resolve(tmpdir())]);
  if (process.platform === "win32") {
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (existsSync(drive)) roots.add(resolve(drive));
    }
  } else {
    roots.add("/dev/shm");
    roots.add("/run/shm");
    const mounts = await readdir("/mnt").catch(() => []);
    for (const name of mounts) roots.add(join("/mnt", name));
  }
  return [...roots].filter((root) => existsSync(root));
}

/** 在可能的盘上找出所有 dshwm-* 条目，返回绝对路径。 */
export async function findScratch() {
  const found = [];
  for (const root of await scratchRoots()) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !SCRATCH_PATTERN.test(entry.name)) continue;
      found.push(join(root, entry.name));
    }
  }
  return found;
}

/** 删除给定的路径，返回仍然存在的那些。 */
export async function removeScratch(paths) {
  const left = [];
  for (const path of paths) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    if (existsSync(path)) left.push(path);
  }
  return left;
}
