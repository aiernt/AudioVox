// Site photos managed from the admin page (admin.html): the two hero flyers and the gallery.
//
// Settings live in the D1 database (binding "DB"); uploaded image files live in the R2 bucket (binding "MEDIA")
// and are served from /media/<file>. The original photos in /images keep working: the database just points at them.
//
//   GET    /api/media                       public: { flyers: [...], gallery: [...] } for the home page
//   GET    /media/<key>                     public: an uploaded image
//   -- admin only (Cloudflare Access login, or "Authorization: Bearer <ADMIN_TOKEN>" for local testing):
//   POST   /api/admin/upload?kind=...       upload one image (the page shrinks it first); returns its address
//   PUT    /api/admin/flyers/:slot          { src, alt, stamp, visible }  update flyer 1 or 2
//   POST   /api/admin/gallery               { src, alt, caption }  add a photo (goes to the end)
//   PUT    /api/admin/gallery/:id           { alt, caption } and/or { visible }   edit a photo's text / show or hide it
//   PUT    /api/admin/gallery-order         { ids: [...] }          new order
//   DELETE /api/admin/gallery/:id                                   take a photo out of the gallery (the picture stays in the library)
//   GET    /api/admin/library                                       every picture that can be reused (uploads + built-in photos)
//   DELETE /api/admin/library?src=/media/...                        delete an unused upload for good
//
// Admin access is checked here too (not only by Cloudflare Access), so the admin API can't be reached any other way.
// Settings: ACCESS_TEAM_DOMAIN (e.g. "audiovox.cloudflareaccess.com") and ACCESS_AUD (the Access application's
// "Application Audience (AUD) Tag"). ADMIN_TOKEN also works, for local testing.

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max) : "");

// The starting content: today's photos, so nothing disappears when the site switches over.
const START_FLYERS = [
  { slot: 1, src: "images/flyer.jpg", alt: "Upcoming show flyer", stamp: "ROCKED!", visible: 1 },
  { slot: 2, src: "images/flyer2.jpg", alt: "Upcoming show flyer", stamp: "", visible: 1 },
];
const START_GALLERY = Array.from({ length: 33 }, (_, i) => `images/gallery/gallery-${i + 1}.jpg`);

let ready = null;
function ensureSchema(db) {
  if (!ready) {
    ready = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS site_flyers (
          slot INTEGER PRIMARY KEY, src TEXT NOT NULL DEFAULT '', alt TEXT NOT NULL DEFAULT '',
          stamp TEXT NOT NULL DEFAULT '', visible INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS site_gallery (
          id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, alt TEXT NOT NULL DEFAULT '',
          caption TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS song_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
      ]);
      // Added later: a gallery photo can be kept but left out of the carousel (visible = 0).
      const cols = (await db.prepare("PRAGMA table_info(site_gallery)").all()).results;
      if (!cols.some((c) => c.name === "visible")) {
        await db.prepare("ALTER TABLE site_gallery ADD COLUMN visible INTEGER NOT NULL DEFAULT 1").run();
      }
      // Copy today's flyers and gallery in once, ever (never again, even if every photo is later removed).
      const seeded = await db.prepare("SELECT v FROM song_settings WHERE k = 'media_seeded'").first();
      if (!seeded) {
        const now = Date.now();
        await db.batch([
          ...START_FLYERS.map((f) => db.prepare("INSERT OR IGNORE INTO site_flyers (slot, src, alt, stamp, visible, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .bind(f.slot, f.src, f.alt, f.stamp, f.visible, now)),
          ...START_GALLERY.map((src, i) => db.prepare("INSERT INTO site_gallery (src, alt, caption, sort, created_at) VALUES (?1, '', '', ?2, ?3)").bind(src, i + 1, now)),
          db.prepare("INSERT OR REPLACE INTO song_settings (k, v) VALUES ('media_seeded', ?1)").bind(String(now)),
        ]);
      }
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

async function state(db) {
  const flyers = (await db.prepare("SELECT slot, src, alt, stamp, visible FROM site_flyers ORDER BY slot").all()).results
    .map((f) => ({ ...f, visible: !!f.visible }));
  const gallery = (await db.prepare("SELECT id, src, alt, caption, visible FROM site_gallery ORDER BY sort, id").all()).results
    .map((g) => ({ ...g, visible: !!g.visible }));
  return { flyers, gallery };
}

// ---------- admin check: Cloudflare Access login ----------
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
let certs = null, certsAt = 0;
async function accessKeys(team) {
  if (certs && Date.now() - certsAt < 3600_000) return certs;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  certs = (await res.json()).keys || []; certsAt = Date.now();
  return certs;
}
// Returns the signed-in email if the request carries a valid Cloudflare Access login for this app, otherwise "".
async function accessEmail(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return "";
  try {
    const [h, p, sig] = jwt.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    const team = String(env.ACCESS_TEAM_DOMAIN).trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");   // accepts "x.cloudflareaccess.com" or "https://x.cloudflareaccess.com/"
    const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!jwk) return "";
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!valid || !aud.includes(env.ACCESS_AUD) || payload.exp * 1000 < Date.now()) return "";
    return payload.email || "admin";
  } catch { return ""; }
}
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
async function isAdmin(request, env) {
  if (await accessEmail(request, env)) return true;
  return !!env.ADMIN_TOKEN && sameSecret(request.headers.get("Authorization") || "", `Bearer ${env.ADMIN_TOKEN}`);
}

// Only our own images: site files under images/, or uploads under /media/.
const okSrc = (s) => /^(images\/[A-Za-z0-9_\-\/]+\.(jpe?g|png|webp)|\/media\/[a-z]+\/[A-Za-z0-9\-]+\.(jpg|png|webp))$/.test(s);

async function readJson(request) {
  const text = await request.text();
  if (text.length > 20000) throw new Error("too large");
  const data = JSON.parse(text || "{}");
  if (!data || typeof data !== "object") throw new Error("bad body");
  return data;
}

export async function handleMedia(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Uploaded images
  if (path.startsWith("/media/")) {
    if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    if (!env.MEDIA) return new Response("Not found", { status: 404 });
    const key = path.slice("/media/".length);
    if (!/^[a-z]+\/[A-Za-z0-9\-]+\.(jpg|png|webp)$/.test(key)) return new Response("Not found", { status: 404 });
    const obj = await env.MEDIA.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");   // every upload gets a new name, so it can be cached forever
    return new Response(method === "HEAD" ? null : obj.body, { headers });
  }

  if (!env.DB) return json({ ok: false, error: "The database isn't set up yet." }, 503);
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return json({ ok: false, error: "Forbidden" }, 403);
  }

  try {
    await ensureSchema(env.DB);
    const db = env.DB;

    // Public: what the home page shows
    if (path === "/api/media" && method === "GET") {
      const s = await state(db);
      return json({
        ok: true,
        flyers: s.flyers.filter((f) => f.visible && f.src),
        gallery: s.gallery.filter((g) => g.visible).map(({ id, src, alt, caption }) => ({ id, src, alt, caption })),
      });
    }

    if (!path.startsWith("/api/admin/")) return json({ ok: false, error: "Not found" }, 404);
    if (!(await isAdmin(request, env))) return json({ ok: false, error: "Please sign in again." }, 403);
    const parts = path.split("/").filter(Boolean).slice(2);   // after "api/admin"

    // Who am I / everything for the admin page
    if (parts[0] === "state" && method === "GET") {
      return json({ ok: true, email: (await accessEmail(request, env)) || "local test", uploads: !!env.MEDIA, ...(await state(db)) });
    }

    // Upload one image (raw body, already shrunk by the admin page)
    if (parts[0] === "upload" && method === "POST") {
      if (!env.MEDIA) return json({ ok: false, error: "Photo storage (R2) isn't set up yet." }, 503);
      const kind = url.searchParams.get("kind") === "flyer" ? "flyer" : "gallery";
      const type = (request.headers.get("Content-Type") || "").split(";")[0].trim();
      const ext = ALLOWED_TYPES[type];
      if (!ext) return json({ ok: false, error: "Please upload a JPG, PNG or WebP image." }, 400);
      const body = await request.arrayBuffer();
      if (!body.byteLength) return json({ ok: false, error: "That file was empty." }, 400);
      if (body.byteLength > MAX_UPLOAD_BYTES) return json({ ok: false, error: "That image is too big (8MB max)." }, 413);
      const key = `${kind}/${crypto.randomUUID()}.${ext}`;
      await env.MEDIA.put(key, body, { httpMetadata: { contentType: type } });
      return json({ ok: true, src: `/media/${key}` });
    }

    // The picture library, for reusing a picture: every upload (newest first) plus the photos built into the site.
    if (parts[0] === "library" && parts.length === 1 && method === "GET") {
      const files = [];
      if (env.MEDIA) {
        let cursor;
        do {
          const page = await env.MEDIA.list({ cursor, limit: 1000 });
          for (const o of page.objects) files.push({ src: `/media/${o.key}`, uploaded: o.uploaded ? new Date(o.uploaded).getTime() : 0 });
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor && files.length < 5000);
        files.sort((a, b) => b.uploaded - a.uploaded);
      }
      const builtIn = [...new Set([...START_FLYERS.map((f) => f.src), ...START_GALLERY])].map((src) => ({ src, builtIn: true }));
      return json({ ok: true, files: [...files.filter((f) => okSrc(f.src)), ...builtIn] });
    }
    // Delete an uploaded picture for good (only when no flyer or gallery photo uses it; built-in photos can't be deleted).
    if (parts[0] === "library" && parts.length === 1 && method === "DELETE") {
      const src = clean(url.searchParams.get("src"), 300);
      if (!src.startsWith("/media/") || !okSrc(src)) return json({ ok: false, error: "Only uploaded pictures can be deleted." }, 400);
      const { n } = await db.prepare("SELECT (SELECT COUNT(*) FROM site_gallery WHERE src = ?1) + (SELECT COUNT(*) FROM site_flyers WHERE src = ?1) AS n").bind(src).first();
      if (n) return json({ ok: false, error: "That picture is still being used. Take it out of the gallery or flyer first." }, 409);
      if (env.MEDIA) await env.MEDIA.delete(src.slice("/media/".length));
      return json({ ok: true });
    }

    // Flyers 1 and 2
    if (parts[0] === "flyers" && parts.length === 2 && method === "PUT") {
      const slot = Number(parts[1]);
      if (slot !== 1 && slot !== 2) return json({ ok: false, error: "Not found" }, 404);
      let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const src = clean(d.src, 300);
      if (src && !okSrc(src)) return json({ ok: false, error: "That image address isn't allowed." }, 400);
      await db.prepare(`INSERT INTO site_flyers (slot, src, alt, stamp, visible, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT (slot) DO UPDATE SET src = ?2, alt = ?3, stamp = ?4, visible = ?5, updated_at = ?6`)
        .bind(slot, src, clean(d.alt, 200) || "Upcoming show flyer", clean(d.stamp, 20), d.visible ? 1 : 0, Date.now()).run();
      return json({ ok: true, ...(await state(db)) });
    }

    // Gallery: add
    if (parts[0] === "gallery" && parts.length === 1 && method === "POST") {
      let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const src = clean(d.src, 300);
      if (!okSrc(src)) return json({ ok: false, error: "That image address isn't allowed." }, 400);
      if (await db.prepare("SELECT 1 FROM site_gallery WHERE src = ?1").bind(src).first()) return json({ ok: false, error: "That picture is already in the gallery." }, 409);
      const { m } = await db.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM site_gallery").first();
      await db.prepare("INSERT INTO site_gallery (src, alt, caption, sort, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(src, clean(d.alt, 200), clean(d.caption, 300), m + 1, Date.now()).run();
      return json({ ok: true, ...(await state(db)) });
    }
    // Gallery: new order
    if (parts[0] === "gallery-order" && method === "PUT") {
      let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const ids = Array.isArray(d.ids) ? d.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 2000) : [];
      if (ids.length) await db.batch(ids.map((id, i) => db.prepare("UPDATE site_gallery SET sort = ?1 WHERE id = ?2").bind(i + 1, id)));
      return json({ ok: true, ...(await state(db)) });
    }
    // Gallery: edit text / remove
    if (parts[0] === "gallery" && parts.length === 2) {
      const id = Number(parts[1]);
      if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: "Not found" }, 404);
      const row = await db.prepare("SELECT src FROM site_gallery WHERE id = ?1").bind(id).first();
      if (!row) return json({ ok: false, error: "Not found" }, 404);
      if (method === "PUT") {
        let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
        // Either the text (alt + caption), the "show in the carousel" switch, or both.
        if ("alt" in d || "caption" in d) {
          await db.prepare("UPDATE site_gallery SET alt = ?1, caption = ?2 WHERE id = ?3").bind(clean(d.alt, 200), clean(d.caption, 300), id).run();
        }
        if ("visible" in d) await db.prepare("UPDATE site_gallery SET visible = ?1 WHERE id = ?2").bind(d.visible ? 1 : 0, id).run();
        return json({ ok: true, ...(await state(db)) });
      }
      if (method === "DELETE") {
        // Only takes it out of the gallery: the picture stays in the library so it can be used again
        // (it's deleted for good from the library, DELETE /api/admin/library).
        await db.prepare("DELETE FROM site_gallery WHERE id = ?1").bind(id).run();
        return json({ ok: true, ...(await state(db)) });
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  } catch (err) {
    console.error("Media error", err && err.message ? err.message : err);
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
}

// The home page (/) with the admin page's flyer settings already applied, so a hidden flyer is never sent and
// never flashes on screen before the page's script catches up. If the database can't be read, the page is sent
// as-is and the script in app.js applies the settings instead.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export async function homePage(request, env) {
  // Ask for the full file every time (no "has it changed?" check), since what we send depends on the settings.
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const page = await env.ASSETS.fetch(new Request(request, { headers }));
  if (page.status !== 200 || !(page.headers.get("Content-Type") || "").includes("text/html") || !env.DB) return page;

  let flyers;
  try {
    await ensureSchema(env.DB);
    flyers = (await state(env.DB)).flyers;
  } catch (err) {
    console.error("Home page flyers", err && err.message ? err.message : err);
    return page;
  }

  let rewriter = new HTMLRewriter();
  [["next-show", "next-show-img", 1], ["next-show-2", "next-show-img-2", 2]].forEach(([boxId, imgId, slot]) => {
    const f = flyers.find((x) => x.slot === slot);
    if (!f || !f.visible || !f.src) {
      rewriter = rewriter.on(`#${boxId}`, { element: (el) => el.remove() });
      return;
    }
    rewriter = rewriter
      .on(`#${imgId}`, {
        element: (el) => {
          el.setAttribute("src", f.src);
          el.setAttribute("alt", f.alt || "Upcoming show flyer");
          if (f.stamp) el.setAttribute("data-stamp", f.stamp); else el.removeAttribute("data-stamp");
        },
      })
      .on(`#${boxId} .next-show-stamp`, { element: (el) => el.remove() })
      .on(`#${boxId}`, {
        element: (el) => {
          if (f.stamp) el.append(`<span class="next-show-stamp" aria-hidden="true">${escapeHtml(f.stamp)}</span>`, { html: true });
        },
      });
  });

  const out = rewriter.transform(page);
  const res = new Response(out.body, out);
  res.headers.delete("ETag");
  res.headers.set("Cache-Control", "no-cache");
  return res;
}
