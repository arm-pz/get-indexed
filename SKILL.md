---
name: get-indexed
description: >-
  Tells search engines about a site's new and changed pages through every
  channel that has an API, and lists the few steps that still need a person.
  Sends live pages that are new since the last run to IndexNow (Bing, Yandex,
  Seznam, Naver), resubmits the sitemap to Google Search Console, reads Google's
  index status, and ends with a short hand-submit list for Google's Request
  indexing button and Brave's form, which have no API. Use when the user asks to "submit my
  URLs", "get my site indexed", "ping search engines", "automate URL submission",
  "set up IndexNow", "my pages are discovered but not indexed", or "why isn't
  Google or Brave showing my new pages", even if they never mention IndexNow or
  sitemaps. Not for pages that cannot be indexed because of noindex, robots,
  redirects or broken links (use seo-crawl), ranking or brand-search problems
  (use findable or seo-sweep), or writing page copy (use wordsmith).
argument-hint: "[sitemap URL]"
---

# Get Indexed

Search engines find pages through links and sitemaps; this skill makes sure they hear about new and changed pages the day they go live, through the channels that accept it, and is honest about the ones that do not.

| Engine | Automated? | Channel |
|---|---|---|
| Bing, Yandex, Seznam, Naver | Yes | IndexNow: one POST reaches all of them |
| Google | Sitemap: yes. Index status: yes, read-only | Search Console API |
| Google "Request indexing" | No API | The button in URL inspection, about 10 a day |
| Brave | No API | https://search.brave.com/submit-url (a form) |

## Ground rules

- **Only sites the user owns,** verified in Search Console where Google is involved.
- **Plan first.** The script only plans unless given `--submit`. Show the plan, then submit when the user agrees or has asked for it.
- **Never submit a page that is not live.** The script checks every pending URL answers 200 without a redirect and reports the rest; fix the page or the sitemap rather than forcing it.
- **Never automate a form or a button that has no API.** Google's Indexing API is only for job postings and livestream pages; using it for anything else breaks Google's terms. Brave has no API. Scripting either is out of scope; the skill hands those over as a short list.
- **Submitting is a request, not a guarantee.** Engines decide what to index. Do not promise dates or rankings.
- **Keep secrets out of the repo.** The IndexNow key is public by design (it is served from the site); Google tokens are not. Pass them through environment variables or CI secrets.

## Run

Requires Node.js 20+. No dependencies.

```bash
node scripts/get-indexed.mjs --sitemap https://example.com/sitemap.xml                 # plan
INDEXNOW_KEY=... GOOGLE_ACCESS_TOKEN=... \
  node scripts/get-indexed.mjs --sitemap https://example.com/sitemap.xml \
    --google-site sc-domain:example.com --submit                                       # send
```

| Option | Default | Use |
|---|---|---|
| `--sitemap <url>` | required | The site's sitemap or sitemap index |
| `--submit` | off | Actually send; without it, only plan |
| `--state <file>` | `.get-indexed.json` | What IndexNow already has, so later runs send only new and changed pages |
| `--all` | off | Ignore the state and treat every page as new |
| `--indexnow-key <key>` | env `INDEXNOW_KEY` | The key the site serves at `/<key>.txt` |
| `--google-site <prop>` | none | Search Console property, e.g. `sc-domain:example.com` |
| `--inspect <n>` | 10 | Read Google's index status for up to n pages (quota: 2,000 a day) |
| `--format json\|markdown` | markdown | JSON for CI or other skills |
| `--out <file>` | stdout | Write the report to a file |

Exit code 1 means a submission was rejected or the IndexNow key check failed; 2 means bad arguments or an unreadable sitemap.

First-time setup (key file, Google access, running it after every deploy) is in `references/setup.md`.

## Read the report

1. **Not live, not submitted**: sitemap entries that do not answer 200. These are bugs in the site or the sitemap; hand `seo-crawl` the site URL so it can trace them, or, if it is not installed, give the user the list of URLs and statuses to fix.
2. **Sent automatically**: each channel's result. `skipped` names what is missing.
3. **Google index status**: per page, from URL Inspection. `Discovered - currently not indexed` means Google knows the page and has not fetched it yet: normal for a new site, fixed by time and links. `Crawled - currently not indexed` means Google fetched it and chose not to index it: a content or duplication problem, worth handing to `seo-sweep`.
4. **For you**: up to 10 pages for Google's Request indexing (homepage first, then the sitemap's order, skipping pages Google already indexed) and the Brave form. Give the user these as a checklist.

## Run it on every deploy

The point of automating is that nobody has to remember. Once set up, run it as the last step of the site's deploy job with `--submit`, the state file kept between runs (cache or commit it), and the secrets from CI. `references/setup.md` has a GitHub Actions example.

## Hand-offs

- Pages failing the live check, broken links, noindex, canonicals: `seo-crawl`.
- Indexed but not ranking, or other sites winning the brand search: `findable`, then `seo-sweep`.
- A whole-site fix-and-prove pass: `seo-sweep`, which runs this skill as its last step.
