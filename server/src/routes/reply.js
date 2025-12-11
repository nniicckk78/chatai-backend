const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");
const fs = require("fs");
const path = require("path");

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
      // Entferne null-Werte
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

  // Kunde
  if (customer.name) summary.user["Name"] = customer.name;
  if (customer.birthDate?.age) summary.user["Age"] = customer.birthDate.age;
  if (customer.city) summary.user["Wohnort"] = customer.city;
  if (customer.occupation) summary.user["Work"] = customer.occupation;
  if (customer.hobbies) summary.user["Sport and Hobbies"] = customer.hobbies;
  if (customer.relationshipStatus) summary.user["Family"] = customer.relationshipStatus;
  if (customer.health) summary.user["Health"] = customer.health;
  if (customer.rawText) summary.user["Other"] = customer.rawText;

  // Fake/Moderator
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

// Hilfsfunktion: Info-/System-Nachrichten erkennen (z.B. Likes/Hinweise)
function isInfoMessage(msg) {
  if (!msg || typeof msg !== "object") return true;
  const t = (msg.text || "").toLowerCase();
  const type = (msg.type || "").toLowerCase();
  const mtype = (msg.messageType || "").toLowerCase();
  if (type === "info" || mtype === "info") return true;
  // Häufige Hinweise (FPC Like, System)
  if (t.includes("geliked") || t.includes("like erhalten") || t.includes("hat dich gelikt") || t.includes("like bekommen")) return true;
  if (t.includes("info:") || t.includes("hinweis:")) return true;
  return false;
}

// Verlauf komprimieren (letzte n nicht-Info-Nachrichten)
function compressConversation(messages, limit = 30) {
  if (!Array.isArray(messages)) return "";
  const nonInfo = messages.filter(m => !isInfoMessage(m) && typeof m?.text === "string" && m.text.trim() !== "");
  const slice = nonInfo.slice(-limit);
  // Erkenne Reihenfolge: neueste oben oder unten
  let newestFirst = false;
  try {
    if (slice.length > 1) {
      const firstTs = slice[0]?.timestamp ? new Date(slice[0].timestamp).getTime() : null;
      const lastTs = slice[slice.length - 1]?.timestamp ? new Date(slice[slice.length - 1].timestamp).getTime() : null;
      if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
    }
  } catch (e) { /* ignore */ }
  const chron = newestFirst ? [...slice].reverse() : slice;
  return chron
    .map(m => `${m.type === "received" ? "Kunde" : "Fake"}: ${m.text.trim()}`)
    .join("\n");
}

// Analysiere Schreibstil der letzten Moderator-Nachrichten
function analyzeWritingStyle(messages) {
  if (!Array.isArray(messages)) return null;
  const moderatorMsgs = messages
    .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
    .slice(-10); // Letzte 10 Moderator-Nachrichten
  
  if (moderatorMsgs.length === 0) return null;
  
  const texts = moderatorMsgs.map(m => m.text.trim());
  const avgLength = texts.reduce((sum, t) => sum + t.length, 0) / texts.length;
  const hasEmojis = texts.some(t => /[\u{1F300}-\u{1F9FF}]/u.test(t));
  const hasExclamation = texts.some(t => t.includes("!"));
  const hasQuestion = texts.some(t => t.includes("?"));
  const casualWords = ["hey", "hallo", "hi", "okay", "ok", "ja", "nein", "mega", "geil", "wow"];
  const hasCasual = texts.some(t => casualWords.some(w => t.toLowerCase().includes(w)));
  
  return {
    avgLength: Math.round(avgLength),
    hasEmojis,
    hasExclamation,
    hasQuestion,
    hasCasual,
    sampleTexts: texts.slice(-3).join(" | ") // Letzte 3 als Beispiel
  };
}

// Zähle Kunden-Nachrichten (für Neukunde vs. Langzeitkunde)
function countCustomerMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "").length;
}

// Validiere und filtere assetsToSend, um undefined-Elemente und ungültige Objekte zu entfernen
function validateAssets(assetsToSend) {
  if (!Array.isArray(assetsToSend)) {
    if (assetsToSend) {
      console.warn("⚠️ assetsToSend ist kein Array:", typeof assetsToSend);
    }
    return [];
  }
  
  const validAssets = assetsToSend.filter(asset => {
    // Entferne undefined/null Elemente
    if (!asset || typeof asset !== 'object') {
      console.warn("⚠️ Ungültiges Asset gefunden (undefined/null/nicht-Objekt), entferne:", asset);
      return false;
    }
    // Prüfe auf Template-Strings, die nicht ersetzt wurden (z.B. {{image.url}})
    try {
      const assetStr = JSON.stringify(asset);
      if (assetStr.includes('{{') || assetStr.includes('}}')) {
        console.warn("⚠️ Asset enthält nicht-ersetzte Template-Strings, entferne:", assetStr.substring(0, 100));
        return false;
      }
    } catch (err) {
      console.warn("⚠️ Fehler beim Stringify von Asset, entferne:", err.message);
      return false;
    }
    // Prüfe, ob asset gültige Eigenschaften hat (mindestens url oder id sollte vorhanden sein)
    if (!asset.url && !asset.id && !asset.src && !asset.imageUrl) {
      console.warn("⚠️ Asset hat keine gültigen Eigenschaften (url/id/src/imageUrl), entferne:", asset);
      return false;
    }
    return true;
  });
  
  if (assetsToSend.length !== validAssets.length) {
    console.log(`✅ assetsToSend validiert: ${assetsToSend.length} -> ${validAssets.length} gültige Assets`);
  }
  
  return validAssets;
}

// Wrapper für async-Fehler
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

router.post("/", asyncHandler(async (req, res, next) => {
  // #region agent log
  try{const logPath=path.join(__dirname,'../../.cursor/debug.log');const logDir=path.dirname(logPath);if(!fs.existsSync(logDir))fs.mkdirSync(logDir,{recursive:true});fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:275',message:'Route handler entry',data:{hasBody:!!req.body,bodyKeys:req.body?Object.keys(req.body):[]},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})+'\n');}catch(e){}
  // #endregion
  // Logge die Größe des Request-Body, um zu sehen, was die Extension sendet
  let bodySize = 0;
  try {
    bodySize = JSON.stringify(req.body).length;
  } catch (err) {
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:282',message:'JSON.stringify req.body failed',data:{error:err.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})+'\n');}catch(e){}
    // #endregion
    console.error("❌ FEHLER: JSON.stringify(req.body) fehlgeschlagen:", err.message);
  }
  console.log("=== ChatCompletion Request (SIZE CHECK) ===");
  console.log(`Request body size: ${(bodySize / 1024 / 1024).toFixed(2)} MB`);
  
  // Logge nur wichtige Felder, nicht den kompletten Body (kann zu groß sein)
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
  
  // Prüfe ALLE möglichen Felder, die die Extension senden könnte
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
  // Log metaData-Übersicht (falls vorhanden)
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
  
  // WICHTIG: Wenn der Body zu groß ist, könnte die Extension zu viele Daten senden
  // Prüfe, ob assetsToSend oder userProfile zu groß sind
  if (bodySize > 5 * 1024 * 1024) { // > 5MB
    console.warn("⚠️ WARNUNG: Request body ist sehr groß (>5MB)!");
    console.warn("⚠️ Mögliche Ursachen: Zu viele assetsToSend, zu große userProfile, oder zu viele Chat-Nachrichten");
  }
  
  // WICHTIG: Extrahiere ALLE möglichen Felder, die die Extension senden könnte
  // Die Extension könnte den chatId oder die Nachricht in verschiedenen Formaten senden
  // Die alte Extension hat wahrscheinlich bereits alles richtig erkannt - wir müssen nur die Felder richtig lesen
  const { 
    messageText = "", 
    pageUrl, 
    platformId, 
    assetsToSend, 
    userProfile, 
    chatId,
    // Mögliche Felder für ASA-Erkennung (von alter Extension)
    lastMessageFromFake,
    isASA,
    asa,
    lastMessageType,
    messageType,
    // Mögliche Felder für die letzte Nachricht
    lastMessage,
    last_message,
    lastUserMessage,
    lastCustomerMessage
  } = req.body || {};
  
  // WICHTIG: Die Extension sollte die richtige Nachricht in messageText senden
  // Wir suchen NICHT mehr nach anderen Nachrichten im Body, da das zu falschen Nachrichten führen kann
  // Nur wenn messageText wirklich leer ist, suchen wir nach alternativen Feldern
  let possibleMessageFromBody = null;
  
  // NUR wenn messageText wirklich leer ist, suche nach alternativen Feldern
  // ABER: Sei vorsichtig - die Extension sollte die richtige Nachricht senden!
  if (!messageText || messageText.trim() === "") {
    console.warn("⚠️ messageText ist leer - suche nach alternativen Feldern (könnte problematisch sein)");
    
    // Suche NUR in bekannten Feldern, nicht rekursiv im ganzen Body
    // Das verhindert, dass wir falsche Nachrichten finden
    const knownMessageFields = ['lastMessage', 'last_message', 'lastUserMessage', 'lastCustomerMessage', 'userMessage', 'user_message'];
    for (const field of knownMessageFields) {
      if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].trim() !== "") {
        possibleMessageFromBody = req.body[field];
        console.log(`⚠️ Alternative Nachricht gefunden in '${field}':`, possibleMessageFromBody.substring(0, 100) + "...");
        break; // Nimm die erste gefundene
      }
    }
  }

  // WICHTIG: Prüfe auch andere mögliche Feldnamen für messageText
  // Die Extension könnte die Nachricht unter einem anderen Namen senden
  // WICHTIG: Die letzte Nachricht ist IMMER vom KUNDEN (unten im Chat)
  // Wenn die letzte Nachricht vom FAKE ist, müssen wir eine ASA-Nachricht schreiben
  // WICHTIG: Wir müssen die RICHTIGE letzte Nachricht vom KUNDEN finden, nicht irgendeine Nachricht!
  const possibleMessageFields = ['messageText', 'message', 'text', 'content', 'message_content', 'lastMessage', 'last_message', 'userMessage', 'user_message', 'lastUserMessage', 'lastCustomerMessage'];
  let foundMessageText = messageText || possibleMessageFromBody;
  
  // PRIORITÄT: messageText sollte die letzte Nachricht vom Kunden sein
  // Wenn messageText vorhanden ist, verwende es (es sollte die richtige Nachricht sein)
  if (messageText && messageText.trim() !== "") {
    foundMessageText = messageText;
    console.log("✅ messageText direkt verwendet:", foundMessageText.substring(0, 100) + "...");
  } else {
    // Nur wenn messageText leer ist, suche nach anderen Feldern
    for (const field of possibleMessageFields) {
      if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].trim() !== "" && !foundMessageText) {
        foundMessageText = req.body[field];
        console.log(`✅ messageText gefunden unter Feldname '${field}':`, foundMessageText.substring(0, 100) + "...");
      }
    }
  }
  
  // Prüfe auch in userProfile oder anderen verschachtelten Objekten (nur wenn noch nichts gefunden)
  if ((!foundMessageText || foundMessageText.trim() === "") && userProfile && typeof userProfile === 'object') {
    if (userProfile.messageText && userProfile.messageText.trim() !== "") foundMessageText = userProfile.messageText;
    if (userProfile.message && userProfile.message.trim() !== "" && !foundMessageText) foundMessageText = userProfile.message;
    if (userProfile.lastMessage && userProfile.lastMessage.trim() !== "" && !foundMessageText) foundMessageText = userProfile.lastMessage;
  }

  // Fallback: letzte Kunden-Nachricht aus siteInfos.messages holen
  if ((!foundMessageText || foundMessageText.trim() === "") && req.body?.siteInfos?.messages) {
    const msgs = req.body.siteInfos.messages;
    // Kunde = type === "received"
    const lastReceived = [...msgs].reverse().find(
      m => m?.type === "received" && typeof m.text === "string" && m.text.trim() !== ""
    );
    if (lastReceived) {
      foundMessageText = lastReceived.text.trim();
      console.log("✅ Nachricht aus siteInfos.messages (received):", foundMessageText.substring(0, 100) + "...");
    }
    // Falls keine received-Nachricht gefunden: letzte beliebige Text-Nachricht
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
  
  // WICHTIG: Prüfe, ob die gefundene Nachricht wirklich vom Kunden ist
  // Wenn die Nachricht zu lang ist oder komisch klingt, könnte es eine falsche Nachricht sein
  if (foundMessageText && foundMessageText.length > 500) {
    console.warn("⚠️ Gefundene Nachricht ist sehr lang (>500 Zeichen) - könnte falsch sein:", foundMessageText.substring(0, 100) + "...");
  }
  
  // Prüfe, ob die letzte Nachricht vom FAKE/Moderator kommt (ASA-Fall)
  // Die alte Extension hat wahrscheinlich bereits erkannt, ob die letzte Nachricht vom Fake kommt
  // Wir prüfen alle möglichen Felder, die die Extension senden könnte
  let isLastMessageFromFake = false;
  
  // Direkte Flags
  if (lastMessageFromFake !== undefined) {
    isLastMessageFromFake = Boolean(lastMessageFromFake);
    console.log("✅ ASA-Flag von Extension erhalten: lastMessageFromFake =", isLastMessageFromFake);
  } else if (isASA !== undefined) {
    isLastMessageFromFake = Boolean(isASA);
    console.log("✅ ASA-Flag von Extension erhalten: isASA =", isLastMessageFromFake);
  } else if (asa !== undefined) {
    isLastMessageFromFake = Boolean(asa);
    console.log("✅ ASA-Flag von Extension erhalten: asa =", isLastMessageFromFake);
  } 
  // Prüfe messageType oder lastMessageType
  else if (lastMessageType !== undefined) {
    // Wenn lastMessageType === "sent" oder "asa-messages", dann ist es vom Fake
    isLastMessageFromFake = lastMessageType === "sent" || lastMessageType === "asa-messages" || lastMessageType === "sent-messages";
    console.log("✅ ASA-Flag aus lastMessageType erkannt:", lastMessageType, "->", isLastMessageFromFake);
  } else if (messageType !== undefined) {
    isLastMessageFromFake = messageType === "sent" || messageType === "asa-messages" || messageType === "sent-messages";
    console.log("✅ ASA-Flag aus messageType erkannt:", messageType, "->", isLastMessageFromFake);
  }
  // Prüfe, ob messageText leer ist UND es gibt eine lastMessage (vom Fake)
  else if ((!foundMessageText || foundMessageText.trim() === "") && (lastMessage || last_message || lastUserMessage || lastCustomerMessage)) {
    // Wenn messageText leer ist, aber es gibt eine lastMessage, könnte es sein, dass die letzte Nachricht vom Fake ist
    // ABER: Das ist unsicher, daher nur als Hinweis loggen
    console.log("⚠️ messageText ist leer, aber lastMessage vorhanden - könnte ASA-Fall sein");
    // Wir machen es NICHT automatisch zu ASA, da es auch andere Gründe geben kann
  } else {
    console.log("⚠️ Kein ASA-Flag von Extension gefunden - prüfe auf andere Indikatoren...");
  }
  
  // Backup: Prüfe letzte Nachricht in siteInfos.messages (richtige Reihenfolge erkennen: iluvo ggf. neueste oben)
  if (!isLastMessageFromFake && req.body?.siteInfos?.messages?.length) {
    const msgsAll = req.body.siteInfos.messages;
    const msgs = msgsAll.filter(m => !isInfoMessage(m));
    const list = msgs.length > 0 ? msgs : msgsAll;
    let newestFirst = false;
    try {
      if (list.length > 1) {
        const firstTs = list[0]?.timestamp ? new Date(list[0].timestamp).getTime() : null;
        const lastTs = list[list.length - 1]?.timestamp ? new Date(list[list.length - 1].timestamp).getTime() : null;
        if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
      }
    } catch (e) { /* ignore */ }
    const newestMsg = newestFirst ? list[0] : list[list.length - 1];
    if (newestMsg?.type === "sent" || newestMsg?.messageType === "sent") {
      isLastMessageFromFake = true;
      console.log("✅ ASA erkannt über siteInfos.messages (neueste ist sent).");
    }
    // Zusätzlich: wenn die letzten 2 Nachrichten (neueste zuerst) beide sent sind -> ASA
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
  
  // WICHTIG: Validiere die Nachricht - sie sollte nicht zu lang oder komisch sein
  if (foundMessageText && foundMessageText.length > 1000) {
    console.error("❌ FEHLER: Nachricht ist zu lang (>1000 Zeichen) - könnte falsch sein!");
    console.error("❌ Erste 200 Zeichen:", foundMessageText.substring(0, 200));
  }
  // Kurzlog der gefundenen Nachricht (gekürzt)
  if (foundMessageText) {
    console.log("foundMessageText (short):", foundMessageText.substring(0, 120));
  }

  // Logging für Debugging
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
  
  // Prüfe auch andere mögliche Feldnamen für chatId
  // Die Extension generiert chatId als `${username}-${lastMessage}`, also kann es auch ein String sein
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
  
  // NEU: Fallback auf metaData.chatId (falls vorhanden)
  if (!foundChatId && req.body?.siteInfos?.metaData?.chatId) {
    foundChatId = req.body.siteInfos.metaData.chatId;
    console.log("✅ chatId aus siteInfos.metaData.chatId (FALLBACK):", foundChatId);
  }
  
  // Die Extension generiert chatId manchmal als `${username}-${lastMessage}`
  // Prüfe auch, ob es einen generierten chatId gibt (String mit Bindestrich)
  if (!foundChatId && typeof chatId === 'string' && chatId.includes('-')) {
    foundChatId = chatId;
    console.log(`✅ Generierter chatId (username-lastMessage) gefunden:`, foundChatId);
  }

  // Versuche chatId zu extrahieren, falls nicht im Request vorhanden
  let finalChatId = foundChatId || chatId;
  
  // Prüfe auch userProfile für chatId (verschachtelt)
  if (!finalChatId && userProfile && typeof userProfile === 'object') {
    if (userProfile.chatId) finalChatId = userProfile.chatId;
    if (userProfile.chat_id) finalChatId = userProfile.chat_id;
    if (userProfile.dialogueId) finalChatId = userProfile.dialogueId;
    if (userProfile.dialogue_id) finalChatId = userProfile.dialogue_id;
    // Prüfe auch verschachtelte Objekte
    if (userProfile.meta && userProfile.meta.chatId) finalChatId = userProfile.meta.chatId;
    if (userProfile.metadata && userProfile.metadata.chatId) finalChatId = userProfile.metadata.chatId;
  }
  
  // Prüfe alle Felder im Request-Body nach chatId-ähnlichen Werten
  if (!finalChatId) {
    const bodyString = JSON.stringify(req.body);
    // Suche nach Zahlen, die wie chatIds aussehen (z.B. "58636919")
    const numberMatches = bodyString.match(/\b\d{8,}\b/g);
    if (numberMatches && numberMatches.length > 0) {
      // Nimm die größte Zahl, die wie ein chatId aussieht
      const possibleChatIds = numberMatches.filter(n => n.length >= 8 && n.length <= 10);
      if (possibleChatIds.length > 0) {
        finalChatId = possibleChatIds[possibleChatIds.length - 1];
        console.log("✅ Möglicher chatId aus Request-Body extrahiert:", finalChatId);
      }
    }
  }
  
  if (!finalChatId && pageUrl) {
    // Versuche chatId aus URL zu extrahieren (z.B. "Dialogue #58784193" oder ähnliche Patterns)
    const dialogueMatch = pageUrl.match(/[Dd]ialogue[#\s]*(\d+)/);
    if (dialogueMatch) {
      finalChatId = dialogueMatch[1];
      console.log("✅ chatId aus URL extrahiert:", finalChatId);
    }
    // Versuche auch aus URL-Parametern
    try {
      const urlObj = new URL(pageUrl);
      const dialogueParam = urlObj.searchParams.get('dialogue') || urlObj.searchParams.get('chatId') || urlObj.searchParams.get('id');
      if (dialogueParam) {
        finalChatId = dialogueParam;
        console.log("✅ chatId aus URL-Parametern extrahiert:", finalChatId);
      }
    } catch (e) {
      // URL parsing failed, ignore
    }
  }
  
  // WORKAROUND: Falls immer noch kein chatId gefunden wurde
  // Das alte Backend hat wahrscheinlich einfach null zurückgegeben oder einen generischen Wert
  // Da die Extension den chatId auf der Seite findet, aber nicht sendet, können wir ihn nicht kennen
  // ABER: Vielleicht hat das alte Backend einfach null zurückgegeben und die Extension hat trotzdem funktioniert?
  // Oder: Vielleicht sendet die Extension den chatId in einem Feld, das wir noch nicht geprüft haben?
  // 
  // Versuche: Prüfe ALLE Felder im Request-Body rekursiv nach chatId-ähnlichen Werten
  if (!finalChatId) {
    function findChatIdInObject(obj, depth = 0) {
      if (depth > 3) return null; // Max depth
      if (!obj || typeof obj !== 'object') return null;
      
      // Prüfe direkte Felder
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        // Prüfe auf chatId-ähnliche Feldnamen
        if (key.toLowerCase().includes('chat') || key.toLowerCase().includes('dialogue') || key.toLowerCase().includes('conversation')) {
          if (typeof value === 'string' && /^\d{8,10}$/.test(value)) {
            return value;
          }
          if (typeof value === 'number' && value > 10000000 && value < 9999999999) {
            return String(value);
          }
        }
        // Rekursiv in verschachtelten Objekten suchen
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
  
  // FINAL FALLBACK: Wenn wirklich kein chatId gefunden wurde
  // WICHTIG: Die Extension prüft alle 2 Sekunden, ob sich die Chat-ID ändert
  // Wenn chatId null ist, könnte die Extension die Seite neu laden
  // Daher geben wir einen generischen Wert zurück, um Reloads zu vermeiden
  if (!finalChatId) {
    // Verwende einen generischen Wert, um Reloads zu vermeiden
    // Die Extension findet den chatId auf der Seite, aber sendet ihn nicht
    // Daher können wir nur einen generischen Wert zurückgeben
    finalChatId = "00000000";
    
    console.warn("⚠️ Kein chatId gefunden - verwende generischen Wert '00000000' um Reloads zu vermeiden.");
    console.warn("⚠️ Falls die Extension blockiert, muss sie angepasst werden, um chatId im Request zu senden.");
  }

  // Prüfe auf Minderjährige und strafrechtliche Themen
  if (isMinorMention(foundMessageText)) {
    console.error("🚨 BLOCKIERT: Minderjährige oder strafrechtliche Themen erkannt!");
    return res.status(200).json({
      error: "🚨 WICHTIG: Minderjährige oder strafrechtliche Themen erkannt! Bitte manuell prüfen!",
      resText: "🚨 WICHTIG: Minderjährige oder strafrechtliche Themen erkannt! Bitte manuell prüfen!",
      replyText: "🚨 WICHTIG: Minderjährige oder strafrechtliche Themen erkannt! Bitte manuell prüfen!",
      summary: {},
      chatId: finalChatId,
      actions: [], // Keine Aktionen bei Blockierung
      flags: { 
        blocked: true, 
        reason: "minor_or_illegal", 
        isError: true, 
        showError: true,
        requiresAttention: true // Extension soll Aufmerksamkeit erregen
      }
    });
  }

  const client = getClient();
  let replyText = null;
  let extractedInfo = { user: {}, assistant: {} };
  let errorMessage = null;

  // WICHTIG: Wenn messageText leer ist, geben wir eine Antwort zurück, die KEINE Reloads auslöst
  // Die Extension lädt die Seite neu, wenn flags.blocked: true ist ODER wenn chatId sich ändert
  // Daher geben wir eine normale Antwort zurück, aber mit actions: [], damit nichts passiert
  if (!foundMessageText || foundMessageText.trim() === "") {
    console.warn("⚠️ messageText ist leer - gebe leere Antwort zurück (keine Reloads)");
    // WICHTIG: Verwende den chatId aus dem Request, damit er sich nicht ändert
    const safeChatId = chatId || finalChatId || "00000000";
    return res.status(200).json({
      resText: "", // Leer, keine Fehlermeldung
      replyText: "",
      summary: {},
      chatId: safeChatId, // Verwende den ursprünglichen chatId, damit er sich nicht ändert
      actions: [], // Keine Aktionen, damit Extension nichts macht
      flags: { blocked: false }, // NICHT blocked, damit Extension nicht neu lädt
      disableAutoSend: true // Verhindere Auto-Send
    });
  }
  
  if (!client) {
    errorMessage = "❌ FEHLER: OpenAI Client nicht verfügbar. Bitte Admin kontaktieren.";
    console.error("❌ OpenAI Client nicht verfügbar - KEINE Fallback-Nachricht!");
    return res.status(200).json({
      error: errorMessage,
      resText: errorMessage, // Fehlermeldung in resText, damit Extension sie anzeigen kann
      replyText: errorMessage,
      summary: {},
      chatId: finalChatId,
      actions: [], // Keine Aktionen bei Fehler
      flags: { blocked: true, reason: "no_client", isError: true, showError: true }
    });
  }

  // Versuche Bilder zu analysieren, falls Bild-URLs in der Nachricht sind
  let imageDescriptions = [];
  try {
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:717',message:'Before image analysis',data:{foundMessageTextLength:foundMessageText?.length||0,hasClient:!!client},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
    // #endregion
    const imageUrls = extractImageUrls(foundMessageText);
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:720',message:'After extractImageUrls',data:{imageUrlsCount:imageUrls.length,firstUrl:imageUrls[0]?.substring(0,50)||null},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
    // #endregion
    if (imageUrls.length > 0) {
      // Beschränke auf 1 Bild (oder erweitern auf 2 bei Bedarf)
      const firstUrl = imageUrls[0];
      console.log("Bild-URL gefunden, versuche Analyse:", firstUrl);
      const dataUrl = await fetchImageAsBase64(firstUrl);
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:725',message:'After fetchImageAsBase64',data:{hasDataUrl:!!dataUrl,dataUrlLength:dataUrl?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
      // #endregion
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
        // #region agent log
        try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:744',message:'After vision API call',data:{hasChoices:!!vision.choices,choicesLength:vision.choices?.length||0,hasMessage:!!vision.choices?.[0]?.message,hasContent:!!vision.choices?.[0]?.message?.content},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
        // #endregion
        const desc = vision.choices?.[0]?.message?.content?.trim();
        if (desc) {
          imageDescriptions.push(desc);
          console.log("Bildbeschreibung:", desc.substring(0, 120));
        }
      }
    }
  } catch (err) {
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:751',message:'Image analysis error caught',data:{error:err.message,stack:err.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
    // #endregion
    console.warn("Bildanalyse fehlgeschlagen:", err.message);
  }

  // Versuche Nachricht zu generieren
  try {
    // Prüfe ASA-Fall: Wenn die letzte Nachricht vom FAKE kommt, schreibe eine Reaktivierungsnachricht
    // WICHTIG: Nur wenn explizit signalisiert, sonst könnte es andere Gründe geben
    if (isLastMessageFromFake) {
      console.log("🔄 ASA-Fall erkannt: Letzte Nachricht vom Fake, generiere Reaktivierungsnachricht...");
      
      // Zähle Kunden-Nachrichten, um Neukunde vs. Langzeitkunde zu unterscheiden
      const customerMessageCount = countCustomerMessages(req.body?.siteInfos?.messages || []);
      const isLongTermCustomer = customerMessageCount >= 10;
      console.log(`📊 Kunden-Nachrichten: ${customerMessageCount} (${isLongTermCustomer ? "Langzeitkunde" : "Neukunde"})`);
      
      // Analysiere Schreibstil der letzten Moderator-Nachrichten
      const writingStyle = analyzeWritingStyle(req.body?.siteInfos?.messages || []);
      const styleContext = writingStyle ? `\n\nSchreibstil der letzten Moderator-Nachrichten (WICHTIG: Übernehme diesen Stil!):
- Durchschnittliche Länge: ${writingStyle.avgLength} Zeichen
- Emojis verwendet: ${writingStyle.hasEmojis ? "Ja" : "Nein"}
- Ausrufezeichen: ${writingStyle.hasExclamation ? "Ja" : "Nein"}
- Fragen: ${writingStyle.hasQuestion ? "Ja" : "Nein"}
- Umgangssprachlich: ${writingStyle.hasCasual ? "Ja" : "Nein"}
- Beispiel-Nachrichten: ${writingStyle.sampleTexts.substring(0, 200)}` : "";
      
      // Verschiedene ASA-Nachrichten je nach Kunden-Typ
      const asaTemplatesNew = [
        "Hey, ich hatte mich eigentlich schon gefreut dich besser kennenzulernen, hast du etwa kein Interesse mehr an mir oder hast du eine andere Frau kennengelernt?",
        "Hallo, ich dachte wir hätten eine gute Verbindung aufgebaut. Warum schreibst du mir nicht mehr zurück?",
        "Hey, ich hatte gehofft wir können uns besser kennenlernen. Ist etwas passiert oder hast du das Interesse verloren?",
        "Hallo, ich hatte mich schon auf unsere Unterhaltung gefreut. Schreibst du mir nicht mehr, weil du keine Zeit hast?",
        "Hey, ich dachte wir verstehen uns gut. Warum antwortest du mir nicht mehr? Hast du vielleicht jemand anderen kennengelernt?"
      ];
      
      const asaTemplatesLongTerm = [
        "Wieso schreibst du mir nicht mehr? Ich bin gerade wirklich traurig, habe ich irgendwas falsch gemacht oder was ist gerade das Problem?",
        "Hey, ich verstehe es nicht. Wir haben doch so lange geschrieben und jetzt hörst du einfach auf. Was ist los?",
        "Hallo, ich bin wirklich enttäuscht. Nach all den Wochen, in denen wir uns geschrieben haben, antwortest du mir nicht mehr. Was ist passiert?",
        "Hey, ich dachte wir hätten eine gute Verbindung. Warum lässt du mich jetzt einfach hängen? Habe ich etwas falsch gemacht?",
        "Hallo, ich bin gerade wirklich traurig. Wir haben so viel geschrieben und jetzt ist einfach Funkstille. Was ist das Problem?"
      ];
      
      // Wähle Template basierend auf Kunden-Typ
      const templates = isLongTermCustomer ? asaTemplatesLongTerm : asaTemplatesNew;
      
      // Wähle zufällig eine ASA-Nachricht
      let asaMessage = templates[Math.floor(Math.random() * templates.length)].trim();
      
      // Entferne Anführungszeichen am Anfang/Ende falls vorhanden
      if (asaMessage.startsWith('"') && asaMessage.endsWith('"')) {
        asaMessage = asaMessage.slice(1, -1).trim();
      }
      if (asaMessage.startsWith("'") && asaMessage.endsWith("'")) {
        asaMessage = asaMessage.slice(1, -1).trim();
      }
      
      // Entferne alle Anführungszeichen und Bindestriche
      asaMessage = asaMessage.replace(/"/g, "").replace(/'/g, "").replace(/-/g, " ");
      // Ersetze ß durch ss (DACH)
      asaMessage = asaMessage.replace(/ß/g, "ss");
      
      // Stelle sicher, dass ASA-Nachricht mindestens 150 Zeichen hat
      // WICHTIG: Kein hartes slice, sondern mit KI verlängern, damit keine abgeschnittenen Sätze entstehen
      const asaMinLen = 150;
      if (asaMessage.length < asaMinLen) {
        console.log(`⚠️ ASA-Nachricht zu kurz (${asaMessage.length} Zeichen), verlängere mit KI...`);
        try {
          const asaExtensionPrompt = `Die folgende Reaktivierungsnachricht ist zu kurz. Erweitere sie auf mindestens 150 Zeichen, behalte den Reaktivierungs-Fokus bei und stelle am Ende eine passende Frage. Die Nachricht soll natürlich und menschlich klingen, nicht abgehackt.${styleContext}

WICHTIG: 
- Verwende KEINE Bindestriche (-), KEINE Anführungszeichen (" oder ') und KEIN "ß" (immer "ss" verwenden)
- Übernehme den Schreibstil der letzten Moderator-Nachrichten (siehe oben)
- ${isLongTermCustomer ? "Sei persönlicher und emotionaler, da es ein Langzeitkunde ist." : "Sei freundlich und hoffnungsvoll, da es ein Neukunde ist."}

"${asaMessage}"

Antworte NUR mit der vollständigen, erweiterten Nachricht (mindestens 150 Zeichen), keine Erklärungen.`;
          
          const asaExtended = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { 
                role: "system", 
                content: `Du erweiterst Reaktivierungsnachrichten auf mindestens 150 Zeichen. Fokus auf Reaktivierung, natürlicher Ton, keine Bindestriche/Anführungszeichen/ß. ${isLongTermCustomer ? "Für Langzeitkunden: persönlicher, emotionaler Ton." : "Für Neukunden: freundlich, hoffnungsvoll."} Übernehme den Schreibstil der letzten Moderator-Nachrichten.` 
              },
              { role: "user", content: asaExtensionPrompt }
            ],
            max_tokens: 200,
            temperature: 0.8
          });
          
          const extendedText = asaExtended.choices?.[0]?.message?.content?.trim();
          if (extendedText && extendedText.length >= asaMinLen) {
            // Reinige die erweiterte Nachricht
            let cleaned = extendedText.trim();
            if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
              cleaned = cleaned.slice(1, -1).trim();
            }
            if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
              cleaned = cleaned.slice(1, -1).trim();
            }
            cleaned = cleaned.replace(/"/g, "").replace(/'/g, "").replace(/-/g, " ").replace(/ß/g, "ss");
            
            // Stelle sicher, dass sie mit Punkt oder Frage endet (nicht mitten im Satz)
            if (!cleaned.match(/[.!?]$/)) {
              // Wenn keine Interpunktion am Ende, füge eine Frage hinzu
              if (!cleaned.endsWith("?")) {
                cleaned += " Was denkst du?";
              }
            }
            
            asaMessage = cleaned;
            console.log("✅ ASA-Nachricht auf 150+ Zeichen erweitert:", asaMessage.length, "Zeichen");
          } else {
            // Fallback: Füge einen natürlichen Zusatz hinzu
            const fallbackFiller = " Hallo? Bist du noch da? Mega schade, dass du mir nicht zurückschreibst. Ich würde mich echt freuen, wenn du mir wieder antwortest. Wo steckst du denn gerade und was hält dich ab?";
            asaMessage = (asaMessage + fallbackFiller).trim();
            // Stelle sicher, dass sie mit Interpunktion endet
            if (!asaMessage.match(/[.!?]$/)) {
              asaMessage += "?";
            }
            console.log("⚠️ ASA-Nachricht mit Fallback-Filler verlängert:", asaMessage.length, "Zeichen");
          }
        } catch (err) {
          console.error("Fehler beim Verlängern der ASA-Nachricht:", err);
          // Fallback: Füge einen natürlichen Zusatz hinzu
          const fallbackFiller = " Hallo? Bist du noch da? Mega schade, dass du mir nicht zurückschreibst. Ich würde mich echt freuen, wenn du mir wieder antwortest. Wo steckst du denn gerade und was hält dich ab?";
          asaMessage = (asaMessage + fallbackFiller).trim();
          if (!asaMessage.match(/[.!?]$/)) {
            asaMessage += "?";
          }
        }
      }
      
      // Finale Prüfung: Mindestlänge und sauberes Ende
      if (asaMessage.length < asaMinLen) {
        console.warn(`⚠️ ASA-Nachricht immer noch zu kurz (${asaMessage.length} Zeichen), füge zusätzlichen Text hinzu...`);
        const additionalFiller = " Ich würde wirklich gerne wieder von dir hören und unsere Unterhaltung fortsetzen. Was hält dich denn gerade ab, mir zu schreiben?";
        asaMessage = (asaMessage + additionalFiller).trim();
      }
      
      // Stelle sicher, dass sie mit Interpunktion endet
      if (!asaMessage.match(/[.!?]$/)) {
        asaMessage += "?";
      }
      
      console.log("✅ ASA-Nachricht generiert:", asaMessage.substring(0, 100) + "...", `(${asaMessage.length} Zeichen)`);
      
      // WICHTIG: Verwende IMMER den chatId aus dem Request (falls vorhanden), damit er sich NICHT ändert
      // PRIORITÄT: chatId aus Request > siteInfos.chatId > finalChatId > Default
      const asaChatId = chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000";
      
      // WICHTIG: Variable Wartezeit zwischen 40-60 Sekunden auch für ASA-Nachrichten
      const minWait = 40;
      const maxWait = 60;
      const asaWaitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
      
      // Validiere assetsToSend für ASA-Antwort
      const asaValidAssets = validateAssets(assetsToSend);
      
      return res.json({
        resText: asaMessage,
        replyText: asaMessage,
        summary: {},
        chatId: asaChatId, // chatId aus Request, damit er sich nicht ändert
        actions: [
          {
            type: "insert_and_send",
            delay: asaWaitTime // Wartezeit in Sekunden (40-60 Sekunden variabel)
          }
        ],
        assets: asaValidAssets,
        flags: { 
          blocked: false, // WICHTIG: Immer false, damit Extension nicht neu lädt
          noReload: true, // Explizites Flag: Nicht neu laden
          skipReload: true // Zusätzliches Flag für Rückwärtskompatibilität
        },
        disableAutoSend: true, // WICHTIG: Verhindere automatisches Senden durch Extension - unsere Funktion übernimmt die Kontrolle
        waitTime: asaWaitTime, // Zusätzliches Flag für Rückwärtskompatibilität
        noReload: true // Explizites Flag auf oberster Ebene
      });
    }
    
    // 1. Informationen extrahieren (nur wenn Nachricht vom Kunden vorhanden)
    extractedInfo = await extractInfoFromMessage(client, foundMessageText);

    // Fallback: Wenn nichts extrahiert wurde, nutze metaData (falls vorhanden)
    if ((!extractedInfo.user || Object.keys(extractedInfo.user).length === 0) && req.body?.siteInfos?.metaData) {
      const metaSummary = buildSummaryFromMeta(req.body.siteInfos.metaData);
      // Nur übernehmen, wenn wirklich etwas drin ist
      if (Object.keys(metaSummary.user).length > 0 || Object.keys(metaSummary.assistant).length > 0) {
        extractedInfo = metaSummary;
        console.log("✅ Summary aus metaData übernommen (Fallback)");
      }
    }
    
    // 2. Antwort generieren
    // WICHTIG: Wir antworten als FAKE/MODERATOR auf den KUNDEN
    // Die Nachricht kommt vom KUNDEN, wir antworten als FAKE
    
    // Prüfe auf Bot/KI-Vorwürfe
    const lowerMessage = foundMessageText.toLowerCase();
    const isBotAccusation = lowerMessage.includes("bot") || lowerMessage.includes("ki") || 
                           lowerMessage.includes("künstliche intelligenz") || 
                           lowerMessage.includes("chatgpt") || lowerMessage.includes("fake") ||
                           lowerMessage.includes("automatisch") || lowerMessage.includes("programmiert");
    
    // Prüfe auf sexuelle Themen
    const isSexualTopic = lowerMessage.includes("titten") || lowerMessage.includes("brüste") ||
                         lowerMessage.includes("arsch") || lowerMessage.includes("po") ||
                         lowerMessage.includes("pussy") || lowerMessage.includes("schwanz") ||
                         lowerMessage.includes("sex") || lowerMessage.includes("ficken") ||
                         lowerMessage.includes("vorlieben") || lowerMessage.includes("sexuell") ||
                         lowerMessage.includes("geil") || lowerMessage.includes("lust");
    
    // Prüfe auf Berufsfragen
    const isJobQuestion = lowerMessage.includes("was arbeitest") || lowerMessage.includes("beruf") ||
                         lowerMessage.includes("was machst du beruflich") || lowerMessage.includes("job") ||
                         lowerMessage.includes("wo arbeitest");
    
    // Prüfe auf Treffen/Termine
    const isMeetingRequest = lowerMessage.includes("treffen") || lowerMessage.includes("wann") ||
                            lowerMessage.includes("zeit") || lowerMessage.includes("kennenlernen") ||
                            lowerMessage.includes("sehen") || lowerMessage.includes("date");
    
    // Extrahiere Geschlecht aus userProfile (falls vorhanden) - für Geschlechtererkennung
    let fakeGender = null;
    let customerGender = null;
    if (userProfile && typeof userProfile === 'object') {
      // Versuche Geschlecht zu erkennen
      if (userProfile.gender) fakeGender = userProfile.gender.toLowerCase();
      if (userProfile.sex) fakeGender = userProfile.sex.toLowerCase();
    }
    
    // Versuche Geschlecht aus Nachricht zu extrahieren (falls erwähnt)
    if (lowerMessage.includes("frau") || lowerMessage.includes("weiblich") || lowerMessage.includes("sie ")) {
      customerGender = "männlich"; // Wenn Kunde "Frau" sagt, ist er wahrscheinlich männlich
    }
    if (lowerMessage.includes("mann") || lowerMessage.includes("männlich") || lowerMessage.includes("er ")) {
      customerGender = "weiblich"; // Wenn Kunde "Mann" sagt, ist er wahrscheinlich weiblich
    }
    
    // Zeit/Datum für DACH (Europe/Berlin)
    const now = new Date();
    const nowString = now.toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour12: false });
    const month = now.getMonth() + 1;
    const season = month === 12 || month <= 2 ? "Winter" : month <= 5 ? "Frühling" : month <= 8 ? "Sommer" : "Herbst";

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
- WICHTIG: Reagiere NUR auf die Nachricht, die dir gegeben wird - erfinde nichts!
- WICHTIG: Schreibe NIEMALS das Zeichen "ß" – immer "ss" verwenden.
- WICHTIG: Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${nowString} (${season}). Keine falschen Jahreszeiten/Wetter-Annahmen.
- WICHTIG: Wenn der Kunde Zeiten/Wecker/Schlaf erwähnt, reagiere empathisch auf wenig Schlaf usw., aber verabschiede dich nicht.
- WICHTIG: Auch bei "Gute Nacht" oder ähnlichem den Dialog offenhalten und eine passende Frage stellen.
- WICHTIG: Bei Geld/Coins/Bezahlen/aufladen/kostenlos: nicht darüber reden, nicht zum Aufladen auffordern, elegant ausweichen und sofort mit einer passenden Frage zum Thema fortfahren.
- WICHTIG: Übernehme den Schreibstil der letzten Moderator-Nachrichten (siehe userPrompt)! Passe Länge, Emojis, Ton und Formulierungen an, damit der Kunde nicht merkt, dass verschiedene Moderatoren schreiben!`;
    
    // WICHTIG: userProfile könnte die Daten vom FAKE enthalten, nicht vom KUNDEN
    // Verwende daher NUR die extrahierten Infos vom KUNDEN (aus der Nachricht)
    // NICHT userProfile, da das die Daten vom Fake sein könnten!
    
    // Baue Kontext für bessere Antworten - NUR aus extrahierten Kunden-Infos
    const customerContext = [];
    if (extractedInfo.user && Object.keys(extractedInfo.user).length > 0) {
      Object.entries(extractedInfo.user).forEach(([key, value]) => {
        if (value) customerContext.push(`${key}: ${value}`);
      });
    }
    
    // Extrahiere den Namen des KUNDEN aus der Nachricht (nicht vom userProfile!)
    const customerName = extractedInfo.user?.Name || null;
    const customerJob = extractedInfo.user?.Work || null;
    
    // Analysiere Schreibstil der letzten Moderator-Nachrichten
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1037',message:'Before analyzeWritingStyle',data:{hasSiteInfos:!!req.body?.siteInfos,hasMessages:!!req.body?.siteInfos?.messages,isArray:Array.isArray(req.body?.siteInfos?.messages),messagesLength:req.body?.siteInfos?.messages?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
    // #endregion
    let writingStyle = null;
    try {
      writingStyle = analyzeWritingStyle(req.body?.siteInfos?.messages || []);
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1039',message:'After analyzeWritingStyle',data:{hasWritingStyle:!!writingStyle,hasSampleTexts:!!writingStyle?.sampleTexts,sampleTextsType:typeof writingStyle?.sampleTexts},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
    } catch (err) {
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1041',message:'analyzeWritingStyle error',data:{error:err.message,stack:err.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
      console.error("❌ Fehler in analyzeWritingStyle:", err.message);
    }
    const styleContext = writingStyle ? `\n\nSchreibstil der letzten Moderator-Nachrichten (WICHTIG: Übernehme diesen Stil!):
- Durchschnittliche Länge: ${writingStyle.avgLength} Zeichen
- Emojis verwendet: ${writingStyle.hasEmojis ? "Ja" : "Nein"}
- Ausrufezeichen: ${writingStyle.hasExclamation ? "Ja" : "Nein"}
- Fragen: ${writingStyle.hasQuestion ? "Ja" : "Nein"}
- Umgangssprachlich: ${writingStyle.hasCasual ? "Ja" : "Nein"}
- Beispiel-Nachrichten: ${writingStyle.sampleTexts ? writingStyle.sampleTexts.substring(0, 300) : ""}` : "";
    
    // Komprimiere letzten 30 Nachrichten für Kontext
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1047',message:'Before compressConversation',data:{hasMessages:!!req.body?.siteInfos?.messages,isArray:Array.isArray(req.body?.siteInfos?.messages)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
    // #endregion
    let conversationContext = "";
    try {
      conversationContext = compressConversation(req.body?.siteInfos?.messages || [], 30);
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1050',message:'After compressConversation',data:{conversationContextLength:conversationContext?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
    } catch (err) {
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1052',message:'compressConversation error',data:{error:err.message,stack:err.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
      console.error("❌ Fehler in compressConversation:", err.message);
    }
    const conversationBlock = conversationContext ? `\n\nLetzte Nachrichten im Chat (Kunde/Fake):\n${conversationContext}` : "";
    
    // Zähle Kunden-Nachrichten für Kontext
    let customerMessageCount = 0;
    try {
      customerMessageCount = countCustomerMessages(req.body?.siteInfos?.messages || []);
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1055',message:'After countCustomerMessages',data:{customerMessageCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
    } catch (err) {
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1057',message:'countCustomerMessages error',data:{error:err.message,stack:err.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
      console.error("❌ Fehler in countCustomerMessages:", err.message);
    }
    const customerTypeContext = customerMessageCount >= 10 ? "\n\nWICHTIG: Dies ist ein Langzeitkunde (bereits viele Nachrichten ausgetauscht). Sei persönlicher und emotionaler in deiner Antwort." : customerMessageCount > 0 ? "\n\nWICHTIG: Dies ist ein Neukunde (erst wenige Nachrichten). Sei freundlich und hoffnungsvoll." : "";
    
    // Bild-Kontext
    const imageContext = imageDescriptions.length > 0 ? `\n\nErkannte Bilder:\n- ${imageDescriptions.join("\n- ")}\n` : "";
    
    // Baue spezifischen Prompt basierend auf Situation
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
      // Realistische Berufe für Frauen/Männer (keine Flugzeugbegleiter, Zugkontrolleur)
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

    // Geld/Coins abfedern
    const moneyKeywords = ["coin", "coins", "geld", "aufladen", "kredit", "bezahlen", "kostenlos", "kostenfrei", "gratis"];
    const touchesMoney = moneyKeywords.some(k => lowerMessage.includes(k));
    if (touchesMoney) {
      specificInstructions += `\n\n💸 GELD/COINS:
- Nicht über Geld/Coins/aufladen/kostenlos sprechen.
- Keine Hinweise zum Aufladen geben, keine externen Vorschläge.
- Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben.`;
    }
    
    // WICHTIG: Validiere die Nachricht nochmal vor dem Prompt
    // Wenn die Nachricht zu lang oder komisch ist, könnte es eine falsche Nachricht sein
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
${imageContext}${conversationBlock}${styleContext}${customerTypeContext}
Aktuelles Datum/Zeit (DACH): ${nowString} (${season})
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
- Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!
- WICHTIG: Übernehme den Schreibstil der letzten Moderator-Nachrichten (siehe oben)! Passe Länge, Emojis, Ton und Formulierungen an, damit der Kunde nicht merkt, dass verschiedene Moderatoren schreiben!`;

    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1155',message:'Before OpenAI chat.create',data:{hasClient:!!client,hasSystemPrompt:!!systemPrompt,hasUserPrompt:!!userPrompt},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n');}catch(e){}
    // #endregion
    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 200, // Mehr Tokens für natürlichere, längere Antworten
      temperature: 0.8 // Etwas kreativer für natürlichere Antworten
    });
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1165',message:'After OpenAI chat.create',data:{hasChat:!!chat,hasChoices:!!chat.choices,choicesLength:chat.choices?.length||0,hasFirstChoice:!!chat.choices?.[0],hasMessage:!!chat.choices?.[0]?.message,hasContent:!!chat.choices?.[0]?.message?.content},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n');}catch(e){}
    // #endregion
    replyText = chat.choices?.[0]?.message?.content?.trim();
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1166',message:'After extracting replyText',data:{hasReplyText:!!replyText,replyTextLength:replyText?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n');}catch(e){}
    // #endregion
    
    // WICHTIG: Prüfe, ob eine gültige Antwort generiert wurde
    if (!replyText || replyText.trim() === "") {
      errorMessage = "❌ FEHLER: Konnte keine Antwort generieren. Bitte versuche es erneut.";
      console.error("❌ Antwort ist leer - KEINE Fallback-Nachricht!");
      return res.status(200).json({
        error: errorMessage,
        resText: errorMessage, // Fehlermeldung in resText, damit Extension sie anzeigen kann
        replyText: errorMessage,
        summary: extractedInfo,
        chatId: finalChatId,
        actions: [], // Keine Aktionen bei Fehler
        flags: { blocked: true, reason: "empty_response", isError: true, showError: true }
      });
    }
    
    // WICHTIG: Entferne Anführungszeichen am Anfang/Ende (falls vorhanden)
    replyText = replyText.trim();
    if (replyText.startsWith('"') && replyText.endsWith('"')) {
      replyText = replyText.slice(1, -1).trim();
    }
    if (replyText.startsWith("'") && replyText.endsWith("'")) {
      replyText = replyText.slice(1, -1).trim();
    }
    // Entferne auch Anführungszeichen am Anfang, wenn sie alleine stehen
    if (replyText.startsWith('"') && !replyText.endsWith('"')) {
      replyText = replyText.replace(/^"/, '').trim();
    }
    if (replyText.startsWith("'") && !replyText.endsWith("'")) {
      replyText = replyText.replace(/^'/, '').trim();
    }
    
    // Entferne Bindestriche (falls vorhanden)
    replyText = replyText.replace(/-/g, " ");
    // Ersetze ß durch ss (DACH)
    replyText = replyText.replace(/ß/g, "ss");
    
    // Prüfe Mindestlänge (80 Zeichen)
    if (replyText.length < 80) {
      console.warn(`⚠️ Antwort zu kurz (${replyText.length} Zeichen), versuche zu verlängern...`);
      // Versuche Antwort zu verlängern, falls zu kurz
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
          replyText = extendedText.replace(/-/g, " ").replace(/ß/g, "ss");
          console.log("✅ Antwort auf 80+ Zeichen erweitert");
        }
      } catch (err) {
        console.error("Fehler beim Erweitern der Antwort:", err);
      }
    }
    
    // Prüfe, ob eine Frage am Ende steht
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
          replyText = questionText.replace(/-/g, " ").replace(/ß/g, "ss");
          console.log("✅ Frage am Ende hinzugefügt");
        }
      } catch (err) {
        console.error("Fehler beim Hinzufügen der Frage:", err);
        // Fallback: Füge eine generische Frage hinzu
        if (!replyText.endsWith("?")) {
          replyText += " Was denkst du dazu?";
        }
      }
    }
    
    console.log("✅ Antwort generiert:", replyText.substring(0, 100));
  } catch (err) {
    errorMessage = `❌ FEHLER: Beim Generieren der Nachricht ist ein Fehler aufgetreten: ${err.message}`;
    console.error("❌ OpenAI Fehler", err.message);
    return res.status(200).json({
      error: errorMessage,
      resText: errorMessage, // Fehlermeldung in resText, damit Extension sie anzeigen kann
      replyText: errorMessage,
      summary: extractedInfo,
      chatId: finalChatId,
      actions: [], // Keine Aktionen bei Fehler
      flags: { blocked: true, reason: "generation_error", isError: true, showError: true }
    });
  }

  // Wenn wir hier ankommen, wurde replyText erfolgreich generiert
  console.log("=== ChatCompletion Response ===");
  console.log("resText:", replyText.substring(0, 100));
  console.log("summary keys:", Object.keys(extractedInfo.user || {}).length, "user,", Object.keys(extractedInfo.assistant || {}).length, "assistant");

  // Format für Extension: Kompatibilität mit alter Extension
  // Die Extension erwartet: resText, summary (als Objekt), chatId
  // NUR wenn replyText erfolgreich generiert wurde!
  // WICHTIG: Verwende IMMER den chatId aus dem Request (falls vorhanden), damit er sich NICHT ändert
  // PRIORITÄT: chatId aus Request > siteInfos.chatId > finalChatId > Default
  const responseChatId = chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000";
  
  console.log("=== Response ChatId ===");
  console.log("chatId aus Request:", chatId || "(nicht gesendet)");
  console.log("siteInfos.chatId:", req.body?.siteInfos?.chatId || "(nicht gesendet)");
  console.log("finalChatId (extrahiert):", finalChatId);
  console.log("responseChatId (verwendet):", responseChatId);
  console.log("⚠️ WICHTIG: responseChatId sollte IMMER gleich dem chatId aus Request sein (falls vorhanden), um Reloads zu vermeiden!");
  
  // WICHTIG: Variable Wartezeit zwischen 40-60 Sekunden für alle Plattformen (FPC, iluvo, viluu)
  // Das verhindert, dass die Seite neu lädt, bevor die Nachricht abgeschickt wird
  const minWait = 40;
  const maxWait = 60;
  const waitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
  
  // #region agent log
  try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1314',message:'Before res.json',data:{hasReplyText:!!replyText,hasExtractedInfo:!!extractedInfo,hasAssetsToSend:!!assetsToSend,assetsToSendLength:assetsToSend?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})+'\n');}catch(e){}
  // #endregion
  
  // WICHTIG: Validiere und filtere assetsToSend, um undefined-Elemente und ungültige Objekte zu entfernen
  const validAssets = validateAssets(assetsToSend);
  
  try {
    return res.json({
      resText: replyText, // Extension erwartet resText statt replyText
      replyText, // Auch für Rückwärtskompatibilität
      summary: extractedInfo, // Extension erwartet summary als Objekt
      summaryText: JSON.stringify(extractedInfo), // Für Rückwärtskompatibilität
      chatId: responseChatId, // WICHTIG: chatId aus Request (damit er sich nicht ändert), sonst finalChatId oder Default
      actions: [
        {
          type: "insert_and_send",
          delay: waitTime // Wartezeit in Sekunden (40-60 Sekunden variabel)
        }
      ],
      assets: validAssets, // Verwende validierte Assets
      flags: { 
        blocked: false, // WICHTIG: Immer false, damit Extension nicht neu lädt
        noReload: true, // Explizites Flag: Nicht neu laden
        skipReload: true // Zusätzliches Flag für Rückwärtskompatibilität
      },
      disableAutoSend: true, // WICHTIG: Verhindere automatisches Senden durch Extension - unsere Funktion übernimmt die Kontrolle
      waitTime: waitTime, // Zusätzliches Flag für Rückwärtskompatibilität
      noReload: true // Explizites Flag auf oberster Ebene
    });
  } catch (err) {
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1335',message:'res.json serialization error',data:{error:err.message,stack:err.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})+'\n');}catch(e){}
    // #endregion
    console.error("❌ FEHLER: res.json() Serialisierung fehlgeschlagen:", err.message);
    throw err; // Weiterleiten an Express Error-Handler
  }
}));

// Express Error-Handler für alle unerwarteten Fehler
router.use((err, req, res, next) => {
  // #region agent log
  try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1339',message:'Express error handler triggered',data:{error:err.message,stack:err.stack?.substring(0,500),name:err.name,hasBody:!!req.body},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})+'\n');}catch(e){}
  // #endregion
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

