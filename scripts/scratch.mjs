// 兜底清理：跨进程检查测试是否在磁盘上留下 dshwm-* 目录。
//
//   node scripts/scratch.mjs check   有残留就列出来并以 1 退出（供 npm test 收尾用）
//   node scripts/scratch.mjs clean   删掉残留（进程被 Ctrl+C 之类打断后的手动恢复）
//
// 每个测试文件自己也会在 finally 里删自己的临时目录，这里只是第二道保险。

import { findScratch, removeScratch, scratchRoots } from "../test/support/scratch.mjs";

const action = process.argv[2] ?? "check";

if (action === "check") {
  const found = await findScratch();
  if (found.length === 0) {
    console.log(`no scratch directories left (${(await scratchRoots()).length} roots scanned)`);
    process.exit(0);
  }
  console.error(`scratch directories left behind (${found.length}):`);
  for (const path of found) console.error(`  ${path}`);
  console.error("run `npm run clean:scratch` to remove them, and fix the test that leaked.");
  process.exit(1);
} else if (action === "clean") {
  const found = await findScratch();
  const left = await removeScratch(found);
  console.log(`removed ${found.length - left.length} scratch directories`);
  if (left.length > 0) {
    for (const path of left) console.error(`  still there: ${path}`);
    process.exit(1);
  }
} else {
  console.error(`unknown action: ${action} (expected check or clean)`);
  process.exit(2);
}
