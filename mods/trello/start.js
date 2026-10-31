import { spaces, panes, run, notify, pickFolder, shared, setShared } from "herdr";
import { settings, pick, expand, short, inside } from "./api.js";
import { brief } from "./brief.js";

// Which tab each card got, shared by the panel and the card dialog and kept across restarts.
// The link survives renaming the card or the tab.
const LINKS = "trello.links";
export const links = () => shared(LINKS) ?? {};

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
  if (tab) setShared(LINKS, { ...links(), [card.id]: tab.id });
  notify({ title: "Claude is on it", body: `#${card.number} ${card.title} · ${short(repo)}`, level: "success", timeout: 3000 });
  return repo;
}
