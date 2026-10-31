// Node's fs/promises plus the `exists` Herdr's sandbox adds.
import * as fs from "node:fs/promises";
export * from "node:fs/promises";
export const exists = (path) => fs.access(path).then(() => true, () => false);
