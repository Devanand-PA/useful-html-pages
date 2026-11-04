# Smoke suites for `useful-html-pages`

Two single-file apps, one harness pattern: the real HTML is booted in
[jsdom](https://github.com/jsdom/jsdom) with its **network replaced by recorded
fixtures**, so each suite is fast, offline and reproducible.

| app | suite | fixtures | capture script |
|---|---|---|---|
| `anime-custom-lists.html` | `npm test` | `tests/fixtures/` | `npm run capture` (`capture-fixtures.sh`) |
| `jobs-custom-lists.html` | `npm run test:jobs` | `tests/fixtures-jobs/` | `npm run capture:jobs` (`capture-jobs-fixtures.sh`) |

`node_modules/` is already installed in this working copy. If you need to reinstall:

```bash
cd tests && npm i --cache ./.npm-cache     # sandboxes with a read-only HOME npm cache
cd tests && npm i                          # normal machine
```

---

## 1. `anime-custom-lists.html` — `npm test`

Deterministic end-to-end checks for the single-file app one directory up. The real
HTML is booted in [jsdom](https://github.com/jsdom/jsdom) with its **network replaced
by recorded fixtures**, so the suite is fast, offline and reproducible.

```bash
cd tests
npm test            # = node smoke.mjs
```

`node_modules/` is already installed in this working copy. If you need to reinstall:

```bash
cd tests && npm i --cache ./.npm-cache     # sandboxes with a read-only HOME npm cache
cd tests && npm i                          # normal machine
```

## What it checks

Everything is driven through the app's own test hook, `window.__animeTest`:

| id | scenario | assertion |
|----|----------|-----------|
| A | recommendations are visual | after boot + `computeRecs(true)`: at least one `.rec-card` is rendered, **every** rendered card contains an `<img>` with a non-empty absolute `http(s)` src, **every** object from `recCandidates()` has a non-empty `cover` and `synopsis`, and `recSource()` is `"providers"` (never `"offline"` — the hardcoded title-only fallback is the bug) |
| B | metadata back-fill | after `syncMissingMeta()`: every seeded entry (tier list and watch list) that has a title also has a `cover` and a `synopsis`, and every `.item` card in the grid shows real artwork instead of the `no image yet` tile. Back-fill runs concurrently at boot, so when nothing is pending the scenario blanks three tier entries itself and retries `syncMissingMeta()` until a pass completes |
| C | adult title searchable | `doSearch("redo of healer")` then `searchCandidates()` contains a title matching `/redo of healer/i` |
| D | relevance ranking | that same title is within the **first 5** candidates (it used to be hidden behind Kitsu's fuzzy text matches) — the app must merge providers and rank by relevance |
| E | app did not throw | no `window.onerror`, no unhandled rejection (page or Node level), no jsdom "uncaught" error while the scenarios run |
| F | watch chooser → EverythingMoe top 5 | every rendered card kind (`.item`, `.result-card`, `.rec-card`) carries **exactly one** `.watch-btn`; clicking it opens the `#watchMenu` chooser instead of navigating; the chooser lists **exactly five** uniquely-named sites in ranked order with the card's title as its headline; picking the **#1** site (pinned: Re:Anime → `https://reanime.to/search?q=<url-encoded title of that very card>`) opens it in `_blank`; a top-5 site with no shareable search route (currently Gotaku) opens its homepage instead; and `refreshWatchSites()` upgrades the list to `live` from the `everythingmoe-anime.html` fixture. If the ranking or a route changes, update `WATCH_PREFIX`/`WATCH_SITE` here together with `WATCH_REGISTRY`/`WATCH_BUNDLED` in the app and re-capture the fixture |
| G | tier weights follow position | `tierWeights(list)` is **strictly decreasing** top-to-bottom for the seeded ladder list **and** after a custom-named tier is unshifted on top (the "God tier" case); the unranked row (`""`) weighs less than the bottom tier; the scenario leaves the list untouched |
| H | duplicates: same show, other name | clicking the ⧉ overlay on the first `.rec-card` opens the `#dupeModal` picker; choosing a tracked entry records exactly one `{title, of}` pair, hides that card from the batch immediately, shows the `#dupePanel` with the pair, makes `buildSeenIndex().looksTracked` block it, and `dupeGuard()` counts the second name of the pair as already-counted; clicking ✕ in the panel restores the card in the batch and hides the empty panel |
| I | tier labels & notes edit in place | dbl-clicking a tier label swaps `.tl-text` for a `.tier-label-edit` input **inside the label** — Esc cancels, Enter commits and the repainted row shows the new name; dbl-clicking an `.item` card opens its tooltip with a focused `textarea.tt-notes-edit`, with `.tt-notes` verified to sit **below `.tt-syn`** — Enter saves (entry updated, 📝 dot on the card, editor closes), Esc cancels, clicking the notes reopens the editor, and saving blank text clears the note and the dot. No `prompt()` is used anywhere in the flow |

Results print as a compact PASS/FAIL table. Exit codes:

| code | meaning |
|------|---------|
| 0 | all green |
| 1 | at least one scenario failed (details in the table, stacks printed for errors) |
| 2 | `window.__animeTest` is missing/incomplete — scenarios are reported as SKIP, fixtures are still exercised, re-run once the hook lands |
| 3 | harness/boot failure (the page could not be booted, or `ready` never settled) |

A missing or broken hook never crashes the runner: missing scenarios show as `SKIP`,
failing ones as `FAIL` with the reason, and the fixture report always prints.

## Fixtures (`fixtures/`)

Every file is a **real HTTP response body** captured with `curl`, with the status code
in a sibling `<file>.status` file when it was not `200`. Re-capture everything:

```bash
cd tests && ./capture-fixtures.sh
```

The script extracts the app's seed / fallback-pool titles out of
`../anime-custom-lists.html` (between the `ISEKAI_SEED`, `WATCH_SEED` and
`OFFLINE_POOL` markers), so it follows the app when the title lists change.

| fixture | source | notes |
|---|---|---|
| `anilist-403.json` | `POST https://graphql.anilist.co` | **real 403**: "The AniList API has been temporarily disabled due to severe stability issues." This is the outage the app has to survive, so it is replayed for every AniList request |
| `kitsu-ping.json` | `/api/edge/anime?page[limit]=1` | boot liveness probe |
| `kitsu-search-redo-of-healer.json` | `filter[text]=redo of healer` | the actual fuzzy junk Kitsu returns (no "Redo of Healer" row at all) |
| `kitsu-categories-*.json` | `filter[categories]=<slug>&sort=-averageRating` | recommendation fallback discovery; captured for every slug the profile can plausibly pick (`isekai`, `adventure`, `fantasy`, `high-fantasy`, `dark-fantasy`, `supernatural`, `demon`, `action`, `romance`, `comedy`, `swordplay`) |
| `tvmaze-ping.json` / `tvmaze-search-redo-of-healer.json` | `shows/1`, `search/shows?q=` | |
| `ann-ping.xml` / `ann-title-redo-of-healer.xml` | `api.xml?title=~...` | raw XML, the app parses it with `DOMParser` |
| `everythingmoe-anime.html` | `everythingmoe.com/section/anime` | ranked anime-site toplist (HTML) the ▶ watch-site chooser refreshes from; pins the current top five — re-capture it together with the app's `WATCH_BUNDLED` when EverythingMoe's ranking changes |
| `jikan-ping.json` + `.status` | `api.jikan.moe/v4/anime/1` | unreachable from this environment (connection timeout) — the 5xx replay models the provider being down |
| `titles/kitsu--<slug>.json` | `filter[text]=<title>` | one per seed/fallback title, for back-fill + candidate hydration |
| `titles/tvmaze--<slug>.json` | `search/shows?q=<title>` | same |
| `titles/ann--<slug>.xml` | `api.xml?title=~<title>` | seed titles only |

Per-title captures use `page[limit]=3` to keep the directory small (~5 MB total).

### How requests are routed

`smoke.mjs` never matches on a full URL. It parses the URL and routes by **host and
query parameter shape**, so a new page size, extra `include=`, sort order or an added
parameter still resolves to the same fixture:

| host | rule | fixture |
|---|---|---|
| `*anilist*` | any GraphQL request | `anilist-403.json` (403) |
| `*kitsu*` | has `filter[text]` | `titles/kitsu--<slug>.json` |
| | has `filter[categories]` | `kitsu-categories-<slug>.json` |
| | no filters | `kitsu-ping.json` |
| `*jikan*` | any | `jikan-ping.json` (and its status, if recorded non-200) |
| `*tvmaze*` | has `q` | `titles/tvmaze--<slug>.json` |
| | `/shows/<id>` | `tvmaze-ping.json` |
| `*animenewsnetwork*` | has `title` | `titles/ann--<slug>.xml` |
| | has `id` | `titles/ann-id--<id>.xml` |
| `*everythingmoe*` | any | `everythingmoe-anime.html` (the ▶ chooser's "live" refresh; the CORS relays the app tries after the direct fetch surface here as unmatched hosts when the fixture is missing) |

Anything unmatched returns an empty, provider-shaped payload and is listed under
**unmatched requests** in the report. If the app starts calling a new endpoint, the run
does not silently skew — the request shows up there, and you extend the capture script.

## Environment knobs

| variable | default | effect |
|---|---|---|
| `SMOKE_REALTIME=1` | off | honour the app's real throttles (2.2 s per entry, 1.5 s boot polls). Slow (~minutes) but closest to a browser |
| `SMOKE_VERBOSE=1` | off | forward the page console to stdout |
| `SMOKE_READY_TIMEOUT` | `20000` | ms to wait for `__animeTest.ready` |
| `SMOKE_DUMP_URLS=1` | off | dump every distinct URL the app requested, with counts |

The suite also widens `__animeTest.apiConfig.searchDeadline` to 60 s when the hook
exposes it, so the app's provider-search deadline can never beat the instant fixture
replay. Hook surface the suite relies on beyond the base contract: `recSource()`
(scenario A), `apiConfig` (deadline knob), `pickBestHit()` (used only in failure
diagnostics), `watchSites()` (scenario F's ranked list), `refreshWatchSites()`
(scenario F's live-refresh check), `tierWeights()` (scenario G), and `dupes()`,
`buildSeenIndex()` plus `dupeGuard()` (scenario H). All of it is optional except
the base contract in `smoke.mjs`.
| `SMOKE_APP=<path>` | `../anime-custom-lists.html` | boot another copy of the page (used to self-test the "hook missing" / "app threw" diagnostics) |

## Intentional limitations

- **Timers are clamped to 5 ms** unless `SMOKE_REALTIME=1`. The app spaces provider
  calls with `setTimeout(…, 2200)` (AniList's rate cap) and polls during boot; without
  clamping a 54-entry back-fill takes ~2 minutes. The fetch stub ignores `AbortSignal`,
  so clamped fetch watchdogs are harmless.
- **jsdom does not load images or lay out the page.** The suite asserts that `img`
  elements exist with an absolute `src`, not that the images render.
- **`localStorage` is cleared before every run**, so every run starts from the app's
  own seed data (no save slots, no recommendation cache).
- The AniList outage is *modelled*, not mocked away: if the API comes back, re-capture
  `anilist-403.json` (or add a healthy GraphQL fixture) before trusting scenario A to
  exercise the provider-discovery fallback.
- The suite only writes under `tests/`. It never edits the app.

---

## 2. `jobs-custom-lists.html` — `npm run test:jobs`

Same harness, different app: `smoke-jobs.mjs` boots `../jobs-custom-lists.html`
in jsdom with its network replayed from `fixtures-jobs/` and drives everything
through `window.__jobsTest`. The three job APIs it talks to are all CORS-open and
key-free, so the fixtures are real captured bodies (see
[`docs/jobs-api-capabilities.md`](../docs/jobs-api-capabilities.md)).

| id | scenario | assertion |
|---|---|---|
| A | matching jobs are visual | after `computeRecs(true)` + hydration: at least one `.rec-card` renders, **every** rendered card contains an `<img>` with a non-empty absolute `http(s)` src, **every** object from `recCandidates()` has a non-empty `cover` and `synopsis`, and `recSource()` is `"providers"` (never `"offline"`) |
| B | metadata back-fill | blanking every seeded job and re-running `syncMissingMeta()` leaves **every** entry with artwork and a description (or pay), and no `.item` still shows the “no image yet” tile |
| C | keyword search | `doSearch("python")` surfaces candidates whose tags include `python`, one rendered `.result-card` per candidate |
| D | relevance ranking | those python-tagged postings sit inside the **first 5** results (tag hits must outrank unrelated rows) |
| E | app did not throw | no `window.onerror`, no unhandled rejection (page or Node level) while the scenarios run |
| F | open-on chooser | every card kind (`.item`, `.result-card`, `.rec-card`) carries **exactly one** `.watch-btn`; clicking it opens `#watchMenu`; the chooser opens the card's own posting first (when it has a URL) then lists **exactly five** uniquely-named ranked sites in order (LinkedIn → Indeed → Glassdoor → Wellfound → Google Jobs); picking **#1** opens `https://www.linkedin.com/jobs/search?keywords=<url-encoded title of that card>` in `_blank` |
| G | tier weights follow position | `tierWeights(list)` is **strictly decreasing** top-to-bottom for the seeded ladder, the unranked row weighs less than the bottom tier, and a custom-named tier unshifted on top (“God”) pins at 1.0 without breaking strict decrease |
| H | duplicates: same job, another name | clicking ⧉ on the first `.rec-card` opens `#dupeModal`; choosing a tracked job records exactly one `{key, of}` pair, hides that card from the batch (the next-best match steps into its slot), shows `#dupePanel` with the pair, makes `buildSeenIndex().looksTracked` block it, and `dupeGuard()` counts the other name of the pair as already-counted; ✕ restores it |
| I | tier labels & notes edit in place | dbl-clicking a tier label swaps `.tl-text` for a `.tier-label-edit` input inside the label — Esc cancels, Enter commits and the repainted row shows the new name; dbl-clicking an `.item` opens its tooltip with a focused `textarea.tt-notes-edit` **below `.tt-syn`** — Enter saves (📝 dot appears), Esc cancels, saving blank text clears the note and the dot. No `prompt()` anywhere in the flow |
| J | posting URL → card | `addCard.open({mode:"url", url})` opens the modal with all three flavours; **⚡ Fetch details** walks the relay chain and fills `#acTitle` / `#acCompany` from the captured reader response for a real Greenhouse posting; saving files the card in the chosen tier with its URL and fetched description |
| K | screenshot → card | `addCard.attachImage(dataUrl)` opens the modal in screenshot mode with the preview rendered; saving produces a card whose `cover` stays the `data:image` URL (jsdom has no canvas, so no downscaling happens), `shot === true`, and the card renders `img.shot` plus the 📷 dot |
| L | pay & region normalisation | `parsePay` annualises monthly (`$3.5k–$5k/month` → 60k), hourly (`$50–$75/hour` → 104k) and yearly strings, leaves “competitive” unparsed; `regionOf` buckets “Berlin, Germany” → `Germany` and Remote/Worldwide → `Worldwide`; `canonSkill("typescript")` → `TypeScript` |

### Fixtures (`fixtures-jobs/`)

Every file is a **real HTTP response body** captured with `curl` by
`capture-jobs-fixtures.sh`; a non-200 gets a `<file>.status` sidecar. Re-capture
everything with `npm run capture:jobs`.

| fixture | source | notes |
|---|---|---|
| `remotive-ping.json` | `remotive.com/api/remote-jobs?limit=1` | boot liveness probe (also the body Remotive serves for every query right now — see below) |
| `remotive-search-python.json` | `?limit=20&search=python` | the search result pool: 12 postings with tags, pay strings and logos |
| `remotive-search-designer.json`, `remotive-category-software-development.json` | same host, other params | captured; byte-identical to the ping body |
| `jobicy-ping.json` | `jobicy.com/api/v2/remote-jobs?count=1` | boot probe |
| `jobicy-industry-{engineering,data-science,seller,management}.json` | `?count=20&industry=<slug>` | **the four most frequent industries, under their official slugs** — Jobicy answers a *label* slug (e.g. `industry=software-engineering`) with HTTP 400 `Invalid 'industry' value`; the full vocabulary comes from `?get=industries` |
| `arbeitnow-ping.json` | `arbeitnow.com/api/job-board-api?page=99999` | 747 bytes: a page past the end, an empty `data` array — the cheap ping for a 2.4 MB-per-page board |
| `arbeitnow-board.json` | `?page=2` | 300 real postings (tags, locations, `remote` flags; **no company logos**, which is why the app treats the board as a discovery source only) |
| `jina-greenhouse.txt` | `r.jina.ai/https://job-boards.greenhouse.io/gitlab/jobs/8629019002` | the reader-relay answer scenario J parses: a `Title:` line plus the posting's opening paragraphs |

**Known upstream quirk recorded in the fixtures:** Remotive is currently serving a
*collapsed* Cloudflare cache — `search=python`, `search=designer`, `category=…`
and `limit=1` all return the same 12 postings (identical `cf-cache-status: HIT`
and `last-modified`), and `limit` is ignored. The fixtures are real and faithful,
but the suite therefore cannot assert server-side search filtering against
Remotive; it asserts relevance ranking over the returned pool instead. Re-capture
when Cloudflare stops collapsing the cache key.

### How requests are routed

Like `smoke.mjs`, `smoke-jobs.mjs` never matches on a full URL — it routes by host
and query-parameter shape, so a new page size or an added parameter still lands on
the same fixture:

| host | rule | fixture |
|---|---|---|
| `*remotive*` | has `search` | `remotive-search-python.json` |
| | has `category` | `remotive-category-software-development.json` |
| | otherwise | `remotive-ping.json` |
| `*jobicy*` | has `industry` | `jobicy-industry-<slug>.json` (falls back to the engineering slice) |
| | otherwise | `jobicy-ping.json` |
| `*arbeitnow*` | `page=99999` | `arbeitnow-ping.json` |
| | any other page | `arbeitnow-board.json` |
| `*r.jina.ai*` | any | `jina-greenhouse.txt` |
| anything else | — | 404 + empty body, listed under **unmatched requests** |

Anything unmatched returns an empty payload and is reported: the relay chain the
app walks for “paste a URL” (direct fetch → reader → allorigins → corsproxy)
surfaces there as one direct hit per fetch, which is exactly what a CORS-blocked
job board looks like from a browser.

### Environment knobs

Same as the anime suite: `SMOKE_REALTIME=1`, `SMOKE_VERBOSE=1`,
`SMOKE_READY_TIMEOUT`, `SMOKE_DUMP_URLS=1`, `SMOKE_APP=<path>`. Exit codes are
identical (0 all green · 1 failure · 2 hook missing · 3 harness/boot failure).

Intentional limitations specific to the jobs suite:

- **jsdom has no canvas**, so a pasted/dropped screenshot is stored as its raw
  data URL. Scenario K asserts that path; the canvas downscale a real browser
  performs is not covered by the suite (it is exercised by the screenshots in
  `docs/`, which were taken in headless Chromium against the live APIs).
- The suite asserts **relevance ranking over a fixed pool** (see the Remotive
  cache quirk above), not which postings a provider happens to return.
- The suite only writes under `tests/`. It never edits the app.
