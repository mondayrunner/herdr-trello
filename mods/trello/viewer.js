import * as fs from "fs/promises";
import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, theme, closeOverlay, openOverlay } from "herdr";
import { trello, short, data } from "./api.js";
import { glyph, spinner } from "./icons.js";
import { blocks, picture, failed, loadPicture } from "./pictures.js";
import { start, tabOf, goTo, pickRepo, nudge } from "./start.js";

const FIELDS = [
  "fields=name,desc,due,dueComplete,labels,shortUrl,idShort,idList,idBoard,dateLastActivity",
  "members=true&member_fields=fullName,username,initials,avatarUrl",
  "checklists=all&checklist_fields=name,pos&checkItems=all&checkItem_fields=name,state,pos",
  "attachments=true&attachment_fields=name,url,fileName,isUpload,bytes,mimeType",
  "actions=commentCard,updateCard:idList,createCard,addAttachmentToCard&actions_limit=100",
  "action_memberCreator_fields=fullName,username,initials,avatarUrl",
  "list=true&list_fields=name&board=true&board_fields=name,shortUrl",
].join("&");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Trello's label colors, the same in every theme so they read as Trello's.
const LABELS = { green: "#4bce97", yellow: "#e2b203", orange: "#fea362", red: "#f87168", purple: "#9f8fef", blue: "#579dff", sky: "#6cc3e0", lime: "#94c748", pink: "#e774bb", black: "#8590a2" };
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const cardFile = (id) => `${data()}/cards/${id}.json`;

// "3h ago" this month, "on Sep 21" before that.
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  const d = new Date(iso), year = d.getFullYear() === new Date().getFullYear() ? "" : `, ${d.getFullYear()}`;
  return `on ${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

const day = (iso) => { const d = new Date(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const size = (n) => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`;
// Only web links go to macOS `open`. Card text is written by whoever uses the board, and `open`
// also takes file://, smb:// and app URL schemes: one click on such a link could start a file
// the card itself delivered (uploads land unquarantined). Herdr's own link filter does the same,
// but only when a mod doesn't handle clicks itself.
export const openUrl = (url) => /^https?:\/\/[^\s/]/i.test(url ?? "") ? exec("open", [url]).catch(() => null) : null;
// A file this mod wrote itself (a downloaded picture).
const openFile = (path) => exec("open", [path]).catch(() => null);

// Copy link, reference or title: a popup of the panel's mod.
export function copyMenu({ url, number, title }, at) {
  openOverlay({ mod: "trello", kind: "popup", width: 300, height: 170, ...(at ? { at } : {}),
    props: { copyMenu: { url, ref: `#${number} ${title}`, title } } });
}

function labelChip(l, t) {
  const c = LABELS[(l.color ?? "").replace(/_(light|dark)$/, "")] ?? t.muted;
  return div().h(22).px(8).flex_none().flex().items_center().rounded(11).border_1().border_color(`${c}66`).bg(`${c}2e`)
    .text_size(12).font_semibold().text_color(c).child(l.name || " ");
}

// The comments and moves on a card, oldest first.
function timeline(actions) {
  return actions.slice().reverse().flatMap((a) => {
    const who = a.memberCreator ?? {}, base = { who, at: a.date };
    if (a.type === "commentCard") return [{ ...base, kind: "comment", text: a.data?.text ?? "" }];
    if (a.type === "createCard") return [{ ...base, kind: "event", text: `added this card to ${a.data?.list?.name ?? "the board"}` }];
    if (a.type === "addAttachmentToCard") return [{ ...base, kind: "event", text: `attached ${a.data?.attachment?.name ?? "a file"}` }];
    if (a.type === "updateCard" && a.data?.listAfter) return [{ ...base, kind: "event", text: `moved this from ${a.data.listBefore?.name ?? "?"} to ${a.data.listAfter.name}` }];
    return [];
  });
}

// One card in a dialog: { card, repo } from the panel. The panel's copy of the card shows at
// once; the whole card loads behind it. Comments, ticked checklist items and moves go straight
// to Trello and tell the panel, so its list follows.
export class Viewer {
  constructor({ card, repo }, overlay, cx) {
    this.card = card; this.repo = repo ?? null; this.overlay = overlay; this.tab = "write";
    this.reply = TextareaState.new({ placeholder: "Write a comment (Markdown)" });
    this.reply.set_auto_grow(3, 12);
    this.reply.on("change", (_e, cx) => { const has = Boolean(this.reply.value().trim()); if (has !== this.replying) { this.replying = has; cx.notify(); } });
    this.reply.on("submit", (e, cx) => { if (e.secondary) this.comment(cx); });
    this.parts = new Map();
    this.open(cx);
  }

  // The card as it was the last time it was open, at once; from Trello only when it changed since
  // (the panel's sync knows when each card last changed) or when nothing is saved yet. As Herdr
  // Issues does it: what's cached shows, what's new loads behind it.
  open(cx) {
    this.loading = true;
    cx.spawn(async (cx) => {
      const saved = await fs.readFile(cardFile(this.card.id), "utf8").then(JSON.parse).catch(() => null);
      if (saved?.full) this.show(saved.full);
      if (saved?.full && saved.active && saved.active === this.card.active) { this.loading = false; cx.notify(); }
      else { cx.notify(); this.load(cx); }
    });
  }

  show(full) { this.full = full; this.items = timeline(full.actions ?? []); }

  // Kept with when Trello last saw the card change; `active` null means "fetch again next time".
  async save(active) {
    await fs.mkdir(`${data()}/cards`, { recursive: true }).catch(() => null);
    await fs.writeFile(cardFile(this.card.id), JSON.stringify({ active, full: this.full })).catch(() => null);
  }

  load(cx) {
    this.loading = true; this.error = null;
    cx.spawn(async (cx) => {
      try { this.show(await trello(`cards/${this.card.id}?${FIELDS}`)); await this.save(Date.parse(this.full.dateLastActivity ?? "") || null); }
      catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // A write to Trello, then a reload of the card (unless what's shown is already right) and a nudge
  // to the panel, which fetches that board again.
  change(label, write, cx, { reload = true } = {}) {
    if (this.busy) return;
    this.busy = label; this.error = null;
    cx.spawn(async (cx) => {
      try { await write(); }
      catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.busy = null;
        nudge(this.card.boardId);
        // What's saved no longer matches Trello: the next open fetches the card again.
        if (this.full) await this.save(null);
        if (reload || this.error) this.load(cx); else cx.notify();
      }
    });
    cx.notify();
  }

  comment(cx) {
    const text = this.reply.value().trim();
    if (!text) return;
    this.change("Commenting", async () => {
      await trello(`cards/${this.card.id}/actions/comments`, { method: "POST", params: { text } });
      this.reply.set_value(""); this.replying = false; this.tab = "write";
    }, cx);
  }

  // Shown at once; only a failed write reloads the card.
  tick(item, cx) {
    if (this.busy) return;
    const state = item.state === "complete" ? "incomplete" : "complete";
    item.state = state;
    this.change("Saving", () => trello(`cards/${this.card.id}/checkItem/${item.id}`, { method: "PUT", params: { state } }), cx, { reload: false });
  }

  move(list, cx) {
    this.moving = false;
    this.change(`Moving to ${list.name}`, () => trello(`cards/${this.card.id}`, { method: "PUT", params: { idList: list.id } }), cx);
  }

  toggleMove(cx) {
    this.moving = !this.moving;
    if (this.moving && !this.lists) cx.spawn(async (cx) => {
      this.lists = await trello(`boards/${this.full?.idBoard ?? this.card.boardId}/lists?filter=open&fields=name`).catch(() => []);
      cx.notify();
    });
    cx.notify();
  }

  // Start Claude on the card, or go to the tab it already has. The dialog closes so the tab shows.
  claude(cx) {
    const open = tabOf(this.card.id);
    if (open) { goTo(open); closeOverlay(this.overlay); return; }
    if (this.starting) return;
    this.starting = true; this.error = null;
    cx.spawn(async (cx) => {
      try { if (await start(this.card, this.repo, this.full)) closeOverlay(this.overlay); }
      catch (e) { this.error = String(e?.message ?? e); }
      finally { this.starting = false; cx.notify(); }
    });
    cx.notify();
  }

  folder(cx) {
    cx.spawn(async (cx) => {
      const picked = await pickRepo(this.card.board);
      if (picked) { this.repo = picked; cx.notify(); }
    });
  }

  // ---- drawing ----

  button(id, label, t, onClick, { primary = false, enabled = true, icon = null } = {}) {
    const solid = primary && enabled;
    return h_flex().id(id).h(32).px(12).gap(6).flex_none().items_center().justify_center().rounded(7).text_size(13).font_medium()
      .bg(solid ? t.solid : t.raised).border_1().border_color(solid ? t.solid : t.border).text_color(solid ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
      .when(Boolean(icon), (e) => e.child(glyph(icon, 14, solid ? t.solid_foreground : t.muted)))
      .when(label !== "", (e) => e.child(label));
  }

  // The downloaded picture, or null while it loads (a redraw follows once it's there).
  ensure(url, cx) {
    const loading = loadPicture(url);
    if (loading) cx.spawn(async (cx) => { await loading; cx.notify(); });
    return picture(url);
  }

  // A member's Trello picture, else their initials on a tint of their own.
  person(m, size, t, cx) {
    const p = m?.avatarUrl ? this.ensure(`${m.avatarUrl}/50.png`, cx) : null;
    if (p) return image(p.path).size(size).flex_none().rounded(size / 2);
    const name = m?.fullName ?? m?.username ?? "?", colors = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6];
    const color = colors[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % colors.length];
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center().bg(color + "33")
      .text_size(Math.round(size * 0.42)).font_semibold().text_color(color).child((m?.initials ?? name.slice(0, 1)).toUpperCase());
  }

  // Markdown with its images drawn in between the text; the split is kept per text, not redone per render.
  markdown(key, text, t, cx) {
    if (!this.parts.has(text)) this.parts.set(text, blocks(text));
    return v_flex().gap(12).children(this.parts.get(text).map((b, n) => b.image ? this.picture(`${key}-${n}`, b.image, b.alt, t, cx)
      : TextView.markdown(`${key}-${n}`, b.text).selectable(true).on_link_click((url) => openUrl(url))));
  }

  // At its own width, never wider than the column; a click opens the file.
  picture(key, url, alt, t, cx, max = null) {
    const p = this.ensure(url, cx);
    if (!p) return div().h(failed(url) ? 36 : 120).w(max ?? 320).flex_none().rounded(8).border_1().border_color(t.border).bg(t.raised)
      .flex().items_center().justify_center().px(12).text_size(12).text_color(t.muted).truncate()
      .child(failed(url) ? `Image could not be loaded${alt ? `: ${alt}` : ""}` : "Loading image…");
    const room = max ?? Math.max(240, (this.width ?? 1100) - 380), w = Math.min(p.width, room), h = Math.round(p.height * w / p.width);
    return div().id(key).flex_none().cursor_pointer().on_click(() => openFile(p.file)).child(image(p.path).w(w).h(h).rounded(8));
  }

  section(title, icon, t, body, extra = null) {
    return v_flex().flex_none().gap(10)
      .child(h_flex().gap(8).items_center().text_size(15).font_semibold()
        .child(glyph(icon, 16, t.muted)).child(title)
        .when(Boolean(extra), (e) => e.child(div().text_size(13).font_normal().text_color(t.muted).child(extra))))
      .child(body);
  }

  checklists(c, t) {
    return (c.checklists ?? []).slice().sort((a, b) => a.pos - b.pos).map((cl) => {
      const items = (cl.checkItems ?? []).slice().sort((a, b) => a.pos - b.pos), done = items.filter((i) => i.state === "complete").length;
      return this.section(cl.name, "checklist", t, v_flex().gap(2)
        .child(div().h(4).mb(6).w_full().rounded(2).bg(t.raised)
          .child(div().h(4).rounded(2).bg(t.ansi2).w(`${items.length ? Math.round(100 * done / items.length) : 0}%`)))
        .children(items.map((i) => h_flex().id(`check-${i.id}`).px(6).py(5).gap(10).items_start().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.tick(i, cx))
          .child(div().mt(2).size(16).flex_none().rounded(4).border_1().border_color(i.state === "complete" ? t.ansi2 : t.input)
            .bg(i.state === "complete" ? t.ansi2 : t.background).flex().items_center().justify_center()
            .when(i.state === "complete", (e) => e.child(glyph("check", 12, t.background))))
          .child(div().flex_1().min_w(0).text_size(14).text_color(i.state === "complete" ? t.muted : t.foreground)
            .when(i.state === "complete", (e) => e.line_through()).child(i.name)))), `${done}/${items.length}`);
    });
  }

  attachments(c, t, cx) {
    const all = c.attachments ?? [];
    if (!all.length) return [];
    const isImage = (a) => a.isUpload && (a.mimeType?.startsWith("image/") || IMAGE_FILE.test(a.fileName ?? a.name ?? ""));
    const images = all.filter(isImage), files = all.filter((a) => !isImage(a));
    return [this.section("Attachments", "clip", t, v_flex().gap(10)
      .when(images.length > 0, (e) => e.child(h_flex().gap(10).flex_wrap().items_start()
        .children(images.map((a) => v_flex().gap(4).child(this.picture(`att-${a.id}`, a.url, a.name, t, cx, 200))
          .child(div().w(200).text_size(12).text_color(t.muted).truncate().child(a.name))))))
      .children(files.map((a) => h_flex().id(`file-${a.id}`).px(10).py(8).gap(10).items_center().rounded(8).border_1().border_color(t.border)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => openUrl(a.url))
        .child(glyph(a.isUpload ? "clip" : "external", 14, t.muted))
        .child(div().flex_1().min_w(0).text_size(13).truncate().child(a.name || a.url))
        .when(Boolean(a.bytes), (e) => e.child(div().text_size(12).text_color(t.muted).child(size(a.bytes)))))), `${all.length}`)];
  }

  activity(t, cx) {
    const items = this.items ?? [];
    return this.section("Activity", "comment", t, v_flex().gap(12)
      .when(!items.length, (e) => e.child(div().text_size(13).text_color(t.muted).child(this.loading ? "Loading…" : "No comments yet")))
      .children(items.map((a, n) => a.kind === "event"
        ? h_flex().gap(10).items_center().pl(4).text_size(13).text_color(t.muted)
          .child(this.person(a.who, 22, t, cx))
          .child(div().font_semibold().text_color(t.foreground).child(a.who.fullName ?? a.who.username ?? "Someone"))
          .child(div().flex_1().min_w(0).truncate().child(a.text)).child(div().flex_none().child(ago(a.at)))
        : h_flex().gap(10).items_start()
          .child(this.person(a.who, 30, t, cx))
          .child(v_flex().flex_1().min_w(0).rounded(8).border_1().border_color(t.border).overflow_hidden()
            .child(h_flex().h(34).px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13)
              .child(div().font_semibold().child(a.who.fullName ?? a.who.username ?? "Someone"))
              .child(div().text_color(t.muted).child(ago(a.at))))
            .child(div().px(14).py(12).text_size(14).child(this.markdown(`comment-${n}`, a.text, t, cx)))))));
  }

  composer(t) {
    const busy = Boolean(this.busy), text = Boolean(this.replying);
    const tab = (id, label) => div().id(`reply-tab-${id}`).h(30).px(12).flex().items_center().rounded_t(6).text_size(13).cursor_pointer()
      .when(this.tab === id, (e) => e.bg(t.background).border_1().border_b(0).border_color(t.border).text_color(t.foreground))
      .when(this.tab !== id, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    return v_flex().flex_none().rounded(8).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().px(8).pt(8).gap(4).items_end().bg(t.raised).border_b(1).border_color(t.border).child(tab("write", "Write")).child(tab("preview", "Preview")))
      .child(this.tab === "write"
        ? div().id("reply").px(12).py(10).bg(t.background).cursor_text().child(Textarea.new(this.reply).w_full().text_size(14).text_color(t.foreground))
        : div().px(14).py(12).min_h(90).bg(t.background).text_size(14).child(text
          ? TextView.markdown("reply-preview", this.reply.value()).on_link_click((url) => openUrl(url))
          : div().text_color(t.muted).child("Nothing to preview")))
      .child(h_flex().px(12).py(10).gap(8).items_center().bg(t.background).border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(12).text_color(t.muted).child("Markdown is supported · Ctrl+Enter comments"))
        .child(this.button("reply-send", "Comment", t, (_e, cx) => this.comment(cx), { primary: true, enabled: text && !busy })));
  }

  side(title, t, body, action = null) {
    return v_flex().flex_none().gap(8).py(14).border_b(1).border_color(t.border)
      .child(h_flex().items_center().text_size(12).font_semibold().text_color(t.muted).child(div().flex_1().child(title)).when(Boolean(action), (e) => e.child(action)))
      .child(body);
  }

  sidebar(c, t, cx) {
    const open = tabOf(this.card.id), status = open?.tab.status;
    const link = (id, label, onClick) => div().id(id).text_size(12).font_normal().text_color(t.accent).cursor_pointer().hover((s) => s.underline()).on_click(onClick).child(label);
    const none = (text) => div().text_size(13).text_color(t.muted).child(text);
    const claude = h_flex().id("claude").h(40).gap(8).items_center().justify_center().rounded(8).text_size(14).font_semibold().cursor_pointer()
      .bg(open ? t.raised : t.solid).text_color(open ? t.foreground : t.solid_foreground).border_1().border_color(open ? t.border : t.solid)
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.claude(cx))
      .child(this.starting || status === "working" ? spinner(open ? t.working : t.solid_foreground, 14)
        : open ? div().size(8).rounded(4).bg(t[status] ?? t.idle) : glyph("terminal", 16, t.solid_foreground))
      .child(this.starting ? "Writing the brief…" : open ? "Go to Claude tab" : "Start Claude");
    return v_flex().id("card-sidebar").w(280).flex_none().min_h(0).overflow_y_scrollbar().pl(8).pr(28).pt(16)
      .child(v_flex().flex_none().gap(10).pb(16).border_b(1).border_color(t.border)
        .child(claude)
        .child(h_flex().id("card-folder").gap(6).items_center().text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.folder(cx))
          .child(glyph("folder", 13, t.muted)).child(div().flex_1().min_w(0).truncate().child(this.repo ? short(this.repo) : "Pick a folder for this board"))
          .child(div().text_color(t.accent).child("Change"))))
      .child(this.side("List", t, v_flex().gap(4)
        .child(div().text_size(14).font_semibold().child(c?.list?.name ?? this.card.list ?? ""))
        .when(Boolean(this.moving), (e) => e.child(!this.lists ? none("Loading lists…") : v_flex().gap(1).children(this.lists.map((l) => {
          const here = l.id === c?.idList;
          return h_flex().id(`move-${l.id}`).px(6).py(5).gap(8).items_center().rounded(6).text_size(13)
            .when(!here, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.move(l, cx)))
            .child(div().w(14).flex_none().text_color(t.accent).child(here ? "✓" : "")).child(div().text_color(here ? t.muted : t.foreground).child(l.name));
        })))), link("card-move", this.moving ? "Done" : "Move", (_e, cx) => this.toggleMove(cx))))
      .child(this.side("Members", t, c?.members?.length
        ? v_flex().gap(8).children(c.members.map((m) => h_flex().gap(8).items_center().text_size(13).child(this.person(m, 22, t, cx)).child(m.fullName ?? m.username)))
        : none("No one")))
      .child(this.side("Labels", t, (c?.labels ?? []).length ? h_flex().gap(4).flex_wrap().children(c.labels.map((l) => labelChip(l, t))) : none("No labels")))
      .child(this.side("Due", t, c?.due
        ? h_flex().gap(6).items_center().text_size(13).child(glyph("clock", 14, t.muted)).child(day(c.due))
          .when(c.dueComplete, (e) => e.child(div().text_color(t.ansi2).child("· done")))
          .when(!c.dueComplete && Date.parse(c.due) < Date.now(), (e) => e.child(div().text_color(t.ansi1).child("· overdue")))
        : none("No due date")));
  }

  render(cx) {
    const t = theme(), c = this.full, card = this.card;
    const bar = h_flex().h(32).gap(8).items_center()
      .child(div().text_size(13).text_color(t.muted).child(`${c?.board?.name ?? card.board} · ${c?.list?.name ?? card.list ?? ""}`))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.ansi1).truncate().child(this.error ?? ""))
      .when(this.loading || Boolean(this.busy), (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(spinner(t.working)).child(this.busy ?? "Refreshing")))
      .when(!this.loading && !this.busy, (e) => e.child(this.button("card-refresh", "Refresh", t, (_e, cx) => { this.load(cx); cx.notify(); }, { icon: "refresh" })))
      .child(this.button("card-copy", "Copy", t, () => copyMenu({ url: card.url, number: card.number, title: c?.name ?? card.title }), { icon: "copy" }))
      .child(this.button("card-trello", "Open in Trello", t, () => openUrl(card.url), { icon: "external" }))
      .child(this.button("card-close", "", t, () => closeOverlay(this.overlay), { icon: "close" }));
    const title = c?.name ?? card.title, labels = c?.labels ?? [];
    return v_flex().id("card").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(14)
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(v_flex().flex_none().px(32).pt(14).pb(18).gap(14).border_b(1).border_color(t.border)
        .child(bar)
        // Word by word, so the title wraps like text with the number after its last word.
        .child(h_flex().flex_wrap().gap_x(8).text_size(28).children(title.split(/\s+/).filter(Boolean).map((w) => div().child(w)))
          .child(div().text_color(t.muted).child(`#${card.number}`)))
        .when(labels.length > 0, (e) => e.child(h_flex().gap(6).flex_wrap().children(labels.map((l) => labelChip(l, t))))))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(v_flex().id(`card-thread-${card.id}`).flex_1().min_w(0).h_full().overflow_y_scrollbar().pl(32).pr(24).py(20).gap(28)
          .child(this.section("Description", "list", t, c?.desc?.trim()
            ? div().text_size(14).child(this.markdown("desc", c.desc, t, cx))
            : div().text_size(14).text_color(t.muted).child(c ? "No description" : "Loading…")))
          .children(c ? this.checklists(c, t) : [])
          .children(c ? this.attachments(c, t, cx) : [])
          .child(this.activity(t, cx))
          .child(this.composer(t))
          .child(div().flex_none().h(12)))
        .child(this.sidebar(c, t, cx)));
  }
}
