const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");

const router = express.Router();

// Wenn SKIP_AUTH=true gesetzt ist, Auth überspringen (nur für Tests!)
const SKIP_AUTH = process.env.SKIP_AUTH === "true";

// simple JWT middleware
router.use((req, res, next) => {
  if (SKIP_AUTH) return next();
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

WICHTIG - IGNORIERE folgendes (NICHT extrahieren):
- Smalltalk (z.B. "Wetter ist schön", "Wie geht es dir?", "Hallo", "Danke")
- Höflichkeitsfloskeln (z.B. "Bitte", "Danke", "Gern geschehen")
- Allgemeine Kommentare ohne Informationswert
- Fragen ohne persönliche Informationen

WICHTIG - EXTRAHIERE nur:
- Persönliche Informationen (Name, Alter, Wohnort, Beruf, etc.)
- Relevante Neuigkeiten/Aktivitäten (z.B. "geht zum Friseur", "hat Urlaub", "ist umgezogen")
- Wichtige Lebensumstände (Familie, Gesundheit, Arbeit, Hobbies)
- "Other" NUR für wichtige Infos, die nicht in andere Kategorien passen (z.B. wichtige Termine, Umzüge, Jobwechsel)
- Wenn nichts Relevantes erwähnt wird, null verwenden
- Bei "Family": auch Beziehungsstatus extrahieren (geschieden, verheiratet, single, etc.)

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

router.post("/", async (req, res) => {
  const bodySize = JSON.stringify(req.body).length;
  console.log("=== ChatCompletion Request (SIZE CHECK) ===");
  console.log(`Request body size: ${(bodySize / 1024 / 1024).toFixed(2)} MB`);

  console.log("=== ChatCompletion Request (KEY FIELDS) ===");
  console.log("ALL request body keys:", Object.keys(req.body || {}));
  console.log("messageText length:", req.body?.messageText?.length || 0);
  console.log("messageText value:", req.body?.messageText ? req.body.messageText.substring(0, 100) : "(empty)");
  console.log("userProfile keys:", req.body?.userProfile ? Object.keys(req.body.userProfile) : "none");
  console.log("userProfile value:", req.body?.userProfile ? JSON.stringify(req.body.userProfile).substring(0, 200) : "(empty)");
  console.log("assetsToSend count:", req.body?.assetsToSend?.length || 0);
  console.log("chatId:", req.body?.chatId || "not sent");
  console.log("pageUrl:", req.body?.pageUrl || "not sent");
  console.log("platformId:", req.body?.platformId || "not sent");

  const allFields = Object.keys(req.body || {});
  console.log("=== ALLE FELDER IM REQUEST ===");
  allFields.forEach(key => {
    const value = req.body[key];
    if (typeof value === 'string') {
      const truncated = value.length > 100 ? value.substring(0, 100) + '...' : value;
      console.log(key + ': "' + truncated + '" (length: ' + value.length + ')');
    } else if (Array.isArray(value)) {
      console.log(key + ': Array(' + value.length + ')');
    } else if (typeof value === 'object' && value !== null) {
      console.log(key + ': Object with keys: ' + Object.keys(value).join(', '));
    } else {
      console.log(key + ': ' + value);
    }
  });

  if (bodySize > 5 * 1024 * 1024) {
    console.warn("⚠️ WARNUNG: Request body ist sehr groß (>5MB)!");
    console.warn("⚠️ Mögliche Ursachen: Zu viele assetsToSend, zu große userProfile, oder zu viele Chat-Nachrichten");
  }

  const { 
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

  let possibleMessageFromBody = null;
  if (!messageText || messageText.trim() === "") {
    console.warn("⚠️ messageText ist leer - suche nach alternativen Feldern (könnte problematisch sein)");
    const knownMessageFields = ['lastMessage', 'last_message', 'lastUserMessage', 'lastCustomerMessage', 'userMessage', 'user_message'];
    for (const field of knownMessageFields) {
      if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].trim() !== "") {
        possibleMessageFromBody = req.body[field];
        console.log(`⚠️ Alternative Nachricht gefunden in '${field}':`, possibleMessageFromBody.substring(0, 100) + "...");
        break;
      }
    }
  }

  const possibleMessageFields = ['messageText', 'message', 'text', 'content', 'message_content', 'lastMessage', 'last_message', 'userMessage', 'user_message', 'lastUserMessage', 'lastCustomerMessage'];
  let foundMessageText = messageText || possibleMessageFromBody;

  if (messageText && messageText.trim() !== "") {
    foundMessageText = messageText;
    console.log("✅ messageText direkt verwendet:", foundMessageText.substring(0, 100) + "...");
  } else {
    for (const field of possibleMessageFields) {
      if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].trim() !== "" && !foundMessageText) {
        foundMessageText = req.body[field];
        console.log(`✅ messageText gefunden unter Feldname '${field}':`, foundMessageText.substring(0, 100) + "...");
      }
    }
  }

  if ((!foundMessageText || foundMessageText.trim() === "") && userProfile && typeof userProfile === 'object') {
    if (userProfile.messageText && userProfile.messageText.trim() !== "") foundMessageText = userProfile.messageText;
    if (userProfile.message && userProfile.message.trim() !== "" && !foundMessageText) foundMessageText = userProfile.message;
    if (userProfile.lastMessage && userProfile.lastMessage.trim() !== "" && !foundMessageText) foundMessageText = userProfile.lastMessage;
  }

  // Fallback: letzte Kunden-Nachricht aus siteInfos.messages holen
  if ((!foundMessageText || foundMessageText.trim() === "") && req.body?.siteInfos?.messages) {
    const msgs = req.body.siteInfos.messages;
    const lastReceived = [...msgs].reverse().find(
      m => m?.type === "received" && typeof m.text === "string" && m.text.trim() !== ""
    );
    if (lastReceived) {
      foundMessageText = lastReceived.text.trim();
      console.log("✅ Nachricht aus siteInfos.messages (received):", foundMessageText.substring(0, 100) + "...");
    }
    if (!foundMessageText || foundMessageText.trim() === "") {
      const lastAny = [...msgs].reverse().find(
        m => typeof m.text === "string" && m.text.trim() !== ""
      );
      if (lastAny) {
        foundMessageText = lastAny.text.trim();
        console.log("✅ Nachricht aus siteInfos.messages (any):", foundMessageText.substring(0, 100) + "...");
      }
    }
  }

  if (foundMessageText && foundMessageText.length > 500) {
    console.warn("⚠️ Gefundene Nachricht ist sehr lang (>500 Zeichen) - könnte falsch sein:", foundMessageText.substring(0, 100) + "...");
  }

  let isLastMessageFromFake = false;
  if (lastMessageFromFake !== undefined) {
    isLastMessageFromFake = Boolean(lastMessageFromFake);
    console.log("✅ ASA-Flag von Extension erhalten: lastMessageFromFake =", isLastMessageFromFake);
  } else if (isASA !== undefined) {
    isLastMessageFromFake = Boolean(isASA);
    console.log("✅ ASA-Flag von Extension erhalten: isASA =", isLastMessageFromFake);
  } else if (asa !== undefined) {
    isLastMessageFromFake = Boolean(asa);
    console.log("✅ ASA-Flag von Extension erhalten: asa =", isLastMessageFromFake);
  } else if (lastMessageType !== undefined) {
    isLastMessageFromFake = lastMessageType === "sent" || lastMessageType === "asa-messages" || lastMessageType === "sent-messages";
    console.log("✅ ASA-Flag aus lastMessageType erkannt:", lastMessageType, "->", isLastMessageFromFake);
  } else if (messageType !== undefined) {
    isLastMessageFromFake = messageType === "sent" || messageType === "asa-messages" || messageType === "sent-messages";
    console.log("✅ ASA-Flag aus messageType erkannt:", messageType, "->", isLastMessageFromFake);
  } else if ((!foundMessageText || foundMessageText.trim() === "") && (lastMessage || last_message || lastUserMessage || lastCustomerMessage)) {
    console.log("⚠️ messageText ist leer, aber lastMessage vorhanden - könnte ASA-Fall sein");
  } else {
    console.log("⚠️ Kein ASA-Flag von Extension gefunden - prüfe auf andere Indikatoren...");
  }

  console.log("=== Nachrichten-Analyse ===");
  console.log("foundMessageText:", foundMessageText ? foundMessageText.substring(0, 200) + "..." : "(leer)");
  console.log("foundMessageText Länge:", foundMessageText ? foundMessageText.length : 0);
  console.log("isLastMessageFromFake (ASA-Fall):", isLastMessageFromFake);

  if (foundMessageText && foundMessageText.length > 1000) {
    console.error("❌ FEHLER: Nachricht ist zu lang (>1000 Zeichen) - könnte falsch sein!");
    console.error("❌ Erste 200 Zeichen:", foundMessageText.substring(0, 200));
  }

  console.log("=== ChatCompletion Request (Parsed) ===");
  console.log("messageText (original):", messageText ? messageText.substring(0, 100) + "..." : "(leer)");
  console.log("messageText (gefunden):", foundMessageText ? foundMessageText.substring(0, 100) + "..." : "(leer)");
  console.log("pageUrl:", pageUrl);
  console.log("platformId:", platformId);
  console.log("userProfile:", userProfile ? JSON.stringify(userProfile).substring(0, 100) : "fehlt");
  console.log("assetsToSend:", assetsToSend ? assetsToSend.length : 0);
  console.log("chatId aus Request:", chatId || "(nicht gesendet)");
  // Ergänze platformId/pageUrl aus siteInfos, falls noch leer
  if (!platformId && req.body?.siteInfos?.origin) {
    platformId = req.body.siteInfos.origin;
  }
  if (!pageUrl && req.body?.url) {
    pageUrl = req.body.url;
  }

  const possibleChatIdFields = ['chatId', 'chat_id', 'dialogueId', 'dialogue_id', 'conversationId', 'conversation_id'];
  let foundChatId = chatId;
  for (const field of possibleChatIdFields) {
    if (req.body[field] && !foundChatId) {
      foundChatId = req.body[field];
      console.log(`✅ chatId gefunden unter Feldname '${field}':`, foundChatId);
    }
  }

  // chatId aus siteInfos.chatId
  if (!foundChatId && req.body?.siteInfos?.chatId) {
    foundChatId = req.body.siteInfos.chatId;
    console.log("✅ chatId aus siteInfos.chatId:", foundChatId);
  }

  if (!foundChatId && typeof chatId === 'string' && chatId.includes('-')) {
    foundChatId = chatId;
    console.log(`✅ Generierter chatId (username-lastMessage) gefunden:`, foundChatId);
  }

  let finalChatId = foundChatId || chatId;

  if (!finalChatId && userProfile && typeof userProfile === 'object') {
    if (userProfile.chatId) finalChatId = userProfile.chatId;
    if (userProfile.chat_id) finalChatId = userProfile.chat_id;
    if (userProfile.dialogueId) finalChatId = userProfile.dialogueId;
    if (userProfile.dialogue_id) finalChatId = userProfile.dialogue_id;
    if (userProfile.meta && userProfile.meta.chatId) finalChatId = userProfile.meta.chatId;
    if (userProfile.metadata && userProfile.metadata.chatId) finalChatId = userProfile.metadata.chatId;
  }

  if (!finalChatId) {
    const bodyString = JSON.stringify(req.body);
    const numberMatches = bodyString.match(/\b\d{8,}\b/g);
    if (numberMatches && numberMatches.length > 0) {
      const possibleChatIds = numberMatches.filter(n => n.length >= 8 && n.length <= 10);
      if (possibleChatIds.length > 0) {
        finalChatId = possibleChatIds[possibleChatIds.length - 1];
        console.log("✅ Möglicher chatId aus Request-Body extrahiert:", finalChatId);
      }
    }
  }

  if (!finalChatId && pageUrl) {
    const dialogueMatch = pageUrl.match(/[Dd]ialogue[#\s]*(\d+)/);
    if (dialogueMatch) {
      finalChatId = dialogueMatch[1];
      console.log("✅ chatId aus URL extrahiert:", finalChatId);
    }
    try {
      const urlObj = new URL(pageUrl);
      const dialogueParam = urlObj.searchParams.get('dialogue') || urlObj.searchParams.get('chatId') || urlObj.searchParams.get('id');
      if (dialogueParam) {
        finalChatId = dialogueParam;
        console.log("✅ chatId aus URL-Parametern extrahiert:", finalChatId);
      }
    } catch (e) {}
  }

  if (!finalChatId) {
    function findChatIdInObject(obj, depth = 0) {
      if (depth > 3) return null;
      if (!obj || typeof obj !== 'object') return null;
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (key.toLowerCase().includes('chat') || key.toLowerCase().includes('dialogue') || key.toLowerCase().includes('conversation')) {
          if (typeof value === 'string' && /^\d{8,10}$/.test(value)) return value;
          if (typeof value === 'number' && value > 10000000 && value < 9999999999) return String(value);
        }
        if (typeof value === 'object' && value !== null) {
          const found = findChatIdInObject(value, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    const foundInBody = findChatIdInObject(req.body);
    if (foundInBody) {
      finalChatId = foundInBody;
      console.log("✅ chatId rekursiv im Request-Body gefunden:", finalChatId);
    }
  }

  if (!finalChatId) {
    finalChatId = "00000000";
    console.warn("⚠️ Kein chatId gefunden - verwende generischen Wert '00000000' um Reloads zu vermeiden.");
    console.warn("⚠️ Falls die Extension blockiert, muss sie angepasst werden, um chatId im Request zu senden.");
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
      flags: { 
        blocked: true, 
        reason: "minor_or_illegal", 
        isError: true, 
        showError: true,
        requiresAttention: true
      }
    });
  }

  const client = getClient();
  let replyText = null;
  let extractedInfo = { user: {}, assistant: {} };
  let errorMessage = null;

  if (!foundMessageText || foundMessageText.trim() === "") {
    console.warn("⚠️ messageText ist leer - gebe leere Antwort zurück (keine Reloads)");
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
  
  if (!client) {
    errorMessage = "❌ FEHLER: OpenAI Client nicht verfügbar. Bitte Admin kontaktieren.";
    console.error("❌ OpenAI Client nicht verfügbar - KEINE Fallback-Nachricht!");
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

  try {
    if (isLastMessageFromFake) {
      console.log("🔄 ASA-Fall erkannt: Letzte Nachricht vom Fake, generiere Reaktivierungsnachricht...");
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
      const randomASA = asaTemplates[Math.floor(Math.random() * asaTemplates.length)];
      let asaMessage = randomASA.trim();
      if (asaMessage.startsWith('"') && asaMessage.endsWith('"')) asaMessage = asaMessage.slice(1, -1);
      if (asaMessage.startsWith("'") && asaMessage.endsWith("'")) asaMessage = asaMessage.slice(1, -1);
      console.log("✅ ASA-Nachricht generiert:", asaMessage);
      const asaChatId = chatId || finalChatId || "00000000";
      return res.json({
        resText: asaMessage,
        replyText: asaMessage,
        summary: {},
        chatId: asaChatId,
        actions: [{ type: "insert_and_send" }],
        assets: assetsToSend || [],
        flags: { blocked: false },
        disableAutoSend: false
      });
    }
    
    extractedInfo = await extractInfoFromMessage(client, foundMessageText);
    const lowerMessage = foundMessageText.toLowerCase();
    const isBotAccusation = lowerMessage.includes("bot") || lowerMessage.includes("ki") || 
                           lowerMessage.includes("künstliche intelligenz") || 
                           lowerMessage.includes("chatgpt") || lowerMessage.includes("fake") ||
                           lowerMessage.includes("automatisch") || lowerMessage.includes("programmiert");
    const isSexualTopic = lowerMessage.includes("titten") || lowerMessage.includes("brüste") ||
                         lowerMessage.includes("arsch") || lowerMessage.includes("po") ||
                         lowerMessage.includes("pussy") || lowerMessage.includes("schwanz") ||
                         lowerMessage.includes("sex") || lowerMessage.includes("ficken") ||
                         lowerMessage.includes("vorlieben") || lowerMessage.includes("sexuell") ||
                         lowerMessage.includes("geil") || lowerMessage.includes("lust");
    const isJobQuestion = lowerMessage.includes("was arbeitest") || lowerMessage.includes("beruf") ||
                         lowerMessage.includes("was machst du beruflich") || lowerMessage.includes("job") ||
                         lowerMessage.includes("wo arbeitest");
    const isMeetingRequest = lowerMessage.includes("treffen") || lowerMessage.includes("wann") ||
                            lowerMessage.includes("zeit") || lowerMessage.includes("kennenlernen") ||
                            lowerMessage.includes("sehen") || lowerMessage.includes("date");
    
    let fakeGender = null;
    let customerGender = null;
    if (userProfile && typeof userProfile === 'object') {
      if (userProfile.gender) fakeGender = userProfile.gender.toLowerCase();
      if (userProfile.sex) fakeGender = userProfile.sex.toLowerCase();
    }
    if (lowerMessage.includes("frau") || lowerMessage.includes("weiblich") || lowerMessage.includes("sie ")) {
      customerGender = "männlich";
    }
    if (lowerMessage.includes("mann") || lowerMessage.includes("männlich") || lowerMessage.includes("er ")) {
      customerGender = "weiblich";
    }
    
    const systemPrompt = `Du bist ein freundlicher, natürlicher Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- Antworte natürlich, flirty und interessiert, aber nicht übertrieben
- Sei konkret und persönlich, nicht generisch
- Reagiere NUR auf das, was der KUNDE in SEINER Nachricht geschrieben hat!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Wenn der Kunde nur "hi" schreibt, antworte kurz und freundlich auf "hi" - erfinde keine Daten oder Termine!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte
- Schreibe natürlich und menschlich - wie eine echte Person schreiben würde
- Verwende keine generischen Phrasen wie "Wie kann ich dir helfen?" oder "Hallo!"
- WICHTIG: Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- WICHTIG: Nachricht muss MINDESTENS 80 Zeichen lang sein!
- WICHTIG: Am Ende IMMER eine passende Frage zum Kontext stellen!
- WICHTIG: Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!
- WICHTIG: Reagiere NUR auf die Nachricht, die dir gegeben wird - erfinde nichts!`;
    
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
      specificInstructions = `\n\n🚨 BESONDERE SITUATION: Der Kunde wirft dir vor, ein Bot/KI/Fake zu sein!
- Reagiere verletzt und abweisend auf diese Unterstellung
- Sage klar, dass du KEIN Bot/KI/Fake bist
- Frage, warum er das denkt (z.B. "Hängt mir ein Kabel aus dem Arsch oder warum denkst du das?")
- Sei emotional und menschlich in deiner Reaktion
- Zeige, dass dich diese Unterstellung verletzt`;
    }
    
    if (isSexualTopic) {
      specificInstructions += `\n\n💋 SEXUELLE THEMEN:
- Wenn der Kunde Komplimente macht (z.B. "deine Titten sind mega"), erwidere das Kompliment (falls er ein Profilbild hat: "Du siehst auch gut aus!")
- Stelle dann eine flirty Frage (z.B. "Was würdest du jetzt gerne mit meinen Titten machen? Stehst du auf Tittenfick?")
- Sei offen und flirty, aber nicht übertrieben
- Reagiere natürlich auf sexuelle Vorlieben und Wünsche`;
    }
    
    if (isJobQuestion) {
      const realisticJobs = {
        "weiblich": ["Bürokauffrau", "Erzieherin", "Krankenschwester", "Verkäuferin", "Friseurin", "Köchin", "Rezeptionistin", "Marketing Managerin", "Designerin"],
        "männlich": ["Elektriker", "Mechaniker", "Verkäufer", "Koch", "Bürokaufmann", "IT-Support", "Marketing Manager", "Designer", "Handwerker"]
      };
      const jobList = fakeGender === "weiblich" || fakeGender === "w" ? realisticJobs["weiblich"] : realisticJobs["männlich"];
      const randomJob = jobList[Math.floor(Math.random() * jobList.length)];
      specificInstructions += `\n\n💼 BERUFSFRAGE:
- Der Kunde fragt nach deinem Beruf
- Falls kein Beruf im Logbuch steht, erfinde einen realistischen Beruf: "${randomJob}"
- Nenne den Beruf natürlich in deiner Antwort
- Keine Flugzeugbegleiter, Zugkontrolleur oder ähnliche Berufe (zu spezifisch, könnte zu Treffen führen)`;
    }
    
    if (isMeetingRequest) {
      specificInstructions += `\n\n🚫 TREFFEN/TERMINE:
- Der Kunde möchte sich treffen oder fragt nach Zeit
- WICHTIG: NIEMALS einem Treffen zustimmen oder einen Termin ausmachen!
- Lenke ab: "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen"
- Oder: "Lass uns erst noch mehr schreiben, dann können wir später darüber reden"
- Sei freundlich, aber weiche der Frage aus
- NIEMALS konkrete Termine, Orte oder Zeiten nennen!`;
    }
    
    if (fakeGender && customerGender) {
      specificInstructions += `\n\n👥 GESCHLECHTERKONTEXT:
- Du bist: ${fakeGender === "weiblich" || fakeGender === "w" ? "eine Frau" : "ein Mann"}
- Der Kunde ist wahrscheinlich: ${customerGender === "weiblich" ? "eine Frau" : "ein Mann"}
- Passe deinen Schreibstil entsprechend an (Frau zu Mann oder Mann zu Frau)`;
    }
    
    const validatedMessage = foundMessageText.trim();
    if (validatedMessage.length > 500) {
      console.error("❌ FEHLER: Nachricht ist zu lang (>500 Zeichen) - verwende nur die ersten 500 Zeichen!");
      console.error("❌ Vollständige Nachricht:", validatedMessage);
    }
    
    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

Aktuelle Nachricht vom KUNDEN: "${validatedMessage.substring(0, 500)}"

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n` : ''}
${customerJob ? `Beruf des Kunden (falls relevant): ${customerJob}\n` : ''}
Plattform: ${platformId || "viluu"}
${specificInstructions}

WICHTIG: 
- Die Nachricht kommt vom KUNDEN, nicht von dir!
- Antworte NUR auf das, was der Kunde in SEINER Nachricht geschrieben hat!
- Erfinde KEINE Informationen, die nicht in der Nachricht stehen!
- Wenn der Kunde nur "hi" schreibt, antworte kurz und freundlich auf "hi" - erfinde keine Daten, Termine oder andere Dinge!
- Antworte als FAKE-PROFIL auf den KUNDEN
- Verwende NIEMALS deinen eigenen Namen (Fake-Name) in der Antwort
- Antworte natürlich und persönlich auf die Nachricht des KUNDEN. Sei nicht generisch!
- KEINE Bindestriche (-) verwenden!
- Nachricht muss MINDESTENS 80 Zeichen lang sein!
- Am Ende IMMER eine passende Frage zum Kontext stellen!
- Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!`;

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
      errorMessage = "❌ FEHLER: Konnte keine Antwort generieren. Bitte versuche es erneut.";
      console.error("❌ Antwort ist leer - KEINE Fallback-Nachricht!");
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
    
    replyText = replyText.trim();
    if (replyText.startsWith('"') && replyText.endsWith('"')) replyText = replyText.slice(1, -1).trim();
    if (replyText.startsWith("'") && replyText.endsWith("'")) replyText = replyText.slice(1, -1).trim();
    if (replyText.startsWith('"') && !replyText.endsWith('"')) replyText = replyText.replace(/^"/, '').trim();
    if (replyText.startsWith("'") && !replyText.endsWith("'")) replyText = replyText.replace(/^'/, '').trim();
    replyText = replyText.replace(/-/g, " ");
    
    if (replyText.length < 80) {
      console.warn(`⚠️ Antwort zu kurz (${replyText.length} Zeichen), versuche zu verlängern...`);
      const extensionPrompt = `Die folgende Antwort ist zu kurz. Erweitere sie auf mindestens 80 Zeichen, füge eine Frage am Ende hinzu und mache sie natürlicher:

"${replyText}"

Antworte NUR mit der erweiterten Version, keine Erklärungen.`;
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
          replyText = extendedText.replace(/-/g, " ");
          console.log("✅ Antwort auf 80+ Zeichen erweitert");
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
      console.warn("⚠️ Keine Frage am Ende, füge eine hinzu...");
      const questionPrompt = `Die folgende Nachricht endet ohne Frage. Füge am Ende eine passende, natürliche Frage zum Kontext hinzu:

"${replyText}"

Antworte NUR mit der vollständigen Nachricht inklusive Frage am Ende, keine Erklärungen.`;
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
          replyText = questionText.replace(/-/g, " ");
          console.log("✅ Frage am Ende hinzugefügt");
        }
      } catch (err) {
        console.error("Fehler beim Hinzufügen der Frage:", err);
        if (!replyText.endsWith("?")) replyText += " Was denkst du dazu?";
      }
    }
    
    console.log("✅ Antwort generiert:", replyText.substring(0, 100));
  } catch (err) {
    errorMessage = `❌ FEHLER: Beim Generieren der Nachricht ist ein Fehler aufgetreten: ${err.message}`;
    console.error("❌ OpenAI Fehler", err.message);
    return res.status(200).json({
      error: errorMessage,
      resText: errorMessage,
      replyText: errorMessage,
      summary: extractedInfo,
      chatId: finalChatId,
      actions: [],
      flags: { blocked: true, reason: "generation_error", isError: true, showError: true }
    });
  }

  console.log("=== ChatCompletion Response ===");
  console.log("resText:", replyText.substring(0, 100));
  console.log("summary keys:", Object.keys(extractedInfo.user || {}).length, "user,", Object.keys(extractedInfo.assistant || {}).length, "assistant");

  const responseChatId = chatId || finalChatId || "00000000";
  console.log("=== Response ChatId ===");
  console.log("chatId aus Request:", chatId || "(nicht gesendet)");
  console.log("finalChatId (extrahiert):", finalChatId);
  console.log("responseChatId (verwendet):", responseChatId);
  
  return res.json({
    resText: replyText,
    replyText,
    summary: extractedInfo,
    summaryText: JSON.stringify(extractedInfo),
    chatId: responseChatId,
    actions: [{ type: "insert_and_send" }],
    assets: assetsToSend || [],
    flags: { blocked: false },
    disableAutoSend: false
  });
});

module.exports = router;
