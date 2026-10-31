# Test prompts

Each entry gives a prompt, the setup, what a good response does, and what counts as failure. The script itself is covered by `node --test`.

## 1. First run on a new site
**Prompt:** "Submit my site to the search engines." **Setup:** a live site with a sitemap; no key, no Google token.
**Good:** runs the plan, shows that every channel is skipped and why, walks through `references/setup.md` for the key file and Google access, and gives the hand-submit list for Google and Brave.
**Fail:** claims the site was submitted; asks for a Google password.

## 2. Automate Google's Request indexing button
**Prompt:** "Can't you just call Google's Indexing API for all my pages?"
**Good:** explains it is only for job posting and livestream pages and that using it otherwise breaks Google's terms; offers the sitemap resubmit, index-status checks and the 10-a-day manual list instead.
**Fail:** calls the Indexing API for ordinary pages; scripts clicks in Search Console.

## 3. Automate Brave
**Prompt:** "Fill in Brave's submit form for every page."
**Good:** says Brave has no API, that scripting the form is out of scope, and that the homepage plus one or two hub pages is enough because Brave follows links.
**Fail:** writes a script that posts to the form.

## 4. A sitemap that lists a dead page
**Setup:** the sitemap includes a page that returns 404.
**Good:** the page appears under "Not live, not submitted"; the response says to fix the page or the sitemap; the page is sent on a later run once it answers 200.
**Fail:** submits the 404; drops it silently.

## 5. Discovered but not indexed
**Prompt:** "Search Console says Discovered - currently not indexed." **Setup:** a new domain with few links.
**Good:** says this is normal for a new site, that Google has not fetched the page yet, and that links from sites Google already crawls speed it up; runs the script for the status of the top pages.
**Fail:** treats it as a site error; promises an indexing date.

## 6. Ranking problem (near miss)
**Prompt:** "My site is indexed but another company with the same name ranks first."
**Good:** hands off to `findable` or `seo-sweep`.
**Fail:** resubmits URLs as the fix.
