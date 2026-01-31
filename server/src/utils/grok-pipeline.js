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

const GROK_TIMEOUT_MS = 30000;
const MAX_TOKENS = 350;

// ========== Regeln & Anweisungen ==========

function buildRulesBlock(allRules) {
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
    return {
      isLocationQuestion: true,
      locationQuestionError: null,
      cityToUse: fakeCity,
      cityInstructions: `Der Kunde fragt nach deinem Wohnort. Du MUSST zuerst deinen Wohnort nennen: "${fakeCity}". ${districtHint} Dann eine Frage zurück. Struktur: "Ich wohne in ${fakeCity} [evtl. Stadtteil]. Woher kommst du denn?"`
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

function buildASAPrompt({ allRules, asaConversationContext, asaExample }) {
  const rulesBlock = buildRulesBlock(allRules);
  const systemContent = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL auf eine System-Nachricht (Kuss oder Like) – der Kunde hat dich geliked oder einen Kuss geschickt, du schreibst die ERSTE Antwort.
${rulesBlock}

WICHTIG: Antworte natürlich, locker, freundlich. Bedanke dich kurz für Kuss/Like. Stelle 1–2 Fragen (z.B. wie geht es dir, was machst du so). Mindestens 150 Zeichen. KEINE Anführungszeichen am Anfang/Ende. Kein "ß" – immer "ss".`;

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

function buildFirstMessagePrompt({ allRules, firstMessageInstructions, profileInfo, extractedUserInfo }) {
  const rulesBlock = buildRulesBlock(allRules);
  const fakeName = extractedUserInfo?.assistant?.Name || profileInfo?.moderatorInfo?.name || 'Sandy';
  const fakeCity = extractedUserInfo?.assistant?.Stadt || profileInfo?.moderatorInfo?.city || '';
  const now = new Date();
  const berlinTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const weekday = weekdayNames[berlinTime.getDay()];
  const hour = berlinTime.getHours();
  const timePhase = hour >= 22 || hour < 6 ? 'Nacht' : hour >= 18 ? 'Abend' : hour >= 12 ? 'Nachmittag' : hour >= 6 ? 'Vormittag' : 'Nacht';

  const systemContent = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL namens ${fakeName}${fakeCity ? ` aus ${fakeCity}` : ''}.
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

function buildCityPrompt({ allRules, cityInstructions, customerMessage }) {
  const rulesBlock = buildRulesBlock(allRules);
  const systemContent = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL.
${rulesBlock}

WOHNORT-FRAGE: ${cityInstructions}

Antworte kurz (1–2 Sätze), nenne den Wohnort wie angegeben, stelle eine Frage zurück. Keine Anführungszeichen am Anfang/Ende.`;

  const userContent = `Kundennachricht: "${customerMessage}"\n\nGeneriere genau eine Antwort (nur der Text).`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];
}

function buildNormalPrompt({ allRules, customerMessage, conversationHistory, situationInstructions, examples }) {
  const rulesBlock = buildRulesBlock(allRules);
  const systemContent = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN.
${rulesBlock}

LOGIK: Gehe auf die Kundennachricht ein. Stelle eine passende Frage. Mindestens 150 Zeichen. Natürlich und locker.
${situationInstructions ? `\nSITUATION:\n${situationInstructions}\n` : ''}

Antworte NUR mit der einen Nachricht, keine Erklärungen. Keine Anführungszeichen am Anfang/Ende. Immer "ss" statt "ß".`;

  let userContent = '';
  if (conversationHistory && conversationHistory.trim()) {
    userContent += `Chat-Verlauf (Auszug):\n${conversationHistory.substring(Math.max(0, conversationHistory.length - 800))}\n\n`;
  }
  userContent += `Aktuelle Kundennachricht: "${customerMessage}"\n\n`;
  if (examples && examples.length > 0) {
    userContent += 'Beispiele (Stil/Länge daran orientieren):\n';
    examples.slice(0, 2).forEach((ex, i) => {
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

// ========== Situation für normale Reply (kurz) ==========

function getSituationInstructions(customerMessage, allRules) {
  const lower = (customerMessage || '').toLowerCase();
  const situations = allRules?.situationalResponses || {};
  if (lower.includes('treffen') || lower.includes('termine') || lower.includes('kennenlernen')) {
    return situations['Treffen/Termine'] || 'NIEMALS einem Treffen zustimmen. Freundlich ausweichen, keine Zusage.';
  }
  if (lower.includes('wohnort') || lower.includes('wo wohnst') || lower.includes('woher')) {
    return situations['Wohnort-Frage'] || 'Bei Wohnort-Frage: konkreten Ort nennen (aus Profil), dann Frage zurück.';
  }
  if (lower.includes('geld') || lower.includes('coins') || lower.includes('credits')) {
    return situations['Geld/Coins'] || 'Nicht über Credits/Aufladen sprechen. Freundlich ausweichen.';
  }
  if (lower.includes('bot') || lower.includes('ki') || lower.includes('fake')) {
    return situations['Bot-Vorwurf'] || 'Verletzt/abweisend reagieren. Klar sagen: kein Bot.';
  }
  if (lower.includes('beruf') || lower.includes('arbeit')) {
    return situations['Berufsfrage'] || 'Realistischen Beruf nennen (aus Profil oder erfinden).';
  }
  return '';
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
    vectorDbFunc = null
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

  // —— 2. Wohnort-Check (bei normaler Reply / nicht Erstnachricht, nicht ASA) ——
  if (!isFirstMessage && !isASA) {
    const loc = await checkLocationQuestion({
      customerMessage,
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
          customerMessage
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
      const messages = buildASAPrompt({
        allRules,
        asaConversationContext,
        asaExample: oneExample
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
        extractedUserInfo
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
  let examples = [];
  if (vectorDbFunc && typeof vectorDbFunc === 'function') {
    try {
      examples = await vectorDbFunc(customerMessage, { topK: 3, situation: null, conversationHistory, includeSexual: true }) || [];
    } catch (e) {
      // ignore
    }
  }
  if (examples.length === 0 && customerMessage) {
    try {
      examples = await selectSmartExamples(customerMessage, {
        topK: 3,
        conversationHistory,
        includeSexual: true
      }) || [];
    } catch (e) {
      // ignore
    }
  }
  const situationInstructions = getSituationInstructions(customerMessage, allRules);
  try {
    const messages = buildNormalPrompt({
      allRules,
      customerMessage,
      conversationHistory,
      situationInstructions,
      examples
    });
    let finalMessage = await callGrok(messages);
    finalMessage = postProcessMessage(finalMessage);
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
  return m;
}

module.exports = {
  runGrokPipeline,
  buildRulesBlock,
  checkLocationQuestion,
  callGrok
};
