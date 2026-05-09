# Community plugin submission checklist (Papertrail)

References: [Developer policies](https://docs.obsidian.md/Developer+policies) · [Submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)

## Policies and manifest

- [x] **License** — `LICENSE` in repo.
- [x] **`authorUrl`** — set in `manifest.json`.
- [x] **`fundingUrl`** — omitted unless you accept donations.
- [x] **`minAppVersion`** — **1.5.0**; bump in `manifest.json` and `versions.json` when support changes.
- [x] **`description`** — in `manifest.json` (≤250 chars, ends with `.`, no emoji).
- [x] **`isDesktopOnly`** — `false` (no Node/Electron-only APIs).

## Code

- [x] **Command id** — `open-papertrail` (no duplicate plugin-id prefix).
- [x] **No sample-plugin cruft** · **No hidden network/tracking**.

## Release artifacts

- [x] **`manifest.json`**, **`main.js`**, **`styles.css`** · **`versions.json`** · **`README.md`**.
- [ ] **GitHub release** — tag matching `manifest.json` `version` (e.g. **v1.0.0**); ship the three plugin files.
- [ ] **Manual checks** — clean vault (desktop + mobile); re-read Obsidian docs before submit.
