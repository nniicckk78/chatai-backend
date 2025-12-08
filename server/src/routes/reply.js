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
  if (lower.includes("minderjähr")) return true;
  // naive Alterspruefung auf 10-17
  const ageMatch = lower.match(/\b(1[0-7])\b/);
  return Boolean(ageMatch);
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
  const { messageText = "", pageUrl, platformId, assetsToSend, userProfile } = req.body || {};

  // Logging für Debugging
  console.log("=== ChatCompletion Request ===");
  console.log("messageText:", messageText ? messageText.substring(0, 100) + "..." : "(leer)");
  console.log("pageUrl:", pageUrl);
  console.log("platformId:", platformId);
  console.log("userProfile:", userProfile ? "vorhanden" : "fehlt");
  console.log("assetsToSend:", assetsToSend ? assetsToSend.length : 0);

  if (isMinorMention(messageText)) {
    return res.json({
      flags: { blocked: true, reason: "minor" },
      actions: []
    });
  }

  const client = getClient();
  let replyText = "Hi, ich antworte gleich freundlich und knapp.";
  let extractedInfo = { user: {}, assistant: {} };

  if (!messageText || messageText.trim() === "") {
    console.warn("⚠️ messageText ist leer - verwende Fallback-Text");
    replyText = "Hallo! Wie kann ich dir helfen?";
  } else if (client) {
    try {
      // 1. Informationen extrahieren
      extractedInfo = await extractInfoFromMessage(client, messageText);
      
      // 2. Antwort generieren
      const systemPrompt =
        "Du bist ein höflicher, knapper Chat-Moderator. Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte. Schreibe kurz.";
      const userPrompt = `Nachricht: ${messageText}\nPlattform: ${platformId || "unbekannt"}\nURL: ${pageUrl || "unbekannt"}`;

      const chat = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 150,
        temperature: 0.7
      });
      replyText = chat.choices?.[0]?.message?.content?.trim() || replyText;
      console.log("✅ Antwort generiert:", replyText.substring(0, 100));
    } catch (err) {
      console.error("❌ OpenAI Fehler", err.message);
      // fallback bleibt replyText
    }
  } else {
    console.warn("⚠️ OpenAI Client nicht verfügbar - verwende Fallback-Text");
  }

  console.log("=== ChatCompletion Response ===");
  console.log("resText:", replyText.substring(0, 100));
  console.log("summary keys:", Object.keys(extractedInfo.user || {}).length, "user,", Object.keys(extractedInfo.assistant || {}).length, "assistant");

  // Format für Extension: Kompatibilität mit alter Extension
  // Die Extension erwartet: resText, summary (als Objekt), chatId
  return res.json({
    resText: replyText, // Extension erwartet resText statt replyText
    replyText, // Auch für Rückwärtskompatibilität
    summary: extractedInfo, // Extension erwartet summary als Objekt
    summaryText: JSON.stringify(extractedInfo), // Für Rückwärtskompatibilität
    chatId: null, // Wird von Extension gesetzt, falls benötigt
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
