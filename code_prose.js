/* SPDX-License-Identifier: MIT */
"use strict";

// A conservative, language-agnostic detector for explanatory prose placed in
// <code> or <pre> by a website. It does not rewrite or parse program source.
(() => {
  function looksLikeProseCode(value) {
    if (typeof value !== "string") return false;
    const text = value.slice(0, 24000).trim();
    if (text.length < 70) return false;

    // Literal HTML/XML source (including escaped markup exposed as textContent)
    // must remain byte-for-byte intact. An actual <span>/<br> DOM child is fine:
    // these tags do not appear in textContent.
    if (/<\/?\s*[a-z][\w:-]*(?:\s[^<>]*)?\s*\/?\s*>/i.test(text) ||
        /<\?(?:php|xml|=)/i.test(text) || /<!doctype\s/i.test(text)) return false;

    // Strong signals of executable source / structured data. Natural-language
    // paragraphs sometimes contain a few punctuation marks, so reject syntax
    // forms rather than individual occurrences of punctuation.
    if (/(?:^|\n)\s*(?:def\s+\w+\s*\(|function\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=|import\s+\w+|from\s+\w+\s+import\b|#include\s*[<"]|(?:public|private|protected)\s+(?:static\s+)?(?:function|class)|(?:SELECT|INSERT|UPDATE|DELETE)\s+\S+\s+(?:FROM|INTO|SET)\b)/im.test(text)) return false;
    if (/(?:=>|\$[A-Za-z_]\w*\s*=|\b(?:console\.log|document\.querySelector|echo\s+\$)\b)/i.test(text)) return false;

    const words = text.match(/[\p{L}][\p{L}\p{M}'’\-]*/gu) || [];
    if (words.length < 14) return false;
    const letters = (text.match(/\p{L}/gu) || []).length;
    const nonWhitespace = text.replace(/\s/g, "").length;
    if (!nonWhitespace || letters / nonWhitespace < 0.67) return false;

    // A code listing normally has high punctuation density and assignments,
    // while prose has word groups and normal sentence boundaries.
    const sourceSymbols = (text.match(/[{};$=]/g) || []).length;
    if (sourceSymbols > 3 && sourceSymbols / words.length > 0.13) return false;
    if (words.length < 24 && !/[.!?](?:\s|$)/.test(text)) return false;
    return true;
  }
  globalThis.ribsCodeProse = Object.freeze({ looksLikeProseCode });
})();
