/**
 * Optionales Debug-Logging für die Auflösung des Fake-Vornamens (Render / stdout).
 * Aktivierung: CHATAI_DEBUG_FAKE_NAME=1 (oder true/yes/on), z. B. in Render → Environment.
 */

"use strict";

function isChataiFakeNameDebugEnabled() {
  const v = String(process.env.CHATAI_DEBUG_FAKE_NAME || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * @param {string} stage z. B. resolveSafeFakeFirstNameForPrompt
 * @param {Record<string, unknown>} payload
 */
function logChataiFakeNameResolution(stage, payload) {
  if (!isChataiFakeNameDebugEnabled()) return;
  const ts = new Date().toISOString();
  const obj = { ts, stage, ...payload };
  try {
    const s = JSON.stringify(obj);
    const max = 12000;
    console.log("[CHATAI_DEBUG_FAKE_NAME]", s.length > max ? `${s.slice(0, max)}…(truncated)` : s);
  } catch (e) {
    console.log("[CHATAI_DEBUG_FAKE_NAME]", ts, stage, e && e.message ? e.message : e);
  }
}

/**
 * Kurze, sichere Vorschau der moderatorInfo-Felder (kein komplettes rawText).
 * @param {object|null|undefined} m
 */
function moderatorInfoSnapshotForDebug(m) {
  if (!m || typeof m !== "object") return {};
  const pick = (key, maxLen) => {
    const v = m[key];
    if (v == null) return undefined;
    const str = String(v).trim();
    if (!str) return undefined;
    return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
  };
  const raw = m.rawText;
  let rawPreview;
  if (typeof raw === "string" && raw.length) {
    const t = raw.replace(/\s+/g, " ").trim();
    rawPreview = t.length > 160 ? `${t.slice(0, 160)}…` : t;
  }
  return {
    name: pick("name", 120),
    Vorname: pick("Vorname", 120),
    firstName: pick("firstName", 120),
    username: pick("username", 80),
    displayName: pick("displayName", 120),
    city: pick("city", 80),
    Wohnort: pick("Wohnort", 80),
    rawTextChars: typeof raw === "string" ? raw.length : 0,
    rawTextPreview: rawPreview
  };
}

module.exports = {
  isChataiFakeNameDebugEnabled,
  logChataiFakeNameResolution,
  moderatorInfoSnapshotForDebug
};
