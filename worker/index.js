// Cloudflare Worker entry point (see wrangler.jsonc).
//
// The site itself is plain static files served by Workers Static Assets. This
// script only runs for /api/*:
//   POST /api/booking  receives the booking form and relays it to the band's
//                      internal inbox through Resend (https://resend.com)
//   /api/songs*        the shared song-request list (see songs.js)
// The Resend API key lives only in Cloudflare (never in the page or this repo).
//
// Settings (Cloudflare dashboard -> Workers & Pages -> audiovox -> Settings ->
// Variables and Secrets):
//   RESEND_API_KEY  (secret)  your Resend API key
//   BOOKING_TO      (text)    internal address(es) to receive requests, comma-separated
//   BOOKING_FROM    (text)    sender, e.g. "AudioVox Website <bookings@yourdomain.com>"
//                             (the domain must be verified in Resend)

import { handleSongs } from "./songs.js";
import { handleMedia } from "./media.js";

const MAX = { name: 120, email: 200, phone: 60, date: 40, venue: 200, details: 4000 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Single-line text for headers like the subject: no CR/LF so nothing can inject headers.
const oneLine = (v) => v.replace(/[\r\n]+/g, " ");
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function handleBooking(request, env) {
  // Only accept posts that come from this site's own pages.
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  if (!env.RESEND_API_KEY || !env.BOOKING_TO || !env.BOOKING_FROM) {
    console.error("Booking form: RESEND_API_KEY, BOOKING_TO or BOOKING_FROM is not set");
    return json({ ok: false, error: "Booking form is not configured yet." }, 500);
  }

  let data;
  try {
    const text = await request.text();
    if (text.length > 20000) return json({ ok: false, error: "Message too large." }, 413);
    data = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }
  if (!data || typeof data !== "object") return json({ ok: false, error: "Invalid request." }, 400);

  // Honeypot: a real visitor never fills this. Pretend it worked, send nothing.
  if (data.website) return json({ ok: true });

  const f = {
    name: clean(data.name, MAX.name),
    email: clean(data.email, MAX.email),
    phone: clean(data.phone, MAX.phone),
    date: clean(data.date, MAX.date),
    venue: clean(data.venue, MAX.venue),
    details: clean(data.details, MAX.details),
  };
  if (!f.name || !f.details || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) {
    return json({ ok: false, error: "Please fill in your name, a valid email and the details." }, 400);
  }

  const rows = [
    ["Name", f.name],
    ["Email", f.email],
    ["Phone", f.phone || "-"],
    ["Event date", f.date || "-"],
    ["Venue / location", f.venue || "-"],
  ];
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nDetails:\n${f.details}\n`;
  const html =
    `<h2>New booking request</h2><table cellpadding="6" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${escapeHtml(v)}</td></tr>`).join("") +
    `</table><h3>Details</h3><p style="white-space:pre-wrap">${escapeHtml(f.details)}</p>` +
    `<p style="color:#777">Reply to this email to answer ${escapeHtml(f.name)} directly.</p>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.BOOKING_FROM,
      to: env.BOOKING_TO.split(",").map((s) => s.trim()).filter(Boolean),
      reply_to: f.email,
      subject: oneLine(`Booking request from ${f.name}`).slice(0, 150),
      text,
      html,
    }),
  });

  if (!res.ok) {
    console.error("Resend error", res.status, await res.text());
    return json({ ok: false, error: "Couldn't send your request. Please try again." }, 502);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/songs" || pathname.startsWith("/api/songs/")) {
      return handleSongs(request, env, ctx);
    }
    if (pathname === "/api/media" || pathname.startsWith("/api/admin/") || pathname.startsWith("/media/")) {
      return handleMedia(request, env, ctx);
    }
    if (pathname === "/api/booking") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleBooking(request, env);
    }
    // Everything else is the static site.
    return env.ASSETS.fetch(request);
  },
};
