#!/usr/bin/env bash
# Re-capture every network fixture replayed by smoke.mjs, straight from the live APIs.
#
#   cd tests && ./capture-fixtures.sh
#
# Everything under fixtures/ is a real HTTP response body (status recorded in a
# sibling "<file>.status" file whenever the response was not 200).  smoke.mjs never
# touches the network: its fetch stub maps request URLs onto these files.
#
# Endpoints captured (the ones this app speaks):
#   * AniList GraphQL  -> captured live as 403 (the public API is currently disabled upstream)
#   * Kitsu  /api/edge/anime?filter[text]=...        text search
#   * Kitsu  /api/edge/anime?filter[categories]=...  category discovery (recommendation fallback)
#   * Kitsu  /api/edge/anime?page[limit]=1           liveness ping
#   * Jikan  /v4/anime/1 and /v4/anime?q=...         (may be unreachable -> status recorded)
#   * TVmaze /shows/1 and /search/shows?q=...
#   * ANN    /encyclopedia/api.xml?title=~...        raw XML
#
# Per-title lookups are captured for every seed / fallback-pool title found in the
# app, so the metadata back-fill has a fixture for whatever title it asks about.
# Those are recorded with page[limit]=3 / one ANN hit to keep the fixtures small;
# the stub serves them no matter what page size the app asks for.
#
# Requirements: bash, curl, python3.
set -uo pipefail
cd "$(dirname "$0")"

HTML="../anime-custom-lists.html"
FIX="fixtures"
rm -rf "$FIX"
mkdir -p "$FIX/titles"

UA="anime-custom-lists-smoke-fixtures/1.0"
CURL=(curl -sS --max-time 30 -A "$UA")
FAILED=0

urlenc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-70
}

# fetch <url> <dest> [extra curl args...]
#  200  -> body only
#  other -> body (when the server sent one) + "<dest>.status" holding the code
fetch() {
  local url="$1" dest="$2"; shift 2
  local tmp code ext
  tmp=$(mktemp)
  code=$("${CURL[@]}" "$@" -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null) || code=000
  ext="${dest##*.}"
  if [ "$code" = "200" ]; then
    mv "$tmp" "$dest"
    rm -f "$dest.status"
  else
    FAILED=$((FAILED + 1))
    printf '%s\n' "$code" > "$dest.status"
    if [ -s "$tmp" ]; then
      mv "$tmp" "$dest"
    else
      rm -f "$tmp"
      if [ "$ext" = "xml" ]; then printf '<ann></ann>\n' > "$dest"
      else printf '{}\n' > "$dest"; fi
    fi
  fi
  printf '  %-56s %s\n' "$(basename "$dest")" "$code"
}

echo "== base fixtures"
# --- AniList: 403 upstream today; this is the whole point of the outage model ---
body=$(mktemp)
printf '%s' '{"query":"query{Page(perPage:1){media(type:ANIME){id}}}"}' > "$body"
fetch "https://graphql.anilist.co" "$FIX/anilist-403.json" \
  -X POST -H "Content-Type: application/json" --data-binary @"$body"
rm -f "$body"

# --- pings (run on every boot) ---
fetch "https://kitsu.io/api/edge/anime?page%5Blimit%5D=1"                            "$FIX/kitsu-ping.json"
fetch "https://api.tvmaze.com/shows/1"                                               "$FIX/tvmaze-ping.json"
fetch "https://cdn.animenewsnetwork.com/encyclopedia/api.xml?title=~zzzzzzzzzzzz"    "$FIX/ann-ping.xml"
fetch "https://api.jikan.moe/v4/anime/1"                                             "$FIX/jikan-ping.json"

# --- the reported bug title, exactly as the app queries it ---
ROH=$(urlenc "redo of healer")
fetch "https://kitsu.io/api/edge/anime?filter%5Btext%5D=${ROH}&page%5Blimit%5D=20&include=genres,categories" \
  "$FIX/kitsu-search-redo-of-healer.json"
fetch "https://api.tvmaze.com/search/shows?q=${ROH}" \
  "$FIX/tvmaze-search-redo-of-healer.json"
fetch "https://cdn.animenewsnetwork.com/encyclopedia/api.xml?title=~${ROH}" \
  "$FIX/ann-title-redo-of-healer.xml"
fetch "https://api.jikan.moe/v4/anime?q=${ROH}&limit=20" \
  "$FIX/jikan-search-redo-of-healer.json"

# --- category discovery, exactly the shape the recommendation fallback uses ---
for cat in isekai adventure fantasy high-fantasy dark-fantasy supernatural demon \
           action romance comedy swordplay; do
  q=$(urlenc "$cat")
  fetch "https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=${q}&sort=-averageRating&page%5Blimit%5D=12&include=genres,categories" \
    "$FIX/kitsu-categories-${cat}.json"
  sleep 0.2
done

# --- what titles does this app know about? ---
TITLES=$(mktemp)
python3 - "$HTML" > "$TITLES" <<'PY' || true
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
def between(a, b):
    i = src.find(a)
    if i < 0:
        return ""
    j = src.find(b, i + len(a))
    return src[i:j if j >= 0 else len(src)]
out, seen = [], set()
def push(kind, t):
    t = (t or "").strip()
    if len(t) > 1 and t.lower() not in seen:
        seen.add(t.lower()); out.append(kind + "\t" + t)
# tier-list + watch-list seeds are plain string literals
for t in re.findall(r'"([^"]+)"', between("const ISEKAI_SEED", "const WATCH_SEED")):
    push("seed", t)
for t in re.findall(r'"([^"]+)"', between("const WATCH_SEED", "function blankEntry")):
    push("seed", t)
# the offline recommendation pool is [title, score, ...] tuples
for m in re.finditer(r'^\s*\["([^"]+)"', between("const OFFLINE_POOL", "const REC_CACHE_KEY"), re.M):
    push("pool", m.group(1))
sys.stdout.write("\n".join(out) + ("\n" if out else ""))
PY
SEED_COUNT=$(grep -c '^seed' "$TITLES" || true)
ALL_COUNT=$(grep -c . "$TITLES" || true)
echo "== per-title fixtures ($ALL_COUNT titles: $SEED_COUNT seeds + pool)"
if [ "$ALL_COUNT" = "0" ]; then
  echo "  !! could not extract titles (moved markers?) — per-title fixtures skipped" >&2
fi

while IFS=$'\t' read -r kind title; do
  [ -z "${title:-}" ] && continue
  s=$(slug "$title")
  [ -z "$s" ] && continue
  q=$(urlenc "$title")
  # Kitsu: every title (the back-fill and candidate hydration both search by title)
  fetch "https://kitsu.io/api/edge/anime?filter%5Btext%5D=${q}&page%5Blimit%5D=3&include=genres,categories" \
    "$FIX/titles/kitsu--${s}.json"
  # TVmaze: every title — it is the one general TV DB in the list and it knows most of
  # these by their English name (Kitsu often only has the romanised one).
  fetch "https://api.tvmaze.com/search/shows?q=${q}" \
    "$FIX/titles/tvmaze--${s}.json"
  # ANN: seeds only — its catalogue is deeper for these, and it is tiny to store
  if [ "$kind" = "seed" ]; then
    fetch "https://cdn.animenewsnetwork.com/encyclopedia/api.xml?title=~${q}" \
      "$FIX/titles/ann--${s}.xml"
  fi
  sleep 0.3
done < "$TITLES"
rm -f "$TITLES"

echo
echo "done. non-200 captures: $FAILED (statuses recorded next to the body files)"
echo "top-level fixture files: $(ls "$FIX" | wc -l)"
echo "per-title fixture files: $(ls "$FIX/titles" | wc -l)"
du -sh "$FIX"
