# Live job-API capability report

Measured from this machine on **2026-11-02 02:30 → 02:50 IST** with
`curl`, requests to the same host spaced ~1 s apart. Every claim below is backed by the
command that produced it; the captured bodies used by the smoke suite live in
[`tests/fixtures-jobs/`](../tests/fixtures-jobs/) and can be regenerated with
`bash tests/capture-jobs-fixtures.sh`.

Scope: what `jobs-custom-lists.html` can do from a `file://` page (null origin, no key,
no backend) — and which endpoints are safe to call in a loop.

---

## 0. TL;DR — decision table

| Provider | Text search | Slice/browse | Logo | Description | Pay | Geo | CORS `*` on GET | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Remotive** `remotive.com/api/remote-jobs` | ✓ `search=` | ✓ `category=` | ✓ `company_logo` | ✓ `description` (HTML) | ✓ `salary` **string only** | ✓ `candidate_required_location` | ✓ | **Primary source.** Only provider with a real text search; carries pay as text. |
| **Jobicy** `jobicy.com/api/v2/remote-jobs` | ✗ none | ✓ `industry=`, `geo=` | ✓ `companyLogo` | ✓ `jobExcerpt` | ✓ numeric `salaryMin/Max/Currency` on ~40% of rows | ✓ `jobGeo` | ✓ | **Secondary.** Industry/geo slices only — its `industry` filter is picky (below). |
| **Arbeitnow** `arbeitnow.com/api/job-board-api` | ✗ (dump) | ✗ | ✗ **none** | ✓ `description` | ✗ none | ✓ `location`, `remote` flag | ✓ | **Discovery only.** ~2.4 MB/page of EU/on-site postings; filtered client-side. |
| **Jina reader** `r.jina.ai/<url>` | — | — | — | ✓ opening paragraphs | — | — | ✓ | **Extraction relay** for “paste a URL → card”. Other relays tried (allorigins, corsproxy.io) are down/401 today. |

Three things changed the app's design:

1. **Jobicy's `industry` filter only accepts its own slugs.** `industry=data-science`
   works; a label slug like `industry=software-engineering` returns
   **HTTP 400** `{"success":false,"error":"Invalid 'industry' value…"}`. The full
   vocabulary comes from `?get=industries` (22 entries) and is mirrored into the app
   as `JOBICY_INDUSTRY_SLUG`; an unmapped label must never be sent.
2. **Remotive is serving a collapsed Cloudflare cache right now.** `limit=1`,
   `?search=python`, `?search=designer` and `?category=software-development` all
   return the **same 12 postings** (identical `cf-cache-status: HIT` and
   `last-modified`), and `limit` itself is ignored. The smoke fixtures are real, but
   the suite cannot assert *server-side* search filtering against Remotive until the
   cache key stops collapsing — it asserts relevance ranking over the returned pool.
3. **Arbeitnow has no company logos and no light ping.** Every page is ~2.4 MB, so the
   app treats it as a discovery source (search + recommendation pool, filtered
   locally) and **never** as a metadata source: the back-fill only asks
   keyword-searchable providers, because a logo-less row would leave cards grey.

---

## 1. Remotive — `https://remotive.com/api/remote-jobs`

```bash
curl -s "https://remotive.com/api/remote-jobs?limit=1" | head -c 400
curl -s "https://remotive.com/api/remote-jobs?limit=20&search=python" | head -c 400
```

Envelope: `{"00-warning", "0-legal-notice", "job-count", "total-job-count", "jobs"}`.
Per-job keys: `id, url, title, company_name, company_logo, company_logo_url, category,
tags[], job_type, publication_date, candidate_required_location, salary, description`.

- `salary` is a **formatted string**, never numeric: `"$3.5k–$5k/month"`,
  `"$170k - $200k"`, `"$50-$75 /hour"`, `"$1000 per task"`. No `salaryMin/Max`.
- `tags` mix real skills with noise (`"Typescript "` with a trailing space, `"admin"`,
  `"web applications"`), so they are canonicalised before matching.
- `description` is HTML; stripped and truncated to 900 chars.
- **Cache quirk** (§0.2): the same 12 jobs answer every query today. Faithful, but
  not query-dependent.

## 2. Jobicy — `https://jobicy.com/api/v2/remote-jobs`

```bash
curl -s "https://jobicy.com/api/v2/remote-jobs?get=industries" | head -c 400   # the vocabulary
curl -s "https://jobicy.com/api/v2/remote-jobs?count=20&industry=engineering" | head -c 400
curl -s "https://jobicy.com/api/v2/remote-jobs?count=20&industry=software-engineering"  # → 400
```

Envelope: `{apiVersion, documentationUrl, friendlyNotice, jobCount, lastUpdate,
nextCursor, hasMore, appliedFilters, jobs, statusCode, success}`.
Per-job keys: `id, url, jobSlug, jobTitle, companyName, companyLogo, jobIndustry[],
jobType[], jobGeo, jobLevel, jobExcerpt, jobDescription, pubDate` plus **optional**
`salaryMin, salaryMax, salaryCurrency, salaryPeriod` (present on ~40% of rows; the four
salary fields always appear together, and the data-science slice has none at all).

Official industry vocabulary (`?get=industries`, label → slug):

| label | slug | | label | slug |
|---|---|---|---|---|
| Admin & Virtual Assistance | `admin-support` | | Marketing & Sales | `marketing` |
| Business Development | `business` | | Product & Operations | `management` |
| Content & Editorial | `copywriting` | | Project & Program Management | `project-management` |
| Creative & Design | `design-multimedia` | | QA & Testing | `qa-testing` |
| Customer Support & Success | `supporting` | | Sales | `seller` |
| Cybersecurity | `cybersecurity` | | SEO | `seo` |
| Data Science & Analytics | `data-science` | | Software Engineering | `engineering` |
| DevOps & Infrastructure | `admin` | | Technical Support | `technical-support` |
| Education & E-learning | `education` | | Web, UI & UX Design | `web-app-design` |
| Finance & Accounting | `accounting-finance` | | Healthcare & Medical | `healthcare` |
| HR & Recruiting | `hr` | | Legal & Compliance | `legal` |

`industry` is the only picky filter; `geo` accepts free-form regions (`geo=usa` works).
`tag=` is accepted but answered 0 rows for `python` — not relied upon.

## 3. Arbeitnow — `https://www.arbeitnow.com/api/job-board-api`

```bash
curl -s "https://www.arbeitnow.com/api/job-board-api?page=99999"   # 747 b  → the ping
curl -s "https://www.arbeitnow.com/api/job-board-api?page=2"       # ~2.4 MB → 300 postings
```

Envelope: `{data[], links, meta}`; `meta` carries the board's own terms and pagination
(`per_page`, `current_page`). Per-posting keys: `slug, company_name, title, description,
remote, url, tags[], job_types[], location, created_at` (unix seconds).

- **No `company_logo`** — Arbeitnow rows can never fill a card's artwork.
- `tags` are company slugs in practice (`["adjoe"]`), not skills, so they filter poorly;
  title/company matching is what the app uses for search over the board.
- `page=99999` (past the last page) is a cheap, honest liveness probe: ~750 bytes with
  `data: []`.
- 27 of the 300 captured postings are flagged `remote`; locations are free text
  (“Hamburg”, “Berlin”, “Remote”), bucketed client-side.

## 4. The extraction relay — “paste a URL → card”

Job boards almost never send CORS headers, so a pasted URL cannot usually be read
directly. The app walks a chain and takes the first readable answer:

```bash
curl -s "https://r.jina.ai/https://job-boards.greenhouse.io/gitlab/jobs/8629019002" | head -8
# Title: Director, Support (Bengaluru)
# URL Source: https://job-boards.greenhouse.io/…
# Markdown Content:
# GitLab is the intelligent orchestration platform for DevSecOps. …
```

| hop | URL shape | status 2026-11-02 | what the app takes from it |
|---|---|---|---|
| 1 direct | the URL itself | only works if the site sends CORS | JSON-LD `JobPosting` (title, `hiringOrganization.name`, `jobLocation`, `baseSalary`, `description`), else `og:title`/`og:description`/`<title>` |
| 2 reader | `https://r.jina.ai/<url>` | ✓ 200, ~12 KB | the `Title:` line plus the opening paragraphs; the company is the first word of paragraph one when it reads “X is building …” |
| 3 allorigins | `https://api.allorigins.win/raw?url=<enc>` | ✗ 520 today | — |
| 4 corsproxy | `https://corsproxy.io/?url=<enc>` | ✗ 401 today | — |

When every hop fails the card is **still created** from the URL alone (typed fields,
“Open posting →” link), which is what a LinkedIn/Indeed login wall looks like in
practice — `r.jina.ai` itself is redirected to a login interstitial by Indeed.

---

## 5. Row normalisation (what the app compares everywhere)

| app field | Remotive | Jobicy | Arbeitnow |
|---|---|---|---|
| `title` | `title` | `jobTitle` | `title` |
| `company` | `company_name` | `companyName` | `company_name` |
| `location` | `candidate_required_location` | `jobGeo` | `location` |
| `url` | `url` | `url` | `url` |
| `cover` | `company_logo` | `companyLogo` | — none — |
| `pay` | `salary` (string) | `salaryMin/Max/Currency` (numeric, optional) | — none — |
| `tags` | `tags[]` + `category` | `jobIndustry[]` + `jobType[]` | `tags[]` + `job_types[]` |
| `remote` | always true | always true | `remote` (bool) |
| `postedAt` | `publication_date` | `pubDate` | `created_at` (unix → ISO) |

**Pay strings are parsed, not trusted.** `parsePay` reads the numbers (`k` = thousand,
comma separators allowed) and annualises by detected period — hourly ×2080, monthly ×12,
yearly as-is — while `per task/per project` stays unannualised, because “$1000 per task”
is not comparable to a salary. Stats and the min-pay filter only ever compare
annualised numbers; the card shows the provider's original string.

**Regions bucket, they do not match.** Free-text locations map through an ordered rule
list (Worldwide → USA → Canada → UK → Germany → Netherlands → Europe → India → LatAm →
Asia → Oceania → Africa → Middle East → first words) so the Region filter chip stays
small.

**Skills canonicalise, then match case-insensitively.** A `SKILL_ALIAS` table maps the
spelling drift (`js`→JavaScript, `k8s`→Kubernetes, `AI/ML`…) and the taste profile
weights canonical skills; generic role vocabulary (engineer, senior, remote, …) is
excluded from the signal so “engineer” can never outrank “kubernetes”.

---

_This report is a snapshot: providers change, caches expire, ranking moves. Re-run the
commands above (and `npm run capture:jobs`) before trusting any line of it._
