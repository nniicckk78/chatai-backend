const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");

const router = express.Router();

// simple JWT middleware
router.use((req, res, next) => {
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

router.post("/", async (req, res) => {
  // Logge den kompletten Request-Body, um zu sehen, was die Extension sendet
  console.log("=== ChatCompletion Request (COMPLETE BODY) ===");
  console.log("Full request body:", JSON.stringify(req.body, null, 2));
  
  // WICHTIG: Extrahiere ALLE möglichen Felder, die die Extension senden könnte
  // Die Extension könnte den chatId oder die Nachricht in verschiedenen Formaten senden
  const { messageText = "", pageUrl, platformId, assetsToSend, userProfile, chatId } = req.body || {};
  
  // Prüfe, ob die Extension vielleicht die letzte Nachricht aus dem Chat im Request-Body hat
  // Suche nach allen String-Feldern, die wie Nachrichten aussehen
  let possibleMessageFromBody = null;
  if (!messageText || messageText.trim() === "") {
    // Suche nach langen Strings im Request-Body, die wie Nachrichten aussehen
    function findMessageInObject(obj, depth = 0) {
      if (depth > 3) return null;
      if (!obj || typeof obj !== 'object') return null;
      
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        // Wenn es ein String ist und länger als 10 Zeichen, könnte es eine Nachricht sein
        if (typeof value === 'string' && value.trim().length > 10 && 
            !value.includes('http') && !value.includes('@') && 
            !key.toLowerCase().includes('url') && !key.toLowerCase().includes('id')) {
          return value;
        }
        // Rekursiv suchen
        if (typeof value === 'object' && value !== null) {
          const found = findMessageInObject(value, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    
    possibleMessageFromBody = findMessageInObject(req.body);
    if (possibleMessageFromBody) {
      console.log("✅ Mögliche Nachricht im Request-Body gefunden:", possibleMessageFromBody.substring(0, 50) + "...");
    }
  }

  // WICHTIG: Prüfe auch andere mögliche Feldnamen für messageText
  // Die Extension könnte die Nachricht unter einem anderen Namen senden
  const possibleMessageFields = ['messageText', 'message', 'text', 'content', 'message_content', 'lastMessage', 'last_message', 'userMessage', 'user_message'];
  let foundMessageText = messageText || possibleMessageFromBody;
  for (const field of possibleMessageFields) {
    if (req.body[field] && !foundMessageText) {
      foundMessageText = req.body[field];
      console.log(`✅ messageText gefunden unter Feldname '${field}':`, foundMessageText.substring(0, 50) + "...");
    }
  }
  
  // Prüfe auch in userProfile oder anderen verschachtelten Objekten
  if (!foundMessageText && userProfile && typeof userProfile === 'object') {
    if (userProfile.messageText) foundMessageText = userProfile.messageText;
    if (userProfile.message) foundMessageText = userProfile.message;
    if (userProfile.lastMessage) foundMessageText = userProfile.lastMessage;
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
  // Die Extension lädt die Seite neu, wenn flags.blocked: true ist
  // Daher geben wir eine normale Antwort zurück, aber mit actions: [], damit nichts passiert
  if (!foundMessageText || foundMessageText.trim() === "") {
    console.warn("⚠️ messageText ist leer - gebe leere Antwort zurück (keine Reloads)");
    return res.status(200).json({
      resText: "", // Leer, keine Fehlermeldung
      replyText: "",
      summary: {},
      chatId: finalChatId,
      actions: [], // Keine Aktionen, damit Extension nichts macht
      flags: { blocked: false } // NICHT blocked, damit Extension nicht neu lädt
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

  // Versuche Nachricht zu generieren
  try {
    // 1. Informationen extrahieren
    extractedInfo = await extractInfoFromMessage(client, foundMessageText);
    
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
    
    const systemPrompt = `Du bist ein freundlicher, natürlicher Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- Antworte natürlich, flirty und interessiert, aber nicht übertrieben
- Sei konkret und persönlich, nicht generisch
- Reagiere auf das, was der KUNDE sagt (nicht auf dich selbst!)
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte
- Schreibe natürlich und menschlich - wie eine echte Person schreiben würde
- Verwende keine generischen Phrasen wie "Wie kann ich dir helfen?" oder "Hallo!"
- WICHTIG: Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- WICHTIG: Nachricht muss MINDESTENS 80 Zeichen lang sein!
- WICHTIG: Am Ende IMMER eine passende Frage zum Kontext stellen!
- WICHTIG: Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!`;
    
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
    
    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

Aktuelle Nachricht vom KUNDEN: "${foundMessageText}"

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n` : ''}
${customerJob ? `Beruf des Kunden (falls relevant): ${customerJob}\n` : ''}
Plattform: ${platformId || "viluu"}
${specificInstructions}

WICHTIG: 
- Die Nachricht kommt vom KUNDEN, nicht von dir!
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
      max_tokens: 200, // Mehr Tokens für natürlichere, längere Antworten
      temperature: 0.8 // Etwas kreativer für natürlichere Antworten
    });
    
    replyText = chat.choices?.[0]?.message?.content?.trim();
    
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
    
    // Entferne Bindestriche (falls vorhanden)
    replyText = replyText.replace(/-/g, " ");
    
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
          replyText = extendedText.replace(/-/g, " ");
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
          replyText = questionText.replace(/-/g, " ");
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
  return res.json({
    resText: replyText, // Extension erwartet resText statt replyText
    replyText, // Auch für Rückwärtskompatibilität
    summary: extractedInfo, // Extension erwartet summary als Objekt
    summaryText: JSON.stringify(extractedInfo), // Für Rückwärtskompatibilität
    chatId: finalChatId, // chatId aus Request, URL oder Default
    actions: [
      {
        type: "insert_and_send"
      }
    ],
    assets: assetsToSend || [],
    flags: { blocked: false },
    disableAutoSend: false
  });
});

module.exports = router;
