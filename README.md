# Henry Watch Tracker — v6.0

Built incrementally on v1–v5 — no rebuild, no schema changes beyond what's documented below. Still Airtable-only, no AI backend, no second database.

## What's new in v6

### 1. Quick Add (replaces/upgrades Bulk Import)
The old Bulk Import screen is now **Quick Add** — same screen, same paste-based workflow, upgraded:
- Format now has a 9th field, **Current Streaming**: `Title | Type | Year | Language | Priority Queue | Mood | Match % | Why It Was Recommended | Current Streaming`
- Accessible from **Home** (new "⚡ Quick Add" quicklink) and **More ☰ → ⚡ Quick Add**
- **Preview before saving**: tap Preview and you'll see exactly which rows are new, which are updates to existing titles, and which had parse errors — nothing touches Airtable until you tap **Confirm & Save**
- **No duplicates, ever**: titles are matched by normalized name against your existing Titles table. A match updates that record (Status, Lists, Language, Priority, Mood, Match %, Why, Streaming, Recommendation Source) — every other field on that record (ratings, watch history, Canon, ownership, everything) is left exactly as it was, because Airtable's update API only touches the fields you explicitly send
- After saving: a summary count of saved vs. errored rows

### 2. Real TMDb posters, now with write-back
Already had read-only TMDb lookup since v5; v6 adds saving the result back to Airtable so you don't re-fetch every session:

**How it tries to save, in order:**
1. **Poster/Image** (your existing attachment field) — the app sends TMDb's poster URL to this field, and Airtable downloads and stores the image itself. This works for a normal Airtable attachment field, so in almost all cases **you don't need to add anything**.
2. **Poster URL** (fallback) — if step 1 fails for any reason (permissions, field type, etc.), the app tries writing the plain URL into a field literally named `Poster URL`.
3. If neither exists/works, posters still display in the app for that session (read from TMDb, just not saved) and Settings will tell you exactly what to add.

**My honest assessment for your base:** your `Poster/Image` field is a standard Airtable attachment field, which Airtable's API supports writing external URLs to directly — so step 1 should just work, and you most likely don't need to add a `Poster URL` field at all. The fallback exists as a safety net in case your token's permissions or field config behave differently than expected; the app will tell you plainly via a toast and in Settings if it ever needs that fallback field.

**Settings → 🖼 Fetch Missing Posters**: a new button that goes through every title missing artwork, looks each up on TMDb, and saves the result — one at a time with a short delay between requests (basic rate limiting) and a live `Fetching 12 of 143…` status line. In read-only mode it still fetches and displays posters for the session, but warns nothing will be saved.

Existing behavior unchanged: open any screen and titles missing posters get them lazily as they scroll into view (from v5), with a skeleton shimmer while loading.

### 3 & 4. Posters everywhere, detail page
No changes needed here — this was already true as of v5: Watch Next, High Priority, English/Foreign Dub rows, Search, hero (blurred background), and the detail page (large poster + blurred banner + match % + mood chips + streaming chips + Why It Was Recommended + rating buttons + Mark Watched/Favorite/Rewatch Soon) all already use real artwork with `cover` sizing (no stretching) and 2-line title support. v6 just makes the artwork itself more reliably populated and persistent.

## TMDb setup

1. Create a free account at themoviedb.org
2. Settings → API → request a free API key (v3 auth)
3. Paste it into **Settings → TMDb API Key** in this app
4. The key is stored only in your phone's browser `localStorage`, alongside your Airtable settings — it is never written into these files or any repository, and nothing is sent anywhere except directly from your browser to TMDb's and Airtable's APIs

No key = the app behaves exactly like v4 (Airtable posters where present, cinematic fallback elsewhere).

## Everything else — unchanged

Airtable connection/Settings, hero card, Pick Something, Tonight's Mood, Add Recommendation (single-entry form), Stats, Install flow, Search (title/type/genre/mood/language/streaming/source/why), all list filters, smart "Why This Fits You" overlap reasoning from v5.

## File structure

```
watchtracker/
├── index.html         — app shell, all screens (Quick Add preview UI, Fetch Missing Posters)
├── style.css            — theme, preview list styling, disabled states
├── app.js               — Airtable client (read/create/update + poster write-back), TMDb client, Quick Add preview/confirm flow
├── manifest.json         — PWA metadata
├── service-worker.js    — offline shell caching (v6 cache)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md             — this file
```

No dependencies, no build step. Edit files directly and re-upload to your host to deploy.
