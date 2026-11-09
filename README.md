# @reed-io/dsh-workspace-move

Move a DeepSeek Harness workspace — the folder itself, everything inside it, the
workspaces registered inside it, and the sessions stored for it — to another
place on disk, from the workspace menu. It behaves like `mv`: one target path, one
atomic result. Changing the folder name renames the workspace at the same time.

## What a move carries

| Carried with the workspace | How |
| --- | --- |
| The workspace folder and its whole tree | One rename on the same volume; copy, verify, then delete the source across volumes. |
| Workspaces registered inside that folder | Their registered paths are rewritten to follow the folder. Registrations, titles and session lists are kept. |
| Sessions listed in the workspace | Each session log moves to the destination project directory and its stored `cwd` header is rewritten in place, so history and titles are kept byte for byte. |
| The workspace title | Only when the moving folder also renames the workspace and the title was still the folder name. |

Nothing else moves. The source folder is deleted only when the move emptied it,
and its parent folder is never touched.

## Use it

Right-click a workspace in the sidebar (or use its `…` button) and choose
**Move workspace…**. Pick the destination folder in the built-in browser, type
the folder name the workspace should have there, check the resulting location,
and confirm.

A move is refused, with a reason, when:

- a workspace folder already exists at the destination — pick another name;
- the destination is inside the workspace, or the workspace is inside the
  destination's own path;
- any of the sessions still has work running — stop them first;
- the name is not a legal folder name on this platform.

After a successful move the toast offers **Undo**, and the workspace menu offers
**Undo last move** while the move is still the most recent one of this run. Undo
is kept in memory only: it lasts until DeepSeek Harness restarts.

A move either completes or fails as a whole. If any step fails, the plugin rolls
back the folder, the registrations and every session it had already touched, and
reports the failure.

## Agent tool

The same engine is one tool, so an agent can do it too:

```text
move_workspace(workspaceId, targetParent, folderName?)
```

`folderName` defaults to the current folder name. The tool reports the final
destination, how many sessions and nested workspaces came along, and whether the
move can still be undone.

## Behaviour notes

- The move runs in the Host process, which owns both the workspace registry and
  the session store; the browser only drives it.
- Sessions are rewritten in place: only the compressed header frame carrying
  `cwd` is re-encoded, every event frame is copied byte for byte.
- A moved session is re-attached to its workspace after its log has landed at the
  new path, so the workspace keeps its session order.
- Running DeepSeek Harness does not need a restart after a move for the moved
  sessions to be usable; a session that is itself currently running cannot be
  moved, which the running-work check enforces.
- Developed and verified on Windows first. The path handling, volume detection
  and folder-name rules are platform-aware, so macOS and Linux use the same code
  path — with the native shared-folder case handled by the copy-and-verify branch.

## Requirements

- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0`
- Node `^22.19.0 || >=24.0.0`
- A local (owner) desktop session: the destination dialog talks to the Host over a
  loopback-only route.

## Install

Requires a running DeepSeek Harness. Replace `desktop` with the profile you use
(`web`, `desktop`, …).

```bash
dsh plugin --profile desktop add @reed-io/dsh-workspace-move@latest
```

Or add the bundle to a profile's `dsh.profile.bundles` and restart DeepSeek
Harness. After installing, reload the page (`Ctrl+R`) so the sidebar picks up the
new menu entries.

## Development

```bash
npm run build     # src/client.js -> lib/client.js (browser bundle)
npm run check     # build, then verify the client bundle contract and containment
npm test          # unit tests: path encoding, folder rules, session log rewriting
```

`lib/client.js` is generated — edit `src/client.js` instead. The Host half
(`lib/*.js` except `client.js`) is plain ESM, loaded straight by Node.

A separate end-to-end harness drives real Cordis services (move, rename, refusal,
rollback, undo) against a scratch session store. It needs the Harness packages
resolvable from `node_modules`, so it lives in the development checkout rather
than in a fresh clone.

## License

MIT
