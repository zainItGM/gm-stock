// GM Stone catalogue API — one Netlify Function serving /api/*
// (test-server.mjs runs this same file locally, against Netlify's own local Blobs server.)
//
//   GET  /api/data.js        live data as a script the public site loads (window.GM_LIVE);
//                            items marked hidden are left out, so the site never sees them
//   GET  /api/data           live data as JSON, hidden items included (admin)
//   PUT  /api/data           replace live data { rev, data, what }    (admin, token)
//   GET  /api/history        the last saves: [{ rev, updatedAt, what }]  (admin, token)
//   GET  /api/history/<rev>  one saved version, in full                (admin, token)
//   POST /api/restore        { rev, baseRev } -> makes that version live again (admin, token)
//   POST /api/login          { password } -> { token }
//   GET  /api/me             check a token               (admin, token)
//   POST /api/upload         image bytes -> { url }      (admin, token)
//   GET  /api/img/<id>       serve an uploaded image
//   GET  /api/status         { configured, hasData }
//
// Settings (Netlify → Project configuration → Environment variables):
//   ADMIN_PASSWORD   required — the password for /admin/
//   ADMIN_SECRET     optional — signs login tokens (defaults to a value derived from the password)
//   ADMIN_TOKEN_DAYS optional — how long a login lasts (default 14)

import { createHmac, timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE_NAME = "gmstone";
const DATA_KEY = "data";
const HIST_INDEX = "hist-index";   // [{ rev, updatedAt, what }], newest first
const HIST_KEEP = 40;              // how many saved versions to keep
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

export const config = { path: "/api/*" };

const openStore = () => getStore({ name: STORE_NAME, consistency: "strong" });

/* ---------------- what the public site gets ---------------- */
// Items with hidden: true stay in the admin but are left out of the site's data.
// A cargo block whose bundles are all hidden is left out too. The "hidden" key never reaches the site.
function forSite(d) {
  const shown = list => (list || []).filter(x => x && !x.hidden).map(({ hidden, ...x }) => x);
  const blocks = shown(d.DATA).map(B => ({ ...B, lots: shown(B.lots) })).filter(B => B.lots.length);
  return { ...d, DATA: blocks, STOCK: shown(d.STOCK), ORDER: shown(d.ORDER), PROJECTS: shown(d.PROJECTS) };
}

/* ---------------- saving, with history ---------------- */
// Every save is also kept as hist/<rev>, so any of the last HIST_KEEP versions can be put back.
const histKey = rev => "hist/" + String(rev).padStart(8, "0");
async function saveVersion(store, data, what) {
  const cur = await store.get(DATA_KEY, { type: "json" });
  const doc = { rev: (cur ? cur.rev : 0) + 1, updatedAt: new Date().toISOString(), what: String(what || "Saved").slice(0, 200), data };
  await store.setJSON(DATA_KEY, doc);
  try {
    await store.setJSON(histKey(doc.rev), doc);
    const index = (await store.get(HIST_INDEX, { type: "json" })) || [];
    const next = [{ rev: doc.rev, updatedAt: doc.updatedAt, what: doc.what }, ...index.filter(h => h.rev !== doc.rev)];
    for (const old of next.slice(HIST_KEEP)) await store.delete(histKey(old.rev));
    await store.setJSON(HIST_INDEX, next.slice(0, HIST_KEEP));
  } catch (e) { console.error("history not saved:", e.message); } // the save itself already went through
  return doc;
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
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const want = Buffer.from(sign(exp)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
function passwordOk(given) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const hash = s => createHash("sha256").update(String(s ?? "")).digest(); // equal lengths, so the comparison takes the same time
  return timingSafeEqual(hash(given), hash(process.env.ADMIN_PASSWORD));
}

/* ---------------- helpers ---------------- */
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const err = (msg, status) => json({ error: msg }, status);
const js = (body, extra = {}) => new Response(body, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache, max-age=0, must-revalidate", ...extra } });
const SHAPE = ["DATA", "STOCK", "ORDER", "PROJECTS"];
const isObj = x => x && typeof x === "object" && !Array.isArray(x);
// The public page's code expects these shapes; anything else could stop it from drawing.
function validData(d) {
  if (!isObj(d)) return "no data";
  for (const k of SHAPE) if (!Array.isArray(d[k])) return k + " must be a list";
  if (typeof d.ENQ_TO !== "string" || typeof d.WA_NO !== "string") return "ENQ_TO and WA_NO must be text";
  for (const k of SHAPE) for (const it of d[k]) {
    if (!isObj(it)) return "every item in " + k + " must be an object";
    if (JSON.stringify(it).length > 400000) return "an item in " + k + " is too large — use an uploaded photo instead of an embedded one";
  }
  for (const B of d.DATA) {
    if (!Array.isArray(B.lots)) return "cargo block " + (B.block || "?") + " has no bundle list";
    for (const l of B.lots) if (!isObj(l) || typeof l.id !== "string" || !Array.isArray(l.net)) return "a bundle in block " + (B.block || "?") + " is incomplete";
  }
  for (const S of d.STOCK) if (typeof S.name !== "string" || !S.name) return "a stock item has no name";
  for (const O of d.ORDER) if (typeof O.name !== "string" || !O.name) return "a to-order item has no name";
  for (const P of d.PROJECTS) {
    if (typeof P.name !== "string" || !Array.isArray(P.shots)) return "a project has no name or photo list";
    // the site's Projects tab stops working if a project it shows has no photo
    if (!P.hidden && !(P.shots[0] && P.shots[0].img)) return `project “${P.name}” needs at least one photo to be shown on the site`;
  }
  return null;
}

/* ---------------- handler ---------------- */
export default async function handler(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const m = req.method;

  // The public page loads this before its own script. Whatever happens it must stay valid
  // JavaScript: on any problem the page simply uses the copy of the catalogue built into it.
  if (route === "data.js" && m === "GET") {
    try {
      const doc = await openStore().get(DATA_KEY, { type: "json" });
      if (!doc || !doc.data) return js("/* no live data yet: the page uses its built-in catalogue */");
      const etag = `"rev-${doc.rev}"`;
      if ((req.headers.get("if-none-match") || "").includes(etag)) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache, max-age=0, must-revalidate" } });
      return js("window.GM_LIVE=" + JSON.stringify(forSite(doc.data)).replace(/</g, "\\u003c") + ";", { etag });
    } catch (e) {
      console.error("data.js:", e.message);
      return js("/* live data unavailable: the page uses its built-in catalogue */");
    }
  }

  let store;
  try { store = openStore(); } catch (e) { return err("storage unavailable: " + e.message, 500); }

  try {
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
      // an uploaded photo never changes (a new upload gets a new name), so browsers and Netlify's edge may keep it
      return new Response(got.data, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "netlify-cdn-cache-control": "public, max-age=31536000, immutable, durable" } });
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
      const doc = await saveVersion(store, body.data, body.what);
      return json({ rev: doc.rev, updatedAt: doc.updatedAt });
    }
    if (route === "history" && m === "GET") {
      return json({ items: (await store.get(HIST_INDEX, { type: "json" })) || [] });
    }
    if (route.startsWith("history/") && m === "GET") {
      const rev = Number(route.slice(8));
      if (!Number.isInteger(rev) || rev < 1) return err("not found", 404);
      const doc = await store.get(histKey(rev), { type: "json" });
      return doc ? json(doc) : err("That version is no longer kept", 404);
    }
    if (route === "restore" && m === "POST") {
      const body = await req.json().catch(() => ({}));
      const rev = Number(body.rev);
      const old = Number.isInteger(rev) && rev > 0 ? await store.get(histKey(rev), { type: "json" }) : null;
      if (!old) return err("That version is no longer kept", 404);
      const cur = await store.get(DATA_KEY, { type: "json" });
      const curRev = cur ? cur.rev : 0;
      if (body.baseRev != null && body.baseRev !== curRev) return json({ error: "Someone else saved first. Reload to see their changes.", rev: curRev }, 409);
      const doc = await saveVersion(store, old.data, `Put back version ${old.rev} (“${old.what || "Saved"}”)`);
      return json({ rev: doc.rev, updatedAt: doc.updatedAt, data: doc.data });
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
    console.error("api:", route, e.message);
    return err("server error: " + e.message, 500);
  }
}
