/*
 * My Vacation — Admin dashboard (vanilla JS, zero build step).
 *
 * Product analytics (GA4 / Firebase Analytics) and crash health (Crashlytics →
 * BigQuery) for the app, read with the signed-in user's own Google token
 * (Google Identity Services token flow). No server, no keys in the page.
 *
 * Data loading lives in sources.js (loadReal → MODEL); this file owns filters,
 * sign-in, demo data and rendering. Demo mode fills the same MODEL from
 * demo-data.json so every card can be judged before real users exist.
 */

const cfg = window.MV_CONFIG;
const $ = (sel) => document.querySelector(sel);
const PREFS_KEY = "mv.admin.prefs.v1";
const TOKEN_KEY = "mv.admin.token.v1";

// ── State ─────────────────────────────────────────────────────────────────────

const prefs = Object.assign(
  { range: "7d", start: "", end: "", platform: "all", includeQa: false, demo: true },
  readJson(localStorage, PREFS_KEY),
);
let auth = readJson(sessionStorage, TOKEN_KEY); // { token, exp, email } | null
if (auth && auth.exp < Date.now() + 60_000) auth = null;
let tokenClient = null;
let demoData = null;
let loadSeq = 0;

function readJson(storage, key) {
  try { return JSON.parse(storage.getItem(key)) || null; } catch { return null; }
}
function writeJson(storage, key, value) {
  try { value == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
const savePrefs = () => writeJson(localStorage, PREFS_KEY, prefs);

// ── Dates ─────────────────────────────────────────────────────────────────────

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };

// → { start, end } as YYYY-MM-DD plus the number of days.
function currentRange() {
  let start, end = iso(new Date());
  if (prefs.range === "today") start = end;
  else if (prefs.range === "30d") start = iso(daysAgo(29));
  else if (prefs.range === "custom" && prefs.start && prefs.end) {
    [start, end] = prefs.start <= prefs.end ? [prefs.start, prefs.end] : [prefs.end, prefs.start];
  } else start = iso(daysAgo(6));
  const days = Math.round((new Date(end) - new Date(start)) / 86_400_000) + 1;
  return { start, end, days };
}

// ── Formatting ────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n) => (n >= 10_000 ? compact.format(n) : nf.format(Math.round(n)));
const pct = (a, b, digits = 0) => (b ? `${((a / b) * 100).toFixed(digits)}%` : "—");
const langNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "language" }); } catch { return null; } })();

function human(key) {
  if (key === "(not set)") return "(not set)";
  const s = String(key).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function language(code) {
  try { return langNames?.of(code) || code; } catch { return code; }
}
// share_completed.target is a package id / iOS activity type, or "system".
const TARGETS = {
  "com.instagram.android": "Instagram", "com.burbn.instagram.shareextension": "Instagram",
  "com.whatsapp": "WhatsApp", "net.whatsapp.WhatsApp.ShareExtension": "WhatsApp",
  "org.telegram.messenger": "Telegram", "ph.telegra.Telegraph.Share": "Telegram",
  "com.google.android.apps.photos": "Google Photos",
  "com.apple.UIKit.activity.Message": "Messages", "com.apple.UIKit.activity.SaveToCameraRoll": "Save to Photos",
  "com.apple.UIKit.activity.AirDrop": "AirDrop", system: "System sheet",
};
const target = (id) => TARGETS[id] || id;
function relDate(isoStr) {
  const d = new Date(isoStr), days = Math.floor((Date.now() - d) / 86_400_000);
  const when = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} d ago`;
  return `<span title="${esc(d.toLocaleString())}">${when}</span>`;
}

// ── Demo data ────────────────────────────────────────────────────────────────

// Sums numeric leaves of two same-shaped models (maps union their keys).
function addModels(a, b) {
  if (typeof a === "number" || typeof b === "number") return (a || 0) + (b || 0);
  if (Array.isArray(a)) return a.map((x, i) => (x.key ? { key: x.key, users: x.users + (b[i]?.users || 0) } : x));
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[k] = addModels(a?.[k], b?.[k]);
  return out;
}
function scaleModel(m, f) {
  if (typeof m === "number") return Math.round(m * f);
  if (Array.isArray(m)) return m.map((x) => ({ ...x, users: Math.round(x.users * f) }));
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, scaleModel(v, f)]));
}

async function loadDemo(range) {
  demoData ||= await (await fetch("demo-data.json")).json();
  const base = prefs.platform === "all" ? addModels(demoData.android, demoData.ios) : demoData[prefs.platform];
  const model = scaleModel(base, range.days / demoData.days);
  const platforms = prefs.platform === "all" ? ["android", "ios"] : [prefs.platform];
  model.crashes = Object.fromEntries(platforms.map((p) => [p, demoData.crashes[p]]));
  return { model, errors: {} };
}

// ── Sign-in (Google Identity Services, token flow) ───────────────────────────

function initAuth() {
  if (!cfg.clientId) {
    $("#btn-signin").disabled = true;
    $("#btn-signin").title = "Set clientId in config.js first";
    return;
  }
  const ready = () => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: cfg.scopes.join(" "),
      callback: onToken,
      error_callback: (e) => toast(e.message || "Sign-in was cancelled"),
    });
  };
  if (window.google?.accounts?.oauth2) ready();
  else {
    const t = setInterval(() => { if (window.google?.accounts?.oauth2) { clearInterval(t); ready(); } }, 100);
  }
}

function signIn() {
  if (!tokenClient) return toast("Google sign-in is still loading — try again in a second.");
  tokenClient.requestAccessToken({ prompt: "" });
}

async function onToken(resp) {
  if (resp.error) return toast(`Sign-in failed: ${resp.error}`);
  const missing = cfg.scopes.filter((s) => s.startsWith("https://") && !google.accounts.oauth2.hasGrantedAllScopes(resp, s));
  if (missing.length) toast(`Not granted: ${missing.map((s) => s.split("/").pop()).join(", ")} — some cards will fail.`);
  auth = { token: resp.access_token, exp: Date.now() + Number(resp.expires_in) * 1000, email: "" };
  try {
    const me = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${auth.token}` } })).json();
    auth.email = me.email || "";
  } catch { /* email is cosmetic */ }
  writeJson(sessionStorage, TOKEN_KEY, auth);
  if (prefs.demo) { prefs.demo = false; savePrefs(); }
  syncControls();
  load();
}

function signOut() {
  if (auth?.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(auth.token, () => {});
  auth = null;
  writeJson(sessionStorage, TOKEN_KEY, null);
  syncControls();
  load();
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load() {
  const seq = ++loadSeq;
  const range = currentRange();
  $("#range-label").textContent = range.start === range.end ? range.start : `${range.start} → ${range.end}`;
  $("#signin-hint").hidden = prefs.demo || !!auth;
  if (!prefs.demo && !auth) { $("#cards")?.remove(); return; }

  document.body.classList.add("loading");
  let result;
  try {
    if (prefs.demo) result = await loadDemo(range);
    else {
      const filters = { start: range.start, end: range.end, platform: prefs.platform, includeQa: prefs.includeQa };
      result = await loadReal(auth.token, cfg, filters, range);
      if (Object.values(result.errors).some((e) => e.status === 401)) {
        toast("Your Google session expired — sign in again.");
        auth = null;
        writeJson(sessionStorage, TOKEN_KEY, null);
        syncControls();
      }
    }
  } catch (e) {
    result = { model: {}, errors: { _all: e } };
  }
  if (seq !== loadSeq) return; // a newer load started meanwhile
  document.body.classList.remove("loading");
  render(result.model, result.errors, range);
}

// ── Rendering helpers ────────────────────────────────────────────────────────

function card(title, body, { span = 4, sub = "", key = "", errors = {}, empty = false, data = true } = {}) {
  const err = errors[key] || errors._all;
  let content = body;
  if (err) content = `<div class="card-error"><strong>Couldn’t load.</strong> ${esc(err.message)}</div>`;
  else if (empty) content = `<div class="card-empty">No data in this range yet.</div>`;
  return `<section class="card span-${span}">
    <header class="card-head"><h2>${esc(title)}</h2>${prefs.demo && data ? '<span class="demo-pill">demo</span>' : ""}</header>
    ${sub ? `<p class="card-sub">${sub}</p>` : ""}
    ${content}
  </section>`;
}

const isEmpty = (obj) => !obj || Object.values(obj).every((v) => !v);

// Horizontal bar list, one series. `order` fixes row order (else by value).
function barList(obj, { order, label = human, total } = {}) {
  const entries = order ? order.map((k) => [k, obj[k] || 0]) : Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const sum = total ?? entries.reduce((s, e) => s + e[1], 0);
  return `<div class="bars">${entries.map(([k, v]) => `
    <div class="bar-row" title="${esc(label(k))}: ${nf.format(v)} (${pct(v, sum, 1)})">
      <span class="bar-label">${esc(label(k))}</span>
      <span class="bar-track"><span class="bar" style="width:${(v / max) * 100}%"></span></span>
      <span class="bar-value">${fmt(v)} <small>${pct(v, sum)}</small></span>
    </div>`).join("")}</div>`;
}

function legend(items) {
  return `<div class="legend">${items.map(([cls, name]) => `<span><i class="sw ${cls}"></i>${esc(name)}</span>`).join("")}</div>`;
}

// ── Cards ────────────────────────────────────────────────────────────────────

function toplineHtml(t) {
  const tiles = [
    ["Active users", t.activeUsers],
    ["New users", t.newUsers],
    ["Vacations created", t.vacationsCreated],
    ["Vacations revealed", t.vacationsRevealed],
  ];
  return `<div class="tiles">${tiles.map(([l, v]) => `<div class="tile"><span class="tile-label">${l}</span><span class="tile-value">${fmt(v || 0)}</span></div>`).join("")}</div>`;
}

function funnelHtml(steps) {
  const first = steps[0]?.users || 0;
  return `<div class="funnel">${steps.map((s, i) => {
    const meta = FUNNEL.find((f) => f.key === s.key);
    const prev = i ? steps[i - 1].users : null;
    return `<div class="funnel-row" title="${esc(meta.label)}: ${nf.format(s.users)} users">
      <span class="funnel-label">${esc(meta.label)}<small><code>${esc(s.key)}</code></small></span>
      <span class="bar-track"><span class="bar" style="width:${first ? (s.users / first) * 100 : 0}%"></span></span>
      <span class="funnel-value">${fmt(s.users)} <small>${i ? `${pct(s.users, prev)} of prev` : "users"}</small></span>
    </div>`;
  }).join("")}</div>`;
}

const SLOTS = ["morning", "day", "evening"];

function slotsHtml(s) {
  const max = Math.max(1, ...SLOTS.flatMap((k) => [s.sealed[k] || 0, s.missed[k] || 0]));
  return legend([["sw-sealed", "Sealed"], ["sw-missed", "Missed"]]) + `<div class="slots">${SLOTS.map((k) => {
    const a = s.sealed[k] || 0, b = s.missed[k] || 0;
    return `<div class="slot">
      <span class="slot-name">${human(k)} <small>${pct(b, a + b)} missed</small></span>
      <div class="bar-row" title="Sealed: ${nf.format(a)}"><span class="bar-track"><span class="bar bar-sealed" style="width:${(a / max) * 100}%"></span></span><span class="bar-value">${fmt(a)}</span></div>
      <div class="bar-row" title="Missed: ${nf.format(b)}"><span class="bar-track"><span class="bar bar-missed" style="width:${(b / max) * 100}%"></span></span><span class="bar-value">${fmt(b)}</span></div>
    </div>`;
  }).join("")}</div>`;
}

function sourcesHtml(src) {
  const cam = src.camera || 0, gal = src.gallery || 0, sum = cam + gal || 1;
  const other = Object.entries(src).filter(([k]) => k !== "camera" && k !== "gallery");
  return `<div class="stack" role="img" aria-label="Camera ${pct(cam, sum)}, gallery ${pct(gal, sum)}">
      <span class="seg-fill bar-sealed" style="flex:${cam}" title="Camera: ${nf.format(cam)}"></span>
      <span class="seg-fill bar-missed" style="flex:${gal}" title="Gallery: ${nf.format(gal)}"></span>
    </div>
    <div class="stack-legend">
      <span><i class="sw sw-sealed"></i>Camera <b>${fmt(cam)}</b> ${pct(cam, sum)}</span>
      <span><i class="sw sw-missed"></i>Gallery <b>${fmt(gal)}</b> ${pct(gal, sum)}</span>
    </div>
    ${other.length ? `<p class="card-sub">Other values: ${other.map(([k, v]) => `${esc(k)} ${fmt(v)}`).join(", ")}</p>` : ""}`;
}

function semverDesc(a, b) {
  const pa = a.version.split(/[.\-]/).map(Number), pb = b.version.split(/[.\-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function crashFree(v) {
  if (!v.activeUsers) return { text: "—", cls: "", icon: "" };
  const r = Math.max(0, 1 - v.crashedUsers / v.activeUsers) * 100;
  const [cls, icon] = r >= 99.5 ? ["ok", "✓"] : r >= 98 ? ["warn", "!"] : ["bad", "✕"];
  return { text: `${r.toFixed(r >= 99.95 ? 1 : 2)}%`, cls, icon };
}

function crashPlatformHtml(p, data) {
  const name = p === "android" ? "Android" : "iOS";
  if (!data) return "";
  const versions = [...data.versions].sort(semverDesc);
  const issueUrl = (id) => prefs.demo
    ? `${cfg.firebaseConsole}/${cfg.firebaseApps[p]}/issues`
    : `${cfg.firebaseConsole}/${cfg.firebaseApps[p]}/issues/${encodeURIComponent(id)}`;
  return `<div class="crash-col">
    <h3>${name}</h3>
    ${data.note ? `<p class="card-empty">${esc(data.note)}</p>` : ""}
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Version</th><th class="num">Users</th><th class="num">Crashed</th><th class="num">Crash-free</th></tr></thead>
      <tbody>${versions.length ? versions.map((v) => {
        const cf = crashFree(v);
        return `<tr><td>${esc(v.version)}</td><td class="num">${fmt(v.activeUsers)}</td><td class="num">${fmt(v.crashedUsers)}</td>
          <td class="num"><span class="status ${cf.cls}">${cf.icon ? `<i>${cf.icon}</i>` : ""}${cf.text}</span></td></tr>`;
      }).join("") : `<tr><td colspan="4" class="muted">No versions in this range.</td></tr>`}</tbody>
    </table></div>
    <h4>Top issues</h4>
    <div class="table-wrap"><table class="tbl issues">
      <thead><tr><th>Issue</th><th class="num">Events</th><th class="num">Users</th><th class="num">Last seen</th></tr></thead>
      <tbody>${data.issues.length ? data.issues.map((i) => `<tr>
        <td><a href="${issueUrl(i.id)}" target="_blank" rel="noopener">${esc(i.title)}</a>
          <span class="type type-${esc((i.type || "").toLowerCase())}">${esc(human((i.type || "").toLowerCase()))}</span>
          <small>${esc(i.subtitle)}</small></td>
        <td class="num">${fmt(i.events)}</td><td class="num">${fmt(i.users)}</td><td class="num">${relDate(i.lastSeen)}</td></tr>`).join("")
        : `<tr><td colspan="4" class="muted">No crashes in this range.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}

function storeHtml() {
  return `<div class="store-grid">
    <div class="store"><h3>App Store</h3><span class="not-connected">Not connected</span>
      <p>App Store Connect Analytics needs a JWT signed with the team’s .p8 key, which can’t live in a public page. Open App Store Connect → Analytics.</p>
      <a href="https://appstoreconnect.apple.com/analytics" target="_blank" rel="noopener">App Store Connect →</a></div>
    <div class="store"><h3>Google Play</h3><span class="not-connected">Not connected</span>
      <p>The Play Developer Reporting API only accepts a service account, so it can’t run in the browser. Open Play Console → Statistics.</p>
      <a href="https://play.google.com/console" target="_blank" rel="noopener">Play Console →</a></div>
  </div>`;
}

function render(m, errors, range) {
  const share = range.days === 1 ? "today" : `${range.days} days`;
  const crashes = m.crashes || {};
  const html = [
    card("Top line", m.topline ? toplineHtml(m.topline) : "", { span: 12, key: "topline", errors,
      sub: `${share} · ${{ all: "Android + iOS", android: "Android", ios: "iOS" }[prefs.platform]}${prefs.includeQa ? " · QA devices included" : " · QA devices excluded"}` }),
    card("Funnel", m.funnel ? funnelHtml(m.funnel) : "", { span: 7, key: "funnel", errors, empty: m.funnel && !m.funnel[0].users,
      sub: "Users who fired each step’s event in the range." }),
    card("Slots", m.slots ? slotsHtml(m.slots) : "", { span: 5, key: "slots", errors, empty: m.slots && isEmpty(m.slots.sealed) && isEmpty(m.slots.missed),
      sub: "Photos sealed vs slots missed." }),
    card("Camera vs gallery", m.sources ? sourcesHtml(m.sources) : "", { key: "sources", errors, empty: isEmpty(m.sources), sub: "Sealed photos by source." }),
    card("Rejected photos", m.rejections ? barList(m.rejections) : "", { key: "rejections", errors, empty: isEmpty(m.rejections), sub: "Gallery picks refused, by reason." }),
    card("Reminders opened", m.reminders ? barList(m.reminders) : "", { key: "reminders", errors, empty: isEmpty(m.reminders), sub: "By slot (or kind for non-slot reminders)." }),
    card("Shares by kind", m.shareKind ? barList(m.shareKind) : "", { key: "shareKind", errors, empty: isEmpty(m.shareKind) }),
    card("Shares by target", m.shareTarget ? barList(m.shareTarget, { label: target }) : "", { key: "shareTarget", errors, empty: isEmpty(m.shareTarget) }),
    card("Collage styles viewed", m.collages ? barList(m.collages) : "", { key: "collages", errors, empty: isEmpty(m.collages) }),
    card("Crashes", Object.keys(crashes).map((p) => crashPlatformHtml(p, crashes[p])).join(""), { span: 12, key: "crashes", errors,
      sub: "Crash-free users = 1 − users with a fatal crash ÷ active users of that version (GA4, QA devices included). Crashlytics data arrives by daily BigQuery export." }),
    card("App languages", m.languages ? barList(m.languages, { label: language }) : "", { span: 6, key: "languages", errors, empty: isEmpty(m.languages), sub: "Active users by app_language." }),
    card("Vacation types", m.vacationTypes ? barList(m.vacationTypes) : "", { span: 6, key: "vacationTypes", errors, empty: isEmpty(m.vacationTypes), sub: "Vacations created by type." }),
    card("Store numbers", storeHtml(), { span: 12, data: false }),
  ].join("");
  let host = $("#cards");
  if (!host) { host = document.createElement("div"); host.id = "cards"; host.className = "cards"; $("#dashboard").append(host); }
  host.innerHTML = html;
}

// ── Controls ─────────────────────────────────────────────────────────────────

function syncControls() {
  document.querySelectorAll("#range-seg button").forEach((b) => b.classList.toggle("active", b.dataset.range === prefs.range));
  document.querySelectorAll("#platform-seg button").forEach((b) => b.classList.toggle("active", b.dataset.platform === prefs.platform));
  $("#custom-range").hidden = prefs.range !== "custom";
  const r = currentRange();
  $("#date-start").value = prefs.start || r.start;
  $("#date-end").value = prefs.end || r.end;
  $("#qa-toggle").checked = prefs.includeQa;
  $("#demo-toggle").checked = prefs.demo;
  document.body.classList.toggle("demo", prefs.demo);
  $("#demo-banner").hidden = !prefs.demo;
  $("#btn-signin").hidden = !!auth;
  $("#btn-signout").hidden = !auth;
  $("#user-email").hidden = !auth;
  $("#user-email").textContent = auth?.email || "Signed in";
}

let toastTimer;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.append(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

function wire() {
  $("#range-seg").addEventListener("click", (e) => {
    const r = e.target.dataset.range;
    if (!r) return;
    prefs.range = r;
    if (r === "custom" && !prefs.start) { const c = currentRange(); prefs.start = iso(daysAgo(13)); prefs.end = c.end; }
    savePrefs(); syncControls(); load();
  });
  for (const id of ["#date-start", "#date-end"]) {
    $(id).addEventListener("change", () => {
      prefs.start = $("#date-start").value; prefs.end = $("#date-end").value;
      savePrefs(); load();
    });
  }
  $("#platform-seg").addEventListener("click", (e) => {
    if (!e.target.dataset.platform) return;
    prefs.platform = e.target.dataset.platform;
    savePrefs(); syncControls(); load();
  });
  $("#qa-toggle").addEventListener("change", (e) => { prefs.includeQa = e.target.checked; savePrefs(); load(); });
  $("#demo-toggle").addEventListener("change", (e) => { prefs.demo = e.target.checked; savePrefs(); syncControls(); load(); });
  $("#btn-refresh").addEventListener("click", load);
  $("#btn-signin").addEventListener("click", signIn);
  $("#btn-signout").addEventListener("click", signOut);
}

wire();
syncControls();
initAuth();
load();
