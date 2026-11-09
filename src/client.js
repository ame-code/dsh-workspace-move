/**
 * Browser half of the workspace move plugin: the workspace context-menu entries
 * and the destination dialog. Every operation is delegated to the Host over the
 * plugin's own route, so the Client never touches the registry or the session
 * store itself.
 * @module @reed-io/dsh-workspace-move/client
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from "react";

const translations = {
  "zh": {
    "meta.title": "移动工作区",
    "meta.description": "把工作区目录、其子目录、其下的子工作区和其中的会话整体搬到新位置，支持重命名、失败回滚与撤销。",
    "menu.move": "移动工作区…",
    "menu.undo": "撤销上次移动",
    "dialog.title": "移动工作区",
    "dialog.source": "当前位置",
    "dialog.target": "目标上级文件夹",
    "dialog.folderName": "文件夹名称",
    "dialog.folderHint": "工作区会以此名称放进所选文件夹；改名即重命名工作区。",
    "dialog.destination": "移动后位置",
    "dialog.up": "上一层",
    "dialog.home": "主目录",
    "dialog.newFolder": "新建文件夹",
    "dialog.newFolderPrompt": "新文件夹名称",
    "dialog.pickHere": "选择此文件夹",
    "dialog.confirm": "移动",
    "dialog.cancel": "取消",
    "dialog.moving": "正在移动…",
    "dialog.loading": "加载中…",
    "dialog.emptyFolder": "这里没有子文件夹",
    "dialog.invalidName": "请填写不含斜杠的文件夹名称。",
    "dialog.targetExists": "目标文件夹里已有同名项且非空，请换个名字。",
    "dialog.sameLocation": "工作区已经在这个位置了，换个目标或改个名字。",
    "dialog.insideSelf": "不能把工作区搬到它自己的文件夹里面。",
    "dialog.ancestor": "目标在工作区当前路径的上层，请换一个位置。",
    "dialog.missingFolder": "这个文件夹不存在，请刷新后重试。",
    "dialog.unknownWorkspace": "这个工作区已经不在列表里了，请重新打开菜单。",
    "toast.moved": "工作区已移动。",
    "toast.undone": "已撤销移动。",
    "toast.failed": "操作失败。",
    "running.title": "请先停止这些会话",
    "running.hint": "有正在运行的会话不能移动，停止后再试。",
    "undo.title": "撤销上次移动",
    "undo.body": "将把工作区及其会话恢复到原来的位置。",
    "undo.confirm": "撤销",
    "undo.none": "没有可撤销的移动。"
  },
  "en": {
    "meta.title": "Workspace Move",
    "meta.description": "Move a workspace directory — its subfolders, nested workspaces and sessions — to a new location, with rename, rollback and undo.",
    "menu.move": "Move workspace…",
    "menu.undo": "Undo last move",
    "dialog.title": "Move workspace",
    "dialog.source": "Current location",
    "dialog.target": "Destination parent folder",
    "dialog.folderName": "Folder name",
    "dialog.folderHint": "The workspace lands in the chosen folder under this name. Changing the name renames the workspace.",
    "dialog.destination": "New location",
    "dialog.up": "Up",
    "dialog.home": "Home",
    "dialog.newFolder": "New folder",
    "dialog.newFolderPrompt": "New folder name",
    "dialog.pickHere": "Use this folder",
    "dialog.confirm": "Move",
    "dialog.cancel": "Cancel",
    "dialog.moving": "Moving…",
    "dialog.loading": "Loading…",
    "dialog.emptyFolder": "No subfolders here",
    "dialog.invalidName": "Enter a folder name without slashes.",
    "dialog.targetExists": "That name already exists there and is not empty. Pick another name.",
    "dialog.sameLocation": "The workspace is already there. Pick another place or change the name.",
    "dialog.insideSelf": "A workspace cannot be moved inside its own folder.",
    "dialog.ancestor": "That place is above the workspace's current path. Pick another one.",
    "dialog.missingFolder": "That folder does not exist. Refresh and try again.",
    "dialog.unknownWorkspace": "That workspace is no longer listed. Reopen the menu.",
    "toast.moved": "Workspace moved.",
    "toast.undone": "Move undone.",
    "toast.failed": "The action failed.",
    "running.title": "Stop these sessions first",
    "running.hint": "Sessions with running work cannot be moved. Stop them and try again.",
    "undo.title": "Undo last move",
    "undo.body": "Restores the workspace and its sessions to the previous location.",
    "undo.confirm": "Undo",
    "undo.none": "Nothing to undo."
  }
};

/** Stable route prefix of the Host API. */
const API_PREFIX = "/dsh-workspace-move/api";

/** Header every Host call carries; the Host rejects anything without it. */
const API_HEADER = "x-dsh-workspace-move";

/**
 * POST one action to the Host and unwrap its envelope.
 * @param action - action name.
 * @param body - JSON body.
 * @returns the action result.
 */
async function callHost(action, body = {}) {
  const response = await fetch(`${API_PREFIX}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", [API_HEADER]: "1" },
    body: JSON.stringify(body),
    credentials: "same-origin"
  });
  if (!response.ok) {
    const error = new Error(`request failed with status ${response.status}`);
    error.code = `http-${response.status}`;
    throw error;
  }
  const envelope = await response.json();
  if (envelope.ok !== true) {
    const error = new Error(envelope.message ?? envelope.code ?? "request failed");
    error.code = envelope.code;
    error.details = envelope.details ?? {};
    throw error;
  }
  return envelope.result;
}

/**
 * Translate a failure into something a person can act on.
 * @param t - translator.
 * @param error - the rejected call.
 * @returns the message to show.
 */
function describeFailure(t, error) {
  switch (error?.code) {
    case "sessions-running": {
      const running = error.details?.active ?? [];
      const names = running.map((item) => `${item.sessionId} (${item.kinds?.join(", ") ?? "busy"})`).join("\n");
      return `${t("running.title")}\n${names}\n${t("running.hint")}`;
    }
    case "target-exists":
      return t("dialog.targetExists");
    case "target-same":
      return t("dialog.sameLocation");
    case "target-inside":
      return t("dialog.insideSelf");
    case "target-ancestor":
      return t("dialog.ancestor");
    case "target-missing":
      return t("dialog.missingFolder");
    case "workspace-unknown":
      return t("dialog.unknownWorkspace");
    case "name-invalid":
    case "name-empty":
    case "name-padded":
    case "name-relative":
    case "name-trailing":
      return t("dialog.invalidName");
    case "nothing-to-undo":
      return t("undo.none");
    default:
      return `${t("toast.failed")} ${error?.message ?? ""}`.trim();
  }
}

/**
 * Dialog styling. Every colour, radius and shadow is a harness design token, so
 * the dialog follows the surrounding theme instead of imposing a palette; the
 * only literals left are spacing and type sizes.
 */
const CSS = `
.dshwm-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42));backdrop-filter:var(--dsw-mask-blur,blur(2px))}
.dshwm-panel{display:flex;flex-direction:column;gap:14px;width:min(760px,calc(100vw - 48px));max-height:calc(100vh - 96px);padding:20px 22px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);font-family:var(--dsw-font-family);overflow:hidden}
.dshwm-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.dshwm-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshwm-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshwm-value{padding:7px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform);font-size:12.5px;word-break:break-all}
.dshwm-browser{display:flex;flex-direction:column;gap:8px;padding:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px)}
.dshwm-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;min-height:22px;font-size:12px}
.dshwm-crumb{padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer}
.dshwm-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshwm-crumb[data-active=true]{color:var(--dsw-alias-label-primary);font-weight:600}
.dshwm-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px;max-height:220px;overflow-y:auto;padding:2px}
.dshwm-entry{display:flex;align-items:center;gap:6px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;overflow:hidden;white-space:nowrap;cursor:pointer}
.dshwm-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshwm-entry>span:last-child{overflow:hidden;text-overflow:ellipsis}
.dshwm-input{padding:7px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.dshwm-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshwm-hint{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dshwm-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dshwm-button{padding:7px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}
.dshwm-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshwm-button:disabled{opacity:.45;cursor:default}
.dshwm-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshwm-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:600}
.dshwm-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshwm-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
`;

/** Identifier of the stylesheet, so a reload replaces it instead of stacking copies. */
const CSS_ID = "@reed-io/dsh-workspace-move/dialog.css";

/**
 * Put the dialog stylesheet into the document exactly once.
 * @returns nothing.
 */
function installStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "@reed-io/dsh-workspace-move";
  tag.dataset.pluginCss = CSS_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/**
 * One row of the destination picker.
 * @param props - entry data and the click handler.
 * @returns the row.
 */
function FolderRow({ entry, onOpen }) {
  return h(
    "button",
    {
      type: "button",
      title: entry.path,
      className: "dshwm-entry",
      onClick: () => onOpen(entry.path)
    },
    h("span", { "aria-hidden": "true" }, entry.isSymbolicLink ? "🔗" : "📁"),
    h("span", null, entry.name)
  );
}

/**
 * The destination dialog: browse to a parent folder, name the workspace folder,
 * review what travels with it, then move.
 * @param props - the request and how to finish.
 * @returns the dialog.
 */
function MoveDialog({ ctx, t, request, onClose, onDone }) {
  const [listing, setListing] = useState(undefined);
  const [target, setTarget] = useState("");
  const [current, setCurrent] = useState("");
  const [folderName, setFolderName] = useState(request.currentName ?? "");
  const [plan, setPlan] = useState(undefined);
  const [error, setError] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const open = useCallback(
    async (path) => {
      setError(undefined);
      try {
        const next = await callHost("browse", { path });
        if (!alive.current) return;
        setListing(next);
        setCurrent(next.path);
        setTarget(next.path);
      } catch (failure) {
        if (alive.current) setError(describeFailure(t, failure));
      }
    },
    [t]
  );

  useEffect(() => {
    void open(request.startAt);
  }, [open, request.startAt]);

  useEffect(() => {
    if (target === "") return;
    let cancelled = false;
    callHost("plan", { workspaceId: request.workspaceId, targetParent: target, folderName })
      .then((next) => {
        if (!cancelled) setPlan(next);
      })
      .catch((failure) => {
        if (!cancelled) setPlan({ failure: describeFailure(t, failure), failureCode: failure.code });
      });
    return () => {
      cancelled = true;
    };
  }, [target, folderName, request.workspaceId, t]);

  const createFolder = useCallback(async () => {
    const name = window.prompt(t("dialog.newFolderPrompt"), "");
    if (name === null) return;
    try {
      const made = await callHost("createFolder", { parent: current, name });
      await open(made.path);
    } catch (failure) {
      setError(describeFailure(t, failure));
    }
  }, [current, open, t]);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await callHost("move", { workspaceId: request.workspaceId, targetParent: target, folderName });
      onDone(result);
    } catch (failure) {
      setError(describeFailure(t, failure));
      setBusy(false);
    }
  }, [folderName, onDone, request.workspaceId, t, target]);

  const crumbs = listing?.crumbs ?? [];
  const entries = listing?.entries ?? [];
  const blocked = plan?.failure !== undefined;
  return h(
    "div",
    {
      className: "dshwm-backdrop",
      role: "presentation",
      onMouseDown: (event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }
    },
    h(
      "div",
      { role: "dialog", "aria-modal": "true", "aria-label": t("dialog.title"), className: "dshwm-panel" },
      h("h2", { className: "dshwm-title" }, t("dialog.title")),
      h(
        "div",
        { className: "dshwm-field" },
        h("span", { className: "dshwm-label" }, t("dialog.source")),
        h("div", { className: "dshwm-value" }, request.source)
      ),
      h(
        "div",
        { className: "dshwm-field" },
        h("span", { className: "dshwm-label" }, t("dialog.target")),
        h(
          "div",
          { className: "dshwm-browser" },
          h(
            "div",
            { className: "dshwm-crumbs" },
            crumbs.map((crumb, index) =>
              h(
                "button",
                {
                  key: crumb.path,
                  type: "button",
                  className: "dshwm-crumb",
                  "data-active": index === crumbs.length - 1 ? "true" : "false",
                  onClick: () => void open(crumb.path)
                },
                crumb.name
              )
            )
          ),
          h(
            "div",
            { className: "dshwm-list" },
            listing === undefined
              ? h("span", { className: "dshwm-hint" }, t("dialog.loading"))
              : entries.length === 0
                ? h("span", { className: "dshwm-hint" }, t("dialog.emptyFolder"))
                : entries.map((entry) => h(FolderRow, { key: entry.path, entry, onOpen: (path) => void open(path) }))
          ),
          h(
            "div",
            { className: "dshwm-footer" },
            h("button", { type: "button", className: "dshwm-button", onClick: () => void createFolder() }, t("dialog.newFolder")),
            h("button", { type: "button", className: "dshwm-button", onClick: () => void open(current) }, t("dialog.pickHere"))
          )
        )
      ),
      h(
        "div",
        { className: "dshwm-field" },
        h("span", { className: "dshwm-label" }, t("dialog.folderName")),
        h("input", {
          className: "dshwm-input",
          value: folderName,
          spellCheck: false,
          onChange: (event) => setFolderName(event.target.value)
        }),
        h("p", { className: "dshwm-hint" }, t("dialog.folderHint"))
      ),
      h(
        "div",
        { className: "dshwm-field" },
        h("span", { className: "dshwm-label" }, t("dialog.destination")),
        blocked
          ? h("p", { className: "dshwm-hint" }, plan.failure)
          : h("div", { className: "dshwm-value" }, plan?.destination ?? t("dialog.loading"))
      ),
      error === undefined ? null : h("p", { className: "dshwm-error" }, error),
      h(
        "div",
        { className: "dshwm-footer" },
        h("button", { type: "button", className: "dshwm-button", disabled: busy, onClick: () => onClose() }, t("dialog.cancel")),
        h(
          "button",
          {
            type: "button",
            className: "dshwm-button dshwm-primary",
            disabled: busy || blocked || target === "",
            onClick: () => void confirm()
          },
          busy ? t("dialog.moving") : t("dialog.confirm")
        )
      )
    )
  );
}

/**
 * Icons drawn here rather than borrowed, so the entries keep their own visual
 * identity inside the Host menu.
 * @param props - drawing size.
 * @returns the "move" glyph: a folder with an arrow leaving it.
 */
function MoveIcon({ size = 16 }) {
  return h(
    "svg",
    { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
    h("path", {
      d: "M2 4.25c0-.69.56-1.25 1.25-1.25h2.6c.35 0 .68.15.9.41l.62.74h4.38c.69 0 1.25.56 1.25 1.25v.6H2v-1.75Z",
      fill: "currentColor",
      opacity: 0.55
    }),
    h("rect", { x: 2, y: 5.25, width: 8.2, height: 6.5, rx: 1.25, fill: "currentColor", opacity: 0.9 }),
    h("path", {
      d: "M9.6 8.5h3.6m0 0-1.7-1.7m1.7 1.7-1.7 1.7",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinecap: "round",
      strokeLinejoin: "round"
    })
  );
}

/**
 * The "undo" glyph: a counter-clockwise arrow loop.
 * @param props - drawing size.
 * @returns the undo icon.
 */
function UndoIcon({ size = 16 }) {
  return h(
    "svg",
    { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
    h("path", {
      d: "M4.2 6.1V3.3L1.7 5.8l2.5 2.5V6.1Z",
      fill: "currentColor",
      opacity: 0.85
    }),
    h("path", {
      d: "M2.4 6.6a5.4 5.4 0 1 1 .9 5.3",
      stroke: "currentColor",
      strokeWidth: 1.4,
      strokeLinecap: "round",
      fill: "none"
    })
  );
}

/** Services the Client half needs before it can contribute menu entries. */
export const inject = ["slots", "locale", "contextMenus"];

/**
 * Mount the Client half: the two workspace menu entries, the icons they draw,
 * and the one dialog the move entry opens.
 * @param ctx - Client context.
 */
function apply(ctx) {
  try {
    mount(ctx);
  } catch (error) {
    // This half only contributes menu entries. If the shell is not shaped the way
    // it expects, losing the entries is the correct outcome; failing here would
    // abort the whole Web boot and take every other plugin down with it.
    console.error("workspace-move: menu contributions unavailable", error);
  }
}

/**
 * Register the entries, their icons and the dialog behind a fully usable shell.
 * @param ctx - Client context.
 */
function mount(ctx) {
  installStyles();
  const namespace = "workspaceMove";
  ctx.effect(() => ctx.locale.register(namespace, translations), "workspace-move: dictionaries");
  const t = ctx.locale.bind(namespace);

  /** What the Host last reported about undo; refreshed at mount and after every move. */
  let undo = { available: false };
  const refreshUndo = () =>
    callHost("undoInfo")
      .then((info) => {
        undo = info ?? { available: false };
        return undo;
      })
      .catch(() => undo);

  /**
   * Open the destination dialog over the shell.
   * @param request - the workspace being moved and where browsing starts.
   * @returns nothing.
   */
  const openDialog = (request) => {
    const slot = `workspace-move-dialog-${request.workspaceId}`;
    let dispose;
    const close = () => {
      if (dispose === undefined) return;
      dispose();
      dispose = undefined;
    };
    dispose = ctx.slots.register(
      { name: "shell.overlay", id: slot, order: 40, inject: () => ({}) },
      () =>
        h(MoveDialog, {
          ctx,
          t,
          request,
          onClose: close,
          onDone: async (result) => {
            close();
            await refreshUndo();
            ctx.contextMenus.notify(
              `${t("toast.moved")} ${result.destination}`,
              true,
              result.undoable
                ? {
                    label: t("menu.undo"),
                    run: async () => {
                      await callHost("undo");
                      undo = { available: false };
                      ctx.contextMenus.notify(t("toast.undone"), true);
                    },
                    failureLabel: t("toast.failed")
                  }
                : undefined
            );
          }
        })
    );
  };

  ctx.effect(
    () =>
      ctx.contextMenus.register({
        id: "workspace-move.move",
        target: "workspace",
        order: 200,
        resolve: (value) => {
          const workspaceId = typeof value?.workspaceId === "string" ? value.workspaceId : "";
          const path = typeof value?.path === "string" ? value.path : "";
          if (workspaceId === "" || path === "") return [];
          const trimmed = path.replace(/[\\/]+$/u, "");
          const name = trimmed.split(/[\\/]/u).pop() ?? "";
          const cut = trimmed.length - name.length;
          const startAt = cut > 1 ? trimmed.slice(0, cut - 1) : trimmed;
          return [
            {
              id: "workspace-move.move",
              label: t("menu.move"),
              icon: { key: "workspaceMove.move" },
              failureLabel: t("toast.failed"),
              run: () => {
                openDialog({ workspaceId, source: path, currentName: name, startAt });
              }
            }
          ];
        }
      }),
    "workspace-move: move entry"
  );

  ctx.effect(
    () =>
      ctx.contextMenus.register({
        id: "workspace-move.undo",
        target: "workspace",
        order: 210,
        resolve: () =>
          undo.available !== true
            ? []
            : [
                {
                  id: "workspace-move.undo",
                  label: t("menu.undo"),
                  icon: { key: "workspaceMove.undo" },
                  separatorBefore: true,
                  failureLabel: t("toast.failed"),
                  run: async () => {
                    try {
                      await callHost("undo");
                      undo = { available: false };
                      ctx.contextMenus.notify(t("toast.undone"), true);
                    } catch (failure) {
                      await refreshUndo();
                      ctx.contextMenus.notify(describeFailure(t, failure));
                    }
                  }
                }
              ]
      }),
    "workspace-move: undo entry"
  );

  ctx.slots.inject("contextMenu.icon", () => [
    ctx.slots.register({ name: "contextMenu.icon", key: "workspaceMove.move" }, MoveIcon),
    ctx.slots.register({ name: "contextMenu.icon", key: "workspaceMove.undo" }, UndoIcon)
  ]);

  void refreshUndo();
}

export { apply };
