#!/usr/bin/env node
/**
 * smoke.mjs — deterministic end-to-end smoke test for ../anime-custom-lists.html
 *
 *   cd tests && npm test            # or: node smoke.mjs
 *
 * The app is a single-file page: no build step, inline JS, all of its data arrives
 * through fetch() and all of its state lives in localStorage.  So the test boots the
 * *real* file inside jsdom with:
 *
 *   • runScripts: "dangerously"     — the inline app script actually runs
 *   • url: "http://localhost/"      — gives jsdom a real origin, hence localStorage
 *   • an empty localStorage         — every run starts from the app's own seed data
 *   • a stubbed window.fetch        — replayed from tests/fixtures/, never the network
 *
 * The fetch stub routes by *URL shape* (host + query parameters), not by an exact
 * string, so a new query parameter or a different page size added by the app still
 * resolves to the same recorded payload.  Unrecognised requests are reported in the
 * diagnostics block at the end instead of failing silently.
 *
 * Scenarios (drive everything through window.__animeTest, added by the app):
 *   A  recommendations are visual   .rec-card has an <img>, every candidate has cover+synopsis
 *   B  metadata back-fill           every tier-list entry gains a cover and a synopsis
 *   C  adult title searchable       doSearch("redo of healer") surfaces the title
 *   D  relevance ranking            that title is inside the first 5 results
 *
 * Exit codes: 0 all pass · 1 something failed · 2 test hook missing (nothing run) ·
 *             3 harness/boot failure (app did not boot at all).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* SMOKE_APP lets the harness itself be pointed at a copy (used to check the
 * "hook missing" and "app threw" diagnostics without touching the real app). */
const APP_PATH = process.env.SMOKE_APP
  ? path.resolve(process.env.SMOKE_APP)
  : path.resolve(HERE, "..", "anime-custom-lists.html");
const FIX_DIR = path.join(HERE, "fixtures");

/* ---- knobs ---------------------------------------------------------------------
 * SMOKE_REALTIME=1        honour the app's real 2.2s throttles (slow, faithful)
 * SMOKE_VERBOSE=1         forward the page console to stdout
 * SMOKE_READY_TIMEOUT=N   ms to wait for __animeTest.ready (default 20000)
 * SMOKE_DUMP_URLS=1       print every distinct URL the app requested
 */
const FAST = process.env.SMOKE_REALTIME !== "1";
const VERBOSE = process.env.SMOKE_VERBOSE === "1";
const READY_TIMEOUT = Number(process.env.SMOKE_READY_TIMEOUT || 20000);
const DUMP_URLS = process.env.SMOKE_DUMP_URLS === "1";
const SCENARIO_TIMEOUT = 60000;
/* The app throttles provider calls (2.2s gaps, 1.5s boot polls).  Timers are clamped
 * while FAST so a 54-entry back-fill takes ~0.3s instead of ~2 minutes.  The fetch stub
 * ignores AbortSignal, so clamping the fetch watchdog is harmless. */
const TIMER_CAP = 5;

const C = process.stdout.isTTY
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", b: "", x: "" };

/* ============================================================================
 * fixture router
 * ==========================================================================*/

const fixtureCache = new Map();
/** Load `<name>` (relative to fixtures/) plus an optional `<name>.status` file. */
function loadFixture(name) {
  if (fixtureCache.has(name)) return fixtureCache.get(name);
  const file = path.join(FIX_DIR, name);
  let rec = null;
  try {
    if (fs.statSync(file).isFile()) {
      const body = fs.readFileSync(file, "utf8");
      const sf = file + ".status";
      let status = 200;
      if (fs.existsSync(sf)) {
        const n = Number(fs.readFileSync(sf, "utf8").trim());
        status = Number.isFinite(n) && n > 0 ? n : 500;
      }
      rec = {
        fixture: name,
        status,
        body,
        type: name.endsWith(".xml") ? "application/xml" : "application/json",
      };
    }
  } catch { /* missing fixture */ }
  fixtureCache.set(name, rec);
  return rec;
}

/** URL slug, matching capture-fixtures.sh (lowercase, non-alnum runs -> "-"). */
function slugVariants(s) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cut = base.slice(0, 70);
  return [...new Set([cut, cut.replace(/-+$/, ""), base])].filter(Boolean);
}

function fixtureFor(kind, value, ext) {
  for (const s of slugVariants(value)) {
    const rec = loadFixture(`titles/${kind}--${s}.${ext}`);
    if (rec) return rec;
  }
  return null;
}

const EMPTY = {
  json: { status: 200, body: '{"data":[],"included":[]}', type: "application/json", fixture: null },
  jikan: { status: 200, body: '{"data":[],"pagination":{"has_next_page":false}}', type: "application/json", fixture: null },
  tv: { status: 200, body: "[]", type: "application/json", fixture: null },
  xml: { status: 200, body: '<?xml version="1.0" encoding="UTF-8"?><ann></ann>', type: "application/xml", fixture: null },
};

const served = new Map();     // fixture name -> count
const misses = new Map();     // descriptive key -> count
const urlSeen = new Map();    // full url -> count
function noteServed(rec) {
  if (!rec) return;
  if (rec.fixture) served.set(rec.fixture, (served.get(rec.fixture) || 0) + 1);
  else if (rec.miss) misses.set(rec.miss, (misses.get(rec.miss) || 0) + 1);
}

/** Route one request.  Returns {status, body, type, fixture?}. */
function routeRequest(u, init) {
  const host = u.hostname.toLowerCase();
  const p = u.pathname;
  const q = u.searchParams;
  const method = String((init && init.method) || "GET").toUpperCase();

  /* ---- AniList GraphQL: captured live as 403 (API disabled upstream today) ---- */
  if (host.includes("anilist")) {
    return loadFixture("anilist-403.json") || {
      status: 403,
      body: '{"errors":[{"message":"AniList API disabled (no fixture)"}]}',
      type: "application/json",
      fixture: null,
      miss: "anilist (no fixture)",
    };
  }

  /* ---- Kitsu ---- */
  if (host.includes("kitsu")) {
    const text = q.get("filter[text]");
    if (text) {
      const rec = fixtureFor("kitsu", text, "json");
      if (rec) return rec;
      const miss = { ...EMPTY.json, fixture: null, miss: `kitsu text: ${text}` };
      return miss;
    }
    const cat = q.get("filter[categories]");
    if (cat) {
      for (const s of slugVariants(cat)) {
        const rec = loadFixture(`kitsu-categories-${s}.json`);
        if (rec) return rec;
      }
      return { ...EMPTY.json, fixture: null, miss: `kitsu category: ${cat}` };
    }
    const byId = p.match(/\/anime\/(\d+)/);
    if (byId) {
      const rec = loadFixture(`titles/kitsu-id--${byId[1]}.json`);
      return rec || { ...EMPTY.json, fixture: null, miss: `kitsu id: ${byId[1]}` };
    }
    return loadFixture("kitsu-ping.json") || { ...EMPTY.json, fixture: null, miss: `kitsu path: ${p}` };
  }

  /* ---- Jikan / MAL ---- */
  if (host.includes("jikan")) {
    const ping = loadFixture("jikan-ping.json");
    /* If the recorded probe failed, replay that failure for every Jikan request: the
     * app marks the provider dead and this is what the live environment looks like. */
    if (ping && ping.status >= 400) {
      return { ...ping, fixture: ping.fixture };
    }
    const term = q.get("q");
    if (term) {
      const rec = fixtureFor("jikan", term, "json");
      return rec || { ...EMPTY.jikan, fixture: null, miss: `jikan search: ${term}` };
    }
    return ping || { ...EMPTY.jikan, fixture: null, miss: "jikan ping (no fixture)" };
  }

  /* ---- TVmaze ---- */
  if (host.includes("tvmaze")) {
    const term = q.get("q");
    if (term) {
      for (const s of slugVariants(term)) {
        const rec = loadFixture(`titles/tvmaze--${s}.json`) || loadFixture(`tvmaze-search-${s}.json`);
        if (rec) return rec;
      }
      return { ...EMPTY.tv, fixture: null, miss: `tvmaze search: ${term}` };
    }
    const byId = p.match(/\/shows\/(\d+)/);
    if (byId) return loadFixture("tvmaze-ping.json") || { ...EMPTY.tv, fixture: null, miss: "tvmaze ping" };
    return { ...EMPTY.tv, fixture: null, miss: `tvmaze path: ${p}` };
  }

  /* ---- Anime News Network (XML) ---- */
  if (host.includes("animenewsnetwork")) {
    const title = q.get("title");
    if (title) {
      const bare = title.replace(/^~/, "");
      const rec = fixtureFor("ann", bare, "xml");
      if (rec) return rec;
      /* the liveness probe asks for a query that cannot match anything */
      if (/^z+$/i.test(bare)) {
        return loadFixture("ann-ping.xml") || { ...EMPTY.xml, fixture: null, miss: "ann ping" };
      }
      return { ...EMPTY.xml, fixture: null, miss: `ann title: ${bare}` };
    }
    const id = q.get("id");
    if (id) {
      const rec = loadFixture(`titles/ann-id--${id}.xml`);
      return rec || { ...EMPTY.xml, fixture: null, miss: `ann id: ${id}` };
    }
    return loadFixture("ann-ping.xml") || { ...EMPTY.xml, fixture: null, miss: "ann ping" };
  }

  /* Unknown host: keep the app alive with an empty payload, but record it so a new
   * endpoint the app starts using is visible in the diagnostics instead of mysterious. */
  return { ...EMPTY.json, fixture: null, miss: `${method} ${host}${p}` };
}

function makeResponse(rec, url) {
  const body = rec.body;
  return {
    ok: rec.status >= 200 && rec.status < 300,
    status: rec.status,
    statusText: String(rec.status),
    url,
    redirected: false,
    type: "basic",
    headers: {
      get: (k) => (String(k).toLowerCase() === "content-type" ? rec.type : null),
      has: (k) => String(k).toLowerCase() === "content-type",
    },
    async text() { return body; },
    async json() { return JSON.parse(body); },
    clone() { return makeResponse(rec, url); },
  };
}

/** The stub installed on the jsdom window. */
function replayFetch(input, init) {
  let raw = "";
  try {
    raw = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : String(input));
  } catch { raw = String(input); }
  urlSeen.set(raw, (urlSeen.get(raw) || 0) + 1);
  let u = null;
  try { u = new URL(raw, "http://localhost/"); } catch { u = null; }
  let rec;
  if (!u) {
    rec = { ...EMPTY.json, fixture: null, miss: `unparseable url: ${raw}` };
  } else {
    try {
      rec = routeRequest(u, init);
    } catch (e) {
      rec = { status: 500, body: '{"error":"fixture router crashed"}', type: "application/json",
              fixture: null, miss: `router error: ${e.message}` };
    }
  }
  noteServed(rec);
  return Promise.resolve(makeResponse(rec, raw));
}

/* ============================================================================
 * little helpers
 * ==========================================================================*/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (t.unref) t.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(t));
}

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    await sleep(20);
  }
  throw new Error(`${label} not satisfied within ${ms}ms`);
}

const nonEmpty = (v) => typeof v === "string" ? v.trim().length > 0 : v != null;
const absoluteUrl = (v) => {
  if (typeof v !== "string" || !v.trim()) return false;
  try { const u = new URL(v.trim()); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
};
const titlesOf = (rows, n = 6) => rows.slice(0, n).map((r) => JSON.stringify(r.title ?? r)).join(", ") +
  (rows.length > n ? ` …(+${rows.length - n})` : "");

/* ============================================================================
 * runner
 * ==========================================================================*/
const rows = [];                   // { id, name, status, detail }
const appErrors = [];              // { message, stack, kind }

function addRow(id, name, status, detail) { rows.push({ id, name, status, detail }); }

function printTable() {
  const w1 = 6, w2 = 44;
  const line = (a, b, c) => `${a.padEnd(w1)} ${b.padEnd(w2)} ${c}`;
  console.log("");
  console.log(C.b + line("id", "scenario", "result  detail") + C.x);
  console.log(C.d + "─".repeat(112) + C.x);
  for (const r of rows) {
    const tag = r.status === "PASS" ? `${C.g}PASS${C.x}`
      : r.status === "FAIL" ? `${C.r}FAIL${C.x}`
      : `${C.y}${r.status}${C.x}`;
    const name = r.name.length > w2 ? r.name.slice(0, w2 - 1) + "…" : r.name;
    console.log(`${r.id.padEnd(w1)} ${name.padEnd(w2)} ${tag}    ${r.detail}`);
  }
  console.log("");
}

function printFixtureReport() {
  console.log(C.b + "fixtures exercised" + C.x);
  if (!served.size && !misses.size) {
    console.log("  (none — no network request was made)");
  }
  const base = [...served.entries()].filter(([n]) => !n.startsWith("titles/"));
  const perTitle = [...served.entries()].filter(([n]) => n.startsWith("titles/"));
  for (const [n, c] of base.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${String(c).padStart(4)}×  ${n}`);
  }
  if (perTitle.length) {
    console.log(`  ${String(perTitle.reduce((s, [, c]) => s + c, 0)).padStart(4)}×  per-title fixtures (${perTitle.length} distinct)`);
  }
  if (misses.size) {
    console.log("");
    console.log(C.y + "unmatched requests (no fixture recorded — the app asked for something new)" + C.x);
    const shown = [...misses.entries()].slice(0, 12);
    for (const [n, c] of shown) console.log(`  ${String(c).padStart(4)}×  ${n}`);
    if (misses.size > shown.length) console.log(`  … and ${misses.size - shown.length} more`);
    console.log(C.d + "  re-run ./capture-fixtures.sh (it extracts titles from the app) to extend coverage" + C.x);
  }
  if (DUMP_URLS) {
    console.log("");
    console.log(C.b + "every distinct URL requested" + C.x);
    for (const [u, c] of [...urlSeen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${String(c).padStart(4)}×  ${u}`);
    }
  }
}

/* The app's own vocabulary for the hook we are allowed to rely on. */
const HOOK_MEMBERS = ["ready", "state", "apiSearch", "doSearch", "searchCandidates",
  "computeRecs", "recCandidates", "syncMissingMeta"];

function hookStatus(hook) {
  if (!hook) return { ok: false, missing: HOOK_MEMBERS.slice() };
  const missing = HOOK_MEMBERS.filter((k) => !(k in hook));
  const wrong = [];
  if (hook && "ready" in hook && !(hook.ready && typeof hook.ready.then === "function")) {
    wrong.push("ready is not a Promise");
  }
  for (const k of ["state", "searchCandidates", "recCandidates"]) {
    if (hook && k in hook && typeof hook[k] !== "function") wrong.push(`${k} is not a function`);
  }
  for (const k of ["doSearch", "computeRecs", "syncMissingMeta", "apiSearch"]) {
    if (hook && k in hook && typeof hook[k] !== "function") wrong.push(`${k} is not a function`);
  }
  return { ok: missing.length === 0 && wrong.length === 0, missing, wrong };
}

/* ============================================================================
 * scenarios
 * ==========================================================================*/
function makeScenarios({ win, doc, hook }) {
  /* A — recommendation cards are visual ------------------------------------- */
  async function scenarioA() {
    await withTimeout(hook.computeRecs(true), 30000, "computeRecs(true)");
    await waitFor(() => doc.querySelectorAll(".rec-card").length > 0, 10000,
      "at least one .rec-card to render");
    /* artwork may be back-filled after first paint; give hydration a chance */
    await waitFor(() => {
      const cs = hook.recCandidates() || [];
      const cards = [...doc.querySelectorAll(".rec-card")];
      return cs.length > 0 && cards.length > 0 &&
        cards.every((c) => c.querySelector("img")) &&
        cs.every((c) => nonEmpty(c.cover) && nonEmpty(c.synopsis));
    }, 10000, "rec cards/candidates to be hydrated").catch(() => {});

    const cards = [...doc.querySelectorAll(".rec-card")];
    if (!cards.length) throw new Error("no .rec-card rendered at all");
    const badCards = cards.filter((c) => {
      const img = c.querySelector("img");
      return !img || !absoluteUrl(img.getAttribute("src"));
    });
    const placeholders = doc.querySelectorAll(".rec-card .rc-noimg").length;
    const cands = hook.recCandidates() || [];
    if (!cands.length) throw new Error(`.rec-card rendered but recCandidates() is empty`
      + (typeof hook.recSource === "function" ? ` (recSource=${hook.recSource()})` : ""));
    const badCands = cands.filter((c) => !nonEmpty(c.cover) || !nonEmpty(c.synopsis));

    if (badCards.length) {
      throw new Error(`${badCards.length}/${cards.length} rendered .rec-card lack a real <img> src`
        + (placeholders ? ` (${placeholders} "no image" placeholders)` : "")
        + ` — e.g. ${titlesOf(badCards.map((c) => ({ title: c.querySelector(".rec-title")?.textContent })))}`);
    }
    if (badCands.length) {
      const missCover = badCands.filter((c) => !nonEmpty(c.cover)).length;
      const missSyn = badCands.filter((c) => !nonEmpty(c.synopsis)).length;
      throw new Error(`${badCands.length}/${cands.length} recCandidates() incomplete`
        + (typeof hook.recSource === "function" ? ` (recSource=${hook.recSource()})` : "")
        + ` (missing cover: ${missCover}, missing synopsis: ${missSyn}) — e.g. ${titlesOf(badCands)}`);
    }
    /* When AniList is down the pool must come from provider discovery (Kitsu categories),
     * not from the hardcoded title-only fallback that produced the "no image" cards. */
    if (typeof hook.recSource === "function") {
      const src = hook.recSource();
      if (src === "offline") {
        throw new Error("recSource() === \"offline\": the panel fell back to the hardcoded "
          + "title list instead of provider discovery (no cover/synopsis data there)");
      }
      if (src !== "providers") {
        throw new Error(`recSource() === ${JSON.stringify(src)}, expected "providers" `
          + "(AniList is replayed as 403 in these fixtures)");
      }
    }
    return `${cards.length} cards rendered with artwork; ${cands.length} candidates all have cover+synopsis`
      + (typeof hook.recSource === "function" ? `; recSource=${hook.recSource()}` : "");
  }

  /* diagnostic used when the back-fill leaves gaps: what would a fresh search see? */
  async function searchDiag(title) {
    try {
      const rows = await hook.apiSearch(title, {});
      const art = rows.filter((r) => nonEmpty(r.cover) && nonEmpty(r.synopsis)).length;
      const st = typeof hook.apiState === "function"
        ? Object.entries(hook.apiState()).map(([k, v]) => `${k}:${v.alive ? "up" : "DOWN"}`).join(",")
        : "apiState n/a";
      let pick = "";
      try {
        const best = typeof hook.pickBestHit === "function" ? hook.pickBestHit(title, rows) : null;
        pick = best ? ` pick=${JSON.stringify(best.title)}(${best.source}${best.cover ? ",cover" : ""}${best.synopsis ? ",syn" : ""})` : " pick=null";
      } catch (e) { pick = ` pick threw: ${e.message}`; }
      return `${rows.length} rows/${art} with art [${st}] first=${JSON.stringify(rows[0]?.title ?? null)}${pick}`;
    } catch (e) {
      return `apiSearch threw: ${e.message}`;
    }
  }

  /* B — metadata back-fill for seeded tier-list entries --------------------- */
  async function scenarioB() {
    const st = hook.state();
    const collect = () => (st.lists || []).flatMap((l) => (l.entries || []).map((e) => ({ list: l, e })));
    const withTitle = () => collect().filter(({ e }) => nonEmpty(e.title));
    const incomplete = () => withTitle().filter(({ e }) => !nonEmpty(e.cover) || !nonEmpty(e.synopsis));

    /* The app may already have back-filled its seeds during boot.  Either way the
     * function under test must to be able to fill a bare entry, so blank a few
     * tier-list entries and make syncMissingMeta() do real work. */
    let seeded = incomplete();
    let forced = 0;
    if (!seeded.length) {
      const tier = withTitle().filter(({ list }) => list.kind === "tier").slice(0, 3);
      for (const { e } of tier) {
        e.cover = null; e.synopsis = null; e.score = null; e.metaDone = false; e.syncTries = 0;
      }
      forced = tier.length;
      seeded = incomplete();
      if (!seeded.length) throw new Error("could not create a bare entry to back-fill");
    }

    /* syncMissingMeta() is a no-op while another pass is running (e.g. the boot
     * sync), so retry until a pass actually finishes the blanked entries. */
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      await hook.syncMissingMeta();
      if (!incomplete().length) break;
      await sleep(150);
    }

    const all = collect().filter(({ e }) => nonEmpty(e.title));
    const missing = all.filter(({ e }) => !nonEmpty(e.cover) || !nonEmpty(e.synopsis));
    if (missing.length) {
      const diag = [];
      for (const { e } of missing.slice(0, 3)) {
        diag.push(`${JSON.stringify(e.title)}${!nonEmpty(e.cover) ? " [no cover]" : ""}${!nonEmpty(e.synopsis) ? " [no synopsis]" : ""} tries=${e.syncTries || 0} src=${e.source || "-"} <- ${await searchDiag(e.title)}`);
      }
      const more = missing.length > 3 ? ` (and ${missing.length - 3} more)` : "";
      throw new Error(`${missing.length}/${all.length} entries still incomplete after syncMissingMeta()`
        + ` — ${diag.join("; ")}${more}`);
    }

    /* and the grid itself must show artwork instead of the "no image yet" tile */
    const items = [...doc.querySelectorAll(".item")];
    if (!items.length) throw new Error("no .item cards in the grid — nothing rendered");
    const noImg = items.filter((it) => {
      const img = it.querySelector("img");
      return !img || !absoluteUrl(img.getAttribute("src"));
    });
    if (noImg.length) {
      const tiles = doc.querySelectorAll(".item .noimg").length;
      throw new Error(`${noImg.length}/${items.length} .item cards have no real <img>`
        + (tiles ? ` (${tiles} "no image yet" tiles)` : "")
        + ` — e.g. ${titlesOf(noImg.map((it) => ({ title: it.querySelector(".it-title")?.textContent })))}`);
    }
    return `${seeded.length} bare entries back-filled${forced ? ` (${forced} deliberately blanked)` : ""}; `
      + `${items.length} grid cards now carry artwork`;
  }

  /* shared search run for C & D */
  let searchRun = null;
  function runSearch() {
    searchRun ||= (async () => {
      await withTimeout(hook.doSearch("redo of healer"), SCENARIO_TIMEOUT, "doSearch(\"redo of healer\")");
      await waitFor(() => (hook.searchCandidates() || []).some((c) => /redo of healer/i.test(c.title || "")),
        6000, "a /redo of healer/i hit to appear").catch(() => {});
      return hook.searchCandidates() || [];
    })();
    return searchRun;
  }

  /* C — the reported title can be found at all ------------------------------ */
  async function scenarioC() {
    const cands = await runSearch();
    if (!cands.length) {
      /* extra context for the most likely failure mode: providers marked down */
      let diag = "";
      try {
        const st = typeof hook.apiState === "function" ? hook.apiState() : null;
        if (st) diag = " providers: " + Object.entries(st)
          .map(([k, v]) => `${k}=${v.alive ? "up" : "DOWN"}`).join(", ");
        if (typeof hook.apiSearch === "function") {
          const direct = await hook.apiSearch("redo of healer", {});
          diag += `; apiSearch() returned ${Array.isArray(direct) ? direct.length : "?"} rows`;
        }
      } catch (e) { diag += `; diag failed: ${e.message}`; }
      throw new Error("doSearch() returned no candidates at all — " + diag);
    }
    const hit = cands.find((c) => /redo of healer/i.test(c.title || ""));
    if (!hit) throw new Error(`"Redo of Healer" not in ${cands.length} results — top: ${titlesOf(cands, 5)}`);
    return `found "${hit.title}" (${hit.source}) among ${cands.length} results`;
  }

  /* D — relevance ranking, not provider fuzzy order ------------------------- */
  async function scenarioD() {
    const cands = await runSearch();
    const idx = cands.findIndex((c) => /redo of healer/i.test(c.title || ""));
    if (idx < 0) throw new Error("no /redo of healer/i result to rank (see scenario C)");
    if (idx >= 5) throw new Error(`hit is at position ${idx + 1}, expected within the first 5 — top: ${titlesOf(cands, 5)}`);
    return `hit at position ${idx + 1}/${cands.length}: ${titlesOf(cands.slice(0, 5), 5)}`;
  }

  return { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD };
}

/* ============================================================================
 * main
 * ==========================================================================*/
async function main() {
  const started = Date.now();
  if (!fs.existsSync(APP_PATH)) {
    console.error(`cannot find the app at ${APP_PATH}`);
    return 3;
  }
  if (!fs.existsSync(FIX_DIR)) {
    console.error(`fixtures missing at ${FIX_DIR} — run ./capture-fixtures.sh first`);
    return 3;
  }
  const html = fs.readFileSync(APP_PATH, "utf8");

  const vc = new VirtualConsole();
  const BENIGN = /Not implemented|Could not parse CSS stylesheet|Error: Not implemented/i;
  vc.on("jsdomError", (err) => {
    const message = String(err?.message || err);
    if (BENIGN.test(message)) return;
    appErrors.push({ kind: "jsdomError", message, stack: String(err?.detail?.stack || err?.stack || "") });
  });
  if (VERBOSE) vc.on("log", (...a) => console.log(C.d + "[page]", ...a, C.x));
  vc.on("error", (...a) => { if (VERBOSE) console.error(C.d + "[page error]", ...a, C.x); });

  let dom;
  try {
    dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: "http://localhost/",
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        /* The app must start from its built-in seed data, never a previous run. */
        try { window.localStorage.clear(); } catch { /* jsdom without storage */ }
        window.fetch = replayFetch;

        window.addEventListener("error", (ev) => {
          appErrors.push({
            kind: "window.onerror",
            message: String(ev?.message || ev?.error?.message || "unknown error"),
            stack: String(ev?.error?.stack || ""),
          });
        });
        window.addEventListener("unhandledrejection", (ev) => {
          const r = ev?.reason;
          appErrors.push({
            kind: "unhandledrejection",
            message: String(r?.message || r || "unhandled rejection"),
            stack: String(r?.stack || ""),
          });
        });

        /* Compress the app's throttle/debounce timers so the suite stays fast. */
        if (FAST) {
          const realSetTimeout = window.setTimeout.bind(window);
          window.setTimeout = function (fn, ms, ...args) {
            const n = Number(ms);
            const delay = Number.isFinite(n) ? Math.min(Math.max(n, 0), TIMER_CAP) : 0;
            return realSetTimeout(fn, delay, ...args);
          };
        }
      },
    });
  } catch (e) {
    console.error(`${C.r}harness failure:${C.x} the page could not be booted in jsdom\n${e.stack || e}`);
    return 3;
  }

  const { window } = dom;
  const doc = window.document;
  const hook = window.__animeTest || null;
  const status = hookStatus(hook);

  console.log(C.b + "anime-custom-lists smoke suite" + C.x);
  console.log(`  app:      ${APP_PATH}`);
  console.log(`  fixtures: ${FIX_DIR}`);
  let jsdomVersion = "?";
  try {
    jsdomVersion = JSON.parse(fs.readFileSync(path.join(HERE, "node_modules", "jsdom", "package.json"), "utf8")).version;
  } catch { /* not installed locally */ }
  console.log(`  jsdom:    ${jsdomVersion}  ·  mode: ${FAST ? "fast (timers clamped)" : "real timers"}`);

  /* ---- the hook is the contract; without it we can say nothing useful ---- */
  if (!status.ok) {
    console.log("");
    console.log(C.r + C.b + "HOOK MISSING — window.__animeTest is not (fully) installed by the app." + C.x);
    if (!hook) console.log("  The page booted, but no test hook was found on window.");
    if (status.missing?.length) console.log("  missing members: " + status.missing.join(", "));
    if (status.wrong?.length) console.log("  wrong shape:    " + status.wrong.join(", "));
    console.log("  expected contract:");
    console.log(`    window.__animeTest = { ready: Promise, state(), apiSearch(q,opts), doSearch(q,opts),`);
    console.log(`      searchCandidates(), computeRecs(force), recCandidates(), syncMissingMeta() }`);
    /* let boot finish so the fixture report is meaningful */
    await sleep(400);
    addRow("A", "recommendations are visual", "SKIP", "needs __animeTest (hook missing)");
    addRow("B", "metadata back-fill", "SKIP", "needs __animeTest (hook missing)");
    addRow("C", "adult title searchable", "SKIP", "needs __animeTest (hook missing)");
    addRow("D", "relevance ranking", "SKIP", "needs __animeTest (hook missing)");
    printTable();
    printFixtureReport();
    console.log(C.y + "\nRe-run this suite once the hook lands — fixtures are already captured." + C.x);
    try { window.close(); } catch { /* ignore */ }
    return 2;
  }

  /* ---- wait for the app's boot probe -------------------------------- */
  try {
    await withTimeout(hook.ready, READY_TIMEOUT, "__animeTest.ready");
  } catch (e) {
    console.error(`${C.r}boot failure:${C.x} ${e.message}`);
    console.error("  the page loaded but its boot probe never settled — check the fetch stub / fixtures");
    printFixtureReport();
    try { window.close(); } catch { /* ignore */ }
    return 3;
  }
  /* ready() promises the probe; a tick for the first render keeps scenarios simple */
  await sleep(20);
  /* The app races provider searches against a deadline.  Timer clamping could make
   * that deadline fire before the fixture replay settles, so the hook exposes the
   * timing as mutable config — widen it (fixtures resolve immediately anyway). */
  try {
    const cfg = hook.apiConfig;
    if (cfg && typeof cfg === "object" && "searchDeadline" in cfg) cfg.searchDeadline = 60000;
  } catch { /* older hook revision without the knob */ }

  const scenarios = makeScenarios({ win: window, doc, hook });
  const LABELS = {
    A: "recommendations are visual",
    B: "metadata back-fill",
    C: "adult title searchable",
    D: "relevance ranking",
  };
  for (const id of ["A", "B", "C", "D"]) {
    try {
      const detail = await withTimeout(scenarios[id](), SCENARIO_TIMEOUT, `scenario ${id}`);
      addRow(id, LABELS[id], "PASS", detail || "ok");
    } catch (e) {
      addRow(id, LABELS[id], "FAIL", String(e?.message || e).replace(/\s+/g, " ").slice(0, 420));
    }
  }

  /* ---- the app must not have thrown while we drove it ------------------- */
  const seenErr = new Set();
  const unexpected = appErrors.filter((e) => {
    if (BENIGN.test(e.message)) return false;
    const key = e.message + "|" + (e.stack || "").split("\n")[1];
    if (seenErr.has(key)) return false;
    seenErr.add(key);
    return true;
  });
  if (unexpected.length) {
    const first = unexpected[0];
    addRow("E", "app did not throw", "FAIL",
      `${unexpected.length} uncaught error(s) — ${first.kind}: ${first.message}`.slice(0, 420));
    console.log("");
    console.log(C.r + C.b + "UNCAUGHT ERRORS FROM THE PAGE" + C.x);
    for (const e of unexpected.slice(0, 5)) {
      console.log(`  ${C.r}${e.kind}${C.x}: ${e.message}`);
      if (e.stack) console.log(e.stack.split("\n").slice(0, 8).map((l) => "    " + l).join("\n"));
    }
    if (unexpected.length > 5) console.log(`  … and ${unexpected.length - 5} more`);
  } else {
    addRow("E", "app did not throw", "PASS", "no window.onerror / unhandled rejection");
  }

  printTable();
  printFixtureReport();

  const failed = rows.filter((r) => r.status === "FAIL");
  const passed = rows.filter((r) => r.status === "PASS");
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(C.b + `${failed.length ? "FAILED" : "ALL GREEN"}: `
    + `${passed.length} passed, ${failed.length} failed, ${rows.filter((r) => r.status === "SKIP").length} skipped`
    + ` (${elapsed}s)` + C.x);

  try { window.close(); } catch { /* ignore */ }
  return failed.length ? 1 : 0;
}

/* A rejected promise created inside the page's VM context surfaces as a *Node*
 * unhandledRejection, not a jsdom window event.  Without this listener Node aborts
 * the whole process and we would lose the report; with it, the error is recorded and
 * fails the run loudly instead. */
process.on("unhandledRejection", (reason) => {
  const r = reason;
  appErrors.push({
    kind: "unhandledrejection",
    message: String(r?.message || r || "unhandled rejection"),
    stack: String(r?.stack || ""),
  });
});

/* Guard the process against a page that wedges the event loop. */
const watchdog = setTimeout(() => {
  console.error(`\n${C.r}watchdog: suite did not finish in time${C.x}`);
  printTable();
  process.exit(1);
}, 300000);
if (watchdog.unref) watchdog.unref();

let code = 3;
try {
  code = await main();
} catch (e) {
  console.error(`${C.r}harness crashed:${C.x} ${e?.stack || e}`);
  code = 3;
}
process.exitCode = code;
/* jsdom windows can hold timers; make the exit deterministic. */
setTimeout(() => process.exit(code), 250).unref();
