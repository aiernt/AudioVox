// "Songs We Should Learn": the shared, public song-request list (song-requests.html).
// Stored in a Cloudflare D1 database (binding "DB", see wrangler.jsonc) and served from /api/songs*.
//
// Fans search Spotify (through this Worker, so the app keys stay secret), then add a song or vote for one
// already on the list. Every rule is checked here, on the server, so it can't be skipped:
//   - songs released from 1989 to now
//   - no songs with an explicit word spelled out in the TITLE (explicit lyrics and masked spellings are fine)
//   - songs the band already plays (KNOWN_SONGS) can't be requested
//   - a quick math check before adding, 5 new songs per visitor per hour, one vote per song per visitor
//   - every added song is looked up on Spotify by the server, so made-up songs can't be added
//
//   GET    /api/songs                 the list, most votes first (plus the band's "already play" list)
//   GET    /api/songs/search?q=...    search Spotify (cached; rate-limited per visitor)
//   GET    /api/songs/challenge       a fresh "what's 3 + 4?" question
//   POST   /api/songs/unlock          answer the question -> a pass that allows adding for a few hours
//   POST   /api/songs                 add a song {sp: Spotify track id, unlock}; a listed song just gets a vote
//   POST   /api/songs/:id/vote        vote for a song
//   DELETE /api/songs/:id/vote        take your vote back
//   -- band only ("Authorization: Bearer <ADMIN_TOKEN>"; open /song-requests#admin=TOKEN once per device):
//   DELETE /api/songs/:id             remove a song
//   GET    /api/songs/export          download the list as a spreadsheet (CSV)
//   POST   /api/songs/test-email      send a test "new song" email and show Resend's reply
//
// Settings (Cloudflare dashboard -> Workers & Pages -> audiovox -> Settings -> Variables and secrets):
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET  (secrets) the Spotify app keys
//   ADMIN_TOKEN  (secret) lets the band remove songs and export the list
//   SONG_NOTIFY  (text)   emails BOOKING_TO via Resend when a fan adds a song. On by default; "off" turns it off.
//   VOTE_SALT    (secret) optional extra salt for the hashed visitor ids

const MIN_YEAR = 1989;
const LIST_LIMIT = 500;            // most songs the list will hold (stops a flood)
const NEW_SONGS_PER_HOUR = 5;      // per visitor
const VOTES_PER_HOUR = 60;         // per visitor (votes and un-votes each)
const SEARCHES_PER_MINUTE = 30;    // per visitor
const CHALLENGES_PER_HOUR = 30;    // per visitor
const CHALLENGE_TTL = 30 * 60 * 1000;
const UNLOCK_TTL = 4 * 3600 * 1000;
const HOUR = 3600 * 1000;
const SEARCH_CACHE_SECONDS = 6 * 3600;

// Songs the band already plays. Most match by TITLE alone, so cover versions by other artists are caught too.
// Entries marked true have a very common title (e.g. "Higher", "Black"), so they also need the artist to match.
const KNOWN_SONGS = [
  ["Plush", "Stone Temple Pilots"], ["Flagpole Sitta", "Harvey Danger"], ["All the Small Things", "blink-182"],
  ["Inside Out", "Eve 6", true], ["When I Come Around", "Green Day"], ["Say It Ain't So", "Weezer"],
  ["Everlong", "Foo Fighters"], ["Hemorrhage (In My Hands)", "Fuel"], ["Creep", "Radiohead"],
  ["Higher", "Creed", true], ["Welcome to Paradise", "Green Day"], ["Jeremy", "Pearl Jam", true],
  ["Good", "Better Than Ezra", true], ["Basket Case", "Green Day"], ["In the Meantime", "Spacehog", true],
  ["Cumbersome", "Seven Mary Three"], ["Santa Monica", "Everclear", true], ["By the Way", "Red Hot Chili Peppers", true],
  ["Possum Kingdom", "Toadies"], ["Sex on Fire", "Kings of Leon"], ["What I Got", "Sublime"],
  ["Killing in the Name", "Rage Against the Machine"], ["Wicked Game", "Chris Isaak"], ["Wicked Game", "HIM"], ["Santeria", "Sublime"],
  ["Are You Gonna Go My Way", "Lenny Kravitz"], ["Baby One More Time", "Bowling for Soup"], ["Song 2", "Blur", true],
  ["Smells Like Teen Spirit", "Nirvana"], ["Hanging by a Moment", "Lifehouse"], ["Release", "Pearl Jam", true],
  ["Shimmer", "Fuel", true], ["3 AM", "Matchbox Twenty", true], ["Save Tonight", "Eagle-Eye Cherry", true],
  ["Blister in the Sun", "Violent Femmes"], ["Unglued", "Stone Temple Pilots", true], ["Fell on Black Days", "Soundgarden"],
  ["Heavy", "Collective Soul", true], ["Mrs. Robinson", "The Lemonheads"], ["Hitchin' a Ride", "Green Day"],
  ["Kryptonite", "3 Doors Down"], ["Like a Stone", "Audioslave"], ["Come as You Are", "Nirvana"],
  ["Mr. Brightside", "The Killers"], ["Bound for the Floor", "Local H"], ["My Own Worst Enemy", "Lit"],
  ["Black", "Pearl Jam", true], ["Laid", "James", true], ["Paralyzer", "Finger Eleven"],
  ["Fight for Your Right", "Beastie Boys"], ["Slide", "Goo Goo Dolls", true], ["Are You Gonna Be My Girl", "Jet"],
];

// The band's starting shortlist. Added ONCE, the very first time the list is created (never again, even if
// the list is later emptied). Spotify details are filled in automatically: [song, artist, year]
const SEED_SONGS = [
  ["Black Hole Sun", "Soundgarden", 1994], ["Lithium", "Nirvana", 1991], ["Even Flow", "Pearl Jam", 1991],
  ["Today", "The Smashing Pumpkins", 1993], ["Interstate Love Song", "Stone Temple Pilots", 1994],
  ["Semi-Charmed Life", "Third Eye Blind", 1997], ["Mr. Jones", "Counting Crows", 1993], ["Cannonball", "The Breeders", 1993],
  ["Zombie", "The Cranberries", 1994], ["Closing Time", "Semisonic", 1998], ["Hey Jealousy", "Gin Blossoms", 1992],
];

// Explicit words that keep a song off the list when they're spelled out in the TITLE (whole words only,
// so "Cocktail" or "Dickens" are fine; masked spellings like "F**k" are allowed).
const BLOCKED_TITLE_WORDS = ["fuck", "fucking", "fucked", "fucker", "fuckin", "motherfucker", "shit", "shitty", "shithead", "bullshit", "horseshit", "dipshit",
  "bitch", "bitches", "cunt", "cock", "cocksucker", "dick", "dickhead", "pussy", "whore", "slut", "bastard", "asshole", "tits", "cum", "wank",
  "nigger", "nigga", "faggot", "fag", "retard"];
const blockedTitleRx = new RegExp("(?:^|[^a-z])(?:" + BLOCKED_TITLE_WORDS.join("|") + ")(?:$|[^a-z])", "i");

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const titleKey = (song) => norm(String(song).replace(/[\(\[].*?[\)\]]/g, ""));   // "Everlong (Acoustic)" -> "everlong"
const artistKey = (a) => norm(String(a).replace(/^the\s+/i, ""));
const songKey = (song, artist) => `${titleKey(song)}|${artistKey(artist)}`;
const explicitTitle = (song) => blockedTitleRx.test(String(song).normalize("NFKD").replace(/[̀-ͯ]/g, ""));
const inYearRange = (year) => year >= MIN_YEAR && year <= new Date().getUTCFullYear();

const knownByTitle = new Set(KNOWN_SONGS.filter((k) => !k[2]).map((k) => titleKey(k[0])));
const knownStrict = KNOWN_SONGS.filter((k) => k[2]).map((k) => ({ title: titleKey(k[0]), artist: artistKey(k[1]) }));
function isKnown(song, artist) {
  const t = titleKey(song);
  if (knownByTitle.has(t)) return true;
  const a = norm(artist);
  return knownStrict.some((k) => k.title === t && a.includes(k.artist));
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const isAdmin = (request, env) => !!env.ADMIN_TOKEN && sameSecret(request.headers.get("Authorization") || "", `Bearer ${env.ADMIN_TOKEN}`);

// A visitor is only ever stored as a salted hash of their IP address. The raw IP is never saved.
async function visitorId(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${env.VOTE_SALT || "audiovox-songs"}`))).slice(0, 32);
}

// ---------- Spotify ----------
// "Client credentials" sign-in: the Worker gets a short-lived pass with the app keys. No visitor logins.
let spToken = null, spTokenExpires = 0;
async function spotifyToken(env) {
  if (spToken && Date.now() < spTokenExpires - 60_000) return spToken;
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) throw new Error("Spotify keys are not set");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Spotify sign-in failed (${res.status})`);
  spToken = data.access_token;
  spTokenExpires = Date.now() + (data.expires_in || 3600) * 1000;
  return spToken;
}
async function spotifyGet(env, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.spotify.com/v1/" + path, { headers: { Authorization: `Bearer ${await spotifyToken(env)}` } });
    if (res.status === 401 && attempt === 0) { spToken = null; continue; }   // pass expired early: get a new one
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(`Spotify ${res.status}`); err.status = res.status; throw err; }
    return data;
  }
}
// Spotify writes versions after a dash ("Today - 2011 Remaster"): show the plain title, keep the full one.
const VERSION_RX = /^(.*?)\s+-\s+(.*(?:remaster|version|live|mix|edit|mono|stereo|demo|acoustic|single|recorded|session|take|\b\d{4}\b).*)$/i;
function mapTrack(t) {
  const name = t.name || "";
  const m = name.match(VERSION_RX);
  const imgs = t.album?.images || [];
  return {
    id: t.id, song: m ? m[1] : name, fullTitle: m ? name : undefined,
    artist: (t.artists || []).map((a) => a.name).join(", "),
    album: t.album?.name || "", albumType: t.album?.album_type || "",
    albumArtist: (t.album?.artists || []).map((a) => a.name).join(", "),
    date: t.album?.release_date || "", year: Number(String(t.album?.release_date || "").slice(0, 4)) || 0,
    art: imgs[0]?.url || "", thumb: imgs[imgs.length - 1]?.url || "",
    url: t.external_urls?.spotify || "",
  };
}
async function spotifySearch(env, ctx, host, q) {
  const cacheKey = new Request(`https://${host}/__cache/spotify-search/${encodeURIComponent(q.toLowerCase())}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit.json();
  // Development-mode Spotify apps get at most 10 results per request, so ask for two pages.
  const pages = await Promise.all([0, 10].map((offset) =>
    spotifyGet(env, "search?" + new URLSearchParams({ q, type: "track", market: "US", limit: "10", offset: String(offset) }))));
  const results = pages.flatMap((p) => p.tracks?.items || []).filter(Boolean).map(mapTrack);
  ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${SEARCH_CACHE_SECONDS}` } })));
  return results;
}

// Picking the original album when Spotify has the same song on several (same rules as the page).
function editionPenalty(it) {
  const a = String(it.album || "").toLowerCase();
  if (/karaoke|tribute|lullaby|rockabye|in the style of|originally performed|backing track|made famous/.test(a)) return 3;
  if (it.albumArtist && norm(it.albumArtist) !== norm(it.artist)) return 2;
  if (/greatest|hits|best of|collection|anthology|essential|compilation|\blive\b|soundtrack|now that|sampler|number 1|#1|\ba-sides\b|\bb-sides\b|singles|rarities|retrospective/.test(a)) return 2;
  if (/remaster|deluxe|anniversary|edition|expanded|bonus|reissue|- single|- ep|version|sped.?up|slowed/.test(a)) return 1;
  if (it.albumType === "compilation") return 1;
  return 0;
}
function trackPenalty(it) {
  const full = it.fullTitle || it.song;
  const extra = (String(full).match(/[\(\[].*?[\)\]]|\s-\s.*$/g) || []).join(" ");
  return /\b(live|acoustic|demo|remix|instrumental|karaoke|unplugged|session|rehearsal|mix|edit|version|take)\b/i.test(extra) ? 2 : 0;
}
function chooseOriginal(list) {
  const scored = list.map((it, i) => ({ it, i, p: editionPenalty(it), t: trackPenalty(it), d: String(it.date || "9999").slice(0, 10) }));
  const pool = scored.some((s) => s.p < 2) ? scored.filter((s) => s.p < 2) : scored;
  pool.sort((a, b) => (a.t - b.t) || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0) || (a.p - b.p) || (a.i - b.i));
  return pool[0]?.it;
}

// ---------- database ----------
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS songs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          track_id INTEGER,
          song TEXT NOT NULL,
          artist TEXT NOT NULL,
          year INTEGER NOT NULL DEFAULT 0,
          art TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          votes INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'fan',
          submitter TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS song_votes (
          song_id INTEGER NOT NULL, voter TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (song_id, voter))`),
        db.prepare(`CREATE TABLE IF NOT EXISTS song_challenges (id TEXT PRIMARY KEY, answer INTEGER NOT NULL, voter TEXT NOT NULL, expires INTEGER NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS song_unlocks (token TEXT PRIMARY KEY, voter TEXT NOT NULL, expires INTEGER NOT NULL)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS song_hits (voter TEXT NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (voter, bucket))`),
        db.prepare(`CREATE TABLE IF NOT EXISTS song_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_songs_rank ON songs (votes DESC, created_at ASC)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_song_votes_voter ON song_votes (voter, created_at)"),
      ]);
      // Spotify columns, added to an existing database without touching any songs or votes.
      // sp = Spotify track id ('' = not looked up yet, '-' = Spotify didn't have it), url = link to the song on Spotify.
      const { results: cols } = await db.prepare("PRAGMA table_info(songs)").all();
      const have = new Set(cols.map((c) => c.name));
      if (!have.has("sp")) await db.prepare("ALTER TABLE songs ADD COLUMN sp TEXT NOT NULL DEFAULT ''").run();
      if (!have.has("url")) await db.prepare("ALTER TABLE songs ADD COLUMN url TEXT NOT NULL DEFAULT ''").run();
      // The starter shortlist goes in once, ever. A database that already has songs counts as seeded.
      const seeded = await db.prepare("SELECT v FROM song_settings WHERE k = 'seeded'").first();
      if (!seeded) {
        const { n } = await db.prepare("SELECT COUNT(*) AS n FROM songs").first();
        const now = Date.now();
        const writes = n === 0 ? SEED_SONGS.map(([song, artist, year], i) =>
          db.prepare("INSERT OR IGNORE INTO songs (key, song, artist, year, votes, source, created_at) VALUES (?1, ?2, ?3, ?4, 0, 'band', ?5)")
            .bind(songKey(song, artist), song, artist, year, now + i)) : [];
        writes.push(db.prepare("INSERT OR REPLACE INTO song_settings (k, v) VALUES ('seeded', ?1)").bind(String(now)));
        await db.batch(writes);
      }
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// Songs without Spotify details yet (the starter list, and songs added before the switch to Spotify) are
// looked up in the background, a few at a time, so the page gets Spotify artwork and players.
let backfilling = false;
async function backfillSpotify(env, ctx, host, db) {
  if (backfilling || !env.SPOTIFY_CLIENT_ID) return;
  backfilling = true;
  try {
    const { results } = await db.prepare("SELECT id, song, artist FROM songs WHERE sp = '' LIMIT 4").all();
    for (const r of results) {
      let found = null;
      try {
        const items = await spotifySearch(env, ctx, host, `track:"${r.song}" artist:"${r.artist.replace(/^the\s+/i, "")}"`);
        found = chooseOriginal(items.filter((it) => songKey(it.song, it.artist) === songKey(r.song, r.artist)));
      } catch (err) { console.error("Spotify backfill", r.song, err.message); continue; }
      if (found) await db.prepare("UPDATE songs SET sp = ?1, url = ?2, art = ?3, year = CASE WHEN ?4 > 0 THEN ?4 ELSE year END WHERE id = ?5")
        .bind(found.id, found.url, found.art, found.year, r.id).run();
      else await db.prepare("UPDATE songs SET sp = '-' WHERE id = ?1").bind(r.id).run();
    }
  } finally { backfilling = false; }
}

async function listSongs(db, voter) {
  const { results } = await db.prepare(
    `SELECT s.id, s.song, s.artist, s.year, s.art, s.sp, s.url, s.votes, s.source,
            EXISTS (SELECT 1 FROM song_votes v WHERE v.song_id = s.id AND v.voter = ?1) AS voted
     FROM songs s ORDER BY s.votes DESC, s.created_at ASC LIMIT ${LIST_LIMIT}`).bind(voter).all();
  return results.map((r) => ({ ...r, sp: r.sp === "-" ? "" : r.sp, voted: !!r.voted }));
}

// Adding and removing a vote each change the vote row and the song's count together, in one step.
async function addVote(db, id, voter) {
  const now = Date.now();
  const [ins] = await db.batch([
    db.prepare("INSERT OR IGNORE INTO song_votes (song_id, voter, created_at) VALUES (?1, ?2, ?3)").bind(id, voter, now),
    db.prepare("UPDATE songs SET votes = votes + 1 WHERE id = ?1 AND changes() > 0").bind(id),
  ]);
  return !!ins.meta.changes;
}
async function removeVote(db, id, voter) {
  const [del] = await db.batch([
    db.prepare("DELETE FROM song_votes WHERE song_id = ?1 AND voter = ?2").bind(id, voter),
    db.prepare("UPDATE songs SET votes = MAX(votes - 1, 0) WHERE id = ?1 AND changes() > 0").bind(id),
  ]);
  return !!del.meta.changes;
}

// Counts an action in the current time window and says whether this visitor is over the limit.
async function overLimit(db, voter, kind, limit, bucketMs) {
  const bucket = Math.floor(Date.now() / bucketMs) * bucketMs;
  const key = `${kind}:${voter}`;
  await db.prepare("INSERT INTO song_hits (voter, bucket, n) VALUES (?1, ?2, 1) ON CONFLICT (voter, bucket) DO UPDATE SET n = n + 1").bind(key, bucket).run();
  const row = await db.prepare("SELECT n FROM song_hits WHERE voter = ?1 AND bucket = ?2").bind(key, bucket).first();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM song_hits WHERE bucket < ?1").bind(Date.now() - 2 * HOUR).run().catch(() => {});
  return row.n > limit;
}

// Sends the "new song" email through Resend and reports what Resend said (logged, and shown by the admin test button).
function songEmail(env, s, siteUrl) {
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const page = `${siteUrl}/song-requests`;
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.BOOKING_FROM,
      to: env.BOOKING_TO.split(",").map((x) => x.trim()).filter(Boolean),
      subject: `New song request: ${s.song} - ${s.artist}`.replace(/[\r\n]+/g, " ").slice(0, 150),
      text: `A fan added a song to the request list.\n\nSong: ${s.song}\nArtist: ${s.artist}\nYear: ${s.year || "-"}\n${s.url ? `On Spotify: ${s.url}\n` : ""}\nSee the list: ${page}\n`,
      html: `<h2>New song request</h2><p><b>${esc(s.song)}</b> &mdash; ${esc(s.artist)}${s.year ? ` (${s.year})` : ""}</p>${s.url ? `<p><a href="${esc(s.url)}">Listen on Spotify</a></p>` : ""}<p><a href="${esc(page)}">See the list</a></p>`,
    }),
  }).then(async (res) => {
    const body = (await res.text()).slice(0, 500);
    if (!res.ok) console.error("Song email refused by Resend", res.status, body);
    return { ok: res.ok, status: res.status, body };
  }).catch((err) => { console.error("Song email failed", err && err.message); return { ok: false, status: 0, body: String(err && err.message || err) }; });
}
function notifyNewSong(env, ctx, s, siteUrl) {
  if (env.SONG_NOTIFY === "off") return;
  if (!env.RESEND_API_KEY || !env.BOOKING_TO || !env.BOOKING_FROM) { console.error("Song email: RESEND_API_KEY, BOOKING_TO or BOOKING_FROM is missing"); return; }
  ctx.waitUntil(songEmail(env, s, siteUrl));
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 4000) throw new Error("too large");
  const data = JSON.parse(text || "{}");
  if (!data || typeof data !== "object") throw new Error("bad body");
  return data;
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// ---------- the API ----------
export async function handleSongs(request, env, ctx) {
  const url = new URL(request.url);
  const method = request.method;
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean); // ["api","songs",...]

  if (!env.DB) {
    console.error("Songs: the DB (D1) binding is missing");
    return json({ ok: false, error: "The song list isn't set up yet." }, 503);
  }
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return json({ ok: false, error: "Forbidden" }, 403);
  }

  try {
    await ensureSchema(env.DB);
    const db = env.DB;
    const voter = await visitorId(request, env);
    const sid = (v) => (typeof v === "string" && /^[A-Za-z0-9]{10,40}$/.test(v) ? v : "");

    // GET /api/songs
    if (parts.length === 2 && method === "GET") {
      ctx.waitUntil(backfillSpotify(env, ctx, url.host, db).catch((e) => console.error("backfill", e.message)));
      return json({ ok: true, songs: await listSongs(db, voter), known: KNOWN_SONGS });
    }

    // GET /api/songs/search?q=
    if (parts.length === 3 && parts[2] === "search" && method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      if (q.length < 2) return json({ ok: true, results: [] });
      if (await overLimit(db, voter, "search", SEARCHES_PER_MINUTE, 60000)) return json({ ok: false, error: "Slow down a little and try again in a moment." }, 429);
      try { return json({ ok: true, results: await spotifySearch(env, ctx, url.host, q) }); }
      catch (err) { console.error("Spotify search", err.message); return json({ ok: false, error: "Search isn’t available right now. Please try again in a moment." }, 502); }
    }

    // GET /api/songs/export  (band only)
    if (parts.length === 3 && parts[2] === "export" && method === "GET") {
      if (!isAdmin(request, env)) return json({ ok: false, error: "Not allowed" }, 403);
      const { results } = await db.prepare("SELECT id, song, artist, year, votes, source, url, created_at FROM songs ORDER BY votes DESC, created_at ASC").all();
      const rows = [["Rank", "Song", "Artist", "Year", "Votes", "Added by", "Spotify link", "Added on"]]
        .concat(results.map((r, i) => [i + 1, r.song, r.artist, r.year || "", r.votes, r.source === "band" ? "Band" : "Fan", r.url, new Date(r.created_at).toISOString().slice(0, 10)]));
      return new Response("﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), { headers: {
        "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="audiovox-song-requests-${new Date().toISOString().slice(0, 10)}.csv"` } });
    }

    // POST /api/songs/test-email  (band only): sends one test "new song" email and returns Resend's answer
    if (parts.length === 3 && parts[2] === "test-email" && method === "POST") {
      if (!isAdmin(request, env)) return json({ ok: false, error: "Not allowed" }, 403);
      const missing = ["RESEND_API_KEY", "BOOKING_TO", "BOOKING_FROM"].filter((k) => !env[k]);
      if (missing.length) return json({ ok: false, error: `Missing setting(s): ${missing.join(", ")}` }, 500);
      const r = await songEmail(env, { song: "TEST - please ignore", artist: "AudioVox website", year: "", url: "" }, url.origin);
      return json({ ok: r.ok, resendStatus: r.status, resendReply: r.body, songNotify: env.SONG_NOTIFY || "(not set = on)",
        error: r.ok ? undefined : `Resend refused it (${r.status}): ${r.body}` }, r.ok ? 200 : 502);
    }

    // GET /api/songs/challenge
    if (parts.length === 3 && parts[2] === "challenge" && method === "GET") {
      if (await overLimit(db, voter, "challenge", CHALLENGES_PER_HOUR, HOUR)) return json({ ok: false, error: "Too many tries. Please wait a bit." }, 429);
      await db.prepare("DELETE FROM song_challenges WHERE expires < ?1").bind(Date.now()).run();
      const rand = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9);
      const a = rand(), b = rand(), id = crypto.randomUUID();
      await db.prepare("INSERT INTO song_challenges (id, answer, voter, expires) VALUES (?1, ?2, ?3, ?4)").bind(id, a + b, voter, Date.now() + CHALLENGE_TTL).run();
      return json({ ok: true, id, question: `${a} + ${b}` });
    }

    // POST /api/songs/unlock  {challengeId, answer}
    if (parts.length === 3 && parts[2] === "unlock" && method === "POST") {
      let data;
      try { data = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      const id = typeof data.challengeId === "string" ? data.challengeId.slice(0, 64) : "";
      const row = id ? await db.prepare("SELECT answer, expires FROM song_challenges WHERE id = ?1").bind(id).first() : null;
      if (row) await db.prepare("DELETE FROM song_challenges WHERE id = ?1").bind(id).run(); // every question is single-use
      if (!row || row.expires < Date.now()) return json({ ok: false, code: "challenge", error: "That one timed out. Try this one." }, 400);
      if (parseInt(String(data.answer).trim(), 10) !== row.answer) return json({ ok: false, code: "challenge", error: "Not quite — try this one." }, 400);
      const token = crypto.randomUUID();
      await db.batch([
        db.prepare("DELETE FROM song_unlocks WHERE expires < ?1").bind(Date.now()),
        db.prepare("INSERT INTO song_unlocks (token, voter, expires) VALUES (?1, ?2, ?3)").bind(token, voter, Date.now() + UNLOCK_TTL),
      ]);
      return json({ ok: true, unlock: token });
    }

    // POST /api/songs  {sp, unlock}
    if (parts.length === 2 && method === "POST") {
      let data;
      try { data = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      if (data.website) return json({ ok: true, songs: await listSongs(db, voter) }); // honeypot
      const pass = typeof data.unlock === "string" ? await db.prepare("SELECT voter, expires FROM song_unlocks WHERE token = ?1").bind(data.unlock.slice(0, 64)).first() : null;
      if (!pass || pass.voter !== voter || pass.expires < Date.now()) return json({ ok: false, code: "locked", error: "Answer the quick check first, then add your song." }, 403);

      const spId = sid(data.sp);
      if (!spId) return json({ ok: false, error: "Please pick a song from the search." }, 400);
      // The server looks the song up on Spotify itself and saves what Spotify says, never what the page sent.
      let t;
      try { t = mapTrack(await spotifyGet(env, `tracks/${spId}?market=US`)); }
      catch (err) {
        if (err.status === 404 || err.status === 400) return json({ ok: false, error: "We couldn’t find that song. Try searching again." }, 404);
        console.error("Spotify lookup", err.message);
        return json({ ok: false, error: "We couldn’t reach Spotify just now. Please try again in a moment." }, 502);
      }
      if (!t.id || !t.song || !t.artist) return json({ ok: false, error: "We couldn’t find that song. Try searching again." }, 404);
      if (!inYearRange(t.year)) return json({ ok: false, error: `We only add songs from ${MIN_YEAR} on.` }, 400);
      if (explicitTitle(t.song)) return json({ ok: false, error: "Sorry, we can’t add that one to the list." }, 400);
      if (isKnown(t.song, t.artist)) return json({ ok: false, code: "known", error: `We already play “${t.song}”! Come catch it at a show.` }, 409);

      const key = songKey(t.song, t.artist);
      const existing = await db.prepare("SELECT id FROM songs WHERE key = ?1").bind(key).first();
      if (existing) {
        const counted = await addVote(db, existing.id, voter);
        return json({ ok: true, merged: true, counted, id: existing.id, songs: await listSongs(db, voter) });
      }
      const recent = await db.prepare("SELECT COUNT(*) AS n FROM songs WHERE submitter = ?1 AND created_at > ?2").bind(voter, Date.now() - HOUR).first();
      if (recent.n >= NEW_SONGS_PER_HOUR) return json({ ok: false, error: "That’s a lot of new songs for one hour! Please try again a bit later." }, 429);
      const total = await db.prepare("SELECT COUNT(*) AS n FROM songs").first();
      if (total.n >= LIST_LIMIT) return json({ ok: false, error: "The list is full right now. Vote for a song that’s already on it!" }, 429);

      let id;
      try {
        const ins = await db.prepare("INSERT INTO songs (key, sp, url, song, artist, year, art, votes, source, submitter, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'fan', ?8, ?9)")
          .bind(key, t.id, t.url.slice(0, 300), t.song.slice(0, 200), t.artist.slice(0, 200), t.year, t.art.slice(0, 500), voter, Date.now()).run();
        id = ins.meta.last_row_id;
      } catch (err) {
        const dupe = await db.prepare("SELECT id FROM songs WHERE key = ?1").bind(key).first();   // added by someone else a moment ago
        if (!dupe) throw err;
        const counted = await addVote(db, dupe.id, voter);
        return json({ ok: true, merged: true, counted, id: dupe.id, songs: await listSongs(db, voter) });
      }
      await addVote(db, id, voter);
      notifyNewSong(env, ctx, t, url.origin);
      return json({ ok: true, merged: false, id, songs: await listSongs(db, voter) });
    }

    // POST /api/songs/:id/vote  and  DELETE /api/songs/:id/vote (take it back)
    if (parts.length === 4 && parts[3] === "vote" && (method === "POST" || method === "DELETE")) {
      const id = Number(parts[2]);
      if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: "Not found" }, 404);
      if (!(await db.prepare("SELECT id FROM songs WHERE id = ?1").bind(id).first())) return json({ ok: false, error: "Not found" }, 404);
      if (await overLimit(db, voter, method === "POST" ? "vote" : "unvote", VOTES_PER_HOUR, HOUR)) return json({ ok: false, error: "Too many votes. Try again later." }, 429);
      const changed = method === "POST" ? await addVote(db, id, voter) : await removeVote(db, id, voter);
      return json({ ok: true, counted: changed, songs: await listSongs(db, voter) });
    }

    // DELETE /api/songs/:id  (band only)
    if (parts.length === 3 && method === "DELETE") {
      if (!isAdmin(request, env)) return json({ ok: false, error: "Not allowed" }, 403);
      const id = Number(parts[2]);
      if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: "Not found" }, 404);
      await db.batch([
        db.prepare("DELETE FROM song_votes WHERE song_id = ?1").bind(id),
        db.prepare("DELETE FROM songs WHERE id = ?1").bind(id),
      ]);
      return json({ ok: true, songs: await listSongs(db, voter) });
    }

    return json({ ok: false, error: "Not found" }, 404);
  } catch (err) {
    console.error("Songs error", err && err.message ? err.message : err);
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
}
