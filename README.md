# Papertrail

A sidebar list of every markdown note in your vault: **title**, **auto-generated excerpt**, and **last modified** date. Includes **search** (titles + fuzzy path, with optional body matches), **new note**, and a **right-click menu** aligned with the file explorer so core actions and other plugins stay consistent.

## Requirements

- Obsidian **1.5.0** or newer (recommended; older versions may work for some features).

## Install

### Community plugins

When the plugin is listed in **Settings → Community plugins → Browse**, search for **Papertrail** and install.

### Manual

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Create a folder: `<Vault>/.obsidian/plugins/papertrail/`
3. Place those three files inside the folder.
4. Enable **Papertrail** under **Settings → Community plugins**.

### BRAT

If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat), add the GitHub repository that hosts this plugin and install the beta/release branch as documented in BRAT’s readme.

## Use

- **Ribbon**: Click the scroll-text icon to open Papertrail in the sidebar (or focus it if it is already open).
- **Command palette**: Run **Open Papertrail**.
- **Search**: Use the search control in the footer. Short queries match titles and paths; longer queries can scan note bodies (debounced, with a sensible concurrency limit).
- **New note**: Use the plus control in the footer (creates and opens a note in the vault default location).
- **Context menu**: Right-click a row for **Open in new tab**, **Rename**, **Delete**, **Reveal in file navigation** (when the file explorer is available), plus any items registered for the vault **file menu** (same hook as the native tree).

## Settings

| Setting | Description |
|--------|-------------|
| **Sort order** | Modified (new / old), title (A–Z), or path (A–Z). |
| **Hide excluded paths** | Extra rule: hide paths with a segment starting with `.` (in addition to Obsidian’s **Excluded files** and `.obsidian`). |

## Development

This plugin ships as plain `main.js` (no build step). To work on it:

1. Clone or copy this folder into `<Vault>/.obsidian/plugins/papertrail/`.
2. Reload Obsidian (**Developer Tools** or restart the app) after changes.

## Releasing (author checklist)

1. Update `version` in `manifest.json` and add the same version to `versions.json` with the correct `minAppVersion`.
2. Tag a GitHub release; attach `manifest.json`, `main.js`, and `styles.css` (or point users at the repo root).
3. For **Community plugins** submission and requirements, see Obsidian’s [Plugin guidelines](https://docs.obsidian.md/Developer+policies/Plugin+guidelines) and [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins).
4. Set **`authorUrl`** (and optional **`fundingUrl`**) in `manifest.json` to your real links before submitting.

## License

MIT — see [LICENSE](LICENSE).
# papertrail
