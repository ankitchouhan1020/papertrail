# Papertrail

Sidebar list of all markdown notes: title, excerpt, modified date, footer search and new note, and a right-click file menu consistent with the File Explorer.

Requires **Obsidian 1.5.0** or newer. Source: [github.com/ankitchouhan1020/papertrail](https://github.com/ankitchouhan1020/papertrail).

## Install

**Community plugins:** Settings → Community plugins → Browse → **Papertrail**.

**Manual:** From [Releases](https://github.com/ankitchouhan1020/papertrail/releases), download `main.js`, `manifest.json`, and `styles.css` into `<Vault>/.obsidian/plugins/papertrail/`, then enable the plugin.

**BRAT:** Add `ankitchouhan1020/papertrail`.

## Usage

- **Ribbon** or command **Open Papertrail** — open or focus the sidebar view.
- **Footer** — search; **+** creates a note in the vault default location.
- **Right-click a row** — open in new tab, rename, delete, reveal in navigation when available, plus other **file menu** items from plugins.

## Settings

| Setting | Description |
|--------|-------------|
| **Sort order** | By modified date, title, or path. |
| **Hide excluded paths** | Also hide paths with a `.` segment (in addition to Obsidian excluded files and `.obsidian`). |

## Development

Follow Obsidian’s [**Build a plugin**](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin) guide: use a **dedicated dev vault**, not your main notes.

1. Clone this repo into `<dev-vault>/.obsidian/plugins/papertrail/`.
2. `npm install`
3. `npm run dev` — watches `src/main.ts` and rebuilds `main.js` on change.
4. Enable Papertrail under Community plugins and reload when files change (or use [Hot-Reload](https://github.com/pjeby/hot-reload)).

Production bundle: `npm run build` (runs `tsc` then esbuild). **Edit `src/main.ts` only** — root `main.js` is generated.

## Releasing

See [COMMUNITY_PLUGIN_CHECKLIST.md](COMMUNITY_PLUGIN_CHECKLIST.md). Bump versions in `manifest.json` / `versions.json`, then tag a GitHub release with `main.js`, `manifest.json`, and `styles.css`.

## License

MIT — see [LICENSE](LICENSE).
