import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { hc, run, layout, theme, notify, props, focused, shared, setShared, openOverlay, closeOverlay } from "herdr";
import * as fs from "fs/promises";
import { icons, glyph, icon, spinner } from "./icons.js";
import { DEFAULTS, settings, reload, trello, data, expand, short, localDay, inside } from "./api.js";
import { tabIndex, state, links, picked, pickRepo, migrate } from "./start.js";
import { Viewer, copyMenu, openUrl } from "./viewer.js";

const SHOWN = 100;                    // rows drawn at most; the filter narrows the rest
const SYNC = 60000;                   // how often the boards are checked while the panel shows
const SCAN = 3000;                    // how often the focused terminal is read for card links
const RESYNC = 6 * 3600 * 1000;       // a full fetch now and then catches what board activity misses
const CACHE = 4;                      // a board file of another version is fetched again
const MENTIONS = 6;

const boardsDir = () => `${data()}/boards`;
const boardFile = (id) => `${boardsDir()}/${id}.json`;
const metaFile = () => `${data()}/meta.json`;
const STOP = new Set(["nl", "com", "the", "de", "het", "van", "den", "der", "en", "and", "bv"]);
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const CARD_LINK = /trello\.com\/c\/([A-Za-z0-9]{8})/g;
const shortLink = (url) => /\/c\/([A-Za-z0-9]{8})/.exec(url ?? "")?.[1];

// The tabs: what's open now (yours and nobody's), everything of yours, everything.
const VIEWS = {
  current: { has: (c) => c.current && (c.mine || c.nobody), empty: "Nothing in this list" },
  mine: { label: "Mine", has: (c) => c.mine, empty: "No cards of yours on the client boards" },
  all: { label: "All", has: () => true, empty: "No cards on the client boards" },
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Whether the Trello panel is the side panel showing. A copy outside the side panel (a pane) always counts.
function panelShown(root = layout()) {
  const body = find(root, "panel-body");
  if (!body?.children?.some((c) => c.content?.mod === "trello")) return true;
  return !find(root, "panel")?.hidden && find(body, body.active)?.content?.mod === "trello";
}


// The panel; its Trello button beside the tab bar (props { button: true }); or, as overlays of
// this mod, one card (props { card, repo }) and the copy menu (props { copyMenu }).
export default class Trello extends View {
  init(_props, cx) {
    const p = props() ?? {};
    migrate();
    cx.spawn(async (cx) => { await icons(); cx.notify(); });
    if (p.card) { this.viewer = new Viewer(p, p.overlay, cx); return; }
    if (p.copyMenu) { this.copying = { ...p.copyMenu, overlay: p.overlay }; return; }
    if (p.button) {
      // The tab bar restores each space's side panel only if it's listed here.
      const panels = shared("workspace.panels") ?? ["files", "changes"];
      if (!panels.includes("trello")) setShared("workspace.panels", [...panels, "trello"]);
      this.button = true;
      return;
    }
    this.boards = {}; this.cards = []; this.counts = {}; this.repos = {}; this.mentioned = [];
    this.view = "current"; this.query = ""; this.changedAt = state().changed?.at;
    this.input = InputState.new({ placeholder: "Filter cards" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(SYNC, (cx) => { if (panelShown()) this.refresh(cx); });
    cx.timer.every(SCAN, (cx) => { if (panelShown()) this.scan(cx); });
  }

  // The cache: one file per board, as the last fetch left it, so the list shows at once after a start.
  async load() {
    this.config = await settings();
    this.meta = await fs.readFile(metaFile(), "utf8").then(JSON.parse).catch(() => null) ?? { full: 0 };
    await fs.mkdir(boardsDir(), { recursive: true });
    for (const f of (await fs.readdir(boardsDir())).filter((f) => f.endsWith(".json"))) {
      const board = await fs.readFile(`${boardsDir()}/${f}`, "utf8").then(JSON.parse).catch(() => null);
      if (board?.version === CACHE) this.boards[board.id] = board;
      else await fs.unlink(`${boardsDir()}/${f}`).catch(() => null);  // another version's cache: fetched again
    }
    this.rebuild();
  }

  // Everything derived from the boards, worked out once per change instead of on every render:
  // newest activity first, so a filtered list keeps that order without sorting again. Which lists
  // are current or done comes from the settings now, not from when the board was fetched.
  rebuild() {
    const { isCurrent, isDone } = this.config;
    this.cards = Object.values(this.boards).flatMap((b) => b.cards).sort((a, b) => b.active - a.active);
    for (const c of this.cards) { c.current = isCurrent(c.list); c.done = isDone(c.list); }
    this.byLink = new Map(this.cards.map((c) => [shortLink(c.url), c]));
    for (const v of Object.keys(VIEWS)) this.counts[v] = this.cards.filter(VIEWS[v].has).length;
    this.memo = null;
  }

  // One board's cards in the shape the panel draws.
  normalize(board, raw) {
    const me = this.meta.me.id;
    return raw.flatMap((c) => {
      const at = board.lists.findIndex((l) => l.id === c.idList);
      if (at < 0) return [];
      const list = board.lists[at].name, labels = (c.labels ?? []).map((l) => l.name).filter(Boolean);
      const due = c.due ? localDay(c.due) : null;
      return [{
        id: c.id, number: c.idShort, title: c.name, url: c.shortUrl, board: board.name, boardId: board.id, boardUrl: board.shortUrl,
        list, order: at * 1e9 + (c.pos ?? 0),
        mine: (c.idMembers ?? []).includes(me), nobody: !(c.idMembers ?? []).length,
        due: c.due && !c.dueComplete ? c.due : null, active: Date.parse(c.dateLastActivity ?? 0) || 0,
        meta: [list, due && `due ${due}`, ...labels].filter(Boolean).join(" · "),
        hay: `#${c.idShort} ${c.name} ${board.name} ${list} ${labels.join(" ")}`.toLowerCase(),
      }];
    });
  }

  // As the Issues panel does it: one cheap call for the boards, then only the boards with new
  // activity since the last fetch get their cards fetched again; every few hours all of them.
  // One board at a time, because Herdr cuts off a script that works too long in one go.
  // `stale`: a board the card dialog just changed, fetched whatever its activity says.
  refresh(cx, stale = null) {
    if (this.syncing) { if (stale) this.stale = stale; return; }
    this.syncing = true;
    const before = this.error;
    let changed = false;
    cx.spawn(async (cx) => {
      try {
        if (!this.meta) { await this.load(); this.resolve(cx); cx.notify(); }
        this.config = await settings();
        if (!this.meta.me) { const m = await trello("members/me", { params: { fields: "username" } }); this.meta.me = { id: m.id, username: m.username }; }
        const boards = await trello("members/me/boards", { params: { filter: "open", fields: "name,shortUrl,dateLastActivity", lists: "open" } });
        const client = boards.filter((b) => (b.lists ?? []).some((l) => this.config.isCurrent(l.name)));
        const full = Date.now() - this.meta.full > RESYNC;
        // Boards that closed or lost their current list go.
        const keep = new Set(client.map((b) => b.id));
        for (const id of Object.keys(this.boards).filter((id) => !keep.has(id))) {
          delete this.boards[id]; changed = true;
          await fs.unlink(boardFile(id)).catch(() => null);
        }
        for (const b of client) {
          const lists = b.lists.map((l) => l.name).join("\n"), have = this.boards[b.id];
          if (!full && b.id !== stale && have && have.activity === b.dateLastActivity && have.lists === lists) continue;
          const raw = await trello(`boards/${b.id}/cards`, { params: { filter: "open", fields: "name,idShort,idList,idMembers,due,dueComplete,shortUrl,dateLastActivity,pos,labels" } });
          const board = { version: CACHE, id: b.id, name: b.name, activity: b.dateLastActivity, lists, cards: this.normalize(b, raw) };
          this.boards[b.id] = board; changed = true;
          await fs.writeFile(boardFile(b.id), JSON.stringify(board));
        }
        if (full) this.meta.full = Date.now();
        if (full || changed) await fs.writeFile(metaFile(), JSON.stringify(this.meta));
        this.error = null;
      } catch (e) { this.error = String(e?.message ?? e); }
      finally {
        // Also after a failed sync: what did change (a board gone, one fetched) shows. Every redraw of
        // a mod redraws the whole window, so only when there's something new to show, or when the
        // last drawing showed "Syncing".
        if (changed) this.rebuild();
        this.syncing = false; this.resolve(cx);
        if (changed || this.error !== before || this.drewSyncing) cx.notify();
        // A change that came in during this sync gets one of its own.
        if (this.stale) { const s = this.stale; this.stale = null; this.refresh(cx, s); }
      }
    });
  }

  // Refresh: settings, token and folders read again, and every board fetched again.
  refreshAll(cx) {
    reload(); this.repos = {}; this.folders = null;
    if (this.meta) { this.meta.full = 0; this.meta.me = null; }
    this.refresh(cx); cx.notify();
  }

  // Which folder each board's cards are worked on in, shown on its header so a wrong guess shows before a click.
  resolve(cx) {
    cx.spawn(async (cx) => {
      this.config = await settings();
      const boards = [...new Set(this.cards.map((c) => c.board))].filter((b) => !(b in this.repos));
      if (!boards.length) return;
      for (const b of boards) this.repos[b] = undefined;  // claimed, so a second resolve() skips them
      for (const b of boards) this.repos[b] = await this.repoFor(b).catch(() => null);
      cx.notify();
    });
  }

  // The folder picked for this board, else the folder under `folders` whose name holds most of the
  // board's words, the shortest among equals. Whole words only, and at least half of them: "seo" is
  // not "houseofhaver", one shared "studio" doesn't make "Forever Young Studio" studio-mos. A folder
  // that is the board's name run together ("Play.food" → playfood) counts in full.
  async repoFor(board) {
    const { repos, folders } = this.config;
    if (repos[board]) return (await fs.exists(expand(repos[board]))) ? expand(repos[board]) : null;
    if (!this.folders) {
      this.folders = [];
      for (const dir of folders.map(expand)) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith("-worktrees")) this.folders.push({ name: e.name, path: `${dir}/${e.name}` });
      }
    }
    const ws = words(board), whole = norm(board);
    const best = this.folders.map((f) => {
      const own = new Set(words(f.name)), name = norm(f.name);
      const score = name === whole || (whole.length >= 5 && name.startsWith(whole)) ? ws.length : ws.filter((w) => own.has(w)).length;
      return { ...f, score };
    }).filter((f) => f.score > 0 && f.score * 2 >= ws.length).sort((a, b) => b.score - a.score || a.name.length - b.name.length)[0];
    return best?.path ?? null;
  }

  // The focused terminal's screen and recent history, for links to cards (an agent's "commented on
  // https://trello.com/c/…"): newest line first. A focused mod pane has no terminal: the last one stays.
  scan(cx) {
    const terminal = (this.terminal = focused()?.terminal ?? this.terminal);
    if (this.scanning || !terminal || !this.byLink) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", terminal, "--lines", "300"]);
        if (r.code !== 0) return;
        const found = [];
        for (const line of r.stdout.split("\n").reverse())
          for (const m of line.matchAll(CARD_LINK)) { const c = this.byLink.get(m[1]); if (c && !found.includes(c)) found.push(c); }
        const now = found.slice(0, MENTIONS);
        if (now.map((c) => c.id).join() !== this.mentioned.map((c) => c.id).join()) { this.mentioned = now; cx.notify(); }
      } catch { /* the terminal closed: try again next time */ }
      finally { this.scanning = false; }
    });
  }

  // A card in the large view: a dialog of this mod, so it draws and writes on its own.
  open(card) {
    openOverlay({ mod: "trello", kind: "dialog", width: 0.86, height: 0.9, props: { card, repo: this.repoOf(card.board) ?? null } });
  }

  // A folder picked in the panel or dialog, else the one from the settings or the guess.
  repoOf(board, chosen = picked()) {
    return chosen[board] ?? this.repos[board];
  }

  toolbar(t) {
    const root = layout(), on = panelShown(root) && !find(root, "panel")?.hidden;
    return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("panel-trello").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: "trello" }); run("layout.show", { id: "panel" }); }
        })
        .child(glyph("trello", 14)).child("Trello"));
  }

  copyMenu(t) {
    const { url, ref, title, overlay } = this.copying;
    const items = [["Copy link", url], ["Copy number and title", ref], ["Copy title", title]].filter(([, text]) => text);
    return v_flex().id("trello-copy").size_full().p(6).gap(1).bg(t.popover).text_color(t.foreground).text_size(12)
      .children(items.map(([label, text], n) => v_flex().id(`copy-${n}`).px(8).py(6).rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
        .on_click((_e, cx) => { cx.write_to_clipboard(text); notify({ title: "Copied", body: text, level: "success", timeout: 2500 }); closeOverlay(overlay); })
        .child(div().font_semibold().child(label))
        .child(div().text_size(11).text_color(t.muted).truncate().child(text))));
  }

  // The filtered list (newest first) and its groups per board, kept until the cards, tab or filter change.
  // Groups follow the list's order, so the board with the newest card comes first.
  shown() {
    const q = this.query.trim().toLowerCase(), key = `${this.view}|${q}`;
    if (this.memo?.key !== key) {
      const has = VIEWS[this.view].has, found = this.cards.filter((c) => has(c) && (!q || c.hay.includes(q)));
      const by = new Map();
      for (const c of found.slice(0, SHOWN)) {
        if (!by.has(c.board)) by.set(c.board, { board: c.board, url: c.boardUrl, cards: [] });
        by.get(c.board).cards.push(c);
      }
      for (const g of by.values()) g.cards.sort((a, b) => a.order - b.order);
      this.memo = { key, found: found.length, groups: [...by.values()] };
    }
    return this.memo;
  }

  // The board whose folder holds the focused terminal: its group comes first. A focused mod pane keeps the last one.
  here(chosen) {
    const cwd = focused()?.cwd;
    if (!cwd) return this.hereBoard ?? null;
    const match = Object.keys({ ...this.repos, ...chosen }).find((b) => { const repo = this.repoOf(b, chosen); return repo && inside(cwd, repo); });
    return (this.hereBoard = match ?? null);
  }

  // The row takes the panel's 13px foreground text; only what differs sets its own. The ↗ box
  // centres its 12px icon by padding; without a status mark it sits in the row itself, 1px down
  // as it would be centred in the 18px trailing box.
  row(c, t, tabs, linked, where = "card") {
    const open = linked[c.id] ? tabs().get(linked[c.id]) : null, status = open?.tab.status;
    const mark = status === "working" ? spinner(t.working) : open ? div().size(7).rounded(4).bg(t[status] ?? t.idle) : null;
    const browse = div().id(`${where}-browse-${c.id}`).size(16).p(2).text_color(t.dim)
      .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(c.url); })
      .children(icon("external", 12));
    return h_flex().id(`${where}-${c.id}`).flex_none().px(10).py(6).gap(8).items_start().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => this.open(c))
      .on_mouse_down("right", () => copyMenu({ url: c.url, number: c.number, title: c.title }, "pointer"))
      .child(div().flex_none().w(34).text_color(t.dim).child(`#${c.number}`))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(c.done ? div().text_color(t.muted).child(c.title) : c.title)
        .child(div().text_size(11).text_color(c.due && Date.parse(c.due) < Date.now() ? t.ansi1 : t.dim).truncate().child(where === "card" ? c.meta : `${c.board} · ${c.meta}`)))
      .child(mark ? h_flex().flex_none().h(18).gap(6).child(mark).child(browse) : browse.flex_none().mt(1));
  }

  heading(label, t) {
    return div().flex_none().px(10).pt(10).pb(4).text_size(11).font_semibold().text_color(t.dim).child(label);
  }

  // The board name opens the board; the folder (or "no folder") picks another folder for it.
  board(g, t, here, chosen) {
    const repo = this.repoOf(g.board, chosen);
    return h_flex().flex_none().px(10).pt(10).pb(4).gap(8).text_size(11)
      .when(here, (e) => e.child(div().size(6).flex_none().rounded(3).bg(t.accent)))
      .child(div().id(`board-${g.board}`).flex_none().cursor_pointer().font_semibold().text_color(here ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground)).on_click(() => openUrl(g.url)).child(g.board))
      .child(div().id(`folder-${g.board}`).flex_1().min_w(0).cursor_pointer().text_right().truncate()
        .text_color(repo === null ? t.ansi3 : t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => cx.spawn(async () => { await pickRepo(g.board); }))
        .child(repo === undefined ? "" : repo === null ? "no folder" : short(repo)));
  }

  segment(id, label, on, t, onClick) {
    return div().id(id).h(24).px(9).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).when(on, (e) => e.font_semibold())
      .hover((s) => s.bg(on ? t.selected : t.hover)).on_click(onClick).child(label);
  }


  render(cx) {
    if (this.viewer) return this.viewer.render(cx);
    if (this.copying) return this.copyMenu(theme());
    if (this.button) return this.toolbar(theme());
    // Hidden behind Files or Changes: draw nothing (and ask Herdr nothing more), and sync the moment it shows again.
    const shownNow = panelShown();
    if (!this.wasShown && shownNow) { this.refresh(cx); this.scan(cx); }
    this.wasShown = shownNow;
    if (!shownNow) return div();
    const t = theme();
    // The card dialog wrote to a card: fetch that board again. The shared state is read once per redraw.
    const s = state(), changed = s.changed;
    if (changed?.at && changed.at !== this.changedAt) {
      this.changedAt = changed.at;
      this.refresh(cx, changed.board);
    }
    this.drewSyncing = this.syncing;

    const { found, groups } = this.shown(), drawn = groups.reduce((n, g) => n + g.cards.length, 0);
    // The spaces are asked for only when a drawn card has a tab.
    const linked = links(s), chosen = picked(s), here = this.here(chosen);
    let index = null;
    const tabs = () => (index ??= tabIndex());
    const ordered = here ? [...groups.filter((g) => g.board === here), ...groups.filter((g) => g.board !== here)] : groups;
    const loading = this.syncing && !this.cards.length;
    const empty = this.error || (loading ? "Loading cards…" : this.query.trim() ? "No cards match" : VIEWS[this.view].empty);
    const label = (v) => VIEWS[v].label ?? this.config?.currentName ?? DEFAULTS.current[0];
    return v_flex().id("trello").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(glyph("trello", 14, t.ansi4))
        .child(div().font_semibold().child("Trello"))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).text_right().truncate().child(this.meta?.me ? `@${this.meta.me.username} · client boards` : ""))
        .child(h_flex().id("trello-refresh").h(26).px(8).gap(5).flex_none().items_center().rounded(7).border_1().border_color(t.border).text_size(12).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.refreshAll(cx))
          .child(this.syncing ? spinner(t.working) : glyph("refresh", 12))
          .child(this.syncing ? "Syncing" : "Refresh")))
      .child(v_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
        .child(div().id("trello-filter").h(28).px(9).flex().items_center().rounded(7).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(h_flex().gap(6).items_center()
          .child(h_flex().flex_none().p(2).gap(2).rounded(8).border_1().border_color(t.border)
            .children(Object.keys(VIEWS).map((v) => this.segment(`view-${v}`, loading ? label(v) : `${label(v)} (${this.counts[v] ?? 0})`, this.view === v, t, (_e, cx) => { this.view = v; cx.notify(); }))))))
      .child(v_flex().id("trello-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(Boolean(this.error) && drawn > 0, (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.ansi1).child(this.error)))
        .when(this.mentioned.length > 0, (e) => e.child(this.heading("In this terminal", t))
          .children(this.mentioned.map((c) => this.row(c, t, tabs, linked, "mentioned"))))
        .children(ordered.flatMap((g) => [this.board(g, t, g.board === here, chosen), ...g.cards.map((c) => this.row(c, t, tabs, linked))]))
        .when(found > drawn, (e) => e.child(div().px(10).py(10).text_size(11).text_color(t.dim).child(`${found - drawn} older cards not shown: type in the filter to find them`)))
        .when(!drawn, (e) => e.child(div().px(16).py(28).text_size(12).text_center().text_color(this.error ? t.ansi1 : t.dim).child(empty))))
      .child(div().flex_none().px(12).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child("Click: open the card · right-click: copy"));
  }
}
