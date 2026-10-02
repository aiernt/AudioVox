# AudioVox Calendar Integration Plan

_Last updated: 2026-09-18_

## Why We're Doing This

The Shows section currently embeds the band's Google Calendar directly as an iframe (the same calendar linked from the Linktree page). It works, but it looks like a generic Google Calendar widget dropped into the page — it doesn't match the site's dark, red-accented design, and the band doesn't like how it looks sitting there.

The fix: keep using that same Google Calendar as the single source of truth for show dates (so booking/updating a show stays exactly as easy as it is today — just edit the calendar), but stop embedding Google's own widget. Instead, pull the event data out via Google's API and render it ourselves, styled to match the rest of the site.

## Proposed Approach

Use the Google Calendar API (v3) to fetch upcoming events directly from the browser, using a restricted API key, and render them as a styled list/cards in the site's own look — no iframe, no Google branding.

This is a read-only, client-side fetch: no backend server needed, consistent with how the rest of this site works (plain HTML/CSS/JS, no build step).

## Setup Steps (Google Cloud)

1. Create or select a project in Google Cloud Console, under the Google account that owns the AudioVox calendar.
2. Enable the **Google Calendar API** (APIs & Services → Library → search "Google Calendar API" → Enable).
3. Create an **API key** (APIs & Services → Credentials → + Create Credentials → API key) — choose "Application data," not "User data," and skip any Service Account / IAM role step.
4. Restrict the key:
   - **Application restrictions → Websites**, allowing: `audiovox.huddlegab.com/*`, `audiovoxmusic.com/*`, `www.audiovoxmusic.com/*`
   - **API restrictions → Restrict key** to just Google Calendar API
5. Confirm the calendar's sharing setting is "Make available to public" (Calendar Settings → Access permissions) — likely already true since the embed works today.

Cost/quota: confirmed free, no billing account required. Quota checked in Cloud Console: 10,000 queries/minute overall, 600/minute per user — far beyond anything this site would ever use.

## Current Blocker

Waiting on the API key from the person who owns the Google account/email that manages the AudioVox calendar. Once that key is in hand, the front-end work below can start.

## Implementation Plan (once the key arrives)

1. Add the fetch call (client-side JS) to `js/app.js`, hitting the Calendar API's `events.list` endpoint for the AudioVox calendar id, filtered to upcoming events only.
2. Render each event as a styled card/row matching the site's dark theme (date, time, venue/title from the event), reusing the visual language already used elsewhere (red accents, Bebas Neue headings).
3. Remove the `<iframe>` embed and the now-unused `.calendar-frame` CSS from the Shows section.
4. Keep a plain link out to the full public Google Calendar (or the Linktree "Upcoming Shows" link) for anyone who wants to subscribe/see the full calendar view.
5. Handle the empty state (no upcoming events) with a simple friendly message rather than a blank section.

## Open Questions To Confirm

- How many upcoming events to show at once (e.g., next 5? all within 60 days?)
- Any need to show past/recent shows, or upcoming only?
- Preferred date/time display format
- Confirm the API key has arrived and is restricted as described above before it goes live
