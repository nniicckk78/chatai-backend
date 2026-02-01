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
const OPENAI_SITUATION_TIMEOUT_MS = 15000;
const OPENAI_SITUATION_MAX_TOKENS = 120;
const OPENAI_PLAN_TIMEOUT_MS = 15000;
const OPENAI_PLAN_MAX_TOKENS = 150;
const OPENAI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

/** Entfernt/ersetzt Zeichen, die in JSON/API-Requests zu "unexpected end of hex escape" führen. */
function sanitizeForApiContent(str) {
  if (str == null || typeof str !== 'string') return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/[\x00-\x1F]/g, (c) => (c === '\n' ? '\n' : ' '))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// ========== Moderator-Persona (alle Prompts) ==========
const MODERATOR_PERSONA = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL. Du hast interne Regeln für verschiedene Situationen (Treffen, Sexuell, Bot-Vorwurf, Geld, Wohnort, etc.). Pro Nachricht erkennst du, welche Situation(en) zutreffen, und wendest genau diese Regeln plus die allgemeinen Regeln an. Bei mehreren Situationen kombinierst du die Regeln. Du antwortest nur auf Deutsch, locker, Du-Form. Erfinde keine Details, die nicht im Kontext oder Profil stehen.\n\n`;

// Allgemein: Thema halten, nicht zu schlau, Schreibfehler verstehen, natürlich wirken, Format
const GENERAL_BEHAVIOR = `THEMA: Geh nicht zu stark vom Thema ab. Wenn du etwas ergaenzst oder eine Frage stellst, soll es zur Person oder zum Kontext passen – nicht themenfremd (z.B. keine Beziehungsart-/Vorlieben-Fragen, wenn der Kunde nur etwas Konkretes gefragt hat).\nDUMM: Du bist ein normaler Mensch, du weisst nicht alles. Bei Fachfragen (z.B. Technik, wie etwas funktioniert): nicht mit Fachwissen antworten; sag ehrlich, dass du es nicht weisst, oder lenke freundlich um. Sei lieber etwas "dumm" als uebermaessig kompetent.\nSCHREIBFEHLER: Verstehe Tipp- und Schreibfehler des Kunden wie ein Mensch (z.B. "ham" statt "Hamm", fehlende Buchstaben, Grammatik). Antworte trotzdem inhaltlich richtig, ohne den Kunden zu korrigieren.\nNATUERLICH: Du darfst hier und da kleine, unauffaellige Fehler machen (Komma, Punkt, Grammatik) – wie ein Mensch, der nicht perfekt tippt. Aber nicht zu extrem oder auffaellig.\nFORMAT: KEINE Bindestriche (z.B. kennenlernen, nicht kennen-lernen). Immer ss, nie ß. Keine Anführungszeichen am Anfang/Ende der Nachricht.\nTREFFEN/CHAT: Begruende NIEMALS, dass du dich im Chat wohler fuehlst. Bei Treffen/Bar/Ort/Zeit: NIEMALS Bar, Ort oder Uhrzeit nennen; keine Vorschlaege machen; nicht auf Vorschlaege eingehen. Nur darueber schreiben, was man "wuerde" machen, wie toll es "waere" – mehr nicht. Wird in Trainingsdaten gezeigt. Stelle eine klare Gegenfrage.\nEIGENE ERREGUNG: Eigene Erregung beschreiben (z.B. "macht mich feucht", "stell ich mir geil vor") nur, wenn der Kunde explizit mit dir/Fake ueber Sex spricht – also was er mit dir machen will, was ihr zusammen machen wuerdet usw. Wenn er nur eine Story oder ein Erlebnis erzaehlt (auch wild/anzueglich), ohne dich direkt einzubeziehen: auf den Inhalt reagieren (lustig, wild, interessant, Frage) – nicht mit deiner eigenen koerperlichen Reaktion.\n\n`;

// ========== Priorität (Reihenfolge im Prompt) ==========
const PRIORITY_NOTE = `PRIORITÄT (in dieser Reihenfolge beachten):
1. Safety/harte Grenzen (bereits geprüft)
2. Situations-Regeln (unten – nur die genannten Situationen)
3. Allgemeine Regeln (verbotene/bevorzugte Wörter, allgemeine Regeln)
4. Stil/Beispiele (Länge, Ton)\n\n`;

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
  'anna', 'maria', 'lena', 'lisa', 'julia', 'laura', 'sarah', 'lea', 'lara', 'sophie', 'emma', 'mia', 'hannah',
  'leonie', 'lina', 'nele', 'clara', 'emily', 'sandy', 'jana', 'nicole', 'jennifer', 'melanie', 'sandra',
  'susanne', 'susann', 'christina', 'katharina', 'jessica', 'vanessa', 'nadine', 'stefanie', 'andrea',
  'franziska', 'petra', 'monika', 'sabine', 'birgit', 'claudia', 'daniela', 'silke', 'tanja', 'yvonne'
]);
/** Typische männliche Vornamen (Deutsch/International). */
const MALE_NAMES = new Set([
  'alessandro', 'alexandro', 'max', 'paul', 'lucas', 'felix', 'ben', 'jonas', 'tim', 'leon', 'lukas',
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
      block += '- Bei sexuellen Positionen/Rollen: Du bist die PASSIVE Partei, der Kunde die AKTIVE Partei.\n';
    } else {
      block += '\n🚨🚨🚨 KRITISCH: SEXUELLE ROLLEN/POSITIONEN (MANN zu FRAU) 🚨🚨🚨\n';
      block += '- Du bist der MANN, der Kunde ist die FRAU.\n';
      block += '- Du nimmst AKTIVE Rollen ein (du "nimmst", nicht du wirst "genommen").\n';
      block += '- ✅ RICHTIG: "Ich würde dich doggy nehmen", "Ich würde dich gerne nehmen", "Ich würde dich ficken".\n';
      block += '- ❌ FALSCH: "Ich würde gerne doggy genommen werden", "Ich würde gerne von dir genommen werden" (passive Rollen für Frauen!).\n';
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
  const response = await Promise.race([
    client.chat.completions.create({
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? MAX_TOKENS
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Grok Timeout')), options.timeoutMs || GROK_TIMEOUT_MS))
  ]);
  const text = response.choices?.[0]?.message?.content?.trim() || '';
  if (!text) throw new Error('Grok lieferte keine Antwort');
  return text;
}

/** Stellt sicher, dass die Nachricht mit einer Frage endet. Wenn nicht und OpenAI verfügbar: kurzer Call zum Anhängen einer Frage. */
async function ensureQuestionAtEnd(message) {
  if (!message || typeof message !== 'string') return message || '';
  const trimmed = message.trim();
  if (trimmed.endsWith('?')) return message;
  const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
  if (!hasOpenAI) return message;
  try {
    const userContent = `Die folgende Chat-Nachricht endet nicht mit einer Frage. Fuege genau eine kurze, thematisch passende Frage am Ende hinzu. Gib NUR die komplette Nachricht inkl. neuer Frage zurueck, keine Erklaerungen.\n\nNachricht:\n\n${sanitizeForApiContent(trimmed)}`;
    const result = await callOpenAI([
      { role: 'system', content: 'Du haengst einer Chat-Nachricht genau eine kurze, thematisch passende Frage an. Gib NUR die komplette Nachricht mit angehaengter Frage zurueck. Keine Anführungszeichen, kein anderer Text.' },
      { role: 'user', content: userContent }
    ], { temperature: 0.2, max_tokens: 180, timeoutMs: 10000 });
    const out = (result || '').trim();
    if (out && out.length > trimmed.length && out.includes('?')) {
      console.log('✅ Grok-Pipeline: Frage am Ende ergaenzt (Post-Processing)');
      return postProcessMessage(out);
    }
  } catch (err) {
    console.warn('⚠️ Frage-am-Ende Post-Processing fehlgeschlagen:', err.message);
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

function buildASAPrompt({ allRules, asaConversationContext, asaExample, doubleProfileHint = '', customerHasProfilePic = false }) {
  const rulesBlock = buildRulesBlock(allRules);
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR;
  if (doubleProfileHint && doubleProfileHint.trim()) systemContent += doubleProfileHint.trim() + '\n\n';
  if (!customerHasProfilePic) {
    systemContent += 'PROFILBILD: Der Kunde hat KEIN Profilbild. Erwaehne NICHT sein Aussehen, sage NICHT dass er gut aussieht oder aehnliches.\n\n';
  }
  systemContent += `Du antwortest auf eine System-Nachricht (Kuss oder Like) – der Kunde hat dich geliked oder einen Kuss geschickt, du schreibst die ERSTE Antwort.
${rulesBlock}

WICHTIG: Antworte natürlich, locker, freundlich. Bedanke dich kurz für Kuss/Like. Stelle 1–2 Fragen (z.B. wie geht es dir, was machst du so). Mindestens 150 Zeichen. Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. KEINE Anführungszeichen am Anfang/Ende. KEINE Bindestriche.`;

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
  const fakeName = extractedUserInfo?.assistant?.Name || profileInfo?.moderatorInfo?.name || 'Sandy';
  const fakeCity = extractedUserInfo?.assistant?.Stadt || profileInfo?.moderatorInfo?.city || '';
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
  systemContent += `Du antwortest als FAKE-PROFIL namens ${fakeName}${fakeCity ? ` aus ${fakeCity}` : ''}.
${rulesBlock}

WICHTIG: Schreibe NIEMALS deinen eigenen Namen. Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. KEINE Bindestriche. KEINE Anführungszeichen am Anfang/Ende. Nutze Zeitkontext (${weekday}, ${timePhase}). Antworte natürlich, mindestens 150 Zeichen.`;

  const userContent = `${firstMessageInstructions}

[FAKE-PROFIL]
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
  return { weekday, timePhase };
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
 * Prüft, ob Kunde direkt über Sex mit dem Fake spricht (z.B. "ich würde dich...", "stell dir vor wir...").
 * Wenn ja: eigene Erregungs-Beschreibungen ("macht mich feucht") sind passend.
 * Wenn nein (nur Story/Erlebnis ohne direkten Bezug zum Fake): nicht mit eigener Erregung reagieren.
 */
function isCustomerTalkingAboutSexWithFake(customerMessage) {
  if (!customerMessage || typeof customerMessage !== 'string') return false;
  const lower = customerMessage.toLowerCase();
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
  isEmotional = false,
  noSexHint = false,
  imageRulesHint = false,
  isContactRequest = false,
  isCustomerIrritatedFlag = false,
  emotionalToneHint = null,
  imageContextHint = null,
  timeContextHint = null,
  knownFromCustomerMessage = ''
}) {
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR + PRIORITY_NOTE;
  if (genderHint && genderHint.trim()) {
    systemContent += genderHint.trim() + '\n';
  }
  if (knownFromCustomerMessage && knownFromCustomerMessage.trim()) {
    systemContent += `BEKANNT AUS NACHRICHT/KONTEXT: ${sanitizeForApiContent(knownFromCustomerMessage.trim())}. Darauf eingehen, wenn es zur Nachricht passt.\n\n`;
  }
  if (timeContextHint && timeContextHint.trim()) {
    systemContent += `ZEIT: ${timeContextHint.trim()}\n\n`;
  }
  if (imageContextHint && imageContextHint.trim()) {
    systemContent += `BILD: ${imageContextHint.trim()}\n\n`;
  }
  if (doubleProfileHint && doubleProfileHint.trim()) {
    systemContent += doubleProfileHint.trim() + '\n\n';
  }
  if (isMidConversation) {
    systemContent += 'KONTEXT: Die Konversation laeuft bereits. Beginne die Nachricht NICHT mit Hey, Hi, Hallo oder aehnlichen Begruessungen – antworte direkt auf das Gesagte.\n\n';
  }
  if (isMeetingSituation) {
    systemContent += 'TREFFEN/BAR-FRAGEN: NIEMALS Bar, Ort oder Uhrzeit nennen. Keine Vorschlaege machen, nicht auf Vorschlaege eingehen. Nur darueber schreiben, was man "wuerde" machen, wie toll es "waere" – mehr nicht. Orientiere dich streng an den Trainingsdaten, dort ist es gezeigt. NIEMALS begruenden, dass du dich im Chat wohler fuehlst. Beende mit einer klaren Gegenfrage.\n\n';
  }
  if (isContactRequest) {
    systemContent += 'KONTAKTDATEN: Kunde fragt nach Nummer/WhatsApp/Telegram/Instagram etc. Freundlich ablehnen – keine echten Kontaktdaten nennen, auf die Plattform verweisen. Nicht sexualisieren, sachlich und freundlich bleiben. Mit einer thematisch passenden Frage abschliessen.\n\n';
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
  if (imageRulesHint) {
    systemContent += 'BILDER: Kunden schicken uns Bilder – reagiere positiv darauf, beschreibe das Bild NICHT. Wir schicken selbst keine Bilder – wenn der Kunde nach Fotos von uns fragt, finde einen Grund warum nicht (wie in Trainingsdaten).\n\n';
  }
  if (situationRulesBlock && situationRulesBlock.trim()) {
    systemContent += sanitizeForApiContent(situationRulesBlock.trim());
  }
  systemContent += generalRulesBlock;
  if (locationContext && (locationContext.fakeCity || locationContext.customerCity)) {
    const parts = [];
    if (locationContext.fakeCity) parts.push(`Fake-Wohnort = ${locationContext.fakeCity}`);
    if (locationContext.customerCity) parts.push(`Kunde = ${locationContext.customerCity}`);
    systemContent += `\nKONTEXT (Ort): ${parts.join(', ')}. Nenne eine Stadt, kein Bundesland. Bleib beim Thema Ort, erfinde keine anderen Staedte.\n\n`;
  }
  if (learningContext && learningContext.trim()) {
    systemContent += sanitizeForApiContent(learningContext.trim()) + '\n\n';
  }
  if (plan && plan.trim()) {
    systemContent += `PLAN (daran halten):\n${sanitizeForApiContent(plan.trim())}\n\n`;
  }
  systemContent += `LOGIK: Gehe auf die GESAMTE Kundennachricht ein – inkl. genannte Vorlieben, Beziehungsvorstellungen oder andere wichtige Punkte. Ignoriere keine Teile der Nachricht. Wenn der Kunde eine Frage stellt, beantworte sie (oder weiche im Stil der Beispiele aus) und beende die Nachricht mit einer konkreten Gegenfrage. Jede Nachricht braucht eine Frage am Ende – zum Kontext passend, zum Thema oder das Thema erweiternd/vertiefend. Auch bei sexuellen Themen: am Ende eine kurze Frage, die zum Thema passt oder es vertieft (keine Treffen-Einladung). Mindestens 150 Zeichen. Natuerlich und locker.
Stimmung: Reagiere passend auf die Stimmung des Kunden – warm und aufgeschlossen bei positivem/flirty Ton, verstaendnisvoll bei Traurigkeit, deeskalierend bei Unmut. Erkenne die Emotion hinter der Nachricht und spiegle sie angemessen.
Rechtschreibung: Schreibe in normaler deutscher Rechtschreibung mit ä, ö, ü (Umlaute) – z.B. wär, wäre, möchte, für, schön. UMLAUTE: Immer ä, ö, ü schreiben, niemals waer, moechte, fuer, schon als Ersatz. Immer ss, nie ß. Keine Anführungszeichen am Anfang/Ende. KEINE Bindestriche.
Antworte NUR mit der einen Nachricht – keine Meta-Kommentare, keine Wiederholung der Kundennachricht woertlich; eigenstaendig formuliert, mit Frage am Ende. Keine Erklaerungen.`;

  let userContent = '';
  if (conversationHistory && conversationHistory.trim()) {
    const historySnippet = conversationHistory.substring(Math.max(0, conversationHistory.length - 800));
    userContent += `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(historySnippet)}\n\n`;
  }
  userContent += `Aktuelle Kundennachricht: "${sanitizeForApiContent(customerMessage || '')}"\n\n`;
  if (examples && examples.length > 0) {
    userContent += 'TRAININGS-BEISPIELE (Stil, Struktur und Inhalt daran orientieren – Antwort auf Frage + Gegenfrage wie in den Beispielen, nicht erfinden):\n';
    examples.slice(0, 5).forEach((ex, i) => {
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
  'Treffen/Termine': 'Kunde erwähnt Treffen, sich sehen, kennenlernen, vorbeikommen, bei dir/bei mir, Date, Café, reale Aktivitäten.',
  'Wohnort-Frage': 'Kunde fragt wo du wohnst, woher du kommst, aus welcher Stadt/Region.',
  'Geld/Coins': 'Kunde spricht über Geld, Coins, Credits, Aufladen, Kosten.',
  'Bot-Vorwurf': 'Kunde unterstellt Bot, KI, Fake oder dass du nicht echt bist.',
  'Berufsfrage': 'Kunde fragt nach deinem Beruf, deiner Arbeit, was du arbeitest.',
  'Kontaktdaten außerhalb der Plattform': 'Kunde will Nummer, WhatsApp, Telegram, Instagram, Email teilen oder außerhalb der Plattform schreiben.',
  'Bilder Anfrage': 'Kunde möchte ein Foto/Bild von dir sehen, bittet darum etwas zu zeigen/zu sehen (z.B. Bild von dir, zeig mir, will sehen, deine Muschi/Brust/etc. sehen). Auch implizit: "will X sehen" wo X etwas ist, das man nur per Bild zeigen würde.',
  'Sexuelle Themen': 'Kunde spricht über Sex, Fantasien, Körper, Lust, explizite Wünsche oder Anspielungen.',
  'Wonach suchst du?': 'Kunde fragt wonach du suchst (Beziehung, was lockeres, etc.).',
  'Moderator/Outing': 'Kunde fragt ob du ein Chat-Moderator/Moderator bist.'
};

const ALLOWED_SITUATION_NAMES = new Set(Object.keys(SITUATION_DEFINITIONS_LLM));


/**
 * Erkennt Situationen anhand des Kontexts der Kundennachricht (LLM), nicht nur Stichwörter.
 * @param {string} customerMessage - Aktuelle Kundennachricht
 * @param {string} [conversationHistorySnippet] - Optional: letzte ~600 Zeichen Kontext
 * @returns {Promise<string[]|null>} Array der Situationsnamen oder null bei Fehler (dann Fallback auf getDetectedSituations)
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
      content: `Du klassifizierst Kundennachrichten auf einer Dating-Plattform. Wähle ALLE zutreffenden Situationen aus der Liste. Mehrere Situationen sind möglich (z.B. "Bilder Anfrage" + "Sexuelle Themen").

Situationen (nur diese Namen verwenden):
${defsText}

Antworte NUR mit einem JSON-Array der zutreffenden Situationsnamen, z.B. ["Bilder Anfrage", "Sexuelle Themen"]. Kein anderer Text, keine Erklärung.`
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
    out.push('Bot-Vorwurf');
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
  const sexualIndicators = ['sex', 'ficken', 'geil', 'heiß', 'kuss', 'kusse', 'liebe', 'flirt', 'date', 'treffen'];
  if (sexualIndicators.some(term => lower.includes(term))) {
    out.push('Sexuelle Themen');
  }
  return out;
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
    ? ' Bei Kontaktdaten: freundlich ablehnen, auf Plattform verweisen, keine echten Kontaktdaten, thematisch passende Frage am Ende.'
    : '';
  const sexualHint = Array.isArray(detectedSituations) && detectedSituations.some(s => (s || '').toLowerCase().includes('sexuell'))
    ? ' Bei Sexuelle Themen: auf sexuelle Inhalte und Fragen eingehen, nicht ausweichen – Ton und Regeln der Situation Sexuelle Themen beachten.'
    : '';
  const contextSnippet = (conversationHistory || '').trim().slice(-700);
  const customerSnippet = (customerMessage || '').trim();
  const customerForPlan = customerSnippet.length > 600 ? customerSnippet.slice(0, 600) + '…' : customerSnippet;
  const contextBlock = contextSnippet
    ? `Kontext (Auszug aus dem Gespräch – beachten für Ton und Thema):\n${sanitizeForApiContent(contextSnippet)}\n\n`
    : '';
  const userContent = `${contextBlock}Aktuelle Kundennachricht: "${sanitizeForApiContent(customerForPlan)}"\n\nErkannte Situation(en): ${situationList}.${contactHint}${sexualHint}\n\nGib in 2–4 Sätzen an: Welche Regeln/Prioritäten gelten hier? Welcher Ton? Worauf muss die Antwort eingehen (Inhalt der Kundennachricht)? Was unbedingt vermeiden? Nur den Plan, keine Antwort an den Kunden.`;
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

// ========== Grok als Korrektor (zweiter Grok-Aufruf statt LoRA) ==========

/**
 * Korrigiert die Grok-Antwort mit einem zweiten Grok-Aufruf (gleiche Regeln wie LoRA-Korrektor).
 * Env: USE_GROK_AS_CORRECTOR=true. Bekommt optional Plan + Konversation wie der Generator.
 */
async function runGrokCorrector({ customerMessage = '', context = {}, grokText = '', learningContext = '', exampleSnippet = '', planSnippet = '', conversationSnippet = '' }) {
  if (!grokText || !grokText.trim()) return null;
  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push('Thema Treffen/Bar/Zeit');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  if (context.contactRequest === true) ctx.push('Kunde fragt nach Kontaktdaten/Telegram/WhatsApp etc. – Antwort MUSS freundlich ablehnen und auf Plattform verweisen');
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';
  const planBlock = (planSnippet && planSnippet.trim()) ? `Plan (was die Antwort tun sollte): ${sanitizeForApiContent(planSnippet.trim().slice(0, 280))}${planSnippet.length > 280 ? '…' : ''}\n\n` : '';
  const conversationBlock = (conversationSnippet && conversationSnippet.trim()) ? `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(conversationSnippet.trim().slice(-450))}\n\n` : '';
  const fullCustomerMsg = (customerMessage || '').trim();
  const customerForCorrector = fullCustomerMsg.length > 800 ? fullCustomerMsg.slice(0, 800) + '…' : fullCustomerMsg;
  const learningBlock = (learningContext && learningContext.trim()) ? `Feedback/Stil (daran orientieren): ${learningContext.trim().slice(0, 400)}\n\n` : '';
  const exampleBlock = (exampleSnippet && exampleSnippet.trim()) ? `Beispiel einer guten Antwort (Stil/Struktur so): "${exampleSnippet.trim().slice(0, 220)}${exampleSnippet.length > 220 ? '…' : ''}"\n\n` : '';
  const contactCheck = context.contactRequest === true ? '\n(5) Hat der Kunde nach Kontaktdaten/Telegram/WhatsApp gefragt und die Antwort lehnt das nicht ab? Wenn ja → freundliche Ablehnung (keine Nummer/Telegram) + Verweis auf Plattform einbauen.' : '';
  const userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht: "${sanitizeForApiContent(customerForCorrector)}"\n\nPrüfe die folgende Moderatoren-Antwort und korrigiere/verbessere sie:\n(1) Geht die Antwort auf die Kundennachricht ein? Wenn nein → umschreiben.\n(2) Steht am Ende eine Frage? Wenn nein → Frage hinzufügen.\n(3) Umlaute (ä,ö,ü) und ss statt ß? Stil/Bindestriche?\n(4) Enthält die Antwort Meta-Kommentare oder wörtliche Wiederholung der Kundennachricht? Wenn ja → entfernen, eigenständig formulieren.${contactCheck}\nGib NUR den fertigen korrigierten Text zurück, keine Erklärungen.\n\nZu korrigierende Antwort:\n\n${sanitizeForApiContent(grokText.trim())}`;

  const sexualRule = context.allowSexualContent === true
    ? (context.customerTalkingAboutSexWithFake === true
      ? 'WICHTIG: Kunde spricht direkt über Sex mit Fake – sexuelle Inhalte und eigene Erregung sind passend. Entferne oder entschärfe sie NICHT. Nur echte Regelverstöße korrigieren.'
      : 'WICHTIG: Kunde erzählt Story/Erlebnis (ohne direkten Sex-Bezug zum Fake) – eigene Erregungs-Beschreibungen der Moderatoren-Persona entschärfen oder entfernen. Auf Inhalt reagieren, nicht mit eigener körperlicher Reaktion. Flirty bleiben, ohne selbstbezogene Erregung.')
    : 'Entferne sexuelle Formulierungen nur, wenn im Kontext steht "Kunde möchte nicht über Sex schreiben". Sonst lasse den Text inhaltlich wie er ist.';
  const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
    ? (context.contactRequest === true
      ? 'KONTAKTDATEN: Kunde fragt nach Nummer/Telegram/WhatsApp/Instagram etc. – Die Antwort MUSS freundlich ablehnen (keine echten Kontaktdaten nennen), auf die Plattform verweisen; sachlich und deeskalierend, thematisch passende Frage am Ende. Wenn die zu korrigierende Antwort das nicht tut, unbedingt einbauen.'
      : 'Bei gereiztem Kunden: Antwort sachlich und deeskalierend, thematisch passende Frage am Ende.')
    : '';
  const systemContent = `Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide immer anhand des gesamten Kontexts und der Kundennachricht. ${sexualRule} ${contactIrritatedRule} PFLICHT: Jede Nachricht braucht eine Frage am Ende. Fehlt eine Frage, füge am Ende UNBEDINGT eine kurze, thematisch passende Frage hinzu. Die Antwort MUSS auf die Kundennachricht eingehen. Wenn etwas zu korrigieren ist (fehlende Frage, kein Bezug, Kontaktdaten nicht abgelehnt, Umlaute/ss, Stil), aendere es. Schreibe mit ä, ö, ü. Immer ss, nie ß. Keine Anführungszeichen. Keine Bindestriche. Antworte NUR mit der fertigen korrigierten Nachricht – kein anderer Text.`;

  try {
    const corrected = await callGrok([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ], { temperature: 0.3, max_tokens: 400 });
    const text = (corrected || '').trim();
    if (text && text.length >= 20) {
      console.log('✅ Grok-Korrektor: Nachricht korrigiert (' + grokText.length + ' → ' + text.length + ' Zeichen)');
      return text;
    }
  } catch (err) {
    console.warn('⚠️ Grok-Korrektor fehlgeschlagen:', err.message);
  }
  return null;
}

// ========== Mistral als Korrektor ==========

const MISTRAL_CORRECTOR_TIMEOUT_MS = 20000;
const MISTRAL_CORRECTOR_MAX_TOKENS = 400;
const MISTRAL_CORRECTOR_MODEL = process.env.MISTRAL_CORRECTOR_MODEL || 'mistral-small-latest';
/** Wenn true: Minimal-Prompt nutzen, damit das aus dem Fine-Tuning gelernte Verhalten nicht von langen Anweisungen überschrieben wird. */
const MISTRAL_CORRECTOR_FINETUNED = process.env.MISTRAL_CORRECTOR_FINETUNED === 'true' || process.env.MISTRAL_CORRECTOR_FINETUNED === '1';

function getMistralClient() {
  const key = process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim();
  if (!key || !MistralClient) return null;
  return new MistralClient({ apiKey: key });
}

/**
 * Korrigiert die Grok-Antwort mit Mistral (gleiche Regeln wie OpenAI-Korrektor).
 * Nutzen wenn USE_MISTRAL_CORRECTOR=true und MISTRAL_API_KEY gesetzt.
 * Bei MISTRAL_CORRECTOR_FINETUNED=true: nur Daten übergeben, keine langen Regeln – das Modell nutzt das aus dem Training gelernte Verhalten.
 */
async function runMistralCorrector({ customerMessage = '', context = {}, grokText = '', learningContext = '', exampleSnippet = '', planSnippet = '', conversationSnippet = '' }) {
  if (!grokText || !grokText.trim()) return null;
  const client = getMistralClient();
  if (!client) return null;
  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push('Thema Treffen/Bar/Zeit');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  if (context.contactRequest === true) ctx.push('Kunde fragt nach Kontaktdaten/Telegram/WhatsApp etc. – Antwort MUSS freundlich ablehnen und auf Plattform verweisen');
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';
  const planBlock = (planSnippet && planSnippet.trim()) ? `Plan (was die Antwort tun sollte): ${sanitizeForApiContent(planSnippet.trim().slice(0, 280))}${planSnippet.length > 280 ? '…' : ''}\n\n` : '';
  const conversationBlock = (conversationSnippet && conversationSnippet.trim()) ? `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(conversationSnippet.trim().slice(-450))}\n\n` : '';
  const fullCustomerMsg = (customerMessage || '').trim();
  const customerForCorrector = fullCustomerMsg.length > 800 ? fullCustomerMsg.slice(0, 800) + '…' : fullCustomerMsg;
  const learningBlock = (learningContext && learningContext.trim()) ? `Feedback/Stil (daran orientieren): ${learningContext.trim().slice(0, 400)}\n\n` : '';
  const exampleBlock = (exampleSnippet && exampleSnippet.trim()) ? `Beispiel einer guten Antwort (Stil/Struktur so): "${exampleSnippet.trim().slice(0, 220)}${exampleSnippet.length > 220 ? '…' : ''}"\n\n` : '';

  let systemContent;
  let userContent;

  if (MISTRAL_CORRECTOR_FINETUNED) {
    // Minimal-Prompt: nur Daten, keine langen Regeln. Das Fine-Tuning hat bereits gezeigt, wie korrigiert wird (Meta, Echo, Kontaktdaten, Frage etc.) – lange Anweisungen würden das Gelernte überschreiben.
    systemContent = 'Du bist ein Korrektor für Chat-Moderator-Antworten. Gib nur die fertige korrigierte Nachricht zurück, keine Erklärungen, keine Meta-Kommentare.';
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht: "${sanitizeForApiContent(customerForCorrector)}"\n\nZu korrigierende Antwort:\n\n${sanitizeForApiContent(grokText.trim())}`;
    if (process.env.NODE_ENV !== 'production') console.log('🔧 Mistral-Korrektor: Minimal-Prompt (Fine-Tuned-Modell)');
  } else {
    const contactCheck = context.contactRequest === true ? '\n(5) Hat der Kunde nach Kontaktdaten/Telegram/WhatsApp gefragt und die Antwort lehnt das nicht ab? Wenn ja → freundliche Ablehnung (keine Nummer/Telegram) + Verweis auf Plattform einbauen.' : '';
    userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht: "${sanitizeForApiContent(customerForCorrector)}"\n\nPrüfe die folgende Moderatoren-Antwort und korrigiere/verbessere sie:\n(1) Geht die Antwort auf die Kundennachricht ein? Wenn nein → umschreiben.\n(2) Steht am Ende eine Frage? Wenn nein → Frage hinzufügen.\n(3) Umlaute (ä,ö,ü) und ss statt ß? Stil/Bindestriche?\n(4) Enthält die Antwort Meta-Kommentare oder wörtliche Wiederholung der Kundennachricht? Wenn ja → entfernen, eigenständig formulieren.${contactCheck}\nGib NUR den fertigen korrigierten Text zurück, keine Erklärungen.\n\nZu korrigierende Antwort:\n\n${sanitizeForApiContent(grokText.trim())}`;

    const sexualRule = context.allowSexualContent === true
      ? (context.customerTalkingAboutSexWithFake === true
        ? 'WICHTIG: Kunde spricht direkt über Sex mit Fake – sexuelle Inhalte und eigene Erregung sind passend. Entferne oder entschärfe sie NICHT. Nur echte Regelverstöße korrigieren.'
        : 'WICHTIG: Kunde erzählt Story/Erlebnis (ohne direkten Sex-Bezug zum Fake) – eigene Erregungs-Beschreibungen der Moderatoren-Persona entschärfen oder entfernen. Auf Inhalt reagieren, nicht mit eigener körperlicher Reaktion. Flirty bleiben, ohne selbstbezogene Erregung.')
      : 'Entferne sexuelle Formulierungen nur, wenn im Kontext steht "Kunde möchte nicht über Sex schreiben". Sonst lasse den Text inhaltlich wie er ist.';
    const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
      ? (context.contactRequest === true
        ? 'KONTAKTDATEN: Kunde fragt nach Nummer/Telegram/WhatsApp/Instagram etc. – Die Antwort MUSS freundlich ablehnen (keine echten Kontaktdaten nennen), auf die Plattform verweisen; sachlich und deeskalierend, thematisch passende Frage am Ende. Wenn die zu korrigierende Antwort das nicht tut, unbedingt einbauen.'
        : 'Bei gereiztem Kunden: Antwort sachlich und deeskalierend, thematisch passende Frage am Ende.')
      : '';
    const metaRule = 'KEINE Meta-Kommentare, keine internen Notizen, keine Erklaerungen – ausschliesslich die eine Chat-Nachricht ausgeben.';
    const noEchoRule = 'Wiederhole die Kundennachricht NICHT woertlich oder fast woertlich. Formuliere eigenstaendig; gehe inhaltlich darauf ein, ohne seine Formulierungen zu echoen (z.B. nicht "dass du mich so X findest" wenn der Kunde "du bist so X" schrieb).';
    systemContent = `Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide immer anhand des gesamten Kontexts und der Kundennachricht. ${sexualRule} ${contactIrritatedRule} ${metaRule} ${noEchoRule} PFLICHT: Jede Nachricht braucht eine Frage am Ende. Fehlt eine Frage, füge am Ende UNBEDINGT eine kurze, thematisch passende Frage hinzu. Die Antwort MUSS auf die Kundennachricht eingehen. Wenn etwas zu korrigieren ist (fehlende Frage, kein Bezug, Kontaktdaten nicht abgelehnt, Meta/Wiederholung, Umlaute/ss, Stil), aendere es. Schreibe mit ä, ö, ü. Immer ss, nie ß. Keine Anführungszeichen. Keine Bindestriche. Antworte NUR mit der fertigen korrigierten Nachricht – kein anderer Text.`;
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

// ========== OpenAI als Korrektor (zuverlässig: Frage am Ende, Bezug zur Kundennachricht) ==========

const OPENAI_CORRECTOR_TIMEOUT_MS = 20000;
const OPENAI_CORRECTOR_MAX_TOKENS = 400;

/**
 * Korrigiert die Grok-Antwort mit OpenAI (gleiche Regeln wie Grok/LoRA-Korrektor).
 * Wird genutzt, wenn OPENAI_API_KEY gesetzt ist und weder LoRA noch USE_GROK_AS_CORRECTOR gewählt sind.
 * Bekommt optional Plan + Konversation wie der Generator.
 */
async function runOpenAICorrector({ customerMessage = '', context = {}, grokText = '', learningContext = '', exampleSnippet = '', planSnippet = '', conversationSnippet = '' }) {
  if (!grokText || !grokText.trim()) return null;
  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push('Thema Treffen/Bar/Zeit');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  if (context.contactRequest === true) ctx.push('Kunde fragt nach Kontaktdaten/Telegram/WhatsApp etc. – Antwort MUSS freundlich ablehnen und auf Plattform verweisen');
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';
  const planBlock = (planSnippet && planSnippet.trim()) ? `Plan (was die Antwort tun sollte): ${sanitizeForApiContent(planSnippet.trim().slice(0, 280))}${planSnippet.length > 280 ? '…' : ''}\n\n` : '';
  const conversationBlock = (conversationSnippet && conversationSnippet.trim()) ? `Chat-Verlauf (Auszug):\n${sanitizeForApiContent(conversationSnippet.trim().slice(-450))}\n\n` : '';
  const fullCustomerMsg = (customerMessage || '').trim();
  const customerForCorrector = fullCustomerMsg.length > 800 ? fullCustomerMsg.slice(0, 800) + '…' : fullCustomerMsg;
  const learningBlock = (learningContext && learningContext.trim()) ? `Feedback/Stil (daran orientieren): ${learningContext.trim().slice(0, 400)}\n\n` : '';
  const exampleBlock = (exampleSnippet && exampleSnippet.trim()) ? `Beispiel einer guten Antwort (Stil/Struktur so): "${exampleSnippet.trim().slice(0, 220)}${exampleSnippet.length > 220 ? '…' : ''}"\n\n` : '';
  const contactCheck = context.contactRequest === true ? '\n(5) Hat der Kunde nach Kontaktdaten/Telegram/WhatsApp gefragt und die Antwort lehnt das nicht ab? Wenn ja → freundliche Ablehnung (keine Nummer/Telegram) + Verweis auf Plattform einbauen.' : '';
  const userContent = `${contextLine}${planBlock}${conversationBlock}${learningBlock}${exampleBlock}Kundennachricht: "${sanitizeForApiContent(customerForCorrector)}"\n\nPrüfe die folgende Moderatoren-Antwort und korrigiere/verbessere sie:\n(1) Geht die Antwort auf die Kundennachricht ein? Wenn nein → umschreiben.\n(2) Steht am Ende eine Frage? Wenn nein → Frage hinzufügen.\n(3) Umlaute (ä,ö,ü) und ss statt ß? Stil/Bindestriche?\n(4) Enthält die Antwort Meta-Kommentare oder wörtliche Wiederholung der Kundennachricht? Wenn ja → entfernen, eigenständig formulieren.${contactCheck}\nGib NUR den fertigen korrigierten Text zurück, keine Erklärungen.\n\nZu korrigierende Antwort:\n\n${sanitizeForApiContent(grokText.trim())}`;

  const sexualRule = context.allowSexualContent === true
    ? (context.customerTalkingAboutSexWithFake === true
      ? 'WICHTIG: Kunde spricht direkt über Sex mit Fake – sexuelle Inhalte und eigene Erregung sind passend. Entferne oder entschärfe sie NICHT. Nur echte Regelverstöße korrigieren.'
      : 'WICHTIG: Kunde erzählt Story/Erlebnis (ohne direkten Sex-Bezug zum Fake) – eigene Erregungs-Beschreibungen der Moderatoren-Persona entschärfen oder entfernen. Auf Inhalt reagieren, nicht mit eigener körperlicher Reaktion. Flirty bleiben, ohne selbstbezogene Erregung.')
    : 'Entferne sexuelle Formulierungen nur, wenn im Kontext steht "Kunde möchte nicht über Sex schreiben". Sonst lasse den Text inhaltlich wie er ist.';
  const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
    ? (context.contactRequest === true
      ? 'KONTAKTDATEN: Kunde fragt nach Nummer/Telegram/WhatsApp/Instagram etc. – Die Antwort MUSS freundlich ablehnen (keine echten Kontaktdaten nennen), auf die Plattform verweisen; sachlich und deeskalierend, thematisch passende Frage am Ende. Wenn die zu korrigierende Antwort das nicht tut, unbedingt einbauen.'
      : 'Bei gereiztem Kunden: Antwort sachlich und deeskalierend, thematisch passende Frage am Ende.')
    : '';
  const metaRule = 'KEINE Meta-Kommentare, keine internen Notizen, keine Erklaerungen – ausschliesslich die eine Chat-Nachricht ausgeben.';
  const noEchoRule = 'Wiederhole die Kundennachricht NICHT woertlich oder fast woertlich. Formuliere eigenstaendig; gehe inhaltlich darauf ein, ohne seine Formulierungen zu echoen (z.B. nicht "dass du mich so X findest" wenn der Kunde "du bist so X" schrieb).';
  const systemContent = `Du bist ein Korrektor für Chat-Moderator-Antworten. Entscheide immer anhand des gesamten Kontexts und der Kundennachricht. ${sexualRule} ${contactIrritatedRule} ${metaRule} ${noEchoRule} PFLICHT: Jede Nachricht braucht eine Frage am Ende. Fehlt eine Frage, füge am Ende UNBEDINGT eine kurze, thematisch passende Frage hinzu. Die Antwort MUSS auf die Kundennachricht eingehen. Wenn etwas zu korrigieren ist (fehlende Frage, kein Bezug, Kontaktdaten nicht abgelehnt, Meta/Wiederholung, Umlaute/ss, Stil), aendere es. Schreibe mit ä, ö, ü. Immer ss, nie ß. Keine Anführungszeichen. Keine Bindestriche. Antworte NUR mit der fertigen korrigierten Nachricht – kein anderer Text.`;

  try {
    const corrected = await callOpenAI([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ], { temperature: 0.3, max_tokens: OPENAI_CORRECTOR_MAX_TOKENS, timeoutMs: OPENAI_CORRECTOR_TIMEOUT_MS });
    const text = (corrected || '').trim();
    if (text && text.length >= 20) {
      console.log('✅ OpenAI-Korrektor: Nachricht korrigiert (' + grokText.length + ' → ' + text.length + ' Zeichen)');
      return text;
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
    imageType = null
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

  // Doppel-Profil: 2 Namen (z.B. "Femke und Nadine") = für 2 Personen schreiben, "wir" statt "ich"
  const moderatorName = (profileInfo?.moderatorInfo?.name || extractedUserInfo?.assistant?.Name || '').trim();
  const doubleProfileHint = moderatorName.includes(' und ')
    ? 'DOPPELPROFIL: Du schreibst fuer 2 Personen (z.B. zwei Namen im Profil). Nutze "wir" statt "ich", "uns" statt "mich", "unsere" statt "meine" – als waeren zwei Personen am Schreiben.\n\n'
    : '';

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
        const finalMessage = await callGrok(messages);
        return emptyResult({
          safety: safetyCheck,
          finalMessage: postProcessMessage(finalMessage),
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
        customerHasProfilePic
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
  const detectedSituations = Array.isArray(detectedSituationsFromReply) && detectedSituationsFromReply.length > 0
    ? detectedSituationsFromReply.filter(s => s && s !== 'allgemein')
    : getDetectedSituations(customerMessage, allRules);
  const situationRulesBlock = buildSituationRulesBlock(detectedSituations, allRules);
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
  const exampleTopK = (primarySituation === 'Treffen/Termine' || primarySituation === 'Kontaktdaten außerhalb der Plattform' || primarySituation === 'Bilder Anfrage') ? 5 : 3;
  let examples = [];
  if (vectorDbFunc && typeof vectorDbFunc === 'function') {
    try {
      examples = await vectorDbFunc(customerMessage, { topK: exampleTopK, situation: primarySituation, conversationHistory, includeSexual: true }) || [];
    } catch (e) {
      // ignore
    }
  }
  if (examples.length === 0 && customerMessage) {
    try {
      examples = await selectSmartExamples(customerMessage, {
        topK: exampleTopK,
        situation: primarySituation,
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

  // Orts-Kontext für Normal-Reply: wenn Konversation um Ort/Stadt geht oder Kunde/Fake Ort nennen – immer Stadt, kein Bundesland
  let locationContext = null;
  const lowerMsg = (customerMessage || '').toLowerCase();
  const lowerHist = (conversationHistory || '').toLowerCase();
  const locationKeywords = ['welcher ort', 'ort in der nähe', 'da in der nähe', 'wo ist', 'wo liegt', 'wohnort', 'woher', 'aus '];
  const suggestsLocation = locationKeywords.some(k => lowerMsg.includes(k) || lowerHist.includes(k)) ||
    detectedSituations.some(s => s === 'Wohnort-Frage');
  let fakeCity = profileInfo?.moderatorInfo?.city || profileInfo?.moderatorInfo?.Wohnort ||
    extractedUserInfo?.assistant?.city || extractedUserInfo?.assistant?.Wohnort || null;
  let customerCity = profileInfo?.customerInfo?.city || profileInfo?.customerInfo?.wohnort ||
    extractedUserInfo?.user?.Wohnort || extractedUserInfo?.user?.wohnort || extractedUserInfo?.user?.city || null;
  const hasLocation = suggestsLocation || (customerCity && (customerCity + '').trim()) || (fakeCity && (fakeCity + '').toLowerCase() !== 'sag ich später');
  if (hasLocation && (findNearbyCityFunc && typeof findNearbyCityFunc === 'function')) {
    fakeCity = fakeCity && (fakeCity + '').toLowerCase() !== 'sag ich später' ? (fakeCity + '').trim() : null;
    customerCity = customerCity ? (customerCity + '').trim() : null;
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
  } else if (suggestsLocation) {
    fakeCity = fakeCity && (fakeCity + '').toLowerCase() !== 'sag ich später' ? (fakeCity + '').trim() : null;
    customerCity = customerCity ? (customerCity + '').trim() : null;
    if (fakeCity || customerCity) {
      locationContext = { fakeCity: fakeCity || null, customerCity: customerCity || null };
    }
  }

  // Mitten in der Konversation: kein "Hey"/"Hi"/"Hallo" am Anfang
  const isMidConversation = (conversationHistory || '').trim().length > 150;

  const isMeetingSituation = detectedSituations && detectedSituations.includes('Treffen/Termine');
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
  const { weekday, timePhase } = getBerlinTimeContext();
  const timeContextHint = `Heute ${weekday}, ${timePhase}. Nur Aktivitaeten nennen, die dazu passen (z.B. Sonntag kein Einkaufen, nachts keine Arbeit).`;
  const knownFromCustomerMessage = buildKnownFromCustomerMessage(extractedUserInfo?.user);

  // Geschlechter-Rollen (wie in multi-agent): aus Profil oder Name/Profilbild ableiten
  const customerName = (profileInfo?.customerInfo?.name || extractedUserInfo?.user?.Name || '').trim();
  const fakeGender = extractedUserInfo?.assistant?.Gender || profileInfo?.moderatorInfo?.gender || inferGenderFromName(moderatorName);
  const customerGender = profileInfo?.customerInfo?.gender || extractedUserInfo?.user?.Gender || inferGenderFromName(customerName);
  const hasSexualSituation = detectedSituations && detectedSituations.some(s => (s || '').includes('Sexuell'));
  const genderHint = buildGenderHint(fakeGender, customerGender, hasSexualSituation);

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
      isEmotional,
      noSexHint,
      imageRulesHint: true, // Kunden schicken Bilder -> positiv reagieren, nicht beschreiben; wir schicken keine -> Grund finden (Trainingsdaten)
      isContactRequest,
      isCustomerIrritatedFlag,
      emotionalToneHint,
      imageContextHint,
      timeContextHint,
      knownFromCustomerMessage
    });
    let finalMessage = await callGrok(messages);
    finalMessage = postProcessMessage(finalMessage);
    // ========== KORREKTOR: Mistral (USE_MISTRAL_CORRECTOR) | LoRA | Grok | OpenAI ==========
    const useMistralCorrector = (process.env.USE_MISTRAL_CORRECTOR === 'true' || process.env.USE_MISTRAL_CORRECTOR === '1') && !!(process.env.MISTRAL_API_KEY && process.env.MISTRAL_API_KEY.trim());
    const useGrokAsCorrector = process.env.USE_GROK_AS_CORRECTOR === 'true' || process.env.USE_GROK_AS_CORRECTOR === '1';
    const useCorrectorEnv = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
    const correctorModelId = (process.env.CORRECTOR_LORA_MODEL_ID || '').trim();
    const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
    const useOpenAICorrector = hasOpenAI && !useMistralCorrector && !useGrokAsCorrector && !(useCorrectorEnv && correctorModelId);
    const correctorContext = {
      isEmotional,
      noSexHint,
      isMeetingSituation,
      hasProfilePic: profileInfo?.customerInfo?.hasProfilePic === true,
      allowSexualContent: detectedSituations && detectedSituations.some(s => (s || '').includes('Sexuell')) && !noSexHint,
      contactRequest: isContactRequest,
      customerIrritated: isCustomerIrritatedFlag,
      customerTalkingAboutSexWithFake
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
    } else if (useOpenAICorrector) {
      console.log('🔧 Grok-Pipeline: rufe OpenAI als Korrektor auf');
      corrected = await runOpenAICorrector({
        customerMessage,
        context: correctorContext,
        grokText: finalMessage,
        learningContext: effectiveLearningContext || '',
        exampleSnippet,
        planSnippet: correctorPlanSnippet,
        conversationSnippet: correctorConversationSnippet
      });
    } else if (useGrokAsCorrector) {
      console.log('🔧 Grok-Pipeline: rufe Grok als Korrektor auf');
      corrected = await runGrokCorrector({
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
    } else if (useOpenAICorrector) {
      console.log('ℹ️ Grok-Pipeline: OpenAI-Korrektor kein Ergebnis, behalte Original');
    } else if (useGrokAsCorrector) {
      console.log('ℹ️ Grok-Pipeline: Grok-Korrektor kein Ergebnis, behalte Original');
    } else if (useCorrectorEnv && correctorModelId) {
      console.log('ℹ️ Grok-Pipeline: Korrektor kein Ergebnis (LoRA leer/Fehler/aus), behalte Original');
    }
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
    // Post-Processing: Wenn keine Frage am Ende, per OpenAI eine passende Frage anhaengen
    finalMessage = await ensureQuestionAtEnd(finalMessage);
    return emptyResult({
      safety: safetyCheck,
      finalMessage,
      stage2Examples: Array.isArray(examples) ? examples.slice(0, 5) : []
    });
  } catch (err) {
    console.error('❌ Grok normale Reply:', err.message);
    return emptyResult({ finalMessage: '', error: err.message });
  }
}

function postProcessMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  let m = msg.trim();
  // Meta-Zeilen entfernen (Hinweis:, Note:, Korrektur: etc.) – nur ganze Zeilen
  m = m.split(/\n+/).filter(line => !/^\s*(Hinweis|Note|Korrektur|Erklaerung|Erklärung):\s*/i.test(line.trim())).join(' ').trim();
  m = m.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
  m = m.replace(/ß/g, 'ss');
  // Bindestriche: in Woertern (kennen-lernen -> kennenlernen) und als Satzzeichen ( " - " -> " ")
  m = m.replace(/([a-zäöüA-ZÄÖÜ]+)-([a-zäöüA-ZÄÖÜ]+)/g, '$1$2');
  m = m.replace(/\s+-\s+/g, ' ');
  // Umlaute: typische Falschschreibungen (ganzes Wort) ersetzen
  m = m.replace(/\bwaer\b/gi, 'wär').replace(/\bwaere\b/gi, 'wäre');
  m = m.replace(/\bmoechte\b/gi, 'möchte').replace(/\bfuer\b/gi, 'für');
  m = m.replace(/\bschoen\b/gi, 'schön').replace(/\bueber\b/gi, 'über');
  m = m.replace(/\bnaechste\b/gi, 'nächste').replace(/\bnaechsten\b/gi, 'nächsten').replace(/\bnaechster\b/gi, 'nächster');
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
  return m;
}

module.exports = {
  runGrokPipeline,
  buildRulesBlock,
  checkLocationQuestion,
  callGrok,
  detectSituationsWithLLM
};
