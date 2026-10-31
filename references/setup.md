# Setup

Each channel is optional; the script skips whatever is not set up and says so.

## IndexNow (Bing, Yandex, Seznam, Naver)

1. Make a key: 8 to 128 letters, digits or dashes. `node -e "console.log(crypto.randomUUID().replaceAll('-',''))"` is fine.
2. Serve it from the site root as `/<key>.txt`, containing only the key. In a static site, add the file to the folder that deploys; check the build copies it (some builds copy an explicit file list).
3. Deploy, then check: `curl https://example.com/<key>.txt` prints the key.
4. Pass the key as `INDEXNOW_KEY`. It is not a secret: anyone can read the file. It only proves you control the site.

**On Cloudflare:** Caching → Configuration → Crawler Hints sends IndexNow pings for pages Cloudflare sees change. If it is on, this channel overlaps with it. Keep both, or skip the key and rely on Crawler Hints; the report then shows IndexNow as skipped.

Bing Webmaster Tools reads IndexNow submissions, so there is no separate Bing step. Verify the site there once (import from Search Console) to see what Bing indexed.

## Google Search Console

The property must already be verified (Search Console → Add property → Domain, verified by a DNS TXT record).

The script needs an OAuth access token with the `https://www.googleapis.com/auth/webmasters` scope, as `GOOGLE_ACCESS_TOKEN`.

**On your own machine** (with the Google Cloud CLI):

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/cloud-platform
export GOOGLE_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
```

**In CI** (a service account):

1. Google Cloud console → a project → enable the **Google Search Console API**.
2. Create a service account and a JSON key. Store the key as a CI secret; never commit it.
3. Search Console → Settings → Users and permissions → Add user → the service account's email, permission **Full** (submitting a sitemap needs Full; inspection alone works with Restricted).
4. In the job, exchange the key for a token (for GitHub Actions, `google-github-actions/auth` with `token_format: access_token` and the webmasters scope) and pass it as `GOOGLE_ACCESS_TOKEN`.

The property name is `sc-domain:example.com` for a Domain property, or the exact URL prefix (`https://www.example.com/`) for a URL-prefix property.

Limits: URL Inspection allows 2,000 calls a day and 600 a minute per property; the script inspects 10 by default.

## What stays manual

- **Google's Request indexing button.** About 10 a day, per property. Google's Indexing API is only for job posting and livestream pages; do not use it for other pages.
- **Brave.** https://search.brave.com/submit-url, a form with no API. The homepage and one or two hub pages are enough; Brave's crawler follows links.

The report lists the pages for both, already filtered and ordered.

## Run it after every deploy (GitHub Actions)

```yaml
  index:
    needs: deploy                      # after the site is live
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { repository: arm-pz/get-indexed, path: get-indexed }
      - uses: actions/cache@v4         # keeps what IndexNow already has between runs
        with: { path: .get-indexed.json, key: get-indexed-${{ github.run_id }}, restore-keys: get-indexed- }
      - uses: google-github-actions/auth@v2
        id: gauth
        with:
          credentials_json: ${{ secrets.GSC_SERVICE_ACCOUNT }}
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/webmasters
      - run: >
          node get-indexed/scripts/get-indexed.mjs --submit
          --sitemap https://example.com/sitemap.xml
          --google-site sc-domain:example.com
          --out "$GITHUB_STEP_SUMMARY"
        env:
          INDEXNOW_KEY: ${{ vars.INDEXNOW_KEY }}
          GOOGLE_ACCESS_TOKEN: ${{ steps.gauth.outputs.access_token }}
```

Check the action versions and inputs against their current docs before relying on this.
