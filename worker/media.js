// Site photos managed from the admin page (admin.html): the hero flyers, the gallery and the "Bands We Bring To Life" tiles.
//
// Settings live in the D1 database (binding "DB"); uploaded image files live in the R2 bucket (binding "MEDIA")
// and are served from /media/<file>. The original photos in /images keep working: the database just points at them.
//
// Flyers sit in two piles on the home page, left and right. Each flyer has a side and a stacking number (z):
// the highest z is the top of the pile (in front); the ones under it peek out behind at other angles.
//
//   GET    /api/media                       public: { flyers: [...], gallery: [...] } for the home page
//   GET    /media/<key>                     public: an uploaded image
//   -- admin only (Cloudflare Access login, or "Authorization: Bearer <ADMIN_TOKEN>" for local testing):
//   POST   /api/admin/upload?kind=...       upload one image (the page shrinks it first); returns its address
//   POST   /api/admin/flyers                { src, alt, stamp, visible, side, show_date, end_date }  add a flyer (on top of that pile)
//   PUT    /api/admin/flyers/:id            { src, alt, stamp, visible, show_date, end_date }  edit a flyer
//          show_date: the stamp appears the day after it. end_date: the flyer comes off the site that day.
//   DELETE /api/admin/flyers/:id                                    take a flyer off (the picture stays in the library)
//   PUT    /api/admin/flyer-order           { left: [ids], right: [ids] }  both piles, top first
//   POST   /api/admin/gallery               { src, alt, caption }  add a photo (goes to the end)
//   PUT    /api/admin/gallery/:id           { alt, caption } and/or { visible }   edit a photo's text / show or hide it
//   PUT    /api/admin/gallery-order         { ids: [...] }          new order
//   DELETE /api/admin/gallery/:id                                   take a photo out of the gallery (the picture stays in the library)
//   POST   /api/admin/bands                 { name, src, visible }  add a band to "Bands We Bring To Life" (goes to the end)
//   PUT    /api/admin/bands/:id             { name, src, visible }  edit a band (src '' = no picture, just the colour tile)
//   DELETE /api/admin/bands/:id                                     take a band off (its picture stays in the library)
//   PUT    /api/admin/band-order            { ids: [...] }          new order
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
  { slot: 1, src: "images/flyer.jpg", alt: "Upcoming show flyer", stamp: "ROCKED!", visible: 1, side: "left" },
  { slot: 2, src: "images/flyer2.jpg", alt: "Upcoming show flyer", stamp: "", visible: 1, side: "right" },
];
const MAX_FLYERS_PER_SIDE = 10;
const START_GALLERY = Array.from({ length: 33 }, (_, i) => `images/gallery/gallery-${i + 1}.jpg`);
// "Bands We Bring To Life": [name, picture file in images/bands]
const START_BANDS = [
  ["Stone Temple Pilots", "stone-temple-pilots.jpg"], ["Harvey Danger", "harvey-danger.jpg"], ["Blink 182", "blink-182.jpg"],
  ["Eve 6", "eve-6.jpg"], ["Weezer", "weezer.jpg"], ["Foo Fighters", "foo-fighters.jpg"], ["Fuel", "fuel.jpg"],
  ["Radiohead", "radiohead.jpg"], ["Creed", "creed.jpg"], ["Green Day", "green-day.jpg"], ["Pearl Jam", "pearl-jam.jpg"],
  ["Better Than Ezra", "better-than-ezra.jpg"], ["Spacehog", "spacehog.jpg"], ["Seven Mary 3", "seven-mary-3.jpg"],
  ["Everclear", "everclear.jpg"], ["Toadies", "toadies.jpg"], ["Kings of Leon", "kings-of-leon.jpg"], ["Sublime", "sublime.jpg"],
  ["Rage Against the Machine", "rage-against-the-machine.jpg"], ["HIM", "him.jpg"], ["Lenny Kravitz", "lenny-kravitz.jpg"],
  ["Bowling for Soup", "bowling-for-soup.jpg"], ["Blur", "blur.jpg"], ["Nirvana", "nirvana.jpg"], ["Lifehouse", "lifehouse.jpg"],
  ["Matchbox 20", "matchbox-20.jpg"], ["Eagle-Eye Cherry", "eagle-eye-cherry.jpg"], ["Violent Femmes", "violent-femmes.jpg"],
  ["Soundgarden", "soundgarden.jpg"], ["Collective Soul", "collective-soul.jpg"], ["Lemonheads", "lemonheads.jpg"],
  ["3 Doors Down", "3-doors-down.jpg"], ["Audioslave", "audioslave.jpg"], ["The Killers", "the-killers.jpg"], ["Local H", "local-h.jpg"],
  ["Lit", "lit.jpg"], ["James", "james.jpg"], ["Finger Eleven", "finger-eleven.jpg"], ["Beastie Boys", "beastie-boys.jpg"],
  ["Goo Goo Dolls", "goo-goo-dolls.jpg"], ["Jet", "jet.jpg"],
].map(([name, file]) => ({ name, src: `images/bands/${file}` }));
const MAX_BANDS = 200;

let ready = null;
function ensureSchema(db) {
  if (!ready) {
    ready = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS site_flyers (
          slot INTEGER PRIMARY KEY, src TEXT NOT NULL DEFAULT '', alt TEXT NOT NULL DEFAULT '',
          stamp TEXT NOT NULL DEFAULT '', visible INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0,
          side TEXT NOT NULL DEFAULT 'left', z INTEGER NOT NULL DEFAULT 0,
          show_date TEXT NOT NULL DEFAULT '', end_date TEXT NOT NULL DEFAULT '')`),
        db.prepare(`CREATE TABLE IF NOT EXISTS site_gallery (
          id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, alt TEXT NOT NULL DEFAULT '',
          caption TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS song_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS site_bands (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, src TEXT NOT NULL DEFAULT '',
          visible INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
      ]);
      // The bands list goes in once, ever, too.
      if (!(await db.prepare("SELECT v FROM song_settings WHERE k = 'bands_seeded'").first())) {
        const now = Date.now();
        await db.batch([
          ...START_BANDS.map((b, i) => db.prepare("INSERT INTO site_bands (name, src, sort, created_at) VALUES (?1, ?2, ?3, ?4)").bind(b.name, b.src, i + 1, now)),
          db.prepare("INSERT OR REPLACE INTO song_settings (k, v) VALUES ('bands_seeded', ?1)").bind(String(now)),
        ]);
      }
      // Added later: a gallery photo can be kept but left out of the carousel (visible = 0).
      const cols = (await db.prepare("PRAGMA table_info(site_gallery)").all()).results;
      if (!cols.some((c) => c.name === "visible")) {
        await db.prepare("ALTER TABLE site_gallery ADD COLUMN visible INTEGER NOT NULL DEFAULT 1").run();
      }
      // Added later: flyers in two piles. The original flyer 1 is the left pile, flyer 2 the right.
      const fcols = (await db.prepare("PRAGMA table_info(site_flyers)").all()).results;
      if (!fcols.some((c) => c.name === "side")) {
        await db.batch([
          db.prepare("ALTER TABLE site_flyers ADD COLUMN side TEXT NOT NULL DEFAULT 'left'"),
          db.prepare("ALTER TABLE site_flyers ADD COLUMN z INTEGER NOT NULL DEFAULT 0"),
          db.prepare("UPDATE site_flyers SET side = CASE WHEN slot = 2 THEN 'right' ELSE 'left' END, z = 1"),
        ]);
      }
      // Added later: the show's date (the stamp only appears once it has passed) and the date to take it down.
      if (!fcols.some((c) => c.name === "show_date")) {
        await db.batch([
          db.prepare("ALTER TABLE site_flyers ADD COLUMN show_date TEXT NOT NULL DEFAULT ''"),
          db.prepare("ALTER TABLE site_flyers ADD COLUMN end_date TEXT NOT NULL DEFAULT ''"),
        ]);
      }
      // Copy today's flyers and gallery in once, ever (never again, even if every photo is later removed).
      const seeded = await db.prepare("SELECT v FROM song_settings WHERE k = 'media_seeded'").first();
      if (!seeded) {
        const now = Date.now();
        await db.batch([
          ...START_FLYERS.map((f) => db.prepare("INSERT OR IGNORE INTO site_flyers (slot, src, alt, stamp, visible, updated_at, side, z) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)")
            .bind(f.slot, f.src, f.alt, f.stamp, f.visible, now, f.side)),
          ...START_GALLERY.map((src, i) => db.prepare("INSERT INTO site_gallery (src, alt, caption, sort, created_at) VALUES (?1, '', '', ?2, ?3)").bind(src, i + 1, now)),
          db.prepare("INSERT OR REPLACE INTO song_settings (k, v) VALUES ('media_seeded', ?1)").bind(String(now)),
        ]);
      }
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

async function state(db) {
  // Left pile then right pile, each from the top (front) down.
  const flyers = (await db.prepare("SELECT slot AS id, src, alt, stamp, visible, side, z, show_date, end_date FROM site_flyers ORDER BY side, z DESC, slot").all()).results
    .map((f) => ({ ...f, visible: !!f.visible }));
  const gallery = (await db.prepare("SELECT id, src, alt, caption, visible FROM site_gallery ORDER BY sort, id").all()).results
    .map((g) => ({ ...g, visible: !!g.visible }));
  const bands = (await db.prepare("SELECT id, name, src, visible FROM site_bands ORDER BY sort, id").all()).results
    .map((b) => ({ ...b, visible: !!b.visible }));
  return { flyers, gallery, bands };
}

// ---------- flyer dates ----------
// Dates are plain days (YYYY-MM-DD) where the band plays, so "today" is worked out in that time zone.
const SHOW_TZ = "America/New_York";
const todayLocal = () => new Intl.DateTimeFormat("en-CA", { timeZone: SHOW_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateOrBlank = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
const badDates = (d) => { const s = dateOrBlank(d.show_date), e = dateOrBlank(d.end_date); return !!(s && e && e <= s); };
// The flyers the site shows right now: switched on, with a picture, and not yet at their take-down date.
// A flyer's stamp only shows once its show date has passed (always, if it has no show date).
function liveFlyers(flyers, today = todayLocal()) {
  return flyers
    .filter((f) => f.visible && f.src && !(f.end_date && today >= f.end_date))
    .map((f) => ({ ...f, stamp: f.stamp && (!f.show_date || today > f.show_date) ? f.stamp : "" }));
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
export async function isAdmin(request, env) {
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
        flyers: liveFlyers(s.flyers).map(({ id, src, alt, stamp, side }) => ({ id, src, alt, stamp, side })),
        gallery: s.gallery.filter((g) => g.visible).map(({ id, src, alt, caption }) => ({ id, src, alt, caption })),
      });
    }

    if (!path.startsWith("/api/admin/")) return json({ ok: false, error: "Not found" }, 404);
    if (!(await isAdmin(request, env))) return json({ ok: false, error: "Please sign in again." }, 403);
    const parts = path.split("/").filter(Boolean).slice(2);   // after "api/admin"

    // Who am I / everything for the admin page
    if (parts[0] === "state" && method === "GET") {
      return json({ ok: true, email: (await accessEmail(request, env)) || "local test", uploads: !!env.MEDIA, today: todayLocal(), ...(await state(db)) });
    }

    // Upload one image (raw body, already shrunk by the admin page)
    if (parts[0] === "upload" && method === "POST") {
      if (!env.MEDIA) return json({ ok: false, error: "Photo storage (R2) isn't set up yet." }, 503);
      const kind = ["flyer", "band"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "gallery";
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
      const builtIn = [...new Set([...START_FLYERS.map((f) => f.src), ...START_GALLERY, ...START_BANDS.map((b) => b.src)])].map((src) => ({ src, builtIn: true }));
      return json({ ok: true, files: [...files.filter((f) => okSrc(f.src)), ...builtIn] });
    }
    // Delete an uploaded picture for good (only when no flyer or gallery photo uses it; built-in photos can't be deleted).
    if (parts[0] === "library" && parts.length === 1 && method === "DELETE") {
      const src = clean(url.searchParams.get("src"), 300);
      if (!src.startsWith("/media/") || !okSrc(src)) return json({ ok: false, error: "Only uploaded pictures can be deleted." }, 400);
      const { n } = await db.prepare("SELECT (SELECT COUNT(*) FROM site_gallery WHERE src = ?1) + (SELECT COUNT(*) FROM site_flyers WHERE src = ?1) + (SELECT COUNT(*) FROM site_bands WHERE src = ?1) AS n").bind(src).first();
      if (n) return json({ ok: false, error: "That picture is still being used. Take it off the flyer, gallery photo or band first." }, 409);
      if (env.MEDIA) await env.MEDIA.delete(src.slice("/media/".length));
      return json({ ok: true });
    }

    // Flyers: add (on top of its pile)
    if (parts[0] === "flyers" && parts.length === 1 && method === "POST") {
      let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const src = clean(d.src, 300);
      if (!okSrc(src)) return json({ ok: false, error: "Choose a picture for the flyer first." }, 400);
      if (badDates(d)) return json({ ok: false, error: "The take-down date has to be after the show date." }, 400);
      const side = d.side === "right" ? "right" : "left";
      const { n, m } = await db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(z), 0) AS m FROM site_flyers WHERE side = ?1").bind(side).first();
      if (n >= MAX_FLYERS_PER_SIDE) return json({ ok: false, error: `That pile is full (${MAX_FLYERS_PER_SIDE} flyers). Remove one first.` }, 400);
      await db.prepare("INSERT INTO site_flyers (src, alt, stamp, visible, updated_at, side, z, show_date, end_date) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
        .bind(src, clean(d.alt, 200) || "Upcoming show flyer", clean(d.stamp, 20), d.visible === false ? 0 : 1, Date.now(), side, m + 1,
          dateOrBlank(d.show_date), dateOrBlank(d.end_date)).run();
      return json({ ok: true, ...(await state(db)) });
    }
    // Flyers: edit / take off
    if (parts[0] === "flyers" && parts.length === 2) {
      const id = Number(parts[1]);
      if (!Number.isInteger(id) || id < 1 || !(await db.prepare("SELECT 1 FROM site_flyers WHERE slot = ?1").bind(id).first())) {
        return json({ ok: false, error: "That flyer isn't there any more. Reload the page." }, 404);
      }
      if (method === "PUT") {
        let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
        const src = clean(d.src, 300);
        if (!okSrc(src)) return json({ ok: false, error: "Choose a picture for the flyer first." }, 400);
      if (badDates(d)) return json({ ok: false, error: "The take-down date has to be after the show date." }, 400);
        await db.prepare("UPDATE site_flyers SET src = ?1, alt = ?2, stamp = ?3, visible = ?4, updated_at = ?5, show_date = ?6, end_date = ?7 WHERE slot = ?8")
          .bind(src, clean(d.alt, 200) || "Upcoming show flyer", clean(d.stamp, 20), d.visible ? 1 : 0, Date.now(),
            dateOrBlank(d.show_date), dateOrBlank(d.end_date), id).run();
        return json({ ok: true, ...(await state(db)) });
      }
      if (method === "DELETE") {
        await db.prepare("DELETE FROM site_flyers WHERE slot = ?1").bind(id).run();   // the picture stays in the library
        return json({ ok: true, ...(await state(db)) });
      }
    }
    // Flyers: restack both piles (also moves a flyer from one pile to the other). Lists are top first.
    if (parts[0] === "flyer-order" && method === "PUT") {
      let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const ids = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_FLYERS_PER_SIDE) : []);
      const left = ids(d.left), right = ids(d.right);
      const stmts = [];
      [["left", left], ["right", right]].forEach(([side, list]) => list.forEach((id, i) => {
        stmts.push(db.prepare("UPDATE site_flyers SET side = ?1, z = ?2 WHERE slot = ?3").bind(side, list.length - i, id));
      }));
      if (stmts.length) await db.batch(stmts);
      return json({ ok: true, ...(await state(db)) });
    }

    // Bands We Bring To Life: add (at the end) / edit / take off / new order
    if (parts[0] === "bands" && parts.length === 1 && method === "POST") {
      let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const name = clean(d.name, 80), src = clean(d.src, 300);
      if (!name) return json({ ok: false, error: "Type the band's name." }, 400);
      if (src && !okSrc(src)) return json({ ok: false, error: "That image address isn't allowed." }, 400);
      const { n, m } = await db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(sort), 0) AS m FROM site_bands").first();
      if (n >= MAX_BANDS) return json({ ok: false, error: "That's a lot of bands! Remove one first." }, 400);
      if (await db.prepare("SELECT 1 FROM site_bands WHERE lower(name) = lower(?1)").bind(name).first()) return json({ ok: false, error: `${name} is already on the list.` }, 409);
      await db.prepare("INSERT INTO site_bands (name, src, visible, sort, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(name, src, d.visible === false ? 0 : 1, m + 1, Date.now()).run();
      return json({ ok: true, ...(await state(db)) });
    }
    if (parts[0] === "band-order" && method === "PUT") {
      let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const ids = Array.isArray(d.ids) ? d.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_BANDS) : [];
      if (ids.length) await db.batch(ids.map((id, i) => db.prepare("UPDATE site_bands SET sort = ?1 WHERE id = ?2").bind(i + 1, id)));
      return json({ ok: true, ...(await state(db)) });
    }
    if (parts[0] === "bands" && parts.length === 2) {
      const id = Number(parts[1]);
      if (!Number.isInteger(id) || id < 1 || !(await db.prepare("SELECT 1 FROM site_bands WHERE id = ?1").bind(id).first())) {
        return json({ ok: false, error: "That band isn't there any more. Reload the page." }, 404);
      }
      if (method === "PUT") {
        let d; try { d = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
        const name = clean(d.name, 80), src = clean(d.src, 300);
        if (!name) return json({ ok: false, error: "Type the band's name." }, 400);
        if (src && !okSrc(src)) return json({ ok: false, error: "That image address isn't allowed." }, 400);
        if (await db.prepare("SELECT 1 FROM site_bands WHERE lower(name) = lower(?1) AND id <> ?2").bind(name, id).first()) return json({ ok: false, error: `${name} is already on the list.` }, 409);
        await db.prepare("UPDATE site_bands SET name = ?1, src = ?2, visible = ?3 WHERE id = ?4").bind(name, src, d.visible ? 1 : 0, id).run();
        return json({ ok: true, ...(await state(db)) });
      }
      if (method === "DELETE") {
        await db.prepare("DELETE FROM site_bands WHERE id = ?1").bind(id).run();   // the picture stays in the library
        return json({ ok: true, ...(await state(db)) });
      }
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

// The home page (/) with the flyer piles and the band tiles built in, so a hidden flyer is never sent and nothing
// flashes on screen. If the database can't be read, the page is sent as-is (with the two original flyers that are
// written into index.html, and app.js builds the built-in band list).
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Where each flyer in a pile sits, by depth (0 = top of the pile). Angles and offsets are for the left pile;
// the right pile is the mirror image. Offsets are a share of the flyer's own size, and push the flyers underneath
// outwards and upwards so they peek out without covering the hero text. Deeper than this, the pattern repeats.
const PILE_SPOTS = [
  { r: -15, x: 0, y: 0 },
  { r: -3, x: -13, y: -15 },
  { r: -29, x: -17, y: -4 },
  { r: 5, x: -5, y: -23 },
  { r: -35, x: -21, y: -14 },
];
function flyerPilesHtml(flyers) {
  let order = 0;   // the order the full-size viewer goes through them: left pile top to bottom, then the right pile
  return ["left", "right"].map((side) => {
    const pile = flyers.filter((f) => f.side === side && f.visible && f.src);   // already top first
    if (!pile.length) return "";
    const mirror = side === "right" ? -1 : 1;
    const boxes = pile.map((f, depth) => {
      const spot = depth === 0 ? PILE_SPOTS[0] : PILE_SPOTS[1 + ((depth - 1) % (PILE_SPOTS.length - 1))];
      const r = spot.r * mirror, x = spot.x * mirror;
      const style = `--r:${r}deg;--rh:${r < 0 ? 5 : -5}deg;--x:${x}%;--y:${spot.y}%;z-index:${pile.length - depth}`;
      const stamp = f.stamp ? ` data-stamp="${escapeHtml(f.stamp)}"` : "";
      return `<div class="next-show${depth === 0 ? " is-top" : ""}" style="${style}">` +
        `<span class="next-show-tape"></span>` +
        `<img src="${escapeHtml(f.src)}" alt="${escapeHtml(f.alt || "Upcoming show flyer")}" class="next-show-img lightbox-trigger"` +
        ` data-lightbox-group="flyer" data-order="${order++}"${stamp} data-cta-href="#shows" data-cta-label="See Upcoming Shows">` +
        (f.stamp ? `<span class="next-show-stamp" aria-hidden="true">${escapeHtml(f.stamp)}</span>` : "") +
        `</div>`;
    });
    // Bottom of the pile first in the page, so each flyer is drawn over the ones beneath it.
    return `<div class="flyer-pile flyer-pile-${side}">${boxes.reverse().join("")}</div>`;
  }).join("");
}
// "Bands We Bring To Life" tiles. A band with no picture shows a colour gradient worked out from its name
// (the same sum as hueFromName in app.js).
function bandHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}
function bandTilesHtml(bands) {
  return bands.filter((b) => b.visible && b.name).map((b) =>
    `<li class="cover-band-art" style="--hue:${bandHue(b.name)}">` +
    (b.src ? `<img class="cover-band-photo" src="${escapeHtml(b.src)}" alt="" loading="lazy">` : "") +
    `<span class="cover-band-name">${escapeHtml(b.name)}</span></li>`).join("");
}
export async function homePage(request, env) {
  // Ask for the full file every time (no "has it changed?" check), since what we send depends on the settings.
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const page = await env.ASSETS.fetch(new Request(request, { headers }));
  if (page.status !== 200 || !(page.headers.get("Content-Type") || "").includes("text/html") || !env.DB) return page;

  let s;
  try {
    await ensureSchema(env.DB);
    s = await state(env.DB);
  } catch (err) {
    console.error("Home page flyers/bands", err && err.message ? err.message : err);
    return page;
  }

  const piles = flyerPilesHtml(liveFlyers(s.flyers));
  const tiles = bandTilesHtml(s.bands);
  const out = new HTMLRewriter()
    .on("#next-shows", { element: (el) => { el.setInnerContent(piles, { html: true }); } })
    // data-filled tells app.js the tiles are already there (otherwise it builds its own built-in list)
    .on("#cover-bands-grid", { element: (el) => { el.setInnerContent(tiles, { html: true }); el.setAttribute("data-filled", "1"); } })
    .transform(page);
  const res = new Response(out.body, out);
  res.headers.delete("ETag");
  res.headers.set("Cache-Control", "no-cache");
  return res;
}
