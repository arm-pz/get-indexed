#!/usr/bin/env node
// get-indexed: tell search engines about a site's new and changed URLs, through
// the channels that have an API (IndexNow; Google Search Console's sitemap and
// URL Inspection APIs), and list what still needs a person (Google's "Request
// indexing" button, Brave's submit form). Plans by default; --submit sends.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const USAGE = `Usage: get-indexed --sitemap <url> [options]

  --sitemap <url>          sitemap.xml (or a sitemap index) of a site you own
  --state <file>           remembers what was submitted (default .get-indexed.json)
  --all                    treat every URL as new, ignoring the state file
  --submit                 send the submissions (without it, only plan)
  --indexnow-key <key>     IndexNow key; also env INDEXNOW_KEY
  --google-site <prop>     Search Console property, e.g. sc-domain:example.com
  --inspect <n>            read Google's index status for up to n URLs (default 10)
  --out <file>             write the JSON report here (default: stdout)
  --format json|markdown   report format (default markdown)

Google calls need env GOOGLE_ACCESS_TOKEN with the webmasters scope, e.g.
  gcloud auth application-default print-access-token`;

const MANUAL_LIMIT = 10; // Google allows about 10 "Request indexing" clicks a day

export const ENDPOINTS = {
  indexnow: "https://api.indexnow.org/indexnow",
  google: "https://www.googleapis.com/webmasters/v3",
  inspect: "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
};

function fail(message) {
  process.stderr.write(`get-indexed: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { state: ".get-indexed.json", inspect: 10, format: "markdown" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg === "--sitemap") options.sitemap = value();
    else if (arg === "--state") options.state = value();
    else if (arg === "--all") options.all = true;
    else if (arg === "--submit") options.submit = true;
    else if (arg === "--indexnow-key") options.indexnowKey = value();
    else if (arg === "--google-site") options.googleSite = value();
    else if (arg === "--inspect") options.inspect = Number(value());
    else if (arg === "--out") options.out = value();
    else if (arg === "--format") options.format = value();
    else fail(`unknown option ${arg}\n\n${USAGE}`);
  }
  if (!options.sitemap) fail(`--sitemap is required\n\n${USAGE}`);
  if (!/^https?:\/\//.test(options.sitemap)) fail("--sitemap must be an http(s) URL");
  if (!["json", "markdown"].includes(options.format)) fail("--format must be json or markdown");
  if (!Number.isInteger(options.inspect) || options.inspect < 0) fail("--inspect must be a whole number");
  options.indexnowKey ??= process.env.INDEXNOW_KEY;
  options.googleToken = process.env.GOOGLE_ACCESS_TOKEN;
  return options;
}

/* ------------------------------------------------------------ sitemap */

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function blocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi"))].map((m) => m[1]);
}

function field(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(block);
  if (!m) return null;
  const raw = m[1].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
  return decode(raw) || null;
}

// Every URL in the sitemap (following a sitemap index), with its lastmod.
// Only URLs on the sitemap's own host count: IndexNow rejects mixed hosts.
export async function readSitemap(sitemapUrl, { fetchImpl = fetch, limit = 50 } = {}) {
  const host = new URL(sitemapUrl).host;
  const urls = new Map();
  const seen = new Set();
  const queue = [sitemapUrl];
  while (queue.length > 0) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    if (seen.size >= limit) throw new Error(`more than ${limit} sitemaps; stopping`);
    seen.add(url);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
    const xml = await res.text();
    if (/<sitemapindex\b/i.test(xml)) {
      for (const b of blocks(xml, "sitemap")) {
        const loc = field(b, "loc");
        if (loc && new URL(loc).host === host) queue.push(loc);
      }
    } else if (/<urlset\b/i.test(xml)) {
      for (const b of blocks(xml, "url")) {
        const loc = field(b, "loc");
        if (!loc || new URL(loc).host !== host) continue;
        urls.set(loc, field(b, "lastmod"));
      }
    } else throw new Error(`${url} is not a sitemap`);
  }
  return { host, urls };
}

// New: never submitted. Changed: lastmod differs from the one submitted.
export function diff(urls, state, all = false) {
  const previous = state?.urls ?? {};
  const fresh = [];
  const changed = [];
  for (const [url, lastmod] of urls) {
    if (all || !(url in previous)) fresh.push(url);
    else if ((previous[url] ?? null) !== (lastmod ?? null)) changed.push(url);
  }
  return { fresh, changed, unchanged: urls.size - fresh.length - changed.length };
}

/* ------------------------------------------------------------ channels */

// IndexNow only accepts a key the site itself serves, at /<key>.txt.
export async function checkIndexNowKey(host, key, { fetchImpl = fetch, origin = `https://${host}` } = {}) {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) return { ok: false, reason: "key must be 8-128 letters, digits or dashes" };
  const keyLocation = `${origin}/${key}.txt`;
  try {
    const res = await fetchImpl(keyLocation);
    const body = res.ok ? (await res.text()).trim() : "";
    if (body === key) return { ok: true, keyLocation };
    return { ok: false, keyLocation, reason: res.ok ? "key file does not contain the key" : `key file answered HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, keyLocation, reason: error.message };
  }
}

export async function submitIndexNow({ host, key, keyLocation, urls }, { fetchImpl = fetch, endpoint = ENDPOINTS.indexnow } = {}) {
  const results = [];
  for (let i = 0; i < urls.length; i += 10000) {
    const urlList = urls.slice(i, i + 10000);
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation, urlList }),
    });
    // 200 and 202 both mean accepted; anything else is reported as is
    results.push({ count: urlList.length, status: res.status, ok: res.status === 200 || res.status === 202 });
  }
  return results;
}

// A sitemap can list pages that are not live yet (or any more). Submitting
// those wastes crawl budget and teaches engines the sitemap lies, so each
// pending URL must answer 200 itself, without a redirect.
export async function checkLive(urls, { fetchImpl = fetch, limit = 500 } = {}) {
  const live = [];
  const dead = [];
  for (const url of urls.slice(0, limit)) {
    try {
      const res = await fetchImpl(url, { method: "HEAD", redirect: "manual" });
      (res.status === 200 ? live : dead).push(res.status === 200 ? url : { url, status: res.status });
    } catch (error) {
      dead.push({ url, status: error.message });
    }
  }
  return { live, dead, unchecked: urls.slice(limit) };
}

const enc = encodeURIComponent;

export async function submitGoogleSitemap({ site, sitemap, token }, { fetchImpl = fetch, endpoint = ENDPOINTS.google } = {}) {
  const res = await fetchImpl(`${endpoint}/sites/${enc(site)}/sitemaps/${enc(sitemap)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300, error: res.ok ? null : await res.text() };
}

export async function inspectGoogle({ site, urls, token }, { fetchImpl = fetch, endpoint = ENDPOINTS.inspect } = {}) {
  const out = [];
  for (const url of urls) {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: site }),
    });
    if (!res.ok) {
      out.push({ url, error: `HTTP ${res.status}` });
      continue;
    }
    const r = (await res.json()).inspectionResult?.indexStatusResult ?? {};
    out.push({ url, verdict: r.verdict ?? null, coverage: r.coverageState ?? null, lastCrawl: r.lastCrawlTime ?? null });
  }
  return out;
}

/* ------------------------------------------------------------ report */

export function renderMarkdown(report) {
  const lines = [`# get-indexed: ${report.host}`, "", `Mode: ${report.submitted ? "submitted" : "plan only (add --submit to send)"}`, ""];
  lines.push(`Sitemap: ${report.total} URLs · ${report.fresh.length} new · ${report.changed.length} changed · ${report.unchanged} unchanged`, "");
  if (report.dead.length) {
    lines.push("## Not live, not submitted", "", "In the sitemap but not answering 200 (fix the page or drop it from the sitemap):", "");
    for (const d of report.dead) lines.push(`- ${d.url} (${d.status})`);
    lines.push("");
  }
  lines.push("## Sent automatically", "");
  for (const c of report.channels) lines.push(`- **${c.name}**: ${c.summary}`);
  if (report.inspection.length) {
    lines.push("", "## Google index status", "", "| URL | Coverage | Last crawl |", "|---|---|---|");
    for (const r of report.inspection) lines.push(`| ${r.url} | ${r.error ?? r.coverage ?? "unknown"} | ${r.lastCrawl ?? "never"} |`);
  }
  lines.push("", "## For you (no API exists)", "");
  if (report.manual.length === 0) lines.push("Nothing new to hand-submit.");
  else {
    lines.push(`Google Search Console → URL inspection → Request indexing (about ${MANUAL_LIMIT} a day):`, "");
    for (const u of report.manual) lines.push(`- ${u}`);
    lines.push("", "Brave: https://search.brave.com/submit-url — the homepage and one or two section pages are enough; Brave follows links.");
  }
  return `${lines.join("\n")}\n`;
}

// pages to hand-submit first: the homepage, then the sitemap's own order
// (sites list their hub pages first; depth alone ties every flat page)
const priority = (order) => (a, b) =>
  (new URL(a).pathname === "/" ? 0 : 1) - (new URL(b).pathname === "/" ? 0 : 1) || order.get(a) - order.get(b);

// what IndexNow now has: earlier submissions still in the sitemap, plus this
// run's live URLs at their current lastmod (dead ones stay pending)
function sentState(urls, state, sent) {
  const out = {};
  for (const [url, lastmod] of Object.entries(state?.urls ?? {})) if (urls.has(url)) out[url] = lastmod;
  for (const url of sent) out[url] = urls.get(url) ?? null;
  return out;
}

export async function run(options, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoints = { ...ENDPOINTS, ...deps.endpoints };
  const { host, urls } = await readSitemap(options.sitemap, { fetchImpl });
  let state = null;
  if (!options.all) {
    try {
      state = JSON.parse(await readFile(options.state, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`could not read ${options.state}: ${error.message}`);
    }
  }
  const { fresh, changed, unchanged } = diff(urls, state, options.all);
  const { live: pending, dead, unchecked } = await checkLive([...fresh, ...changed], { fetchImpl });
  if (unchecked.length) throw new Error(`${unchecked.length} URLs over the 500-URL live check; split the sitemap or run again after this batch`);
  const channels = [];
  let anyFailed = false;

  // IndexNow: Bing, Yandex, Seznam, Naver and the others that share it
  if (!options.indexnowKey) channels.push({ name: "IndexNow", ok: null, summary: "skipped: no key (see references/setup.md)" });
  else if (pending.length === 0) channels.push({ name: "IndexNow", ok: true, summary: "nothing new or changed" });
  else {
    const check = await checkIndexNowKey(host, options.indexnowKey, { fetchImpl, origin: deps.origin });
    if (!check.ok) {
      anyFailed = true;
      channels.push({ name: "IndexNow", ok: false, summary: `not sent: ${check.reason} (${check.keyLocation ?? "no key location"})` });
    } else if (!options.submit) channels.push({ name: "IndexNow", ok: null, summary: `would send ${pending.length} URLs` });
    else {
      const results = await submitIndexNow({ host, key: options.indexnowKey, keyLocation: check.keyLocation, urls: pending }, { fetchImpl, endpoint: endpoints.indexnow });
      const ok = results.every((r) => r.ok);
      anyFailed ||= !ok;
      channels.push({ name: "IndexNow", ok, summary: results.map((r) => `${r.count} URLs → HTTP ${r.status}`).join(", ") });
    }
  }

  // Google: resubmitting the sitemap is the API's way to say "look again"
  const google = options.googleSite && options.googleToken;
  if (!google) channels.push({ name: "Google sitemap", ok: null, summary: "skipped: needs --google-site and GOOGLE_ACCESS_TOKEN" });
  else if (!options.submit) channels.push({ name: "Google sitemap", ok: null, summary: `would resubmit ${options.sitemap}` });
  else {
    const r = await submitGoogleSitemap({ site: options.googleSite, sitemap: options.sitemap, token: options.googleToken }, { fetchImpl, endpoint: endpoints.google });
    anyFailed ||= !r.ok;
    channels.push({ name: "Google sitemap", ok: r.ok, summary: r.ok ? "resubmitted" : `HTTP ${r.status}: ${r.error?.slice(0, 200)}` });
  }

  // read-only, so it runs in plan mode too
  const order = new Map([...urls.keys()].map((u, i) => [u, i]));
  const toInspect = [...(pending.length ? pending : [...urls.keys()])].sort(priority(order)).slice(0, options.inspect);
  const inspection = google && toInspect.length ? await inspectGoogle({ site: options.googleSite, urls: toInspect, token: options.googleToken }, { fetchImpl, endpoint: endpoints.inspect }) : [];

  // hand-submit only what Google has not indexed (or what we could not check)
  const indexed = new Set(inspection.filter((r) => r.verdict === "PASS").map((r) => r.url));
  const manual = pending.filter((u) => !indexed.has(u)).sort(priority(order)).slice(0, MANUAL_LIMIT);

  const report = {
    host,
    sitemap: options.sitemap,
    submitted: Boolean(options.submit),
    total: urls.size,
    fresh,
    changed,
    unchanged,
    dead,
    channels,
    inspection,
    manual,
    failed: anyFailed,
  };

  // the state records what IndexNow accepted (the one channel that takes URL
  // lists), so a run without a key never marks URLs as sent
  const indexNowAccepted = channels.some((c) => c.name === "IndexNow" && c.ok === true);
  if (options.submit && !anyFailed && indexNowAccepted) {
    await mkdir(dirname(options.state), { recursive: true });
    await writeFile(options.state, `${JSON.stringify({ sitemap: options.sitemap, updated: new Date().toISOString(), urls: sentState(urls, state, pending) }, null, 2)}\n`);
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  let report;
  try {
    report = await run(options);
  } catch (error) {
    fail(error.message);
  }
  const text = options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, text);
  } else process.stdout.write(text);
  process.exit(report.failed ? 1 : 0);
}
