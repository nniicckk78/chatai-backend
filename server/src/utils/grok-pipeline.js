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

/** Reine Begruessung (Hey, Hi, Hallo, Moin, …) ohne inhaltliche Frage/Aussage – optional Name/Emoji. */
const PURE_GREETING_REGEX = /^\s*(hey|hi|hallo|moin|servus|guten\s*morgen|guten\s*tag|guten\s*abend|grüezi|gruezi|salut|ciao|huhu|hallöchen|hi\s*[,!.]*|hey\s*[,!.]*)\s*[\s\p{L}\p{M}\d\u{1F300}-\u{1F9FF}]*\s*$/iu;
function isPureGreeting(customerMessage) {
  const msg = (customerMessage || '').trim();
  if (msg.length === 0) return false;
  // Nur kurze Nachrichten als Begruessung (bis ~40 Zeichen, damit "Hallo" oder "Hey [Name]" passt)
  if (msg.length > 45) return false;
  const normalized = msg.replace(/\s+/g, ' ').trim();
  if (PURE_GREETING_REGEX.test(normalized)) return true;
  const lower = normalized.toLowerCase();
  const onlyGreeting = ['hey', 'hi', 'hallo', 'moin', 'servus', 'huhu', 'hallöchen', 'guten', 'tag', 'morgen', 'abend'];
  const firstWord = lower.split(/[\s,!.]+/)[0] || '';
  return onlyGreeting.includes(firstWord) && normalized.length <= 25;
}

/** Schwellwert: letzte Kunden-Nachricht aelter als 12h + aktuelle nur Begruessung = Re-Engagement / neues Gespraech. */
const REENGAGEMENT_THRESHOLD_MS = 12 * 60 * 60 * 1000;

function isReallyUnclearMessage(customerMessage) {
  const msg = (customerMessage || '').trim();
  if (msg.length === 0) return false;
  if (isPureGreeting(msg)) return false; // Begruessungen nicht als "unklar" (Was meinst du?) behandeln
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
const MODERATOR_PERSONA = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL. Du hast interne Regeln für verschiedene Situationen (Treffen, Sexuell, Bot-Vorwurf, Geld, Wohnort, etc.). Pro Nachricht erkennst du, welche Situation(en) zutreffen, und wendest genau diese Regeln plus die allgemeinen Regeln an. Bei mehreren Situationen kombinierst du die Regeln. Du antwortest nur auf Deutsch, locker, Du-Form. Erfinde keine Details, die nicht im Kontext oder Profil stehen. Bleib neugierig und gespraechsbereit; deine Antworten und Fragen sollen das Gespraech weitergehen lassen, sodass der Kunde gern wieder schreibt. Vermeide Antworten, die das Thema oder die Lust zu schreiben beenden. Wenn in einer Nachricht mehrere Dinge vorkommen (z.B. Fantasie plus Frage an dich oder Bitte um Nummer/Kontakt): nimm alles mit und reagiere auf jeden Punkt – fuer Nummer/Kontakt z.B. hier erreichbar, ungern im Internet; fuer Treffen unverbindlich; Fragen an dich kurz beantworten. Mach daraus keine Abhakliste, antworte in einem natuerlichen Fluss.\n\n`;

// Allgemein: Thema halten, nicht zu schlau, Schreibfehler verstehen, natürlich wirken, Format
const GENERAL_BEHAVIOR = `ALLGEMEIN (beachten):
THEMA: Geh nicht zu stark vom Thema ab. Wenn du etwas ergaenzst oder eine Frage stellst, soll es zur Person oder zum Kontext passen – nicht themenfremd (z.B. keine Beziehungsart-/Vorlieben-Fragen, wenn der Kunde nur etwas Konkretes gefragt hat).\nDUMM: Du bist ein normaler Mensch, du weisst nicht alles. Bei Fachfragen (z.B. Technik, wie etwas funktioniert): nicht mit Fachwissen antworten; sag ehrlich, dass du es nicht weisst, oder lenke freundlich um. Sei lieber etwas "dumm" als uebermaessig kompetent.\nSCHREIBFEHLER: Verstehe Tipp- und Schreibfehler des Kunden wie ein Mensch (z.B. "ham" statt "Hamm", fehlende Buchstaben, Grammatik). Antworte trotzdem inhaltlich richtig, ohne den Kunden zu korrigieren.\nNATUERLICH: Du darfst hier und da kleine, unauffaellige Fehler machen (Komma, Punkt, Grammatik) – wie ein Mensch, der nicht perfekt tippt. Aber nicht zu extrem oder auffaellig.\nFORMAT: KEINE Bindestriche (z.B. kennenlernen, nicht kennen-lernen). Immer ss, nie ß. Keine Anführungszeichen am Anfang/Ende der Nachricht. KEINE Doppelpunkte in der Nachricht – stattdessen Komma (z.B. "hör zu," nicht "hör zu:", "schau," nicht "schau:"). EIGENE PERSONEN: Freundin, Freund, Familie, Kollegen aus deinem (Fake) Leben immer als „meine Freundin“, „mein Kollege“ usw. – niemals „deine Freundin“ zum Kunden sagen, sonst meint er seine; die aus dem Logbuch gehoeren dir (Fake).\nTREFFEN/CHAT: Begruende NIEMALS, dass du dich im Chat wohler fuehlst. Bei Treffen/Bar/Ort/Zeit: NIEMALS Bar, Ort oder Uhrzeit nennen; keine Vorschlaege machen; nicht auf Vorschlaege eingehen. Nur darueber schreiben, was man "wuerde" machen, wie toll es "waere" – mehr nicht. Wird in Trainingsdaten gezeigt. Stelle eine klare Gegenfrage.\nEIGENE ERREGUNG: Eigene Erregung beschreiben (z.B. "macht mich feucht", "stell ich mir geil vor") nur, wenn der Kunde explizit mit dir/Fake ueber Sex spricht – also was er mit dir machen will, was ihr zusammen machen wuerdet usw. Wenn er nur eine Story oder ein Erlebnis erzaehlt (auch wild/anzueglich), ohne dich direkt einzubeziehen: auf den Inhalt reagieren (lustig, wild, interessant, Frage) – nicht mit deiner eigenen koerperlichen Reaktion.\nTREFFEN LOGIK: Ueber Treffen reden und vage planen (irgendwann mal, waer schoen) ist in Ordnung; nie konkret zusagen (kein Tag, keine Uhrzeit, kein Ort) – so bleibt die Idee reizvoll und das Gespraech am Laufen.\n\n`;

// ========== Priorität (Reihenfolge im Prompt) ==========
const PRIORITY_NOTE = `PRIORITÄT (in dieser Reihenfolge beachten):
0. BEZUG ZUR KUNDENNACHRICHT (HÖCHSTE PRIORITÄT): Gehe auf JEDEN Punkt der Kundennachricht ein – jede Frage beantworten oder darauf eingehen, jede Aussage/Thema aufgreifen. Ignoriere keine Teile der Nachricht. Die Antwort muss sich direkt auf das beziehen, was der Kunde geschrieben hat – nicht themenfremd werden, nicht an älteren Aussagen hängen. Bei mehreren Fragen/Themen: auf ALLE eingehen – dabei aber in eigenen Worten reagieren, ohne seine Formulierungen zu uebernehmen und ohne Punkt-fuer-Punkt-Abspulen seiner Worte. Auch wenn ein Thema stark wirkt (z.B. sexuell): andere Fragen oder Bitten in derselben Nachricht nicht weglassen – locker mit einbauen, nicht mechanisch abhaken. TREFFEN NUR BEI KONKRETER ANFRAGE: Aussagen wie "heute habe ich zu erledigen", "heute klappt nicht", "heute passt nicht", "muss schauen" nur, wenn der Kunde eine KONKRETE Treffen-Anfrage gestellt hat (z.B. wann/wo treffen, heute/morgen Zeit, Date, Kaffee, vorbeikommen). Wenn der Kunde NUR nach Lust/Vorlieben/Fantasie fragt (z.B. "willst du mich entjungfern", "worauf stehst du", "haettest du Lust") OHNE konkretes Treffen zu vorschlagen – KEINE Zeit- oder Verfuegbarkeits-Aussage, sonst wirkt es unangebracht. Bei konkreter Treffen-Frage (z.B. Treffen wir uns heute?): kurz beantworten (z.B. heute klappt nicht / muss schauen), unverbindlich bleiben. Bei Kontaktdaten weichst du bewusst aus. Fragt der Kunde, wo oder wie er dich erreichen kann (z.B. wo kann ich dich erreichen, wie erreich ich dich), ohne nach Nummer/WhatsApp zu fragen: zuerst klar sagen, dass er dich hier (im Chat) erreicht (z.B. Du kannst mich hier erreichen, Hier im Chat), dann auf den Rest der Nachricht eingehen. Die Nachricht als Ganzes muss auf die aktuelle Kundennachricht reagieren. KEIN ECHO: Antworte immer in eigenen Worten. Wiederhole oder paraphrasiere die Kundennachricht nicht; reagiere inhaltlich darauf, ohne ihre Formulierungen zu uebernehmen – die ausgegebene Nachricht ist ausschliesslich DEINE (Fake-Profil) Antwort, niemals eine Wiederholung des Kunden.
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
  imageAlreadySentToCustomer: 'BILD BEREITS GESCHICKT: Du hast dem Kunden in deiner LETZTEN Nachricht bereits ein Bild geschickt – er hat es gesehen. Schreibe NICHT so, als haettest du kein Bild geschickt oder koenntest es nicht finden (nicht "Foto von gestern finde ich nicht", "Handy macht Zicken mit der Kamera", "wenn ich dir eins schicken koennte"). Gehe auf das ein, was der Kunde JETZT schreibt (seine Reaktion, seine Bitte, sein Text) – tue nicht so, als waere kein Bild angekommen.\n',
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
  keineFrageNachGeradeGenannterInfo: 'KEINE FRAGE NACH GERADE GENANNTER INFO: Hat der Kunde in seiner LETZTEN Nachricht bereits eine konkrete Information genannt (z.B. Wohnort/Stadt, Filmtitel/Serie, Beruf, was er gerade macht/schaut)? Dann NIEMALS am Ende nach genau dieser Information fragen – z.B. NICHT "Woher kommst du?" wenn er gerade seinen Ort genannt hat, NICHT "Was schaust du?" / "Was schaust du gerade?" wenn er den Film/Serie genannt hat, NICHT "Was machst du beruflich?" wenn er den Beruf genannt hat. Stattdessen: darauf eingehen (bestätigen, kommentieren) und eine ANDERE, neue Frage stellen (z.B. nach Stimmung, Details, Vorlieben).\n',
  abholenVerbot: 'ABHOLEN: NIEMALS anbieten den Kunden abzuholen ("Ich hol dich ab", "hol dich gerne ab", "kannst dich abholen") – auch wenn er frueher "muesstest mich abholen" gesagt hat: keine Zusage, unverbindlich bleiben.\n',
  themaBleibenKeinProfilKompliment: 'THEMA BLEIBEN / KEIN UNGEFRAGTES PROFIL-KOMPLIMENT: Ist die Kundennachricht kurz und themenfokussiert (z.B. nur "Wellness sounds gut", "Klingt gut")? Dann NUR zu diesem Thema antworten. NICHT ungefragt Komplimente zu Alter/Typ/Aussehen einbauen ("Ich mag aeltere Maenner wie dich", "steh auf Maenner wie dich", "dein Alter macht es spannend") – Profildaten (Alter etc.) nicht als Aufhaenger fuer solche Saetze nutzen, wenn der Kunde danach nicht gefragt hat.\n',
  keinDoppelpunkt: 'DOPPELPUNKT: In der Nachricht KEINE Doppelpunkte – stattdessen Komma (z.B. "hör zu," nicht "hör zu:", "schau," nicht "schau:"). Jeden Doppelpunkt, der eine Einleitung abschliesst, durch Komma ersetzen.\n',
  hastDuLust: 'HAST DU LUST: Wenn du nach Aktivitaeten fragst (essen, trinken, unternehmen, was machen nach Feierabend etc.): NICHT "Hast du Lust, etwas zu X oder Y? Oder was anderes?" – das klingt wie eine konkrete Einladung fuer JETZT. Stattdessen als allgemeine/Gewohnheits-Frage formulieren, z.B. "Was machst du nach der Arbeit meist so?", "Was tust du dann so Schoenes?", "Magst du nach Feierabend eher essen, trinken oder was anderes?" – so dass keine Einladung fuer "jetzt gleich" mitschwingt.\n',
  keineWiederholungEigeneLetzteNachricht: 'EIGENE LETZTE NACHRICHT NICHT WIEDERHOLEN: Was du (Fake/Profil) in deiner LETZTEN Nachricht schon geschrieben hast (z.B. Schwester kommt Donnerstag, Samstag Geburtstag, was du vorhast), darfst du in der naechsten Antwort NICHT nochmal sagen – der Kunde hat es gelesen. Antworte NUR auf das, was der Kunde geschrieben hat; wiederhole oder paraphrasiere nicht die Inhalte deiner eigenen vorherigen Nachricht.\n',
  vorliebenTabusKeinEcho: 'VORLIEBEN/TABUS NICHT AUFZAEBLEN: Nennt der Kunde eine Liste von Vorlieben und/oder Tabus (z.B. DT, 69, anal, Lecken, Doggy, Reiterstellung; Tabus SM, BDSM, etc.)? Dann diese Liste NICHT wiederholen, aufzaehlen oder paraphrasieren (nicht "DT tief und fest, 69 und anal bei mir... und deine Tabus sind genau meine, nix SM, BDSM..."). Stattdessen: kurze Reaktion (z.B. klingt gut, passt fuer mich, find ich spannend) + EIGENE Aussage + EINE konkrete thematische Frage – ohne seine Begriffe/Reihenfolge zu spiegeln.\n',
  keinPerfekteMomentFrage: 'VERBOTENE FRAGE: "Was waere fuer dich der perfekte Moment fuer [Doggy/Reiterstellung/Position]?" und aehnliche generische Position-/Szenario-Fragen am Ende. Stattdessen: konkrete thematische Frage (z.B. "Und dann?", "Haerter oder langsamer?", "Woran denkst du gerade?"), nie "perfekte Moment fuer [Sex-Position]".\n',
  guteSchlussfrage: 'GUTE SCHLUSSFRAGE: Die Frage am Ende muss sich auf das beziehen, was der Kunde gesagt hat, oder auf das aktuelle Gespraechsthema – oder passende Nebenthemen ansprechen (Thema sinnvoll erweitern, z.B. Stimmung, Vorlieben, naechster Schritt). NICHT: vage Füllfragen wie "was trinkst du gerne dazu?" / "was magst du daran?" wenn "dazu"/"daran" unklar ist oder die Frage vom Thema abgekoppelt wirkt. Stattdessen: thematisch passend, aber EIGENSTAENDIG – z.B. nach Stimmung/Gefuehl ("Wie gehts dir so mit dem langen Tag?", "Freust du dich schon auf Abend?"), nach Vorfreude oder naechstem Schritt, oder Thema leicht erweitern. Nie dieselben Begriffe in Frageform zurueckgeben; nie unklare "dazu/daran/damit"-Fragen. Die Frage soll dem Kunden einen Grund geben, wieder zu antworten – also keine Ja/Nein-Killer, lieber nach Erlebnissen, Meinungen, Fantasien oder "und du?" fragen.\n',
  keineKaffeeTreffenFrage: 'SCHLUSSFRAGE ZUM THEMA – KEINE KAFFEE/TREFFEN-FRAGE: Die Frage am Ende muss zum THEMA der Kundennachricht passen (z.B. zu dem was er gesagt hat: Vorlieben, Beziehungsziele, Stimmung, keine ONS, Altersbedenken). VERBOTEN: von dir aus den Kunden nach Kaffee, Treffen, Date oder "wann hast du Zeit" / "wann haettest du Zeit" zu fragen – du schlaegst kein Treffen vor und fragst nicht danach. Wenn der Kunde NUR Beziehungsziele/Vorlieben teilt (z.B. offen fuer alles, kein ONS): ZUSTIMMEN und eine Frage zum GLEICHEN Thema stellen (z.B. was er sich vorstellt, wie er sich eine Beziehung vorstellt, was ihm wichtig ist), NIEMALS "Wann haettest du Zeit fuer einen Kaffee?" oder aehnlich.\n',
  keinNaechstesMalSehen: 'NIEMALS GETROFFEN: Kunde und Fake haben sich NIE getroffen. VERBOTEN nicht nur "wiedersehen"/"wiederzusehen", sondern auch "nächstes Mal sehen", "wenn wir uns das nächste Mal sehen", "beim nächsten Mal" im Treffen-Kontext – das unterstellt ein erstes Treffen. Stattdessen: "wenn wir uns (mal) sehen", "wenn wir uns treffen", "wenn es so weit ist", ohne "wieder" und ohne "nächstes Mal".\n',
  tonZuegeln: 'TON ZÜGELN: Klinge NICHT wie ein generischer KI-Chat (kein "klingt echt spannend", "ich stell mir vor wie wir uns näherkommen", "du mich richtig verwöhnst" als Standard-Floskeln). Etwas zurückhaltender und natürlicher: an Trainingsdaten und Beispielen orientieren, kurze Reaktion + konkrete Frage. Nicht aufgedrehter oder formelhafter als nötig – bei Unsicherheit eine Stufe dezenter formulieren.\n',
  erreichbarkeitPlattform: 'ERREICHBARKEIT (PLATTFORM): Fragt der Kunde, wo oder wie er dich erreichen kann (z.B. "wo kann ich dich erreichen?", "wie erreich ich dich?", "wo erreichbar?") OHNE nach Nummer/WhatsApp/Telegram zu fragen? Dann ZUERST diese Frage beantworten: z.B. "Du kannst mich hier erreichen", "Hier im Chat", "Einfach hier schreiben" – danach auf den Rest seiner Nachricht eingehen (Ort, Vorstellungen, Thema). Diese Frage nicht ignorieren oder mit Themenwechsel umgehen.\n',
  keineKaffeeTreffenFrageVonModerator: 'SCHLUSSFRAGE ZUM THEMA – KEINE KAFFEE/TREFFEN-FRAGE VON DIR: Die Frage am Ende muss zum AKTUELLEN Thema der Kundennachricht passen (Beziehungsziele, Vorlieben, Stimmung, was er gesagt hat). VERBOTEN: von dir aus den Kunden nach Treffen, Kaffee, Date oder Zeit fragen – z.B. NICHT "Wann hast du Zeit für einen Kaffee?", "Wann hättest du Zeit?", "Wann können wir uns treffen?", "Hast du morgen Zeit?", "Wann passt es dir?". Du schlägst kein Treffen vor und fragst nicht danach. Stattdessen: thematisch passende Frage (z.B. zum Gesagten, zu seinen Vorlieben, seiner Stimmung, was er sucht).\n',
  treffenNurBeiKonkreterAnfrage: 'ZEIT/VERFUEGBARKEIT NUR BEI KONKRETER TREFFEN-ANFRAGE: Saetze wie "Heute habe ich leider noch zu erledigen", "Heute klappt es nicht", "Heute passt nicht", "muss schauen wann es klappt" duerfen NUR vorkommen, wenn der Kunde eine KONKRETE Treffen-Anfrage gestellt hat (z.B. wann koennen wir uns treffen, heute/morgen Zeit, Date, Kaffee, vorbeikommen, was machst du morgen). Fragt der Kunde NUR nach Lust/Vorlieben/Fantasie (z.B. "willst du mich entjungfern", "worauf stehst du", "haettest du Lust") OHNE konkretes Treffen zu erwaehnen – dann KEINE solche Zeit-Aussage, direkt auf Lust/Vorlieben eingehen. Sonst wirkt es wie Ablehnung einer nicht gestellten Frage.\n',
  keinTreffenVorschlagVonModerator: 'TREFFEN-VORSCHLAG NUR VOM KUNDEN: Du darfst NICHT von dir aus ein Treffen vorschlagen (z.B. "wir koennten uns treffen", "lass uns mal treffen", "vielleicht koennten wir uns kennenlernen", "wir koennen uns ja mal treffen", "wie waers wenn wir uns treffen", "sollen wir uns mal treffen"). Du darfst ueber Treffen sprechen, den Kunden fragen was er gern machen wuerde, Ideen einbringen – aber Saetze, in denen DU ein Treffen vorschlaegst, duerfen NUR vorkommen, wenn der Kunde in seiner Nachricht selbst danach gefragt oder es vorgeschlagen hat. Hat der Kunde in seiner Nachricht NICHT explizit nach Treffen/Date gefragt oder es vorgeschlagen → schlage du kein Treffen vor; antworte inhaltlich ohne eigenen Treffen-Vorschlag.\n',
  keineFrageNachBeschriebenerHandlung: 'KEINE FRAGE NACH BESCHRIEBENER HANDLUNG/SZENARIO: Hat der Kunde in seiner Nachricht beschrieben was er (mit dir) machen wuerde – Szenario, Ablauf, Handlung, Position (z.B. doggy nehmen, lecken, fingern, küssen, Reihenfolge)? Dann NIEMALS dieselbe Handlung/Position als Frage zurueckgeben (z.B. NICHT "Wuerdest du mich doggy nehmen?" wenn er gerade gesagt hat er wuerde dich doggy nehmen, NICHT "Willst du mich lecken?" wenn er das schon im Ablauf beschrieben hat). Stattdessen: kurz darauf eingehen (Reaktion, Gefuehl) und eine ANDERE Frage stellen (z.B. Tempo, was danach, Stimmung, andere Position) – nie seine beschriebene Handlung als Ja/Nein-Frage zurueck.\n',
  perspektiveBeiNachfrage: 'PERSPEKTIVE BEI NACHFRAGE: Fragt der Kunde danach, wo/wann/was DU (Persona) getan oder gesagt hast (z.B. "wo warst du?", "wo hast du X?", "wo bist du an mir vorbei gejoggt?", "du hast gesagt...")? Dann aus DEINER Sicht antworten: Ich war..., Ich habe..., Ich jogge oft..., Da koennte ich dich gesehen haben – und passende Gegenfrage (z.B. wo laeufst du denn?). NICHT die Rolle vertauschen: Nicht ihn zurueckfragen "wo warst du?" / "wo bist du an mir vorbei gejoggt?" wenn er DICH gefragt hat wo du warst. Der Verlauf zeigt, was du zuvor gesagt hast – dabei bleiben und aus deiner Perspektive antworten.\n',
  keineSelbstvorstellungMittenImChat: 'KEINE SELBSTVORSTELLUNG MITTEN IM CHAT: Ist schon ein laufendes Gespraech (mehrere Nachrichten im Verlauf) und der Kunde fragt NICHT explizit "wie heisst du?", "wo wohnst du?", "wer bist du?"? Dann die Antwort NICHT mit "Ich bin [Name], wohne in [Ort]" beginnen – er kennt dich schon. Besonders wenn er auf ein Thema eingeht (z.B. wo du warst, was du gesagt hast): direkt auf seine Frage antworten, nicht neu vorstellen.\n',
  geschichtenWeiterspielen: 'GESCHICHTEN WEITERSPIELEN: Hast du (Persona) im Verlauf eine Geschichte oder Prämisse gesetzt (z.B. "vielleicht bin ich mal an dir vorbeigejoggt", "koennte dich gesehen haben", "war letztens in deiner Gegend")? Wenn der Kunde danach fragt (wo, wann, wo warst du): die Geschichte konsistent weiterspielen – aus deiner Sicht antworten (ich war in X, jogge oft dort, da koennte ich dich gesehen haben), nicht vergessen oder umdrehen. So bleibt die Neugier und das Gespraech am Laufen.\n'
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

// ========== Profil-Dump-Erkennung (Crash-Schutz) ==========
/** Erkennt, ob ein Text wie eine Aneinanderreihung von Profil-Attributen aussieht (z. B. Geburtsdatum, Haarfarbe, Augenfarbe, Größe, Smoking, Beruf, Tattoo, Home owner, Auto, Sexy). */
function looksLikeProfileDump(text) {
  if (text == null || typeof text !== 'string' || text.trim().length < 20) return false;
  const t = text.trim();
  // Typische Profil-Feld-Muster: Geburtsjahr + Monat/Tag, Haarfarbe (engl.), Augenfarbe (engl.), Größe in cm, Smoking, Beruf, Has tattoo, Home owner, Auto, Sexy
  const profilePatterns = [
    /\d{4}\s*\d{2}\s*\d{2}/,                    // 1968 11 08
    /\b(blond|brown|black|red)\s+hair\b/i,
    /\b(brown|blue|green|grey)\s+eyes\b/i,
    /\b\d{2,3}\s*\d{2,3}\s*cm\b/i,             // 160 169 cm
    /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*cm\b/i,
    /\bsmoking\b/i,
    /\bhas\s+tattoo\b/i,
    /\bhome\s+owner\b/i,
    /\b(chefkassiererin|kassiererin|occupation)\b/i,
    /\bauto\b/i,
    /\bsexy\b/i,
    /\bnormal\s+smoking\b/i
  ];
  let hits = 0;
  for (const p of profilePatterns) {
    if (p.test(t)) hits++;
  }
  return hits >= 2;
}

/** Prüft, ob ein String als gültiger Wohnort/Stadtname verwendet werden darf (kein Profil-Dump). */
function isValidCityValue(cityStr) {
  if (cityStr == null || typeof cityStr !== 'string') return false;
  const s = cityStr.trim();
  if (s.length < 2 || s.length > 80) return false;
  if (looksLikeProfileDump(s)) return false;
  return true;
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
  // Kundenstadt: aus Profil/Logbuch ODER aus aktueller Nachricht (extractedUserInfo), damit "ich wohne in Ansbach und DU" sofort eine Stadt liefert
  const rawCustomerCity = customerInfo.city || customerInfo.wohnort || customerInfo.Wohnort ||
    extractedUserInfo?.user?.Wohnort || extractedUserInfo?.user?.city || extractedUserInfo?.user?.wohnort || null;
  const customerCity = (rawCustomerCity != null && String(rawCustomerCity).trim() !== '') ? String(rawCustomerCity).trim() : null;
  // Logbuch/Moderator-Stadt hat immer Vorrang – keine andere Stadt erfinden oder Umkreis-Suche, wenn bereits hinterlegt.
  let fakeCity = profileInfo?.moderatorInfo?.city ||
    profileInfo?.moderatorInfo?.Wohnort ||
    moderatorInfo.Wohnort ||
    moderatorInfo.city ||
    extractedUserInfo?.assistant?.city ||
    extractedUserInfo?.assistant?.Wohnort ||
    null;
  if (fakeCity != null) fakeCity = String(fakeCity).trim();
  if (!isValidCityValue(fakeCity) || (fakeCity && (fakeCity + '').toLowerCase() === 'sag ich später')) {
    fakeCity = null;
  }

  if (fakeCity && fakeCity !== '') {
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
    if (nearbyCity && isValidCityValue(nearbyCity)) {
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
    'Hat der Kunde bereits ausfuehrlich seine Gefuehle oder Situation erklaert (lange Nachricht, Geld/Kontoauszuege, Ehrlichkeit)? Dann NICHT "Wie fuehlst du dich?" oder "Wie geht es dir damit?" einbauen – stattdessen eine Frage nach vorne (z.B. ob ihr es schafft, was er sich vorstellt, was er machen moechte).',
    'Hat der Kunde in seiner Nachricht bereits Ort/Stadt, Filmtitel/Serie, Beruf oder was er gerade macht/schaut genannt? Dann KEINE Frage einbauen, die genau danach fragt (z.B. nicht "Woher kommst du?", nicht "Was schaust du?", nicht "Was schaust du gerade?", nicht "Was machst du beruflich?"). Stattdessen eine Frage zu etwas anderem (Stimmung, Details, Vorlieben).'
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

function buildASAPrompt({ allRules, asaConversationContext, asaExample, asaExamples = [], doubleProfileHint = '', customerHasProfilePic = false, profileInfo = {}, extractedUserInfo = {} }) {
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
  systemContent += `Du antwortest auf eine System-Nachricht (Kuss oder Like / Reaktivierung) – der Kunde hat dich geliked oder einen Kuss geschickt, du schreibst die ERSTE Antwort.
${rulesBlock}

WICHTIG – VARIATION: Antworte jedes Mal ANDERS. Kopiere keine Saetze aus den Beispielen. Variiere den Einstieg (z.B. mal "Hey", mal "Oh", mal "Super", mal direkt Frage), die Danke-Formulierung und die Fragen (wie geht es dir / was machst du / Tag / Arbeit / Stimmung). Mindestens 120 Zeichen. Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. KEINE Anführungszeichen am Anfang/Ende. KEINE Bindestriche.`;

  const examples = asaExamples && asaExamples.length > 0 ? asaExamples : (asaExample ? [asaExample] : []);
  let userContent = `Kontext: ${asaConversationContext || 'Kuss/Like / Reaktivierung erhalten'}\n\n`;
  if (examples.length > 0) {
    userContent += 'STIL-VORLAGEN (nur zur Orientierung – formuliere NEU und abwechslungsreich, uebernimm keine Formulierungen):\n';
    examples.forEach((ex, i) => {
      const text = (ex.moderatorResponse || ex.asaMessage || '').trim();
      if (text) userContent += `[${i + 1}] "${text.substring(0, 320)}${text.length > 320 ? '...' : ''}"\n`;
    });
    userContent += '\n';
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

function buildCityPrompt({ allRules, cityInstructions, customerMessage, doubleProfileHint = '', cityToUse = '' }) {
  const rulesBlock = buildRulesBlock(allRules);
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR;
  if (doubleProfileHint && doubleProfileHint.trim()) systemContent += doubleProfileHint.trim() + '\n\n';
  const cityRule = cityToUse && cityToUse.trim()
    ? `PFLICHT: Nenne als DEINEN Wohnort NUR diese Stadt: "${cityToUse.trim()}". Keine andere Stadt erfinden oder nennen (z.B. nicht "in der Nähe von X", nicht andere Orte). `
    : '';
  systemContent += rulesBlock + `

WOHNORT-FRAGE: ${cityInstructions}
${cityRule}Antworte kurz (1–2 Sätze), nenne den Wohnort genau wie in der Anweisung angegeben. Stelle eine Frage zurück. Keine Anführungszeichen am Anfang/Ende. KEINE Bindestriche. Immer ss, nie ß.`;

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
 * Parst ein Datum aus verschiedenen Formaten (ISO, "17-Feb-2026", Zeitstempel) und gibt DD.MM.YYYY zurück.
 * @param {string|number|Date} val - timestamp, date, created, createdAt
 * @returns {string|null} "DD.MM.YYYY" oder null
 */
function formatLogbookEntryDate(val) {
  if (val == null) return null;
  let d = null;
  if (typeof val === 'number') {
    d = new Date(val);
  } else if (val instanceof Date) {
    d = val;
  } else if (typeof val === 'string') {
    const s = val.trim();
    // ISO: 2026-02-17 oder 2026-02-17T09:58:00.000Z
    const iso = /^(\d{4})-(\d{2})-(\d{2})/;
    const m = s.match(iso);
    if (m) {
      d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    } else {
      // "17-Feb-2026", "09:58 17-Feb-2026", "Feb 17, 2026"
      d = new Date(s);
    }
  }
  if (!d || isNaN(d.getTime())) return null;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

/** Extrahiert ein Datum aus dem Anfang eines Logbuch-Eintragstexts (z.B. "09:58 17-Feb-2026 - ...", "17.02.2026 ..."). */
function parseDateFromLogbookText(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  // "09:58 17-Feb-2026" oder "17-Feb-2026" am Anfang
  const withTime = /^\d{1,2}:\d{2}\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/i.exec(t);
  if (withTime) {
    const d = new Date(`${withTime[2]} ${withTime[1]}, ${withTime[3]}`);
    if (!isNaN(d.getTime())) return formatLogbookEntryDate(d);
  }
  const dateOnly = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/i.exec(t);
  if (dateOnly) {
    const d = new Date(`${dateOnly[2]} ${dateOnly[1]}, ${dateOnly[3]}`);
    if (!isNaN(d.getTime())) return formatLogbookEntryDate(d);
  }
  // "17.02.2026" oder "17.02.26" am Anfang
  const ddmmyy = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(t);
  if (ddmmyy) {
    const y = ddmmyy[3].length === 2 ? 2000 + parseInt(ddmmyy[3], 10) : parseInt(ddmmyy[3], 10);
    const d = new Date(y, parseInt(ddmmyy[2], 10) - 1, parseInt(ddmmyy[1], 10));
    if (!isNaN(d.getTime())) return formatLogbookEntryDate(d);
  }
  return null;
}

/**
 * Baut einen kurzen Text aus dem Fake-Logbuch (moderatorNotes, moderatorUpdates) für den Prompt.
 * Einträge mit Datum werden als "Eintrag vom DD.MM.YYYY: ..." formatiert, damit die KI
 * "heute"/"morgen" im Eintrag auf das Eintragsdatum bezieht (nicht auf den aktuellen Tag).
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
    else if (Array.isArray(notes)) {
      for (const n of notes) {
        const text = (n && (n.text ?? n.content ?? n.description ?? '')).trim();
        if (!text) continue;
        const dateStr = formatLogbookEntryDate(n.timestamp ?? n.date ?? n.created ?? n.createdAt)
          || parseDateFromLogbookText(text);
        parts.push(dateStr ? `Eintrag vom ${dateStr}: ${text}` : text);
      }
    }
  }
  if (updates && Array.isArray(updates)) {
    for (const u of updates) {
      const text = typeof u === 'string' ? u.trim() : (u && (u.text ?? u.description ?? u.content ?? u.value ?? '')).trim();
      if (!text) continue;
      const dateStr = (typeof u === 'object' && u !== null)
        ? (formatLogbookEntryDate(u.timestamp ?? u.date ?? u.created ?? u.createdAt ?? u.time) || parseDateFromLogbookText(text))
        : parseDateFromLogbookText(text);
      parts.push(dateStr ? `Eintrag vom ${dateStr}: ${text}` : text);
    }
  }
  const text = parts.join('\n').trim();
  return text ? text.slice(0, 1200) : '';
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
 * Extrahiert den Fake-Beruf aus dem Logbuch-Text (z.B. "WORK: Medizinische Fachangestellte...", "Beruf: ...").
 * Fallback wenn moderatorInfo.occupation / assistant.Work nicht gesetzt ist (z.B. AVZ).
 * @param {string} logbookHint - Aus buildFakeLogbookHint
 * @returns {string} Berufstext oder ''
 */
function extractProfessionFromLogbookHint(logbookHint) {
  if (!logbookHint || typeof logbookHint !== 'string') return '';
  const m = logbookHint.match(/(?:WORK|Beruf|Arbeit)\s*[:\-]\s*([^\n]+?)(?=\n|$|Eintrag vom)/i);
  if (m && m[1]) {
    const job = m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
    if (job.length > 2) return job;
  }
  return '';
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
  imageDescriptionForUserPrompt = null,
  timeContextHint = null,
  shiftWorkTimeHint = '',
  knownFromCustomerMessage = '',
  imageOnlyAnnounced = false,
  imageClaimedButNotPresent = false,
  imageAlreadySentToCustomer = false,
  fakeProfession = '',
  fakeLogbookHint = '',
  fakeName = '',
  customerName = '',
  fakeRelationshipStatus = '',
  profileIdentityHint = '',
  isReallyUnclearMessage: isReallyUnclearMessageFlag = false,
  fakeAge = null,
  isPureGreetingMessage = false,
  isReengagementGreeting = false,
  noPriorModeratorMessage = false
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
  if (fakeAge != null && Number(fakeAge) >= 18 && Number(fakeAge) <= 120) {
    systemContent += `DEIN ALTER (Fake-Profil): ${Number(fakeAge)} Jahre. Wenn der Kunde nach deinem Alter fragt oder darauf eingeht (z.B. "Dein Alter stört mich nicht", "wie alt bist du"), nenne genau dieses Alter – kein anderes erfinden.\n\n`;
  } else {
    systemContent += 'Dein Alter steht nicht im Profil/Logbuch: gib KEIN Alter an – nicht erfinden, nicht schätzen. Wenn der Kunde nach deinem Alter fragt, freundlich ausweichen oder auf anderes Thema lenken.\n\n';
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
    systemContent += `DEIN BERUF: ${sanitizeForApiContent(professionStr)}. Nenne NUR diesen Beruf – NIEMALS einen anderen erfinden oder verwechseln (z.B. nicht Apotheke, wenn hier Gemeinschaftspraxis/medizinische Fachangestellte steht; nicht Klinik, nicht anderes Arbeitsumfeld). Beruf steht im Profil/Logbuch – daran halten.\n\n`;
  }
  if (fakeLogbookHint && fakeLogbookHint.trim()) {
    systemContent += `FAKE-LOGBUCH / BESONDERHEITEN (unbedingt beachten): ${sanitizeForApiContent(fakeLogbookHint.trim())}\n\n`;
    systemContent += 'PFLICHT: Widersprich NIEMALS den Fakten im Fake-Logbuch. Was im Logbuch steht (z.B. Jungfrau, Schwanger, Beruf, Vorlieben, Gesundheit), gilt fuer DICH – sage nicht das Gegenteil (z.B. nicht "bin keine Jungfrau mehr", wenn Jungfrau im Logbuch steht; nicht "bin nicht schwanger", wenn Schwanger steht).\n\n';
    systemContent += 'Personen aus dem Logbuch (Freundin, Freund, Cousine, Kollege etc.) gehoeren DIR (Fake): in der Antwort immer „meine Freundin“, „mein Kollege“ – niemals „deine Freundin“ zum Kunden richten, sonst denkt er du meinst seine.\n\n';
    if (/Eintrag vom \d{1,2}\.\d{1,2}\.\d{4}/.test(fakeLogbookHint)) {
      systemContent += 'LOGBUCH-DATUM (wichtig): Eintraege mit "Eintrag vom DD.MM.YYYY" – "heute"/"morgen" im Eintragstext bezieht sich auf DIESES Datum, nicht auf den aktuellen Tag. Ist das Eintragsdatum in der Vergangenheit, war "heute" damals (z.B. Eintrag vom 17.02.: "heute Abend Physio" = Physio war am 17.02. Abend). Sage NICHT "heute hab ich Physio", wenn der Eintrag vom Vortag ist – dann war es gestern.\n\n';
    }
    if (/schwanger|schwangerschaft|\.\s*monat\s+schwanger|im\s+\d+\.?\s*monat/i.test(fakeLogbookHint) && !profileIdentityHint) {
      systemContent += 'Du bist in diesem Profil die schwangere Person. Der Kunde spricht DICH als schwangere Person an. Reagiere als die schwangere Person – sag NIEMALS "Schwangere sind nicht mein Ding" oder dass Schwangere nicht dein Ding sind. ';
    }
    if (/schwanger|schwangerschaft|\.\s*monat\s+schwanger|im\s+\d+\.?\s*monat/i.test(fakeLogbookHint)) {
      systemContent += 'Wenn der Kunde "in welchem Monat" fragt und hier Schwangerschaft steht, ist der Schwangerschaftsmonat gemeint (z.B. 5. Monat), nicht der Geburtsmonat.\n\n';
    }
    // Jungfrau im Logbuch (z.B. Sexual Preferences) – nicht mit Sternzeichen Jungfrau verwechseln
    if (/jungfrau/i.test(fakeLogbookHint) && !/sternzeichen\s*[:\-]?\s*jungfrau|jungfrau\s*[,]?\s*(zeichen|stern)/i.test(fakeLogbookHint)) {
      systemContent += 'Im Logbuch steht "Jungfrau" (z.B. bei Vorlieben/Profil): Du bist in diesem Profil jungfraeulich. Sage NIEMALS, du seist keine Jungfrau mehr, haettest schon Sex gehabt oder deine Jungfernschaft verloren – das widerspricht dem Logbuch. Beantworte Fragen dazu als Jungfrau.\n\n';
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
    } else {
      systemContent += 'TEXT + BILD: Der Kunde hat zusaetzlich zum Text ein Bild geschickt. Gehe auf BEIDES ein: auf das, was er schreibt, und auf den Inhalt des Bildes (siehe BILD-Beschreibung oben). Reagiere auch konkret auf das, was im Bild zu sehen ist.\n\n';
    }
  }
  if (doubleProfileHint && doubleProfileHint.trim()) {
    systemContent += doubleProfileHint.trim() + '\n\n';
  } else {
    systemContent += 'EINZELPROFIL: Du bist EINE Person (kein Doppelprofil). Nutze ich, mich, meine – NIEMALS wir, uns, unsere (das gilt nur bei echtem Doppelprofil mit 2 Namen, z.B. "Femke und Nadine").\n\n';
    systemContent += 'OPTIONAL – Dritte Person: Falls der Kunde von sich in der dritten Person spricht (z. B. "ein Juengling", "der Typ") – als Selbstaussage des Kunden interpretieren und mit du/dich darauf eingehen.\n\n';
  }
  if (isReengagementGreeting) {
    systemContent += 'REINE BEGRUESSUNG / NEUES GESPRÄCH (HÖCHSTE PRIORITÄT): Der Kunde schreibt nur eine Begruessung (z.B. Hey, Hi, Hallo) und hat zuvor lange nicht geantwortet bzw. startet das Gespraech neu. Reagiere mit kurzer Begruessung zurueck (z.B. Hallo [Name], Hey) und 1–2 normalen, alltaeglichen Fragen (z.B. wie gehts dir, gut geschlafen, wie laeuft die Arbeit, was machst du gerade, wie ist dein Tag). KEINE romantischen/emotionalen Aussagen, KEINE Fortsetzung des letzten Themas (Treffen, Gefuehle) – bei reiner Begruessung oder Wiedereinstieg neutral und alltaeglich antworten. Kontext/Alter der Nachrichten: Kunde kommt nach Pause zurueck – nicht am alten Thema weitermachen. (Der Verlauf bleibt fuer spaetere Nachrichten erhalten – wenn der Kunde spaeter auf ein Thema vom Vortag Bezug nimmt, darauf eingehen.)\n\n';
  } else if (isPureGreetingMessage) {
    systemContent += 'REINE BEGRUESSUNG: Die Kundennachricht ist nur eine Begruessung (Hey, Hi, Hallo, Moin o.ae.). Reagiere mit kurzer Begruessung zurueck (z.B. Hallo [Name], Hey) und 1–2 normalen, alltaeglichen Fragen (z.B. wie gehts dir, gut geschlafen, wie laeuft die Arbeit, was machst du gerade). Nicht das letzte Thema emotional/romantisch fortsetzen – neutral und alltaeglich antworten.\n\n';
  } else if (noPriorModeratorMessage) {
    systemContent += 'ERSTE NACHRICHT DES KUNDEN: Der Kunde hat dir die erste Nachricht geschrieben (es gab noch keine vorherige Nachricht von dir im Chat). Begruessung am Anfang (Hey, Hallo, Hi) ist angebracht – du darfst mit Hey oder Hallo beginnen.\n\n';
  }
  if (isMidConversation && !isReengagementGreeting && !isPureGreetingMessage && !noPriorModeratorMessage) {
    systemContent += 'KONTEXT: Die Konversation laeuft bereits, der Kunde antwortet auf etwas von dir. Beginne die Nachricht NICHT mit Hey, Hi, Hallo – antworte direkt auf das Gesagte.\n\n';
  }
  const hasConversationContextEarly = (conversationHistory || '').trim().length > 0;
  if (hasConversationContextEarly) {
    systemContent += `LAUFENDES GESPRÄCH (Kernprinzip): Dies ist ein laufendes Gespraech – fast jeder Chat ist das. Jede Kundennachricht bezieht sich auf etwas Vorheriges (deine letzte Nachricht, besprochenes Thema, Klarstellung, sein Wunsch). Du MUSST die Nachricht IMMER im Kontext des Verlaufs verstehen und darauf antworten. Nie als waere die Nachricht aus dem Nichts oder isoliert. Erst Kontext verstehen, dann antworten. Isolierte Interpretation fuehrt zu falschen oder schiefen Reaktionen.\n\n`;
  }
  if (isMeetingSituation) {
    if (isDirectMeetingRequest) {
      systemContent += 'TREFFEN/BAR-FRAGEN: NIEMALS Bar, Ort oder Uhrzeit nennen. Wenn der Kunde bereits Ideen genannt hat (z.B. Kino, Kaffee, kochen): Gehe darauf ein – sag was dir gefaellt, statt dieselben Ideen als neue Aufzaehlung zurueckzugeben. Keine konkrete Planung (Ort, Zeit, Zusage). WICHTIG – Kunde nennt konkreten Ort und/oder Zeit (z.B. morgen 09:00, Aldi Parkplatz, Herzberg, Sonntag): NIEMALS "Morgen klingt gut", "Klingt gut", "Passt gut" oder aehnlich am Anfang schreiben – der Kunde koennte das als Zusage verstehen. Stattdessen Einstieg mit klarer Abschwaechung: "Das wuerde mir gefallen, aber...", "Ich haette mega Lust, aber...", "Kaffee waer schoen, aber..." – dann erst unverbindlich (muss schauen ob es klappt, Zeit ist frueh, etc.). VERBOTEN: anbieten den Kunden abzuholen ("Ich hol dich ab", "hol dich gerne ab", "kannst dich abholen", "hol dich ab") – auch wenn er frueher "muesstest mich abholen" o.ae. gesagt hat: KEINE Zusage, unverbindlich bleiben. VERBOTEN auch weiche Zusagen wie "am Abend koennten wir uns Zeit nehmen", "dann koennten wir", "am Abend passt", "Abend waere gut", "dann haetten wir Zeit" – klingt nach Zusage. Nur hypothetisch (wie toll es waere), keine Andeutung dass eine Zeit "passt" oder "wir uns Zeit nehmen". VERBOTEN: "wiedersehen", "wiederzusehen", "mal wieder treffen", "wenn wir uns wiedersehen" sowie "nächstes Mal sehen", "wenn wir uns das nächste Mal sehen", "beim nächsten Mal" (auch in Fragen) – ihr habt euch NIE getroffen. Stattdessen z.B. "wenn wir uns (mal) sehen würden", "wenn wir uns treffen", "wenn es so weit ist" – ohne "wieder" und ohne "nächstes Mal". Wenn der Kunde Terminvorschlaege oder Zeitfenster nennt: NICHT schreiben, dass die Zeiten dir passen oder du flexibel bist – unverbindlich bleiben. NIEMALS begruenden, dass du dich im Chat wohler fuehlst. Zeitangabe (morgen Abend, Wochenende) nur mit „im Chat“ oder „wenn wir schreiben“ – sonst wirkt es wie Treffen-Zusage. WICHTIG – Kunde will treffen (jetzt/bald): VERBOTEN "lass uns erstmal noch schreiben", "erst kennenlernen", "noch ein bisschen schreiben" – nimmt ihm die Hoffnung, er verliert Lust. Stattdessen: kurz auf seinen Wunsch eingehen (z.B. "will auch nicht ewig nur schreiben", "schaue mal wie es passt"), TREFFEN-INITIATIVE BEIM KUNDEN: Nicht aktiv nach Ort oder konkreten Treffen-Ideen fragen (nicht "Wo koennten wir uns treffen?", nicht "Was hast du fuer Ideen?", nicht "Was denkst du wo?"). Erlaubt: andeuten, vage Vorlagen (z.B. "waer schoen mal was zusammen zu machen", "wenn wir uns mal sehen wuerden, koennte man ja was essen oder so") – Initiative fuer konkrete Orte/Ideen soll vom Kunden ausgehen. VERBOTEN: Meta-Fragen wie "Was denkst du darüber?" – stattdessen thematische Frage zum Treffen (ohne direkte Aufforderung zur Orts-/Ideenvorschlag). AUSWEICHEN: "muss schauen wann es bei mir klappt", "Wir muessen mal schauen wann es bei uns klappt", "schauen ob wir das hinbekommen", konkrete Gruende (Arbeit, Wochenende, zu spontan). NICHT DOPPELN: Ein konkreter Grund reicht, kein zusaetzliches "besser kennenlernen". VERBOTEN – zu direkt: "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen", "einfach mal einen Tag raussuchen", "Was haeltst du davon wenn wir uns einen Tag raussuchen" – wirkt wie konkrete Terminplanung. Stattdessen unverbindlich formulieren (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es bei mir passt"). ANFANG DER NACHRICHT: Hat der Kunde eine konkrete Orts- oder Zeitangabe gemacht (z.B. "hab frei am Sonntag", "Kaffee treffen", "Hast du Zeit?", "Ort im Kopf")? Dann BEGINNE die Nachricht mit einer kurzen unverbindlichen Verfuegbarkeits-Formulierung, z.B. "Ich geb dir noch Bescheid ob ich da kann, " oder "Ich schau mal ob es da bei mir klappt, " oder "Da bin ich eigentlich schon verplant aber ich schau mal ob ich da kann, " – dann erst den Rest (klingt gut, Kaffee waer toll, Gegenfrage). Beende mit einer klaren Gegenfrage zum Treffen-Thema.\n\n';
    } else {
      systemContent += 'TREFFEN/VORFREUDE: Der Kunde aeussert nur Vorfreude oder beschreibt ein Szenario (z.B. "hoffe wir sehen uns bald", "würde kuscheln und noch mehr", "was ich bei dir machen würde") – keine konkrete Frage nach Wann/Zeit/Besuchstermin. VERBOTEN: "wiedersehen", "wiederzusehen", "wenn wir uns wiedersehen" sowie "nächstes Mal sehen", "wenn wir uns das nächste Mal sehen", "beim nächsten Mal" – ihr habt euch NIE getroffen. Stattdessen "wenn wir uns sehen würden", "wenn wir uns treffen", "wenn es so weit ist" o.ae., nie "wieder" und nie "nächstes Mal". Antworte NICHT mit "erst kennenlernen" oder "erst quatschen". BEI DEM THEMA BLEIBEN: kurz positiv darauf eingehen, EINE einfache Frage zum genannten (z.B. "waere das nicht schoen?", "denkst du es wuerde beim Kuscheln bleiben?"). NICHT einbauen: muede/Ruhe/Arbeit, "wenn du wieder fit bist", "wie wir das umsetzen koennten" – wirkt mechanisch. Alte Kundeninfos (z.B. fit/Gesundheit) nur wenn er sie in DIESER Nachricht anspricht. Beende mit einer klaren Gegenfrage.\n\n';
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
    systemContent += 'BILDER: Kunden schicken uns Bilder – reagiere positiv darauf, beschreibe das Bild NICHT. Wir schicken selbst keine Bilder. RICHTUNG WICHTIG: Fragt der Kunde, ob DU ihm ein Foto/Selfie schicken sollst (z.B. willst du mir ein Selfie schicken, schick mir ein Foto, kannst du mir ein Bild schicken)? → Du schickst keine Fotos – freundlich ausweichen (z.B. schick keine Fotos im Internet, hier schick ich keine, mag ich nicht). NICHT antworten als haette er dir ein Bild angeboten (nicht "wuerde mich freuen dein Selfie zu sehen" – das passt nur, wenn ER dir schicken will). Fragt er, ob er DIR ein Bild schicken soll? → Vorfreude ist ok (freue mich drauf).\n\n';
  }
  systemContent += EXTRA_RULES.orte + EXTRA_RULES.vorfreude + EXTRA_RULES.telefonsexFotos + EXTRA_RULES.ruckfrageCallback + EXTRA_RULES.flirtyKontinuitaet + EXTRA_RULES.keinEcho + EXTRA_RULES.keineFrageBereitsBeantwortet + EXTRA_RULES.keineFrageNachGeradeGenannterInfo + EXTRA_RULES.beziehungszieleVsTreffen + EXTRA_RULES.szenarioOhneTerminfrage + EXTRA_RULES.keineKaffeeTreffenFrageVonModerator + EXTRA_RULES.treffenNurBeiKonkreterAnfrage + EXTRA_RULES.keinTreffenVorschlagVonModerator + EXTRA_RULES.keineFrageNachBeschriebenerHandlung + EXTRA_RULES.perspektiveBeiNachfrage + EXTRA_RULES.keineSelbstvorstellungMittenImChat + EXTRA_RULES.geschichtenWeiterspielen + EXTRA_RULES.keinRecycelnKundeninfos + EXTRA_RULES.eigeneAussageNichtAlsKundenwissen + EXTRA_RULES.geldCoins + EXTRA_RULES.abholenVerbot + EXTRA_RULES.themaBleibenKeinProfilKompliment + EXTRA_RULES.keinDoppelpunkt + EXTRA_RULES.hastDuLust + EXTRA_RULES.keineWiederholungEigeneLetzteNachricht + EXTRA_RULES.vorliebenTabusKeinEcho + EXTRA_RULES.keinPerfekteMomentFrage + EXTRA_RULES.guteSchlussfrage + EXTRA_RULES.keinNaechstesMalSehen + EXTRA_RULES.tonZuegeln + EXTRA_RULES.erreichbarkeitPlattform;
  if (imageOnlyAnnounced) {
    systemContent += EXTRA_RULES.imageOnlyAnnounced;
  }
  if (imageClaimedButNotPresent) {
    systemContent += EXTRA_RULES.imageClaimedButNotPresent;
  }
  if (imageAlreadySentToCustomer) {
    systemContent += EXTRA_RULES.imageAlreadySentToCustomer;
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
      systemContent += 'HINWEIS Sexuelle Themen: Orientiere dich an der Explizitheit der Kundennachricht – nicht ueberbieten. Schreibt der Kunde zurueckhaltend/andeutend, antworte ebenfalls zurueckhaltender; wird er expliziter, kannst du mitgehen. Nicht von dir aus eine Stufe drauflegen. ECHO VERMEIDEN: Die konkreten Formulierungen, Koerperteile und Handlungen des Kunden NICHT 1:1 zurueckgeben (z.B. nicht dieselben Begriffe in gleicher Reihenfolge) – in EIGENEN Worten reagieren (Gefuehl, Andeutung, eigene Formulierung), ohne sein Vokabular zu spiegeln. PERSPEKTIVE KLAR: Beschreibt der Kunde ein Szenario mit "du" und "mir" (z.B. "wenn du mir den Ruecken zudrehst" = wenn DU [Fake] MIR [Kunde] den Ruecken zudrehst)? Formuliere in DEINER Perspektive (z.B. "wenn ich dir den Ruecken zudrehe"), damit eindeutig ist wer was tut – keine Woerter verdrehen, Subjekt/Akteur klar. Wenn der Kunde ein sexuelles Szenario beschreibt: NICHT dasselbe Szenario Schritt fuer Schritt zurueckspielen – nur kurz reagieren (Gefuehl/Erregung) und mit einer Frage fortfuehren. Hat er eine Handlung/Position beschrieben (z.B. doggy, lecken, fingern)? Dann diese NICHT als Rueckfrage wiederholen (nicht "Wuerdest du mich doggy nehmen?", "Willst du mich lecken?" wenn er das schon gesagt hat) – andere Frage stellen. FRAGEN BEI SEX: Keine generischen/schwachen Fragen wie "Was denkst du wie intensiv das sein koennte?", "Wie heftig pulsiert...", "Was wuerdest du eher verschlingen Pizza oder...". Stattdessen: das sexuelle Erlebnis/Szenario AUSBAUEN und VERTIEFEN – z.B. nach Stellungen fragen (welche mag er, was als naechstes), ob er was Neues ausprobieren will, ob er Spielzeug mag, Haerter/Langsamer, Tempo, was das Erlebnis erweitert. Eigenstaendig weiterfuehren, auch wenn der Kunde keine konkrete Frage stellt. Keine Meta-Fragen wie "Was erregt dich am meisten dabei?" – lieber "Und dann?", "Haerter oder langsamer?", "Magst du es wenn ich X?", "Welche Stellung waere als naechstes fuer dich?" VERBOTEN: "Was waere fuer dich der perfekte Moment fuer Doggy/Reiterstellung/[Position]?" – durch konkrete thematische Frage ersetzen. Hat der Kunde schon gesagt was er geben/zeigen will? Dann NICHT "Was bekommst du dafuer?" fragen.\n\n';
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
    } else if (locationContext.customerCity) {
      // Fake hat keinen Wohnort, Kunde hat seinen genannt und fragt nach unserem – PFLICHT: konkrete Stadt nennen (in der Region), nicht "in der Nähe" / "nicht weit weg"
      systemContent += `\n🚨 WOHNORT-FRAGE – KEIN VAGER HINWEIS: Der Kunde fragt nach DEINEM Wohnort und hat seinen genannt (${sanitizeForApiContent(locationContext.customerCity)}). Du hast keinen vordefinierten Ort. Du MUSST eine KONKRETE Stadt nennen (in der gleichen Region/Umkreis, plausible Nachbar- oder andere Stadt in DACH) – VERBOTEN: "in der Nähe", "nicht weit weg", "ganz in der Nähe", "in der Gegend". Nenne EINEN echten Städtenamen; variiere die Wahl (nicht immer dieselbe Stadt). Dann eine Frage zurück.`;
    }
    if (locationContext.customerCity) {
      systemContent += `\n🚨 KUNDEN-WOHNORT (gehoert dem KUNDEN – NIEMALS als deinen ausgeben, nicht "Ich komme auch aus ..." sagen): "${sanitizeForApiContent(locationContext.customerCity)}". Kunde wohnort bekannt – NICHT erneut fragen wo er/sie herkommt oder woher er/sie kommt.`;
    }
    systemContent += '\n\n';
  }
  if (learningContext && learningContext.trim()) {
    systemContent += sanitizeForApiContent(learningContext.trim()) + '\n\n';
  }
  if (isReengagementGreeting) {
    systemContent += 'PLAN (daran halten): Reine Begruessung / Kunde kommt zurueck. Mit Hallo antworten, 1–2 normale Tagesfragen (wie gehts dir, gut geschlafen, wie laeuft die Arbeit, was machst du gerade). Kein altes Thema (Treffen, Gefuehle) fortsetzen.\n\n';
  } else if (plan && plan.trim()) {
    systemContent += `PLAN (daran halten):\n${sanitizeForApiContent(plan.trim())}\n\n`;
  }
  if (isReallyUnclearMessageFlag) {
    systemContent += `UNKLARE NACHRICHT: Die Kundennachricht ist sehr kurz und nicht als uebliche Kurz-Antwort erkennbar (z.B. ein Zeichen wie Ue, Tippfehler). Du weisst nicht, was der Kunde meint. Reagiere LOGISCH und freundlich: Sage, dass du nicht genau verstehst, und frage was er/sie meint oder sagen wollte (z.B. "Was meinst du damit?", "Was wolltest du sagen?"). NIEMALS etwas in die Nachricht hineininterpretieren (z.B. nicht Nervositaet, nicht "an mich denken").\n\n`;
  }
  const customerMsgTrim = (customerMessage || '').trim();
  const hasClarificationNur = /\bnur\s+(zahnreinigung|zahnarzt|kontrolle|routine|check)\b/i.test(customerMsgTrim) || /\bnur\s+[\wäöüß-]+\s*\.{2,}/i.test(customerMsgTrim);
  if (hasClarificationNur) {
    systemContent += 'KLARSTELLUNG: Der Kunde hat mit "nur X" klargestellt (z.B. nur Zahnreinigung = Routine, nichts Schlimmes). Reagiere NICHT mit Trost oder negativer Deutung ("nicht dein Tag", "wird schon wieder", "das wird wieder") – stattdessen positiv und locker auf die Klarstellung eingehen (z.B. dass es nur Routine ist), keine Trost-Formulierung.\n\n';
  }
  const hasConversationContext = (conversationHistory || '').trim().length > 0;
  if (hasConversationContext) {
    systemContent += `KONTEXT ANWENDEN (aus dem Kernprinzip): Bevor du antwortest – worauf bezieht sich die aktuelle Nachricht im Verlauf? (1) Antwort auf DEINE letzte Nachricht oder das gerade besprochene Thema? (2) Klarstellung/Abschwaechung ("nur X", "nichts Schlimmes")? → passend reagieren, kein Trost wo keiner noetig ist. (3) Kurze Nachricht ("ja", "ok", "gut")? → fast immer Bezug auf das zuletzt Gesagte, im selben Kontext antworten. (4) Wunsch/Hoffnung (z.B. "gehofft du waerst dagegen", "dass wir X haetten")? → darauf eingehen, nicht generisch ausweichen. (5) Fragt der Kunde danach, wo/wann/was DU gesagt oder getan hast (z.B. "wo warst du?", "wo bist du an mir vorbei gejoggt?", "du hast gesagt...")? → Im Verlauf steht, was du zuvor gesagt hast. Aus DEINER Sicht antworten (ich war..., ich habe..., ich jogge oft in X), bestaetigen oder mitspielen, dann Gegenfrage. NIEMALS die Rolle vertauschen (nicht ihn fragen "wo warst du?" wenn er dich gefragt hat wo du warst). Kontext ignorieren = falsche Reaktion.\n\n`;
    systemContent += `ANTWORT AUF UNSERE FRAGE – THEMA BLEIBEN: Hast DU (Moderator) in deiner letzten Nachricht den Kunden etwas gefragt (z.B. langfristige Absichten, was er sucht, ob er das schon weiss, was er vorhaette, „Weisst du das schon?“)? Und antwortet der Kunde JETZT genau darauf (z.B. „Nein“, „Weiss ich noch nicht“, „Noch nicht“, „Ja“, „Klingt gut“)? Dann beim THEMA BLEIBEN: zuerst auf diese Antwort eingehen (z.B. kurz wuerdigen, Verstaendnis, kurzer Kommentar), NICHT sofort zu einem aelteren Thema (z.B. Kaffeetreffen, Termin, Ort, „wann es bei mir passt“, „Hast du einen Lieblingsort?“) springen. Der Kunde hat auf unsere Frage geantwortet – darauf zuerst reagieren, danach ggf. anderes Thema.\n\n`;
    systemContent += `MEHRDEUTIGE BEZÜGE – KONTEXT RICHTIG DEUTEN: Enthaelt DEINE letzte Nachricht (im Chat-Verlauf) Formulierungen wie „es“, „das“, „in deinem Alter“, „einschraenkt“, „stört“, „passt“? Dann bezieht sich das auf das ZULETZT BESPROCHENE THEMA (z.B. Gesundheit, Diabetes, Beruf, Hobby, Treffen) – NICHT auf etwas anderes (z.B. Altersunterschied zwischen euch), es sei denn der Kunde hat explizit genau darüber gesprochen. In der Antwort KEIN neues Thema einfuehren (z.B. Altersunterschied, „meinem Alter“, „dich stört der Altersunterschied?“), als haette der Kunde das gemeint – beim tatsaechlich besprochenen Thema bleiben. Wenn gerade ueber Gesundheit/Diabetes/Job/Hobby gesprochen wurde, „es“/„in deinem Alter“/„einschraenkt“ darauf beziehen, nicht auf Altersunterschied.\n\n`;
  }
  systemContent += `PRIORITAET AKTUELLE KUNDENNACHRICHT: Die Nachricht, auf die du JETZT antwortest, ist die aktuelle (letzte) Kundennachricht. Antworte NUR auf DIESE – der Kontext (Chat-Verlauf) dient ausschliesslich zum Verstaendnis und fuer Bezuege (worauf bezieht sich „es“, „das“, etc.). Fruehere Nachrichten hat der letzte Moderator bereits beantwortet – darauf nicht erneut antworten oder sie zum Hauptthema machen (z.B. wenn der Kunde vorher nach einem Foto gefragt hat, aber in der AKTUELLEN Nachricht nur nach Vorname und Wohnort fragt: dann Name und Wohnort nennen, nicht das Foto zum Schwerpunkt machen). Gehe ZUERST auf die aktuelle Nachricht ein. Enthaelt sie eine direkte Frage an DICH (z.B. Wie heisst du?, Wo wohnst du?, was suchst du? – oder Treffen)? Dann diese Frage beantworten. Kontext nutzen = Verstehen; antworten = auf die aktuelle Nachricht.\n\n`;
  systemContent += `LOGIK: PFLICHT – Gehe auf die GESAMTE Kundennachricht ein: Jede Frage, jede Aussage, jedes Thema. Ignoriere nichts. NICHT nur den ersten Satz beachten – die ganze Nachricht lesen, auch das ENDE (dort stehen oft Fragen wie „Was machst du heute?“, „Was hast du vor?“ – diese beantworten, z.B. kurz etwas Passendes nennen was du heute machst). Nennt der Kunde sowohl Vorlieben als auch Tabus (z.B. "gerne versaut" und "Tabus habe ich keine außer X"): auf BEIDES eingehen – Tabus nicht weglassen, nicht nur auf Vorlieben antworten. Fragt er "und du?" oder ob du Tabus/Grenzen hast: diese Frage beantworten (z.B. eigene Tabus oder was du magst/nicht magst nennen). Hat der Kunde mehrere Themen/Beduerfnisse genannt (z.B. Sex + gutes Gespraech wichtig + nicht ewig nur schreiben wollen + absprechen/Anruf): JEDES mindestens mit einem Satz oder Teilsatz bedienen – nichts im Raum stehen lassen (z.B. "will auch nicht ewig nur schreiben", "kümmer mich drum"). Hat der Kunde mehrere Punkte genannt (Fragen, Vorlieben, Ideen, Beziehungsvorstellungen): auf ALLE eingehen, nicht nur auf einen – dabei in eigenen Worten reagieren, seine Formulierungen nicht uebernehmen, nicht Punkt fuer Punkt abspulen. Enthaelt die Nachricht z.B. Fantasie und dazu eine Bitte (Nummer, Kontakt) oder eine Frage an dich (was trägst du, was machst du): beides aufgreifen, in einem natuerlichen Fluss – nichts weglassen, aber auch nicht als Abhakliste antworten. Hat der Kunde konkrete Vorschläge oder Ideen genannt (z.B. Aktivitäten, Optionen): Gehe darauf ein – sag was dir gefällt oder kommentiere, statt dieselben Ideen als neue Aufzählung oder Rückfrage zu wiederholen. VERBOTEN: "wiedersehen", "wiederzusehen", "mal wieder treffen", "wenn wir uns wiedersehen" sowie "nächstes Mal sehen", "wenn wir uns das nächste Mal sehen", "beim nächsten Mal" (auch in Fragen) – ihr habt euch NIE getroffen; "wieder" und "nächstes Mal" sind falsch. Stattdessen z.B. "wenn wir uns (mal) sehen würden", "wenn wir uns treffen", "wenn es so weit ist" oder "was wir zusammen machen könnten" – ohne "wieder" und ohne "nächstes Mal". Konsistenz mit deiner letzten Nachricht: Hast du dort etwas abgelehnt oder eine Grenze gesetzt (z.B. "nicht X", "nur Y", Ablehnung eines Szenarios) – in der naechsten Antwort darfst du dieses abgelehnte Szenario nicht wieder einbauen oder die Grenze aufheben; gehe auf die aktuelle Kundenfrage ein und bleib bei deiner Grenze. Hast du in deiner letzten oder vorherigen Nachricht etwas ueber DICH gesagt (z.B. was du isst, machst, wo du bist, was du vorhast)? Dann bleib dabei – wechsle NICHT zu etwas anderem (z.B. nicht ploetzlich Omelett wenn du Nudeln mit Pesto gesagt hast, nicht Spaghetti wenn der Kunde das isst). Lies den Chat-Verlauf – was hast du bereits ueber dich gesagt? Bleib konsistent. Wenn der Kunde eine Einschränkung oder ein Problem andeutet (z.B. kann nicht mehr schreiben, keine Credits/Geld, will nicht, spricht dagegen, geht nicht): Gehe nicht nur kurz darauf ein und wechsle dann das Thema – stelle eine echte Nachfrage (warum? Was spricht dagegen? Ich dachte wir verstehen uns gut?) und zeige Neugier wie ein echter Mensch. Bei "Was machst du so?" / "Was machst du gerade?" im laufenden Chat: eher aktuelle Tätigkeit (gerade jetzt) nennen, nicht nur Beruf/Freizeit. Bei mehreren Punkten (z.B. Frage + Thema): auf ALLE eingehen. Fragt der Kunde DICH direkt (z.B. was macht X für dich schön, was suchst du, wie oft, was wäre für dich)? → Diese Frage ZUERST beantworten (aus deiner/Persona-Sicht), nicht nur zurückfragen oder auf ihn umlenken. Danach Gegenfrage. Wenn der Kunde eine Frage stellt, beantworte sie (oder weiche im Stil der Beispiele aus) und beende die Nachricht mit einer konkreten Gegenfrage. Jede Nachricht braucht eine Frage am Ende – zum Kontext passend, zum Thema oder das Thema erweiternd/vertiefend. Auch bei sexuellen Themen: am Ende eine kurze Frage, die zum Thema passt oder es vertieft (keine Treffen-Einladung). Mindestens 120 Zeichen. Natürlich und locker.
Stimmung: Reagiere passend auf die Stimmung des Kunden – warm und aufgeschlossen bei positivem/flirty Ton, verständnisvoll bei Traurigkeit, deeskalierend bei Unmut. Erkenne die Emotion hinter der Nachricht und spiegle sie angemessen.
Rechtschreibung: IMMER echte Umlaute (ä, ö, ü) – niemals ae, oe, ue (z.B. nächstes, wäre, möchte, für, könnte, schön). "teuer" mit eu, nie "teür". ss statt ß. Keine Anführungszeichen, keine Bindestriche. Keine Doppelpunkte in der Nachricht – stattdessen Komma (z.B. "hör zu," nicht "hör zu:").
Antworte NUR mit der einen Nachricht – keine Meta-Kommentare, keine Wiederholung der Kundennachricht wörtlich; eigenständig formuliert, mit Frage am Ende. Keine Erklärungen.
AUFBAU: Beginne NICHT mit einer Zusammenfassung oder Paraphrase der Kundennachricht (z.B. nicht "Ah, du fährst nachts und morgens bis mittags, Dienstag frei..."). Start mit kurzer Reaktion (z.B. "Das klingt flexibel bei dir", "Klingt anstrengend") oder direkt mit deiner Aussage/Frage.
FRAGEN: Die Gegenfrage am Ende MUSS wie in den Trainingsbeispielen sein – konkret, thematisch, zur Kundennachricht passend. NICHT die letzten Woerter/Sachen des Kunden einfach in eine Frage packen (z.B. nicht "Was machst du mit X und Y?" wenn er X und Y gerade nannte) – lieber nach Stimmung, Vorfreude oder Gefuehl fragen oder Thema einen Schritt weiter fuehren. KRITISCH – KEINE REDUNDANTE FRAGE: Hat der Kunde in seiner LETZTEN Nachricht bereits eine konkrete Information genannt (Wohnort/Stadt, Filmtitel/Serie, Beruf, was er gerade macht/schaut)? Dann NIEMALS am Ende nach genau dieser Information fragen (nicht "Woher kommst du?" wenn er gerade seinen Ort genannt hat, nicht "Was schaust du?" wenn er den Film genannt hat). Hat er beschrieben was er (mit dir) machen wuerde (Szenario, Ablauf, Position z.B. doggy, lecken)? Dann NIEMALS dieselbe Handlung als Frage zurueck (nicht "Wuerdest du mich doggy nehmen?" wenn er gerade sagte er wuerde dich doggy nehmen) – stattdessen darauf eingehen, andere Frage (Tempo, was danach, Stimmung). VERBOTEN: generische Meta-Fragen wie "Was interessiert dich (noch/denn) an unseren Gesprächen?", "Was magst du an mir?", "Was gefällt dir an unserem Chat?", "Was denkst du darüber?" – solche Fragen stehen NICHT in den Trainingsdaten und wirken beliebig. VERBOTEN: Planungs-/Umsetzungs-Fragen wie "Was denkst du, wie wir das umsetzen können?", "wie wir das am besten umsetzen können", "wie setzen wir das um" – klingen nach Buero/Projekt, nicht nach Flirt/Sextalk. Bei sexuellen Themen: Schlussfrage muss zum Thema passen – flirty, konkret (z.B. "würde dir das gefallen?", "magst du das?", "und was machst du dann für mich?", "denkst du du würdest X aushalten?"), NIEMALS nach Umsetzung/Planung klingen. VERBOTEN: "Was waere fuer dich der perfekte Moment fuer Doggy/Reiterstellung/[Position]?" und aehnliche generische Position-Fragen – durch konkrete thematische Frage ersetzen. Keine vagen Füllfragen mit unklarem Bezug (z.B. nicht "was trinkst du gerne dazu?" / "was magst du daran?" wenn "dazu"/"daran" aus dem Kontext nicht eindeutig ist – Schlussfrage muss sich klar auf Kundennachricht oder Gespraechsthema beziehen). Nutze stattdessen Fragen wie in den Beispielen (nachfragen zum Thema, zu dem was der Kunde gesagt hat, oder thematisch erweiternd). Bei Treffen-Wunsch: andeuten oder vage Vorlagen (z.B. was zusammen machen), nicht aktiv nach Ort oder Ideen fragen (nicht "Wo koennten wir treffen?", "Was fuer Ideen hast du?"), nicht meta.

PFLICHT: Nur eine Nachricht ausgeben; Frage am Ende (im Stil der Beispiele); keine Meta-Kommentare; KEIN ECHO – nicht Name, Alter, Ort oder Vorlieben des Kunden zurueckspielen, eigenstaendig formulieren.`;

  let userContent = '';
  if (conversationHistory && conversationHistory.trim()) {
    const historySnippet = conversationHistory.substring(Math.max(0, conversationHistory.length - 1200));
    userContent += `LAUFENDES GESPRÄCH: Die folgende Kundennachricht ist eine ANTWORT auf den Chat-Verlauf. Verstehe sie NUR im Bezug dazu – nie isoliert. Im Verlauf steht auch, was DU (Persona) bereits gesagt oder getan hast – wenn der Kunde danach fragt (z.B. wo warst du, wo bist du an mir vorbei...), aus DEINER Sicht antworten (ich war..., ich habe...), keine Rollenvertauschung.\n\nChat-Verlauf:\n${sanitizeForApiContent(historySnippet)}\n\nNeue Kundennachricht (bezieht sich auf obigen Verlauf – worauf genau? Erst einordnen, dann passend antworten):\n"${sanitizeForApiContent(customerMessage || '')}"\n\n`;
  } else {
    userContent += `Aktuelle Kundennachricht: "${sanitizeForApiContent(customerMessage || '')}"\n\n`;
  }
  const hasTextAndImage = imageDescriptionForUserPrompt && imageDescriptionForUserPrompt.trim() && (customerMessage || '').trim().length > 25 && !/^der kunde hat ein bild geschickt\.?$/i.test((customerMessage || '').trim());
  if (hasTextAndImage) {
    const descSnippet = imageDescriptionForUserPrompt.trim().replace(/\s*Reagiere flirty und positiv.*$/i, '').trim();
    userContent += `Der Kunde hat mit dieser Nachricht ein Bild geschickt. Inhalt des Bildes: ${sanitizeForApiContent(descSnippet.substring(0, 400))}${descSnippet.length > 400 ? '...' : ''}. Reagiere auf seine Nachricht UND auf den Bildinhalt.\n\n`;
  }
  userContent += `PFLICHT: Deine Antwort muss auf ALLE Punkte dieser Kundennachricht eingehen (jede Frage, jedes Thema, jede Aussage). Ignoriere nichts – in eigenen Worten, natuerlich in einem Fluss, ohne die Formulierungen des Kunden zu uebernehmen und ohne wie eine Abhakliste zu wirken.\n\n`;
  userContent += `FRAGE BEANTWORTEN: Fragen koennen UEBERALL in der Nachricht stehen – besonders oft am ENDE langer Nachrichten. Jede direkte Frage an DICH beantworten (z.B. Wie geht es dir?, Wie heisst du?, Was machst du? – oder „Was machst du heute noch?“ / „Was hast du vor?“ / „Wie verbringst du den Tag?“). Bei „was machst du heute“ / „was hast du vor“: kurz etwas Passendes nennen (was du heute machst), nicht ignorieren. Bei Treffen-Frage: kurz unverbindlich (z.B. heute klappt nicht). Keine Frage ignorieren – auch nicht am Ende. Danach Gegenfrage.\n\n`;
  userContent += `Die Nachricht kann mehrere Aussagen/Fragen enthalten – auf JEDEN Punkt eingehen (jede Frage aufgreifen oder beantworten, jedes Thema mit mindestens einem Satz), ohne Punkt-fuer-Punkt abzuspulen oder zu paraphrasieren.\n\n`;
  userContent += `KRITISCH – KONSISTENZ: Lies den Chat-Verlauf oben – was hast DU (Fake/Moderator) bereits ueber dich gesagt (z.B. was du isst, machst, wo du bist)? Bleib dabei – wechsle nicht zu etwas anderem. Wenn du "Nudeln mit Pesto" gesagt hast, sag nicht "Omelett" oder "Spaghetti Bolognese".\n\n`;
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

FOKUS AKTUELLE NACHRICHT: Waehle Situationen NUR fuer die AKTUELLE (letzte) Kundennachricht. Der Kontext dient nur zur Einordnung. Eine Situation (z.B. "Bilder Anfrage", "Wohnort-Frage") nur waehlen, wenn sie in der AKTUELLEN Nachricht vorkommt oder klar darin gemeint ist – NICHT waehlen, nur weil das Thema in einer frueheren Nachricht vorkam (die hat der Moderator bereits beantwortet). Beispiel: Aktuelle Nachricht fragt nur nach Vornamen und Wohnort, in einer frueheren Nachricht hatte er nach einem Foto gefragt → nur "Wohnort-Frage" (und ggf. Namensfrage) waehlen, NICHT "Bilder Anfrage".

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
  const hasNameQuestion = /\b(wie hei[ßs]t du\??|wie ist dein name\??|was ist dein name\??|wie hei[ßs]en sie\??|wie hei[ßs]t ihr\??)\b/i.test(customerSnippet);
  const hasWieGehtEsDir = /\b(wie geht es dir|wie gehts dir|wie geht\'s dir|wie geht es dir denn)\b/i.test(customerSnippet);
  const hasTreffenFrage = /\b(treffen\s+wir\s+uns|sehen\s+wir\s+uns|wann\s+treffen|wann\s+sehen|treffen\s+heute|heute\s+treffen|sollen\s+wir\s+uns\s+treffen|k[oö]nnen\s+wir\s+uns\s+treffen|wann\s+k[oö]nnen\s+wir|treffen\s+wir\s+uns\s+heute)\b/i.test(customerSnippet);
  const hasWasMachstDuHeute = /\b(was\s+machst\s+du\s+(heute|mit\s+deiner\s+zeit|den\s+ganzen\s+tag)|was\s+hast\s+du\s+vor\b|wie\s+verbringst\s+du\s+(den\s+tag|heute)|was\s+machst\s+du\s+heute\s+noch)\b/i.test(customerSnippet);
  const hasDirectQuestionToPersona = hasNameQuestion || hasWieGehtEsDir || hasTreffenFrage || hasWasMachstDuHeute || /\b(für dich|für dich\?|was macht .* für dich|was suchst du|wie oft|was wäre für dich|was findest du|was ist für dich|besonders schön für dich)\b/i.test(customerSnippet) || (/\?/.test(customerSnippet) && /\b(dich|dir|du)\b/i.test(customerSnippet));
  const directQuestionHint = hasDirectQuestionToPersona
    ? ' PFLICHT: Die aktuelle Kundennachricht enthaelt eine direkte Frage an die Persona (z.B. wie geht es dir, wie heisst du, was machst du / was machst du heute, was hast du vor, wie verbringst du den Tag – oder Treffen). Plan: Diese Frage NICHT ignorieren – in der Antwort kurz beantworten (bei "was machst du heute"/"was hast du vor": kurz etwas Passendes nennen; bei Treffen-Frage unverbindlich), dann Rest der Nachricht. Fragen stehen oft am ENDE langer Nachrichten – auch dann beantworten. Kontext nutzen; Antwort auf aktuelle Nachricht.'
    : '';
  const hasTreffen = Array.isArray(detectedSituations) && detectedSituations.some(s => (s || '').includes('Treffen'));
  const hasConcreteOrtZeit = /\b(morgen|am\s+\w+|um\s+\d{1,2}\s*:?\s*\d{0,2}|parkplatz|aldi|herzberg|treffen\s+in\s+\w+|\d{1,2}\s*uhr)\b/i.test(customerSnippet);
  const meetingHint = hasTreffen && hasConcreteOrtZeit
    ? ' Bei Treffen: Kunde hat konkreten Ort und/oder Zeit genannt (z.B. morgen 09:00, Aldi Parkplatz). Plan darf NICHT vorschlagen "Klingt gut" oder "Morgen klingt gut" am Anfang – das wirkt wie Zusage. Stattdessen: Einstieg mit Abschwaechung (wuerde mir gefallen, aber... / haette Lust, aber...), dann unverbindlich (muss schauen ob es klappt).'
    : '';
  const contextBlock = contextSnippet
    ? `Kontext (Auszug aus dem Gespräch – beachten für Ton und Thema):\n${sanitizeForApiContent(contextSnippet)}\n\n`
    : '';
  const userContent = `${contextBlock}Aktuelle Kundennachricht: "${sanitizeForApiContent(customerForPlan)}"\n\nErkannte Situation(en): ${situationList}.${contactHint}${sexualHint}${romanticHint}${wasWillstDuWissenHint}${unclearHint}${directQuestionHint}${meetingHint}\n\nKONTEXT-KLARHEIT (wichtig): Was war das LETZTE BESPROCHENE THEMA im Verlauf vor dieser Nachricht (z.B. Gesundheit/Diabetes, Beruf, Hobby, Treffen, Alter des Kunden, Beziehung)? Wenn die letzte Moderatoren-Nachricht mehrdeutige Formulierungen enthaelt (z.B. \"es\", \"das\", \"in deinem Alter\", \"einschraenkt\", \"stört\"), worauf bezieht sich das – auf das zuletzt besprochene Thema (z.B. Diabetes) oder auf etwas anderes (z.B. Altersunterschied)? Nenne explizit: \"Letztes Thema: [X]. Bezug von es/das/einschraenkt/in deinem Alter: [Y].\" – damit die Antwort nicht auf ein falsches Thema eingeht (z.B. Altersunterschied, wenn der Kunde ueber Diabetes sprach).\n\nGib in 2–4 Sätzen an: Welche Regeln/Prioritäten gelten hier? Welcher Ton? Welche Themen/Fragen stecken in der Nachricht? Nenne sie stichwortartig (z.B. Vorlieben UND Tabus, Pizza/Kueche, TV, Rueckfrage "und du?") – keine woertliche Paraphrase. WICHTIG: Nicht nur den ersten Satz – die GANZE Nachricht. Nennt der Kunde Tabus und fragt "und du?" → Plan muss Tabus und die Rueckfrage einbeziehen, nicht nur Vorlieben. Die Antwort soll auf alle genannten Themen eingehen, aber nicht Punkt fuer Punkt abspulen. Alle Themen/Beduerfnisse beruecksichtigen (nicht nur die erkannten Situationen) – nichts im Raum stehen lassen. Fragt der Kunde auf die letzte Moderatoren-Nachricht zurueck (z.B. "woher weisst du das")? Dann: explizit darauf eingehen. Was unbedingt vermeiden? Nur den Plan, keine Antwort an den Kunden.`;
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

  const hasClarificationNurMistral = /\bnur\s+(zahnreinigung|zahnarzt|kontrolle|routine|check)\b/i.test(fullCustomerMsg) || /\bnur\s+[\wäöüß-]+\s*\.{2,}/i.test(fullCustomerMsg);
  const customerClarificationRuleMistral = hasClarificationNurMistral
    ? ' KLARSTELLUNG: Kunde hat mit "nur X" klargestellt (z.B. nur Zahnreinigung = Routine). Enthaelt die Antwort Trost oder negative Deutung ("nicht dein Tag", "wird schon wieder", "das wird wieder")? Wenn ja → ersetzen durch positive, lockere Reaktion auf die Klarstellung (z.B. dass es nur Routine ist), keine Trost-Formulierung.'
    : '';
  const hasDagegenSexHopeMistral = /gehofft|hoffte/i.test(fullCustomerMsg) && /dagegen/i.test(fullCustomerMsg) && /sex|haettet|hätten/i.test(fullCustomerMsg);
  const dagegenSexHopeRuleMistral = hasDagegenSexHopeMistral
    ? ' Kunde sagt er habe gehofft du waerst DAGEGEN und dass ihr Sex haettet. Antwort nur generisches Treffen/Chemie? → ersetzen: Hoffnung anerkennen, Verstaendnis (z.B. kann Samstag nicht), am liebsten mit ihm / das mit ihm machen.'
    : '';
  const hasNameQuestionMistral = /\b(wie hei[ßs]t du\??|wie ist dein name\??|was ist dein name\??|wie hei[ßs]en sie\??|wie hei[ßs]t ihr\??)\b/i.test(fullCustomerMsg);
  const hasWieGehtEsDirMistral = /\b(wie geht es dir|wie gehts dir|wie geht\'s dir|wie geht es dir denn)\b/i.test(fullCustomerMsg);
  const hasTreffenFrageMistral = /\b(treffen\s+wir\s+uns|sehen\s+wir\s+uns|wann\s+treffen|wann\s+sehen|treffen\s+heute|heute\s+treffen|sollen\s+wir\s+uns\s+treffen|k[oö]nnen\s+wir\s+uns\s+treffen|wann\s+k[oö]nnen\s+wir|treffen\s+wir\s+uns\s+heute)\b/i.test(fullCustomerMsg);
  const hasWasMachstDuHeuteMistral = /\b(was\s+machst\s+du\s+(heute|mit\s+deiner\s+zeit|den\s+ganzen\s+tag)|was\s+hast\s+du\s+vor\b|wie\s+verbringst\s+du\s+(den\s+tag|heute)|was\s+machst\s+du\s+heute\s+noch)\b/i.test(fullCustomerMsg);
  const hasDirectQuestionToPersonaMistral = hasNameQuestionMistral || hasWieGehtEsDirMistral || hasTreffenFrageMistral || hasWasMachstDuHeuteMistral || /\b(für dich|für dich\?|was macht .* für dich|was suchst du|wie oft|was wäre für dich|besonders schön für dich)\b/i.test(fullCustomerMsg) || (/\?/.test(fullCustomerMsg) && /\b(dich|dir|du)\b/i.test(fullCustomerMsg));
  const answerDirectQuestionRuleMistral = hasDirectQuestionToPersonaMistral
    ? ' PFLICHT: Die AKTUELLE Kundennachricht enthaelt eine direkte Frage an die Persona (z.B. wie geht es dir, wie heisst du, was machst du – oder "was machst du heute?", "was hast du vor?", "wie verbringst du den Tag?" – oder Treffen). Beantwortet die Antwort diese Frage oder ignoriert sie? Fragen stehen oft am ENDE langer Nachrichten – auch dann beantworten. Bei "was machst du heute"/"was hast du vor": kurz etwas Passendes nennen (z.B. was die Persona heute macht), NICHT ignorieren. Bei Treffen-Frage: kurz unverbindlich beantworten. Sonst: zuerst die Frage beantworten, dann Gegenfrage.'
    : '';
  const treffenFrageIgnoredRuleMistral = hasTreffenFrageMistral
    ? ' TREFFEN-FRAGE IGNORIERT: Kunde fragt nach Treffen (z.B. "Treffen wir uns heute?", "Wann sehen wir uns?") und die Antwort geht NICHT darauf ein (kein "heute klappt nicht", kein "muss schauen", kein "passt heute nicht", kein unverbindliches Abblocken)? Dann AM ANFANG der Antwort einen kurzen Satz einfuegen: z.B. "Heute klappt es leider nicht, aber " oder "Muss schauen wann es passt – " dann den bisherigen Antworttext. Die Treffen-Frage darf nie ignoriert werden.'
    : '';
  const hasNameOrWohnortRequestMistral = context.askForNameOrWohnort === true || /\b(vornamen?|name)\s+und\s+wohnort\b|\bwohnort\s+und\s+(vornamen?|name)\b|\b(deinen?|dein)\s+(vornamen?|wohnort)\b|\bdenkst\s+du\s+noch\s+an\s+(deinen?\s+)?(vornamen?|wohnort)\b/i.test(fullCustomerMsg);
  const fn = (context.fakeFirstName && String(context.fakeFirstName).trim()) || '';
  const fc = (context.fakeCityForAnswer && String(context.fakeCityForAnswer).trim()) || '';
  const nameAndWohnortRuleMistral = (hasNameOrWohnortRequestMistral && (fn || fc))
    ? ' PFLICHT NAME/WOHNORT: Der Kunde hat nach Vorname und/oder Wohnort gefragt (z.B. "Vornamen und Wohnort", "wo wohnst du", "wie heisst du"). Die Antwort MUSS diese Fragen beantworten' + (fn ? ': Vorname "' + fn + '" nennen' : '') + (fc ? (fn ? ', Wohnort "' + fc + '" nennen' : ': Wohnort "' + fc + '" nennen') : '') + '. Enthaelt die Antwort den Vornamen und/oder den Wohnort NICHT (oder nur eines davon obwohl beides gefragt)? Dann AM ANFANG der Antwort ergaenzen (z.B. "Ich bin ' + (fn || '[Vorname]') + ', wohne in ' + (fc || '[Stadt]') + '. ..." oder "Ich heisse ' + (fn || '[Vorname]') + ', komme aus ' + (fc || '[Stadt]') + '. ..."). Nicht nur auf andere Themen (z.B. Fotos, Arbeit) eingehen und Name/Wohnort weglassen.'
    : '';
  const erreichbarkeitRuleMistral = (context.askForErreichbarkeit === true)
    ? ' ERREICHBARKEIT (PLATTFORM): Der Kunde hat gefragt, wo/wie er dich erreichen kann (z.B. "wo kann ich dich erreichen?"). Die Antwort MUSS diese Frage beantworten (z.B. "Du kannst mich hier erreichen", "Hier im Chat", "einfach hier schreiben"). Enthaelt die Antwort KEINEN solchen Bezug (hier, im Chat, hier erreichen)? Dann AM ANFANG der Antwort einen kurzen Satz einfuegen: z.B. "Du kannst mich hier erreichen. " oder "Hier im Chat erreichst du mich. " – dann den bisherigen Antworttext. Danach auf den Rest der Kundennachricht eingehen.'
    : '';
  const focusCurrentMessageRuleMistral = ' FOKUS AKTUELLE KUNDENNACHRICHT: Die Antwort muss sich auf die AKTUELLE (letzte) Kundennachricht konzentrieren. Der Chat-Verlauf dient nur zum Verstaendnis und fuer Bezuege (es, das, worauf er sich bezieht). Themen aus frueheren Nachrichten (z.B. Foto-Anfrage) hat der letzte Moderator bereits beantwortet – nicht erneut darauf antworten oder das zum Hauptthema machen. Wenn die aktuelle Nachricht z.B. nach Name und Wohnort fragt, muss die Antwort Name und Wohnort nennen; andere Themen aus dem Verlauf (z.B. Fotos) sind sekundaer oder schon beantwortet. Kontext = Verstehen; Antwort = auf die aktuelle Nachricht.';
  // Name nicht wiederholen, wenn letzter Moderator/Kunde ihn schon kennt; nur Vorname (nie Benutzername) nennen
  const noRepeatNameIfAlreadySaidRuleMistral = ' Hat die LETZTE Moderator-Nachricht im Chat-Verlauf bereits den Vornamen der Persona genannt (z.B. "Ich bin Justine", "Ich heisse X") oder spricht der Kunde die Persona mit diesem Namen an (z.B. "liebe Justine", "Hey Justine")? Enthaelt die zu korrigierende Antwort trotzdem eine erneute Vorstellung mit "Ich heisse [Name]" oder "Ich bin [Name]"? Wenn ja → diesen Teil entfernen oder durch kurze Bestaetigung ersetzen (z.B. "Ja, genau.", "Freut mich."), keine erneute Namensnennung.';
  const useOnlyFirstNameNotUsernameRuleMistral = (context.fakeFirstName && context.fakeDisplayNameOrUsername)
    ? ` PFLICHT NAME: Der Vorname der Persona fuer den Chat ist "${String(context.fakeFirstName).trim()}". Enthaelt die Antwort "Ich heisse ${String(context.fakeDisplayNameOrUsername).trim()}" oder nennt die Antwort den Benutzername/Anzeigenamen (z.B. "${String(context.fakeDisplayNameOrUsername).trim()}") statt den Vornamen? Wenn ja → ersetzen: nur "${String(context.fakeFirstName).trim()}" verwenden (z.B. "Ich heisse ${String(context.fakeFirstName).trim()}" oder gar nicht nochmal vorstellen, wenn der Name schon bekannt ist). Niemals den Benutzernamen/Anzeigenamen als Persona-Namen im Chat nennen.`
    : (context.fakeFirstName ? ` PFLICHT NAME: Wenn die Antwort den Namen der Persona nennt, muss es der Vorname "${String(context.fakeFirstName).trim()}" sein – nie einen anderen Namen (z.B. Benutzername/Anzeigenamen) verwenden.` : '');
  const logbookNoContradictRuleMistral = (context.logbookSaysJungfrau || context.logbookSaysSchwanger)
    ? (context.logbookSaysJungfrau
      ? ' LOGBUCH JUNGFRÄULICHKEIT: Im Fake-Logbuch steht "Jungfrau" (z.B. Vorlieben). Enthaelt die Antwort, die Persona sei keine Jungfrau mehr, habe schon Sex gehabt, habe die Jungfernschaft verloren oder der Arsch sei "entjungfert"? Wenn ja → umschreiben: Persona ist in diesem Profil jungfraeulich, Antwort muss dazu passen (z.B. als Jungfrau antworten, nicht widersprechen).'
      : '') + (context.logbookSaysSchwanger
      ? ' LOGBUCH SCHWANGERSCHAFT: Im Fake-Logbuch steht Schwangerschaft. Enthaelt die Antwort, die Persona sei nicht schwanger oder widerspricht sie dem? Wenn ja → umschreiben: Persona ist in diesem Profil schwanger, Antwort muss dazu passen.'
      : '')
    : '';

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
  const noVorliebenTabusEchoRule = ' Hat der Kunde Vorlieben und/oder Tabus aufgelistet (z.B. DT, 69, anal, Lecken, Doggy, Reiterstellung; Tabus SM, BDSM)? Listet oder paraphrasiert die Antwort diese gleichen Begriffe (z.B. "DT tief und fest, 69 und anal... deine Tabus sind genau meine, nix SM, BDSM")? Wenn ja → diesen Teil entfernen/kuerzen, nur kurze Reaktion (klingt gut, passt fuer mich) + eigene Aussage + EINE thematische Frage, keine Aufzaehlung seiner Vorlieben/Tabus.';
  const noPerfekteMomentFrageRule = ' Enthaelt die Antwort am Ende eine Frage wie "Was waere fuer dich der perfekte Moment fuer Doggy/Reiterstellung/..." oder "perfekte Moment fuer [Position]"? Wenn ja → diese Frage ersetzen durch konkrete thematische Frage (z.B. "Und dann?", "Haerter oder langsamer?", "Woran denkst du gerade?").';
  const noParaphraseSchlussfrageRule = ' Ist die letzte Frage der Antwort nur eine Wiederholung/Paraphrase dessen, was der Kunde gerade gesagt hat (z.B. Kunde nannte "Huehner versorgen und Kleinigkeiten" → Antwort fragt "Was machst du mit den Huehnern und den Kleinigkeiten?")? Wenn ja → diese Schlussfrage ersetzen durch eigenstaendige Frage (z.B. nach Stimmung, Vorfreude, Gefuehl: "Freust du dich schon auf Abend?", "Wie gehts dir so mit dem langen Tag?", "Dann kannst du bald abschalten?").';
  const noMetaQuestionAboutCustomerActivityRule = ' KEINE META-FRAGE ZUR KUNDENAKTIVITAET: Hat der Kunde gerade erzaehlt was ER macht (z.B. Einkaufen, Arbeit, Weg, "ich werde in X einkaufen gehen")? Enthaelt die Schlussfrage der Antwort eine Rueckfrage genau zu DIESER Aktivitaet (z.B. "Was hast du dir fuer den Einkauf vorgenommen?", "Was erhoffst du dir von deinem Einkauf?", "Was hast du vor beim Einkauf?", "Wie laeuft dein Einkauf?")? Das wirkt wie Interview, nicht wie lockeres Gespraech. Wenn ja → diese Frage ersetzen durch natuerliche Gegenfrage (z.B. nach Stimmung, nach ihm allgemein, oder thematisch weiter – nicht seine gerade genannte Aktivitaet in eine Frage verpacken).';
  const noQuestionAlreadyAnsweredRule = ' Hat der Kunde in seiner Nachricht bereits gesagt was er geben/zeigen/tun will (z.B. "dann kriegste was tolles", "zeig dir auch was", "dann bekommst du X")? Enthaelt die Antwort eine Rueckfrage wie "Was bekommst du dafuer?", "Zeigst du mir auch was?", "Was krieg ich dafuer?"? Wenn ja → diese Frage entfernen/ersetzen durch Reaktion auf sein Angebot oder andere thematische Frage.';
  // Kunde hat in seiner Nachricht bereits Wohnort/Stadt, Filmtitel/Serie, Beruf oder was er gerade macht genannt – Antwort darf nicht danach fragen
  const noRedundantFactQuestionRule = ' Hat der Kunde in seiner Nachricht bereits eine konkrete Information genannt (z.B. Wohnort/Stadt, Filmtitel/Serie, Beruf, was er gerade macht/schaut)? (1) Endet die Antwort mit einer Frage, die genau danach fragt (z.B. "Woher kommst du?", "Was schaust du?", "Was schaust du gerade?", "Was machst du beruflich?")? ODER (2) enthaelt die Antwort eine bestaetigende Rueckfrage zum gerade vom Kunden genannten Ort (z.B. "Und du kommst aus Berlin Spandau?", "Du kommst aus [Ort], oder?", "Du wohnst in [Ort], oder?")? Wenn ja → diese Schlussfrage bzw. Bestaetigung entfernen oder durch eine andere, nicht-redundante Frage ersetzen (z.B. zum Treffen, Stimmung, Details, Vorlieben). Nicht nach etwas fragen, das der Kunde gerade gesagt hat.';
  // Kunde hat beschrieben was er (mit Persona) machen wuerde (Szenario, Handlung, Position) – Antwort darf das nicht als Rueckfrage wiederholen
  const noRedundantScenarioQuestionRule = ' Hat der Kunde in seiner Nachricht beschrieben was er (mit der Persona) machen wuerde (Szenario, Ablauf, Handlung, Position – z.B. doggy nehmen, lecken, fingern, küssen, Reihenfolge)? Enthaelt die Antwort eine Frage, die genau diese Handlung/Position zurueckfragt (z.B. "Wuerdest du mich doggy nehmen?", "Willst du mich lecken?", "Wuerdest du mich dann X?", "Wuerdest du mich gerne noch doggy nehmen?")? Wenn ja → diese Frage entfernen oder durch eine nicht-redundante Frage ersetzen (z.B. Tempo, was danach, Stimmung, andere Position). Rest der Nachricht bleibt; nur die redundante Rueckfrage ist verboten.';
  // Kunde fragt wo/wann/was die Persona getan hat – Antwort muss aus Persona-Sicht sein, nicht dieselbe Frage an den Kunden zurueck (Rollenvertauschung)
  const noRoleReversalRule = ' Fragt die Kundennachricht danach, wo/wann/was DU (Persona) getan oder gesagt hast (z.B. "wo warst du?", "wo bist du an mir vorbei gejoggt?", "wo hast du X?", "du hast gesagt...")? Enthaelt die Antwort stattdessen eine Rueckfrage an den Kunden, die dieselbe Sache von IHM wissen will (z.B. "wo bist du an mir vorbei gejoggt?", "wo warst du?")? Das ist Rollenvertauschung – der Kunde hat DICH gefragt, nicht umgekehrt. Wenn ja → diese Rueckfrage ersetzen durch eine Antwort aus der Persona-Sicht (z.B. "Ich war in [Ort]/jogge oft in [Gegend], da koennte ich dich gesehen haben" oder thematisch passend) und eine andere Gegenfrage (z.B. wo laeufst du denn, was machst du da).';
  // Moderator fragt von sich aus nach Kaffee/Treffen/Zeit – verboten; Schlussfrage muss zum Thema passen
  const noKaffeeTreffenFrageRule = ' Enthaelt die Antwort eine Frage nach Kaffee, Treffen, Date oder "wann hast du Zeit" / "wann haettest du Zeit" / "Zeit fuer einen Kaffee" / "wann koennten wir uns treffen" (oder aehnlich), obwohl der Kunde NICHT nach einem Treffen gefragt hat (sondern z.B. nur Beziehungsziele, Vorlieben, keine ONS geteilt hat)? Wenn ja → diese Schlussfrage ENTFERNEN oder durch eine thematisch passende Frage ersetzen (z.B. zum was der Kunde gesagt hat: was er sich vorstellt, was ihm wichtig ist, Stimmung, Vorlieben). Der Moderator schlaegt kein Treffen vor und fragt nicht danach – die Frage am Ende muss zum aktuellen Thema der Kundennachricht passen.';
  // Schlussfrage: keine vagen "dazu/daran/damit"-Fragen; Bezug zu Kundennachricht oder Gespraechsthema
  const noVagueDazuSchlussfrageRule = ' SCHLUSSFRAGE KLAR BEZIEHEN: Enthaelt die letzte Frage der Antwort vage Woerter wie "dazu", "daran", "damit" (z.B. "was trinkst du gerne dazu?", "was magst du daran?", "was haeltst du davon?"), ohne dass aus der Kundennachricht eindeutig hervorgeht worauf sich "dazu/daran/damit" bezieht? Oder ist die Schlussfrage eine generische Praeferenzfrage (z.B. nur wegen Stichwort Kaffee nach "was trinkst du dazu?") die nicht zum Gesagten passt? Wenn ja → diese Schlussfrage ersetzen durch eine konkrete Frage, die sich klar auf das bezieht was der Kunde gesagt hat oder auf das Gespraechsthema (z.B. Stimmung, naechster Schritt, Vorlieben im Kontext) – nie unklare Füllfragen.';
  // Reine Begruessung (Hey, Hi, Hallo): Antwort soll nicht emotional/romantisch sein, sondern Hallo + Tagesfragen
  const pureGreetingAnswerRule = (context.isPureGreetingMessage === true)
    ? ' BEGRUESSUNG ALS KUNDENNACHRICHT: Die Kundennachricht ist nur eine Begruessung (Hey, Hi, Hallo o.ae.). Enthaelt die Antwort starke romantische/emotionale Formulierungen (z.B. "Gefuehle", "Herz", "in deinen Armen", "zaubert mir ein Laecheln", "was wuerdest du mit mir machen", "spuere diese Gefuehle") oder spinnt das Thema Treffen/Gefuehle fort? Wenn ja → ersetzen durch kurze Begruessung zurueck (z.B. Hallo [Name], Hey) + 1–2 normale Tagesfragen (wie gehts dir, gut geschlafen, wie laeuft die Arbeit, was machst du gerade). Bei reiner Begruessung neutral und alltaeglich antworten.'
    : '';
  // Keine Zeit-Aussage wenn Kunde nicht konkret nach Treffen gefragt hat
  const noTimeRefusalWithoutMeetingRequestRule = (context.isDirectMeetingRequest !== true)
    ? ' KEINE ZEIT-ABLEHNUNG OHNE TREFFEN-ANFRAGE: Hat der Kunde KEINE konkrete Treffen-Anfrage gestellt (kein wann/wo/heute/morgen/Date)? Beginnt die Antwort mit einer Zeit- oder Verfuegbarkeits-Aussage (z.B. "Heute habe ich leider...", "Heute klappt es nicht...", "Heute passt nicht...", "Muss schauen wann...")? Wenn ja → diesen Einstieg entfernen, die Antwort mit dem naechsten Satz beginnen (direkt auf das eingehen, was der Kunde gesagt hat – Lust, Vorlieben, Thema). Sonst wirkt es unangebracht.'
    : '';
  // Kein eigener Treffen-Vorschlag der Persona, wenn der Kunde nicht danach gefragt hat
  const noMeetingSuggestionFromModeratorRule = (context.isDirectMeetingRequest !== true)
    ? ' KEIN EIGENER TREFFEN-VORSCHLAG: Hat der Kunde in seiner Nachricht NICHT explizit nach Treffen/Date gefragt oder es vorgeschlagen? Enthaelt die Antwort einen VORSCHLAG der Persona zum Treffen (z.B. "wir koennten uns treffen", "vielleicht koennten wir uns treffen", "lass uns mal treffen", "koennten wir uns kennenlernen", "wir koennen uns ja mal treffen", "wie waers wenn wir uns treffen", "sollen wir uns mal treffen")? Wenn ja → diesen Satz/Teil entfernen oder umformulieren (z.B. Frage was er gern machen wuerde, inhaltliche Antwort ohne eigenen Treffen-Vorschlag). Der Rest der Nachricht bleibt; nur der EIGENE Vorschlag der Persona darf nicht drinstehen.'
    : '';
  // Bild nur angekündigt: Kein "Danke für das Bild" / "sieht geil aus"
  const imageOnlyAnnouncedRule = (context.imageOnlyAnnounced === true)
    ? ' BILD NUR ANGEKUENDIGT: Kunde hat noch kein Bild geschickt. Enthaelt die Antwort "Danke fuer das Bild" oder Bewertung (sieht geil aus)? Wenn ja → entfernen/ersetzen durch Vorfreude (z.B. freue mich drauf), keine Bewertung eines nicht vorhandenen Bildes.'
    : '';
  // Kunde behauptet Bild geschickt, aber keins da: Nicht auf ein Bild reagieren
  const imageClaimedButNotPresentRule = (context.imageClaimedButNotPresent === true)
    ? ' BILD BEHAUPTET, ABER NICHT DA: Kunde behauptet ein Bild geschickt zu haben – es ist keins angekommen. Enthaelt die Antwort Reaktion auf ein Bild (z.B. "dein Bild macht mich geil", "sieht geil aus", Bewertung des Bildes)? Wenn ja → ersetzen durch: freundlich sagen, dass kein Bild angekommen ist, und ggf. bitten nochmal zu schicken. Keine Reaktion als ob ein Bild da waere.'
    : '';
  // Du hast dem Kunden in deiner letzten Nachricht bereits ein Bild geschickt – er hat es gesehen. Antwort darf nicht so tun, als hättest du keins geschickt.
  const imageAlreadySentToCustomerRule = (context.imageAlreadySentToCustomer === true)
    ? ' BILD BEREITS GESCHICKT: Du hast dem Kunden in deiner LETZTEN Nachricht bereits ein Bild geschickt – er hat es gesehen. Enthaelt die Antwort "Foto finde ich nicht", "Handy macht Zicken mit der Kamera", "wenn ich dir eins schicken koennte", "Foto von gestern finde ich nicht mehr" o.ae.? Wenn ja → diesen Teil entfernen/ersetzen; auf das eingehen, was der Kunde JETZT schreibt (seine Reaktion, seine Bitte), nicht so tun als waere kein Bild angekommen.'
    : '';
  // Orte: Nie behaupten, Ort (Café, Bar, etc.) zu kennen/mögen
  const noPlaceClaimRule = ' Enthaelt die Antwort, die Persona kenne oder moege einen vom Kunden genannten Ort (Café, Bar, Restaurant, Lokal)? Wenn ja → umformulieren: hoechstens allgemein (klingt nett), niemals "mag/kenne ich auch" zu konkretem Ortsnamen.';
  // Vorfreude nicht zu stark
  const noStrongHopeRule = ' Formuliert die Antwort feste Zusage oder starke Vorfreude (z.B. "freue mich schon auf das Wochenende mit dir")? Wenn ja → zurueckhaltender umformulieren.';
  // Nie getroffen: "wiedersehen"/"wenn wir uns wiedersehen" impliziert ein bereits stattgefundenes Treffen – Kunde und Fake haben sich nie getroffen.
  const noWiedersehenRule = ' PFLICHT: Enthaelt die Antwort "wiedersehen", "wiederzusehen", "mal wieder treffen", "wenn wir uns wiedersehen" ODER "nächstes Mal sehen", "wenn wir uns das nächste Mal sehen", "beim nächsten Mal" (im Treffen-Kontext)? Ihr habt euch NIE getroffen – "wieder" und "nächstes Mal" unterstellen ein erstes Treffen. Wenn ja → ersetzen durch "wenn wir uns (mal) sehen", "wenn wir uns treffen", "wenn es so weit ist", "was wir zusammen machen könnten" – ohne "wieder" und ohne "nächstes Mal".';
  // "Hatte ich schon mal" / "das Vergnügen hatte ich schon": Kunde meint Erfahrung mit ANDEREN, nicht mit dem Fake – Antwort darf nicht so tun, als hätte er dich/deinen Körper schon erlebt.
  const noSharedPastRule = ' Enthaelt die Antwort eine Formulierung, als haette der Kunde DICH bzw. deinen Koerper schon erlebt (z.B. "dass du meinen X schon mal probiert hast", "dass du mich schon mal ...")? Kunde und Fake haben sich nie getroffen – Saetze wie "hatte ich schon mal" / "das Vergnuegen hatte ich schon" meinen seine Erfahrung mit ANDEREN. Wenn ja → umschreiben: auf seine Erfahrung eingehen, ohne so zu tun als haette er dich bereits erlebt.';
  // Allgemein: Grenzen einhalten – wenn die letzte Moderatoren-Nachricht etwas abgelehnt oder eine Grenze gesetzt hat, darf die naechste Antwort das nicht aufheben oder das abgelehnte Szenario wieder einbauen.
  const boundaryConsistencyRule = ' Enthaelt der Chat-Verlauf in der letzten Moderatoren-Nachricht eine Ablehnung oder Grenze (z.B. etwas abgelehnt, "nicht fuer X", "nur Y", klare Einschraenkung)? Wenn ja: Widerspricht die zu korrigierende Antwort dieser Grenze oder baut das abgelehnte Szenario wieder ein? Wenn ja → umschreiben: Grenze einhalten, auf die Kundenfrage eingehen, keine Wiederaufnahme des abgelehnten Themas.';
  // Eigene Aussagen konsistent halten: Wenn die Persona in einer vorherigen Nachricht etwas ueber SICH gesagt hat (Essen, Aktivitaet), darf die Antwort nicht zu etwas anderem wechseln.
  const selfConsistencyRule = ' Enthaelt der Chat-Verlauf eine vorherige Moderator-Nachricht, in der die Persona etwas ueber SICH gesagt hat (z.B. was sie isst, macht, wo sie ist – Nudeln mit Pesto, Omelett, etc.)? Widerspricht die zu korrigierende Antwort dem (z.B. anderes Essen, andere Aktivitaet)? Wenn ja → umschreiben: konsistent mit der vorherigen Aussage bleiben, NICHT das des Kunden echoen oder etwas Neues erfinden.';
  // Wenn WIR (Moderator) in der letzten Nachricht etwas ueber UNS gesagt haben (z.B. Wohnort "ich bin aus Heikendorf"), darf die Antwort das NICHT als Kundenwissen bestaetigen ("geil dass du das weisst").
  const noEchoOwnModeratorStatementRule = ' Enthaelt die LETZTE Moderator-Nachricht im Chat-Verlauf eine Aussage ueber die Persona selbst (z.B. Wohnort "ich bin aus X", "wohne in X", Beruf, was sie macht)? Enthaelt die zu korrigierende Antwort dann Formulierungen, als haette der KUNDE das gesagt oder gewusst (z.B. "geil dass du das weisst", "super dass du weisst woher ich bin", "ja ich bin aus [Ort]" als Wiederholung)? Wenn ja → umschreiben: diesen Teil entfernen, stattdessen auf das eingehen, was der Kunde WIRKLICH geschrieben hat (seine Fragen, seine Themen). Die eigene Aussage nicht dem Kunden zuschreiben.';
  const noRepeatOwnLastMessageRule = ' Enthaelt die LETZTE Moderator-Nachricht im Chat-Verlauf Fakten/Infos ueber die Persona (z.B. Schwester kommt Donnerstag, Geburtstag Samstag, was sie vorhat)? Wiederholt die zu korrigierende Antwort dieselben Infos (z.B. "Bei mir kommt meine Schwester ab Donnerstag...", gleiche Termine/Details)? Wenn ja → diesen Teil entfernen; nur auf die Kundennachricht eingehen, keine Wiederholung der eigenen letzten Nachricht – der Kunde hat sie schon gelesen.';
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
  // Bilder-Anfrage RICHTUNG: Kunde bittet Persona zu schicken (willst du mir Selfie/Foto schicken) – Antwort darf nicht so klingen als erwarte Persona ein Bild vom Kunden
  const imageRequestDirectionRule = ' BILDER-ANFRAGE RICHTUNG: Bittet die Kundennachricht DICH (Persona), ein Foto/Selfie zu schicken (z.B. "willst du mir ein Selfie schicken", "schick mir ein Foto", "kannst du mir ein Bild schicken", "selfie von der Arbeit schicken")? Enthaelt die Antwort trotzdem etwas wie "wuerde mich freuen dein Selfie zu sehen", "freue mich auf dein Bild", "wuerde dein Selfie gern sehen" – also als wuerde der Kunde DIR ein Bild schicken? Das ist Richtungsvertauschung. Wenn ja → ersetzen durch freundliches Ausweichen: Persona schickt keine Fotos (z.B. schick keine Fotos im Internet, hier schick ich keine, mag ich nicht – locker im Ton), und auf den Rest der Nachricht eingehen.';
  // Rueckfragen/Callbacks: Kunde fragt "woher weisst du das", "wie meinst du das" – Antwort muss darauf eingehen, nicht themenfremd werden
  const ruckfrageCallbackRule = ' Fragt der Kunde auf die letzte Moderatoren-Nachricht zurueck (z.B. "woher weisst du das", "wie meinst du das", "wer weiss", "woher soll ich das wissen")? Geht die Antwort DIREKT darauf ein (Erklaerung, Begruendung, Flirt-Kommentar) – oder wechselt sie themenfremd (z.B. Name, Beruf, "was machst du gerade")? Wenn themenfremd → umschreiben: Rueckbezug auf die eigene Aussage herstellen, Flirt-Ton beibehalten (z.B. "weil du so rueberkommst", "weil ich dich sympathisch finde").';
  // Wir haben den Kunden etwas gefragt (z.B. Absichten, „weißt du das schon?“), Kunde antwortet darauf (z.B. „Nein“, „Weiß ich noch nicht“) – Antwort muss zuerst darauf eingehen, nicht zu Kaffeetreffen/Ort springen
  const answerOurQuestionStayOnTopicRule = ' Enthaelt die LETZTE Moderator-Nachricht im Chat-Verlauf eine FRAGE an den Kunden (z.B. Absichten, langfristig, "Weisst du das schon?", "was wären deine Absichten?", "was haettest du vor?") und ist die Kundennachricht eine kurze ANTWORT darauf (z.B. "Nein", "Weiss ich noch nicht", "Noch nicht", "Ja", "Klingt gut")? Wenn ja: Geht die zu korrigierende Antwort ZUERST auf diese Kundenantwort ein (z.B. Verstaendnis, kurzer Kommentar) – oder springt sie sofort zu einem aelteren Thema (z.B. Kaffeetreffen, "wann es bei mir passt", "Hast du einen Lieblingsort?", Termin)? Wenn sie das Thema wechselt ohne auf die Kundenantwort einzugehen → umschreiben: zuerst auf die Kundenantwort eingehen (z.B. "Das ist okay", "Kann ich verstehen", kurzer Satz), DANN erst anderes Thema.';
  // Mehrdeutiger Kontext: Moderator sagte z.B. "es / in deinem Alter / einschränkt" (bezog sich auf Diabetes/Job/Hobby) – Antwort darf nicht "Altersunterschied"/"meinem Alter" einführen, wenn der Kunde nie darüber sprach
  const ambiguousContextStayOnTopicRule = ' Enthaelt der Chat-Verlauf ein kuerzlich besprochenes Thema (z.B. Gesundheit, Diabetes, Beruf, Hobby) und die letzte Moderator-Nachricht mehrdeutige Woerter ("es", "in deinem Alter", "einschraenkt", "stört")? Erwaehnt die zu korrigierende Antwort "Altersunterschied", "meinem Alter", "dich stört der Altersunterschied" oder aehnlich, obwohl der Kunde in seinen Nachrichten NIE ueber Altersunterschied gesprochen hat (sondern z.B. ueber Diabetes)? Wenn ja → Themen-Verwechslung: diesen Teil entfernen oder ersetzen; Antwort soll beim tatsaechlich besprochenen Thema bleiben (z.B. Diabetes/Gesundheit) oder auf die aktuelle Kundennachricht eingehen, nicht ein falsch gedeutetes Thema (Altersunterschied) einbauen.';
  // Treffen: NIEMALS einem konkreten Tag/Ort/Zeit zustimmen – auch bei sexuellen Themen. Wie ausgewichen wird, kennt Mistral aus dem Training.
  const meetingRule = (context.isMeetingSituation === true)
    ? (context.isDirectMeetingRequest === true
      ? ' PFLICHT TREFFEN: Wenn Kontext "Thema Treffen/Bar/Zeit" enthaelt: Die Antwort darf NIEMALS einem konkreten Tag, Uhrzeit oder Ort zustimmen oder diese nennen. Keine weichen Zusagen ("passt gut", "bin flexibel", "am Abend koennten wir"). VERBOTEN bei konkreter Ort/Zeit-Nennung des Kunden (z.B. morgen 09:00, Aldi Parkplatz): "Morgen klingt gut", "Klingt gut", "Passt gut" am Anfang – Kunde koennte das als Zusage verstehen. Stattdessen: "Das wuerde mir gefallen, aber...", "Ich haette mega Lust, aber...", "Kaffee waer schoen, aber..." dann unverbindlich. Unverbindlich/hypothetisch formulieren. Hat der Kunde eine konkrete Orts- oder Zeitangabe gemacht (z.B. "hab frei am Sonntag", "Kaffee treffen", "Hast du Zeit?", "Ort im Kopf")? Dann soll die Nachricht AM ANFANG eine kurze unverbindliche Verfuegbarkeits-Formulierung haben (z.B. "Ich geb dir noch Bescheid ob ich da kann, " oder "Ich schau mal ob es da bei mir klappt, " oder "Da bin ich eigentlich schon verplant aber ich schau mal ob ich da kann, ") – wenn die Antwort so einen Einstieg NICHT hat, am Anfang ergaenzen. Kunde will treffen: VERBOTEN "lass uns erstmal noch schreiben", "erst kennenlernen", "noch ein bisschen schreiben" – nimmt die Hoffnung. Stattdessen: auf seinen Wunsch eingehen (z.B. "will auch nicht ewig nur schreiben", "schaue mal wie es passt", "muessen mal schauen wann es bei uns klappt"). NICHT aktiv nach Ort oder Ideen fragen ("Wo koennten wir treffen?", "Was fuer Ideen?" – verboten). VERBOTEN: "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen", "Was haeltst du davon wenn wir uns einen Tag raussuchen" – zu direkt; ersetzen durch unverbindlich (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es passt"). Erlaubt: andeuten, vage Vorlagen (was zusammen machen, essen gehen); Initiative beim Kunden. VERBOTEN: Meta-Frage "Was denkst du darüber?" – durch thematische Frage zum Treffen ersetzen. Ein Ausweichgrund reicht, kein "besser kennenlernen" doppeln.'
      : ' TREFFEN/VORFREUDE: Der Kunde hat nur Vorfreude geaeussert (keine konkrete Treffen-Anfrage). Enthaelt die Antwort "kennenlernen" oder "erst quatschen" als Ablehnung? Wenn ja → umformulieren: positiv auf die Vorfreude eingehen oder Gegenfrage, wie in Trainingsdaten. Keine Standard-Ablehnung einbauen. Keine Zusage zu Ort/Zeit. Wenn der Kunde positiv zustimmt (z.B. "dann treffen wir uns", "dann brauchen wir uns nur noch treffen") ohne konkrete Zeit: NICHT mit "zu ueberstuerzt", "muss sacken lassen" antworten – wirkt wie Ablehnung. Stattdessen: positiv auf die Idee eingehen (klingt gut, waere schoen) und unverbindlich bleiben. SZENARIO NUR: Enthaelt die Antwort Ablenkung wie "platt", "muede von der Woche", "brauch Ruhe", "wenn du wieder fit bist", "wie wir das umsetzen koennten"? Wenn ja → diese Saetze/Teile entfernen oder umformulieren: beim Thema der Kundennachricht bleiben (z.B. Kuscheln/Fantasie), eine einfache thematische Frage (z.B. "waere das nicht schoen?", "denkst du es wuerde beim Kuscheln bleiben?"). Kein Recyceln alter Kundeninfos (fit, Gesundheit) wenn der Kunde sie in dieser Nachricht nicht anspricht.')
    : '';
  // Jede Nachricht muss eine Frage enthalten (auch im Minimal-Prompt Pflicht) + ganze Kundennachricht abdecken
  const questionAndWholeRule = ' PFLICHT: (1) Jede Nachricht muss eine Frage enthalten. Fehlt eine → eine passende Frage einbauen (z. B. am Ende). (2) Die Antwort MUSS auf die GESAMTE Kundennachricht eingehen – jede Frage, jedes Thema, jede Aussage. Ignoriert die Antwort Teile der Kundennachricht? → kurzen Bezug ergänzen, nichts auslassen.';
  // Mehrere Themen: Wenn Kunde mehrere Beduerfnisse nennt (z.B. Sex + gutes Gespraech + nicht ewig schreiben), jedes mindestens kurz bedienen.
  const multiThemeRule = ' Enthaelt die Kundennachricht mehrere Themen/Beduerfnisse (z.B. Sex + gutes Gespraech wichtig + nicht ewig nur schreiben wollen / absprechen/Anruf)? Ignoriert die Antwort eines davon komplett? Wenn ja → kurzen Satz ergaenzen (z.B. "will auch nicht ewig nur schreiben", "kümmer mich drum", "Gespraech ist mir auch wichtig"), ohne andere Regeln zu verletzen. Nennt der Kunde Vorlieben UND Tabus (z.B. "gerne versaut" und "Tabus habe ich keine außer X") oder fragt "und du?" / ob du Tabus hast? Ignoriert die Antwort Tabus oder die Rueckfrage? Wenn ja → kurzen Bezug zu Tabus und Antwort auf "und du?" ergaenzen (z.B. eigene Tabus/Grenzen nennen), nicht nur auf Vorlieben antworten. Nichts im Raum stehen lassen.';
  // Mehrere Anliegen in einer Nachricht (z.B. Fantasie + Nummer/Frage an Persona): fehlenden Teil natuerlich ergaenzen, keine Abhakliste
  const multiPointNaturalRule = ' Enthaelt die Kundennachricht erkennbar mehrere Anliegen (z.B. Fantasie/Sexuelles UND eine Bitte wie Nummer schicken/Kontakt oder eine Frage an die Persona wie was trägst du, was machst du)? Geht die Antwort nur auf einen Teil ein und laesst das andere komplett aus? Wenn ja → einen kurzen, natuerlichen Bezug zum fehlenden Teil ergaenzen (z.B. bei Nummer/Kontakt: dass du hier erreichbar bist/ungern Nummer im Internet; bei Frage an dich: kurz beantworten). Die Nachricht soll nicht wie eine Abhakliste wirken – nur ergaenzen wenn etwas Wichtiges fehlt, dann locker einbauen.';
  // Treffen: Keine konkrete Zusage, aber unverbindliche Aussicht wie "schaue mal wann es klappt" ist erlaubt (wie in Training-Daten).
  const meetingTreffenAussichtRule = (context.isMeetingSituation === true)
    ? ' TREFFEN: Keine konkrete Zusage zu Tag/Ort/Zeit. Unverbindliche Formulierungen wie "Ich schaue mal wann es klappt", "muss mal schauen wann es bei mir passt", "Dann weiss ich Bescheid" sind ERLAUBT – keine Zusage, aber Kunde kann beruhigt sein. Nicht "nie klappt" oder abweisend. Wie in Training-Daten.'
    : '';
  // Mindestlaenge 120 Zeichen: Korrektor erweitert zu kurze Nachrichten thematisch passend (keine generischen Floskeln)
  const minLengthRule = ' PFLICHT: Die Nachricht muss mindestens 120 Zeichen haben. Ist sie kuerzer: mit einem thematisch passenden Satz oder einer passenden Frage erweitern (zur Kundennachricht und zur Antwort passend), sodass mindestens 120 Zeichen. Keine generischen Fragen wie "Und bei dir so?" – nur inhaltlich passende Erweiterung.';
  // Profil-Dump-Crash: Antwort enthält Aufzählung von Profil-Feldern (Geburtsdatum, Haarfarbe, Augenfarbe, Größe cm, Smoking, Beruf, Tattoo, Home owner, Auto, Sexy) → komplett umschreiben
  const profileDumpRule = ' CRASH-SCHUTZ: Enthaelt die Antwort eine Aufzaehlung von Profil-Attributen (z.B. Geburtsdatum wie 1968 11 08, "Blond hair", "Brown eyes", Koerpergroesse in cm wie 160 169 cm, "Smoking", Beruf wie Chefkassiererin, "Has tattoo", "Home owner", "Auto", "Sexy") statt eines normalen Satzes? Wenn ja → die GESAMTE Antwort verwerfen und neu formulieren: einen kurzen, natuerlichen Satz zur Kundennachricht (z.B. Wohnort-Frage: "Ich wohne in [Stadt]. Woher kommst du denn?" oder thematisch passend), OHNE diese Attribut-Liste. So eine Aufzaehlung darf NIEMALS in der Ausgabe stehen.';
  // Wohnort-Antwort: Wenn erwartete Stadt aus Logbuch übergeben, falsche Stadt in der Antwort ersetzen
  const expectedCityWohnortRule = (context.expectedCityForWohnort && String(context.expectedCityForWohnort).trim())
    ? ` WOHNORT PFLICHT: Die Antwort muss den Wohnort "${String(context.expectedCityForWohnort).trim()}" nennen (aus dem Logbuch). Enthaelt die Antwort einen anderen Ortsnamen (z.B. andere Stadt)? Wenn ja → diesen Ort durch "${String(context.expectedCityForWohnort).trim()}" ersetzen.`
    : '';
  // Beruf: Wenn Profil/Logbuch einen Fake-Beruf vorgeben, Antwort darf keinen anderen nennen (z.B. nicht Apotheke wenn Gemeinschaftspraxis steht)
  const expectedJobRule = (context.expectedFakeJob && String(context.expectedFakeJob).trim())
    ? ` BERUF PFLICHT: Der Beruf der Persona aus Profil/Logbuch ist: "${sanitizeForApiContent(String(context.expectedFakeJob).trim())}". Enthaelt die Antwort einen anderen Beruf oder Arbeitsort fuer die Persona (z.B. "in einer Apotheke", "arbeite in der Apotheke", "in der Klinik", anderes Arbeitsumfeld)? Wenn ja → ersetzen durch diesen korrekten Beruf (z.B. "ich arbeite als ${sanitizeForApiContent(String(context.expectedFakeJob).trim().slice(0, 80))}"). Nur DIESEN Beruf nennen.`
    : '';
  // Wohnort-Frage: Antwort nur "in der Nähe"/"nicht weit weg" ohne konkrete Stadt → konkreten Städtenamen einbauen
  const wohnortConcreteCityRule = ' Fragt die Kundennachricht nach dem Wohnort/Ort der Persona (z.B. "wo wohnst du", "ich wohne in X und du", "woher kommst du")? Enthaelt die Antwort nur vage Formulierungen wie "in der Nähe", "nicht weit weg", "ganz in der Nähe", "in der Gegend" OHNE einen konkreten Städtenamen? Wenn ja → ersetzen: einen konkreten Städtenamen einbauen (plausible Stadt in der Region/Umkreis der Kundenstadt aus dem Verlauf – variiere die Wahl, nicht immer dieselbe Stadt). VERBOTEN: Antwort nur mit "nicht weit weg" oder "in der Nähe" lassen – es muss ein echter Ortsname vorkommen.';
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
  const noHastDuLustRule = ' Enthaelt die Antwort "Hast du Lust, etwas zu X oder Y? Oder vielleicht was anderes?" (essen, trinken, unternehmen)? Klingt wie Einladung fuer JETZT. Wenn ja → ersetzen durch allgemeine/Gewohnheits-Frage (z.B. "Was machst du nach der Arbeit meist so?", "Was tust du dann so Schoenes?", "Magst du nach Feierabend eher essen, trinken oder was anderes?").';
  // Zeit-Zusage immer verboten: Kunde nennt Zeitraum/Tag (z.B. 01.-21.06, Juni, nächste Woche) – Antwort darf NICHT zustimmen ("passt perfekt", "passt gut", "klingt gut"). Gilt auch bei Sex/Fantasy-Kontext.
  const noTimeAgreementRule = ' Hat der Kunde einen Zeitraum, Tag, Ort oder Zeitfenster genannt (z.B. morgen 09:00, Aldi Parkplatz, Sonntag, nächste Woche)? Enthaelt die Antwort eine Zusage oder klingt-so-als-ob-Zustimmung (z.B. "Morgen klingt gut", "Klingt gut", "passt perfekt", "passt gut", "klingt gut", "zwischen X und Y passt", "passt mir")? Wenn ja → umschreiben: keine Zusage; Einstieg mit Abschwaechung wie "Das wuerde mir gefallen, aber...", "Ich haette Lust, aber..." – dann unverbindlich (muss schauen ob es klappt etc.), nicht auf den genannten Zeitraum/Ort zustimmen.';
  const naturalFormulationRule = ' NATUERLICHE FORMULIERUNG: Die Ausgabe muss natürlich und verständlich klingen. Enthaelt die Antwort sinnlose oder unpassende Formulierungen? Z.B.: Alter als "mit [Zahl]" im Satz verwechselt ("Möchtest du mit 53 nicht lieber..."), vulgaere/sexualisierte Wendungen die nicht zum Kontext passen, sinnlose Zahlen-Anhaenge ("00", "11" am Satzende)? Wenn ja → diesen Teil entfernen oder natürlich umformulieren. Wenn die Vorlage bereits natürlich und regelkonform ist → nur minimal korrigieren (Rechtschreibung, klare Verstösse), nicht umschreiben.';

  if (MISTRAL_USE_MINIMAL_PROMPT) {
    // Minimal-Prompt: nur Daten, keine langen Regeln. Eigenes Modell (z. B. Fine-Tune) hat bereits gelernt, wie korrigiert wird – lange Anweisungen würden das Gelernte überschreiben.
    // Bei Kontaktdaten: klare, umsetzbare Anweisung für Mistral (Korrektor hat keinen Zugriff auf Trainingsdaten – nur prüfen und ersetzen).
    const contactRuleMinimal = (context.contactRequest === true)
      ? ' Bei Kontaktdaten-Anfrage: Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten" oder "duerfen nicht"? Wenn ja → diese Formulierungen entfernen und persoenlich ausweichend ersetzen. Sonst Stil beibehalten.'
      : '';
    const noEchoMinimal = ' Du korrigierst NUR die Moderatoren-Antwort. Die Kundennachricht ist nur Kontext. Gib NIEMALS die Kundennachricht oder eine Paraphrase davon als Ausgabe zurueck – die Ausgabe muss eindeutig die Antwort des Fake-Profils sein, keine Wiederholung des Kunden. Falsch: Kundentext leicht umformuliert zurueckgeben. Richtig: nur die Moderatoren-Antwort inhaltlich/stilistisch korrigieren. Die Antwort darf NICHT mit einer Paraphrase oder Aufzaehlung dessen beginnen, was der Kunde gesagt hat – entweder kurze Reaktion (z. B. Das klingt flexibel) oder direkt eigene Aussage/Frage.';
    const toneMinimal = ' Ton der urspruenglichen Antwort (locker, umgangssprachlich) beibehalten – nicht formell oder typisch KI umschreiben.';
    systemContent = 'PFLICHT: Nur die fertige korrigierte Nachricht zurueckgeben, keine Erklaerungen.\n\nDu bist ein Korrektor für Chat-Moderator-Antworten. Gib nur die fertige korrigierte Nachricht zurück, keine Erklärungen, keine Meta-Kommentare.' + toneMinimal + ' Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten, nur klare Fehler korrigieren. Jede Nachricht muss eine Frage enthalten; maximal ein bis zwei Fragen, keine Frage-Kaskade. Mindestens 120 Zeichen – bei kürzerer Nachricht thematisch passend erweitern.' + noEchoMinimal + contactRuleMinimal + focusCurrentMessageRuleMistral + nameAndWohnortRuleMistral + erreichbarkeitRuleMistral + profileDumpRule + expectedCityWohnortRule + expectedJobRule + wohnortConcreteCityRule + customerClarificationRuleMistral + dagegenSexHopeRuleMistral + answerDirectQuestionRuleMistral + treffenFrageIgnoredRuleMistral + naturalFormulationRule + noFalseSingleRule + noTelefonsexPhotoRule + imageRequestDirectionRule + ruckfrageCallbackRule + answerOurQuestionStayOnTopicRule + ambiguousContextStayOnTopicRule + noWiedersehenRule + noSharedPastRule + noTimeAgreementRule + noAbholenRule + noUnaskedAgeTypeComplimentRule + noHastDuLustRule + boundaryConsistencyRule + selfConsistencyRule + noEchoOwnModeratorStatementRule + noRepeatOwnLastMessageRule + censorshipRule + noOftTreffenRule + limitationFollowUpRule + engageOnSuggestionsRule + neutralMessageNoSexRule + meetingRule + meetingTreffenAussichtRule + noTagRaussuchenRule + multiThemeRule + multiPointNaturalRule + questionAndWholeRule + minLengthRule + sameActivityPlaceRule + noParaphraseRule + noVorliebenTabusEchoRule + noPerfekteMomentFrageRule + noParaphraseSchlussfrageRule + noMetaQuestionAboutCustomerActivityRule + noQuestionAlreadyAnsweredRule + noRedundantFactQuestionRule + noKaffeeTreffenFrageRule + noVagueDazuSchlussfrageRule + pureGreetingAnswerRule + noTimeRefusalWithoutMeetingRequestRule + noMeetingSuggestionFromModeratorRule + noRedundantScenarioQuestionRule + noRoleReversalRule + noRepeatNameIfAlreadySaidRuleMistral + useOnlyFirstNameNotUsernameRuleMistral + logbookNoContradictRuleMistral + imageOnlyAnnouncedRule + imageClaimedButNotPresentRule + imageAlreadySentToCustomerRule + noPlaceClaimRule + noStrongHopeRule + customerSingularRule + humanTyposHint;
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht (nur Kontext – nicht ausgeben):\n"${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Moderatoren-Antwort:\n\n${sanitizeForApiContent(grokText.trim())}\n\nGib NUR die korrigierte Moderatoren-Antwort aus. Niemals die Kundennachricht oder eine Paraphrase davon zurueckgeben.`;
    if (process.env.NODE_ENV !== 'production') console.log('🔧 Mistral-Korrektor: Minimal-Prompt (eigenes Modell)');
  } else {
    const contactCheck = context.contactRequest === true ? '\n(6) Kontaktdaten: Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten"? → entfernen/umschreiben. Lehnt die Antwort die Kontakt-Anfrage nicht ab? → persoenlich ausweichend einbauen.' : '';
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht (nur Kontext – nicht ausgeben):\n"${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Moderatoren-Antwort:\n\n${sanitizeForApiContent(grokText.trim())}\n\nKontext nutzen: Chat-Verlauf zeigt, worauf die Kundennachricht sich bezieht. Ist sie eine Klarstellung/Abschwaechung (z.B. \"nur X\", \"nichts Schlimmes\")? Enthaelt die Antwort Trost oder \"nicht dein Tag\"? → ersetzen durch positive Reaktion. Stellt der Kunde eine direkte Frage an die Persona (z.B. was für dich schön ist – oder nach dem Namen: wie heißt du, wie ist dein Name)? Beantwortet die Antwort sie oder gibt sie sie nur zurück? Wenn nicht → zuerst Frage beantworten (bei Namensfrage: Persona-Namen nennen), dann Gegenfrage.\n\nPrüfe die obige Moderatoren-Antwort und korrigiere/verbessere sie:\n(1) PFLICHT: Geht die Antwort auf die GESAMTE Kundennachricht ein – jede Frage, jedes Thema, jede Aussage? Enthaelt die Kundennachricht mehrere Fragen/Themen? Geht die Antwort auf JEDE ein? Wenn eine Frage oder ein Thema fehlt → kurzen Bezug ergaenzen (1 Satz oder Teilsatz), nichts auslassen.\n(2) Enthält die Nachricht eine Frage? Wenn nein → Frage einbauen.\n(3) Hat die Nachricht mindestens 120 Zeichen? Wenn nein → thematisch passend erweitern (keine generischen Floskeln).\n(4) Umlaute (ä,ö,ü) und ss statt ß? Stil/Bindestriche?\n(5) Enthält die Antwort Meta-Kommentare, Echo/Paraphrase der Kundennachricht oder Meta-Fragen wie "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?"? Wenn ja → entfernen bzw. durch konkrete thematische Frage ersetzen, eigenständig formulieren (Kundentext nicht nachplappern).\n(6) Kunde will treffen: Enthält die Antwort "lass uns erstmal noch schreiben", "erst kennenlernen", "noch ein bisschen schreiben" oder Meta-Fragen wie "Was denkst du darüber?"? Wenn ja → umschreiben: auf Treffenwunsch eingehen (z.B. will auch nicht ewig nur schreiben, schaue wie es passt) + konkrete Frage zum moeglichen Treffen (Café, Essen, Vorlieben – variieren), nicht immer dieselbe Formulierung.${contactCheck}\nGib NUR den fertigen korrigierten Text zurück, keine Erklärungen. Niemals die Kundennachricht oder eine Paraphrase davon zurueckgeben.`;

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
    const sexualPerspectiveAndQuestionsRuleMistral = (context.allowSexualContent === true && context.customerTalkingAboutSexWithFake === true)
      ? ' SEX KONTEXT: Echo der Kundenszenario-Formulierung (z.B. "wenn du mir den Ruecken zudrehst") kann missverstaendlich sein → aus Persona-Sicht formulieren (z.B. "wenn ich dir den Ruecken zudrehe"). Schlussfrage bei Sex: Keine generischen/schwachen oder Planungs-Fragen ("Was denkst du wie intensiv das sein koennte?", "Was denkst du wie wir das umsetzen koennten?", "wie wir das am besten umsetzen", "Pizza oder Brüste", "Wie heftig pulsiert...") → ersetzen durch konkrete, flirty Frage die zum Szenario passt (z.B. "wuerde dir das gefallen?", "magst du das?", "und was machst du dann fuer mich?", "denkst du du wuerdest X aushalten?", Stellungen, Tempo, Haerter/Langsamer). Niemals nach "Umsetzung" oder "wie setzen wir das um" klingen.'
      : '';
    const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
      ? (context.contactRequest === true
        ? 'KONTAKTDATEN: (1) Enthaelt die Antwort "nicht erlaubt", "Regeln", "Plattform", "echte Kontaktdaten verboten" oder "duerfen nicht"? Wenn ja → diese Formulierungen entfernen und persoenlich ausweichend ersetzen. (2) Lehnt die Antwort die Kontakt-Anfrage nicht ab? Wenn ja → persoenlich ausweichend einbauen (keine Nummer/Telegram nennen). Sachlich, thematisch passende Frage am Ende.'
        : 'Bei gereiztem Kunden: Antwort sachlich und deeskalierend, thematisch passende Frage am Ende.')
      : '';
    const metaRule = 'KEINE Meta-Kommentare, keine internen Notizen, keine Erklaerungen – ausschliesslich die eine Chat-Nachricht ausgeben.';
    const noMetaPhrasesRuleMistral = ' Formulierungen wie "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?", "Was waere fuer dich der perfekte Moment fuer Doggy/Reiterstellung/...", "Was denkst du wie wir das umsetzen koennten?", "wie wir das am besten umsetzen" sind verboten – durch konkrete, thematisch passende Fragen ersetzen (bei Sex: flirty, z.B. "wuerde dir das gefallen?", "magst du das?").';
    const noGenericOpenAIPhrasesRule = ' GENERISCHER KI-TON: Enthaelt die Antwort typische Floskeln wie "klingt echt spannend", "ich stell mir vor wie wir uns näherkommen", "du mich richtig verwöhnst", "was würdest du denn als erstes mit mir anstellen?" (formelhaft)? Wenn ja → etwas zurueckhaltender und natürlicher umformulieren: kurze Reaktion + konkrete Frage, Stil an Beispiele anpassen, nicht formelhaft oder aufgedreht.';
    const noEchoRule = ' Du korrigierst NUR die Moderatoren-Antwort; die Kundennachricht ist nur Kontext. Gib NIEMALS die Kundennachricht oder eine Paraphrase davon als Ausgabe zurueck – die Ausgabe muss eindeutig die Antwort des Fake-Profils sein. Wiederhole die Kundennachricht NICHT woertlich oder fast woertlich; formuliere eigenstaendig (z.B. nicht "dass du mich so X findest" wenn der Kunde "du bist so X" schrieb). Falsch: Kundentext leicht umformuliert zurueckgeben. Richtig: nur die Moderatoren-Antwort korrigieren. Bei Echo/Paraphrase → ersetzen durch eigenstaendige Reaktion.';
    const toneRuleMistral = ' TON: Die urspruengliche Antwort ist locker/umgangssprachlich. Korrektur darf den Ton NICHT formell oder typisch "KI" machen – Stimmung und Wortwahl beibehalten, nur klare Regelverstoesse aendern, nicht glaetten oder umformulieren.';
    systemContent = `PFLICHT: Nur die fertige korrigierte Nachricht ausgeben, keine Erklaerungen.

Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide immer anhand des gesamten Kontexts und der Kundennachricht.${toneRuleMistral} ${sexualRule} ${sexualPerspectiveAndQuestionsRuleMistral} ${contactIrritatedRule}${meetingRule} ${meetingTreffenAussichtRule} ${focusCurrentMessageRuleMistral} ${nameAndWohnortRuleMistral} ${erreichbarkeitRuleMistral} ${profileDumpRule} ${expectedCityWohnortRule} ${expectedJobRule} ${wohnortConcreteCityRule} ${customerClarificationRuleMistral} ${dagegenSexHopeRuleMistral} ${answerDirectQuestionRuleMistral} ${treffenFrageIgnoredRuleMistral} ${naturalFormulationRule} ${multiThemeRule} ${multiPointNaturalRule} ${noFalseSingleRule} ${noTelefonsexPhotoRule} ${imageRequestDirectionRule} ${ruckfrageCallbackRule} ${answerOurQuestionStayOnTopicRule} ${ambiguousContextStayOnTopicRule} ${noWiedersehenRule} ${noSharedPastRule} ${noTimeAgreementRule} ${noAbholenRule} ${noUnaskedAgeTypeComplimentRule} ${noHastDuLustRule} ${boundaryConsistencyRule} ${selfConsistencyRule} ${noEchoOwnModeratorStatementRule} ${noRepeatOwnLastMessageRule} ${censorshipRule} ${noOftTreffenRule} ${limitationFollowUpRule} ${engageOnSuggestionsRule} ${metaRule} ${noMetaPhrasesRuleMistral} ${noGenericOpenAIPhrasesRule} ${noEchoRule}${noVorliebenTabusEchoRule} ${noPerfekteMomentFrageRule} ${noParaphraseSchlussfrageRule} ${noMetaQuestionAboutCustomerActivityRule} ${noQuestionAlreadyAnsweredRule} ${noRedundantFactQuestionRule} ${noRedundantScenarioQuestionRule} ${noRoleReversalRule} ${noKaffeeTreffenFrageRule} ${noMeetingSuggestionFromModeratorRule} ${noRepeatNameIfAlreadySaidRuleMistral} ${useOnlyFirstNameNotUsernameRuleMistral} ${questionAndWholeRule}${minLengthRule}${sameActivityPlaceRule}${noParaphraseRule}${imageOnlyAnnouncedRule}${imageClaimedButNotPresentRule}${imageAlreadySentToCustomerRule}${customerSingularRule} Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten, nur klare Fehler korrigieren. Jede Nachricht muss eine Frage enthalten; maximal ein bis zwei Fragen, keine Frage-Kaskade.${humanTyposHint} PFLICHT: Jede Nachricht muss eine Frage enthalten. Fehlt eine Frage, fuege UNBEDINGT eine kurze, thematisch passende Frage ein (z. B. am Ende). Die Antwort MUSS mindestens 120 Zeichen haben – bei kürzerer Nachricht thematisch passend erweitern (keine generischen Floskeln). Die Antwort MUSS auf die Kundennachricht eingehen. Fragt der Kunde "woher weisst du das" etc.? → Antwort muss darauf eingehen, nicht themenfremd. Enthaelt die Antwort Telefonsex- oder Foto-Vorschlaege? → entfernen. Wenn etwas zu korrigieren ist (fehlende Frage, kein Bezug, Rueckfrage ignoriert, Telefonsex/Fotos, Beziehungsstatus falsch, Kontaktdaten nicht abgelehnt, Meta/Wiederholung, Umlaute/ss, Stil), aendere es. Schreibe mit ä, ö, ü. Immer ss, nie ß. Keine Anführungszeichen. Keine Bindestriche. Keine Doppelpunkte – stattdessen Komma (z.B. "hör zu," nicht "hör zu:"). Antworte NUR mit der fertigen korrigierten Nachricht – kein anderer Text.`;
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

  const hasClarificationNur = /\bnur\s+[\wäöüß-]+/i.test(fullCustomerMsg);
  const customerClarificationRuleOpenAI = hasClarificationNur
    ? ' Kunde hat mit "nur X" klargestellt (z.B. nur Zahnreinigung = Routine, nichts Schlimmes). Enthaelt die Antwort Trost oder negative Deutung ("nicht dein Tag", "wird schon wieder", "das wird wieder")? → ersetzen durch positive, lockere Reaktion auf die Klarstellung (z.B. dass es nur Routine ist), keine Trost-Formulierung.'
    : '';
  const hasDagegenSexHope = /gehofft|hoffte/i.test(fullCustomerMsg) && /dagegen/i.test(fullCustomerMsg) && /sex|haettet|hätten/i.test(fullCustomerMsg);
  const dagegenSexHopeRuleOpenAI = hasDagegenSexHope
    ? ' Kunde sagt er habe gehofft du waerst DAGEGEN und dass ihr Sex haettet. Enthaelt die Antwort nur generisches Treffen/Chemie ("wir uns sehen", "Chemie spüren") ohne auf seinen Wunsch einzugehen? → ersetzen: Hoffnung anerkennen, Verstaendnis (z.B. kann Samstag nicht), dass er Druck ablassen muss – und KLAR sagen am liebsten mit ihm / das mit ihm machen.'
    : '';
  const hasNameQuestionOpenAI = /\b(wie hei[ßs]t du\??|wie ist dein name\??|was ist dein name\??|wie hei[ßs]en sie\??|wie hei[ßs]t ihr\??)\b/i.test(fullCustomerMsg);
  const hasWieGehtEsDirOpenAI = /\b(wie geht es dir|wie gehts dir|wie geht\'s dir|wie geht es dir denn)\b/i.test(fullCustomerMsg);
  const hasTreffenFrageOpenAI = /\b(treffen\s+wir\s+uns|sehen\s+wir\s+uns|wann\s+treffen|wann\s+sehen|treffen\s+heute|heute\s+treffen|sollen\s+wir\s+uns\s+treffen|k[oö]nnen\s+wir\s+uns\s+treffen|wann\s+k[oö]nnen\s+wir|treffen\s+wir\s+uns\s+heute)\b/i.test(fullCustomerMsg);
  const hasWasMachstDuHeuteOpenAI = /\b(was\s+machst\s+du\s+(heute|mit\s+deiner\s+zeit|den\s+ganzen\s+tag)|was\s+hast\s+du\s+vor\b|wie\s+verbringst\s+du\s+(den\s+tag|heute)|was\s+machst\s+du\s+heute\s+noch)\b/i.test(fullCustomerMsg);
  const hasDirectQuestionToPersonaOpenAI = hasNameQuestionOpenAI || hasWieGehtEsDirOpenAI || hasTreffenFrageOpenAI || hasWasMachstDuHeuteOpenAI || /\b(für dich|für dich\?|was macht .* für dich|was suchst du|wie oft|was wäre für dich|besonders schön für dich)\b/i.test(fullCustomerMsg) || (/\?/.test(fullCustomerMsg) && /\b(dich|dir|du)\b/i.test(fullCustomerMsg));
  const erreichbarkeitRuleOpenAI = (context.askForErreichbarkeit === true)
    ? ' ERREICHBARKEIT (PLATTFORM): Der Kunde hat gefragt, wo/wie er dich erreichen kann (z.B. "wo kann ich dich erreichen?"). Die Antwort MUSS diese Frage beantworten (z.B. "Du kannst mich hier erreichen", "Hier im Chat", "einfach hier schreiben"). Enthaelt die Antwort KEINEN solchen Bezug (hier, im Chat, hier erreichen)? Dann AM ANFANG der Antwort einen kurzen Satz einfuegen: z.B. "Du kannst mich hier erreichen. " oder "Hier im Chat erreichst du mich. " – dann den bisherigen Antworttext. Danach auf den Rest der Kundennachricht eingehen.'
    : '';
  const answerDirectQuestionRuleOpenAI = hasDirectQuestionToPersonaOpenAI
    ? ' PFLICHT: Die AKTUELLE Kundennachricht enthaelt eine direkte Frage an die Persona (z.B. wie geht es dir, wie heisst du, was machst du – oder "was machst du heute?", "was hast du vor?", "wie verbringst du den Tag?" – oder Treffen). Beantwortet die Antwort diese Frage oder ignoriert sie? Fragen oft am ENDE langer Nachrichten – auch dann beantworten. Bei "was machst du heute"/"was hast du vor": kurz etwas Passendes nennen, NICHT ignorieren. Bei Treffen-Frage: kurz unverbindlich. Sonst: zuerst Frage beantworten, dann Gegenfrage.'
    : '';
  const treffenFrageIgnoredRuleOpenAI = hasTreffenFrageOpenAI
    ? ' TREFFEN-FRAGE IGNORIERT: Kunde fragt nach Treffen (z.B. "Treffen wir uns heute?", "Wann sehen wir uns?") und die Antwort geht NICHT darauf ein (kein "heute klappt nicht", kein "muss schauen", kein "passt heute nicht", kein unverbindliches Abblocken)? Dann AM ANFANG der Antwort einen kurzen Satz einfuegen: z.B. "Heute klappt es leider nicht, aber " oder "Muss schauen wann es passt – " dann den bisherigen Antworttext. Die Treffen-Frage darf nie ignoriert werden.'
    : '';
  const hasNameOrWohnortRequestOpenAI = context.askForNameOrWohnort === true || /\b(vornamen?|name)\s+und\s+wohnort\b|\bwohnort\s+und\s+(vornamen?|name)\b|\b(deinen?|dein)\s+(vornamen?|wohnort)\b|\bdenkst\s+du\s+noch\s+an\s+(deinen?\s+)?(vornamen?|wohnort)\b/i.test(fullCustomerMsg);
  const fnOpenAI = (context.fakeFirstName && String(context.fakeFirstName).trim()) || '';
  const fcOpenAI = (context.fakeCityForAnswer && String(context.fakeCityForAnswer).trim()) || '';
  const nameAndWohnortRuleOpenAI = (hasNameOrWohnortRequestOpenAI && (fnOpenAI || fcOpenAI))
    ? ' PFLICHT NAME/WOHNORT: Der Kunde hat nach Vorname und/oder Wohnort gefragt (z.B. "Vornamen und Wohnort", "wo wohnst du", "wie heisst du"). Die Antwort MUSS diese Fragen beantworten' + (fnOpenAI ? ': Vorname "' + fnOpenAI + '" nennen' : '') + (fcOpenAI ? (fnOpenAI ? ', Wohnort "' + fcOpenAI + '" nennen' : ': Wohnort "' + fcOpenAI + '" nennen') : '') + '. Enthaelt die Antwort den Vornamen und/oder den Wohnort NICHT (oder nur eines davon obwohl beides gefragt)? Dann AM ANFANG der Antwort ergaenzen (z.B. "Ich bin ' + (fnOpenAI || '[Vorname]') + ', wohne in ' + (fcOpenAI || '[Stadt]') + '. ..." oder "Ich heisse ' + (fnOpenAI || '[Vorname]') + ', komme aus ' + (fcOpenAI || '[Stadt]') + '. ..."). Nicht nur auf andere Themen (z.B. Fotos, Arbeit) eingehen und Name/Wohnort weglassen.'
    : '';
  const focusCurrentMessageRuleOpenAI = ' FOKUS AKTUELLE KUNDENNACHRICHT: Die Antwort muss sich auf die AKTUELLE (letzte) Kundennachricht konzentrieren. Chat-Verlauf nur zum Verstaendnis und fuer Bezuege – Themen aus frueheren Nachrichten (z.B. Foto-Anfrage) hat der letzte Moderator bereits beantwortet. Nicht erneut darauf antworten oder zum Hauptthema machen. Aktuelle Nachricht fragt z.B. nach Name und Wohnort → Antwort muss Name und Wohnort nennen; andere Themen aus dem Verlauf sekundaer oder schon beantwortet. Kontext = Verstehen; Antwort = auf die aktuelle Nachricht.';
  const noRepeatNameIfAlreadySaidRuleOpenAI = ' Hat die LETZTE Moderator-Nachricht im Chat-Verlauf bereits den Vornamen der Persona genannt (z.B. "Ich bin Justine", "Ich heisse X") oder spricht der Kunde die Persona mit diesem Namen an (z.B. "liebe Justine", "Hey Justine")? Enthaelt die Antwort trotzdem "Ich heisse [Name]" oder "Ich bin [Name]"? Wenn ja → diesen Teil entfernen oder durch kurze Bestaetigung ersetzen (z.B. "Ja, genau.", "Freut mich."), keine erneute Namensnennung.';
  const useOnlyFirstNameNotUsernameRuleOpenAI = (context.fakeFirstName && context.fakeDisplayNameOrUsername)
    ? ` PFLICHT NAME: Der Vorname der Persona ist "${String(context.fakeFirstName).trim()}". Enthaelt die Antwort "Ich heisse ${String(context.fakeDisplayNameOrUsername).trim()}" oder den Benutzernamen/Anzeigenamen "${String(context.fakeDisplayNameOrUsername).trim()}"? Wenn ja → ersetzen durch "${String(context.fakeFirstName).trim()}" oder Vorstellung weglassen wenn Name schon bekannt. Niemals Benutzernamen/Anzeigenamen im Chat nennen.`
    : (context.fakeFirstName ? ` PFLICHT NAME: Wenn die Antwort den Namen der Persona nennt, muss es der Vorname "${String(context.fakeFirstName).trim()}" sein – nie einen anderen Namen (z.B. Benutzername).` : '');
  const logbookNoContradictRuleOpenAI = (context.logbookSaysJungfrau || context.logbookSaysSchwanger)
    ? (context.logbookSaysJungfrau ? ' LOGBUCH: "Jungfrau" steht im Fake-Logbuch. Enthaelt die Antwort "keine Jungfrau mehr", "habe schon Sex gehabt", "Jungfernschaft verloren", "entjungfert"? Wenn ja → umschreiben: Persona ist jungfraeulich, Antwort muss dazu passen.' : '') + (context.logbookSaysSchwanger ? ' LOGBUCH: Schwangerschaft steht im Fake-Logbuch. Widerspricht die Antwort dem? Wenn ja → umschreiben: Persona ist schwanger.' : '')
    : '';
  const neutralMessageNoSexRule = (context.allowSexualContent !== true)
    ? ' Wenn die AKTUELLE Kundennachricht keine sexuellen Themen enthaelt, entferne/entschaerfe explizite sexuelle Formulierungen in der Antwort.'
    : '';
  const humanTyposHint = ' Optional: vereinzelt leichte Tippfehler (Komma, Buchstabe) – nicht bei jeder Nachricht.';
  const sameActivityPlaceRule = ' Behauptet die Antwort, die Persona mache dieselbe Aktivitaet am selben Ort/Zeit wie der Kunde? Wenn ja → umformulieren, nur Interesse zeigen (klingt toll), NICHT behaupten man sei dort.';
  const noParaphraseRule = ' Antwort darf die Kundennachricht nicht nur zusammenfassen oder seine Details nachplappern. Kurz bestaetigen, eigene Aussage + Frage.';
  const echoReplaceRule = ' Enthaelt die Antwort ein Echo oder Paraphrase der Kundennachricht (z.B. seinen Wunsch/Szenario in unseren Worten zurueckgeben wie "wenn du so genussvoll eine Frau verwöhnen würdest…")? Wenn ja → diesen Teil ERSETZEN durch eigenstaendige Reaktion (eigene Aussage, Gefuehl, Frage), Kundentext weder woertlich noch sinngemaess zurueckgeben. Bei sexuellen Themen: Konkrete Begriffe/Koerperteile/Handlungen des Kunden NICHT 1:1 uebernehmen – in eigenen Worten reagieren, sein Vokabular nicht spiegeln.';
  const noQuestionAlreadyAnsweredRule = ' Hat der Kunde in seiner Nachricht bereits gesagt was er geben/zeigen/tun will (z.B. "dann kriegste was tolles", "zeig dir auch was")? Enthaelt die Antwort "Was bekommst du dafuer?", "Zeigst du mir auch was?", "Was krieg ich dafuer?"? Wenn ja → diese Frage entfernen/ersetzen durch Reaktion auf sein Angebot oder andere thematische Frage.';
  const noMetaPhrasesRule = ' VERBOTEN: Meta-Kommentare wie "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?", "Was waere fuer dich der perfekte Moment fuer Doggy/Reiterstellung/...", "Was denkst du wie wir das umsetzen koennten?", "wie wir das am besten umsetzen" – wirken wie Buero/Planung, nicht wie Flirt. Stattdessen: konkrete thematische Fragen (bei Sex: flirty, z.B. "wuerde dir das gefallen?", "magst du das?"; zum Treffen, zu Vorlieben, zur Situation).';
  const noGenericOpenAIPhrasesRuleOpenAI = ' GENERISCHER KI-TON: Enthaelt die Antwort Floskeln wie "klingt echt spannend", "ich stell mir vor wie wir uns näherkommen", "du mich richtig verwöhnst", "was würdest du denn als erstes mit mir anstellen?" (formelhaft)? Wenn ja → zurueckhaltender und natürlicher umformulieren: kurze Reaktion + konkrete Frage, nicht formelhaft.';
  const noVorliebenTabusEchoRuleOpenAI = ' Hat der Kunde Vorlieben/Tabus aufgelistet (DT, 69, anal, Doggy, Tabus SM, BDSM etc.)? Listet die Antwort dieselben Begriffe auf ("DT tief und fest, 69 und anal... deine Tabus sind genau meine")? → kuerzen, nur kurze Reaktion + eigene Aussage + eine thematische Frage.';
  const noPerfekteMomentFrageRuleOpenAI = ' Enthaelt die Antwort "Was waere fuer dich der perfekte Moment fuer Doggy/Reiterstellung/..."? → diese Frage ersetzen durch konkrete thematische Frage (z.B. "Und dann?", "Haerter oder langsamer?").';
  const noParaphraseSchlussfrageRuleOpenAI = ' Ist die Schlussfrage nur Paraphrase der Kundennachricht (z.B. er nannte X und Y, Antwort fragt "Was machst du mit X und Y?")? → ersetzen durch Frage nach Stimmung/Vorfreude/Gefuehl (z.B. "Freust du dich schon auf Abend?", "Wie gehts dir mit dem langen Tag?").';
  const noMetaQuestionAboutCustomerActivityRuleOpenAI = ' KEINE META-FRAGE ZUR KUNDENAKTIVITAET: Hat der Kunde gerade erzaehlt was ER macht (z.B. Einkaufen, Arbeit, "ich werde einkaufen gehen")? Enthaelt die Schlussfrage der Antwort eine Rueckfrage genau zu DIESER Aktivitaet (z.B. "Was hast du dir fuer den Einkauf vorgenommen?", "Was erhoffst du dir von deinem Einkauf?")? Wirkt wie Interview. Wenn ja → diese Frage ersetzen durch natuerliche Gegenfrage (z.B. nach Stimmung, nach ihm allgemein – nicht seine gerade genannte Aktivitaet in eine Frage verpacken).';
  // Kunde hat bereits Wohnort/Stadt, Beruf etc. genannt – Antwort darf nicht danach fragen oder bestätigend zurückfragen
  const noRedundantFactQuestionRuleOpenAI = ' Hat der Kunde in seiner Nachricht bereits eine konkrete Information genannt (z.B. Wohnort/Stadt, Filmtitel/Serie, Beruf, was er gerade macht/schaut)? (1) Endet die Antwort mit einer Frage, die genau danach fragt (z.B. "Woher kommst du?", "Was schaust du?", "Was machst du beruflich?")? ODER (2) enthaelt die Antwort eine bestaetigende Rueckfrage zum gerade vom Kunden genannten Ort (z.B. "Und du kommst aus Berlin Spandau?", "Du kommst aus [Ort], oder?", "Du wohnst in [Ort], oder?")? Wenn ja → diese Schlussfrage bzw. Bestaetigung entfernen oder durch eine andere, nicht-redundante Frage ersetzen (z.B. zum Treffen, Stimmung, Details, Vorlieben). Nicht nach etwas fragen, das der Kunde gerade gesagt hat.';
  const noRedundantScenarioQuestionRuleOpenAI = ' Hat der Kunde in seiner Nachricht beschrieben was er (mit der Persona) machen wuerde (Szenario, Ablauf, Handlung, Position – z.B. doggy nehmen, lecken, fingern, küssen)? Enthaelt die Antwort eine Frage, die genau diese Handlung/Position zurueckfragt (z.B. "Wuerdest du mich doggy nehmen?", "Willst du mich lecken?", "Wuerdest du mich gerne noch doggy nehmen?")? Wenn ja → diese Frage entfernen oder durch eine nicht-redundante Frage ersetzen (z.B. Tempo, was danach, Stimmung, andere Position). Rest der Nachricht bleibt.';
  const noRoleReversalRuleOpenAI = ' Fragt die Kundennachricht danach, wo/wann/was DU (Persona) getan oder gesagt hast (z.B. "wo warst du?", "wo bist du an mir vorbei gejoggt?", "wo hast du X?")? Enthaelt die Antwort eine Rueckfrage an den Kunden, die dieselbe Sache von IHM wissen will (z.B. "wo bist du an mir vorbei gejoggt?", "wo warst du?")? Rollenvertauschung – Kunde hat DICH gefragt. Wenn ja → Rueckfrage ersetzen durch Antwort aus Persona-Sicht (z.B. "Ich war in [Ort]/jogge oft in [Gegend]" + andere Gegenfrage).';
  const noVagueDazuSchlussfrageRuleOpenAI = ' SCHLUSSFRAGE KLAR BEZIEHEN: Enthaelt die letzte Frage der Antwort vage Woerter wie "dazu", "daran", "damit" (z.B. "was trinkst du gerne dazu?", "was magst du daran?", "was haeltst du davon?"), ohne dass aus der Kundennachricht eindeutig hervorgeht worauf sich "dazu/daran/damit" bezieht? Oder ist die Schlussfrage eine generische Praeferenzfrage (z.B. nur wegen Stichwort Kaffee nach "was trinkst du dazu?") die nicht zum Gesagten passt? Wenn ja → diese Schlussfrage ersetzen durch eine konkrete Frage, die sich klar auf das bezieht was der Kunde gesagt hat oder auf das Gespraechsthema (z.B. Stimmung, naechster Schritt, Vorlieben im Kontext) – nie unklare Füllfragen.';
  const pureGreetingAnswerRuleOpenAI = (context.isPureGreetingMessage === true)
    ? ' BEGRUESSUNG ALS KUNDENNACHRICHT: Die Kundennachricht ist nur eine Begruessung (Hey, Hi, Hallo o.ae.). Enthaelt die Antwort starke romantische/emotionale Formulierungen (z.B. "Gefuehle", "Herz", "in deinen Armen", "zaubert mir ein Laecheln", "was wuerdest du mit mir machen", "spuere diese Gefuehle") oder spinnt das Thema Treffen/Gefuehle fort? Wenn ja → ersetzen durch kurze Begruessung zurueck (z.B. Hallo [Name], Hey) + 1–2 normale Tagesfragen (wie gehts dir, gut geschlafen, wie laeuft die Arbeit, was machst du gerade). Bei reiner Begruessung neutral und alltaeglich antworten.'
    : '';
  const noTimeRefusalWithoutMeetingRequestRuleOpenAI = (context.isDirectMeetingRequest !== true)
    ? ' KEINE ZEIT-ABLEHNUNG OHNE TREFFEN-ANFRAGE: Hat der Kunde KEINE konkrete Treffen-Anfrage gestellt? Beginnt die Antwort mit "Heute habe ich leider...", "Heute klappt es nicht...", "Heute passt nicht...", "Muss schauen wann..."? Wenn ja → diesen Einstieg entfernen, Antwort mit dem naechsten Satz beginnen (direkt auf Lust/Vorlieben/Thema eingehen).'
    : '';
  const noMeetingSuggestionFromModeratorRuleOpenAI = (context.isDirectMeetingRequest !== true)
    ? ' KEIN EIGENER TREFFEN-VORSCHLAG: Hat der Kunde in seiner Nachricht NICHT explizit nach Treffen/Date gefragt oder es vorgeschlagen? Enthaelt die Antwort einen VORSCHLAG der Persona zum Treffen (z.B. "wir koennten uns treffen", "vielleicht koennten wir uns treffen", "lass uns mal treffen", "koennten wir uns kennenlernen", "wir koennen uns ja mal treffen", "wie waers wenn wir uns treffen", "sollen wir uns mal treffen")? Wenn ja → diesen Satz/Teil entfernen oder umformulieren (z.B. Frage was er gern machen wuerde, inhaltliche Antwort ohne eigenen Treffen-Vorschlag). Rest der Nachricht bleibt; nur der EIGENE Vorschlag der Persona darf nicht drinstehen.'
    : '';
  const imageOnlyAnnouncedRule = (context.imageOnlyAnnounced === true)
    ? ' BILD NUR ANGEKUENDIGT: "Danke fuer das Bild" oder Bewertung → entfernen/ersetzen durch Vorfreude (freue mich drauf).'
    : '';
  const imageClaimedButNotPresentRule = (context.imageClaimedButNotPresent === true)
    ? ' BILD BEHAUPTET, ABER NICHT DA: Kunde behauptet Bild geschickt – keins angekommen. Reaktion auf ein Bild ("dein Bild", Bewertung)? → ersetzen durch: kein Bild angekommen, ggf. bitten nochmal zu schicken.'
    : '';
  const imageAlreadySentToCustomerRuleOpenAI = (context.imageAlreadySentToCustomer === true)
    ? ' BILD BEREITS GESCHICKT: Du hast dem Kunden in deiner letzten Nachricht bereits ein Bild geschickt – er hat es gesehen. Enthaelt die Antwort "Foto finde ich nicht", "Handy macht Zicken mit der Kamera", "wenn ich dir eins schicken koennte" o.ae.? → diesen Teil entfernen, auf das eingehen was der Kunde JETZT schreibt.'
    : '';
  const noPlaceClaimRule = ' Ort (Café, Bar) vom Kunden genannt und Antwort behauptet "mag/kenne ich auch"? → umformulieren, hoechstens allgemein (klingt nett).';
  const noStrongHopeRule = ' Starke Vorfreude (z.B. "freue mich schon auf das Wochenende mit dir")? → zurueckhaltender umformulieren.';
  const noWiedersehenRule = ' PFLICHT: "wiedersehen", "wiederzusehen", "wenn wir uns wiedersehen" ODER "nächstes Mal sehen", "wenn wir uns das nächste Mal sehen", "beim nächsten Mal" (Treffen-Kontext) → ersetzen durch "wenn wir uns (mal) sehen", "wenn wir uns treffen", "wenn es so weit ist" (ihr habt euch NIE getroffen).';
  const noSharedPastRule = ' Antwort darf nicht so tun, als haette der Kunde DICH schon erlebt (Kunde und Fake haben sich nie getroffen).';
  const boundaryConsistencyRule = ' Letzte Moderatoren-Nachricht enthielt Ablehnung/Grenze? → naechste Antwort darf diese nicht aufheben oder abgelehntes Szenario wieder einbauen.';
  const selfConsistencyRule = ' Vorherige Moderator-Nachricht enthielt Aussage ueber Persona (Essen, Ort, Aktivitaet)? → Antwort muss konsistent bleiben, nicht widersprechen.';
  const noEchoOwnModeratorStatementRule = ' LETZTE Moderator-Nachricht enthielt Aussage ueber Persona (z.B. Wohnort "ich bin aus X")? Antwort darf das NICHT als Kundenwissen bestaetigen ("geil dass du das weisst", "ja ich bin aus X" wiederholen) – auf das eingehen, was der Kunde WIRKLICH geschrieben hat.';
  const noRepeatOwnLastMessageRuleOpenAI = ' LETZTE Moderator-Nachricht enthielt Fakten/Infos (z.B. Schwester Donnerstag, Geburtstag Samstag)? Antwort wiederholt dieselben Infos? → diesen Teil entfernen, nur auf Kundennachricht eingehen, keine Wiederholung der eigenen letzten Nachricht.';
  const limitationFollowUpRule = ' Kunde aeussert Einschraenkung/Problem? → Antwort soll nachfragen (warum? was spricht dagegen?), nicht nur bestaetigen und Thema wechseln.';
  const engageOnSuggestionsRule = ' Kunde hat konkrete Vorschlaege genannt (Kino, Kaffee, kochen)? → auf seine Ideen eingehen, sagen was dir gefaellt, nicht dieselben Ideen als Aufzaehlung zurueckgeben.';
  const customerSingularRule = (context.fakeIsPlural === true) ? ' Kunde ist EINE Person: "ihr"/"euch" → du/dich/dir.' : '';
  const singleProfileNoWirRule = (context.fakeIsPlural === false) ? ' EINZELPROFIL: "wir"/"uns"/"unsere" in Bezug auf Persona → ich/mich/meine.' : '';
  const noFalseSingleRule = (context.isNonSingle === true && context.fakeRelationshipStatus)
    ? ` PFLICHT: Fake ist ${sanitizeForApiContent(context.fakeRelationshipStatus)}. "single"/"keinen Partner" → ersetzen durch tatsaechlichen Status.`
    : '';
  const noTelefonsexPhotoRule = ' PFLICHT: Telefonsex-, Foto-Vorschlaege → entfernen, durch andere Argumente ersetzen (Fantasie, Kennenlernen im Chat).';
  const imageRequestDirectionRuleOpenAI = ' BILDER-ANFRAGE RICHTUNG: Bittet die Kundennachricht DICH (Persona), ein Foto/Selfie zu schicken (z.B. "willst du mir ein Selfie schicken", "schick mir ein Foto", "kannst du mir ein Bild schicken")? Enthaelt die Antwort "wuerde mich freuen dein Selfie zu sehen", "freue mich auf dein Bild" o.ae. – also als wuerde der Kunde DIR schicken? Richtungsvertauschung. Wenn ja → ersetzen durch freundliches Ausweichen: Persona schickt keine Fotos (schick keine Fotos im Internet, hier schick ich keine – locker), Rest der Nachricht beibehalten.';
  const ruckfrageCallbackRule = ' Kunde fragt auf letzte Moderatoren-Nachricht zurueck ("woher weisst du das")? → Antwort muss DIREKT darauf eingehen, nicht themenfremd wechseln.';
  const answerOurQuestionStayOnTopicRuleOpenAI = ' Letzte Moderator-Nachricht war eine FRAGE an den Kunden (z.B. Absichten, "Weisst du das schon?", "was haettest du vor?") und Kundennachricht ist kurze ANTWORT (z.B. "Nein", "Weiss ich noch nicht", "Klingt gut")? Geht die Antwort ZUERST darauf ein – oder springt sie zu aelterem Thema (Kaffeetreffen, Ort, "wann es passt")? Wenn Thema-Wechsel ohne Bezug auf Kundenantwort → umschreiben: zuerst auf Kundenantwort eingehen (z.B. "Das ist okay", "Kann ich verstehen"), dann anderes Thema.';
  const ambiguousContextStayOnTopicRuleOpenAI = ' Kontext-Verwechslung: Verlauf enthaelt kuerzlich besprochenes Thema (z.B. Gesundheit, Diabetes, Beruf, Hobby) und letzte Moderator-Nachricht hatte "es"/"in deinem Alter"/"einschraenkt". Enthaelt die Antwort "Altersunterschied", "meinem Alter", "dich stört der Altersunterschied", obwohl der Kunde NIE ueber Altersunterschied sprach? Wenn ja → diesen Teil entfernen/ersetzen, beim tatsaechlich besprochenen Thema bleiben (z.B. Diabetes), kein falsches Thema (Altersunterschied) einbauen.';
  const profileDumpRuleOpenAI = ' CRASH-SCHUTZ: Enthaelt die Antwort eine Aufzaehlung von Profil-Attributen (z.B. Geburtsdatum wie 1968 11 08, "Blond hair", "Brown eyes", Koerpergroesse in cm wie 160 169 cm, "Smoking", Beruf wie Chefkassiererin, "Has tattoo", "Home owner", "Auto", "Sexy") statt eines normalen Satzes? Wenn ja → die GESAMTE Antwort verwerfen und neu formulieren: einen kurzen, natuerlichen Satz zur Kundennachricht (z.B. Wohnort-Frage: "Ich wohne in [Stadt]. Woher kommst du denn?" oder thematisch passend), OHNE diese Attribut-Liste. So eine Aufzaehlung darf NIEMALS in der Ausgabe stehen.';
  const expectedCityWohnortRuleOpenAI = (context.expectedCityForWohnort && String(context.expectedCityForWohnort).trim())
    ? ` WOHNORT PFLICHT: Antwort muss den Wohnort "${String(context.expectedCityForWohnort).trim()}" nennen. Anderen Ortsnamen → durch diesen ersetzen.`
    : '';
  const expectedJobRuleOpenAI = (context.expectedFakeJob && String(context.expectedFakeJob).trim())
    ? ` BERUF PFLICHT: Beruf der Persona aus Profil/Logbuch ist: "${sanitizeForApiContent(String(context.expectedFakeJob).trim())}". Enthaelt die Antwort einen anderen Beruf/Arbeitsort fuer die Persona (z.B. "in einer Apotheke", "in der Klinik")? Wenn ja → ersetzen durch diesen korrekten Beruf.`
    : '';
  const wohnortConcreteCityRuleOpenAI = ' Fragt die Kundennachricht nach dem Wohnort (z.B. "wo wohnst du", "ich wohne in X und du", "woher kommst du")? Enthaelt die Antwort nur "in der Nähe", "nicht weit weg", "ganz in der Nähe" OHNE konkreten Städtenamen? Wenn ja → konkreten Ortsnamen einbauen (plausible Stadt in der Region der Kundenstadt aus dem Verlauf – variiere, nicht immer dieselbe Stadt).';
  const meetingRule = (context.isMeetingSituation === true)
    ? (context.isDirectMeetingRequest === true
      ? ' PFLICHT TREFFEN: Keine Zusage zu Tag/Uhrzeit/Ort. VERBOTEN wenn Kunde konkreten Ort/Zeit nennt (z.B. morgen 09:00, Aldi Parkplatz): "Morgen klingt gut", "Klingt gut", "Passt gut" am Anfang – wirkt wie Zusage. Stattdessen: "Das wuerde mir gefallen, aber...", "Ich haette Lust, aber..." dann unverbindlich. "Ich schaue mal wann es klappt", "muss mal schauen wann es bei mir passt" sind ERLAUBT. Hat der Kunde konkrete Orts- oder Zeitangabe gemacht? Dann AM ANFANG unverbindlichen Einstieg (z.B. "Ich geb dir noch Bescheid ob ich da kann, " oder "Ich schau mal ob es da bei mir klappt, ") – wenn nicht vorhanden, ergaenzen. VERBOTEN: "einen Tag raussuchen", "lass uns erstmal noch schreiben", "erst kennenlernen" – ersetzen durch auf Wunsch eingehen, unverbindlich. VERBOTEN "Was denkst du darüber?" – thematische Frage zum Treffen. Ein Ausweichgrund reicht.'
      : ' TREFFEN/VORFREUDE: Keine "kennenlernen"/"erst quatschen" als Ablehnung. Positiv auf Vorfreude eingehen. Keine Ablenkung (muede, Ruhe, "wie wir das umsetzen koennten"). Wenn der Kunde positiv zustimmt (z.B. "dann treffen wir uns", "dann brauchen wir uns nur noch treffen") ohne konkrete Zeit: NICHT mit "zu ueberstuerzt", "muss sacken lassen" antworten – wirkt wie Ablehnung. Stattdessen: positiv auf die Idee eingehen (klingt gut, waere schoen) und unverbindlich bleiben (wann/wo offen), ohne den Vorschlag abzulehnen.')
    : '';
  const multiThemeRuleOpenAI = ' Enthaelt die Kundennachricht mehrere Themen/Beduerfnisse (z.B. Sex + gutes Gespraech + nicht ewig nur schreiben / absprechen)? Ignoriert die Antwort eines davon? Wenn ja → kurzen Satz ergaenzen (z.B. "will auch nicht ewig nur schreiben", "kümmer mich drum"), ohne andere Regeln zu verletzen. Nennt der Kunde Tabus und fragt "und du?"? Ignoriert die Antwort das? Wenn ja → Bezug zu Tabus und Antwort auf "und du?" ergaenzen.';
  const questionAndWholeRule = ' PFLICHT: (1) Jede Nachricht muss eine Frage enthalten. (2) Antwort MUSS auf die GESAMTE Kundennachricht eingehen – jede Frage, jedes Thema.';
  const minLengthRule = ' Mindestens 120 Zeichen. Kuerzer → thematisch passend erweitern, keine generischen Floskeln.';
  const censorshipRule = ' *** oder "zensiert"/"ausgeblendet" → entfernen und unauffaellig ueberspielen.';
  const noOftTreffenRule = ' "oft treffen", "mag es wenn man so nah wohnt" → entfernen oder durch kurze Bestaetigung ersetzen.';
  const noTimeAgreementRule = ' Kunde hat Zeitraum/Tag/Ort genannt (z.B. morgen 09:00, Aldi Parkplatz)? Antwort darf NICHT zustimmen oder so klingen ("Morgen klingt gut", "Klingt gut", "passt perfekt", "passt gut"). Wenn ja → Einstieg mit "Das wuerde mir gefallen, aber...", "Ich haette Lust, aber..." dann unverbindlich (muss schauen ob es klappt). Unverbindlich bleiben.';
  const noAbholenRuleOpenAI = ' Enthaelt die Antwort "Ich hol dich ab", "hol dich gerne ab", "kannst dich abholen" o.ae.? → diesen Teil entfernen, unverbindlich bleiben.';
  const noUnaskedAgeTypeComplimentRuleOpenAI = ' Enthaelt die Antwort ungefragte Komplimente zu Alter/Typ ("mag aeltere Maenner wie dich", "dein Alter macht es spannender") bei kurzer themenfokussierter Kundennachricht? → diesen Teil entfernen, beim Thema bleiben.';
  const noHastDuLustRuleOpenAI = ' Enthaelt die Antwort "Hast du Lust, etwas zu essen/trinken/unternehmen?" o.ae.? Klingt wie Einladung fuer JETZT. → ersetzen durch allgemeine Frage (z.B. "Was machst du nach der Arbeit meist so?", "Magst du nach Feierabend eher essen, trinken oder was anderes?").';
  const sexualRule = context.allowSexualContent === true
    ? (context.customerTalkingAboutSexWithFake === true
      ? ' Kunde spricht direkt ueber Sex mit Fake – sexuelle Inhalte NICHT entfernen/entschaerfen.'
      : ' Kunde erzählt Story ohne direkten Sex-Bezug zum Fake – eigene Erregungs-Beschreibungen entschaerfen/entfernen, flirty bleiben.')
    : ' Aktuelle Kundennachricht nicht sexuell? → explizite sexuelle Formulierungen in der Antwort entfernen/entschaerfen.';
  const sexualPerspectiveAndQuestionsRuleOpenAI = (context.allowSexualContent === true && context.customerTalkingAboutSexWithFake === true)
    ? ' SEX KONTEXT: Echo der Kundenszenario-Formulierung (z.B. "wenn du mir den Ruecken zudrehst") kann missverstaendlich sein → aus Persona-Sicht formulieren (z.B. "wenn ich dir den Ruecken zudrehe"). Schlussfrage bei Sex: Keine generischen/schwachen oder Planungs-Fragen ("Was denkst du wie intensiv...", "Was denkst du wie wir das umsetzen koennten?", "wie wir das am besten umsetzen", "Pizza oder Brüste", "Wie heftig pulsiert...") → ersetzen durch konkrete, flirty Frage (z.B. "wuerde dir das gefallen?", "magst du das?", "und was machst du dann fuer mich?", Stellungen, Tempo). Niemals nach "Umsetzung" oder "wie setzen wir das um" klingen.'
    : '';
  const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
    ? (context.contactRequest === true
      ? ' KONTAKTDATEN: "nicht erlaubt"/"Regeln"/"Plattform" entfernen, persoenlich ausweichend ersetzen. Kontakt-Anfrage persoenlich ablehnen.'
      : ' Gereizter Kunde: sachlich, deeskalierend, thematisch passende Frage.')
    : '';
  const metaRule = ' Keine Meta-Kommentare, keine Erklaerungen – nur die eine Chat-Nachricht ausgeben.';
  const noEchoRule = ' Gib NUR die Moderatoren-Antwort zurueck. Kundennachricht weder woertlich noch sinngemaess nachplappern. Bei Echo/Paraphrase des Kundentextes → ersetzen durch eigenstaendige Reaktion.';

  const toneRule = ' TON WICHTIG: Die urspruengliche Antwort kommt von einem anderen Modell (locker, umgangssprachlich, menschlich). Halte dich zurueck: Nur bei eindeutigen Regelverstoessen aendern. Wenn die Vorlage bereits locker und verstaendlich ist, moeglichst wenig aendern – nicht jeden Satz "verbessern" oder formalisieren, sonst klingt die Nachricht steif und der Korrektor-Stil faellt auf. Formulierung, Stimmung und Wortwahl der urspruenglichen Antwort beibehalten. Nicht glaetten, nicht umformulieren um sie eleganter klingen zu lassen.';
  const naturalFormulationRuleOpenAI = ' NATUERLICHE FORMULIERUNG: Die Ausgabe muss natürlich und verständlich klingen. Enthaelt die Antwort sinnlose oder unpassende Formulierungen? Z.B.: Alter als "mit [Zahl]" im Satz verwechselt ("Möchtest du mit 53 nicht lieber..."), vulgaere/sexualisierte Wendungen die nicht zum Kontext passen, sinnlose Zahlen-Anhaenge ("00", "11" am Satzende)? Wenn ja → diesen Teil entfernen oder natürlich umformulieren. Wenn die Vorlage bereits natürlich und regelkonform ist → nur minimal korrigieren (Rechtschreibung, klare Verstösse), nicht umschreiben.';
  const systemContent = `PFLICHT: Nur die fertige korrigierte Nachricht ausgeben, keine Erklaerungen.

Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide anhand des gesamten Kontexts und der Kundennachricht. Nur bei klaren Regelverstoessen umschreiben; Stil und Wortschatz der ursprünglichen Antwort möglichst beibehalten.${toneRule} ${sexualRule} ${sexualPerspectiveAndQuestionsRuleOpenAI} ${contactIrritatedRule}${meetingRule} ${customerClarificationRuleOpenAI} ${dagegenSexHopeRuleOpenAI} ${answerDirectQuestionRuleOpenAI} ${erreichbarkeitRuleOpenAI} ${treffenFrageIgnoredRuleOpenAI} ${naturalFormulationRuleOpenAI} ${multiThemeRuleOpenAI} ${noFalseSingleRule} ${noTelefonsexPhotoRule} ${imageRequestDirectionRuleOpenAI} ${ruckfrageCallbackRule} ${answerOurQuestionStayOnTopicRuleOpenAI} ${ambiguousContextStayOnTopicRuleOpenAI} ${focusCurrentMessageRuleOpenAI} ${nameAndWohnortRuleOpenAI} ${noRepeatNameIfAlreadySaidRuleOpenAI} ${useOnlyFirstNameNotUsernameRuleOpenAI} ${logbookNoContradictRuleOpenAI} ${profileDumpRuleOpenAI} ${expectedCityWohnortRuleOpenAI} ${expectedJobRuleOpenAI} ${wohnortConcreteCityRuleOpenAI} ${noWiedersehenRule} ${noSharedPastRule} ${noTimeAgreementRule} ${noAbholenRuleOpenAI} ${noUnaskedAgeTypeComplimentRuleOpenAI} ${noHastDuLustRuleOpenAI} ${boundaryConsistencyRule} ${selfConsistencyRule} ${noEchoOwnModeratorStatementRule} ${noRepeatOwnLastMessageRuleOpenAI} ${censorshipRule} ${noOftTreffenRule} ${limitationFollowUpRule} ${engageOnSuggestionsRule} ${metaRule} ${noMetaPhrasesRule} ${noGenericOpenAIPhrasesRuleOpenAI} ${noEchoRule} ${echoReplaceRule}${noVorliebenTabusEchoRuleOpenAI} ${noPerfekteMomentFrageRuleOpenAI} ${noParaphraseSchlussfrageRuleOpenAI}${noMetaQuestionAboutCustomerActivityRuleOpenAI} ${noRedundantFactQuestionRuleOpenAI} ${noRedundantScenarioQuestionRuleOpenAI} ${noRoleReversalRuleOpenAI} ${noVagueDazuSchlussfrageRuleOpenAI} ${pureGreetingAnswerRuleOpenAI} ${noTimeRefusalWithoutMeetingRequestRuleOpenAI} ${noMeetingSuggestionFromModeratorRuleOpenAI} ${noQuestionAlreadyAnsweredRule}${questionAndWholeRule}${minLengthRule}${sameActivityPlaceRule}${noParaphraseRule}${customerSingularRule}${singleProfileNoWirRule} Jede Nachricht muss eine Frage enthalten; mindestens 120 Zeichen.${humanTyposHint} ${imageOnlyAnnouncedRule} ${imageClaimedButNotPresentRule} ${imageAlreadySentToCustomerRuleOpenAI} ${noPlaceClaimRule} ${noStrongHopeRule} ${neutralMessageNoSexRule}

Außerdem: Umlaute korrigieren (ae→ä, oe→ö, ue→ü wo es Umlaut ist; nicht in Feuer, Museum, etc.). Immer ss statt ß. Keine Anführungszeichen, keine Bindestriche. Keine Doppelpunkte in der Nachricht – stattdessen Komma (z.B. "hör zu," nicht "hör zu:", "schau," nicht "schau:"). Gib NUR die fertige korrigierte Nachricht zurück – kein anderer Text.`;

  const userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht (nur Kontext – nicht ausgeben):\n"${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Moderatoren-Antwort:\n\n${sanitizeForApiContent(grokText.trim())}\n\nKontext nutzen: Der Chat-Verlauf zeigt, worauf sich die Kundennachricht bezieht. Ist sie eine Klarstellung oder Abschwaechung (z.B. \"nur X\", \"nichts Schlimmes\")? Enthaelt die Antwort trotzdem Trost oder \"nicht dein Tag\"? → ersetzen durch passende, positive Reaktion auf die Klarstellung. Stellt der Kunde eine direkte Frage an die Persona (z.B. was für dich schön ist – oder nach dem Namen: wie heißt du, wie ist dein Name)? Beantwortet die Antwort diese Frage oder gibt sie sie nur zurück? Wenn nicht beantwortet → zuerst die Frage beantworten (bei Namensfrage: Persona-Namen nennen), dann Gegenfrage.\n\nPrüfe und korrigiere: Geht die Antwort auf die GESAMTE Kundennachricht ein? Enthaelt die Kundennachricht mehrere Fragen oder Themen (z.B. mehrere Saetze/Fragen)? Geht die Antwort auf JEDE ein? Wenn eine Frage oder ein Thema fehlt → kurzen Bezug ergaenzen (1 Satz oder Teilsatz). Enthaelt sie eine Frage? Mindestens 120 Zeichen? Umlaute und ss statt ß? Beginnt die Antwort mit einer Paraphrase/Aufzaehlung der Kundennachricht (z. B. "Ah, du machst X und Y und Z...")? Wenn ja → ersetzen: nur kurze Reaktion (z. B. Das klingt flexibel bei dir) + eigene Aussage + Frage. Echo/Paraphrase: Gibt die Antwort den Kundentext (oder sein Szenario/Wunsch) woertlich oder sinngemaess zurueck? Wenn ja → ersetzen durch eigenstaendige Reaktion. Meta: Enthaelt die Antwort "Ich finde es spannend was du dir wünschst", "Was wäre dein perfektes Szenario?" oder aehnliche Meta-Fragen? Wenn ja → durch konkrete thematische Frage ersetzen. Kunde will treffen: Enthaelt die Antwort "erstmal noch schreiben", "erst kennenlernen" oder "Was denkst du darüber?"? Wenn ja → umschreiben: auf Treffenwunsch eingehen; NICHT aktiv nach Ort oder Ideen fragen ("Wo koennten wir treffen?", "Was fuer Ideen?" – verboten); andeuten/vage Vorlagen, Initiative beim Kunden. Enthaelt die Antwort "einen Tag raussuchen", "wenn wir uns einen Tag raussuchen" oder "Was haeltst du davon wenn wir uns einen Tag raussuchen"? Wenn ja → ersetzen durch unverbindliche Formulierung (z.B. "muessen mal schauen wann es bei uns klappt", "schaue mal wann es passt"). Gib NUR den fertigen korrigierten Text zurück.`;

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
    imageClaimedButNotPresent = false,
    imageAlreadySentToCustomer = false,
    lastPreviousCustomerMessageAgeMs = null,
    noPriorModeratorMessage = false
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
          doubleProfileHint,
          cityToUse: loc.cityToUse || null
        });
        let finalMessage = await callGrok(messages);
        finalMessage = postProcessMessage(finalMessage);
        // Wohnort-Antwort wie normale Nachricht: Mistral-Korrektor + Mindestlänge
        const useMistralCorrector = (process.env.USE_MISTRAL_CORRECTOR === 'true' || process.env.USE_MISTRAL_CORRECTOR === '1') && !!(process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim());
        const useCorrectorEnv = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
        const correctorModelId = (process.env.CORRECTOR_LORA_MODEL_ID || '').trim();
        const safeCityForWohnort = (loc.cityToUse && isValidCityValue(loc.cityToUse)) ? (loc.cityToUse || '').trim() : null;
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
          fakeIsPlural: !!doubleProfileHint,
          expectedCityForWohnort: safeCityForWohnort
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
    // 2–3 verschiedene Beispiele für mehr Variation (Fisher-Yates Shuffle, dann erste 2–3 nehmen)
    const numExamples = Math.min(3, Math.max(2, asaExamples.length));
    const shuffled = [...asaExamples];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const selectedASAs = shuffled.slice(0, numExamples);
    try {
      const customerHasProfilePic = profileInfo?.customerInfo?.hasProfilePic === true;
      const messages = buildASAPrompt({
        allRules,
        asaConversationContext,
        asaExamples: selectedASAs,
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
  const fakeAge = profileInfo?.moderatorInfo?.birthDate?.age ?? extractedUserInfo?.assistant?.Age ?? null;

  // Geschlechter-Rollen (wie in multi-agent): aus Profil oder Name/Profilbild ableiten
  const customerName = (profileInfo?.customerInfo?.name || extractedUserInfo?.user?.Name || '').trim();
  const fakeGender = extractedUserInfo?.assistant?.Gender || profileInfo?.moderatorInfo?.gender || inferGenderFromName(moderatorName);
  const customerGender = profileInfo?.customerInfo?.gender || extractedUserInfo?.user?.Gender || inferGenderFromName(customerName);
  const hasSexualSituation = detectedSituations && detectedSituations.some(s => (s || '').includes('Sexuell'));
  const genderHint = buildGenderHint(fakeGender, customerGender, hasSexualSituation);
  let fakeProfession = (profileInfo?.moderatorInfo?.occupation || extractedUserInfo?.assistant?.Work || extractedUserInfo?.assistant?.Beruf || '').trim();
  if (!fakeProfession && fakeLogbookHint) fakeProfession = extractProfessionFromLogbookHint(fakeLogbookHint);
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

  // Reine Begruessung (Hey/Hi/Hallo) + lange Pause seit letzter Kunden-Nachricht = neues Gespraech (Hallo + Tagesfragen).
  // WICHTIG: Der Kontext (conversationHistory) wird NICHT gekuerzt – auch Nachrichten >24h bleiben drin, damit der Kunde
  // spaeter auf ein Thema vom Vortag Bezug nehmen kann. Wir steuern nur DIESE Antwort, nicht den verfuegbaren Kontext.
  const isPureGreetingMsg = isPureGreeting(customerMessage);
  const lastPrevAgeMs = opts.lastPreviousCustomerMessageAgeMs;
  const isReengagementGreetingFlag = isPureGreetingMsg && (lastPrevAgeMs != null && lastPrevAgeMs > REENGAGEMENT_THRESHOLD_MS);
  if (isReengagementGreetingFlag) console.log('ℹ️ Reine Begruessung nach langer Pause – Kunde startet neu, antworte mit Hallo + Tagesfragen');
  else if (isPureGreetingMsg) console.log('ℹ️ Reine Begruessung erkannt – antworte mit Hallo + normale Tagesfragen');

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
      imageDescriptionForUserPrompt: imageDescription && imageDescription.trim() ? imageDescription.trim() : null,
      timeContextHint,
      shiftWorkTimeHint,
      knownFromCustomerMessage,
      imageOnlyAnnounced: !!opts.imageOnlyAnnounced,
      imageClaimedButNotPresent: !!opts.imageClaimedButNotPresent,
      imageAlreadySentToCustomer: !!opts.imageAlreadySentToCustomer,
      fakeProfession,
      isReallyUnclearMessage: isReallyUnclear,
      fakeLogbookHint,
      fakeName: moderatorName || extractedUserInfo?.assistant?.Name || '',
      customerName: customerName || extractedUserInfo?.user?.Name || profileInfo?.customerInfo?.name || '',
      fakeRelationshipStatus,
      profileIdentityHint,
      fakeAge,
      isPureGreetingMessage: isPureGreetingMsg,
      isReengagementGreeting: isReengagementGreetingFlag,
      noPriorModeratorMessage: !!opts.noPriorModeratorMessage
    });
    let finalMessage = '';
    let noQuestionError = false;
    const imageOnlyAnnouncedFlag = !!opts.imageOnlyAnnounced;
    const imageClaimedButNotPresentFlag = !!opts.imageClaimedButNotPresent;
    // Vorname für Chat: firstName/Vorname zuerst (z. B. Justine), nie Benutzername/Displayname (z. B. Blumenklang) als einzigen Namen nutzen
    const fakeFirstName = (profileInfo?.moderatorInfo?.firstName || profileInfo?.moderatorInfo?.Vorname || extractedUserInfo?.assistant?.Name || moderatorName || profileInfo?.moderatorInfo?.name || '').toString().trim().split(/\s+/)[0] || '';
    const fakeCityForAnswer = (locationContext && locationContext.fakeCity) ? String(locationContext.fakeCity).trim() : (profileInfo?.moderatorInfo?.city || profileInfo?.moderatorInfo?.Wohnort || extractedUserInfo?.assistant?.city || extractedUserInfo?.assistant?.Wohnort || '').toString().trim() || null;
    const asksForNameOrWohnort = isWohnortFrage || /\b(vornamen?|name)\s+und\s+wohnort\b|\bwohnort\s+und\s+(vornamen?|name)\b|\b(deinen?|dein)\s+(vornamen?|wohnort)\b|\bdenkst\s+du\s+noch\s+an\s+(deinen?\s+)?(vornamen?|wohnort)\b|\b(richtigen?\s+)?vornamen?\b.*\b(schatzi|erfahren|sagen|nennen|verraten|denkst)\b|\b(wo\s+wohnst|woher\s+kommst)\b/i.test((customerMessage || '').trim());
    const asksForErreichbarkeit = /\b(wo\s+kann\s+ich\s+dich\s+erreichen|wie\s+erreich(e)?\s+ich\s+dich|wo\s+erreichbar|wie\s+kann\s+ich\s+dich\s+erreichen)\b/i.test((customerMessage || '').trim());
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
      imageAlreadySentToCustomer: !!opts.imageAlreadySentToCustomer,
      fakeIsPlural,
      fakeRelationshipStatus,
      isNonSingle: fakeRelationshipStatus && !/^single$/i.test(fakeRelationshipStatus) && /relation|beziehung|verheiratet|verwitwet|witwe|witwer|geschieden|married|widow|vergebn|in\s+einer\s+beziehung/i.test(fakeRelationshipStatus),
      askForNameOrWohnort: !!asksForNameOrWohnort,
      askForErreichbarkeit: !!asksForErreichbarkeit,
      fakeFirstName: fakeFirstName || null,
      fakeCityForAnswer: (fakeCityForAnswer && (fakeCityForAnswer + '').toLowerCase() !== 'sag ich später' && isValidCityValue(fakeCityForAnswer)) ? fakeCityForAnswer : null,
      customerName: (customerName || extractedUserInfo?.user?.Name || profileInfo?.customerInfo?.name || '').toString().trim() || null,
      expectedFakeJob: (fakeProfession && fakeProfession.trim()) ? fakeProfession.trim() : null,
      fakeDisplayNameOrUsername: (modName && modName.trim() && modName.trim().toLowerCase() !== (fakeFirstName || '').toLowerCase()) ? modName.trim() : ((modUsername && modUsername.trim() && modUsername.trim().toLowerCase() !== (fakeFirstName || '').toLowerCase()) ? modUsername.trim() : null),
      logbookSaysJungfrau: !!(fakeLogbookHint && /jungfrau/i.test(fakeLogbookHint) && !/sternzeichen\s*[:\-]?\s*jungfrau|jungfrau\s*[,]?\s*(zeichen|stern)/i.test(fakeLogbookHint)),
      logbookSaysSchwanger: !!(fakeLogbookHint && /schwanger|schwangerschaft/i.test(fakeLogbookHint)),
      isPureGreetingMessage: !!isPureGreetingMsg
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
  // Doppelpunkt nach typischen Einleitungswörtern durch Komma ersetzen (z.B. "hör zu:" -> "hör zu,")
  m = m.replace(/\b(hör zu|schau|pass auf|okay|gut|ok|alles klar|na gut|na klar)\s*:\s*/gi, '$1, ');
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
