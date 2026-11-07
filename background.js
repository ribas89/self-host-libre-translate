/* SPDX-License-Identifier: MIT */
"use strict";

const DEFAULTS = { serverUrl: "", source: "auto", target: "auto" };
// Explicit user consent is required before sending any webpage or selection text.
// This gate also applies to previously enabled tabs after upgrading the add-on.
const PRIVACY_CONSENT_KEY = "shltPrivacyConsentV1519";
let privacyConsent = "pending";
const privacyReady = (async () => {
  try {
    const stored = await browser.storage.local.get(PRIVACY_CONSENT_KEY);
    if (["accepted", "declined"].includes(stored[PRIVACY_CONSENT_KEY]))
      privacyConsent = stored[PRIVACY_CONSENT_KEY];
  } catch (error) { console.warn("Cannot read privacy preference", error); }
})();
async function requirePrivacyConsent() {
  await privacyReady;
  if (privacyConsent !== "accepted")
    throw new Error("Review and accept the privacy notice before using translation.");
}
async function openPrivacyPage() {
  if (!browser.tabs?.create || !browser.runtime?.getURL) return false;
  const url = browser.runtime.getURL("consent.html");
  const tabs = await browser.tabs.query({});
  const existing = tabs.find(t => t.url === url);
  if (existing && browser.tabs.update) await browser.tabs.update(existing.id, {active: true});
  else await browser.tabs.create({url, active: true});
  return true;
}
if (browser.runtime?.onInstalled) {
  browser.runtime.onInstalled.addListener(async () => {
    await privacyReady;
    if (privacyConsent === "pending") await openPrivacyPage().catch(error => console.warn("Cannot open privacy notice", error));
  });
}
async function setPrivacyConsent(accepted, cacheEnabled) {
  await privacyReady;
  if (accepted) {
    // Default consent choice is local caching ON, but the user can untick it.
    await setCacheEnabled(cacheEnabled !== false);
    privacyConsent = "accepted";
    await browser.storage.local.set({[PRIVACY_CONSENT_KEY]: "accepted"});
    // Resume any tabs that were enabled before this consent update.
    for (const tabId of [...enabledTabs]) {
      await restoreTab(tabId);
      await ensurePageStart(tabId);
    }
  } else {
    privacyConsent = "declined";
    await browser.storage.local.set({[PRIVACY_CONSENT_KEY]: "declined"});
    await setCacheEnabled(false);
    const active = [...enabledTabs];
    enabledTabs.clear();
    for (const tabId of active) await restoreTab(tabId);
    saveSessionSoon();
  }
  return {status: privacyConsent, caching: pageCacheStats()};
}

// One-time migration: make the new browser-language target visible to existing users.
// Future manual target choices are never overridden.
const TARGET_AUTO_MIGRATION_KEY = "ribsAutoPageTargetV1512";
async function migratePageTarget() {
  const saved = await browser.storage.local.get({ [TARGET_AUTO_MIGRATION_KEY]: false });
  if (!saved[TARGET_AUTO_MIGRATION_KEY]) {
    await browser.storage.local.set({ target: "auto", [TARGET_AUTO_MIGRATION_KEY]: true });
  }
}

// Selection translation is configured per Firefox tab, not globally.
// The language catalog is shared, but each tab gets independent From/To choices.
const SELECTION_LANGUAGE_CACHE_KEY = "ribsSelectionServerLanguagesV1";
const selectionTabPrefs = new Map();
let selectionMenuLanguages = [];
let selectionMenuServer = "";
const selectionLanguagesReady = (async () => {
  try {
    const stored = await browser.storage.local.get([SELECTION_LANGUAGE_CACHE_KEY, "serverUrl"]);
    const cached = stored[SELECTION_LANGUAGE_CACHE_KEY];
    if (cached && cached.serverUrl === stored.serverUrl && Array.isArray(cached.languages)) {
      selectionMenuServer = cached.serverUrl;
      selectionMenuLanguages = filterSelectionLanguages(cached.languages);
    }
  } catch (error) { console.warn("Selection language catalog unavailable", error); }
})();
function filterSelectionLanguages(languages) {
  const codes = new Set();
  return (Array.isArray(languages) ? languages : []).filter(item => {
    if (!item || typeof item.code !== "string" || typeof item.name !== "string" ||
        !/^[a-z]{2,3}(?:-[a-z]{2,3})?$/i.test(item.code) || codes.has(item.code)) return false;
    codes.add(item.code);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function selectionPreferencesForTab(tabId, serverUrl) {
  const saved = selectionTabPrefs.get(tabId);
  return saved && saved.serverUrl === serverUrl ?
    { source: saved.source, target: saved.target } : { source: "auto", target: "auto" };
}
async function updateSelectionLanguageList(serverUrl, languages) {
  await selectionLanguagesReady;
  selectionMenuServer = serverUrl;
  selectionMenuLanguages = filterSelectionLanguages(languages);
  await browser.storage.local.set({
    [SELECTION_LANGUAGE_CACHE_KEY]: { serverUrl, languages: selectionMenuLanguages }
  });
}
async function getSelectionSettingsForTab(tabId) {
  await ready;
  await selectionLanguagesReady;
  const settings = await browser.storage.local.get("serverUrl");
  const serverUrl = settings.serverUrl || "";
  const prefs = selectionPreferencesForTab(tabId, serverUrl);
  return { ...prefs, languages: selectionMenuServer === serverUrl ? selectionMenuLanguages : [] };
}
async function setSelectionSettingsForTab(tabId, source, target) {
  await ready;
  await selectionLanguagesReady;
  if (!Number.isInteger(tabId)) throw new Error("Open a browser tab first.");
  const settings = await browser.storage.local.get("serverUrl");
  const serverUrl = settings.serverUrl || "";
  if (!serverUrl) throw new Error("Configure your LibreTranslate server first.");
  if (selectionMenuServer !== serverUrl || !selectionMenuLanguages.length)
    throw new Error("Test the server connection to load its supported languages.");
  const valid = code => code === "auto" || selectionMenuLanguages.some(lang => lang.code === code);
  if (!valid(source) || !valid(target)) throw new Error("The chosen language is not supported by this server.");
  selectionTabPrefs.set(tabId, { serverUrl, source, target });
  saveSessionSoon();
  return { source, target, languages: selectionMenuLanguages };
}
const SESSION_KEY = "ribsTranslatorSessionV3";
const jobs = new Map();
// Temporary in-flight selection operations. This counter is deliberately
// independent from jobs/frame progress and is never persisted across restarts.
const selectionPendingByTab = new Map();
const enabledTabs = new Set();
const tabLocations = new Map();
// Invalidate older asynchronous SPA transitions when the user navigates quickly.
const navigationVersions = new Map();
const translationCache = new Map();
const CACHE_MAX = 3500;
// Persist only exact source-text translations for each page. If a page changes,
// only the new/changed text is sent to the user's server.
const PAGE_CACHE_KEY = "ribsPageTranslationCacheV1";
const PAGE_CACHE_ENABLED_KEY = "ribsPageCacheEnabledV1518";
const PAGE_CACHE_MIGRATION_KEY = "ribsPageCachePrivacyMigrationV1518";
const PAGE_CACHE_LIMIT = 30;
const PAGE_CACHE_ENTRY_LIMIT = 1500;
const PAGE_CACHE_CHAR_LIMIT = 350000;
const pageCache = new Map();
let pageCacheEnabled = false; // Opt-in, including after upgrades from older versions.
let cacheSaveTimer = null;
let cacheGeneration = 0;
const cacheReady = (async () => {
  try {
    const settings = await browser.storage.local.get({
      [PAGE_CACHE_MIGRATION_KEY]: false, [PAGE_CACHE_ENABLED_KEY]: false
    });
    if (!settings[PAGE_CACHE_MIGRATION_KEY]) {
      // Old releases always cached. Delete all old stored text on first upgrade.
      await browser.storage.local.remove(PAGE_CACHE_KEY);
      await browser.storage.local.set({
        [PAGE_CACHE_MIGRATION_KEY]: true, [PAGE_CACHE_ENABLED_KEY]: false
      });
      return;
    }
    pageCacheEnabled = settings[PAGE_CACHE_ENABLED_KEY] === true;
    if (!pageCacheEnabled) {
      await browser.storage.local.remove(PAGE_CACHE_KEY);
      return;
    }
    const saved = (await browser.storage.local.get(PAGE_CACHE_KEY))[PAGE_CACHE_KEY];
    if (!Array.isArray(saved)) return;
    for (const item of saved) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
      const entries = new Map(item[1].filter(x => Array.isArray(x) && x.length === 2 &&
        typeof x[0] === "string" && typeof x[1] === "string").slice(-PAGE_CACHE_ENTRY_LIMIT));
      pageCache.set(item[0], entries);
    }
    while (pageCache.size > PAGE_CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value);
  } catch (error) { console.warn("Page cache recovery unavailable", error); }
})();
function pageKey(serverUrl, source, target, frameUrl) {
  // Include the entire URL, including a fragment, for Kiwix and SPA pages.
  return JSON.stringify([serverUrl, source, target, frameUrl || ""]);
}
function cachedPageText(key, original) {
  if (!pageCacheEnabled) return undefined;
  const entries = pageCache.get(key);
  if (!entries || !entries.has(original)) return undefined;
  // Move page to the back of our bounded LRU cache.
  pageCache.delete(key);
  pageCache.set(key, entries);
  return entries.get(original);
}
function storePageText(key, original, translated) {
  if (!pageCacheEnabled || !original || original.length > 8000 || typeof translated !== "string") return;
  let entries = pageCache.get(key);
  if (!entries) entries = new Map();
  pageCache.delete(key);
  pageCache.set(key, entries);
  if (entries.has(original)) entries.delete(original);
  entries.set(original, translated);
  while (entries.size > PAGE_CACHE_ENTRY_LIMIT) entries.delete(entries.keys().next().value);
  while (pageCache.size > PAGE_CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value);
  let total = 0;
  for (const values of pageCache.values()) for (const [a,b] of values) total += a.length + b.length;
  while (total > PAGE_CACHE_CHAR_LIMIT && pageCache.size) {
    const firstKey = pageCache.keys().next().value;
    const first = pageCache.get(firstKey);
    if (pageCache.size === 1 && first.size > 1) {
      const [a,b] = first.entries().next().value;
      first.delete(a); total -= a.length + b.length;
    } else {
      for (const [a,b] of first) total -= a.length + b.length;
      pageCache.delete(firstKey);
    }
  }
  schedulePageCacheSave();
}
function schedulePageCacheSave() {
  if (!pageCacheEnabled) return;
  if (cacheSaveTimer !== null) return;
  const generation = cacheGeneration;
  cacheSaveTimer = setTimeout(async () => {
    cacheSaveTimer = null;
    if (generation !== cacheGeneration || !pageCacheEnabled) return;
    const snapshot = [...pageCache.entries()].map(([key, items]) => [key, [...items.entries()]]);
    try {
      await browser.storage.local.set({ [PAGE_CACHE_KEY]: snapshot });
    } catch (error) { console.warn("Cannot save page translation cache", error); }
  }, 700);
}
async function clearPageCache() {
  await cacheReady;
  cacheGeneration++;
  if (cacheSaveTimer !== null) { clearTimeout(cacheSaveTimer); cacheSaveTimer = null; }
  pageCache.clear();
  translationCache.clear();
  await browser.storage.local.remove(PAGE_CACHE_KEY);
  return { cleared: true };
}
async function setCacheEnabled(enabled) {
  await cacheReady;
  const next = enabled === true;
  if (next !== pageCacheEnabled) {
    // Clear all old data before changing modes, including the in-memory cache.
    await clearPageCache();
    pageCacheEnabled = next;
    await browser.storage.local.set({ [PAGE_CACHE_ENABLED_KEY]: next });
  }
  return pageCacheStats();
}
function pageCacheStats() {
  let blocks = 0;
  for (const entries of pageCache.values()) blocks += entries.size;
  return { pages: pageCache.size, blocks, enabled: pageCacheEnabled };
}

const requestQueue = [];
const MAX_REQUESTS = 2;
let requestsRunning = 0;
let saveTimer = null;
let lastWebTab = null;
const autoStarting = new Set();
function normalizedPageUrl(url) {
  try { const u = new URL(url); return ["http:", "https:"].includes(u.protocol) ? u.href : ""; }
  catch (_) { return ""; }
}
async function rememberPageUrl(tabId) {
  // Reading the current tab URL must not mark a SPA route as handled.
  // Otherwise opening the popup can overwrite tabLocations before the
  // history/hash navigation event reaches pageLocationChanged().
  try { const tab = await browser.tabs.get(tabId); return tab.url; }
  catch (_) { return ""; }
}

const sessionStore = browser.storage.session || browser.storage.local;
const ready = (async () => {
  try {
    await migratePageTarget();
    const saved = (await sessionStore.get(SESSION_KEY))[SESSION_KEY] || {};
    for (const entry of saved.jobs || []) {
      if (!Number.isInteger(entry.tabId)) continue;
      jobs.set(entry.tabId, { ...entry, frames: new Map(entry.frames || []) });
    }
    if (Number.isInteger(saved.lastWebTab)) lastWebTab = saved.lastWebTab;
    for (const id of saved.enabledTabs || []) {
      if (Number.isInteger(id)) enabledTabs.add(id);
    }
    for (const [id, prefs] of saved.selectionTabPrefs || []) {
      if (Number.isInteger(id) && prefs && typeof prefs.serverUrl === "string" &&
          typeof prefs.source === "string" && typeof prefs.target === "string") {
        selectionTabPrefs.set(id, prefs);
      }
    }
    const tabs = await browser.tabs.query({});
    const open = new Set(tabs.map(tab => tab.id));
    const privateIds = new Set(tabs.filter(tab => tab.incognito).map(tab => tab.id));
    for (const tab of tabs) tabLocations.set(tab.id, normalizedPageUrl(tab.url));
    for (const id of enabledTabs) if (!open.has(id) || privateIds.has(id)) enabledTabs.delete(id);
    for (const id of selectionTabPrefs.keys()) if (!open.has(id) || privateIds.has(id)) selectionTabPrefs.delete(id);
    for (const id of jobs.keys()) if (!open.has(id) || privateIds.has(id) || !enabledTabs.has(id)) jobs.delete(id);
    if (lastWebTab !== null && !open.has(lastWebTab)) lastWebTab = null;
    // v1.5.2 used persistent per-URL preferences. Discard those outdated rules.
    await browser.storage.local.remove("ribsEnabledPagesV1");
  } catch (error) { console.warn("Session recovery unavailable", error); }
})();

function saveSessionSoon() {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const openTabs = await browser.tabs.query({});
      const privateTabs = new Set(openTabs.filter(tab => tab.incognito).map(tab => tab.id));
      const isNormal = tabId => !privateTabs.has(tabId);
      const snapshot = {
        jobs: [...jobs.entries()].filter(([tabId]) => isNormal(tabId)).map(([tabId, state]) => ({
          ...state, tabId, frames: [...state.frames.entries()]
        })),
        lastWebTab: isNormal(lastWebTab) ? lastWebTab : null,
        enabledTabs: [...enabledTabs].filter(isNormal),
        selectionTabPrefs: [...selectionTabPrefs.entries()].filter(([tabId]) => isNormal(tabId))
      };
      await sessionStore.set({ [SESSION_KEY]: snapshot });
    } catch (error) { console.warn("Cannot persist translation status", error); }
  }, 80);
}
function normalizeServer(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("Enter your LibreTranslate server URL first.");
  let url;
  try { url = new URL(value); } catch (_) { throw new Error("Enter a valid HTTP or HTTPS server URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("The server must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Do not include login credentials in the URL.");
  if (url.search || url.hash) throw new Error("Use the server address without a query or fragment.");
  url.pathname = url.pathname.replace(/\/(translate|languages)\/?$/, "/").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}
function scheduleRequest(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    pumpRequests();
  });
}
function pumpRequests() {
  while (requestsRunning < MAX_REQUESTS && requestQueue.length) {
    const next = requestQueue.shift();
    requestsRunning++;
    Promise.resolve().then(next.task).then(next.resolve, next.reject)
      .finally(() => { requestsRunning--; pumpRequests(); });
  }
}
async function requestJSON(url, payload) {
  await requirePrivacyConsent();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    // LibreTranslate frequently returns Access-Control-Allow-Origin: *.
    // Credentialed cross-origin requests cannot use that wildcard. Do not
    // send browser cookies or HTTP authentication to arbitrary servers.
    const opts = { method: payload ? "POST" : "GET", credentials: "omit",
      headers: { Accept: "application/json" }, signal: controller.signal };
    if (payload) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(payload);
    }
    const response = await fetch(url, opts);
    const body = await response.text();
    let parsed;
    try { parsed = JSON.parse(body); }
    catch (_) { throw new Error(`The server returned non-JSON (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(parsed.error || parsed.message || "translation failed").slice(0, 180)}`);
    return parsed;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Translation timed out after 120 seconds.");
    throw error;
  } finally { clearTimeout(timeout); }
}
function remember(key, result) {
  if (!pageCacheEnabled) return;
  translationCache.set(key, result);
  if (translationCache.size > CACHE_MAX) translationCache.delete(translationCache.keys().next().value);
}
function getSummary(tabId) {
  const state = jobs.get(tabId);
  const enabled = enabledTabs.has(tabId);
  if (!state) return { tabId, status: enabled ? "waiting" : "idle", total: 0, completed: 0,
    failed: 0, pending: 0, percent: 0, frames: 0, pageEnabled: enabled, pageUrl: tabLocations.get(tabId) || "" };
  let total = 0, completed = 0, failed = 0, frames = 0, scanning = false;
  for (const f of state.frames.values()) {
    total += f.total || 0;
    completed += f.completed || 0;
    failed += f.failed || 0;
    scanning ||= Boolean(f.scanning);
    frames++;
  }
  const pending = Math.max(0, total - completed);
  let status = state.status;
  if (status === "running" && frames > 0 && pending === 0 && !scanning) status = "complete";
  return { tabId, status, total, completed, failed, pending,
    percent: total ? Math.min(100, Math.round(100 * completed / total)) : 0,
    frames, error: state.error || "", target: state.target, source: state.source,
    pageEnabled: enabled, pageUrl: tabLocations.get(tabId) || "", runId: state.runId };
}
function remainingLabel(count) {
  if (!count) return "...";
  if (count > 999) return "1k+";
  return String(count);
}
async function updateBadge(tabId) {
  const state = getSummary(tabId);
  let text = "", color = "#64748b", title = "Self Host Libre Translate";
  if (state.status === "running") {
    text = remainingLabel(state.pending);
    color = "#2563eb";
    title = `${state.pending} text blocks remaining, ${state.completed}/${state.total} translated`;
  } else if (state.status === "complete") {
    text = state.failed ? "!" : "✓";
    color = state.failed ? "#b45309" : "#13875f";
    title = `${state.completed} blocks completed, ${state.failed} failed`;
  } else if (state.status === "error") {
    text = "!"; color = "#b91c1c"; title = state.error || "Translation failed";
  } else if (state.pageEnabled) {
    text = "ON"; color = "#167d91"; title = "Translation enabled in this tab";
  }
  // Selection translation temporarily takes priority in the badge, without
  // changing the full-page job's remaining count or completion state.
  const selectedPending = selectionPendingByTab.get(tabId) || 0;
  if (selectedPending) {
    text = remainingLabel(selectedPending);
    color = "#a45112";
    title = `LibreTranslate Selection: ${selectedPending} request${selectedPending === 1 ? "" : "s"} remaining. ${title}`;
  }
  try {
    await Promise.all([
      browser.action.setBadgeText({ tabId, text }),
      browser.action.setBadgeBackgroundColor({ tabId, color }),
      browser.action.setTitle({ tabId, title })
    ]);
  } catch (_) { /* The tab may have closed. */ }
  browser.runtime.sendMessage({ type: "STATUS_PUSH", status: state }).catch(() => {});
}
async function countSelectionRequest(tabId, delta) {
  const updated = Math.max(0, (selectionPendingByTab.get(tabId) || 0) + delta);
  if (updated) selectionPendingByTab.set(tabId, updated);
  else selectionPendingByTab.delete(tabId);
  await updateBadge(tabId);
}
async function translateBatch(tabId, runId, source, target, texts, frameUrl) {
  await requirePrivacyConsent();
  await cacheReady;
  const state = jobs.get(tabId);
  if (!state || state.runId !== runId || state.status !== "running") throw new Error("Translation was stopped.");
  // Even when normal-window caching is enabled, private tabs bypass both caches.
  const tab = await browser.tabs.get(tabId);
  const mayCache = pageCacheEnabled && tab && !tab.incognito;
  const cacheVersion = cacheGeneration;
  if (!Array.isArray(texts) || !texts.length || texts.length > 16 ||
      texts.some(text => typeof text !== "string" || text.length > 8000)) throw new Error("Invalid batch.");
  const results = new Array(texts.length);
  const missing = [];
  const indexes = new Map();
  const prefix = `${state.serverUrl}|${source}|${target}|`;
  const key = pageKey(state.serverUrl, source, target, frameUrl);
  for (let i = 0; i < texts.length; i++) {
    const pageHit = mayCache ? cachedPageText(key, texts[i]) : undefined;
    if (pageHit !== undefined) { results[i] = pageHit; continue; }
    if (mayCache && translationCache.has(prefix + texts[i])) {
      results[i] = translationCache.get(prefix + texts[i]);
      if (mayCache) storePageText(key, texts[i], results[i]);
      continue;
    }
    if (!indexes.has(texts[i])) { indexes.set(texts[i], []); missing.push(texts[i]); }
    indexes.get(texts[i]).push(i);
  }
  if (missing.length) {
    const translated = await scheduleRequest(async () => {
      if (jobs.get(tabId)?.runId !== runId) throw new Error("Translation was stopped.");
      const response = await requestJSON(`${state.serverUrl}/translate`, {
        q: missing, source, target, format: "text"
      });
      const list = Array.isArray(response.translatedText) ? response.translatedText : [response.translatedText];
      if (list.length !== missing.length || list.some(x => typeof x !== "string")) {
        throw new Error("Unexpected /translate response.");
      }
      return list;
    });
    for (let i = 0; i < missing.length; i++) {
      // The preference may have changed while the API call was in flight.
      if (mayCache && pageCacheEnabled && cacheVersion === cacheGeneration) {
        remember(prefix + missing[i], translated[i]);
        storePageText(key, missing[i], translated[i]);
      }
      for (const index of indexes.get(missing[i])) results[index] = translated[i];
    }
  }
  return results;
}
// Script evidence prevents a Latin-script /detect guess such as Estonian from
// being used as the target for an overwhelmingly Cyrillic Russian forum.
const SCRIPT_LANGUAGES = {
  Cyrillic: new Set(["ru", "uk", "bg", "be", "mk", "sr", "kk", "ky", "tg", "mn"]),
  Greek: new Set(["el"]),
  Arabic: new Set(["ar", "fa", "ur", "ps"]),
  Hebrew: new Set(["he", "yi"])
};
function likelyScript(text) {
  const value = String(text || "").slice(0, 10000);
  const letters = (value.match(/\p{L}/gu) || []).length;
  if (letters < 25) return null;
  for (const script of ["Cyrillic", "Greek", "Arabic", "Hebrew"]) {
    const pattern = new RegExp(`\\p{Script=${script}}`, "gu");
    const matches = (value.match(pattern) || []).length;
    if (matches >= 18 && matches / letters >= 0.20) return script;
  }
  return "LatinOrMixed";
}
function scriptCompatible(language, script) {
  if (!script || script === "LatinOrMixed") return true;
  return SCRIPT_LANGUAGES[script]?.has(String(language).split("-")[0].toLowerCase()) || false;
}
function normalizedDetectedLanguage(candidate, serverUrl) {
  const code = String(candidate || "").trim();
  if (!/^[a-z]{2,3}(?:-[a-z]{2,3})?$/i.test(code)) return null;
  const base = code.split("-")[0];
  // Do not apply a previous server's language catalog to a newly configured one.
  const catalog = selectionMenuServer === serverUrl ? selectionMenuLanguages : [];
  if (catalog.length) {
    const find = value => catalog.find(lang => lang.code.toLowerCase() === value.toLowerCase())?.code;
    return find(code) || (code === "pb" ? find("pt-BR") : null) || find(base) || null;
  }
  // LibreTranslate normally accepts base codes (ru, en, es), not region tags
  // such as ru-RU. Preserve the Brazilian Portuguese special case.
  return code.toLowerCase() === "pt-br" ? "pt-BR" : base;
}
async function detectPageLanguage(serverUrl, samples, declared) {
  const parts = (Array.isArray(samples) ? samples : [samples])
    .filter(value => typeof value === "string" && value.trim())
    .slice(0, 4).map(value => value.trim().slice(0, 1700));
  const declaredCandidate = String(declared || "").trim().replace("_", "-");
  const declaredCode = normalizedDetectedLanguage(declaredCandidate, serverUrl) ||
    normalizedDetectedLanguage(declaredCandidate.split("-")[0], serverUrl);
  const script = likelyScript(parts.join(" "));
  // A declared language is especially strong evidence for non-Latin scripts.
  // Latin text alone cannot distinguish English from Estonian or Portuguese,
  // so use multi-sample detection instead of blindly trusting a Latin lang tag.
  if (declaredCode && script && script !== "LatinOrMixed" && scriptCompatible(declaredCode, script)) return declaredCode;
  if (!parts.length) throw new Error("Cannot detect page language. The page has no readable text. Choose a target language manually.");
  const votes = new Map();
  let failed = 0;
  for (const part of parts) {
    if ((part.match(/\p{L}/gu) || []).length < 20) continue;
    try {
      const response = await requestJSON(`${serverUrl}/detect`, { q: part });
      const candidates = (Array.isArray(response) ? response : [response])
        .map(item => ({code: normalizedDetectedLanguage(item?.language, serverUrl), confidence: Number(item?.confidence) || 0}))
        .filter(item => item.code && scriptCompatible(item.code, script))
        .sort((a,b) => b.confidence - a.confidence);
      if (!candidates.length) continue;
      // A vote per independent page sample, rather than the single highest
      // confidence returned for one header or short advertisement.
      const selected = candidates[0];
      const record = votes.get(selected.code) || {votes:0, score:0};
      record.votes += 1;
      record.score += Math.min(1, Math.max(0.05, selected.confidence));
      votes.set(selected.code, record);
    } catch (error) {
      failed++;
      console.warn("Page language detection sample failed:", error);
    }
  }
  const ranked = [...votes].sort((a,b) => b[1].votes - a[1].votes || b[1].score - a[1].score);
  if (ranked.length) {
    // Break a vote tie in favor of the document's declared language if it
    // agrees with the measured writing system and received at least one vote.
    const topVotes = ranked[0][1].votes;
    if (declaredCode && scriptCompatible(declaredCode, script)) {
      const declaredVote = ranked.find(item => item[0] === declaredCode && item[1].votes === topVotes);
      if (declaredVote) return declaredCode;
    }
    return ranked[0][0];
  }
  if (declaredCode && scriptCompatible(declaredCode, script)) return declaredCode;
  const reason = failed === parts.length ? "The translation server could not detect the page language." :
    "The page language could not be identified reliably.";
  throw new Error(`${reason} Choose a target language explicitly.`);
}

async function translateSelectionToPageLanguage(msg) {
  await requirePrivacyConsent();
  const settings = await browser.storage.local.get(DEFAULTS);
  const server = normalizeServer(settings.serverUrl);
  const selected = String(msg.text || "");
  if (!selected.trim() || selected.length > 16000) throw new Error("Select 1 to 16,000 characters of text.");
  // The context-menu handler passes the per-tab choices. Auto source detects
  // selected text; auto target detects the original page language.
  const source = typeof msg.selectionSource === "string" ? msg.selectionSource : "auto";
  const choice = typeof msg.selectionTarget === "string" ? msg.selectionTarget : "auto";
  if (source !== "auto" && !/^[a-z]{2,3}(?:-[a-z]{2,3})?$/i.test(source)) throw new Error("Invalid source language.");
  if (choice !== "auto" && !/^[a-z]{2,3}(?:-[a-z]{2,3})?$/i.test(choice)) throw new Error("Invalid target language.");
  const target = choice === "auto" ?
    await detectPageLanguage(server, msg.pageSamples || msg.pageSample, msg.declaredLanguage) : choice;
  const response = await requestJSON(`${server}/translate`, {
    q: selected, source, target, format: "text"
  });
  if (typeof response.translatedText !== "string") throw new Error("Unexpected /translate response.");
  return { translated: response.translatedText, source, target };
}
// Auto target for whole-page translation means Firefox's preferred content
// language, falling back to its UI language. The resolved code must be a
// supported LibreTranslate language, never the literal string "auto".
function matchBrowserLocale(locale, languages) {
  const desired = String(locale || "").trim().replace(/_/g, "-").toLowerCase();
  if (!desired) return null;
  const exact = languages.find(item => item.code.toLowerCase() === desired);
  if (exact) return exact.code;
  if (desired === "pt-br") {
    const brazilian = languages.find(item => item.code.toLowerCase() === "pb");
    if (brazilian) return brazilian.code;
  }
  const base = desired.split("-")[0];
  const direct = languages.find(item => item.code.toLowerCase() === base);
  if (direct) return direct.code;
  // Brazilian Portuguese may be exposed as pb by some Argos installations.
  if (base === "pt") {
    const alt = languages.find(item => item.code.toLowerCase() === "pt-br" || item.code.toLowerCase() === "pb");
    if (alt) return alt.code;
  }
  return null;
}
async function resolvePageTarget(serverUrl, requested) {
  if (requested !== "auto") return requested;
  await selectionLanguagesReady;
  let languages = selectionMenuServer === serverUrl ? selectionMenuLanguages : [];
  if (!languages.length) {
    languages = filterSelectionLanguages(await requestJSON(`${serverUrl}/languages`, null));
    await updateSelectionLanguageList(serverUrl, languages);
  }
  let preferred = [];
  try {
    if (browser.i18n?.getAcceptLanguages) preferred = await browser.i18n.getAcceptLanguages();
  } catch (error) { console.warn("Cannot read Firefox content languages", error); }
  try {
    if (browser.i18n?.getUILanguage) preferred.push(browser.i18n.getUILanguage());
  } catch (error) { console.warn("Cannot read Firefox interface language", error); }
  for (const locale of preferred) {
    const supported = matchBrowserLocale(locale, languages);
    if (supported) return supported;
  }
  throw new Error("No Firefox preferred language is supported by this LibreTranslate server. Choose a target language explicitly.");
}

async function startTab(tabId, provided) {
  await requirePrivacyConsent();
  const serverUrl = normalizeServer(provided.serverUrl);
  const source = String(provided.source || "auto");
  const target = await resolvePageTarget(serverUrl, String(provided.target || "auto"));
  if (source === target) throw new Error("Select different source and target languages.");
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,3})?$/.test(target) ||
      (source !== "auto" && !/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,3})?$/.test(source))) {
    throw new Error("Unsupported language code format.");
  }
  const old = jobs.get(tabId);
  if (old) await browser.tabs.sendMessage(tabId, { type: "RESTORE", runId: old.runId }).catch(() => {});
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const state = { runId, status: "running", serverUrl, source, target, error: "", frames: new Map() };
  jobs.set(tabId, state);
  saveSessionSoon();
  await updateBadge(tabId);
  try {
    await browser.tabs.sendMessage(tabId, { type: "START_TRANSLATION", runId, source, target });
  } catch (error) {
    state.status = "error";
    state.error = "This page cannot be translated. Open a regular HTTP/HTTPS page and reload. " + error.message;
    saveSessionSoon();
    await updateBadge(tabId);
    throw new Error(state.error);
  }
  return getSummary(tabId);
}
async function restoreTab(tabId) {
  const state = jobs.get(tabId);
  if (state) {
    state.status = "stopped";
    await browser.tabs.sendMessage(tabId, { type: "RESTORE", runId: state.runId }).catch(() => {});
  }
  jobs.delete(tabId);
  saveSessionSoon();
  await updateBadge(tabId);
  return getSummary(tabId);
}
async function ensurePageStart(tabId) {
  await privacyReady;
  if (privacyConsent !== "accepted") return;
  const url = await rememberPageUrl(tabId);
  if (!enabledTabs.has(tabId) || !normalizedPageUrl(url) || autoStarting.has(tabId)) return;
  const state = jobs.get(tabId);
  if (state && state.status === "running") return;
  autoStarting.add(tabId);
  try {
    const settings = await browser.storage.local.get(DEFAULTS);
    if (!settings.serverUrl) throw new Error("Configure a translation server before enabling a tab.");
    if (enabledTabs.has(tabId) && normalizedPageUrl(await rememberPageUrl(tabId))) {
      await startTab(tabId, settings);
    }
  } catch (error) {
    if (!/receiving end|could not establish connection|No matching message/i.test(String(error.message || ""))) {
      console.warn("Page translation could not start", error);
    }
  } finally { autoStarting.delete(tabId); }
}
async function setPageEnabled(tabId, enabled, settings) {
  if (enabled) await requirePrivacyConsent();
  const url = await rememberPageUrl(tabId);
  if (enabled) {
    if (!normalizedPageUrl(url)) throw new Error("Open a normal HTTP/HTTPS page to enable translation.");
    // Establish a baseline when the tab is explicitly turned on.
    if (!tabLocations.has(tabId)) tabLocations.set(tabId, normalizedPageUrl(url));
    const serverUrl = normalizeServer(settings.serverUrl);
    await browser.storage.local.set({ serverUrl, source: settings.source, target: settings.target });
    enabledTabs.add(tabId);
    saveSessionSoon();
    // Restart if a previous run used different source or target settings.
    const current = jobs.get(tabId);
    const target = await resolvePageTarget(serverUrl, settings.target || "auto");
    if (current && (current.source !== settings.source || current.target !== target || current.serverUrl !== serverUrl)) {
      await restoreTab(tabId);
    }
    await ensurePageStart(tabId);
  } else {
    enabledTabs.delete(tabId);
    saveSessionSoon();
    await restoreTab(tabId);
  }
  await updateBadge(tabId);
  return getSummary(tabId);
}
async function pageLocationChanged(tabId, url) {
  const next = normalizedPageUrl(url);
  if (!next || tabLocations.get(tabId) === next) return;
  tabLocations.set(tabId, next);
  const version = (navigationVersions.get(tabId) || 0) + 1;
  navigationVersions.set(tabId, version);
  // SPA navigations keep the document alive. Stop the old job before starting
  // the new one, but never start for a URL that was superseded meanwhile.
  if (jobs.has(tabId)) await restoreTab(tabId);
  if (navigationVersions.get(tabId) !== version) return;
  await updateBadge(tabId);
  if (navigationVersions.get(tabId) !== version) return;
  if (enabledTabs.has(tabId)) await ensurePageStart(tabId);
}
function isPage(url) { return /^https?:\/\//i.test(url || ""); }
async function getContextTab() {
  const active = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (active && isPage(active.url)) {
    if (!tabLocations.has(active.id)) tabLocations.set(active.id, normalizedPageUrl(active.url));
    lastWebTab = active.id; saveSessionSoon(); return { tabId: active.id };
  }
  if (lastWebTab !== null) {
    try { const tab = await browser.tabs.get(lastWebTab); if (isPage(tab.url)) { if (!tabLocations.has(tab.id)) tabLocations.set(tab.id, normalizedPageUrl(tab.url)); return { tabId: tab.id }; } }
    catch (_) { /* The tab has closed. */ }
  }
  const candidates = await browser.tabs.query({});
  const page = candidates.find(tab => isPage(tab.url));
  if (page && !tabLocations.has(page.id)) tabLocations.set(page.id, normalizedPageUrl(page.url));
  return { tabId: page ? page.id : null };
}
async function handleMessage(msg, sender) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "GET_PRIVACY_STATUS": await privacyReady; return {status: privacyConsent};
    case "OPEN_PRIVACY_PAGE": return {opened: await openPrivacyPage()};
    case "ACCEPT_PRIVACY": return setPrivacyConsent(true, msg.cacheEnabled);
    case "DECLINE_PRIVACY": return setPrivacyConsent(false, false);
    case "GET_CONTEXT_TAB": return getContextTab();
    case "GET_STATUS": await rememberPageUrl(msg.tabId); return getSummary(msg.tabId);
    case "CACHE_STATS": await cacheReady; return pageCacheStats();
    case "SET_CACHE_ENABLED": await requirePrivacyConsent(); return setCacheEnabled(msg.enabled);
    case "GET_SELECTION_SETTINGS": return getSelectionSettingsForTab(msg.tabId);
    case "SET_SELECTION_SETTINGS": return setSelectionSettingsForTab(msg.tabId, msg.source, msg.target);
    case "CLEAR_PAGE_CACHE": return clearPageCache();
    case "TRANSLATE_SELECTION_TO_PAGE": return translateSelectionToPageLanguage(msg);
    case "START_TAB": return startTab(msg.tabId, msg.settings);
    case "RESTORE_TAB": return restoreTab(msg.tabId);
    case "SET_PAGE_ENABLED": return setPageEnabled(msg.tabId, Boolean(msg.enabled), msg.settings || {});
    case "CHECK_SERVER": {
      const serverUrl = normalizeServer(msg.serverUrl);
      const languages = await requestJSON(`${serverUrl}/languages`, null);
      if (!Array.isArray(languages)) throw new Error("/languages did not return a language list.");
      const supported = filterSelectionLanguages(languages);
      await updateSelectionLanguageList(serverUrl, supported);
      return { serverUrl, languages: supported };
    }
  }
  if (!sender.tab) return;
  const tabId = sender.tab.id;
  const frameId = sender.frameId ?? 0;
  if (msg.type === "PAGE_LOCATION_CHANGED" && frameId === 0) {
    await pageLocationChanged(tabId, msg.url);
    return { ok: true };
  }
  if (msg.type === "FRAME_HELLO") {
    await privacyReady;
    if (privacyConsent !== "accepted") return {active: false};
    const state = jobs.get(tabId);
    if (state && state.status === "running") return { active: true, runId: state.runId, source: state.source, target: state.target };
    if (frameId === 0 && enabledTabs.has(tabId) && normalizedPageUrl(await rememberPageUrl(tabId))) {
      // A newly loaded top-level document is ready for its first translation.
      await ensurePageStart(tabId);
      const started = jobs.get(tabId);
      if (started && started.status === "running") return {
        active: true, runId: started.runId, source: started.source, target: started.target
      };
    }
    return { active: false };
  }
  if (msg.type === "TRANSLATE_BATCH") return translateBatch(tabId, msg.runId, msg.source, msg.target, msg.texts, sender.url);
  const state = jobs.get(tabId);
  if (!state || state.runId !== msg.runId) return { ok: false };
  if (msg.type === "FRAME_ERROR") {
    state.status = "error";
    state.error = String(msg.error || "Translation failed");
    saveSessionSoon(); updateBadge(tabId).catch(() => {});
  }
  if (msg.type === "FRAME_PROGRESS" && state.status === "running") {
    state.frames.set(frameId, { total: Number(msg.total) || 0, completed: Number(msg.completed) || 0,
      failed: Number(msg.failed) || 0, scanning: Boolean(msg.scanning) });
    saveSessionSoon(); updateBadge(tabId).catch(() => {});
  }
  return { ok: true };
}
browser.runtime.onMessage.addListener((msg, sender) => ready.then(() => handleMessage(msg, sender)));

// Firefox emits these even when JavaScript changes the address bar without
// replacing the document. A background event is more reliable than polling
// alone, especially for Kiwix viewer#book/article navigation.
async function sameDocumentNavigation(details) {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return;
  await ready;
  await pageLocationChanged(details.tabId, details.url);
}
if (browser.webNavigation?.onHistoryStateUpdated) {
  browser.webNavigation.onHistoryStateUpdated.addListener(sameDocumentNavigation);
}
if (browser.webNavigation?.onReferenceFragmentUpdated) {
  browser.webNavigation.onReferenceFragmentUpdated.addListener(sameDocumentNavigation);
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  await ready;
  try { const tab = await browser.tabs.get(tabId); if (isPage(tab.url)) { lastWebTab = tabId; saveSessionSoon(); } }
  catch (_) { /* Tab closed during activation. */ }
});
browser.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== "loading" && change.status !== "complete" && !change.url) return;
  await ready;
  const currentUrl = change.url || await rememberPageUrl(tabId);
  const newUrl = normalizedPageUrl(currentUrl);
  if (change.status === "loading") {
    navigationVersions.set(tabId, (navigationVersions.get(tabId) || 0) + 1);
    jobs.delete(tabId);
    tabLocations.set(tabId, newUrl);
    saveSessionSoon();
    await updateBadge(tabId);
  } else if (newUrl && newUrl !== tabLocations.get(tabId)) {
    await pageLocationChanged(tabId, newUrl);
  }
  if (change.status === "complete" && enabledTabs.has(tabId) && newUrl) {
    await ensurePageStart(tabId);
  }
});
browser.tabs.onRemoved.addListener(async tabId => {
  await ready;
  jobs.delete(tabId); tabLocations.delete(tabId); navigationVersions.delete(tabId);
  enabledTabs.delete(tabId); selectionTabPrefs.delete(tabId);
  selectionPendingByTab.delete(tabId);
  if (lastWebTab === tabId) lastWebTab = null;
  saveSessionSoon();
});
ready.then(async () => {
  for (const id of new Set([...jobs.keys(), ...tabLocations.keys()])) await updateBadge(id);
});

// tabs.sendMessage() cannot reach a document with no content-script listener.
// This commonly happens with tabs already open before extension installation,
// reloads, or new frames. Inject only the clicked frame, then retry once.
function noSelectionReceiver(error) {
  const message = String(error?.message || error || "");
  return /receiving end does not exist|could not establish connection|no receiving end|message port closed/i.test(message);
}
async function sendSelectionToFrame(tabId, frameId, payload) {
  const options = { frameId };
  try {
    return await browser.tabs.sendMessage(tabId, payload, options);
  } catch (error) {
    if (!noSelectionReceiver(error)) throw error;
    if (!browser.scripting?.executeScript) {
      throw new Error("Cannot load the selection translator in this frame. Reload the page and try again.");
    }
    let results;
    try {
      results = await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["code_prose.js", "content.js"]
      });
    } catch (injectionError) {
      throw new Error("Firefox cannot access this frame. Check the extension's website permissions or reload the page. " +
        String(injectionError?.message || injectionError));
    }
    if (!Array.isArray(results) || !results.some(result => result.frameId === frameId && !result.error)) {
      const detail = results?.find(result => result.error)?.error;
      throw new Error("The selection translator could not start in the selected frame. " +
        String(detail?.message || detail || "Try reloading this page."));
    }
    return browser.tabs.sendMessage(tabId, payload, options);
  }
}

// One context-menu action. Language choices live in the popup for the tab
// where selection translation was requested.
const SELECTION_MENU_ID = "ribs-translate-selection-to-page-language";
if (browser.contextMenus) {
  browser.contextMenus.create({
    id: SELECTION_MENU_ID,
    title: "LibreTranslate Selection",
    contexts: ["selection", "editable"]
  });
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== SELECTION_MENU_ID || !Number.isInteger(tab?.id)) return;
    const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
    let failure = null;
    // Count each selection request as one operation. Multiple overlapping
    // selections count down 2, 1, and then the original page badge returns.
    await countSelectionRequest(tab.id, 1);
    try {
      await ready;
      const settings = await browser.storage.local.get("serverUrl");
      const prefs = selectionPreferencesForTab(tab.id, settings.serverUrl || "");
      const payload = { type: "REVERSE_SELECTION", selectionText: info.selectionText || "",
        selectionSource: prefs.source, selectionTarget: prefs.target };
      const response = await sendSelectionToFrame(tab.id, frameId, payload);
      if (!response?.ok) throw new Error(response?.error || "Selection was not translated.");
    } catch (error) {
      failure = String(error?.message || error);
      console.warn(`LibreTranslate Selection failed in tab ${tab.id}, frame ${frameId}:`, error);
    } finally {
      await countSelectionRequest(tab.id, -1);
    }
    if (failure && !selectionPendingByTab.has(tab.id)) {
      // Error feedback is temporary too. The full-page badge is restored.
      await Promise.all([
        browser.action.setBadgeText({ tabId: tab.id, text: "!" }),
        browser.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b91c1c" }),
        browser.action.setTitle({ tabId: tab.id, title: `LibreTranslate Selection: ${failure.slice(0, 150)}` })
      ]).catch(() => {});
      setTimeout(() => {
        if (!selectionPendingByTab.has(tab.id)) updateBadge(tab.id).catch(() => {});
      }, 2500);
    }
  });
}
