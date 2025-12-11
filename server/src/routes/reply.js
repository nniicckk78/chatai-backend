const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");

const router = express.Router();

// Wenn SKIP_AUTH=true gesetzt ist, Auth überspringen (nur für Tests!)
const SKIP_AUTH = process.env.SKIP_AUTH === "true";

// simple JWT middleware
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

function isMinorMention(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  // Direkte Erwähnungen
  if (lower.includes("minderjähr")) return true;
  if (lower.includes("unter 18")) return true;
  if (lower.includes("unter achtzehn")) return true;
  if (lower.includes("jugendlich") && (lower.includes("14") || lower.includes("15") || lower.includes("16") || lower.includes("17"))) return true;
  
  // Altersprüfung: 10-17 Jahre
  const ageMatch = lower.match(/\b(1[0-7])\s*(jahr|jahre|j|alt)\b/i);
  if (ageMatch) return true;
  
  // Strafrechtliche Themen
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
        {
          role: "system",
          content: "Du bist ein Daten-Extraktions-Assistent. Antworte NUR mit gültigem JSON, kein zusätzlicher Text."
        },
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

// Fallback: Baue Summary aus metaData (customerInfo / moderatorInfo), falls Extraktion nichts liefert
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

// Bild-URL-Erkennung im Text
function extractImageUrls(text) {
  if (!text || typeof text !== "string") return [];
  const regex = /(https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|gif|webp))/gi;
  const matches = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

// Bild als Base64 laden (max ~3MB)
async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      console.warn("fetchImageAsBase64: HTTP", res.status, url);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) {
      console.warn("fetchImageAsBase64: Bild zu groß, übersprungen", url);
      return null;
    }
    const lower = url.toLowerCase();
    let mime = "image/jpeg";
    if (lower.endsWith(".png")) mime = "image/png";
    if (lower.endsWith(".webp")) mime = "image/webp";
    if (lower.endsWith(".gif")) mime = "image/gif";
    const base64 = buf.toString("base64");
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    console.warn("fetchImageAsBase64 error:", err.message);
    return null;
  }
}

// Verlauf komprimieren (letzte n nicht-Info-Nachrichten)
function compressConversation(messages, limit = 10) {
  if (!Array.isArray(messages)) return "";
  const nonInfo = messages.filter(m => !isInfoMessage(m) && typeof m?.text === "string" && m.text.trim() !== "");
  const slice = nonInfo.slice(-limit);
  const chron = slice.sort((a, b) => {
    const ta = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });
  return chron
    .map(m => `${m.type === "received" ? "Kunde" : "Fake"}: ${m.text.trim()}`)
    .join("\n");
}

// Hilfsfunktion: Info-/System-Nachrichten erkennen (z.B. Likes/Hinweise)
function isInfoMessage(msg) {
  if (!msg || typeof msg !== "object") return true;
  const t = (msg.text || "").toLowerCase();
  const type = (msg.type || "").toLowerCase();
  const mtype = (msg.messageType || "").toLowerCase();
  if (type === "info" || mtype === "info") return true;
  if (t.includes("geliked") || t.includes("like erhalten") || t.includes("hat dich gelikt") || t.includes("like bekommen")) return true;
  if (t.includes("info:") || t.includes("hinweis:")) return true;
  return false;
}

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

router.post("/", asyncHandler(async (req, res, next) => {
  try {
    console.log("✅ Route-Handler gestartet");
    console.log("✅ SKIP_AUTH:", SKIP_AUTH);
    
    if (!req.body || typeof req.body !== 'object') {
      console.error("❌ FEHLER: req.body ist nicht definiert oder kein Objekt!");
      console.error("❌ req.body:", req.body);
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
    if (req.body?.siteInfos?.metaData) {
      console.log("metaData keys:", Object.keys(req.body.siteInfos.metaData));
      if (req.body.siteInfos.metaData.customerInfo) {
        console.log("metaData.customerInfo keys:", Object.keys(req.body.siteInfos.metaData.customerInfo));
        console.log("metaData.customerInfo.name:", req.body.siteInfos.metaData.customerInfo.name || "(none)");
      }
      if (req.body.siteInfos.metaData.moderatorInfo) {
        console.log("metaData.moderatorInfo keys:", Object.keys(req.body.siteInfos.metaData.moderatorInfo));
        console.log("metaData.moderatorInfo.name:", req.body.siteInfos.metaData.moderatorInfo.name || "(none)");
      }
    }
  
    if (bodySize > 5 * 1024 * 1024) {
      console.warn("⚠️ WARNUNG: Request body ist sehr groß (>5MB)!");
      console.warn("⚠️ Mögliche Ursachen: Zu viele assetsToSend, zu große userProfile, oder zu viele Chat-Nachrichten");
    }
  
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

    const possibleMessageFields = ['messageText', 'message', 'text', 'content', 'message_content', 'lastMessage', 'last_message', 'userMessage', 'user_message', 'lastUserMessage', 'lastCustomerMessage', 'reason'];
    let foundMessageText = messageText || possibleMessageFromBody;
  
    if (messageText && messageText.trim() !== "") {
      foundMessageText = messageText;
      console.log("✅ messageText direkt verwendet:", foundMessageText.substring(0, 100) + "...");
    } else {
      for (const field of possibleMessageFields) {
        if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].trim() !== "" && !foundMessageText) {
          let extractedText = req.body[field];
          if (field === 'reason') {
            const prefixes = ['not_matching_chat_id', 'chat_id_mismatch', 'error_'];
            for (const prefix of prefixes) {
              if (extractedText.toLowerCase().startsWith(prefix.toLowerCase())) {
                extractedText = extractedText.substring(prefix.length);
                console.log(`✅ Präfix '${prefix}' aus reason entfernt`);
                break;
              }
            }
            const textMatch = extractedText.match(/[a-zA-ZäöüÄÖÜß]{3,}.*/);
            if (textMatch) {
              extractedText = textMatch[0];
              console.log("✅ Nachricht aus reason extrahiert:", extractedText.substring(0, 100) + "...");
            }
          }
          if (extractedText && extractedText.trim() !== "") {
            foundMessageText = extractedText.trim();
            console.log(`✅ messageText gefunden unter Feldname '${field}':`, foundMessageText.substring(0, 100) + "...");
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
      let newestFirst = false;
      try {
        const firstTs = msgs[0]?.timestamp ? new Date(msgs[0].timestamp).getTime() : null;
        const lastTs = msgs[msgs.length - 1]?.timestamp ? new Date(msgs[msgs.length - 1].timestamp).getTime() : null;
        if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
      } catch (e) { /* ignore */ }
      const iter = newestFirst ? msgs : [...msgs].reverse();
      const lastReceived = iter.find(
        m => m?.type === "received" && typeof m.text === "string" && m.text.trim() !== "" && !isInfoMessage(m)
      );
      if (lastReceived) {
        foundMessageText = lastReceived.text.trim();
        console.log("✅ Nachricht aus siteInfos.messages (received):", foundMessageText.substring(0, 100) + "...");
      }
      if (!foundMessageText || foundMessageText.trim() === "") {
        const lastAny = iter.find(
          m => typeof m.text === "string" && m.text.trim() !== "" && !isInfoMessage(m)
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
    if (!isLastMessageFromFake && req.body?.siteInfos?.messages?.length) {
      const msgsAll = req.body.siteInfos.messages;
      const msgs = msgsAll.filter(m => !isInfoMessage(m));
      const list = msgs.length > 0 ? msgs : msgsAll;
      let newestFirst = false;
      try {
        const firstTs = list[0]?.timestamp ? new Date(list[0].timestamp).getTime() : null;
        const lastTs = list[list.length - 1]?.timestamp ? new Date(list[list.length - 1].timestamp).getTime() : null;
        if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
      } catch (e) { /* ignore */ }
      const newestMsg = newestFirst ? list[0] : list[list.length - 1];
      if (newestMsg?.type === "sent" || newestMsg?.messageType === "sent") {
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt über siteInfos.messages (neueste ist sent).");
      }
      const ordered = newestFirst ? list : [...list].reverse();
      if (ordered[0]?.type === "sent" && (ordered[1]?.type === "sent" || !ordered[1])) {
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt über letzte 2 Nachrichten (sent,sent) – neueste oben/unten berücksichtigt.");
      }
    }
  
    console.log("=== Nachrichten-Analyse ===");
    console.log("foundMessageText:", foundMessageText ? foundMessageText.substring(0, 200) + "..." : "(leer)");
    console.log("foundMessageText Länge:", foundMessageText ? foundMessageText.length : 0);
    console.log("isLastMessageFromFake (ASA-Fall):", isLastMessageFromFake);
  
    if (foundMessageText && foundMessageText.length > 1000) {
      console.error("❌ FEHLER: Nachricht ist zu lang (>1000 Zeichen) - könnte falsch sein!");
      console.error("❌ Erste 200 Zeichen:", foundMessageText.substring(0, 200));
    }
    if (foundMessageText) {
      console.log("foundMessageText (short):", foundMessageText.substring(0, 120));
    }

    console.log("=== ChatCompletion Request (Parsed) ===");
    console.log("messageText (original):", messageText ? messageText.substring(0, 100) + "..." : "(leer)");
    console.log("messageText (gefunden):", foundMessageText ? foundMessageText.substring(0, 100) + "..." : "(leer)");
    console.log("pageUrl:", pageUrl);
    console.log("platformId:", platformId);
    console.log("userProfile:", userProfile ? JSON.stringify(userProfile).substring(0, 100) : "fehlt");
    console.log("assetsToSend:", assetsToSend ? assetsToSend.length : 0);
    console.log("chatId aus Request:", chatId || "(nicht gesendet)");
    if (!platformId && req.body?.siteInfos?.origin) {
      platformId = req.body.siteInfos.origin;
    }
    if (!pageUrl && req.body?.url) {
      pageUrl = req.body.url;
    }
  
    let foundChatId = null;
    if (chatId) {
      foundChatId = chatId;
      console.log("✅ chatId aus Request-Body direkt (HÖCHSTE PRIORITÄT):", foundChatId);
    }
  
    if (!foundChatId && req.body?.siteInfos?.chatId) {
      foundChatId = req.body.siteInfos.chatId;
      console.log("✅ chatId aus siteInfos.chatId (FALLBACK):", foundChatId);
    }
    if (!foundChatId && req.body?.siteInfos?.metaData?.chatId) {
      foundChatId = req.body.siteInfos.metaData.chatId;
      console.log("✅ chatId aus siteInfos.metaData.chatId (FALLBACK):", foundChatId);
    }
  
    if (!foundChatId) {
      const possibleChatIdFields = ['chatId', 'chat_id', 'dialogueId', 'dialogue_id', 'conversationId', 'conversation_id'];
      for (const field of possibleChatIdFields) {
        if (req.body[field]) {
          foundChatId = req.body[field];
          console.log(`✅ chatId gefunden unter Feldname '${field}':`, foundChatId);
          break;
        }
      }
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
      } catch (e) {
        // ignore
      }
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
    let imageDescriptions = [];

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
      const imageUrls = extractImageUrls(foundMessageText);
      if (imageUrls.length > 0) {
        const firstUrl = imageUrls[0];
        console.log("Bild-URL gefunden, versuche Analyse:", firstUrl);
        const dataUrl = await fetchImageAsBase64(firstUrl);
        if (dataUrl) {
          const vision = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast dieses Bild gerade geschickt bekommen. Reagiere so, als ob du es selbst siehst: freundlich, positiv, flirty, menschlich. NIEMALS beleidigend oder negativ. Keine Ratespiele, keine Phantasie erfinden. Wenn Körper/Genitalien sichtbar: freundlich/sexuell positiv formulieren. Wenn Gesicht/Urlaub/Haustier/Haus: positiv, neugierig, charmant. Kurz halten."
              },
              {
                role: "user",
                content: [
                  { type: "text", text: "Reagiere kurz und positiv auf das Bild, als ob du es gerade erhalten hast. Keine neutral-sachliche Beschreibung, sondern menschlich und freundlich/flirty." },
                  { type: "image_url", image_url: { url: dataUrl } }
                ]
              }
            ],
            max_tokens: 120,
            temperature: 0.2
          });
          const desc = vision.choices?.[0]?.message?.content?.trim();
          if (desc) {
            imageDescriptions.push(desc);
            console.log("Bildbeschreibung:", desc.substring(0, 120));
          }
        }
      }
    } catch (err) {
      console.warn("Bildanalyse fehlgeschlagen:", err.message);
    }

    try {
      if (!imageDescriptions) {
        imageDescriptions = [];
      }
    
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
      
        let asaMessage = asaTemplates[Math.floor(Math.random() * asaTemplates.length)].trim();
        if (asaMessage.startsWith('"') && asaMessage.endsWith('"')) {
          asaMessage = asaMessage.slice(1, -1).trim();
        }
        if (asaMessage.startsWith("'") && asaMessage.endsWith("'")) {
          asaMessage = asaMessage.slice(1, -1).trim();
        }
        asaMessage = asaMessage.replace(/"/g, "").replace(/'/g, "").replace(/-/g, " ");
      
        const asaMinLen = 150;
        if (asaMessage.length < asaMinLen) {
          const filler = " Hallo? Bist du noch da? Mega schade, dass du mir nicht zurückschreibst. Ich würde mich echt freuen, wenn du mir wieder antwortest. Wo steckst du denn gerade und was hält dich ab?";
          asaMessage = (asaMessage + filler).slice(0, asaMinLen + 30).trim();
        }
        console.log("✅ ASA-Nachricht generiert:", asaMessage);
      
        const asaChatId = chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000";
      
        const minWait = 40;
        const maxWait = 60;
        const asaWaitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
      
        return res.json({
          resText: asaMessage,
          replyText: asaMessage,
          summary: {},
          chatId: asaChatId,
          actions: [
            {
              type: "insert_and_send",
              delay: asaWaitTime
            }
          ],
          assets: assetsToSend || [],
          flags: { 
            blocked: false,
            noReload: true,
            skipReload: true
          },
          disableAutoSend: true,
          waitTime: asaWaitTime,
          noReload: true
        });
      }
    
      extractedInfo = await extractInfoFromMessage(client, foundMessageText);

      if ((!extractedInfo.user || Object.keys(extractedInfo.user).length === 0) && req.body?.siteInfos?.metaData) {
        const metaSummary = buildSummaryFromMeta(req.body.siteInfos.metaData);
        if (Object.keys(metaSummary.user).length > 0 || Object.keys(metaSummary.assistant).length > 0) {
          extractedInfo = metaSummary;
          console.log("✅ Summary aus metaData übernommen (Fallback)");
        }
      }
    
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
      if (!imageDescriptions || !Array.isArray(imageDescriptions)) {
        imageDescriptions = [];
      }
      const imageContext = imageDescriptions.length > 0 ? `Erkannte Bilder:\n- ${imageDescriptions.join("\n- ")}\n` : "";
      const convoContext = compressConversation(req.body?.siteInfos?.messages || [], 10);
      const conversationBlock = convoContext ? `Letzte Nachrichten (Kunde/Fake):\n${convoContext}\n` : "";
    
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
${imageContext ? imageContext : ''}
${conversationBlock ? conversationBlock : ''}
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
      if (replyText.startsWith('"') && replyText.endsWith('"')) {
        replyText = replyText.slice(1, -1).trim();
      }
      if (replyText.startsWith("'") && replyText.endsWith("'")) {
        replyText = replyText.slice(1, -1).trim();
      }
      if (replyText.startsWith('"')) {
        replyText = replyText.replace(/^"/, '').trim();
      }
      if (replyText.startsWith("'")) {
        replyText = replyText.replace(/^'/, '').trim();
      }
      if (replyText.endsWith('"')) {
        replyText = replyText.slice(0, -1).trim();
      }
      if (replyText.endsWith("'")) {
        replyText = replyText.slice(0, -1).trim();
      }
      replyText = replyText.replace(/"/g, "").replace(/'/g, "");
      replyText = replyText.replace(/-/g, " ");
    
      if (replyText.length < 80) {
        console.warn(`⚠️ Antwort zu kurz (${replyText.length} Zeichen), versuche zu verlängern...`);
        const extensionPrompt = `Die folgende Antwort ist zu kurz. Erweitere sie auf mindestens 80 Zeichen, füge eine Frage am Ende hinzu und mache sie natürlicher. WICHTIG: Verwende KEINE Bindestriche (-) und KEINE Anführungszeichen (" oder ') in der Antwort!

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
            let cleanedExtended = extendedText.trim();
            if (cleanedExtended.startsWith('"') && cleanedExtended.endsWith('"')) {
              cleanedExtended = cleanedExtended.slice(1, -1).trim();
            }
            if (cleanedExtended.startsWith("'") && cleanedExtended.endsWith("'")) {
              cleanedExtended = cleanedExtended.slice(1, -1).trim();
            }
            cleanedExtended = cleanedExtended.replace(/"/g, "").replace(/'/g, "").replace(/-/g, " ");
            replyText = cleanedExtended;
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
        const questionPrompt = `Die folgende Nachricht endet ohne Frage. Füge am Ende eine passende, natürliche Frage zum Kontext hinzu. WICHTIG: Verwende KEINE Bindestriche (-) und KEINE Anführungszeichen (" oder ') in der Antwort!

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
            let cleanedQuestion = questionText.trim();
            if (cleanedQuestion.startsWith('"') && cleanedQuestion.endsWith('"')) {
              cleanedQuestion = cleanedQuestion.slice(1, -1).trim();
            }
            if (cleanedQuestion.startsWith("'") && cleanedQuestion.endsWith("'")) {
              cleanedQuestion = cleanedQuestion.slice(1, -1).trim();
            }
            cleanedQuestion = cleanedQuestion.replace(/"/g, "").replace(/'/g, "").replace(/-/g, " ");
            replyText = cleanedQuestion;
            console.log("✅ Frage am Ende hinzugefügt");
          }
        } catch (err) {
          console.error("Fehler beim Hinzufügen der Frage:", err);
          if (!replyText.endsWith("?")) {
            replyText += " Was denkst du dazu?";
          }
        }
      }
    
      console.log("✅ Antwort generiert:", replyText.substring(0, 100));
    } catch (err) {
      errorMessage = `❌ FEHLER: Beim Generieren der Nachricht ist ein Fehler aufgetreten: ${err.message}`;
      console.error("❌ OpenAI Fehler:", err.message);
      console.error("❌ OpenAI Fehler Stack:", err.stack);
      console.error("❌ OpenAI Fehler Details:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
      if (err.message && err.message.includes("chat ID") || err.message && err.message.includes("chatId")) {
        console.error("⚠️ WARNUNG: Fehler scheint mit chatId zusammenzuhängen, aber wir übergeben keinen chatId an OpenAI!");
        console.error("⚠️ finalChatId:", finalChatId);
      }
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

    const responseChatId = chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000";
  
    console.log("=== Response ChatId ===");
    console.log("chatId aus Request:", chatId || "(nicht gesendet)");
    console.log("siteInfos.chatId:", req.body?.siteInfos?.chatId || "(nicht gesendet)");
    console.log("finalChatId (extrahiert):", finalChatId);
    console.log("responseChatId (verwendet):", responseChatId);
    console.log("⚠️ WICHTIG: responseChatId sollte IMMER gleich dem chatId aus Request sein (falls vorhanden), um Reloads zu vermeiden!");
  
    const minWait = 40;
    const maxWait = 60;
    const waitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
  
    return res.json({
      resText: replyText,
      replyText,
      summary: extractedInfo,
      summaryText: JSON.stringify(extractedInfo),
      chatId: responseChatId,
      actions: [
        {
          type: "insert_and_send",
          delay: waitTime
        }
      ],
      assets: assetsToSend || [],
      flags: { 
        blocked: false,
        noReload: true,
        skipReload: true
      },
      disableAutoSend: true,
      waitTime: waitTime,
      noReload: true
    });
  } catch (err) {
    console.error("❌ FEHLER IM ROUTE-HANDLER (vor asyncHandler):", err);
    console.error("❌ Stack:", err.stack);
    throw err;
  }
}));

router.use((err, req, res, next) => {
  console.error("❌ UNERWARTETER FEHLER im Router-Handler:", err);
  console.error("❌ Stack:", err.stack);
  return res.status(500).json({
    error: `❌ FEHLER: Unerwarteter Server-Fehler: ${err.message}`,
    resText: `❌ FEHLER: Unerwarteter Server-Fehler: ${err.message}`,
    replyText: `❌ FEHLER: Unerwarteter Server-Fehler: ${err.message}`,
    summary: {},
    chatId: req.body?.chatId || "00000000",
    actions: [],
    flags: { blocked: true, reason: "server_error", isError: true, showError: true }
  });
});

module.exports = router;
