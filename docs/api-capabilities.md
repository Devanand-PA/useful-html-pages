# Live anime-API capability report

Measured from this machine on **2026-10-21 23:48 → 2026-10-22 00:05 UTC** (IST 05:18–05:35) with
`curl --max-time 30`, requests to the same host spaced ~1 s apart.
Every claim below is backed by a command + condensed real output; the raw responses are committed
next to this file under [`docs/evidence/`](evidence/) and can be regenerated with
`bash docs/evidence/capture.sh`.

Scope: what `anime-custom-lists.html` can still do from a `file://` page (null origin, no key, no backend)
while AniList's GraphQL API is disabled.

---

## 0. TL;DR — decision table

| Provider | Text search | Genre/category browse | Cover | Synopsis | Score | Adult titles incl. "Redo of Healer" | CORS `*` on GET | Verdict |
|---|---|---|---|---|---|---|---|---|
| **AniList** GraphQL | ✗ 403 | ✗ 403 | (cached URLs still load) | ✗ | ✗ | n/a | ✗ **no ACAO on the 403** | **Dead right now.** Detect + degrade. |
| **Kitsu** `kitsu.io/api/edge` | ✓ but *badly* fuzzy, hides adult rows | ✓ `filter[categories]=<slug>` | ✓ `posterImage` | ✓ `synopsis` (HTML-ish) | ✓ `averageRating` 0–100 string | ✗ R18 records are deleted (404) | ✓ | **Best metadata + genre discovery source.** |
| **Jikan v4** `api.jikan.moe` | unreachable from this host | unreachable | — | — | — | `sfw` documented, unverifiable here | untestable | **Cannot be relied on from this machine.** Optional enhancement only. |
| **TVmaze** `api.tvmaze.com` | ✓ fuzzy + **relevance score**, *does* include Adult | ✗ (no genre filter) | ✓ `image` | ✓ `summary` (HTML) | ✓ `rating.average` (0–10) | ✓ finds it (`id 52532`, genres incl. `Adult`) | ✓ | **Best text-search / rescue path for adult titles.** |
| **ANN** `cdn.animenewsnetwork.com/encyclopedia/api.xml` | ✓ `anime=~<name>` exact-ish | ✗ genre browse **removed** | ✓ `type="Picture"` | ✓ `type="Plot Summary"` | ✓ `<ratings weighted_score>` | ✓ `anime=~redo of healer` → id 23465 | ✓ (api.xml) | **Per-title enrichment only.** |

Three things that change the app's design:

1. **Kitsu silently ignores unknown category slugs.** A typo'd genre does not return `[]`, it returns the
   whole 22 515-title catalogue. Never trust `filter[categories]` without a slug whitelist.
2. **Kitsu deleted its R18 catalogue.** "Redo of Healer" survives only as a *dangling* MAL→Kitsu mapping
   row pointing at an anime id that now 404s. There is no way to retrieve it from Kitsu.
3. **ANN's `genre=` / `nskip=` browse is gone** (`<warning>ignored genre=Fantasy</warning>`), and
   `reports.xml` is the one endpoint **without** `Access-Control-Allow-Origin` — unusable from `file://`.

---

## 1. CORS matrix (the app runs from a `file://` URL ⇒ `Origin: null`)

Checked on the real `GET` with `-H 'Origin: null'`; "*present*" means literally
`access-control-allow-origin: *` in the response headers of that request.

| Endpoint (actual GET) | `Access-Control-Allow-Origin` | Usable from `file://`? |
|---|---|---|
| `https://graphql.anilist.co` — `POST` while disabled | **absent** (`HTTP/2 403`, only `content-type: application/json`) | ✗ browser reports a **CORS error**, not a 403 |
| `https://graphql.anilist.co` — `OPTIONS` preflight | `*` (`HTTP/2 204`) | preflight passes; the real response then fails |
| `https://kitsu.io/api/edge/anime…` | `*` | ✓ |
| `https://kitsu.io/api/edge/categories…` | `*` | ✓ |
| `https://api.tvmaze.com/search/shows…` | `*` | ✓ |
| `https://api.tvmaze.com/shows…` | `*` | ✓ |
| `https://cdn.animenewsnetwork.com/encyclopedia/api.xml…` | `*` | ✓ |
| `https://cdn.animenewsnetwork.com/encyclopedia/reports.xml…` | **absent** (`grep -c access-control ann-reports.hdr` → `0`) | ✗ **the CORS-unsafe one** |
| `https://www.animenewsnetwork.com/encyclopedia/anime.php?genre[]=…` (HTML) | **absent** | ✗ (and it is HTML, not XML) |
| `https://api.jikan.moe/v4/…` | untestable (host unreachable, see §4) | ? |
| `https://s4.anilist.co/…cover…jpg` (image CDN) | n/a — `<img>` needs no CORS | ✓ still serves: `200 image/jpeg 83 836 B` |

```console
$ curl -s -D - -o /dev/null -H 'Origin: null' -X POST https://graphql.anilist.co \
       -H 'Content-Type: application/json' -d '{"query":"{Media(id:1){id}}"}'
HTTP/2 403
date: Wed, 21 Oct 2026 23:48:04 GMT
content-type: application/json
content-length: 334
cache-control: private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0
x-frame-options: SAMEORIGIN
server: cloudflare
cf-ray: a4e426aa19851190-COK
#  <-- no access-control-allow-origin anywhere in the response

$ curl -s -D - -o /dev/null -H 'Origin: null' -X OPTIONS https://graphql.anilist.co \
       -H 'Access-Control-Request-Method: POST'
HTTP/2 204
access-control-allow-origin: *
access-control-allow-headers: Authorization,Accept,DNT,X-CustomHeader,Keep-Alive,User-Agent,…
access-control-allow-methods: GET, POST, OPTIONS
```

**Consequence for the app:** a `fetch('https://graphql.anilist.co', …)` from `file://` rejects with
`TypeError: Failed to fetch` — you never see the JSON body — so the AniList branch cannot distinguish
"API disabled" from "network offline". Treat *any* rejection/!ok as "provider down" and fall through.

---

## 2. AniList — globally disabled, no working shape

Every query shape returns the same 403 body. There is no field-level or endpoint-level workaround.

```console
$ curl -s -X POST https://graphql.anilist.co -H 'Content-Type: application/json' \
    -d '{"query":"{ Page(perPage:2){ media(sort:TRENDING_DESC,type:ANIME){ id title{romaji} } } }"}'
{
    "errors": [
        {
            "message": "The AniList API has been temporarily disabled due to severe stability issues.",
            "status": 403,
            "locations": [ { "line": 1, "column": 1 } ]
        }
    ],
    "data": null
}
```

| Probe | Result |
|---|---|
| `POST /` with `Page`/`Media` query | `403` + JSON above |
| `POST /` with the most trivial query `{Media(id:1){id}}` | `403`, identical body |
| `GET /?query={Media(id:1){id}}` | `403` |
| `GET /` (no body) | `403`, `content-type: text/html` (nginx page) |
| `POST https://anilist.co/graphql` | `302` (no GraphQL there) |
| `POST https://anilist.co/api/v2/oauth/token` | `302` |
| `OPTIONS /` | `204` + full CORS headers (preflight is fine) |
| Image CDN `s4.anilist.co` | `200 image/jpeg` — cached cover URLs still render |

The message is AniList's documented circuit-breaker, not a permissions problem:
their API docs state that "in cases of severe outages, we may lower the rate limits … or in extreme
cases, temporarily suspend access to the API", with announcements in the AniList Discord
([docs.anilist.co/guide/considerations](https://docs.anilist.co/guide/considerations)). The same
string has been reported repeatedly by other projects
([AniLibApp #112](https://github.com/AniLibApp/AniLib/issues/112),
[AniFillerPedia #237](https://github.com/Napandee/AniFillerPedia/issues/237),
[r/animexplore](https://www.reddit.com/r/animexplore/comments/1s7z5cp/anilist_api_issue_temporary_outage/)).

**What an app should do**

* Assume AniList may be down for hours/days; never make it a blocking step of page render.
* Probe once at boot with a cheap query and a short `AbortController` timeout (5–8 s), cache the verdict
  in memory/localStorage for ~10 min, and skip AniList for the rest of the session if it fails.
* Do **not** retry per keystroke or per card. One probe, then degrade.
* Persist AniList-sourced covers/synopses you already fetched — the CDN still serves them, so archived
  entries keep their images even while the API is down.
* Keep your own `source`/`srcId` per entry so a future re-sync can go back to AniList when it returns.

---

## 3. Kitsu — the metadata back end (still works, with sharp edges)

Base: `https://kitsu.io/api/edge` · JSON:API (`data[].attributes`), CORS `*`, no key needed.

### 3.1 Text search

```
https://kitsu.io/api/edge/anime?filter%5Btext%5D=<query>&page%5Blimit%5D=10
```

`filter[text]` is **fuzzy and relevance-poor**, and it **silently omits adult rows**:

```console
$ curl -s 'https://kitsu.io/api/edge/anime?filter%5Btext%5D=redo%20of%20healer&page%5Blimit%5D=10'
rows: 6
  42903 'Re:Zero kara Hajimeru Isekai Seikatsu: Shin Henshuu-ban'   avg=82.12
  13141 'RE:Map'                                                   avg=None
  50805 'Tefuda ga Oome no Victoria'                               avg=74.45
  12139 'JRA Hokan Keikaku'                                        avg=56.51
  1671  'Rockman Hoshi ni Negai wo'                                 avg=66.56
  3251  'Evangelion: 3.0 You Can (Not) Redo'                       avg=76.25
```

The requested title is **not in the result set at all**, and the ordering is not by relevance
(`Re:Map` outranks `Evangelion 3.0`). Related probes:

| Query | Rows | Contains the searched title? |
|---|---|---|
| `redo of healer` (also `page[limit]=20`) | 6 | ✗ |
| `kaifuku` | 1 (`Chiyu Mahou no Machigatta Tsukaikata…`) | ✗ |
| `yarinaoshi` | 1 (`Yarinaoshi Reijou wa Ryuutei Heika wo Kouryaku-chuu`) | ✗ |
| `healer` | 8 (`Healer Girl`, `Kono Healer Mendokusai`, …) | ✗ |
| `frieren` | 6, all Frieren entries, best match first | ✓ |
| `ishuzoku` | 1 (`Ishuzoku Reviewers`, `nsfw=false`, `r`) | ✓ |

Why the adult title is unreachable — **it is not a ranking bug, the record is gone**:

```console
$ curl -s 'https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist%2Fanime&filter%5BexternalId%5D=40750&include=item'
rows: 1
item: ('Kaifuku Jutsushi no Yarinaoshi', kitsu_id 42732, ageRating 'R18', nsfw True)   # include=item still shows the stub

$ curl -s -w ' -> %{http_code}' https://kitsu.io/api/edge/anime/42732
{"errors":[{"title":"Record not found","detail":"The record identified by 42732 could not be found.","code":"404","status":"404"}]} -> 404

$ curl -s 'https://kitsu.io/api/edge/anime/46474'           # control
Sousou no Frieren                                            # 200

$ curl -s 'https://kitsu.io/api/edge/anime?filter%5BageRating%5D=R18&page%5Blimit%5D=3'
{"data":[],"meta":{"count":0}, …}                            # every R18 title is hidden
```

MAL→Kitsu mapping is otherwise healthy (`myanimelist/anime/1` → `1 Cowboy Bebop`,
`52991` → `46474 Sousou no Frieren`), so the dangling `40750 → 42732` is a deletion artefact, not a
mapping bug.

**Rate/limits & pagination (measured)**

| Thing | Result |
|---|---|
| `page[limit]` | **max 20** → `400 {"title":"Invalid page value","detail":"Limit exceeds maximum page size of 20.","code":"118"}` |
| `page[offset]` | works, e.g. `offset=10000` → 200 (undocumented cap, `links.next` still present) |
| `filter[nsfw]` | **rejected** → `400 {"title":"Filter not allowed","detail":"nsfw is not allowed.","code":"102"}` |
| `filter[userCount][gte]=10000` / `filter[averageRating][gte]=80` | `500 Internal Server Error` (no range filters) |
| `filter[ageRating]=R` / `PG` / `G` | **allowed** — counts 2 521 / 10 531 / 6 780; `R18` → 0 |
| Rate-limit headers | none (`x-ratelimit-*` absent; only `x-runtime`, `x-request-id`) |
| 8 back-to-back GETs | all `200`, 0.56–1.11 s each, no 429 |

Etiquette: keep it ≤ ~2 req/s, one genre page at a time, and back off on `429`/`500`.

### 3.2 Category / genre discovery

```
https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=<slug>&sort=-averageRating&page%5Blimit%5D=20
https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=<slug>&sort=-averageRating&page%5Blimit%5D=8&include=categories
```

```console
$ curl -s -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=fantasy&sort=-averageRating&page%5Blimit%5D=8&include=categories'
HTTP/2 200 · content-type: application/vnd.api+json · access-control-allow-origin: * · x-runtime: 0.236
rows: 8  included: 29 (type=categories)
  48323 'Chainsaw Man: Reze-hen'                        avg=88.92 users=  6024 eps=1  subtype=movie age=R  slug=Chainsaw-Man--The-Movie-Reze-Arc
  48671 'Ore dake Level Up na Ken: Season 2 - Arise…'   avg=86.25 users= 10282 eps=13 subtype=TV    age=PG slug=Solo-Leveling-Season-2-…
  46474 'Sousou no Frieren'                             avg=88.85 users= 21336 eps=28 subtype=TV    age=PG slug=sousou-no-frieren
  49240 'Sousou no Frieren 2nd Season'                  avg=88.42 users=  6322 eps=10 subtype=TV    age=PG
  49746 'Re:Zero kara Hajimeru Isekai Seikatsu 4th S.'  avg=87.78 users=  3066 eps=19 subtype=TV    age=PG
  45515 'Arcane Season 2'                               avg=85.80 users=  2699 eps=9  subtype=ONA   age=PG
  49001 'Kimetsu no Yaiba: Mugenjou-hen Movie 1'        avg=87.01 users=  5003 eps=1  subtype=movie age=R
  46043 'Tongari Boushi no Atelier'                     avg=86.27 users=  5236 eps=13 subtype=TV    age=None
```

⚠️ **Unknown slug trap** — the filter is *silently dropped*, it does not return an empty list:

```console
$ curl -s 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=zzzznotarealcategory&page%5Blimit%5D=3'
rows: 3   meta: {'count': 22515}   # i.e. the entire catalogue
   'Attack on Titan', 'Boku no Hero Academia', 'Boku no Hero Academia 2'

$ curl -s 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=school&page%5Blimit%5D=3'
rows: 3   meta: {'count': 22515}   # 'school' is NOT a slug -> filter ignored

$ curl -s 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=school-life&page%5Blimit%5D=1'
count: 2015                        # the real slug works
```

So: hard-code a verified slug map (below) and, as a cheap runtime guard, treat
`meta.count === 22515` (or any "top of catalogue" payload) as "slug rejected".

`sort` values that work: `-averageRating`, `-userCount`, `popularityRank`, `-startDate`.
Prefer `-userCount` for recommendations — `-averageRating` promotes 6 024-user new movies to #1, while
`-userCount` yields Attack on Titan (617 909 users) / FMA:B (422 568).

### 3.3 Category slug list

`GET /api/edge/categories?page[limit]=100&page[offset]=0` → 3 pages, **218 slugs** total
(`data[].attributes.slug`, `.title`, `.totalMediaCount`, `.nsfw` — every row here reports `nsfw:false`).
Full machine-readable list: [`docs/evidence/kitsu-categories-p0.json` … `-p2.json`](evidence/).

The 22 genre names the app uses, mapped to **verified** slugs (`count` = `meta.count` of
`?filter[categories]=<slug>`):

| App genre | Kitsu slug | count | Notes |
|---|---|---|---|
| Action | `action` | 18 466 | |
| Adventure | `adventure` | 10 897 | |
| Comedy | `comedy` | 25 974 | |
| Drama | `drama` | 18 102 | |
| Fantasy | `fantasy` | 26 598 | also `fantasy-world` (1 543), `dark-fantasy` (185) |
| Horror | `horror` | 3 033 | |
| Mecha | `mecha` | 2 099 | also `super-robot` (85), `piloted-robot` (410) |
| Military | `military` | 1 348 | also `war` (404) |
| Music | `music` | 4 506 | also `musical-band` (119), `idol` (1 181) |
| Mystery | `mystery` | 3 994 | also `detective` (395) |
| Psychological | `psychological` | 3 514 | |
| Romance | `romance` | 27 889 | |
| Sci-Fi | `science-fiction` | 6 966 | **`sci-fi` / `scifi` do not exist** → filter silently dropped |
| School | `school-life` | 11 691 | **`school` does not exist**; `high-school` is a different, smaller tag (1 041) |
| Shounen | `shounen` | 3 661 | also `seinen` (3 223), `shoujo` (2 655), `josei` (1 512) |
| Slice of Life | `slice-of-life` | 10 774 | |
| Supernatural | `supernatural` | 4 584 | also `demon` (2 020), `ghost` (359), `vampire` (784) |
| Thriller | `thriller` | 2 784 | |
| Historical | `historical` | 4 374 | period tags: `sengoku-period` (40), `tokugawa-period` (32), `heian-period` (15) |
| Isekai | `isekai` | 2 812 | |
| Harem | `harem` | 3 750 | also `reverse-harem` (227), `love-polygon` (315) |
| Ecchi | `ecchi` | 5 825 | returns `ageRating: R`/`PG` titles only, `nsfw:false` |

Some other useful slugs from the same dump: `sports` (4 205), `magic` (4 077), `martial-arts` (2 602),
`super-power` (1 965), `space` (912), `time-travel` (576), `crime` (564), `post-apocalypse` (526),
`samurai` (497), `coming-of-age` (487), `working-life` (459), `cooking` (427), `family` (421),
`cyberpunk` (163), `steampunk` (114), `dystopia` (176), `zombie` (288), `yaoi` (8 414),
`shoujo-ai` (5 885), `kids` (2 723), `parody` (1 097), `magical-girl` (702), `gender-bender` (651),
`dementia` (647), `loli` (684), `tentacle` (179), `netorare` (172), `ahegao` (252).
Empty/meta rows to ignore: `content-indicators`, `elements`, `setting`, `themes`,
`target-demographics` (`totalMediaCount: 0`), `dynamic` (1).

The full 218-slug list (slug(`totalMediaCount`)) is in
[§ 9 Appendix](#9-appendix-kitsus-218-category-slugs).

### 3.4 Field mapping (`data[]` item)

| Need | JSON path | Example / notes |
|---|---|---|
| title | `attributes.canonicalTitle` | `"Sousou no Frieren"` — use as display title |
| alt titles | `attributes.titles.en` / `.en_jp` / `.ja_jp` | `titles.en` is often absent |
| **cover (poster)** | `attributes.posterImage.large` (or `.medium`) | `https://media.kitsu.app/anime/48323/poster_image/medium-….jpeg` — 2:3 poster, **use this for cards** |
| cover (banner) | `attributes.coverImage.large` | `3360×840` wide banner, not a card image |
| **synopsis** | `attributes.synopsis` (= `attributes.description`) | plain-ish text, sometimes contains no HTML, may be `null` |
| **score** | `attributes.averageRating` | **0–100 as a *string*** (`"88.92"`, `null` for unreleased) → `/10` for display |
| popularity | `attributes.userCount` (guests+users), `attributes.favoritesCount` | `617909` / `12345` |
| rank | `attributes.ratingRank`, `attributes.popularityRank` | lower = better (`popularityRank: 1` = Attack on Titan) |
| episodes | `attributes.episodeCount`, `attributes.episodeLength` | `null` while airing |
| airing | `attributes.startDate`, `attributes.endDate`, `attributes.status` | `"2023-09-29"`, `finished`/`current`/`tba` |
| format | `attributes.subtype`, `attributes.showType` | `TV`, `movie`, `ONA`, `OVA`, `special` |
| **adult flag** | `attributes.nsfw` (bool), `attributes.ageRating`, `attributes.ageRatingGuide` | observed `ageRating`: `G`, `PG`, `R`, `None`; R18 rows are **not** served by the API at all. `ageRatingGuide` like `"17+ (violence & profanity)"` |
| **genres** | `relationships.categories.data[].id` → names via `?include=categories` → `included[].attributes.title` | `["Drama","Fantasy",…]`; `relationships.genres` exists but is basically empty — **use categories** |
| canonical URL | `https://kitsu.io/anime/` + `attributes.slug` | `…/anime/sousou-no-frieren` → **200**. (`kitsu.app/anime/<slug>` → 403 to non-browser agents; fine in a real browser, so prefer `kitsu.io` for copy/paste links) |
| ids | top-level `data[].id` | numeric string, e.g. `"46474"` |

Everything above is present without `?include=`; `include=categories` costs nothing extra in latency
(`x-runtime: 0.236`) and gives you genre names in the same round trip.

---

## 4. Jikan v4 (MAL) — not reachable from this host

```console
$ curl -s -4 --connect-timeout 8 --max-time 12 -o /dev/null -w 'code=%{http_code} connect=%{time_connect} total=%{time_total}\n' https://api.jikan.moe/v4/anime/1
code=000 connect=0.000000 total=8.001180          # TCP connect never completes

$ curl -s -4 … https://api.jikan.moe/v4/genres/anime
code=000 connect=0.000000 total=8.000943

$ curl -sv -4 --connect-timeout 8 https://api.jikan.moe/v4/anime/1
*   Trying 135.181.39.91:443...
* Connection timed out after 8001 milliseconds

$ timeout 12 bash -c 'exec 3<>/dev/tcp/135.181.39.91/443'   # raw SYN test
tcp443 blocked/timeout

$ curl -s -o /dev/null -w '%{http_code}\n' https://jikan.moe/      # control, same domain
200          (server: Netlify)

$ curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/rate_limit   # control, other host
200
```

`api.jikan.moe` resolves to `135.181.39.91` (A) and `2a01:4f9:c010:b863::1` (AAAA); **both** addresses
black-hole TCP/443 and TCP/80 from this machine, while `jikan.moe` (Netlify) and other hosts answer
instantly. So this is a network-path/blocking problem, not a Jikan outage and not DNS. The same
`fetch failed` came back from a second, independent HTTP client on this host.

**Therefore: every Jikan behaviour below is documented, not observed.** Do not build a blocking
dependency on it. If the app keeps Jikan, it needs a 5–8 s `AbortController` timeout and a silent
fall-through, otherwise every search waits the full timeout before the fallback runs (this is very
likely what the user experienced as "search is stuck/empty").

Documented facts, from the official spec fetched from the docs site's own source
(`docs.api.jikan.moe` → `https://raw.githubusercontent.com/jikan-me/jikan-rest/master/storage/api-docs/api-docs.json`,
saved as [`docs/evidence/jikan-openapi.json.gz`](evidence/jikan-openapi.json.gz)):

* **Rate limits (verbatim from `info.description`):** `Daily Unlimited` · `Per Minute 60 requests` ·
  `Per Second 3 requests`, and "It's still possible to get rate limited from MyAnimeList.net instead."
  Exceeding it yields `429 RateLimitException`.
* **`/anime` query params:** `q`, `type`, `score`, `min_score`, `max_score`, `status`, `rating`, `sfw`,
  `genres` ("Filter by genre(s) IDs. Can pass multiple with a comma"), `genres_exclude`, `order_by`,
  `sort`, `letter`, `producers`, `start_date`, `end_date`, `limit`, `page`.
* **`sfw` (verbatim):** "'Safe For Work'. This is a flag. When supplied it will filter out entries
  according to the SFW Policy. You do not need to pass a value to it. e.g usage: `?sfw`". So `sfw=true`
  and bare `?sfw` mean the same thing.
* **Genre search ordered by score:**
  `https://api.jikan.moe/v4/anime?genres=10&order_by=score&sort=desc&min_score=7&sfw&limit=25`

### 4.1 Genre ids

`/v4/genres/anime` was not callable, so the ids are taken from **MAL's own genre index** (Jikan mirrors
MAL ids 1:1), scraped from the genre sidebar of `https://myanimelist.net/anime/genre/1/Action`
(+ `/genre/18/Mecha`, `/genre/36/Slice_of_Life`) — **62 ids**, all real links, saved verbatim to
[`docs/evidence/mal-genre-ids.txt`](evidence/mal-genre-ids.txt):

| App genre | MAL/Jikan id | | App genre | MAL/Jikan id |
|---|---|---|---|---|
| Action | 1 | | Mystery | 7 |
| Adventure | 2 | | Psychological | 40 |
| Comedy | 4 | | Romance | 22 |
| Drama | 8 | | Sci-Fi | 24 |
| Fantasy | 10 | | Slice of Life | 36 |
| Horror | 14 | | Supernatural | 37 |
| Mecha | 18 | | Thriller | **41 (`Suspense`)** |
| Military | 38 | | School | 23 |
| Music | 19 | | Ecchi | 9 |
| Shounen | 27 | | Isekai | 62 |
| Harem | 35 | | Historical | 13 |

Adjacent ids worth knowing: `5 Avant Garde`, `6 Mythology`, `17 Martial Arts`, `20 Parody`,
`21 Samurai`, `25 Shoujo`, `26 Girls Love`, `28 Boys Love`, `29 Space`, `31 Super Power`,
`32 Vampire`, `39 Detective`, `42 Seinen`, `43 Josei`, `62 Isekai`, `66 Mahou Shoujo`,
`73 Reverse Harem`, `82 Urban Fantasy`.

### 4.2 Does `sfw` remove adult entries? — the premise was wrong

The title in question is **not** `Rx` on MAL:

```console
$ curl -sL 'https://myanimelist.net/anime.php?q=redo%20of%20healer&cat=anime' | grep -oE 'myanimelist\.net/anime/[0-9]+/[A-Za-z0-9_]+' | sort -u
myanimelist.net/anime/40750/Kaifuku_Jutsushi_no_Yarinaoshi      <-- the real id
myanimelist.net/anime/52991/Sousou_no_Frieren
…

$ curl -s 'https://myanimelist.net/anime/40748'
<title>Jujutsu Kaisen (TV 2020) - MyAnimeList.net</title>       <-- 40748 is Jujutsu Kaisen

$ curl -s 'https://myanimelist.net/anime/40750'
<title>Kaifuku Jutsushi no Yarinaoshi (Redo of Healer) - MyAnimeList.net</title>
Rating: R+ - Mild Nudity
```

**MAL id 40748 = Jujutsu Kaisen. The correct id is 40750**, and its MAL rating is
`R+ - Mild Nudity`, not `Rx - Hentai`. A `sfw`-based filter therefore would *not* be what hides it —
whatever the app's adult filtering does, it is not the cause of this bug. (Corroborating adult-ish
signals come from the other providers: TVmaze tags it `Adult`, ANN rates it `Objectionable content: MA`.)

---

## 5. TVmaze — best text search, only place adult titles surface

Base `https://api.tvmaze.com`, CORS `*`, no key.

```console
$ curl -s -D - -H 'Origin: null' 'https://api.tvmaze.com/search/shows?q=redo%20of%20healer'
HTTP/2 200
content-type: application/json; charset=UTF-8
access-control-allow-origin: *
rows: 1
  id=52532 'Redo of Healer'  type='Animation'  genres=['Action','Anime','Fantasy','Adult']  score=1.373
```

```json
{ "name": "Redo of Healer", "type": "Animation", "language": "Japanese",
  "genres": ["Action","Anime","Fantasy","Adult"], "premiered": "2021-01-14",
  "rating": {"average": 6.5}, "averageRuntime": 25,
  "image": {"medium": "https://static.tvmaze.com/uploads/images/medium_portrait/289/723822.jpg",
            "original": "https://static.tvmaze.com/uploads/images/original_untouched/289/723822.jpg"},
  "summary": "<p>\"Healing magicians cannot fight alone.\" Keyaru, …</p>",
  "url": "https://www.tvmaze.com/shows/52532/redo-of-healer" }
```

* **Ranking is real relevance** — `/search/shows` results carry a `score` float (not a percentage).
  `q=frieren` → `Frieren: Beyond Journey's End` 0.533, `Sousou no Frieren: … no Mahou` 0.450,
  then unrelated `Frieden` 0.392 / `Friheden` 0.376. Sorting by `score` desc gives a sensible order, so
  this is the provider to use when you need "did the user mean this title?" rather than "any row".
* **It tags anime explicitly:** `show.type === "Animation"` **and** `show.genres` contains `"Anime"`
  (and `"Adult"` for adult titles). That is a usable client-side anime/adult classifier.
* **No genre browse:** `/shows?genre=anime&page=0` returns 240 arbitrary shows (`Under the Dome`,
  `Person of Interest`, …) — the parameter is ignored, exactly like Kitsu's unknown-slug trap. There is
  no genre-filter endpoint; `/shows?page=N` is a full-database crawl. Use `/search/shows` only.
* **Ranking/other fields:** `rating.average` (0–10, `null` a lot), `externals.imdb`/`.thetvdb`,
  `averageRuntime`, `status`, `premiered`. No episode count on the search payload (needs `/shows/:id/episodes`
  or `?embed=episodes`).
* **Rate limit (documented on [tvmaze.com/api](https://www.tvmaze.com/api)):** "at least 20 calls every
  10 seconds per IP address", `429` on excess, responses cached ~60 min at the edge. Measured: 12 rapid
  requests → `200` ×12.
* Summary is HTML (`<p>…</p>`) — strip tags before display.

---

## 6. ANN encyclopedia XML — per-title enrichment only

Base `https://cdn.animenewsnetwork.com/encyclopedia/api.xml`, CORS `*` (verified on the GET).

**Search by name works** (documented syntax is `~name` — a tilde *prefix*, not `name~`):

```console
$ curl -s 'https://cdn.animenewsnetwork.com/encyclopedia/api.xml?anime=~redo%20of%20healer'
<ann><anime id="23465" gid="1052805374" type="TV" name="Redo of Healer" precision="TV" …>
  <info … type="Picture" src="https://cdn.animenewsnetwork.com/thumbnails/fit200x200/encyc/A23465-….jpg" …/>
  <info … type="Plot Summary">Keyarga is a healer who is used and tossed around by his fellow adventurers…</info>
  <info … type="Genres">adventure</info>
  <info … type="Themes">ecchi</info>
  <info … type="Vintage">2021-01-13</info>
  <info … type="Objectionable content">MA</info>
  <ratings nb_votes="225" weighted_score="5.5084" bayesian_score="5.60766"/>
```

`anime=~frieren` → `id="38838" name="Frieren: Beyond Journey's End"` (also with Picture).
`anime=~kaifuku` → `<warning>no results for anime=~kaifuku</warning>` (romaji is not an ANN primary
name — pass the English title), and `id=1` / `anime=1` still fetch a single title by id.

**Genre browse is gone.** Both parameters the app was relying on are now rejected:

```console
$ curl -s 'https://cdn.animenewsnetwork.com/encyclopedia/api.xml?genre=Fantasy&nskip=0'
<ann><warning>ignored genre=Fantasy</warning><warning>ignored nskip=0</warning></ann>   # 85 bytes, HTTP 200

$ …?genre=fantasy / ?genre=anime / ?genre=Science%20Fiction / ?nskip=10 / ?nlist=all
<ann><warning>ignored genre=fantasy</warning></ann>        … same shape, all "ignored"
$ …?anime=genre~fantasy        -> <ann><warning>no result for anime=genre~fantasy</warning></ann>
$ …?anime=themes~ecchi         -> <ann><warning>no result for anime=themes~ecchi</warning></ann>
```

Details are still rich: on `anime=1` the tags present are `Picture`, `Plot Summary`, `Genres` (3),
`Themes` (2), `Vintage`, `Running time`, `Number of episodes`, `Objectionable content`,
`Alternative title` (3), `Opening Theme`, `Ending Theme`, `Insert song`, `Official website`,
`Main title`, plus `<ratings nb_votes="352" weighted_score="5.8028" bayesian_score="5.85772"/>`.
Genres come back **lower-case** (`action`, `drama`, `science fiction`) and themes separately
(`ecchi`), so ANN genre strings do not match either Kitsu slugs or MAL ids.

**CORS-unsafe endpoint:** `reports.xml` has **no** `access-control-allow-origin`, so the bulk-list feed
(`reports.xml?id=155&type=anime&nlist=all`) — the only remaining way to enumerate ANN titles — cannot be
read from a `file://` page:

```console
$ curl -s -D - -o /dev/null -H 'Origin: null' 'https://cdn.animenewsnetwork.com/encyclopedia/reports.xml?id=155&type=anime&nlist=2'
HTTP/2 200
content-type: text/xml;charset=UTF-8
server: cloudflare
x-frame-options: SAMEORIGIN
set-cookie: ann5_session_id=…; Domain=.animenewsnetwork.com; SameSite=Lax
# no access-control-allow-origin  (api.xml in contrast sends: access-control-allow-origin: *)

<report skipped="0" listed="2"><args><type>anime</type><name></name><licensed></licensed><search></search></args>
<item><id>40689</id><gid>876995154</gid><type>TV</type><name>Null-Meta</name><precision>TV</precision><vintage>2027</vintage></item>
```

The HTML genre browse (`www.animenewsnetwork.com/encyclopedia/anime.php?genre[]=6&nskip=0&nlist=25`) is
also CORS-less and HTML, i.e. not usable. Practical use of ANN in this app: *fallback enrichment for a
single title* (picture + plot summary + "Objectionable content" rating) when Kitsu/TVmaze have no image.
It is cache-friendly (`cache-control: public`, one-day expiry) and quotes its own generated timestamp.

---

## 7. Recommended fallback architecture

1. **Boot:** probe AniList once (short timeout). If it fails → set `providerMode = 'fallback'` and stop
   calling it for the session.
2. **Recommendations (bug 1):** Kitsu genre discovery, one request per genre bucket:
   `GET https://kitsu.io/api/edge/anime?filter[categories]=<slug>&sort=-userCount&page[limit]=20&include=categories`
   → `posterImage.medium`, `synopsis`, `averageRating`/10, `userCount`, `https://kitsu.io/anime/<slug>`.
   Cover and synopsis are *guaranteed present* for the overwhelming majority of rows, which is exactly
   what the text-only fallback list lacked. Merge 2–4 buckets, de-dupe by `data[].id`, drop rows with
   `synopsis === null` or no `posterImage`.
3. **Search (bug 2):** query **in parallel** and merge with a relevance rank instead of "first provider
   with rows":
   * TVmaze `search/shows?q=<q>&` → keep `show.type === 'Animation'` or `genres.includes('Anime')`,
     rank by `score`, reuse `image.medium` + `summary` (strip tags).
   * Kitsu `filter[text]=<q>&page[limit]=20` → keep rows whose `canonicalTitle`/`titles.*` actually match
     the query tokens; rank those above unmatched rows (Kitsu returns junk like `Re:Map` for
     "redo of healer", so a title-token check is mandatory).
   * ANN `api.xml?anime=~<q>` only when the other two are empty, for picture/plot.
   * Do **not** let one provider's empty-but-200 response end the search.
4. **Adult titles:** they cannot be recovered from Kitsu (records deleted) and not from Jikan (unreachable
   here); TVmaze search and ANN `~name` are the only live paths, and both return image + summary for
   "Redo of Healer". If you offer an "include adult" toggle, implement it as "also query TVmaze/ANN and
   keep rows whose genres include `Adult` / ANN `Objectionable content` ≥ `MA`", not as an AniList/Jikan
   flag.
5. **Link-out:** always keep `source` + `srcId` and link to the canonical page
   (`https://kitsu.io/anime/<slug>`, `https://www.tvmaze.com/shows/<id>/<slug>`,
   `https://www.animenewsnetwork.com/encyclopedia/anime.php?id=<ann id>`).
6. **Never** call `reports.xml` from the browser (CORS), and never pass an unvalidated genre name to
   `filter[categories]` (silent fallback to the whole catalogue).

---

## 8. Corrections to the bug report's premises

| Premise | Measured reality |
|---|---|
| "MAL id 40748 = Kaifuku Jutsushi no Yarinaoshi" | **40748 = Jujutsu Kaisen**; the real id is **40750** |
| "Adult titles are filtered out by `sfw=true`" | Redo of Healer is `R+ - Mild Nudity` on MAL, *not* `Rx`, so `sfw` would not drop it; the Kitsu record is 404 (deleted), which is the real blocker |
| "Kitsu's fuzzy search is the search bug" | It is *a* bug (junk results, no relevance order), but the title is **absent from Kitsu entirely** (`/anime/42732` → 404, `filter[ageRating]=R18` → 0 rows) |
| "Recommendations were AniList-only" | Correct; Kitsu genre discovery fully replaces it (covers + synopsis + score + canonical URL, CORS-safe) |

---

## 9. Appendix: Kitsu's 218 category slugs

From `GET /api/edge/categories?page[limit]=100` (3 pages; `slug(totalMediaCount)`) — every row
`nsfw:false`:

```
absurdist-humour(140) action(18466) adventure(10897) africa(19) ahegao(252) air-force(49)
alien(528) all-girls-school(147) alternative-past(164) alternative-present(215) americas(91)
android(235) angel(150) angst(310) anime-influenced(848) anthropomorphism(553) anti-war(42)
asia(2255) assassin(205) bakumatsu-meiji-period(34) baseball(176) basketball(82) battle-royale(77)
bishounen(164) blackmail(148) bounty-hunter(39) boxing(50) breaking-the-fourth-wall(45)
buddhism(26) card-games(114) china(154) combat(85) comedy(25974) coming-of-age(487)
conspiracy(170) contemporary-fantasy(845) content-indicators(0) cooking(427) cops(596)
countryside(171) crime(564) cross-dressing(386) cyberpunk(163) cyborg(146) cycling(19)
dark-fantasy(185) dark-skinned-girl(95) deity(201) delinquent(290) dementia(647) demon(2020)
desert(26) detective(395) disaster(125) dragon(333) drama(18102) drifting(18) dynamic(1)
dystopia(176) earth(2754) ecchi(5825) elementary-school(91) elements(0) elf(358) epidemic(20)
europe(206) family(421) fantasy(26598) fantasy-world(1543) female-student(644) female-teacher(136)
feudal-warfare(49) floating-island(22) formula-racing(16) france(59) friendship(810) future(776)
gender-bender(651) genetic-modification(99) germany(19) ghost(359) gunfights(316) harem(3750)
heian-period(15) henshin(160) high-fantasy(95) high-school(1041) historical(4374) horror(3033)
housewives(96) human-enhancement(170) humanoid-alien(262) idol(1181) isekai(2812) island(59)
italy(22) japan(3151) josei(1512) juujin(424) kids(2723) korea(183) kyoto(17) law-and-order(166)
loli(684) love-polygon(315) mafia(221) magic(4077) magical-girl(702) maid(286) mars(20)
martial-arts(2602) mecha(2099) mermaid(56) middle-east(27) middle-school(111) military(1348)
motorsport(778) music(4506) musical-band(119) mystery(3994) navy(34) netorare(172) new-york(32)
ninja(161) nurse(53) office-lady(287) other-planet(204) parallel-universe(215) parasite(36)
parental-abandonment(69) parody(1097) past(625) performance(103) piloted-robot(410) pirate(111)
plot-continuity(1036) politics(205) post-apocalypse(526) power-suit(107) present(2452)
proxy-battles(205) psychological(3514) religion(66) revenge(308) reverse-harem(227) robot(304)
robot-helper(65) romance(27889) rotten-world(59) russia(19) samurai(497) satire(45)
school-clubs(373) school-life(11691) science-fiction(6966) seinen(3223) sengoku-period(40)
setting(0) shinsengumi(10) shipboard(213) shoujo(2655) shoujo-ai(5885) shounen(3661)
shounen-ai(2471) slapstick(496) slavery(148) slice-of-life(10774) slow-when-it-comes-to-love(87)
soccer(95) space(912) space-battles(90) space-opera(128) space-travel(200) special-squads(152)
sports(4205) steampunk(114) stereotypes(318) street-racing(31) student-government(26)
sudden-girlfriend-appearance(102) summer(36) super-deformed(301) super-power(1965) super-robot(85)
superhero(267) supernatural(4584) swordplay(717) target-demographics(0) tennis(59) tentacle(179)
the-arts(521) themes(0) thievery(75) three-kingdoms(20) thriller(2784) time-travel(576)
tokugawa-period(32) tokyo(132) tone-changes(42) transforming-craft(101) united-kingdom(59)
united-states(136) university(299) unrequited-love(102) vampire(784) victorian-period(21)
violence(1400) violent-retribution-for-accidental-infringement(67) virtual-reality(577)
volleyball(59) voyeurism(44) waitress(35) war(404) working-life(459) world-war-ii(75)
wrestling(36) yaoi(8414) zombie(288)
```

---

## 10. Reproduction

```bash
bash docs/evidence/capture.sh           # re-runs every probe in this document (~35 s, sleep-spaced)
python3 docs/evidence/extract-evidence.py  # (capture.sh calls this itself; condenses bulky HTML into *.txt)
```

| Evidence file | Shows |
|---|---|
| `evidence/anilist-403.json` / `.hdr` | 403 body; no ACAO on the response |
| `evidence/anilist-preflight.hdr` | OPTIONS 204 with `*` |
| `evidence/kitsu-categories-p0.json` … `-p2.json` | all 218 slugs (3 pages) |
| `evidence/kitsu-search-redo-of-healer.json` | fuzzy junk set |
| `evidence/kitsu-mapping-mal-40750.json` | dangling mapping → 42732 |
| `evidence/kitsu-anime-42732.json` | `404 Record not found` |
| `evidence/kitsu-discovery-fantasy.json` | genre discovery + `include=categories` |
| `evidence/kitsu-anime-46474-genres.json` | `relationships.genres` empty, genres live in `categories` |
| `evidence/kitsu-category-unknown-slug.json` | silent filter drop (count 22515) |
| `evidence/kitsu-limit-50.json`, `kitsu-filter-nsfw.json`, `kitsu-filter-range.json` | 400 / 400 / 500 |
| `evidence/jikan-connectivity.txt` | connect timeouts, control 200 |
| `evidence/jikan-openapi.json.gz` | rate limits + `sfw` description |
| `evidence/tvmaze-search-redo.json`, `tvmaze-show-52532.json` | adult title with poster/summary/score |
| `evidence/tvmaze-shows-genre-ignored.txt` | `genre=` ignored |
| `evidence/ann-api-redo.xml`, `ann-genre-ignored.xml`, `ann-reports.hdr` | `~name` search; browse removed; reports.xml CORS-less |
| `evidence/mal-anime-40748.txt`, `mal-anime-40750.txt`, `mal-search-redo.txt` | id correction + MAL rating |
| `evidence/mal-genre-ids.txt` | 62 MAL genre ids (source of the §4.1 table) |
