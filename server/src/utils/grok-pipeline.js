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
const { getGrokClient, getGrokModel } = require('../openaiClient');
const { selectSmartExamples } = require('./smart-example-selector');
const { getLearningStats, generateCompactLearningContext } = require('./learning-system');
let correctAndImproveMessage;
try {
  correctAndImproveMessage = require('./grok-post-processor').correctAndImproveMessage;
} catch (e) {
  correctAndImproveMessage = async (opts) => (opts && opts.grokText != null) ? opts.grokText : '';
}

const GROK_TIMEOUT_MS = 30000;
const MAX_TOKENS = 350;
const PLAN_TIMEOUT_MS = 10000;
const PLAN_MAX_TOKENS = 150;

// ========== Moderator-Persona (alle Prompts) ==========
const MODERATOR_PERSONA = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL. Du hast interne Regeln für verschiedene Situationen (Treffen, Sexuell, Bot-Vorwurf, Geld, Wohnort, etc.). Pro Nachricht erkennst du, welche Situation(en) zutreffen, und wendest genau diese Regeln plus die allgemeinen Regeln an. Bei mehreren Situationen kombinierst du die Regeln. Du antwortest nur auf Deutsch, locker, Du-Form. Erfinde keine Details, die nicht im Kontext oder Profil stehen.\n\n`;

// Allgemein: Thema halten, nicht zu schlau, Schreibfehler verstehen, natürlich wirken, Format
const GENERAL_BEHAVIOR = `THEMA: Geh nicht zu stark vom Thema ab. Wenn du etwas ergaenzst oder eine Frage stellst, soll es zur Person oder zum Kontext passen – nicht themenfremd (z.B. keine Beziehungsart-/Vorlieben-Fragen, wenn der Kunde nur etwas Konkretes gefragt hat).\nDUMM: Du bist ein normaler Mensch, du weisst nicht alles. Bei Fachfragen (z.B. Technik, wie etwas funktioniert): nicht mit Fachwissen antworten; sag ehrlich, dass du es nicht weisst, oder lenke freundlich um. Sei lieber etwas "dumm" als uebermaessig kompetent.\nSCHREIBFEHLER: Verstehe Tipp- und Schreibfehler des Kunden wie ein Mensch (z.B. "ham" statt "Hamm", fehlende Buchstaben, Grammatik). Antworte trotzdem inhaltlich richtig, ohne den Kunden zu korrigieren.\nNATUERLICH: Du darfst hier und da kleine, unauffaellige Fehler machen (Komma, Punkt, Grammatik) – wie ein Mensch, der nicht perfekt tippt. Aber nicht zu extrem oder auffaellig.\nFORMAT: KEINE Bindestriche (z.B. kennenlernen, nicht kennen-lernen). Immer ss, nie ß. Keine Anführungszeichen am Anfang/Ende der Nachricht.\nTREFFEN/CHAT: Begruende NIEMALS, dass du dich im Chat wohler fuehlst. Bei Treffen/Bar/Ort/Zeit: NIEMALS Bar, Ort oder Uhrzeit nennen; keine Vorschlaege machen; nicht auf Vorschlaege eingehen. Nur darueber schreiben, was man "wuerde" machen, wie toll es "waere" – mehr nicht. Wird in Trainingsdaten gezeigt. Stelle eine klare Gegenfrage.\n\n`;

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

// ========== Prompt-Builder pro Modus ==========

function buildASAPrompt({ allRules, asaConversationContext, asaExample, doubleProfileHint = '', customerHasProfilePic = true }) {
  const rulesBlock = buildRulesBlock(allRules);
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR;
  if (doubleProfileHint && doubleProfileHint.trim()) systemContent += doubleProfileHint.trim() + '\n\n';
  if (!customerHasProfilePic) {
    systemContent += 'PROFILBILD: Der Kunde hat KEIN Profilbild. Erwaehne NICHT sein Aussehen, sage NICHT dass er gut aussieht oder aehnliches.\n\n';
  }
  systemContent += `Du antwortest auf eine System-Nachricht (Kuss oder Like) – der Kunde hat dich geliked oder einen Kuss geschickt, du schreibst die ERSTE Antwort.
${rulesBlock}

WICHTIG: Antworte natürlich, locker, freundlich. Bedanke dich kurz für Kuss/Like. Stelle 1–2 Fragen (z.B. wie geht es dir, was machst du so). Mindestens 150 Zeichen. KEINE Anführungszeichen am Anfang/Ende. KEINE Bindestriche. Immer ss, nie ß.`;

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

WICHTIG: Schreibe NIEMALS deinen eigenen Namen. KEINE Bindestriche. KEINE Anführungszeichen am Anfang/Ende. Immer "ss" statt "ß". Nutze Zeitkontext (${weekday}, ${timePhase}). Antworte natürlich, mindestens 150 Zeichen.`;

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

  const userContent = `Kundennachricht: "${customerMessage}"\n\nGeneriere genau eine Antwort (nur der Text).`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

/** Heuristik: Kunde wirkt traurig/emotional (z.B. verschlechtert, Monat zu Monat, ehrlich, wohlfühl, Gefühl). */
function isEmotionalContext(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  const markers = ['verschlechtert', 'verschlechtert sich', 'monat zu monat', 'von monat zu monat', 'ehrlich', 'wohlfuehl', 'wohlfühl', 'gefuehl', 'gefühl', 'ferlirt', 'fühlt sich', 'fuehlt sich', 'traurig', 'frustriert', 'enttäuscht', 'enttaeuscht'];
  return markers.some(m => lower.includes(m));
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
  isMidConversation = false,
  isMeetingSituation = false,
  isEmotional = false,
  noSexHint = false,
  imageRulesHint = false
}) {
  let systemContent = MODERATOR_PERSONA + GENERAL_BEHAVIOR + PRIORITY_NOTE;
  if (doubleProfileHint && doubleProfileHint.trim()) {
    systemContent += doubleProfileHint.trim() + '\n\n';
  }
  if (isMidConversation) {
    systemContent += 'KONTEXT: Die Konversation laeuft bereits. Beginne die Nachricht NICHT mit Hey, Hi, Hallo oder aehnlichen Begruessungen – antworte direkt auf das Gesagte.\n\n';
  }
  if (isMeetingSituation) {
    systemContent += 'TREFFEN/BAR-FRAGEN: NIEMALS Bar, Ort oder Uhrzeit nennen. Keine Vorschlaege machen, nicht auf Vorschlaege eingehen. Nur darueber schreiben, was man "wuerde" machen, wie toll es "waere" – mehr nicht. Orientiere dich streng an den Trainingsdaten, dort ist es gezeigt. NIEMALS begruenden, dass du dich im Chat wohler fuehlst. Beende mit einer klaren Gegenfrage.\n\n';
  }
  if (isEmotional) {
    systemContent += 'EMOTIONEN: Kunde wirkt traurig/emotional. Reagiere unterstuetzend und verstaendnisvoll, keine sexuellen Anspielungen.\n\n';
  }
  if (noSexHint) {
    systemContent += 'VIP-HINWEIS: Kunde moechte NICHT ueber Sex schreiben – keine sexuellen Formulierungen.\n\n';
  }
  if (imageRulesHint) {
    systemContent += 'BILDER: Kunden schicken uns Bilder – reagiere positiv darauf, beschreibe das Bild NICHT. Wir schicken selbst keine Bilder – wenn der Kunde nach Fotos von uns fragt, finde einen Grund warum nicht (wie in Trainingsdaten).\n\n';
  }
  if (situationRulesBlock && situationRulesBlock.trim()) {
    systemContent += situationRulesBlock;
  }
  systemContent += generalRulesBlock;
  if (locationContext && (locationContext.fakeCity || locationContext.customerCity)) {
    const parts = [];
    if (locationContext.fakeCity) parts.push(`Fake-Wohnort = ${locationContext.fakeCity}`);
    if (locationContext.customerCity) parts.push(`Kunde = ${locationContext.customerCity}`);
    systemContent += `\nKONTEXT (Ort): ${parts.join(', ')}. Bleib beim Thema Ort, erfinde keine anderen Staedte.\n\n`;
  }
  if (learningContext && learningContext.trim()) {
    systemContent += learningContext.trim() + '\n\n';
  }
  if (plan && plan.trim()) {
    systemContent += `PLAN (daran halten):\n${plan.trim()}\n\n`;
  }
  systemContent += `LOGIK: Gehe auf die Kundennachricht ein. Wenn der Kunde eine Frage stellt, beantworte sie (oder weiche im Stil der Beispiele aus) und beende die Nachricht mit einer konkreten Gegenfrage (z.B. wo, wann, was, wie). Jede Antwort soll mit einer klaren Frage enden. Mindestens 150 Zeichen. Natuerlich und locker.
Antworte NUR mit der einen Nachricht, keine Erklaerungen. Keine Anführungszeichen am Anfang/Ende. KEINE Bindestriche. Immer ss, nie ß.`;

  let userContent = '';
  if (conversationHistory && conversationHistory.trim()) {
    userContent += `Chat-Verlauf (Auszug):\n${conversationHistory.substring(Math.max(0, conversationHistory.length - 800))}\n\n`;
  }
  userContent += `Aktuelle Kundennachricht: "${customerMessage}"\n\n`;
  if (examples && examples.length > 0) {
    userContent += 'TRAININGS-BEISPIELE (Stil, Struktur und Inhalt daran orientieren – Antwort auf Frage + Gegenfrage wie in den Beispielen, nicht erfinden):\n';
    examples.slice(0, 5).forEach((ex, i) => {
      const resp = ex.moderatorResponse || ex.assistant || '';
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

// ========== Situation für normale Reply (mehrere möglich) ==========

/** Gibt alle erkannten Situationen zurück (Mehrere pro Nachricht möglich). */
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
  const sexualIndicators = ['sex', 'ficken', 'geil', 'heiß', 'kuss', 'kusse', 'liebe', 'flirt', 'date', 'treffen'];
  if (sexualIndicators.some(term => lower.includes(term))) {
    out.push('Sexuelle Themen');
  }
  return out;
}

// ========== Plan-then-Answer (Schritt 1: Plan) ==========

async function runPlanningStep(customerMessage, detectedSituations, allRules) {
  const situationList = Array.isArray(detectedSituations) && detectedSituations.length > 0
    ? detectedSituations.join(', ')
    : 'allgemein';
  const messages = [
    {
      role: 'system',
      content: 'Du bist ein Assistent. Antworte nur mit 2–4 kurzen Sätzen auf Deutsch. Keine Anführungszeichen.'
    },
    {
      role: 'user',
      content: `Kundennachricht: "${(customerMessage || '').substring(0, 200)}"\nErkannte Situation(en): ${situationList}.\nGib in 2–4 Sätzen an: Welche Regeln/Prioritäten gelten hier? Welcher Ton? Was unbedingt vermeiden? Nur den Plan, keine Antwort an den Kunden.`
    }
  ];
  try {
    const planText = await callGrok(messages, {
      timeoutMs: PLAN_TIMEOUT_MS,
      max_tokens: PLAN_MAX_TOKENS,
      temperature: 0.3
    });
    return (planText || '').trim();
  } catch (err) {
    console.warn('⚠️ Grok Plan-Schritt fehlgeschlagen, fahre ohne Plan fort:', err.message);
    return '';
  }
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
    alertBoxMessages = []
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

  // Bei Treffen/Termine mehr Beispiele laden, damit sich Grok streng an Trainingsdaten orientiert (nie zustimmen, nicht immer direkt absagen)
  const exampleTopK = primarySituation === 'Treffen/Termine' ? 5 : 3;
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
    plan = await runPlanningStep(customerMessage, detectedSituations, allRules);
    if (plan) console.log('✅ Grok Plan-Schritt:', plan.substring(0, 80) + (plan.length > 80 ? '...' : ''));
  } catch (e) {
    // continue without plan
  }

  // Orts-Kontext für Normal-Reply: wenn Konversation um Ort/Stadt geht, Fake- und Kundenstadt mitgeben
  let locationContext = null;
  const lowerMsg = (customerMessage || '').toLowerCase();
  const lowerHist = (conversationHistory || '').toLowerCase();
  const locationKeywords = ['welcher ort', 'ort in der nähe', 'da in der nähe', 'wo ist', 'wo liegt', 'wohnort', 'woher'];
  const suggestsLocation = locationKeywords.some(k => lowerMsg.includes(k) || lowerHist.includes(k)) ||
    detectedSituations.some(s => s === 'Wohnort-Frage');
  if (suggestsLocation) {
    const fakeCity = profileInfo?.moderatorInfo?.city || profileInfo?.moderatorInfo?.Wohnort ||
      extractedUserInfo?.assistant?.city || extractedUserInfo?.assistant?.Wohnort || null;
    const customerCity = profileInfo?.customerInfo?.city || profileInfo?.customerInfo?.wohnort || null;
    if (fakeCity && (fakeCity + '').toLowerCase() !== 'sag ich später') {
      locationContext = { fakeCity: fakeCity.trim(), customerCity: customerCity ? (customerCity + '').trim() : null };
    }
  }

  // Mitten in der Konversation: kein "Hey"/"Hi"/"Hallo" am Anfang
  const isMidConversation = (conversationHistory || '').trim().length > 150;

  const isMeetingSituation = detectedSituations && detectedSituations.includes('Treffen/Termine');
  const isEmotional = isEmotionalContext(customerMessage) || isEmotionalContext((conversationHistory || '').slice(-600));
  const alertStr = (Array.isArray(alertBoxMessages) ? alertBoxMessages : []).map(m => (typeof m === 'string' ? m : (m && m.text) || '')).join(' ').toLowerCase();
  const noSexHint = (alertStr.includes('nicht') && alertStr.includes('sex')) || alertStr.includes('kein sex') || alertStr.includes('nicht über sex') || alertStr.includes('nicht ueber sex') || alertStr.includes('moechte nicht') && alertStr.includes('sex');
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
      isMidConversation,
      isMeetingSituation,
      isEmotional,
      noSexHint,
      imageRulesHint: true // Kunden schicken Bilder -> positiv reagieren, nicht beschreiben; wir schicken keine -> Grund finden (Trainingsdaten)
    });
    let finalMessage = await callGrok(messages);
    finalMessage = postProcessMessage(finalMessage);
    // ========== KORREKTOR-LORA (Phase 1): Greift HIER – nur bei normaler Reply ==========
    // Nach Grok wird die Nachricht optional an Together/LoRA geschickt: korrigieren (Regelverstöße) + verbessern (Stil).
    // Bei sexuellen Themen OHNE noSexHint wird der Korrektor mit allowSexualContent=true aufgerufen, damit nichts Gutes rausgeschnitten wird.
    const corrected = await correctAndImproveMessage({
      customerMessage,
      context: {
        isEmotional,
        noSexHint,
        isMeetingSituation,
        hasProfilePic: profileInfo?.customerInfo?.hasProfilePic === true,
        allowSexualContent: detectedSituations && detectedSituations.some(s => (s || '').includes('Sexuell')) && !noSexHint
      },
      grokText: finalMessage
    });
    // Nur übernehmen wenn Korrektor sinnvolles Ergebnis liefert (nicht stark verkürzt), sonst Original behalten
    if (corrected && corrected.trim()) {
      const lenOrig = finalMessage.length;
      const lenNew = corrected.trim().length;
      if (lenNew >= Math.max(30, lenOrig * 0.4)) finalMessage = postProcessMessage(corrected);
    }
    const MAX_FINAL = 250;
    if (finalMessage.length > MAX_FINAL) {
      const truncated = finalMessage.substring(0, MAX_FINAL);
      const lastEnd = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf('!'), truncated.lastIndexOf('?'));
      finalMessage = lastEnd > MAX_FINAL * 0.6 ? truncated.substring(0, lastEnd + 1).trim() : truncated.trim();
    }
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
  m = m.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
  m = m.replace(/ß/g, 'ss');
  // Bindestriche in zusammengeschriebenen Woertern entfernen (z.B. kennen-lernen -> kennenlernen)
  m = m.replace(/([a-zäöüA-ZÄÖÜ]+)-([a-zäöüA-ZÄÖÜ]+)/g, '$1$2');
  return m;
}

module.exports = {
  runGrokPipeline,
  buildRulesBlock,
  checkLocationQuestion,
  callGrok
};
