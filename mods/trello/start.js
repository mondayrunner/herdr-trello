import { spaces, panes, run, notify, pickFolder, shared, setShared } from "herdr";
import { settings, expand, short, inside } from "./api.js";
import { brief } from "./brief.js";

// The mod's shared state, one key so a redraw asks Herdr once, seen by the panel and the card
// dialog and kept across restarts: `links` (card id → its tab; survives renaming the card or the
// tab), `repos` (board name → folder picked in the panel or dialog) and `changed` ({ board, at }:
// the dialog wrote to a card on that board).
const KEY = "trello";
const OLD = { links: "trello.links", repos: "trello.repos" };  // the keys before there was one
export const state = () => shared(KEY) ?? {};
export const links = (s = state()) => s.links ?? {};
export const picked = (s = state()) => s.repos ?? {};
// Read-modify-write of the whole value; `part` gets `value`, or `{ ...part, ...value }` with `merge`.
const update = (part, value, merge = false) => {
  const s = state();
  setShared(KEY, { ...s, [part]: merge ? { ...s[part], ...value } : value });
};
export const pick = (board, folder) => update("repos", { [board]: folder }, true);
export const nudge = (board) => update("changed", { board, at: Date.now() });
// The newest request a toast told about: a click on the toast opens it (see the Trello button).
export const announce = (card, repo) => update("newest", { card, repo });

// What an older version (or another copy still on it) left in the old keys goes into the one key,
// on every start of a copy, and the old key is emptied so it isn't merged again.
export function migrate() {
  for (const [part, key] of Object.entries(OLD)) {
    const old = shared(key);
    if (old && typeof old === "object" && Object.keys(old).length) { update(part, old, true); setShared(key, null); }
  }
}

const tabName = (card) => {
  const name = `#${card.number} ${card.title}`;
  return name.length > 30 ? `${name.slice(0, 29).trimEnd()}…` : name;
};

// Every tab by id, from one look at the spaces.
export const tabIndex = () => new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, { space: s, tab: t }])));

// The card's tab, if it has one and it's still open. Asks for the spaces only when there's a link.
export function tabOf(id, index = null) {
  const tab = links()[id];
  return tab ? (index ?? tabIndex()).get(tab) ?? null : null;
}

// The local space working in this folder: one whose folder it is, else one with a terminal in it.
function spaceFor(repo) {
  const local = spaces().filter((s) => !s.machine);
  const bySpace = local.find((s) => inside(s.folder, repo));
  if (bySpace) return bySpace;
  const tabs = new Map(local.flatMap((s) => s.tabs.map((t) => [t.id, s])));
  const pane = panes().find((p) => tabs.has(p.tab) && inside(p.cwd, repo));
  return pane ? tabs.get(pane.tab) : null;
}

export function goTo(open) {
  run("space.select", { id: open.space.id });
  run("tab.select", { id: open.tab.id });
}

// The system folder picker for a board; the choice is shared, so the panel shows it at once.
export async function pickRepo(board) {
  const folder = await pickFolder({ prompt: `Use for ${board}` });
  if (folder) pick(board, folder);
  return folder;
}

// A new Claude tab in the board's folder with the card as its brief. `card`: { id, number, title,
// board }; `raw`: the card as the dialog loaded it, so it isn't fetched twice. Resolves with the
// folder used, or null when no folder was picked.
export async function start(card, repo, raw = null) {
  repo ??= await pickRepo(card.board);
  if (!repo) return null;
  const config = await settings();
  const r = await brief(card.id, { repo, who: card.board, c: raw,
    dir: `${expand(config.attachments)}/${card.board.replace(/[\\/:]+/g, "-")} #${card.number}` });
  if (r.empty) throw new Error("This card is empty. Give it a title that says what to do, then try again.");
  const name = tabName(card), space = spaceFor(repo);
  if (space) run("tab.new", { space: space.id, name, folder: repo, argv: ["claude"], task: r.brief });
  else run("space.new", { folder: repo, tab: name, argv: ["claude"], task: r.brief });
  // Remember the new tab, so the next click on this card goes there. Found by its name among the
  // tabs no other card has: "the active tab" can still be the old one right after tab.new, and a
  // wrong link is worse than none (no link only means the next click opens a fresh tab).
  const taken = new Set(Object.values(links()));
  const now = space ? spaces().find((s) => s.id === space.id) : spaces().find((s) => s.folder === repo);
  const tab = now?.tabs.find((t) => t.name === name && !taken.has(t.id));
  if (tab) update("links", { [card.id]: tab.id }, true);
  notify({ title: "Claude is on it", body: `#${card.number} ${card.title} · ${short(repo)}`, level: "success", timeout: 3000 });
  return repo;
}
