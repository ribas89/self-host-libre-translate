/* SPDX-License-Identifier: MIT */
"use strict";
const el = id => document.getElementById(id);
const FALLBACK_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "pt-BR", name: "Portuguese (Brazil)" },
  { code: "pt", name: "Portuguese" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese" },
  { code: "ru", name: "Russian" },
  { code: "ar", name: "Arabic" }
];
let activeTabId = null;
let privacyAccepted = false;
function fillSelect(node, languages, current, auto) {
  const seen = new Set();
  const list = [];
  if (auto) list.push({ code: "auto", name: "Auto" });
  for (const language of languages) {
    if (!language?.code || seen.has(language.code)) continue;
    seen.add(language.code);
    list.push(language);
  }
  if (current && !list.some(x => x.code === current)) list.push({ code: current, name: current });
  node.replaceChildren(...list.map(language => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.name;
    return option;
  }));
  if (current) node.value = current;
}
function message(text, bad = false) {
  el("connection").textContent = text;
  el("connection").classList.toggle("bad", bad);
}
function settingsFromForm() {
  return { serverUrl: el("server").value.trim(), source: el("source").value, target: el("target").value };
}
async function saveSettings() {
  const settings = settingsFromForm();
  await browser.storage.local.set(settings);
  return settings;
}
function renderStatus(s) {
  if (!s) return;
  el("error").hidden = !s.error;
  el("error").textContent = s.error || "";
  let heading = "Ready";
  if (s.status === "running") heading = "Translating";
  else if (s.status === "complete") heading = s.failed ? "Finished with errors" : "Translation complete";
  else if (s.status === "error") heading = "Translation error";
  else if (s.status === "waiting") heading = "Ready to translate";
  el("status").textContent = heading;
  el("percent").textContent = s.status === "running" ? `${s.pending} remaining` :
    s.status === "complete" ? "0 remaining" : "";
  el("bar").style.width = `${s.percent || 0}%`;
  if (["running", "complete"].includes(s.status)) {
    el("details").textContent = `${s.completed} of ${s.total} blocks processed, ${s.failed} failed, ${s.frames} frame(s)`;
  } else if (s.status === "error") {
    el("details").textContent = "Check your server connection and translation API.";
  } else if (s.pageEnabled) {
    el("details").textContent = "Translation is ON in this tab. It will also translate the next page you visit here.";
  } else {
    el("details").textContent = "Translation is OFF in this tab. Use the header switch to turn it on.";
  }
  el("print").disabled = s.status !== "complete";
  el("restore").disabled = !["running", "complete", "error"].includes(s.status);
  const toggle = el("page-toggle");
  toggle.setAttribute("aria-checked", String(!!s.pageEnabled));
  toggle.setAttribute("aria-label", s.pageEnabled ? "Disable translation in this tab" : "Enable translation in this tab");
  toggle.title = toggle.getAttribute("aria-label");
  toggle.querySelector(".toggle-label").textContent = s.pageEnabled ? "ON" : "OFF";
  toggle.disabled = activeTabId == null || !privacyAccepted;
  el("page-scope").textContent = s.pageUrl ?
    "This switch follows the current tab across websites and article navigation. Other tabs remain independent." :
    "Open a normal webpage to change translation for this tab.";
}
function fillSelectionSelect(node, languages, current, autoLabel) {
  const options = [{ code: "auto", name: autoLabel }, ...languages];
  const unique = new Set();
  node.replaceChildren(...options.filter(lang => {
    if (!lang?.code || unique.has(lang.code)) return false;
    unique.add(lang.code);
    return true;
  }).map(lang => {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = lang.name;
    return option;
  }));
  node.value = options.some(x => x.code === current) ? current : "auto";
}
async function refreshSelectionSettings() {
  if (activeTabId === null) return;
  const data = await browser.runtime.sendMessage({type: "GET_SELECTION_SETTINGS", tabId: activeTabId});
  fillSelectionSelect(el("selection-source"), data.languages, data.source, "Auto");
  fillSelectionSelect(el("selection-target"), data.languages, data.target, "Auto");
  el("selection-source").disabled = !data.languages.length;
  el("selection-target").disabled = !data.languages.length;
}
async function saveSelectionSettings() {
  if (activeTabId === null) return;
  try {
    const data = await browser.runtime.sendMessage({
      type: "SET_SELECTION_SETTINGS", tabId: activeTabId,
      source: el("selection-source").value, target: el("selection-target").value
    });
    if (data.source !== el("selection-source").value || data.target !== el("selection-target").value)
      await refreshSelectionSettings();
  } catch (error) {
    message(error.message || String(error), true);
    await refreshSelectionSettings();
  }
}
async function refreshStatus() {
  if (activeTabId == null) return;
  const status = await browser.runtime.sendMessage({ type: "GET_STATUS", tabId: activeTabId });
  renderStatus(status);
}
async function checkServer() {
  if (!privacyAccepted) {
    await browser.runtime.sendMessage({type: "OPEN_PRIVACY_PAGE"});
    return message("Review privacy choices before connecting.", true);
  }
  const serverUrl = el("server").value.trim();
  if (!serverUrl) return message("Enter your server URL.", true);
  el("test").disabled = true;
  message("Checking the LibreTranslate API...");
  try {
    const result = await browser.runtime.sendMessage({ type: "CHECK_SERVER", serverUrl });
    el("server").value = result.serverUrl;
    const previousSource = el("source").value;
    const previousTarget = el("target").value;
    fillSelect(el("source"), result.languages, previousSource, true);
    fillSelect(el("target"), result.languages, previousTarget, true);
    await saveSettings();
    await refreshSelectionSettings();
    message(`Connected to your server (${result.languages.length} languages).`);
  } catch (e) { message(e.message || String(e), true); }
  finally { el("test").disabled = false; }
}
async function togglePage() {
  if (!privacyAccepted) {
    await browser.runtime.sendMessage({type:"OPEN_PRIVACY_PAGE"});
    return message("Review privacy choices before translating.", true);
  }
  if (activeTabId == null) return;
  const toggle = el("page-toggle");
  const enabled = toggle.getAttribute("aria-checked") !== "true";
  const settings = await saveSettings();
  if (enabled && !settings.serverUrl) return message("Set and test a translation server first.", true);
  toggle.disabled = true;
  message("");
  try {
    const status = await browser.runtime.sendMessage({
      type: "SET_PAGE_ENABLED", tabId: activeTabId, enabled, settings
    });
    renderStatus(status);
  } catch (e) { message(e.message || String(e), true); await refreshStatus(); }
  finally { toggle.disabled = activeTabId == null; }
}
async function saveLanguageChange() {
  if (activeTabId == null) return;
  const settings = await saveSettings();
  // Applying a new language should restart only the enabled tab.
  if (el("page-toggle").getAttribute("aria-checked") !== "true") return;
  try {
    renderStatus(await browser.runtime.sendMessage({
      type: "SET_PAGE_ENABLED", tabId: activeTabId, enabled: true, settings
    }));
  } catch (e) { message(e.message || String(e), true); }
}
async function restore() {
  if (activeTabId == null) return;
  const settings = await saveSettings();
  renderStatus(await browser.runtime.sendMessage({
    type: "SET_PAGE_ENABLED", tabId: activeTabId, enabled: false, settings
  }));
}
async function printCurrent() {
  if (activeTabId == null) return;
  try { await browser.tabs.sendMessage(activeTabId, { type: "PRINT" }, { frameId: 0 }); }
  catch (e) { message(e.message || String(e), true); }
}
function renderCacheSettings(stats) {
  const toggle = el("cache-toggle");
  toggle.disabled = !privacyAccepted;
  toggle.setAttribute("aria-checked", String(!!stats.enabled));
  toggle.querySelector(".cache-toggle-label").textContent = stats.enabled ? "ON" : "OFF";
  toggle.title = stats.enabled ? "Disable saved translations" : "Enable saved translations";
  el("cache-status").textContent = stats.enabled
    ? `${stats.blocks} translated blocks saved across ${stats.pages} page(s). Changed text is translated again.`
    : "Caching is OFF. No page translations are stored. Private tabs never use saved translations.";
}
async function updateCacheStats() {
  try { renderCacheSettings(await browser.runtime.sendMessage({ type: "CACHE_STATS" })); }
  catch (_) { el("cache-status").textContent = "Cache settings unavailable."; }
}
async function toggleCaching() {
  if (!privacyAccepted) return message("Review privacy choices before enabling caching.", true);
  const toggle = el("cache-toggle");
  const enabled = toggle.getAttribute("aria-checked") !== "true";
  toggle.disabled = true;
  try {
    renderCacheSettings(await browser.runtime.sendMessage({ type: "SET_CACHE_ENABLED", enabled }));
    message(enabled ? "Caching enabled for normal tabs." : "Caching disabled. Saved translations cleared.");
  } catch (error) { message(error.message || String(error), true); await updateCacheStats(); }
  finally { toggle.disabled = false; }
}
async function clearCache() {
  el("clear-cache").disabled = true;
  try {
    await browser.runtime.sendMessage({ type: "CLEAR_PAGE_CACHE" });
    await updateCacheStats();
    message("Saved translations cleared.");
  } catch (error) { message(error.message || String(error), true); }
  finally { el("clear-cache").disabled = false; }
}
async function initialize() {
  fillSelect(el("source"), FALLBACK_LANGUAGES, "auto", true);
  fillSelect(el("target"), FALLBACK_LANGUAGES, "auto", true);
  const privacy = await browser.runtime.sendMessage({type:"GET_PRIVACY_STATUS"});
  privacyAccepted = privacy?.status === "accepted";
  el("privacy-banner").hidden = privacyAccepted;
  el("test").disabled = !privacyAccepted;
  // Get the background context first so its one-time target migration finishes
  // before the popup reads saved settings.
  const context = await browser.runtime.sendMessage({ type: "GET_CONTEXT_TAB" });
  activeTabId = context?.tabId ?? null;
  const settings = await browser.storage.local.get({ serverUrl: "", source: "auto", target: "auto" });
  el("server").value = settings.serverUrl;
  fillSelect(el("source"), FALLBACK_LANGUAGES, settings.source, true);
  fillSelect(el("target"), FALLBACK_LANGUAGES, settings.target, true);
  if (activeTabId == null) {
    el("page-toggle").disabled = true;
    message("Open a normal website before translating.", true);
  } else await refreshStatus();
  await updateCacheStats();
  await refreshSelectionSettings();
  if (settings.serverUrl && privacyAccepted) {
    try {
      const data = await browser.runtime.sendMessage({ type: "CHECK_SERVER", serverUrl: settings.serverUrl });
      fillSelect(el("source"), data.languages, settings.source, true);
      fillSelect(el("target"), data.languages, settings.target, true);
      await refreshSelectionSettings();
      message(`Connected to your server (${data.languages.length} languages).`);
    } catch (e) { message(`Server unavailable: ${e.message}`, true); }
  }
}
browser.runtime.onMessage.addListener(msg => {
  if (msg?.type === "STATUS_PUSH" && msg.status?.tabId === activeTabId) renderStatus(msg.status);
});
el("test").addEventListener("click", checkServer);
el("privacy-review").addEventListener("click", () => {
  browser.runtime.sendMessage({type:"OPEN_PRIVACY_PAGE"}).catch(e => message(e.message || String(e), true));
});
el("page-toggle").addEventListener("click", togglePage);
el("source").addEventListener("change", saveLanguageChange);
el("target").addEventListener("change", saveLanguageChange);
el("selection-source").addEventListener("change", saveSelectionSettings);
el("selection-target").addEventListener("change", saveSelectionSettings);
el("restore").addEventListener("click", restore);
el("print").addEventListener("click", printCurrent);
el("clear-cache").addEventListener("click", clearCache);
el("cache-toggle").addEventListener("click", toggleCaching);
initialize().catch(e => message(e.message || String(e), true));
