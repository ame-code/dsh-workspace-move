# Changelog

## Unreleased

- Preserve workspace session membership and order during moves instead of
  reattaching stored sessions. Unlisted sessions (including subagents) still move
  with the folder, and their live path/header indexes follow move and undo.
- Keep complete session backups until a move commits, and remove partial target
  artifacts on rollback so failed moves do not leave duplicate session IDs or
  lose companion files. Refuse existing session target directories.
- Add real-storage regressions for array-valued session IDs, readable JSON,
  unchanged unrelated workspaces, nested sessions, and registry restart.

- Tests can no longer leave scratch directories behind. Temporary directories go
  through `test/support/scratch.mjs`, which deletes them in `finally` and fails the
  run if one survives; each test script also runs `scripts/scratch.mjs check`,
  which scans the system temp directory, every Windows drive root, `/dev/shm` and
  `/mnt/*` for `dshwm-*` leftovers. `npm run clean:scratch` sweeps older ones.
  The platform test used to create a probe directory on the other volume to prove
  it was writable and never remove it — one empty folder per run, for example on
  `D:\` — and now removes it immediately.

## 0.2.4

- Verified against DeepSeek Harness `0.2.2-rc.3`, this time with the published
  packages: unit, platform and end-to-end suites pass against `0.2.2-rc.3` from the
  registry, and `test/chain.mjs` moves a workspace through a real `dsh web`
  `0.2.2-rc.3` host — plan, move, registry and session-header rewrite, undo, and no
  leftover scratch files.
- The dialog was driven in a real browser against that same `0.2.2-rc.3` host: the
  workspace menu still shows the entries in the same order, the panel opens with
  the destination browser, creating a folder inline works, the move completes, the
  undo entry appears and brings the workspace back — with no console errors.
- Nothing in the plugin had to change: the client bundle loader still resolves
  `<package>/client.js` through `window.__ModuleLoader__.load`, `contextMenus` /
  `slots` / `locale` keep their signatures, the 25 `--dsw-*` tokens the dialog uses
  all still exist, the router still reports a duplicate prefix route the same way,
  the workspace registry and the `workspace/session-activity` waterfall are
  unchanged, and sessions are still written as v4 zstd logs.
- `engines.dsh` needs no per-release entry: the harness evaluates the range with
  `includePrerelease`, so `>=0.2.0-rc.1 <0.3.0-0` covers the `0.2.2-rc.*` line.
- The withdrawn `0.2.3` was the same compatibility declaration, published before
  rc.3 existed and removed again; `0.2.4` supersedes it.

## 0.2.2

- The destination dialog asks for a new folder inline instead of calling
  `window.prompt`, which Electron does not implement: the "New folder" button used
  to throw and look dead.
- Drop the "Use this folder" button. Browsing already selected the folder you were
  in — that is where the workspace moves — so the button never changed anything.
  The dialog now says so in a hint next to "New folder" instead of offering a
  no-op.

## 0.2.1

- Moving a workspace no longer leaves an empty folder behind in the session
  storage: once every session it owned has been written to its new place, the
  folder that encoded the old working directory is removed if nothing else lives
  in it. Undo and rollback clean up the same way, so a move and its reversal keep
  the storage root tidy.
- `test/chain.mjs` moves a workspace through a real `dsh web` host in an isolated
  `DSH_HOME`; CI runs it on ubuntu-latest and macos-latest, which is the only way
  the macOS path gets exercised without a Mac.

## 0.2.0

- macOS and Linux now run the same move path as Windows, with the platform's own
  rules: case sensitivity is probed instead of assumed (so a case-only rename such
  as `proj` → `Proj` works on case-insensitive volumes), folder names follow the
  local filesystem's rules instead of Windows' everywhere, and the copy branch
  preserves executable bits.
- Symbolic links are moved as links: the copy-and-verify branch recreates them and
  compares the link text, so a tree containing links survives a cross-volume move
  and dangling links stay dangling.
- Fix `isInside` on POSIX: the volume root was trimmed to an empty prefix, which
  made every containment check against `/` answer "no".
- Tests that describe filesystem semantics now live in `test/platform.mjs` and
  adapt to the volume they run on; the end-to-end run moved to `test/e2e.mjs` and
  no longer depends on a fixed checkout path.
- CI runs the unit, platform and end-to-end suites on ubuntu-latest,
  macos-latest and windows-latest.

## 0.1.2

- `README.md` is now the Chinese readme, with the English one moved to
  `README.en.md`; both carry a language switcher.

## 0.1.1

- Fix the plugin card in the plugin manager: the localized title and description
  now live under a single nested `meta` object, so the list shows
  “Workspace Move / 移动工作区” instead of the package name.

## 0.1.0

- Move a workspace folder, its tree, its nested workspace registrations and its
  sessions to a new location from the workspace context menu.
- Rename the workspace by giving the folder a new name at the destination.
- Rewrite session logs in place (header `cwd` only) so history and titles survive
  byte for byte.
- Refuse moves while any of the workspace's sessions is running, on destination
  collisions, and on names this platform rejects.
- Roll a failed move back: folder, registrations and sessions return to where they
  were.
- Undo the last move of the current run from the toast or the workspace menu.
- Expose the same engine as the `move_workspace` agent tool.
- Chinese and English UI.
