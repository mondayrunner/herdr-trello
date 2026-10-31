// Node module hooks: inside mods/trello, Herdr's own modules resolve to the counting stand-ins.
const STUBS = { "gpui-kit": "gpui-kit.mjs", "gpui-base": "gpui-base.mjs", "herdr": "herdr.mjs", "fs/promises": "fs.mjs" };

export async function resolve(specifier, context, next) {
  if (STUBS[specifier] && context.parentURL?.includes("/mods/trello/")) {
    return { url: new URL(`./stubs/${STUBS[specifier]}`, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
