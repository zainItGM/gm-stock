// Moves the photos built into site/index.html (as data: URIs) into separate files, so the page loads fast.
//   site/img/HASH.jpg     the photo, byte for byte as it was (nothing is re-encoded, so it looks identical)
// HASH comes from the photo itself, so the same photo is stored once and can be cached for good.
// Safe to run again: photos already moved are left alone. Needs only Node.js.
//   node tools/extract-images.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const PAGE = "site/index.html", DIR = "site/img";
const EXT = { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp", gif: "gif", avif: "avif" };
mkdirSync(DIR, { recursive: true });
const before = statSync(PAGE).size;
let html = readFileSync(PAGE, "utf8");
let moved = 0, reused = 0;

html = html.replace(/data:image\/(jpeg|jpg|png|webp|gif|avif);base64,([A-Za-z0-9+/=]+)/g, (_, type, b64) => {
  const bytes = Buffer.from(b64, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const file = join(DIR, hash + "." + EXT[type]);
  if (existsSync(file)) reused++; else { writeFileSync(file, bytes); moved++; }
  return "/img/" + hash + "." + EXT[type];
});

writeFileSync(PAGE, html);
const after = statSync(PAGE).size;
console.log(`${moved} photo(s) moved to ${DIR}/, ${reused} already there.`);
console.log(`${PAGE}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`);
