import * as fs from "fs/promises";
import { home, appHome, exec, readTextFile, shared, setShared } from "herdr";

// Settings live in ~/.config/herdr-app/data/trello/settings.json (edited by hand); these are the defaults.
export const DEFAULTS = {
  envFile: "~/.config/trello/.env",       // holds TRELLO_KEY and TRELLO_TOKEN
  folders: ["~/Sites/clients"],           // where a board's repo is guessed from its name
  attachments: "~/Downloads/trello",      // a card's uploads go to "<board> #<number>" in here
  repos: {},                              // board name → folder, for boards the guess gets wrong
  current: ["Doing"],                     // the list(s) of open requests; a board with one is a client board
  done: ["Done", "Approved", "Archive"],  // finished lists, shown dimmed
};

// Shared between the panel and the card dialog (both copies of this mod), kept across restarts.
export const CHANGED = "trello.changed";  // { board, at }: the dialog wrote to a card on that board
const PICKED = "trello.repos";            // board name → folder picked in the panel

export const data = () => `${appHome()}/data/trello`;
export const expand = (p) => p.replace(/^~(?=\/|$)/, home());
export const short = (path) => path.split("/").slice(-2).join("/");
// `path` is `dir` or somewhere inside it; not a sibling that starts with the same letters.
export const inside = (path, dir) => path === dir || Boolean(path?.startsWith(`${dir}/`));
// The local date of a Trello timestamp (Trello stores UTC), as YYYY-MM-DD.
export const localDay = (iso) => { const d = new Date(iso), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// A list's name as the settings name it: without the emoji in front ("⚡️ Doing" is "Doing"),
// case and spacing aside. Lists match by their whole name; "Undone" is not "Done".
const bare = (name) => name.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim().toLowerCase();
const named = (names) => { const set = new Set([names].flat().map(bare)); return (list) => set.has(bare(list)); };

let config = null, auth = null;

// The settings over the defaults. Read once per mod load; Refresh reads them again.
export async function settings() {
  if (!config) {
    config = { ...DEFAULTS, ...await readTextFile(`${data()}/settings.json`).then((t) => JSON.parse(t ?? "{}")).catch(() => ({})) };
    config.isCurrent = named(config.current);
    config.isDone = named(config.done);
    config.currentName = [config.current].flat()[0];
  }
  return config;
}

// Read settings.json and the env file again on next use.
export function reload() { config = null; auth = null; }

// Folders picked in the panel, on top of the settings' `repos`.
export const picked = () => shared(PICKED) ?? {};
export const pick = (board, folder) => setShared(PICKED, { ...picked(), [board]: folder });

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

// Trello serves uploads only to its key and token; every other host gets no credentials.
const trelloHost = (url) => /^https:\/\/(api\.)?trello\.com\//.test(url);
let headers = 0;

// Downloads `url` to `out` with curl (fetch gives no bytes). For Trello's own URLs the OAuth header
// goes through a file of its own, so the token never shows up in a process list, and the file goes
// again right after. curl drops that header when a redirect leaves the host. Resolves true when saved.
export async function download(url, out, { seconds = 30 } = {}) {
  const args = ["-sfL", "--max-time", String(seconds), "-o", out, "--", url];
  const header = trelloHost(url) ? `${data()}/.auth-${Date.now()}-${headers++}` : null;
  if (header) {
    const { key, token } = await credentials();
    await fs.mkdir(data(), { recursive: true });
    await fs.writeFile(header, `Authorization: OAuth oauth_consumer_key="${key}", oauth_token="${token}"\n`);
    args.unshift("-H", `@${header}`);
  }
  try { return (await exec("curl", args).catch(() => null))?.code === 0; }
  finally { if (header) await fs.unlink(header).catch(() => null); }
}
