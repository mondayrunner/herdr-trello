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

let config = null, auth = null;

async function saved() {
  return readTextFile(settingsFile()).then((t) => JSON.parse(t ?? "{}")).catch(() => ({}));
}

// The settings over the defaults, with the list names as patterns. Read once per mod load.
export async function settings() {
  if (!config) {
    config = { ...DEFAULTS, ...await saved() };
    config.currentList = new RegExp(escape(config.current).replace(/\s+/g, "\\s*"), "i");
    config.doneList = new RegExp(config.done.map(escape).join("|"), "i");
  }
  return config;
}

// Read settings.json again on next use (another copy of the mod wrote to it).
export function reload() { config = null; }

// One board's folder, kept in settings.json.
export async function saveRepo(board, folder) {
  const s = await settings(), file = await saved();
  s.repos = { ...s.repos, [board]: folder.replace(home(), "~") };
  await fs.mkdir(data(), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify({ ...file, repos: s.repos }, null, 2) + "\n");
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
