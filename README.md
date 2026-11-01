# My Vacation — Admin dashboard

A zero-build static page with product analytics (GA4 / Firebase Analytics) and
crash health (Crashlytics → BigQuery). No server of our own: the page signs you
in with Google in the browser and calls Google's APIs with **your** token. It
holds no keys, so it can live in a public repo.

- **Live:** https://recordsmen.github.io/my-vacation-admin/
- **Source of truth:** this folder. The public repo `Recordsmen/my-vacation-admin`
  is only a published copy (see [Publish](#publish)).

## Files

| File | What it does |
|------|--------------|
| `index.html` | Layout: top bar, filters, card host |
| `config.js` | OAuth client ID, GA4 property, BigQuery tables, console links. Public values only |
| `sources.js` | GA4 Data API + BigQuery queries → one `MODEL` object (shape documented at the top) |
| `app.js` | Filters, Google sign-in, demo mode, rendering of every card |
| `demo-data.json` | Fake numbers for the **Demo data** switch (30 days per platform; scaled to the range) |
| `styles.css` | Golden Hour look: paper / ink / sun, Bricolage Grotesque + Inter |

## Run locally

Google sign-in and `fetch("demo-data.json")` need http, not `file://`:

```bash
python3 -m http.server 8791 --directory admin
```

Open http://localhost:8791. Demo data works at once. Real sign-in from localhost
needs `http://localhost:8791` in the OAuth client's authorized JavaScript origins.

## Setup (already done once for `my-vacation-olik`)

1. **APIs** in Cloud project `my-vacation-olik`: Google Analytics Data API,
   Google Analytics Admin API, BigQuery API.
2. **Google Auth Platform** (Cloud console → Google Auth Platform): app
   "My Vacation Admin", audience External, publishing status **Testing**, test
   users = the two owner Google accounts. Only test users can sign in.
   Testing mode shows an "unverified app" screen; that's expected.
3. **OAuth client**: type *Web application*, authorized JavaScript origin
   `https://recordsmen.github.io` (+ `http://localhost:8791` for local runs). Its
   client ID goes into `config.js` → `clientId`. No client secret is used.
4. **Google Analytics** linked to the Firebase project. `ga4PropertyId` in
   `config.js` can stay empty: at sign-in the page asks the Analytics Admin API for
   the property whose Firebase link is project `318644605011`.
5. **GA4 custom dimensions** (GA4 → Admin → Data display → Custom definitions).
   Without them the Data API can't group by event parameters, and the affected card
   says which one is missing.

   | Scope | Dimension = parameter / user property |
   |-------|---------------------------------------|
   | Event | `slot`, `source`, `reason`, `kind`, `target`, `style`, `type` |
   | User  | `app_language`, `qa` |

   Optional (not used by cards yet): `planned_days`, `reminders_on`, `day_index`,
   `early`, `days`, `photos`, `skipped_animation`, `action`; user `vacations_total`.
6. **Crashlytics → BigQuery**: Firebase console → Project settings → Integrations →
   BigQuery → Crashlytics on (daily batch export, free sandbox). Tables
   `firebase_crashlytics.com_olikbobik_myvacation_ANDROID` / `_IOS` appear after the
   first exported event; until then the Crashes card says so. In the sandbox
   (no billing) tables keep 60 days of partitions.

### Scopes

| Scope | Why |
|-------|-----|
| `email` | Show who is signed in |
| `analytics.readonly` | GA4 Data API reports + Admin API property lookup |
| `bigquery.readonly` | Run read-only queries on the Crashlytics export |

The token lives in this tab's `sessionStorage` for up to an hour; **Sign out**
revokes it. Your Google account still needs access to the GA4 property and
BigQuery dataset (the project owner has both).

## Filters and definitions

- **Range:** today, 7 d, 30 d (both including today) or custom. Dates are the
  GA4 property's time zone; BigQuery uses UTC partition dates.
- **Platform:** GA4 `platform` = Android / iOS; crashes show one table per platform.
- **QA devices:** users with user property `qa=true` are excluded unless
  *Include QA devices* is on. Crashlytics can't see that property, so crash-free %
  uses all users.
- **Funnel:** users who fired each step's event in the range (open funnel, not a
  strict sequence): `vacation_created` → `photo_sealed` → `day_captured_shown`
  (a full 3/3 day) → `vacation_finished` → `vacation_revealed` → `share_completed`.
- **Crash-free users** per version = 1 − (Crashlytics users with a fatal event ÷
  GA4 active users on that `appVersion`).
- **Store numbers:** not connected. App Store Connect Analytics needs a JWT from
  a `.p8` key and Play's Reporting API needs a service account; neither can sit in
  a public page.

## Add a metric

1. Make sure the app logs it (event + parameters). Register any parameter you
   want to group by as a GA4 custom dimension (step 5 above); new dimensions only
   fill from the day they're registered.
2. In `sources.js`, add a loader to `GA_SECTIONS`, e.g.

   ```js
   async albumOpens(ctx) {
     return tally(await runReport(ctx, { dimensions: ["platform"], metrics: ["eventCount"], eventNames: ["album_photo_opened"] }));
   },
   ```

   `runReport` adds the date range, platform and QA filters for you and fails
   with a readable message if a custom dimension isn't registered.
3. In `app.js` → `render()`, add a card:
   `card("Album photos opened", m.albumOpens ? barList(m.albumOpens) : "", { key: "albumOpens", errors, empty: isEmpty(m.albumOpens) })`.
4. Add the same key with fake numbers to both `android` and `ios` in
   `demo-data.json`, check it with the switch on, then publish.

For a crash metric, add a query in `crashesFor()` (standard SQL against the
Crashlytics export schema).

## Publish

GitHub Pages on a private repo isn't free, so the page is published from the
public repo `Recordsmen/my-vacation-admin` (Pages: branch `main`, root). It holds
only the files of this folder. After a change here is merged:

```bash
admin/publish.sh
```

The script copies this folder into a fresh clone of the Pages repo, commits as
Recordsmen and pushes. Pages updates in about a minute.
