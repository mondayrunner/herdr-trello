import * as fs from "fs/promises";
import { appHome } from "herdr";

// Herdr draws images only from real folders, and this mod's folder is a
// symlink to its git checkout: the icons go to its data folder instead.
const SVG = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  trello: SVG(`<rect width="18" height="18" x="3" y="3" rx="2"/><rect width="3" height="9" x="7" y="7"/><rect width="3" height="5" x="14" y="7"/>`),
  refresh: SVG(`<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>`),
  external: SVG(`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`),
  close: SVG(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`),
  copy: SVG(`<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`),
  terminal: SVG(`<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M7.5 10l3 2.5-3 2.5"/><path d="M12.5 15.5h4"/>`),
  check: SVG(`<path d="M20 6 9 17l-5-5"/>`),
  list: SVG(`<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>`),
  move: SVG(`<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`),
  clip: SVG(`<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>`),
  checklist: SVG(`<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>`),
  comment: SVG(`<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>`),
  folder: SVG(`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`),
  clock: SVG(`<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`),
  plus: SVG(`<path d="M5 12h14"/><path d="M12 5v14"/>`),
};

let written = null;

// Resolves once the icons are on disk; draw them only after that.
export function icons() {
  written ??= (async () => {
    const dir = `${appHome()}/data/trello/icons`;
    await fs.mkdir(dir, { recursive: true });
    for (const [name, svg] of Object.entries(ICONS)) await fs.writeFile(`${dir}/${name}.svg`, svg);
  })();
  return written;
}

export const icon = (name) => `data/trello/icons/${name}.svg`;
