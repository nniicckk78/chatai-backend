/**
 * 🚀 GROK PIPELINE
 * Kompletter Generierungsweg mit xAI Grok für:
 * - ASA-Nachrichten
 * - Erstnachrichten
 * - Wohnort-/Stadtauswahl
 * - Normale Reply-Nachrichten
 *
 * Alle Regeln und Anweisungen werden aus dem bestehenden System übernommen.
 * Safety-Agent läuft weiter vor jeder Generierung.
 */

const { runSafetyCheck } = require('./safety-agent');
const { getGrokClient, getGrokModel, getClient } = require('../openaiClient');
const { selectSmartExamples } = require('./smart-example-selector');
let MistralClient;
try {
  const mistralPkg = require('@mistralai/mistralai');
  MistralClient = mistralPkg.Mistral || mistralPkg.default || null;
} catch (e) {
  MistralClient = null;
}
const { getLearningStats, generateCompactLearningContext } = require('./learning-system');
let correctAndImproveMessage;
try {
  correctAndImproveMessage = require('./grok-post-processor').correctAndImproveMessage;
} catch (e) {
  correctAndImproveMessage = async (opts) => (opts && opts.grokText != null) ? opts.grokText : '';
}

const GROK_TIMEOUT_MS = 30000;
const MAX_TOKENS = 350;
const MIN_MESSAGE_LENGTH = 120;
const OPENAI_SITUATION_TIMEOUT_MS = 15000;
const OPENAI_SITUATION_MAX_TOKENS = 120;
const OPENAI_PLAN_TIMEOUT_MS = 15000;
const OPENAI_PLAN_MAX_TOKENS = 150;
const OPENAI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

/** Entfernt ungepaarte UTF-16-Surrogate (z. B. durch .slice mitten in Emoji) – verhindert "unexpected end of hex escape" beim JSON-Parsen.
 *  Alle Wörter und vollständigen Zeichen (inkl. Emojis) bleiben erhalten. */
function removeUnpairedSurrogates(str) {
  if (str == null || typeof str !== 'string' || str.length === 0) return str || '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1);
      if (i + 1 < str.length && next >= 0xDC00 && next <= 0xDFFF) {
        out += str[i] + str[i + 1];
        i++;
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Ungepaartes Low-Surrogate (z. B. nach slice) weglassen
    } else {
      out += str[i];
    }
  }
  return out;
}

/** Entfernt/ersetzt Zeichen, die in JSON/API-Requests zu "unexpected end of hex escape" führen.
 *  Verhindert, dass \u im JSON als unvollständiges Unicode-Escape geparst wird.
 *  Alle Wörter bleiben erhalten; nur defekte Zeichenhälften (z. B. durch Emoji-Slice) werden entfernt. */
function sanitizeForApiContent(str) {
  if (str == null || typeof str !== 'string') return '';
  let s = removeUnpairedSurrogates(str);
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\u2028/g, ' ')
    .replace(/\u2029/g, ' ')
    .replace(/[\x00-\x1F]/g, (c) => (c === '\n' ? '\n' : ' '))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** Zeichen für Regex escapen (für Literalsuche). */
function escapeRegex(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Entfernt woertliche Wiederholungen der Kundennachricht aus der Moderatoren-Antwort (Post-Processing).
 * Nur laengere Phrasen (7+ Woerter) werden ersetzt, damit der Satz nicht zerhackt klingt.
 * Nach der Ersetzung: Aufräumen (mehrfaches "…" zusammenfassen, kein "…" am Anfang/Ende).
 * @param {string} customerMessage - aktuelle Kundennachricht
 * @param {string} replyText - generierte Moderatoren-Antwort
 * @returns {string} bereinigte Antwort
 */
function removeCustomerEcho(customerMessage, replyText) {
  if (!customerMessage || !replyText || typeof customerMessage !== 'string' || typeof replyText !== 'string') return replyText;
  const customer = customerMessage.trim().replace(/\s+/g, ' ');
  const reply = replyText;
  if (!customer || !reply.trim()) return reply;
  const customerWords = customer.split(/\s+/).filter(Boolean);
  if (customerWords.length < 7) return reply;
  let result = reply;
  const MIN_PHRASE_WORDS = 7;
  const MIN_PHRASE_LEN = 40;
  // Nur laengere Phrasen ersetzen, damit die Nachricht nicht zerhackt klingt
  for (let len = Math.min(customerWords.length, 20); len >= MIN_PHRASE_WORDS; len--) {
    for (let start = 0; start <= customerWords.length - len; start++) {
      const phrase = customerWords.slice(start, start + len).join(' ');
      if (phrase.length < MIN_PHRASE_LEN) continue;
      const escaped = escapeRegex(phrase).replace(/\s/g, '\\s+');
      const regex = new RegExp(escaped, 'gi');
      if (regex.test(result)) {
        result = result.replace(regex, '…');
      }
    }
  }
  result = result.replace(/\s*…\s*…\s*/g, ' … ').replace(/\s+/g, ' ').trim();
  result = result.replace(/^\s*…\s*[,.]?\s*/i, '').replace(/\s*[,.]?\s*…\s*$/i, '').trim();
  return result;
}

/**
 * Ergaenzt eine zu kurze Moderatoren-Antwort per LLM um einen thematisch passenden Satz/Frage
 * (zur Kundennachricht und zur bestehenden Antwort). Keine generischen Floskeln.
 * @param {string} customerMessage - aktuelle Kundennachricht
 * @param {string} replyText - bestehende Moderatoren-Antwort (bereits post-processed)
 * @returns {Promise<string>} replyText oder replyText + LLM-Ergaenzung
 */
async function extendReplyToMinLength(customerMessage, replyText) {
  if (!replyText || typeof replyText !== 'string') return replyText || '';
  const msg = replyText.trim();
  if (msg.length >= MIN_MESSAGE_LENGTH) return msg;
  const needChars = MIN_MESSAGE_LENGTH - msg.length;
  const systemContent = 'Du ergaenzst Chat-Moderator-Antworten. Gib NUR den anzuhängenden Text aus – keinen anderen Satz, keine Anführungszeichen, keine Erklärung. Der Zusatz muss thematisch zur Kundennachricht und zur bestehenden Antwort passen (z.B. passende Gegenfrage oder kurzer Satz). Du-Form, locker, auf Deutsch. Immer ss, nie ß. Keine Bindestriche.';
  const userContent = `Kundennachricht: "${sanitizeForApiContent((customerMessage || '').trim().slice(0, 300))}"\n\nBestehende Moderatoren-Antwort (zu kurz): "${sanitizeForApiContent(msg.slice(0, 250))}"\n\nHaenge genau einen kurzen Satz oder eine kurze Frage an, die zum Thema passt. Mindestens ${Math.max(20, needChars)} Zeichen. Gib NUR diesen Anhaengen-Teil aus.`;
  try {
    const appended = await callOpenAI(
      [{ role: 'system', content: systemContent }, { role: 'user', content: userContent }],
      { max_tokens: 80, temperature: 0.3, timeoutMs: 10000 }
    );
    const clean = (appended || '').trim().replace(/^["'„""]+/, '').replace(/["'"""]+$/, '');
    if (clean.length < 15 || clean.length > 200) return msg;
    if (clean.toLowerCase().includes(msg.slice(0, 30).toLowerCase())) return msg;
    const result = (msg + ' ' + clean).replace(/\s+/g, ' ').trim();
    return result.length >= MIN_MESSAGE_LENGTH ? result : msg;
  } catch (e) {
    console.warn('⚠️ Grok-Pipeline: Mindestlaenge-Ergaenzung fehlgeschlagen:', e.message);
    return msg;
  }
}

/**
 * Stellt sicher, dass die Nachricht mindestens MIN_MESSAGE_LENGTH Zeichen hat.
 * Wenn zu kurz: thematisch passende Ergaenzung per LLM (keine generischen Fragen).
 * @param {string} msg - bereits post-processed
 * @param {string} [customerMessage] - Kundennachricht (fuer passende Ergaenzung)
 * @returns {Promise<string>}
 */
async function ensureMinimumLength(msg, customerMessage) {
  if (!msg || typeof msg !== 'string') return msg || '';
  const m = msg.trim();
  if (m.length >= MIN_MESSAGE_LENGTH) return m;
  if (customerMessage && typeof customerMessage === 'string' && customerMessage.trim()) {
    return extendReplyToMinLength(customerMessage.trim(), m);
  }
  return m;
}

// ========== Moderator-Persona (alle Prompts) ==========
const MODERATOR_PERSONA = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL. Du hast interne Regeln für verschiedene Situationen (Treffen, Sexuell, Bot-Vorwurf, Geld, Wohnort, etc.). Pro Nachricht erkennst du, welche Situation(en) zutreffen, und wendest genau diese Regeln plus die allgemeinen Regeln an. Bei mehreren Situationen kombinierst du die Regeln. Du antwortest nur auf Deutsch, locker, Du-Form. Erfinde keine Details, die nicht im Kontext oder Profil stehen.\n\n`;

// Allgemein: Thema halten, nicht zu schlau, Schreibfehler verstehen, natürlich wirken, Format
const GENERAL_BEHAVIOR = `ALLGEMEIN (beachten):
THEMA: Geh nicht zu stark vom Thema ab. Wenn du etwas ergaenzst oder eine Frage stellst, soll es zur Person oder zum Kontext passen – nicht themenfremd (z.B. keine Beziehungsart-/Vorlieben-Fragen, wenn der Kunde nur etwas Konkretes gefragt hat).\nDUMM: Du bist ein normaler Mensch, du weisst nicht alles. Bei Fachfragen (z.B. Technik, wie etwas funktioniert): nicht mit Fachwissen antworten; sag ehrlich, dass du es nicht weisst, oder lenke freundlich um. Sei lieber etwas "dumm" als uebermaessig kompetent.\nSCHREIBFEHLER: Verstehe Tipp- und Schreibfehler des Kunden wie ein Mensch (z.B. "ham" statt "Hamm", fehlende Buchstaben, Grammatik). Antworte trotzdem inhaltlich richtig, ohne den Kunden zu korrigieren.\nNATUERLICH: Du darfst hier und da kleine, unauffaellige Fehler machen (Komma, Punkt, Grammatik) – wie ein Mensch, der nicht perfekt tippt. Aber nicht zu extrem oder auffaellig.\nFORMAT: KEINE Bindestriche (z.B. kennenlernen, nicht kennen-lernen). Immer ss, nie ß. Keine Anführungszeichen am Anfang/Ende der Nachricht. EIGENE PERSONEN: Freundin, Freund, Familie, Kollegen aus deinem (Fake) Leben immer als „meine Freundin“, „mein Kollege“ usw. – niemals „deine Freundin“ zum Kunden sagen, sonst meint er seine; die aus dem Logbuch gehoeren dir (Fake).\nTREFFEN/CHAT: Begruende NIEMALS, dass du dich im Chat wohler fuehlst. Bei Treffen/Bar/Ort/Zeit: NIEMALS Bar, Ort oder Uhrzeit nennen; keine Vorschlaege machen; nicht auf Vorschlaege eingehen. Nur darueber schreiben, was man "wuerde" machen, wie toll es "waere" – mehr nicht. Wird in Trainingsdaten gezeigt. Stelle eine klare Gegenfrage.\nEIGENE ERREGUNG: Eigene Erregung beschreiben (z.B. "macht mich feucht", "stell ich mir geil vor") nur, wenn der Kunde explizit mit dir/Fake ueber Sex spricht – also was er mit dir machen will, was ihr zusammen machen wuerdet usw. Wenn er nur eine Story oder ein Erlebnis erzaehlt (auch wild/anzueglich), ohne dich direkt einzubeziehen: auf den Inhalt reagieren (lustig, wild, interessant, Frage) – nicht mit deiner eigenen koerperlichen Reaktion.\n\n`;

// ========== Priorität (Reihenfolge im Prompt) ==========
const PRIORITY_NOTE = `PRIORITÄT (in dieser Reihenfolge beachten):
0. BEZUG ZUR KUNDENNACHRICHT: Deine Antwort hat immer einen klaren inhaltlichen Bezug zu dem, was der Kunde in seiner letzten Nachricht geschrieben hat – gleiches Thema, Reaktion auf seinen Punkt. Du musst nicht jede einzelne Frage wörtlich beantworten (bei Treffen, Kontaktdaten etc. weichst du ja bewusst aus); aber die Nachricht als Ganzes darf sich nicht um etwas völlig anderes drehen oder an älteren Aussagen hängen statt an der aktuellen Kundennachricht.
1. Safety/harte Grenzen (bereits geprüft)
2. Situations-Regeln (unten – nur die genannten Situationen)
3. Allgemeine Regeln (verbotene/bevorzugte Wörter, allgemeine Regeln)
4. Stil/Beispiele (Länge mind. 120 Zeichen ist Pflicht; Stil/Ton an Beispielen orientieren)
5. TON/INTENSITÄT: Passe dich an den Ton und die Intensität der Kundennachricht an – antworte nicht aufgedrehter oder expliziter als der Kunde; bei Unsicherheit lieber eine Stufe zurückhaltender. Wenn der Kunde andeutend oder sachlich schreibt, bleib ebenfalls andeutend/sachlicher; wenn er expliziter wird, kannst du mitgehen.\n\n`;

// Kurze Zusatzregeln (nicht den Haupt-Prompt überladen)
const EXTRA_RULES = {
  orte: 'ORTE: Niemals behaupten, einen vom Kunden genannten Ort (Café, Bar, Restaurant, Lokal) zu kennen oder zu mögen. Ortsnamen nicht mit "mag/kenne ich auch" kommentieren; hoechstens allgemein (z.B. klingt nett) ohne konkreten Namen.\n',
  vorfreude: 'VORFREUDE: Nicht als feste Zusage oder starke Vorfreude formulieren (z.B. "freue mich schon auf das Wochenende mit dir"); zurueckhaltend bleiben.\n',
  imageOnlyAnnounced: 'BILD NUR ANGEKUENDIGT: Kunde hat noch kein Bild geschickt – nicht "Danke fuer das Bild" oder Bewertung (sieht geil aus) sagen; nur Vorfreude (z.B. freue mich drauf).\n'
};

// ========== Regeln & Anweisungen ==========

/** Allgemeine Regeln + verbotene/bevorzugte Wörter (ohne Situations-Regeln). */
function buildGeneralRulesBlock(allRules) {
  if (!allRules) return '';
  let block = '';
  if (allRules.generalRules && allRules.generalRules.trim()) {
    block += `\n📋 ALLGEMEINE REGELN:\n${allRules.generalRules}\n`;
  }
  if (allRules.forbiddenWords && allRules.forbiddenWords.length > 0) {
    block += `\n❌ VERBOTENE WÖRTER (NIEMALS verwenden):\n${allRules.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n`;
  }
  if (allRules.preferredWords && allRules.preferredWords.length > 0) {
    block += `\n✅ BEVORZUGTE WÖRTER (wo passend verwenden):\n${allRules.preferredWords.map(w => `- "${w}"`).join('\n')}\n`;
  }
  return block;
}

/** Nur Regeln der angegebenen Situationen (für Multi-Situation). */
function buildSituationRulesBlock(situationNames, allRules) {
  if (!allRules?.situationalResponses || !Array.isArray(situationNames) || situationNames.length === 0) return '';
  const situations = allRules.situationalResponses;
  let block = '\n📌 SITUATIONS-REGELN (nur diese Situationen beachten – alle genannten kombinieren):\n';
  for (const name of situationNames) {
    if (name && situations[name] && typeof situations[name] === 'string') {
      block += `[${name}]: ${situations[name].trim()}\n`;
    }
  }
  return block + '\n';
}

/** Vollständiger Block (für ASA/Erstnachricht/Stadt – inkl. Situations-Auszug). */
function buildRulesBlock(allRules) {
  if (!allRules) return '';
  let block = buildGeneralRulesBlock(allRules);
  if (allRules.situationalResponses && typeof allRules.situationalResponses === 'object') {
    const entries = Object.entries(allRules.situationalResponses).slice(0, 8);
    if (entries.length > 0) {
      block += '\n📌 SITUATIONS-REGELN (beachten):\n';
      entries.forEach(([name, text]) => {
        block += `[${name}]: ${(text || '').substring(0, 200)}${(text || '').length > 200 ? '...' : ''}\n`;
      });
    }
  }
  return block;
}

// Deutsche Bundeslaender (fuer Wohnort: Bundesland -> Stadt via findNearbyCity)
const BUNDESLAENDER_LOWER = [
  'baden-württemberg', 'baden-wuerttemberg', 'bayern', 'berlin', 'brandenburg', 'bremen', 'hamburg', 'hessen',
  'mecklenburg-vorpommern', 'niedersachsen', 'nordrhein-westfalen', 'nrw', 'rheinland-pfalz', 'saarland',
  'sachsen-anhalt', 'sachsen anhalt', 'schleswig-holstein', 'thüringen', 'thueringen'
];

function isBundesland(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim().toLowerCase();
  return BUNDESLAENDER_LOWER.some(b => n === b || n.includes(b) || b.includes(n));
}

// ========== Geschlecht aus Name/Profil (wie in multi-agent/reply) ==========
/** Typische weibliche Vornamen (Deutsch/International) – erster Token des Namens. */
const FEMALE_NAMES = new Set([
  'anna', 'maria', 'lena', 'lisa', 'lotta', 'julia', 'laura', 'sarah', 'lea', 'lara', 'sophie', 'emma', 'mia', 'hannah',
  'leonie', 'lina', 'nele', 'clara', 'emily', 'sandy', 'jana', 'nicole', 'jennifer', 'melanie', 'sandra',
  'susanne', 'susann', 'christina', 'katharina', 'jessica', 'vanessa', 'nadine', 'stefanie', 'andrea',
  'franziska', 'petra', 'monika', 'sabine', 'birgit', 'claudia', 'daniela', 'silke', 'tanja', 'yvonne'
]);
/** Typische männliche Vornamen (Deutsch/International). */
const MALE_NAMES = new Set([
  'alessandro', 'alexandro', 'andi', 'max', 'paul', 'lucas', 'felix', 'ben', 'jonas', 'tim', 'leon', 'lukas',
  'alexander', 'david', 'tom', 'jan', 'marc', 'michael', 'thomas', 'martin', 'steffen', 'peter', 'andreas',
  'markus', 'christian', 'daniel', 'simon', 'florian', 'tobias', 'sebastian', 'matthias', 'stefan',
  'marco', 'mario', 'dennis', 'kevin', 'patrick', 'jens', 'oliver', 'ralf', 'uwe', 'wolfgang'
]);

/**
 * Erkennt Geschlecht aus Vornamen (z.B. aus Profil/Name), falls in Profil nicht gesetzt.
 * @param {string} [name] - Anzeigename (z.B. "Alessandro92" -> "alessandro")
 * @returns {'weiblich'|'männlich'|null}
 */
function inferGenderFromName(name) {
  if (!name || typeof name !== 'string') return null;
  const first = name.trim().split(/[\s_\-.]/)[0].toLowerCase().replace(/\d+/g, '');
  if (!first) return null;
  if (FEMALE_NAMES.has(first)) return 'weiblich';
  if (MALE_NAMES.has(first)) return 'männlich';
  return null;
}

/**
 * Baut den Geschlechter-Rollen-Hinweis für den System-Prompt (wie in multi-agent.js).
 * Fake kann Mann oder Frau sein; Kunde kann Mann oder Frau sein (Mann–Mann, Frau–Frau, Frau–Mann, Mann–Frau).
 * @param {string|null} fakeGender - 'weiblich'|'männlich'|'w'|'female'|null
 * @param {string|null} customerGender - 'weiblich'|'männlich'|null (falls null: typischerweise Gegenteil von Fake annehmen)
 * @param {boolean} hasSexualSituation - ob sexuelle Rollen/Positionen-Hinweise ergänzt werden sollen
 * @returns {string}
 */
function buildGenderHint(fakeGender, customerGender, hasSexualSituation) {
  const normalizedFake = !fakeGender ? null : (fakeGender === 'w' || fakeGender === 'female' ? 'weiblich' : fakeGender);
  if (!normalizedFake || (normalizedFake !== 'weiblich' && normalizedFake !== 'männlich')) return '';
  const isFemale = normalizedFake === 'weiblich';
  const customerIsFemale = customerGender === 'weiblich' || customerGender === 'w' || customerGender === 'female';
  const customerIsMale = customerGender === 'männlich' || customerGender === 'male';
  const customerLabel = customerIsFemale
    ? 'eine FRAU'
    : customerIsMale
      ? 'ein MANN'
      : (isFemale ? 'ein MANN (typischerweise; schreibt dir als Frau)' : 'eine FRAU (typischerweise; schreibt dir als Mann)');

  let block = '\n🚨🚨🚨 KRITISCH: GESCHLECHTER-ROLLENVERSTÄNDNIS 🚨🚨🚨\n';
  block += `- Du bist: ${isFemale ? 'eine FRAU' : 'ein MANN'}\n`;
  block += `- Der Kunde ist: ${customerLabel}\n`;
  block += '- Passe deinen Schreibstil entsprechend an (' + (isFemale ? 'Frau' : 'Mann') + ' zu ' + (isFemale ? 'Mann' : 'Frau') + ').\n';

  if (hasSexualSituation) {
    if (isFemale) {
      block += '\n🚨🚨🚨 KRITISCH: SEXUELLE ROLLEN/POSITIONEN (FRAU zu MANN) 🚨🚨🚨\n';
      block += '- Du bist die FRAU, der Kunde ist der MANN.\n';
      block += '- Du nimmst PASSIVE/RECEPTIVE Rollen ein (du wirst "genommen", nicht du "nimmst").\n';
      block += '- ✅ RICHTIG: "Ich würde gerne doggy genommen werden", "Ich liebe es, wenn du mich doggy nimmst", "Ich würde gerne von dir genommen werden".\n';
      block += '- ❌ FALSCH: "Ich würde dich doggy nehmen", "Ich würde dich nehmen", "Ich würde dich ficken" (aktive Rollen für Männer!).\n';
      block += '- PERSPEKTIVE: Du schreibst als FRAU an den MANN. Niemals Sätze, die der MANN zur FRAU sagt! ❌ FALSCH: "Zeig mir deine Löcher/Muschi/Brust", "Schick mir (ein Bild von) deiner...". Das wäre seine Perspektive (er will etwas von dir sehen). Du forderst ihn nicht so auf.\n';
      block += '- Bei sexuellen Positionen/Rollen: Du bist die PASSIVE Partei, der Kunde die AKTIVE Partei.\n';
    } else {
      block += '\n🚨🚨🚨 KRITISCH: SEXUELLE ROLLEN/POSITIONEN (MANN zu FRAU) 🚨🚨🚨\n';
      block += '- Du bist der MANN, der Kunde ist die FRAU.\n';
      block += '- Du nimmst AKTIVE Rollen ein (du "nimmst", nicht du wirst "genommen").\n';
      block += '- ✅ RICHTIG: "Ich würde dich doggy nehmen", "Ich würde dich gerne nehmen", "Ich würde dich ficken".\n';
      block += '- ❌ FALSCH: "Ich würde gerne doggy genommen werden", "Ich würde gerne von dir genommen werden" (passive Rollen für Frauen!).\n';
      block += '- PERSPEKTIVE: Du schreibst als MANN an die FRAU. Niemals Sätze, die die FRAU zum MANN sagt! ❌ FALSCH: "Zeig mir deinen Schwanz/Penis", "Schick mir (ein Bild von) deinem...". Das wäre ihre Perspektive (sie will etwas von dir sehen). Du forderst sie nicht so auf.\n';
      block += '- Bei sexuellen Positionen/Rollen: Du bist die AKTIVE Partei, der Kunde die PASSIVE Partei.\n';
    }
  }
  return block + '\n';
}

// ========== Wohnort-Check (wie in multi-agent) ==========

async function checkLocationQuestion({
  customerMessage,
  conversationHistory = '',
  profileInfo,
  extractedUserInfo,
  isLocationQuestionFunc,
  findNearbyCityFunc
}) {
  if (!isLocationQuestionFunc || typeof isLocationQuestionFunc !== 'function' || !isLocationQuestionFunc(customerMessage)) {
    return { isLocationQuestion: false, locationQuestionError: null, cityToUse: null, cityInstructions: '' };
  }

  const customerInfo = profileInfo?.customerInfo || profileInfo || {};
  const moderatorInfo = extractedUserInfo?.assistant || profileInfo?.moderatorInfo || {};
  const customerCity = customerInfo.city || customerInfo.wohnort || null;
  const fakeCity = profileInfo?.moderatorInfo?.city ||
    profileInfo?.moderatorInfo?.Wohnort ||
    moderatorInfo.Wohnort ||
    moderatorInfo.city ||
    extractedUserInfo?.assistant?.city ||
    extractedUserInfo?.assistant?.Wohnort ||
    null;

  if (fakeCity && fakeCity.trim() !== '' && fakeCity.toLowerCase() !== 'sag ich später') {
    const cityLower = fakeCity.toLowerCase();
    let districtHint = '';
    if (cityLower === 'leipzig') districtHint = "Nenne einen realistischen Stadtteil: Zentrum, Plagwitz, Connewitz, Grünau, Lindenau, Gohlis, etc.";
    else if (cityLower === 'berlin') districtHint = "Nenne einen realistischen Stadtteil: Mitte, Prenzlauer Berg, Kreuzberg, Friedrichshain, Charlottenburg, etc.";
    else if (cityLower === 'hamburg') districtHint = "Nenne einen realistischen Stadtteil: Altona, Eimsbüttel, St. Pauli, Eppendorf, etc.";
    else if (cityLower === 'münchen') districtHint = "Nenne einen realistischen Stadtteil: Schwabing, Maxvorstadt, Haidhausen, Sendling, etc.";
    else if (cityLower === 'köln') districtHint = "Nenne einen realistischen Stadtteil: Innenstadt, Ehrenfeld, Nippes, Lindenthal, etc.";
    else if (cityLower === 'frankfurt') districtHint = "Nenne einen realistischen Stadtteil: Innenstadt, Sachsenhausen, Nordend, etc.";
    else districtHint = `Nenne einen realistischen Stadtteil von ${fakeCity}.`;
    const cityInstructions = `Der Kunde fragt nach deinem Wohnort. Du MUSST zuerst deinen Wohnort nennen: "${fakeCity}". ${districtHint} Dann eine Frage zurück. Struktur: "Ich wohne in ${fakeCity} [evtl. Stadtteil]. Woher kommst du denn?"`;
    return {
      isLocationQuestion: true,
      locationQuestionError: null,
      cityToUse: fakeCity,
      cityInstructions
    };
  }

  if (customerCity && customerCity.trim() !== '' && customerCity.toLowerCase() !== 'sag ich später') {
    const nearbyCity = findNearbyCityFunc && typeof findNearbyCityFunc === 'function'
      ? await findNearbyCityFunc(customerCity)
      : null;
    if (nearbyCity) {
      return {
        isLocationQuestion: true,
        locationQuestionError: null,
        cityToUse: nearbyCity,
        cityInstructions: `Der Kunde fragt nach deinem Wohnort. Kunde kommt aus "${customerCity}". Nenne eine Stadt im Umkreis: "${nearbyCity}". Struktur: "Ich wohne in ${nearbyCity}. Woher kommst du denn?"`
      };
    }
    return {
      isLocationQuestion: true,
      locationQuestionError: {
        error: "WOHNORT-FRAGE: Keine passende Stadt im Umkreis gefunden",
        message: "Der Kunde fragt nach dem Wohnort, aber es konnte keine passende Stadt im 20km Umkreis gefunden werden. Bitte manuell reagieren.",
        requiresHumanModeration: true,
        customerCity,
        fakeCity
      },
      cityToUse: null,
      cityInstructions: ''
    };
  }

  return {
    isLocationQuestion: true,
    locationQuestionError: {
      error: "WOHNORT-FRAGE: Keine Wohnort-Informationen verfügbar",
      message: "Der Kunde fragt nach dem Wohnort, aber weder im Fake-Profil noch beim Kunden ist ein Wohnort hinterlegt. Bitte manuell reagieren.",
      requiresHumanModeration: true,
      customerCity: customerCity || null,
      fakeCity
    },
    cityToUse: null,
    cityInstructions: ''
  };
}

// ========== Grok API-Aufruf ==========

async function callGrok(messages, options = {}) {
  const client = getGrokClient();
  if (!client) {
    throw new Error('Grok-Client nicht verfügbar (XAI_API_KEY fehlt?)');
  }
  const model = options.model || getGrokModel();
  const doCreate = (msgList) =>
    Promise.race([
      client.chat.completions.create({
        model,
        messages: msgList,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? MAX_TOKENS
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Grok Timeout')), options.timeoutMs || GROK_TIMEOUT_MS))
    ]);
  const sanitized = Array.isArray(messages)
    ? messages.map((m) => {
        if (m && typeof m.content === 'string') {
          return { ...m, content: sanitizeForApiContent(m.content) };
        }
        return m;
      })
    : messages;
  const response = await doCreate(sanitized);
  const text = response.choices?.[0]?.message?.content?.trim() || '';
  if (!text) throw new Error('Grok lieferte keine Antwort');
  return text;
}

/** Stellt sicher, dass die Nachricht eine Frage enthält (?). Wenn nicht und OpenAI verfügbar: kurzer Call zum Einbau einer thematisch passenden Frage (z. B. am Ende).
 * opts.customerMessage, opts.conversationSnippet: Kontext, damit die Frage thematisch passt und keine Treffen-Fragen entstehen.
 */
async function ensureQuestionInMessage(message, opts = {}) {
  if (!message || typeof message !== 'string') return message || '';
  const trimmed = message.trim();
  if (trimmed.includes('?')) return message;
  const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
  if (!hasOpenAI) return message;
  const customerMessage = (opts.customerMessage || '').trim().slice(0, 400);
  const conversationSnippet = (opts.conversationSnippet || '').trim().slice(0, 350);
  const systemRules = [
    'Du fuegst einer Chat-Nachricht genau eine kurze, thematisch passende Frage ein (z. B. am Ende). Gib NUR die komplette Nachricht mit eingebauter Frage zurueck. Keine Anführungszeichen, kein anderer Text.',
    'WICHTIG: Keine Fragen zu Treffen, Dates, Kaffee trinken gehen, spontane Treffen oder persönlichem Kennenlernen einbauen. Der Moderator darf kein Treffen vorschlagen oder danach fragen. Die Frage muss thematisch zur Kundennachricht und zum Konversationsverlauf passen.'
  ].join(' ');
  try {
    let userContent = `Die folgende Chat-Nachricht enthaelt keine Frage. Fuege genau eine kurze, thematisch passende Frage ein (z. B. am Ende). Gib NUR die komplette Nachricht inkl. Frage zurueck, keine Erklaerungen.\n`;
    if (customerMessage) userContent += `\nKundennachricht (Kontext):\n${sanitizeForApiContent(customerMessage)}\n`;
    if (conversationSnippet) userContent += `\nLetzter Konversationsausschnitt (Kontext):\n${sanitizeForApiContent(conversationSnippet)}\n`;
    userContent += `\nNachricht, in die die Frage eingefuegt werden soll:\n\n${sanitizeForApiContent(trimmed)}`;
    const result = await callOpenAI([
      { role: 'system', content: systemRules },
      { role: 'user', content: userContent }
    ], { temperature: 0.2, max_tokens: 180, timeoutMs: 10000 });
    const out = (result || '').trim();
    if (out && out.includes('?')) {
      console.log('✅ Grok-Pipeline: Frage in Nachricht ergaenzt (Post-Processing)');
      return postProcessMessage(out);
    }
  } catch (err) {
    console.warn('⚠️ Frage-in-Nachricht Post-Processing fehlgeschlagen:', err.message);
  }
  return message;
}

/** OpenAI-Aufruf für Situationserkennung und Plan (entlastet Grok, vermeidet Timeouts). */
async function callOpenAI(messages, options = {}) {
  const client = getClient();
  if (!client) {
    throw new Error('OpenAI-Client nicht verfügbar (OPENAI_API_KEY fehlt?)');
  }
  const model = options.model || OPENAI_MODEL;
  const response = await Promise.race([
    client.chat.completions.create({
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens ?? OPENAI_SITUATION_MAX_TOKENS
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('OpenAI Timeout')), options.timeoutMs || OPENAI_SITUATION_TIMEOUT_MS))
  ]);
  const text = response.choices?.[0]?.message?.content?.trim() || '';
  if (!text) throw new Error('OpenAI lieferte keine Antwort');
  return text;
}

// ========== Prompt-Builder pro Modus ==========

function buildASAPrompt({ allRules, asaConversationContext, asaExample, doubleProfileHint = '', customerHasProfilePic = false, profileInfo = {}, extractedUserInfo = {} }) {
  const rulesBlock = buildRulesBlock(allRules);
  const customerInfo = profileInfo?.customerInfo || {};
  const moderatorInfo = profileInfo?.moderatorInfo || {};
  const fakeName = moderatorInfo?.name || extractedUserInfo?.assistant?.Name || '';
  const customerName = extractedUserInfo?.user?.Name || customerInfo?.name || '';
  const customerAge = extractedUserInfo?.user?.Age ?? customerInfo?.birthDate?.age ?? null;
  const customerCity = extractedUserInfo?.user?.Wohnort || customerInfo?.city || '';

  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR;
  if (doubleProfileHint && doubleProfileHint.trim()) systemContent += doubleProfileHint.trim() + '\n\n';
  if (!customerHasProfilePic) {
    systemContent += 'PROFILBILD: Der Kunde hat KEIN Profilbild. Erwaehne NICHT sein Aussehen, sage NICHT dass er gut aussieht oder aehnliches.\n\n';
  }
  if (fakeName) systemContent += `DEIN NAME (Fake-Profil): ${sanitizeForApiContent(fakeName)}. NUR diesen Namen verwenden – keinen anderen.\n\n`;
  if (customerName || customerAge != null || customerCity) {
    systemContent += `KUNDEN-PROFIL (wenn du den Kunden ansprichst, NUR diese Daten verwenden – nichts erfinden!): ${customerName ? `Name: ${customerName}. ` : ''}${customerAge != null ? `Alter: ${customerAge} Jahre. ` : ''}${customerCity ? `Wohnort: ${customerCity}.` : ''}\n\n`;
  }
  systemContent += `Du antwortest auf eine System-Nachricht (Kuss oder Like) – der Kunde hat dich geliked oder einen Kuss geschickt, du schreibst die ERSTE Antwort.
${rulesBlock}

WICHTIG: Antworte natürlich, locker, freundlich. Bedanke dich kurz für Kuss/Like. Stelle 1–2 Fragen (z.B. wie geht es dir, was machst du so). Mindestens 120 Zeichen. Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. KEINE Anführungszeichen am Anfang/Ende. KEINE Bindestriche.`;

  let userContent = `Kontext: ${asaConversationContext || 'Kuss/Like erhalten'}\n\n`;
  if (asaExample && (asaExample.moderatorResponse || asaExample.asaMessage)) {
    const ex = asaExample.moderatorResponse || asaExample.asaMessage;
    userContent += `BEISPIEL (Stil und Länge daran orientieren, nicht 1:1 kopieren):\n"${ex.substring(0, 400)}${ex.length > 400 ? '...' : ''}"\n\n`;
  }
  userContent += 'Generiere genau eine Antwort (nur der Text, keine Erklärungen).';

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

function buildFirstMessagePrompt({ allRules, firstMessageInstructions, profileInfo, extractedUserInfo, doubleProfileHint = '' }) {
  const rulesBlock = buildRulesBlock(allRules);
  const fakeName = profileInfo?.moderatorInfo?.name || extractedUserInfo?.assistant?.Name || 'Sandy';
  const fakeCity = (extractedUserInfo?.assistant?.Stadt || extractedUserInfo?.assistant?.Wohnort || profileInfo?.moderatorInfo?.city || '').trim();
  const customerInfo = profileInfo?.customerInfo || {};
  const customerName = extractedUserInfo?.user?.Name || customerInfo?.name || '';
  const customerAge = extractedUserInfo?.user?.Age ?? customerInfo?.birthDate?.age ?? null;
  const customerCity = extractedUserInfo?.user?.Wohnort || customerInfo?.city || '';
  const now = new Date();
  const berlinTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const weekday = weekdayNames[berlinTime.getDay()];
  const hour = berlinTime.getHours();
  const timePhase = hour >= 22 || hour < 6 ? 'Nacht' : hour >= 18 ? 'Abend' : hour >= 12 ? 'Nachmittag' : hour >= 6 ? 'Vormittag' : 'Nacht';
  const customerHasNoProfilePic = profileInfo?.customerInfo && profileInfo.customerInfo.hasProfilePic === false;

  let systemContent = `${MODERATOR_PERSONA}${GENERAL_BEHAVIOR}`;
  if (customerHasNoProfilePic) {
    systemContent += 'PROFILBILD: Der Kunde hat KEIN Profilbild. Erwaehne NICHT sein Aussehen, sage NICHT dass er gut aussieht oder aehnliches.\n\n';
  }
  if (customerName || customerAge != null || customerCity) {
    systemContent += `KUNDEN-PROFIL (NUR die Daten des KUNDEN – wenn du ihn ansprichst, diese verwenden; NIE als deine eigenen ausgeben!): ${customerName ? `Name: ${customerName}. ` : ''}${customerAge != null ? `Alter: ${customerAge} Jahre. ` : ''}${customerCity ? `Wohnort: ${customerCity}.` : ''}\n\n`;
  }
  systemContent += `ERSTNACHRICHT (Kunde hat geliked oder Kuss geschickt):
- Stelle dich NICHT vor: Kein Name, kein Alter, kein Wohnort von dir in der Nachricht. Der Kunde sieht dein Profil bereits.
- Antworte nur mit: kurzem Danke für das Like/den Kuss + 1–2 Fragen (z.B. wie geht es dir, was machst du gerade, was gefällt dir an mir).
- Die Daten unter KUNDEN-PROFIL gehoeren dem KUNDEN – niemals sein Alter oder seinen Wohnort als deine eigenen angeben.

Du antwortest als Fake-Profil (Name/Wohnort nur intern, nicht in die Nachricht schreiben).
${rulesBlock}

WICHTIG: Keine Vorstellung. Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. KEINE Bindestriche. KEINE Anführungszeichen am Anfang/Ende. Nutze Zeitkontext (${weekday}, ${timePhase}). Antworte natürlich, mindestens 120 Zeichen.`;

  const userContent = `${firstMessageInstructions}

[FAKE-PROFIL – nur für dich, NICHT in die Nachricht schreiben]
Name: ${fakeName}
${fakeCity ? `Wohnort: ${fakeCity}\n` : ''}
[ZEIT] ${weekday}, ${timePhase}

Generiere genau eine Erstnachricht (nur der Text).`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

function buildCityPrompt({ allRules, cityInstructions, customerMessage, doubleProfileHint = '' }) {
  const rulesBlock = buildRulesBlock(allRules);
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR;
  if (doubleProfileHint && doubleProfileHint.trim()) systemContent += doubleProfileHint.trim() + '\n\n';
  systemContent += rulesBlock + `

WOHNORT-FRAGE: ${cityInstructions}

Antworte kurz (1–2 Sätze), nenne den Wohnort wie angegeben, stelle eine Frage zurück. Keine Anführungszeichen am Anfang/Ende. KEINE Bindestriche. Immer ss, nie ß.`;

  const userContent = `Kundennachricht: "${sanitizeForApiContent(customerMessage || '')}"\n\nGeneriere genau eine Antwort (nur der Text).`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

/** Aktueller Wochentag + Tagesphase (Europe/Berlin) für plausible Aktivitäten im Prompt. */
function getBerlinTimeContext() {
  const now = new Date();
  const berlinTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const weekday = weekdayNames[berlinTime.getDay()];
  const hour = berlinTime.getHours();
  const timePhase = hour >= 22 || hour < 6 ? 'Nacht' : hour >= 18 ? 'Abend' : hour >= 12 ? 'Nachmittag' : hour >= 6 ? 'Vormittag' : 'Nacht';
  return { weekday, timePhase, hour };
}

/** Hinweis für Schichtarbeit: Schichttyp muss zur Uhrzeit passen (z.B. mittags nicht "nach Spätschicht"). */
function buildShiftWorkTimeHint(hour, fakeProfession, fakeLogbookHint) {
  const professionStr = (fakeProfession || '').toLowerCase();
  const logbookStr = (fakeLogbookHint || '').toLowerCase();
  const hasShiftWork = /\bschicht\b|frühschicht|spätschicht|spaetschicht|nachtschicht|schichtdienst/i.test(professionStr + ' ' + logbookStr);
  if (!hasShiftWork) return '';
  // Stunde 0–5: Nacht → Nachtschicht passt (gerade fertig). 6–13: Vormittag/früher Nachmittag → NUR Frühschicht (Spätschicht passt nicht). 14–21: Nachmittag/Abend → Spätschicht oder Frühschicht (morgens). 22–23: Abend/Nacht → Nachtschicht oder Spätschicht.
  if (hour >= 6 && hour < 14) {
    return 'SCHICHTARBEIT: Es ist Vormittag/frueher Nachmittag. Wenn du erwaenst, dass du von einer Schicht kommst oder dich erholst: NUR Frühschicht (gerade fertig). Spätschicht passt NICHT – die laeuft erst ab Nachmittag. Nicht "nach der Spätschicht" um die Mittagszeit schreiben.';
  }
  if (hour >= 14 && hour < 22) {
    return 'SCHICHTARBEIT: Es ist Nachmittag/Abend. Wenn du Schicht erwaehnst: Spätschicht (gerade fertig oder dabei) oder Frühschicht (heute morgen) passen. Nachtschicht erst ab spaetem Abend/Nacht.';
  }
  return 'SCHICHTARBEIT: Es ist Abend/Nacht. Wenn du Schicht erwaehnst: Nachtschicht (gerade fertig oder dabei) oder Spätschicht (gerade fertig) passen. Frühschicht nur wenn du "heute frueh" meinst.';
}

/** Heuristik: Kunde wirkt traurig/emotional (z.B. verschlechtert, Monat zu Monat, ehrlich, wohlfühl, Gefühl). */
function isEmotionalContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  const markers = ['verschlechtert', 'verschlechtert sich', 'monat zu monat', 'von monat zu monat', 'ehrlich', 'wohlfuehl', 'wohlfühl', 'gefuehl', 'gefühl', 'ferlirt', 'fühlt sich', 'fuehlt sich', 'traurig', 'frustriert', 'enttäuscht', 'enttaeuscht'];
  return markers.some(m => lower.includes(m));
}

/** Heuristik: Kunde wirkt gereizt/frustriert (z.B. Vorwürfe, Unmut, Druck). */
function isCustomerIrritated(conversationHistory) {
  if (!conversationHistory || typeof conversationHistory !== 'string') return false;
  const recent = conversationHistory.slice(-1200).toLowerCase();
  const markers = ['warum nicht', 'echt jetzt', 'lächerlich', 'lachhaft', 'scam', 'betrug', 'scheiß', 'scheiss', 'nutte', 'verarscht', 'verarschen', 'spinner', 'unverschämt', 'unverschaemt', 'frech', 'dreist', 'mach mal', 'sag mal endlich', 'nummer her', 'was soll das', 'unfassbar', 'unglaublich', 'keine lust mehr', 'zeitverschwendung'];
  return markers.some(m => recent.includes(m));
}

/**
 * Allgemeine emotionale Stimmung aus letzter Nachricht + Kontext.
 * Gibt zurück: 'irritated' | 'sad_vulnerable' | 'flirty_positive' | null (neutral).
 * Reihenfolge: gereizt und traurig haben Vorrang vor positiv (passende Reaktion wichtiger).
 */
function getEmotionalTone(customerMessage, conversationHistory) {
  const text = [conversationHistory || '', customerMessage || ''].join(' ').slice(-1500);
  if (!text || !text.trim()) return null;
  const lower = text.toLowerCase();
  if (isCustomerIrritated(conversationHistory || '')) return 'irritated';
  if (isEmotionalContext(text)) return 'sad_vulnerable';
  const positiveMarkers = ['gefällst mir', 'gefaellst mir', 'mag dich', 'freue mich', 'freut mich', 'schön dass', 'schoen dass', 'richtig gut', 'super ', 'toll ', 'mega', 'lächel', 'laechel', 'haha', '😊', '🙂', 'gerne wieder', 'bin begeistert', 'find ich gut', 'gefällt', 'gefaellt', 'süß ', 'suess ', 'nett von dir', 'danke dass', 'klingt gut', 'klingt super', 'bin gespannt', 'lust auf', 'bock auf'];
  if (positiveMarkers.some(m => lower.includes(m))) return 'flirty_positive';
  return null;
}

/**
 * Heuristik: Kunde spricht ueber Kinder, Familie oder gemeinsame Zukunft (nicht ueber Sex).
 * In dem Fall duerfen keine expliziten sexuellen Formulierungen in die Antwort.
 */
function isMessageAboutFamilyOrChildren(customerMessage) {
  if (!customerMessage || typeof customerMessage !== 'string') return false;
  const lower = customerMessage.toLowerCase();
  const familyMarkers = [
    'kinder', 'kind ', 'familie', 'zukunft', 'heirat', 'hochzeit', 'traumhochzeit',
    'baby', 'babys', 'schwanger', 'mutter', 'vater', 'eltern', 'zusammen kinder',
    'kinder haben', 'familie gründen', 'familie gruenden', 'mit dir zusammen kinder',
    'mit dir kinder', 'eines tages kinder', 'später mal kinder'
  ];
  return familyMarkers.some(m => lower.includes(m));
}

/**
 * Prüft, ob Kunde direkt über Sex mit dem Fake spricht (z.B. "ich würde dich...", "stell dir vor wir...").
 * Wenn ja: eigene Erregungs-Beschreibungen ("macht mich feucht") sind passend.
 * Wenn nein (nur Story/Erlebnis ohne direkten Bezug zum Fake): nicht mit eigener Erregung reagieren.
 * Kinder/Familie/Zukunft (z.B. "mit dir zusammen Kinder haben") zaehlt NICHT als Sex – dann keine expliziten Formulierungen.
 */
function isCustomerTalkingAboutSexWithFake(customerMessage) {
  if (!customerMessage || typeof customerMessage !== 'string') return false;
  const lower = customerMessage.toLowerCase();
  if (isMessageAboutFamilyOrChildren(customerMessage)) return false;
  const directSexMarkers = [
    'ich würde dich', 'ich wuerde dich', 'würde ich dich', 'wuerde ich dich',
    'was würdest du', 'was wuerdest du', 'stell dir vor wir', 'stell dir vor du und ich',
    'ich will dich', 'ich moechte dich', 'ich möchte dich', 'mit dir machen',
    'dich lecken', 'dich ficken', 'dich nehmen', 'bei dir', 'an dir',
    'du und ich', 'wir beide', 'zusammen mit dir', 'wenn wir uns treffen',
    'was machen wir', 'was wollen wir', 'lass uns', 'hast du lust auf',
    'magst du es wenn', 'gefällt dir', 'gefaellt dir', 'zeig mir', 'schick mir',
    'deine brüste', 'deine brueste', 'dein körper', 'dein koerper', 'deine muschi',
    'wie schmeckst du', 'wie fühlst du dich an', 'wie fuehlst du dich an'
  ];
  return directSexMarkers.some(m => lower.includes(m));
}

/**
 * Filtert zeitgebundene Logbucheinträge aus den Notes (z.B. "Other"), damit die KI nicht
 * auf veraltete "heute"-Facts reagiert (z.B. "Kd hat heute Geburtstag" vom 31.01. am 02.02.).
 * - Einträge mit Datum in der Vergangenheit + "heute" werden entfernt (waren nur an dem Tag aktuell).
 * - Themen wie "Geburtstag" werden nur dann übergeben, wenn der Kunde in der aktuellen Nachricht
 *   darauf Bezug nimmt – sonst keine erneuten Gratulationen aus dem Logbuch.
 * @param {Object} userInfo - extractedUserInfo.user (wird nicht mutiert)
 * @param {string} customerMessage - aktuelle Kundennachricht
 * @returns {Object} Kopie von userInfo mit gefiltertem "Other"
 */
function filterTimeSensitiveNotes(userInfo, customerMessage) {
  if (!userInfo || typeof userInfo !== 'object') return userInfo;
  const otherRaw = userInfo.Other != null ? String(userInfo.Other).trim() : '';
  if (!otherRaw) return userInfo;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msgLower = (customerMessage || '').toLowerCase();

  // Erkenne Logbuchzeilen mit Datum am Anfang (z.B. "Jan 31, 2026 - ...", "31.01.2026 ...", "Jan 31 2026 ...")
  const datePatterns = [
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s|$)/,                    // 31.01.2026
    /^(\d{1,2})\.(\d{1,2})\.(\d{2})(?:\s|$)/,                   // 31.01.26
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i, // Jan 31, 2026
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})/i   // Jan 31 2026
  ];
  const monthNames = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function parseEntryDate(line) {
    const trimmed = line.trim();
    for (const re of datePatterns) {
      const m = trimmed.match(re);
      if (!m) continue;
      if (re.source.includes('Jan|Feb')) {
        const month = monthNames[m[1].toLowerCase().slice(0, 3)];
        const day = parseInt(m[2], 10);
        const year = parseInt(m[3], 10);
        if (!isNaN(day) && !isNaN(year) && month != null) return new Date(year, month, day);
      } else {
        const d = parseInt(m[1], 10), mon = parseInt(m[2], 10) - 1, y = parseInt(m[3], 10);
        const year = y < 100 ? 2000 + y : y;
        if (!isNaN(d) && !isNaN(mon) && !isNaN(year)) return new Date(year, mon, d);
      }
    }
    return null;
  }

  const lines = otherRaw.split(/\r?\n/);
  const kept = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { kept.push(line); continue; }

    const entryDate = parseEntryDate(trimmed);
    const hasHeute = /\bheute\b/i.test(trimmed);
    const hasGeburtstag = /\bgeburtstag\b/i.test(trimmed);
    const customerMentionsGeburtstag = /\bgeburtstag\b/i.test(msgLower);

    // Eintrag mit Datum in der Vergangenheit und "heute" → war nur an dem Tag aktuell, nicht mehr verwenden
    if (entryDate) {
      const entryDay = new Date(entryDate);
      entryDay.setHours(0, 0, 0, 0);
      if (entryDay < today && hasHeute) continue; // veralteter "heute"-Eintrag weglassen
    }

    // Geburtstag-Infos aus dem Logbuch nur nutzen, wenn der Kunde in dieser Nachricht darauf eingeht
    if (hasGeburtstag && !customerMentionsGeburtstag) continue;

    kept.push(line);
  }

  const filteredOther = kept.join('\n').trim();
  if (filteredOther === otherRaw) return userInfo;

  const out = { ...userInfo };
  if (filteredOther) out.Other = filteredOther; else delete out.Other;
  return out;
}

/**
 * Baut eine Zeile "Bekannt aus Nachricht" aus extractedUserInfo.user (nur relevante, befüllte Felder).
 * @param {Object} userInfo - extractedUserInfo.user
 * @returns {string} Eine Zeile oder '' wenn nichts Relevantes
 */
function buildKnownFromCustomerMessage(userInfo) {
  if (!userInfo || typeof userInfo !== 'object') return '';
  const skipKeys = new Set(['Name', 'name', 'rawText']); // Namen/roher Text nicht doppelt
  const parts = [];
  for (const [k, v] of Object.entries(userInfo)) {
    if (skipKeys.has(k)) continue;
    const val = v != null && typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : '');
    if (!val) continue;
    parts.push(`${k}: ${val}`);
  }
  return parts.length > 0 ? parts.join(', ') : '';
}

/**
 * Baut einen kurzen Text aus dem Fake-Logbuch (moderatorNotes, moderatorUpdates) für den Prompt.
 * Damit die KI z.B. Schwangerschaft („im 5. Monat schwanger“) oder andere Besonderheiten beachtet.
 * @param {Object} profileInfo - enthält moderatorNotes, moderatorUpdates
 * @returns {string} Text für FAKE-LOGBUCH-Block oder ''
 */
function buildFakeLogbookHint(profileInfo) {
  if (!profileInfo) return '';
  const notes = profileInfo.moderatorNotes;
  const updates = profileInfo.moderatorUpdates;
  const parts = [];
  if (notes) {
    if (typeof notes === 'string') parts.push(notes.trim());
    else if (Array.isArray(notes)) parts.push(notes.map(n => (n && (n.text ?? n.content ?? n.description ?? '')).trim()).filter(Boolean).join(' '));
  }
  if (updates && Array.isArray(updates)) {
    parts.push(updates.map(u => (u && (u.text ?? u.description ?? u.content ?? u.value ?? '')).trim()).filter(Boolean).join(' '));
  }
  const text = parts.join(' ').trim();
  return text ? text.slice(0, 800) : '';
}

/**
 * Prüft, ob im Fake-Logbuch bereits ein Wohnort-Eintrag steht (z.B. "Wohnort: X", "Ort: X").
 * Dann keine erneute OpenStreetMap-Suche und kein neuer Wohnort in die Summary.
 * @param {Object} profileInfo - enthält moderatorNotes, moderatorUpdates
 * @returns {boolean}
 */
function doesFakeLogbookContainWohnort(profileInfo) {
  const text = buildFakeLogbookHint(profileInfo);
  if (!text || !text.trim()) return false;
  return /\bwohnort\s*[:\-]|\bort\s*[:\-]|\blocality\s*[:\-]/i.test(text);
}

/**
 * Parst den Moderator-Namen in eine Liste von Vornamen (Doppel-/Mehrfachprofil).
 * Erkennt "X und Y" sowie "Sina, Lea, Paula, Samira" (Komma oder " und ").
 * @param {string} nameStr - name oder Vorname (z.B. "Sina, Lea, Paula, Samira, von li. nach re.")
 * @returns {{ fakeIsPlural: boolean, fakeNamesList: string[] }}
 */
function parseMultiFakeNames(nameStr) {
  const fakeNamesList = [];
  if (!nameStr || typeof nameStr !== 'string') return { fakeIsPlural: false, fakeNamesList };

  const parts = nameStr.split(/\s*,\s*|\s+und\s+/i).map(p => p.trim()).filter(Boolean);
  const skipPatterns = /^(von|nach|li\.?|re\.?)$/i;
  const looksLikeSuffix = (s) => skipPatterns.test(s) || /^\s*von\s/i.test(s) || /\s+nach\s+/i.test(s);

  for (const p of parts) {
    if (!p || p.length < 2) continue;
    if (looksLikeSuffix(p)) break;
    fakeNamesList.push(p);
  }

  const fakeIsPlural = fakeNamesList.length >= 2;
  return { fakeIsPlural, fakeNamesList: fakeIsPlural ? fakeNamesList : [] };
}

/**
 * Baut den Doppel-/Mehrpersonen-Hinweis inkl. Identitäten-Liste.
 * Wenn der Kunde einen der Namen nennt oder "euch" sagt, soll die KI als diese Person(en) antworten.
 */
function buildDoubleProfileHint(fakeIsPlural, fakeNamesList) {
  if (!fakeIsPlural || !fakeNamesList || fakeNamesList.length === 0) return '';

  const count = fakeNamesList.length;
  const namesStr = fakeNamesList.join(', ');
  const label = count === 2 ? 'DOPPELPROFIL' : 'MEHRPERSONEN-PROFIL';

  let hint = `${label}: Du schreibst fuer ${count} Personen (${namesStr}). Nutze "wir" statt "ich", "uns" statt "mich", "unsere" statt "meine" – als waeren ${count} Personen am Schreiben.\n`;
  hint += `ANREDE KUNDE: Der Kunde ist immer EINE Person. Sprich ihn/sie mit du, dich, dir an – niemals ihr, euch. (Du = wir/uns, Kunde = du/dich/dir.)\n`;
  hint += `IDENTITAETEN: Die Namen [${namesStr}] sind DEINE Identitaeten. Wenn der Kunde einen oder mehrere dieser Namen nennt (z.B. "Lea und Paula") oder "euch" sagt, antworte ALS diese Person(en) – bestaetige, dass ihr das seid, nicht ueber sie in der dritten Person.\n\n`;
  return hint;
}

function buildNormalPrompt({
  customerMessage,
  conversationHistory,
  situationRulesBlock,
  generalRulesBlock,
  learningContext,
  plan,
  examples,
  locationContext = null,
  doubleProfileHint = '',
  genderHint = '',
  isMidConversation = false,
  isMeetingSituation = false,
  isDirectMeetingRequest = false,
  isEmotional = false,
  noSexHint = false,
  isFamilyChildrenContext = false,
  imageRulesHint = false,
  isContactRequest = false,
  isCustomerIrritatedFlag = false,
  emotionalToneHint = null,
  imageContextHint = null,
  timeContextHint = null,
  shiftWorkTimeHint = '',
  knownFromCustomerMessage = '',
  imageOnlyAnnounced = false,
  fakeProfession = '',
  fakeLogbookHint = '',
  fakeName = ''
}) {
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR + PRIORITY_NOTE;
  const nameStr = (fakeName || '').trim();
  if (nameStr) {
    systemContent += `DEIN NAME (Fake-Profil): ${sanitizeForApiContent(nameStr)}. Bei Vorstellung oder wenn der Kunde nach deinem Namen fragt, NUR diesen Namen nennen – keinen anderen (z.B. nicht Anna, wenn du ${nameStr} heisst).\n\n`;
  }
  if (genderHint && genderHint.trim()) {
    systemContent += genderHint.trim() + '\n';
  }
  const professionStr = String(fakeProfession || '').trim();
  if (professionStr) {
    systemContent += `DEIN BERUF: ${sanitizeForApiContent(professionStr)}. Nenne nur diesen Beruf, keine anderen (z.B. Stylistin, Sekretärin aus Regeln).\n\n`;
  }
  if (fakeLogbookHint && fakeLogbookHint.trim()) {
    systemContent += `FAKE-LOGBUCH / BESONDERHEITEN (unbedingt beachten): ${sanitizeForApiContent(fakeLogbookHint.trim())}\n\n`;
    systemContent += 'Personen aus dem Logbuch (Freundin, Freund, Cousine, Kollege etc.) gehoeren DIR (Fake): in der Antwort immer „meine Freundin“, „mein Kollege“ – niemals „deine Freundin“ zum Kunden richten, sonst denkt er du meinst seine.\n\n';
    if (/schwanger|schwangerschaft|\.\s*monat\s+schwanger|im\s+\d+\.?\s*monat/i.test(fakeLogbookHint)) {
      systemContent += 'Wenn der Kunde "in welchem Monat" fragt und hier Schwangerschaft steht, ist der Schwangerschaftsmonat gemeint (z.B. 5. Monat), nicht der Geburtsmonat.\n\n';
    }
  }
  if (knownFromCustomerMessage && knownFromCustomerMessage.trim()) {
    systemContent += `BEKANNT AUS NACHRICHT/KONTEXT: ${sanitizeForApiContent(knownFromCustomerMessage.trim())}. Darauf eingehen, wenn es zur Nachricht passt.\n\n`;
  }
  if (timeContextHint && timeContextHint.trim()) {
    systemContent += `ZEIT: ${timeContextHint.trim()}\n\n`;
  }
  if (shiftWorkTimeHint && shiftWorkTimeHint.trim()) {
    systemContent += `${shiftWorkTimeHint.trim()}\n\n`;
  }
  if (imageContextHint && imageContextHint.trim()) {
    systemContent += `BILD: ${imageContextHint.trim()}\n\n`;
    const msgTrim = (customerMessage || '').trim();
    if (msgTrim.length <= 25) {
      systemContent += 'NUR BILD: Kunde hat nur ein Bild geschickt (keinen Text). Reagiere nur auf das Bild – kein Treffen, kein "morgen Zeit?", kein "besser kennenlernen". Frage zum Bild oder zum Thema Bild.\n\n';
    }
  }
  if (doubleProfileHint && doubleProfileHint.trim()) {
    systemContent += doubleProfileHint.trim() + '\n\n';
  } else {
    // Optional: Wenn kein Doppelprofil, kann der Kunde von sich in 3. Person sprechen – dann mit du/dich darauf eingehen
    systemContent += 'OPTIONAL – Dritte Person: Falls der Kunde von sich in der dritten Person spricht (z. B. "ein Juengling", "der Typ") – als Selbstaussage des Kunden interpretieren und mit du/dich darauf eingehen.\n\n';
  }
  if (isMidConversation) {
    systemContent += 'KONTEXT: Die Konversation laeuft bereits. Beginne die Nachricht NICHT mit Hey, Hi, Hallo oder aehnlichen Begruessungen – antworte direkt auf das Gesagte.\n\n';
  }
  if (isMeetingSituation) {
    if (isDirectMeetingRequest) {
      systemContent += 'TREFFEN/BAR-FRAGEN: NIEMALS Bar, Ort oder Uhrzeit nennen. Wenn der Kunde bereits Ideen genannt hat (z.B. Kino, Kaffee, kochen): Gehe darauf ein – sag was dir gefaellt, statt dieselben Ideen als neue Aufzaehlung zurueckzugeben. Keine konkrete Planung (Ort, Zeit, Zusage). VERBOTEN auch weiche Zusagen wie "am Abend koennten wir uns Zeit nehmen", "dann koennten wir", "am Abend passt", "Abend waere gut", "dann haetten wir Zeit" – klingt nach Zusage. Nur hypothetisch (wie toll es waere), keine Andeutung dass eine Zeit "passt" oder "wir uns Zeit nehmen". Ihr habt euch nie getroffen – keine Formulierung wie "dich wiederzusehen", "wiedersehen", "mal wieder treffen". Wenn der Kunde Terminvorschlaege oder Zeitfenster nennt: NICHT schreiben, dass die Zeiten dir passen oder du flexibel bist – unverbindlich bleiben. NIEMALS begruenden, dass du dich im Chat wohler fuehlst. Zeitangabe (morgen Abend, Wochenende) nur mit „im Chat“ oder „wenn wir schreiben“ – sonst wirkt es wie Treffen-Zusage. NICHT DOPPELN: Wenn du bereits einen konkreten Grund fuer das Ausweichen nennst (z.B. Arbeit, Wochenenddienst, zu spontan, keine Zeit, muss noch erledigen), schreibe NICHT zusaetzlich Saetze wie "ich moechte dich besser kennenlernen" oder "erst kennenlernen" – ein Grund reicht, sonst wirkt es gedoppelt. Beende mit einer klaren Gegenfrage.\n\n';
    } else {
      systemContent += 'TREFFEN/VORFREUDE: Der Kunde aeussert nur Vorfreude oder Hoffnung auf ein Treffen (z.B. "hoffe wir sehen uns bald"), keine konkrete Treffen-Anfrage. Ihr habt euch nie getroffen – keine Formulierung wie "dich wiederzusehen", "wiedersehen", "mal wieder treffen". Antworte NICHT mit "erst kennenlernen" oder "erst quatschen" – nutze die Vielfalt aus den Trainingsdaten (z.B. positiv darauf eingehen, Gegenfrage stellen). Keine Zusage zu Ort/Zeit. Beende mit einer klaren Gegenfrage.\n\n';
    }
  }
  if (isContactRequest) {
    systemContent += 'KONTAKTDATEN: An Trainingsdaten orientieren (dort ist gezeigt, wie ausweichen). Kunde fragt nach Nummer/WhatsApp/Telegram etc. – persoenlich ausweichen (z.B. Nummer nicht so schnell rausgeben, erst hier schreiben). VERBOTEN an den Kunden: "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten/duerfen nicht" – wirkt wie System-Regel. Nicht sexualisieren, thematisch passende Frage am Ende.\n\n';
  }
  if (isCustomerIrritatedFlag) {
    systemContent += 'GEREIZTER KUNDE: Kunde wirkt frustriert oder gereizt. Deeskalierend reagieren: freundlich, verstaendnisvoll, keine Sexualisierung, keine Rechtfertigung. Thema aufgreifen und mit einer ruhigen, thematisch passenden Frage abschliessen.\n\n';
  }
  if (isEmotional) {
    systemContent += 'EMOTIONEN: Kunde wirkt traurig/emotional. Reagiere unterstuetzend und verstaendnisvoll, keine sexuellen Anspielungen.\n\n';
  }
  if (emotionalToneHint && emotionalToneHint.trim()) {
    systemContent += `STIMMUNG: ${emotionalToneHint.trim()}\n\n`;
  }
  if (noSexHint) {
    systemContent += 'VIP-HINWEIS: Kunde moechte NICHT ueber Sex schreiben – keine sexuellen Formulierungen.\n\n';
  }
  if (isFamilyChildrenContext) {
    systemContent += 'KINDER/FAMILIE/ZUKUNFT: Kunde spricht ueber Kinder, Familie oder gemeinsame Zukunft – reagiere liebevoll und suess, KEINE expliziten sexuellen Formulierungen (kein Ficken, keine koerperlichen Details, keine sexuellen Fantasien). Thema bleibt Romantik/Familie.\n\n';
  }
  if (imageRulesHint) {
    systemContent += 'BILDER: Kunden schicken uns Bilder – reagiere positiv darauf, beschreibe das Bild NICHT. Wir schicken selbst keine Bilder – wenn der Kunde nach Fotos von uns fragt, finde einen Grund warum nicht (wie in Trainingsdaten).\n\n';
  }
  systemContent += EXTRA_RULES.orte + EXTRA_RULES.vorfreude;
  if (imageOnlyAnnounced) {
    systemContent += EXTRA_RULES.imageOnlyAnnounced;
  }
  if (situationRulesBlock && situationRulesBlock.trim()) {
    systemContent += sanitizeForApiContent(situationRulesBlock.trim());
    if (situationRulesBlock.includes('Bot-Vorwurf')) {
      systemContent += 'HINWEIS Bot-Vorwurf: Wenn der Kunde von SICH sagt er sei kein Fake/Bot (z.B. Antwort auf "Du bist Fake?") – er meint sich selbst. Dann auf seine Abwehr eingehen (z.B. einladen, wo hinkommen), nicht defensiv als ob er dich beschuldigt.\n\n';
    }
    if (situationRulesBlock.includes('Sexuell')) {
      systemContent += 'HINWEIS Sexuelle Themen: Orientiere dich an der Explizitheit der Kundennachricht – nicht ueberbieten. Schreibt der Kunde zurueckhaltend/andeutend, antworte ebenfalls zurueckhaltender; wird er expliziter, kannst du mitgehen. Nicht von dir aus eine Stufe drauflegen.\n\n';
    }
  }
  systemContent += 'ZENSUR/PLATTFORM: Die Plattform blendet oft Nummern, E-Mails, URLs oder Namen aus (z.B. als *** oder *****). Reagiere NICHT woertlich auf ***/Sternfolgen; schreibe KEINE *** in deine Antwort. Sag dem Kunden NICHT dass etwas zensiert oder ausgeblendet wird – ueberspiel es (z.B. auf die Absicht eingehen, hier weiterschreiben, thematisch antworten ohne die Stelle zu zitieren).\n\n';
  systemContent += generalRulesBlock;
  if (locationContext && (locationContext.fakeCity || locationContext.customerCity)) {
    const parts = [];
    if (locationContext.fakeCity) parts.push(`Fake-Wohnort = ${locationContext.fakeCity}`);
    if (locationContext.customerCity) parts.push(`Kunde = ${locationContext.customerCity}`);
    systemContent += `\nKONTEXT (Ort): ${parts.join(', ')}. Nenne eine Stadt, kein Bundesland. Bleib beim Thema Ort, erfinde keine anderen Staedte.`;
    if (locationContext.customerCity) {
      systemContent += ` Kunde wohnort bekannt (${sanitizeForApiContent(locationContext.customerCity)}) – NICHT erneut fragen wo er/sie herkommt oder woher er/sie kommt.`;
    }
    systemContent += '\n\n';
  }
  if (learningContext && learningContext.trim()) {
    systemContent += sanitizeForApiContent(learningContext.trim()) + '\n\n';
  }
  if (plan && plan.trim()) {
    systemContent += `PLAN (daran halten):\n${sanitizeForApiContent(plan.trim())}\n\n`;
  }
  systemContent += `LOGIK: Gehe auf die GESAMTE Kundennachricht ein – inkl. genannte Vorlieben, Beziehungsvorstellungen oder andere wichtige Punkte. Ignoriere keine Teile der Nachricht. Hat der Kunde bereits konkrete Vorschläge oder Ideen genannt (z.B. Aktivitäten, Optionen): Gehe darauf ein – sag was dir gefällt oder kommentiere, statt dieselben Ideen als neue Aufzählung oder Rückfrage zu wiederholen. Ihr habt euch nie getroffen – keine Formulierung wie "dich wiederzusehen", "wiedersehen", "mal wieder treffen". Konsistenz mit deiner letzten Nachricht: Hast du dort etwas abgelehnt oder eine Grenze gesetzt (z.B. "nicht X", "nur Y", Ablehnung eines Szenarios) – in der nächsten Antwort darfst du dieses abgelehnte Szenario nicht wieder einbauen oder die Grenze aufheben; gehe auf die aktuelle Kundenfrage ein und bleib bei deiner Grenze. Wenn der Kunde eine Einschränkung oder ein Problem andeutet (z.B. kann nicht mehr schreiben, keine Credits/Geld, will nicht, spricht dagegen, geht nicht): Gehe nicht nur kurz darauf ein und wechsle dann das Thema – stelle eine echte Nachfrage (warum? Was spricht dagegen? Ich dachte wir verstehen uns gut?) und zeige Neugier wie ein echter Mensch. Bei "Was machst du so?" / "Was machst du gerade?" im laufenden Chat: eher aktuelle Tätigkeit (gerade jetzt) nennen, nicht nur Beruf/Freizeit. Bei mehreren Punkten (z.B. Frage + Thema): auf ALLE eingehen. Wenn der Kunde eine Frage stellt, beantworte sie (oder weiche im Stil der Beispiele aus) und beende die Nachricht mit einer konkreten Gegenfrage. Jede Nachricht braucht eine Frage am Ende – zum Kontext passend, zum Thema oder das Thema erweiternd/vertiefend. Auch bei sexuellen Themen: am Ende eine kurze Frage, die zum Thema passt oder es vertieft (keine Treffen-Einladung). Mindestens 120 Zeichen. Natürlich und locker.
Stimmung: Reagiere passend auf die Stimmung des Kunden – warm und aufgeschlossen bei positivem/flirty Ton, verständnisvoll bei Traurigkeit, deeskalierend bei Unmut. Erkenne die Emotion hinter der Nachricht und spiegle sie angemessen.
Rechtschreibung: IMMER echte Umlaute (ä, ö, ü) – niemals ae, oe, ue (z.B. nächstes, wäre, möchte, für, könnte, schön). ss statt ß. Keine Anführungszeichen, keine Bindestriche.
Antworte NUR mit der einen Nachricht – keine Meta-Kommentare, keine Wiederholung der Kundennachricht wörtlich; eigenständig formuliert, mit Frage am Ende. Keine Erklärungen.

PFLICHT: Nur eine Nachricht ausgeben; Frage am Ende; keine Meta-Kommentare, keine wörtliche Wiederholung der Kundennachricht.`;

  let userContent = '';
  if (conversationHistory && conversationHistory.trim()) {
    const historySnippet = conversationHistory.substring(Math.max(0, conversationHistory.length - 800));
    userContent += `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(historySnippet)}\n\n`;
  }
  userContent += `Aktuelle Kundennachricht: "${sanitizeForApiContent(customerMessage || '')}"\n\n`;
  if (examples && examples.length > 0) {
    userContent += 'TRAININGS-BEISPIELE – Orientiere dich STARK an diesen Beispielen aus den Trainingsdaten: Stil, Ton und Aufbau übernehmen, Inhalt variieren. Antwort auf Frage + Gegenfrage wie in den Beispielen:\n';
    examples.slice(0, 8).forEach((ex, i) => {
      const resp = sanitizeForApiContent((ex.moderatorResponse || ex.assistant || '').toString());
      userContent += `${i + 1}. "${resp.substring(0, 180)}${resp.length > 180 ? '...' : ''}"\n`;
    });
    userContent += '\n';
  }
  userContent += 'Generiere genau eine Antwort (nur der Text).';

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

// ========== LLM-basierte Situationserkennung (Kontext statt nur Stichwörter) ==========

const SITUATION_DEFINITIONS_LLM = {
  'Treffen/Termine': 'Kunde erwähnt Treffen, sich sehen, kennenlernen, vorbeikommen, bei dir/bei mir, Date, Café, reale Aktivitäten. Auch wenn der Kunde konkrete Zeiträume, Tage oder Zeitfenster nennt (z.B. 01.-21.06, Juni, nächste Woche, Wochenende, einen bestimmten Monat/Tag), auch im sexuellen oder Fantasie-Kontext (z.B. Video/Foto zu einem Zeitraum) – dann ebenfalls wählen, damit keine Zusage zu Zeiten erfolgt.',
  'Wohnort-Frage': 'Kunde fragt wo du wohnst, woher du kommst, aus welcher Stadt/Region.',
  'Geld/Coins': 'Kunde spricht über Geld, Coins, Credits, Aufladen, Kosten – oder deutet an, dass er nicht mehr (hier) schreiben kann, keine Credits/Geld hat, schade dass er nicht mehr schreiben kann, kann keine Nachrichten mehr senden, Einschränkung wegen Credits/Geld.',
  'Bot-Vorwurf': 'Kunde unterstellt DIR (dem Profil) Bot, KI, Fake oder dass du nicht echt bist. NICHT waehlen, wenn der Kunde von SICH behauptet er sei kein Fake/Bot (z.B. Antwort auf "Du bist Fake?" – dann meint er sich selbst, nicht dich).',
  'Berufsfrage': 'Kunde fragt nach deinem Beruf, deiner Arbeit, was du arbeitest.',
  'Kontaktdaten außerhalb der Plattform': 'Kunde will Nummer, WhatsApp, Telegram, Instagram, Email teilen oder außerhalb der Plattform schreiben.',
  'Bilder Anfrage': 'Kunde möchte ein Foto/Bild von dir sehen, bittet darum etwas zu zeigen/zu sehen (z.B. Bild von dir, zeig mir, will sehen, deine Muschi/Brust/etc. sehen). Auch implizit: "will X sehen" wo X etwas ist, das man nur per Bild zeigen würde.',
  'Romantik / Verliebtheit': 'Kunde drückt Verliebtheit, emotionale Bindung, "sich hingeben" im Sinne von sich öffnen/binden, Bereitschaft für die Beziehung aus – ohne explizite sexuelle Aufforderung oder explizite Begriffe. Nur wenn keine klaren sexuellen Formulierungen (Sex, Körper, Lust, konkrete Handlungen) vorkommen.',
  'Sexuelle Themen': 'Nur wenn der Kunde explizit über Sex, konkrete sexuelle Handlungen, Körperteile, Lust oder eindeutige sexuelle Wünsche spricht. Nicht bei rein emotionaler/romantischer Formulierung wie Verliebtheit, "sich hingeben" (Bindung), "bereit für dich" (emotional) ohne sexuelle Begriffe.',
  'Wonach suchst du?': 'Kunde fragt wonach du suchst (Beziehung, was lockeres, etc.).',
  'Moderator/Outing': 'Kunde fragt ob du ein Chat-Moderator/Moderator bist.'
};

const ALLOWED_SITUATION_NAMES = new Set(Object.keys(SITUATION_DEFINITIONS_LLM));


/**
 * Erkennt Situationen anhand des Kontexts der Kundennachricht (LLM), nicht nur Stichwörter.
 * @param {string} customerMessage - Aktuelle Kundennachricht
 * @param {string} [conversationHistorySnippet] - Optional: letzte ~600 Zeichen Kontext
 * @returns {Promise<string[]|null>} Array der Situationsnamen oder null bei Fehler (dann allgemein, kein Stichwort-Fallback)
 */
async function detectSituationsWithLLM(customerMessage, conversationHistorySnippet = '') {
  if (!customerMessage || typeof customerMessage !== 'string' || !customerMessage.trim()) {
    return null;
  }
  const defsText = Object.entries(SITUATION_DEFINITIONS_LLM)
    .map(([name, def]) => `- "${name}": ${def}`)
    .join('\n');
  const contextSnippet = (conversationHistorySnippet || '').slice(-600).trim();
  const userContent = contextSnippet
    ? `Kontext (Auszug):\n${sanitizeForApiContent(contextSnippet)}\n\nAktuelle Kundennachricht: "${sanitizeForApiContent((customerMessage || '').slice(0, 400))}"`
    : `Kundennachricht: "${sanitizeForApiContent((customerMessage || '').slice(0, 400))}"`;
  const messages = [
    {
      role: 'system',
      content: `Du klassifizierst Kundennachrichten auf einer Dating-Plattform. Waehle ALLE zutreffenden Situationen aus der Liste. Mehrere Situationen sind moeglich (z.B. "Bilder Anfrage" + "Sexuelle Themen").

Situationen (nur diese Namen verwenden):
${defsText}

WICHTIG Bot-Vorwurf: Nur "Bot-Vorwurf" waehlen, wenn der Kunde DICH (das Profil) als Bot/Fake bezeichnet. NICHT waehlen, wenn im Kontext die letzte Nachricht vom Profil den Kunden als Fake bezeichnet hat (z.B. "Du bist Fake?") und der Kunde antwortet, er sei kein Fake – dann meint er sich selbst.

Antworte NUR mit einem JSON-Array der zutreffenden Situationsnamen, z.B. ["Bilder Anfrage", "Sexuelle Themen"]. Kein anderer Text, keine Erklaerung.`
    },
    { role: 'user', content: userContent }
  ];
  try {
    const raw = await callOpenAI(messages, {
      timeoutMs: OPENAI_SITUATION_TIMEOUT_MS,
      max_tokens: OPENAI_SITUATION_MAX_TOKENS,
      temperature: 0.2
    });
    const trimmed = (raw || '').trim();
    const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
    const arr = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(trimmed);
    if (!Array.isArray(arr)) return null;
    const valid = arr.filter(s => typeof s === 'string' && ALLOWED_SITUATION_NAMES.has(s));
    if (valid.length === 0) return null;
    return valid;
  } catch (err) {
    console.warn('⚠️ LLM-Situationserkennung (OpenAI) fehlgeschlagen:', err.message);
    return null;
  }
}

// ========== Situation für normale Reply (Fallback: Stichwörter) ==========

/** Gibt alle erkannten Situationen zurück (Mehrere pro Nachricht möglich). Fallback wenn LLM nicht genutzt wird oder fehlschlägt. */
function getDetectedSituations(customerMessage, allRules) {
  const lower = (customerMessage || '').toLowerCase();
  const out = [];
  if (lower.includes('treffen') || lower.includes('termine') || lower.includes('kennenlernen')) {
    out.push('Treffen/Termine');
  }
  if (lower.includes('wohnort') || lower.includes('wo wohnst') || lower.includes('woher')) {
    out.push('Wohnort-Frage');
  }
  if (lower.includes('geld') || lower.includes('coins') || lower.includes('credits')) {
    out.push('Geld/Coins');
  }
  if (lower.includes('bot') || lower.includes('ki') || lower.includes('fake')) {
    const selfDenial = /\b(ich\s+bin\s+)(kein(e)?\s+)?(fake|bot)\b|von\s+fake\s+weit\s+entfernt|(bin|ist)\s+echt\s+nicht\s+(fake|bot)|weit\s+entfernt\s+von\s+fake/i.test(lower);
    if (!selfDenial) out.push('Bot-Vorwurf');
  }
  if (lower.includes('beruf') || lower.includes('arbeit')) {
    out.push('Berufsfrage');
  }
  if (lower.includes('kontakt') || lower.includes('whatsapp') || lower.includes('telegram') || lower.includes('instagram') || lower.includes('nummer')) {
    out.push('Kontaktdaten außerhalb der Plattform');
  }
  const bildAnfrageMarkers = ['bild von dir', 'foto von dir', 'zeig mir ein bild', 'schick mir ein foto', 'bild von mir', 'foto von mir', 'hast du ein bild', 'hast du ein foto', 'kannst du mir ein bild', 'kannst du mir ein foto', 'möchte ein bild', 'moechte ein bild', 'will ein bild', 'will ein foto'];
  if (bildAnfrageMarkers.some(term => lower.includes(term))) {
    out.push('Bilder Anfrage');
  }
  // Romantik zuerst: Verliebtheit/Hingabe (emotional) ohne explizite Sexualität → Allgemein-Beispiele nutzen
  const romanticMarkers = ['verliebt', 'hingeben', 'bereit für dich'];
  const explicitSexualMarkers = ['sex', 'ficken', 'geil', 'heiß', 'kuss', 'kusse'];
  if (romanticMarkers.some(term => lower.includes(term)) && !explicitSexualMarkers.some(term => lower.includes(term))) {
    out.push('Romantik / Verliebtheit');
  }
  // Sexuelle Themen nur bei expliziten Begriffen (nicht bei "liebe"/"flirt" allein)
  if (explicitSexualMarkers.some(term => lower.includes(term))) {
    out.push('Sexuelle Themen');
  }
  return out;
}

/**
 * Erkennt, ob die Kundennachricht eine DIREKTE Treffen-Anfrage ist (Frage/Vorschlag: wann, wo, lass uns, darf ich einladen)
 * oder nur Vorfreude/Hoffnung aeussert (hoffe wir sehen uns bald, bin gespannt wenn wir uns sehen).
 * "Erst kennenlernen"-Ablehnung nur bei direkter Anfrage; bei reiner Vorfreude Vielfalt aus Trainingsdaten nutzen.
 * @param {string} customerMessage - aktuelle Kundennachricht
 * @returns {boolean} true = direkte Treffen-Anfrage; false = nur Vorfreude/Erwaehnung oder kein Treffen-Kontext
 */
function isDirectMeetingRequest(customerMessage) {
  if (!customerMessage || typeof customerMessage !== 'string') return false;
  const lower = customerMessage.trim().toLowerCase();
  // Nur Vorfreude/Hoffnung (ohne konkrete Frage oder Einladung) = NICHT direkt
  const onlyAnticipation = /\b(hoffe?|hoffnung|bin\s+gespannt|freue\s+mich|wird\s+(toll|schön|schön)|wäre\s+toll)\b.*\b(sehen|treffen|kennenlernen)\b/i.test(lower) &&
    !/\b(wann|wo|wie|kannst\s+du|kann\s+ich|darf\s+ich|lass\s+uns|wollen\s+wir|hast\s+du\s+zeit|passt\s+(dir|es)|was\s+machst\s+du)\b/i.test(lower);
  if (onlyAnticipation) return false;
  // Explizite Frage oder Vorschlag = direkt
  const directPatterns = [
    /\bwann\s+(können|kann|dürfen|darf)\s+(wir\s+uns\s+)?(treffen|sehen|kennenlernen)/i,
    /\b(kannst\s+du|kann\s+ich)\s+(vorbeikommen|dich\s+sehen|uns\s+treffen)/i,
    /\b(darf\s+ich\s+)?dich\s+(mal\s+)?(einladen|sehen|treffen)/i,
    /\blass\s+uns\s+(mal\s+)?(treffen|sehen)/i,
    /\bwollen\s+wir\s+(uns\s+)?(treffen|sehen)/i,
    /\b(hast\s+du|hättest\s+du)\s+zeit\s+(für\s+ein\s+treffen|morgen|am\s+\w+)/i,
    /\bwas\s+machst\s+du\s+(morgen|am\s+\w+|nächstes\s+wochenende)/i,
    /\bwann\s+(passt|geht)\s+(es\s+)?(dir|bei\s+dir)/i,
    /\b(wann|wo)\s+darf\s+ich\s+dich\s+sehen/i
  ];
  return directPatterns.some(re => re.test(lower));
}

// ========== Plan-then-Answer (Schritt 1: Plan) ==========

/**
 * @param {string} customerMessage - aktuelle Kundennachricht (vollständig für Plan)
 * @param {string[]} detectedSituations
 * @param {Object} allRules
 * @param {string} [conversationHistory] - Kontext: letzte Nachrichten (Auszug), damit Plan Konversation berücksichtigt
 */
async function runPlanningStep(customerMessage, detectedSituations, allRules, conversationHistory = '') {
  const situationList = Array.isArray(detectedSituations) && detectedSituations.length > 0
    ? detectedSituations.join(', ')
    : 'allgemein';
  const contactHint = Array.isArray(detectedSituations) && detectedSituations.some(s => (s || '').includes('Kontaktdaten'))
    ? ' Bei Kontaktdaten: persönlich ausweichen (Training-Daten). NIEMALS "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten" an den Kunden. Thematisch passende Frage am Ende.'
    : '';
  const sexualHint = Array.isArray(detectedSituations) && detectedSituations.some(s => (s || '').toLowerCase().includes('sexuell'))
    ? ' Bei Sexuelle Themen: auf sexuelle Inhalte und Fragen eingehen, nicht ausweichen – Ton und Regeln der Situation Sexuelle Themen beachten.'
    : '';
  const hasRomantik = Array.isArray(detectedSituations) && detectedSituations.some(s => (s || '').includes('Romantik'));
  const hasSexuell = Array.isArray(detectedSituations) && detectedSituations.some(s => (s || '').toLowerCase().includes('sexuell'));
  const romanticHint = hasRomantik && !hasSexuell
    ? ' Bei Romantik/Verliebtheit: warm, romantisch, flirty antworten – keine expliziten sexuellen Formulierungen.'
    : '';
  const contextSnippet = (conversationHistory || '').trim().slice(-700);
  const customerSnippet = (customerMessage || '').trim();
  const customerForPlan = customerSnippet.length > 600 ? customerSnippet.slice(0, 600) + '…' : customerSnippet;
  const contextBlock = contextSnippet
    ? `Kontext (Auszug aus dem Gespräch – beachten für Ton und Thema):\n${sanitizeForApiContent(contextSnippet)}\n\n`
    : '';
  const userContent = `${contextBlock}Aktuelle Kundennachricht: "${sanitizeForApiContent(customerForPlan)}"\n\nErkannte Situation(en): ${situationList}.${contactHint}${sexualHint}${romanticHint}\n\nGib in 2–4 Sätzen an: Welche Regeln/Prioritäten gelten hier? Welcher Ton? Worauf muss die Antwort eingehen? Nenne alle Aspekte der Kundennachricht (Fragen, Aussagen, Themen) – die Antwort muss auf alle eingehen. Was unbedingt vermeiden? Nur den Plan, keine Antwort an den Kunden.`;
  const messages = [
    {
      role: 'system',
      content: 'Du bist ein Assistent. Antworte nur mit 2–4 kurzen Sätzen auf Deutsch. Keine Anführungszeichen. Berücksichtige immer den Kontext und die vollständige Kundennachricht.'
    },
    { role: 'user', content: userContent }
  ];
  try {
    const planText = await callOpenAI(messages, {
      timeoutMs: OPENAI_PLAN_TIMEOUT_MS,
      max_tokens: OPENAI_PLAN_MAX_TOKENS,
      temperature: 0.3
    });
    return (planText || '').trim();
  } catch (err) {
    console.warn('⚠️ Plan-Schritt (OpenAI) fehlgeschlagen:', err.message);
    return '';
  }
}

// ========== Mistral als Korrektor ==========

const MISTRAL_CORRECTOR_TIMEOUT_MS = 20000;
const MISTRAL_CORRECTOR_MAX_TOKENS = 400;
const MISTRAL_CORRECTOR_MODEL = process.env.MISTRAL_CORRECTOR_MODEL || 'mistral-small-latest';
/** Minimal-Prompt nutzen, wenn ein eigenes Modell gesetzt ist (Fine-Tune): dann kommt das Gelernte aus dem Training durch, lange Anweisungen würden es überschreiben. */
const MISTRAL_USE_MINIMAL_PROMPT = !!(process.env.MISTRAL_CORRECTOR_MODEL && process.env.MISTRAL_CORRECTOR_MODEL.trim());

function getMistralClient() {
  const key = process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim();
  if (!key || !MistralClient) return null;
  return new MistralClient({ apiKey: key });
}

/**
 * Korrigiert die Grok-Antwort mit Mistral (gleiche Regeln wie OpenAI-Korrektor).
 * Nutzen wenn USE_MISTRAL_CORRECTOR=true und MISTRAL_API_KEY gesetzt.
 * Wenn MISTRAL_CORRECTOR_MODEL gesetzt ist (z. B. Fine-Tune): nur Daten übergeben, keine langen Regeln – das Modell nutzt das aus dem Training gelernte Verhalten.
 */
async function runMistralCorrector({ customerMessage = '', context = {}, grokText = '', learningContext = '', exampleSnippet = '', planSnippet = '', conversationSnippet = '' }) {
  if (!grokText || !grokText.trim()) return null;
  const client = getMistralClient();
  if (!client) return null;
  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push(context.isDirectMeetingRequest ? 'Thema Treffen/Bar/Zeit (direkte Anfrage)' : 'Thema Treffen/Vorfreude (keine direkte Anfrage)');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  if (context.contactRequest === true) ctx.push('Kunde fragt nach Kontaktdaten/Telegram/WhatsApp – persönlich ausweichen (Training-Daten); NIEMALS "nicht erlaubt"/"Regeln"/"Plattform" an den Kunden');
  if (context.fakeIsPlural === true) ctx.push('Doppelprofil (wir/uns) – Kunde ist EINE Person, anreden mit du/dich/dir, nie ihr/euch');
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';
  const planBlock = (planSnippet && planSnippet.trim()) ? `Plan (was die Antwort tun sollte): ${sanitizeForApiContent(planSnippet.trim().slice(0, 280))}${planSnippet.length > 280 ? '…' : ''}\n\n` : '';
  const conversationBlock = (conversationSnippet && conversationSnippet.trim()) ? `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(conversationSnippet.trim().slice(-450))}\n\n` : '';
  const fullCustomerMsg = (customerMessage || '').trim();
  const customerForCorrector = fullCustomerMsg.length > 800 ? fullCustomerMsg.slice(0, 800) + '…' : fullCustomerMsg;
  const learningBlock = (learningContext && learningContext.trim()) ? `Feedback/Stil (daran orientieren): ${learningContext.trim().slice(0, 400)}\n\n` : '';
  const exampleBlock = (exampleSnippet && exampleSnippet.trim()) ? `Beispiel einer guten Antwort (Stil/Struktur so): "${exampleSnippet.trim().slice(0, 220)}${exampleSnippet.length > 220 ? '…' : ''}"\n\n` : '';

  let systemContent;
  let userContent;

  // Wenn aktuelle Kundennachricht nicht sexuell ist: explizit sexuelle Formulierungen entfernen/entschärfen (verhindert sexualisierte Antwort bei neutraler Nachricht trotz sexualisierter Historie).
  const neutralMessageNoSexRule = (context.allowSexualContent !== true)
    ? ' WICHTIG: Wenn die AKTUELLE Kundennachricht keine sexuellen Themen enthaelt, entferne oder entschaerfe explizite sexuelle Formulierungen in der Antwort. Die Antwort muss zum Ton der aktuellen Nachricht passen – nicht zum Chat-Verlauf.'
    : '';
  // Leichte menschliche Tippfehler optional einbauen (nicht bei jeder Nachricht), damit es authentischer wirkt.
  const humanTyposHint = ' Optional (nicht bei jeder Nachricht): Fuege vereinzelt leichte, menschliche Tippfehler ein – z.B. Komma vergessen, ein Buchstabe zu viel, ein Nomen versehentlich klein. Nichts Dramatisches, nur hin und wieder.';
  // Kunde erzählt von Aktivität/Ort/Zeit (z.B. Sauna Geyre am ersten Montag): Persona darf NICHT behaupten, dieselbe Aktivität am selben Ort/Zeit zu machen – sonst Treffen-Erwartung.
  const sameActivityPlaceRule = ' Behauptet die Antwort, die Persona mache dieselbe Aktivitaet am selben Ort/Zeit wie der Kunde (z.B. "ich bin auch oft in Geyre am ersten Montag")? Wenn ja → umformulieren: nur Interesse zeigen (klingt toll, mag ich auch), NICHT behaupten, man sei dort oder mache es zur gleichen Zeit.';
  // Keine Paraphrase: Antwort soll nicht die Kundennachricht zusammenfassen oder seine Details nachplappern. Weniger Wiederholung.
  const noParaphraseRule = ' Fasst die Antwort die Kundennachricht nur zusammen oder wiederholt sie seine Details (Ort, Tag, Aktivitaet)? Wenn ja → kuerzen und umschreiben: nur EINEN Aspekt aufgreifen, eigenstaendig antworten, keine Aufzaehlung seiner Punkte. Kundennachricht weder woertlich noch sinngemäss nachplappern – in 1–2 Saetzen eigenstaendig darauf eingehen, Rest eigene Worte/Frage.';
  // Bild nur angekündigt: Kein "Danke für das Bild" / "sieht geil aus"
  const imageOnlyAnnouncedRule = (context.imageOnlyAnnounced === true)
    ? ' BILD NUR ANGEKUENDIGT: Kunde hat noch kein Bild geschickt. Enthaelt die Antwort "Danke fuer das Bild" oder Bewertung (sieht geil aus)? Wenn ja → entfernen/ersetzen durch Vorfreude (z.B. freue mich drauf), keine Bewertung eines nicht vorhandenen Bildes.'
    : '';
  // Orte: Nie behaupten, Ort (Café, Bar, etc.) zu kennen/mögen
  const noPlaceClaimRule = ' Enthaelt die Antwort, die Persona kenne oder moege einen vom Kunden genannten Ort (Café, Bar, Restaurant, Lokal)? Wenn ja → umformulieren: hoechstens allgemein (klingt nett), niemals "mag/kenne ich auch" zu konkretem Ortsnamen.';
  // Vorfreude nicht zu stark
  const noStrongHopeRule = ' Formuliert die Antwort feste Zusage oder starke Vorfreude (z.B. "freue mich schon auf das Wochenende mit dir")? Wenn ja → zurueckhaltender umformulieren.';
  // Nie getroffen: "wiedersehen"/"wiederzusehen"/"mal wieder treffen" impliziert ein bereits stattgefundenes Treffen – Kunde und Fake haben sich nie getroffen.
  const noWiedersehenRule = ' Enthaelt die Antwort "wiedersehen", "wiederzusehen", "mal wieder treffen" oder aehnlich (impliziert, ihr haettet euch schon getroffen)? Wenn ja → entfernen/umschreiben (ihr habt euch nie getroffen).';
  // "Hatte ich schon mal" / "das Vergnügen hatte ich schon": Kunde meint Erfahrung mit ANDEREN, nicht mit dem Fake – Antwort darf nicht so tun, als hätte er dich/deinen Körper schon erlebt.
  const noSharedPastRule = ' Enthaelt die Antwort eine Formulierung, als haette der Kunde DICH bzw. deinen Koerper schon erlebt (z.B. "dass du meinen X schon mal probiert hast", "dass du mich schon mal ...")? Kunde und Fake haben sich nie getroffen – Saetze wie "hatte ich schon mal" / "das Vergnuegen hatte ich schon" meinen seine Erfahrung mit ANDEREN. Wenn ja → umschreiben: auf seine Erfahrung eingehen, ohne so zu tun als haette er dich bereits erlebt.';
  // Allgemein: Grenzen einhalten – wenn die letzte Moderatoren-Nachricht etwas abgelehnt oder eine Grenze gesetzt hat, darf die naechste Antwort das nicht aufheben oder das abgelehnte Szenario wieder einbauen.
  const boundaryConsistencyRule = ' Enthaelt der Chat-Verlauf in der letzten Moderatoren-Nachricht eine Ablehnung oder Grenze (z.B. etwas abgelehnt, "nicht fuer X", "nur Y", klare Einschraenkung)? Wenn ja: Widerspricht die zu korrigierende Antwort dieser Grenze oder baut das abgelehnte Szenario wieder ein? Wenn ja → umschreiben: Grenze einhalten, auf die Kundenfrage eingehen, keine Wiederaufnahme des abgelehnten Themas.';
  // Kunde aeusert Einschraenkung/Problem (z.B. kann nicht mehr schreiben, keine Credits/Geld, will nicht, spricht dagegen): Antwort soll nachfragen (warum? was spricht dagegen? ich dachte wir verstehen uns gut?), nicht nur bestaetigen und Thema wechseln.
  const limitationFollowUpRule = ' Aeusert die Kundennachricht eine Einschraenkung oder ein Problem (z.B. kann nicht mehr schreiben, keine Credits/Geld, will nicht, spricht dagegen, geht nicht)? Wenn ja: Geht die Antwort nur kurz darauf ein und wechselt dann das Thema, ohne nachzufragen? Wenn ja → umschreiben: echte Nachfrage einbauen (warum? was spricht dagegen? ich dachte wir verstehen uns gut? was haelt dich ab?), Neugier zeigen, Thema nicht einfach wechseln.';
  // Kunde hat bereits konkrete Vorschlaege/Ideen genannt (z.B. Kino, Kaffee, kochen): Antwort soll darauf eingehen (sagen was gefaellt), nicht dieselben Ideen als neue Aufzaehlung oder Rueckfrage wiederholen.
  const engageOnSuggestionsRule = ' Hat der Kunde bereits konkrete Vorschlaege oder Ideen genannt (z.B. Aktivitaeten, Optionen)? Wenn ja: Gibt die Antwort nur eine aehnliche Aufzaehlung oder Rueckfrage zurueck, ohne auf seine genannten Ideen einzugehen (sagen was dir gefaellt)? Wenn ja → umschreiben: auf seine genannten Ideen eingehen, sagen was dir gefaellt oder kommentieren, statt dieselben Ideen als neue Aufzaehlung zurueckzugeben.';
  // Doppelprofil: Kunde ist EINE Person – nie ihr/euch, immer du/dich/dir
  const customerSingularRule = (context.fakeIsPlural === true)
    ? ' ANREDE KUNDE: Profil = 2 Personen (wir/uns). Der Kunde ist EINE Person. Enthaelt die Antwort "ihr"/"euch" in Bezug auf den Kunden (z.B. "was wuerdet ihr")? Wenn ja → in du/dich/dir aendern (z.B. "was wuerdest du").'
    : '';
  // Treffen: NIEMALS einem konkreten Tag/Ort/Zeit zustimmen – auch bei sexuellen Themen. Wie ausgewichen wird, kennt Mistral aus dem Training.
  const meetingRule = (context.isMeetingSituation === true)
    ? (context.isDirectMeetingRequest === true
      ? ' PFLICHT TREFFEN: Wenn Kontext "Thema Treffen/Bar/Zeit" enthaelt: Die Antwort darf NIEMALS einem konkreten Tag (z.B. Sonntag, Montag), einer Uhrzeit oder einem Ort zustimmen oder diese nennen. Auch keine Formulierung, dass die genannten Zeiten/Zeitfenster dir passen oder du flexibel bist (z.B. "passt gut mit den Zeiten", "bin da flexibel", "die Zeiten passen mir"). Auch KEINE weichen Zusagen wie "am Abend koennten wir uns Zeit nehmen", "dann koennten wir", "am Abend passt", "Abend waere gut", "dann haetten wir Zeit" – klingt nach Zusage. Saetze wie "Sonntag klingt gut", "dann passt mir", "komm vorbei" muessen entfernt oder umformuliert werden. Unverbindlich/hypothetisch umformulieren, keine Andeutung dass eine Zeit "passt" oder "wir uns Zeit nehmen". NICHT DOPPELN: Enthaelt die Antwort bereits einen konkreten Ausweichgrund (z.B. Arbeit, Wochenenddienst, zu spontan, keine Zeit, muss noch erledigen)? Wenn ja → Saetze wie "ich moechte dich besser kennenlernen", "erst kennenlernen", "dafuer brauche ich mehr Zeit" (als zweiter Grund) entfernen – ein Grund reicht. "Lass uns morgen Abend Zeit nehmen" / "dann klären wir" ohne "im Chat" oder "schreiben" → umformulieren (z.B. "wenn wir morgen schreiben, können wir klären") oder den Satz entfernen.'
      : ' TREFFEN/VORFREUDE: Der Kunde hat nur Vorfreude geaeussert (keine konkrete Treffen-Anfrage). Enthaelt die Antwort "kennenlernen" oder "erst quatschen" als Ablehnung? Wenn ja → umformulieren: positiv auf die Vorfreude eingehen oder Gegenfrage, wie in Trainingsdaten. Keine Standard-Ablehnung einbauen. Keine Zusage zu Ort/Zeit.')
    : '';
  // Jede Nachricht muss eine Frage enthalten (auch im Minimal-Prompt Pflicht) + ganze Nachricht abdecken
  const questionAndWholeRule = ' PFLICHT: Jede Nachricht muss eine Frage enthalten. Fehlt eine → eine passende Frage einbauen (z. B. am Ende). Geht die Antwort auf die ganze Kundennachricht ein (alle Themen/Fragen)? Fehlt ein Teil → kurzen Bezug ergänzen.';
  // Mindestlaenge 120 Zeichen: Korrektor erweitert zu kurze Nachrichten thematisch passend (keine generischen Floskeln)
  const minLengthRule = ' PFLICHT: Die Nachricht muss mindestens 120 Zeichen haben. Ist sie kuerzer: mit einem thematisch passenden Satz oder einer passenden Frage erweitern (zur Kundennachricht und zur Antwort passend), sodass mindestens 120 Zeichen. Keine generischen Fragen wie "Und bei dir so?" – nur inhaltlich passende Erweiterung.';
  // Plattform-Zensur (***): Antwort darf keine *** enthalten und nicht "zensiert"/"ausgeblendet" sagen – clever ueberspielen
  const censorshipRule = ' Enthaelt die Antwort *** oder ***** oder Formulierungen wie "wird zensiert", "ist ausgeblendet", "Plattform zeigt das nicht"? Wenn ja → entfernen und unauffaellig ueberspielen (z.B. auf Absicht eingehen, hier weiterschreiben), dem Kunden NICHT sagen dass zensiert wird.';
  // Treffen: Keine Aussagen wie "dann kann man sich oft treffen" / "mag es wenn man so nah wohnt" – zu verbindlich; kurze Bestaetigung (Da hast du recht) statt ausbauen
  const noOftTreffenRule = ' Enthaelt die Antwort Formulierungen wie "oft treffen", "richtig oft treffen", "kann man sich oft treffen", "mag es wenn man so nah wohnt", "da kann man sich oft treffen"? Wenn ja → diesen Satz/Teil entfernen oder durch kurze Bestaetigung ersetzen (z.B. "Da hast du recht."), nicht ausbauen.';
  // Zeit-Zusage immer verboten: Kunde nennt Zeitraum/Tag (z.B. 01.-21.06, Juni, nächste Woche) – Antwort darf NICHT zustimmen ("passt perfekt", "passt gut", "klingt gut"). Gilt auch bei Sex/Fantasy-Kontext.
  const noTimeAgreementRule = ' Hat der Kunde einen Zeitraum, Tag oder Zeitfenster genannt (z.B. 01.-21.06, Juni, nächste Woche, ein Datum)? Enthaelt die Antwort eine Zusage dazu (z.B. "passt perfekt", "passt gut", "klingt gut", "zwischen X und Y passt", "die Zeiten passen", "passt mir")? Wenn ja → umschreiben: keine Zusage zu Zeitfenstern/Tagen; unverbindlich bleiben oder auf anderes eingehen (z.B. auf die Idee/Stimmung), nicht auf den genannten Zeitraum zustimmen.';

  if (MISTRAL_USE_MINIMAL_PROMPT) {
    // Minimal-Prompt: nur Daten, keine langen Regeln. Eigenes Modell (z. B. Fine-Tune) hat bereits gelernt, wie korrigiert wird – lange Anweisungen würden das Gelernte überschreiben.
    // Bei Kontaktdaten: klare, umsetzbare Anweisung für Mistral (Korrektor hat keinen Zugriff auf Trainingsdaten – nur prüfen und ersetzen).
    const contactRuleMinimal = (context.contactRequest === true)
      ? ' Bei Kontaktdaten-Anfrage: Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten" oder "duerfen nicht"? Wenn ja → diese Formulierungen entfernen und persoenlich ausweichend ersetzen. Sonst Stil beibehalten.'
      : '';
    systemContent = 'PFLICHT: Nur die fertige korrigierte Nachricht zurueckgeben, keine Erklaerungen.\n\nDu bist ein Korrektor für Chat-Moderator-Antworten. Gib nur die fertige korrigierte Nachricht zurück, keine Erklärungen, keine Meta-Kommentare. Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten, nur klare Fehler korrigieren. Jede Nachricht muss eine Frage enthalten; maximal ein bis zwei Fragen, keine Frage-Kaskade. Mindestens 120 Zeichen – bei kürzerer Nachricht thematisch passend erweitern.' + contactRuleMinimal + noWiedersehenRule + noSharedPastRule + noTimeAgreementRule + boundaryConsistencyRule + censorshipRule + noOftTreffenRule + limitationFollowUpRule + engageOnSuggestionsRule + neutralMessageNoSexRule + meetingRule + questionAndWholeRule + minLengthRule + sameActivityPlaceRule + noParaphraseRule + imageOnlyAnnouncedRule + noPlaceClaimRule + noStrongHopeRule + customerSingularRule + humanTyposHint;
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht: "${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Antwort:\n\n${sanitizeForApiContent(grokText.trim())}`;
    if (process.env.NODE_ENV !== 'production') console.log('🔧 Mistral-Korrektor: Minimal-Prompt (eigenes Modell)');
  } else {
    const contactCheck = context.contactRequest === true ? '\n(6) Kontaktdaten: Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten"? → entfernen/umschreiben. Lehnt die Antwort die Kontakt-Anfrage nicht ab? → persoenlich ausweichend einbauen.' : '';
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht: "${sanitizeForApiContent(customerForCorrector)}"\n\nPrüfe die folgende Moderatoren-Antwort und korrigiere/verbessere sie:\n(1) Geht die Antwort auf die Kundennachricht ein? Wenn nein → umschreiben.\n(2) Enthält die Nachricht eine Frage? Wenn nein → Frage einbauen.\n(3) Hat die Nachricht mindestens 120 Zeichen? Wenn nein → thematisch passend erweitern (keine generischen Floskeln).\n(4) Umlaute (ä,ö,ü) und ss statt ß? Stil/Bindestriche?\n(5) Enthält die Antwort Meta-Kommentare oder wörtliche Wiederholung der Kundennachricht? Wenn ja → entfernen, eigenständig formulieren.${contactCheck}\nGib NUR den fertigen korrigierten Text zurück, keine Erklärungen.\n\nZu korrigierende Antwort:\n\n${sanitizeForApiContent(grokText.trim())}`;

    const imageOnlyAnnouncedRule = (context.imageOnlyAnnounced === true)
      ? ' BILD NUR ANGEKUENDIGT: Kunde hat noch kein Bild geschickt. "Danke fuer das Bild" oder Bewertung (sieht geil aus) → entfernen/ersetzen durch Vorfreude (freue mich drauf).'
      : '';
    const noPlaceClaimRule = ' Ort (Café, Bar, Restaurant) vom Kunden genannt und Antwort behauptet "mag/kenne ich auch"? → umformulieren, hoechstens allgemein (klingt nett).';
    const noStrongHopeRule = ' Starke Vorfreude (z.B. "freue mich schon auf das Wochenende mit dir")? → zurueckhaltender umformulieren.';
    const sexualRule = context.allowSexualContent === true
      ? (context.customerTalkingAboutSexWithFake === true
        ? 'WICHTIG: Kunde spricht direkt über Sex mit Fake – sexuelle Inhalte und eigene Erregung sind passend. Entferne oder entschärfe sie NICHT. Nur echte Regelverstöße korrigieren.'
        : 'WICHTIG: Kunde erzählt Story/Erlebnis (ohne direkten Sex-Bezug zum Fake) – eigene Erregungs-Beschreibungen der Moderatoren-Persona entschärfen oder entfernen. Auf Inhalt reagieren, nicht mit eigener körperlicher Reaktion. Flirty bleiben, ohne selbstbezogene Erregung.')
      : 'Wenn die AKTUELLE Kundennachricht keine sexuellen Themen enthaelt, entferne oder entschaerfe explizite sexuelle Formulierungen in der Antwort – die Antwort muss zum Ton der aktuellen Nachricht passen (nicht zum Chat-Verlauf). Ansonsten: sexuelle Formulierungen nur entfernen, wenn im Kontext "Kunde moechte nicht ueber Sex schreiben" steht.';
    const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
      ? (context.contactRequest === true
        ? 'KONTAKTDATEN: (1) Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten" oder "duerfen nicht"? Wenn ja → diese Formulierungen entfernen und persoenlich ausweichend ersetzen. (2) Lehnt die Antwort die Kontakt-Anfrage nicht ab? Wenn ja → persoenlich ausweichend einbauen (keine Nummer/Telegram nennen). Sachlich, thematisch passende Frage am Ende.'
        : 'Bei gereiztem Kunden: Antwort sachlich und deeskalierend, thematisch passende Frage am Ende.')
      : '';
    const metaRule = 'KEINE Meta-Kommentare, keine internen Notizen, keine Erklaerungen – ausschliesslich die eine Chat-Nachricht ausgeben.';
    const noEchoRule = 'Wiederhole die Kundennachricht NICHT woertlich oder fast woertlich. Formuliere eigenstaendig; gehe inhaltlich darauf ein, ohne seine Formulierungen zu echoen (z.B. nicht "dass du mich so X findest" wenn der Kunde "du bist so X" schrieb).';
    systemContent = `PFLICHT: Nur die fertige korrigierte Nachricht ausgeben, keine Erklaerungen.

Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide immer anhand des gesamten Kontexts und der Kundennachricht. ${sexualRule} ${contactIrritatedRule}${meetingRule} ${noWiedersehenRule} ${noSharedPastRule} ${noTimeAgreementRule} ${boundaryConsistencyRule} ${censorshipRule} ${noOftTreffenRule} ${limitationFollowUpRule} ${engageOnSuggestionsRule} ${metaRule} ${noEchoRule}${questionAndWholeRule}${minLengthRule}${sameActivityPlaceRule}${noParaphraseRule}${customerSingularRule} Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten, nur klare Fehler korrigieren. Jede Nachricht muss eine Frage enthalten; maximal ein bis zwei Fragen, keine Frage-Kaskade.${humanTyposHint} PFLICHT: Jede Nachricht muss eine Frage enthalten. Fehlt eine Frage, fuege UNBEDINGT eine kurze, thematisch passende Frage ein (z. B. am Ende). Die Antwort MUSS mindestens 120 Zeichen haben – bei kürzerer Nachricht thematisch passend erweitern (keine generischen Floskeln). Die Antwort MUSS auf die Kundennachricht eingehen. Wenn etwas zu korrigieren ist (fehlende Frage, kein Bezug, Kontaktdaten nicht abgelehnt, Meta/Wiederholung, Umlaute/ss, Stil), aendere es. Schreibe mit ä, ö, ü. Immer ss, nie ß. Keine Anführungszeichen. Keine Bindestriche. Antworte NUR mit der fertigen korrigierten Nachricht – kein anderer Text.`;
  }

  try {
    const response = await Promise.race([
      client.chat.complete({
        model: MISTRAL_CORRECTOR_MODEL,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3,
        maxTokens: MISTRAL_CORRECTOR_MAX_TOKENS
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Mistral Korrektor Timeout')), MISTRAL_CORRECTOR_TIMEOUT_MS))
    ]);
    const text = (response?.choices?.[0]?.message?.content || '').trim();
    if (text && text.length >= 20) {
      console.log('✅ Mistral-Korrektor: Nachricht korrigiert (' + grokText.length + ' → ' + text.length + ' Zeichen)');
      return text;
    }
  } catch (err) {
    console.warn('⚠️ Mistral-Korrektor fehlgeschlagen:', err.message);
  }
  return null;
}

// ========== Haupt-Einstieg: runGrokPipeline ==========

/**
 * Führt die komplette Grok-Pipeline aus.
 * @param {Object} opts
 * @param {string} opts.conversationHistory
 * @param {string} opts.customerMessage
 * @param {Object} opts.profileInfo
 * @param {Object} opts.extractedUserInfo
 * @param {Object} opts.allRules
 * @param {Object} opts.trainingData
 * @param {boolean} opts.isASA
 * @param {string} opts.asaConversationContext
 * @param {boolean} opts.isFirstMessage
 * @param {string} opts.firstMessageInstructions
 * @param {boolean} opts.hasLike
 * @param {boolean} opts.hasKuss
 * @param {Function} opts.isLocationQuestionFunc
 * @param {Function} opts.findNearbyCityFunc
 * @param {Function} [opts.vectorDbFunc] - für Few-Shot bei normaler Reply
 * @param {string} [opts.learningContext] - aus Feedback/Training (Vermeide/Bevorzuge, Stil)
 * @param {string[]} [opts.detectedSituationsFromReply] - von reply.js erkannte Situation(en)
 * @param {string[]} [opts.alertBoxMessages] - VIP-Hinweise (z.B. "Möchte nicht über Sex schreiben")
 * @param {string} [opts.imageDescription] - Bildbeschreibung (Kunde hat Bild geschickt – flirty/positiv reagieren)
 * @param {string} [opts.imageType] - Bildtyp (penis, nude, dildo, etc.)
 * @param {boolean} [opts.imageOnlyAnnounced] - Kunde kündigt nur ein Bild an, hat noch keins geschickt
 * @returns {Promise<Object>} { blocked, finalMessage, locationQuestionError, safety, stage2Examples, ... }
 */
async function runGrokPipeline(opts) {
  const {
    conversationHistory = '',
    customerMessage = '',
    profileInfo = {},
    extractedUserInfo = {},
    allRules = {},
    trainingData = {},
    isASA = false,
    asaConversationContext = '',
    isFirstMessage = false,
    firstMessageInstructions = '',
    hasLike = false,
    hasKuss = false,
    isLocationQuestionFunc = null,
    findNearbyCityFunc = null,
    vectorDbFunc = null,
    learningContext = '',
    detectedSituationsFromReply = null,
    alertBoxMessages = [],
    imageDescription = null,
    imageType = null,
    imageOnlyAnnounced = false
  } = opts;

  const emptyResult = (overrides = {}) => ({
    safety: { isBlocked: false, reason: null, errorMessage: null },
    blocked: false,
    finalMessage: '',
    locationQuestionError: null,
    stage2Examples: [],
    ...overrides
  });

  // —— 1. Safety (immer, sofern Kundentext vorhanden) ——
  const textToCheck = customerMessage || (isFirstMessage ? '' : ' ');
  if (textToCheck.trim()) {
    const safetyCheck = runSafetyCheck(textToCheck);
    if (safetyCheck.isBlocked) {
      console.error('🛡️ Grok-Pipeline: Safety blockiert –', safetyCheck.reason);
      return emptyResult({
        safety: safetyCheck,
        blocked: true,
        finalMessage: '',
        error: safetyCheck.errorMessage
      });
    }
  }
  const safetyCheck = { isBlocked: false, reason: null, errorMessage: null };

  // Mehrpersonen-Profil: Namen parsen (z.B. "Femke und Nadine" oder "Sina, Lea, Paula, Samira")
  const moderatorName = (profileInfo?.moderatorInfo?.name || extractedUserInfo?.assistant?.Name || '').trim();
  const moderatorFirstName = (profileInfo?.moderatorInfo?.firstName || profileInfo?.moderatorInfo?.Vorname || '').trim();
  const nameSource = moderatorFirstName || moderatorName;
  const { fakeIsPlural, fakeNamesList } = parseMultiFakeNames(nameSource || moderatorName);
  const doubleProfileHint = buildDoubleProfileHint(fakeIsPlural, fakeNamesList);

  // —— 2. Wohnort-Check (bei normaler Reply / nicht Erstnachricht, nicht ASA) ——
  if (!isFirstMessage && !isASA) {
    const loc = await checkLocationQuestion({
      customerMessage,
      conversationHistory,
      profileInfo,
      extractedUserInfo,
      isLocationQuestionFunc,
      findNearbyCityFunc
    });
    if (loc.locationQuestionError) {
      return emptyResult({
        safety: safetyCheck,
        locationQuestionError: loc.locationQuestionError
      });
    }
    if (loc.isLocationQuestion && loc.cityInstructions) {
      try {
        const messages = buildCityPrompt({
          allRules,
          cityInstructions: loc.cityInstructions,
          customerMessage,
          doubleProfileHint
        });
        let finalMessage = await callGrok(messages);
        finalMessage = postProcessMessage(finalMessage);
        // Wohnort-Antwort wie normale Nachricht: Mistral-Korrektor + Mindestlänge
        const useMistralCorrector = (process.env.USE_MISTRAL_CORRECTOR === 'true' || process.env.USE_MISTRAL_CORRECTOR === '1') && !!(process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim());
        const useCorrectorEnv = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
        const correctorModelId = (process.env.CORRECTOR_LORA_MODEL_ID || '').trim();
        const cityCorrectorContext = {
          isEmotional: false,
          noSexHint: true,
          isMeetingSituation: false,
          isDirectMeetingRequest: false,
          hasProfilePic: profileInfo?.customerInfo?.hasProfilePic === true,
          allowSexualContent: false,
          contactRequest: false,
          customerIrritated: false,
          customerTalkingAboutSexWithFake: false,
          imageOnlyAnnounced: false,
          fakeIsPlural: !!doubleProfileHint
        };
        const cityPlanSnippet = 'Wohnort-Frage: Antwort nennt den Wohnort (Stadt/Stadtteil) und stellt eine Frage zurück. Mindestens 120 Zeichen. Umlaute (ä, ö, ü), ss statt ß.';
        let corrected = null;
        if (useMistralCorrector) {
          console.log('🔧 Grok-Pipeline (Wohnort): rufe Mistral als Korrektor auf');
          corrected = await runMistralCorrector({
            customerMessage,
            context: cityCorrectorContext,
            grokText: finalMessage,
            learningContext: '',
            exampleSnippet: '',
            planSnippet: cityPlanSnippet,
            conversationSnippet: (conversationHistory || '').trim()
          });
        } else if (useCorrectorEnv && correctorModelId) {
          console.log('🔧 Grok-Pipeline (Wohnort): rufe Korrektor-LoRA auf');
          corrected = await correctAndImproveMessage({
            customerMessage,
            context: cityCorrectorContext,
            grokText: finalMessage,
            learningContext: '',
            exampleSnippet: ''
          });
        }
        if (corrected != null && corrected.trim()) {
          const lenOrig = finalMessage.length;
          const lenNew = corrected.trim().length;
          const minLen = Math.max(30, lenOrig * 0.4);
          const origNorm = finalMessage.trim().toLowerCase().replace(/\s+/g, ' ');
          const corrNorm = corrected.trim().toLowerCase().replace(/\s+/g, ' ');
          const isIdentical = origNorm === corrNorm || (origNorm.length > 20 && corrNorm.includes(origNorm) && corrNorm.length - origNorm.length < 15);
          if (lenNew >= minLen && !isIdentical) {
            finalMessage = postProcessMessage(corrected);
            console.log('✅ Grok-Pipeline (Wohnort): Korrektor-Ergebnis übernommen (' + lenOrig + ' → ' + lenNew + ' Zeichen)');
          }
        }
        finalMessage = removeCustomerEcho(customerMessage, finalMessage);
        finalMessage = postProcessMessage(finalMessage);
        finalMessage = await ensureQuestionInMessage(finalMessage, { customerMessage, conversationSnippet: (conversationHistory || '').trim().slice(-400) });
        finalMessage = await ensureMinimumLength(finalMessage, customerMessage);
        return emptyResult({
          safety: safetyCheck,
          finalMessage,
          stage2Examples: []
        });
      } catch (err) {
        console.error('❌ Grok Stadtauswahl:', err.message);
        return emptyResult({ finalMessage: '', error: err.message });
      }
    }
  }

  // —— 3. ASA ——
  if (isASA) {
    let asaExamples = (trainingData.asaExamples || []).filter(ex => ex.asaMessage && ex.asaMessage.trim().length >= 120);
    if (asaExamples.length === 0) {
      asaExamples = (trainingData.asaExamples || []).filter(ex => ex.moderatorResponse && ex.moderatorResponse.trim().length >= 120);
    }
    const oneExample = asaExamples.length > 0
      ? asaExamples[Math.floor(Math.random() * asaExamples.length)]
      : null;
    const selectedASAs = oneExample ? [oneExample] : [];
    try {
      // Nur bei explizit true: Aussehen kommentieren erlauben; sonst defensiv immer "kein Profilbild"-Hinweis
      const customerHasProfilePic = profileInfo?.customerInfo?.hasProfilePic === true;
      const messages = buildASAPrompt({
        allRules,
        asaConversationContext,
        asaExample: oneExample,
        doubleProfileHint,
        customerHasProfilePic,
        profileInfo,
        extractedUserInfo
      });
      const finalMessage = await callGrok(messages);
      return emptyResult({
        safety: safetyCheck,
        finalMessage: postProcessMessage(finalMessage),
        stage2Examples: selectedASAs.map(ex => ({
          customerMessage: 'ASA Reaktivierung',
          moderatorResponse: ex.asaMessage || ex.moderatorResponse || '',
          situation: 'ASA Reaktivierung',
          source: 'asa-example'
        }))
      });
    } catch (err) {
      console.error('❌ Grok ASA:', err.message);
      return emptyResult({ finalMessage: '', error: err.message });
    }
  }

  // —— 4. Erstnachricht ——
  if (isFirstMessage && firstMessageInstructions) {
    try {
      const messages = buildFirstMessagePrompt({
        allRules,
        firstMessageInstructions,
        profileInfo,
        extractedUserInfo,
        doubleProfileHint
      });
      let finalMessage = await callGrok(messages);
      finalMessage = postProcessMessage(finalMessage);
      if (finalMessage.length < 150) {
        const ext = hasKuss ? ' Wie geht es dir denn so?' : hasLike ? ' Wie geht es dir denn so?' : ' Wie geht es dir denn gerade so?';
        finalMessage = (finalMessage + ext).substring(0, 250);
      }
      return emptyResult({
        safety: safetyCheck,
        finalMessage,
        stage2Examples: []
      });
    } catch (err) {
      console.error('❌ Grok Erstnachricht:', err.message);
      return emptyResult({ finalMessage: '', error: err.message });
    }
  }

  // —— 5. Normale Reply ——
  // Kein Stichwort-Fallback: nur LLM-Ergebnis aus reply.js; bei leer → allgemein
  const detectedSituations = Array.isArray(detectedSituationsFromReply) && detectedSituationsFromReply.length > 0
    ? detectedSituationsFromReply.filter(s => s && s !== 'allgemein')
    : [];
  // Bei Kinder/Familie/Zukunft: Sexual-Situation nicht in den Prompt – keine expliziten sexuellen Regeln
  const situationsForRulesBlock = isMessageAboutFamilyOrChildren(customerMessage)
    ? (detectedSituations || []).filter(s => !(s || '').toLowerCase().includes('sexuell'))
    : (detectedSituations || []);
  const situationRulesBlock = buildSituationRulesBlock(situationsForRulesBlock, allRules);
  const generalRulesBlock = buildGeneralRulesBlock(allRules);
  const primarySituation = detectedSituations.length > 0 ? detectedSituations[0] : null;

  // Punkt 2 + 7: Verhalten aus Feedback (Vermeide/Bevorzuge) – Fallback wenn reply.js keinen learningContext übergibt
  let effectiveLearningContext = (learningContext && learningContext.trim()) ? learningContext.trim() : '';
  if (!effectiveLearningContext) {
    try {
      const stats = await getLearningStats();
      if (stats && Object.keys(stats).length > 0) {
        effectiveLearningContext = await generateCompactLearningContext(
          customerMessage,
          primarySituation || detectedSituations,
          stats
        ) || '';
      }
    } catch (e) {
      // ignore
    }
  }

  // Bei Treffen/Termine, Kontaktdaten oder Bilder Anfrage mehr Beispiele laden (streng an Trainingsdaten: ablehnen, freundlich, Frage am Ende)
  const exampleTopK = (primarySituation === 'Treffen/Termine' || primarySituation === 'Kontaktdaten außerhalb der Plattform' || primarySituation === 'Bilder Anfrage') ? 8 : 5;
  // Romantik/Verliebtheit: Trainings-Beispiele sind unter "Allgemein" – keine Situationsfilterung, nur Ähnlichkeit
  let situationsForExamples = (primarySituation === 'Romantik / Verliebtheit')
    ? null
    : (detectedSituations.length > 0 ? detectedSituations : null);
  // Fallback: Wenn Kunde Einschränkung/Credits/Geld andeutet (z.B. "kann nicht mehr schreiben"), aber LLM hat "Geld/Coins" nicht erkannt – für Beispielauswahl trotzdem "Geld/Coins" nutzen, damit passende Trainings-Beispiele gefunden werden
  const limitationKeywords = ['nicht mehr schreiben', 'keine credits', 'kein geld', 'credits', 'coins', 'kann nicht mehr', 'schade dass ich nicht mehr', 'keine nachrichten mehr', 'aufladen', 'kosten'];
  const suggestsGeldCoins = limitationKeywords.some(k => (customerMessage || '').toLowerCase().includes(k));
  if (suggestsGeldCoins && (!situationsForExamples || !situationsForExamples.includes('Geld/Coins'))) {
    situationsForExamples = situationsForExamples ? [...situationsForExamples, 'Geld/Coins'] : ['Geld/Coins'];
    if (process.env.NODE_ENV !== 'production') console.log('🔍 Beispielauswahl: Geld/Coins ergänzt (Kunde deutet Einschränkung/Credits an)');
  }
  let examples = [];
  if (vectorDbFunc && typeof vectorDbFunc === 'function') {
    try {
      examples = await vectorDbFunc(customerMessage, { topK: exampleTopK, situation: situationsForExamples, conversationHistory, includeSexual: true }) || [];
    } catch (e) {
      // ignore
    }
  }
  if (examples.length === 0 && customerMessage) {
    try {
      examples = await selectSmartExamples(customerMessage, {
        topK: exampleTopK,
        situation: situationsForExamples,
        conversationHistory,
        includeSexual: true
      }) || [];
    } catch (e) {
      // ignore
    }
  }
  if (examples.length === 0 && customerMessage) {
    try {
      examples = await vectorDbFunc(customerMessage, { topK: exampleTopK, situation: null, conversationHistory, includeSexual: true }) || [];
    } catch (e) {
      // ignore
    }
  }
  if (examples.length === 0 && customerMessage) {
    try {
      examples = await selectSmartExamples(customerMessage, { topK: exampleTopK, conversationHistory, includeSexual: true }) || [];
    } catch (e) {
      // ignore
    }
  }

  let plan = '';
  try {
    plan = await runPlanningStep(customerMessage, detectedSituations, allRules, conversationHistory);
    if (plan) console.log('✅ Grok Plan-Schritt:', plan.substring(0, 80) + (plan.length > 80 ? '...' : ''));
  } catch (e) {
    // continue without plan
  }

  // Orts-Kontext für Normal-Reply: NUR wenn Kunde wirklich nach Wohnort fragt (Wohnort-Frage).
  // Wohnort-Suche (findNearbyCity) nur, wenn im Fake-Logbuch noch KEIN Wohnort steht.
  let locationContext = null;
  const isWohnortFrage = detectedSituations && detectedSituations.some(s => s === 'Wohnort-Frage');
  let fakeCity = profileInfo?.moderatorInfo?.city || profileInfo?.moderatorInfo?.Wohnort ||
    extractedUserInfo?.assistant?.city || extractedUserInfo?.assistant?.Wohnort || null;
  let customerCity = profileInfo?.customerInfo?.city || profileInfo?.customerInfo?.wohnort || profileInfo?.customerInfo?.Wohnort ||
    extractedUserInfo?.user?.Wohnort || extractedUserInfo?.user?.wohnort || extractedUserInfo?.user?.city || null;
  fakeCity = fakeCity && (fakeCity + '').toLowerCase() !== 'sag ich später' ? (fakeCity + '').trim() : null;
  customerCity = customerCity ? (customerCity + '').trim() : null;
  const hasWohnortInLogbook = doesFakeLogbookContainWohnort(profileInfo);
  const fakeHasWohnortAlready = (fakeCity && fakeCity.trim() && !isBundesland(fakeCity)) || hasWohnortInLogbook;
  if (!isWohnortFrage) {
    locationContext = null;
  } else if (fakeHasWohnortAlready) {
    locationContext = { fakeCity: fakeCity, customerCity: customerCity || null };
  } else if (findNearbyCityFunc && typeof findNearbyCityFunc === 'function') {
    let resolvedFakeCity = fakeCity && !isBundesland(fakeCity) ? fakeCity : null;
    const inputForResolve = customerCity || fakeCity;
    if (inputForResolve && (!resolvedFakeCity || isBundesland(fakeCity))) {
      try {
        const nearbyCity = await findNearbyCityFunc(inputForResolve);
        if (nearbyCity && nearbyCity.trim()) resolvedFakeCity = nearbyCity.trim();
      } catch (e) {
        if (fakeCity) resolvedFakeCity = fakeCity;
      }
    }
    if (!resolvedFakeCity && fakeCity) resolvedFakeCity = fakeCity;
    if (resolvedFakeCity || customerCity) {
      locationContext = { fakeCity: resolvedFakeCity, customerCity: customerCity || null };
    }
  } else if (fakeCity || customerCity) {
    locationContext = { fakeCity: fakeCity || null, customerCity: customerCity || null };
  }

  // Mitten in der Konversation: kein "Hey"/"Hi"/"Hallo" am Anfang
  const isMidConversation = (conversationHistory || '').trim().length > 150;

  const isMeetingSituation = detectedSituations && detectedSituations.includes('Treffen/Termine');
  const isDirectMeetingRequestFlag = isMeetingSituation && isDirectMeetingRequest(customerMessage);
  const isContactRequest = detectedSituations && detectedSituations.some(s => (s || '').includes('Kontaktdaten'));
  const isCustomerIrritatedFlag = isCustomerIrritated(conversationHistory);
  const isEmotional = isEmotionalContext(customerMessage) || isEmotionalContext((conversationHistory || '').slice(-600));
  const emotionalTone = getEmotionalTone(customerMessage, conversationHistory);
  const emotionalToneHint = (emotionalTone === 'flirty_positive')
    ? 'Kunde wirkt positiv/flirty. Reagiere warm und aufgeschlossen, gleiche Energie, thematisch passende Frage am Ende.'
    : null;
  const customerTalkingAboutSexWithFake = isCustomerTalkingAboutSexWithFake(customerMessage);
  const alertStr = (Array.isArray(alertBoxMessages) ? alertBoxMessages : []).map(m => (typeof m === 'string' ? m : (m && m.text) || '')).join(' ').toLowerCase();
  const noSexHint = (alertStr.includes('nicht') && alertStr.includes('sex')) || alertStr.includes('kein sex') || alertStr.includes('nicht über sex') || alertStr.includes('nicht ueber sex') || alertStr.includes('moechte nicht') && alertStr.includes('sex');
  const imageContextHint = (imageDescription && imageDescription.trim())
    ? `${imageDescription.trim()} Reagiere flirty und positiv auf das Bild – lehne nie ab.`
    : null;
  const { weekday, timePhase, hour } = getBerlinTimeContext();
  const timeContextHint = `Heute ${weekday}, ${timePhase}. Nur Aktivitaeten nennen, die dazu passen (z.B. Sonntag kein Einkaufen, nachts keine Arbeit).`;
  const filteredUserInfo = filterTimeSensitiveNotes(extractedUserInfo?.user, customerMessage);
  const knownFromCustomerMessage = buildKnownFromCustomerMessage(filteredUserInfo);
  const fakeLogbookHint = buildFakeLogbookHint(profileInfo);
  const fakeProfessionForShift = (profileInfo?.moderatorInfo?.occupation || extractedUserInfo?.assistant?.Work || extractedUserInfo?.assistant?.Beruf || '').trim();
  const shiftWorkTimeHint = buildShiftWorkTimeHint(hour, fakeProfessionForShift, fakeLogbookHint);

  // Geschlechter-Rollen (wie in multi-agent): aus Profil oder Name/Profilbild ableiten
  const customerName = (profileInfo?.customerInfo?.name || extractedUserInfo?.user?.Name || '').trim();
  const fakeGender = extractedUserInfo?.assistant?.Gender || profileInfo?.moderatorInfo?.gender || inferGenderFromName(moderatorName);
  const customerGender = profileInfo?.customerInfo?.gender || extractedUserInfo?.user?.Gender || inferGenderFromName(customerName);
  const hasSexualSituation = detectedSituations && detectedSituations.some(s => (s || '').includes('Sexuell'));
  const genderHint = buildGenderHint(fakeGender, customerGender, hasSexualSituation);
  const fakeProfession = (profileInfo?.moderatorInfo?.occupation || extractedUserInfo?.assistant?.Work || extractedUserInfo?.assistant?.Beruf || '').trim();

  try {
    const messages = buildNormalPrompt({
      customerMessage,
      conversationHistory,
      situationRulesBlock,
      generalRulesBlock,
      learningContext: effectiveLearningContext,
      plan,
      examples,
      locationContext,
      doubleProfileHint, // bereits oben berechnet
      genderHint,
      isMidConversation,
      isMeetingSituation,
      isDirectMeetingRequest: isDirectMeetingRequestFlag,
      isEmotional,
      noSexHint,
      isFamilyChildrenContext: isMessageAboutFamilyOrChildren(customerMessage),
      imageRulesHint: true, // Kunden schicken Bilder -> positiv reagieren, nicht beschreiben; wir schicken keine -> Grund finden (Trainingsdaten)
      isContactRequest,
      isCustomerIrritatedFlag,
      emotionalToneHint,
      imageContextHint,
      timeContextHint,
      shiftWorkTimeHint,
      knownFromCustomerMessage,
      imageOnlyAnnounced: !!opts.imageOnlyAnnounced,
      fakeProfession,
      fakeLogbookHint,
      fakeName: moderatorName || extractedUserInfo?.assistant?.Name || ''
    });
    let finalMessage = '';
    let noQuestionError = false;
    for (let questionAttempt = 1; questionAttempt <= 2; questionAttempt++) {
      finalMessage = await callGrok(messages);
      finalMessage = postProcessMessage(finalMessage);
      // ========== KORREKTOR: Mistral (USE_MISTRAL_CORRECTOR) | LoRA ==========
    const useMistralCorrector = (process.env.USE_MISTRAL_CORRECTOR === 'true' || process.env.USE_MISTRAL_CORRECTOR === '1') && !!(process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim());
    const useCorrectorEnv = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
    const correctorModelId = (process.env.CORRECTOR_LORA_MODEL_ID || '').trim();
    const imageOnlyAnnouncedFlag = !!opts.imageOnlyAnnounced;
    const correctorContext = {
      isEmotional,
      noSexHint,
      isMeetingSituation,
      isDirectMeetingRequest: isDirectMeetingRequestFlag,
      hasProfilePic: profileInfo?.customerInfo?.hasProfilePic === true,
      allowSexualContent: !isMessageAboutFamilyOrChildren(customerMessage) && detectedSituations && detectedSituations.some(s => (s || '').includes('Sexuell')) && !noSexHint,
      contactRequest: isContactRequest,
      customerIrritated: isCustomerIrritatedFlag,
      customerTalkingAboutSexWithFake,
      imageOnlyAnnounced: imageOnlyAnnouncedFlag,
      fakeIsPlural
    };
    const exampleSnippet = (examples && examples.length > 0 && (examples[0].moderatorResponse || examples[0].assistant))
      ? String(examples[0].moderatorResponse || examples[0].assistant).trim().slice(0, 250)
      : '';
    let corrected = null;
    const correctorPlanSnippet = (plan || '').trim();
    const correctorConversationSnippet = (conversationHistory || '').trim();
    if (useMistralCorrector) {
      console.log('🔧 Grok-Pipeline: rufe Mistral als Korrektor auf');
      corrected = await runMistralCorrector({
        customerMessage,
        context: correctorContext,
        grokText: finalMessage,
        learningContext: effectiveLearningContext || '',
        exampleSnippet,
        planSnippet: correctorPlanSnippet,
        conversationSnippet: correctorConversationSnippet
      });
    } else if (useCorrectorEnv && correctorModelId) {
      console.log('🔧 Grok-Pipeline: rufe Korrektor-LoRA auf (Modell: ' + correctorModelId + ')');
      corrected = await correctAndImproveMessage({
        customerMessage,
        context: correctorContext,
        grokText: finalMessage,
        learningContext: effectiveLearningContext || '',
        exampleSnippet
      });
    }
    // Nur übernehmen wenn Korrektor echtes Ergebnis liefert und tatsächlich etwas geändert hat
    if (corrected != null && corrected.trim()) {
      const lenOrig = finalMessage.length;
      const lenNew = corrected.trim().length;
      const minLen = Math.max(30, lenOrig * 0.4);
      const origNorm = finalMessage.trim().toLowerCase().replace(/\s+/g, ' ');
      const corrNorm = corrected.trim().toLowerCase().replace(/\s+/g, ' ');
      const isIdentical = origNorm === corrNorm || (origNorm.length > 20 && corrNorm.includes(origNorm) && corrNorm.length - origNorm.length < 15);
      if (lenNew >= minLen && !isIdentical) {
        finalMessage = postProcessMessage(corrected);
        console.log('✅ Grok-Pipeline: Korrektor-Ergebnis übernommen (' + lenOrig + ' → ' + lenNew + ' Zeichen)');
      } else if (isIdentical) {
        console.log('ℹ️ Grok-Pipeline: Korrektor gab (nahezu) unveränderten Text zurück – keine Änderung, behalte Original');
      } else {
        console.log('ℹ️ Grok-Pipeline: Korrektor-Ergebnis verworfen (zu kurz: ' + lenNew + ' < ' + minLen + ')');
      }
    } else if (useMistralCorrector) {
      console.log('ℹ️ Grok-Pipeline: Mistral-Korrektor kein Ergebnis, behalte Original');
    } else if (useCorrectorEnv && correctorModelId) {
      console.log('ℹ️ Grok-Pipeline: Korrektor kein Ergebnis (LoRA leer/Fehler/aus), behalte Original');
    }
    // Post-Processing: Woertliche Wiederholungen der Kundennachricht entfernen (KIs ignorieren Prompt-Anweisung)
    finalMessage = removeCustomerEcho(customerMessage, finalMessage);
    finalMessage = removeOftTreffenPhrases(finalMessage);
    finalMessage = removeDoubledKennenlernen(finalMessage);
    finalMessage = removeMeetingTimePhrases(finalMessage);
    finalMessage = removeTreffenWhenOnlyImage(finalMessage, customerMessage);
    finalMessage = postProcessMessage(finalMessage);
    const MAX_FINAL = 250;
    if (finalMessage.length > MAX_FINAL) {
      const truncated = finalMessage.substring(0, MAX_FINAL);
      const lastEnd = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf('!'), truncated.lastIndexOf('?'));
      // Immer an Satzgrenze abschneiden, wenn mind. 80 Zeichen uebrig (nie mitten im Satz enden)
      const minLengthAtSentence = 80;
      finalMessage = (lastEnd >= minLengthAtSentence)
        ? truncated.substring(0, lastEnd + 1).trim()
        : truncated.trim();
      finalMessage = postProcessMessage(finalMessage);
    }
    // Post-Processing: Sicherstellen, dass die Nachricht eine Frage enthaelt (mit Kontext + Regeln, damit OpenAI keine Treffen-Fragen einbaut)
    finalMessage = await ensureQuestionInMessage(finalMessage, {
      customerMessage,
      conversationSnippet: (conversationHistory || '').trim().slice(-400)
    });
      if (finalMessage.includes('?')) break;
      if (questionAttempt === 1) console.log('🔄 Keine Frage in Nachricht – Generierung wird einmal wiederholt...');
    }
    if (!finalMessage.includes('?')) {
      noQuestionError = true;
      console.warn('❌ Nachricht enthaelt auch nach 2. Versuch keine Frage – noQuestionError gesetzt (Client zeigt rote Meldung)');
    }
    finalMessage = await ensureMinimumLength(finalMessage, customerMessage);
    return emptyResult({
      safety: safetyCheck,
      finalMessage,
      stage2Examples: Array.isArray(examples) ? examples.slice(0, 8) : [],
      noQuestionError,
      locationContext: locationContext || null
    });
  } catch (err) {
    console.error('❌ Grok normale Reply:', err.message);
    return emptyResult({ finalMessage: '', error: err.message });
  }
}

/**
 * Entfernt Treffen/Kennenlernen-Sätze, wenn der Kunde nur ein Bild geschickt hat (keinen Text).
 * @param {string} msg - finale Nachricht
 * @param {string} customerMessage - aktuelle Kundennachricht
 * @returns {string}
 */
function removeTreffenWhenOnlyImage(msg, customerMessage) {
  if (!msg || typeof msg !== 'string') return msg;
  const txt = (customerMessage || '').trim();
  if (txt.length > 25) return msg;
  let out = msg;
  if (/morgen\s+zeit\s*\?/i.test(out)) {
    out = out.replace(/\s*[,.]?\s*Morgen\s+Zeit\s*\?[^.!?]*[.!?]/gi, ' ');
  }
  if (/\b(ich\s+)?nehm\s+mir\s+(lieber\s+)?(noch\s+)?Zeit\s+dich\s+(erst\s+)?besser\s+kennenzulernen/i.test(out)) {
    out = out.replace(/\s*[,.]?\s*[Ii]ch\s+nehm\s+mir\s+(lieber\s+)?(noch\s+)?[Zz]eit\s+dich\s+(erst\s+)?besser\s+kennenzulernen[^.!?]*[.!?]/gi, ' ');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Ersetzt Formulierungen wie "lass uns morgen Abend Zeit nehmen" durch Chat-Version, damit es nicht wie Treffen-Zusage klingt.
 * @param {string} msg - finale Nachricht
 * @returns {string}
 */
function removeMeetingTimePhrases(msg) {
  if (!msg || typeof msg !== 'string') return msg;
  let out = msg;
  if (/lass\s+uns\s+(morgen\s+abend|am\s+wochenende|morgen|übermorgen|uebermorgen)\s+zeit\s+(für\s+uns\s+)?nehmen/i.test(out) && !/im\s+chat|schreiben|hier\s+im\s+chat/i.test(out)) {
    out = out.replace(/\s*[,.]?\s*Lass\s+uns\s+(morgen\s+Abend|am\s+Wochenende|morgen|übermorgen|uebermorgen)\s+Zeit\s+(für\s+uns\s+)?nehmen[^.!?]*(?:,\s*um\s+[^.!?]+)?[.!?]/gi, '. Wenn wir dann wieder schreiben, können wir drüber reden.');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Entfernt den gedoppelten "kennenlernen"-Satz, wenn bereits ein konkreter Ausweichgrund in der Nachricht steht
 * (z.B. Wochenenddienst, zu spontan, keine Zeit) – ein Grund reicht.
 * @param {string} msg - finale Nachricht
 * @returns {string}
 */
function removeDoubledKennenlernen(msg) {
  if (!msg || typeof msg !== 'string') return msg;
  const lower = msg.toLowerCase();
  const hasReason = /\b(wochenenddienst|zu spontan|keine zeit|muss noch|erledigen|gerade arbeiten|bin gerade|hab gerade|deshalb ist das|dafür ist das|echt zu spontan)\b/.test(lower);
  if (!hasReason) return msg;
  const kennenlernenSentence = /\s*[,.]?\s*(aber\s+)?ich\s+(möchte|moechte)\s+dich\s+(noch\s+)?besser\s+kennenlernen[^.!?]*[.!?]/gi;
  let out = msg.replace(kennenlernenSentence, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Entfernt/ersetzt Saetze mit verbotenen Treffen-Phrasen (z.B. "da kann man sich oft treffen")
 * durch kurze Bestaetigung – ohne Prompt zu vergroessern.
 * @param {string} msg - finale Nachricht
 * @returns {string}
 */
function removeOftTreffenPhrases(msg) {
  if (!msg || typeof msg !== 'string') return msg;
  const lower = msg.toLowerCase();
  const hasForbidden = /\b(?:oft\s+treffen|kann\s+man\s+sich\s+(?:ja\s+)?(?:richtig\s+)?oft\s+treffen|(?:mag|liebe)\s+es\s+(?:auch\s+)?wenn\s+(?:es\s+so\s+nah\s+ist|man\s+so\s+nah\s+wohnt)|da\s+kann\s+man\s+sich\s+(?:ja\s+)?(?:richtig\s+)?oft\s+treffen)\b/.test(lower);
  if (!hasForbidden) return msg;
  const sentencePattern = /[^.!?]*(?:oft\s+treffen|kann\s+man\s+sich\s+(?:ja\s+)?(?:richtig\s+)?oft\s+treffen|(?:mag|liebe)\s+es\s+(?:auch\s+)?wenn\s+(?:es\s+so\s+nah\s+ist|man\s+so\s+nah\s+wohnt)|da\s+kann\s+man\s+sich\s+(?:ja\s+)?(?:richtig\s+)?oft\s+treffen)[^.!?]*[.!?]/gi;
  let out = msg.replace(sentencePattern, ' Da hast du recht. ').replace(/\s+/g, ' ').trim();
  return out;
}

function postProcessMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  let m = msg.trim();
  // Meta-Zeilen entfernen (Hinweis:, Note:, Korrektur: etc.) – nur ganze Zeilen
  m = m.split(/\n+/).filter(line => !/^\s*(Hinweis|Note|Korrektur|Erklaerung|Erklärung):\s*/i.test(line.trim())).join(' ').trim();
  m = m.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
  m = m.replace(/ß/g, 'ss');
  // Bindestriche/Striche: zuerst Satzzeichen-Striche (inkl. Unicode en-dash, em-dash) zwischen Woertern -> Leerzeichen
  m = m.replace(/\s*[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*/g, ' ');
  m = m.replace(/\s+/g, ' ').trim();
  // Wort-intern: kennen-lernen -> kennenlernen (nur ASCII-Bindestrich zwischen Buchstaben)
  m = m.replace(/([a-zäöüA-ZÄÖÜ]+)-([a-zäöüA-ZÄÖÜ]+)/g, '$1$2');
  // Umlaute: typische Falschschreibungen (ganzes Wort) ersetzen
  m = m.replace(/\bwaer\b/gi, 'wär').replace(/\bwaere\b/gi, 'wäre');
  m = m.replace(/\bmoechte\b/gi, 'möchte').replace(/\bfuer\b/gi, 'für');
  m = m.replace(/\bschoen\b/gi, 'schön').replace(/\bueber\b/gi, 'über');
  m = m.replace(/\bnaechste\b/gi, 'nächste').replace(/\bnaechsten\b/gi, 'nächsten').replace(/\bnaechster\b/gi, 'nächster').replace(/\bnaechstes\b/gi, 'nächstes');
  m = m.replace(/\bwuerde\b/gi, 'würde').replace(/\bwuerden\b/gi, 'würden');
  m = m.replace(/\bkoennte\b/gi, 'könnte').replace(/\bhoeffentlich\b/gi, 'hoffentlich');
  m = m.replace(/\bgerae\b/gi, 'gerade').replace(/\bzurueck\b/gi, 'zurück');
  m = m.replace(/\buebrigens\b/gi, 'übrigens').replace(/\bschoene\b/gi, 'schöne').replace(/\bschoener\b/gi, 'schöner');
  // Weitere Umlaute (häufig von Modellen weggelassen)
  m = m.replace(/\bhaende\b/gi, 'Hände').replace(/\bHande\b/g, 'Hände').replace(/\bhande\b/g, 'hände');
  m = m.replace(/\bgehoert\b/gi, 'gehört').replace(/\bhoeren\b/gi, 'hören').replace(/\bmoechten\b/gi, 'möchten');
  m = m.replace(/\bkoennen\b/gi, 'können').replace(/\bmuessen\b/gi, 'müssen').replace(/\bmuess\b/gi, 'müss');
  m = m.replace(/\bgefuehl\b/gi, 'Gefühl').replace(/\bfuehlen\b/gi, 'fühlen').replace(/\bfuehl\b/gi, 'fühl');
  m = m.replace(/\bmaechtig\b/gi, 'mächtig').replace(/\btaeglich\b/gi, 'täglich').replace(/\bmoeglich\b/gi, 'möglich');
  m = m.replace(/\bmoeglichst\b/gi, 'möglichst').replace(/\bgefaellt\b/gi, 'gefällt').replace(/\bgefaellst\b/gi, 'gefallst');
  m = m.replace(/\bbruecke\b/gi, 'Brücke').replace(/\bstueck\b/gi, 'Stück').replace(/\bglueck\b/gi, 'Glück');
  m = m.replace(/\bkuessen\b/gi, 'küssen').replace(/\bkuess\b/gi, 'küss').replace(/\bschluessel\b/gi, 'Schlüssel');
  m = m.replace(/\bzaehl\b/gi, 'zähl').replace(/\bzaehlen\b/gi, 'zählen').replace(/\bgaebe\b/gi, 'gäbe');
  m = m.replace(/\bwaere\b/gi, 'wäre').replace(/\bwaeren\b/gi, 'wären').replace(/\bhaette\b/gi, 'hätte');
  m = m.replace(/\bkoerper\b/gi, 'Körper').replace(/\bkoerperlich\b/gi, 'körperlich');
  m = m.replace(/\bgruen\b/gi, 'grün');
  m = m.replace(/\bnaechstem\b/gi, 'nächstem');
  m = m.replace(/\bverstaendnisvoll\b/gi, 'verständnisvoll').replace(/\bverstaendlich\b/gi, 'verständlich');
  m = m.replace(/\beigenstaendig\b/gi, 'eigenständig').replace(/\bErklaerung\b/gi, 'Erklärung').replace(/\berklaerung\b/gi, 'Erklärung');
  return m;
}

module.exports = {
  runGrokPipeline,
  buildRulesBlock,
  checkLocationQuestion,
  callGrok,
  detectSituationsWithLLM
};
