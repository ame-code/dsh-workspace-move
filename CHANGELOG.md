# Changelog

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
