// Measures what one redraw of the Trello panel (All tab, 100 rows) and of the card view costs,
// by running the mod's real code in Node with counting stand-ins for Herdr and its UI toolkit.
// Prints one JSON object for ce-optimize. Weights from Herdr on the throttled Mac (2026-10-31):
// a call into Herdr ~10 ms, a builder step ~0.06 ms.
import { register } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const HOST_MS = 10, OP_MS = 0.06, ROWS = 100;
const mod = resolve(process.argv[2] ?? "mods/trello");

// ---- a fake Herdr home with settings and a key ----
const home = await mkdtemp(join(tmpdir(), "herdr-trello-bench-"));
const appHome = join(home, ".config/herdr-app");
await mkdir(join(appHome, "data/trello"), { recursive: true });
await mkdir(join(home, "Sites/clients/acme-studio"), { recursive: true });
await writeFile(join(home, "trello.env"), "TRELLO_KEY=k\nTRELLO_TOKEN=t\n");
await writeFile(join(appHome, "data/trello/settings.json"), JSON.stringify({ envFile: join(home, "trello.env"), folders: [join(home, "Sites/clients")], current: ["Doing"] }));

// ---- fake Trello: 25 boards, 1584 cards, one card with everything on it ----
const BOARDS = 25, PER = 64, LISTS = ["Backlog", "⚡️ Doing", "Review", "Done", "Archive"];
const boards = Array.from({ length: BOARDS }, (_, b) => ({
  id: `b${b}`, name: b === 0 ? "Acme Studio" : `Client ${b}`, shortUrl: `https://trello.com/b/B${b}`,
  dateLastActivity: new Date(2026, 9, 1 + b).toISOString(),
  lists: LISTS.map((name, l) => ({ id: `b${b}l${l}`, name })),
}));
const cards = (b) => Array.from({ length: b < 19 ? PER : PER - 2 }, (_, i) => ({
  id: `c${b}x${i}`, idShort: i + 1, name: `Card ${i + 1} on board ${b}: fix the footer on mobile`, idList: `b${b}l${i % LISTS.length}`,
  idMembers: i % 3 ? ["me"] : [], due: i % 7 ? null : new Date(2026, 9, 20 + (i % 9)).toISOString(), dueComplete: false,
  shortUrl: `https://trello.com/c/${String(b).padStart(3, "0")}${String(i).padStart(5, "0")}`, dateLastActivity: new Date(2026, 9, 1, b, i).toISOString(),
  pos: i * 1000, labels: i % 4 ? [] : [{ name: "bug", color: "red" }],
}));
const full = {
  id: "c0x1", name: "Website feedback and the new landing page", desc: "Go through the feedback.\n\n![shot](https://example.com/a.png)\n\nThen build the page. See [the doc](https://example.com/doc).",
  due: null, dueComplete: false, labels: [{ name: "bug", color: "red" }, { name: "web", color: "blue" }], shortUrl: "https://trello.com/c/00000001", idShort: 2, idList: "b0l1", idBoard: "b0",
  members: [{ id: "me", fullName: "Tim", username: "tim", initials: "T", avatarUrl: null }],
  checklists: [{ id: "cl1", name: "Todo", pos: 1, checkItems: Array.from({ length: 6 }, (_, i) => ({ id: `ci${i}`, name: `Step ${i + 1}`, state: i < 2 ? "complete" : "incomplete", pos: i })) }],
  attachments: [{ id: "a1", name: "notes.docx", url: "https://trello.com/1/cards/c0x1/attachments/a1/download/notes.docx", fileName: "notes.docx", isUpload: true, bytes: 75000, mimeType: "application/msword" }],
  actions: Array.from({ length: 20 }, (_, i) => i % 4 === 3
    ? { type: "updateCard", date: new Date(2026, 9, 1 + i).toISOString(), memberCreator: { fullName: "Rutger", initials: "R" }, data: { listBefore: { name: "Backlog" }, listAfter: { name: "⚡️ Doing" } } }
    : { type: "commentCard", date: new Date(2026, 9, 1 + i).toISOString(), memberCreator: { fullName: i % 2 ? "Tim" : "Client", initials: "T" }, data: { text: `Comment ${i + 1}: please also check the **header** on tablets.` } }).reverse(),
  list: { name: "⚡️ Doing" }, board: { name: "Acme Studio", shortUrl: "https://trello.com/b/B0" },
};
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname.replace(/^\/1\//, "");
  const body = path === "members/me" ? { id: "me", username: "you" }
    : path === "members/me/boards" ? boards
    : path.startsWith("boards/") ? cards(Number(path.split("/")[1].slice(1)))
    : path.startsWith("cards/") ? full : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

// ---- Herdr's state as the stand-ins report it ----
const panel = { id: "panel", type: "column", hidden: false, children: [{ id: "panel-body", type: "stack", active: "trello", children: [
  { id: "files", type: "block", content: { mod: "files" } }, { id: "trello", type: "block", content: { mod: "trello" } }] }] };
globalThis.__benchEnv = {
  home, appHome, focusedCwd: join(home, "Sites/clients/acme-studio/src"),
  layout: { id: "root", type: "row", children: [{ id: "main", type: "block" }, panel] },
  spaces: [{ id: "s1", name: "acme", folder: join(home, "Sites/clients/acme-studio"), machine: null, active: true,
    tabs: Array.from({ length: 6 }, (_, i) => ({ id: `tab${i}`, name: `${i + 1}`, active: i === 0, status: i === 1 ? "working" : "idle" })) }],
  props: {}, terminalText: "commented on https://trello.com/c/00000003 and https://trello.com/c/00100007\n",
};

register("./hooks.mjs", import.meta.url);
const { count, reset } = await import("./stubs/counter.mjs");
const { default: Trello } = await import(join(mod, "main.js"));

// A cx whose tasks run and can be awaited; timers never fire.
const tasks = [];
const cx = { spawn: (f) => { const p = Promise.resolve().then(() => f(cx)); tasks.push(p); return p; }, notify() {}, timer: { every() {} } };
const settle = async () => { for (let n = 0; n < 50 && tasks.length; n++) await Promise.allSettled(tasks.splice(0)); };

// One redraw measured after a first one, as a steady redraw (live data changed, nothing else).
function measure(view) {
  view.render(cx);
  reset();
  view.render(cx);
  const snapshot = { host: count.host, ops: count.ops, texts: count.texts.join("\n"), byHost: { ...count.byHost } };
  const times = [];
  for (let i = 0; i < 30; i++) { const t = performance.now(); view.render(cx); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  return { ...snapshot, ms: times[15] };
}

const out = { check_passes: 0, rows_all_view: 0, titles_ok: 0, viewer_ok: 0 };
try {
  // The panel, synced through its own code, on the All tab; one card has a tab of its own.
  __benchEnv.props = {};
  const p = new Trello();
  p.init({}, cx);
  await settle();
  p.view = "all";
  p.scan(cx); await settle();
  const { setShared } = await import("./stubs/herdr.mjs");
  setShared("trello.links", { c0x1: "tab1" });
  const a = measure(p);
  const drawn = p.memo.groups.flatMap((g) => g.cards);
  out.rows_all_view = drawn.length;
  out.titles_ok = drawn.length === ROWS && drawn.every((c) => a.texts.includes(c.title) && a.texts.includes(`#${c.number}`)) ? 1 : 0;
  out.host_calls_panel = a.host; out.element_ops_panel = a.ops; out.node_ms_panel = +a.ms.toFixed(3);

  // The card view, loaded through its own code.
  const card = drawn.find((c) => c.id === "c0x1") ?? { id: "c0x1", number: 2, title: full.name, board: "Acme Studio", boardId: "b0", url: full.shortUrl, list: "⚡️ Doing" };
  __benchEnv.props = { card, repo: join(home, "Sites/clients/acme-studio"), overlay: "o1" };
  const v = new Trello();
  v.init({}, cx);
  await settle();
  const b = measure(v);
  const words = full.name.split(/\s+/);
  const comments = full.actions.filter((x) => x.type === "commentCard").map((x) => x.data.text);
  const items = full.checklists[0].checkItems.map((i) => i.name);
  out.viewer_ok = [...words, ...items, ...comments, "Start Claude", "Go to Claude tab"].filter((s) => s !== "Start Claude" && s !== "Go to Claude tab").every((s) => b.texts.includes(s))
    && (b.texts.includes("Start Claude") || b.texts.includes("Go to Claude tab")) && b.texts.includes("Go through the feedback.") ? 1 : 0;
  out.host_calls_viewer = b.host; out.element_ops_viewer = b.ops; out.node_ms_viewer = +b.ms.toFixed(3);

  out.est_ms_per_render = +((a.host + b.host) * HOST_MS + (a.ops + b.ops) * OP_MS).toFixed(2);
  out.host_breakdown_panel = a.byHost; out.host_breakdown_viewer = b.byHost;
} catch (e) {
  out.error = String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ");
}

// herdr-app check on the same folder, when Herdr is installed here.
try { await promisify(execFile)("herdr-app", ["check", mod], { timeout: 60000 }); out.check_passes = 1; } catch { out.check_passes = 0; }

await rm(home, { recursive: true, force: true });
console.log(JSON.stringify(out));
process.exit(0);
