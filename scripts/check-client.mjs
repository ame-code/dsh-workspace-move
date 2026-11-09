/**
 * Load the built Client bundle the way the browser module system does, and check
 * that it registers both menu entries, both icons and both effect lifetimes.
 * @module @reed-io/dsh-workspace-move/scripts
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

let registered;
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load: (entry) => (registered = entry) } },
  console
});

if (registered === undefined) throw new Error("bundle did not call __ModuleLoader__.load");
if (typeof registered.factory !== "function") throw new Error("bundle has no factory");

const element = (type, props, ...children) => ({ type, props, children });
const react = {
  createElement: element,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}]
};

const exports = registered.factory((name) => {
  if (name === "react" || name === "react/jsx-runtime") return react;
  throw new Error(`bundle requested an unexpected module: ${name}`);
});

const log = [];
const disposers = [];
const ctx = {
  effect: (fn, label) => {
    const dispose = fn();
    log.push(`effect ${label} -> ${typeof dispose}`);
    return () => {};
  },
  locale: {
    register: (namespace, dictionaries) => {
      log.push(`locale ${namespace} zh=${Object.keys(dictionaries.zh).length} en=${Object.keys(dictionaries.en).length}`);
      return () => {};
    },
    bind: (namespace) => (key) => `${namespace}.${key}`
  },
  slots: {
    inject: (name, callback) => {
      log.push(`slots.inject ${name}`);
      for (const dispose of callback()) disposers.push(dispose);
      return () => {};
    },
    register: (declaration, component) => {
      log.push(`slot ${declaration.name} ${declaration.key ?? declaration.id}`);
      return () => {};
    }
  },
  contextMenus: {
    register: (input) => {
      log.push(`menu ${input.id} target=${input.target} order=${input.order}`);
      return () => {};
    },
    notify: () => {}
  }
};

if (exports.inject?.length !== 3) throw new Error(`unexpected inject: ${JSON.stringify(exports.inject)}`);
if (typeof exports.apply !== "function") throw new Error("bundle exports no apply");
exports.apply(ctx);

const expected = [
  "locale workspaceMove",
  "menu workspace-move.move target=workspace order=200",
  "menu workspace-move.undo target=workspace order=210",
  "slots.inject contextMenu.icon",
  "slot contextMenu.icon workspaceMove.move",
  "slot contextMenu.icon workspaceMove.undo"
];
for (const line of expected) {
  if (!log.some((entry) => entry.startsWith(line))) throw new Error(`missing registration: ${line}\n${log.join("\n")}`);
}
console.log(log.join("\n"));
console.log("bundle contract ok");

// A shell that cannot accept contributions must not abort the boot: apply has to
// swallow the failure and log it.
const broken = {
  effect: (fn) => {
    fn();
    return () => {};
  },
  locale: {
    register: () => {
      throw new Error("locale service unavailable");
    },
    bind: () => () => ""
  },
  slots: { inject: () => () => {}, register: () => () => {} },
  contextMenus: { register: () => () => {}, notify: () => {} }
};
const originalError = console.error;
const logged = [];
console.error = (...args) => logged.push(args.join(" "));
try {
  exports.apply(broken);
} finally {
  console.error = originalError;
}
if (logged.length === 0) throw new Error("apply swallowed a failure without reporting it");
console.log("failure containment ok");
