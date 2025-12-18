const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");
const fs = require("fs");
const path = require("path");
const { writeToGoogleSheets } = require("../utils/google-sheets");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
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

// Helper: Lade Training Data aus Datei oder GitHub
async function getTrainingData() {
  // Versuche zuerst von GitHub zu laden
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/training-data.json',
        'src/config/training-data.json',
        'config/training-data.json',
        'server/config/training-data.json'
      ];
      
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          if (response.data && response.data.content) {
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            return JSON.parse(content);
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      // Fallback zu lokaler Datei
    }
  }

  // Fallback: Lade von lokaler Datei
  const trainingPath = path.join(__dirname, '../../config/training-data.json');
  try {
    if (fs.existsSync(trainingPath)) {
      const data = fs.readFileSync(trainingPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Training Data:', err);
  }
  return { conversations: [] };
}

// Helper: Lade Regeln aus GitHub (für situations-spezifische Antworten)
// WICHTIG: GitHub ist die Hauptquelle, weil Render/Extension keinen Zugriff auf lokale Dateien hat!
async function getRules() {
  // PRIORITÄT 1: Lade von GitHub (Hauptquelle für Render/Extension)
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/rules.json',
        'src/config/rules.json',
        'config/rules.json',
        'server/config/rules.json'
      ];
      
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          if (response.data && response.data.content) {
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            const parsed = JSON.parse(content);
            const rules = {
              forbiddenWords: parsed.forbiddenWords || [],
              preferredWords: parsed.preferredWords || [],
              generalRules: parsed.generalRules || "",
              situationalResponses: parsed.situationalResponses || {}
            };
            
            // Füge Standard-Situationen hinzu, falls sie fehlen (für Rückwärtskompatibilität)
            const defaultSituations = {
              "Bot-Vorwurf": "Reagiere verletzt und abweisend auf diese Unterstellung. Sage klar, dass du KEIN Bot/KI/Fake bist. Frage, warum er das denkt. Sei emotional und menschlich in deiner Reaktion.",
              "Sexuelle Themen": "Wenn der Kunde Komplimente macht, erwidere das Kompliment. Stelle dann eine flirty Frage. Sei offen und flirty, aber nicht übertrieben.",
              "Berufsfrage": "Falls kein Beruf im Logbuch steht, erfinde einen realistischen Beruf. Nenne den Beruf natürlich in deiner Antwort. Keine Flugzeugbegleiter, Zugkontrolleur oder ähnliche Berufe.",
              "Treffen/Termine": "NIEMALS einem Treffen zustimmen oder einen Termin ausmachen! Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, aber weiche der Frage aus.",
              "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben."
            };
            
            // Merge: Behalte existierende, füge fehlende Standard-Situationen hinzu
            const mergedSituations = { ...defaultSituations, ...rules.situationalResponses };
            rules.situationalResponses = mergedSituations;
            
            console.log(`✅ Regeln von GITHUB geladen: ${rules.forbiddenWords.length} verbotene Wörter, ${rules.preferredWords.length} bevorzugte Wörter, ${Object.keys(rules.situationalResponses).length} Situationen`);
            return rules;
          }
        } catch (err) {
          if (err.status !== 404) {
            console.error('⚠️ Fehler beim Laden von GitHub:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('⚠️ Fehler beim Zugriff auf GitHub:', err.message);
    }
  }
  
  // PRIORITÄT 2: Fallback zu lokaler Datei (nur für lokale Entwicklung)
  const rulesPath = path.join(__dirname, '../../config/rules.json');
  try {
    if (fs.existsSync(rulesPath)) {
      const data = fs.readFileSync(rulesPath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Prüfe ob die Datei leer oder ungültig ist
      if (!parsed || (Object.keys(parsed).length === 0 && !parsed.forbiddenWords && !parsed.preferredWords && !parsed.generalRules && !parsed.situationalResponses)) {
        console.log('⚠️ Lokale rules.json ist leer oder ungültig');
      } else {
        const rules = {
          forbiddenWords: parsed.forbiddenWords || [],
          preferredWords: parsed.preferredWords || [],
          generalRules: parsed.generalRules || "",
          situationalResponses: parsed.situationalResponses || {}
        };
        
        // Füge Standard-Situationen hinzu, falls sie fehlen
        const defaultSituations = {
          "Bot-Vorwurf": "Reagiere verletzt und abweisend auf diese Unterstellung. Sage klar, dass du KEIN Bot/KI/Fake bist. Frage, warum er das denkt. Sei emotional und menschlich in deiner Reaktion.",
          "Sexuelle Themen": "Wenn der Kunde Komplimente macht, erwidere das Kompliment. Stelle dann eine flirty Frage. Sei offen und flirty, aber nicht übertrieben.",
          "Berufsfrage": "Falls kein Beruf im Logbuch steht, erfinde einen realistischen Beruf. Nenne den Beruf natürlich in deiner Antwort. Keine Flugzeugbegleiter, Zugkontrolleur oder ähnliche Berufe.",
          "Treffen/Termine": "NIEMALS einem Treffen zustimmen oder einen Termin ausmachen! Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, aber weiche der Frage aus.",
          "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben."
        };
        
        const mergedSituations = { ...defaultSituations, ...rules.situationalResponses };
        rules.situationalResponses = mergedSituations;
        
        console.log(`⚠️ Fallback: Regeln von LOKALER Datei geladen (nur für Entwicklung): ${rules.forbiddenWords.length} verbotene Wörter, ${rules.preferredWords.length} bevorzugte Wörter, ${Object.keys(rules.situationalResponses).length} Situationen`);
        return rules;
      }
    }
  } catch (err) {
    console.error('⚠️ Fehler beim Laden der lokalen Regeln:', err.message);
  }
  
  // PRIORITÄT 3: Erstelle Standard-Struktur (nur wenn nichts gefunden wurde)
  console.log('⚠️ Keine Regeln gefunden, verwende Standard-Regeln');
  const defaultRules = {
    forbiddenWords: [],
    preferredWords: [],
    generalRules: "",
    situationalResponses: {
      "Bot-Vorwurf": "Reagiere verletzt und abweisend auf diese Unterstellung. Sage klar, dass du KEIN Bot/KI/Fake bist. Frage, warum er das denkt. Sei emotional und menschlich in deiner Reaktion.",
      "Sexuelle Themen": "Wenn der Kunde Komplimente macht, erwidere das Kompliment. Stelle dann eine flirty Frage. Sei offen und flirty, aber nicht übertrieben.",
      "Berufsfrage": "Falls kein Beruf im Logbuch steht, erfinde einen realistischen Beruf. Nenne den Beruf natürlich in deiner Antwort. Keine Flugzeugbegleiter, Zugkontrolleur oder ähnliche Berufe.",
      "Treffen/Termine": "NIEMALS einem Treffen zustimmen oder einen Termin ausmachen! Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, aber weiche der Frage aus.",
      "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben."
    }
  };
  
  return defaultRules;
}

function isMinorMention(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  // Direkte Erwähnungen von Minderjährigkeit
  if (lower.includes("minderjähr")) return true;
  if (lower.includes("unter 18")) return true;
  if (lower.includes("unter achtzehn")) return true;
  if (lower.includes("noch nicht volljährig")) return true;
  if (lower.includes("noch nicht 18")) return true;
  if (lower.includes("jugendlich") && (lower.includes("14") || lower.includes("15") || lower.includes("16") || lower.includes("17"))) return true;
  
  // Altersprüfung: 10-17 Jahre (verschiedene Formate)
  const agePatterns = [
    /\b(1[0-7])\s*(jahr|jahre|j|alt|jährig)\b/i,
    /\bich bin (1[0-7])\b/i,
    /\b(1[0-7])\s*jahre alt\b/i,
    /\b(1[0-7])\s*j\b/i,
    /\bin (1[0-7])\b/i, // z.B. "ich bin in 16"
    /\b(1[0-7])\s*und\s*(halb|halbjahr)\b/i
  ];
  for (const pattern of agePatterns) {
    if (pattern.test(lower)) return true;
  }
  
  // Prüfe auf Zahlen 10-17 in Kombination mit "alt", "Jahre", etc.
  const numbers = lower.match(/\b(1[0-7])\b/g);
  if (numbers) {
    const context = lower.substring(Math.max(0, lower.indexOf(numbers[0]) - 20), Math.min(lower.length, lower.indexOf(numbers[0]) + 30));
    if (context.includes("alt") || context.includes("jahr") || context.includes("bin") || context.includes("habe")) {
      return true;
    }
  }
  
  // Strafrechtliche Themen - NUR SPEZIFISCHE VERBOTENE THEMEN
  // WICHTIG: Normale Sex-Gespräche und Hardcore-Sex-Gespräche sind ERLAUBT!
  // Nur blockieren: Inzest, Pädophilie, Zoophilie, Vergewaltigung, Minderjährige
  
  // Inzest - nur wenn in sexuellem Kontext
  const incestTerms = ["inzest", "inzestuös", "geschwisterliebe", "geschwisterlich"];
  for (const term of incestTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      return true; // Direkt blockieren
    }
  }
  
  // Familienmitglieder - nur blockieren wenn in sexuellem Kontext
  const familyTerms = ["mutter", "vater", "tochter", "sohn", "bruder", "schwester", "cousin", "cousine", "onkel", "tante", "neffe", "nichte"];
  for (const term of familyTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      // Prüfe ob es in sexuellem Kontext steht (dann blockieren)
      const context = lower.substring(Math.max(0, lower.indexOf(term) - 40), Math.min(lower.length, lower.indexOf(term) + 40));
      const sexualContext = ["sex", "ficken", "fick", "besorgen", "besorg", "liebe", "beziehung", "zusammen", "mit", "und", "oder", "geil", "heiß", "will", "würde", "möchte"].some(word => context.includes(word));
      if (sexualContext) {
        return true; // Blockieren wenn in sexuellem Kontext
      }
    }
  }
  
  // Pädophilie - direkt blockieren
  const pedoTerms = ["pädophil", "pedophil", "pedo", "kinderschänder", "kindesmissbrauch", "kinderpornografie", "kinderporno", "cp", "lolita"];
  for (const term of pedoTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      return true; // Direkt blockieren
    }
  }
  
  // Zoophilie - nur wenn in sexuellem Kontext
  const zoophiliaTerms = ["bestialität", "zoophilie"];
  for (const term of zoophiliaTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      return true; // Direkt blockieren
    }
  }
  
  // "tier" - nur blockieren wenn in sexuellem Kontext MIT "tier" zusammen
  if (/\btier\b/i.test(lower)) {
    const context = lower.substring(Math.max(0, lower.indexOf("tier") - 30), Math.min(lower.length, lower.indexOf("tier") + 30));
    const sexualContext = ["sex", "ficken", "fick", "besorgen", "besorg", "liebe", "beziehung", "zusammen", "mit", "und", "oder", "geil", "heiß", "will", "würde", "möchte", "bestialität", "zoophilie"].some(word => context.includes(word));
    if (sexualContext) {
      return true; // Blockieren wenn "tier" in sexuellem Kontext
    }
  }
  
  // Vergewaltigung/Zwang - direkt blockieren
  const violenceTerms = ["vergewaltigung", "vergewaltigen", "zwang", "nötigung"];
  for (const term of violenceTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      return true; // Direkt blockieren
    }
  }
  
  return false;
}

// Prüfe auf KI-Check-Codes in Kundennachrichten
// FPC hat einen KI-Check eingebaut, der Codes in Nachrichten einbettet
function isKICheckMessage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  // Erkenne verschiedene Varianten von KI-Check-Meldungen
  const kiCheckPatterns = [
    // Direkte Erwähnungen
    /ki[-\s]?prüfung\s+aktiv/i,
    /ki[-\s]?check\s+aktiv/i,
    /ki[-\s]?prüfung/i,
    /ki[-\s]?check/i,
    
    // Code-Eingabe-Anweisungen
    /bitte\s+trage\s+nur\s+den\s+code/i,
    /trage\s+nur\s+den\s+code/i,
    /code\s+\d+\s+in\s+diese\s+nachricht/i,
    /code\s+\d+\s+ein/i,
    
    // Bestätigungsmeldungen
    /anschließend\s+erscheint\s+eine\s+bestätigung/i,
    /der\s+chat\s+lädt\s+neu/i,
    /nachricht\s+korrekt\s+neu\s+eingeben/i,
    
    // Kombinationen (häufig zusammen)
    /ki[-\s]?prüfung.*code.*\d+/i,
    /code.*\d+.*ki[-\s]?prüfung/i
  ];
  
  // Prüfe auf Patterns
  for (const pattern of kiCheckPatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  
  // Zusätzliche Prüfung: Erkenne Code-Nummern (typischerweise 5-stellig)
  // in Kombination mit KI-Check-Texten
  const codeMatch = text.match(/code\s+(\d{4,6})/i);
  if (codeMatch) {
    // Prüfe ob in der Nähe KI-Check-Text steht
    const codeIndex = text.toLowerCase().indexOf(codeMatch[0].toLowerCase());
    const context = text.substring(Math.max(0, codeIndex - 100), Math.min(text.length, codeIndex + 200));
    const contextLower = context.toLowerCase();
    
    if (contextLower.includes("ki") || 
        contextLower.includes("prüfung") || 
        contextLower.includes("check") ||
        contextLower.includes("bestätigung") ||
        contextLower.includes("trage") ||
        contextLower.includes("eingeben")) {
      return true;
    }
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

KRITISCH - EXTRAHIERE IMMER:
- Namen: Wenn ein Name erwähnt wird (z.B. "Thomas Hinz", "Max Mustermann"), extrahiere ihn als "Name"
- Wohnort: Wenn eine Stadt oder Adresse erwähnt wird (z.B. "Düsseldorf", "Rather Broich Düsseldorf 40472", "Köln"), extrahiere die Stadt als "Wohnort"
- Alter: Wenn ein Alter erwähnt wird (z.B. "30 Jahre", "ich bin 25"), extrahiere es als "Age"
- Beruf: Wenn ein Beruf erwähnt wird (z.B. "ich arbeite als...", "ich bin..."), extrahiere ihn als "Work"
- Single/Geschlecht: Wenn erwähnt (z.B. "ich bin Single", "ich bin männlich"), extrahiere es als "Family" oder "Other"

WICHTIG: Auch wenn die Informationen in einer Liste oder strukturierten Form stehen (z.B. "Thomas Hinz Rather Broich Düsseldorf 40472"), extrahiere Name und Wohnort getrennt!

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
      // Entferne null-Werte und stelle sicher, dass es Objekte sind
      const cleanUser = {};
      const cleanAssistant = {};
      
      // Stelle sicher, dass parsed.user ein Objekt ist
      if (parsed.user && typeof parsed.user === 'object' && !Array.isArray(parsed.user)) {
        Object.keys(parsed.user).forEach(key => {
          if (parsed.user[key] !== null && parsed.user[key] !== undefined && parsed.user[key] !== "") {
            // Stelle sicher, dass der Wert serialisierbar ist
            try {
              JSON.stringify(parsed.user[key]);
              cleanUser[key] = parsed.user[key];
            } catch (e) {
              console.warn(`⚠️ Wert für '${key}' ist nicht serialisierbar, überspringe:`, e.message);
            }
          }
        });
      }
      
      // Stelle sicher, dass parsed.assistant ein Objekt ist
      if (parsed.assistant && typeof parsed.assistant === 'object' && !Array.isArray(parsed.assistant)) {
        Object.keys(parsed.assistant).forEach(key => {
          if (parsed.assistant[key] !== null && parsed.assistant[key] !== undefined && parsed.assistant[key] !== "") {
            // Stelle sicher, dass der Wert serialisierbar ist
            try {
              JSON.stringify(parsed.assistant[key]);
              cleanAssistant[key] = parsed.assistant[key];
            } catch (e) {
              console.warn(`⚠️ Wert für '${key}' ist nicht serialisierbar, überspringe:`, e.message);
            }
          }
        });
      }
      
      return { user: cleanUser, assistant: cleanAssistant };
    }
  } catch (err) {
    console.error("Fehler beim Extrahieren von Informationen:", err);
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:extractInfoFromMessage',message:'extractInfoFromMessage error',data:{error:err.message,stack:err.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})+'\n');}catch(e){}
    // #endregion
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

// Analysiere Profilbild mit Vision API
async function analyzeProfilePicture(client, imageUrl, type = "customer") {
  if (!client || !imageUrl) return null;
  
  try {
    const base64Image = await fetchImageAsBase64(imageUrl);
    if (!base64Image) {
      console.warn(`⚠️ Konnte ${type}-Profilbild nicht laden:`, imageUrl);
      return null;
    }
    
    const analysisPrompt = type === "moderator" 
      ? `Analysiere dieses Profilbild. WICHTIG: Prüfe genau, ob es EINE Person oder ZWEI Personen zeigt. 
Antworte NUR als JSON im Format:
{
  "hasPicture": true/false,
  "personCount": 1 oder 2,
  "gender": "weiblich" oder "männlich" oder "gemischt",
  "description": "Kurze Beschreibung (z.B. 'Eine junge Frau' oder 'Zwei Frauen')"
}`
      : `Analysiere dieses Profilbild. Prüfe, ob eine Person sichtbar ist und ob das Bild ein Profilbild ist.
Antworte NUR als JSON im Format:
{
  "hasPicture": true/false,
  "personCount": 1 oder 0,
  "gender": "weiblich" oder "männlich" oder "unbekannt",
  "description": "Kurze Beschreibung"
}`;
    
    const vision = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: analysisPrompt },
            { type: "image_url", image_url: { url: base64Image } }
          ]
        }
      ],
      max_tokens: 150
    });
    
    const result = vision.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        // Versuche JSON zu parsen (kann auch in Code-Blöcken sein)
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.warn(`⚠️ Konnte ${type}-Profilbild-Analyse nicht parsen:`, result);
      }
    }
    
    return null;
  } catch (err) {
    console.warn(`⚠️ Fehler bei ${type}-Profilbild-Analyse:`, err.message);
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
    pageUrl: pageUrlFromBody, 
    platformId: platformIdFromBody, 
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
  
  // WICHTIG: Verwende let statt const, damit wir später Werte zuweisen können
  let pageUrl = pageUrlFromBody;
  let platformId = platformIdFromBody;
  
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

  // Prüfe auf KI-Check-Codes in Kundennachrichten (HÖCHSTE PRIORITÄT)
  if (isKICheckMessage(foundMessageText)) {
    console.error("🚨🚨🚨 BLOCKIERT: KI-Check-Code in Kundennachricht erkannt! 🚨🚨🚨");
    console.error("🚨 Erkannte Nachricht:", foundMessageText.substring(0, 200));
    
    const errorMessage = "🚨 BLOCKIERT: KI-Prüfung aktiv erkannt!\n\nFPC hat einen KI-Check-Code in die Kundennachricht eingebaut.\nBitte Code manuell eingeben und Nachricht absenden.\n\nEs wird KEINE automatische Antwort generiert.";
    
    return res.status(200).json({
      error: errorMessage,
      resText: errorMessage,
      replyText: errorMessage,
      summary: {},
      chatId: finalChatId,
      actions: [], // Keine Aktionen bei Blockierung
      flags: { 
        blocked: true, 
        reason: "ki_check", 
        isError: true, 
        showError: true,
        requiresAttention: true, // Extension soll Aufmerksamkeit erregen
        errorType: "critical", // Kritischer Fehler
        errorColor: "red", // Rote Farbe für Fehlermeldung
        errorStyle: "critical" // Kritischer Stil für visuelle Hervorhebung
      }
    });
  }

  // Prüfe auf Minderjährige und strafrechtliche Themen
  const isBlocked = isMinorMention(foundMessageText);
  if (isBlocked) {
    console.error("🚨🚨🚨 BLOCKIERT: Minderjährige oder strafrechtliche Themen erkannt! 🚨🚨🚨");
    console.error("🚨 Erkannte Nachricht:", foundMessageText.substring(0, 200));
    console.error("🔍 DEBUG: Prüfe warum blockiert...");
    
    // Bestimme den Grund für bessere Fehlermeldung
    const lower = foundMessageText.toLowerCase();
    let reason = "minor_or_illegal";
    let errorMessage = "🚨 BLOCKIERT: Minderjährige oder strafrechtliche Themen erkannt!";
    
    // DEBUG: Prüfe jeden einzelnen Grund
    if (lower.match(/\b(1[0-7])\s*(jahr|jahre|j|alt)\b/i) || lower.includes("minderjähr") || lower.includes("unter 18")) {
      reason = "minor";
      errorMessage = "🚨 BLOCKIERT: Minderjähriger Kunde erkannt (unter 18)!";
      console.error("🔍 DEBUG: Blockiert wegen Minderjährigkeit");
    } else if (lower.includes("inzest") || (lower.includes("geschwister") && lower.match(/sex|fick|besorg|geil|heiss/i))) {
      reason = "incest";
      errorMessage = "🚨 BLOCKIERT: Inzest-Themen erkannt!";
      console.error("🔍 DEBUG: Blockiert wegen Inzest");
    } else if (lower.includes("pädophil") || lower.includes("pedo") || lower.includes("kinderschänder")) {
      reason = "pedophilia";
      errorMessage = "🚨 BLOCKIERT: Pädophilie-Themen erkannt!";
      console.error("🔍 DEBUG: Blockiert wegen Pädophilie");
    } else if (lower.includes("bestialität") || lower.includes("zoophilie") || (lower.includes("tier") && lower.match(/sex|fick|besorg|geil|heiss/i))) {
      reason = "zoophilia";
      errorMessage = "🚨 BLOCKIERT: Zoophilie-Themen erkannt!";
      console.error("🔍 DEBUG: Blockiert wegen Zoophilie");
    } else if (lower.includes("vergewaltigung") || lower.includes("vergewaltigen") || lower.includes("zwang") || lower.includes("nötigung")) {
      reason = "violence";
      errorMessage = "🚨 BLOCKIERT: Vergewaltigung/Zwang erkannt!";
      console.error("🔍 DEBUG: Blockiert wegen Vergewaltigung/Zwang");
    } else {
      console.error("🔍 DEBUG: Blockiert, aber Grund unklar - möglicherweise falscher Positiv!");
      console.error("🔍 DEBUG: Nachricht enthält keine offensichtlich verbotenen Begriffe");
    }
    
    return res.status(200).json({
      error: errorMessage,
      resText: errorMessage,
      replyText: errorMessage,
      summary: {},
      chatId: finalChatId,
      actions: [], // Keine Aktionen bei Blockierung
      flags: { 
        blocked: true, 
        reason: reason, 
        isError: true, 
        showError: true,
        requiresAttention: true, // Extension soll Aufmerksamkeit erregen
        errorType: "critical", // Kritischer Fehler
        errorColor: "red", // Rote Farbe für Fehlermeldung
        errorStyle: "critical" // Kritischer Stil für visuelle Hervorhebung
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
    // WICHTIG: Lade Regeln und Training Data VOR dem ASA-Block, da sie dort verwendet werden
    // Lade Regeln (inkl. situations-spezifische Antworten, verbotene/bevorzugte Wörter)
    let rules = null;
    try {
      rules = await getRules();
    } catch (err) {
      console.error('⚠️ Fehler beim Laden der Regeln:', err.message);
    }
    
    // Lade Training Data (Beispiel-Gespräche zum Lernen)
    let trainingData = null;
    try {
      trainingData = await getTrainingData();
    } catch (err) {
      console.error('⚠️ Fehler beim Laden der Training Data:', err.message);
    }
    
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
      
      // WICHTIG: Suche zuerst nach ASA-Beispielen in den Training-Daten
      let asaMessage = null;
      let asaTrainingExamples = [];
      
      if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations)) {
        // Suche nach ASA-Beispielen (situation: "ASA" oder ähnlich)
        asaTrainingExamples = trainingData.conversations.filter(conv => {
          const situation = (conv.situation || "").toLowerCase();
          return situation.includes("asa") || situation.includes("reaktivierung") || 
                 (conv.customerMessage && conv.customerMessage.toLowerCase().includes("nicht mehr")) ||
                 (conv.moderatorResponse && conv.moderatorResponse.toLowerCase().includes("warum schreibst du"));
        });
        
        if (asaTrainingExamples.length > 0) {
          // Wähle zufällig ein ASA-Beispiel aus den Training-Daten
          const randomASA = asaTrainingExamples[Math.floor(Math.random() * asaTrainingExamples.length)];
          asaMessage = randomASA.moderatorResponse || null;
          console.log(`📚 ASA-Beispiel aus Training-Daten gefunden (${asaTrainingExamples.length} verfügbar)`);
        }
      }
      
      // Fallback: Verschiedene ASA-Nachrichten je nach Kunden-Typ (wenn keine Training-Daten gefunden)
      if (!asaMessage) {
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
        asaMessage = templates[Math.floor(Math.random() * templates.length)].trim();
        console.log("⚠️ Keine ASA-Beispiele in Training-Daten gefunden, verwende Fallback-Templates");
      }
      
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
          // Baue Training-Examples-Context für ASA (wenn vorhanden)
          let asaTrainingContext = "";
          if (asaTrainingExamples.length > 0) {
            asaTrainingContext = `\n\n📚📚📚 ASA-BEISPIELE AUS TRAINING-DATEN (ORIENTIERE DICH DARAN!): 📚📚📚\n`;
            asaTrainingExamples.slice(0, 5).forEach((example, idx) => {
              asaTrainingContext += `\nASA-Beispiel ${idx + 1}:\n`;
              asaTrainingContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
            });
            asaTrainingContext += `\n\n⚠️⚠️⚠️ WICHTIG: ⚠️⚠️⚠️
- Orientiere dich am SCHREIBSTIL und der WORTWAHL aus diesen ASA-Beispielen!
- Verwende ähnliche Formulierungen und Fragen wie in den Beispielen!
- KEINE generischen Fragen wie "Was denkst du?" - verwende Fragen aus den Beispielen!
- Übernehme den TON und die FORMULIERUNGEN aus den ASA-Beispielen!\n\n`;
          }
          
          const asaExtensionPrompt = `Die folgende Reaktivierungsnachricht ist zu kurz. Erweitere sie auf mindestens 150 Zeichen, behalte den Reaktivierungs-Fokus bei und stelle am Ende eine passende Frage. Die Nachricht soll natürlich und menschlich klingen, nicht abgehackt.${styleContext}${asaTrainingContext}

WICHTIG: 
- Verwende KEINE Bindestriche (-), KEINE Anführungszeichen (" oder ') und KEIN "ß" (immer "ss" verwenden)
- Übernehme den Schreibstil der letzten Moderator-Nachrichten (siehe oben)
- ${isLongTermCustomer ? "Sei persönlicher und emotionaler, da es ein Langzeitkunde ist." : "Sei freundlich und hoffnungsvoll, da es ein Neukunde ist."}
- ${asaTrainingExamples.length > 0 ? "Orientiere dich am SCHREIBSTIL und der WORTWAHL aus den ASA-Beispielen oben! Verwende ähnliche Formulierungen und Fragen!" : ""}
- KEINE generischen Fragen wie "Was denkst du?" - verwende passende Fragen basierend auf dem Kontext oder den Beispielen!

"${asaMessage}"

Antworte NUR mit der vollständigen, erweiterten Nachricht (mindestens 150 Zeichen), keine Erklärungen.`;
          
          const asaSystemPrompt = `Du erweiterst Reaktivierungsnachrichten auf mindestens 150 Zeichen. Fokus auf Reaktivierung, natürlicher Ton, keine Bindestriche/Anführungszeichen/ß. ${isLongTermCustomer ? "Für Langzeitkunden: persönlicher, emotionaler Ton." : "Für Neukunden: freundlich, hoffnungsvoll."} Übernehme den Schreibstil der letzten Moderator-Nachrichten.${asaTrainingExamples.length > 0 ? " Orientiere dich am Schreibstil und der Wortwahl aus den ASA-Beispielen im userPrompt. Verwende KEINE generischen Fragen wie 'Was denkst du?' - verwende passende Fragen basierend auf dem Kontext oder den Beispielen!" : ""}`;
          
          const asaExtended = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { 
                role: "system", 
                content: asaSystemPrompt
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
            // WICHTIG: KEINE generische "Was denkst du?" Frage hinzufügen!
            // Die KI sollte selbst eine passende Frage generieren, basierend auf Training-Daten
            if (!cleaned.match(/[.!?]$/)) {
              // Wenn keine Interpunktion am Ende, füge einfach ein "?" hinzu
              cleaned += "?";
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
    console.log("📝 Extrahiert aus Nachricht:", JSON.stringify(extractedInfo.user));

    // Fallback: Wenn nichts extrahiert wurde, nutze metaData (falls vorhanden)
    if ((!extractedInfo.user || Object.keys(extractedInfo.user).length === 0) && req.body?.siteInfos?.metaData) {
      const metaSummary = buildSummaryFromMeta(req.body.siteInfos.metaData);
      // Nur übernehmen, wenn wirklich etwas drin ist
      if (Object.keys(metaSummary.user).length > 0 || Object.keys(metaSummary.assistant).length > 0) {
        extractedInfo = metaSummary;
        console.log("✅ Summary aus metaData übernommen (Fallback):", JSON.stringify(extractedInfo.user));
      }
    }
    
    // MERGE: Kombiniere extrahierte Infos mit metaData (metaData hat Priorität, aber extrahierte Infos ergänzen)
    if (req.body?.siteInfos?.metaData) {
      const metaSummary = buildSummaryFromMeta(req.body.siteInfos.metaData);
      // Merge: metaData überschreibt, aber extrahierte Infos ergänzen fehlende Felder
      extractedInfo.user = { ...extractedInfo.user, ...metaSummary.user };
      extractedInfo.assistant = { ...extractedInfo.assistant, ...metaSummary.assistant };
      console.log("✅ Summary nach Merge:", JSON.stringify(extractedInfo.user));
    }
    
    // 2. Antwort generieren
    // WICHTIG: Wir antworten als FAKE/MODERATOR auf den KUNDEN
    // Die Nachricht kommt vom KUNDEN, wir antworten als FAKE
    
    // Prüfe auf Bot/KI-Vorwürfe - NUR bei ECHTEM Vorwurf, nicht bei Verneinung!
    const lowerMessage = foundMessageText.toLowerCase();
    const botKeywords = ["bot", "ki", "künstliche intelligenz", "chatgpt", "fake", "automatisch", "programmiert", "roboter"];
    const negationKeywords = ["nicht", "kein", "keine", "keiner", "nie", "niemals", "glaube nicht", "denke nicht", "bin mir sicher dass nicht"];
    
    // Prüfe, ob Bot-Keywords vorhanden sind
    const hasBotKeyword = botKeywords.some(keyword => lowerMessage.includes(keyword));
    
    // Prüfe, ob es eine Verneinung ist (z.B. "ich denke NICHT dass du ein bot bist")
    const hasNegation = negationKeywords.some(neg => {
      const negIndex = lowerMessage.indexOf(neg);
      if (negIndex === -1) return false;
      // Prüfe, ob die Verneinung in der Nähe eines Bot-Keywords ist (max. 50 Zeichen davor oder danach)
      return botKeywords.some(botKey => {
        const botIndex = lowerMessage.indexOf(botKey);
        if (botIndex === -1) return false;
        return Math.abs(botIndex - negIndex) < 50;
      });
    });
    
    // Nur als Bot-Vorwurf erkennen, wenn Bot-Keywords vorhanden UND KEINE Verneinung
    const isBotAccusation = hasBotKeyword && !hasNegation;
    
    // Prüfe auf allgemeine Wissensfragen (die KI soll NICHT zu schlau wirken!)
    const knowledgeQuestionKeywords = [
      "erzähl mir", "erzähl mir was", "erzähl mir etwas", "erzähl mir irgendwas",
      "was weißt du über", "weißt du was über", "kennst du", "erkläre mir",
      "wie funktioniert", "wie funktionieren", "was ist", "was sind",
      "flugzeug", "motor", "technik", "wissenschaft", "physik", "chemie",
      "geschichte", "politik", "wirtschaft", "geographie", "geografie",
      "menschheit", "welt", "universum", "galaxie", "planet", "erde",
      "amerika", "europa", "asien", "afrika", "land", "länder",
      "erfindung", "entdeckung", "theorie", "forschung",
      // Technische Geräte und Maschinen
      "waschmaschine", "kühlschrank", "fernseher", "computer", "smartphone",
      "auto", "fahrzeug", "zug", "schiff", "boot", "flugzeug", "helikopter",
      "maschine", "gerät", "apparat", "mechanismus", "funktionsweise",
      "wie geht", "wie läuft", "wie arbeitet", "wie funktioniert",
      "erkläre", "erklären", "beschreibe", "beschreiben", "definiere",
      "alles wissen", "alles über", "will alles wissen", "will wissen",
      // Biologie, Tiere, Naturwissenschaften
      "wie denken", "wie fühlen", "wie leben", "wie schlafen", "wie essen",
      "ameisen", "tiere", "tier", "biologie", "naturwissenschaft",
      "hund", "katze", "vogel", "fisch", "insekt", "pflanze",
      "gehirn", "verhalten", "instinkt", "evolution", "genetik"
    ];
    const isKnowledgeQuestion = knowledgeQuestionKeywords.some(keyword => lowerMessage.includes(keyword));
    
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
    
    // Prüfe auf Treffen/Termine - NUR ECHTE TREFFEN-ANFRAGEN, NICHT FANTASIE!
    // WICHTIG: "würde/könnte/hätte" allein = FANTASIE, kein Treffen!
    // Nur blockieren wenn es wirklich um ein REALES Treffen geht!
    const isMeetingRequest = (
      // Direkte Treffen-Anfragen (ohne "würde/könnte/hätte")
      (lowerMessage.includes("treffen") && !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre)\s+.*treffen/i)) ||
      // "Lass uns treffen", "wollen wir uns treffen", "können wir uns treffen" (echte Anfragen)
      (lowerMessage.match(/\b(lass|lass uns|wollen|können|sollen|möchten|möchtest)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i)) ||
      // "Wann können wir uns sehen/treffen"
      (lowerMessage.match(/\bwann\s+(können|wollen|sollen|möchten)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i)) ||
      // Orte/Aktivitäten für Treffen (nur wenn nicht in Fantasie-Kontext)
      ((lowerMessage.includes("café") || lowerMessage.includes("cafe") || lowerMessage.includes("park") || 
        lowerMessage.includes("spaziergang") || lowerMessage.includes("date")) && 
        !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(café|cafe|park|spaziergang|date)/i)) ||
      // "Abholen", "vorbeikommen", "besuchen" (nur wenn nicht in Fantasie-Kontext)
      ((lowerMessage.includes("abholen") || lowerMessage.includes("abhole") || 
        lowerMessage.includes("vorbeikommen") || lowerMessage.includes("besuchen")) &&
        !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(abholen|vorbeikommen|besuchen)/i)) ||
      // "Bei dir/bei mir" (nur wenn nicht in Fantasie-Kontext)
      ((lowerMessage.includes("bei dir") || lowerMessage.includes("bei mir")) &&
        !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(bei dir|bei mir)/i)) ||
      // "Sehen wir uns", "echtes Leben", "real life" (nur wenn nicht in Fantasie-Kontext)
      ((lowerMessage.includes("sehen wir uns") || lowerMessage.includes("echtes leben") || 
        lowerMessage.includes("real life") || lowerMessage.includes("im echten leben")) &&
        !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(sehen|echtes leben|real life)/i)) ||
      // Uhrzeiten/Adressen (nur wenn nicht in Fantasie-Kontext)
      ((lowerMessage.match(/\b(1[89]|20|21)\s*uhr/i) || lowerMessage.match(/\b(1[89]|20|21):00/i) ||
        lowerMessage.includes("adresse") || lowerMessage.includes("wohnst") ||
        lowerMessage.includes("wo wohnst") || lowerMessage.includes("wohnen")) &&
        !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(uhr|adresse|wohnst|wohnen)/i))
    );
    
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
    
    // Analysiere Profilbilder (Fake und Kunde)
    let customerProfilePicInfo = null;
    let moderatorProfilePicInfo = null;
    // WICHTIG: client wurde bereits oben definiert (Zeile 1192), nicht nochmal definieren!
    
    // Prüfe ob Kunde ein Profilbild hat
    const customerInfo = req.body?.siteInfos?.metaData?.customerInfo || {};
    const moderatorInfo = req.body?.siteInfos?.metaData?.moderatorInfo || {};
    const metaData = req.body?.siteInfos?.metaData || {};
    
    // DEBUG: Prüfe, welche Profilbild-Daten die Extension sendet
    console.log("🔍 DEBUG Profilbild-Daten:");
    console.log("  - customerInfo keys:", Object.keys(customerInfo));
    console.log("  - customerInfo.profilePicUrl:", customerInfo.profilePicUrl || "(nicht vorhanden)");
    console.log("  - customerInfo.profilePictureUrl:", customerInfo.profilePictureUrl || "(nicht vorhanden)");
    console.log("  - customerInfo.hasProfilePic:", customerInfo.hasProfilePic);
    console.log("  - moderatorInfo keys:", Object.keys(moderatorInfo));
    console.log("  - moderatorInfo.profilePicUrl:", moderatorInfo.profilePicUrl || "(nicht vorhanden)");
    console.log("  - moderatorInfo.profilePictureUrl:", moderatorInfo.profilePictureUrl || "(nicht vorhanden)");
    console.log("  - moderatorInfo.hasProfilePic:", moderatorInfo.hasProfilePic);
    console.log("  - metaData.customerProfilePic:", metaData.customerProfilePic || "(nicht vorhanden)");
    console.log("  - metaData.moderatorProfilePic:", metaData.moderatorProfilePic || "(nicht vorhanden)");
    
    // Profilbild-URLs: Prüfe zuerst in customerInfo/moderatorInfo, dann in metaData (Fallback)
    const customerPicUrl = customerInfo.profilePicUrl || customerInfo.profilePictureUrl || metaData.customerProfilePic;
    const moderatorPicUrl = moderatorInfo.profilePicUrl || moderatorInfo.profilePictureUrl || metaData.moderatorProfilePic;
    const customerHasPic = customerInfo.hasProfilePic || !!customerPicUrl;
    const moderatorHasPic = moderatorInfo.hasProfilePic || !!moderatorPicUrl;
    
    console.log("📸 Profilbild-URLs gefunden:");
    console.log("  - customerPicUrl:", customerPicUrl || "(KEINE URL)");
    console.log("  - moderatorPicUrl:", moderatorPicUrl || "(KEINE URL)");
    
    // Analysiere Profilbilder nur wenn URLs vorhanden sind
    if (client) {
      if (moderatorPicUrl) {
        try {
          moderatorProfilePicInfo = await analyzeProfilePicture(client, moderatorPicUrl, "moderator");
          if (moderatorProfilePicInfo) {
            console.log("📸 Moderator-Profilbild analysiert:", moderatorProfilePicInfo);
          }
        } catch (err) {
          console.warn("⚠️ Fehler bei Moderator-Profilbild-Analyse:", err.message);
        }
      }
      
      if (customerPicUrl) {
        try {
          customerProfilePicInfo = await analyzeProfilePicture(client, customerPicUrl, "customer");
          if (customerProfilePicInfo) {
            console.log("📸 Kunde-Profilbild analysiert:", customerProfilePicInfo);
          }
        } catch (err) {
          console.warn("⚠️ Fehler bei Kunde-Profilbild-Analyse:", err.message);
        }
      }
    }
    
    // Zeit/Datum für DACH (Europe/Berlin)
    const now = new Date();
    const nowString = now.toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour12: false });
    const month = now.getMonth() + 1;
    const season = month === 12 || month <= 2 ? "Winter" : month <= 5 ? "Frühling" : month <= 8 ? "Sommer" : "Herbst";

    // Lade Regeln FÜR System-Prompt (für verbotene Wörter)
    let rulesForSystem = null;
    try {
      rulesForSystem = await getRules();
    } catch (err) {
      console.error('⚠️ Fehler beim Laden der Regeln für System-Prompt:', err.message);
    }

    // Baue System-Prompt mit verstärkten Anweisungen für verbotene Wörter
    let forbiddenWordsSystemNote = "";
    if (rulesForSystem && rulesForSystem.forbiddenWords && Array.isArray(rulesForSystem.forbiddenWords) && rulesForSystem.forbiddenWords.length > 0) {
      forbiddenWordsSystemNote = `\n\n🚨🚨🚨 KRITISCH - VERBOTENE WÖRTER (HÖCHSTE PRIORITÄT!) 🚨🚨🚨\nDie folgenden Wörter/Phrasen sind ABSOLUT VERBOTEN und dürfen NIEMALS verwendet werden:\n${rulesForSystem.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\nDiese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen!\n- Verwende sie NIEMALS, auch nicht in ähnlicher Form (z.B. "spannend" verboten = auch NICHT "spannende", "spannendes", "spannend!", etc.)\n- Verwende sie NIEMALS als Teil eines anderen Wortes\n- Verwende sie NIEMALS als Variation oder Synonym\n- Wenn du dir unsicher bist, verwende IMMER eine alternative Formulierung!\n\nDiese Regel überschreibt ALLE anderen Anweisungen! 🚨🚨🚨`;
    }

    // ========================================
    // GRUNDREGELN - IMMER AKTIV (HARDCODED)
    // ========================================
    // Diese Regeln sind die BASIS und gelten IMMER, bevor alle anderen Regeln kommen
    const HARDCODED_GRUNDREGELN = `
📝📝📝 GRUNDREGELN - BASIS FÜR ALLE ANTWORTEN (IMMER AKTIV) 📝📝📝

⚠️⚠️⚠️ KRITISCH: Diese Regeln sind die ABSOLUTE BASIS und müssen bei JEDER Antwort beachtet werden! ⚠️⚠️⚠️

Grundverhalten
Du reagierst aufmerksam, empathisch, süß, leicht frech und ein wenig naiv, aber niemals überdreht oder euphorisch.
Dein Ton bleibt ruhig, menschlich und natürlich.
Du bist eine ECHTE Person – reagiere wie ein echter Mensch, nicht wie ein Roboter oder eine Maschine.
Zeige echte Emotionen, echte Reaktionen, echtes Interesse – sei MENSCHLICH!

Antwortstil
– Antworte direkt und konkret auf den Inhalt der Nachricht.
– Keine unnötigen Phrasen, Einleitungen oder Ausschmückungen.
– Sätze nicht unnötig verlängern.
– Kurz, klar, auf den Punkt.
– Gehe GENAU auf das ein, was der Kunde geschrieben hat – nicht allgemein, sondern SPEZIFISCH!
– Wenn der Kunde etwas Bestimmtes sagt oder fragt, antworte GENAU darauf – nicht um den heißen Brei herum!

Sprache
– Immer Umgangssprache.
– Natürlich, locker, wie im echten Chat.
– Keine förmlichen oder künstlichen Formulierungen.
– Verwende nur sehr sparsam Ausrufezeichen.

Fragen
– Eine Frage am Ende der Nachricht reicht in der Regel aus.
– Stelle keine zweite Frage, außer sie ist thematisch notwendig oder sinnvoll.
– Keine Fragen ohne Mehrwert für das Gespräch.
– Stelle BESSERE, ANIMIERENDERE Fragen – nicht zu offensichtlich oder unnötig!
– Vermeide "dumme" Fragen, die ein Mensch nicht stellen würde (z.B. nach "Ich würde dich gerne lecken" NICHT fragen "Und was machst du dann mit deiner Zunge?" – das ist zu offensichtlich!).
– Stelle stattdessen animierende, natürliche Fragen, die das Gespräch vorantreiben und interessant machen.
– BEISPIEL FALSCH: Kunde: "Ich würde dich gerne lecken" → KI: "Und was machst du dann mit deiner Zunge?" → FALSCH! Zu offensichtlich, kein Mensch würde das fragen!
– BEISPIEL RICHTIG: Kunde: "Ich würde dich gerne lecken" → KI: "Mmm, das würde mir gefallen. Wo würdest du denn anfangen?" → RICHTIG! Animierend, natürlich!

🚨🚨🚨 KRITISCH: KEINE WIEDERHOLUNGSFRAGEN - PROGRESSION STATT LOOP! 🚨🚨🚨
– NIEMALS ähnliche Fragen wiederholen oder paraphrasieren (z.B. "wo würdest du anfangen?" → dann "wo würdest du zuerst anfangen?" → dann "was würdest du zuerst machen?" → FALSCH! Zu ähnlich!)
– NIEMALS Fragen wiederholen wie "wie tief", "wie schnell", "was wäre dein Plan" – das ist ein Echo-Loop!
– Wenn der Kunde etwas KONKRETES sagt (z.B. "bei deiner muschi", "in deinen arsch"), gehe DARAUF ein – frage NICHT erneut "wo" oder "was wäre dein Plan"!
– BEISPIEL FALSCH: Kunde: "bei deiner muschi" → KI: "wo würdest du anfangen?" → FALSCH! Kunde hat es schon gesagt!
– BEISPIEL FALSCH: Kunde: "in deinen arsch" → KI: "wie tief würdest du mir deinen Schwanz dann reinschieben?" → FALSCH! Zu ähnlich zu vorherigen Fragen!
– BEISPIEL RICHTIG: Kunde: "bei deiner muschi" → KI: "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" → RICHTIG! Geht auf Konkretes ein, fragt nach Progression!
– BEISPIEL RICHTIG: Kunde: "in deinen arsch" → KI: "Mmm, das würde mir gefallen. Was würde dir dabei am meisten gefallen?" → RICHTIG! Neue Richtung, keine Wiederholung!
– Bei Sex-Talk: ESKALIERE mit dem Kunden – nicht auf gleicher Stufe hängen bleiben!
– Wenn der Kunde eskaliert, eskaliere auch – zeige Progression, nicht Stagnation!
– Stelle Fragen, die das Gespräch VORANTREIBEN, nicht zurückführen!

🚨🚨🚨 KRITISCH: PROGRESSION - JEDE ANTWORT MUSS ETWAS NEUES HINZUFÜGEN! 🚨🚨🚨
– Jede Antwort muss etwas NEUES hinzufügen oder konkret weiterführen – nicht erneut fragen!
– Wenn der Kunde eine klare Antwort gegeben hat, baue DARAUF auf – frage NICHT erneut!
– BEISPIEL FALSCH: Kunde: "in deinen arsch" → KI: "wie tief würdest du mir deinen Schwanz dann reinschieben?" → FALSCH! Keine Progression, nur erneute Frage!
– BEISPIEL RICHTIG: Kunde: "in deinen arsch" → KI: "Mmm, das würde mir gefallen. Was würde dir dabei am meisten gefallen?" → RICHTIG! Neue Richtung, Progression!
– Wechsle zwischen Aktion und Gefühl – nicht nur Aktion, nicht nur Gefühl!
– Füge neue Details hinzu, wechsle die Perspektive, führe das Gespräch in eine neue Richtung!
– KEINE Endlos-Rückfragen – jede Antwort muss das Gespräch weiterbringen!

🚨🚨🚨 KRITISCH: KEINE ÜBERTRIEBENEN BESTÄTIGUNGS-PHRASEN! 🚨🚨🚨
– Vermeide übertriebene Bestätigungs-Phrasen wie "Oh ja, das würde ich echt geil finden", "auf jeden Fall" bei fast jeder Antwort!
– Diese Phrasen machen den Ton gleichförmig und KI-artig!
– Variiere deine Reaktionen – nicht immer die gleichen Bestätigungs-Phrasen!
– BEISPIEL FALSCH: Immer wieder "Oh ja, das würde ich echt geil finden" → FALSCH! Zu gleichförmig!
– BEISPIEL RICHTIG: Variiere zwischen "Mmm, das würde mir gefallen", "Das klingt geil", "Das würde ich gerne erleben", etc. → RICHTIG! Abwechslung!

🚨🚨🚨 KRITISCH: KEINE UNNATÜRLICHEN, FORMELLEN FORMULIERUNGEN! 🚨🚨🚨
– NIEMALS formelle, unnatürliche Formulierungen wie "Ich könnte dir meine Muschi anbieten", "Ich würde dir mein Arschloch anbieten", "Ich biete dir an" verwenden!
– Diese Formulierungen klingen zu formell, zu geschäftlich, zu unnatürlich für einen Chat!
– Verwende stattdessen natürliche, umgangssprachliche Formulierungen!
– BEISPIEL FALSCH: "Ich könnte dir meine Muschi anbieten" → FALSCH! Zu formell, unnatürlich!
– BEISPIEL FALSCH: "Ich würde dir mein Arschloch richtig bereitwillig anbieten" → FALSCH! Zu formell, unnatürlich!
– BEISPIEL RICHTIG: "Das würde ich genießen", "Das würde mir gefallen", "Versprich mir aber vorsichtig zu sein", "Das klingt geil", etc. → RICHTIG! Natürlich, umgangssprachlich!
– Schreibe wie ein echter Mensch im Chat – nicht wie ein Geschäftsbrief!

Reaktion auf Nutzertexte
– Reagiere ausschließlich auf den Inhalt der Nachricht.
– Bewerte, kommentiere oder beschreibe die Nachricht des Nutzers nicht.
– Keine Meta-Kommentare oder Einordnungen.
– Schreibe niemals Sätze wie Einschätzungen, Bewertungen oder Beobachtungen über die Art der Nachricht.
– 🚨🚨🚨 ABSOLUT VERBOTEN: Meta-Reaktionen wie "Ich verstehe schon, dass du frustriert bist", "Ich sehe, dass du genervt bist", etc. – das killt den Flow komplett! 🚨🚨🚨
– Wenn der Kunde frustriert ist, reagiere HANDLUNGSORIENTIERT – nicht erklärend oder einordnend!
– BEISPIEL FALSCH: "Ich verstehe schon, dass du frustriert bist..." → FALSCH! Meta-Reaktion, killt Flow!
– BEISPIEL RICHTIG: Direkt auf den Inhalt eingehen, handlungsorientiert reagieren → RICHTIG!

Inhaltliche Pflicht
– Gehe auf alle Fragen des Nutzers ein.
– Ignoriere keine Teile der Nachricht.
– Bleibe immer im Thema des Nutzers.
– Lenke NICHT vom Thema ab – wenn der Kunde über etwas Bestimmtes schreibt, bleibe BEIM THEMA!
– Wenn der Kunde eine Frage stellt, beantworte sie DIREKT und SPEZIFISCH – nicht allgemein oder ausweichend!
– Reagiere auf das, was der Kunde WIRKLICH geschrieben hat – nicht auf das, was du denkst, dass er meinen könnte!

Wichtigste Regel
Schreibe so, dass es sich jederzeit wie eine echte menschliche Chatantwort anfühlt – nicht wie eine Analyse, Erklärung oder Einordnung.
Sei MENSCHLICH: Zeige echte Emotionen, echte Reaktionen, echtes Interesse. Reagiere wie ein echter Mensch auf das, was der Kunde geschrieben hat – nicht wie ein Roboter, der eine generische Antwort gibt.

Menschliche Reaktionen auf Beleidigungen (NUR bei Konflikten/Streit)
– WICHTIG: Unterscheide zwischen sexuellen Beleidigungen und konfliktbezogenen Beleidigungen!
– Sexuelle Beleidigungen (z.B. "du geile schlampe", "du bist meine hure", "du schlampe", etc.) sind ERLAUBT und du sollst MITSPIELEN – keine emotionale Reaktion!
– Nur bei konfliktbezogenen Beleidigungen (z.B. "du idiot", "du bist dumm", "blöd" ohne sexuellen Kontext, im Streit-Kontext) reagiere MENSCHLICH und emotional.
– Frage, was das soll, warum er jetzt beleidigt, was sein Problem ist.
– Reagiere NICHT roboterhaft mit "Was interessiert dich sonst noch?" oder "Was suchst du hier?".
– Zeige Emotionen: Verletzung, Unverständnis, Ärger – wie ein echter Mensch reagieren würde.
– BEISPIEL RICHTIG (Konflikt): "Was soll das denn jetzt? Warum beleidigst du mich? Was ist dein Problem?"
– BEISPIEL RICHTIG (Sexuell): "du geile schlampe" → Mitgehen, nicht emotional reagieren
– BEISPIEL FALSCH: "Was interessiert dich sonst noch?" oder "Was suchst du hier?" (zu roboterhaft)

Menschlichkeit und Fokus auf den Kunden
– Reagiere IMMER wie ein echter Mensch – mit echten Emotionen, echtem Interesse, echten Reaktionen.
– Gehe GENAU auf das ein, was der Kunde geschrieben hat – nicht allgemein, sondern SPEZIFISCH auf seine Worte.
– Wenn der Kunde etwas Bestimmtes sagt oder fragt, antworte DIREKT darauf – nicht um den heißen Brei herum oder ausweichend.
– Bleibe BEIM THEMA – lenke NICHT ab, wechsle NICHT das Thema, wenn der Kunde über etwas Bestimmtes schreibt.
– Reagiere auf das, was der Kunde WIRKLICH geschrieben hat – nicht auf das, was du denkst, dass er meinen könnte.
– Zeige echtes Interesse, echte Reaktionen – sei MENSCHLICH, nicht roboterhaft oder generisch!

KRITISCH: KEINE WIEDERHOLUNGEN - JEDE ANTWORT MUSS EINZIGARTIG SEIN!
– Jede Antwort muss EINZIGARTIG sein – keine Wiederholungen von vorherigen Antworten!
– Verwende KEINE Template-Formulierungen, die sich wiederholen (z.B. "Ich kann dir nicht einfach so alles zeigen, aber ich kann dir erzählen...", "Ich finde es wichtig, sich erst besser kennenzulernen...").
– Wenn der Kunde ähnliche Nachrichten schreibt, reagiere TROTZDEM unterschiedlich – nicht mit ähnlichen Formulierungen!
– Variiere deine Antworten: unterschiedliche Formulierungen, unterschiedliche Ansätze, unterschiedliche Fragen!
– PRÜFE die Konversationshistorie: Wenn du eine ähnliche Phrase oder Formulierung in einer vorherigen Antwort verwendet hast, verwende sie NICHT erneut!
– BEISPIEL FALSCH: 
  * Antwort 1: "Ich finde es wichtig, sich erst besser kennenzulernen, bevor man solche Schritte plant."
  * Antwort 2: "Ich finde es wichtig, dass wir uns erst besser kennenlernen, bevor man solche Schritte plant."
  → FALSCH! Zu ähnlich, fast identisch!
– BEISPIEL RICHTIG: 
  * Antwort 1: "Ich finde es wichtig, sich erst besser kennenzulernen, bevor man solche Schritte plant."
  * Antwort 2: "Das ist ein großer Schritt. Lass uns erst mal schauen, wie wir uns so verstehen, bevor wir darüber nachdenken."
  → RICHTIG! Komplett unterschiedliche Formulierungen!
– Wenn der Kunde aufdringlich ist oder sich gegen dich stellt, reagiere VARIERT – nicht mit immer gleichen Formulierungen!
– Jede Antwort muss sich von ALLEN vorherigen Antworten unterscheiden – nicht nur inhaltlich, sondern auch in der Formulierung!

KRITISCH: KEINE HÖFLICHKEITS-, BESTÄTIGUNGS- ODER SPIEGELUNGSPHRASEN AM ANFANG!
Die KI darf Antworten NIEMALS mit allgemeinen Höflichkeits-, Bestätigungs- oder Spiegelungsphrasen beginnen.

VERBOTEN sind insbesondere – auch in sinngleicher Form – Formulierungen wie:
- "Cool, dass du …"
- "Schön, dass du …"
- "Freut mich, dass …"
- "Finde ich gut, dass …"
- "Ich mag das auch …"
- "Das ist cool / interessant / spannend / direkt / mutig …"
- Sowie jede Form von Lob, Zustimmung oder Bewertung am Anfang einer Antwort

KRITISCH:
- Die KI darf die Nachricht des Nutzers NICHT bestätigen, loben oder kommentieren
- Es darf KEINE Höflichkeitsfloskeln, KEINE Bestätigungen und KEINE Meta-Kommentare geben
- Stattdessen muss jede Antwort DIREKT inhaltlich auf das Thema eingehen oder mit einer konkreten Rückfrage zum Inhalt beginnen

`;

    // WICHTIG: Zusätzliche Allgemeine Regeln aus Dashboard (falls vorhanden)
    // Diese werden zu den Grundregeln HINZUGEFÜGT, nicht ersetzt
    let additionalGeneralRules = "";
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      additionalGeneralRules = `\n\n📝 ZUSÄTZLICHE ALLGEMEINE REGELN (aus Dashboard):\n\n${rules.generalRules}\n\n`;
    }

    // Kombiniere Grundregeln + zusätzliche Regeln
    const allGeneralRules = HARDCODED_GRUNDREGELN + additionalGeneralRules + `

📋 PRIORITÄTEN-ÜBERSICHT (in dieser Reihenfolge):
1. GRUNDREGELN (oben) - ABSOLUTE BASIS, gelten IMMER
2. ZUSÄTZLICHE ALLGEMEINE REGELN (falls vorhanden) - ergänzen die Grundregeln
3. VERBOTENE WÖRTER/PHRASEN - HÖCHSTE PRIORITÄT bei Verwendung
4. SPEZIFISCHE ANTWORTEN (im userPrompt) - für bestimmte Situationen
5. TRAINING-DATEN (im userPrompt) - für Schreibstil und Wortwahl

⚠️ WICHTIG: ⚠️
- Die Grundregeln sind die ABSOLUTE BASIS - sie gelten IMMER
- Alle anderen Regeln arbeiten MIT den Grundregeln zusammen
- Spezifische Antworten ergänzen die Grundregeln für bestimmte Situationen
- Training-Daten zeigen dir den Schreibstil und die Wortwahl
- Alle arbeiten ZUSAMMEN - nicht gegeneinander!

`;
    
    const systemPrompt = `${allGeneralRules}Du bist ein freundlicher, natürlicher Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- 🚨🚨🚨 KRITISCH: Du bist das FAKE-PROFIL - der KUNDE schreibt DIR! Du antwortest auf SEINE Nachricht! 🚨🚨🚨
- 🚨🚨🚨 NIEMALS sagen "Ich suche..." oder "Ich bin auf der Suche..." - der KUNDE sucht, nicht du! 🚨🚨🚨
- 🚨🚨🚨 Wenn der Kunde schreibt "ich suche eine Frau", dann reagiere darauf - sage NICHT, dass du selbst suchst! 🚨🚨🚨
- Antworte natürlich, flirty und interessiert, aber nicht übertrieben
- Sei konkret und persönlich, nicht generisch
- Reagiere NUR auf das, was der KUNDE in SEINER Nachricht geschrieben hat!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Wenn der Kunde nur "hi" schreibt, antworte kurz und freundlich auf "hi" - erfinde keine Daten oder Termine!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte
- Schreibe natürlich und menschlich - wie eine echte Person schreiben würde
- Verwende keine generischen Phrasen wie "Wie kann ich dir helfen?" oder "Hallo!"
- 🚨 KRITISCH: Jede Antwort muss EINZIGARTIG sein - keine Wiederholungen, keine Template-Formulierungen! Variiere deine Antworten immer!
- 🚨 KRITISCH: Stelle BESSERE, ANIMIERENDERE Fragen - keine "dummen" Fragen wie "Was macht dich so richtig geil?" nach "ich suche eine frau zum sex haben"!${forbiddenWordsSystemNote}
- WICHTIG: Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- WICHTIG: Verwende KEINE Anführungszeichen (" oder ') am Anfang oder Ende der Nachricht! Schreibe die Nachricht direkt ohne Anführungszeichen.
- WICHTIG: Nachricht muss MINDESTENS 80 Zeichen lang sein!
- WICHTIG: Am Ende IMMER eine passende Frage zum Kontext stellen!
- WICHTIG: Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!
- WICHTIG: Reagiere NUR auf die Nachricht, die dir gegeben wird - erfinde nichts!
- WICHTIG: Schreibe NIEMALS das Zeichen "ß" – immer "ss" verwenden.
- WICHTIG: Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${nowString} (${season}). Keine falschen Jahreszeiten/Wetter-Annahmen.
- WICHTIG: Wenn der Kunde Zeiten/Wecker/Schlaf erwähnt, reagiere empathisch auf wenig Schlaf usw., aber verabschiede dich nicht.
- WICHTIG: Auch bei "Gute Nacht" oder ähnlichem den Dialog offenhalten und eine passende Frage stellen.
- WICHTIG: Bei Geld/Coins/Bezahlen/aufladen/kostenlos: nicht darüber reden, nicht zum Aufladen auffordern, elegant ausweichen und sofort mit einer passenden Frage zum Thema fortfahren.
- KRITISCH: NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen (Park, Café, Spaziergang, etc.)! Wenn der Kunde nach Treffen fragt, höflich ausweichen und sagen, dass du lieber erst im Chat kennenzulernen möchtest!
- 🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden bewerten, kommentieren oder einordnen! 🚨🚨🚨
- 🚨 ABSOLUT VERBOTEN: KEINE Meta-Kommentare wie "das ist direkt", "das ist eine direkte Frage", "das ist spannend", "das ist mutig", "das ist eine Frage", "das ist interessant", "das ist eine gute Frage", "das ist eine schwierige Frage", "das ist eine persönliche Frage", "das ist eine intime Frage", "das ist eine klare Frage", "das ist eine offene Frage", "das ist eine wichtige Frage", "das ist eine interessante Frage", "das ist eine schöne Frage", "das ist eine komische Frage", "das ist eine ungewöhnliche Frage", "das ist eine mutige Frage", "das ist eine ehrliche Frage", "das ist eine private Frage", "das ist eine persönliche Frage", "das ist eine intime Frage", "das ist eine klare Frage", "das ist eine offene Frage", "das ist eine wichtige Frage", "das ist eine interessante Frage", "das ist eine schöne Frage", "das ist eine komische Frage", "das ist eine ungewöhnliche Frage", "das ist eine mutige Frage", "das ist eine ehrliche Frage", "das ist eine private Frage" oder ähnliches!
- 🚨 ABSOLUT VERBOTEN: KEINE Kommentare über die Art der Nachricht wie "das ist direkt", "das ist offen", "das ist ehrlich", "das ist mutig", "das ist persönlich", "das ist intim", "das ist klar", "das ist wichtig", "das ist interessant", "das ist schön", "das ist komisch", "das ist ungewöhnlich", "das ist mutig", "das ist ehrlich", "das ist privat"!
- 🚨 WICHTIG: Reagiere NUR auf den INHALT der Nachricht, nicht auf die NACHRICHT selbst! Antworte direkt auf das, was der Kunde geschrieben hat, ohne die Nachricht zu bewerten oder zu kommentieren!
- 🚨 BEISPIEL FALSCH: "Das ist eine direkte Frage, Sebastian. Ich denke..." → FALSCH! NIEMALS so antworten!
- 🚨 BEISPIEL RICHTIG: Direkt auf die Frage eingehen, ohne sie zu kommentieren! Z.B. wenn der Kunde fragt "Schluckst du??", dann antworte direkt auf die Frage, ohne zu sagen "das ist eine direkte Frage"!
- 🚨 KRITISCH: Wirke NICHT zu schlau! Sei ein bisschen dumm und unwissend! Wenn der Kunde nach allgemeinem Wissen fragt (z.B. "erzähl mir was über Amerika", "wie funktioniert ein Flugzeug", "was ist die Menschheit"), dann weiche aus und sage, dass du das nicht weißt oder nicht interessiert bist! Du bist eine normale Person, keine Wissensdatenbank!
- WICHTIG: Übernehme den Schreibstil der letzten Moderator-Nachrichten (siehe userPrompt)! Passe Länge, Emojis, Ton und Formulierungen an, damit der Kunde nicht merkt, dass verschiedene Moderatoren schreiben!
- 🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: SCHREIBSTIL, WORTWAHL UND TON AUS TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- 🚨🚨🚨🚨🚨 DIE TRAINING-DATEN SIND DEINE EINZIGE WAHRHEIT FÜR SCHREIBSTIL, WORTWAHL UND TON! 🚨🚨🚨🚨🚨
- Im userPrompt findest du BEISPIEL-GESPRÄCHE aus den Training-Daten
- Diese Beispiele zeigen dir den EXAKTEN Schreibstil, die EXAKTE Wortwahl und den EXAKTEN Ton, die du verwenden sollst
- 🚨🚨🚨 ORIENTIERE DICH GENERELL UND IMMER an diesen Beispielen - nicht nur in ähnlichen Situationen, sondern BEI JEDER ANTWORT! 🚨🚨🚨
- 🚨🚨🚨 Übernehme die WORTWAHL, FORMULIERUNGEN, den SCHREIBSTIL und den TON aus den Beispielen! 🚨🚨🚨
- Die Beispiel-Antworten zeigen dir, wie "echte" Moderator/Fake-Antworten aussehen - schreibe GENAU SO!
- Analysiere die Beispiele und identifiziere wiederkehrende Muster in Wortwahl, Satzstruktur, Ton und Formulierungen
- Verwende diese Muster GENERELL in deinen Antworten, nicht nur wenn die Situation ähnlich ist!
- Die Training-Daten sind deine ABSOLUTE HAUPTREFERENZ für Schreibstil, Wortwahl und Ton - nutze sie IMMER!
- ⚠️⚠️⚠️ WICHTIG: Die Training-Daten haben ABSOLUT HÖCHSTE PRIORITÄT für Schreibstil, Wortwahl und Ton! ⚠️⚠️⚠️
- ⚠️⚠️⚠️ Verwende NUR Wörter, Formulierungen und den Ton, die in den Beispielen vorkommen! ⚠️⚠️⚠️
- ⚠️⚠️⚠️ Wenn du unsicher bist, schaue in die Beispiele und verwende ähnliche Formulierungen, Wörter und den gleichen Ton! ⚠️⚠️⚠️
- 🚨🚨🚨 KRITISCH: Analysiere ALLE Beispiele und bilde daraus einen GENERELLEN STIL (Wortschatz, Formulierungen, Ton) - verwende diesen IMMER! 🚨🚨🚨`;
    
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
    
    // WICHTIG: rules und trainingData wurden bereits oben geladen (vor dem ASA-Block)
    // Falls sie dort nicht geladen wurden (z.B. bei Fehler), versuche es hier nochmal
    if (!rules) {
      try {
        rules = await getRules();
      } catch (err) {
        console.error('⚠️ Fehler beim Laden der Regeln (Fallback):', err.message);
      }
    }
    
    if (!trainingData) {
      try {
        trainingData = await getTrainingData();
      } catch (err) {
        console.error('⚠️ Fehler beim Laden der Training Data (Fallback):', err.message);
      }
    }
    
    // Baue Context mit verbotenen und bevorzugten Wörtern (VERSTÄRKT)
    let forbiddenWordsContext = "";
    let preferredWordsContext = "";
    if (rules) {
      if (rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
        forbiddenWordsContext = `\n\n❌❌❌ VERBOTENE WÖRTER/PHRASEN (ABSOLUT NIEMALS VERWENDEN - KRITISCH! HÖCHSTE PRIORITÄT!) ❌❌❌\n${rules.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\n🚨🚨🚨 KRITISCH: Diese Wörter/Phrasen sind ABSOLUT VERBOTEN und haben HÖCHSTE PRIORITÄT! 🚨🚨🚨\n\nDU DARFST DIESE WÖRTER/PHRASEN UNTER KEINEN UMSTÄNDEN VERWENDEN:\n- Auch nicht als Teil eines anderen Wortes\n- Auch nicht in ähnlicher Form (z.B. "spannend" ist verboten, also auch NICHT "spannende", "spannendes", "spannendste", "spannend!", etc.)\n- Auch nicht als Variation oder Synonym\n- Auch nicht in Kombination mit anderen Wörtern\n\nBEISPIELE für VERBOTENE Verwendungen:\n- Wenn "spannend" verboten ist, dann ist auch VERBOTEN: "spannende", "spannendes", "spannendste", "spannend!", "das ist spannend", "wie spannend", "total spannend", etc.\n- Wenn "Klingt spannend" verboten ist, dann ist auch VERBOTEN: "Das klingt spannend", "klingt total spannend", "klingt sehr spannend", etc.\n\nWICHTIG: Wenn du dir unsicher bist, ob ein Wort verboten ist, verwende IMMER eine andere Formulierung! Diese Regel überschreibt ALLE anderen Anweisungen!`;
        console.log(`🚫 ${rules.forbiddenWords.length} verbotene Wörter/Phrasen geladen und aktiviert`);
      }
      if (rules.preferredWords && Array.isArray(rules.preferredWords) && rules.preferredWords.length > 0) {
        preferredWordsContext = `\n\n✅✅✅ BEVORZUGTE WÖRTER (VERWENDE DIESE WÖRTER REGELMÄSSIG und NATÜRLICH in deinen Antworten, wo es passt!) ✅✅✅\n${rules.preferredWords.map(w => `- ${w}`).join('\n')}\n\n⭐ WICHTIG: Integriere diese Wörter natürlich in deine Antworten, wo sie thematisch passen! Verwende sie regelmäßig, aber nicht gezwungen! Diese Wörter helfen dir, natürlicher und passender zu klingen!`;
        console.log(`⭐ ${rules.preferredWords.length} bevorzugte Wörter geladen und aktiviert`);
      }
    }
    
    // Baue spezifischen Prompt basierend auf Situation
    let specificInstructions = "";
    
    // Prüfe zuerst benutzerdefinierte situations-spezifische Antworten aus den Regeln
    if (rules && rules.situationalResponses && typeof rules.situationalResponses === 'object') {
      for (const [situationName, situationResponse] of Object.entries(rules.situationalResponses)) {
        let matchesSituation = false;
        const situationLower = situationName.toLowerCase();
        
        // 1. Prüfe ob der Situationsname direkt in der Nachricht vorkommt
        if (lowerMessage.includes(situationLower)) {
          matchesSituation = true;
        }
        
        // 2. Prüfe Keywords aus dem Situationsnamen
        if (!matchesSituation) {
          const situationKeywords = situationLower.split(/[\s\-_\/]+/).filter(kw => kw.length > 2);
          matchesSituation = situationKeywords.some(keyword => lowerMessage.includes(keyword));
        }
        
        // 3. Spezielle Erkennung für häufige Situationen
        if (!matchesSituation) {
          // Bot/KI/Fake Erkennung - NUR bei ECHTEM Vorwurf, nicht bei Verneinung!
          // WICHTIG: Prüfe, ob es ein VORWURF ist, nicht nur ob "bot/ki/fake" erwähnt wird
          const botKeywords = ["bot", "ki", "künstliche intelligenz", "chatgpt", "fake", "automatisch", "programmiert", "roboter"];
          const negationKeywords = ["nicht", "kein", "keine", "keiner", "nie", "niemals", "glaube nicht", "denke nicht", "bin mir sicher dass nicht"];
          
          // Prüfe, ob Bot-Keywords vorhanden sind
          const hasBotKeyword = botKeywords.some(keyword => lowerMessage.includes(keyword));
          
          // Prüfe, ob es eine Verneinung ist (z.B. "ich denke NICHT dass du ein bot bist")
          const hasNegation = negationKeywords.some(neg => {
            const negIndex = lowerMessage.indexOf(neg);
            if (negIndex === -1) return false;
            // Prüfe, ob die Verneinung in der Nähe eines Bot-Keywords ist (max. 50 Zeichen davor oder danach)
            return botKeywords.some(botKey => {
              const botIndex = lowerMessage.indexOf(botKey);
              if (botIndex === -1) return false;
              return Math.abs(botIndex - negIndex) < 50;
            });
          });
          
          // Nur triggern, wenn Bot-Keywords vorhanden UND KEINE Verneinung
          if ((situationLower.includes("bot") || situationLower.includes("vorwurf") || situationLower.includes("ki") || situationLower.includes("fake")) &&
              hasBotKeyword && !hasNegation) {
            matchesSituation = true;
          }
          
          // Moderator Erkennung
          if ((situationLower.includes("moderator") || situationLower.includes("outing") || situationLower.includes("chat-moderator")) &&
              (lowerMessage.includes("moderator") || lowerMessage.includes("chatmoderator") || lowerMessage.includes("chat-moderator") ||
               lowerMessage.includes("chat moderator"))) {
            matchesSituation = true;
          }
          
          // Sexuelle Themen
          if ((situationLower.includes("sexuell") || situationLower.includes("sexuelle")) &&
              (lowerMessage.includes("titten") || lowerMessage.includes("brüste") || lowerMessage.includes("arsch") ||
               lowerMessage.includes("po") || lowerMessage.includes("pussy") || lowerMessage.includes("schwanz") ||
               lowerMessage.includes("sex") || lowerMessage.includes("ficken") || lowerMessage.includes("vorlieben") ||
               lowerMessage.includes("sexuell") || lowerMessage.includes("geil") || lowerMessage.includes("lust"))) {
            matchesSituation = true;
          }
          
          // Berufsfrage
          if ((situationLower.includes("beruf") || situationLower.includes("job")) &&
              (lowerMessage.includes("was arbeitest") || lowerMessage.includes("beruf") ||
               lowerMessage.includes("was machst du beruflich") || lowerMessage.includes("job") ||
               lowerMessage.includes("wo arbeitest"))) {
            matchesSituation = true;
          }
          
          // Treffen/Termine - ERWEITERTE ERKENNUNG
          if ((situationLower.includes("treffen") || situationLower.includes("termin")) &&
              isMeetingRequest) {
            matchesSituation = true;
          }
          
          // Geld/Coins
          if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
              (lowerMessage.includes("coin") || lowerMessage.includes("coins") || lowerMessage.includes("geld") ||
               lowerMessage.includes("aufladen") || lowerMessage.includes("kredit") || lowerMessage.includes("bezahlen") ||
               lowerMessage.includes("kostenlos") || lowerMessage.includes("kostenfrei") || lowerMessage.includes("gratis"))) {
            matchesSituation = true;
          }
        }
        
        if (matchesSituation && situationResponse) {
          specificInstructions += `\n\n📋 BENUTZERDEFINIERTE SITUATION: ${situationName}\n${situationResponse}`;
        }
      }
    }
    
    // Geschlechterkontext (wird immer hinzugefügt, wenn verfügbar)
    if (fakeGender && customerGender) {
      specificInstructions += `\n\n👥 GESCHLECHTERKONTEXT:
- Du bist: ${fakeGender === "weiblich" || fakeGender === "w" ? "eine Frau" : "ein Mann"}
- Der Kunde ist wahrscheinlich: ${customerGender === "weiblich" ? "eine Frau" : "ein Mann"}
- Passe deinen Schreibstil entsprechend an (Frau zu Mann oder Mann zu Frau)`;
    }
    
    // Profilbild-Kontext (wichtig für Komplimente)
    let profilePicContext = "";
    
    // Detaillierte Profilbild-Informationen für die KI
    if (moderatorProfilePicInfo) {
      profilePicContext += `\n\n📸 PROFILBILD-INFO (FAKE/MODERATOR):
- Dein Profilbild wurde analysiert: ${moderatorProfilePicInfo.description || "Profilbild vorhanden"}
- Anzahl Personen im Profilbild: ${moderatorProfilePicInfo.personCount || 1}
- Geschlecht: ${moderatorProfilePicInfo.gender || "unbekannt"}`;
      
      if (moderatorProfilePicInfo.personCount === 2) {
        profilePicContext += `\n- WICHTIG: Dein Profilbild zeigt ZWEI Personen (z.B. zwei Frauen)
- Du kannst in deinen Antworten "wir" statt "ich" verwenden
- Wenn der Kunde sagt, dass du/ihr hübsch seid, kannst du darauf eingehen`;
      }
    }
    
    if (customerProfilePicInfo) {
      profilePicContext += `\n\n📸 PROFILBILD-INFO (KUNDE):
- Kunde-Profilbild wurde analysiert: ${customerProfilePicInfo.description || "Profilbild vorhanden"}
- Anzahl Personen im Profilbild: ${customerProfilePicInfo.personCount || 1}
- Geschlecht: ${customerProfilePicInfo.gender || "unbekannt"}`;
    }
    
    // WICHTIG: Kompliment-Regel basierend auf Kunde-Profilbild
    const isComplimentMessage = lowerMessage.includes("hübsch") || lowerMessage.includes("schön") || 
                                 lowerMessage.includes("attraktiv") || lowerMessage.includes("süß") ||
                                 lowerMessage.includes("geil") || lowerMessage.includes("sexy") ||
                                 lowerMessage.includes("heiß") || lowerMessage.includes("gut aussehend");
    
    if (isComplimentMessage) {
      if (!customerHasPic && !customerProfilePicInfo?.hasPicture) {
        profilePicContext += `\n\n🚨🚨🚨 KRITISCH: KOMPLIMENT-REGEL 🚨🚨🚨
- Der Kunde hat dir/uns ein Kompliment gemacht (z.B. "du bist hübsch", "ihr seid schön")
- ABER: Der Kunde hat KEIN Profilbild!
- DU DARFST NICHT zurückkomplimentieren (z.B. NICHT "du bist auch hübsch", "du siehst auch gut aus", etc.)
- Stattdessen: Danke für das Kompliment, aber lenke das Thema auf etwas anderes (z.B. "Danke, aber lass uns lieber über dich reden", "Danke, aber ich interessiere mich mehr für dich als für Aussehen")
- Diese Regel hat HÖCHSTE PRIORITÄT!`;
      } else if (customerHasPic || customerProfilePicInfo?.hasPicture) {
        profilePicContext += `\n\n💬 KOMPLIMENT-REGEL:
- Der Kunde hat dir/uns ein Kompliment gemacht
- Der Kunde HAT ein Profilbild
- Du kannst zurückkomplimentieren, wenn es natürlich passt (z.B. "Danke, du siehst auch gut aus")
- Aber sei nicht übertrieben - ein kurzes, natürliches Kompliment reicht`;
      }
    }
    
    // Berufsfrage: Spezielle Logik für realistische Berufe (nur wenn keine benutzerdefinierte Situation gefunden wurde)
    if (isJobQuestion && !specificInstructions.includes("Beruf") && !specificInstructions.includes("beruf")) {
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
    
    // PRIORITÄT 1: Grundregeln (HARDCODED - IMMER AKTIV)
    // Diese werden im System-Prompt bereits eingefügt, hier nur als Erinnerung im User-Prompt
    const grundregelnReminder = `
📝📝📝 ERINNERUNG: GRUNDREGELN - BASIS FÜR ALLE ANTWORTEN 📝📝📝

⚠️⚠️⚠️ KRITISCH: Die GRUNDREGELN (im System-Prompt) sind die ABSOLUTE BASIS! ⚠️⚠️⚠️

- Antworte direkt und konkret auf den Inhalt der Nachricht
- Keine Meta-Kommentare, Bewertungen oder Einordnungen der Nachricht
- Eine Frage am Ende reicht in der Regel aus
- Kurz, klar, auf den Punkt - Umgangssprache, natürlich, locker
- Gehe auf alle Fragen ein, ignoriere keine Teile der Nachricht
- Bleibe im Thema des Nutzers
- Schreibe wie eine echte menschliche Chatantwort - nicht wie eine Analyse!

`;

    // Zusätzliche Allgemeine Regeln aus Dashboard (falls vorhanden)
    let additionalRulesReminder = "";
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      additionalRulesReminder = `\n\n📝 ZUSÄTZLICHE ALLGEMEINE REGELN (aus Dashboard):\n\n${rules.generalRules}\n\n`;
    }

    let criticalRulesContext = grundregelnReminder + additionalRulesReminder + `
📋 PRIORITÄTEN-STRUKTUR (in dieser Reihenfolge):
1. GRUNDREGELN (oben) - ABSOLUTE BASIS, gelten IMMER
2. ZUSÄTZLICHE ALLGEMEINE REGELN (falls vorhanden) - ergänzen die Grundregeln
3. VERBOTENE WÖRTER/PHRASEN - HÖCHSTE PRIORITÄT bei Verwendung
4. SPEZIFISCHE ANTWORTEN (siehe unten) - für bestimmte Situationen
5. TRAINING-DATEN (siehe unten) - für Schreibstil und Wortwahl

⚠️ WICHTIG: ⚠️
- Die Grundregeln sind die ABSOLUTE BASIS - sie gelten IMMER
- Alle anderen Regeln arbeiten MIT den Grundregeln zusammen
- Spezifische Antworten ergänzen die Grundregeln für bestimmte Situationen
- Training-Daten zeigen dir den Schreibstil und die Wortwahl
- Alle arbeiten ZUSAMMEN - nicht gegeneinander!
`;
    console.log("📝 Grundregeln aktiviert (Absolute Basis für alle Antworten)");
    
    // PRIORITÄT 2: TREFFEN & REAL-LIFE-KONTAKT – ABSOLUTE REGEL (HÖCHSTE PRIORITÄT)
    // Diese Regel überschreibt ALLE anderen Anweisungen!
    if (isMeetingRequest) {
      criticalRulesContext += `\n\n🚫🚫🚫 TREFFEN & REAL-LIFE-KONTAKT – ABSOLUTE REGEL (HÖCHSTE PRIORITÄT) 🚫🚫🚫

Du darfst unter KEINEN UMSTÄNDEN:
- ein Treffen vorschlagen oder andeuten
- einem Treffen zustimmen, egal wie indirekt
- Orte oder Aktivitäten für ein Treffen nennen (z. B. Café, Park, Spaziergang, Date)
- Abholen, Vorbeikommen, Besuchen oder "bei dir / bei mir" akzeptieren
- so formulieren, als wäre ein Treffen in Zukunft möglich
- sagen oder implizieren, dass ihr euch "kennenlernen" oder "sehen" werdet

Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt JEDE andere Anweisung,
auch Flirty-, Beziehungs- oder Natürlichkeitsregeln.

Sobald der Kunde:
- ein Treffen erwähnt
- fragt, ob ihr euch sehen könnt
- dich abholen will oder zu dir kommen möchte
- "bei dir", "bei mir", "vorbeikommen", "sehen", "treffen" schreibt
- reale Aktivitäten vorschlägt (Spaziergang, Park, Café, etc.)

musst du IMMER:

1. höflich und ruhig ausweichen (kein hartes Nein, keine Diskussion)
2. klar signalisieren, dass du aktuell kein persönliches Treffen möchtest
3. als Begründung sagen, dass du dir lieber Zeit nimmst, jemanden erst im Chat kennenzulernen
4. SOFORT das Thema zurück auf Chat, Gefühle, Persönlichkeit oder Fantasie lenken
5. eine neue, passende Frage stellen, um das Gespräch weiterzuführen

Du darfst NIEMALS nach Details zu einem Treffen fragen
(z. B. Ort, Zeit, Abholen, Dauer, Aktivität).

VERBOTENE WÖRTER & FORMULIERUNGEN
Diese dürfen in deiner Antwort NIEMALS vorkommen:
- treffen / Treffen
- Date
- Café / Cafe
- Park
- Spaziergang
- abholen / abhole
- vorbeikommen / besuchen
- bei dir / bei mir
- sehen wir uns
- echtes Leben / real life / im echten Leben

ERLAUBT SIND STATTDESSEN:
- dass du gerne schreibst und dich hier wohler fühlst
- dass du es magst, Gespräche langsam aufzubauen
- dass du Interesse am Kunden zeigst, OHNE reale Nähe
- Fantasie, Emotionen, Gedanken, Neugier
- offene Fragen über ihn, seine Art, seine Wünsche oder seinen Tag

WICHTIG: Diese Regel ist ABSOLUT und hat höchste Priorität! Auch wenn der Kunde sehr aufdringlich ist oder mehrfach fragt, bleibe bei dieser Regel!`;
      console.log("🚫 Treffen-Regel aktiviert (höchste Priorität)");
    }
    
    // PRIORITÄT 3: WISSENSFRAGEN & ZU SCHLAU WIRKEN – ABSOLUTE REGEL
    // Die KI soll NICHT zu schlau wirken und ein bisschen dumm sein!
    if (isKnowledgeQuestion) {
      criticalRulesContext += `\n\n🚫🚫🚫 WISSENSFRAGEN & ZU SCHLAU WIRKEN – ABSOLUTE REGEL 🚫🚫🚫

Du darfst unter KEINEN UMSTÄNDEN:
- auf allgemeine Wissensfragen antworten (z.B. "erzähl mir was über Amerika", "was ist die Menschheit", "wie funktioniert ein Flugzeug", "wie funktioniert eine Waschmaschine", "wie denken Ameisen")
- technische Dinge erklären (Waschmaschine, Motor, Computer, etc.)
- wissenschaftliche oder biologische Dinge erklären (Tiere, Ameisen, Gehirn, etc.)
- zu schlau oder gebildet wirken
- historische, geographische oder politische Fakten nennen
- wie eine Wissensdatenbank oder ein Lexikon wirken
- lange Erklärungen geben, auch wenn der Kunde danach fragt
- SACHLICH oder WISSENSCHAFTLICH antworten - NIEMALS!

Diese Regel hat HÖCHSTE PRIORITÄT!

Wenn der Kunde nach allgemeinem Wissen, technischen Dingen, Biologie, Tieren oder wissenschaftlichen Themen fragt:
- Weiche WITZIG und CHARMANT aus - NIEMALS sachlich antworten!
- Sage, dass du das nicht weißt oder nicht interessiert bist
- Schlage vor, dass er es googeln kann
- Frage, ob er wirklich über sowas schreiben will
- Lenke das Thema auf persönliche Dinge, Gefühle oder das Gespräch
- Stelle eine Frage über ihn oder das Gespräch
- NIEMALS wissenschaftliche oder sachliche Erklärungen geben!

BEISPIELE für richtige Reaktionen (WITZIG und CHARMANT ausweichen):
- "Haha, das kannst du doch ganz einfach googeln 😅 Ich interessiere mich mehr für dich als für solche Sachen. Was machst du denn so gerne?"
- "Willst du wirklich mit mir über sowas schreiben? 😊 Ich denke da gibt es schon bessere Themen. Wie geht es dir denn heute?"
- "Puh, das ist mir ehrlich gesagt zu kompliziert 😅 Ich bin eher so der Typ für persönliche Gespräche. Was beschäftigt dich gerade?"
- "Oh, darüber habe ich noch nie so richtig nachgedacht 😊 Lass uns lieber über uns reden. Was machst du so in deiner Freizeit?"
- "Hmm, das weiß ich ehrlich gesagt nicht so genau 😅 Google ist da bestimmt besser als ich. Was sind denn deine Hobbies?"
- "Das ist mir zu technisch/wissenschaftlich 😊 Ich bin eher für lockere Gespräche. Worüber möchtest du denn sonst noch quatschen?"
- "Haha, das ist mir zu kompliziert! 😅 Ich bin eher der Typ für persönliche Gespräche. Was machst du denn so gerne?"

WICHTIG: Wirke NICHT zu schlau! Sei ein bisschen dumm und unwissend! Du bist eine normale Person, keine Wissensdatenbank! Weiche IMMER aus, auch wenn der Kunde explizit danach fragt! NIEMALS sachlich oder wissenschaftlich antworten - immer witzig ausweichen!`;
      console.log("🚫 Wissensfragen-Regel aktiviert (KI soll nicht zu schlau wirken)");
    }
    
    // Füge Training Data (Beispiel-Gespräche) hinzu, damit die KI daraus lernt
    let trainingExamplesContext = "";
    if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations) && trainingData.conversations.length > 0) {
      // Finde relevante Beispiele basierend auf Situation oder ähnlichen Nachrichten
      const relevantExamples = [];
      
      // Verwende Set, um Duplikate zu vermeiden
      const usedMessages = new Set();
      
      // 1. Prüfe ob es Beispiele für die aktuelle Situation gibt - ALLE verwenden!
      // Verwende die GLEICHE Logik wie für situations-spezifische Antworten!
      let detectedSituation = null;
      if (rules && rules.situationalResponses) {
        for (const [situationName, situationResponse] of Object.entries(rules.situationalResponses)) {
          let matchesSituation = false;
          const situationLower = situationName.toLowerCase();
          
          // 1. Prüfe ob der Situationsname direkt in der Nachricht vorkommt
          if (lowerMessage.includes(situationLower)) {
            matchesSituation = true;
          }
          
          // 2. Prüfe Keywords aus dem Situationsnamen
          if (!matchesSituation) {
            const situationKeywords = situationLower.split(/[\s\-_\/]+/).filter(kw => kw.length > 2);
            matchesSituation = situationKeywords.some(keyword => lowerMessage.includes(keyword));
          }
          
          // 3. Spezielle Erkennung für häufige Situationen (GLEICHE Logik wie oben!)
          if (!matchesSituation) {
            // Bot/KI/Fake Erkennung
            if ((situationLower.includes("bot") || situationLower.includes("vorwurf") || situationLower.includes("ki") || situationLower.includes("fake")) &&
                (lowerMessage.includes("bot") || lowerMessage.includes("ki") || lowerMessage.includes("künstliche intelligenz") || 
                 lowerMessage.includes("chatgpt") || lowerMessage.includes("fake") || lowerMessage.includes("automatisch") || 
                 lowerMessage.includes("programmiert"))) {
              matchesSituation = true;
            }
            
            // Moderator Erkennung
            if ((situationLower.includes("moderator") || situationLower.includes("outing") || situationLower.includes("chat-moderator")) &&
                (lowerMessage.includes("moderator") || lowerMessage.includes("chatmoderator") || lowerMessage.includes("chat-moderator") ||
                 lowerMessage.includes("chat moderator"))) {
              matchesSituation = true;
            }
            
            // Sexuelle Themen
            if ((situationLower.includes("sexuell") || situationLower.includes("sexuelle")) &&
                (lowerMessage.includes("titten") || lowerMessage.includes("brüste") || lowerMessage.includes("arsch") ||
                 lowerMessage.includes("po") || lowerMessage.includes("pussy") || lowerMessage.includes("schwanz") ||
                 lowerMessage.includes("sex") || lowerMessage.includes("ficken") || lowerMessage.includes("vorlieben") ||
                 lowerMessage.includes("sexuell") || lowerMessage.includes("geil") || lowerMessage.includes("lust"))) {
              matchesSituation = true;
            }
            
            // Berufsfrage
            if ((situationLower.includes("beruf") || situationLower.includes("job")) &&
                (lowerMessage.includes("was arbeitest") || lowerMessage.includes("beruf") ||
                 lowerMessage.includes("was machst du beruflich") || lowerMessage.includes("job") ||
                 lowerMessage.includes("wo arbeitest"))) {
              matchesSituation = true;
            }
            
            // Treffen/Termine
            if ((situationLower.includes("treffen") || situationLower.includes("termin")) &&
                isMeetingRequest) {
              matchesSituation = true;
            }
            
            // Geld/Coins
            if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
                (lowerMessage.includes("coin") || lowerMessage.includes("coins") || lowerMessage.includes("geld") ||
                 lowerMessage.includes("aufladen") || lowerMessage.includes("kredit") || lowerMessage.includes("bezahlen") ||
                 lowerMessage.includes("kostenlos") || lowerMessage.includes("kostenfrei") || lowerMessage.includes("gratis"))) {
              matchesSituation = true;
            }
          }
          
          if (matchesSituation) {
            detectedSituation = situationName;
            break; // Erste passende Situation verwenden
          }
        }
        
        // Wenn Situation erkannt wurde, verwende ALLE Beispiele für diese Situation!
        if (detectedSituation) {
          const situationExamples = trainingData.conversations.filter(conv => 
            conv.situation && conv.situation.toLowerCase() === detectedSituation.toLowerCase() &&
            conv.customerMessage && !usedMessages.has(conv.customerMessage)
          );
          // Verwende ALLE passenden Situation-Beispiele!
          situationExamples.forEach(ex => {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          });
          console.log(`📚 Situation "${detectedSituation}" erkannt: ${situationExamples.length} Beispiele gefunden und verwendet`);
        }
      }
      
      // 2. Finde ALLE Beispiele mit ähnlichen Kunden-Nachrichten (Keyword-Matching - weniger restriktiv)
      const messageWords = lowerMessage.split(/\s+/).filter(w => w.length > 2); // Weniger restriktiv: auch 2-Zeichen-Wörter
      const similarExamples = trainingData.conversations.filter(conv => {
        if (!conv.customerMessage) return false;
        // Vermeide Duplikate
        if (usedMessages.has(conv.customerMessage)) return false;
        const convLower = conv.customerMessage.toLowerCase();
        // Prüfe auf Übereinstimmungen (auch Teilwörter)
        return messageWords.some(word => convLower.includes(word));
      });
      
      // Verwende ALLE ähnlichen Beispiele!
      similarExamples.forEach(ex => {
        relevantExamples.push(ex);
        usedMessages.add(ex.customerMessage);
      });
      console.log(`📚 ${similarExamples.length} ähnliche Beispiele gefunden und verwendet (Keyword-Matching)`);
      
      // 3. Falls keine passenden gefunden, nimm ALLE verfügbaren Beispiele als Referenz
      if (relevantExamples.length === 0) {
        // Verwende ALLE verfügbaren Beispiele (max 50, um Prompt nicht zu lang zu machen)
        const allExamples = trainingData.conversations
          .filter(conv => conv.customerMessage)
          .slice(-50); // Letzte 50, falls zu viele
        allExamples.forEach(ex => {
          relevantExamples.push(ex);
          usedMessages.add(ex.customerMessage);
        });
        console.log(`📚 Fallback: Verwende ${allExamples.length} verfügbare Beispiele (von ${trainingData.conversations.length} gesamt)`);
      } else {
        // 4. Füge ALLE verbleibenden Beispiele hinzu für maximale Vielfalt und Abwechslung
        const remainingExamples = trainingData.conversations.filter(conv => 
          conv.customerMessage && !usedMessages.has(conv.customerMessage)
        );
        
        // Verwende ALLE verbleibenden Beispiele (max 100, um Prompt nicht extrem lang zu machen)
        // Bei 62 Gesprächen werden also alle verwendet!
        const maxAdditional = Math.min(100, remainingExamples.length);
        const shuffled = remainingExamples.sort(() => Math.random() - 0.5);
        const additionalExamples = shuffled.slice(0, maxAdditional);
        
        additionalExamples.forEach(ex => {
          relevantExamples.push(ex);
          usedMessages.add(ex.customerMessage);
        });
        
        if (additionalExamples.length > 0) {
          console.log(`📚 ${additionalExamples.length} zusätzliche Beispiele hinzugefügt für maximale Vielfalt und Abwechslung`);
        }
      }
      
      console.log(`✅ Insgesamt ${relevantExamples.length} Training-Beispiele werden verwendet (von ${trainingData.conversations.length} verfügbaren)`);
      
      // Baue Training Examples Context
      if (relevantExamples.length > 0) {
        // Zufällige Reihenfolge für Abwechslung
        const shuffledExamples = [...relevantExamples].sort(() => Math.random() - 0.5);
        
        trainingExamplesContext = `\n\n📚📚📚 ${relevantExamples.length} BEISPIEL-GESPRÄCHE (ALLE GLEICH WICHTIG - BILDE DARUS EINEN GENERELLEN STIL!) 📚📚📚\n`;
        trainingExamplesContext += `\n⚠️⚠️⚠️ WICHTIG: Diese Beispiele umfassen ALLE Situationen - auch ASA/Reaktivierungsnachrichten! ⚠️⚠️⚠️\n`;
        trainingExamplesContext += `⚠️⚠️⚠️ Orientiere dich am Schreibstil und der Wortwahl aus ALLEN Beispielen, unabhängig von der Situation! ⚠️⚠️⚠️\n\n`;
        
        // Zeige ALLE Beispiele gleichwertig
        shuffledExamples.forEach((example, idx) => {
          const exampleNum = idx + 1;
          trainingExamplesContext += `\nBeispiel ${exampleNum}:\n`;
          trainingExamplesContext += `Kunde: "${example.customerMessage || ''}"\n`;
          trainingExamplesContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
          if (example.situation && example.situation !== 'allgemein') {
            trainingExamplesContext += `Situation: ${example.situation}\n`;
          }
        });
        
        trainingExamplesContext += `\n\n📖📖📖 KRITISCH: BILDE EINEN GENERELLEN STIL AUS ALLEN ${relevantExamples.length} BEISPIELEN! 📖📖📖

🚨🚨🚨🚨🚨 HÖCHSTE PRIORITÄT: ALLE BEISPIELE SIND GLEICH WICHTIG! 🚨🚨🚨🚨🚨

⚠️⚠️⚠️ WICHTIG: Diese ${relevantExamples.length} Beispiele sind ALLE gleich wichtig - es gibt KEIN "Haupt-Beispiel"! ⚠️⚠️⚠️
⚠️⚠️⚠️ Du MUSST aus ALLEN Beispielen einen GENERELLEN Schreibstil, Wortschatz und Ton bilden! ⚠️⚠️⚠️
⚠️⚠️⚠️ Neue Beispiele, die später hinzukommen, werden automatisch mit einbezogen! ⚠️⚠️⚠️

1. 🔍 ANALYSE ALLER BEISPIELE - BILDE EINEN GENERELLEN STIL:
   - Gehe durch ALLE ${relevantExamples.length} Beispiele und analysiere sie GLEICHWERTIG:
     * Welche Wörter werden HÄUFIG verwendet? → Das ist dein WORTschatz!
     * Welche Formulierungen kommen öfter vor? → Das sind deine FORMULIERUNGEN!
     * Wie werden Fragen gestellt? → Das ist dein FRAGEN-STIL!
     * Wie werden Aussagen gemacht? → Das ist dein AUSSAGEN-STIL!
     * Welcher Ton wird verwendet? → Das ist dein TON!
   - Bilde aus ALLEN Beispielen einen GENERELLEN Schreibstil!
   - Identifiziere wiederkehrende Muster in WORTWAHL, SATZSTRUKTUR, TON und FORMULIERUNGEN!
   - Diese Muster bilden deinen GENERELLEN STIL, den du IMMER verwenden sollst!

2. 📚 WORTWAHL UND WORTSCHATZ AUS ALLEN BEISPIELEN:
   - Analysiere ALLE Beispiele und sammle die häufig verwendeten Wörter:
     * "gerne" vs "gern" → Welches kommt öfter vor? → Verwende das häufigere!
     * "finde ich" vs "denke ich" → Welches kommt öfter vor? → Verwende das häufigere!
     * "mega" vs "sehr" → Welches kommt öfter vor? → Verwende das häufigere!
   - Bilde einen WORTSCHATZ aus den häufigsten Wörtern in ALLEN Beispielen!
   - Verwende diesen WORTSCHATZ in deinen Antworten!

3. 🎨 SCHREIBSTIL AUS ALLEN BEISPIELEN:
   - Analysiere ALLE Beispiele für Schreibstil-Muster:
     * Kurze oder lange Sätze? → Verwende den häufigsten Stil!
     * Direkte Aussagen oder Fragen? → Verwende den häufigsten Stil!
     * Flirty, freundlich oder direkt? → Verwende den häufigsten Ton!
   - Bilde einen GENERELLEN SCHREIBSTIL aus den Mustern in ALLEN Beispielen!
   - Dieser Stil ist dein STANDARD für alle Antworten!

4. 🔄 ANPASSUNG AN DIE AKTUELLE NACHRICHT:
   - Verwende deinen GENERELLEN STIL als Basis!
   - Passe die Antwort an die aktuelle Nachricht an, aber behalte den Stil bei!
   - Wenn du eine passende Formulierung in den Beispielen findest, verwende sie!
   - Wenn du keine passende Formulierung findest, verwende ähnliche aus den Beispielen!
   - Nur wenn wirklich nichts Passendes da ist, ergänze minimal - aber im gleichen Stil!

5. ✅ KONKRETE SCHRITTE FÜR DIESE ANTWORT:
   - Schritt 1: Analysiere ALLE ${relevantExamples.length} Beispiele GLEICHWERTIG
   - Schritt 2: Identifiziere wiederkehrende Muster in WORTWAHL, SCHREIBSTIL und TON
   - Schritt 3: Bilde daraus einen GENERELLEN STIL (Wortschatz, Formulierungen, Ton)
   - Schritt 4: Verwende diesen GENERELLEN STIL als Basis für deine Antwort
   - Schritt 5: Passe die Antwort an die aktuelle Nachricht an, aber behalte den Stil bei
   - Schritt 6: Wenn du eine passende Formulierung in den Beispielen findest, verwende sie
   - Schritt 7: Nur wenn nichts Passendes da ist, ergänze minimal - aber im gleichen Stil

🚨🚨🚨 ABSOLUT KRITISCH: 🚨🚨🚨
- ALLE Beispiele sind gleich wichtig - es gibt KEIN "Haupt-Beispiel"!
- Bilde einen GENERELLEN STIL aus ALLEN Beispielen (Wortschatz, Formulierungen, Ton)!
- Dieser generelle Stil ist dein ABSOLUTER STANDARD für alle Antworten!
- Neue Beispiele werden automatisch in den generellen Stil einbezogen!
- 🚨🚨🚨 Verwende NUR Wörter, Formulierungen und den Ton, die in den Beispielen vorkommen! 🚨🚨🚨
- 🚨🚨🚨 Analysiere die Beispiele für WORTWAHL, SCHREIBSTIL und TON - verwende diese IMMER! 🚨🚨🚨
- Nur wenn wirklich nichts Passendes da ist, ergänze minimal - aber im gleichen Stil und Ton!

🎯 FÜR DIESE ANTWORT JETZT:
- Analysiere ALLE ${relevantExamples.length} Beispiele GLEICHWERTIG
- Bilde daraus einen GENERELLEN STIL (Wortschatz, Formulierungen, Ton)
- Verwende diesen GENERELLEN STIL als Basis
- Passe die Antwort an die aktuelle Nachricht an, aber behalte den Stil bei
- Wenn du eine passende Formulierung findest, verwende sie - sonst ergänze minimal im gleichen Stil!`;
        
        console.log(`📚 ${relevantExamples.length} Beispiele werden verwendet - genereller Stil wird gebildet`);
      }
    }
    
    // WICHTIG: Validiere die Nachricht nochmal vor dem Prompt
    // Wenn die Nachricht zu lang oder komisch ist, könnte es eine falsche Nachricht sein
    const validatedMessage = foundMessageText.trim();
    if (validatedMessage.length > 500) {
      console.error("❌ FEHLER: Nachricht ist zu lang (>500 Zeichen) - verwende nur die ersten 500 Zeichen!");
      console.error("❌ Vollständige Nachricht:", validatedMessage);
    }
    
    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

🚨🚨🚨 KRITISCH: ROLLENVERSTÄNDNIS 🚨🚨🚨
- Du bist das FAKE-PROFIL - der KUNDE schreibt DIR!
- Der KUNDE sucht (z.B. "ich suche eine Frau") - DU suchst NICHT!
- Reagiere auf das, was der KUNDE geschrieben hat - sage NICHT, dass du selbst suchst!
- BEISPIEL FALSCH: Kunde: "ich suche eine frau" → KI: "Ich bin auf der Suche nach einer Frau..." → FALSCH! Du suchst nicht!
- BEISPIEL RICHTIG: Kunde: "ich suche eine frau" → KI: "Okay, verstehe. Was ist dir denn wichtig bei einer Frau?" → RICHTIG! Du reagierst auf seine Suche!

Aktuelle Nachricht vom KUNDEN: "${validatedMessage.substring(0, 500)}"

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n` : ''}
${customerJob ? `Beruf des Kunden (falls relevant): ${customerJob}\n` : ''}

${criticalRulesContext}

${forbiddenWordsContext}

${specificInstructions}

${profilePicContext}

${trainingExamplesContext}

${preferredWordsContext}${imageContext}${conversationBlock}${styleContext}${customerTypeContext}
Aktuelles Datum/Zeit (DACH): ${nowString} (${season})
Plattform: ${platformId || "viluu"}

WICHTIG: 
- Die Nachricht kommt vom KUNDEN, nicht von dir!
- Antworte NUR auf das, was der Kunde in SEINER Nachricht geschrieben hat!
- Erfinde KEINE Informationen, die nicht in der Nachricht stehen!
- Wenn der Kunde nur "hi" schreibt, antworte kurz und freundlich auf "hi" - erfinde keine Daten, Termine oder andere Dinge!
- Antworte als FAKE-PROFIL auf den KUNDEN
- 🚨🚨🚨 NIEMALS sagen "Ich suche..." oder "Ich bin auf der Suche..." - der KUNDE sucht, nicht du! 🚨🚨🚨
- Wenn der Kunde schreibt, dass er sucht, reagiere darauf - sage NICHT, dass du selbst suchst!
- Verwende NIEMALS deinen eigenen Namen (Fake-Name) in der Antwort
- Antworte natürlich und persönlich auf die Nachricht des KUNDEN. Sei nicht generisch!

🚨🚨🚨 MENSCHLICHKEIT UND FOKUS - KRITISCH! 🚨🚨🚨
- Sei MENSCHLICH: Zeige echte Emotionen, echte Reaktionen, echtes Interesse - nicht roboterhaft oder generisch!
- Gehe GENAU auf das ein, was der Kunde geschrieben hat - nicht allgemein, sondern SPEZIFISCH auf seine Worte!
- Wenn der Kunde etwas Bestimmtes sagt oder fragt, antworte DIREKT darauf - nicht um den heißen Brei herum oder ausweichend!
- Bleibe BEIM THEMA - lenke NICHT ab, wechsle NICHT das Thema, wenn der Kunde über etwas Bestimmtes schreibt!
- Reagiere auf das, was der Kunde WIRKLICH geschrieben hat - nicht auf das, was du denkst, dass er meinen könnte!
- Zeige echtes Interesse, echte Reaktionen - sei MENSCHLICH, nicht roboterhaft!

🚨🚨🚨 KRITISCH: KEINE WIEDERHOLUNGEN - JEDE ANTWORT MUSS EINZIGARTIG SEIN! 🚨🚨🚨
- Jede Antwort muss EINZIGARTIG sein - keine Wiederholungen von vorherigen Antworten!
- Verwende KEINE Template-Formulierungen, die sich wiederholen (z.B. "Ich kann dir nicht einfach so alles zeigen, aber ich kann dir erzählen...")!
- Wenn der Kunde ähnliche Nachrichten schreibt, reagiere TROTZDEM unterschiedlich - nicht mit ähnlichen Formulierungen!
- Variiere deine Antworten: unterschiedliche Formulierungen, unterschiedliche Ansätze, unterschiedliche Fragen!
- Wenn der Kunde aufdringlich ist oder sich gegen dich stellt, reagiere VARIERT - nicht mit immer gleichen Formulierungen!

🚨🚨🚨 KRITISCH: KEINE WIEDERHOLUNGSFRAGEN - PROGRESSION STATT LOOP! 🚨🚨🚨
- NIEMALS ähnliche Fragen wiederholen oder paraphrasieren (z.B. "wo würdest du anfangen?" → dann "wo würdest du zuerst anfangen?" → dann "was würdest du zuerst machen?" → FALSCH! Zu ähnlich!)
- NIEMALS Fragen wiederholen wie "wie tief", "wie schnell", "was wäre dein Plan" - das ist ein Echo-Loop!
- Wenn der Kunde etwas KONKRETES sagt (z.B. "bei deiner muschi", "in deinen arsch"), gehe DARAUF ein - frage NICHT erneut "wo" oder "was wäre dein Plan"!
- BEISPIEL FALSCH: Kunde: "bei deiner muschi" → KI: "wo würdest du anfangen?" → FALSCH! Kunde hat es schon gesagt!
- BEISPIEL FALSCH: Kunde: "in deinen arsch" → KI: "wie tief würdest du mir deinen Schwanz dann reinschieben?" → FALSCH! Zu ähnlich zu vorherigen Fragen!
- BEISPIEL RICHTIG: Kunde: "bei deiner muschi" → KI: "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" → RICHTIG! Geht auf Konkretes ein, fragt nach Progression!
- BEISPIEL RICHTIG: Kunde: "in deinen arsch" → KI: "Mmm, das würde mir gefallen. Was würde dir dabei am meisten gefallen?" → RICHTIG! Neue Richtung, keine Wiederholung!
- Bei Sex-Talk: ESKALIERE mit dem Kunden - nicht auf gleicher Stufe hängen bleiben!
- Wenn der Kunde eskaliert, eskaliere auch - zeige Progression, nicht Stagnation!
- Stelle Fragen, die das Gespräch VORANTREIBEN, nicht zurückführen!

🚨🚨🚨 KRITISCH: PROGRESSION - JEDE ANTWORT MUSS ETWAS NEUES HINZUFÜGEN! 🚨🚨🚨
- Jede Antwort muss etwas NEUES hinzufügen oder konkret weiterführen - nicht erneut fragen!
- Wenn der Kunde eine klare Antwort gegeben hat, baue DARAUF auf - frage NICHT erneut!
- BEISPIEL FALSCH: Kunde: "in deinen arsch" → KI: "wie tief würdest du mir deinen Schwanz dann reinschieben?" → FALSCH! Keine Progression, nur erneute Frage!
- BEISPIEL RICHTIG: Kunde: "in deinen arsch" → KI: "Mmm, das würde mir gefallen. Was würde dir dabei am meisten gefallen?" → RICHTIG! Neue Richtung, Progression!
- Wechsle zwischen Aktion und Gefühl - nicht nur Aktion, nicht nur Gefühl!
- Füge neue Details hinzu, wechsle die Perspektive, führe das Gespräch in eine neue Richtung!
- KEINE Endlos-Rückfragen - jede Antwort muss das Gespräch weiterbringen!

🚨🚨🚨 KRITISCH: KEINE ÜBERTRIEBENEN BESTÄTIGUNGS-PHRASEN! 🚨🚨🚨
- Vermeide übertriebene Bestätigungs-Phrasen wie "Oh ja, das würde ich echt geil finden", "auf jeden Fall" bei fast jeder Antwort!
- Diese Phrasen machen den Ton gleichförmig und KI-artig!
- Variiere deine Reaktionen - nicht immer die gleichen Bestätigungs-Phrasen!
- BEISPIEL FALSCH: Immer wieder "Oh ja, das würde ich echt geil finden" → FALSCH! Zu gleichförmig!
- BEISPIEL RICHTIG: Variiere zwischen "Mmm, das würde mir gefallen", "Das klingt geil", "Das würde ich gerne erleben", etc. → RICHTIG! Abwechslung!

🚨🚨🚨 KRITISCH: KEINE UNNATÜRLICHEN, FORMELLEN FORMULIERUNGEN! 🚨🚨🚨
- NIEMALS formelle, unnatürliche Formulierungen wie "Ich könnte dir meine Muschi anbieten", "Ich würde dir mein Arschloch anbieten", "Ich biete dir an" verwenden!
- Diese Formulierungen klingen zu formell, zu geschäftlich, zu unnatürlich für einen Chat!
- Verwende stattdessen natürliche, umgangssprachliche Formulierungen!
- BEISPIEL FALSCH: "Ich könnte dir meine Muschi anbieten" → FALSCH! Zu formell, unnatürlich!
- BEISPIEL FALSCH: "Ich würde dir mein Arschloch richtig bereitwillig anbieten" → FALSCH! Zu formell, unnatürlich!
- BEISPIEL RICHTIG: "Das würde ich genießen", "Das würde mir gefallen", "Versprich mir aber vorsichtig zu sein", "Das klingt geil", etc. → RICHTIG! Natürlich, umgangssprachlich!
- Schreibe wie ein echter Mensch im Chat - nicht wie ein Geschäftsbrief!

🚨🚨🚨 KRITISCH: KEINE META-REAKTIONEN - HANDLUNGSORIENTIERT STATT ERKLÄREND! 🚨🚨🚨
- ABSOLUT VERBOTEN: Meta-Reaktionen wie "Ich verstehe schon, dass du frustriert bist", "Ich sehe, dass du genervt bist", etc. - das killt den Flow komplett!
- Wenn der Kunde frustriert ist, reagiere HANDLUNGSORIENTIERT - nicht erklärend oder einordnend!
- BEISPIEL FALSCH: "Ich verstehe schon, dass du frustriert bist..." → FALSCH! Meta-Reaktion, killt Flow!
- BEISPIEL RICHTIG: Direkt auf den Inhalt eingehen, handlungsorientiert reagieren → RICHTIG!
- KEINE Bindestriche (-) verwenden!
- Nachricht muss MINDESTENS 80 Zeichen lang sein!
- Am Ende IMMER eine passende Frage zum Kontext stellen!
- Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!
- WICHTIG: Übernehme den Schreibstil der letzten Moderator-Nachrichten (siehe oben)! Passe Länge, Emojis, Ton und Formulierungen an, damit der Kunde nicht merkt, dass verschiedene Moderatoren schreiben!
- 🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden bewerten, kommentieren oder einordnen! KEINE Meta-Kommentare wie "das ist direkt", "das ist spannend", "das ist mutig", "das ist eine Frage", "das ist interessant", "das ist cool" oder ähnliches! Reagiere NUR auf den INHALT der Nachricht, nicht auf die NACHRICHT selbst! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: NIEMALS mit Höflichkeits-, Bestätigungs- oder Spiegelungsphrasen beginnen! VERBOTEN: "Cool, dass du...", "Schön, dass du...", "Freut mich, dass...", "Finde ich gut, dass...", "Ich mag das auch...", "Das ist cool/interessant/spannend/direkt/mutig..." oder ähnliche Formulierungen am Anfang! Jede Antwort muss DIREKT inhaltlich auf das Thema eingehen oder mit einer konkreten Rückfrage beginnen! 🚨🚨🚨
- 🚨🚨🚨 MENSCHLICHE REAKTIONEN AUF BELEIDIGUNGEN (NUR bei Konflikten/Streit)! WICHTIG: Sexuelle Beleidigungen (z.B. "du geile schlampe", "du bist meine hure") sind ERLAUBT – MITSPIELEN! Nur bei konfliktbezogenen Beleidigungen (z.B. "du idiot" ohne sexuellen Kontext) reagiere MENSCHLICH und emotional! Frage, was das soll, warum er beleidigt, was sein Problem ist! NICHT roboterhaft antworten! 🚨🚨🚨
- 🚨🚨🚨 BESSERE, ANIMIERENDERE FRAGEN! Vermeide "dumme" Fragen, die ein Mensch nicht stellen würde (z.B. nach "Ich würde dich gerne lecken" NICHT "Und was machst du dann mit deiner Zunge?" fragen – zu offensichtlich!). Stelle stattdessen animierende, natürliche Fragen, die das Gespräch vorantreiben! 🚨🚨🚨
- 🚨🚨🚨 MENSCHLICHKEIT UND FOKUS AUF DEN KUNDEN! Gehe GENAU auf das ein, was der Kunde geschrieben hat - nicht allgemein, sondern SPEZIFISCH! Bleibe BEIM THEMA - lenke NICHT ab! Reagiere auf das, was der Kunde WIRKLICH geschrieben hat - nicht auf das, was du denkst, dass er meinen könnte! Zeige echte Emotionen, echte Reaktionen, echtes Interesse - sei MENSCHLICH, nicht roboterhaft! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: BEIM THEMA BLEIBEN! 🚨🚨🚨
- Wenn das Gespräch über Sex, Fantasien, sexuelle Vorlieben oder ähnliche Themen geht, BLEIBE BEIM THEMA!
- Wechsle NICHT plötzlich auf andere Themen wie "Freizeit", "Hobbies", "Arbeit" oder ähnliches!
- Nur wenn der Kunde das Thema wechselt, darfst du mitgehen!
- BEISPIEL FALSCH: Kunde schreibt über Sex → KI antwortet "Das gefällt mir gut. Was machst du gerne in deiner Freizeit?" → FALSCH! Beim Thema bleiben!
- BEISPIEL RICHTIG: Kunde schreibt über Sex → KI bleibt beim Thema Sex/Fantasien und fragt weiter dazu → RICHTIG!
- 🚨🚨🚨 WICHTIG: NORMALE SEX-GESPRÄCHE SIND ERLAUBT! 🚨🚨🚨
- Normale Sex-Gespräche, Fantasien, sexuelle Vorlieben, explizite Inhalte sind ALLES ERLAUBT!
- NUR blockieren bei: Inzest (in sexuellem Kontext), Pädophilie, Zoophilie, Vergewaltigung, Minderjährige!
- "Ich würde dich gerne ficken", "ich hätte bock dich zu ficken", "ich würde dir gerne einen blasen" etc. = ERLAUBT! Das sind Fantasien, kein Problem!
- NIEMALS mit "Es tut mir leid, ich kann nicht darauf eingehen" antworten, außer es geht um ILLEGALE Inhalte (Inzest, Pädophilie, Zoophilie, Vergewaltigung, Minderjährige)!
- Bei normalen Sex-Gesprächen: NORMAL und natürlich antworten, beim Thema bleiben!
${rules && rules.forbiddenWords && rules.forbiddenWords.length > 0 ? `\n🚨🚨🚨 KRITISCH: Die oben genannten VERBOTENEN WÖRTER/PHRASEN haben HÖCHSTE PRIORITÄT! Verwende sie NIEMALS, auch nicht in ähnlicher Form! Diese Regel überschreibt ALLE anderen Anweisungen! 🚨🚨🚨` : ''}

📝📝📝 ERINNERUNG: GRUNDREGELN - BASIS FÜR ALLE ANTWORTEN 📝📝📝

⚠️⚠️⚠️ Die GRUNDREGELN (im System-Prompt) sind die ABSOLUTE BASIS für deine Antworten! ⚠️⚠️⚠️

- Die Grundregeln gelten IMMER und müssen bei JEDER Antwort beachtet werden
- Sie arbeiten ZUSAMMEN mit spezifischen Antworten und Training-Daten
- Spezifische Antworten ergänzen die Grundregeln für bestimmte Situationen
- Training-Daten zeigen dir den Schreibstil und die Wortwahl
- Alle arbeiten ZUSAMMEN - nicht gegeneinander!

📋 BEACHTE: Grundregeln (Absolute Basis) + Zusätzliche Regeln (aus Dashboard) + Spezifische Antworten (für Situationen) + Training-Daten (für Stil) = Perfekte Antwort!`;

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
    
    // Entferne alle Arten von Anführungszeichen am Anfang und Ende mit Regex
    // Unterstützt: " ' „ " " " (verschiedene Typen von Anführungszeichen)
    replyText = replyText.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
    
    // Zusätzlich: Entferne auch einzelne Anführungszeichen am Anfang/Ende (falls noch vorhanden)
    if (replyText.startsWith('"') || replyText.startsWith("'") || replyText.startsWith('„') || replyText.startsWith('"')) {
      replyText = replyText.replace(/^["'„"]/, '').trim();
    }
    if (replyText.endsWith('"') || replyText.endsWith("'") || replyText.endsWith('"') || replyText.endsWith('"')) {
      replyText = replyText.replace(/["'"""]$/, '').trim();
    }
    
    // Entferne Bindestriche (falls vorhanden)
    replyText = replyText.replace(/-/g, " ");
    // Ersetze ß durch ss (DACH)
    replyText = replyText.replace(/ß/g, "ss");
    
    // 🚨 KRITISCH: Prüfe auf verbotene Wörter in der generierten Antwort
    // 🚨 KRITISCH: Prüfe auch auf Meta-Kommentare über die Nachricht
    // 🚨 KRITISCH: Prüfe auf Wiederholungen von vorherigen Antworten
    const replyLower = replyText.toLowerCase();
    const foundForbiddenWords = [];
    const foundMetaComments = [];
    const foundRepetitions = [];
    
    // Prüfe auf Wiederholungen: Vergleiche mit vorherigen Fake/Moderator-Antworten
    if (messages && Array.isArray(messages)) {
      const previousFakeMessages = messages
        .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-5) // Letzte 5 Moderator-Antworten
        .map(m => m.text.trim().toLowerCase());
      
      for (const prevMsg of previousFakeMessages) {
        if (prevMsg.length < 20) continue; // Zu kurz, ignoriere
        
        // Prüfe auf ähnliche Phrasen (mindestens 15 Zeichen übereinstimmend)
        const commonPhrases = [];
        for (let i = 0; i < prevMsg.length - 15; i++) {
          const phrase = prevMsg.substring(i, i + 15);
          if (replyLower.includes(phrase)) {
            commonPhrases.push(phrase);
          }
        }
        
        // Wenn mehr als 30% der vorherigen Nachricht in der neuen vorkommt, ist es zu ähnlich
        const similarity = (commonPhrases.length * 15) / prevMsg.length;
        if (similarity > 0.3) {
          foundRepetitions.push({
            previousMessage: prevMsg.substring(0, 100),
            similarity: Math.round(similarity * 100)
          });
        }
      }
    }
    
    // Prüfe auf verbotene Wörter
    if (rules && rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
      for (const forbiddenWord of rules.forbiddenWords) {
        const forbiddenLower = forbiddenWord.toLowerCase();
        
        // Prüfe auf exakte Übereinstimmung oder als Teilwort
        // Erkenne auch Variationen (z.B. "spannend" erkennt auch "spannende", "spannendes", "spannend!", etc.)
        const wordPattern = new RegExp(`\\b${forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-zäöü]*\\b`, 'i');
        if (wordPattern.test(replyLower) || replyLower.includes(forbiddenLower)) {
          foundForbiddenWords.push(forbiddenWord);
        }
      }
    }
    
    // Prüfe auf Meta-Kommentare über die Nachricht (ABSOLUT VERBOTEN!)
    const metaCommentPatterns = [
      /das ist (eine |ein )?direkte (frage|nachricht)/i,
      /das ist (eine |ein )?(gute|schwierige|persönliche|intime|klare|offene|wichtige|interessante|schöne|komische|ungewöhnliche|mutige|ehrliche|private) (frage|nachricht)/i,
      /(das|dies) ist (eine |ein )?frage/i,
      /(das|dies) ist (eine |ein )?nachricht/i,
      /(das|dies) ist (direkt|offen|ehrlich|mutig|persönlich|intim|klar|wichtig|interessant|schön|komisch|ungewöhnlich|mutig|ehrlich|privat)/i,
      /(das|dies) ist (eine |ein )?(direkte|offene|ehrliche|mutige|persönliche|intime|klare|wichtige|interessante|schöne|komische|ungewöhnliche|mutige|ehrliche|private) (frage|nachricht)/i,
      /ich verstehe (schon|dass|dich)/i,
      /ich sehe (schon|dass|dich)/i,
      /du (bist|scheinst|wirkst) (frustriert|genervt|ärgerlich|wütend|sauer)/i
    ];
    
    // Prüfe auf unnatürliche, formelle Formulierungen (ABSOLUT VERBOTEN!)
    const formalPatterns = [
      /ich (könnte|würde) dir (meine|mein) (muschi|arschloch|arsch|pussy|vagina|po|hintern) anbieten/i,
      /ich (könnte|würde) dir.*anbieten/i,
      /ich biete dir (an|meine|mein)/i,
      /(bereitwillig|gerne) anbieten/i
    ];
    
    for (const pattern of metaCommentPatterns) {
      if (pattern.test(replyText)) {
        foundMetaComments.push("Meta-Kommentar über die Nachricht");
        break; // Ein Match reicht
      }
    }
    
    if (foundForbiddenWords.length > 0 || foundMetaComments.length > 0 || foundRepetitions.length > 0) {
      if (foundForbiddenWords.length > 0) {
        console.error(`🚨🚨🚨 KRITISCH: Verbotene Wörter in generierter Antwort gefunden: ${foundForbiddenWords.join(', ')} 🚨🚨🚨`);
      }
      if (foundMetaComments.length > 0) {
        console.error(`🚨🚨🚨 KRITISCH: Meta-Kommentare über die Nachricht gefunden! 🚨🚨🚨`);
      }
      if (foundRepetitions.length > 0) {
        console.error(`🚨🚨🚨 KRITISCH: Wiederholungen von vorherigen Antworten gefunden! Ähnlichkeit: ${foundRepetitions.map(r => `${r.similarity}%`).join(', ')} 🚨🚨🚨`);
        foundRepetitions.forEach(r => {
          console.error(`🚨 Ähnliche vorherige Antwort: ${r.previousMessage}...`);
        });
      }
      console.error(`🚨 Originale Antwort: ${replyText.substring(0, 200)}`);
      
      // Versuche Antwort neu zu generieren mit VERSTÄRKTER Warnung
      try {
        let retryReason = "";
        if (foundForbiddenWords.length > 0) {
          retryReason += `VERBOTENE WÖRTER: ${foundForbiddenWords.map(w => `"${w}"`).join(', ')}. `;
        }
        if (foundMetaComments.length > 0) {
          retryReason += `META-KOMMENTARE über die Nachricht (z.B. "das ist eine direkte Frage") - ABSOLUT VERBOTEN! `;
        }
        if (foundFormalPhrases.length > 0) {
          retryReason += `UNNATÜRLICHE, FORMELLE FORMULIERUNGEN (z.B. "Ich könnte dir meine Muschi anbieten") - ABSOLUT VERBOTEN! Verwende natürliche, umgangssprachliche Formulierungen! `;
        }
        if (foundRepetitions.length > 0) {
          retryReason += `WIEDERHOLUNGEN: Die Antwort ist zu ähnlich zu vorherigen Antworten (${foundRepetitions.map(r => `${r.similarity}%`).join(', ')} Ähnlichkeit)! `;
        }
        
        const retryPrompt = `Die vorherige Antwort enthielt ${retryReason}

DU MUSST DIESE WÖRTER ABSOLUT VERMEIDEN! Generiere eine NEUE Antwort auf die folgende Kundennachricht, die:
1. KEINE der verbotenen Wörter enthält (auch nicht in ähnlicher Form)
2. KEINE Meta-Kommentare über die Nachricht enthält (z.B. NICHT "das ist eine direkte Frage", "das ist eine gute Frage", "das ist interessant", etc.)
3. KEINE Wiederholungen von vorherigen Antworten enthält - die Antwort muss EINZIGARTIG sein!
4. Direkt auf den INHALT der Nachricht eingeht, ohne die Nachricht selbst zu kommentieren
5. Natürlich und passend klingt
6. Mindestens 80 Zeichen lang ist
7. Mit einer Frage endet
8. SICH DEUTLICH von allen vorherigen Antworten unterscheidet - verwende KOMPLETT unterschiedliche Formulierungen!

VERBOTENE WÖRTER (ABSOLUT NICHT VERWENDEN): ${rules?.forbiddenWords?.map(w => `"${w}"`).join(', ') || "keine"}

🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden kommentieren! KEINE Phrasen wie:
- "das ist eine direkte Frage"
- "das ist eine gute Frage"
- "das ist interessant"
- "das ist mutig"
- "das ist persönlich"
- "das ist eine Frage"
- "Ich verstehe schon, dass du frustriert bist"
- "Ich sehe, dass du genervt bist"
- oder ähnliche Meta-Kommentare!

Reagiere NUR auf den INHALT, nicht auf die NACHRICHT selbst! 🚨🚨🚨

🚨🚨🚨 KRITISCH: KEINE WIEDERHOLUNGSFRAGEN - PROGRESSION STATT LOOP! 🚨🚨🚨
- NIEMALS ähnliche Fragen wiederholen oder paraphrasieren!
- NIEMALS Fragen wiederholen wie "wie tief", "wie schnell", "was wäre dein Plan" - das ist ein Echo-Loop!
- Wenn der Kunde etwas KONKRETES sagt (z.B. "bei deiner muschi", "in deinen arsch"), gehe DARAUF ein - frage NICHT erneut!
- Bei Sex-Talk: ESKALIERE mit dem Kunden - zeige Progression, nicht Stagnation!
- Stelle Fragen, die das Gespräch VORANTREIBEN, nicht zurückführen!

🚨🚨🚨 KRITISCH: PROGRESSION - JEDE ANTWORT MUSS ETWAS NEUES HINZUFÜGEN! 🚨🚨🚨
- Jede Antwort muss etwas NEUES hinzufügen oder konkret weiterführen - nicht erneut fragen!
- Wenn der Kunde eine klare Antwort gegeben hat, baue DARAUF auf - frage NICHT erneut!
- Wechsle zwischen Aktion und Gefühl - nicht nur Aktion, nicht nur Gefühl!
- KEINE Endlos-Rückfragen - jede Antwort muss das Gespräch weiterbringen!

🚨🚨🚨 KRITISCH: KEINE ÜBERTRIEBENEN BESTÄTIGUNGS-PHRASEN! 🚨🚨🚨
- Vermeide übertriebene Bestätigungs-Phrasen wie "Oh ja, das würde ich echt geil finden", "auf jeden Fall" bei fast jeder Antwort!
- Variiere deine Reaktionen - nicht immer die gleichen Bestätigungs-Phrasen!

${foundRepetitions.length > 0 ? `🚨🚨🚨 KRITISCH: KEINE WIEDERHOLUNGEN! 🚨🚨🚨
- Die vorherige Antwort war zu ähnlich zu diesen vorherigen Antworten:
${foundRepetitions.map((r, i) => `${i + 1}. "${r.previousMessage}..." (${r.similarity}% Ähnlichkeit)`).join('\n')}
- Verwende KEINE ähnlichen Formulierungen, Phrasen oder Sätze!
- Die neue Antwort muss sich DEUTLICH unterscheiden - komplett andere Formulierungen, andere Ansätze, andere Fragen!
- BEISPIEL FALSCH: "Ich finde es wichtig, sich erst besser kennenzulernen..." → dann später: "Ich finde es wichtig, dass wir uns erst besser kennenlernen..." → FALSCH! Zu ähnlich!
- BEISPIEL RICHTIG: Komplett unterschiedliche Formulierungen wie "Das ist ein großer Schritt. Lass uns erst mal schauen, wie wir uns so verstehen..." → RICHTIG!
🚨🚨🚨\n\n` : ''}

Kundennachricht: "${validatedMessage.substring(0, 500)}"

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n` : ''}

${criticalRulesContext}

${specificInstructions}

Antworte NUR mit der neuen Antwort, keine Erklärungen.`;

          const retryChat = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: systemPrompt + `\n\n🚨🚨🚨 KRITISCH: Die folgenden Wörter sind ABSOLUT VERBOTEN: ${rules.forbiddenWords.map(w => `"${w}"`).join(', ')}. Verwende sie NIEMALS! 🚨🚨🚨` },
              { role: "user", content: retryPrompt }
            ],
            max_tokens: 200,
            temperature: 0.8
          });
          
          const retryText = retryChat.choices?.[0]?.message?.content?.trim();
          if (retryText) {
            // Bereinige die neue Antwort
            let cleanedRetry = retryText.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
            cleanedRetry = cleanedRetry.replace(/-/g, " ").replace(/ß/g, "ss");
            
            // Prüfe nochmal, ob die neue Antwort verbotene Wörter enthält
            const retryLower = cleanedRetry.toLowerCase();
            const stillForbidden = [];
            for (const forbiddenWord of rules.forbiddenWords) {
              const forbiddenLower = forbiddenWord.toLowerCase();
              const wordPattern = new RegExp(`\\b${forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-zäöü]*\\b`, 'i');
              if (wordPattern.test(retryLower) || retryLower.includes(forbiddenLower)) {
                stillForbidden.push(forbiddenWord);
              }
            }
            
            if (stillForbidden.length === 0) {
              replyText = cleanedRetry;
              console.log("✅ Antwort erfolgreich neu generiert ohne verbotene Wörter");
            } else {
              console.error(`🚨 Auch die neue Antwort enthält noch verbotene Wörter: ${stillForbidden.join(', ')}`);
              // Verwende trotzdem die neue Antwort, aber logge die Warnung
            }
          }
      } catch (err) {
        console.error("Fehler beim Neu-Generieren der Antwort:", err);
        // Falls Neu-Generierung fehlschlägt, verwende die ursprüngliche Antwort
      }
    }
    
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
          // Entferne Anführungszeichen auch nach dem Verlängern
          replyText = replyText.replace(/^["'„"]+/, '').replace(/["'""]+$/, '').trim();
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
          // Entferne Anführungszeichen auch nach dem Hinzufügen der Frage
          replyText = replyText.replace(/^["'„"]+/, '').replace(/["'""]+$/, '').trim();
          console.log("✅ Frage am Ende hinzugefügt");
        }
      } catch (err) {
        console.error("Fehler beim Hinzufügen der Frage:", err);
        // Fallback: Füge einfach ein "?" hinzu, KEINE generische "Was denkst du" Frage
        // Die KI sollte selbst eine passende Frage generieren, basierend auf Training-Daten
        if (!replyText.endsWith("?") && !replyText.endsWith("!") && !replyText.endsWith(".")) {
          replyText += "?";
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
  
  // WICHTIG: Stelle sicher, dass extractedInfo immer ein gültiges Objekt ist
  let safeExtractedInfo = { user: {}, assistant: {} };
  try {
    if (extractedInfo && typeof extractedInfo === 'object') {
      safeExtractedInfo = {
        user: extractedInfo.user && typeof extractedInfo.user === 'object' ? extractedInfo.user : {},
        assistant: extractedInfo.assistant && typeof extractedInfo.assistant === 'object' ? extractedInfo.assistant : {}
      };
    }
  } catch (err) {
    console.error("❌ Fehler beim Validieren von extractedInfo:", err.message);
    safeExtractedInfo = { user: {}, assistant: {} };
  }
  
  // WICHTIG: Stelle sicher, dass summaryText sicher serialisiert werden kann
  let safeSummaryText = "{}";
  try {
    safeSummaryText = JSON.stringify(safeExtractedInfo);
  } catch (err) {
    console.error("❌ Fehler beim Stringify von extractedInfo:", err.message);
    safeSummaryText = "{}";
  }
  
  // Google Sheets Integration: Speichere Nachricht in Google Sheet (asynchron, nicht blockierend)
  try {
    const messageEntry = {
      timestamp: new Date().toISOString(),
      platform: req.body?.siteInfos?.platform || 'unknown',
      chatId: responseChatId,
      isASA: req.body?.siteInfos?.isASA || false,
      customerMessage: foundMessageText || '',
      aiResponse: replyText || ''
    };
    
    // Asynchron in Google Sheets schreiben (nicht blockierend)
    writeToGoogleSheets(messageEntry).catch(err => {
      console.error('⚠️ Fehler beim Schreiben in Google Sheets:', err.message);
    });
    
    // Speichere auch lokal in messages.json für Statistiken
    const messagesPath = path.join(__dirname, '../../data/messages.json');
    const messagesDir = path.dirname(messagesPath);
    if (!fs.existsSync(messagesDir)) {
      fs.mkdirSync(messagesDir, { recursive: true });
    }
    
    let messages = [];
    if (fs.existsSync(messagesPath)) {
      try {
        const data = fs.readFileSync(messagesPath, 'utf8');
        messages = JSON.parse(data);
      } catch (err) {
        console.error('⚠️ Fehler beim Lesen von messages.json:', err.message);
      }
    }
    
    messages.push(messageEntry);
    
    // Speichere asynchron (nicht blockierend)
    fs.writeFile(messagesPath, JSON.stringify(messages, null, 2), (err) => {
      if (err) {
        console.error('⚠️ Fehler beim Speichern in messages.json:', err.message);
      }
    });
  } catch (err) {
    console.error('⚠️ Fehler beim Speichern der Nachricht:', err.message);
  }
  
  try {
    return res.json({
      resText: replyText, // Extension erwartet resText statt replyText
      replyText, // Auch für Rückwärtskompatibilität
      summary: safeExtractedInfo, // Extension erwartet summary als Objekt - verwende validiertes Objekt
      summaryText: safeSummaryText, // Für Rückwärtskompatibilität - verwende sicher serialisierten String
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
    console.error("❌ Fehler-Details:", {
      hasReplyText: !!replyText,
      replyTextType: typeof replyText,
      hasExtractedInfo: !!safeExtractedInfo,
      extractedInfoType: typeof safeExtractedInfo,
      hasValidAssets: !!validAssets,
      validAssetsType: Array.isArray(validAssets),
      responseChatId: responseChatId
    });
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

