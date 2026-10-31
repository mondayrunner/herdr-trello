import * as fs from "fs/promises";
import { createHash } from "crypto";
import { appHome } from "herdr";
import { download } from "./api.js";

// The markdown view draws no images, so the screenshots on a card are cut out of the text and
// drawn between its runs, from a copy in the data folder (Herdr draws images only from its home).
const IMAGE = /(```[\s\S]*?```)|!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;

// The text as markdown runs and the images between them; code is left alone.
export function blocks(markdown) {
  const out = [];
  let last = 0, m;
  IMAGE.lastIndex = 0;
  while ((m = IMAGE.exec(markdown))) {
    if (m[1] || !/^https?:\/\//.test(m[3])) continue;
    out.push({ text: markdown.slice(last, m.index) }, { image: m[3], alt: m[2] });
    last = m.index + m[0].length;
  }
  out.push({ text: markdown.slice(last) });
  return out.filter((b) => b.image || b.text.trim());
}

// Width and height from the file's own header: PNG, GIF, JPEG, WebP.
function dimensions(b) {
  const u16 = (i) => (b[i] << 8) | b[i + 1], u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return { width: u32(16), height: u32(20) };
  if (ascii(0, 4) === "GIF8") return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff || b[i + 1] === 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: u16(i + 7), height: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const kind = ascii(12, 16);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === "VP8L") {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

const pictures = {};
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 20);

// { path (for image()), file, width, height } once downloaded; null before.
export const picture = (url) => typeof pictures[url] === "object" ? pictures[url] : null;
export const failed = (url) => pictures[url] === "missing";

// Starts the download the first time a URL is asked for: a promise that resolves once it's
// ready or failed (Trello's own URLs go with the key and token, see download()).
export function loadPicture(url) {
  if (pictures[url] !== undefined) return null;
  pictures[url] = "loading";
  return (async () => {
    const dir = `${appHome()}/data/trello/images`, path = `data/trello/images/${hash(url)}.png`, file = `${appHome()}/${path}`;
    try {
      if (!await fs.exists(file)) {
        await fs.mkdir(dir, { recursive: true });
        if (!await download(url, file)) throw new Error("download failed");
      }
      const size = dimensions(await fs.readFile(file));
      if (!size?.width || !size?.height) throw new Error("not an image");
      pictures[url] = { path, file, ...size };
    } catch { pictures[url] = "missing"; await fs.unlink(file).catch(() => null); }
  })();
}
