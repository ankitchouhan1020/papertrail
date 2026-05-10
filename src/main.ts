// @ts-nocheck — src/main.ts is compiled by esbuild; add types gradually.
import {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  Menu,
  Modal,
  TextComponent,
  ButtonComponent,
  setIcon,
  Notice,
} from "obsidian";

/** Passed to `workspace.trigger("file-menu", …)` so core + plugins attach the same items as the file explorer. */
const FILE_MENU_SOURCE = "file-explorer";

const VIEW_TYPE = "papertrail";
/** Lucide icon id (ribbon + tab). See Obsidian icon docs / lucide.dev */
const PLUGIN_ICON = "scroll-text";
const REFRESH_DEBOUNCE_MS = 120;
/** Cap parallel vault reads so huge vaults don’t stampede cachedRead + excerpt parsing. */
const EXCERPT_LOAD_CONCURRENCY = 8;
/** Debounce before scanning note bodies for substring matches. */
const SEARCH_BODY_DEBOUNCE_MS = 200;
/** Min query length before body (cachedRead) tier runs. */
const SEARCH_BODY_MIN_QUERY_LEN = 2;
const SEARCH_MAX_RESULTS = 200;
const SEARCH_BODY_SNIPPET_MAX = 240;
/** Concurrent body reads during search. */
const SEARCH_READ_CONCURRENCY = 8;

/** Title + excerpt stack vertically; shared max line count (title measured first). */
const SNIPPET_BODY_LINE_BUDGET = 3;

const PT_TITLE_MAX_CLASSES = [
  "pt-title-wrap--max-1",
  "pt-title-wrap--max-2",
  "pt-title-wrap--max-3",
];

const PT_EXCERPT_BUDGET_CLASSES = [
  "pt-excerpt--budget-0",
  "pt-excerpt--budget-1",
  "pt-excerpt--budget-2",
];

/** @param {HTMLElement} el */
function stripTitleMaxClasses(el) {
  for (const c of PT_TITLE_MAX_CLASSES) {
    el.classList.remove(c);
  }
}

/** @param {HTMLElement} el */
function stripExcerptBudgetClasses(el) {
  for (const c of PT_EXCERPT_BUDGET_CLASSES) {
    el.classList.remove(c);
  }
}

/**
 * Count laid-out horizontal lines for an element’s contents (stable vs scrollHeight/lineHeight on mobile).
 * @param {HTMLElement} el
 */
function countVisualTextLines(el) {
  if (!(el instanceof HTMLElement)) return 1;
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = range.getClientRects();
  if (!rects || rects.length === 0) return 1;
  /** @type {Set<number>} */
  const tops = new Set();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.height < 0.5 && r.width < 0.5) continue;
    tops.add(Math.round(r.top));
  }
  return Math.max(1, tops.size);
}

/**
 * Title on its own line(s); excerpt always starts on the next line. Max 3 lines total.
 * @param {HTMLElement | null} snippetEl
 */
function layoutPapertrailSnippetBudget(snippetEl) {
  if (!(snippetEl instanceof HTMLElement)) return;
  const titleWrap = snippetEl.querySelector(".pt-title-wrap");
  const excerpt = snippetEl.querySelector(".pt-excerpt");
  if (!(titleWrap instanceof HTMLElement) || !(excerpt instanceof HTMLElement)) {
    return;
  }

  const titleEl =
    /** @type {HTMLElement | null} */ (titleWrap.querySelector(".pt-title")) ??
    titleWrap;

  if (excerpt.classList.contains("pt-excerpt--empty")) {
    stripTitleMaxClasses(titleWrap);
    stripExcerptBudgetClasses(excerpt);
    titleWrap.classList.add("pt-title-wrap--max-3");
    return;
  }

  stripTitleMaxClasses(titleWrap);
  stripExcerptBudgetClasses(excerpt);

  titleWrap.classList.add("pt-title-wrap--measure");
  void snippetEl.offsetHeight;
  const naturalTitleLines = countVisualTextLines(titleEl);
  titleWrap.classList.remove("pt-title-wrap--measure");

  const titleSlots = Math.min(SNIPPET_BODY_LINE_BUDGET, naturalTitleLines);
  const excerptLines = Math.max(0, SNIPPET_BODY_LINE_BUDGET - titleSlots);

  titleWrap.classList.add(`pt-title-wrap--max-${titleSlots}`);

  if (excerptLines <= 0) {
    excerpt.classList.add("pt-excerpt--budget-0");
  } else if (excerptLines === 1) {
    excerpt.classList.add("pt-excerpt--budget-1");
  } else {
    excerpt.classList.add("pt-excerpt--budget-2");
  }
}

/** @param {HTMLElement | null} snippetEl */
function schedulePapertrailSnippetBudget(snippetEl) {
  if (!(snippetEl instanceof HTMLElement)) return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() =>
      layoutPapertrailSnippetBudget(snippetEl)
    );
  });
}

/** @param {unknown} e */
function errorMessage(e) {
  if (e && typeof e === "object" && "message" in e) {
    const m = /** @type {{ message?: unknown }} */ (e).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * List row date.
 * Recent edits → relative ("just now", "5 min ago", "2 hr ago", "yesterday",
 * "3 days ago"); anything ≥ 7 days old falls back to "9 May 2026".
 */
function formatListCardDate(mtime) {
  const diff = Math.max(0, Date.now() - mtime);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  if (diff < MIN) return "Just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MIN);
    return `${m}\u00a0${m === 1 ? "minute" : "minutes"} ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h}\u00a0${h === 1 ? "hour" : "hours"} ago`;
  }
  if (diff < 7 * DAY) {
    const d = Math.floor(diff / DAY);
    return d === 1 ? "Yesterday" : `${d}\u00a0days ago`;
  }

  const d = new Date(mtime);
  return `${d.getDate()}\u00a0${MONTH_ABBR[d.getMonth()]}\u00a0${d.getFullYear()}`;
}

const META_KEY_LINE =
  /^(tags|aliases|alias|cssclass|cssclasses|date|publish|status|author|created|updated)\s*:/i;
const DATAVIEW_LINE = /^.+?\s*::\s*\S/;
const HEADING_LINE = /^#{1,6}\s/;
const TAG_ONLY_ITEM =
  /^[-*+]\s+(#\[[^\]]+\]|#[\w/-]+)(\s*,\s*(#\[[^\]]+\]|#[\w/-]+))*$/i;
const TAG_ONLY_LINE = /^(#\[[^\]]+\]|#[\w/-]+)(\s+(#\[[^\]]+\]|#[\w/-]+))*$/i;

function cleanExcerptBlock(block) {
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const kept = [];
  for (const l of lines) {
    if (HEADING_LINE.test(l)) continue;
    if (META_KEY_LINE.test(l)) continue;
    if (DATAVIEW_LINE.test(l)) continue;
    if (TAG_ONLY_ITEM.test(l)) continue;
    if (TAG_ONLY_LINE.test(l)) continue;
    if (/^%%[\s\S]*%%$/.test(l)) continue;
    kept.push(l);
  }
  let s = kept.join(" ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1");
  s = s.replace(/\[\[[^\]]*::[^\]]*\]\]/g, " ");
  s = s.replace(/\[[^\]]*::[^\]]*\]/g, " ");
  s = s.replace(/(^|\s)#(?!\s)([\w/-]+)/g, "$1");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function excerptFromMarkdown(raw) {
  let s = raw.replace(/^\uFEFF?/, "");
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/m, "");
  s = s.trim();
  while (HEADING_LINE.test(s)) s = s.replace(/^#{1,6}\s.*\r?\n?/m, "").trim();

  const blocks = s
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  let text = "";
  for (const block of blocks) {
    text = cleanExcerptBlock(block);
    if (text.length > 0) break;
  }

  if (text.length > 220) {
    text = text.slice(0, 220).trim();
    const cut = text.lastIndexOf(" ");
    if (cut > 140) text = text.slice(0, cut);
    text += "…";
  }
  return text;
}

/**
 * @typedef {{ kind: "plain" | "mark", text: string }} HighlightSegment
 */

/**
 * Apply highlight segments into `el`, replacing existing children.
 * Uses createEl + text nodes so we never write HTML directly.
 * @param {HTMLElement} el
 * @param {HighlightSegment[]} segments
 */
function applyHighlightSegmentsTo(el, segments) {
  el.empty();
  for (const seg of segments) {
    if (!seg.text) continue;
    if (seg.kind === "mark") {
      el.createEl("mark", { cls: "pt-search-mark", text: seg.text });
    } else {
      el.appendChild(document.createTextNode(seg.text));
    }
  }
}

/**
 * Indices in `textLower` matching `queryLower` as an ordered subsequence (fuzzy).
 * @returns {number[] | null}
 */
function fuzzyOrderedIndices(queryLower, textLower) {
  if (!queryLower.length) return [];
  /** @type {number[]} */
  const pos = [];
  let qi = 0;
  for (let i = 0; i < textLower.length && qi < queryLower.length; i++) {
    if (textLower[i] === queryLower[qi]) {
      pos.push(i);
      qi++;
    }
  }
  return qi >= queryLower.length ? pos : null;
}

/** @param {number[]} pos */
function scoreFromFuzzyIndices(pos) {
  if (!pos.length) return 0;
  const span = pos[pos.length - 1] - pos[0];
  const startBonus = pos[0] === 0 ? 80 : 0;
  return 10000 - span + startBonus - pos.length * 2;
}

/** @param {number[]} indices sorted ascending */
function indicesToRanges(indices) {
  if (!indices.length) return [];
  /** @type {number[][]} */
  const ranges = [];
  let s = indices[0];
  let e = indices[0] + 1;
  for (let k = 1; k < indices.length; k++) {
    if (indices[k] === e) e++;
    else {
      ranges.push([s, e]);
      s = indices[k];
      e = indices[k] + 1;
    }
  }
  ranges.push([s, e]);
  return ranges;
}

/**
 * Build highlight segments for a fuzzy match. `original` and indices share
 * length with the fuzzy match on lowercase.
 * @returns {HighlightSegment[]}
 */
function highlightFuzzySegments(original, indices) {
  const ranges = indicesToRanges(indices);
  /** @type {HighlightSegment[]} */
  const segs = [];
  let last = 0;
  for (const [a, b] of ranges) {
    if (a > last) {
      segs.push({ kind: "plain", text: original.slice(last, a) });
    }
    segs.push({ kind: "mark", text: original.slice(a, b) });
    last = b;
  }
  if (last < original.length) {
    segs.push({ kind: "plain", text: original.slice(last) });
  }
  return segs;
}

/**
 * First case-insensitive substring match → highlight segments.
 * @returns {HighlightSegment[]}
 */
function highlightSubstringICSegments(original, needle) {
  if (!needle) return [{ kind: "plain", text: original }];
  const lower = original.toLowerCase();
  const nl = needle.toLowerCase();
  const idx = lower.indexOf(nl);
  if (idx < 0) return [{ kind: "plain", text: original }];
  /** @type {HighlightSegment[]} */
  const segs = [];
  if (idx > 0) segs.push({ kind: "plain", text: original.slice(0, idx) });
  segs.push({
    kind: "mark",
    text: original.slice(idx, idx + needle.length),
  });
  const tail = idx + needle.length;
  if (tail < original.length) {
    segs.push({ kind: "plain", text: original.slice(tail) });
  }
  return segs;
}

/** Strip frontmatter + collapse whitespace for body search (same boundary as excerpt). */
function plainTextForSearch(raw) {
  let s = raw.replace(/^\uFEFF?/, "");
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/m, "");
  s = s.trim();
  while (HEADING_LINE.test(s)) {
    s = s.replace(/^#{1,6}\s.*\r?\n?/m, "").trim();
  }
  return s.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} plain
 * @param {string} needle raw query for highlight length
 * @returns {{ segments: HighlightSegment[]; found: boolean } | null} null if no match
 */
function snippetSegmentsAroundMatch(plain, needle) {
  if (!needle) {
    return {
      segments: [
        { kind: "plain", text: plain.slice(0, SEARCH_BODY_SNIPPET_MAX) },
      ],
      found: false,
    };
  }
  const lower = plain.toLowerCase();
  const nl = needle.toLowerCase();
  const idx = lower.indexOf(nl);
  if (idx < 0) return null;
  const pad = Math.floor((SEARCH_BODY_SNIPPET_MAX - needle.length) / 2);
  const start = Math.max(0, idx - pad);
  const end = Math.min(
    plain.length,
    Math.max(idx + needle.length + pad, start + SEARCH_BODY_SNIPPET_MAX)
  );
  const chunk = plain.slice(start, end);
  const relIdx = idx - start;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < plain.length ? "…" : "";
  /** @type {HighlightSegment[]} */
  const segs = [];
  if (prefix) segs.push({ kind: "plain", text: prefix });
  if (relIdx > 0) segs.push({ kind: "plain", text: chunk.slice(0, relIdx) });
  segs.push({
    kind: "mark",
    text: chunk.slice(relIdx, relIdx + needle.length),
  });
  const tailStart = relIdx + needle.length;
  if (tailStart < chunk.length) {
    segs.push({ kind: "plain", text: chunk.slice(tailStart) });
  }
  if (suffix) segs.push({ kind: "plain", text: suffix });
  return { segments: segs, found: true };
}

/** True if any path segment starts with "." (e.g. `.hidden`, `dir/.secret`). */
function pathHasDotSegment(normPath) {
  const parts = normPath.split("/");
  return parts.some((p) => p.length > 0 && p.startsWith("."));
}

/**
 * Matches Obsidian-style excluded paths (userIgnoreFilters).
 * @param {string} normPath forward slashes
 * @param {string} filterRaw pattern from settings
 */
function pathMatchesUserIgnoreFilter(normPath, filterRaw) {
  const filter = String(filterRaw ?? "").replace(/\\/g, "/").trim();
  if (!filter) return false;
  const path = normPath.replace(/\\/g, "/");

  if (filter.endsWith("/")) {
    return path === filter.slice(0, -1) || path.startsWith(filter);
  }
  if (filter.includes("*")) {
    const esc = filter
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    const re = new RegExp("^" + esc + "($|/)");
    return re.test(path);
  }
  return path === filter || path.startsWith(filter + "/");
}

/** @param {import("obsidian").App} app */
function getFileExplorerInstance(app) {
  try {
    const ip = app.internalPlugins;
    if (!ip) return null;
    if (typeof ip.getEnabledPluginById === "function") {
      const p = ip.getEnabledPluginById("file-explorer");
      return p?.instance ?? null;
    }
    if (typeof ip.getPluginById === "function") {
      const p = ip.getPluginById("file-explorer");
      return p?.instance ?? null;
    }
    const pl = ip.plugins;
    const e = pl && pl["file-explorer"];
    return e?.instance ?? null;
  } catch {
    return null;
  }
}

class PapertrailRenameModal extends Modal {
  /**
   * @param {import("obsidian").App} app
   * @param {TFile} file
   */
  constructor(app, file) {
    super(app);
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "New file name (keep the extension, e.g. .md).",
    });
    const tc = new TextComponent(contentEl).setValue(this.file.name);
    tc.inputEl.addClass("pt-rename-modal-input");
    const row = contentEl.createDiv({ cls: "pt-rename-modal-actions" });
    new ButtonComponent(row).setButtonText("Cancel").onClick(() => {
      this.close();
    });
    new ButtonComponent(row)
      .setButtonText("Rename")
      .setCta()
      .onClick(async () => {
        const name = tc.getValue().trim();
        if (!name) return;
        try {
          const parent = this.file.parent;
          const newPath = parent?.path
            ? normalizePath(`${parent.path}/${name}`)
            : normalizePath(name);
          if (newPath !== this.file.path) {
            await this.app.fileManager.renameFile(this.file, newPath);
          }
        } catch (e) {
          new Notice("Papertrail: could not rename — " + errorMessage(e));
        }
        this.close();
      });
  }
}

/**
 * Core file explorer builds its menu in the explorer view; `file-menu` only runs plugin hooks.
 * Prepend the usual actions so behavior matches the native tree, then trigger for plugins.
 * @param {Menu} menu
 * @param {TFile} file
 * @param {import("obsidian").App} app
 */
function populateExplorerLikeFileMenuBeforePlugins(menu, file, app) {
  menu.addItem((item) => {
    item
      .setTitle("Open in new tab")
      .setIcon("file-plus")
      .onClick(() => {
        void app.workspace.getLeaf("tab").openFile(file);
      });
  });
  menu.addSeparator();
  menu.addItem((item) => {
    item.setTitle("Rename").setIcon("pencil-line").onClick(() => {
      const fm = app.fileManager;
      if (fm && typeof fm.promptForFileRename === "function") {
        void fm.promptForFileRename(file);
      } else {
        new PapertrailRenameModal(app, file).open();
      }
    });
  });
  menu.addItem((item) => {
    item.setTitle("Delete").setIcon("trash").onClick(() => {
      void app.fileManager.promptForDeletion(file);
    });
  });
  const fe = getFileExplorerInstance(app);
  if (fe && typeof fe.revealInFolder === "function") {
    menu.addItem((item) => {
      item
        .setTitle("Reveal in file navigation")
        .setIcon("folder-tree")
        .onClick(() => {
          try {
            fe.revealInFolder(file);
          } catch (e) {
            new Notice(
              "Papertrail: reveal in navigation failed — " + errorMessage(e)
            );
          }
        });
    });
  }
  menu.addSeparator();
}

const DEFAULT_SETTINGS = {
  sortOrder: "mtime-desc",
  hideExcludedPaths: true,
};

/** @type {{ id: string; label: string }[]} */
const SORT_ORDERS = [
  { id: "mtime-desc", label: "Modified (newest first)" },
  { id: "mtime-asc", label: "Modified (oldest first)" },
  { id: "title-asc", label: "Title (A–Z)" },
  { id: "path-asc", label: "Path (A–Z)" },
];

class PapertrailSettingTab extends PluginSettingTab {
  /** @param {PapertrailPlugin} plugin */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Sort order")
      .setDesc("How notes are ordered in the list.")
      .addDropdown((dropdown) => {
        for (const { id, label } of SORT_ORDERS) {
          dropdown.addOption(id, label);
        }
        return dropdown
          .setValue(this.plugin.settings.sortOrder)
          .onChange(async (value) => {
            this.plugin.settings.sortOrder = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Hide excluded paths")
      .setDesc(
        "When enabled, also hide notes whose path includes a folder or file starting with a dot."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideExcludedPaths)
          .onChange(async (value) => {
            this.plugin.settings.hideExcludedPaths = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

class PapertrailView extends ItemView {
  /**
   * @param {import('obsidian').WorkspaceLeaf} leaf
   * @param {PapertrailPlugin} plugin
   */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    /** @type {Map<string, string>} */
    this._excerptCache = new Map();
    this._previewSerial = 0;
    /** @type {number | null} */
    this._debounceTimer = null;
    /** @type {HTMLDivElement | null} */
    this.scrollEl = null;
    /** @type {HTMLDivElement | null} */
    this._chromeFooter = null;
    /** @type {HTMLDivElement | null} */
    this._chromeDefaultRow = null;
    /** @type {HTMLDivElement | null} */
    this._chromeSearchRow = null;
    /** @type {HTMLSpanElement | null} */
    this._chromeTitleEl = null;
    /** @type {HTMLInputElement | null} */
    this._searchInput = null;
    this._searchMode = false;
    this._searchQuery = "";
    this._searchGen = 0;
    /** @type {number | null} */
    this._searchBodyTimer = null;
    /** @type {{ file: TFile; subtitleEl: HTMLElement; req: string }[]} */
    this._excerptQueue = [];
    this._excerptInflight = 0;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Papertrail";
  }

  getIcon() {
    return PLUGIN_ICON;
  }

  scheduleRefresh() {
    if (this._debounceTimer != null) {
      window.clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._debounceTimer = window.setTimeout(() => {
      this._debounceTimer = null;
      this.refreshList();
    }, REFRESH_DEBOUNCE_MS);
  }

  registerViewEvents() {
    const bump = () => this.scheduleRefresh();
    this.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => {
        this.updateActiveRow();
        if (this.plugin.app.workspace.getActiveLeaf() === this.leaf) {
          this.queueScrollActiveIntoView();
          this.triggerChromeTitleTabTransition();
        }
      })
    );
    this.registerEvent(this.plugin.app.vault.on("create", bump));
    this.registerEvent(
      this.plugin.app.vault.on("delete", (f) => {
        if (f && "path" in f) this._excerptCache.delete(f.path);
        bump();
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        if (oldPath) this._excerptCache.delete(oldPath);
        if (file && "path" in file) this._excerptCache.delete(file.path);
        bump();
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on("modify", (f) => {
        if (f && "path" in f) this._excerptCache.delete(f.path);
        bump();
      })
    );
  }

  /**
   * Refresh just the .pt-date cells so relative labels ("5 min ago") don't
   * go stale between vault events. Runs on a 60s tick — DOM rebuild is
   * unnecessary since we only need to re-stringify the timestamp.
   */
  tickRelativeDates() {
    if (!this.scrollEl) return;
    const rows = this.scrollEl.querySelectorAll(".pt-item[data-path]");
    for (const row of rows) {
      if (!(row instanceof HTMLElement)) continue;
      const path = row.dataset.path;
      if (!path) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const dateEl = row.querySelector(".pt-date");
      if (dateEl instanceof HTMLElement) {
        dateEl.setText(formatListCardDate(file.stat.mtime));
      }
    }
  }

  /** @param {MouseEvent} e */
  onRootClick(e) {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(".pt-chrome-footer")) return;
    const item = target.closest(".pt-item");
    if (!item || !(item instanceof HTMLElement)) return;
    const path = item.dataset.path;
    if (!path) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.plugin.app.workspace.getLeaf(false).openFile(file);
    }
  }

  /**
   * Context menu: core explorer-style entries first, then `file-menu` (plugins).
   * @param {MouseEvent} e
   */
  onRootContextMenu(e) {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(".pt-chrome-footer")) return;
    const row = target.closest(".pt-item");
    if (!row || !(row instanceof HTMLElement)) return;
    const path = row.dataset.path;
    if (!path) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    const { app } = this.plugin;
    const explorerLeaf = app.workspace.getLeavesOfType("file-explorer")[0];
    populateExplorerLikeFileMenuBeforePlugins(menu, file, app);
    app.workspace.trigger(
      "file-menu",
      menu,
      file,
      FILE_MENU_SOURCE,
      explorerLeaf ?? this.leaf
    );
    menu.showAtMouseEvent(e);
  }

  updateActiveRow() {
    if (!this.scrollEl) return;
    const active = this.plugin.app.workspace.getActiveFile();
    const path = active?.path;
    const prev = this.scrollEl.querySelector(".pt-item.is-active");
    if (prev) prev.classList.remove("is-active");
    if (path) {
      const next = this.scrollEl.querySelector(
        `.pt-item[data-path="${CSS.escape(path)}"]`
      );
      if (next) next.classList.add("is-active");
    }
  }

  scrollActiveNoteIntoView() {
    if (!this.scrollEl) return;
    const active = this.plugin.app.workspace.getActiveFile();
    if (!active) return;
    const row = this.scrollEl.querySelector(
      `.pt-item[data-path="${CSS.escape(active.path)}"]`
    );
    if (!(row instanceof HTMLElement)) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** After layout (open tab / focus Papertrail), scroll the open note into view. */
  queueScrollActiveIntoView() {
    if (!this.scrollEl) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.scrollActiveNoteIntoView());
    });
  }

  /** Cmd/Ctrl + ↑/↓ — open previous/next list row (via plugin hotkeys, works while editor is focused). */
  navigateListByArrow(delta) {
    if (!this.scrollEl || delta === 0) return;
    const items = /** @type {HTMLElement[]} */ (
      Array.from(
        this.scrollEl.querySelectorAll(".pt-item[data-path]")
      ).filter((n) => n instanceof HTMLElement && Boolean(n.dataset.path))
    );
    if (items.length === 0) return;

    const active = this.plugin.app.workspace.getActiveFile();
    let idx = items.findIndex((el) => el.dataset.path === active?.path);

    if (idx < 0) {
      idx = delta > 0 ? 0 : items.length - 1;
    } else {
      idx += delta;
      if (idx < 0 || idx >= items.length) return;
    }

    const path = items[idx]?.dataset.path;
    const file = path
      ? this.plugin.app.vault.getAbstractFileByPath(path)
      : null;
    if (file instanceof TFile) {
      void this.plugin.app.workspace
        .getLeaf(false)
        .openFile(file)
        .then(() => {
          this.updateActiveRow();
          requestAnimationFrame(() => this.scrollActiveNoteIntoView());
        });
    }
  }

  /** Fade/slide the footer title when this sidebar tab becomes active. */
  triggerChromeTitleTabTransition() {
    const el = this._chromeTitleEl;
    if (!(el instanceof HTMLElement)) return;
    el.classList.remove("pt-chrome-title--tab-in");
    window.requestAnimationFrame(() => {
      void el.offsetWidth;
      el.classList.add("pt-chrome-title--tab-in");
    });
  }

  buildChromeFooter() {
    if (!this.contentEl) return;
    const bar = this.contentEl.createDiv({ cls: "pt-chrome-footer" });
    this._chromeFooter = bar;

    const defRow = bar.createDiv({ cls: "pt-chrome-footer-default" });
    this._chromeDefaultRow = defRow;
    this._chromeTitleEl = defRow.createSpan({
      cls: "pt-chrome-title",
      text: "Papertrail",
    });
    const actions = defRow.createDiv({ cls: "pt-chrome-actions" });
    const searchBtn = actions.createEl("button", {
      cls: "clickable-icon pt-chrome-btn",
      type: "button",
      attr: { "aria-label": "Search notes", title: "Search notes" },
    });
    setIcon(searchBtn, "search");
    this.registerDomEvent(searchBtn, "click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.enterSearchMode();
    });

    const searchRow = bar.createDiv({ cls: "pt-chrome-footer-search" });
    this._chromeSearchRow = searchRow;

    const lead = searchRow.createDiv({ cls: "pt-chrome-search-lead" });
    setIcon(lead, "search");

    const input = searchRow.createEl("input", {
      cls: "pt-chrome-search-input",
      type: "search",
      attr: {
        placeholder: "Search…",
        "aria-label": "Search notes",
        enterkeyhint: "search",
      },
    });
    this._searchInput = input;

    this.registerDomEvent(input, "input", () => {
      this._searchQuery = input.value;
      this.scheduleSearchPipeline();
    });

    this.registerDomEvent(input, "keydown", (kev) => {
      if (kev.key === "Escape") {
        kev.preventDefault();
        this.exitSearchMode();
      }
    });

    const clearBtn = searchRow.createEl("button", {
      cls: "clickable-icon pt-chrome-search-clear",
      type: "button",
      attr: { "aria-label": "Close search", title: "Close search" },
    });
    setIcon(clearBtn, "x");
    this.registerDomEvent(clearBtn, "click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.exitSearchMode();
    });
  }

  enterSearchMode() {
    this._searchMode = true;
    if (this._chromeFooter instanceof HTMLElement) {
      this._chromeFooter.classList.add("is-search-mode");
    }
    if (this._searchInput) {
      this._searchInput.value = this._searchQuery;
      this._searchQuery = this._searchInput.value;
      this.plugin.app.workspace.setActiveLeaf(this.leaf, { focus: true });
      requestAnimationFrame(() => this._searchInput?.focus());
    }
    this.refreshList();
  }

  exitSearchMode() {
    this._searchMode = false;
    this._searchQuery = "";
    this._searchGen++;
    if (this._searchBodyTimer != null) {
      window.clearTimeout(this._searchBodyTimer);
      this._searchBodyTimer = null;
    }
    if (this._searchInput) this._searchInput.value = "";
    if (this._chromeFooter instanceof HTMLElement) {
      this._chromeFooter.classList.remove("is-search-mode");
    }
    this.refreshList();
  }

  scheduleSearchPipeline() {
    if (this._searchBodyTimer != null) {
      window.clearTimeout(this._searchBodyTimer);
      this._searchBodyTimer = null;
    }
    const gen = ++this._searchGen;
    void this.runSearchPipeline(this._searchQuery, gen);
    const q = this._searchQuery.trim();
    if (q.length >= SEARCH_BODY_MIN_QUERY_LEN) {
      this._searchBodyTimer = window.setTimeout(() => {
        this._searchBodyTimer = null;
        if (gen === this._searchGen && this._searchMode) {
          void this.runSearchBodyTier(q, gen);
        }
      }, SEARCH_BODY_DEBOUNCE_MS);
    }
  }

  /**
   * @param {string} rawQuery
   * @param {number} gen
   */
  runSearchPipeline(rawQuery, gen) {
    if (!this.scrollEl || !this._searchMode) return;
    const files = this.plugin.collectMarkdownFiles();
    const qTrim = rawQuery.trim();
    if (!qTrim) {
      if (gen !== this._searchGen) return;
      this.renderNormalListFromFiles(files);
      return;
    }
    const qLower = qTrim.toLowerCase();
    const tierA = this.collectTitlePathMatches(files, qTrim, qLower);
    if (gen !== this._searchGen) return;
    this.renderSearchRows(tierA.slice(0, SEARCH_MAX_RESULTS), gen);
  }

  /**
   * @param {TFile[]} files
   * @param {string} qTrim
   * @param {string} qLower
   */
  collectTitlePathMatches(files, qTrim, qLower) {
    /** @type {{ file: TFile; score: number; titleSegments: HighlightSegment[]; snippetSegments: HighlightSegment[] | null }[]} */
    const tierA = [];
    for (const f of files) {
      const baseLower = f.basename.toLowerCase();
      const pathLower = f.path.toLowerCase();
      const ti = fuzzyOrderedIndices(qLower, baseLower);
      const pi =
        ti === null ? fuzzyOrderedIndices(qLower, pathLower) : null;
      if (ti) {
        tierA.push({
          file: f,
          score: scoreFromFuzzyIndices(ti),
          titleSegments: highlightFuzzySegments(f.basename, ti),
          snippetSegments: null,
        });
      } else if (pi) {
        tierA.push({
          file: f,
          score: scoreFromFuzzyIndices(pi) - 120,
          titleSegments: [{ kind: "plain", text: f.basename }],
          snippetSegments: highlightSubstringICSegments(f.path, qTrim),
        });
      }
    }
    tierA.sort((a, b) => b.score - a.score);
    return tierA;
  }

  /**
   * @param {string} qTrim
   * @param {number} gen
   */
  runSearchBodyTier(qTrim, gen) {
    if (!this.scrollEl || !this._searchMode || gen !== this._searchGen) return;
    const qLower = qTrim.toLowerCase();
    const files = this.plugin.collectMarkdownFiles();
    const tierAFull = this.collectTitlePathMatches(files, qTrim, qLower);
    const seen = new Set(tierAFull.map((x) => x.file.path));
    const toScan = files.filter((f) => !seen.has(f.path));

    /** @type {{ file: TFile; score: number; titleSegments: HighlightSegment[]; snippetSegments: HighlightSegment[] }[]} */
    const tierB = [];
    const vault = this.plugin.app.vault;

    const finish = () => {
      if (gen !== this._searchGen) return;
      const filesNow = this.plugin.collectMarkdownFiles();
      const tierA = this.collectTitlePathMatches(filesNow, qTrim, qLower);
      tierB.sort((a, b) => b.score - a.score);
      const merged = [...tierA, ...tierB].slice(0, SEARCH_MAX_RESULTS);
      this.renderSearchRows(merged, gen);
    };

    if (toScan.length === 0) {
      finish();
      return;
    }

    let i = 0;
    let active = 0;
    const pump = () => {
      while (active < SEARCH_READ_CONCURRENCY && i < toScan.length) {
        const f = toScan[i++];
        active++;
        void vault
          .cachedRead(f)
          .then((raw) => {
            if (gen !== this._searchGen) return;
            const plain = plainTextForSearch(raw);
            const hit = snippetSegmentsAroundMatch(plain, qTrim);
            if (hit?.found) {
              tierB.push({
                file: f,
                score: f.stat.mtime,
                titleSegments: [{ kind: "plain", text: f.basename }],
                snippetSegments: hit.segments,
              });
            }
          })
          .catch(() => {})
          .finally(() => {
            active--;
            if (gen !== this._searchGen) return;
            if (i < toScan.length) {
              pump();
            } else if (active === 0) {
              finish();
            }
          });
      }
      if (i >= toScan.length && active === 0 && gen === this._searchGen) {
        finish();
      }
    };
    pump();
  }

  /** @param {TFile[]} files */
  renderNormalListFromFiles(files) {
    if (!this.scrollEl) return;
    this._excerptQueue.length = 0;
    this.scrollEl.empty();
    for (const file of files) {
      this.createRowEl(file);
    }
    this.updateActiveRow();
  }

  /**
   * @param {{ file: TFile; titleSegments: HighlightSegment[]; snippetSegments: HighlightSegment[] | null }[]} entries
   * @param {number} gen
   */
  renderSearchRows(entries, gen) {
    if (!this.scrollEl || gen !== this._searchGen) return;
    this._excerptQueue.length = 0;
    this.scrollEl.empty();
    for (const ent of entries) {
      this.createSearchRowEl(ent.file, ent.titleSegments, ent.snippetSegments);
    }
    this.updateActiveRow();
  }

  /**
   * @param {TFile} file
   * @param {HighlightSegment[]} titleSegments
   * @param {HighlightSegment[] | null} snippetSegments preset snippet or null to load excerpt
   */
  createSearchRowEl(file, titleSegments, snippetSegments) {
    if (!this.scrollEl) throw new Error("scrollEl not ready");

    const wrap = this.scrollEl.createDiv({
      cls: "pt-item",
      attr: { "data-path": file.path },
    });

    const card = wrap.createDiv({ cls: "pt-card" });
    const row = card.createDiv({ cls: "pt-row" });
    const info = row.createDiv({ cls: "pt-info" });
    const snippet = info.createDiv({ cls: "pt-snippet" });
    const titleSlot = snippet.createSpan({
      cls: "pt-title-wrap pt-title-wrap--max-3",
    });
    const titleSpan = titleSlot.createSpan({ cls: "pt-title" });
    applyHighlightSegmentsTo(titleSpan, titleSegments);
    const subtitle = snippet.createSpan({ cls: "pt-excerpt" });

    const meta = row.createDiv({ cls: "pt-meta" });
    meta.createDiv({
      cls: "pt-date",
      text: formatListCardDate(file.stat.mtime),
    });

    const bottom = card.createDiv({ cls: "pt-footer" });
    bottom.createDiv({ cls: "pt-footer-sep" });

    if (snippetSegments !== null) {
      applyHighlightSegmentsTo(subtitle, snippetSegments);
      subtitle.classList.toggle("pt-excerpt--empty", false);
      subtitle.classList.add("pt-excerpt--budget-2");
      schedulePapertrailSnippetBudget(snippet);
    } else {
      subtitle.classList.add("pt-excerpt--empty");
      subtitle.dataset.ptHighlightSearch = "1";
      const req = String(++this._previewSerial);
      subtitle.dataset.ptReq = req;
      subtitle.dataset.ptPath = file.path;
      const cached = this._excerptCache.get(file.path);
      if (cached !== undefined) {
        this.applySearchHighlightToExcerpt(
          subtitle,
          cached,
          this._searchQuery.trim()
        );
      } else {
        this.enqueueExcerptLoad(file, subtitle, req);
      }
    }
    return wrap;
  }

  /**
   * @param {HTMLElement} el
   * @param {string} text
   * @param {string} qTrim
   */
  applySearchHighlightToExcerpt(el, text, qTrim) {
    const t = text || "";
    if (!qTrim) {
      el.setText(t);
      el.classList.toggle("pt-excerpt--empty", !t);
      if (t) {
        el.classList.add("pt-excerpt--budget-2");
      }
      schedulePapertrailSnippetBudget(el.closest(".pt-snippet"));
      return;
    }
    const low = t.toLowerCase();
    const qi = low.indexOf(qTrim.toLowerCase());
    if (qi < 0) {
      el.setText(t);
    } else {
      applyHighlightSegmentsTo(el, highlightSubstringICSegments(t, qTrim));
    }
    el.classList.toggle("pt-excerpt--empty", !t);
    if (t) {
      el.classList.add("pt-excerpt--budget-2");
    }
    schedulePapertrailSnippetBudget(el.closest(".pt-snippet"));
  }

  /**
   * @param {TFile} file
   * @returns {HTMLDivElement}
   */
  createRowEl(file) {
    if (!this.scrollEl) throw new Error("scrollEl not ready");

    const wrap = this.scrollEl.createDiv({
      cls: "pt-item",
      attr: { "data-path": file.path },
    });

    const card = wrap.createDiv({ cls: "pt-card" });
    const row = card.createDiv({ cls: "pt-row" });
    const info = row.createDiv({ cls: "pt-info" });
    const snippet = info.createDiv({ cls: "pt-snippet" });
    const titleSlot = snippet.createSpan({
      cls: "pt-title-wrap pt-title-wrap--max-3",
    });
    titleSlot.createSpan({ cls: "pt-title", text: file.basename });
    const subtitle = snippet.createSpan({
      cls: "pt-excerpt pt-excerpt--empty",
    });

    const meta = row.createDiv({ cls: "pt-meta" });
    meta.createDiv({
      cls: "pt-date",
      text: formatListCardDate(file.stat.mtime),
    });

    const bottom = card.createDiv({ cls: "pt-footer" });
    bottom.createDiv({ cls: "pt-footer-sep" });

    const req = String(++this._previewSerial);
    subtitle.dataset.ptReq = req;
    subtitle.dataset.ptPath = file.path;

    const cached = this._excerptCache.get(file.path);
    if (cached !== undefined) {
      subtitle.setText(cached || "");
      subtitle.classList.toggle("pt-excerpt--empty", !cached);
      if (cached) {
        subtitle.classList.add("pt-excerpt--budget-2");
      }
    }

    this.enqueueExcerptLoad(file, subtitle, req);
    schedulePapertrailSnippetBudget(snippet);
    return wrap;
  }

  /** @param {TFile} file @param {HTMLElement} subtitleEl @param {string} req */
  enqueueExcerptLoad(file, subtitleEl, req) {
    this._excerptQueue.push({ file, subtitleEl, req });
    this._pumpExcerptQueue();
  }

  _pumpExcerptQueue() {
    while (
      this._excerptInflight < EXCERPT_LOAD_CONCURRENCY &&
      this._excerptQueue.length > 0
    ) {
      const job = this._excerptQueue.shift();
      if (!job) break;
      this._excerptInflight++;
      void this.loadExcerptInto(job.file, job.subtitleEl, job.req).finally(
        () => {
          this._excerptInflight--;
          this._pumpExcerptQueue();
        }
      );
    }
  }

  /**
   * @param {TFile} file
   * @param {HTMLElement} subtitleEl
   * @param {string} req
   */
  async loadExcerptInto(file, subtitleEl, req) {
    const path = file.path;
    let text = this._excerptCache.get(path);
    if (text === undefined) {
      try {
        const raw = await this.plugin.app.vault.cachedRead(file);
        text = excerptFromMarkdown(raw);
        this._excerptCache.set(path, text);
      } catch {
        text = "";
        this._excerptCache.set(path, text);
      }
    }
    if (
      !subtitleEl.isConnected ||
      subtitleEl.dataset.ptReq !== req ||
      subtitleEl.dataset.ptPath !== path
    ) {
      return;
    }
    const q = this._searchQuery.trim();
    const useHl = subtitleEl.dataset.ptHighlightSearch === "1" && q;
    if (useHl) {
      this.applySearchHighlightToExcerpt(subtitleEl, text || "", q);
    } else {
      subtitleEl.setText(text || "");
      subtitleEl.classList.toggle("pt-excerpt--empty", !text);
      if (text) {
        subtitleEl.classList.add("pt-excerpt--budget-2");
      }
      schedulePapertrailSnippetBudget(subtitleEl.closest(".pt-snippet"));
    }
  }

  refreshList() {
    if (!this.scrollEl) return;
    if (this._searchMode) {
      this.scheduleSearchPipeline();
      return;
    }
    this._excerptQueue.length = 0;
    this.scrollEl.empty();
    const files = this.plugin.collectMarkdownFiles();
    for (const file of files) {
      this.createRowEl(file);
    }
    this.updateActiveRow();
  }

  onOpen() {
    // Layout (flex chain, height, overflow) is owned by styles.css —
    // .workspace-leaf-content[data-type="papertrail"], .view-content, .pt-root,
    // .pt-scroll, and .pt-chrome-footer all set the right rules there.
    this.contentEl.empty();
    this.contentEl.addClass("pt-root");
    this.registerDomEvent(this.contentEl, "click", (e) => this.onRootClick(e));
    this.registerDomEvent(this.contentEl, "contextmenu", (e) =>
      this.onRootContextMenu(e)
    );
    this.scrollEl = this.contentEl.createDiv({ cls: "pt-scroll" });
    this.buildChromeFooter();
    this.registerViewEvents();
    this.registerInterval(
      window.setInterval(() => this.tickRelativeDates(), 60_000)
    );
    this.refreshList();
    this.queueScrollActiveIntoView();
    if (this.plugin.app.workspace.getActiveLeaf() === this.leaf) {
      this.triggerChromeTitleTabTransition();
    }
    return Promise.resolve();
  }

  onClose() {
    if (this._debounceTimer != null) {
      window.clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._searchBodyTimer != null) {
      window.clearTimeout(this._searchBodyTimer);
      this._searchBodyTimer = null;
    }
    this._excerptQueue.length = 0;
    this._excerptInflight = 0;
    this._excerptCache.clear();
    this.scrollEl = null;
    this._chromeFooter = null;
    this._chromeDefaultRow = null;
    this._chromeSearchRow = null;
    this._chromeTitleEl = null;
    this._searchInput = null;
    return Promise.resolve();
  }
}

export default class PapertrailPlugin extends Plugin {
  constructor(app, manifestObj) {
    super(app, manifestObj);
    /** @type {typeof DEFAULT_SETTINGS} */
    this.settings = { ...DEFAULT_SETTINGS };
  }

  async loadSettings() {
    const raw = await this.loadData();
    const loaded =
      raw && typeof raw === "object" ? { ...raw } : {};
    if (
      typeof loaded.hideDotPaths === "boolean" &&
      loaded.hideExcludedPaths === undefined
    ) {
      loaded.hideExcludedPaths = loaded.hideDotPaths;
    }
    delete loaded.hideDotPaths;
    delete loaded.filterTag;
    delete loaded.filterFolder;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof PapertrailView) v.refreshList();
    }
  }

  /** @param {number} delta */
  navigatePapertrailList(delta) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (let i = 0; i < leaves.length; i++) {
      const v = leaves[i].view;
      if (v instanceof PapertrailView) {
        v.navigateListByArrow(delta);
        return;
      }
    }
  }

  /**
   * @param {string} normPath
   * @param {boolean} hideExcludedPaths
   * @param {string[]} [userIgnoreFilters] from one getConfig() call; omit to fetch (legacy path only)
   */
  shouldExcludePath(normPath, hideExcludedPaths, userIgnoreFilters) {
    const configDir = this.app.vault.configDir;
    if (configDir && normPath.startsWith(configDir + "/")) return true;
    if (hideExcludedPaths && pathHasDotSegment(normPath)) return true;
    try {
      const mc = this.app.metadataCache;
      if (mc && typeof mc.isUserIgnored === "function") {
        return mc.isUserIgnored(normPath) === true;
      }
    } catch {
      /* fall through */
    }
    let filters = userIgnoreFilters;
    if (!filters) {
      filters = [];
      try {
        const cfg =
          typeof this.app.vault.getConfig === "function"
            ? this.app.vault.getConfig()
            : null;
        if (cfg && Array.isArray(cfg.userIgnoreFilters)) {
          filters = cfg.userIgnoreFilters;
        }
      } catch {
        filters = [];
      }
    }
    for (const f of filters) {
      if (pathMatchesUserIgnoreFilter(normPath, f)) return true;
    }
    return false;
  }

  sortFiles(/** @type {TFile[]} */ files) {
    const o = this.settings.sortOrder;
    if (o === "mtime-asc") {
      files.sort((a, b) => a.stat.mtime - b.stat.mtime);
    } else if (o === "title-asc") {
      files.sort((a, b) => a.basename.localeCompare(b.basename));
    } else if (o === "path-asc") {
      files.sort((a, b) => a.path.localeCompare(b.path));
    } else {
      files.sort((a, b) => b.stat.mtime - a.stat.mtime);
    }
  }

  /** @returns {TFile[]} */
  collectMarkdownFiles() {
    const hideExcluded = this.settings.hideExcludedPaths;
    const all = this.app.vault.getMarkdownFiles();
    /** @type {string[]} */
    let cachedFilters = undefined;
    try {
      const mc = this.app.metadataCache;
      if (!mc || typeof mc.isUserIgnored !== "function") {
        const cfg =
          typeof this.app.vault.getConfig === "function"
            ? this.app.vault.getConfig()
            : null;
        cachedFilters = Array.isArray(cfg?.userIgnoreFilters)
          ? cfg.userIgnoreFilters
          : [];
      }
    } catch {
      cachedFilters = [];
    }

    /** @type {TFile[]} */
    const out = [];
    for (const f of all) {
      const p = normalizePath(f.path);
      if (this.shouldExcludePath(p, hideExcluded, cachedFilters)) continue;
      out.push(f);
    }
    this.sortFiles(out);
    return out;
  }

  /**
   * First WorkspaceTabs under the left dock (depth-first ≈ top tab strip).
   * @param {import("obsidian").Workspace} workspace
   * @returns {import("obsidian").WorkspaceSplit | null}
   */
  findFirstLeftDockTabs(workspace) {
    const left = workspace.leftSplit;
    if (!left || !("children" in left) || !left.children?.length) return null;
    /** @param {import("obsidian").WorkspaceItem} item */
    const dfs = (item) => {
      if (!item) return null;
      if (item.type === "tabs") {
        return /** @type {import("obsidian").WorkspaceSplit} */ (item);
      }
      const ch = "children" in item ? item.children : null;
      if (!Array.isArray(ch)) return null;
      for (const c of ch) {
        const r = dfs(c);
        if (r) return r;
      }
      return null;
    };
    for (const c of left.children) {
      const r = dfs(c);
      if (r) return r;
    }
    return null;
  }

  /**
   * New leaf inserted as tab index 0 in the top left sidebar tab group when possible.
   * @returns {import("obsidian").WorkspaceLeaf | null}
   */
  createPapertrailLeafFirstInLeftDock() {
    const { workspace } = this.app;
    if (typeof workspace.createLeafInParent !== "function") return null;
    try {
      let tabsParent = this.findFirstLeftDockTabs(workspace);
      if (!tabsParent) {
        const fe = workspace.getLeavesOfType("file-explorer")[0];
        const p = fe?.parent;
        if (p && p.type === "tabs") {
          tabsParent = /** @type {import("obsidian").WorkspaceSplit} */ (p);
        }
      }
      if (!tabsParent) return null;
      return workspace.createLeafInParent(tabsParent, 0);
    } catch {
      return null;
    }
  }

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      const leaf = existing[0];
      await workspace.revealLeaf(leaf);
      workspace.setActiveLeaf(leaf, { focus: true });
      return;
    }
    let leaf = this.createPapertrailLeafFirstInLeftDock();
    if (!leaf) {
      leaf = workspace.getLeftLeaf(true);
      if (!leaf) leaf = workspace.getLeftLeaf(false);
      if (!leaf) leaf = workspace.getLeaf("tab");
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new PapertrailSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new PapertrailView(leaf, this));
    this.addCommand({
      id: "open-list",
      name: "Open list",
      icon: PLUGIN_ICON,
      callback: () => {
        void this.activateView();
      },
    });
    this.addCommand({
      id: "open-next-note",
      name: "Open next note in list",
      callback: () => {
        this.navigatePapertrailList(1);
      },
    });
    this.addCommand({
      id: "open-previous-note",
      name: "Open previous note in list",
      callback: () => {
        this.navigatePapertrailList(-1);
      },
    });
    this.addRibbonIcon(PLUGIN_ICON, "Papertrail", () => {
      void this.activateView();
    });
  }
}
