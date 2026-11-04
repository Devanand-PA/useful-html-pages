#!/usr/bin/env node
/**
 * smoke-jobs.mjs — deterministic end-to-end smoke test for ../jobs-custom-lists.html
 *
 *   cd tests && npm run test:jobs      # or: node smoke-jobs.mjs
 *
 * The app is a single-file page: no build step, inline JS, all of its data arrives
 * through fetch() and all of its state lives in localStorage.  So the test boots
 * the *real* file inside jsdom with:
 *
 *   • runScripts: "dangerously"     — the inline app script actually runs
 *   • url: "http://localhost/"      — gives jsdom a real origin, hence localStorage
 *   • an empty localStorage         — every run starts from the app's own seed data
 *   • a stubbed window.fetch        — replayed from tests/fixtures-jobs/, never the network
 *
 * The fetch stub routes by *URL shape* (host + query parameters), not by an exact
 * string, so a new page size or an added parameter still resolves to the same
 * recorded payload.  Unrecognised requests are reported in the diagnostics block
 * at the end instead of failing silently.
 *
 * Scenarios (drive everything through window.__jobsTest, added by the app):
 *   A  matching jobs are visual   .rec-card has an <img>, every candidate has cover+description
 *   B  metadata back-fill         every seeded job gains a cover and a description
 *   C  keyword search             doSearch("python") surfaces python-tagged postings
 *   D  relevance ranking          those postings sit inside the first 5 results
 *   E  app did not throw          no window.onerror, no unhandled rejection
 *   F  open-on chooser            every card's 🔗 opens the chooser; it lists the
 *                                 posting first (when the card has a URL) then the
 *                                 five ranked job sites; picking LinkedIn searches it
 *                                 for that card's title
 *   G  tier weights               a tier placed lower always weighs strictly less:
 *                                 ladder + custom names, top/bottom/unranked checked
 *   H  duplicates                 ⧉ on a match marks it "same job, another name": the
 *                                 card hides, the seen index blocks it, the profile
 *                                 counts the job once, ✕ in the panel restores it
 *   I  in-place editing           dbl-click a tier label renames it inside the label;
 *                                 dbl-click a card opens its tooltip with the notes
 *                                 editor focused below the description (Enter/Esc/blank)
 *   J  URL → card                 "Fetch details" on a pasted Greenhouse URL fills the
 *                                 title and company from the page (through the reader
 *                                 relay), and saving files the card in the chosen tier
 *   K  screenshot → card          an attached screenshot becomes the card's image
 *                                 (data URL kept when no canvas exists) and the card
 *                                 is flagged as coming from a screenshot
 *   L  pay & region normalisation monthly/hourly pay annualise, region strings bucket
 *
 * Exit codes: 0 all pass · 1 something failed · 2 test hook missing (nothing run) ·
 *             3 harness/boot failure (app did not boot at all).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* SMOKE_APP lets the harness itself be pointed at a copy. */
const APP_PATH = process.env.SMOKE_APP
  ? path.resolve(process.env.SMOKE_APP)
  : path.resolve(HERE, "..", "jobs-custom-lists.html");
const FIX_DIR = path.join(HERE, "fixtures-jobs");

/* ---- knobs ---------------------------------------------------------------------
 * SMOKE_REALTIME=1        honour the app's real throttles (slow, faithful)
 * SMOKE_VERBOSE=1         forward the page console to stdout
 * SMOKE_READY_TIMEOUT=N   ms to wait for __jobsTest.ready (default 20000)
 * SMOKE_DUMP_URLS=1       print every distinct URL the app requested
 */
const FAST = process.env.SMOKE_REALTIME !== "1";
const VERBOSE = process.env.SMOKE_VERBOSE === "1";
const READY_TIMEOUT = Number(process.env.SMOKE_READY_TIMEOUT || 20000);
const DUMP_URLS = process.env.SMOKE_DUMP_URLS === "1";
const SCENARIO_TIMEOUT = 60000;
/* Timers are clamped while FAST so a 20-entry back-fill takes ~0.3s instead of
 * ~2 minutes.  The fetch stub ignores AbortSignal, so clamping the fetch
 * watchdog is harmless. */
const TIMER_CAP = 5;

const C = process.stdout.isTTY
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", b: "", x: "" };

/* ============================================================================
 * fixture router
 * ==========================================================================*/

const fixtureCache = new Map();
/** Load `<name>` (relative to fixtures-jobs/) plus an optional `<name>.status` file. */
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
        type: name.endsWith(".txt") ? "text/plain"
          : name.endsWith(".xml") ? "application/xml"
          : "application/json",
      };
    }
  } catch { /* missing fixture */ }
  fixtureCache.set(name, rec);
  return rec;
}

const EMPTY = {
  json: { status: 200, body: '{"jobs":[]}', type: "application/json", fixture: null },
  arbeit: { status: 200, body: '{"data":[],"links":{},"meta":{}}', type: "application/json", fixture: null },
  text: { status: 404, body: "", type: "text/plain", fixture: null },
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
  const q = u.searchParams;
  const method = String((init && init.method) || "GET").toUpperCase();

  /* ---- Remotive (the only provider with a real text search) ---- */
  if (host.includes("remotive")) {
    const term = q.get("search");
    if (term) {
      return loadFixture("remotive-search-python.json")
        || { ...EMPTY.json, fixture: null, miss: `remotive search: ${term}` };
    }
    if (q.get("category")) {
      return loadFixture("remotive-category-software-development.json")
        || { ...EMPTY.json, fixture: null, miss: `remotive category: ${q.get("category")}` };
    }
    return loadFixture("remotive-ping.json") || { ...EMPTY.json, fixture: null, miss: "remotive ping" };
  }

  /* ---- Jobicy (industry / geo slices; no keyword search) ---- */
  if (host.includes("jobicy")) {
    const ind = q.get("industry");
    if (ind) {
      return loadFixture(`jobicy-industry-${ind}.json`)
        || loadFixture("jobicy-industry-engineering.json")
        || { ...EMPTY.json, fixture: null, miss: `jobicy industry: ${ind}` };
    }
    return loadFixture("jobicy-ping.json") || { ...EMPTY.json, fixture: null, miss: "jobicy ping" };
  }

  /* ---- Arbeitnow (board dump; page=99999 is the cheap empty ping) ---- */
  if (host.includes("arbeitnow")) {
    if (q.get("page") === "99999") {
      return loadFixture("arbeitnow-ping.json") || { ...EMPTY.arbeit, fixture: null, miss: "arbeitnow ping" };
    }
    return loadFixture("arbeitnow-board.json") || { ...EMPTY.arbeit, fixture: null, miss: "arbeitnow board" };
  }

  /* ---- the reader relay that extracts a pasted posting's fields ---- */
  if (host.includes("r.jina.ai")) {
    return loadFixture("jina-greenhouse.txt")
      || { ...EMPTY.text, fixture: null, miss: `jina reader: ${u.pathname}` };
  }

  /* Unknown host: a 404 with an empty body — the app's relay chain must walk
   * past it, and it shows up in the diagnostics. */
  return { ...EMPTY.text, fixture: null, miss: `${method} ${host}${u.pathname}` };
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
  for (const [n, c] of [...served.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${String(c).padStart(4)}×  ${n}`);
  }
  if (misses.size) {
    console.log("");
    console.log(C.y + "unmatched requests (no fixture recorded — the app asked for something new)" + C.x);
    const shown = [...misses.entries()].slice(0, 12);
    for (const [n, c] of shown) console.log(`  ${String(c).padStart(4)}×  ${n}`);
    if (misses.size > shown.length) console.log(`  … and ${misses.size - shown.length} more`);
    console.log(C.d + "  re-run ./capture-jobs-fixtures.sh to extend coverage" + C.x);
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
/* The 🔗 "open on…" contract: the chooser opens the card's own posting first
 * (when it carries a URL) and then offers five ranked job sites, each with a
 * verified search route for the card's title. Pinned here: LinkedIn leads with
 * https://www.linkedin.com/jobs/search?keywords=<title>. If the ranking or a
 * route changes, update JOB_SITES here together with the app's registry. */
const EXPECTED_SITES = ["LinkedIn", "Indeed", "Glassdoor", "Wellfound", "Google Jobs"];
const PINNED_SITE = "LinkedIn";
const PINNED_PREFIX = "https://www.linkedin.com/jobs/search?keywords=";
/* The posting used by scenario J — captured through the reader relay. */
const SAMPLE_URL = "https://job-boards.greenhouse.io/gitlab/jobs/8629019002";

function makeScenarios({ win, doc, hook }) {
  const entryById = (id) => {
    for (const l of hook.state().lists) {
      const e = l.entries.find((x) => x.id === id);
      if (e) return e;
    }
    return null;
  };
  const allEntries = () => hook.state().lists.flatMap((l) => l.entries);

  /* A — matching jobs are visual --------------------------------------------- */
  async function scenarioA() {
    await withTimeout(hook.computeRecs(true), 30000, "computeRecs(true)");
    await waitFor(() => doc.querySelectorAll(".rec-card").length > 0, 10000,
      "at least one .rec-card to render");
    /* artwork may be back-filled after first paint; give hydration a chance */
    await waitFor(() => {
      const cs = hook.recCandidates() || [];
      return cs.length > 0 && cs.every((c) => nonEmpty(c.cover) && nonEmpty(c.synopsis));
    }, 12000, "all candidates to carry artwork + a description").catch(() => {});

    const cards = [...doc.querySelectorAll(".rec-card")];
    if (!cards.length) throw new Error("no recommendation cards rendered");
    const imgs = cards.map((c) => c.querySelector("img")).filter(Boolean);
    if (imgs.length !== cards.length) {
      throw new Error(`${cards.length - imgs.length} of ${cards.length} rec cards have no <img>`);
    }
    for (const img of imgs) {
      if (!absoluteUrl(img.getAttribute("src"))) {
        throw new Error("a rec card image has a non-absolute src: " + img.getAttribute("src"));
      }
    }
    const cs = hook.recCandidates();
    const broken = cs.filter((c) => !c.cover || !c.synopsis);
    if (broken.length) {
      throw new Error(`${broken.length} candidate(s) without cover/description: ` +
        broken.slice(0, 3).map((c) => c.title).join(", "));
    }
    const source = hook.recSource();
    if (source !== "providers") {
      throw new Error(`recSource is "${source}" — the built-in fallback pool is not a live source`);
    }
    return `${cards.length} cards / ${cs.length} candidates, all with artwork + description (via ${source})`;
  }

  /* B — metadata back-fill ---------------------------------------------------- */
  async function scenarioB() {
    /* the boot back-fill may still be running: blank everything and wait for a
       pass that completes, exactly like a fresh save with no metadata. */
    const blank = () => {
      for (const e of allEntries()) {
        e.cover = null; e.synopsis = null; e.pay = null; e.location = ""; e.remote = null;
        e.tags = []; e.url = null; e.source = null; e.srcId = null;
        e.metaDone = false; e.syncTries = 0;
      }
    };
    blank();
    const complete = () => allEntries()
      .every((e) => e.cover && (e.synopsis || e.pay));
    let pass = 0;
    for (; pass < 6 && !complete(); pass++) {
      await withTimeout(hook.syncMissingMeta(), 30000, `syncMissingMeta() pass ${pass + 1}`);
      await sleep(150);
    }
    if (!complete()) {
      const bad = allEntries().filter((e) => !e.cover || !(e.synopsis || e.pay));
      throw new Error(`${bad.length} entr(ies) still without cover/description after ${pass} pass(es): ` +
        bad.slice(0, 4).map((e) => e.title).join(", "));
    }
    await sleep(80);                     // let the last repaint land
    const noImg = [...doc.querySelectorAll(".item .noimg")];
    if (noImg.length) {
      throw new Error(`${noImg.length} card(s) still show the "no image yet" tile`);
    }
    const withSyn = allEntries().filter((e) => e.synopsis).length;
    return `all ${allEntries().length} seeded jobs back-filled (${withSyn} with a description), no "no image yet" tiles`;
  }

  /* C — keyword search surfaces matching postings ----------------------------- */
  async function scenarioC() {
    await withTimeout(hook.doSearch("python"), 30000, "doSearch('python')");
    await waitFor(() => (hook.searchCandidates() || []).length > 0, 10000, "search results");
    const cands = hook.searchCandidates();
    const py = cands.filter((c) => (c.tags || []).some((t) => String(t).toLowerCase() === "python"));
    if (!py.length) {
      throw new Error("no result carries a python tag after searching 'python'");
    }
    const cards = [...doc.querySelectorAll(".result-card")];
    if (cards.length !== cands.length) {
      throw new Error(`rendered ${cards.length} result cards for ${cands.length} candidates`);
    }
    const companies = cands.filter((c) => c.company).length;
    return `${cands.length} results (${companies} with a company), python-tagged: ` +
      py.slice(0, 3).map((c) => c.title).join(", ");
  }

  /* D — relevance ranking ----------------------------------------------------- */
  async function scenarioD() {
    const cands = hook.searchCandidates() || [];
    if (!cands.length) await scenarioC();
    const pool = hook.searchCandidates() || [];
    const py = pool.filter((c) => (c.tags || []).some((t) => String(t).toLowerCase() === "python"));
    if (!py.length) throw new Error("no python-tagged result to rank");
    const first5 = pool.slice(0, 5).map((c) => c.title);
    const top = py.filter((c) => first5.includes(c.title));
    if (!top.length) {
      throw new Error("python-tagged results are not inside the first 5 — first 5: " + first5.join(" | "));
    }
    return `python-tagged "${top[0].title}" ranks #${first5.indexOf(top[0].title) + 1} of ${pool.length}`;
  }

  /* F — the 🔗 open-on chooser ------------------------------------------------- */
  async function scenarioF() {
    /* every card kind carries exactly one chooser badge */
    for (const sel of [".item", ".result-card", ".rec-card"]) {
      const cards = [...doc.querySelectorAll(sel)];
      if (!cards.length) throw new Error(`no ${sel} on the page to badge`);
      for (const c of cards.slice(0, 3)) {
        const n = c.querySelectorAll(".watch-btn").length;
        if (n !== 1) throw new Error(`${sel} carries ${n} chooser badges (expected exactly 1)`);
      }
    }
    const opened = [];
    win.open = (url, target) => { opened.push({ url, target }); return null; };

    const card = doc.querySelector(".item");
    const entry = entryById(card.dataset.entryId);
    if (!entry) throw new Error("the first .item has no known entry");
    if (!entry.url) throw new Error("the first tracked job has no posting URL after back-fill");

    card.querySelector(".watch-btn").click();
    const menu = doc.getElementById("watchMenu");
    if (menu.style.display !== "block") throw new Error("the 🔗 badge did not open the chooser");

    const rows = [...menu.querySelectorAll(".wm-site")];
    const names = rows.map((b) => b.querySelector(".wm-name").textContent.trim());
    if (names[0] !== "Open posting") {
      throw new Error("the chooser must open the card's own posting first — got " + names[0]);
    }
    const ranked = names.slice(1);
    if (ranked.length !== EXPECTED_SITES.length || new Set(ranked).size !== ranked.length) {
      throw new Error(`expected ${EXPECTED_SITES.length} unique ranked sites, got: ${ranked.join(", ")}`);
    }
    if (ranked.join(",") !== EXPECTED_SITES.join(",")) {
      throw new Error(`ranked sites drifted: ${ranked.join(", ")} != ${EXPECTED_SITES.join(",")}`);
    }
    if (!menu.querySelector(".wm-title").textContent.includes(entry.title)) {
      throw new Error("the chooser headline is not the card's title");
    }
    /* rank 0 opens the posting itself */
    rows[0].click();
    if (!opened.length || opened[0].url !== entry.url || opened[0].target !== "_blank") {
      throw new Error("Open posting did not open the card's own URL in a new tab");
    }
    /* rank 1 searches the pinned site for that title */
    rows[1].click();
    const want = PINNED_PREFIX + encodeURIComponent(entry.title);
    if (!opened[1] || opened[1].url !== want || opened[1].target !== "_blank") {
      throw new Error(`picking #1 did not search ${PINNED_SITE}: wanted ${want}, got ${opened[1] && opened[1].url}`);
    }
    if (menu.style.display !== "none") throw new Error("the chooser stayed open after a pick");
    return `chooser: posting + ${ranked.join(" · ")}; ${PINNED_SITE} searched "${entry.title}"`;
  }

  /* G — tier weights follow position ------------------------------------------ */
  async function scenarioG() {
    const list = hook.state().lists.find((l) => l.kind === "tier");
    if (!list) throw new Error("no tier list seeded");
    const ladder = hook.tierWeights(list);
    const vals = [...ladder.values()];
    if (!vals.every((v, i) => i === 0 || v < vals[i - 1])) {
      throw new Error("tier weights are not strictly decreasing top to bottom: " + vals.join(", "));
    }
    const bottom = list.tiers[list.tiers.length - 1];
    if (!(ladder.get("") < ladder.get(bottom.id))) {
      throw new Error("the unranked row must weigh less than the bottom tier");
    }
    /* a custom-named tier dragged on top ("God") keeps the ladder strict */
    const original = list.tiers.slice();
    list.tiers.unshift({ id: "smoke-god", label: "God" });
    const withGod = hook.tierWeights(list);
    const godVals = [...withGod.values()];
    if (!godVals.every((v, i) => i === 0 || v < godVals[i - 1])) {
      throw new Error("weights with a God tier are not strictly decreasing: " + godVals.join(", "));
    }
    if (withGod.get("smoke-god") !== 1) {
      throw new Error("the top tier must weigh 1.0, got " + withGod.get("smoke-god"));
    }
    list.tiers = original;                     // leave the list untouched
    return `ladder strict (${vals.map((v) => v.toFixed(2)).join(" › ")}); God tier pinned at 1.0; unranked < bottom`;
  }

  /* H — duplicates: same job, another name ------------------------------------- */
  async function scenarioH() {
    await waitFor(() => doc.querySelectorAll(".rec-card").length > 0, 10000, "a .rec-card to mark");
    const before = doc.querySelectorAll(".rec-card").length;
    const card = doc.querySelector(".rec-card");
    const title = card.querySelector(".rec-title").textContent.trim();

    card.querySelector(".dupe-btn").click();
    const modal = doc.getElementById("dupeModal");
    if (modal.style.display !== "flex") throw new Error("⧉ did not open the duplicate picker");
    const picks = [...modal.querySelectorAll(".dupe-pick")];
    if (!picks.length) throw new Error("the picker lists no tracked jobs");
    picks[0].click();

    const dupes = hook.dupes();
    if (dupes.length !== 1) throw new Error(`expected exactly one duplicate pair, got ${dupes.length}`);
    if (!dupes[0].key || !dupes[0].of) throw new Error("the pair is missing its key/of");

    /* the batch always shows the same number of cards — the next-best match
       steps up into the slot the marked one vacated, so assert on identity */
    const titlesAfter = [...doc.querySelectorAll(".rec-card .rec-title")]
      .map((t) => t.textContent.trim());
    if (titlesAfter.includes(title)) {
      throw new Error("the marked card is still rendered in the batch");
    }
    if (titlesAfter.length !== before) {
      throw new Error(`expected ${before} cards to still render, got ${titlesAfter.length}`);
    }
    const panel = doc.getElementById("dupePanel");
    if (panel.style.display !== "block") throw new Error("the ⧉ Duplicates panel did not appear");
    if (panel.querySelectorAll(".dupe-row").length !== 1) throw new Error("the panel does not list the pair");

    if (!hook.buildSeenIndex().looksTracked({ title, company: "" })) {
      throw new Error("the marked posting is still seen as new — it will be recommended again");
    }
    const cand = (hook.recCandidates() || []).find((c) => c.title === title);
    if (!cand) throw new Error("the marked candidate is gone from the pool entirely");
    const guard = hook.dupeGuard();
    guard(hook.jobKey(cand));
    if (!guard(dupes[0].of)) {
      throw new Error("the same job under its other name was counted twice");
    }
    panel.querySelector(".dupe-x").click();
    if (hook.dupes().length !== 0) throw new Error("✕ did not remove the marking");
    await waitFor(() => {
      const t = [...doc.querySelectorAll(".rec-card .rec-title")].map((x) => x.textContent.trim());
      return t.includes(title);
    }, 4000, "the card to come back after unmarking");
    const titlesBack = [...doc.querySelectorAll(".rec-card .rec-title")].map((t) => t.textContent.trim());
    if (!titlesBack.includes(title)) throw new Error("the card did not come back after unmarking");
    return `"${title}" marked duplicate → hidden (next match stepped up), blocked, restored`;
  }

  /* I — tier labels & notes edit in place -------------------------------------- */
  async function scenarioI() {
    /* ---- tier label, in place ---- */
    const row = doc.querySelector(".tier-row:not(.unranked)");
    if (!row) throw new Error("no ranked tier row on the page");
    const label = row.querySelector(".tier-label");
    const before = label.querySelector(".tl-text").textContent;
    const dbl = (el) => el.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const key = (el, k) => el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

    dbl(label);
    let input = label.querySelector(".tier-label-edit");
    if (!input) throw new Error("dbl-click did not swap the label text for an inline editor");
    input.value = "Escaped Away";
    key(input, "Escape");
    await sleep(30);
    if (label.querySelector(".tier-label-edit")) throw new Error("Escape did not close the editor");
    if (label.querySelector(".tl-text").textContent !== before) throw new Error("Escape must cancel the rename");

    dbl(label);
    input = label.querySelector(".tier-label-edit");
    if (!input) throw new Error("the editor did not reopen");
    input.value = "Godlike";
    key(input, "Enter");
    await waitFor(() => {
      const r = doc.querySelector(".tier-row:not(.unranked)");
      return r && !r.querySelector(".tier-label-edit") &&
        r.querySelector(".tl-text").textContent === "Godlike";
    }, 4000, "the renamed tier label to repaint");
    const tier = hook.state().lists.find((l) => l.kind === "tier").tiers[0];
    if (tier.label !== "Godlike") throw new Error("the rename did not persist to state");
    tier.label = before;                     // leave the list as it was

    /* ---- card notes, in the tooltip ---- */
    const card = doc.querySelector(".item");
    const entry = entryById(card.dataset.entryId);
    if (!entry) throw new Error("the first .item has no known entry");
    const tips = doc.getElementById("tooltip");

    dbl(card);
    if (tips.style.display !== "block") throw new Error("dbl-click did not open the tooltip");
    const syn = tips.querySelector(".tt-syn");
    const notes = tips.querySelector(".tt-notes");
    if (!notes) throw new Error("the tooltip has no notes section");
    if (!(syn.compareDocumentPosition(notes) & win.Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error("the notes do not sit below the description");
    }
    let ta = tips.querySelector("textarea.tt-notes-edit");
    if (!ta) throw new Error("the notes editor did not open on dbl-click");
    if (doc.activeElement !== ta) throw new Error("the notes editor was not focused");

    ta.value = "should not be saved";
    key(ta, "Escape");
    await sleep(30);
    if (entry.notes) throw new Error("Escape must not save the note");

    dbl(card);
    ta = tips.querySelector("textarea.tt-notes-edit");
    if (!ta) throw new Error("the editor did not reopen");
    ta.value = "referral from Maya";
    key(ta, "Enter");
    await sleep(50);
    if (entry.notes !== "referral from Maya") {
      throw new Error("Enter did not save the note (got " + JSON.stringify(entry.notes) + ")");
    }
    const card2 = doc.querySelector(`.item[data-entry-id="${entry.id}"]`);
    if (!card2 || !card2.querySelector(".notes-dot")) throw new Error("the 📝 dot did not appear on the card");

    dbl(card2);
    ta = tips.querySelector("textarea.tt-notes-edit");
    if (!ta) throw new Error("the editor did not reopen from the dot");
    ta.value = "   ";
    key(ta, "Enter");
    await sleep(50);
    if (entry.notes != null) throw new Error("a blank note must clear the field");
    const card3 = doc.querySelector(`.item[data-entry-id="${entry.id}"]`);
    if (card3 && card3.querySelector(".notes-dot")) throw new Error("the 📝 dot did not clear");

    return "tier label renamed in place (Esc/Enter); notes edited below the description (Esc/Enter/blank)";
  }

  /* J — a pasted posting URL becomes a card ------------------------------------ */
  async function scenarioJ() {
    const ac = hook.addCard;
    ac.open({ mode: "url", url: SAMPLE_URL });
    const modal = doc.getElementById("addCardModal");
    if (modal.style.display !== "flex") throw new Error("the add-card modal did not open");
    if (ac.getField("acUrl") !== SAMPLE_URL) throw new Error("the URL bar did not pre-fill the modal");
    const fills = [...modal.querySelectorAll(".ac-tabs button")].map((b) => b.dataset.mode);
    if (fills.join(",") !== "url,screenshot,manual") {
      throw new Error("the three card flavours are not offered: " + fills.join(", "));
    }

    doc.getElementById("acFetchBtn").click();
    await waitFor(() => nonEmpty(ac.getField("acTitle")), 20000, "the fetched title to fill in");
    const title = ac.getField("acTitle");
    if (!/Director, Support/i.test(title)) {
      throw new Error(`the reader relay fixture was not parsed — title came out as "${title}"`);
    }
    const company = ac.getField("acCompany") || "";
    if (!/GitLab/i.test(company)) {
      throw new Error(`the company was not extracted from the posting (got "${company}")`);
    }
    const before = allEntries().length;
    const saved = ac.save();
    if (!saved) throw new Error("save refused — a required field is missing");
    if (modal.style.display !== "none") throw new Error("the modal did not close after saving");
    if (allEntries().length !== before + 1) throw new Error("no card was added");

    const added = allEntries().find((e) => e.title === title);
    if (!added) throw new Error("the added card is not findable by title");
    if (added.url !== SAMPLE_URL) throw new Error("the posting URL was dropped from the card");
    if (!added.synopsis) throw new Error("the description fetched from the page was dropped");
    return `card from URL: "${title}" @ ${added.company} (fields read through the relay)`;
  }

  /* K — a screenshot becomes a card -------------------------------------------- */
  async function scenarioK() {
    /* a 1×1 png — jsdom has no canvas, so the app must keep the raw data URL */
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const ac = hook.addCard;
    ac.attachImage(dataUrl);
    const modal = doc.getElementById("addCardModal");
    if (modal.style.display !== "flex") throw new Error("the add-card modal did not open");
    if (!modal.querySelector("#shotZone img")) throw new Error("the screenshot preview did not render");

    ac.setField("acTitle", "Senior Product Designer");
    ac.setField("acCompany", "TrustedHousesitters");
    ac.setField("acLocation", "Remote (EU)");
    const before = allEntries().length;
    const saved = ac.save();
    if (!saved) throw new Error("save refused — a required field is missing");
    if (allEntries().length !== before + 1) throw new Error("the screenshot card was not added");

    const e = allEntries().find((x) => x.title === "Senior Product Designer");
    if (!e) throw new Error("the added card is not findable");
    if (!e.cover || !e.cover.startsWith("data:image")) {
      throw new Error("the screenshot did not become the card's image");
    }
    if (e.shot !== true) throw new Error("the card was not flagged as coming from a screenshot");
    const card = doc.querySelector(`.item[data-entry-id="${e.id}"]`);
    if (!card || !card.querySelector("img.shot")) {
      throw new Error("the card does not render the screenshot art");
    }
    if (!card.querySelector(".shot-dot")) throw new Error("the 📷 dot did not appear on the card");
    return `screenshot became the card art for "${e.title}" (${e.cover.length}-byte data URL)`;
  }

  /* L — pay & region normalisation --------------------------------------------- */
  async function scenarioL() {
    const p = hook.parsePay;
    const monthly = p("$3.5k–$5k/month");
    if (monthly.annualMax !== 60000 || monthly.period !== "monthly") {
      throw new Error("monthly pay did not annualise: " + JSON.stringify(monthly));
    }
    const hourly = p("$50-$75 /hour");
    if (hourly.annualMin !== 104000) throw new Error("hourly pay did not annualise: " + JSON.stringify(hourly));
    const yearly = p("$120,000 - $150,000");
    if (yearly.min !== 120000 || yearly.max !== 150000 || yearly.annualMax !== 150000) {
      throw new Error("yearly pay did not parse: " + JSON.stringify(yearly));
    }
    if (p("competitive").annualMax != null) throw new Error("'competitive' must stay unparsed");
    if (hook.regionOf("Berlin, Germany") !== "Germany") throw new Error("Berlin did not bucket to Germany");
    if (hook.regionOf("Remote (Worldwide)", true) !== "Worldwide") throw new Error("Worldwide did not bucket");
    if (hook.canonSkill("typescript") !== "TypeScript") throw new Error("skill canonicalisation drifted");
    return "pay annualised across periods; regions bucketed; skills canonical";
  }

  return { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, F: scenarioF,
           G: scenarioG, H: scenarioH, I: scenarioI, J: scenarioJ, K: scenarioK, L: scenarioL };
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
    console.error(`fixtures missing at ${FIX_DIR} — run ./capture-jobs-fixtures.sh first`);
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
  const hook = window.__jobsTest || null;
  const status = hookStatus(hook);

  console.log(C.b + "jobs-custom-lists smoke suite" + C.x);
  console.log(`  app:      ${APP_PATH}`);
  console.log(`  fixtures: ${FIX_DIR}`);
  let jsdomVersion = "?";
  try {
    jsdomVersion = JSON.parse(fs.readFileSync(path.join(HERE, "node_modules", "jsdom", "package.json"), "utf8")).version;
  } catch { /* not installed locally */ }
  console.log(`  jsdom:    ${jsdomVersion}  ·  mode: ${FAST ? "fast (timers clamped)" : "real timers"}`);

  /* ---- the hook is the contract; without it we can say nothing useful ---- */
  const SCENARIO_IDS = ["A", "B", "C", "D", "F", "G", "H", "I", "J", "K", "L"];
  const LABELS = {
    A: "matching jobs are visual",
    B: "metadata back-fill",
    C: "keyword search surfaces postings",
    D: "relevance ranking",
    F: "open-on chooser → ranked job sites",
    G: "tier weights follow position",
    H: "duplicates: same job, another name",
    I: "tier labels & notes edit in place",
    J: "posting URL → card",
    K: "screenshot → card",
    L: "pay & region normalisation",
  };
  if (!status.ok) {
    console.log("");
    console.log(C.r + C.b + "HOOK MISSING — window.__jobsTest is not (fully) installed by the app." + C.x);
    if (!hook) console.log("  The page booted, but no test hook was found on window.");
    if (status.missing?.length) console.log("  missing members: " + status.missing.join(", "));
    if (status.wrong?.length) console.log("  wrong shape:    " + status.wrong.join(", "));
    console.log("  expected contract:");
    console.log(`    window.__jobsTest = { ready: Promise, state(), apiSearch(q,opts), doSearch(q),`);
    console.log(`      searchCandidates(), computeRecs(force), recCandidates(), syncMissingMeta() }`);
    await sleep(400);
    for (const id of SCENARIO_IDS) addRow(id, LABELS[id], "SKIP", "needs __jobsTest (hook missing)");
    printTable();
    printFixtureReport();
    console.log(C.y + "\nRe-run this suite once the hook lands — fixtures are already captured." + C.x);
    try { window.close(); } catch { /* ignore */ }
    return 2;
  }

  /* ---- wait for the app's boot probe -------------------------------- */
  try {
    await withTimeout(hook.ready, READY_TIMEOUT, "__jobsTest.ready");
  } catch (e) {
    console.error(`${C.r}boot failure:${C.x} ${e.message}`);
    console.error("  the page loaded but its boot probe never settled — check the fetch stub / fixtures");
    printFixtureReport();
    try { window.close(); } catch { /* ignore */ }
    return 3;
  }
  await sleep(20);
  /* The app races provider searches against a deadline.  Timer clamping could
   * make that deadline fire before the fixture replay settles, so the hook
   * exposes the timing as mutable config — widen it (fixtures resolve at once). */
  try {
    const cfg = hook.apiConfig;
    if (cfg && typeof cfg === "object" && "searchDeadline" in cfg) cfg.searchDeadline = 60000;
  } catch { /* hook revision without the knob */ }

  const scenarios = makeScenarios({ win: window, doc, hook });
  for (const id of SCENARIO_IDS) {
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
 * unhandledRejection, not a jsdom window event. */
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
