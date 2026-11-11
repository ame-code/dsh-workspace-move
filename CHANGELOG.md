# Changelog

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
