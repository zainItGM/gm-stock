// Local test server: runs the site and the admin portal WITHOUT Netlify.
// Start:  node test-server.mjs        then open http://localhost:8080/admin/
// Test password is "test" (or set ADMIN_PASSWORD=yourpassword before the command).
// Everything saved in the admin goes into test-data/ (quantities, photos). Nothing goes online.
// Storage runs on Netlify's own local Blobs server, so the function's code is exactly what runs on Netlify.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

import { BlobsServer } from "@netlify/blobs/server";

process.env.ADMIN_PASSWORD ||= "test";
// Netlify's local stand-in for its Blobs storage, keeping its files in test-data/
const blobs = new BlobsServer({ directory: join(process.cwd(), "test-data"), token: "local-test" });
const { port: blobsPort } = await blobs.start();
const blobsURL = "http://localhost:" + blobsPort;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: blobsURL, uncachedEdgeURL: blobsURL, token: "local-test", siteID: "local-test" })).toString("base64");
const { default: api } = await import("./netlify/functions/api.mjs");

const PORT = Number(process.env.PORT || 8080);
const ROOT = join(process.cwd(), "site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);
  if (url.pathname.startsWith("/api/")) {
    // same code as on Netlify; show each API request in the terminal, to make problems easy to spot
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await api(new Request(url.href, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    console.log(`  ${new Date().toLocaleTimeString()}  ${req.method} ${url.pathname}  ->  ${r.status}`);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try { if ((await stat(p)).isDirectory()) p = join(p, "index.html"); } catch {}
  try {
    const body = await readFile(p);
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(PORT, () => console.log(`Test site:  http://localhost:${PORT}/     admin:  http://localhost:${PORT}/admin/   (password: ${process.env.ADMIN_PASSWORD})`));
