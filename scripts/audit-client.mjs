/**
 * Audit the built Client bundle for constructs the browser factory cannot run:
 * a stray ES module statement, a Node global, or a module request other than the
 * platform seeds.
 * @module @reed-io/dsh-workspace-move/scripts
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

const requested = [...new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))];
const problems = [];

const allowed = new Set(["react", "react/jsx-runtime"]);
for (const name of requested) if (!allowed.has(name)) problems.push(`unexpected module request: ${name}`);

for (const match of source.matchAll(/^\s*(?:import|export)\s/gmu)) problems.push(`ES module statement at offset ${match.index}`);

for (const name of ["process.env", "process.platform", "Buffer(", "__dirname", "__filename"]) {
  if (source.includes(name)) problems.push(`Node-only construct: ${name}`);
}

if (!source.startsWith("/*")) problems.push("bundle does not start with its banner comment");
if (!source.includes("window.__ModuleLoader__.load(")) problems.push("bundle does not call the module loader");
if (!source.includes("return module.exports;")) problems.push("factory does not return module.exports");

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`bundle audit ok — modules: ${requested.join(", ") || "none"}`);
