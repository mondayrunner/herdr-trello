// What a redraw costs, counted: calls into Herdr (each one a round trip to the app) and
// element-building steps (each builder call is a call into the native toolkit).
export const count = (globalThis.__bench ??= { host: 0, ops: 0, texts: [], byHost: {} });

export function reset() { count.host = 0; count.ops = 0; count.texts = []; count.byHost = {}; }

export function host(name) { count.host++; count.byHost[name] = (count.byHost[name] ?? 0) + 1; }

// An element: every method call is one step and returns the element, so chains work. Strings given
// as children are kept, so the gates can check what was drawn.
export function element() {
  count.ops++;
  const el = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      return (...args) => {
        count.ops++;
        if (prop === "child") { const c = args[0]; if (typeof c === "string" || typeof c === "number") count.texts.push(String(c)); }
        if (prop === "children") for (const c of args[0] ?? []) if (typeof c === "string") count.texts.push(c);
        if (prop === "when") return args[0] ? (args[1](el) ?? el) : el;
        return el;
      };
    },
  });
  return el;
}
