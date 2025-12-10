const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");

const router = express.Router();

// Wenn SKIP_AUTH=true gesetzt ist, Auth überspringen (nur für Tests!)
const SKIP_AUTH = process.env.SKIP_AUTH === "true";

function isMinorMention(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  if (lower.includes("minderjähr")) return true;
  if (lower.includes("unter 18")) return true;
  if (lower.includes("unter achtzehn")) return true;
  if (lower.includes("jugendlich") && (lower.includes("14") || lower.includes("15") || lower.includes("16") || lower.includes("17"))) return true;

  const ageMatch = lower.match(/\b(1[0-7])\s*(jahr|jahre|j|alt)\b/i);
  if (ageMatch) return true;

  const illegalTerms = [
    "pädophil", "pedophil", "pedo", "kinderschänder", "kindesmissbrauch",
    "inzest", "geschwister", "mutter", "vater", "tochter", "sohn",
    "verwandt", "familienmitglied"
  ];
  for (const term of illegalTerms) {
    if (lower.includes(term)) return true;
  }

  return false;
}

async function extractInfoFromMessage(client, messageText) {
  if (!client || !messageText) return { user: {}, assistant: {} };
  try {
    const extractionPrompt = `Analysiere die folgende Nachricht und extrahiere NUR relevante Informationen über den Kunden für das Logbuch. 
Gib die Antwort NUR als JSON zurück, kein zusätzlicher Text. Format:
{
  "user": {
    "Name": "Vollständiger Name falls erwähnt, sonst null",
    "Age": "Alter als Zahl (z.B. 25) falls erwähnt, sonst null",
    "Wohnort": "Stadt/Ort falls erwähnt (z.B. 'Köln'), sonst null",
    "Work": "Beruf/Arbeit falls erwähnt, sonst null",
    "Sport and Hobbies": "Sportarten und Hobbies falls erwähnt, sonst null",
    "Sexual Preferences": "Sexuelle Vorlieben falls erwähnt, sonst null",
    "Family": "Familienstand und Kinder falls erwähnt (z.B. 'geschieden, 5-jähriges Kind' oder 'verheiratet'), sonst null",
    "Health": "Gesundheit/Krankheiten falls erwähnt, sonst null",
    "Updates": "Aktualisierungen/Neuigkeiten falls erwähnt (z.B. 'geht zum Friseur', 'hat neuen Job', 'ist umgezogen'), sonst null",
    "Other": "NUR wichtige sonstige Infos, die nicht in andere Kategorien passen, sonst null"
  },
  "assistant": {}
}

WICHTIG - IGNORIERE:
- Smalltalk, Höflichkeitsfloskeln, allgemeine Kommentare ohne Info
- Fragen ohne persönliche Informationen

WICHTIG - EXTRAHIERE nur persönliche Infos, relevante Neuigkeiten, Lebensumstände, wichtige sonstige Infos. Wenn nichts, dann null.

Nachricht: ${messageText}`;
    const extraction = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Du bist ein Daten-Extraktions-Assistent. Antworte NUR mit gültigem JSON, kein zusätzlicher Text." },
        { role: "user", content: extractionPrompt }
      ],
      max_tokens: 500,
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const extractedText = extraction.choices?.[0]?.message?.content?.trim();
    if (extractedText) {
      const parsed = JSON.parse(extractedText);
      const cleanUser = {};
      const cleanAssistant = {};
      Object.keys(parsed.user || {}).forEach(key => {
        if (parsed.user[key] !== null && parsed.user[key] !== undefined && parsed.user[key] !== "") {
          cleanUser[key] = parsed.user[key];
        }
      });
      Object.keys(parsed.assistant || {}).forEach(key => {
        if (parsed.assistant[key] !== null && parsed.assistant[key] !== undefined && parsed.assistant[key] !== "") {
          cleanAssistant[key] = parsed.assistant[key];
        }
      });
      return { user: cleanUser, assistant: cleanAssistant };
    }
  } catch (err) {
    console.error("Fehler beim Extrahieren von Informationen:", err);
  }
  return { user: {}, assistant: {} };
}

// Fallback: Summary aus metaData (customerInfo / moderatorInfo)
function buildSummaryFromMeta(metaData) {
  if (!metaData || typeof metaData !== "object") return { user: {}, assistant: {} };
  const summary = { user: {}, assistant: {} };
  const customer = metaData.customerInfo || {};
  const moderator = metaData.moderatorInfo || {};

  if (customer.name) summary.user["Name"] = customer.name;
  if (customer.birthDate?.age) summary.user["Age"] = customer.birthDate.age;
  if (customer.city) summary.user["Wohnort"] = customer.city;
  if (customer.occupation) summary.user["Work"] = customer.occupation;
  if (customer.hobbies) summary.user["Sport and Hobbies"] = customer.hobbies;
  if (customer.relationshipStatus) summary.user["Family"] = customer.relationshipStatus;
  if (customer.health) summary.user["Health"] = customer.health;
  if (customer.rawText) summary.user["Other"] = customer.rawText;

  if (moderator.name) summary.assistant["Name"] = moderator.name;
  if (moderator.birthDate?.age) summary.assistant["Age"] = moderator.birthDate.age;
  if (moderator.city) summary.assistant["Wohnort"] = moderator.city;
  if (moderator.occupation) summary.assistant["Work"] = moderator.occupation;
  if (moderator.hobbies) summary.assistant["Sport and Hobbies"] = moderator.hobbies;
  if (moderator.rawText) summary.assistant["Other"] = moderator.rawText;

  return summary;
}

// async-Wrapper
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// einfache JWT-Middleware
router.use((req, res, next) => {
  if (SKIP_AUTH) {
    console.log("⚠️ SKIP_AUTH aktiv - Auth wird übersprungen");
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ error: "Kein Token" });
  }
  const token = auth.slice(7);
  try {
    const decoded = verifyToken(token);
    req.userId = decoded.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token ungueltig" });
  }
});

// ---------------------------------------------------------------
// POST /chatcompletion
// ---------------------------------------------------------------
router.post("/", asyncHandler(async (req, res, next) => {
  try {
    console.log("✅ Route-Handler gestartet");
    console.log("✅ SKIP_AUTH:", SKIP_AUTH);

    if (!req.body || typeof req.body !== "object") {
      console.error("❌ FEHLER: req.body ist nicht definiert oder kein Objekt!");
      return res.status(400).json({
        error: "❌ FEHLER: Request-Body ist ungültig",
        resText: "❌ FEHLER: Request-Body ist ungültig",
        replyText: "❌ FEHLER: Request-Body ist ungültig",
        summary: {},
        chatId: "00000000",
        actions: [],
        flags: { blocked: true, reason: "invalid_body", isError: true, showError: true }
      });
    }

    const bodySize = JSON.stringify(req.body).length;
    console.log("=== ChatCompletion Request (SIZE CHECK) ===");
    console.log(`Request body size: ${(bodySize / 1024 / 1024).toFixed(2)} MB`);

    let {
      messageText = "",
      pageUrl,
      platformId,
      assetsToSend,
      userProfile,
      chatId,
      lastMessageFromFake,
      isASA,
      asa,
      lastMessageType,
      messageType,
      lastMessage,
      last_message,
      lastUserMessage,
      lastCustomerMessage
    } = req.body || {};

    // Logging (Felder)
    console.log("ALL request body keys:", Object.keys(req.body || {}));
    console.log("messageText length:", req.body?.messageText?.length || 0);
    console.log("userProfile keys:", req.body?.userProfile ? Object.keys(req.body.userProfile) : "none");
    console.log("assetsToSend count:", req.body?.assetsToSend?.length || 0);

    // Nachricht finden (inkl. reason-Prefix entfernen)
    let possibleMessageFromBody = null;
    if (!messageText || messageText.trim() === "") {
      const knownMessageFields = ['lastMessage', 'last_message', 'lastUserMessage', 'lastCustomerMessage', 'userMessage', 'user_message'];
      for (const field of knownMessageFields) {
        if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].trim() !== "") {
          possibleMessageFromBody = req.body[field];
          break;
        }
      }
    }

    const possibleMessageFields = ['messageText', 'message', 'text', 'content', 'message_content', 'lastMessage', 'last_message', 'userMessage', 'user_message', 'lastUserMessage', 'lastCustomerMessage', 'reason'];
    let foundMessageText = messageText || possibleMessageFromBody;

    if (messageText && messageText.trim() !== "") {
      foundMessageText = messageText;
    } else {
      for (const field of possibleMessageFields) {
        if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].trim() !== "" && !foundMessageText) {
          let extractedText = req.body[field];
          if (field === 'reason') {
            const prefixes = ['not_matching_chat_id', 'chat_id_mismatch', 'error_'];
            for (const prefix of prefixes) {
              if (extractedText.toLowerCase().startsWith(prefix.toLowerCase())) {
                extractedText = extractedText.substring(prefix.length);
                break;
              }
            }
            const textMatch = extractedText.match(/[a-zA-ZäöüÄÖÜß]{3,}.*/);
            if (textMatch) {
              extractedText = textMatch[0];
            }
          }
          if (extractedText && extractedText.trim() !== "") {
            foundMessageText = extractedText.trim();
          }
        }
      }
    }

    if ((!foundMessageText || foundMessageText.trim() === "") && userProfile && typeof userProfile === 'object') {
      if (userProfile.messageText && userProfile.messageText.trim() !== "") foundMessageText = userProfile.messageText;
      if (userProfile.message && userProfile.message.trim() !== "" && !foundMessageText) foundMessageText = userProfile.message;
      if (userProfile.lastMessage && userProfile.lastMessage.trim() !== "" && !foundMessageText) foundMessageText = userProfile.lastMessage;
    }

    if ((!foundMessageText || foundMessageText.trim() === "") && req.body?.siteInfos?.messages) {
      const msgs = req.body.siteInfos.messages;
      const lastReceived = [...msgs].reverse().find(
        m => m?.type === "received" && typeof m.text === "string" && m.text.trim() !== ""
      );
      if (lastReceived) {
        foundMessageText = lastReceived.text.trim();
      }
      if (!foundMessageText || foundMessageText.trim() === "") {
        const lastAny = [...msgs].reverse().find(
          m => typeof m.text === "string" && m.text.trim() !== ""
        );
        if (lastAny) {
          foundMessageText = lastAny.text.trim();
        }
      }
    }

    if (!platformId && req.body?.siteInfos?.origin) platformId = req.body.siteInfos.origin;
    if (!pageUrl && req.body?.url) pageUrl = req.body.url;

    // chatId-Priorität: Request > siteInfos > andere Felder > Fallback
    let foundChatId = null;
    if (chatId) foundChatId = chatId;
    if (!foundChatId && req.body?.siteInfos?.chatId) foundChatId = req.body.siteInfos.chatId;
    if (!foundChatId) {
      const possibleChatIdFields = ['chatId', 'chat_id', 'dialogueId', 'dialogue_id', 'conversationId', 'conversation_id'];
      for (const field of possibleChatIdFields) {
        if (req.body[field]) {
          foundChatId = req.body[field];
          break;
        }
      }
    }
    if (!foundChatId && typeof chatId === 'string' && chatId.includes('-')) foundChatId = chatId;

    let finalChatId = foundChatId || chatId;
    if (!finalChatId && userProfile && typeof userProfile === 'object') {
      if (userProfile.chatId) finalChatId = userProfile.chatId;
      if (userProfile.chat_id) finalChatId = userProfile.chat_id;
      if (userProfile.dialogueId) finalChatId = userProfile.dialogueId;
      if (userProfile.dialogue_id) finalChatId = userProfile.dialogue_id;
      if (userProfile.meta?.chatId) finalChatId = userProfile.meta.chatId;
      if (userProfile.metadata?.chatId) finalChatId = userProfile.metadata.chatId;
    }
    if (!finalChatId) {
      const bodyString = JSON.stringify(req.body);
      const numberMatches = bodyString.match(/\b\d{8,}\b/g);
      if (numberMatches?.length) {
        const possibleChatIds = numberMatches.filter(n => n.length >= 8 && n.length <= 10);
        if (possibleChatIds.length > 0) finalChatId = possibleChatIds[possibleChatIds.length - 1];
      }
    }
    if (!finalChatId && pageUrl) {
      const dialogueMatch = pageUrl.match(/[Dd]ialogue[#\s]*(\d+)/);
      if (dialogueMatch) finalChatId = dialogueMatch[1];
      try {
        const urlObj = new URL(pageUrl);
        const dialogueParam = urlObj.searchParams.get('dialogue') || urlObj.searchParams.get('chatId') || urlObj.searchParams.get('id');
        if (dialogueParam) finalChatId = dialogueParam;
      } catch (e) { /* ignore */ }
    }
    if (!finalChatId) {
      const foundInBody = (function findChatId(obj, depth = 0) {
        if (depth > 3 || !obj || typeof obj !== 'object') return null;
        for (const key of Object.keys(obj)) {
          const value = obj[key];
          if (key.toLowerCase().includes('chat') || key.toLowerCase().includes('dialogue') || key.toLowerCase().includes('conversation')) {
            if (typeof value === 'string' && /^\d{8,10}$/.test(value)) return value;
            if (typeof value === 'number' && value > 10000000 && value < 9999999999) return String(value);
          }
          if (typeof value === 'object' && value !== null) {
            const found = findChatId(value, depth + 1);
            if (found) return found;
          }
        }
        return null;
      })(req.body);
      if (foundInBody) finalChatId = foundInBody;
    }
    if (!finalChatId) {
      finalChatId = "00000000";
      console.warn("⚠️ Kein chatId gefunden - verwende '00000000' um Reloads zu vermeiden.");
    }

    if (isMinorMention(foundMessageText)) {
      console.error("🚨 BLOCKIERT: Minderjährige oder strafrechtliche Themen erkannt!");
      return res.status(200).json({
        error: "🚨 WICHTIG: Minderjährige oder strafrechtliche Themen erkannt! Bitte manuell prüfen!",
        resText: "🚨 WICHTIG: Minderjährige oder strafrechtliche Themen erkannt! Bitte manuell prüfen!",
        replyText: "🚨 WICHTIG: Minderjährige oder strafrechtliche Themen erkannt! Bitte manuell prüfen!",
        summary: {},
        chatId: finalChatId,
        actions: [],
        flags: { blocked: true, reason: "minor_or_illegal", isError: true, showError: true, requiresAttention: true }
      });
    }

    const client = getClient();
    if (!client) {
      const errorMessage = "❌ FEHLER: OpenAI Client nicht verfügbar. Bitte Admin kontaktieren.";
      return res.status(200).json({
        error: errorMessage,
        resText: errorMessage,
        replyText: errorMessage,
        summary: {},
        chatId: finalChatId,
        actions: [],
        flags: { blocked: true, reason: "no_client", isError: true, showError: true }
      });
    }

    if (!foundMessageText || foundMessageText.trim() === "") {
      const safeChatId = chatId || finalChatId || "00000000";
      return res.status(200).json({
        resText: "",
        replyText: "",
        summary: {},
        chatId: safeChatId,
        actions: [],
        flags: { blocked: false },
        disableAutoSend: true
      });
    }

    let replyText = null;
    let extractedInfo = { user: {}, assistant: {} };

    // ASA-Fall
    let isLastMessageFromFake = false;
    if (lastMessageFromFake !== undefined) isLastMessageFromFake = Boolean(lastMessageFromFake);
    else if (isASA !== undefined) isLastMessageFromFake = Boolean(isASA);
    else if (asa !== undefined) isLastMessageFromFake = Boolean(asa);
    else if (lastMessageType !== undefined) isLastMessageFromFake = ["sent", "asa-messages", "sent-messages"].includes(lastMessageType);
    else if (messageType !== undefined) isLastMessageFromFake = ["sent", "asa-messages", "sent-messages"].includes(messageType);

    if (isLastMessageFromFake) {
      const asaTemplates = [
        "Hey, lange nichts mehr von dir gehört, wo steckst du denn so lange? Hast du kein Interesse mehr an mir?",
        "Hallo, ich habe schon eine Weile nichts mehr von dir gehört. Ist alles okay bei dir?",
        "Hey, wo bist du denn geblieben? Ich dachte schon, du hättest das Interesse verloren.",
        "Hallo, ich vermisse unsere Unterhaltung. Schreibst du mir nicht mehr?",
        "Hey, ist etwas passiert? Ich habe schon länger nichts mehr von dir gehört.",
        "Hallo, ich warte schon auf deine Antwort. Hast du keine Zeit mehr zum Schreiben?",
        "Hey, wo steckst du denn? Ich dachte, wir hätten eine gute Verbindung.",
        "Hallo, ich hoffe, es geht dir gut. Ich würde gerne wieder von dir hören."
      ];
      let asaMessage = asaTemplates[Math.floor(Math.random() * asaTemplates.length)].trim();
      asaMessage = asaMessage.replace(/"/g, "").replace(/'/g, "").replace(/-/g, " ");
      const asaChatId = chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000";
      const minWait = 40, maxWait = 60;
      const asaWaitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
      return res.json({
        resText: asaMessage,
        replyText: asaMessage,
        summary: {},
        chatId: asaChatId,
        actions: [{ type: "insert_and_send", delay: asaWaitTime }],
        assets: assetsToSend || [],
        flags: { blocked: false, noReload: true, skipReload: true },
        disableAutoSend: true,
        waitTime: asaWaitTime,
        noReload: true
      });
    }

    // 1) Infos extrahieren
    extractedInfo = await extractInfoFromMessage(client, foundMessageText);
    // Fallback: metaData nutzen, falls leer
    if ((!extractedInfo.user || Object.keys(extractedInfo.user).length === 0) && req.body?.siteInfos?.metaData) {
      const metaSummary = buildSummaryFromMeta(req.body.siteInfos.metaData);
      if (Object.keys(metaSummary.user).length > 0 || Object.keys(metaSummary.assistant).length > 0) {
        extractedInfo = metaSummary;
        console.log("✅ Summary aus metaData übernommen (Fallback)");
      }
    }

    // 2) Antwort generieren (Prompts wie bisher)
    const lowerMessage = foundMessageText.toLowerCase();
    const isBotAccusation = ["bot", "ki", "künstliche intelligenz", "chatgpt", "fake", "automatisch", "programmiert"].some(k => lowerMessage.includes(k));
    const isSexualTopic = ["titten", "brüste", "arsch", "po", "pussy", "schwanz", "sex", "ficken", "vorlieben", "sexuell", "geil", "lust"].some(k => lowerMessage.includes(k));
    const isJobQuestion = ["was arbeitest", "beruf", "was machst du beruflich", "job", "wo arbeitest"].some(k => lowerMessage.includes(k));
    const isMeetingRequest = ["treffen", "wann", "zeit", "kennenlernen", "sehen", "date"].some(k => lowerMessage.includes(k));

    let fakeGender = null;
    let customerGender = null;
    if (userProfile && typeof userProfile === 'object') {
      if (userProfile.gender) fakeGender = userProfile.gender.toLowerCase();
      if (userProfile.sex) fakeGender = userProfile.sex.toLowerCase();
    }
    if (lowerMessage.includes("frau") || lowerMessage.includes("weiblich") || lowerMessage.includes("sie ")) customerGender = "männlich";
    if (lowerMessage.includes("mann") || lowerMessage.includes("männlich") || lowerMessage.includes("er ")) customerGender = "weiblich";

    const systemPrompt = `Du bist ein freundlicher, natürlicher Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- Antworte natürlich, flirty und interessiert, aber nicht übertrieben
- Sei konkret und persönlich, nicht generisch
- Reagiere NUR auf das, was der KUNDE in SEINER Nachricht geschrieben hat!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Wenn der Kunde nur "hi" schreibt, antworte kurz und freundlich auf "hi"
- Verwende NIEMALS deinen eigenen Namen
- Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte
- Keine Bindestriche (-); keine Anführungszeichen
- Mindestlänge 80 Zeichen; immer mit Frage enden
- Natürlich bleiben, nicht wie Moderator klingen`;

    const customerContext = [];
    if (extractedInfo.user && Object.keys(extractedInfo.user).length > 0) {
      Object.entries(extractedInfo.user).forEach(([key, value]) => {
        if (value) customerContext.push(`${key}: ${value}`);
      });
    }
    const customerName = extractedInfo.user?.Name || null;
    const customerJob = extractedInfo.user?.Work || null;

    let specificInstructions = "";
    if (isBotAccusation) {
      specificInstructions = `\n\n🚨 BOT-VORWURF:
- Emotional, verletzt reagieren
- Klarstellen, dass du kein Bot bist
- Nachfragen: "Hängt mir ein Kabel aus dem Arsch oder warum denkst du das?"`;
    }
    if (isSexualTopic) {
      specificInstructions += `\n\n💋 SEXUELLE THEMEN:
- Kompliment erwidern, flirty Frage stellen
- Offen/flirty, aber nicht übertrieben`;
    }
    if (isJobQuestion) {
      const realisticJobs = {
        "weiblich": ["Bürokauffrau", "Erzieherin", "Krankenschwester", "Verkäuferin", "Friseurin", "Köchin", "Rezeptionistin", "Marketing Managerin", "Designerin"],
        "männlich": ["Elektriker", "Mechaniker", "Verkäufer", "Koch", "Bürokaufmann", "IT-Support", "Marketing Manager", "Designer", "Handwerker"]
      };
      const jobList = (fakeGender === "weiblich" || fakeGender === "w") ? realisticJobs["weiblich"] : realisticJobs["männlich"];
      const randomJob = jobList[Math.floor(Math.random() * jobList.length)];
      specificInstructions += `\n\n💼 BERUF:
- Wenn kein Beruf im Logbuch: nimm "${randomJob}"
- Keine Jobs, die Treffen nahelegen`;
    }
    if (isMeetingRequest) {
      specificInstructions += `\n\n🚫 TREFFEN:
- Nie einem Treffen zustimmen
- Abwimmeln: erst besser kennenlernen, später reden
- Keine Orte/Zeiten nennen`;
    }
    if (fakeGender && customerGender) {
      specificInstructions += `\n\n👥 GESCHLECHTERKONTEXT:
- Du bist: ${fakeGender === "weiblich" || fakeGender === "w" ? "eine Frau" : "ein Mann"}
- Kunde ist vermutlich: ${customerGender === "weiblich" ? "eine Frau" : "ein Mann"}
- Schreibstil anpassen`;
    }

    const validatedMessage = foundMessageText.trim();
    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

Aktuelle Nachricht vom KUNDEN: "${validatedMessage.substring(0, 500)}"

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n` : ''}
${customerJob ? `Beruf des Kunden (falls relevant): ${customerJob}\n` : ''}
Plattform: ${platformId || "viluu"}
${specificInstructions}

WICHTIG:
- Nur auf diese Nachricht reagieren
- Keine Namen des Fakes nennen
- Keine Bindestriche, keine Anführungszeichen
- Mindestens 80 Zeichen, am Ende eine Frage
- Natürlich, nicht generisch`;

    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 200,
      temperature: 0.8
    });
    replyText = chat.choices?.[0]?.message?.content?.trim();

    if (!replyText || replyText.trim() === "") {
      const errorMessage = "❌ FEHLER: Konnte keine Antwort generieren. Bitte versuche es erneut.";
      return res.status(200).json({
        error: errorMessage,
        resText: errorMessage,
        replyText: errorMessage,
        summary: extractedInfo,
        chatId: finalChatId,
        actions: [],
        flags: { blocked: true, reason: "empty_response", isError: true, showError: true }
      });
    }

    replyText = replyText.trim()
      .replace(/^"/, "").replace(/"$/, "")
      .replace(/^'/, "").replace(/'$/, "")
      .replace(/"/g, "").replace(/'/g, "")
      .replace(/-/g, " ");

    if (replyText.length < 80) {
      const extensionPrompt = `Die folgende Antwort ist zu kurz. Erweitere sie auf mindestens 80 Zeichen, füge eine Frage am Ende hinzu und mache sie natürlicher. Keine Bindestriche, keine Anführungszeichen.
"${replyText}"
Antworte NUR mit der erweiterten Version.`;
      try {
        const extended = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Du erweiterst Nachrichten auf mindestens 80 Zeichen und fügst eine Frage hinzu." },
            { role: "user", content: extensionPrompt }
          ],
          max_tokens: 150,
          temperature: 0.7
        });
        const extendedText = extended.choices?.[0]?.message?.content?.trim();
        if (extendedText && extendedText.length >= 80) {
          replyText = extendedText
            .replace(/^"/, "").replace(/"$/, "")
            .replace(/^'/, "").replace(/'$/, "")
            .replace(/"/g, "").replace(/'/g, "")
            .replace(/-/g, " ");
        }
      } catch (err) {
        console.error("Fehler beim Erweitern der Antwort:", err);
      }
    }

    const hasQuestion = replyText.includes("?") && (
      replyText.trim().endsWith("?") ||
      replyText.trim().endsWith("?!") ||
      replyText.trim().endsWith("??")
    );
    if (!hasQuestion) {
      const questionPrompt = `Füge am Ende eine passende Frage hinzu. Keine Bindestriche, keine Anführungszeichen.
"${replyText}"
Antworte nur mit der kompletten Nachricht inkl. Frage.`;
      try {
        const withQuestion = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Du fügst am Ende einer Nachricht eine passende Frage hinzu." },
            { role: "user", content: questionPrompt }
          ],
          max_tokens: 100,
          temperature: 0.7
        });
        const questionText = withQuestion.choices?.[0]?.message?.content?.trim();
        if (questionText) {
          replyText = questionText
            .replace(/^"/, "").replace(/"$/, "")
            .replace(/^'/, "").replace(/'$/, "")
            .replace(/"/g, "").replace(/'/g, "")
            .replace(/-/g, " ");
        }
      } catch (err) {
        console.error("Fehler beim Hinzufügen der Frage:", err);
        if (!replyText.endsWith("?")) replyText += " Was denkst du dazu?";
      }
    }

    console.log("summary keys:", Object.keys(extractedInfo.user || {}).length, "user,", Object.keys(extractedInfo.assistant || {}).length, "assistant");

    const responseChatId = chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000";
    const minWait = 40, maxWait = 60;
    const waitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;

    return res.json({
      resText: replyText,
      replyText,
      summary: extractedInfo,
      summaryText: JSON.stringify(extractedInfo),
      chatId: responseChatId,
      actions: [{ type: "insert_and_send", delay: waitTime }],
      assets: assetsToSend || [],
      flags: { blocked: false, noReload: true, skipReload: true },
      disableAutoSend: true,
      waitTime,
      noReload: true
    });
  } catch (err) {
    console.error("❌ FEHLER IM ROUTE-HANDLER:", err);
    return res.status(500).json({
      error: `❌ FEHLER: Unerwarteter Server-Fehler: ${err.message}`,
      resText: `❌ FEHLER: Unerwarteter Server-Fehler: ${err.message}`,
      replyText: `❌ FEHLER: Unerwarteter Server-Fehler: ${err.message}`,
      summary: {},
      chatId: req.body?.chatId || "00000000",
      actions: [],
      flags: { blocked: true, reason: "server_error", isError: true, showError: true }
    });
  }
}));

module.exports = router;
