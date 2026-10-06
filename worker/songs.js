// "Songs We Should Learn": the shared, public song-request list (song-requests.html).
// Stored in a Cloudflare D1 database (binding "DB", see wrangler.jsonc) and served from /api/songs*.
//
// Fans search Apple's music catalog (through this Worker), then add a real song to the list or vote
// for one already on it. Every rule is checked here, on the server, so it can't be skipped:
//   - songs released from 1989 to now
//   - no songs with an explicit word spelled out in the TITLE (explicit lyrics and masked spellings are fine)
//   - songs the band already plays (KNOWN_SONGS) can't be requested
//   - a quick math check before adding, 5 new songs per visitor per hour, one vote per song per visitor
//
//   GET    /api/songs                 the list, most votes first
//   GET    /api/songs/search?q=...    search Apple's catalog (results are cached for a day)
//   GET    /api/songs/challenge       a fresh "what's 3 + 4?" question
//   POST   /api/songs/unlock          answer the question -> a pass that allows adding for a few hours
//   POST   /api/songs                 add a song {trackId, unlock}; a song already on the list just gets a vote
//   POST   /api/songs/:id/vote        vote for a song
//   DELETE /api/songs/:id             remove a song (band only: "Authorization: Bearer <ADMIN_TOKEN>")
//
// Settings (Cloudflare dashboard -> Workers & Pages -> audiovox -> Settings -> Variables and secrets):
//   ADMIN_TOKEN  (secret) lets the band remove songs from the page (open /song-requests#admin=TOKEN once)
//   SONG_NOTIFY  (text)   emails BOOKING_TO via Resend when a fan adds a song. On by default; "off" turns it off.
//   VOTE_SALT    (secret) optional extra salt for the hashed visitor ids

const MIN_YEAR = 1989;
const LIST_LIMIT = 500;            // most songs the list will hold (stops a flood)
const NEW_SONGS_PER_HOUR = 5;      // per visitor
const VOTES_PER_HOUR = 60;         // per visitor
const SEARCHES_PER_MINUTE = 30;    // per visitor, so nobody can use us to hammer Apple
const CHALLENGES_PER_HOUR = 30;    // per visitor
const CHALLENGE_TTL = 30 * 60 * 1000;
const UNLOCK_TTL = 4 * 3600 * 1000;
const HOUR = 3600 * 1000;

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

// The band's starting shortlist (added once, when the list is first created): [song, artist, year, art, preview]
const SEED_SONGS = [
  ["Black Hole Sun", "Soundgarden", 1994, "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/69/60/2e/69602e04-f483-70a7-51b6-5dc6b58273ce/00602537879830.rgb.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/fa/c0/77/fac07771-3fd9-165e-2829-b19614198077/mzaf_3138425259586801377.plus.aac.p.m4a"],
  ["Lithium", "Nirvana", 1991, "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/95/fd/b9/95fdb9b2-6d2b-92a6-97f2-51c1a6d77f1a/00602527874609.rgb.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/10/26/3a/10263abf-e10b-1b19-282f-2cfe1e160bb0/mzaf_13537127778296504562.plus.aac.p.m4a"],
  ["Even Flow", "Pearl Jam", 1991, "https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/42/22/dd/4222ddfc-35a9-ab18-f467-cc370f6f24d6/098707793424.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/b2/c9/f5/b2c9f56f-73f0-263b-edf9-4a46b2503e76/mzaf_11196559182905789809.plus.aac.p.m4a"],
  ["Today", "The Smashing Pumpkins", 1993, "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/3a/dc/08/3adc08b0-e98c-b5dd-943e-a37c7ed06205/13UABIM03615.rgb.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/c2/dd/f7/c2ddf7dd-f8d5-18ee-0ea1-658a7441145b/mzaf_5814503050448650956.plus.aac.p.m4a"],
  ["Interstate Love Song", "Stone Temple Pilots", 1994, "https://is1-ssl.mzstatic.com/image/thumb/Music113/v4/d7/15/cc/d715cc36-0741-14b3-39b5-1f1f5ac88dd2/603497851553.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/24/19/e6/2419e6a9-55eb-8578-8ffd-c4fbb24c00c4/mzaf_3187694087858936927.plus.aac.p.m4a"],
  ["Semi-Charmed Life", "Third Eye Blind", 1997, "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/89/8f/21/898f2118-a3e1-2b4a-7481-d986d09ffc29/mzi.jbqxjhwg.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/e7/77/7d/e7777db5-3b28-e029-f41a-6a6058275f76/mzaf_17353091552026184524.plus.aac.p.m4a"],
  ["Mr. Jones", "Counting Crows", 1993, "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/3b/dc/90/3bdc90a2-3697-0c5e-3265-65ccaa7dcbb3/14UMGIM00847.rgb.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/f3/b0/2a/f3b02a56-a5bf-e940-4370-2e0a609f1cb4/mzaf_16264556580562087321.plus.aac.p.m4a"],
  ["Cannonball", "The Breeders", 1993, "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/c7/f2/9c/c7f29c36-434e-3e40-b517-dce503eb2d5c/652637301458.png/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/0a/4b/bd/0a4bbd63-a2b3-7eee-0ebe-19a7dbd72896/mzaf_8660903494435327038.plus.aac.p.m4a"],
  ["Zombie", "The Cranberries", 1994, "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/bd/f8/87/bdf8870e-2df6-07b3-75c9-99a2911fc8b5/24UMGIM84189.rgb.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/d1/44/75/d1447593-07e6-18e7-11e8-8368f3a93aef/mzaf_10254257033740545525.plus.aac.p.m4a"],
  ["Closing Time", "Semisonic", 1998, "https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/6e/02/9e/6e029e4e-66ee-11ec-f536-4f28c9db9a43/18UMGIM47330.rgb.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/19/9d/55/199d55f1-a082-b5aa-1f2f-dbe0ee5092e6/mzaf_14428796061819406061.plus.aac.p.m4a"],
  ["Hey Jealousy", "Gin Blossoms", 1992, "https://is1-ssl.mzstatic.com/image/thumb/Music113/v4/13/a7/76/13a77656-a654-e827-fcba-91d4516480fe/06UMGIM18663.rgb.jpg/100x100bb.jpg", "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/1d/6d/eb/1d6deb34-d841-2c58-f635-8a6dfca65827/mzaf_17213998669808579806.plus.aac.p.m4a"],
];

// Explicit words that keep a song off the list when they're spelled out in the TITLE (whole words only,
// so "Cocktail" or "Dickens" are fine; masked spellings like "F**k" are allowed).
const BLOCKED_TITLE_WORDS = ["fuck", "fucking", "fucked", "fucker", "fuckin", "motherfucker", "shit", "shitty", "shithead", "bullshit", "horseshit", "dipshit",
  "bitch", "bitches", "cunt", "cock", "cocksucker", "dick", "dickhead", "pussy", "whore", "slut", "bastard", "asshole", "tits", "cum", "wank",
  "nigger", "nigga", "faggot", "fag", "retard"];
const blockedTitleRx = new RegExp("(?:^|[^a-z])(?:" + BLOCKED_TITLE_WORDS.join("|") + ")(?:$|[^a-z])", "i");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

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
        db.prepare("CREATE INDEX IF NOT EXISTS idx_songs_rank ON songs (votes DESC, created_at ASC)"),
        db.prepare("CREATE INDEX IF NOT EXISTS idx_song_votes_voter ON song_votes (voter, created_at)"),
      ]);
      const { n } = await db.prepare("SELECT COUNT(*) AS n FROM songs").first();
      if (n === 0 && SEED_SONGS.length) {
        const now = Date.now();
        await db.batch(SEED_SONGS.map(([song, artist, year, art, preview], i) =>
          db.prepare("INSERT OR IGNORE INTO songs (key, song, artist, year, art, preview, votes, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'band', ?7)")
            .bind(songKey(song, artist), song, artist, year, art, preview, now + i)));
      }
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

async function listSongs(db, voter) {
  const { results } = await db.prepare(
    `SELECT s.id, s.song, s.artist, s.year, s.art, s.preview, s.votes, s.source,
            EXISTS (SELECT 1 FROM song_votes v WHERE v.song_id = s.id AND v.voter = ?1) AS voted
     FROM songs s ORDER BY s.votes DESC, s.created_at ASC LIMIT ${LIST_LIMIT}`).bind(voter).all();
  return results.map((r) => ({ ...r, voted: !!r.voted }));
}

async function addVote(db, id, voter) {
  const ins = await db.prepare("INSERT OR IGNORE INTO song_votes (song_id, voter, created_at) VALUES (?1, ?2, ?3)").bind(id, voter, Date.now()).run();
  if (!ins.meta.changes) return false;
  await db.prepare("UPDATE songs SET votes = votes + 1 WHERE id = ?1").bind(id).run();
  return true;
}

// Counts an action in the current time bucket and says whether this visitor is over the limit.
async function overLimit(db, voter, kind, limit, bucketMs) {
  const bucket = Math.floor(Date.now() / bucketMs) * bucketMs;   // start of the time window, in ms
  const key = `${kind}:${voter}`;
  await db.prepare("INSERT INTO song_hits (voter, bucket, n) VALUES (?1, ?2, 1) ON CONFLICT (voter, bucket) DO UPDATE SET n = n + 1").bind(key, bucket).run();
  const row = await db.prepare("SELECT n FROM song_hits WHERE voter = ?1 AND bucket = ?2").bind(key, bucket).first();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM song_hits WHERE bucket < ?1").bind(Date.now() - 2 * HOUR).run().catch(() => {});
  return row.n > limit;
}

// ---------- Apple's music catalog (free, no key) ----------
function mapTrack(r) {
  return {
    trackId: r.trackId, song: r.trackName || "", artist: r.artistName || "",
    year: Number(String(r.releaseDate || "").slice(0, 4)) || 0,
    art: r.artworkUrl100 || "", preview: r.previewUrl || "",
  };
}
async function itunes(params, ctx) {
  const url = "https://itunes.apple.com/" + params;
  const cache = caches.default;
  const cacheKey = new Request(url);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const res = await fetch(url, { headers: { "User-Agent": "AudioVox song requests (audiovox.huddlegab.com)" } });
  if (!res.ok) throw new Error(`Apple search ${res.status}`);
  const data = await res.json();
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } })));
  return data;
}

function notifyNewSong(env, ctx, s, siteUrl) {
  if (env.SONG_NOTIFY === "off" || !env.RESEND_API_KEY || !env.BOOKING_TO || !env.BOOKING_FROM) return;
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const page = `${siteUrl}/song-requests`;
  ctx.waitUntil(fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.BOOKING_FROM,
      to: env.BOOKING_TO.split(",").map((x) => x.trim()).filter(Boolean),
      subject: `New song request: ${s.song} - ${s.artist}`.replace(/[\r\n]+/g, " ").slice(0, 150),
      text: `A fan added a song to the request list.\n\nSong: ${s.song}\nArtist: ${s.artist}\nYear: ${s.year || "-"}\n\nSee the list: ${page}\n`,
      html: `<h2>New song request</h2><p><b>${esc(s.song)}</b> &mdash; ${esc(s.artist)}${s.year ? ` (${s.year})` : ""}</p><p><a href="${esc(page)}">See the list</a></p>`,
    }),
  }).catch((err) => console.error("Song notify failed", err)));
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 4000) throw new Error("too large");
  const data = JSON.parse(text || "{}");
  if (!data || typeof data !== "object") throw new Error("bad body");
  return data;
}

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

    // GET /api/songs
    if (parts.length === 2 && method === "GET") return json({ ok: true, songs: await listSongs(db, voter) });

    // GET /api/songs/search?q=
    if (parts.length === 3 && parts[2] === "search" && method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
      if (q.length < 2) return json({ ok: true, results: [] });
      if (await overLimit(db, voter, "search", SEARCHES_PER_MINUTE, 60000)) return json({ ok: false, error: "Slow down a little and try again in a moment." }, 429);
      let data;
      try { data = await itunes("search?" + new URLSearchParams({ term: q, media: "music", entity: "song", limit: "25", country: "US" }), ctx); }
      catch (err) {
        console.error("Song search failed:", err && err.message);
        return json({ ok: false, error: "Search isn’t available right now. Please try again in a moment.", detail: String(err && err.message || err).slice(0, 120) }, 502);
      }
      const { results: onList } = await db.prepare("SELECT id, key FROM songs").all();
      const listed = new Map(onList.map((r) => [r.key, r.id]));
      const seen = new Set(), results = [];
      for (const t of (data.results || []).map(mapTrack)) {
        if (!t.trackId || !t.song || !t.artist || !inYearRange(t.year) || explicitTitle(t.song)) continue;
        const k = songKey(t.song, t.artist);
        if (seen.has(k)) continue;
        seen.add(k);
        results.push({ ...t, known: isKnown(t.song, t.artist), listedId: listed.get(k) || null });
        if (results.length >= 8) break;
      }
      return json({ ok: true, results });
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
      if (!row || row.expires < Date.now()) return json({ ok: false, code: "challenge", error: "That question timed out. Please answer the new one." }, 400);
      if (parseInt(String(data.answer).trim(), 10) !== row.answer) return json({ ok: false, code: "challenge", error: "That wasn’t quite right. Try the new question." }, 400);
      const token = crypto.randomUUID();
      await db.batch([
        db.prepare("DELETE FROM song_unlocks WHERE expires < ?1").bind(Date.now()),
        db.prepare("INSERT INTO song_unlocks (token, voter, expires) VALUES (?1, ?2, ?3)").bind(token, voter, Date.now() + UNLOCK_TTL),
      ]);
      return json({ ok: true, unlock: token });
    }

    // POST /api/songs  {trackId, unlock}
    if (parts.length === 2 && method === "POST") {
      let data;
      try { data = await readJson(request); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
      if (data.website) return json({ ok: true, songs: await listSongs(db, voter) }); // honeypot
      const pass = typeof data.unlock === "string" ? await db.prepare("SELECT voter, expires FROM song_unlocks WHERE token = ?1").bind(data.unlock.slice(0, 64)).first() : null;
      if (!pass || pass.voter !== voter || pass.expires < Date.now()) return json({ ok: false, code: "locked", error: "Answer the quick check first, then add your song." }, 403);

      const trackId = Number(data.trackId);
      if (!Number.isInteger(trackId) || trackId < 1) return json({ ok: false, error: "Please pick a song from the search." }, 400);
      // Look the song up ourselves: we save what Apple says, never what the page claims.
      const found = (await itunes("lookup?" + new URLSearchParams({ id: String(trackId), entity: "song", country: "US" }), ctx)).results || [];
      const raw = found.find((r) => r.trackId === trackId && (r.kind === "song" || r.wrapperType === "track"));
      if (!raw) return json({ ok: false, error: "We couldn’t find that song. Try searching again." }, 404);
      const t = mapTrack(raw);
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
        const ins = await db.prepare("INSERT INTO songs (key, track_id, song, artist, year, art, preview, votes, source, submitter, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'fan', ?8, ?9)")
          .bind(key, trackId, t.song.slice(0, 200), t.artist.slice(0, 200), t.year, t.art.slice(0, 500), t.preview.slice(0, 500), voter, Date.now()).run();
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

    // POST /api/songs/:id/vote
    if (parts.length === 4 && parts[3] === "vote" && method === "POST") {
      const id = Number(parts[2]);
      if (!Number.isInteger(id) || id < 1) return json({ ok: false, error: "Not found" }, 404);
      if (!(await db.prepare("SELECT id FROM songs WHERE id = ?1").bind(id).first())) return json({ ok: false, error: "Not found" }, 404);
      const recent = await db.prepare("SELECT COUNT(*) AS n FROM song_votes WHERE voter = ?1 AND created_at > ?2").bind(voter, Date.now() - HOUR).first();
      if (recent.n >= VOTES_PER_HOUR) return json({ ok: false, error: "Too many votes. Try again later." }, 429);
      const counted = await addVote(db, id, voter);
      return json({ ok: true, counted, songs: await listSongs(db, voter) });
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
