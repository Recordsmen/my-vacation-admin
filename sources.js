/*
 * Data sources — GA4 Data API and BigQuery (Crashlytics export), called straight
 * from the browser with the signed-in user's OAuth token.
 *
 * Every section loads on its own: one failing query (e.g. a custom dimension not
 * registered yet, or no Crashlytics table) turns only that card into an error.
 *
 * MODEL — the shape both the real loader and demo-data.json produce:
 *   topline      { activeUsers, newUsers, vacationsCreated, vacationsRevealed }
 *   funnel       [{ key, users }]                       (FUNNEL order)
 *   slots        { sealed: {morning,day,evening}, missed: {…} }
 *   sources      { camera, gallery }
 *   rejections   { <reason>: count }
 *   reminders    { <slot or kind>: opens }
 *   shareKind    { <kind>: count }      shareTarget { <target>: count }
 *   collages     { <style>: views }
 *   languages    { <app_language>: users }
 *   vacationTypes{ <type>: vacations }
 *   crashes      { android|ios: { versions:[{version, activeUsers, crashedUsers}],
 *                                 issues:[{id, title, subtitle, type, events, users, lastSeen}] } }
 */

const FUNNEL = [
  { key: "vacation_created", label: "Created a vacation" },
  { key: "photo_sealed", label: "Sealed ≥1 photo" },
  { key: "day_captured_shown", label: "Full day (3/3)" },
  { key: "vacation_finished", label: "Finished" },
  { key: "vacation_revealed", label: "Revealed" },
  { key: "share_completed", label: "Shared" },
];

const PLATFORM_VALUE = { android: "Android", ios: "iOS" };

// ── HTTP ──────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(token, url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error?.message || `HTTP ${res.status}`, res.status);
  return json;
}

// ── GA4 ───────────────────────────────────────────────────────────────────────

const GA_DATA = "https://analyticsdata.googleapis.com/v1beta";
const GA_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";

// Finds the GA4 property linked to the Firebase project.
async function findPropertyId(token, projectNumber) {
  const { accountSummaries = [] } = await api(token, `${GA_ADMIN}/accountSummaries?pageSize=200`);
  const props = accountSummaries.flatMap((a) => a.propertySummaries || []);
  for (const p of props) {
    const { firebaseLinks = [] } = await api(token, `${GA_ADMIN}/${p.property}/firebaseLinks`);
    if (firebaseLinks.some((l) => l.project === `projects/${projectNumber}`)) return p.property.split("/")[1];
  }
  throw new Error("No GA4 property is linked to the Firebase project yet (Firebase → Project settings → Integrations → Google Analytics).");
}

// Custom dimensions the property knows (customEvent:slot, customUser:qa, …).
async function loadMetadata(token, propertyId) {
  const meta = await api(token, `${GA_DATA}/properties/${propertyId}/metadata`);
  return new Set((meta.dimensions || []).map((d) => d.apiName));
}

function gaFilter(f, known, { eventNames, qa = !f.includeQa } = {}) {
  const ex = [];
  if (eventNames) ex.push({ filter: { fieldName: "eventName", inListFilter: { values: eventNames } } });
  if (f.platform !== "all") ex.push({ filter: { fieldName: "platform", stringFilter: { matchType: "EXACT", value: PLATFORM_VALUE[f.platform] } } });
  if (qa && known.has("customUser:qa")) ex.push({ notExpression: { filter: { fieldName: "customUser:qa", stringFilter: { matchType: "EXACT", value: "true" } } } });
  return ex.length ? { andGroup: { expressions: ex } } : undefined;
}

function requireDims(known, dims) {
  const missing = dims.filter((d) => d.includes(":") && !known.has(d));
  if (missing.length) {
    const names = missing.map((d) => d.split(":")[1]).join(", ");
    throw new Error(`Register GA4 custom dimension${missing.length > 1 ? "s" : ""}: ${names} (Admin → Custom definitions). See README.`);
  }
}

async function runReport(ctx, { dimensions = [], metrics, eventNames, qa }) {
  requireDims(ctx.known, dimensions);
  const res = await api(ctx.token, `${GA_DATA}/properties/${ctx.propertyId}:runReport`, {
    dateRanges: [{ startDate: ctx.f.start, endDate: ctx.f.end }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    dimensionFilter: gaFilter(ctx.f, ctx.known, { eventNames, qa }),
    limit: 1000,
  });
  return (res.rows || []).map((r) => ({
    d: (r.dimensionValues || []).map((v) => v.value),
    m: r.metricValues.map((v) => Number(v.value)),
  }));
}

// rows → { <dimension i>: sum of metric j }
function tally(rows, di = 0, mj = 0) {
  const out = {};
  for (const r of rows) {
    const k = r.d[di] || "(not set)";
    out[k] = (out[k] || 0) + r.m[mj];
  }
  return out;
}

const GA_SECTIONS = {
  async topline(ctx) {
    const [[users], events] = await Promise.all([
      runReport(ctx, { metrics: ["activeUsers", "newUsers"] }),
      runReport(ctx, { dimensions: ["eventName"], metrics: ["eventCount"], eventNames: ["vacation_created", "vacation_revealed"] }),
    ]);
    const ev = tally(events);
    return {
      activeUsers: users ? users.m[0] : 0,
      newUsers: users ? users.m[1] : 0,
      vacationsCreated: ev.vacation_created || 0,
      vacationsRevealed: ev.vacation_revealed || 0,
    };
  },

  // Users who fired each step's event in the range (an open funnel, not a sequence).
  async funnel(ctx) {
    const rows = await runReport(ctx, { dimensions: ["eventName"], metrics: ["totalUsers"], eventNames: FUNNEL.map((s) => s.key) });
    const users = tally(rows);
    return FUNNEL.map((s) => ({ key: s.key, users: users[s.key] || 0 }));
  },

  async slots(ctx) {
    const rows = await runReport(ctx, { dimensions: ["eventName", "customEvent:slot"], metrics: ["eventCount"], eventNames: ["photo_sealed", "slot_missed"] });
    const out = { sealed: {}, missed: {} };
    for (const r of rows) {
      const bucket = r.d[0] === "photo_sealed" ? out.sealed : out.missed;
      bucket[r.d[1]] = (bucket[r.d[1]] || 0) + r.m[0];
    }
    return out;
  },

  async sources(ctx) {
    return tally(await runReport(ctx, { dimensions: ["customEvent:source"], metrics: ["eventCount"], eventNames: ["photo_sealed"] }));
  },

  async rejections(ctx) {
    return tally(await runReport(ctx, { dimensions: ["customEvent:reason"], metrics: ["eventCount"], eventNames: ["photo_rejected"] }));
  },

  // reminder_opened carries either `slot` (slot reminders) or `kind` (the rest).
  async reminders(ctx) {
    const rows = await runReport(ctx, { dimensions: ["customEvent:slot", "customEvent:kind"], metrics: ["eventCount"], eventNames: ["reminder_opened"] });
    const out = {};
    for (const r of rows) {
      const k = r.d[0] !== "(not set)" ? r.d[0] : r.d[1];
      out[k] = (out[k] || 0) + r.m[0];
    }
    return out;
  },

  async share(ctx) {
    const rows = await runReport(ctx, { dimensions: ["customEvent:kind", "customEvent:target"], metrics: ["eventCount"], eventNames: ["share_completed"] });
    return { shareKind: tally(rows, 0), shareTarget: tally(rows, 1) };
  },

  async collages(ctx) {
    return tally(await runReport(ctx, { dimensions: ["customEvent:style"], metrics: ["eventCount"], eventNames: ["collage_viewed"] }));
  },

  async languages(ctx) {
    return tally(await runReport(ctx, { dimensions: ["customUser:app_language"], metrics: ["activeUsers"] }));
  },

  async vacationTypes(ctx) {
    return tally(await runReport(ctx, { dimensions: ["customEvent:type"], metrics: ["eventCount"], eventNames: ["vacation_created"] }));
  },
};

// ── BigQuery (Crashlytics) ───────────────────────────────────────────────────

async function bq(ctx, sql, params) {
  const res = await api(ctx.token, `https://bigquery.googleapis.com/bigquery/v2/projects/${ctx.cfg.gcpProject}/queries`, {
    query: sql,
    useLegacySql: false,
    parameterMode: "NAMED",
    queryParameters: Object.entries(params).map(([name, value]) => ({
      name, parameterType: { type: "DATE" }, parameterValue: { value },
    })),
    timeoutMs: 30000,
  });
  if (!res.jobComplete) throw new Error("BigQuery query did not finish in 30 s — press Refresh.");
  const fields = res.schema?.fields?.map((x) => x.name) || [];
  return (res.rows || []).map((r) => Object.fromEntries(r.f.map((c, i) => [fields[i], c.v])));
}

async function crashesFor(ctx, platform, gaUsersByVersion) {
  const table = `\`${ctx.cfg.gcpProject}.${ctx.cfg.crashlyticsDataset}.${ctx.cfg.crashlyticsTables[platform]}\``;
  const where = "DATE(event_timestamp) BETWEEN @start AND @end";
  const params = { start: ctx.dates.start, end: ctx.dates.end };
  let versions, issues;
  try {
    [versions, issues] = await Promise.all([
      bq(ctx, `SELECT application.display_version AS version, COUNT(DISTINCT installation_uuid) AS crashed
               FROM ${table} WHERE ${where} AND is_fatal GROUP BY version`, params),
      bq(ctx, `SELECT issue_id, ANY_VALUE(issue_title) AS title, ANY_VALUE(issue_subtitle) AS subtitle,
                      ANY_VALUE(error_type) AS type, COUNT(*) AS events,
                      COUNT(DISTINCT installation_uuid) AS users, MAX(event_timestamp) AS last_seen
               FROM ${table} WHERE ${where} GROUP BY issue_id ORDER BY events DESC LIMIT 10`, params),
    ]);
  } catch (e) {
    // No table = the export is on but nothing has crashed (or been exported) yet.
    if (e.status === 404) return { versions: [], issues: [], note: `No Crashlytics export table yet (${ctx.cfg.crashlyticsTables[platform]}). It appears after the first exported event.` };
    throw e;
  }
  const crashed = Object.fromEntries(versions.map((v) => [v.version, Number(v.crashed)]));
  const all = new Set([...Object.keys(gaUsersByVersion), ...Object.keys(crashed)]);
  return {
    versions: [...all].filter((v) => v !== "(not set)").map((version) => ({
      version, activeUsers: gaUsersByVersion[version] || 0, crashedUsers: crashed[version] || 0,
    })),
    issues: issues.map((i) => ({
      id: i.issue_id, title: i.title, subtitle: i.subtitle, type: i.type,
      events: Number(i.events), users: Number(i.users),
      lastSeen: new Date(Number(i.last_seen) * 1000).toISOString(),
    })),
  };
}

async function loadCrashes(ctx) {
  // Crashlytics can't tell QA devices apart, so the user base for crash-free %
  // includes QA devices too, whatever the toggle says.
  const rows = ctx.propertyId
    ? await runReport({ ...ctx, f: { ...ctx.f, platform: "all" } }, { dimensions: ["platform", "appVersion"], metrics: ["activeUsers"], qa: false })
    : [];
  const users = { android: {}, ios: {} };
  for (const r of rows) {
    const p = r.d[0] === "Android" ? "android" : r.d[0] === "iOS" ? "ios" : null;
    if (p) users[p][r.d[1]] = r.m[0];
  }
  const platforms = ctx.f.platform === "all" ? ["android", "ios"] : [ctx.f.platform];
  const out = {};
  await Promise.all(platforms.map(async (p) => { out[p] = await crashesFor(ctx, p, users[p]); }));
  return out;
}

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Loads every section. Returns { model, errors } where errors[section] is an
 * Error for sections that failed; the rest of the model is filled.
 * `filters` = { start, end, platform: all|android|ios, includeQa } with GA date
 * strings in start/end, and `dates` = the same range as YYYY-MM-DD for BigQuery.
 */
async function loadReal(token, cfg, filters, dates, onProgress) {
  const model = {}, errors = {};
  let propertyId = cfg.ga4PropertyId, known = new Set(), gaError = null;
  try {
    propertyId = propertyId || await findPropertyId(token, cfg.firebaseProjectNumber);
    known = await loadMetadata(token, propertyId);
  } catch (e) { gaError = e; propertyId = null; }

  const ctx = { token, cfg, f: filters, dates, propertyId, known };
  const jobs = Object.entries(GA_SECTIONS).map(([name, fn]) => async () => {
    try {
      if (gaError) throw gaError;
      const res = await fn(ctx);
      if (name === "share") Object.assign(model, res); else model[name] = res;
    } catch (e) {
      if (name === "share") { errors.shareKind = e; errors.shareTarget = e; } else errors[name] = e;
    }
    onProgress?.();
  });
  jobs.push(async () => {
    try { model.crashes = await loadCrashes(ctx); } catch (e) { errors.crashes = e; }
    onProgress?.();
  });

  // GA4 allows ~10 concurrent requests per property; stay well under it.
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await queue.shift()(); }));
  return { model, errors, propertyId };
}
