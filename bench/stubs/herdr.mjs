// Herdr's module, counted: every call is one round trip to the app.
import { readFile } from "node:fs/promises";
import { host } from "./counter.mjs";

const env = globalThis.__benchEnv;  // set by measure.mjs: { home, appHome, layout, spaces, props }
const shared_ = new Map();
const colors = new Proxy({}, { get: () => "#808080" });
const counted = (name, f) => (...args) => { host(name); return f(...args); };

export const home = () => env.home;
export const appHome = () => env.appHome;
export const theme = counted("theme", () => colors);
export const layout = counted("layout", () => env.layout);
export const spaces = counted("spaces", () => env.spaces);
export const panes = counted("panes", () => []);
export const focused = counted("focused", () => ({ space: "s1", tab: "t1", pane: "p1", terminal: "t1", cwd: env.focusedCwd, agent: null, shown: null }));
export const props = counted("props", () => env.props);
export const shared = counted("shared", (key) => shared_.get(key));
export const setShared = counted("setShared", (key, value) => { shared_.set(key, value); });
export const run = counted("run", () => null);
export const notify = counted("notify", () => "n1");
export const openOverlay = counted("openOverlay", () => "o1");
export const closeOverlay = counted("closeOverlay", () => null);
export const pickFolder = async () => null;
export const exec = async () => ({ code: 0, stdout: "", stderr: "" });
export const hc = async () => ({ code: 0, stdout: env.terminalText ?? "", stderr: "" });
export const readTextFile = async (path) => readFile(path, "utf8").catch(() => null);
