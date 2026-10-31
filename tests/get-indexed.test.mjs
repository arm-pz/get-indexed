import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkIndexNowKey, diff, readSitemap, renderMarkdown, run } from "../scripts/get-indexed.mjs";

const SITE = "https://example.test";
const KEY = "a1b2c3d4e5f6a7b8";

// a fake network: sitemaps and the key file by URL, and a log of what was sent
function fakeNet(pages, { indexnowStatus = 200, inspect = {}, missing = [] } = {}) {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    // live checks: every page on the site is up unless listed as missing
    if (init.method === "HEAD") return new Response(null, { status: missing.includes(u) || !u.startsWith(SITE) ? 404 : 200 });
    if (init.method === "POST" && u === "https://indexnow.test/") {
      sent.push({ to: "indexnow", body: JSON.parse(init.body) });
      return new Response("", { status: indexnowStatus });
    }
    if (init.method === "PUT" && u.startsWith("https://google.test/")) {
      sent.push({ to: "google-sitemap", url: u, auth: init.headers.authorization });
      return new Response(null, { status: 204 });
    }
    if (init.method === "POST" && u === "https://inspect.test/") {
      const { inspectionUrl } = JSON.parse(init.body);
      const r = inspect[inspectionUrl] ?? { verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed" };
      return Response.json({ inspectionResult: { indexStatusResult: r } });
    }
    if (u in pages) return new Response(pages[u], { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, sent };
}

const urlset = (...entries) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
    .map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`)
    .join("")}</urlset>`;

const endpoints = { indexnow: "https://indexnow.test/", google: "https://google.test", inspect: "https://inspect.test/" };

async function tempState() {
  const dir = await mkdtemp(path.join(tmpdir(), "get-indexed-"));
  return { dir, file: path.join(dir, "nested", "state.json") };
}

test("reads a sitemap index, keeps only the sitemap's own host", async () => {
  const { fetchImpl } = fakeNet({
    [`${SITE}/sitemap.xml`]: `<sitemapindex><sitemap><loc>${SITE}/a.xml</loc></sitemap><sitemap><loc>https://other.test/x.xml</loc></sitemap></sitemapindex>`,
    [`${SITE}/a.xml`]: urlset([`${SITE}/`, "2026-10-25"], ["https://other.test/page", null], [`${SITE}/b/`, null]),
  });
  const { host, urls } = await readSitemap(`${SITE}/sitemap.xml`, { fetchImpl });
  assert.equal(host, "example.test");
  assert.deepEqual([...urls.keys()], [`${SITE}/`, `${SITE}/b/`]);
  assert.equal(urls.get(`${SITE}/`), "2026-10-25");
});

test("diff splits new, changed and unchanged by lastmod", () => {
  const urls = new Map([[`${SITE}/`, "2026-10-30"], [`${SITE}/a/`, "2026-10-01"], [`${SITE}/b/`, null]]);
  const state = { urls: { [`${SITE}/`]: "2026-10-25", [`${SITE}/a/`]: "2026-10-01" } };
  assert.deepEqual(diff(urls, state), { fresh: [`${SITE}/b/`], changed: [`${SITE}/`], unchanged: 1 });
  assert.equal(diff(urls, state, true).fresh.length, 3);
});

test("IndexNow key must be served by the site", async () => {
  const { fetchImpl } = fakeNet({ [`${SITE}/${KEY}.txt`]: `${KEY}\n` });
  assert.equal((await checkIndexNowKey("example.test", KEY, { fetchImpl })).ok, true);
  const missing = await checkIndexNowKey("example.test", "zzzzzzzzzzzz", { fetchImpl });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /HTTP 404/);
  assert.equal((await checkIndexNowKey("example.test", "bad key!", { fetchImpl })).ok, false);
});

test("plan mode sends nothing and writes no state", async () => {
  const { dir, file } = await tempState();
  const net = fakeNet({ [`${SITE}/sitemap.xml`]: urlset([`${SITE}/`, null]), [`${SITE}/${KEY}.txt`]: KEY });
  try {
    const report = await run({ sitemap: `${SITE}/sitemap.xml`, state: file, indexnowKey: KEY, inspect: 0 }, { fetchImpl: net.fetchImpl, endpoints });
    assert.deepEqual(net.sent, []);
    assert.match(report.channels[0].summary, /would send 1 URLs/);
    await assert.rejects(readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--submit sends new URLs to IndexNow once, then only what changed", async () => {
  const { dir, file } = await tempState();
  const pages = {
    [`${SITE}/sitemap.xml`]: urlset([`${SITE}/`, "2026-10-25"], [`${SITE}/a/`, "2026-10-25"]),
    [`${SITE}/${KEY}.txt`]: KEY,
  };
  try {
    const first = fakeNet(pages);
    await run({ sitemap: `${SITE}/sitemap.xml`, state: file, indexnowKey: KEY, submit: true, inspect: 0 }, { fetchImpl: first.fetchImpl, endpoints });
    assert.equal(first.sent.length, 1);
    assert.deepEqual(first.sent[0].body.urlList, [`${SITE}/`, `${SITE}/a/`]);
    assert.equal(first.sent[0].body.keyLocation, `${SITE}/${KEY}.txt`);

    pages[`${SITE}/sitemap.xml`] = urlset([`${SITE}/`, "2026-10-30"], [`${SITE}/a/`, "2026-10-25"], [`${SITE}/b/`, null]);
    const second = fakeNet(pages);
    const report = await run({ sitemap: `${SITE}/sitemap.xml`, state: file, indexnowKey: KEY, submit: true, inspect: 0 }, { fetchImpl: second.fetchImpl, endpoints });
    assert.deepEqual(second.sent[0].body.urlList.sort(), [`${SITE}/`, `${SITE}/b/`]);
    assert.equal(report.unchanged, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rejected IndexNow submission fails the run and keeps the URLs pending", async () => {
  const { dir, file } = await tempState();
  const net = fakeNet({ [`${SITE}/sitemap.xml`]: urlset([`${SITE}/`, null]), [`${SITE}/${KEY}.txt`]: KEY }, { indexnowStatus: 403 });
  try {
    const report = await run({ sitemap: `${SITE}/sitemap.xml`, state: file, indexnowKey: KEY, submit: true, inspect: 0 }, { fetchImpl: net.fetchImpl, endpoints });
    assert.equal(report.failed, true);
    assert.match(report.channels[0].summary, /HTTP 403/);
    await assert.rejects(readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Google-only run never marks URLs as sent", async () => {
  const { dir, file } = await tempState();
  const net = fakeNet({ [`${SITE}/sitemap.xml`]: urlset([`${SITE}/`, null]) });
  const saved = process.env.GOOGLE_ACCESS_TOKEN;
  try {
    const report = await run(
      { sitemap: `${SITE}/sitemap.xml`, state: file, googleSite: "sc-domain:example.test", googleToken: "tok", submit: true, inspect: 0 },
      { fetchImpl: net.fetchImpl, endpoints },
    );
    assert.equal(net.sent[0].to, "google-sitemap");
    assert.equal(net.sent[0].auth, "Bearer tok");
    assert.match(net.sent[0].url, /sc-domain%3Aexample\.test\/sitemaps\/https%3A%2F%2Fexample\.test%2Fsitemap\.xml$/);
    assert.equal(report.channels[1].summary, "resubmitted");
    await assert.rejects(readFile(file));
  } finally {
    process.env.GOOGLE_ACCESS_TOKEN = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hand-submit list skips pages Google already indexed, homepage first, then sitemap order", async () => {
  const { dir, file } = await tempState();
  const net = fakeNet(
    { [`${SITE}/sitemap.xml`]: urlset([`${SITE}/skills/`, null], [`${SITE}/`, null], [`${SITE}/zzz/`, null], [`${SITE}/aaa/`, null]) },
    { inspect: { [`${SITE}/`]: { verdict: "PASS", coverageState: "Submitted and indexed" } } },
  );
  try {
    const report = await run(
      { sitemap: `${SITE}/sitemap.xml`, state: file, googleSite: "sc-domain:example.test", googleToken: "tok", inspect: 10 },
      { fetchImpl: net.fetchImpl, endpoints },
    );
    assert.deepEqual(report.manual, [`${SITE}/skills/`, `${SITE}/zzz/`, `${SITE}/aaa/`]);
    assert.equal(report.inspection[0].url, `${SITE}/`);
    const md = renderMarkdown(report);
    assert.match(md, /Submitted and indexed/);
    assert.match(md, /search\.brave\.com\/submit-url/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pages that are not live are reported, not submitted, and stay pending", async () => {
  const { dir, file } = await tempState();
  const pages = { [`${SITE}/sitemap.xml`]: urlset([`${SITE}/`, null], [`${SITE}/soon/`, null]), [`${SITE}/${KEY}.txt`]: KEY };
  try {
    const first = fakeNet(pages, { missing: [`${SITE}/soon/`] });
    const report = await run({ sitemap: `${SITE}/sitemap.xml`, state: file, indexnowKey: KEY, submit: true, inspect: 0 }, { fetchImpl: first.fetchImpl, endpoints });
    assert.deepEqual(first.sent[0].body.urlList, [`${SITE}/`]);
    assert.deepEqual(report.dead, [{ url: `${SITE}/soon/`, status: 404 }]);
    assert.match(renderMarkdown(report), /Not live, not submitted[\s\S]*\/soon\/ \(404\)/);

    // once it goes live, the next run sends it
    const second = fakeNet(pages);
    await run({ sitemap: `${SITE}/sitemap.xml`, state: file, indexnowKey: KEY, submit: true, inspect: 0 }, { fetchImpl: second.fetchImpl, endpoints });
    assert.deepEqual(second.sent[0].body.urlList, [`${SITE}/soon/`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
