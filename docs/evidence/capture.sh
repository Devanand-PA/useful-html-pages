#!/usr/bin/env bash
# Re-capture the raw evidence quoted in docs/api-capabilities.md
# Usage: bash docs/evidence/capture.sh
# Writes *.json/*.xml/*.hdr/*.txt next to this script. Requests to the same host
# are spaced ~1s apart on purpose (Kitsu has no published limit; be polite).
set -u
cd "$(dirname "$0")" || exit 1
C="curl -s --max-time 30"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

echo "[1/12] anilist-403 (headers + body)"
$C -D anilist-403.hdr -o anilist-403.json -X POST https://graphql.anilist.co \
  -H 'Content-Type: application/json' -H 'Origin: null' \
  -d '{"query":"{Media(id:1){id}}"}' || true
$C -D anilist-preflight.hdr -o /dev/null -X OPTIONS https://graphql.anilist.co \
  -H 'Origin: null' -H 'Access-Control-Request-Method: POST' || true

echo "[2/12] kitsu-categories (all 218, 3 pages)"
i=0
url='https://kitsu.io/api/edge/categories?page%5Blimit%5D=100&page%5Boffset%5D=0'
while [ -n "$url" ]; do
  $C -H 'Origin: null' "$url" -o "kitsu-categories-p$i.json" || break
  url=$(python3 -c "import json;print((json.load(open('kitsu-categories-p$i.json')).get('links') or {}).get('next') or '')" 2>/dev/null)
  i=$((i+1)); [ "$i" -ge 5 ] && break; sleep 1
done

echo "[3/12] kitsu search fuzziness"
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Btext%5D=redo%20of%20healer&page%5Blimit%5D=10' -o kitsu-search-redo-of-healer.json; sleep 1
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Btext%5D=kaifuku&page%5Blimit%5D=10' -o kitsu-search-kaifuku.json; sleep 1
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Btext%5D=ishuzoku&page%5Blimit%5D=5' -o kitsu-search-ishuzoku.json; sleep 1

echo "[4/12] kitsu MAL->Kitsu mapping for 40748 (bad row) + controls"
$C -H 'Origin: null' 'https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist%2Fanime&filter%5BexternalId%5D=40748&include=item' -o kitsu-mapping-mal-40748.json; sleep 1
$C -H 'Origin: null' 'https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist%2Fanime&filter%5BexternalId%5D=1&include=item' -o kitsu-mapping-mal-1.json

echo "[5/12] kitsu genre discovery + slug-fallback trap"
$C -D kitsu-discovery.hdr -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=fantasy&sort=-averageRating&page%5Blimit%5D=8&include=categories' -o kitsu-discovery-fantasy.json; sleep 1
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=zzzznotarealcategory&page%5Blimit%5D=3' -o kitsu-category-unknown-slug.json; sleep 1
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=school-life&page%5Blimit%5D=1' -o kitsu-category-school-life.json; sleep 1
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5Bcategories%5D=ecchi&sort=-userCount&page%5Blimit%5D=20' -o kitsu-discovery-ecchi.json

echo "[6/12] kitsu limits (expect 400 x2, 500 x2)"
$C -o kitsu-limit-50.json -w '%{http_code}' 'https://kitsu.io/api/edge/anime?page%5Blimit%5D=50' > kitsu-limit-50.code; echo; sleep 1
$C -o kitsu-filter-nsfw.json -w '%{http_code}' 'https://kitsu.io/api/edge/anime?filter%5Bnsfw%5D=false' > kitsu-filter-nsfw.code; echo; sleep 1
$C -o kitsu-filter-range.json -w '%{http_code}' 'https://kitsu.io/api/edge/anime?filter%5BuserCount%5D%5Bgte%5D=10000' > kitsu-filter-range.code; echo

echo "[6b/12] kitsu adult-record deletion + MAL id correction"
$C -H 'Origin: null' 'https://kitsu.io/api/edge/mappings?filter%5BexternalSite%5D=myanimelist%2Fanime&filter%5BexternalId%5D=40750&include=item' -o kitsu-mapping-mal-40750.json; sleep 1
$C -D kitsu-42732.hdr -H 'Origin: null' 'https://kitsu.io/api/edge/anime/42732' -o kitsu-anime-42732.json; sleep 1
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5BageRating%5D=R18&page%5Blimit%5D=3' -o kitsu-filter-ageRating-r18.json
$C -H 'Origin: null' 'https://kitsu.io/api/edge/anime?filter%5BageRating%5D=R&page%5Blimit%5D=1' -o kitsu-filter-ageRating-r.json
$C -A "$UA" 'https://myanimelist.net/anime/40748' -o mal-anime-40748.html; sleep 1
$C -A "$UA" 'https://myanimelist.net/anime/40750' -o mal-anime-40750.html; sleep 1
$C -A "$UA" -L 'https://myanimelist.net/anime.php?q=redo%20of%20healer&cat=anime' -o mal-search-redo.html

echo "[7/12] jikan reachability (expect connect timeouts -> code 000)"
{
  for u in https://api.jikan.moe/v4/anime/1 https://api.jikan.moe/v4/genres/anime; do
    echo "--- $u (ipv4 forced) ---"
    $C -4 --connect-timeout 8 --max-time 12 -o /dev/null -w 'code=%{http_code} connect=%{time_connect} total=%{time_total}\n' "$u"
  done
  echo "--- jikan.moe marketing site (control) ---"
  $C -o /dev/null -w 'jikan.moe -> %{http_code}\n' https://jikan.moe/
} > jikan-connectivity.txt 2>&1

echo "[8/12] jikan openapi spec (docs-only source of genre ids/limits)"
$C -o jikan-openapi.json 'https://raw.githubusercontent.com/jikan-me/jikan-rest/master/storage/api-docs/api-docs.json'

echo "[9/12] tvmaze"
$C -D tvmaze-search.hdr -H 'Origin: null' 'https://api.tvmaze.com/search/shows?q=redo%20of%20healer' -o tvmaze-search-redo.json; sleep 1
$C -H 'Origin: null' 'https://api.tvmaze.com/search/shows?q=frieren' -o tvmaze-search-frieren.json; sleep 1
$C -H 'Origin: null' 'https://api.tvmaze.com/shows/52532' -o tvmaze-show-52532.json; sleep 1
$C -H 'Origin: null' 'https://api.tvmaze.com/shows?genre=anime&page=0' -o tvmaze-shows-genre-ignored.json

echo "[10/12] ann"
$C -D ann-api.hdr -H 'Origin: null' 'https://cdn.animenewsnetwork.com/encyclopedia/api.xml?anime=~redo%20of%20healer' -o ann-api-redo.xml; sleep 1
$C -H 'Origin: null' 'https://cdn.animenewsnetwork.com/encyclopedia/api.xml?genre=Fantasy&nskip=0' -o ann-genre-ignored.xml; sleep 1
$C -D ann-reports.hdr -H 'Origin: null' 'https://cdn.animenewsnetwork.com/encyclopedia/reports.xml?id=155&type=anime&nlist=2' -o ann-reports.xml

echo "[11/12] mal genre id index (for Jikan ids)"
$C -A "$UA" 'https://myanimelist.net/anime/genre/1/Action' -o mal-genre-1-action.html; sleep 1
$C -A "$UA" 'https://myanimelist.net/anime/genre/18/Mecha' -o mal-genre-18-mecha.html; sleep 1
$C -A "$UA" 'https://myanimelist.net/anime/genre/36/Slice_of_Life' -o mal-genre-36-sol.html

echo "[12/12] condensing bulky captures into the *.txt proofs"
python3 extract-evidence.py

echo "done"
