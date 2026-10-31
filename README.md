# get-indexed

**An agent skill that submits a site's new and changed pages to every search engine with an API, and tells you exactly what's left to do by hand.**

It reads your sitemap and drops any page that isn't live. Pages that are new or changed since the last run go to IndexNow, which covers Bing, Yandex, Seznam and Naver. It also resubmits your sitemap to Google Search Console and reads Google's index status for your top pages. It ends with a short checklist for the two steps no API covers: Google's "Request indexing" button and Brave's submit form.

Works in Claude Code, Codex, Cursor and any agent that loads a SKILL.md. The script is plain Node.js 20, with no dependencies.

## Install

```bash
npx skills add arm-pz/get-indexed
```

## Use

```text
Submit skillsmith.tech's new pages to the search engines.
Set up IndexNow for my site and run it after every deploy.
Search Console says "Discovered - currently not indexed". What now?
```

Or run the script directly:

```bash
node scripts/get-indexed.mjs --sitemap https://example.com/sitemap.xml            # plan only
node scripts/get-indexed.mjs --sitemap https://example.com/sitemap.xml --submit   # send
```

Setup for the IndexNow key file, Google access and running it in CI is in [references/setup.md](references/setup.md).

## What it does not do

- Call Google's Indexing API for ordinary pages. That API is only for job postings and livestream pages.
- Script Brave's submit form or Search Console's buttons.
- Promise indexing or rankings. Submitting a page is a request; each engine decides what to index.

Related: [seo-crawl](https://github.com/arm-pz/seo-crawl) finds why a page can't be indexed, and [seo-sweep](https://github.com/arm-pz/seo-sweep) runs the whole fix-and-prove workflow.

## License

MIT
