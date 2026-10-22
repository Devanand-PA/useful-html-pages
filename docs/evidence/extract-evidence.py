#!/usr/bin/env python3
"""Condense the bulky raw captures (MAL HTML, TVmaze index) into small text proofs.

Run after capture.sh:  python3 docs/evidence/extract-evidence.py
Reads the raw *.html / tvmaze index JSON that capture.sh downloaded, writes the *.txt
proofs referenced by docs/api-capabilities.md, then deletes the raw files.
"""
import html
import json
import os
import re

os.chdir(os.path.dirname(os.path.abspath(__file__)))


def mal_proof(src: str, out: str) -> None:
    if not os.path.exists(src):
        print(f"skip {src} (missing)")
        return
    t = open(src, encoding="utf-8", errors="replace").read()
    m = re.search(r"<title>(.*?)</title>", t, re.S)
    title = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip() if m else "?"
    i = t.find("Rating:")
    rating = "n/a"
    if i > 0:
        rating = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t[i:i + 160]))).strip()[:80]
    with open(out, "w") as fh:
        fh.write(f"source: {src}\ntitle: {title}\nrating: {rating}\n")
    print(f"{out}: {title} | {rating}")
    os.remove(src)


mal_proof("mal-anime-40748.html", "mal-anime-40748.txt")
mal_proof("mal-anime-40750.html", "mal-anime-40750.txt")

if os.path.exists("mal-search-redo.html"):
    t = open("mal-search-redo.html", encoding="utf-8", errors="replace").read()
    ids = sorted(set(re.findall(r"myanimelist\.net/anime/(\d+)/([A-Za-z0-9_]+)", t)))
    keep = [f"/anime/{i}/{s}" for i, s in ids if i in ("40750", "40748", "52991")]
    with open("mal-search-redo.txt", "w") as fh:
        fh.write("query: myanimelist.net/anime.php?q=redo of healer&cat=anime\n")
        fh.write("\n".join(keep) + "\n")
        fh.write(f"(the page listed {len(ids)} distinct anime ids)\n")
    print("mal-search-redo.txt:", keep)
    os.remove("mal-search-redo.html")

seen = {}
for line in open("mal-genre-ids.txt") if os.path.exists("mal-genre-ids.txt") else []:
    p = line.split("\t")
    if len(p) == 2 and p[0].strip().isdigit():
        seen[int(p[0])] = p[1].strip()
for src in ("mal-genre-1-action.html", "mal-genre-36-sol.html", "mal-genre-18-mecha.html"):
    if not os.path.exists(src):
        continue
    t = open(src, encoding="utf-8", errors="replace").read()
    for _href, gid, name in re.findall(r'href="(/anime/genre/(\d+)/[^"]+)"[^>]*>([^<]+)<', t):
        seen.setdefault(int(gid), html.unescape(name).strip())
    os.remove(src)
if seen:
    with open("mal-genre-ids.txt", "w") as fh:
        fh.write("scraped from the genre sidebar of myanimelist.net/anime/genre/"
                 "{1/Action,18/Mecha,36/Slice_of_Life}\n")
        fh.write("\n".join(f"{k}\t{v}" for k, v in sorted(seen.items())) + "\n")
    print(f"mal-genre-ids.txt: {len(seen)} ids")

if os.path.exists("tvmaze-shows-genre-ignored.json"):
    d = json.load(open("tvmaze-shows-genre-ignored.json"))
    with open("tvmaze-shows-genre-ignored.txt", "w") as fh:
        fh.write("GET https://api.tvmaze.com/shows?genre=anime&page=0  -> 200, "
                 f"{len(d)} rows (param ignored, no genre filter exists)\n")
        fh.write("\n".join(f"  {s['name']}  genres={s.get('genres')}" for s in d[:5]) + "\n")
    print("tvmaze-shows-genre-ignored.txt written")
    os.remove("tvmaze-shows-genre-ignored.json")

if os.path.exists("jikan-openapi.json"):
    import gzip
    with open("jikan-openapi.json", "rb") as src, gzip.open("jikan-openapi.json.gz", "wb") as dst:
        dst.write(src.read())
    os.remove("jikan-openapi.json")
    print("jikan-openapi.json.gz written")
