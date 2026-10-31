import { spaces, panes, run, notify, pickFolder, shared, setShared } from "herdr";
import { trello, credentials, settings, saveRepo, data, expand, short } from "./api.js";
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

// The card's tab, if it's still open.
export const tabOf = (id, index = tabIndex()) => index.get(links()[id]) ?? null;

// The local space working in this folder: one whose folder it is, else one with a terminal in it.
function spaceFor(repo) {
  const local = spaces().filter((s) => !s.machine);
  const inside = (p) => p === repo || p?.startsWith(`${repo}/`);
  const bySpace = local.find((s) => inside(s.folder));
  if (bySpace) return bySpace;
  const tabs = new Map(local.flatMap((s) => s.tabs.map((t) => [t.id, s])));
  const pane = panes().find((p) => tabs.has(p.tab) && inside(p.cwd));
  return pane ? tabs.get(pane.tab) : null;
}

export function goTo(open) {
  run("space.select", { id: open.space.id });
  run("tab.select", { id: open.tab.id });
}

// The system folder picker for a board; the choice is saved in settings.json.
export async function pickRepo(board) {
  const folder = await pickFolder({ prompt: `Use for ${board}` });
  if (folder) await saveRepo(board, folder);
  return folder;
}

// The card's own tab when it has one; else a new Claude tab in the board's folder with the card as
// its brief. `card`: { id, number, title, board }. Resolves with the folder used, or null.
export async function start(card, repo) {
  const open = tabOf(card.id);
  if (open) { goTo(open); return repo; }
  repo ??= await pickRepo(card.board);
  if (!repo) return null;
  const config = await settings();
  const r = await brief(trello, await credentials(), card.id, {
    repo, who: card.board,
    dir: `${expand(config.attachments)}/${card.board.replace(/[\\/:]+/g, "-")} #${card.number}`,
    header: `${data()}/.auth-${card.id}`,
  });
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
