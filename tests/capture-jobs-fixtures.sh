#!/usr/bin/env bash
# Re-capture every network fixture replayed by the jobs smoke suite, straight
# from the live job-board APIs.
#
#   cd tests && ./capture-jobs-fixtures.sh
#
# Everything under fixtures-jobs/ is a real HTTP response body (status recorded
# in a sibling "<file>.status" file whenever the response was not 200).  The
# jobs smoke suite never touches the network: its fetch stub maps request URLs
# onto these files.  Re-runnable: the fixture directory is rebuilt from scratch
# every run, so it is always safe to re-run.
#
# Endpoints captured (the ones this app speaks):
#   * Remotive   /api/remote-jobs?limit=1                     liveness ping
#   * Remotive   /api/remote-jobs?limit=20&search=python      text search
#   * Remotive   /api/remote-jobs?limit=20&search=designer    text search
#   * Remotive   /api/remote-jobs?category=software-development&limit=20
#   * Jobicy     /api/v2/remote-jobs?count=1                  liveness ping
#   * Jobicy     /api/v2/remote-jobs?count=20&industry=<slug> industry browse
#   * Arbeitnow  /api/job-board-api?page=99999                liveness ping (empty data[])
#   * Arbeitnow  /api/job-board-api?page=2                    a real page of jobs
#   * Jina       https://r.jina.ai/<job board url>            text extractor for
#                                                              a pasted job URL
#
# Jobicy industry slugs
# ---------------------
# Jobicy's `industry` filter does NOT accept the display labels that come back
# in the `jobIndustry` array of a job row.  It only accepts a predefined
# `industrySlug` (see https://jobicy.com/api/v2/remote-jobs?get=industries);
# anything else is answered with HTTP 400 and
# `{"success":false,"error":"Invalid 'industry' value..."}`.
#
# The four most frequent `jobIndustry` labels in a fresh unfiltered sample
# (count=50, and the same set at count=100) map to the official slugs as:
#
#   jobIndustry label           industrySlug  (captured here)
#   -------------------------   ----------------
#   Data Science & Analytics    data-science
#   Sales                       seller
#   Software Engineering        engineering
#   Product & Operations        management
#
# The fixtures below are therefore captured with the official slugs, so each one
# holds real rows the parsers can be exercised against.
#
# Requirements: bash, curl, python3.
set -euo pipefail
cd "$(dirname "$0")"

UA="jobs-custom-lists-smoke-fixtures/1.0"
CURL=(curl -sS --max-time 60 -A "$UA")
FIX="fixtures-jobs"
rm -rf "$FIX"
mkdir -p "$FIX"

FAILED=0

urlenc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-70
}

# fetch <url> <dest>
#  200 -> body only
#  other -> body (when the server sent one) + "<dest>.status" holding the code
#  curl failed outright (code 000) -> "<dest>.status" holding 500 + empty body
fetch() {
  local url="$1" dest="$2"
  local code ext tmp
  tmp=$(mktemp)
  code=$("${CURL[@]}" -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null) || code=000
  ext="${dest##*.}"
  if [ "$code" = "200" ]; then
    mv "$tmp" "$dest"
    rm -f "$dest.status"
  else
    FAILED=$((FAILED + 1))
    if [ "$code" = "000" ]; then code=500; fi
    printf '%s\n' "$code" > "$dest.status"
    if [ -s "$tmp" ]; then
      mv "$tmp" "$dest"
    else
      rm -f "$tmp"
      if [ "$ext" = "json" ]; then printf '{}\n' > "$dest"
      else : > "$dest"; fi
    fi
  fi
  printf '  %-56s %s\n' "$(basename "$dest")" "$code"
}

echo "== remotive"
fetch "https://remotive.com/api/remote-jobs?limit=1" \
  "$FIX/remotive-ping.json"
fetch "https://remotive.com/api/remote-jobs?limit=20&search=python" \
  "$FIX/remotive-search-python.json"
fetch "https://remotive.com/api/remote-jobs?limit=20&search=designer" \
  "$FIX/remotive-search-designer.json"
fetch "https://remotive.com/api/remote-jobs?category=software-development&limit=20" \
  "$FIX/remotive-category-software-development.json"

echo "== jobicy"
fetch "https://jobicy.com/api/v2/remote-jobs?count=1" \
  "$FIX/jobicy-ping.json"
# The 4 most frequent jobIndustry labels (see the slug map in the header); these
# are Jobicy's official industrySlug values, which is all its `industry` filter
# accepts.  A label such as "sales" or "software-engineering" would come back as
# HTTP 400 / "Invalid 'industry' value".
for ind in data-science seller engineering management; do
  fetch "https://jobicy.com/api/v2/remote-jobs?count=20&industry=${ind}" \
    "$FIX/jobicy-industry-${ind}.json"
  sleep 0.2
done

echo "== arbeitnow"
# page=99999 is the cheap "is the API up?" probe: real response, zero rows.
fetch "https://www.arbeitnow.com/api/job-board-api?page=99999" \
  "$FIX/arbeitnow-ping.json"
fetch "https://www.arbeitnow.com/api/job-board-api?page=2" \
  "$FIX/arbeitnow-board.json"

echo "== jina reader (job metadata extraction for a pasted url)"
fetch "https://r.jina.ai/https://job-boards.greenhouse.io/gitlab/jobs/8629019002" \
  "$FIX/jina-greenhouse.txt"

echo
echo "done. non-200 captures: $FAILED (statuses recorded next to the body files)"
echo "fixture files: $(ls "$FIX" | wc -l)"
du -sh "$FIX"
