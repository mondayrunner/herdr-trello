import * as fs from "fs/promises";
import { home, appHome, readTextFile } from "herdr";

// Settings live in ~/.config/herdr-app/data/trello/settings.json; these are the defaults.
export const DEFAULTS = {
  envFile: "~/.config/trello/.env",       // holds TRELLO_KEY and TRELLO_TOKEN
  folders: ["~/Sites/clients"],           // where a board's repo is guessed from its name
  attachments: "~/Downloads/trello",      // a card's uploads go to "<board> #<number>" in here
  repos: {},                              // board name → folder, set by picking a folder in the panel
  current: "Doing",                       // the list of open requests; a board with one is a client board
  done: ["Done", "Approved", "Archive"],  // finished lists, shown dimmed
};

export const data = () => `${appHome()}/data/trello`;
export const expand = (p) => p.replace(/^~(?=\/|$)/, home());
export const short = (path) => path.split("/").slice(-2).join("/");
const settingsFile = () => `${data()}/settings.json`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A list's name without the emoji or marks in front ("⚡️ Doing" is "Doing"), matched as a whole name,
// or followed by a note after a bracket or dash ("Doing (Tim)", "Done – week 3"), not by more words
// ("Doing later" and "Undone" are other lists).
const bare = (name) => name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
const anyOf = (names) => names.length ? new RegExp(`^(?:${names.map((n) => escape(n).replace(/\s+/g, "\\s*")).join("|")})(?:\\s*[(\\[:–—-].*)?$`, "i") : null;
// The local date of a Trello timestamp (Trello stores UTC), as YYYY-MM-DD.
export const localDay = (iso) => { const d = new Date(iso), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
// Back to ~ only when the path is inside the home folder itself, not one that starts with the same letters.
const tilde = (path) => path === home() || path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path;

let config = null, auth = null;

async function saved() {
  return readTextFile(settingsFile()).then((t) => JSON.parse(t ?? "{}")).catch(() => ({}));
}

// The settings over the defaults, with the list names as patterns. Read once per mod load.
export async function settings() {
  if (!config) {
    config = { ...DEFAULTS, ...await saved() };
    const current = anyOf([config.current]), done = anyOf(config.done);
    config.isCurrent = (list) => current.test(bare(list));
    config.isDone = (list) => Boolean(done?.test(bare(list)));
  }
  return config;
}

// Read settings.json and the env file again on next use (edited, or another copy of the mod wrote to it).
export function reload() { config = null; auth = null; }

// One board's folder, added to what's in settings.json now (another copy may have saved one meanwhile).
export async function saveRepo(board, folder) {
  const file = await saved(), repos = { ...file.repos, [board]: tilde(folder) };
  await fs.mkdir(data(), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify({ ...file, repos }, null, 2) + "\n");
  if (config) config.repos = repos;
}

function parseEnv(text) {
  const env = {};
  for (const line of (text ?? "").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

// The key and token from the env file the settings name.
export async function credentials() {
  if (!auth) {
    const file = (await settings()).envFile, env = parseEnv(await readTextFile(expand(file)));
    if (!env.TRELLO_KEY || !env.TRELLO_TOKEN) throw new Error(`TRELLO_KEY and TRELLO_TOKEN are missing in ${file}`);
    auth = { key: env.TRELLO_KEY, token: env.TRELLO_TOKEN };
  }
  return auth;
}

// Trello's REST API. `params` go in the query string, as Trello takes them for writes too.
export async function trello(path, { method = "GET", params = {} } = {}) {
  const { key, token } = await credentials();
  const query = Object.entries({ ...params, key, token }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const r = await fetch(`https://api.trello.com/1/${path}${path.includes("?") ? "&" : "?"}${query}`, { method });
  if (!r.ok) throw new Error(`Trello ${r.status} on ${path.split("?")[0]}${r.status === 401 ? ": check the key and token" : ""}`);
  return r.json();
}
