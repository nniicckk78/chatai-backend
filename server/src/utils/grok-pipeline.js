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
const OPENAI_PLAN_MODEL = process.env.OPENAI_PLAN_MODEL && process.env.OPENAI_PLAN_MODEL.trim() ? process.env.OPENAI_PLAN_MODEL.trim() : OPENAI_MODEL;

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

/**
 * Nur bei wirklich unklaren Kurznachrichten true: z.B. ein Zeichen wie "Ü", Tippfehler, unvollständig.
 * "ok", "ja", "nein", "hm" etc. sind kontextbezogen klar – dürfen NICHT als unklar gelten.
 * Ab 4 Zeichen: nie als unklar markieren – Kontext klärt (z.B. "müde", "toll", "spät", "wann").
 */
const SHORT_REPLY_WHITELIST = new Set([
  'ja', 'jaa', 'jep', 'jo', 'joa', 'yes', 'nein', 'ne', 'nö', 'no', 'nope', 'yep', 'neee',
  'ok', 'okay', 'okey', 'k', 'kk', 'oh', 'ah', 'eh', 'na', 'hm', 'hmm', 'nix',
  'wo', 'was', 'wie', 'wer', 'wann', 'warum', 'woher', 'wohin',
  'doch', 'genau', 'super', 'klar', 'danke', 'bitte', 'gerne', 'stimmt', 'cool', 'nice', 'thx', 'lol',
  'vielleicht', 'allerdings', 'alles', 'weiss', 'keine', 'mag'
]);
function isReallyUnclearMessage(customerMessage) {
  const msg = (customerMessage || '').trim();
  if (msg.length === 0) return false;
  // Nur 1–3 Zeichen als potenziell unklar – ab 4 Zeichen ergibt im Kontext Sinn (müde, toll, spät, komm, …)
  if (msg.length > 3) return false;
  const normalized = msg.toLowerCase().replace(/\s+/g, ' ');
  return !SHORT_REPLY_WHITELIST.has(normalized);
}

/** Zeichen für Regex escapen (für Literalsuche). */
function escapeRegex(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
0. BEZUG ZUR KUNDENNACHRICHT (HÖCHSTE PRIORITÄT): Gehe auf JEDEN Punkt der Kundennachricht ein – jede Frage beantworten oder darauf eingehen, jede Aussage/Thema aufgreifen. Ignoriere keine Teile der Nachricht. Die Antwort muss sich direkt auf das beziehen, was der Kunde geschrieben hat – nicht themenfremd werden, nicht an älteren Aussagen hängen. Bei mehreren Fragen/Themen: auf ALLE eingehen – dabei aber in eigenen Worten reagieren, ohne seine Formulierungen zu uebernehmen und ohne Punkt-fuer-Punkt-Abspulen seiner Worte. Du musst nicht jede Frage woertlich beantworten (bei Treffen, Kontaktdaten etc. weichst du bewusst aus); aber die Nachricht als Ganzes muss auf die aktuelle Kundennachricht reagieren. KEIN ECHO: Antworte immer in eigenen Worten. Wiederhole oder paraphrasiere die Kundennachricht nicht; reagiere inhaltlich darauf, ohne ihre Formulierungen zu uebernehmen – die ausgegebene Nachricht ist ausschliesslich DEINE (Fake-Profil) Antwort, niemals eine Wiederholung des Kunden.
1. Safety/harte Grenzen (bereits geprüft)
2. Situations-Regeln (unten – nur die genannten Situationen)
3. Allgemeine Regeln (verbotene/bevorzugte Wörter, allgemeine Regeln)
4. Stil/Beispiele (Länge mind. 120 Zeichen ist Pflicht; Stil/Ton an Beispielen orientieren)
5. TON/INTENSITÄT: Passe dich an den Ton und die Intensität der Kundennachricht an – antworte nicht aufgedrehter oder expliziter als der Kunde; bei Unsicherheit lieber eine Stufe zurückhaltender. Wenn der Kunde andeutend oder sachlich schreibt, bleib ebenfalls andeutend/sachlicher; wenn er expliziter wird, kannst du mitgehen.\n\n`;

// Kurze Zusatzregeln (nicht den Haupt-Prompt überladen)
const EXTRA_RULES = {
  orte: 'ORTE: Niemals behaupten, einen vom Kunden genannten Ort (Café, Bar, Restaurant, Lokal) zu kennen oder zu mögen. Ortsnamen nicht mit "mag/kenne ich auch" kommentieren; hoechstens allgemein (z.B. klingt nett) ohne konkreten Namen.\n',
  vorfreude: 'VORFREUDE: Nicht als feste Zusage oder starke Vorfreude formulieren (z.B. "freue mich schon auf das Wochenende mit dir"); zurueckhaltend bleiben.\n',
  imageOnlyAnnounced: 'BILD NUR ANGEKUENDIGT: Kunde hat noch kein Bild geschickt – nicht "Danke fuer das Bild" oder Bewertung (sieht geil aus) sagen; nur Vorfreude (z.B. freue mich drauf).\n',
  imageClaimedButNotPresent: 'BILD BEHAUPTET, ABER NICHT DA: Der Kunde behauptet ein Bild geschickt zu haben – es ist aber KEIN Bild angekommen. Sage freundlich, dass du kein Bild siehst / nichts angekommen ist, und bitte ggf. nochmal zu schicken. Reagiere NICHT als ob ein Bild da waere (nicht "dein Bild macht mich geil", nicht auf ein Bild eingehen, keine Bewertung eines Bildes).\n',
  telefonsexFotos: 'TELEFONSEX/FOTOS: NIEMALS vorschlagen oder anbieten: Telefonsex, heisse Fotos, Bilder schicken, Foto-Tausch. Wir schicken keine Fotos; Telefonsex ist auf der Plattform nicht moeglich. Bei Skepsis (z.B. "kann kaum mit jemandem Sex haben den ich nie gesehen habe"): auf Fantasie, Vorstellungskraft, Kennenlernen im Chat eingehen – NICHT Telefonsex oder Fotos als Loesung nennen.\n',
  ruckfrageCallback: 'RUECKFRAGEN/CALLBACKS: Fragt der Kunde auf deine letzte Nachricht zurueck (z.B. "woher weisst du das", "wie meinst du das", "wer weiss", "woher soll ich das wissen") – gehe DIREKT darauf ein. Erklaere, begruende, spiel mit – wechsle NICHT das Thema (z.B. nicht auf Name, Beruf, was machst du). Die Antwort muss den Rueckbezug auf deine vorherige Aussage herstellen.\n',
  flirtyKontinuitaet: 'FLIRTY-KONTINUITAET: War deine letzte Nachricht flirty/anzueglich und der Kunde reagiert spielerisch darauf (z.B. "wer weiss woher weisst du es", "mal sehen", Lach-Emoji) – bleib im Flirt-Ton. Gehe auf die Rueckfrage ein (z.B. "weil du so rueberkommst", "weil ich dich sympathisch/heiss finde", "na ich stell mir das so vor") statt themenfremd zu werden.\n',
  keinEcho: 'KEIN ECHO – KRITISCH: Wenn der Kunde sich vorstellt (Name, Alter, Ort, Vorlieben) oder etwas beschreibt: NICHT seine Aussagen zurueckspielen (z.B. NICHT "Hey [Name], [Alter] passt, [Ort], du suchst X"). Kurz bestaetigen (z.B. klingt gut, passt) + EIGENE Aussage oder Reaktion + Frage. Maximal 1–2 seiner Punkte kurz aufgreifen, Rest EIGENE Worte – keine Aufzaehlung seiner Formulierungen, kein Nachplappern.\n',
  beziehungszieleVsTreffen: 'BEZIEHUNGSZIELE vs. TREFFEN: Wenn der Kunde NUR seine Beziehungsziele teilt (langfristig, Beziehung, keine ONS, Altersunterschied/Bedenken) und KEINE Treffen-Anfrage stellt (kein wann/wo, kein Date, kein vorbeikommen): ZUSTIMMEN und BERUHIGEN – "ich auch langfristig", "Alter ist fuer mich kein Problem", "gib uns eine Chance". VERBOTEN in diesem Kontext: "vorsichtig", "langsam angehen", "lasse alles langsamer angehen" – das wirkt wie Ablehnung. Diese Formulierungen NUR bei echter Treffen-Anfrage (wann, wo, Date) verwenden.\n',
  szenarioOhneTerminfrage: 'SZENARIO OHNE TERMINFRAGE: Wenn der Kunde NUR beschreibt was er gern machen wuerde (z.B. kuscheln, besuchen, zu dir kommen, "noch mehr") OHNE konkret nach Wann/Zeit/Besuchstermin zu fragen: BEI DEM THEMA BLEIBEN. Kurz positiv darauf eingehen, EINE einfache Frage zum gleichen Thema (z.B. "waere das nicht schoen?", "denkst du es wuerde beim Kuscheln bleiben?"). NICHT: muede/Ruhe/Arbeit nennen, nicht "wenn du wieder fit bist", nicht "wie wir das am besten umsetzen koennten" – das wirkt mechanisch. Alte Kundeninfos (z.B. dass er mal "nicht fit" erwahnt hat) nur verwenden wenn er sie in DIESER Nachricht wieder anspricht.\n',
  keinRecycelnKundeninfos: 'ALTE KUNDENINFOS: Infos die der Kunde frueher mal erwahnt hat (z.B. nicht fit, Gesundheit, Arbeit) nur in die Antwort einbauen, wenn er sie in der AKTUELLEN Nachricht anspricht. Sonst wirkt es mechanisch (z.B. "wenn du wieder fit bist" obwohl er gerade nur ueber Kuscheln/Fantasie spricht).\n',
  eigeneAussageNichtAlsKundenwissen: 'EIGENE AUSSAGE NICHT ALS KUNDENWISSEN: Wenn DEINE letzte Nachricht (vom Profil/Moderator) etwas ueber DICH gesagt hat (z.B. Wohnort "ich bin aus Heikendorf", Beruf, was du machst), dann hat der Kunde das NICHT gesagt. In der naechsten Antwort NICHT bestaetigen als haette der Kunde es gesagt (z.B. NICHT "geil dass du das weisst", "super dass du weisst woher ich bin", "ja ich bin aus Heikendorf" als Wiederholung). Stattdessen: auf das eingehen, was der Kunde WIRKLICH geschrieben hat (seine Fragen, seine Themen). Deine eigene Aussage nicht wiederholen oder dem Kunden zuschreiben.\n',
  geldCoins: 'GELD/CREDITS: Wenn der Kunde ueber wenig Geld, Kontoauszuege, Credits oder Einschraenkung spricht und dabei schon seine Gefuehle/Situation erklaert hat: Warm und liebevoll antworten, NICHT abtun ("mach dir keinen Kopf" reicht nicht). NICHT "Wie fuehlst du dich dabei?" fragen – das hat er schon gesagt. Stattdessen: bestaerken und eine Frage nach vorne (z.B. ob er sicher ist dass ihr es hinkriegt, was er sich vorstellt, was er machen moechte).\n',
  keineFrageBereitsBeantwortet: 'KEINE FRAGE NACH ETWAS, WAS DER KUNDE SCHON GESAGT HAT: Hat der Kunde in seiner Nachricht bereits gesagt was er geben/zeigen/tun will (z.B. "dann kriegste was tolles von mir", "zeig dir auch was", "dann bekommst du X")? Dann NICHT "Was bekommst du dafuer?", "Zeigst du mir auch was?", "Was krieg ich dafuer?" o.ae. fragen – das hat er schon beantwortet. Stattdessen: auf sein Angebot eingehen oder andere, thematische Frage.\n',
  abholenVerbot: 'ABHOLEN: NIEMALS anbieten den Kunden abzuholen ("Ich hol dich ab", "hol dich gerne ab", "kannst dich abholen") – auch wenn er frueher "muesstest mich abholen" gesagt hat: keine Zusage, unverbindlich bleiben.\n',
  themaBleibenKeinProfilKompliment: 'THEMA BLEIBEN / KEIN UNGEFRAGTES PROFIL-KOMPLIMENT: Ist die Kundennachricht kurz und themenfokussiert (z.B. nur "Wellness sounds gut", "Klingt gut")? Dann NUR zu diesem Thema antworten. NICHT ungefragt Komplimente zu Alter/Typ/Aussehen einbauen ("Ich mag aeltere Maenner wie dich", "steh auf Maenner wie dich", "dein Alter macht es spannend") – Profildaten (Alter etc.) nicht als Aufhaenger fuer solche Saetze nutzen, wenn der Kunde danach nicht gefragt hat.\n'
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
        temperature: options.temperature ?? 0.55,
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

/** Ersetzt nur bekannte Umlaut-Digraphen (Wort für Wort), keine globale Ersetzung – verhindert "Feuer"->"Füer".
 *  Für weitere Korrekturen nutzen wir optional OpenAI (correctSpellingAndUmlautsWithOpenAI). */
function fixUmlautDigraphs(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text;
}

/** Rechtschreibung und Umlaute ausschließlich per KI korrigieren – keine Wort-Listen im Post-Processor. Eine Stelle, die alle Fehler behebt. */
async function correctSpellingAndUmlautsWithOpenAI(message) {
  if (!message || typeof message !== 'string' || !message.trim()) return message || '';
  const key = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
  if (!key) return message;
  try {
    const client = getClient();
    if (!client) return message;
    const system = `Du bist ein Korrektor nur für Rechtschreibung und Umlaute in deutschen Chat-Nachrichten. Deine Aufgabe: JEDE falsche Schreibung korrigieren. Inhalt, Formulierung und Satzstellung dürfen sich NICHT ändern.

Regeln:
- Umlaute: ae/oe/ue nur dann durch ä/ö/ü ersetzen, wenn es sich um den Umlaut handelt (z.B. fuer→für, moechte→möchte). NICHT ersetzen in echten Wörtern wie Feuer, Museum, Schuhe, Abenteuer, Poesie – dort bleiben ue/oe/ae als zwei Buchstaben.
- Falsche Mischformen korrigieren: z.B. "teür"→"teuer" (hier ist ü falsch, richtig ist "eu"), "Füer"→"Feuer", "Müseum"→"Museum". Jede ähnliche falsche Schreibung (ü wo eu hingehört, ä/ö wo es kein Umlaut ist) korrigieren.
- Immer ss statt ß.
- Keine Anführungszeichen oder Bindestriche einfügen. Keine Erklärungen – gib NUR die vollständige korrigierte Nachricht zurück.`;
    const user = `Korrigiere alle Rechtschreib- und Umlautfehler in dieser Nachricht. Gib NUR die korrigierte Nachricht zurück:\n\n${sanitizeForApiContent(message.trim())}`;
    const out = await callOpenAI(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.1, max_tokens: 500, timeoutMs: 10000 }
    );
    const corrected = (out || '').trim();
    if (corrected && corrected.length >= 15 && corrected.length <= message.length * 1.6) {
      console.log('✅ KI-Rechtschreibkorrektur angewendet');
      return corrected;
    }
  } catch (err) {
    console.warn('⚠️ KI-Rechtschreibkorrektur:', err.message);
  }
  return message;
}

/** Wendet optional OpenAI-Rechtschreibkorrektur auf die finale Nachricht an (wenn API-Key gesetzt). */
async function applySpellingCorrectionIfAvailable(finalMessage) {
  if (!finalMessage || typeof finalMessage !== 'string' || !finalMessage.trim()) return finalMessage || '';
  if (!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim())) return finalMessage;
  return correctSpellingAndUmlautsWithOpenAI(finalMessage);
}

/** Stellt sicher, dass die Nachricht eine Frage enthält (?). Wenn nicht und OpenAI verfügbar: kurzer Call zum Einbau einer thematisch passenden Frage (z. B. am Ende).
 * Pruft zusaetzlich auf ae/ue/oe und korrigiert zu ae/ue/oe.
 * opts.customerMessage, opts.conversationSnippet: Kontext, damit die Frage thematisch passt und keine Treffen-Fragen entstehen.
 */
async function ensureQuestionInMessage(message, opts = {}) {
  if (!message || typeof message !== 'string') return message || '';
  let result = fixUmlautDigraphs(message);
  const trimmed = result.trim();
  if (trimmed.includes('?')) return result;
  const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
  if (!hasOpenAI) return result;
  const customerMessage = (opts.customerMessage || '').trim().slice(0, 400);
  const conversationSnippet = (opts.conversationSnippet || '').trim().slice(0, 350);
  const systemRules = [
    'Du fuegst einer Chat-Nachricht genau eine kurze, thematisch passende Frage ein (z. B. am Ende). Gib NUR die komplette Nachricht mit eingebauter Frage zurueck. Keine Anführungszeichen, kein anderer Text.',
    'WICHTIG: Keine Fragen zu Treffen, Dates, Kaffee trinken gehen, spontane Treffen oder persönlichem Kennenlernen einbauen. Der Moderator darf kein Treffen vorschlagen oder danach fragen. Die Frage muss thematisch zur Kundennachricht und zum Konversationsverlauf passen.',
    'Hat der Kunde bereits ausfuehrlich seine Gefuehle oder Situation erklaert (lange Nachricht, Geld/Kontoauszuege, Ehrlichkeit)? Dann NICHT "Wie fuehlst du dich?" oder "Wie geht es dir damit?" einbauen – stattdessen eine Frage nach vorne (z.B. ob ihr es schafft, was er sich vorstellt, was er machen moechte).'
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
  return result;
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

Antworte kurz (1–2 Sätze), nenne den Wohnort genau wie angegeben (z. B. "Ich wohne in Magdeburg"), nicht umschreiben mit "in der Nähe von Berlin" oder anderen Städten. Stelle eine Frage zurück. Keine Anführungszeichen am Anfang/Ende. KEINE Bindestriche. Immer ss, nie ß.`;

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
 * Doppelprofil nur bei klarem Hinweis: "X und Y" (z.B. Femke und Nadine) oder 3+ Namen.
 * "Angela, 56" oder "Nickname, Angela" = EINE Person, kein Doppelprofil.
 * @param {string} nameStr - name oder Vorname
 * @returns {{ fakeIsPlural: boolean, fakeNamesList: string[] }}
 */
function parseMultiFakeNames(nameStr) {
  const fakeNamesList = [];
  if (!nameStr || typeof nameStr !== 'string') return { fakeIsPlural: false, fakeNamesList };

  const hasUnd = /\s+und\s+/i.test(nameStr);
  const parts = nameStr.split(/\s*,\s*|\s+und\s+/i).map(p => p.trim()).filter(Boolean);
  const skipPatterns = /^(von|nach|li\.?|re\.?)$/i;
  const looksLikeSuffix = (s) => skipPatterns.test(s) || /^\s*von\s/i.test(s) || /\s+nach\s+/i.test(s);
  const looksLikeAge = (s) => /^\d{1,3}$/.test(s);

  for (const p of parts) {
    if (!p || p.length < 2) continue;
    if (looksLikeSuffix(p)) break;
    if (looksLikeAge(p)) continue;
    fakeNamesList.push(p);
  }

  const fakeIsPlural = fakeNamesList.length >= 2 && (hasUnd || fakeNamesList.length >= 3);
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
  imageClaimedButNotPresent = false,
  fakeProfession = '',
  fakeLogbookHint = '',
  fakeName = '',
  customerName = '',
  fakeRelationshipStatus = '',
  profileIdentityHint = '',
  isReallyUnclearMessage: isReallyUnclearMessageFlag = false
}) {
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR + PRIORITY_NOTE;
  const nameStr = (fakeName || '').trim();
  if (profileIdentityHint && profileIdentityHint.trim()) {
    systemContent += `PROFIL-IDENTITAET (KRITISCH): ${profileIdentityHint.trim()}\n\n`;
  }
  // Beziehungsstatus: Fake kann in Beziehung/verheiratet/verwitwet sein – NIEMALS "single" sagen wenn nicht
  const relStatus = (fakeRelationshipStatus || '').trim();
  const isNonSingle = relStatus && !/^single$/i.test(relStatus) && (
    /relation|beziehung|verheiratet|verwitwet|witwe|witwer|geschieden|married|widow|vergebn|in\s+einer\s+beziehung/i.test(relStatus)
  );
  if (isNonSingle && relStatus) {
    systemContent += `BEZIEHUNGSSTATUS: Du bist ${sanitizeForApiContent(relStatus)} – NIEMALS "single" oder "keinen Partner" sagen. Wenn nach Valentinstag/Partner/Liebesleben gefragt wird: ehrlich antworten (z.B. "hab einen Partner", "bin in einer Beziehung", "bin verheiratet"). Es ist okay, dass du nicht single bist – viele sind aus verschiedenen Gruenden auf der Plattform. Sage nicht, du haettest keinen Partner.\n\n`;
  }
  if (nameStr) {
    systemContent += `DEIN NAME (Fake-Profil): ${sanitizeForApiContent(nameStr)}. Bei Vorstellung oder wenn der Kunde nach deinem Namen fragt, NUR diesen Namen nennen – keinen anderen (z.B. nicht Anna, wenn du ${nameStr} heisst).\n\n`;
  }
  const customerNameStr = (customerName || '').trim();
  if (customerNameStr && nameStr) {
    systemContent += `KUNDEN-NAME: ${sanitizeForApiContent(customerNameStr)}. Wenn du den Kunden mit Namen ansprichst (z.B. "Ach [Name], ..." oder "Hey [Name], ..."): NUR diesen Kunden-Namen (${sanitizeForApiContent(customerNameStr)}) verwenden, NIEMALS deinen eigenen Namen (${sanitizeForApiContent(nameStr)}) – sonst wuerdest du dich selbst ansprechen.\n\n`;
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
    if (/schwanger|schwangerschaft|\.\s*monat\s+schwanger|im\s+\d+\.?\s*monat/i.test(fakeLogbookHint) && !profileIdentityHint) {
      systemContent += 'Du bist in diesem Profil die schwangere Person. Der Kunde spricht DICH als schwangere Person an. Reagiere als die schwangere Person – sag NIEMALS "Schwangere sind nicht mein Ding" oder dass Schwangere nicht dein Ding sind. ';
    }
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
    const isImageOnlyPlaceholder = /^der kunde hat ein bild geschickt\.?$/i.test(msgTrim);
    if (msgTrim.length <= 25 || isImageOnlyPlaceholder) {
      systemContent += 'NUR BILD: Kunde hat nur ein Bild geschickt (keinen Text). Reagiere nur auf das Bild – kein Treffen, kein "morgen Zeit?", kein "besser kennenlernen", keine Annahme von Traurigkeit/Problemen. Frage zum Bild oder zum Thema Bild.\n\n';
    }
  }
  if (doubleProfileHint && doubleProfileHint.trim()) {
    systemContent += doubleProfileHint.trim() + '\n\n';
  } else {
    systemContent += 'EINZELPROFIL: Du bist EINE Person (kein Doppelprofil). Nutze ich, mich, meine – NIEMALS wir, uns, unsere (das gilt nur bei echtem Doppelprofil mit 2 Namen, z.B. "Femke und Nadine").\n\n';
    systemContent += 'OPTIONAL – Dritte Person: Falls der Kunde von sich in der dritten Person spricht (z. B. "ein Juengling", "der Typ") – als Selbstaussage des Kunden interpretieren und mit du/dich darauf eingehen.\n\n';
  }
  if (isMidConversation) {
    systemContent += 'KONTEXT: Die Konversation laeuft bereits. Beginne die Nachricht NICHT mit Hey, Hi, Hallo oder aehnlichen Begruessungen – antworte direkt auf das Gesagte.\n\n';
  }
  if (isMeetingSituation) {
    if (isDirectMeetingRequest) {
      systemContent += 'TREFFEN/BAR-FRAGEN: NIEMALS Bar, Ort oder Uhrzeit nennen. Wenn der Kunde bereits Ideen genannt hat (z.B. Kino, Kaffee, kochen): Gehe darauf ein – sag was dir gefaellt, statt dieselben Ideen als neue Aufzaehlung zurueckzugeben. Keine konkrete Planung (Ort, Zeit, Zusage). VERBOTEN: anbieten den Kunden abzuholen ("Ich hol dich ab", "hol dich gerne ab", "kannst dich abholen", "hol dich ab") – auch wenn er frueher "muesstest mich abholen" o.ae. gesagt hat: KEINE Zusage, unverbindlich bleiben. VERBOTEN auch weiche Zusagen wie "am Abend koennten wir uns Zeit nehmen", "dann koennten wir", "am Abend passt", "Abend waere gut", "dann haetten wir Zeit" – klingt nach Zusage. Nur hypothetisch (wie toll es waere), keine Andeutung dass eine Zeit "passt" oder "wir uns Zeit nehmen". VERBOTEN: "wiedersehen", "wiederzusehen", "mal wieder treffen", "wenn wir uns wiedersehen" (auch in Fragen) – ihr habt euch NIE getroffen. Stattdessen z.B. "wenn wir uns (mal) sehen würden" oder Gegenfrage ohne "wieder". Wenn der Kunde Terminvorschlaege oder Zeitfenster nennt: NICHT schreiben, dass die Zeiten dir passen oder du flexibel bist – unverbindlich bleiben. NIEMALS begruenden, dass du dich im Chat wohler fuehlst. Zeitangabe (morgen Abend, Wochenende) nur mit „im Chat“ oder „wenn wir schreiben“ – sonst wirkt es wie Treffen-Zusage. WICHTIG – Kunde will treffen (jetzt/bald): VERBOTEN "lass uns erstmal noch schreiben", "erst kennenlernen", "noch ein bisschen schreiben" – nimmt ihm die Hoffnung, er verliert Lust. Stattdessen: kurz auf seinen Wunsch eingehen (z.B. "will auch nicht ewig nur schreiben", "schaue mal wie es passt"), TREFFEN-INITIATIVE BEIM KUNDEN: Nicht aktiv nach Ort oder konkreten Treffen-Ideen fragen (nicht "Wo koennten wir uns treffen?", nicht "Was hast du fuer Ideen?", nicht "Was denkst du wo?"). Erlaubt: andeuten, vage Vorlagen (z.B. "waer schoen mal was zusammen zu machen", "wenn wir uns mal sehen wuerden, koennte man ja was essen oder so") – Initiative fuer konkrete Orte/Ideen soll vom Kunden ausgehen. VERBOTEN: Meta-Fragen wie "Was denkst du darüber?" – stattdessen thematische Frage zum Treffen (ohne direkte Aufforderung zur Orts-/Ideenvorschlag). AUSWEICHEN: "muss schauen wann es bei mir klappt", "Wir muessen mal schauen wann es bei uns klappt", "schauen ob wir das hinbekommen", konkrete Gruende (Arbeit, Wochenende, zu spontan). NICHT DOPPELN: Ein konkreter Grund reicht, kein zusaetzliches "besser kennenlernen". VERBOTEN – zu direkt: "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen", "einfach mal einen Tag raussuchen", "Was haeltst du davon wenn wir uns einen Tag raussuchen" – wirkt wie konkrete Terminplanung. Stattdessen unverbindlich formulieren (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es bei mir passt"). Beende mit einer klaren Gegenfrage zum Treffen-Thema.\n\n';
    } else {
      systemContent += 'TREFFEN/VORFREUDE: Der Kunde aeussert nur Vorfreude oder beschreibt ein Szenario (z.B. "hoffe wir sehen uns bald", "würde kuscheln und noch mehr", "was ich bei dir machen würde") – keine konkrete Frage nach Wann/Zeit/Besuchstermin. VERBOTEN: "wiedersehen", "wiederzusehen", "wenn wir uns wiedersehen" – ihr habt euch NIE getroffen. Stattdessen "wenn wir uns sehen würden" o.ae., nie "wieder". Antworte NICHT mit "erst kennenlernen" oder "erst quatschen". BEI DEM THEMA BLEIBEN: kurz positiv darauf eingehen, EINE einfache Frage zum genannten (z.B. "waere das nicht schoen?", "denkst du es wuerde beim Kuscheln bleiben?"). NICHT einbauen: muede/Ruhe/Arbeit, "wenn du wieder fit bist", "wie wir das umsetzen koennten" – wirkt mechanisch. Alte Kundeninfos (z.B. fit/Gesundheit) nur wenn er sie in DIESER Nachricht anspricht. Beende mit einer klaren Gegenfrage.\n\n';
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
  systemContent += EXTRA_RULES.orte + EXTRA_RULES.vorfreude + EXTRA_RULES.telefonsexFotos + EXTRA_RULES.ruckfrageCallback + EXTRA_RULES.flirtyKontinuitaet + EXTRA_RULES.keinEcho + EXTRA_RULES.keineFrageBereitsBeantwortet + EXTRA_RULES.beziehungszieleVsTreffen + EXTRA_RULES.szenarioOhneTerminfrage + EXTRA_RULES.keinRecycelnKundeninfos + EXTRA_RULES.eigeneAussageNichtAlsKundenwissen + EXTRA_RULES.geldCoins + EXTRA_RULES.abholenVerbot + EXTRA_RULES.themaBleibenKeinProfilKompliment;
  if (imageOnlyAnnounced) {
    systemContent += EXTRA_RULES.imageOnlyAnnounced;
  }
  if (imageClaimedButNotPresent) {
    systemContent += EXTRA_RULES.imageClaimedButNotPresent;
  }
  if (situationRulesBlock && situationRulesBlock.trim()) {
    systemContent += sanitizeForApiContent(situationRulesBlock.trim());
    if (situationRulesBlock.includes('Geld/Coins')) {
      systemContent += EXTRA_RULES.geldCoins;
    }
    if (situationRulesBlock.includes('Bot-Vorwurf')) {
      systemContent += 'HINWEIS Bot-Vorwurf: Nur wenn der Kunde DICH explizit als Fake/Bot bezeichnet (nicht bei "zu gut um wahr zu sein" oder bloßer Skepsis). Dann sachlich kurz abwehren (z.B. bin kein Bot, ueberzeug dich gern), NICHT uebertrieben verletzt oder lang. Wenn er nur Skepsis aeussert oder seine Nummer schickt: auf Treffen eingehen ("dann ueberzeug dich beim Treffen"), Nummer erst beim Treffen – keine lange "ich bin kein Fake"-Rede. Wenn der Kunde von SICH sagt er sei kein Fake/Bot (Antwort auf "Du bist Fake?") – er meint sich selbst; dann auf seine Abwehr eingehen, nicht defensiv.\n\n';
    }
    if (situationRulesBlock.includes('Sexuell')) {
      systemContent += 'HINWEIS Sexuelle Themen: Orientiere dich an der Explizitheit der Kundennachricht – nicht ueberbieten. Schreibt der Kunde zurueckhaltend/andeutend, antworte ebenfalls zurueckhaltender; wird er expliziter, kannst du mitgehen. Nicht von dir aus eine Stufe drauflegen. ECHO VERMEIDEN: Die konkreten Formulierungen, Koerperteile und Handlungen des Kunden NICHT 1:1 zurueckgeben (z.B. nicht dieselben Begriffe in gleicher Reihenfolge) – in EIGENEN Worten reagieren (Gefuehl, Andeutung, eigene Formulierung), ohne sein Vokabular zu spiegeln. Wenn der Kunde ein sexuelles Szenario beschreibt: NICHT dasselbe Szenario Schritt fuer Schritt zurueckspielen – nur kurz reagieren (Gefuehl/Erregung) und mit einer Frage fortfuehren. Keine Meta-Fragen wie "Was erregt dich am meisten dabei?" – lieber z.B. "Und dann?", "Was als naechstes?", "Haerter oder langsamer?" Hat der Kunde schon gesagt was er geben/zeigen will? Dann NICHT "Was bekommst du dafuer?" fragen.\n\n';
    }
    if (situationRulesBlock.includes('Was willst du wissen?')) {
      systemContent += 'HINWEIS "Was willst du wissen?": Der Kunde fragt, was du wissen moechtest. Antworte INHALTLICH: nenne 1–2 Dinge die du wissen moechtest (z.B. was er sucht, Beruf, Hobbys, wie sein Tag war) und stelle genau DARAUF eine konkrete Kennenlern-Frage. Orientiere dich an Kennenlern-Beispielen (Stil wie in Trainingsdaten unter Allgemein). NICHT: Wohnort wiederholen, nach Kunden-Wohnort fragen wenn bekannt, generische Floskeln. Frage am Ende muss zum Gesagten passen (z.B. "Was machst du beruflich?", "Wonach suchst du hier?", "Was treibst du so in deiner Freizeit?").\n\n';
    }
  }
  systemContent += 'ZENSUR/PLATTFORM: Die Plattform blendet oft Nummern, E-Mails, URLs oder Namen aus (z.B. als *** oder *****). Reagiere NICHT woertlich auf ***/Sternfolgen; schreibe KEINE *** in deine Antwort. Sag dem Kunden NICHT dass etwas zensiert oder ausgeblendet wird – ueberspiel es (z.B. auf die Absicht eingehen, hier weiterschreiben, thematisch antworten ohne die Stelle zu zitieren).\n\n';
  systemContent += generalRulesBlock;
  if (locationContext && (locationContext.fakeCity || locationContext.customerCity)) {
    if (locationContext.fakeCity) {
      systemContent += `\n🚨 DEIN WOHNORT (Fake – NUR DIESEN nennen, NIEMALS den des Kunden): "${sanitizeForApiContent(locationContext.fakeCity)}". Wenn du nach deinem Wohnort gefragt wirst, nenne NUR diesen Ort.`;
    }
    if (locationContext.customerCity) {
      systemContent += `\n🚨 KUNDEN-WOHNORT (gehoert dem KUNDEN – NIEMALS als deinen ausgeben, nicht "Ich komme auch aus ..." sagen): "${sanitizeForApiContent(locationContext.customerCity)}". Kunde wohnort bekannt – NICHT erneut fragen wo er/sie herkommt oder woher er/sie kommt.`;
    }
    systemContent += '\n\n';
  }
  if (learningContext && learningContext.trim()) {
    systemContent += sanitizeForApiContent(learningContext.trim()) + '\n\n';
  }
  if (plan && plan.trim()) {
    systemContent += `PLAN (daran halten):\n${sanitizeForApiContent(plan.trim())}\n\n`;
  }
  if (isReallyUnclearMessageFlag) {
    systemContent += `UNKLARE NACHRICHT: Die Kundennachricht ist sehr kurz und nicht als uebliche Kurz-Antwort erkennbar (z.B. ein Zeichen wie Ue, Tippfehler). Du weisst nicht, was der Kunde meint. Reagiere LOGISCH und freundlich: Sage, dass du nicht genau verstehst, und frage was er/sie meint oder sagen wollte (z.B. "Was meinst du damit?", "Was wolltest du sagen?"). NIEMALS etwas in die Nachricht hineininterpretieren (z.B. nicht Nervositaet, nicht "an mich denken").\n\n`;
  }
  systemContent += `LOGIK: PFLICHT – Gehe auf die GESAMTE Kundennachricht ein: Jede Frage, jede Aussage, jedes Thema. Ignoriere nichts. NICHT nur den ersten Satz beachten – die ganze Nachricht lesen. Nennt der Kunde sowohl Vorlieben als auch Tabus (z.B. "gerne versaut" und "Tabus habe ich keine außer X"): auf BEIDES eingehen – Tabus nicht weglassen, nicht nur auf Vorlieben antworten. Fragt er "und du?" oder ob du Tabus/Grenzen hast: diese Frage beantworten (z.B. eigene Tabus oder was du magst/nicht magst nennen). Hat der Kunde mehrere Themen/Beduerfnisse genannt (z.B. Sex + gutes Gespraech wichtig + nicht ewig nur schreiben wollen + absprechen/Anruf): JEDES mindestens mit einem Satz oder Teilsatz bedienen – nichts im Raum stehen lassen (z.B. "will auch nicht ewig nur schreiben", "kümmer mich drum"). Hat der Kunde mehrere Punkte genannt (Fragen, Vorlieben, Ideen, Beziehungsvorstellungen): auf ALLE eingehen, nicht nur auf einen – dabei in eigenen Worten reagieren, seine Formulierungen nicht uebernehmen, nicht Punkt fuer Punkt abspulen. Hat der Kunde konkrete Vorschläge oder Ideen genannt (z.B. Aktivitäten, Optionen): Gehe darauf ein – sag was dir gefällt oder kommentiere, statt dieselben Ideen als neue Aufzählung oder Rückfrage zu wiederholen. VERBOTEN: "wiedersehen", "wiederzusehen", "mal wieder treffen", "wenn wir uns wiedersehen" (auch in Fragen) – ihr habt euch NIE getroffen; "wieder" ist falsch. Stattdessen z.B. "wenn wir uns (mal) sehen würden" oder "was wir zusammen machen könnten" ohne "wieder". Konsistenz mit deiner letzten Nachricht: Hast du dort etwas abgelehnt oder eine Grenze gesetzt (z.B. "nicht X", "nur Y", Ablehnung eines Szenarios) – in der naechsten Antwort darfst du dieses abgelehnte Szenario nicht wieder einbauen oder die Grenze aufheben; gehe auf die aktuelle Kundenfrage ein und bleib bei deiner Grenze. Hast du in deiner letzten oder vorherigen Nachricht etwas ueber DICH gesagt (z.B. was du isst, machst, wo du bist, was du vorhast)? Dann bleib dabei – wechsle NICHT zu etwas anderem (z.B. nicht ploetzlich Omelett wenn du Nudeln mit Pesto gesagt hast, nicht Spaghetti wenn der Kunde das isst). Lies den Chat-Verlauf – was hast du bereits ueber dich gesagt? Bleib konsistent. Wenn der Kunde eine Einschränkung oder ein Problem andeutet (z.B. kann nicht mehr schreiben, keine Credits/Geld, will nicht, spricht dagegen, geht nicht): Gehe nicht nur kurz darauf ein und wechsle dann das Thema – stelle eine echte Nachfrage (warum? Was spricht dagegen? Ich dachte wir verstehen uns gut?) und zeige Neugier wie ein echter Mensch. Bei "Was machst du so?" / "Was machst du gerade?" im laufenden Chat: eher aktuelle Tätigkeit (gerade jetzt) nennen, nicht nur Beruf/Freizeit. Bei mehreren Punkten (z.B. Frage + Thema): auf ALLE eingehen. Wenn der Kunde eine Frage stellt, beantworte sie (oder weiche im Stil der Beispiele aus) und beende die Nachricht mit einer konkreten Gegenfrage. Jede Nachricht braucht eine Frage am Ende – zum Kontext passend, zum Thema oder das Thema erweiternd/vertiefend. Auch bei sexuellen Themen: am Ende eine kurze Frage, die zum Thema passt oder es vertieft (keine Treffen-Einladung). Mindestens 120 Zeichen. Natürlich und locker.
Stimmung: Reagiere passend auf die Stimmung des Kunden – warm und aufgeschlossen bei positivem/flirty Ton, verständnisvoll bei Traurigkeit, deeskalierend bei Unmut. Erkenne die Emotion hinter der Nachricht und spiegle sie angemessen.
Rechtschreibung: IMMER echte Umlaute (ä, ö, ü) – niemals ae, oe, ue (z.B. nächstes, wäre, möchte, für, könnte, schön). "teuer" mit eu, nie "teür". ss statt ß. Keine Anführungszeichen, keine Bindestriche.
Antworte NUR mit der einen Nachricht – keine Meta-Kommentare, keine Wiederholung der Kundennachricht wörtlich; eigenständig formuliert, mit Frage am Ende. Keine Erklärungen.
AUFBAU: Beginne NICHT mit einer Zusammenfassung oder Paraphrase der Kundennachricht (z.B. nicht "Ah, du fährst nachts und morgens bis mittags, Dienstag frei..."). Start mit kurzer Reaktion (z.B. "Das klingt flexibel bei dir", "Klingt anstrengend") oder direkt mit deiner Aussage/Frage.
FRAGEN: Die Gegenfrage am Ende MUSS wie in den Trainingsbeispielen sein – konkret, thematisch, zur Kundennachricht passend. VERBOTEN: generische Meta-Fragen wie "Was interessiert dich (noch/denn) an unseren Gesprächen?", "Was magst du an mir?", "Was gefällt dir an unserem Chat?", "Was denkst du darüber?" – solche Fragen stehen NICHT in den Trainingsdaten und wirken beliebig. Nutze stattdessen Fragen wie in den Beispielen (nachfragen zum Thema, zu dem was der Kunde gesagt hat, oder thematisch erweiternd). Bei Treffen-Wunsch: andeuten oder vage Vorlagen (z.B. was zusammen machen), nicht aktiv nach Ort oder Ideen fragen (nicht "Wo koennten wir treffen?", "Was fuer Ideen hast du?"), nicht meta.

PFLICHT: Nur eine Nachricht ausgeben; Frage am Ende (im Stil der Beispiele); keine Meta-Kommentare; KEIN ECHO – nicht Name, Alter, Ort oder Vorlieben des Kunden zurueckspielen, eigenstaendig formulieren.`;

  let userContent = '';
  if (conversationHistory && conversationHistory.trim()) {
    const historySnippet = conversationHistory.substring(Math.max(0, conversationHistory.length - 800));
    userContent += `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(historySnippet)}\n\n`;
  }
  userContent += `PFLICHT: Deine Antwort muss auf ALLE Punkte dieser Kundennachricht eingehen (jede Frage, jedes Thema, jede Aussage). Ignoriere nichts – aber in eigenen Worten, ohne die Formulierungen des Kunden zu uebernehmen.\n\n`;
  userContent += `Die Nachricht kann mehrere Aussagen/Fragen enthalten – auf JEDEN Punkt eingehen (jede Frage aufgreifen oder beantworten, jedes Thema mit mindestens einem Satz), ohne Punkt-fuer-Punkt abzuspulen oder zu paraphrasieren.\n\n`;
  userContent += `KRITISCH – KONSISTENZ: Lies den Chat-Verlauf oben – was hast DU (Fake/Moderator) bereits ueber dich gesagt (z.B. was du isst, machst, wo du bist)? Bleib dabei – wechsle nicht zu etwas anderem. Wenn du "Nudeln mit Pesto" gesagt hast, sag nicht "Omelett" oder "Spaghetti Bolognese".\n\n`;
  userContent += `Aktuelle Kundennachricht: "${sanitizeForApiContent(customerMessage || '')}"\n\n`;
  if (examples && examples.length > 0) {
    userContent += 'TRAININGS-BEISPIELE – Orientiere dich STARK an diesen Beispielen: Stil, Ton, Aufbau und vor allem die ART der Gegenfrage übernehmen (konkret, thematisch, wie in den Beispielen – KEINE generischen Fragen wie "Was interessiert dich an unseren Gesprächen?"):\n';
    examples.slice(0, 8).forEach((ex, i) => {
      const resp = sanitizeForApiContent((ex.moderatorResponse || ex.assistant || '').toString());
      userContent += `${i + 1}. "${resp.substring(0, 280)}${resp.length > 280 ? '...' : ''}"\n`;
    });
    userContent += '\nGeneriere eine Antwort mit Gegenfrage im Stil der Beispiele oben (thematisch, konkret).\n\n';
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
  'Wohnort-Frage': 'NUR wenn der Kunde explizit nach DEINEM oder seinem Wohnort/Ort/Stadt fragt: woher kommst du, wo wohnst du, aus welcher Stadt/Region, wo lebst du. NICHT waehlen bei: "was willst du wissen", "was moechtest du erfahren", "was willst du von mir wissen" – das ist eine Frage nach dem was du wissen moechtest, keine Wohnortfrage.',
  'Was willst du wissen?': 'Kunde fragt was du (das Profil) wissen oder erfahren moechtest (z.B. "was willst du wissen?", "was moechtest du erfahren?", "was willst du von mir wissen?", "was soll ich dir erzaehlen?"). Typisch nach Vorstellung oder wenn der Moderator gesagt hat er will mehr ueber den Kunden erfahren. Dann: inhaltlich antworten – nenne 1–2 Dinge die du wissen moechtest (z.B. was er sucht, Beruf, Hobbys, Tag) und stelle genau dazu eine konkrete Kennenlern-Frage. Keine Wiederholung von Wohnort, keine Frage nach bereits bekannten Profildaten.',
  'Geld/Coins': 'Kunde spricht über Geld, Coins, Credits, Aufladen, Kosten – oder deutet an, dass er nicht mehr (hier) schreiben kann, keine Credits/Geld hat, schade dass er nicht mehr schreiben kann, kann keine Nachrichten mehr senden, Einschränkung wegen Credits/Geld.',
  'Bot-Vorwurf': 'Kunde unterstellt DIR (dem Profil) Bot, KI, Fake oder dass du nicht echt bist. NICHT waehlen, wenn der Kunde von SICH behauptet er sei kein Fake/Bot (z.B. Antwort auf "Du bist Fake?" – dann meint er sich selbst, nicht dich).',
  'Berufsfrage': 'Kunde fragt nach deinem Beruf, deiner Arbeit, was du arbeitest.',
  'Kontaktdaten außerhalb der Plattform': 'Kunde will Nummer, WhatsApp, Telegram, Instagram, Email teilen oder außerhalb der Plattform schreiben.',
  'Bilder Anfrage': 'Kunde möchte ein Foto/Bild von dir sehen, bittet darum etwas zu zeigen/zu sehen (z.B. Bild von dir, zeig mir, will sehen, deine Muschi/Brust/etc. sehen). Auch implizit: "will X sehen" wo X etwas ist, das man nur per Bild zeigen würde.',
  'Romantik / Verliebtheit': 'Kunde drückt Verliebtheit, emotionale Bindung, "sich hingeben" im Sinne von sich öffnen/binden, Bereitschaft für die Beziehung aus – ohne explizite sexuelle Aufforderung oder explizite Begriffe. Nur wenn keine klaren sexuellen Formulierungen (Sex, Körper, Lust, konkrete Handlungen) vorkommen.',
  'Sexuelle Themen': 'Nur wenn der Kunde explizit über Sex, konkrete sexuelle Handlungen, Körperteile, Lust oder eindeutige sexuelle Wünsche spricht. Nicht bei rein emotionaler/romantischer Formulierung wie Verliebtheit, "sich hingeben" (Bindung), "bereit für dich" (emotional) ohne sexuelle Begriffe.',
  'Wonach suchst du?': 'Kunde fragt wonach du suchst ODER teilt seine Beziehungsziele (langfristig, Beziehung, ONS vs. Beziehung, keine One-Night-Stands) oder aeusstert Bedenken (z.B. Altersunterschied, Unterschied zu gross). Auch wenn er sagt, er suche was Langfristiges oder dass der Altersunterschied gross ist – dann waehlen.',
  'Moderator/Outing': 'Kunde fragt ob du ein Chat-Moderator/Moderator bist.',
  'Verärgerte/saure Kunden': 'Kunde signalisiert Ärger, Frust, Ablehnung oder aggressiven Ton: z.B. Stinkefinger-Emojis (🖕), Beleidigungen, sehr kurze negative Nachrichten, "nerv mich nicht", "was soll das", "scheisse", wütender Ton. Auch wenn die Nachricht nur aus Emojis/Gesten besteht die Ablehnung ausdrücken.'
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
  const messageSnippet = (customerMessage || '').trim().slice(0, 700);
  const userContent = contextSnippet
    ? `Kontext (Auszug):\n${sanitizeForApiContent(contextSnippet)}\n\nAktuelle Kundennachricht: "${sanitizeForApiContent(messageSnippet)}"`
    : `Kundennachricht: "${sanitizeForApiContent(messageSnippet)}"`;
  const messages = [
    {
      role: 'system',
      content: `Du klassifizierst Kundennachrichten auf einer Dating-Plattform. Waehle ALLE zutreffenden Situationen aus der Liste. Mehrere Situationen sind moeglich (z.B. "Bilder Anfrage" + "Sexuelle Themen").

Situationen (nur diese Namen verwenden):
${defsText}

WICHTIG Bot-Vorwurf: Nur "Bot-Vorwurf" waehlen, wenn der Kunde DICH EXPLIZIT als Bot/Fake/KI bezeichnet (z.B. "du bist ein Bot", "fake-profil", "bist du echt?", "nicht echt"). NICHT waehlen bei bloßer Skepsis oder Kompliment wie "klingt zu gut um wahr zu sein", "hoert sich zu gut an", "zu schoen um wahr" – das ist keine Anschuldigung. NICHT waehlen, wenn der Kunde von SICH sagt er sei kein Fake/Bot (dann meint er sich selbst).

WICHTIG Wohnort-Frage vs. Was willst du wissen?: "Wohnort-Frage" NUR wenn der Kunde explizit nach Wohnort/Ort/Stadt fragt (woher kommst du, wo wohnst du, aus welcher Stadt). Bei "was willst du wissen?", "was moechtest du erfahren?", "was willst du von mir wissen?" NICHT "Wohnort-Frage" waehlen – stattdessen "Was willst du wissen?" waehlen.

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
  const isWasWillstDuWissen = /\bwas\s+willst\s+du\s+(den\s+)?wissen\b|\bwas\s+m[oö]chtest\s+du\s+erfahren\b|\bwas\s+willst\s+du\s+von\s+mir\s+(wissen)?\b|\bwas\s+soll\s+ich\s+dir\s+erz[aä]hlen\b/i.test(lower);
  if (!isWasWillstDuWissen && (lower.includes('wohnort') || lower.includes('wo wohnst') || lower.includes('woher'))) {
    out.push('Wohnort-Frage');
  }
  if (isWasWillstDuWissen) {
    out.push('Was willst du wissen?');
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
  // Verärgerte/saure Kunden: Stinkefinger 🖕, Kot-Emoji, Beleidigungen, kurze wütende Nachrichten
  const msg = customerMessage || '';
  if (/🖕|💩|👎|😤|😠|💢/.test(msg) || /nerv\s+mich|was\s+soll\s+das|schei[sß]e|arschloch|idiot|dumm\s+bin\s+ich/i.test(lower)) {
    out.push('Verärgerte/saure Kunden');
  } else if (msg.trim().length <= 20 && (msg.includes('🖕') || msg.includes('...'))) {
    out.push('Verärgerte/saure Kunden');
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
  const hasWasWillstDuWissen = Array.isArray(detectedSituations) && detectedSituations.some(s => s === 'Was willst du wissen?');
  const wasWillstDuWissenHint = hasWasWillstDuWissen
    ? ' Bei "Was willst du wissen?": Antwort muss INHALTLICH auf die Frage eingehen – nenne 1–2 Dinge die du wissen moechtest (z.B. was er sucht, Beruf, Hobbys) und stelle genau dazu eine konkrete Kennenlern-Frage. Keine Wiederholung von Wohnort, keine Frage nach bereits bekannten Profildaten.'
    : '';
  const contextSnippet = (conversationHistory || '').trim().slice(-700);
  const customerSnippet = (customerMessage || '').trim();
  const customerForPlan = customerSnippet.length > 600 ? customerSnippet.slice(0, 600) + '…' : customerSnippet;
  const isUnclear = isReallyUnclearMessage(customerMessage);
  const unclearHint = isUnclear
    ? ' WICHTIG: Die Nachricht ist extrem kurz/unklar (z.B. ein Zeichen) und kein uebliches Kurz-Antwort (ja/ok/nein). Prioritaet: freundlich nachfragen was der Kunde meint – NICHT interpretieren oder raten.'
    : '';
  const contextBlock = contextSnippet
    ? `Kontext (Auszug aus dem Gespräch – beachten für Ton und Thema):\n${sanitizeForApiContent(contextSnippet)}\n\n`
    : '';
  const userContent = `${contextBlock}Aktuelle Kundennachricht: "${sanitizeForApiContent(customerForPlan)}"\n\nErkannte Situation(en): ${situationList}.${contactHint}${sexualHint}${romanticHint}${wasWillstDuWissenHint}${unclearHint}\n\nGib in 2–4 Sätzen an: Welche Regeln/Prioritäten gelten hier? Welcher Ton? Welche Themen/Fragen stecken in der Nachricht? Nenne sie stichwortartig (z.B. Vorlieben UND Tabus, Pizza/Kueche, TV, Rueckfrage "und du?") – keine woertliche Paraphrase. WICHTIG: Nicht nur den ersten Satz – die GANZE Nachricht. Nennt der Kunde Tabus und fragt "und du?" → Plan muss Tabus und die Rueckfrage einbeziehen, nicht nur Vorlieben. Die Antwort soll auf alle genannten Themen eingehen, aber nicht Punkt fuer Punkt abspulen. Alle Themen/Beduerfnisse beruecksichtigen (nicht nur die erkannten Situationen) – nichts im Raum stehen lassen. Fragt der Kunde auf die letzte Moderatoren-Nachricht zurueck (z.B. "woher weisst du das")? Dann: explizit darauf eingehen. Was unbedingt vermeiden? Nur den Plan, keine Antwort an den Kunden.`;
  const messages = [
    {
      role: 'system',
      content: 'Du bist ein Assistent. Antworte nur mit 2–4 kurzen Sätzen auf Deutsch. Keine Anführungszeichen. Nur Regeln, Prioritäten, Ton – keine Zusammenfassung der Kundennachricht (kein Paraphrase-Satz).'
    },
    { role: 'user', content: userContent }
  ];
  try {
    const planText = await callOpenAI(messages, {
      timeoutMs: OPENAI_PLAN_TIMEOUT_MS,
      max_tokens: OPENAI_PLAN_MAX_TOKENS,
      temperature: 0.2,
      model: OPENAI_PLAN_MODEL
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
  if (context.isNonSingle === true && context.fakeRelationshipStatus) ctx.push(`Fake ist ${context.fakeRelationshipStatus} – NIEMALS "single" oder "keinen Partner" sagen; ehrlich antworten (z.B. hab einen Partner, bin in einer Beziehung)`);
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
  const noParaphraseRule = ' Fasst die Antwort die Kundennachricht nur zusammen oder wiederholt sie seine Details (Ort, Tag, Aktivitaet)? Spielt die Antwort die Kundenvorstellung zurueck (Name, Alter, Ort, Vorlieben in gleicher Reihenfolge)? Wenn ja → radikal kuerzen, nur kurz bestaetigen (z.B. klingt gut), eigene Aussage + Frage, keine Aufzaehlung seiner Punkte. Beschreibt der Kunde ein sexuelles Szenario und die Antwort spielt es fast 1:1 nach (gleiche Handlungen, leicht umformuliert)? Wenn ja → kuerzen, eigene Reaktion behalten, keine Szene zurueckspielen. Bei sexuellen Themen: Die konkreten Begriffe, Koerperteile und Handlungen des Kunden NICHT 1:1 uebernehmen – in EIGENEN Worten reagieren (Gefuehl, Andeutung), sein Vokabular nicht spiegeln. Kundennachricht weder woertlich noch sinngemäss nachplappern – in 1–2 Saetzen eigenstaendig darauf eingehen, Rest eigene Worte/Frage.';
  const noQuestionAlreadyAnsweredRule = ' Hat der Kunde in seiner Nachricht bereits gesagt was er geben/zeigen/tun will (z.B. "dann kriegste was tolles", "zeig dir auch was", "dann bekommst du X")? Enthaelt die Antwort eine Rueckfrage wie "Was bekommst du dafuer?", "Zeigst du mir auch was?", "Was krieg ich dafuer?"? Wenn ja → diese Frage entfernen/ersetzen durch Reaktion auf sein Angebot oder andere thematische Frage.';
  // Bild nur angekündigt: Kein "Danke für das Bild" / "sieht geil aus"
  const imageOnlyAnnouncedRule = (context.imageOnlyAnnounced === true)
    ? ' BILD NUR ANGEKUENDIGT: Kunde hat noch kein Bild geschickt. Enthaelt die Antwort "Danke fuer das Bild" oder Bewertung (sieht geil aus)? Wenn ja → entfernen/ersetzen durch Vorfreude (z.B. freue mich drauf), keine Bewertung eines nicht vorhandenen Bildes.'
    : '';
  // Kunde behauptet Bild geschickt, aber keins da: Nicht auf ein Bild reagieren
  const imageClaimedButNotPresentRule = (context.imageClaimedButNotPresent === true)
    ? ' BILD BEHAUPTET, ABER NICHT DA: Kunde behauptet ein Bild geschickt zu haben – es ist keins angekommen. Enthaelt die Antwort Reaktion auf ein Bild (z.B. "dein Bild macht mich geil", "sieht geil aus", Bewertung des Bildes)? Wenn ja → ersetzen durch: freundlich sagen, dass kein Bild angekommen ist, und ggf. bitten nochmal zu schicken. Keine Reaktion als ob ein Bild da waere.'
    : '';
  // Orte: Nie behaupten, Ort (Café, Bar, etc.) zu kennen/mögen
  const noPlaceClaimRule = ' Enthaelt die Antwort, die Persona kenne oder moege einen vom Kunden genannten Ort (Café, Bar, Restaurant, Lokal)? Wenn ja → umformulieren: hoechstens allgemein (klingt nett), niemals "mag/kenne ich auch" zu konkretem Ortsnamen.';
  // Vorfreude nicht zu stark
  const noStrongHopeRule = ' Formuliert die Antwort feste Zusage oder starke Vorfreude (z.B. "freue mich schon auf das Wochenende mit dir")? Wenn ja → zurueckhaltender umformulieren.';
  // Nie getroffen: "wiedersehen"/"wenn wir uns wiedersehen" impliziert ein bereits stattgefundenes Treffen – Kunde und Fake haben sich nie getroffen.
  const noWiedersehenRule = ' PFLICHT: Enthaelt die Antwort "wiedersehen", "wiederzusehen", "mal wieder treffen", "wenn wir uns wiedersehen" (auch in Fragen)? Ihr habt euch NIE getroffen – "wieder" ist falsch. Wenn ja → ersetzen durch Formulierung OHNE "wieder" (z.B. "wenn wir uns sehen würden", "was wir zusammen machen könnten") oder Satz umschreiben.';
  // "Hatte ich schon mal" / "das Vergnügen hatte ich schon": Kunde meint Erfahrung mit ANDEREN, nicht mit dem Fake – Antwort darf nicht so tun, als hätte er dich/deinen Körper schon erlebt.
  const noSharedPastRule = ' Enthaelt die Antwort eine Formulierung, als haette der Kunde DICH bzw. deinen Koerper schon erlebt (z.B. "dass du meinen X schon mal probiert hast", "dass du mich schon mal ...")? Kunde und Fake haben sich nie getroffen – Saetze wie "hatte ich schon mal" / "das Vergnuegen hatte ich schon" meinen seine Erfahrung mit ANDEREN. Wenn ja → umschreiben: auf seine Erfahrung eingehen, ohne so zu tun als haette er dich bereits erlebt.';
  // Allgemein: Grenzen einhalten – wenn die letzte Moderatoren-Nachricht etwas abgelehnt oder eine Grenze gesetzt hat, darf die naechste Antwort das nicht aufheben oder das abgelehnte Szenario wieder einbauen.
  const boundaryConsistencyRule = ' Enthaelt der Chat-Verlauf in der letzten Moderatoren-Nachricht eine Ablehnung oder Grenze (z.B. etwas abgelehnt, "nicht fuer X", "nur Y", klare Einschraenkung)? Wenn ja: Widerspricht die zu korrigierende Antwort dieser Grenze oder baut das abgelehnte Szenario wieder ein? Wenn ja → umschreiben: Grenze einhalten, auf die Kundenfrage eingehen, keine Wiederaufnahme des abgelehnten Themas.';
  // Eigene Aussagen konsistent halten: Wenn die Persona in einer vorherigen Nachricht etwas ueber SICH gesagt hat (Essen, Aktivitaet), darf die Antwort nicht zu etwas anderem wechseln.
  const selfConsistencyRule = ' Enthaelt der Chat-Verlauf eine vorherige Moderator-Nachricht, in der die Persona etwas ueber SICH gesagt hat (z.B. was sie isst, macht, wo sie ist – Nudeln mit Pesto, Omelett, etc.)? Widerspricht die zu korrigierende Antwort dem (z.B. anderes Essen, andere Aktivitaet)? Wenn ja → umschreiben: konsistent mit der vorherigen Aussage bleiben, NICHT das des Kunden echoen oder etwas Neues erfinden.';
  // Wenn WIR (Moderator) in der letzten Nachricht etwas ueber UNS gesagt haben (z.B. Wohnort "ich bin aus Heikendorf"), darf die Antwort das NICHT als Kundenwissen bestaetigen ("geil dass du das weisst").
  const noEchoOwnModeratorStatementRule = ' Enthaelt die LETZTE Moderator-Nachricht im Chat-Verlauf eine Aussage ueber die Persona selbst (z.B. Wohnort "ich bin aus X", "wohne in X", Beruf, was sie macht)? Enthaelt die zu korrigierende Antwort dann Formulierungen, als haette der KUNDE das gesagt oder gewusst (z.B. "geil dass du das weisst", "super dass du weisst woher ich bin", "ja ich bin aus [Ort]" als Wiederholung)? Wenn ja → umschreiben: diesen Teil entfernen, stattdessen auf das eingehen, was der Kunde WIRKLICH geschrieben hat (seine Fragen, seine Themen). Die eigene Aussage nicht dem Kunden zuschreiben.';
  // Kunde aeusert Einschraenkung/Problem (z.B. kann nicht mehr schreiben, keine Credits/Geld, will nicht, spricht dagegen): Antwort soll nachfragen (warum? was spricht dagegen? ich dachte wir verstehen uns gut?), nicht nur bestaetigen und Thema wechseln.
  const limitationFollowUpRule = ' Aeusert die Kundennachricht eine Einschraenkung oder ein Problem (z.B. kann nicht mehr schreiben, keine Credits/Geld, will nicht, spricht dagegen, geht nicht)? Wenn ja: Geht die Antwort nur kurz darauf ein und wechselt dann das Thema, ohne nachzufragen? Wenn ja → umschreiben: echte Nachfrage einbauen (warum? was spricht dagegen? ich dachte wir verstehen uns gut? was haelt dich ab?), Neugier zeigen, Thema nicht einfach wechseln.';
  // Kunde hat bereits konkrete Vorschlaege/Ideen genannt (z.B. Kino, Kaffee, kochen): Antwort soll darauf eingehen (sagen was gefaellt), nicht dieselben Ideen als neue Aufzaehlung oder Rueckfrage wiederholen.
  const engageOnSuggestionsRule = ' Hat der Kunde bereits konkrete Vorschlaege oder Ideen genannt (z.B. Aktivitaeten, Optionen)? Wenn ja: Gibt die Antwort nur eine aehnliche Aufzaehlung oder Rueckfrage zurueck, ohne auf seine genannten Ideen einzugehen (sagen was dir gefaellt)? Wenn ja → umschreiben: auf seine genannten Ideen eingehen, sagen was dir gefaellt oder kommentieren, statt dieselben Ideen als neue Aufzaehlung zurueckzugeben.';
  // Doppelprofil: Kunde ist EINE Person – nie ihr/euch, immer du/dich/dir
  const customerSingularRule = (context.fakeIsPlural === true)
    ? ' ANREDE KUNDE: Profil = 2 Personen (wir/uns). Der Kunde ist EINE Person. Enthaelt die Antwort "ihr"/"euch" in Bezug auf den Kunden (z.B. "was wuerdet ihr")? Wenn ja → in du/dich/dir aendern (z.B. "was wuerdest du").'
    : '';
  // EINZELPROFIL: Moderator ist EINE Person – wir/uns/unsere in Selbstbezug sind falsch, durch ich/mich/meine ersetzen
  const singleProfileNoWirRule = (context.fakeIsPlural === false)
    ? ' EINZELPROFIL: Das Profil ist EINE Person (kein Doppelprofil). Enthaelt die Antwort "wir", "uns", "unsere" in Bezug auf die Persona (z.B. "du uns", "unsere Spalte", "wir werden feucht")? Wenn ja → ersetzen durch ich, mich, meine (z.B. "du mich", "meine Spalte", "ich werde feucht").'
    : '';
  // Beziehungsstatus: Fake in Beziehung/verheiratet/verwitwet – NIEMALS "single" oder "keinen Partner" sagen
  const noFalseSingleRule = (context.isNonSingle === true && context.fakeRelationshipStatus)
    ? ` PFLICHT BEZIEHUNGSSTATUS: Der Fake ist ${sanitizeForApiContent(context.fakeRelationshipStatus)}. Enthaelt die Antwort "single", "keinen Partner", "hab keinen Partner", "bin ja single" oder aehnlich? Wenn ja → ersetzen durch den tatsaechlichen Status (z.B. "hab einen Partner", "bin in einer Beziehung", "bin verheiratet"). Es ist okay, dass der Fake nicht single ist.`
    : '';
  // Telefonsex/Fotos: NIEMALS vorschlagen – wir schicken keine Fotos, Telefonsex ist nicht moeglich
  const noTelefonsexPhotoRule = ' PFLICHT: Enthaelt die Antwort Vorschlaege wie Telefonsex, heisse Fotos schicken, Bilder als Loesung/Alternative (z.B. "mit Telefonsex und heissen Fotos", "Fotos vorweg")? Wir schicken keine Fotos, Telefonsex ist auf der Plattform nicht moeglich. Wenn ja → entfernen und durch andere Argumente ersetzen (Fantasie, Vorstellungskraft, Kennenlernen im Chat) – ohne Telefonsex oder Foto-Tausch zu nennen.';
  // Rueckfragen/Callbacks: Kunde fragt "woher weisst du das", "wie meinst du das" – Antwort muss darauf eingehen, nicht themenfremd werden
  const ruckfrageCallbackRule = ' Fragt der Kunde auf die letzte Moderatoren-Nachricht zurueck (z.B. "woher weisst du das", "wie meinst du das", "wer weiss", "woher soll ich das wissen")? Geht die Antwort DIREKT darauf ein (Erklaerung, Begruendung, Flirt-Kommentar) – oder wechselt sie themenfremd (z.B. Name, Beruf, "was machst du gerade")? Wenn themenfremd → umschreiben: Rueckbezug auf die eigene Aussage herstellen, Flirt-Ton beibehalten (z.B. "weil du so rueberkommst", "weil ich dich sympathisch finde").';
  // Treffen: NIEMALS einem konkreten Tag/Ort/Zeit zustimmen – auch bei sexuellen Themen. Wie ausgewichen wird, kennt Mistral aus dem Training.
  const meetingRule = (context.isMeetingSituation === true)
    ? (context.isDirectMeetingRequest === true
      ? ' PFLICHT TREFFEN: Wenn Kontext "Thema Treffen/Bar/Zeit" enthaelt: Die Antwort darf NIEMALS einem konkreten Tag, Uhrzeit oder Ort zustimmen oder diese nennen. Keine weichen Zusagen ("passt gut", "bin flexibel", "am Abend koennten wir"). Unverbindlich/hypothetisch formulieren. Kunde will treffen: VERBOTEN "lass uns erstmal noch schreiben", "erst kennenlernen", "noch ein bisschen schreiben" – nimmt die Hoffnung. Stattdessen: auf seinen Wunsch eingehen (z.B. "will auch nicht ewig nur schreiben", "schaue mal wie es passt", "muessen mal schauen wann es bei uns klappt"). NICHT aktiv nach Ort oder Ideen fragen ("Wo koennten wir treffen?", "Was fuer Ideen?" – verboten). VERBOTEN: "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen", "Was haeltst du davon wenn wir uns einen Tag raussuchen" – zu direkt; ersetzen durch unverbindlich (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es passt"). Erlaubt: andeuten, vage Vorlagen (was zusammen machen, essen gehen); Initiative beim Kunden. VERBOTEN: Meta-Frage "Was denkst du darüber?" – durch thematische Frage zum Treffen ersetzen. Ein Ausweichgrund reicht, kein "besser kennenlernen" doppeln.'
      : ' TREFFEN/VORFREUDE: Der Kunde hat nur Vorfreude geaeussert (keine konkrete Treffen-Anfrage). Enthaelt die Antwort "kennenlernen" oder "erst quatschen" als Ablehnung? Wenn ja → umformulieren: positiv auf die Vorfreude eingehen oder Gegenfrage, wie in Trainingsdaten. Keine Standard-Ablehnung einbauen. Keine Zusage zu Ort/Zeit. Wenn der Kunde positiv zustimmt (z.B. "dann treffen wir uns", "dann brauchen wir uns nur noch treffen") ohne konkrete Zeit: NICHT mit "zu ueberstuerzt", "muss sacken lassen" antworten – wirkt wie Ablehnung. Stattdessen: positiv auf die Idee eingehen (klingt gut, waere schoen) und unverbindlich bleiben. SZENARIO NUR: Enthaelt die Antwort Ablenkung wie "platt", "muede von der Woche", "brauch Ruhe", "wenn du wieder fit bist", "wie wir das umsetzen koennten"? Wenn ja → diese Saetze/Teile entfernen oder umformulieren: beim Thema der Kundennachricht bleiben (z.B. Kuscheln/Fantasie), eine einfache thematische Frage (z.B. "waere das nicht schoen?", "denkst du es wuerde beim Kuscheln bleiben?"). Kein Recyceln alter Kundeninfos (fit, Gesundheit) wenn der Kunde sie in dieser Nachricht nicht anspricht.')
    : '';
  // Jede Nachricht muss eine Frage enthalten (auch im Minimal-Prompt Pflicht) + ganze Kundennachricht abdecken
  const questionAndWholeRule = ' PFLICHT: (1) Jede Nachricht muss eine Frage enthalten. Fehlt eine → eine passende Frage einbauen (z. B. am Ende). (2) Die Antwort MUSS auf die GESAMTE Kundennachricht eingehen – jede Frage, jedes Thema, jede Aussage. Ignoriert die Antwort Teile der Kundennachricht? → kurzen Bezug ergänzen, nichts auslassen.';
  // Mehrere Themen: Wenn Kunde mehrere Beduerfnisse nennt (z.B. Sex + gutes Gespraech + nicht ewig schreiben), jedes mindestens kurz bedienen.
  const multiThemeRule = ' Enthaelt die Kundennachricht mehrere Themen/Beduerfnisse (z.B. Sex + gutes Gespraech wichtig + nicht ewig nur schreiben wollen / absprechen/Anruf)? Ignoriert die Antwort eines davon komplett? Wenn ja → kurzen Satz ergaenzen (z.B. "will auch nicht ewig nur schreiben", "kümmer mich drum", "Gespraech ist mir auch wichtig"), ohne andere Regeln zu verletzen. Nennt der Kunde Vorlieben UND Tabus (z.B. "gerne versaut" und "Tabus habe ich keine außer X") oder fragt "und du?" / ob du Tabus hast? Ignoriert die Antwort Tabus oder die Rueckfrage? Wenn ja → kurzen Bezug zu Tabus und Antwort auf "und du?" ergaenzen (z.B. eigene Tabus/Grenzen nennen), nicht nur auf Vorlieben antworten. Nichts im Raum stehen lassen.';
  // Treffen: Keine konkrete Zusage, aber unverbindliche Aussicht wie "schaue mal wann es klappt" ist erlaubt (wie in Training-Daten).
  const meetingTreffenAussichtRule = (context.isMeetingSituation === true)
    ? ' TREFFEN: Keine konkrete Zusage zu Tag/Ort/Zeit. Unverbindliche Formulierungen wie "Ich schaue mal wann es klappt", "muss mal schauen wann es bei mir passt", "Dann weiss ich Bescheid" sind ERLAUBT – keine Zusage, aber Kunde kann beruhigt sein. Nicht "nie klappt" oder abweisend. Wie in Training-Daten.'
    : '';
  // Mindestlaenge 120 Zeichen: Korrektor erweitert zu kurze Nachrichten thematisch passend (keine generischen Floskeln)
  const minLengthRule = ' PFLICHT: Die Nachricht muss mindestens 120 Zeichen haben. Ist sie kuerzer: mit einem thematisch passenden Satz oder einer passenden Frage erweitern (zur Kundennachricht und zur Antwort passend), sodass mindestens 120 Zeichen. Keine generischen Fragen wie "Und bei dir so?" – nur inhaltlich passende Erweiterung.';
  // Plattform-Zensur (***): Antwort darf keine *** enthalten und nicht "zensiert"/"ausgeblendet" sagen – clever ueberspielen
  const censorshipRule = ' Enthaelt die Antwort *** oder ***** oder Formulierungen wie "wird zensiert", "ist ausgeblendet", "Plattform zeigt das nicht"? Wenn ja → entfernen und unauffaellig ueberspielen (z.B. auf Absicht eingehen, hier weiterschreiben), dem Kunden NICHT sagen dass zensiert wird.';
  // Treffen: Keine Aussagen wie "dann kann man sich oft treffen" / "mag es wenn man so nah wohnt" – zu verbindlich; kurze Bestaetigung (Da hast du recht) statt ausbauen
  const noOftTreffenRule = ' Enthaelt die Antwort Formulierungen wie "oft treffen", "richtig oft treffen", "kann man sich oft treffen", "mag es wenn man so nah wohnt", "da kann man sich oft treffen"? Wenn ja → diesen Satz/Teil entfernen oder durch kurze Bestaetigung ersetzen (z.B. "Da hast du recht."), nicht ausbauen.';
  // Abholen: NIEMALS anbieten den Kunden abzuholen – konkrete Zusage
  const noAbholenRule = ' Enthaelt die Antwort ein Angebot den Kunden abzuholen ("Ich hol dich ab", "hol dich gerne ab", "kannst dich abholen", "hol dich ab", "kein Problem ich hol dich ab")? Wenn ja → diesen Satz/Teil entfernen, unverbindlich bleiben.';
  // Treffen: "einen Tag raussuchen" / "Was hältst du davon wenn wir uns einen Tag raussuchen" – zu direkt, ersetzen durch unverbindlich
  const noTagRaussuchenRule = (context.isMeetingSituation === true)
    ? ' Enthaelt die Antwort "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen", "einfach mal einen Tag raussuchen" oder "Was haeltst du davon wenn wir uns einen Tag raussuchen"? Wenn ja → diesen Teil ersetzen durch unverbindliche Formulierung (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es bei mir passt", "muss schauen wann es klappt") – nicht so tun als wuerdet ihr gemeinsam einen Tag planen.'
    : '';
  // Ungefragte Alter-/Typ-Komplimente: Bei kurzer themenfokussierter Kundennachricht nicht "mag aeltere Maenner wie dich" o.ae. einbauen
  const noUnaskedAgeTypeComplimentRule = ' Enthaelt die Antwort ungefragte Komplimente zu Alter/Typ des Kunden ("mag aeltere Maenner wie dich", "steh auf Maenner wie dich", "dein Alter macht es spannender", "Maenner wie du") obwohl die Kundennachricht kurz und themenfokussiert war (z.B. nur "Wellness sounds gut")? Wenn ja → diesen Satz/Teil entfernen, beim Thema der Kundennachricht bleiben.';
  // Zeit-Zusage immer verboten: Kunde nennt Zeitraum/Tag (z.B. 01.-21.06, Juni, nächste Woche) – Antwort darf NICHT zustimmen ("passt perfekt", "passt gut", "klingt gut"). Gilt auch bei Sex/Fantasy-Kontext.
  const noTimeAgreementRule = ' Hat der Kunde einen Zeitraum, Tag oder Zeitfenster genannt (z.B. 01.-21.06, Juni, nächste Woche, ein Datum)? Enthaelt die Antwort eine Zusage dazu (z.B. "passt perfekt", "passt gut", "klingt gut", "zwischen X und Y passt", "die Zeiten passen", "passt mir")? Wenn ja → umschreiben: keine Zusage zu Zeitfenstern/Tagen; unverbindlich bleiben oder auf anderes eingehen (z.B. auf die Idee/Stimmung), nicht auf den genannten Zeitraum zustimmen.';

  if (MISTRAL_USE_MINIMAL_PROMPT) {
    // Minimal-Prompt: nur Daten, keine langen Regeln. Eigenes Modell (z. B. Fine-Tune) hat bereits gelernt, wie korrigiert wird – lange Anweisungen würden das Gelernte überschreiben.
    // Bei Kontaktdaten: klare, umsetzbare Anweisung für Mistral (Korrektor hat keinen Zugriff auf Trainingsdaten – nur prüfen und ersetzen).
    const contactRuleMinimal = (context.contactRequest === true)
      ? ' Bei Kontaktdaten-Anfrage: Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten" oder "duerfen nicht"? Wenn ja → diese Formulierungen entfernen und persoenlich ausweichend ersetzen. Sonst Stil beibehalten.'
      : '';
    const noEchoMinimal = ' Du korrigierst NUR die Moderatoren-Antwort. Die Kundennachricht ist nur Kontext. Gib NIEMALS die Kundennachricht oder eine Paraphrase davon als Ausgabe zurueck – die Ausgabe muss eindeutig die Antwort des Fake-Profils sein, keine Wiederholung des Kunden. Falsch: Kundentext leicht umformuliert zurueckgeben. Richtig: nur die Moderatoren-Antwort inhaltlich/stilistisch korrigieren. Die Antwort darf NICHT mit einer Paraphrase oder Aufzaehlung dessen beginnen, was der Kunde gesagt hat – entweder kurze Reaktion (z. B. Das klingt flexibel) oder direkt eigene Aussage/Frage.';
    const toneMinimal = ' Ton der urspruenglichen Antwort (locker, umgangssprachlich) beibehalten – nicht formell oder typisch KI umschreiben.';
    systemContent = 'PFLICHT: Nur die fertige korrigierte Nachricht zurueckgeben, keine Erklaerungen.\n\nDu bist ein Korrektor für Chat-Moderator-Antworten. Gib nur die fertige korrigierte Nachricht zurück, keine Erklärungen, keine Meta-Kommentare.' + toneMinimal + ' Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten, nur klare Fehler korrigieren. Jede Nachricht muss eine Frage enthalten; maximal ein bis zwei Fragen, keine Frage-Kaskade. Mindestens 120 Zeichen – bei kürzerer Nachricht thematisch passend erweitern.' + noEchoMinimal + contactRuleMinimal + noFalseSingleRule + noTelefonsexPhotoRule + ruckfrageCallbackRule + noWiedersehenRule + noSharedPastRule + noTimeAgreementRule + noAbholenRule + noUnaskedAgeTypeComplimentRule + boundaryConsistencyRule + selfConsistencyRule + noEchoOwnModeratorStatementRule + censorshipRule + noOftTreffenRule + limitationFollowUpRule + engageOnSuggestionsRule + neutralMessageNoSexRule + meetingRule + meetingTreffenAussichtRule + noTagRaussuchenRule + multiThemeRule + questionAndWholeRule + minLengthRule + sameActivityPlaceRule + noParaphraseRule + noQuestionAlreadyAnsweredRule + imageOnlyAnnouncedRule + imageClaimedButNotPresentRule + noPlaceClaimRule + noStrongHopeRule + customerSingularRule + humanTyposHint;
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht (nur Kontext – nicht ausgeben):\n"${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Moderatoren-Antwort:\n\n${sanitizeForApiContent(grokText.trim())}\n\nGib NUR die korrigierte Moderatoren-Antwort aus. Niemals die Kundennachricht oder eine Paraphrase davon zurueckgeben.`;
    if (process.env.NODE_ENV !== 'production') console.log('🔧 Mistral-Korrektor: Minimal-Prompt (eigenes Modell)');
  } else {
    const contactCheck = context.contactRequest === true ? '\n(6) Kontaktdaten: Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten"? → entfernen/umschreiben. Lehnt die Antwort die Kontakt-Anfrage nicht ab? → persoenlich ausweichend einbauen.' : '';
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht (nur Kontext – nicht ausgeben):\n"${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Moderatoren-Antwort:\n\n${sanitizeForApiContent(grokText.trim())}\n\nPrüfe die obige Moderatoren-Antwort und korrigiere/verbessere sie:\n(1) PFLICHT: Geht die Antwort auf die GESAMTE Kundennachricht ein – jede Frage, jedes Thema, jede Aussage? Enthaelt die Kundennachricht mehrere Fragen/Themen? Geht die Antwort auf JEDE ein? Wenn eine Frage oder ein Thema fehlt → kurzen Bezug ergaenzen (1 Satz oder Teilsatz), nichts auslassen.\n(2) Enthält die Nachricht eine Frage? Wenn nein → Frage einbauen.\n(3) Hat die Nachricht mindestens 120 Zeichen? Wenn nein → thematisch passend erweitern (keine generischen Floskeln).\n(4) Umlaute (ä,ö,ü) und ss statt ß? Stil/Bindestriche?\n(5) Enthält die Antwort Meta-Kommentare, Echo/Paraphrase der Kundennachricht oder Meta-Fragen wie "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?"? Wenn ja → entfernen bzw. durch konkrete thematische Frage ersetzen, eigenständig formulieren (Kundentext nicht nachplappern).\n(6) Kunde will treffen: Enthält die Antwort "lass uns erstmal noch schreiben", "erst kennenlernen", "noch ein bisschen schreiben" oder Meta-Fragen wie "Was denkst du darüber?"? Wenn ja → umschreiben: auf Treffenwunsch eingehen (z.B. will auch nicht ewig nur schreiben, schaue wie es passt) + konkrete Frage zum moeglichen Treffen (Café, Essen, Vorlieben – variieren), nicht immer dieselbe Formulierung.${contactCheck}\nGib NUR den fertigen korrigierten Text zurück, keine Erklärungen. Niemals die Kundennachricht oder eine Paraphrase davon zurueckgeben.`;

    const imageOnlyAnnouncedRule = (context.imageOnlyAnnounced === true)
      ? ' BILD NUR ANGEKUENDIGT: Kunde hat noch kein Bild geschickt. "Danke fuer das Bild" oder Bewertung (sieht geil aus) → entfernen/ersetzen durch Vorfreude (freue mich drauf).'
      : '';
    const imageClaimedButNotPresentRule = (context.imageClaimedButNotPresent === true)
      ? ' BILD BEHAUPTET, ABER NICHT DA: Kunde behauptet Bild geschickt – keins angekommen. Reaktion auf ein Bild ("dein Bild macht mich geil", Bewertung)? → ersetzen durch: kein Bild angekommen, ggf. bitten nochmal zu schicken.'
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
    const noMetaPhrasesRuleMistral = ' Formulierungen wie "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?" sind verboten – durch konkrete thematische Fragen ersetzen.';
    const noEchoRule = ' Du korrigierst NUR die Moderatoren-Antwort; die Kundennachricht ist nur Kontext. Gib NIEMALS die Kundennachricht oder eine Paraphrase davon als Ausgabe zurueck – die Ausgabe muss eindeutig die Antwort des Fake-Profils sein. Wiederhole die Kundennachricht NICHT woertlich oder fast woertlich; formuliere eigenstaendig (z.B. nicht "dass du mich so X findest" wenn der Kunde "du bist so X" schrieb). Falsch: Kundentext leicht umformuliert zurueckgeben. Richtig: nur die Moderatoren-Antwort korrigieren. Bei Echo/Paraphrase → ersetzen durch eigenstaendige Reaktion.';
    const toneRuleMistral = ' TON: Die urspruengliche Antwort ist locker/umgangssprachlich. Korrektur darf den Ton NICHT formell oder typisch "KI" machen – Stimmung und Wortwahl beibehalten, nur klare Regelverstoesse aendern, nicht glaetten oder umformulieren.';
    systemContent = `PFLICHT: Nur die fertige korrigierte Nachricht ausgeben, keine Erklaerungen.

Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide immer anhand des gesamten Kontexts und der Kundennachricht.${toneRuleMistral} ${sexualRule} ${contactIrritatedRule}${meetingRule} ${meetingTreffenAussichtRule} ${multiThemeRule} ${noFalseSingleRule} ${noTelefonsexPhotoRule} ${ruckfrageCallbackRule} ${noWiedersehenRule} ${noSharedPastRule} ${noTimeAgreementRule} ${noAbholenRule} ${noUnaskedAgeTypeComplimentRule} ${boundaryConsistencyRule} ${selfConsistencyRule} ${noEchoOwnModeratorStatementRule} ${censorshipRule} ${noOftTreffenRule} ${limitationFollowUpRule} ${engageOnSuggestionsRule} ${metaRule} ${noMetaPhrasesRuleMistral} ${noEchoRule}${noQuestionAlreadyAnsweredRule}${questionAndWholeRule}${minLengthRule}${sameActivityPlaceRule}${noParaphraseRule}${customerSingularRule} Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten, nur klare Fehler korrigieren. Jede Nachricht muss eine Frage enthalten; maximal ein bis zwei Fragen, keine Frage-Kaskade.${humanTyposHint} PFLICHT: Jede Nachricht muss eine Frage enthalten. Fehlt eine Frage, fuege UNBEDINGT eine kurze, thematisch passende Frage ein (z. B. am Ende). Die Antwort MUSS mindestens 120 Zeichen haben – bei kürzerer Nachricht thematisch passend erweitern (keine generischen Floskeln). Die Antwort MUSS auf die Kundennachricht eingehen. Fragt der Kunde "woher weisst du das" etc.? → Antwort muss darauf eingehen, nicht themenfremd. Enthaelt die Antwort Telefonsex- oder Foto-Vorschlaege? → entfernen. Wenn etwas zu korrigieren ist (fehlende Frage, kein Bezug, Rueckfrage ignoriert, Telefonsex/Fotos, Beziehungsstatus falsch, Kontaktdaten nicht abgelehnt, Meta/Wiederholung, Umlaute/ss, Stil), aendere es. Schreibe mit ä, ö, ü. Immer ss, nie ß. Keine Anführungszeichen. Keine Bindestriche. Antworte NUR mit der fertigen korrigierten Nachricht – kein anderer Text.`;
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

const OPENAI_CORRECTOR_TIMEOUT_MS = 25000;
const OPENAI_CORRECTOR_MAX_TOKENS = 500;

/**
 * OpenAI als vollwertiger Korrektor (gleiche Regeln wie Mistral/Grok), inkl. Umlaute/ss.
 * Wird nach Mistral/LoRA auf die finale Nachricht angewendet, wenn OPENAI_API_KEY und USE_OPENAI_CORRECTOR gesetzt.
 * @param {Object} opts - wie runMistralCorrector: customerMessage, context, grokText, planSnippet, conversationSnippet, learningContext, exampleSnippet
 * @returns {Promise<string|null>} korrigierte Nachricht oder null
 */
async function runOpenAIFullCorrector({ customerMessage = '', context = {}, grokText = '', learningContext = '', exampleSnippet = '', planSnippet = '', conversationSnippet = '' }) {
  if (!grokText || !grokText.trim()) return null;
  const key = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim();
  if (!key) return null;
  const useOpenAICorrector = process.env.USE_OPENAI_CORRECTOR === 'true' || process.env.USE_OPENAI_CORRECTOR === '1';
  if (!useOpenAICorrector) return null;
  const client = getClient();
  if (!client) return null;

  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push(context.isDirectMeetingRequest ? 'Thema Treffen/Bar/Zeit (direkte Anfrage)' : 'Thema Treffen/Vorfreude (keine direkte Anfrage)');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  if (context.contactRequest === true) ctx.push('Kunde fragt nach Kontaktdaten/Telegram/WhatsApp – persönlich ausweichen');
  if (context.fakeIsPlural === true) ctx.push('Doppelprofil (wir/uns) – Kunde ist EINE Person, anreden mit du/dich/dir');
  if (context.isNonSingle === true && context.fakeRelationshipStatus) ctx.push(`Fake ist ${context.fakeRelationshipStatus} – NIEMALS "single" sagen`);
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';
  const planBlock = (planSnippet && planSnippet.trim()) ? `Plan: ${sanitizeForApiContent(planSnippet.trim().slice(0, 280))}${planSnippet.length > 280 ? '…' : ''}\n\n` : '';
  const conversationBlock = (conversationSnippet && conversationSnippet.trim()) ? `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(conversationSnippet.trim().slice(-450))}\n\n` : '';
  const fullCustomerMsg = (customerMessage || '').trim();
  const customerForCorrector = fullCustomerMsg.length > 800 ? fullCustomerMsg.slice(0, 800) + '…' : fullCustomerMsg;
  const learningBlock = (learningContext && learningContext.trim()) ? `Feedback/Stil: ${learningContext.trim().slice(0, 400)}\n\n` : '';
  const exampleBlock = (exampleSnippet && exampleSnippet.trim()) ? `Beispiel: "${exampleSnippet.trim().slice(0, 220)}${exampleSnippet.length > 220 ? '…' : ''}"\n\n` : '';

  const neutralMessageNoSexRule = (context.allowSexualContent !== true)
    ? ' Wenn die AKTUELLE Kundennachricht keine sexuellen Themen enthaelt, entferne/entschaerfe explizite sexuelle Formulierungen in der Antwort.'
    : '';
  const humanTyposHint = ' Optional: vereinzelt leichte Tippfehler (Komma, Buchstabe) – nicht bei jeder Nachricht.';
  const sameActivityPlaceRule = ' Behauptet die Antwort, die Persona mache dieselbe Aktivitaet am selben Ort/Zeit wie der Kunde? Wenn ja → umformulieren, nur Interesse zeigen (klingt toll), NICHT behaupten man sei dort.';
  const noParaphraseRule = ' Antwort darf die Kundennachricht nicht nur zusammenfassen oder seine Details nachplappern. Kurz bestaetigen, eigene Aussage + Frage.';
  const echoReplaceRule = ' Enthaelt die Antwort ein Echo oder Paraphrase der Kundennachricht (z.B. seinen Wunsch/Szenario in unseren Worten zurueckgeben wie "wenn du so genussvoll eine Frau verwöhnen würdest…")? Wenn ja → diesen Teil ERSETZEN durch eigenstaendige Reaktion (eigene Aussage, Gefuehl, Frage), Kundentext weder woertlich noch sinngemaess zurueckgeben. Bei sexuellen Themen: Konkrete Begriffe/Koerperteile/Handlungen des Kunden NICHT 1:1 uebernehmen – in eigenen Worten reagieren, sein Vokabular nicht spiegeln.';
  const noQuestionAlreadyAnsweredRule = ' Hat der Kunde in seiner Nachricht bereits gesagt was er geben/zeigen/tun will (z.B. "dann kriegste was tolles", "zeig dir auch was")? Enthaelt die Antwort "Was bekommst du dafuer?", "Zeigst du mir auch was?", "Was krieg ich dafuer?"? Wenn ja → diese Frage entfernen/ersetzen durch Reaktion auf sein Angebot oder andere thematische Frage.';
  const noMetaPhrasesRule = ' VERBOTEN: Meta-Kommentare wie "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?" oder vergleichbare Meta-Fragen. Stattdessen: konkrete thematische Fragen (z.B. zum Treffen, zu Vorlieben, zur Situation).';
  const imageOnlyAnnouncedRule = (context.imageOnlyAnnounced === true)
    ? ' BILD NUR ANGEKUENDIGT: "Danke fuer das Bild" oder Bewertung → entfernen/ersetzen durch Vorfreude (freue mich drauf).'
    : '';
  const imageClaimedButNotPresentRule = (context.imageClaimedButNotPresent === true)
    ? ' BILD BEHAUPTET, ABER NICHT DA: Kunde behauptet Bild geschickt – keins angekommen. Reaktion auf ein Bild ("dein Bild", Bewertung)? → ersetzen durch: kein Bild angekommen, ggf. bitten nochmal zu schicken.'
    : '';
  const noPlaceClaimRule = ' Ort (Café, Bar) vom Kunden genannt und Antwort behauptet "mag/kenne ich auch"? → umformulieren, hoechstens allgemein (klingt nett).';
  const noStrongHopeRule = ' Starke Vorfreude (z.B. "freue mich schon auf das Wochenende mit dir")? → zurueckhaltender umformulieren.';
  const noWiedersehenRule = ' PFLICHT: "wiedersehen", "wiederzusehen", "wenn wir uns wiedersehen" → ersetzen durch Formulierung OHNE "wieder" (ihr habt euch NIE getroffen).';
  const noSharedPastRule = ' Antwort darf nicht so tun, als haette der Kunde DICH schon erlebt (Kunde und Fake haben sich nie getroffen).';
  const boundaryConsistencyRule = ' Letzte Moderatoren-Nachricht enthielt Ablehnung/Grenze? → naechste Antwort darf diese nicht aufheben oder abgelehntes Szenario wieder einbauen.';
  const selfConsistencyRule = ' Vorherige Moderator-Nachricht enthielt Aussage ueber Persona (Essen, Ort, Aktivitaet)? → Antwort muss konsistent bleiben, nicht widersprechen.';
  const noEchoOwnModeratorStatementRule = ' LETZTE Moderator-Nachricht enthielt Aussage ueber Persona (z.B. Wohnort "ich bin aus X")? Antwort darf das NICHT als Kundenwissen bestaetigen ("geil dass du das weisst", "ja ich bin aus X" wiederholen) – auf das eingehen, was der Kunde WIRKLICH geschrieben hat.';
  const limitationFollowUpRule = ' Kunde aeussert Einschraenkung/Problem? → Antwort soll nachfragen (warum? was spricht dagegen?), nicht nur bestaetigen und Thema wechseln.';
  const engageOnSuggestionsRule = ' Kunde hat konkrete Vorschlaege genannt (Kino, Kaffee, kochen)? → auf seine Ideen eingehen, sagen was dir gefaellt, nicht dieselben Ideen als Aufzaehlung zurueckgeben.';
  const customerSingularRule = (context.fakeIsPlural === true) ? ' Kunde ist EINE Person: "ihr"/"euch" → du/dich/dir.' : '';
  const singleProfileNoWirRule = (context.fakeIsPlural === false) ? ' EINZELPROFIL: "wir"/"uns"/"unsere" in Bezug auf Persona → ich/mich/meine.' : '';
  const noFalseSingleRule = (context.isNonSingle === true && context.fakeRelationshipStatus)
    ? ` PFLICHT: Fake ist ${sanitizeForApiContent(context.fakeRelationshipStatus)}. "single"/"keinen Partner" → ersetzen durch tatsaechlichen Status.`
    : '';
  const noTelefonsexPhotoRule = ' PFLICHT: Telefonsex-, Foto-Vorschlaege → entfernen, durch andere Argumente ersetzen (Fantasie, Kennenlernen im Chat).';
  const ruckfrageCallbackRule = ' Kunde fragt auf letzte Moderatoren-Nachricht zurueck ("woher weisst du das")? → Antwort muss DIREKT darauf eingehen, nicht themenfremd wechseln.';
  const meetingRule = (context.isMeetingSituation === true)
    ? (context.isDirectMeetingRequest === true
      ? ' PFLICHT TREFFEN: Keine Zusage zu Tag/Uhrzeit/Ort. "Ich schaue mal wann es klappt", "muss mal schauen wann es bei mir passt", "muessen mal schauen wann es bei uns klappt" sind ERLAUBT. VERBOTEN zu direkt: "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen", "einfach mal einen Tag raussuchen", "Was haeltst du davon wenn wir uns einen Tag raussuchen" – ersetzen durch unverbindlich (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es passt"). Kunde will treffen: VERBOTEN "lass uns erstmal noch schreiben", "erst kennenlernen", "noch ein bisschen schreiben" – ersetzen durch: auf Wunsch eingehen (z.B. will auch nicht ewig nur schreiben, schaue wie es passt). NICHT aktiv nach Ort/Ideen fragen ("Wo koennten wir treffen?", "Was fuer Ideen?" – verboten); andeuten oder vage Vorlagen, Initiative beim Kunden. VERBOTEN "Was denkst du darüber?" – durch thematische Frage zum Treffen ersetzen. Ein Ausweichgrund reicht.'
      : ' TREFFEN/VORFREUDE: Keine "kennenlernen"/"erst quatschen" als Ablehnung. Positiv auf Vorfreude eingehen. Keine Ablenkung (muede, Ruhe, "wie wir das umsetzen koennten"). Wenn der Kunde positiv zustimmt (z.B. "dann treffen wir uns", "dann brauchen wir uns nur noch treffen") ohne konkrete Zeit: NICHT mit "zu ueberstuerzt", "muss sacken lassen" antworten – wirkt wie Ablehnung. Stattdessen: positiv auf die Idee eingehen (klingt gut, waere schoen) und unverbindlich bleiben (wann/wo offen), ohne den Vorschlag abzulehnen.')
    : '';
  const multiThemeRuleOpenAI = ' Enthaelt die Kundennachricht mehrere Themen/Beduerfnisse (z.B. Sex + gutes Gespraech + nicht ewig nur schreiben / absprechen)? Ignoriert die Antwort eines davon? Wenn ja → kurzen Satz ergaenzen (z.B. "will auch nicht ewig nur schreiben", "kümmer mich drum"), ohne andere Regeln zu verletzen. Nennt der Kunde Tabus und fragt "und du?"? Ignoriert die Antwort das? Wenn ja → Bezug zu Tabus und Antwort auf "und du?" ergaenzen.';
  const questionAndWholeRule = ' PFLICHT: (1) Jede Nachricht muss eine Frage enthalten. (2) Antwort MUSS auf die GESAMTE Kundennachricht eingehen – jede Frage, jedes Thema.';
  const minLengthRule = ' Mindestens 120 Zeichen. Kuerzer → thematisch passend erweitern, keine generischen Floskeln.';
  const censorshipRule = ' *** oder "zensiert"/"ausgeblendet" → entfernen und unauffaellig ueberspielen.';
  const noOftTreffenRule = ' "oft treffen", "mag es wenn man so nah wohnt" → entfernen oder durch kurze Bestaetigung ersetzen.';
  const noTimeAgreementRule = ' Kunde hat Zeitraum/Tag genannt? Antwort darf NICHT zustimmen ("passt perfekt", "passt gut", "klingt gut"). Unverbindlich bleiben.';
  const noAbholenRuleOpenAI = ' Enthaelt die Antwort "Ich hol dich ab", "hol dich gerne ab", "kannst dich abholen" o.ae.? → diesen Teil entfernen, unverbindlich bleiben.';
  const noUnaskedAgeTypeComplimentRuleOpenAI = ' Enthaelt die Antwort ungefragte Komplimente zu Alter/Typ ("mag aeltere Maenner wie dich", "dein Alter macht es spannender") bei kurzer themenfokussierter Kundennachricht? → diesen Teil entfernen, beim Thema bleiben.';
  const sexualRule = context.allowSexualContent === true
    ? (context.customerTalkingAboutSexWithFake === true
      ? ' Kunde spricht direkt ueber Sex mit Fake – sexuelle Inhalte NICHT entfernen/entschaerfen.'
      : ' Kunde erzählt Story ohne direkten Sex-Bezug zum Fake – eigene Erregungs-Beschreibungen entschaerfen/entfernen, flirty bleiben.')
    : ' Aktuelle Kundennachricht nicht sexuell? → explizite sexuelle Formulierungen in der Antwort entfernen/entschaerfen.';
  const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
    ? (context.contactRequest === true
      ? ' KONTAKTDATEN: "nicht erlaubt"/"Regeln"/"Plattform" entfernen, persoenlich ausweichend ersetzen. Kontakt-Anfrage persoenlich ablehnen.'
      : ' Gereizter Kunde: sachlich, deeskalierend, thematisch passende Frage.')
    : '';
  const metaRule = ' Keine Meta-Kommentare, keine Erklaerungen – nur die eine Chat-Nachricht ausgeben.';
  const noEchoRule = ' Gib NUR die Moderatoren-Antwort zurueck. Kundennachricht weder woertlich noch sinngemaess nachplappern. Bei Echo/Paraphrase des Kundentextes → ersetzen durch eigenstaendige Reaktion.';

  const toneRule = ' TON WICHTIG: Die urspruengliche Antwort kommt von einem anderen Modell (locker, umgangssprachlich, menschlich). Deine Korrektur darf den Ton NICHT in einen formellen oder typisch "KI"-klingenden Stil aendern. Nur klare Regelverstoesse korrigieren; Formulierung, Stimmung und Wortwahl der urspruenglichen Antwort beibehalten. Nicht "verbessern", nicht glaetten, nicht umformulieren um sie eleganter klingen zu lassen.';
  const systemContent = `PFLICHT: Nur die fertige korrigierte Nachricht ausgeben, keine Erklaerungen.

Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide anhand des gesamten Kontexts und der Kundennachricht. Nur bei klaren Regelverstoessen umschreiben; Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten.${toneRule} ${sexualRule} ${contactIrritatedRule}${meetingRule} ${multiThemeRuleOpenAI} ${noFalseSingleRule} ${noTelefonsexPhotoRule} ${ruckfrageCallbackRule} ${noWiedersehenRule} ${noSharedPastRule} ${noTimeAgreementRule} ${noAbholenRuleOpenAI} ${noUnaskedAgeTypeComplimentRuleOpenAI} ${boundaryConsistencyRule} ${selfConsistencyRule} ${noEchoOwnModeratorStatementRule} ${censorshipRule} ${noOftTreffenRule} ${limitationFollowUpRule} ${engageOnSuggestionsRule} ${metaRule} ${noMetaPhrasesRule} ${noEchoRule} ${echoReplaceRule}${noQuestionAlreadyAnsweredRule}${questionAndWholeRule}${minLengthRule}${sameActivityPlaceRule}${noParaphraseRule}${customerSingularRule}${singleProfileNoWirRule} Jede Nachricht muss eine Frage enthalten; mindestens 120 Zeichen.${humanTyposHint} ${imageOnlyAnnouncedRule} ${imageClaimedButNotPresentRule} ${noPlaceClaimRule} ${noStrongHopeRule} ${neutralMessageNoSexRule}

Außerdem: Umlaute korrigieren (ae→ä, oe→ö, ue→ü wo es Umlaut ist; nicht in Feuer, Museum, etc.). Immer ss statt ß. Keine Anführungszeichen, keine Bindestriche. Gib NUR die fertige korrigierte Nachricht zurück – kein anderer Text.`;

  const userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht (nur Kontext – nicht ausgeben):\n"${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Moderatoren-Antwort:\n\n${sanitizeForApiContent(grokText.trim())}\n\nPrüfe und korrigiere: Geht die Antwort auf die GESAMTE Kundennachricht ein? Enthaelt die Kundennachricht mehrere Fragen oder Themen (z.B. mehrere Saetze/Fragen)? Geht die Antwort auf JEDE ein? Wenn eine Frage oder ein Thema fehlt → kurzen Bezug ergaenzen (1 Satz oder Teilsatz). Enthaelt sie eine Frage? Mindestens 120 Zeichen? Umlaute und ss statt ß? Beginnt die Antwort mit einer Paraphrase/Aufzaehlung der Kundennachricht (z. B. "Ah, du machst X und Y und Z...")? Wenn ja → ersetzen: nur kurze Reaktion (z. B. Das klingt flexibel bei dir) + eigene Aussage + Frage. Echo/Paraphrase: Gibt die Antwort den Kundentext (oder sein Szenario/Wunsch) woertlich oder sinngemaess zurueck? Wenn ja → ersetzen durch eigenstaendige Reaktion. Meta: Enthaelt die Antwort "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?" oder aehnliche Meta-Fragen? Wenn ja → durch konkrete thematische Frage ersetzen. Kunde will treffen: Enthaelt die Antwort "erstmal noch schreiben", "erst kennenlernen" oder "Was denkst du darüber?"? Wenn ja → umschreiben: auf Treffenwunsch eingehen; NICHT aktiv nach Ort oder Ideen fragen ("Wo koennten wir treffen?", "Was fuer Ideen?" – verboten); andeuten/vage Vorlagen, Initiative beim Kunden. Enthaelt die Antwort "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen" oder "Was haeltst du davon wenn wir uns einen Tag raussuchen"? Wenn ja → ersetzen durch unverbindliche Formulierung (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es passt"). Gib NUR den fertigen korrigierten Text zurück.`;

  try {
    const out = await callOpenAI(
      [{ role: 'system', content: systemContent }, { role: 'user', content: userContent }],
      { temperature: 0.25, max_tokens: OPENAI_CORRECTOR_MAX_TOKENS, timeoutMs: OPENAI_CORRECTOR_TIMEOUT_MS }
    );
    const corrected = (out || '').trim();
    if (corrected && corrected.length >= 20 && corrected.length <= grokText.length * 1.8) {
      console.log('✅ OpenAI-Korrektor: Nachricht korrigiert (' + grokText.length + ' → ' + corrected.length + ' Zeichen)');
      return corrected;
    }
  } catch (err) {
    console.warn('⚠️ OpenAI-Korrektor fehlgeschlagen:', err.message);
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
    imageOnlyAnnounced = false,
    imageClaimedButNotPresent = false
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
        finalMessage = postProcessMessage(finalMessage);
        finalMessage = await ensureQuestionInMessage(finalMessage, { customerMessage, conversationSnippet: (conversationHistory || '').trim().slice(-400) });
        finalMessage = await ensureMinimumLength(finalMessage, customerMessage);
        finalMessage = await applySpellingCorrectionIfAvailable(finalMessage);
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
      const rawMessage = await callGrok(messages);
      let finalMessage = postProcessMessage(rawMessage);
      finalMessage = await applySpellingCorrectionIfAvailable(finalMessage);
      return emptyResult({
        safety: safetyCheck,
        finalMessage,
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
      finalMessage = await applySpellingCorrectionIfAvailable(finalMessage);
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
  let situationRulesBlock = buildSituationRulesBlock(situationsForRulesBlock, allRules);
  if (situationsForRulesBlock.includes('Was willst du wissen?') && (!allRules?.situationalResponses || !allRules.situationalResponses['Was willst du wissen?'])) {
    situationRulesBlock += '\n[Was willst du wissen?]: Antworte inhaltlich auf die Frage: nenne 1–2 Dinge die du wissen moechtest (z.B. was er sucht, Beruf, Hobbys) und stelle genau dazu eine konkrete Kennenlern-Frage. Keine Wiederholung von Wohnort, keine Frage nach bereits bekannten Profildaten. Orientiere dich an Kennenlern-Beispielen (Stil wie in Trainingsdaten unter Allgemein).\n';
  }
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
  // Romantik/Verliebtheit + "Was willst du wissen?": Trainings-Beispiele sind unter "Allgemein" / Kennenlernen – keine Situationsfilterung, nur Ähnlichkeit
  let situationsForExamples = (primarySituation === 'Romantik / Verliebtheit' || primarySituation === 'Was willst du wissen?')
    ? null
    : (detectedSituations.length > 0 ? detectedSituations : null);
  // Fallback: Wenn Kunde Einschränkung/Credits/Geld andeutet (z.B. "kann nicht mehr schreiben"), aber LLM hat "Geld/Coins" nicht erkannt – für Beispielauswahl trotzdem "Geld/Coins" nutzen, damit passende Trainings-Beispiele gefunden werden
  const limitationKeywords = ['nicht mehr schreiben', 'keine credits', 'kein geld', 'credits', 'coins', 'kann nicht mehr', 'schade dass ich nicht mehr', 'keine nachrichten mehr', 'aufladen', 'kosten', 'zu teuer', 'zu teuer ist', 'mir zu teuer'];
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
  if (fakeCity && customerCity && fakeCity.toLowerCase() === customerCity.toLowerCase()) {
    fakeCity = (profileInfo?.moderatorInfo?.city || profileInfo?.moderatorInfo?.Wohnort || '').trim() || null;
    if (fakeCity && (fakeCity + '').toLowerCase() === 'sag ich später') fakeCity = null;
  }
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
  if (!locationContext && customerCity) {
    locationContext = { fakeCity: fakeCity || null, customerCity: customerCity };
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
  const fakeRelationshipStatus = (profileInfo?.moderatorInfo?.relationshipStatus || extractedUserInfo?.assistant?.Beziehungsstatus || extractedUserInfo?.assistant?.Family || '').trim();

  // Profil-Identität aus Username/Name/rawText (z.B. "SchwangereHummel04" = schwangere Person) – KI muss sich als DIESE Person ausgeben
  let profileIdentityHint = '';
  const modUsername = (profileInfo?.moderatorInfo?.username || '').toString().trim();
  const modName = (profileInfo?.moderatorInfo?.name || '').toString().trim();
  const modRawText = (profileInfo?.moderatorInfo?.rawText || '').toString().trim();
  const profileIdentitySource = (modUsername + ' ' + modName + ' ' + modRawText).toLowerCase();
  if (/schwanger|pregnant|schwangerschaft/i.test(profileIdentitySource)) {
    profileIdentityHint = 'Du bist in diesem Profil die schwangere Person (Profil-Name/Username oder Profiltext). Der Kunde spricht DICH als schwangere Person an. Reagiere als die schwangere Person – sag NIEMALS "Schwangere sind nicht mein Ding" oder dass Schwangere nicht dein Ding sind.';
  }

  const isReallyUnclear = isReallyUnclearMessage(customerMessage);
  if (isReallyUnclear) console.log('ℹ️ Unklare Kurznachricht erkannt – KI soll nachfragen statt interpretieren');

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
      imageClaimedButNotPresent: !!opts.imageClaimedButNotPresent,
      fakeProfession,
      isReallyUnclearMessage: isReallyUnclear,
      fakeLogbookHint,
      fakeName: moderatorName || extractedUserInfo?.assistant?.Name || '',
      customerName: customerName || extractedUserInfo?.user?.Name || profileInfo?.customerInfo?.name || '',
      fakeRelationshipStatus,
      profileIdentityHint
    });
    let finalMessage = '';
    let noQuestionError = false;
    const imageOnlyAnnouncedFlag = !!opts.imageOnlyAnnounced;
    const imageClaimedButNotPresentFlag = !!opts.imageClaimedButNotPresent;
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
      imageClaimedButNotPresent: imageClaimedButNotPresentFlag,
      fakeIsPlural,
      fakeRelationshipStatus,
      isNonSingle: fakeRelationshipStatus && !/^single$/i.test(fakeRelationshipStatus) && /relation|beziehung|verheiratet|verwitwet|witwe|witwer|geschieden|married|widow|vergebn|in\s+einer\s+beziehung/i.test(fakeRelationshipStatus)
    };
    const correctorPlanSnippet = (plan || '').trim();
    const correctorConversationSnippet = (conversationHistory || '').trim();
    const exampleSnippet = (examples && examples.length > 0 && (examples[0].moderatorResponse || examples[0].assistant))
      ? String(examples[0].moderatorResponse || examples[0].assistant).trim().slice(0, 250)
      : '';
    for (let questionAttempt = 1; questionAttempt <= 2; questionAttempt++) {
      finalMessage = await callGrok(messages);
      finalMessage = postProcessMessage(finalMessage);
      // ========== KORREKTOR: Mistral (USE_MISTRAL_CORRECTOR) | LoRA ==========
    const useMistralCorrector = (process.env.USE_MISTRAL_CORRECTOR === 'true' || process.env.USE_MISTRAL_CORRECTOR === '1') && !!(process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim());
    const useCorrectorEnv = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
    const correctorModelId = (process.env.CORRECTOR_LORA_MODEL_ID || '').trim();
    let corrected = null;
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
    finalMessage = removeOftTreffenPhrases(finalMessage);
    finalMessage = removeDoubledKennenlernen(finalMessage);
    finalMessage = removeMeetingTimePhrases(finalMessage);
    finalMessage = removeTreffenWhenOnlyImage(finalMessage, customerMessage);
    finalMessage = postProcessMessage(finalMessage);
    const customerLen = (customerMessage || '').trim().length;
    const hasMultipleQuestions = ((customerMessage || '').match(/\?/g) || []).length >= 2;
    const MAX_FINAL = (customerLen > 200 || hasMultipleQuestions) ? 320 : 250;
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
    const openAICorrected = await runOpenAIFullCorrector({
      customerMessage,
      context: correctorContext,
      grokText: finalMessage,
      planSnippet: correctorPlanSnippet,
      conversationSnippet: correctorConversationSnippet,
      learningContext: effectiveLearningContext || '',
      exampleSnippet
    });
    if (openAICorrected && openAICorrected.trim()) {
      const lenNew = openAICorrected.trim().length;
      if (lenNew >= Math.max(30, finalMessage.length * 0.4)) {
        finalMessage = postProcessMessage(openAICorrected.trim());
      }
    }
    if (!openAICorrected || !openAICorrected.trim()) {
      finalMessage = await applySpellingCorrectionIfAvailable(finalMessage);
    }
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
  // Immer Deutsch: "Friend request" (Blenny/Plattform) durch "Freundschaftsanfrage" ersetzen
  m = m.replace(/\bFriend\s*Request\b/gi, 'Freundschaftsanfrage');
  // Keine Wort-Listen für Rechtschreibung/Umlaute mehr – das übernimmt die KI (correctSpellingAndUmlautsWithOpenAI). Post-Processing nur noch strukturell (Bindestriche, ß, Meta-Zeilen).
  return m;
}

module.exports = {
  runGrokPipeline,
  buildRulesBlock,
  checkLocationQuestion,
  callGrok,
  detectSituationsWithLLM
};
