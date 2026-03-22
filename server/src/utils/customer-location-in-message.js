'use strict';

/**
 * Heuristik: Nennt der Kunde in dieser Nachricht seinen Wohnort / Herkunftsort
 * (nicht nur eine allgemeine Nähe wie „in der Nähe“)?
 * @param {string} text
 * @returns {boolean}
 */
function customerStatesOwnLocationInMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 4) return false;
  // wohne/lebe in [Ort] — nicht nur „in der Nähe“
  if (/\b(?:ich\s+)?(?:wohn\w*|leb\w*)\s+in\s+(?!der\s+(?:nähe|naehe)\b)([a-zäöüßA-ZÄÖÜ][\wäöüß\-.]*(?:\s+[\wäöüß\-.]+){0,4})/i.test(t)) return true;
  // komme/bin aus [Ort]
  if (/\b(?:ich\s+)?(?:komme|komm|bin)\s+aus\s+(?!der\b)([a-zäöüßA-ZÄÖÜ])/i.test(t)) return true;
  // umgangssprachlich: „bin in Hamm“, „steck in …“
  if (/\b(?:ich\s+)?bin\s+in\s+[A-ZÄÖÜa-zäöüß][\wäöüß\-]+/i.test(t)) return true;
  return false;
}

module.exports = { customerStatesOwnLocationInMessage };
