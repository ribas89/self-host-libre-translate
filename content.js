/* SPDX-License-Identifier: MIT */
"use strict";

(() => {
  // A right-click may inject this script into a previously opened tab or a
  // newly created frame. Keep only one message listener and one set of DOM
  // observers per document, even when Firefox injects it more than once.
  if (globalThis.__ribsPageTranslatorContentInitialized) return;
  globalThis.__ribsPageTranslatorContentInitialized = true;
  const SKIP = "script,style,noscript,textarea,kbd,samp,svg,math,title,select,option,optgroup,[translate='no'],.notranslate,[contenteditable='true'],[data-ribs-selection-result]";
  const ATTRIBUTE_SKIP = `${SKIP},code,pre`;
  const TRANS_ATTRS = ["title", "alt", "placeholder", "aria-label"];
  const BATCH_MAX_ITEMS = 10;
  const BATCH_MAX_CHARS = 2200;
  let current = null;

  function report(run, scanning) {
    if (current !== run || run.stopped) return;
    browser.runtime.sendMessage({
      type: "FRAME_PROGRESS", runId: run.id,
      total: run.total, completed: run.completed, failed: run.failed,
      scanning
    }).catch(() => {});
  }
  function eligibleText(node, codeClassification) {
    const p = node.parentElement;
    if (!p || !node.nodeValue || !/[\p{L}]/u.test(node.nodeValue) || !node.nodeValue.trim()) return false;
    try {
      if (p.closest(SKIP) || p.isContentEditable) return false;
      const codeBlock = p.closest("code,pre");
      if (!codeBlock) return true;
      if (!codeClassification.has(codeBlock)) {
        codeClassification.set(codeBlock,
          Boolean(globalThis.ribsCodeProse?.looksLikeProseCode(codeBlock.textContent || "")));
      }
      return codeClassification.get(codeBlock);
    } catch (_) { return false; }
  }
  function stopRun(run, restore) {
    if (!run || run.stopped) return;
    run.stopped = true;
    if (run.observer) run.observer.disconnect();
    if (run.scanTimer) clearTimeout(run.scanTimer);
    if (restore) {
      for (const item of run.records) {
        try {
          if (item.kind === "text") {
            if (item.node.isConnected) item.node.nodeValue = item.original;
          } else if (item.node.isConnected) {
            item.node.setAttribute(item.attr, item.original);
          }
        } catch (_) { /* Removed/replaced node. */ }
      }
    }
    run.queue.length = 0;
  }
  async function waitForStablePage(run) {
    if (document.readyState !== "complete") {
      await new Promise(resolve => {
        const done = () => { window.removeEventListener("load", done); resolve(); };
        window.addEventListener("load", done, { once: true });
        setTimeout(done, 8000);
      });
    }
    if (run.stopped) return;
    // Wait for roughly 900ms of DOM calm, but don't wait forever on polling SPAs.
    await new Promise(resolve => {
      let quiet = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(quiet); clearTimeout(cap);
        resolve();
      };
      const reset = () => { clearTimeout(quiet); quiet = setTimeout(finish, 900); };
      let cap;
      const observer = new MutationObserver(reset);
      try { observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); }
      catch (_) { finish(); return; }
      cap = setTimeout(finish, 9000);
      reset();
    });
  }
  function markText(run, node, codeClassification) {
    if (!eligibleText(node, codeClassification)) return;
    const value = node.nodeValue;
    const existing = run.textRecords.get(node);
    if (existing) {
      // Ignore our own replacement. Pick up changes made by the original site.
      if (existing.original === value || existing.translated === value || existing.pendingText === value) return;
      existing.original = value;
      existing.translated = null;
      existing.pendingText = value;
      run.queue.push(existing);
      run.total++;
      return;
    }
    const record = { kind: "text", node, original: value, pendingText: value, translated: null };
    run.textRecords.set(node, record);
    run.records.add(record);
    run.queue.push(record);
    run.total++;
  }
  function markAttributes(run) {
    for (const element of document.querySelectorAll("[title],[alt],[placeholder],[aria-label]")) {
      if (element.closest(ATTRIBUTE_SKIP)) continue;
      for (const attr of TRANS_ATTRS) {
        const val = element.getAttribute(attr);
        if (!val || !val.trim() || !/[\p{L}]/u.test(val)) continue;
        let byAttr = run.attrRecords.get(element);
        if (!byAttr) { byAttr = new Map(); run.attrRecords.set(element, byAttr); }
        const existing = byAttr.get(attr);
        if (existing) {
          if (existing.original === val || existing.translated === val || existing.pendingText === val) continue;
          existing.original = val;
          existing.translated = null;
          existing.pendingText = val;
          run.queue.push(existing);
          run.total++;
        } else {
          const record = { kind: "attribute", node: element, attr, original: val, pendingText: val, translated: null };
          byAttr.set(attr, record);
          run.records.add(record);
          run.queue.push(record);
          run.total++;
        }
      }
    }
  }
  function scanAll(run) {
    if (run.stopped || current !== run || !document.body) return;
    const before = run.total;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const codeClassification = new WeakMap();
    let n;
    while ((n = walker.nextNode())) markText(run, n, codeClassification);
    markAttributes(run);
    if (run.total !== before) {
      report(run, true);
      processQueue(run).catch(err => reportError(run, err));
    }
  }
  function reportError(run, error) {
    if (run.stopped || current !== run) return;
    run.fatal = true;
    run.queue.length = 0;
    browser.runtime.sendMessage({
      type: "FRAME_ERROR", runId: run.id, error: String(error?.message || error)
    }).catch(() => {});
  }
  function scheduleScan(run) {
    if (run.stopped || run.scanTimer) return;
    run.scanTimer = setTimeout(() => {
      run.scanTimer = null;
      scanAll(run);
    }, 420);
  }
  function trimParts(text) {
    const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { left: match[1], core: match[2], right: match[3] };
  }
  function takeBatch(run) {
    const items = [];
    let charCount = 0;
    while (run.queue.length && items.length < BATCH_MAX_ITEMS) {
      const next = run.queue[0];
      const core = trimParts(next.pendingText).core;
      if (items.length && charCount + core.length > BATCH_MAX_CHARS) break;
      run.queue.shift();
      items.push(next);
      charCount += core.length;
    }
    return items;
  }
  async function processQueue(run) {
    if (run.workerActive || run.stopped || run.fatal || current !== run) return;
    run.workerActive = true;
    try {
      while (run.queue.length && !run.stopped && current === run) {
        const items = takeBatch(run);
        const contents = items.map(item => trimParts(item.pendingText).core);
        try {
          const translations = await browser.runtime.sendMessage({
            type: "TRANSLATE_BATCH", runId: run.id,
            source: run.source, target: run.target, texts: contents
          });
          if (run.stopped || current !== run) return;
          if (!Array.isArray(translations) || translations.length !== items.length) {
            throw new Error("The server returned an incomplete translation batch.");
          }
          // Apply translations directly to existing text nodes. No animations,
          // wrapper elements, CSS classes, attributes, or visual timers.
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const { left, right } = trimParts(item.pendingText);
            const result = `${left}${translations[i]}${right}`;
            const live = item.kind === "text" ? item.node.nodeValue : item.node.getAttribute(item.attr);
            // Do not overwrite content that the website changed during the API request.
            if (live === item.pendingText && !run.stopped && current === run) {
              item.translated = result;
              if (item.kind === "text") item.node.nodeValue = result;
              else item.node.setAttribute(item.attr, result);
            }
            run.completed++;
          }
          run.consecutiveFailures = 0;
        } catch (error) {
          if (run.stopped) return;
          run.failed += items.length;
          run.completed += items.length;
          run.consecutiveFailures++;
          if (run.consecutiveFailures >= 2) {
            reportError(run, error);
            return;
          }
        }
        report(run, true);
      }
    } finally {
      run.workerActive = false;
      if (!run.stopped && !run.fatal && current === run) report(run, false);
    }
  }
  async function startRun(msg) {
    if (current && current.id === msg.runId) return;
    if (current) stopRun(current, true);
    const run = {
      id: msg.runId, source: msg.source, target: msg.target,
      total: 0, completed: 0, failed: 0, records: new Set(),
      textRecords: new WeakMap(), attrRecords: new WeakMap(),
      queue: [], workerActive: false, stopped: false, fatal: false,
      scanTimer: null, observer: null, consecutiveFailures: 0
    };
    current = run;
    report(run, true);
    try {
      await waitForStablePage(run);
      if (run.stopped || current !== run) return;
      run.observer = new MutationObserver(() => scheduleScan(run));
      run.observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: TRANS_ATTRS
      });
      scanAll(run);
      if (!run.total) report(run, false);
    } catch (e) { reportError(run, e); }
  }
  // Snapshot the selection before Firefox's context menu can move focus.
  // Firefox's window.getSelection() does not represent selected input text.
  let capturedSelection = null;
  function isTextField(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.matches("textarea")) return !node.disabled && !node.readOnly;
    return node.matches("input") && /^(text|search|email|url|tel)$/i.test(node.type) &&
      !node.disabled && !node.readOnly;
  }
  function editableRoot(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest?.("[contenteditable='true'],[contenteditable=''],[contenteditable='plaintext-only']") || null;
  }
  function deepestActiveElement(root = document) {
    let active = root.activeElement || null;
    // document.activeElement is the custom-element host for open shadow roots.
    // Follow focus to the actual search input when available.
    for (let depth = 0; depth < 12 && active?.shadowRoot?.activeElement; depth++) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }
  function eventSelectionTarget(event) {
    // Browser UI events cross shadow-root boundaries, but event.target is
    // retargeted to the host. composedPath() identifies the actual input.
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    return path.find(node => isTextField(node)) ||
      path.find(node => node?.nodeType === 1 && editableRoot(node)) ||
      deepestActiveElement() || event?.target || null;
  }
  function snapshotSelection(target) {
    const el = target?.nodeType === 1 ? target : target?.parentElement;
    const field = (isTextField(el) ? el : el?.closest?.("textarea,input")) ||
      deepestActiveElement();
    if (isTextField(field) && typeof field.selectionStart === "number") {
      const start = field.selectionStart, end = field.selectionEnd;
      if (end > start) return {
        kind: "field", node: field, start, end, text: field.value.slice(start, end)
      };
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (!range.toString().trim()) return null;
    const root = editableRoot(range.commonAncestorContainer);
    return { kind: root ? "editable" : "page", root, range, text: range.toString() };
  }
  // Firefox's context-menu text may have line endings or whitespace formatted
  // differently from a textarea's actual selected value. The field selection
  // is authoritative; the menu's text is only a hint, never the replacement.
  function normalizedSelectionText(value) {
    return String(value || "").replace(/\r\n?/g, "\n")
      .replace(/[\u00a0\u2007\u202f]/g, " ")
      .replace(/\s+/gu, " ").trim();
  }
  function selectionHintMatches(actual, hint) {
    if (!hint) return true;
    const a = normalizedSelectionText(actual);
    const h = normalizedSelectionText(hint);
    if (!a || !h) return false;
    if (a === h) return true;
    // An older Firefox context-menu implementation may provide an abbreviated
    // selection. Only accept such hints when the common prefix is substantial.
    return Math.min(a.length, h.length) >= 60 && (a.startsWith(h) || h.startsWith(a));
  }
  function snapshotStillExists(entry) {
    if (!entry) return false;
    if (entry.kind === "field") {
      return entry.node?.isConnected &&
        entry.node.value.slice(entry.start, entry.end) === entry.text && entry.end > entry.start;
    }
    return entry.range?.startContainer?.isConnected &&
      entry.range?.endContainer?.isConnected && entry.range.toString() === entry.text;
  }
  function selectionIsUsable(entry, menuText) {
    if (!snapshotStillExists(entry)) return false;
    if (selectionHintMatches(entry.text, menuText)) return true;
    // A freshly captured right-click on an editable field is more reliable
    // than the browser's menu string, particularly for multiline selections.
    return entry.kind === "field" && entry.fromContextMenu === true;
  }
  function rememberSelection(target, fromContextMenu = false) {
    const snapshot = snapshotSelection(target);
    if (snapshot) capturedSelection = { ...snapshot, fromContextMenu };
    else if (fromContextMenu) capturedSelection = null;
  }
  const captureEventSelection = event =>
    rememberSelection(eventSelectionTarget(event), event.type === "contextmenu");
  document.addEventListener("select", captureEventSelection, true);
  document.addEventListener("mouseup", captureEventSelection, true);
  document.addEventListener("keyup", captureEventSelection, true);
  document.addEventListener("contextmenu", captureEventSelection, true);

  // If Firefox opens its native context menu before this script has been
  // injected, we missed the contextmenu event and may no longer have focus.
  // Recover a selected input/textarea by matching the selected text supplied
  // by contextMenus.onClicked. Search open shadow roots as well as the page.
  function recoverFieldSelection(menuText) {
    if (!menuText) return null;
    const matches = [];
    const roots = [document];
    let inspected = 0;
    for (let i = 0; i < roots.length && i < 120; i++) {
      const root = roots[i];
      for (const field of root.querySelectorAll("input,textarea")) {
        if (!isTextField(field) || typeof field.selectionStart !== "number") continue;
        const start = field.selectionStart, end = field.selectionEnd;
        const actual = end > start ? field.value.slice(start, end) : "";
        if (actual && selectionHintMatches(actual, menuText)) {
          matches.push({ kind: "field", node: field, start, end, text: actual });
          if (matches.length > 1) return null; // Do not guess between fields.
        }
      }
      for (const host of root.querySelectorAll("*")) {
        if (++inspected > 25000) break;
        if (host.shadowRoot) roots.push(host.shadowRoot);
      }
      if (inspected > 25000) break;
    }
    return matches.length === 1 ? matches[0] : null;
  }
  function pageSamples() {
    // Collect samples across the entire original document, not just its first
    // 2,500 characters. On translated pages, use our saved original records.
    const originals = [];
    if (current && !current.stopped) {
      for (const record of current.records) {
        if (record.kind !== "text" || !record.node.isConnected) continue;
        const original = String(record.original || "").trim();
        if (original && /[\p{L}]/u.test(original)) originals.push(original);
      }
    }
    if (!originals.length) {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && originals.length < 1400) {
        const parent = node.parentElement;
        if (!parent || parent.closest("script,style,noscript,textarea,input,select,option,[contenteditable],.notranslate")) continue;
        const value = String(node.nodeValue || "").trim();
        if (value && /[\p{L}]/u.test(value)) originals.push(value);
      }
    }
    if (!originals.length) return [];
    // Use three widely spaced parts of the page to avoid treating a localized
    // header, footer or forum advertisement as the entire page language.
    const groups = [[], [], []];
    const sizes = [0, 0, 0];
    const groupsCount = Math.min(3, originals.length);
    for (let i = 0; i < originals.length; i++) {
      const group = Math.min(groupsCount - 1, Math.floor(i * groupsCount / originals.length));
      if (sizes[group] >= 1500) continue;
      const value = originals[i].slice(0, 1500 - sizes[group]);
      groups[group].push(value);
      sizes[group] += value.length;
    }
    return groups.slice(0, groupsCount).map(items => items.join(" ").trim()).filter(Boolean);
  }
  function pageSample() { return pageSamples().join(" ").slice(0, 2500); }

  // Keep the selected text selected after the in-place replacement.
  function selectRange(range) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  function selectRecentlyInsertedText(root, replacement) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const endRange = selection.getRangeAt(0);
    if (!endRange.collapsed || !replacement) return false;
    // execCommand(insertText) usually leaves the caret after the inserted text.
    // This works when it leaves the caret in a single text node; otherwise the
    // manual Range fallback below is used for new DOM insertion.
    const node = endRange.startContainer;
    const end = endRange.startOffset;
    if (node?.nodeType !== Node.TEXT_NODE || end < replacement.length ||
        node.nodeValue.slice(end - replacement.length, end) !== replacement) return false;
    const range = document.createRange();
    range.setStart(node, end - replacement.length);
    range.setEnd(node, end);
    selectRange(range);
    return true;
  }
  function replaceCapturedText(original, replacement) {
    const entry = capturedSelection;
    if (!entry || entry.text !== original) return false;
    if (entry.kind === "field" && entry.node.isConnected) {
      const {node, start, end} = entry;
      if (node.value.slice(start, end) !== original) return false;
      const previousValue = node.value;
      const nextValue = previousValue.slice(0, start) + replacement + previousValue.slice(end);
      node.focus({ preventScroll: true });
      // Use the native prototype setter, not React's element-level value
      // tracker. This allows React-controlled search fields to receive the
      // subsequent input event and retain the change after a render.
      const prototype = node.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(node, nextValue);
      else node.value = nextValue;
      node.setSelectionRange(start, start + replacement.length);
      node.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true,
        inputType: "insertReplacementText", data: replacement }));
      // A framework can reject the change. Don't report success silently.
      if (node.value !== nextValue) return false;
      node.setSelectionRange(start, start + replacement.length);
      requestAnimationFrame(() => {
        if (node.isConnected && node.value === nextValue) {
          node.focus({ preventScroll: true });
          node.setSelectionRange(start, start + replacement.length);
        }
      });
      return true;
    }
    if ((entry.kind === "editable" || entry.kind === "page") && entry.range) {
      if (entry.range.toString() !== original) return false;
      if (entry.kind === "editable" && entry.root?.isConnected) {
        entry.root.focus({ preventScroll: true });
        selectRange(entry.range);
        // Preserve native editor undo if it supports insertText.
        try {
          if (document.execCommand?.("insertText", false, replacement)) {
            if (selectRecentlyInsertedText(entry.root, replacement)) return true;
            // The editor replaced the text, even if it moved the caret.
            return true;
          }
        } catch (_) { /* Fall through to Range replacement. */ }
      }
      // A selected excerpt in ordinary page content can also be translated
      // directly. Only the selection is replaced; there is no result popup.
      // Preserve a marked wrapper to stop page-auto-translation reverting it.
      const range = entry.range;
      if (!range.startContainer.isConnected || !range.endContainer.isConnected) return false;
      const span = document.createElement("span");
      span.setAttribute("data-ribs-selection-result", "");
      span.textContent = replacement;
      range.deleteContents();
      range.insertNode(span);
      const translatedRange = document.createRange();
      translatedRange.selectNodeContents(span);
      selectRange(translatedRange);
      if (entry.kind === "editable") {
        entry.root?.dispatchEvent(new InputEvent("input", { bubbles: true,
          inputType: "insertReplacementText", data: replacement }));
      }
      return true;
    }
    return false;
  }
  function showSelectionError(message) {
    // Only displayed on failure. Successful translations never open a panel.
    const notice = document.createElement("div");
    notice.textContent = `LibreTranslate Selection: ${message}`;
    notice.setAttribute("role", "alert");
    notice.style.cssText = "position:fixed;right:12px;bottom:12px;max-width:330px;" +
      "z-index:2147483647;padding:10px 12px;background:#8b1e27;color:white;" +
      "border-radius:6px;font:13px/1.4 sans-serif;box-shadow:0 2px 12px #0005";
    (document.body || document.documentElement).appendChild(notice);
    setTimeout(() => notice.remove(), 6500);
  }
  async function reverseSelection(msg) {
    const menuText = String(msg.selectionText || "");
    let snapshot = capturedSelection;
    if (!selectionIsUsable(snapshot, menuText)) {
      // The context menu may have moved focus. Only replace a selection that
      // we can still verify against the field's current value or a live Range.
      const activeSnapshot = snapshotSelection(deepestActiveElement());
      if (selectionIsUsable(activeSnapshot, menuText)) {
        snapshot = activeSnapshot;
        capturedSelection = snapshot;
      }
    }
    if (!selectionIsUsable(snapshot, menuText) && menuText) {
      snapshot = recoverFieldSelection(menuText);
      if (snapshot) capturedSelection = snapshot;
    }
    if (!selectionIsUsable(snapshot, menuText)) {
      const error = "Could not access the selected text field. Try selecting the text again.";
      showSelectionError(error);
      return { ok: false, error };
    }
    const text = snapshot.text;
    if (!text.trim()) return { ok: false, error: "No text selected." };
    try {
      const samples = pageSamples();
      const result = await browser.runtime.sendMessage({
        type: "TRANSLATE_SELECTION_TO_PAGE",
        text, pageSample: samples.join(" ").slice(0, 2500), pageSamples: samples,
        declaredLanguage: document.documentElement.lang,
        selectionSource: msg.selectionSource, selectionTarget: msg.selectionTarget
      });
      if (!result || typeof result.translated !== "string") throw new Error("No translation returned by the server.");
      const replaced = replaceCapturedText(text, result.translated);
      capturedSelection = null;
      if (!replaced) {
        const error = "The site changed or rejected the selected field before replacement.";
        showSelectionError(error);
        return { ok: false, error };
      }
      return { ok: true };
    } catch (error) {
      const message = String(error?.message || error);
      console.warn("LibreTranslate Selection failed:", error);
      showSelectionError(message);
      return { ok: false, error: message };
    }
  }

  browser.runtime.onMessage.addListener(msg => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "START_TRANSLATION") {
      startRun(msg).catch(e => reportError(current, e));
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "RESTORE") {
      if (current && (!msg.runId || msg.runId === current.id)) {
        stopRun(current, true); current = null;
      }
      return Promise.resolve({ ok: true });
    }
    if (msg.type === "REVERSE_SELECTION") {
      return reverseSelection(msg);
    }
    if (msg.type === "PRINT" && window === window.top) {
      window.print();
      return Promise.resolve({ ok: true });
    }
  });
  // Frames added after translation begins can join the active tab job.
  browser.runtime.sendMessage({ type: "FRAME_HELLO" })
    .then(msg => { if (msg?.active) startRun(msg); })
    .catch(() => {});
  if (window === window.top) {
    let lastUrl = window.location.href;
    const checkPageLocation = () => {
      const next = window.location.href;
      if (lastUrl === next) return;
      lastUrl = next;
      browser.runtime.sendMessage({ type: "PAGE_LOCATION_CHANGED", url: next }).catch(() => {});
    };
    window.addEventListener("hashchange", checkPageLocation);
    window.addEventListener("popstate", checkPageLocation);
    // Handles pushState-based SPA navigation without injecting code into the site.
    setInterval(checkPageLocation, 900);
  }
})();
