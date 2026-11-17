// GM Stone catalogue API — one Netlify Function serving /api/*
// (test-server.mjs runs this same file locally, with GM_DEV_STORE pointing at a folder.)
//
//   GET  /api/data.js        live data as a script the public site loads (window.GM_LIVE)
//   GET  /api/data           live data as JSON (admin)
//   PUT  /api/data           replace live data            (admin, token)
//   POST /api/login          { password } -> { token }
//   GET  /api/me             check a token               (admin, token)
//   POST /api/upload         image bytes -> { url }      (admin, token)
//   GET  /api/img/<id>       serve an uploaded image
//   GET  /api/status         { configured, hasData }
//
// Settings (Netlify → Site configuration → Environment variables):
//   ADMIN_PASSWORD   required — the password for /admin/
//   ADMIN_SECRET     optional — signs login tokens (defaults to a value derived from the password)
//   ADMIN_TOKEN_DAYS optional — how long a login lasts (default 14)

import { createHmac, timingSafeEqual, randomBytes, createHash } from "node:crypto";

const STORE_NAME = "gmstone";
const DATA_KEY = "data";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

export const config = { path: "/api/*" };

/* ---------------- storage ---------------- */
async function openStore() {
  if (process.env.GM_DEV_STORE) return fileStore(process.env.GM_DEV_STORE); // local testing only
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name: STORE_NAME, consistency: "strong" });
}
async function fileStore(dir) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(dir, { recursive: true });
  const p = k => path.join(dir, k.replace(/[^A-Za-z0-9._-]/g, "_"));
  return {
    async get(k, o = {}) { try { const b = await fs.readFile(p(k)); return o.type === "json" ? JSON.parse(b.toString()) : o.type === "arrayBuffer" ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b.toString(); } catch { return null; } },
    async getWithMetadata(k, o = {}) { const data = await this.get(k, o); if (data == null) return null; let metadata = {}; try { metadata = JSON.parse(await fs.readFile(p(k) + ".meta")); } catch {} return { data, metadata }; },
    async setJSON(k, v) { await fs.writeFile(p(k), JSON.stringify(v)); },
    async set(k, v, o = {}) { await fs.writeFile(p(k), Buffer.from(v)); await fs.writeFile(p(k) + ".meta", JSON.stringify(o.metadata || {})); },
  };
}

/* ---------------- auth ---------------- */
const secret = () => process.env.ADMIN_SECRET || createHash("sha256").update("gmstone-admin:" + (process.env.ADMIN_PASSWORD || "")).digest("hex");
const sign = exp => createHmac("sha256", secret()).update(String(exp)).digest("base64url");
function makeToken() {
  const days = Number(process.env.ADMIN_TOKEN_DAYS) || 14;
  const exp = Date.now() + days * 86400000;
  return { token: exp + "." + sign(exp), exp };
}
function tokenOk(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  // The admin sends the login pass in X-Admin-Token: some proxies (e.g. GitHub Codespaces port
  // forwarding) use the Authorization header themselves. "Authorization: Bearer ..." also works.
  const h = req.headers.get("authorization") || "";
  const t = req.headers.get("x-admin-token") || (h.startsWith("Bearer ") ? h.slice(7) : "");
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
function passwordOk(given) {
  const want = Buffer.from(process.env.ADMIN_PASSWORD || ""), got = Buffer.from(String(given || ""));
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
}

/* ---------------- helpers ---------------- */
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const err = (msg, status) => json({ error: msg }, status);
const SHAPE = ["DATA", "STOCK", "ORDER", "PROJECTS"];
function validData(d) {
  if (!d || typeof d !== "object") return "no data";
  for (const k of SHAPE) if (!Array.isArray(d[k])) return k + " must be a list";
  if (typeof d.ENQ_TO !== "string" || typeof d.WA_NO !== "string") return "ENQ_TO and WA_NO must be text";
  for (const k of SHAPE) for (const it of d[k]) if (JSON.stringify(it).length > 400000) return "an item in " + k + " is too large — use an uploaded photo instead of an embedded one";
  return null;
}

/* ---------------- handler ---------------- */
export default async function handler(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const m = req.method;
  let store;
  try { store = await openStore(); } catch (e) { return err("storage unavailable: " + e.message, 500); }

  try {
    if (route === "data.js" && m === "GET") {
      const doc = await store.get(DATA_KEY, { type: "json" });
      const body = doc && doc.data ? "window.GM_LIVE=" + JSON.stringify(doc.data).replace(/</g, "\\u003c") + ";" : "/* no live data yet */";
      return new Response(body, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache, max-age=0, must-revalidate" } });
    }
    if (route === "status" && m === "GET") {
      const doc = await store.get(DATA_KEY, { type: "json" });
      return json({ configured: !!process.env.ADMIN_PASSWORD, hasData: !!(doc && doc.data), rev: doc ? doc.rev : 0, updatedAt: doc ? doc.updatedAt : null });
    }
    if (route === "login" && m === "POST") {
      if (!process.env.ADMIN_PASSWORD) return err("The admin password hasn't been set up yet. In Netlify: Project configuration > Environment variables > ADMIN_PASSWORD, then deploy again.", 500);
      const body = await req.json().catch(() => ({}));
      if (!passwordOk(body.password)) { await new Promise(r => setTimeout(r, 1000)); return err("Wrong password", 401); } // slow down password guessing
      return json(makeToken());
    }
    if (route.startsWith("img/") && m === "GET") {
      const id = route.slice(4);
      if (!/^[A-Za-z0-9_-]+\.(jpg|png|webp|gif|avif)$/.test(id)) return err("not found", 404);
      const got = await store.getWithMetadata("img/" + id, { type: "arrayBuffer" });
      if (!got || !got.data) return err("not found", 404);
      const type = (got.metadata && got.metadata.type) || "image/jpeg";
      return new Response(got.data, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
    }

    // everything below needs a valid login
    if (!tokenOk(req)) return err("Please sign in", 401);

    if (route === "me" && m === "GET") return json({ ok: true });
    if (route === "data" && m === "GET") {
      const doc = await store.get(DATA_KEY, { type: "json" });
      return json(doc || { rev: 0, updatedAt: null, data: null });
    }
    if (route === "data" && m === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body) return err("bad JSON", 400);
      const bad = validData(body.data); if (bad) return err(bad, 400);
      const cur = await store.get(DATA_KEY, { type: "json" });
      const curRev = cur ? cur.rev : 0;
      if (body.rev != null && body.rev !== curRev) return json({ error: "Someone else saved first. Reload to see their changes.", rev: curRev }, 409);
      const doc = { rev: curRev + 1, updatedAt: new Date().toISOString(), data: body.data };
      await store.setJSON(DATA_KEY, doc);
      return json({ rev: doc.rev, updatedAt: doc.updatedAt });
    }
    if (route === "upload" && m === "POST") {
      const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const ext = IMAGE_TYPES[type]; if (!ext) return err("Upload a JPEG, PNG, WebP, GIF or AVIF image", 415);
      const bytes = await req.arrayBuffer();
      if (!bytes.byteLength) return err("empty upload", 400);
      if (bytes.byteLength > MAX_IMAGE_BYTES) return err("Image is over 5 MB", 413);
      const id = Date.now().toString(36) + "-" + randomBytes(5).toString("hex") + "." + ext;
      await store.set("img/" + id, bytes, { metadata: { type } });
      return json({ url: "/api/img/" + id, id });
    }
    return err("not found", 404);
  } catch (e) {
    return err("server error: " + e.message, 500);
  }
}
