# Henry Watch Tracker — v5.0

Pure polish release on top of v1–v4 — no new screens, no new core features, no AI backend. Still Airtable-only, still a static PWA.

## v5 polish

1. **Automatic TMDb posters** — optional: add a free TMDb API key in Settings. For any title missing a Poster/Image in Airtable, the app looks it up live from TMDb (cached in your browser so it's only fetched once per title) instead of showing the styled fallback. Leave the key blank and nothing changes — you still get the cinematic fallback cards from v3/v4.
2. **Blurred hero/detail backgrounds** — already present from v4 (detail banner), now also used in the fade-in transition when a TMDb poster resolves for the hero card.
3. **Card design refinements** — smoother shadows, consistent corner radii, and a `poster-fade-in` transition so newly-loaded artwork doesn't pop in jarringly.
4. **Streaming service icons** — Netflix, Prime Video, Peacock, Hulu, Max, Disney+, Apple TV+, Paramount+, Theater, and Physical Media each get a small colored badge instead of plain text, used on cards, the hero, and the detail page's Watch Info section.
5. **Better animations** — rows still stagger-fade in (from v4); posters now fade in smoothly as they finish loading rather than snapping into place.
6. **Continue Watching** — unchanged from v4 (Status = Watching row on Home); confirmed still working.
7. **Smarter recommendation reasons** — a new "Why This Fits You" / 🧠 note on the detail page, computed entirely client-side (no AI call) by comparing the title's genres and moods against your Previously Watched titles and surfacing the best-matching, highest-rated overlaps — e.g. "Because you watched Sicario, Wind River & End of Watch." This is a live calculation, not stored in Airtable.
8. **Detail page polish** — streaming chips, runtime next to language, smart-reason block, otherwise same structure as v4.
9. **Skeleton loading** — cards needing a TMDb lookup show a shimmering skeleton placeholder until the poster resolves (or fail gracefully back to the cinematic fallback if TMDb has nothing or no key is set).
10. **Performance** — poster lookups are now lazy via `IntersectionObserver`: TMDb is only queried for cards as they actually scroll into view, not all 100+ at once. Search input is debounced (160ms) so typing doesn't re-filter on every keystroke.

## Setting up TMDb posters (optional)

1. Create a free account at themoviedb.org
2. Settings → API → request a free API key (v3 auth)
3. Paste it into the new **TMDb API Key** field in this app's Settings screen
4. Nothing is written back to TMDb or to Airtable — it's a read-only image lookup, cached locally in your browser

If you skip this, the app works exactly as it did in v4: real Airtable posters where present, styled cinematic placeholders everywhere else.

## Everything else — unchanged from v4

Airtable connection/Settings, hero card, Pick Something, Tonight's Mood, Add Recommendation, Bulk Import, Stats, Install flow, Mark Watched/Favorite/Rewatch Soon/tap-to-rate, Search (now also covering type/language/platform/streaming/source/why), and the full poster-grid browsing experience across Home, list screens, and Search.

## File structure

```
watchtracker/
├── index.html         — app shell, all screens (+ TMDb key field in Settings)
├── style.css            — theme, skeleton shimmer, stream chips, fade-ins
├── app.js               — Airtable client, TMDb client, smart-reason engine, rendering
├── manifest.json         — PWA metadata
├── service-worker.js    — offline shell caching (v5 cache)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md             — this file
```

No dependencies, no build step. Edit files directly and re-upload to your host to deploy.
