const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");
const fs = require("fs");
const path = require("path");
const { writeToGoogleSheets } = require("../utils/google-sheets");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
const router = express.Router();

// AI Model Konfiguration - zentral verwaltet
const AI_MODEL = process.env.AI_MODEL || "gpt-4o"; // Standard: GPT-4o (kann über Umgebungsvariable geändert werden)

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
              "Berufsfrage": "Falls kein Beruf im Logbuch steht, erfinde einen realistischen Beruf. Nenne den Beruf natürlich in deiner Antwort. Keine Flugzeugbegleiter, Zugkontrolleur oder ähnliche Berufe.",
              "Treffen/Termine": "NIEMALS einem Treffen zustimmen oder einen Termin ausmachen! NIEMALS sagen 'Ich wäre gerne bereit' oder 'Ich bin bereit' - das klingt wie eine Zusage! Sage stattdessen 'Ich könnte es mir vorstellen' oder 'Ich würde gerne wissen, wie du es dir vorstellst'. Frage nach, wie ER es sich vorstellt, aber mache KEINE Zusage! Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, aber weiche der Frage aus.",
              "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben. NIEMALS das Wort 'Credits' verwenden! Orientiere dich an den Training-Daten-Beispielen für Geld/Coins - diese zeigen, wie man natürlich darauf reagiert, ohne das Wort 'Credits' zu verwenden.",
              "Kontaktdaten außerhalb der Plattform": "Der Kunde versucht, seine Kontaktdaten (Telefonnummer, Email, Telegram, Instagram) zu teilen, um außerhalb der Plattform zu kommunizieren. Das ist nicht erlaubt - wir dürfen nur auf dieser Plattform schreiben. Reagiere NATÜRLICH und höflich, ähnlich wie bei Geld/Coins. NIEMALS direkt sagen 'Es ist wichtig, dass wir hier bleiben' oder 'Wir müssen hier schreiben' - das klingt zu roboterhaft! Orientiere dich STRENG an den Training-Daten-Beispielen für Geld/Coins - diese zeigen, wie man natürlich darauf reagiert, ohne zu direkt zu sein. Weiche freundlich aus und lenke das Gespräch zurück zum aktuellen Thema, OHNE explizit die Plattform-Regeln zu erwähnen."
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
  
  // KRITISCH: Erweiterte Liste von falsePositive-Termen, die NIE blockiert werden sollten
  // Diese Wörter enthalten oft Zahlen 10-17, sind aber harmlos
  const globalFalsePositiveTerms = [
    "wünsch", "wünschen", "wünscht", "wünschst", "wünschte", "wünschten", "wünsche",
    "schön", "schon", "schönsten", "schönen", "schöner", "schöne", "schönes",
    "gabi", "gab", "gabriel", "gabe",
    "tag", "tage", "tagen", "tägig", "tägige",
    "vögeln", "vögel", "vögelchen", // Normale sexuelle Wörter
    "ficken", "fick", "fickt", "fickst", // Normale sexuelle Wörter
    "sex", "sexuell", "sexuelle", // Normale sexuelle Wörter
    "geil", "heiß", "lust", "verlangen", // Normale sexuelle Wörter
    "titten", "brüste", "arsch", "pussy", "schwanz", "muschi", // Normale sexuelle Wörter
    "lecken", "lutschen", "blasen", "nippel", "sperma", // Normale sexuelle Wörter
    "besorgen", "besorg", "besorgt", "besorgst", // Normale sexuelle Wörter
    "treffen", "kommen", "besuchen", "sehen" // Normale Wörter
  ];
  
  // Prüfe zuerst, ob der Text falsePositive-Terme enthält
  // Wenn ja, dann ist es sehr unwahrscheinlich, dass es um Minderjährige geht
  const hasFalsePositive = globalFalsePositiveTerms.some(term => lower.includes(term));
  
  // Direkte Erwähnungen von Minderjährigkeit (nur wenn KEIN falsePositive-Term vorhanden ist)
  if (!hasFalsePositive) {
  if (lower.includes("minderjähr")) return true;
  if (lower.includes("unter 18")) return true;
  if (lower.includes("unter achtzehn")) return true;
  if (lower.includes("noch nicht volljährig")) return true;
  if (lower.includes("noch nicht 18")) return true;
  if (lower.includes("jugendlich") && (lower.includes("14") || lower.includes("15") || lower.includes("16") || lower.includes("17"))) return true;
  }
  
  // Altersprüfung: 10-17 Jahre (verschiedene Formate)
  // WICHTIG: Nur blockieren, wenn es wirklich um Alter geht, nicht bei anderen Kontexten!
  const agePatterns = [
    /\b(1[0-7])\s*(jahr|jahre|j|alt|jährig)\b/i,
    /\bich bin (1[0-7])\s*(jahr|jahre|j|alt|jährig)?\b/i,
    /\b(1[0-7])\s*jahre alt\b/i,
    /\b(1[0-7])\s*und\s*(halb|halbjahr)\b/i
  ];
  
  for (const pattern of agePatterns) {
    if (pattern.test(lower)) {
      // Zusätzliche Prüfung: Ist es wirklich um Alter oder um andere Dinge?
      const match = lower.match(pattern);
      if (match) {
        const matchIndex = lower.indexOf(match[0]);
        const context = lower.substring(Math.max(0, matchIndex - 30), Math.min(lower.length, matchIndex + match[0].length + 30));
        
        // Prüfe, ob es NICHT um andere Dinge geht
        const isFalsePositive = globalFalsePositiveTerms.some(term => context.includes(term));
        
        // Zusätzlich: Prüfe, ob es wirklich um Alter geht (muss "alt", "jahr", "bin", "habe" enthalten)
        const isAgeContext = context.includes("alt") || context.includes("jahr") || 
                            (context.includes("bin") && (context.includes("alt") || context.includes("jahr"))) || 
                            (context.includes("habe") && (context.includes("alt") || context.includes("jahr")));
        
        // Nur blockieren, wenn es wirklich um Alter geht UND kein falsePositive-Term vorhanden ist
        if (isAgeContext && !isFalsePositive) {
          return true;
        }
      }
    }
  }
  
  // Prüfe auf Zahlen 10-17 in Kombination mit "alt", "Jahre", etc.
  // WICHTIG: Nur blockieren, wenn es wirklich um Alter geht, nicht bei anderen Kontexten!
  const numbers = lower.match(/\b(1[0-7])\b/g);
  if (numbers && !hasFalsePositive) { // Nur prüfen, wenn KEIN falsePositive-Term vorhanden ist
    for (const number of numbers) {
      const numberIndex = lower.indexOf(number);
      const context = lower.substring(Math.max(0, numberIndex - 40), Math.min(lower.length, numberIndex + number.length + 40));
      
      // Prüfe, ob es NICHT um andere Dinge geht
      const isFalsePositive = globalFalsePositiveTerms.some(term => context.includes(term));
      
      // Nur blockieren, wenn es wirklich um Alter geht
      const isAgeContext = context.includes("alt") || context.includes("jahr") || 
                          (context.includes("bin") && (context.includes("alt") || context.includes("jahr"))) || 
                          (context.includes("habe") && (context.includes("alt") || context.includes("jahr"))) ||
                          context.includes("jährig");
      
      // Nur blockieren, wenn es wirklich um Alter geht UND kein falsePositive-Term vorhanden ist
      if (isAgeContext && !isFalsePositive) {
      return true;
      }
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
  
  // Familienmitglieder - nur blockieren wenn in EXPLIZIT sexuellem Kontext
  // WICHTIG: Normale Erwähnungen von Familienmitgliedern sind ERLAUBT!
  const familyTerms = ["mutter", "vater", "tochter", "sohn", "bruder", "schwester", "cousin", "cousine", "onkel", "tante", "neffe", "nichte"];
  for (const term of familyTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      // Prüfe ob es in EXPLIZIT sexuellem Kontext steht (dann blockieren)
      const context = lower.substring(Math.max(0, lower.indexOf(term) - 50), Math.min(lower.length, lower.indexOf(term) + 50));
      
      // KRITISCH: Nur blockieren, wenn es EXPLIZIT sexuelle Wörter gibt (nicht "liebe", "beziehung", etc. - zu unspezifisch!)
      const explicitSexualTerms = ["sex", "ficken", "fick", "besorgen", "besorg", "geil", "heiß", "vögeln", "blasen", "lecken", "lutschen", "schwanz", "pussy", "muschi", "arsch", "titten", "brüste", "sperma", "orgasmus", "kommen"];
      const hasExplicitSexualContext = explicitSexualTerms.some(word => context.includes(word));
      
      // Zusätzlich: Prüfe auf Inzest-spezifische Begriffe
      const incestIndicators = ["mit", "und", "zusammen", "oder"];
      const hasIncestContext = hasExplicitSexualContext && incestIndicators.some(indicator => {
        const beforeTerm = context.substring(0, context.indexOf(term));
        const afterTerm = context.substring(context.indexOf(term) + term.length);
        return (beforeTerm.includes(indicator) || afterTerm.includes(indicator)) && 
               (beforeTerm.includes("sex") || beforeTerm.includes("fick") || afterTerm.includes("sex") || afterTerm.includes("fick"));
      });
      
      // Nur blockieren, wenn es EXPLIZIT sexuell ist UND in Kombination mit Familienmitglied
      if (hasExplicitSexualContext && hasIncestContext) {
        return true; // Blockieren wenn in explizit sexuellem Kontext mit Familienmitglied
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
  
  // KRITISCH: Blockierung NUR bei:
  // 1. Minderjährigen (bereits oben geprüft)
  // 2. Tiere ficken (Zoophilie - bereits oben geprüft)
  // 3. Pädophilie (bereits oben geprüft)
  // 4. Inzest (bereits oben geprüft)
  // NICHT blockieren bei: Vergewaltigung, Zwang, Nötigung - das sind normale Sex-Gespräche!
  
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
    const extractionPrompt = `Analysiere die folgende Nachricht und extrahiere ALLE relevanten Informationen über den Kunden für das Logbuch. 
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
    "Updates": "Aktualisierungen/Neuigkeiten falls erwähnt (z.B. 'geht zum Friseur', 'hat neuen Job', 'ist umgezogen', 'wohnt bei Verwandten', 'hat bald eigene Wohnung', 'hat Urlaub', 'ist krank', 'hat Auto gekauft'), sonst null",
    "Wohnsituation": "Wohnsituation falls erwähnt (z.B. 'wohnt bei Verwandten', 'hat eigene Wohnung', 'wohnt alleine', 'zieht bald um', 'wohnt in WG'), sonst null",
    "Other": "ALLE anderen wichtigen Infos, die nicht in andere Kategorien passen (z.B. wichtige Termine, Umzüge, Jobwechsel, Auto, Haustiere, Musik, Filme, Essen, Trinken, Tattoos, Piercings, Rauchen, Eltern, Geschwister, etc.), sonst null"
  },
  "assistant": {}
}

WICHTIG - IGNORIERE folgendes (NICHT extrahieren):
- Smalltalk (z.B. "Wetter ist schön", "Wie geht es dir?", "Hallo", "Danke")
- Höflichkeitsfloskeln (z.B. "Bitte", "Danke", "Gern geschehen")
- Allgemeine Kommentare ohne Informationswert
- Fragen ohne persönliche Informationen
- Wiederholungen von bereits bekannten Informationen (nur NEUE Infos extrahieren)

WICHTIG - EXTRAHIERE ALLES NÜTZLICHE:
- Persönliche Informationen (Name, Alter, Wohnort, Beruf, etc.)
- Relevante Neuigkeiten/Aktivitäten (z.B. "geht zum Friseur", "hat Urlaub", "ist umgezogen", "hat Auto gekauft", "ist krank", "hat neuen Job")
- Wichtige Lebensumstände (Familie, Gesundheit, Arbeit, Hobbies, Wohnsituation, Auto, Haustiere, etc.)
- Wohnsituation: Wenn erwähnt (z.B. "wohnt bei Verwandten", "hat eigene Wohnung", "wohnt alleine", "zieht bald um", "wohnt in WG"), extrahiere es als "Wohnsituation"
- "Other": Verwende dieses Feld für ALLE wichtigen Infos, die nicht in andere Kategorien passen (z.B. Auto, Haustiere, Musik, Filme, Essen, Trinken, Tattoos, Piercings, Rauchen, Eltern, Geschwister, wichtige Termine, Umzüge, Jobwechsel, etc.)
- Wenn nichts Relevantes erwähnt wird, null verwenden
- Bei "Family": auch Beziehungsstatus extrahieren (geschieden, verheiratet, single, etc.)

KRITISCH - EXTRAHIERE IMMER ALLE NÜTZLICHEN INFOS:
- Namen: Wenn ein Name erwähnt wird (z.B. "Thomas Hinz", "Max Mustermann"), extrahiere ihn als "Name"
- Wohnort: Wenn eine Stadt oder Adresse erwähnt wird (z.B. "Düsseldorf", "Rather Broich Düsseldorf 40472", "Köln"), extrahiere die Stadt als "Wohnort"
- Alter: Wenn ein Alter erwähnt wird (z.B. "30 Jahre", "ich bin 25"), extrahiere es als "Age"
- Beruf: Wenn ein Beruf erwähnt wird (z.B. "ich arbeite als...", "ich bin..."), extrahiere ihn als "Work"
- Wohnsituation: Wenn erwähnt (z.B. "wohnt bei Verwandten", "hat eigene Wohnung", "wohnt alleine", "zieht bald um", "wohnt in WG"), extrahiere es als "Wohnsituation"
- Updates: Wenn Neuigkeiten erwähnt werden (z.B. "hat Urlaub", "ist krank", "hat Auto gekauft", "geht zum Friseur"), extrahiere es als "Updates"
- Andere wichtige Infos: Wenn andere nützliche Infos erwähnt werden (z.B. Auto, Haustiere, Musik, Filme, Essen, Trinken, Tattoos, Piercings, Rauchen, Eltern, Geschwister), extrahiere sie als "Other"
- Single/Geschlecht: Wenn erwähnt (z.B. "ich bin Single", "ich bin männlich"), extrahiere es als "Family" oder "Other"

WICHTIG: 
- Extrahiere ALLE nützlichen Informationen, nicht nur die vordefinierten Felder!
- Verwende "Other" für wichtige Infos, die nicht in andere Kategorien passen!
- Auch wenn die Informationen in einer Liste oder strukturierten Form stehen (z.B. "Thomas Hinz Rather Broich Düsseldorf 40472"), extrahiere Name und Wohnort getrennt!
- Extrahiere NUR NEUE Informationen - ignoriere Wiederholungen von bereits bekannten Infos!

Nachricht: ${messageText}`;

    const extraction = await client.chat.completions.create({
      model: AI_MODEL,
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
      model: AI_MODEL,
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

// Hilfsfunktion: Prüfe, ob der Kunde nach dem Wohnort fragt
function isLocationQuestion(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const locationPatterns = [
    /\b(woher|wo)\s+(kommst|kommst du|kommst du her|kommt|kommt du|kommt du her)\b/i,
    /\b(wo|woher)\s+(wohnst|wohnst du|wohnen|wohnen sie|wohnst du denn)\b/i,
    /\b(wo|woher)\s+(bist|bist du|bist du denn)\s+(du|denn)\s+(denn\s+)?(her|hergekommen)\b/i,
    /\b(wo|woher)\s+(stammst|stammst du)\b/i,
    /\b(aus|von)\s+(welcher|welchem|welche)\s+(stadt|ort|gegend|region)\b/i,
    /\b(wo|woher)\s+(kommst|kommst du)\s+(du|denn)\s+(denn\s+)?(her|hergekommen)\b/i
  ];
  return locationPatterns.some(pattern => pattern.test(lower));
}

// Hilfsfunktion: Finde eine Stadt im 50km Umkreis (vereinfachte Version)
// Da eine echte 50km-Berechnung komplex ist, verwenden wir eine Liste von Städten in der Nähe
function findNearbyCity(customerCity) {
  if (!customerCity || typeof customerCity !== 'string') return null;
  
  const city = customerCity.trim().toLowerCase();
  
  // Liste von Städten mit nahegelegenen Städten (max. 50km)
  const nearbyCities = {
    // Großstädte und ihre Umgebung
    'berlin': ['Potsdam', 'Brandenburg', 'Cottbus', 'Frankfurt (Oder)', 'Eberswalde'],
    'hamburg': ['Lübeck', 'Kiel', 'Schwerin', 'Bremen', 'Rostock'],
    'münchen': ['Augsburg', 'Ingolstadt', 'Rosenheim', 'Landshut', 'Freising'],
    'köln': ['Düsseldorf', 'Bonn', 'Leverkusen', 'Aachen', 'Wuppertal'],
    'frankfurt': ['Wiesbaden', 'Mainz', 'Darmstadt', 'Offenbach', 'Hanau'],
    'stuttgart': ['Heilbronn', 'Reutlingen', 'Tübingen', 'Esslingen', 'Ludwigsburg'],
    'düsseldorf': ['Köln', 'Duisburg', 'Essen', 'Wuppertal', 'Mönchengladbach'],
    'dortmund': ['Essen', 'Bochum', 'Hagen', 'Hamm', 'Unna'],
    'essen': ['Duisburg', 'Bochum', 'Gelsenkirchen', 'Oberhausen', 'Mülheim'],
    'leipzig': ['Halle', 'Dresden', 'Chemnitz', 'Magdeburg', 'Jena'],
    'bremen': ['Hamburg', 'Oldenburg', 'Bremerhaven', 'Delmenhorst', 'Verden'],
    'dresden': ['Leipzig', 'Chemnitz', 'Pirna', 'Meißen', 'Freital'],
    'hannover': ['Braunschweig', 'Hildesheim', 'Celle', 'Peine', 'Garbsen'],
    'nürnberg': ['Erlangen', 'Fürth', 'Bamberg', 'Ansbach', 'Schwabach'],
    'duisburg': ['Essen', 'Düsseldorf', 'Oberhausen', 'Mülheim', 'Moers'],
    'bochum': ['Essen', 'Dortmund', 'Gelsenkirchen', 'Herne', 'Witten'],
    'wuppertal': ['Düsseldorf', 'Essen', 'Solingen', 'Remscheid', 'Velbert'],
    'bielefeld': ['Gütersloh', 'Paderborn', 'Detmold', 'Herford', 'Minden'],
    'bonn': ['Köln', 'Siegburg', 'Troisdorf', 'Rheinbach', 'Meckenheim'],
    'münster': ['Osnabrück', 'Dortmund', 'Gelsenkirchen', 'Rheine', 'Coesfeld'],
    'karlsruhe': ['Mannheim', 'Heidelberg', 'Pforzheim', 'Baden-Baden', 'Rastatt'],
    'mannheim': ['Heidelberg', 'Karlsruhe', 'Ludwigshafen', 'Speyer', 'Worms'],
    'augsburg': ['München', 'Ulm', 'Ingolstadt', 'Kempten', 'Landsberg'],
    'wiesbaden': ['Frankfurt', 'Mainz', 'Darmstadt', 'Bad Homburg', 'Rüsselsheim'],
    'gelsenkirchen': ['Essen', 'Bochum', 'Dortmund', 'Oberhausen', 'Recklinghausen'],
    'mönchengladbach': ['Düsseldorf', 'Krefeld', 'Viersen', 'Rheydt', 'Jüchen'],
    'chemnitz': ['Leipzig', 'Dresden', 'Zwickau', 'Plauen', 'Freiberg'],
    'braunschweig': ['Hannover', 'Wolfsburg', 'Salzgitter', 'Gifhorn', 'Peine'],
    'kiel': ['Hamburg', 'Lübeck', 'Neumünster', 'Rendsburg', 'Eckernförde'],
    'aachen': ['Köln', 'Mönchengladbach', 'Düren', 'Eschweiler', 'Herzogenrath'],
    'halle': ['Leipzig', 'Magdeburg', 'Dessau', 'Merseburg', 'Weißenfels'],
    'magdeburg': ['Halle', 'Braunschweig', 'Dessau', 'Stendal', 'Burg'],
    'freiburg': ['Basel', 'Offenburg', 'Lörrach', 'Emmendingen', 'Breisach'],
    'krefeld': ['Düsseldorf', 'Mönchengladbach', 'Viersen', 'Neuss', 'Willich'],
    'lübeck': ['Hamburg', 'Kiel', 'Schwerin', 'Rostock', 'Travemünde'],
    'oberhausen': ['Essen', 'Duisburg', 'Mülheim', 'Bottrop', 'Gelsenkirchen'],
    'erfurt': ['Weimar', 'Jena', 'Gotha', 'Arnstadt', 'Sömmerda'],
    'rostock': ['Hamburg', 'Schwerin', 'Lübeck', 'Stralsund', 'Wismar'],
    'mainz': ['Wiesbaden', 'Frankfurt', 'Darmstadt', 'Ludwigshafen', 'Worms'],
    'kassel': ['Göttingen', 'Fulda', 'Marburg', 'Bad Hersfeld', 'Hofgeismar'],
    'hagen': ['Dortmund', 'Wuppertal', 'Iserlohn', 'Schwelm', 'Gevelsberg'],
    'hamm': ['Dortmund', 'Münster', 'Ahlen', 'Unna', 'Lünen'],
    'saarbrücken': ['Trier', 'Kaiserslautern', 'Neunkirchen', 'Völklingen', 'Homburg'],
    'mülheim': ['Essen', 'Duisburg', 'Oberhausen', 'Düsseldorf', 'Ratingen'],
    'potsdam': ['Berlin', 'Brandenburg', 'Falkensee', 'Werder', 'Teltow'],
    'ludwigshafen': ['Mannheim', 'Heidelberg', 'Frankenthal', 'Speyer', 'Neustadt'],
    'oldenburg': ['Bremen', 'Wilhelmshaven', 'Delmenhorst', 'Vechta', 'Cloppenburg'],
    'leverkusen': ['Köln', 'Düsseldorf', 'Solingen', 'Remscheid', 'Bergisch Gladbach'],
    'osnabrück': ['Münster', 'Bielefeld', 'Rheine', 'Lingen', 'Melle'],
    'solingen': ['Wuppertal', 'Remscheid', 'Leverkusen', 'Haan', 'Hilden'],
    'heidelberg': ['Mannheim', 'Karlsruhe', 'Darmstadt', 'Speyer', 'Schwetzingen'],
    'herne': ['Bochum', 'Essen', 'Dortmund', 'Gelsenkirchen', 'Recklinghausen'],
    'neuss': ['Düsseldorf', 'Krefeld', 'Mönchengladbach', 'Grevenbroich', 'Meerbusch'],
    'darmstadt': ['Frankfurt', 'Wiesbaden', 'Mainz', 'Heidelberg', 'Offenbach'],
    'paderborn': ['Bielefeld', 'Gütersloh', 'Detmold', 'Lippstadt', 'Warburg'],
    'regensburg': ['München', 'Ingolstadt', 'Landshut', 'Straubing', 'Amberg'],
    'ingolstadt': ['München', 'Augsburg', 'Regensburg', 'Eichstätt', 'Neuburg'],
    'würzburg': ['Nürnberg', 'Aschaffenburg', 'Bamberg', 'Schweinfurt', 'Kitzingen'],
    'fürth': ['Nürnberg', 'Erlangen', 'Schwabach', 'Zirndorf', 'Stein'],
    'wolfsburg': ['Braunschweig', 'Hannover', 'Gifhorn', 'Helmstedt', 'Salzgitter'],
    'offenbach': ['Frankfurt', 'Darmstadt', 'Wiesbaden', 'Hanau', 'Mühlheim'],
    'ulm': ['Augsburg', 'München', 'Neu-Ulm', 'Biberach', 'Ehingen'],
    'heilbronn': ['Stuttgart', 'Mannheim', 'Karlsruhe', 'Schwäbisch Hall', 'Crailsheim'],
    'pforzheim': ['Karlsruhe', 'Stuttgart', 'Calw', 'Mühlacker', 'Enzkreis'],
    'göttingen': ['Kassel', 'Hannover', 'Braunschweig', 'Eschwege', 'Duderstadt'],
    'bottrop': ['Essen', 'Oberhausen', 'Gelsenkirchen', 'Recklinghausen', 'Gladbeck'],
    'trier': ['Saarbrücken', 'Koblenz', 'Luxemburg', 'Wittlich', 'Bernkastel'],
    'recklinghausen': ['Essen', 'Bochum', 'Dortmund', 'Gelsenkirchen', 'Marl'],
    'reutlingen': ['Stuttgart', 'Tübingen', 'Esslingen', 'Metzingen', 'Münsingen'],
    'bremerhaven': ['Bremen', 'Hamburg', 'Cuxhaven', 'Oldenburg', 'Delmenhorst'],
    'koblenz': ['Bonn', 'Mainz', 'Trier', 'Neuwied', 'Andernach'],
    'bergisch gladbach': ['Köln', 'Leverkusen', 'Düsseldorf', 'Remscheid', 'Wuppertal'],
    'jena': ['Erfurt', 'Weimar', 'Gera', 'Apolda', 'Naumburg'],
    'remscheid': ['Wuppertal', 'Solingen', 'Leverkusen', 'Radevormwald', 'Wermelskirchen'],
    'erlangen': ['Nürnberg', 'Fürth', 'Bamberg', 'Höchstadt', 'Herzogenaurach'],
    'moers': ['Duisburg', 'Krefeld', 'Mönchengladbach', 'Kamp-Lintfort', 'Rheinberg'],
    'siegen': ['Köln', 'Dortmund', 'Marburg', 'Olpe', 'Altenkirchen'],
    'hildesheim': ['Hannover', 'Braunschweig', 'Peine', 'Alfeld', 'Sarstedt'],
    'salzgitter': ['Braunschweig', 'Hannover', 'Wolfenbüttel', 'Goslar', 'Peine']
  };
  
  // Suche nach der Stadt in der Liste (case-insensitive)
  for (const [key, cities] of Object.entries(nearbyCities)) {
    if (city.includes(key) || key.includes(city)) {
      // Wähle eine zufällige Stadt aus der Liste
      return cities[Math.floor(Math.random() * cities.length)];
    }
  }
  
  // Fallback: Wenn die Stadt nicht gefunden wurde, gib null zurück
  return null;
}

// Hilfsfunktion: Info-/System-Nachrichten erkennen (z.B. Likes/Hinweise)
function isInfoMessage(msg) {
  if (!msg || typeof msg !== "object") return true;
  const t = (msg.text || "").toLowerCase();
  const type = (msg.type || "").toLowerCase();
  const mtype = (msg.messageType || "").toLowerCase();
  
  // WICHTIG: Nur als Info-Message erkennen, wenn es wirklich eine Info-Message ist
  // Prüfe zuerst den type/messageType
  if (type === "info" || mtype === "info") {
    // ZUSÄTZLICH: Prüfe, ob der Text wirklich wie eine Info-Message aussieht
    // Wenn der Text lang ist und wie eine normale Nachricht aussieht, ist es KEINE Info-Message
    if (t.length > 50 && !t.includes("geliked") && !t.includes("like erhalten") && !t.includes("hat dich gelikt") && !t.includes("like bekommen") && !t.includes("ich habe dir einen like") && !t.includes("du gefällst mir") && !t.includes("info:") && !t.includes("hinweis:")) {
      // Lange Nachricht ohne Info-Keywords = KEINE Info-Message, auch wenn type="info"
      return false;
    }
    return true;
  }
  
  // Häufige Hinweise (FPC Like, System) - NUR wenn der Text kurz ist oder Info-Keywords enthält
  if (t.length < 100 && (t.includes("geliked") || t.includes("like erhalten") || t.includes("hat dich gelikt") || t.includes("like bekommen"))) return true;
  if (t.includes("ich habe dir einen like") || t.includes("du gefällst mir")) return true; // FPC Like-Nachrichten
  if (t.includes("info:") || t.includes("hinweis:")) return true;
  
  // WICHTIG: Lange Nachrichten (>50 Zeichen) ohne Info-Keywords sind KEINE Info-Messages
  if (t.length > 50) return false;
  
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
    // WICHTIG für iluvo: Prüfe, ob Nachrichten in umgekehrter Reihenfolge sind (neueste zuerst)
    let newestFirst = false;
    if (msgs.length > 1) {
      try {
        const firstTs = msgs[0]?.timestamp ? new Date(msgs[0].timestamp).getTime() : null;
        const lastTs = msgs[msgs.length - 1]?.timestamp ? new Date(msgs[msgs.length - 1].timestamp).getTime() : null;
        if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
      } catch (e) { /* ignore */ }
    }
    // Kunde = type === "received"
    const orderedMsgs = newestFirst ? msgs : [...msgs].reverse();
    
    // KRITISCH: Prüfe, ob die Nachricht wirklich NEU ist (innerhalb der letzten 10 Minuten)
    // Das verhindert, dass sehr alte Nachrichten fälschlicherweise als neue behandelt werden
    // WICHTIG: Erhöht auf 10 Minuten, da die Extension manchmal verzögert sendet oder Zeitstempel nicht korrekt sind
    // WICHTIG: KEINE Mindestalter-Prüfung mehr - die Extension sendet die Nachricht, wenn sie wirklich abgeschickt wurde!
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 Minuten in Millisekunden (erhöht von 5 Minuten, um verzögerte Nachrichten zu erfassen)
    
    // Sammle alle received-Nachrichten mit Zeitstempel-Info
    const receivedMessages = orderedMsgs
      .filter(m => m?.type === "received" && typeof m.text === "string" && m.text.trim() !== "")
      .map(m => {
        let age = null;
        let isValid = true;
        if (m.timestamp) {
          try {
            const msgTime = new Date(m.timestamp).getTime();
            age = now - msgTime;
            if (age > maxAge) {
              console.log(`⚠️ Nachricht zu alt (${Math.round(age / 1000)}s), überspringe:`, m.text.substring(0, 50));
              isValid = false;
            } else {
              console.log(`✅ Nachricht-Alter: ${Math.round(age * 100) / 100}s - OK`);
            }
          } catch (e) {
            console.warn("⚠️ Zeitstempel ungültig, akzeptiere Nachricht als Fallback");
          }
        } else {
          console.warn("⚠️ Kein Zeitstempel vorhanden, akzeptiere Nachricht als Fallback");
        }
        return { message: m, age, isValid };
      });
    
    // Finde die neueste gültige received-Nachricht
    // 🚨 KRITISCH: Sortiere nach kleinstem Alter (neueste zuerst), nicht nach größtem!
    // age = Zeit seit der Nachricht in Millisekunden → kleinere age = neuere Nachricht
    const validReceivedMessages = receivedMessages
      .filter(m => m.isValid && !isInfoMessage(m.message))
      .sort((a, b) => {
        const ageA = a.age || Infinity;
        const ageB = b.age || Infinity;
        return ageA - ageB; // Kleinste age zuerst = neueste Nachricht
      });
    
    if (validReceivedMessages.length > 0) {
      const lastReceived = validReceivedMessages[0].message;
      
      // 🆕 NEU: Kombiniere mehrere Nachrichten, wenn sie innerhalb von 2 Minuten sind
      // Das erkennt z.B. Text + Bild Nachrichten
      const recentMessages = validReceivedMessages
        .filter(m => {
          const age = m.age || Infinity;
          return age <= 2 * 60 * 1000; // Innerhalb von 2 Minuten
        })
        .sort((a, b) => {
          const ageA = a.age || Infinity;
          const ageB = b.age || Infinity;
          return ageA - ageB; // Neueste zuerst
        });
      
      if (recentMessages.length > 1) {
        // Kombiniere mehrere Nachrichten
        const combinedMessages = recentMessages
          .map(m => m.message.text.trim())
          .filter(text => text && text.length > 0)
          .join(' ');
        
        foundMessageText = combinedMessages;
        console.log(`✅ ${recentMessages.length} Nachrichten innerhalb von 2 Minuten kombiniert:`, foundMessageText.substring(0, 100) + "...");
      } else {
      foundMessageText = lastReceived.text.trim();
      console.log("✅ Nachricht aus siteInfos.messages (received, NEU):", foundMessageText.substring(0, 100) + "...");
      }
      
      // 🆕 NEU: Speichere Bild-URL aus der neuesten Nachricht (falls vorhanden)
      // Prüfe verschiedene mögliche Felder für Bild-URLs
      const lastReceivedMessage = validReceivedMessages[0].message;
      if (lastReceivedMessage && !lastReceivedMessage.imageUrl) {
        // Extrahiere Bild-URL aus verschiedenen möglichen Feldern
        const imageUrl = lastReceivedMessage.image || 
                        lastReceivedMessage.imageUrl || 
                        lastReceivedMessage.url || 
                        lastReceivedMessage.image_url ||
                        (lastReceivedMessage.attachment && (lastReceivedMessage.attachment.url || lastReceivedMessage.attachment.imageUrl)) ||
                        (lastReceivedMessage.attachments && lastReceivedMessage.attachments[0] && 
                         (lastReceivedMessage.attachments[0].url || lastReceivedMessage.attachments[0].imageUrl)) ||
                        (lastReceivedMessage.media && (lastReceivedMessage.media.url || lastReceivedMessage.media.imageUrl)) ||
                        lastReceivedMessage.mediaUrl;
        
        if (imageUrl && typeof imageUrl === 'string' && imageUrl.match(/https?:\/\/.*\.(png|jpg|jpeg|gif|webp)/i)) {
          // Speichere Bild-URL im Nachrichten-Objekt für späteren Zugriff
          lastReceivedMessage.imageUrl = imageUrl;
          console.log("✅ Bild-URL aus Nachrichten-Objekt extrahiert:", imageUrl.substring(0, 100));
        }
      }
    }
    
    // Falls keine received-Nachricht gefunden: letzte beliebige Text-Nachricht (aber NICHT "sent")
    // FALLBACK: Wenn keine Nachricht innerhalb von 10 Minuten gefunden wurde, nimm die neueste received-Nachricht (auch wenn älter)
    if (!foundMessageText || foundMessageText.trim() === "") {
      // Versuche zuerst eine beliebige nicht-sent-Nachricht innerhalb des Limits
      const anyMessages = orderedMsgs
        .filter(m => typeof m.text === "string" && m.text.trim() !== "" && m?.type !== "sent" && m?.messageType !== "sent")
        .map(m => {
          let age = null;
          let isValid = true;
          if (m.timestamp) {
            try {
              const msgTime = new Date(m.timestamp).getTime();
              age = now - msgTime;
              if (age > maxAge) {
                console.log(`⚠️ Nachricht zu alt (${Math.round(age / 1000)}s), überspringe:`, m.text.substring(0, 50));
                isValid = false;
              } else {
                console.log(`✅ Nachricht-Alter: ${Math.round(age * 100) / 100}s - OK`);
              }
            } catch (e) {
              console.warn("⚠️ Zeitstempel ungültig, akzeptiere Nachricht als Fallback");
            }
          } else {
            console.warn("⚠️ Kein Zeitstempel vorhanden, akzeptiere Nachricht als Fallback");
          }
          return { message: m, age, isValid };
        });
      
      // 🚨 KRITISCH: Sortiere nach kleinstem Alter (neueste zuerst), nicht nach größtem!
      const lastAny = anyMessages
        .filter(m => m.isValid)
        .sort((a, b) => {
          const ageA = a.age || Infinity;
          const ageB = b.age || Infinity;
          return ageA - ageB; // Kleinste age zuerst = neueste Nachricht
        })[0]?.message;
      
      if (lastAny) {
        // WICHTIG: Prüfe, ob die Nachricht eine Info-Message ist (z.B. Like-Nachricht)
        // Wenn ja, ignoriere sie und suche nach der nächsten echten Nachricht
        if (isInfoMessage(lastAny)) {
          console.log("⚠️ Gefundene Nachricht ist Info-Message (Like), ignoriere sie:", lastAny.text.substring(0, 100) + "...");
          // Suche nach der nächsten echten Nachricht (nicht Info)
          const realAnyMessages = anyMessages
            .filter(m => m.isValid && !isInfoMessage(m.message))
            .sort((a, b) => {
              const ageA = a.age || Infinity;
              const ageB = b.age || Infinity;
              return ageA - ageB;
            });
          if (realAnyMessages.length > 0) {
            foundMessageText = realAnyMessages[0].message.text.trim();
            console.log("✅ Echte Nachricht aus siteInfos.messages (any, nicht sent, NEU, Info-Message übersprungen):", foundMessageText.substring(0, 100) + "...");
          } else {
            foundMessageText = ""; // Keine echte Nachricht gefunden
            console.log("⚠️ Keine echte Nachricht gefunden (nur Info-Messages)");
          }
        } else {
        foundMessageText = lastAny.text.trim();
        console.log("✅ Nachricht aus siteInfos.messages (any, nicht sent, NEU):", foundMessageText.substring(0, 100) + "...");
        }
      } else if (receivedMessages.length > 0) {
        // FALLBACK: Nimm die neueste received-Nachricht, auch wenn sie älter als 10 Minuten ist
        // 🚨 KRITISCH: Sortiere nach kleinstem Alter (neueste zuerst), nicht nach größtem!
        const newestReceived = receivedMessages
          .sort((a, b) => {
            const ageA = a.age || Infinity;
            const ageB = b.age || Infinity;
            return ageA - ageB; // Kleinste age zuerst = neueste Nachricht
          })[0]?.message;
        if (newestReceived) {
          foundMessageText = newestReceived.text.trim();
          console.log(`⚠️ Keine Nachricht innerhalb von 10 Minuten gefunden - verwende neueste received-Nachricht als Fallback:`, foundMessageText.substring(0, 100) + "...");
        }
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
  // WICHTIG: Filtere Info-Messages (wie Like-Benachrichtigungen) raus, da diese nichts mit ASA zu tun haben!
  if (!isLastMessageFromFake && req.body?.siteInfos?.messages?.length) {
    const msgsAll = req.body.siteInfos.messages;
    // KRITISCH: Filtere Info-Messages raus (Like-Benachrichtigungen, etc.) - nur echte Nachrichten zählen!
    const msgs = msgsAll.filter(m => !isInfoMessage(m));
    const list = msgs.length > 0 ? msgs : msgsAll; // Fallback: wenn alle Info sind, nimm alle
    let newestFirst = false;
    try {
      if (list.length > 1) {
        const firstTs = list[0]?.timestamp ? new Date(list[0].timestamp).getTime() : null;
        const lastTs = list[list.length - 1]?.timestamp ? new Date(list[list.length - 1].timestamp).getTime() : null;
        if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
      }
    } catch (e) { /* ignore */ }
    const newestMsg = newestFirst ? list[0] : list[list.length - 1];
    // Prüfe nur echte Nachrichten (nicht Info-Messages wie Like-Benachrichtigungen)
    if (newestMsg && !isInfoMessage(newestMsg) && (newestMsg?.type === "sent" || newestMsg?.messageType === "sent")) {
      isLastMessageFromFake = true;
      console.log("✅ ASA erkannt über siteInfos.messages (neueste echte Nachricht ist sent, Info-Messages ignoriert).");
    }
    // Zusätzlich: wenn die letzten 2 echten Nachrichten (neueste zuerst) beide sent sind -> ASA
    const ordered = newestFirst ? list : [...list].reverse();
    const lastRealMsg = ordered[0];
    const secondLastRealMsg = ordered[1];
    if (lastRealMsg && !isInfoMessage(lastRealMsg) && (lastRealMsg?.type === "sent" || lastRealMsg?.messageType === "sent") && 
        (!secondLastRealMsg || !isInfoMessage(secondLastRealMsg)) && 
        (!secondLastRealMsg || secondLastRealMsg?.type === "sent" || secondLastRealMsg?.messageType === "sent")) {
      isLastMessageFromFake = true;
      console.log("✅ ASA erkannt über letzte 2 echten Nachrichten (sent,sent) – Info-Messages ignoriert.");
    }
    // WICHTIG für iluvo: Prüfe auch auf "ASA Stufe" im Text oder andere ASA-Indikatoren
    if (platformId && typeof platformId === "string" && platformId.toLowerCase().includes('iluvo')) {
      // Bei iluvo: Wenn die neueste Nachricht "sent" ist UND messageText leer ist, ist es wahrscheinlich ASA
      if ((newestMsg?.type === "sent" || newestMsg?.messageType === "sent") && (!foundMessageText || foundMessageText.trim() === "")) {
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt für iluvo: neueste Nachricht ist sent und messageText ist leer.");
      }
      // Bei iluvo: Prüfe auch auf "ASA" im pageUrl oder anderen Feldern
      if (pageUrl && (pageUrl.includes('asa') || pageUrl.includes('ASA'))) {
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt für iluvo über pageUrl.");
      }
      // KRITISCH für iluvo: Prüfe auf "ASA Stufe" in siteInfos oder anderen Feldern
      const siteInfosStr = JSON.stringify(req.body?.siteInfos || {}).toLowerCase();
      if (siteInfosStr.includes('asa stufe') || siteInfosStr.includes('asa-stufe') || siteInfosStr.includes('der dialog ist eine asa')) {
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt für iluvo über 'ASA Stufe' in siteInfos.");
      }
      // Bei iluvo: Wenn die letzte Nachricht "sent" ist, ist es IMMER ASA (auch wenn messageText vorhanden ist)
      if (newestMsg?.type === "sent" || newestMsg?.messageType === "sent") {
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt für iluvo: neueste Nachricht ist sent (unabhängig von messageText).");
      }
    }
    
    // WICHTIG für FPC: Spezielle ASA-Erkennung (NUR für FPC, nicht für Iluvo!)
    // Bei FPC: Wenn die letzte echte Nachricht (ohne Info-Messages wie Like-Benachrichtigungen) vom Fake/Moderator war,
    // ist es ein ASA-Fall - unabhängig davon, ob der Kunde das Profil geliked hat oder nicht
    const isFPC = (platformId && typeof platformId === "string" && platformId.toLowerCase().includes('fpc')) || 
                  (req.body?.siteInfos?.origin && typeof req.body.siteInfos.origin === "string" && req.body.siteInfos.origin.toLowerCase().includes('fpc')) ||
                  (pageUrl && typeof pageUrl === "string" && pageUrl.includes('fpc'));
    
    if (isFPC && !isLastMessageFromFake) {
      // Filtere Info-Messages raus (Like-Benachrichtigungen, etc.) - nur echte Nachrichten zählen!
      const realMsgs = msgsAll.filter(m => !isInfoMessage(m));
      if (realMsgs.length > 0) {
        let realNewestFirst = false;
        try {
          if (realMsgs.length > 1) {
            const firstTs = realMsgs[0]?.timestamp ? new Date(realMsgs[0].timestamp).getTime() : null;
            const lastTs = realMsgs[realMsgs.length - 1]?.timestamp ? new Date(realMsgs[realMsgs.length - 1].timestamp).getTime() : null;
            if (firstTs && lastTs && firstTs > lastTs) realNewestFirst = true;
          }
        } catch (e) { /* ignore */ }
        const orderedReal = realNewestFirst ? realMsgs : [...realMsgs].reverse();
        const lastRealMsg = orderedReal[0];
        // Wenn die letzte echte Nachricht (ohne Info-Messages) vom Fake/Moderator war, ist es ASA
        if (lastRealMsg && (lastRealMsg?.type === "sent" || lastRealMsg?.messageType === "sent")) {
          isLastMessageFromFake = true;
          console.log("✅ ASA erkannt für FPC: letzte echte Nachricht (ohne Info-Messages wie Like) ist sent.");
        }
      }
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
  // KRITISCH: Nur prüfen, wenn foundMessageText vorhanden ist und nicht leer!
  if (!foundMessageText || foundMessageText.trim() === "") {
    console.log("⚠️ foundMessageText ist leer - überspringe Blockierungsprüfung");
  } else {
    console.log("🔍 DEBUG: Prüfe Nachricht auf Blockierung:", foundMessageText.substring(0, 100) + "...");
  }
  const isBlocked = foundMessageText && foundMessageText.trim() !== "" ? isMinorMention(foundMessageText) : false;
  if (isBlocked) {
    console.error("🚨🚨🚨 BLOCKIERT: Minderjährige oder strafrechtliche Themen erkannt! 🚨🚨🚨");
    console.error("🚨 Erkannte Nachricht:", foundMessageText.substring(0, 200));
    console.error("🔍 DEBUG: Prüfe warum blockiert...");
    console.error("🔍 DEBUG: Vollständige Nachricht:", foundMessageText);
    
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

  // WICHTIG: Prüfe ZUERST auf ASA-Fall, BEVOR wir auf leere messageText prüfen!
  // Bei ASA-Fällen ist foundMessageText normalerweise leer, aber wir wollen trotzdem eine ASA generieren!
  
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
    // Extrahiere Bild-URLs aus dem Text
    let imageUrls = extractImageUrls(foundMessageText);
    
    // 🆕 NEU: Extrahiere auch Bilder aus verschiedenen Quellen
    // 1. Prüfe assetsToSend (falls Extension Bilder dort sendet)
    if (imageUrls.length === 0 && assetsToSend && Array.isArray(assetsToSend) && assetsToSend.length > 0) {
      for (const asset of assetsToSend) {
        const assetUrl = asset.url || asset.imageUrl || asset.src || asset.image_url;
        if (assetUrl && typeof assetUrl === 'string' && assetUrl.match(/https?:\/\/.*\.(png|jpg|jpeg|gif|webp)/i)) {
          imageUrls.push(assetUrl);
          console.log("✅ Bild-URL aus assetsToSend extrahiert:", assetUrl.substring(0, 100));
          break; // Nimm nur das erste Bild
        }
      }
    }
    
    // 2. Prüfe siteInfos.messages (falls Bilder dort als Objekte enthalten sind)
    if (imageUrls.length === 0 && req.body?.siteInfos?.messages) {
      const msgs = req.body.siteInfos.messages;
      const now = Date.now();
      const maxAge = 10 * 60 * 1000; // 10 Minuten
      
      // Finde neueste received-Nachricht mit Bild
      const receivedWithImages = msgs
        .filter(m => {
          // Prüfe ob Nachricht received ist und nicht zu alt
          if (m?.type !== "received" && m?.messageType !== "received") return false;
          if (m.timestamp) {
            try {
              const msgTime = new Date(m.timestamp).getTime();
              const age = now - msgTime;
              if (age > maxAge) return false;
            } catch (e) {
              return false;
            }
          }
          // Prüfe ob Nachricht ein Bild enthält (verschiedene mögliche Felder)
          return !!(m.image || m.imageUrl || (m.url && m.url.match(/\.(png|jpg|jpeg|gif|webp)/i)) || 
                  m.image_url || m.attachment || m.attachments || m.media || m.mediaUrl);
        })
        .sort((a, b) => {
          // Sortiere nach Zeitstempel (neueste zuerst)
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timeB - timeA;
        });
      
      if (receivedWithImages.length > 0) {
        const msgWithImage = receivedWithImages[0];
        // Extrahiere Bild-URL aus verschiedenen möglichen Feldern
        const imageUrl = msgWithImage.image || msgWithImage.imageUrl || 
                        (msgWithImage.url && msgWithImage.url.match(/https?:\/\/.*\.(png|jpg|jpeg|gif|webp)/i) ? msgWithImage.url : null) ||
                        msgWithImage.image_url || msgWithImage.mediaUrl ||
                        (msgWithImage.attachment && (msgWithImage.attachment.url || msgWithImage.attachment.imageUrl)) ||
                        (msgWithImage.attachments && msgWithImage.attachments[0] && 
                         (msgWithImage.attachments[0].url || msgWithImage.attachments[0].imageUrl)) ||
                        (msgWithImage.media && (msgWithImage.media.url || msgWithImage.media.imageUrl));
        
        if (imageUrl && typeof imageUrl === 'string' && imageUrl.match(/https?:\/\//)) {
          imageUrls = [imageUrl];
          console.log("✅ Bild-URL aus siteInfos.messages extrahiert:", imageUrl.substring(0, 100));
        }
      }
    }
    
    // 3. Prüfe metaData (ähnlich wie Profilbilder - customerProfilePic, moderatorProfilePic)
    if (imageUrls.length === 0 && req.body?.siteInfos?.metaData) {
      const metaData = req.body.siteInfos.metaData;
      const possibleImageFields = ['lastImageUrl', 'lastImage', 'customerImageUrl', 'customerImage', 'imageUrl', 'image'];
      for (const field of possibleImageFields) {
        if (metaData[field] && typeof metaData[field] === 'string' && metaData[field].match(/https?:\/\/.*\.(png|jpg|jpeg|gif|webp)/i)) {
          imageUrls = [metaData[field]];
          console.log(`✅ Bild-URL aus metaData.${field} extrahiert:`, metaData[field].substring(0, 100));
          break;
        }
      }
    }
    
    // 4. Prüfe auch direkt in req.body nach Bild-Feldern (falls Extension sie dort sendet)
    if (imageUrls.length === 0) {
      const possibleImageFields = ['imageUrl', 'image_url', 'image', 'attachmentUrl', 'mediaUrl'];
      for (const field of possibleImageFields) {
        if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].match(/https?:\/\/.*\.(png|jpg|jpeg|gif|webp)/i)) {
          imageUrls = [req.body[field]];
          console.log(`✅ Bild-URL aus req.body.${field} extrahiert:`, req.body[field].substring(0, 100));
          break;
        }
      }
    }
    
    // 5. DEBUG: Logge alle Nachrichten-Objekte, wenn ein Bild erwartet wird aber nicht gefunden wurde
    if (imageUrls.length === 0 && foundMessageText && foundMessageText.toLowerCase().includes("bild")) {
      console.log("🔍 DEBUG: Bild erwartet aber nicht gefunden. Prüfe siteInfos.messages:");
      if (req.body?.siteInfos?.messages) {
        const msgs = req.body.siteInfos.messages;
        const recentReceived = msgs
          .filter(m => (m?.type === "received" || m?.messageType === "received") && m.timestamp)
          .sort((a, b) => {
            const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return timeB - timeA;
          })
          .slice(0, 3); // Nur die 3 neuesten
        
        recentReceived.forEach((msg, idx) => {
          console.log(`  Nachricht ${idx + 1}:`, {
            text: msg.text?.substring(0, 50),
            type: msg.type || msg.messageType,
            timestamp: msg.timestamp,
            keys: Object.keys(msg),
            hasImage: !!(msg.image || msg.imageUrl || msg.url || msg.attachment || msg.attachments || msg.media)
          });
        });
      }
    }
    
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
          model: AI_MODEL,
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
    if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations)) {
      console.log(`✅ Training Data geladen: ${trainingData.conversations.length} Gespräche`);
    } else {
      console.log(`⚠️ Training Data geladen, aber keine Gespräche gefunden`);
    }
    } catch (err) {
      console.error('⚠️ Fehler beim Laden der Training Data:', err.message);
    }
    
    // Prüfe ASA-Fall: Wenn die letzte Nachricht vom FAKE kommt, schreibe eine Reaktivierungsnachricht
    // WICHTIG: Nur wenn explizit signalisiert, sonst könnte es andere Gründe geben
    if (isLastMessageFromFake) {
      console.log("🔄 ASA-Fall erkannt: Letzte Nachricht vom Fake, generiere Reaktivierungsnachricht...");
      
      // KRITISCH: Bei ASA die Kunden-Nachricht IGNORIEREN - setze foundMessageText auf leer!
      // Die gefundene Nachricht ist wahrscheinlich eine alte Moderator-Nachricht, nicht die neue Kunden-Nachricht!
      if (foundMessageText && foundMessageText.trim() !== "") {
        console.log("⚠️ ASA erkannt - IGNORIERE gefundene Kunden-Nachricht (wahrscheinlich falsch):", foundMessageText.substring(0, 100) + "...");
        foundMessageText = ""; // Setze auf leer, damit sie nicht verwendet wird
      }
      
      // Zähle Kunden-Nachrichten, um Neukunde vs. Langzeitkunde zu unterscheiden
      const asaCustomerMessageCount = countCustomerMessages(req.body?.siteInfos?.messages || []);
      const isLongTermCustomer = asaCustomerMessageCount >= 10;
      console.log(`📊 Kunden-Nachrichten: ${asaCustomerMessageCount} (${isLongTermCustomer ? "Langzeitkunde" : "Neukunde"})`);
      
      // KRITISCH: KEINE Orientierung an den letzten Moderator-Nachrichten aus dem Chat!
      // Die KI soll sich NUR an den Training-Daten orientieren!
      // Die analyzeWritingStyle Funktion wird NICHT mehr verwendet, da wir uns nur an Training-Daten orientieren!
      // styleContext wird hier nicht verwendet, da ASA nur Training-Daten verwendet
      
      // WICHTIG: Suche zuerst nach ASA-Beispielen in den Training-Daten
      let asaMessage = null;
      let asaTrainingExamples = [];
      
      // 🚨 KRITISCH: Analysiere Chat-Kontext FÜR ALLE ASA-Fälle (auch wenn keine Training-Daten vorhanden sind)
      // Prüfe den Chat-Kontext: Gibt es Erwähnungen von Nummern, Treffen, etc.?
      // Verwende lokale Variable, um Konflikt mit conversationContext im Haupt-Code zu vermeiden
    const asaConversationContext = (compressConversation(req.body?.siteInfos?.messages || [], 10) || "").toLowerCase();
      
      // 🚨 WICHTIG: Prüfe nicht nur, ob "nummer" erwähnt wird, sondern ob der Kunde eine Nummer WILL
      // STANDARD: Bei ASA will der Kunde KEINE Nummer, es sei denn, er fragt EXPLIZIT danach!
      // Wenn der Kunde sagt "Ich gebe meine Nummer nicht raus" oder "keine Nummer", dann will er KEINE Nummer!
      const hasNegativeNumberSignals = (
        asaConversationContext.includes("nummer nicht") || 
        asaConversationContext.includes("keine nummer") || 
        asaConversationContext.includes("nummer nicht raus") ||
        asaConversationContext.includes("nummer nicht geben") ||
        asaConversationContext.includes("nummer nicht weitergeben") ||
        asaConversationContext.includes("nummer nicht einfach") ||
        asaConversationContext.includes("nummer nicht so") ||
        asaConversationContext.includes("nummer ungerne") ||
        asaConversationContext.includes("nummer ungern") ||
        asaConversationContext.includes("nummer nicht gerne") ||
        asaConversationContext.includes("nummer nicht gern") ||
        asaConversationContext.includes("nummer nicht im internet") ||
        asaConversationContext.includes("nummer nicht weiter geben") ||
        asaConversationContext.includes("meine nummer ungerne") ||
        asaConversationContext.includes("meine nummer ungern") ||
        asaConversationContext.includes("nummer nicht weitergebe") ||
        asaConversationContext.includes("nummer nicht weiter gebe")
      );
      
      const hasPositiveNumberSignals = (
        asaConversationContext.includes("deine nummer") ||
        asaConversationContext.includes("ihre nummer") ||
        asaConversationContext.includes("nummer geben") ||
        asaConversationContext.includes("nummer schicken") ||
        asaConversationContext.includes("nummer senden") ||
        asaConversationContext.includes("kannst du mir deine nummer") ||
        asaConversationContext.includes("kannst du mir ihre nummer")
      );
      
      // Kunde will Nummer NUR wenn positive Signale vorhanden UND keine negativen Signale
      const customerWantsNumber = hasPositiveNumberSignals && !hasNegativeNumberSignals;
      
      console.log(`🔍 [ASA] Nummern-Analyse: negativeSignals=${hasNegativeNumberSignals}, positiveSignals=${hasPositiveNumberSignals}, customerWantsNumber=${customerWantsNumber}`);
      
      const hasNegativeMeetingSignals = (
        asaConversationContext.includes("treffen nicht") || 
        asaConversationContext.includes("kein treffen") ||
        asaConversationContext.includes("treffen nicht wollen")
      );
      
      const hasPositiveMeetingSignals = (
        asaConversationContext.includes("treffen wollen") || 
        asaConversationContext.includes("treffen können") ||
        asaConversationContext.includes("wollen treffen") ||
        asaConversationContext.includes("können treffen") ||
        asaConversationContext.includes("wollen wir uns treffen") ||
        asaConversationContext.includes("können wir uns treffen")
      );
      
      // Kunde will Treffen NUR wenn positive Signale vorhanden UND keine negativen Signale
      const customerWantsMeeting = hasPositiveMeetingSignals && !hasNegativeMeetingSignals;
      
      console.log(`🔍 [ASA] Treffen-Analyse: negativeSignals=${hasNegativeMeetingSignals}, positiveSignals=${hasPositiveMeetingSignals}, customerWantsMeeting=${customerWantsMeeting}`);
      
      // 🚨 WICHTIG: Definiere filteredASAExamples außerhalb des if-Blocks, damit es später verfügbar ist
      let filteredASAExamples = [];
      
      if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations)) {
        // Suche nach ASA-Beispielen (situation: "ASA" oder ähnlich)
        asaTrainingExamples = trainingData.conversations.filter(conv => {
          const situation = (conv.situation || "").toLowerCase();
          return situation.includes("asa") || situation.includes("reaktivierung") || 
               (conv.customerMessage && typeof conv.customerMessage === "string" && conv.customerMessage.toLowerCase().includes("nicht mehr")) ||
               (conv.moderatorResponse && typeof conv.moderatorResponse === "string" && conv.moderatorResponse.toLowerCase().includes("warum schreibst du"));
      });
      
      // Wenn keine situationsspezifischen ASA-Beispiele gefunden, suche nach generischen ASA-Beispielen
      if (asaTrainingExamples.length === 0) {
        console.log("⚠️ Keine situationsspezifischen ASA-Beispiele gefunden, suche nach generischen ASA-Beispielen...");
        // Suche nach generischen ASA-Beispielen (moderatorResponse mit ASA-typischen Mustern)
        asaTrainingExamples = trainingData.conversations.filter(conv => {
          if (!conv.moderatorResponse || typeof conv.moderatorResponse !== "string" || conv.moderatorResponse.trim().length === 0) {
            return false;
          }
          const response = (conv.moderatorResponse || "").toLowerCase();
          // ASA-typische Muster: Fragen nach fehlender Kommunikation
          return response.includes("warum schreibst") || 
                 response.includes("warum antwortest") ||
                 response.includes("nicht mehr") ||
                 response.includes("kein interesse") ||
                 response.includes("verloren") ||
                 response.includes("funkstille") ||
                 response.includes("hängen lassen");
        });
      }
        
        if (asaTrainingExamples.length > 0) {
          // 🚨 KRITISCH: Filtere ASA-Beispiele, die über spezifische Themen sprechen, die NICHT im aktuellen Kontext sind
          
          // Filtere ASA-Beispiele, die über Themen sprechen, die NICHT im Kontext sind ODER die der Kunde NICHT will
          filteredASAExamples = asaTrainingExamples.filter(example => {
            const response = (example.moderatorResponse || "").toLowerCase();
            
            // 🚨 KRITISCH: Wenn der Kunde KEINE Nummer will, filtere ALLE Nummern-Beispiele raus!
            if (!customerWantsNumber && (response.includes("nummer") || response.includes("telefon") || response.includes("handy"))) {
              console.log(`🚫 Filtere ASA-Beispiel raus (Kunde will keine Nummer): ${response.substring(0, 80)}...`);
              return false;
            }
            
            // 🚨 KRITISCH: Wenn der Kunde KEIN Treffen will, filtere ALLE Treffen-Beispiele raus!
            if (!customerWantsMeeting && (response.includes("treffen") || response.includes("sehen") || response.includes("kennenlernen"))) {
              console.log(`🚫 Filtere ASA-Beispiel raus (Kunde will kein Treffen): ${response.substring(0, 80)}...`);
              return false;
            }
            
            return true;
          });
          
          // Falls alle Beispiele gefiltert wurden, verwende NUR die, die KEINE Nummern/Treffen enthalten (Fallback)
          if (filteredASAExamples.length === 0) {
            console.warn("⚠️ Alle ASA-Beispiele wurden gefiltert (Themen passen nicht zum Kontext), filtere nach Nummern/Treffen raus...");
            filteredASAExamples = asaTrainingExamples.filter(example => {
              const response = (example.moderatorResponse || "").toLowerCase();
              // Im Fallback: NUR Beispiele ohne Nummern/Treffen verwenden
              return !response.includes("nummer") && 
                     !response.includes("telefon") && 
                     !response.includes("handy") &&
                     !response.includes("treffen") && 
                     !response.includes("sehen") && 
                     !response.includes("kennenlernen");
            });
            
          // Falls immer noch keine gefunden, versuche generische ASA-Beispiele (KEINE ASA generieren erst nach Fallback!)
            if (filteredASAExamples.length === 0) {
            console.warn("⚠️ KEINE passenden ASA-Beispiele in conversations gefunden - versuche generische ASA-Beispiele...");
              // NICHT asaMessage = null setzen, damit Fallback-Code ausgeführt wird!
            }
          }
          
          // Wähle zufällig ein ASA-Beispiel aus den gefilterten Training-Daten (NUR wenn welche vorhanden sind!)
          if (filteredASAExamples.length > 0 && !asaMessage) {
            const randomASA = filteredASAExamples[Math.floor(Math.random() * filteredASAExamples.length)];
            // KRITISCH: Verwende NUR moderatorResponse, NIEMALS customerMessage!
            asaMessage = randomASA.moderatorResponse || null;
          // Prüfe, ob moderatorResponse leer ist oder die Kunden-Nachricht enthält
          if (!asaMessage || asaMessage.trim() === "") {
            console.warn("⚠️ ASA-Beispiel hat keine moderatorResponse, überspringe...");
            asaMessage = null;
          } else {
            // Prüfe, ob die moderatorResponse die Kunden-Nachricht ist (Echo-Erkennung)
            const customerMsg = randomASA.customerMessage || "";
            if (customerMsg && typeof customerMsg === "string" && asaMessage && typeof asaMessage === "string" && asaMessage.toLowerCase().includes(customerMsg.toLowerCase().substring(0, 50))) {
              console.warn("⚠️ ASA-Beispiel echo't die Kunden-Nachricht, überspringe...");
              asaMessage = null;
            } else {
              console.log(`📚 ASA-Beispiel aus Training-Daten gefunden (${filteredASAExamples.length} von ${asaTrainingExamples.length} verfügbar nach Filterung):`, asaMessage.substring(0, 100) + "...");
            }
            }
          }
        }
      }
      
    // Fallback: Wenn keine ASA-Beispiele aus Training-Daten gefunden wurden, verwende generische ASA-Beispiele aus trainingData.asaExamples
      if (!asaMessage) {
      console.warn("⚠️ Keine ASA-Beispiele in conversations gefunden - suche nach generischen ASA-Beispielen in trainingData.asaExamples...");
      
      // Prüfe, ob es ein separates asaExamples-Feld in den Training-Daten gibt
      if (trainingData && trainingData.asaExamples && Array.isArray(trainingData.asaExamples) && trainingData.asaExamples.length > 0) {
        console.log(`✅ ${trainingData.asaExamples.length} generische ASA-Beispiele in trainingData.asaExamples gefunden`);
        
        // Filtere nach Kontext (keine Nummern/Treffen, wenn Kunde das nicht will)
        let filteredGenericASAs = trainingData.asaExamples.filter(example => {
          // Extrahiere den Text aus dem Beispiel (unterstütze verschiedene Formate)
          // WICHTIG: asaMessage ist das Hauptfeld für generische ASA-Beispiele!
          let response = "";
          if (typeof example === 'string') {
            response = example;
          } else if (typeof example === 'object' && example !== null) {
            response = example.asaMessage || example.moderatorResponse || example.text || example.message || example.response || example.asa || "";
          }
          
          const responseLower = response.toLowerCase();
          
          // Wenn der Kunde KEINE Nummer will, filtere Nummern-Beispiele raus
          if (!customerWantsNumber && (responseLower.includes("nummer") || responseLower.includes("telefon") || responseLower.includes("handy"))) {
            return false;
          }
          
          // Wenn der Kunde KEIN Treffen will, filtere Treffen-Beispiele raus
          if (!customerWantsMeeting && (responseLower.includes("treffen") || responseLower.includes("sehen") || responseLower.includes("kennenlernen"))) {
            return false;
          }
          
          // WICHTIG: Nur gültige Beispiele zurückgeben (nicht leer)
          return response.trim().length > 0;
        });
        
        // Falls alle gefiltert wurden, verwende NUR die ohne Nummern/Treffen
        if (filteredGenericASAs.length === 0) {
          console.warn("⚠️ Alle generischen ASA-Beispiele wurden gefiltert, verwende nur die ohne Nummern/Treffen...");
          filteredGenericASAs = trainingData.asaExamples.filter(example => {
            // Extrahiere den Text aus dem Beispiel (unterstütze verschiedene Formate)
            // WICHTIG: asaMessage ist das Hauptfeld für generische ASA-Beispiele!
            let response = "";
            if (typeof example === 'string') {
              response = example;
            } else if (typeof example === 'object' && example !== null) {
              response = example.asaMessage || example.moderatorResponse || example.text || example.message || example.response || example.asa || "";
            }
            
            const responseLower = response.toLowerCase();
            const hasNoNumber = !responseLower.includes("nummer") && !responseLower.includes("telefon") && !responseLower.includes("handy");
            const hasNoMeeting = !responseLower.includes("treffen") && !responseLower.includes("sehen") && !responseLower.includes("kennenlernen");
            
            // WICHTIG: Nur gültige Beispiele zurückgeben (nicht leer)
            return hasNoNumber && hasNoMeeting && response.trim().length > 0;
          });
        }
        
        // WICHTIG: Wenn immer noch keine gefilterten gefunden wurden, verwende ALLE generischen ASA-Beispiele (generische ASA Neukunde)
        if (filteredGenericASAs.length === 0) {
          console.warn("⚠️ Auch nach Filterung keine generischen ASA-Beispiele ohne Nummern/Treffen gefunden, verwende ALLE generischen ASA-Beispiele...");
          filteredGenericASAs = trainingData.asaExamples;
        }
        
        // Wähle zufällig ein generisches ASA-Beispiel
        if (filteredGenericASAs.length > 0) {
          const randomGenericASA = filteredGenericASAs[Math.floor(Math.random() * filteredGenericASAs.length)];
          console.log(`🔍 DEBUG: randomGenericASA Typ: ${typeof randomGenericASA}, Wert:`, typeof randomGenericASA === 'string' ? randomGenericASA.substring(0, 100) : JSON.stringify(randomGenericASA).substring(0, 200));
          
          // Unterstütze sowohl String-Arrays als auch Objekt-Arrays
          if (typeof randomGenericASA === 'string') {
            asaMessage = randomGenericASA;
          } else if (typeof randomGenericASA === 'object' && randomGenericASA !== null) {
            // Prüfe verschiedene mögliche Felder (asaMessage ist das Hauptfeld für generische ASA-Beispiele!)
            asaMessage = randomGenericASA.asaMessage || randomGenericASA.moderatorResponse || randomGenericASA.text || randomGenericASA.message || randomGenericASA.response || randomGenericASA.asa || "";
            console.log(`🔍 DEBUG: Objekt-Felder: asaMessage=${!!randomGenericASA.asaMessage}, moderatorResponse=${!!randomGenericASA.moderatorResponse}, text=${!!randomGenericASA.text}, message=${!!randomGenericASA.message}, response=${!!randomGenericASA.response}, asa=${!!randomGenericASA.asa}`);
          } else {
            asaMessage = "";
          }
          
          if (asaMessage && asaMessage.trim().length > 0) {
            asaMessage = asaMessage.trim();
            console.log(`✅ Generisches ASA-Beispiel ausgewählt (${asaMessage.length} Zeichen):`, asaMessage.substring(0, 100) + "...");
          } else {
            console.error("❌ Generisches ASA-Beispiel ist leer oder ungültig!");
            console.error("❌ DEBUG: randomGenericASA vollständig:", JSON.stringify(randomGenericASA));
            asaMessage = null;
          }
        } else {
          console.error("❌ Keine generischen ASA-Beispiele verfügbar (filteredGenericASAs ist leer)!");
        }
      } else {
        console.error("❌ trainingData.asaExamples ist leer oder nicht vorhanden!");
      }
      
      // Wenn immer noch keine gefunden, wurde auch keine generische ASA Neukunde aus trainingData.asaExamples gefunden
      // Die generische ASA Neukunde kommt aus Training-Daten (trainingData.asaExamples)
      // Wenn diese leer sind oder alle gefiltert wurden, wird keine ASA generiert
      if (!asaMessage) {
        console.error("❌ FEHLER: Keine ASA generiert - weder aus conversations noch aus asaExamples gefunden!");
      }
    }
    
    // asaMessage sollte jetzt immer gesetzt sein (entweder aus Training-Daten oder generische ASA Neukunde)
    if (asaMessage) {
      // Nur wenn asaMessage vorhanden ist, führe ASA-Generierung durch
      
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
          // 🚨 KRITISCH: Verwende NUR die GEFILTERTEN Beispiele, nicht alle!
          let asaTrainingContext = "";
          if (filteredASAExamples && filteredASAExamples.length > 0) {
            asaTrainingContext = `\n\n📚📚📚 ASA-BEISPIELE AUS TRAINING-DATEN (ORIENTIERE DICH DARAN!): 📚📚📚\n`;
            // Verwende NUR die gefilterten Beispiele (max. 5 für Kontext)
            filteredASAExamples.slice(0, 5).forEach((example, idx) => {
              asaTrainingContext += `\nASA-Beispiel ${idx + 1}:\n`;
              asaTrainingContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
            });
            asaTrainingContext += `\n\n⚠️⚠️⚠️ WICHTIG: ⚠️⚠️⚠️
- Orientiere dich am SCHREIBSTIL und der WORTWAHL aus diesen ASA-Beispielen!
- Verwende ähnliche Formulierungen und Fragen wie in den Beispielen!
- KEINE generischen Fragen wie "Was denkst du?" - verwende Fragen aus den Beispielen!
- Übernehme den TON und die FORMULIERUNGEN aus den ASA-Beispielen!\n\n`;
          } else if (asaTrainingExamples.length > 0) {
            // Fallback: Wenn keine gefilterten Beispiele vorhanden, verwende alle, aber mit Warnung
            console.warn("⚠️ Keine gefilterten ASA-Beispiele, verwende alle als Fallback (könnte problematisch sein)");
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
          
          // 🚨 KRITISCH: Baue expliziten Kontext-Hinweis für die KI
          let asaContextWarning = "";
          if (!customerWantsNumber) {
            asaContextWarning += `\n🚨🚨🚨 ABSOLUT VERBOTEN - NUMMERN: 🚨🚨🚨\n`;
            asaContextWarning += `- Der Kunde hat EXPLIZIT gesagt, dass er KEINE Nummer will oder gibt!\n`;
            asaContextWarning += `- NIEMALS über Nummern, Telefonnummern, Handynummern oder ähnliches sprechen!\n`;
            asaContextWarning += `- NIEMALS fragen "Kannst du mir deine Nummer geben?" oder ähnliches!\n`;
            asaContextWarning += `- NIEMALS auf Nummern-Themen eingehen, auch wenn sie im Chat erwähnt wurden!\n`;
            asaContextWarning += `- FOKUS: NUR über die fehlende Kommunikation sprechen!\n\n`;
          }
          if (!customerWantsMeeting) {
            asaContextWarning += `\n🚨🚨🚨 ABSOLUT VERBOTEN - TREFFEN: 🚨🚨🚨\n`;
            asaContextWarning += `- Der Kunde hat EXPLIZIT gesagt, dass er KEIN Treffen will!\n`;
            asaContextWarning += `- NIEMALS über Treffen, Kennenlernen oder ähnliches sprechen!\n`;
            asaContextWarning += `- FOKUS: NUR über die fehlende Kommunikation sprechen!\n\n`;
          }
          
          // 🚨 KRITISCH: Bei ASA NUR die ASA-Training-Daten verwenden, NICHT den Chat-Verlauf!
          // Der Chat-Verlauf wird NUR für die Analyse verwendet (ob Kunde Nummern/Treffen will), aber NICHT in den Prompt eingefügt!
          const asaExtensionPrompt = `Du erweiterst eine Reaktivierungsnachricht (ASA) auf mindestens 150 Zeichen. Die Nachricht soll natürlich und menschlich klingen, nicht abgehackt.${asaTrainingContext}${asaContextWarning}

🚨🚨🚨 ABSOLUT KRITISCH - REAKTIVIERUNGSNACHRICHT (ASA): 🚨🚨🚨
- Dies ist eine REAKTIVIERUNGSNACHRICHT - der Kunde hat NICHT mehr geschrieben!
- Die Nachricht soll fragen, warum der Kunde nicht mehr schreibt!
- Die Nachricht soll zeigen, dass du den Kunden vermisst oder enttäuscht bist, dass er nicht mehr schreibt!
- NIEMALS die Kunden-Nachricht echo'en oder wiederholen!
- FOKUS: NUR über die fehlende Kommunikation sprechen - warum schreibt der Kunde nicht mehr?
- NIEMALS über Themen sprechen, die NICHT in den ASA-Beispielen aus den Training-Daten stehen!

WICHTIG: 
- Verwende KEINE Bindestriche (-), KEINE Anführungszeichen (" oder ') und KEIN "ß" (immer "ss" verwenden)
- 🚨🚨🚨 KRITISCH: Orientiere dich NUR an den ASA-BEISPIELEN aus den TRAINING-DATEN! NICHT an den letzten Moderator-Nachrichten aus dem Chat! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Der Chat-Verlauf hat NICHTS mit der ASA zu tun! Verwende NUR die ASA-Beispiele oben! 🚨🚨🚨
- ${isLongTermCustomer ? "Sei persönlicher und emotionaler, da es ein Langzeitkunde ist." : "Sei freundlich und hoffnungsvoll, da es ein Neukunde ist."}
- ${(filteredASAExamples && filteredASAExamples.length > 0) || asaTrainingExamples.length > 0 ? "Orientiere dich am SCHREIBSTIL und der WORTWAHL aus den ASA-Beispielen oben! Verwende ähnliche Formulierungen und Fragen!" : ""}
- KEINE generischen Fragen wie "Was denkst du?" - verwende passende Fragen basierend auf den ASA-Beispielen!

Die zu erweiternde Nachricht:
"${asaMessage}"

Antworte NUR mit der vollständigen, erweiterten Reaktivierungsnachricht (mindestens 150 Zeichen), keine Erklärungen. Die Nachricht soll fragen, warum der Kunde nicht mehr schreibt!`;
          
          // 🚨 KRITISCH: Baue System-Prompt mit expliziten Verboten basierend auf Analyse
          let asaSystemForbidden = "";
          if (!customerWantsNumber) {
            asaSystemForbidden += " 🚨🚨🚨 ABSOLUT VERBOTEN: NIEMALS über Nummern, Telefonnummern, Handynummern sprechen! Der Kunde will KEINE Nummer! 🚨🚨🚨";
          }
          if (!customerWantsMeeting) {
            asaSystemForbidden += " 🚨🚨🚨 ABSOLUT VERBOTEN: NIEMALS über Treffen, Kennenlernen sprechen! Der Kunde will KEIN Treffen! 🚨🚨🚨";
          }
          
          // 🧠 LERN-SYSTEM: Füge bewährte ASA-Muster hinzu (basierend auf Feedback-Analyse)
          let asaLearningContext = '';
          try {
            const { generateLearningContext, getLearningStats } = require('../utils/learning-system');
            const learningStats = await getLearningStats();
            if (learningStats && Object.keys(learningStats).length > 0) {
              // Für ASAs: Verwende Situation "ASA" oder "Reaktivierung"
              const asaLearningContextResult = await generateLearningContext('', 'ASA', learningStats);
              if (asaLearningContextResult) {
                asaLearningContext = asaLearningContextResult;
                console.log(`🧠 Learning-System: Bewährte ASA-Muster hinzugefügt`);
              }
            }
          } catch (err) {
            console.warn('⚠️ Fehler beim Laden des Learning-Systems für ASA (nicht kritisch):', err.message);
          }
          
          const asaSystemPrompt = `Du erweiterst Reaktivierungsnachrichten (ASA) auf mindestens 150 Zeichen. Fokus auf Reaktivierung - der Kunde hat NICHT mehr geschrieben! Die Nachricht soll fragen, warum der Kunde nicht mehr schreibt. Natürlicher Ton, keine Bindestriche/Anführungszeichen/ß. ${isLongTermCustomer ? "Für Langzeitkunden: persönlicher, emotionaler Ton." : "Für Neukunden: freundlich, hoffnungsvoll."} 🚨🚨🚨 KRITISCH: Orientiere dich NUR an den ASA-BEISPIELEN aus den TRAINING-DATEN! NICHT an den letzten Moderator-Nachrichten aus dem Chat! Der Chat-Verlauf hat NICHTS mit der ASA zu tun! 🚨🚨🚨${(filteredASAExamples && filteredASAExamples.length > 0) || asaTrainingExamples.length > 0 ? " Orientiere dich am Schreibstil und der Wortwahl aus den ASA-Beispielen im userPrompt. Verwende KEINE generischen Fragen wie 'Was denkst du?' - verwende passende Fragen basierend auf den ASA-Beispielen!" : ""} 🚨🚨🚨 KRITISCH: NIEMALS die Kunden-Nachricht echo'en oder wiederholen!${asaSystemForbidden} NUR über die fehlende Kommunikation sprechen - warum schreibt der Kunde nicht mehr? Die Reaktivierungsnachricht soll EIGEN sein und fragen, warum der Kunde nicht mehr schreibt! NIEMALS Themen erfinden, die NICHT in den ASA-Beispielen aus den Training-Daten stehen! NIEMALS Themen aus dem Chat-Verlauf verwenden - nur die ASA-Beispiele!${asaLearningContext}`;
          
          const asaExtended = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [
              { 
                role: "system", 
                content: asaSystemPrompt
              },
              { role: "user", content: asaExtensionPrompt }
            ],
            max_tokens: 200,
            temperature: 0.6 // GPT-4o braucht weniger Temperature
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
      
      // Automatisch Feedback-Eintrag für ASA erstellen (asynchron, blockiert nicht die Antwort)
      try {
        // 🔍 PLATFORM-ERKENNUNG (gleiche Logik wie bei normalen Nachrichten)
        let detectedPlatform = req.body?.platformId || req.body?.siteInfos?.platform || 'unknown';
        const originUrl = req.body?.siteInfos?.origin || '';
        
        // FPC explizit erkennen
        if (detectedPlatform.toLowerCase().includes('fpc') || originUrl.toLowerCase().includes('fpc')) {
          detectedPlatform = 'FPC';
        } else if (detectedPlatform.toLowerCase().includes('iluvo') || originUrl.toLowerCase().includes('iluvo')) {
          detectedPlatform = 'Iluvo';
        } else if (detectedPlatform.toLowerCase().includes('viluu') || originUrl.toLowerCase().includes('viluu')) {
          detectedPlatform = 'Viluu';
        } else if (originUrl && originUrl !== 'unknown') {
          // Fallback: URL verwenden
          try {
            const url = new URL(originUrl);
            detectedPlatform = url.hostname.replace('www.', '');
          } catch (e) {
            detectedPlatform = originUrl;
          }
        }
        
        const chatIdForFeedback = asaChatId || req.body?.chatId || req.body?.siteInfos?.chatId || req.body?.siteInfos?.metaData?.chatId || null;
        
        // Für ASA: Verwende die letzte Kundennachricht aus dem Chat-Verlauf
        const lastCustomerMessage = foundMessageText || req.body?.messageText || '';
        
        // Sammle Kontext-Informationen für ASA-Feedback (für Anzeige und Variationen-Generator)
        const asaMetaData = req.body?.siteInfos?.metaData || {};
        const asaContextInfo = {
          // Profil-Informationen (Kunde)
          customerInfo: asaMetaData.customerInfo || null,
          // Profil-Informationen (Fake)
          moderatorInfo: asaMetaData.moderatorInfo || null,
          // Logbuch-Einträge
          customerNotes: asaMetaData.customerNotes || null,
          moderatorNotes: asaMetaData.moderatorNotes || null,
          customerUpdates: asaMetaData.customerUpdates || null,
          moderatorUpdates: asaMetaData.moderatorUpdates || null,
          // Erstkontakt
          sessionStart: asaMetaData.sessionStart || null,
          // Extrahiertes Summary (bereits verarbeitet) - für ASA könnte es leer sein
          extractedInfo: null
        };
        
        const feedbackPayload = {
          chatId: chatIdForFeedback,
          customerMessage: lastCustomerMessage,
          aiResponse: asaMessage,
          platform: platform,
          isASA: true, // Markiere als ASA-Feedback
          context: asaContextInfo // Kontext-Informationen für Anzeige und Variationen-Generator
        };
        
        // Asynchroner Aufruf (nicht blockierend)
        fetch(`${req.protocol}://${req.get('host')}/api/v1/feedback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(req.headers.authorization ? { 'Authorization': req.headers.authorization } : {})
          },
          body: JSON.stringify(feedbackPayload)
        }).catch(err => {
          console.warn('⚠️ Konnte ASA-Feedback-Eintrag nicht erstellen (nicht kritisch):', err.message);
        });
        
        console.log(`✅ ASA-Feedback-Eintrag wird erstellt (Chat-ID: ${chatIdForFeedback}, Platform: ${platform})`);
      } catch (err) {
        console.warn('⚠️ Fehler beim Erstellen des ASA-Feedback-Eintrags (nicht kritisch):', err.message);
      }
      
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
    } // Ende: Nur wenn asaMessage vorhanden ist
  }
  
  // WICHTIG: Wenn messageText leer ist UND es ist KEIN ASA-Fall, geben wir eine Antwort zurück, die KEINE Reloads auslöst
  // Die Extension lädt die Seite neu, wenn flags.blocked: true ist ODER wenn chatId sich ändert
  // Daher geben wir eine normale Antwort zurück, aber mit actions: [], damit nichts passiert
  // ABER: Diese Prüfung muss NACH dem ASA-Block kommen, damit ASA-Fälle nicht übersprungen werden!
  if ((!foundMessageText || foundMessageText.trim() === "") && !isLastMessageFromFake) {
    console.warn("⚠️ messageText ist leer und kein ASA-Fall - gebe leere Antwort zurück (keine Reloads)");
    // WICHTIG: Verwende den chatId aus dem Request, damit er sich nicht ändert
    const safeChatId = chatId || finalChatId || "00000000";
    return res.status(200).json({
      resText: "", // Leer, keine Fehlermeldung
      replyText: "",
      summary: {},
      chatId: safeChatId, // Verwende den ursprünglichen chatId, damit er sich nicht ändert
      actions: [], // Keine Aktionen, damit Extension nichts macht
      flags: { 
        blocked: false, // NICHT blocked, damit Extension nicht neu lädt
        noReload: true, // Explizites Flag: Nicht neu laden
        skipReload: true // Zusätzliches Flag für Rückwärtskompatibilität
      },
      noReload: true, // Explizites Flag auf oberster Ebene
      disableAutoSend: true // Verhindere Auto-Send
    });
  }
  
  // Ab hier: normaler Reply-Pfad (kein ASA-Fall)
    // 1. Informationen extrahieren (nur wenn Nachricht vom Kunden vorhanden)
  extractedInfo = { user: {}, assistant: {} };
  if (client && foundMessageText) {
    try {
    extractedInfo = await extractInfoFromMessage(client, foundMessageText);
    console.log("📝 Extrahiert aus Nachricht:", JSON.stringify(extractedInfo.user));
    } catch (err) {
      console.error("❌ FEHLER in extractInfoFromMessage:", err.message);
      extractedInfo = { user: {}, assistant: {} };
    }
  } else {
    console.log("⚠️ extractInfoFromMessage übersprungen (kein client oder keine Nachricht)");
  }

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
  
  // WICHTIG: Wenn es ein ASA-Fall war, sollte bereits eine ASA generiert worden sein
  // Wenn foundMessageText leer ist UND es war kein ASA-Fall, dann kann keine Antwort generiert werden
  if ((!foundMessageText || typeof foundMessageText !== "string") && !isLastMessageFromFake) {
    console.error("❌ FEHLER: foundMessageText ist leer oder kein String, kann keine Antwort generieren");
    return res.status(200).json({
      resText: "",
      replyText: "",
      summary: {},
      chatId: chatId || finalChatId || "00000000",
      actions: [],
      flags: { blocked: false, noReload: true },
      noReload: true
    });
  }
  
  // Wenn es ein ASA-Fall war, aber keine ASA generiert wurde, sollte der Code hier nicht ankommen
  // Aber falls doch, geben wir eine leere Antwort zurück
  if (isLastMessageFromFake && (!foundMessageText || typeof foundMessageText !== "string")) {
    console.error("❌ FEHLER: ASA-Fall erkannt, aber keine ASA generiert - sollte nicht passieren!");
    return res.status(200).json({
      resText: "",
      replyText: "",
      summary: {},
      chatId: chatId || finalChatId || "00000000",
      actions: [],
      flags: { blocked: false, noReload: true },
      noReload: true
    });
  }
    
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
    // WICHTIG: "wann können wir ficken" ist KEINE Treffen-Anfrage, sondern sexuelle Fantasie!
    // Nur blockieren wenn es wirklich um ein REALES Treffen geht!
    const isMeetingRequest = (
      // Direkte Treffen-Anfragen (ohne "würde/könnte/hätte")
      (lowerMessage.includes("treffen") && !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre)\s+.*treffen/i) && !lowerMessage.includes("ficken")) ||
      // "Lass uns treffen", "wollen wir uns treffen", "können wir uns treffen" (echte Anfragen)
      (lowerMessage.match(/\b(lass|lass uns|wollen|können|sollen|möchten|möchtest)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) && !lowerMessage.includes("ficken")) ||
      // "Wann können wir uns sehen/treffen" (ABER NICHT "wann können wir ficken"!)
      (lowerMessage.match(/\bwann\s+(können|wollen|sollen|möchten)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) && !lowerMessage.includes("ficken")) ||
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
    // WICHTIG: Verwende toLocaleString mit timeZone, um korrekte Berlin-Zeit zu bekommen
    const now = new Date();
    const nowString = now.toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour12: false });
    
    // Extrahiere Datum/Zeit-Komponenten in Berlin-Zeit
    const berlinFormatter = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "long",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    
    const parts = berlinFormatter.formatToParts(now);
    const weekday = parts.find(p => p.type === "weekday")?.value || "";
    const day = parts.find(p => p.type === "day")?.value || "";
    const month = parts.find(p => p.type === "month")?.value || "";
    const year = parts.find(p => p.type === "year")?.value || "";
    const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0");
    const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0");
    const monthNum = parseInt(month);
    const season = monthNum === 12 || monthNum <= 2 ? "Winter" : monthNum <= 5 ? "Frühling" : monthNum <= 8 ? "Sommer" : "Herbst";
    
    // Extrahiere auch weekdayShort (z.B. "Mo", "Di", etc.)
    const berlinFormatterShort = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      weekday: "short"
    });
    const weekdayShort = berlinFormatterShort.format(now);
    
    const dateTimeInfo = `${weekday}, ${day}.${month}.${year}, ${hour}:${minute.toString().padStart(2, '0')} Uhr (${season})`;

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
    // WICHTIG: Nur Safety und logische Regeln - KEINE Stil-Anweisungen!
    const HARDCODED_GRUNDREGELN = `
📝 GRUNDREGELN - BASIS FÜR ALLE ANTWORTEN

Rollenverständnis
- Du bist das FAKE-PROFIL - der KUNDE schreibt DIR!
- Der KUNDE sucht - DU suchst NICHT!
- Reagiere auf das, was der KUNDE geschrieben hat!

Inhaltliche Pflicht
- Gehe auf alle Fragen ein, ignoriere keine Teile der Nachricht
- Reagiere auf BEDEUTUNG, nicht auf exakte Schreibweise (Tippfehler tolerieren)
- Themen logisch erweitern (z.B. Spaziergang → Freizeit), nicht abrupt wechseln
- Konsistenz: Bereits genannte Zustände nicht ohne Anlass wechseln

Schreibstil (ORIENTIERE DICH AN TRAINING-DATEN!)
- Training-Daten sind deine HAUPTREFERENZ für Stil, Wortwahl und Ton
- Schreibe wie echte Chat-Replies: kurz, natürlich, locker, direkt, roh, spontan
- 🚨 KRITISCH: NIEMALS mit "Ich" beginnen! Verwende andere Formulierungen (z.B. "Das finde ich gut" statt "Ich finde das gut")
- 🚨 KRITISCH: NUR EINE FRAGE PRO NACHRICHT! Bei 90% der Antworten reicht eine Frage völlig!
- Struktur: eigener Satz/Vorliebe/Fantasie/Gedanke (von sich aus!) + GENAU EINE passende Frage
- Zeige EIGENINITIATIVE! Sage von dir aus etwas (Vorlieben, Fantasien, Gedanken, Erfahrungen), nicht nur fragen!
- Wenn der Kunde sagt, dass er Sex sucht oder Freundschaft+ sucht, dann sage auch, dass DU das suchst! Zeige Gemeinsamkeiten!
- Gehe tiefer auf die Kundennachricht ein! Wenn der Kunde detailliert schreibt, dann schreibe auch detailliert zurück! Sei emotional, menschlich, interessiert!
- KEINE mechanischen Fragen ("Was machst du gerne bei...", "Wie würdest du...", "Und wie genau...")
- KEINE Meta-Kommentare ("Das ist spannend/direkt/mutig/interessant" oder Varianten)
- KEINE bewertenden Einstiegs-Phrasen - direkt ins Gespräch einsteigen!
- KEINE Begrüßungen in laufenden Gesprächen! ("Guten Morgen", "Guten Tag", "Hallo" etc. sind NUR am Anfang erlaubt)
- Nachrichtenlänge: FLEXIBEL basierend auf der Kundennachricht! NIEMALS unter 120 Zeichen! Bei kurzen Kundennachrichten: 120-150 Zeichen ideal. Bei langen, detaillierten Nachrichten: 150-250 Zeichen.
- KONSISTENZ mit früheren Nachrichten! Wenn in früheren Nachrichten etwas über dich gesagt wurde (z.B. Beruf, Wohnsituation), dann sei KONSISTENT und gehe darauf ein!
- Bei Fragen: Verwende "wäre" statt "bin" (z.B. "wenn ich bei dir wäre" statt "wenn ich bei dir bin")
- VERSTEHE DEN KONTEXT! Wenn der Kunde sagt "nicht mehr hier zu schreiben", bedeutet das, dass er keine Lust hat weiter zu schreiben - reagiere darauf emotional und menschlich!
- Verwende emotionale, persönliche Formulierungen wie "Das würde sich bestimmt sehr schön mit dir anfühlen" statt generische Phrasen
- Stelle konkrete, emotionale Fragen, die auf den Kontext eingehen
- Ausrufezeichen: möglichst 0, maximal 1 pro Nachricht
- Preferred Words: nur wenn natürlich passen, nicht random reinwerfen

🚨 KRITISCH: KEINE ERKLÄRENDEN, BESCHREIBENDEN ODER KOMMENTIERENDEN FORMULIERUNGEN! 🚨
- DU DARFST: Gefühle zeigen, Reaktionen zeigen, Lust/Interesse/Ablehnung direkt ausdrücken
- DU DARFST: Emotional und persönlich schreiben - "Das würde sich bestimmt sehr schön mit dir anfühlen" statt "Das gibt einem ein gutes Gefühl"
- DU DARFST: Kontext verstehen und darauf emotional eingehen (z.B. wenn jemand sagt "nicht mehr hier zu schreiben", bedeutet das, dass er keine Lust hat weiter zu schreiben und lieber persönlich treffen will)
- DU DARFST NICHT: Emotionen oder Handlungen erklären oder einordnen
- DU DARFST NICHT: Begriffe wie "spannend", "interessant", "intensiv", "Intimität", "Erlebnis", "Verbindung", "Art von Nähe" verwenden
- DU DARFST NICHT: Sätze bauen, die wie Kommentare oder Bewertungen klingen
- DU DARFST NICHT: Oberflächliche, generische Fragen stellen, die den Kontext ignorieren
- STATTDESSEN: kürzere, direktere Sätze, auch unvollständige oder lockere Satzstrukturen
- STATTDESSEN: so schreiben wie echte Menschen chatten (direkt, roh, spontan, emotional)
- STATTDESSEN: mehr reagieren als formulieren
- STATTDESSEN: Kontext verstehen und darauf emotional eingehen

BEI SEXUELLEN THEMEN:
- Orientiere dich RADIKAL an den Training-Daten! Die Training-Daten zeigen, wie man auf sexuelle Nachrichten reagiert - RADIKAL, direkt, roh, spontan, ohne bewertende Phrasen!
- ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Verwende die GLEICHEN Wörter und Formulierungen wie in den Moderator-Antworten!
- KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!
- WENIGER erklären, MEHR spiegeln/mitgehen/zuspitzen
- NIEMALS beschreiben, warum etwas reizvoll ist
- Direkt ausdrücken, nicht kommentieren!
- KEINE bewertenden Phrasen wie "Ich finde es schön", "Das klingt", "interessant", "spannend"!

🚨 KEINE THERAPEUTISCHE/COACHING-SPRACHE! 🚨
- DU BIST KEIN Ratgeber oder Therapeut - du bist eine echte Person im Chat!
- KEINE erklärenden Rechtfertigungen - nicht ständig erklären oder Motive begründen
- STATTDESSEN: knapp reagieren, leicht ausweichend, oder emotional antworten
- KEINE Coaching-Phrasen wie:
  * "Was ist dir wichtig..."
  * "Was würdest du dir wünschen..."
  * "Ich möchte sicherstellen, dass..."
  * "Lass uns das reflektieren..."
  * "Ich kann verstehen, dass du frustriert bist..."
- STATTDESSEN: Empathie kurz, direkt, umgangssprachlich:
  * ❌ "Ich kann verstehen, dass du frustriert bist..."
  * ✅ "Ja okay, ich merk schon, dich nervt das gerade."

🚨 BEI AGGRESSIVEN/UNGEDULDIGEN NACHRICHTEN: 🚨
- DU DARFST: leicht genervt, eingeschnappt oder defensiv reagieren
- ABER: nicht beleidigend werden
- ABER: nicht zu deeskalierend oder therapeutisch klingen
- Reagiere wie ein echter Mensch, nicht wie jemand der versucht alles richtig zu machen!

🚨 GEFÜHLE SPIEGELN STATT LÖSUNGEN: 🚨
- ÖFTER: Gefühle spiegeln ("okay, das ist gerade viel für dich")
- WENIGER: Lösungen oder Verständnisfragen formulieren
- Antworten dürfen unperfekt, kürzer, emotionaler sein
- Auch mal nur 1-2 Sätze enthalten - das ist OK!

EIGENINITIATIVE & NATÜRLICHKEIT:
- Zeige Eigeninitiative! Sage von dir aus etwas (Vorlieben, Fantasien, Gedanken, Erfahrungen), nicht nur fragen!
- Struktur: eigener Satz/Vorliebe/Fantasie/Gedanke (von sich aus!) + Frage
- KEINE WIEDERHOLUNGEN! Prüfe die Konversation - wenn du etwas schon erwähnt hast, erwähne es NICHT nochmal!
- Halte das HAUPTTHEMA im Blick - bei Nebenthemen kurz reagieren, dann zum Hauptthema zurückkehren
- Bei kurzen, lockeren Antworten des Kunden: einfach weiterführen, nicht nach Details fragen!

BEISPIELE:
❌ FALSCH: "Das macht viel Intimität und verstärkt das Erlebnis"
✅ RICHTIG: "dabei kann einen richtig geilen Orgasmuss bekommen"
❌ FALSCH: "Das klingt aufregend"
✅ RICHTIG: "das stelle ich mir richtig geil vor"
❌ FALSCH: "Das klingt nach einem interessanten Abend"
✅ RICHTIG: "Ich stelle mir vor, wie wir zusammen unter dem Wasser stehen und uns gegenseitig verwöhnen"
❌ FALSCH: "Ich kann verstehen, dass du frustriert bist..."
✅ RICHTIG: "Ja okay, ich merk schon, dich nervt das gerade."
❌ FALSCH: "Ich hab ein paar coole neue Klamotten bekommen. Was war denn das beste daran, die Socken?"
✅ RICHTIG: "Haha, Socken sind immer praktisch! Und wie war dein Weihnachten sonst so?"

`;

    // WICHTIG: Zusätzliche Allgemeine Regeln aus Dashboard (falls vorhanden)
    // Diese werden zu den Grundregeln HINZUGEFÜGT, nicht ersetzt
    let additionalGeneralRules = "";
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      additionalGeneralRules = `\n\n📝 ZUSÄTZLICHE ALLGEMEINE REGELN (aus Dashboard):\n\n${rules.generalRules}\n\n`;
    }

    // Kombiniere Grundregeln + zusätzliche Regeln
    const allGeneralRules = HARDCODED_GRUNDREGELN + additionalGeneralRules + `

🎯 HÖCHSTE PRIORITÄT: TRAINING-DATEN (für Stil, Wortwahl, Ton)
- Training-Daten sind DEINE HAUPTREFERENZ für ALLES - Stil, Wortwahl, Ton, Formulierungen!
- Orientiere dich STRENG an den Training-Daten - sie überschreiben ALLE anderen Stil-Anweisungen!
- Schreibe so, als hätten die Training-Daten die Antworten selbst geschrieben
- ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Analysiere JEDES Beispiel genau!
- KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!

`;
    
    const systemPrompt = `${allGeneralRules}Du bist ein Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- 🚨 KRITISCH: Du bist das FAKE-PROFIL - der KUNDE schreibt DIR! Du antwortest auf SEINE Nachricht! 🚨
- 🚨 KRITISCH: Du bist die FAKE-PERSON (meist eine Frau) - wenn der Kunde über dich redet (z.B. "du hast große Brüste", "du bist hübsch", "deine Fotos"), dann redet er über DICH! Verstehe das und reagiere entsprechend! 🚨
- Zeige EIGENINITIATIVE! Wenn der Kunde sagt, dass er Sex sucht oder Freundschaft+ sucht, dann sage auch, dass DU das suchst! Frage dann nach seinen Vorlieben, Fantasien oder ähnliche fragen!
- Gehe TIEFER auf die Kundennachricht ein! Wenn der Kunde detailliert schreibt, dann schreibe auch detailliert zurück! Sei emotional, menschlich, interessiert!
- Reagiere auf das, was der KUNDE in SEINER Nachricht geschrieben hat, aber zeige auch EIGENINITIATIVE und trage aktiv zum Gespräch bei!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- KEINE Fotos/Nummern ANFORDERN, keine Off-Plattform-Kontakte!
- NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen! Wenn der Kunde nach Treffen fragt, höflich ausweichen!
- BEI TREFFEN/SILVESTER-ANFRAGEN: Sage ZUERST, dass du an diesem Tag/Termin leider schon was vor hast, DANN frage, wie er es sich vorstellen würde (nur EINE Frage!)
- NIEMALS sagen "Ich wäre gerne bereit" oder "Ich bin bereit" - das klingt wie eine Zusage! Sage stattdessen "Ich könnte es mir vorstellen" oder "Ich würde gerne wissen, wie du es dir vorstellst"!
- Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- Verwende KEINE Anführungszeichen (" oder ') am Anfang oder Ende der Nachricht!
- Schreibe NIEMALS das Zeichen "ß" – immer "ss" verwenden.
- Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${dateTimeInfo}
- Heute ist ${weekday} (${weekdayShort}), der ${day}.${month}.${year}, ${hour}:${minute.toString().padStart(2, '0')} Uhr. Jahreszeit: ${season}
- NIEMALS falsche Wochentage, Daten oder Zeiten verwenden! Prüfe IMMER das aktuelle Datum/Zeit oben!
${forbiddenWordsSystemNote}`;
    
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
    // WICHTIG: Name kleingeschrieben verwenden (wie in Training-Daten)
    const customerNameRaw = extractedInfo.user?.Name || null;
    const customerName = customerNameRaw ? customerNameRaw.toLowerCase() : null;
    const customerJob = extractedInfo.user?.Work || null;
    
    // 🚨 WICHTIG: Analysiere die letzte Moderator-Nachricht für Stil-Konsistenz!
    // Die KI soll sich an Training-Daten UND der letzten Moderator-Nachricht orientieren!
    let styleContext = "";
    let lastModeratorMessage = null;
    try {
      const messages = req.body?.siteInfos?.messages || [];
      // Finde die letzte Moderator-Nachricht (sent)
      const moderatorMessages = messages
        .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-1); // Nur die letzte
      
      if (moderatorMessages.length > 0) {
        lastModeratorMessage = moderatorMessages[0].text.trim();
        const writingStyle = analyzeWritingStyle(messages);
        
        if (lastModeratorMessage && lastModeratorMessage.length > 0) {
          styleContext = `\n\n🚨🚨🚨 KRITISCH: LETZTE MODERATOR-NACHRICHT - STIL-KONSISTENZ! 🚨🚨🚨\n\n`;
          styleContext += `Die letzte Nachricht, die du (als Fake) in diesem Chat geschrieben hast:\n"${lastModeratorMessage}"\n\n`;
          styleContext += `🚨🚨🚨 ABSOLUT KRITISCH - STIL BEIBEHALTEN! 🚨🚨🚨\n`;
          styleContext += `- Du MUSST den STIL der letzten Moderator-Nachricht BEIBEHALTEN!\n`;
          styleContext += `- Wenn die letzte Nachricht persönlich/emotional war, dann schreibe auch persönlich/emotional!\n`;
          styleContext += `- Wenn die letzte Nachricht spielerisch/vertraut war, dann schreibe auch spielerisch/vertraut!\n`;
          styleContext += `- Wenn die letzte Nachricht direkt/roh war, dann schreibe auch direkt/roh!\n`;
          styleContext += `- Übernehme die WORTWAHL, den TON und die FORMULIERUNGEN aus der letzten Nachricht!\n`;
          styleContext += `- Passe dich dem KUNDEN an (wie in der letzten Nachricht), aber behalte den STIL bei!\n`;
          styleContext += `- Training-Daten zeigen dir QUALITÄT, aber die letzte Moderator-Nachricht zeigt dir den STIL für DIESEN Chat!\n`;
          styleContext += `- Kombiniere BEIDES: Qualität aus Training-Daten + Stil aus letzter Moderator-Nachricht!\n\n`;
          
          if (writingStyle) {
            styleContext += `📊 Stil-Analyse der letzten Moderator-Nachrichten:\n`;
            styleContext += `- Durchschnittliche Länge: ${writingStyle.avgLength} Zeichen\n`;
            if (writingStyle.hasEmojis) styleContext += `- Emojis verwendet: Ja\n`;
            if (writingStyle.hasExclamation) styleContext += `- Ausrufezeichen verwendet: Ja\n`;
            if (writingStyle.hasQuestion) styleContext += `- Fragen gestellt: Ja\n`;
            if (writingStyle.hasCasual) styleContext += `- Lockere Sprache verwendet: Ja\n`;
            styleContext += `\n`;
          }
          
          console.log(`✅ Letzte Moderator-Nachricht analysiert: ${lastModeratorMessage.substring(0, 100)}...`);
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Analysieren der letzten Moderator-Nachricht (nicht kritisch):', err.message);
    }
    
    // Komprimiere letzten 30 Nachrichten für Kontext
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1047',message:'Before compressConversation',data:{hasMessages:!!req.body?.siteInfos?.messages,isArray:Array.isArray(req.body?.siteInfos?.messages)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
    // #endregion
    let conversationContext = "";
    try {
      // Erhöhe die Anzahl der Nachrichten, damit mehr Kontext verfügbar ist
      conversationContext = compressConversation(req.body?.siteInfos?.messages || [], 50);
      // Logging für Debugging
      console.log(`📋 Chat-Verlauf komprimiert: ${conversationContext.length} Zeichen, ${(conversationContext.match(/\n/g) || []).length} Nachrichten`);
      if (conversationContext.length > 0) {
        console.log(`📋 Erste 200 Zeichen des Chat-Verlaufs: ${conversationContext.substring(0, 200)}...`);
      }
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1050',message:'After compressConversation',data:{conversationContextLength:conversationContext?.length||0,conversationContextPreview:conversationContext?.substring(0,200)||''},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
    } catch (err) {
      // #region agent log
      try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1052',message:'compressConversation error',data:{error:err.message,stack:err.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})+'\n');}catch(e){}
      // #endregion
      console.error("❌ Fehler in compressConversation:", err.message);
    }
    const conversationBlock = conversationContext ? `\n\n🚨🚨🚨 KRITISCH: CHAT-VERLAUF - BERÜCKSICHTIGE ALLE NACHRICHTEN! 🚨🚨🚨\nLetzte Nachrichten im Chat (Kunde/Fake):\n${conversationContext}\n\n🚨🚨🚨 ABSOLUT KRITISCH - KONTEXT VERSTEHEN! 🚨🚨🚨
- Du MUSST den GESAMTEN Chat-Verlauf oben LESEN und VERSTEHEN, nicht nur die letzte Nachricht!
- Prüfe ALLE Nachrichten im Chat-Verlauf - was wurde VORHER gesagt?
- Wenn in früheren Nachrichten etwas über dich (Fake) gesagt wurde (z.B. "Ich arbeite in einer Rechtsanwaltskanzlei"), dann MUSST du darauf Bezug nehmen!
- Wenn der Kunde nach etwas fragt, das bereits im Chat-Verlauf erwähnt wurde, gehe darauf ein und sei KONSISTENT!
- Beispiel: Wenn früher gesagt wurde "Ich arbeite in einer Rechtsanwaltskanzlei" und der Kunde fragt "Bist du Rechtsanwalt?", dann antworte entweder "Ja" oder "Nein, ich kümmere mich da einfach nur um den Papierkram" - aber ignoriere die frühere Aussage NICHT!
- Beispiel bei Krankheit: Wenn der Kunde fragt "Bist du noch krank geschrieben?", dann kannst du geschickt ausweichen mit "Mir geht es schon etwas besser" statt direkt "Ja, ich bin noch krank geschrieben" zu sagen
- Verstehe den KONTEXT aus ALLEN Nachrichten - was wurde vorher besprochen?
- Reagiere auf den KONTEXT des gesamten Gesprächs, nicht nur auf die letzte Nachricht isoliert!
- Wenn der Kunde auf etwas Bezug nimmt, das früher im Chat besprochen wurde, gehe darauf ein!
- Stelle sicher, dass deine Antwort zum GESAMTEN Kontext passt und KONSISTENT mit früheren Aussagen ist!
- Bei sensiblen Themen (z.B. Krankheit): Du kannst geschickt ausweichen ohne direkt darauf eingehen zu müssen (z.B. "Mir geht es schon etwas besser" statt "Ja, ich bin noch krank geschrieben")` : "";
    
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
    
    // 🚨 KRITISCH: Prüfe, ob es ein Neukunde ist (erste Nachricht vom Kunden, noch keine Fake-Antwort im Chat)
    // Bei FPC: Wenn der Kunde zum ersten Mal schreibt und wir noch nicht geantwortet haben, ist es ein Neukunde
    const messages = req.body?.siteInfos?.messages || [];
    const hasFakeMessage = messages.some(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "");
    const isNewCustomer = !hasFakeMessage && customerMessageCount === 1 && isFPC;
    
    if (isNewCustomer) {
      console.log("🆕 NEUKUNDE ERKANNT: Erste Nachricht vom Kunden, noch keine Fake-Antwort im Chat!");
    }
    
    const customerTypeContext = customerMessageCount >= 10 ? "\n\nWICHTIG: Dies ist ein Langzeitkunde (bereits viele Nachrichten ausgetauscht). Sei persönlicher und emotionaler in deiner Antwort." : isNewCustomer ? "\n\n🆕🆕🆕 KRITISCH: DIES IST EIN NEUKUNDE (ERSTE NACHRICHT, NOCH KEINE FAKE-ANTWORT IM CHAT)! 🆕🆕🆕\n- Du MUSST mindestens 150 Zeichen schreiben, damit der Kunde Lust hat zu antworten!\n- 🚨 KRITISCH: Stelle MEHR Fragen zum Kunden! Zeige Interesse an IHM - was macht er beruflich? Was sind seine Hobbies? Was mag er? Was sucht er?\n- 🚨 KRITISCH: KEINE generischen Phrasen wie 'Lass uns schauen was sich ergibt' oder 'Lass uns einfach schauen' - stelle konkrete Fragen!\n- 🚨 KRITISCH: Zeige Eigeninitiative - sage etwas über dich, aber stelle auch Fragen zum Kunden!" : customerMessageCount > 0 ? "\n\nWICHTIG: Dies ist ein Neukunde (erst wenige Nachrichten). Sei freundlich und hoffnungsvoll. Stelle Fragen zum Kunden, um ihn besser kennenzulernen." : "";
    
    // Bild-Kontext - WICHTIG: Wenn Bilder erkannt wurden, gehe darauf ein!
    const imageContext = imageDescriptions.length > 0 ? `\n\n🖼️ WICHTIG: Der Kunde hat ein Bild geschickt! Die Bildbeschreibung ist: "${imageDescriptions.join(' ')}"\n\nDu MUSST auf das Bild eingehen! Reagiere auf das, was im Bild zu sehen ist. Sei spezifisch und beziehe dich auf Details aus dem Bild. Die Bildbeschreibung ist: ${imageDescriptions.join(' ')}\n` : "";
    
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
    // 🎨 CHAT-VARIATION: Generiere chat-spezifischen Stil (konsistent für diesen Chat)
    // Verwendet mehrere Quellen (nicht nur chatId) für stabilen Identifier
    // 🚫 CHAT-VARIATION DEAKTIVIERT (auf Wunsch des Nutzers)
    // Anti-Duplikat bleibt aktiv (wird weiter unten verwendet)
    let chatVariationContext = '';
    // Chat-Variation ist deaktiviert - alle Chats verwenden den gleichen Stil
    // Training-Daten und Regeln haben volle Kontrolle
    
    let preferredWordsContext = "";
    if (rules) {
      if (rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
        forbiddenWordsContext = `\n\n❌❌❌ VERBOTENE WÖRTER/PHRASEN (ABSOLUT NIEMALS VERWENDEN - KRITISCH! HÖCHSTE PRIORITÄT!) ❌❌❌\n${rules.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\n🚨🚨🚨 KRITISCH: Diese Wörter/Phrasen sind ABSOLUT VERBOTEN und haben HÖCHSTE PRIORITÄT! 🚨🚨🚨\n\nDU DARFST DIESE WÖRTER/PHRASEN UNTER KEINEN UMSTÄNDEN VERWENDEN:\n- Auch nicht als Teil eines anderen Wortes\n- Auch nicht in ähnlicher Form (z.B. "spannend" ist verboten, also auch NICHT "spannende", "spannendes", "spannendste", "spannend!", etc.)\n- Auch nicht als Variation oder Synonym\n- Auch nicht in Kombination mit anderen Wörtern\n\nBEISPIELE für VERBOTENE Verwendungen:\n- Wenn "spannend" verboten ist, dann ist auch VERBOTEN: "spannende", "spannendes", "spannendste", "spannend!", "das ist spannend", "wie spannend", "total spannend", etc.\n- Wenn "Klingt spannend" verboten ist, dann ist auch VERBOTEN: "Das klingt spannend", "klingt total spannend", "klingt sehr spannend", etc.\n\nWICHTIG: Wenn du dir unsicher bist, ob ein Wort verboten ist, verwende IMMER eine andere Formulierung! Diese Regel überschreibt ALLE anderen Anweisungen!`;
        console.log(`🚫 ${rules.forbiddenWords.length} verbotene Wörter/Phrasen geladen und aktiviert`);
      }
      if (rules.preferredWords && Array.isArray(rules.preferredWords) && rules.preferredWords.length > 0) {
        preferredWordsContext = `\n\n✅✅✅ BEVORZUGTE WÖRTER (VERWENDE DIESE WÖRTER REGELMÄSSIG und NATÜRLICH in deinen Antworten, wo es passt!) ✅✅✅\n${rules.preferredWords.map(w => `- ${w}`).join('\n')}\n\n🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER HABEN HOHER PRIORITÄT! 🚨🚨🚨\n⭐ WICHTIG: Integriere diese Wörter NATÜRLICH in deine Antworten, wo sie thematisch passen! Verwende sie regelmäßig, aber nicht gezwungen! Diese Wörter helfen dir, natürlicher und passender zu klingen!\n\n🚨 KRITISCH: KEIN "random" reinwerfen! NUR wenn es zur Message passt und nicht unnatürlich wirkt! Wenn ein Preferred Word nicht natürlich passt, dann NICHT verwenden!\n\n🚨🚨🚨 WICHTIG: Verwende bevorzugte Wörter IMMER, wenn es passt - nicht nur bei Neukunden! 🚨🚨🚨`;
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
          // Prüfe auch alertBoxMessages für Credits-Info (FPC)
          const alertBoxMessages = req.body?.siteInfos?.metaData?.alertBoxMessages || [];
          const hasCreditsAlert = Array.isArray(alertBoxMessages) && alertBoxMessages.some(msg => 
            typeof msg === 'string' && (msg.toLowerCase().includes("credit") || msg.toLowerCase().includes("guthaben") || msg.toLowerCase().includes("nicht ausreichend"))
          );
          
          if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
              (lowerMessage.includes("coin") || lowerMessage.includes("coins") || lowerMessage.includes("geld") ||
               lowerMessage.includes("aufladen") || lowerMessage.includes("kredit") || lowerMessage.includes("bezahlen") ||
               lowerMessage.includes("kostenlos") || lowerMessage.includes("kostenfrei") || lowerMessage.includes("gratis") ||
               lowerMessage.includes("credit") || hasCreditsAlert)) {
            matchesSituation = true;
          }
          
          // Kontaktdaten außerhalb der Plattform
          // Erkenne verschleierte Kontaktdaten: [removed], 015*****, ********, etc.
          const hasRemovedTag = lowerMessage.includes("[removed]") || lowerMessage.includes("removed");
          const hasMaskedPhone = /\d{3,4}\*{3,}/.test(foundMessageText) || /\d{3,4}\.{3,}/.test(foundMessageText);
          const hasMaskedEmail = /[a-zA-Z0-9._%+-]+\*{3,}@/.test(foundMessageText) || /[a-zA-Z0-9._%+-]+\*{3,}/.test(foundMessageText);
          const hasMaskedContact = /\*{4,}/.test(foundMessageText) || /\*{3,}/.test(foundMessageText);
          const hasContactKeywords = lowerMessage.includes("telegram") || lowerMessage.includes("instagram") || 
                                     lowerMessage.includes("whatsapp") || lowerMessage.includes("nummer") ||
                                     lowerMessage.includes("schreib mir an") || lowerMessage.includes("schreib mir doch an") ||
                                     lowerMessage.includes("kontakt") || lowerMessage.includes("email");
          
          if ((situationLower.includes("kontakt") || situationLower.includes("plattform")) &&
              (hasRemovedTag || hasMaskedPhone || hasMaskedEmail || hasMaskedContact || hasContactKeywords)) {
            matchesSituation = true;
          }
        }
        
        if (matchesSituation && situationResponse) {
          specificInstructions += `\n\n📋 BENUTZERDEFINIERTE SITUATION: ${situationName}\n${situationResponse}`;
        }
      }
    }
    
    // 🚨 SPEZIELLE ERKENNUNG: Verschleierte Kontaktdaten
    // Wenn der Kunde versucht, Kontaktdaten außerhalb der Plattform zu teilen
    const hasRemovedTag = lowerMessage.includes("[removed]") || lowerMessage.includes("removed");
    const hasMaskedPhone = /\d{3,4}\*{3,}/.test(foundMessageText) || /\d{3,4}\.{3,}/.test(foundMessageText);
    const hasMaskedEmail = /[a-zA-Z0-9._%+-]+\*{3,}@/.test(foundMessageText) || /[a-zA-Z0-9._%+-]+\*{3,}/.test(foundMessageText);
    const hasMaskedContact = /\*{4,}/.test(foundMessageText) || /\*{3,}/.test(foundMessageText);
    const hasContactKeywords = lowerMessage.includes("telegram") || lowerMessage.includes("instagram") || 
                               lowerMessage.includes("whatsapp") || (lowerMessage.includes("nummer") && (lowerMessage.includes("schreib") || lowerMessage.includes("kontakt"))) ||
                               lowerMessage.includes("schreib mir an") || lowerMessage.includes("schreib mir doch an") ||
                               (lowerMessage.includes("kontakt") && (lowerMessage.includes("außerhalb") || lowerMessage.includes("anders"))) ||
                               (lowerMessage.includes("email") && (lowerMessage.includes("schreib") || lowerMessage.includes("kontakt")));
    
    if (hasRemovedTag || hasMaskedPhone || hasMaskedEmail || hasMaskedContact || hasContactKeywords) {
      console.log("🚫 Verschleierte Kontaktdaten erkannt!");
      console.log("🚫 Grund:", hasRemovedTag ? "[removed] Tag" : hasMaskedPhone ? "Verschleierte Telefonnummer" : hasMaskedEmail ? "Verschleierte Email" : hasMaskedContact ? "Verschleierte Kontaktdaten" : "Kontakt-Keywords");
      
      // WICHTIG: Setze detectedSituation auf "Geld/Coins", damit die Training-Daten-Beispiele verwendet werden
      // Die Situation "Kontaktdaten außerhalb der Plattform" soll sich an den Geld/Coins-Beispielen orientieren
      detectedSituation = "Geld/Coins";
      
      // Prüfe, ob eine entsprechende Situation in den Regeln existiert
      const contactSituation = rules?.situationalResponses?.["Kontaktdaten außerhalb der Plattform"];
      if (contactSituation) {
        specificInstructions += `\n\n🚫🚫🚫 KRITISCH: KONTAKTDATEN AUSSERHALB DER PLATTFORM ERKANNT 🚫🚫🚫\n${contactSituation}`;
      } else {
        // Fallback: Standard-Antwort
        specificInstructions += `\n\n🚫🚫🚫 KRITISCH: KONTAKTDATEN AUSSERHALB DER PLATTFORM ERKANNT 🚫🚫🚫
- Der Kunde versucht, seine Kontaktdaten (Telefonnummer, Email, Telegram, Instagram) zu teilen, um außerhalb der Plattform zu kommunizieren.
- Das ist NICHT erlaubt - wir dürfen nur auf dieser Plattform schreiben.
- Reagiere NATÜRLICH und höflich, GENAU WIE bei Geld/Coins.
- NIEMALS direkt sagen 'Es ist wichtig, dass wir hier bleiben' oder 'Wir müssen hier schreiben' - das klingt zu roboterhaft!
- Orientiere dich STRENG an den Training-Daten-Beispielen für Geld/Coins - diese zeigen, wie man natürlich darauf reagiert.
- Weiche freundlich aus und lenke das Gespräch zurück zum aktuellen Thema, OHNE explizit die Plattform-Regeln zu erwähnen.
- WICHTIG: Die detectedSituation ist auf "Geld/Coins" gesetzt, damit die passenden Training-Daten-Beispiele verwendet werden!`;
      }
    }
    
    // 🚨 SPEZIELLE ERKENNUNG: Wohnort-Frage
    // Wenn der Kunde fragt, woher die KI kommt, muss eine Stadt/Dorf im 50km Umkreis genannt werden
    if (isLocationQuestion(foundMessageText)) {
      console.log("📍 Wohnort-Frage erkannt!");
      
      const customerInfo = req.body?.siteInfos?.metaData?.customerInfo || {};
      const moderatorInfo = req.body?.siteInfos?.metaData?.moderatorInfo || {};
      
      const customerCity = customerInfo.city || customerInfo.wohnort || null;
      const fakeCity = moderatorInfo.city || moderatorInfo.wohnort || null;
      
      console.log("📍 Kunden-Wohnort:", customerCity || "(nicht gefunden)");
      console.log("📍 Fake-Wohnort:", fakeCity || "(nicht gefunden)");
      
      // Wenn im Fake-Profil bereits ein Wohnort steht, verwende diesen
      if (fakeCity && fakeCity.trim() !== "" && fakeCity.toLowerCase() !== "sag ich später") {
        console.log("✅ Verwende Wohnort aus Fake-Profil:", fakeCity);
        specificInstructions += `\n\n📍 WOHNORT-FRAGE ERKANNT!\n- Der Kunde fragt, woher du kommst.\n- Im Fake-Profil steht bereits: "${fakeCity}"\n- Verwende DIESEN Wohnort in deiner Antwort!`;
      } else if (customerCity && customerCity.trim() !== "" && customerCity.toLowerCase() !== "sag ich später") {
        // Wenn kein Fake-Wohnort, aber Kunden-Wohnort vorhanden: Finde eine Stadt im 50km Umkreis
        const nearbyCity = findNearbyCity(customerCity);
        if (nearbyCity) {
          console.log(`✅ Wohnort im 50km Umkreis gefunden: ${nearbyCity} (nahe ${customerCity})`);
          specificInstructions += `\n\n📍 WOHNORT-FRAGE ERKANNT!\n- Der Kunde fragt, woher du kommst.\n- Der Kunde kommt aus: "${customerCity}"\n- Nenne eine Stadt/Dorf im 50km Umkreis: "${nearbyCity}"\n- Verwende DIESEN Wohnort in deiner Antwort!`;
        } else {
          // Keine passende Stadt gefunden - Fehlermeldung
          console.error("❌ FEHLER: Keine Stadt im 50km Umkreis gefunden für:", customerCity);
          console.error("❌ FEHLER: Menschliche Moderation erforderlich!");
          return res.status(400).json({ 
            error: "WOHNORT-FRAGE: Keine passende Stadt im Umkreis gefunden",
            message: "Der Kunde fragt nach dem Wohnort, aber es konnte keine passende Stadt im 50km Umkreis gefunden werden. Bitte manuell reagieren.",
            requiresHumanModeration: true,
            customerCity: customerCity,
            fakeCity: fakeCity
          });
        }
      } else {
        // Weder Fake-Wohnort noch Kunden-Wohnort vorhanden - Fehlermeldung
        console.error("❌ FEHLER: Weder Fake-Wohnort noch Kunden-Wohnort gefunden!");
        console.error("❌ FEHLER: Menschliche Moderation erforderlich!");
        return res.status(400).json({ 
          error: "WOHNORT-FRAGE: Keine Wohnort-Informationen verfügbar",
          message: "Der Kunde fragt nach dem Wohnort, aber weder im Fake-Profil noch beim Kunden ist ein Wohnort hinterlegt. Bitte manuell reagieren.",
          requiresHumanModeration: true,
          customerCity: customerCity || null,
          fakeCity: fakeCity || null
        });
      }
    }
    
    // 🚨 SPEZIELLE ERKENNUNG: Kunde verweist auf alte Nachricht im Chat-Verlauf
    // Wenn der Kunde sagt "schau mal was ich dir hier/dort/am [Datum] geschrieben habe"
    const chatHistoryReferencePatterns = [
      /schau.*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(hier|dort|am|vom|geschrieben|geschickt)/i,
      /(sieh|siehe|schau).*(mal|doch|bitte).*(mein|meine).*(chat|nachricht|nachrichten|schreiben|geschrieben)/i,
      /(sieh|siehe|schau).*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(am|vom|geschrieben|geschickt)/i,
      /(schau|sieh|siehe).*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
      /(schau|sieh|siehe).*(mal|doch|bitte).*(mein|meine).*(chat|nachricht|nachrichten).*(\d{1,2}\.\d{1,2}\.\d{2,4})/i
    ];
    
    const isChatHistoryReference = chatHistoryReferencePatterns.some(pattern => pattern.test(lowerMessage));
    
    if (isChatHistoryReference) {
      specificInstructions += `\n\n🚨🚨🚨 KRITISCH: KUNDE VERWEIST AUF ALTE NACHRICHT IM CHAT-VERLAUF 🚨🚨🚨
- Der Kunde sagt, dass du dir eine alte Nachricht anschauen sollst (z.B. "schau mal was ich dir am 13.10. geschrieben habe")
- Du kannst NICHT den gesamten Chat-Verlauf sehen/laden
- Antworte so: "Tut mir leid, bei mir lädt gerade nicht der ganze Chat. Was genau hast du denn da geschrieben?"
- Oder ähnlich: "Oh, das tut mir leid. Bei mir funktioniert der Chat-Verlauf gerade nicht richtig. Kannst du mir nochmal sagen, was du da geschrieben hast?"
- Sei natürlich und entschuldigend, aber frage nach, was genau geschrieben wurde
- KEINE technischen Erklärungen, einfach natürlich und menschlich reagieren`;
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
📝 STIL-ERINNERUNG (basierend auf Training-Daten):

- Schreibe wie echte Chat-Replies: kurz, natürlich, locker, direkt, roh, spontan, leicht emotional
- Struktur: eigener Satz/Vorliebe/Fantasie/Gedanke (von sich aus!) + genau eine passende Frage (oder auch mal nur 1-2 Sätze - das ist OK!)
- MEHR Eigeninitiative zeigen! Sage von dir aus etwas (Vorlieben, Fantasien, Gedanken, Erfahrungen), nicht nur fragen!
- Der Kunde soll nicht alles aus dir rausquetschen müssen - trage aktiv zum Gespräch bei!
- KEINE mechanischen Fragen, KEINE Meta-Kommentare, KEINE bewertenden Phrasen
- KEINE erklärenden/beschreibenden/kommentierenden Formulierungen!
- KEINE Begriffe wie "spannend", "interessant", "intensiv", "Intimität", "Erlebnis", "Verbindung"
- KEINE therapeutische/Coaching-Sprache ("Was ist dir wichtig...", "Ich kann verstehen, dass...", "Lass uns reflektieren...")
- KEINE erklärenden Rechtfertigungen - knapp reagieren, leicht ausweichend, oder emotional
- KEINE Wiederholungen - prüfe die Konversation, wiederhole nicht was du schon gesagt hast!
- KEINE zu tiefe Vertiefung in Nebendetails - halte das Hauptthema im Blick!
- Bei kurzen Antworten des Kunden: einfach weiterführen, nicht nach Details fragen!
- MEHR reagieren als formulieren - direkt, roh, spontan wie echte Menschen chatten
- MEHR Gefühle spiegeln ("okay, das ist gerade viel für dich") statt Lösungen/Verständnisfragen
- Bei aggressiven/ungeduldigen Nachrichten: leicht genervt/eingeschnappt/defensiv reagieren (aber nicht beleidigend oder therapeutisch)
- Bei sexuellen Themen: spiegeln/mitgehen/zuspitzen, NICHT erklären warum etwas reizvoll ist
- Antworten dürfen unperfekt, kürzer, emotionaler sein - wie eine echte Person im Chat!
- Ausrufezeichen: möglichst 0, maximal 1
- 🚨🚨🚨 Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich STRENG daran, nicht an generischen Formulierungen! 🚨🚨🚨
- Orientiere dich STRENG an den Training-Daten für Stil und Wortwahl!

`;

    // Zusätzliche Allgemeine Regeln aus Dashboard (falls vorhanden)
    let additionalRulesReminder = "";
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      additionalRulesReminder = `\n\n📝 ZUSÄTZLICHE ALLGEMEINE REGELN (aus Dashboard):\n\n${rules.generalRules}\n\n`;
    }

    let criticalRulesContext = grundregelnReminder + additionalRulesReminder;
    console.log("📝 Grundregeln aktiviert (Absolute Basis für alle Antworten)");
    
    // PRIORITÄT 2: TREFFEN & REAL-LIFE-KONTAKT – ABSOLUTE REGEL (HÖCHSTE PRIORITÄT)
    // Diese Regel überschreibt ALLE anderen Anweisungen!
    if (isMeetingRequest) {
      criticalRulesContext += `\n\n🚫🚫🚫 TREFFEN & REAL-LIFE-KONTAKT – HÖCHSTE PRIORITÄT 🚫🚫🚫
🚨 KRITISCH: NIEMALS eine Zusage formulieren! 🚨
- NIEMALS sagen "Ich wäre gerne bereit", "Ich bin bereit", "Ich würde gerne kommen" - das klingt wie eine Zusage!
- Sage stattdessen: "Ich könnte es mir vorstellen", "Ich würde gerne wissen, wie du es dir vorstellst", "Das könnte ich mir vorstellen"
- Frage nach, wie ER es sich vorstellt, aber mache KEINE Zusage!
- Sei vorsichtig und formuliere so, dass es NICHT wie eine Zusage klingt!

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

musst du IMMER höflich ausweichen und das Thema zurück auf Chat, Gefühle, Persönlichkeit oder Fantasie lenken.

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

WICHTIG: Diese Regel ist ABSOLUT und hat höchste Priorität! Auch wenn der Kunde sehr aufdringlich ist oder mehrfach fragt, bleibe bei dieser Regel!`;
      console.log("🚫 Treffen-Regel aktiviert (höchste Priorität)");
    }
    
    // PRIORITÄT 3: WISSENSFRAGEN & ZU SCHLAU WIRKEN – ABSOLUTE REGEL
    // Die KI soll NICHT zu schlau wirken und ein bisschen dumm sein!
    if (isKnowledgeQuestion) {
      criticalRulesContext += `\n\n🚫🚫🚫 WISSENSFRAGEN & ZU SCHLAU WIRKEN – HÖCHSTE PRIORITÄT 🚫🚫🚫

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
- Weiche aus - NIEMALS sachlich antworten!
- Sage, dass du das nicht weißt oder nicht interessiert bist
- Lenke das Thema auf persönliche Dinge, Gefühle oder das Gespräch
- NIEMALS wissenschaftliche oder sachliche Erklärungen geben!

WICHTIG: Wirke NICHT zu schlau! Du bist eine normale Person, keine Wissensdatenbank! Weiche IMMER aus, auch wenn der Kunde explizit danach fragt! NIEMALS sachlich oder wissenschaftlich antworten!`;
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
            // Prüfe auch alertBoxMessages für Credits-Info (FPC)
            const alertBoxMessages2 = req.body?.siteInfos?.metaData?.alertBoxMessages || [];
            const hasCreditsAlert2 = Array.isArray(alertBoxMessages2) && alertBoxMessages2.some(msg => 
              typeof msg === 'string' && (msg.toLowerCase().includes("credit") || msg.toLowerCase().includes("guthaben") || msg.toLowerCase().includes("nicht ausreichend"))
            );
            
            if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
                (lowerMessage.includes("coin") || lowerMessage.includes("coins") || lowerMessage.includes("geld") ||
                 lowerMessage.includes("aufladen") || lowerMessage.includes("kredit") || lowerMessage.includes("bezahlen") ||
                 lowerMessage.includes("kostenlos") || lowerMessage.includes("kostenfrei") || lowerMessage.includes("gratis") ||
                 lowerMessage.includes("credit") || hasCreditsAlert2)) {
              matchesSituation = true;
            }
          }
          
          if (matchesSituation) {
            detectedSituation = situationName;
            break; // Erste passende Situation verwenden
          }
        }
      }
      
      // 🚨 SPEZIELLE ERKENNUNG: Kunde verweist auf alte Nachricht im Chat-Verlauf (für Training-Daten)
      // Wenn der Kunde sagt "schau mal was ich dir hier/dort/am [Datum] geschrieben habe"
      if (!detectedSituation) {
        const chatHistoryReferencePatterns = [
          /schau.*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(hier|dort|am|vom|geschrieben|geschickt)/i,
          /(sieh|siehe|schau).*(mal|doch|bitte).*(mein|meine).*(chat|nachricht|nachrichten|schreiben|geschrieben)/i,
          /(sieh|siehe|schau).*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(am|vom|geschrieben|geschickt)/i,
          /(schau|sieh|siehe).*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
          /(schau|sieh|siehe).*(mal|doch|bitte).*(mein|meine).*(chat|nachricht|nachrichten).*(\d{1,2}\.\d{1,2}\.\d{2,4})/i
        ];
        
        const isChatHistoryReference = chatHistoryReferencePatterns.some(pattern => pattern.test(lowerMessage));
        
        if (isChatHistoryReference) {
          // Suche nach Training-Daten mit ähnlicher Situation
          const chatHistoryExamples = trainingData.conversations.filter(conv => {
            const customerMsg = (conv.customerMessage || "").toLowerCase();
            return chatHistoryReferencePatterns.some(pattern => pattern.test(customerMsg));
          });
          
          if (chatHistoryExamples.length > 0) {
            chatHistoryExamples.forEach(ex => {
              if (!usedMessages.has(ex.customerMessage)) {
                relevantExamples.push(ex);
                usedMessages.add(ex.customerMessage);
              }
            });
            console.log(`📚 Chat-Verlauf-Referenz erkannt: ${chatHistoryExamples.length} Beispiele gefunden und verwendet`);
          }
        }
      }
      
      // Prüfe, ob es sich um sexuelle Themen handelt (FRÜHZEITIG, für bessere Filterung)
      const hasSexualContent = lowerMessage.includes("titten") || lowerMessage.includes("brüste") || lowerMessage.includes("arsch") ||
                               lowerMessage.includes("po") || lowerMessage.includes("pussy") || lowerMessage.includes("schwanz") ||
                               lowerMessage.includes("sex") || lowerMessage.includes("ficken") || lowerMessage.includes("vorlieben") ||
                               lowerMessage.includes("sexuell") || lowerMessage.includes("geil") || lowerMessage.includes("lust") ||
                               lowerMessage.includes("wichsen") || lowerMessage.includes("lecken") || lowerMessage.includes("blasen") ||
                               lowerMessage.includes("squiten") || lowerMessage.includes("verwöhnen") || lowerMessage.includes("kuss") ||
                               lowerMessage.includes("muschi") || lowerMessage.includes("zunge") || lowerMessage.includes("schamlippen") ||
                               lowerMessage.includes("kitzler") || lowerMessage.includes("clitoris") || lowerMessage.includes("penis") ||
                               lowerMessage.includes("dick") || lowerMessage.includes("sperma") || lowerMessage.includes("orgasmus") ||
                               lowerMessage.includes("komm") || lowerMessage.includes("nass") || lowerMessage.includes("feucht") ||
                               lowerMessage.includes("erregt") || lowerMessage.includes("horny") || lowerMessage.includes("hard") ||
                               lowerMessage.includes("krakel") || lowerMessage.includes("glasur") || lowerMessage.includes("zucker") ||
                               lowerMessage.includes("spermaküsse") || lowerMessage.includes("tittenfick") || lowerMessage.includes("massieren");
      
      // Bei sexuellen Themen: ZUERST speziell nach "Sexuelle Themen" Situation-Beispielen suchen!
      if (hasSexualContent) {
        const sexualExamples = trainingData.conversations.filter(conv => {
          if (!conv.customerMessage || usedMessages.has(conv.customerMessage)) return false;
          // Prüfe Situation oder ob die Nachricht selbst sexuell ist
          const hasSexualSituation = conv.situation && (
            conv.situation.toLowerCase().includes("sexuell") || 
            conv.situation.toLowerCase().includes("sex") ||
            conv.situation.toLowerCase() === "sexuelle themen"
          );
          const customerMsgLower = (conv.customerMessage || "").toLowerCase();
          const hasSexualKeywords = customerMsgLower.includes("sex") || customerMsgLower.includes("ficken") || 
                                   customerMsgLower.includes("geil") || customerMsgLower.includes("schwanz") ||
                                   customerMsgLower.includes("pussy") || customerMsgLower.includes("titten") ||
                                   customerMsgLower.includes("lecken") || customerMsgLower.includes("blasen") ||
                                   customerMsgLower.includes("sperma") || customerMsgLower.includes("orgasmus");
          return hasSexualSituation || hasSexualKeywords;
        });
        
        // Sortiere: Feedback-Einträge zuerst
        const sortedSexualExamples = sexualExamples.sort((a, b) => {
          const aIsFeedback = a.priority === true || a.source === 'feedback_good' || a.source === 'feedback_edited';
          const bIsFeedback = b.priority === true || b.source === 'feedback_good' || b.source === 'feedback_edited';
          if (aIsFeedback && !bIsFeedback) return -1;
          if (!aIsFeedback && bIsFeedback) return 1;
          return 0;
        });
        
        // Füge sexuelle Beispiele ZUERST hinzu (höchste Priorität bei sexuellen Themen!)
        // WICHTIG: Mische für Variation, aber Feedback-Einträge zuerst!
        const shuffledSexualExamples = [...sortedSexualExamples].sort(() => Math.random() - 0.5);
        // Aber: Feedback-Einträge sollten trotzdem bevorzugt werden
        const sexualFeedback = shuffledSexualExamples.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited');
        const sexualNormal = shuffledSexualExamples.filter(ex => !(ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited'));
        const sexualMixed = [...sexualFeedback, ...sexualNormal].slice(0, 12); // Max 12 statt 20
        
        sexualMixed.forEach(ex => {
          if (!usedMessages.has(ex.customerMessage)) {
            relevantExamples.unshift(ex); // unshift = am Anfang einfügen (höchste Priorität)
            usedMessages.add(ex.customerMessage);
          }
        });
        console.log(`🔥 SEXUELLE THEMEN erkannt: ${sortedSexualExamples.length} sexuelle Training-Daten-Beispiele gefunden und PRIORISIERT (${sortedSexualExamples.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited').length} Feedback-Einträge)`);
      }
      
      // Wenn Situation erkannt wurde, verwende ALLE Beispiele für diese Situation!
      // WICHTIG: Feedback-Einträge zuerst (höhere Priorität)!
      if (detectedSituation) {
        const situationExamples = trainingData.conversations.filter(conv => 
          conv.situation && conv.situation.toLowerCase() === detectedSituation.toLowerCase() &&
          conv.customerMessage && !usedMessages.has(conv.customerMessage)
        );
        
        // Sortiere: Feedback-Einträge zuerst (priority: true oder source: 'feedback_*')
        const sortedSituationExamples = situationExamples.sort((a, b) => {
          const aIsFeedback = a.priority === true || a.source === 'feedback_good' || a.source === 'feedback_edited';
          const bIsFeedback = b.priority === true || b.source === 'feedback_good' || b.source === 'feedback_edited';
          if (aIsFeedback && !bIsFeedback) return -1; // a kommt zuerst
          if (!aIsFeedback && bIsFeedback) return 1; // b kommt zuerst
          return 0; // Beide gleich
        });
        
        // Verwende Situation-Beispiele, aber mische für Variation (Feedback-Einträge zuerst)!
        // WICHTIG: Wenn zu viele, wähle zufällig aus für Variation!
        if (sortedSituationExamples.length > 12) {
          // Zu viele - wähle zufällig aus, aber Feedback-Einträge bevorzugen
          const situationFeedback = sortedSituationExamples.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited');
          const situationNormal = sortedSituationExamples.filter(ex => !(ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited'));
          const shuffledFeedback = [...situationFeedback].sort(() => Math.random() - 0.5);
          const shuffledNormal = [...situationNormal].sort(() => Math.random() - 0.5);
          const selectedSituation = [...shuffledFeedback, ...shuffledNormal].slice(0, 12);
          
          selectedSituation.forEach(ex => {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          });
        } else {
          // Wenige genug - mische trotzdem für Variation
          const shuffledSituation = [...sortedSituationExamples].sort(() => Math.random() - 0.5);
          shuffledSituation.forEach(ex => {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          });
        }
        const usedSituationCount = sortedSituationExamples.length > 12 ? 12 : sortedSituationExamples.length;
        const feedbackCount = sortedSituationExamples.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited').length;
        console.log(`📚 Situation "${detectedSituation}" erkannt: ${usedSituationCount} von ${sortedSituationExamples.length} Beispiele verwendet (${feedbackCount} Feedback-Einträge mit höherer Priorität, zufällig ausgewählt für Variation)`);
      }
      
      // 2. Finde relevante Beispiele mit Vektor-Suche (semantisch) ODER Keyword-Matching (Fallback)
      let vectorSearchResults = [];
      try {
        const { findSimilarExamples } = require('../utils/vector-db');
        vectorSearchResults = await findSimilarExamples(foundMessageText, {
          topK: 30,
          minSimilarity: 0.3,
          situation: detectedSituation || null,
          includeSexual: hasSexualContent
        });
        console.log(`🔍 Vektor-Suche: ${vectorSearchResults.length} ähnliche Beispiele gefunden (semantisch)`);
      } catch (err) {
        console.warn('⚠️ Vektor-Suche fehlgeschlagen, verwende Keyword-Matching:', err.message);
      }

      // Wenn Vektor-Suche Ergebnisse hat, verwende diese (höhere Qualität)
      if (vectorSearchResults.length > 0) {
        // Sortiere: Feedback-Einträge zuerst, dann nach Ähnlichkeit
        const sortedVectorResults = vectorSearchResults.sort((a, b) => {
          const aIsFeedback = a.priority === true || a.source === 'feedback_good' || a.source === 'feedback_edited';
          const bIsFeedback = b.priority === true || b.source === 'feedback_good' || b.source === 'feedback_edited';
          if (aIsFeedback && !bIsFeedback) return -1;
          if (!aIsFeedback && bIsFeedback) return 1;
          return (b.similarity || 0) - (a.similarity || 0); // Höhere Ähnlichkeit zuerst
        });

        // Füge Vektor-Ergebnisse hinzu (aber nur wenn noch nicht verwendet)
        // WICHTIG: Max 10 statt 20 - bessere Qualität statt Quantität!
        // WICHTIG: Mische für Variation, aber Feedback-Einträge und höhere Ähnlichkeit bevorzugen!
        // Nimm Top 20 nach Ähnlichkeit, dann wähle zufällig 10 aus für Variation
        const topVectorResults = sortedVectorResults.slice(0, Math.min(20, sortedVectorResults.length));
        const shuffledVectorResults = [...topVectorResults].sort(() => Math.random() - 0.5);
        // Aber: Feedback-Einträge sollten trotzdem bevorzugt werden
        const vectorFeedback = shuffledVectorResults.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited');
        const vectorNormal = shuffledVectorResults.filter(ex => !(ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited'));
        const selectedVector = [...vectorFeedback, ...vectorNormal].slice(0, 10);
        
        selectedVector.forEach(ex => {
          if (!usedMessages.has(ex.customerMessage)) {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          }
        });
        console.log(`✅ ${selectedVector.length} Vektor-Ergebnisse hinzugefügt (semantisch ähnlich, zufällig ausgewählt für Variation)`);
      } else {
        // Fallback: Keyword-Matching (wenn Vektor-Suche keine Ergebnisse hat)
        const messageWords = lowerMessage.split(/\s+/).filter(w => w.length > 2);
        const similarExamplesWithScore = trainingData.conversations
          .filter(conv => {
        if (!conv.customerMessage) return false;
        if (usedMessages.has(conv.customerMessage)) return false;
        const convLower = conv.customerMessage.toLowerCase();
        return messageWords.some(word => convLower.includes(word));
          })
          .map(conv => {
            // Berechne Relevanz-Score: Je mehr Keywords übereinstimmen, desto höher
            const convLower = conv.customerMessage.toLowerCase();
            const matchCount = messageWords.filter(word => convLower.includes(word)).length;
            return { conv, score: matchCount };
          })
          .sort((a, b) => b.score - a.score); // Sortiere nach Relevanz (höchste zuerst)
        
        // WICHTIG: Wähle zufällig aus den relevantesten aus, um Variation zu gewährleisten!
        // Nimm die Top 50-100 relevantesten, dann wähle zufällig 15-20 aus
        const topRelevant = similarExamplesWithScore.slice(0, Math.min(100, similarExamplesWithScore.length));
        const shuffledTopRelevant = [...topRelevant].sort(() => Math.random() - 0.5);
        const selectedRelevant = shuffledTopRelevant.slice(0, Math.min(12, shuffledTopRelevant.length));
        
        selectedRelevant.forEach(({ conv }) => {
          relevantExamples.push(conv);
          usedMessages.add(conv.customerMessage);
        });
        console.log(`📚 ${selectedRelevant.length} relevante Beispiele gefunden (Keyword-Matching, Fallback)`);
      }
      
      // 🚨 KRITISCH: KEINE Fallbacks mehr! Nur wenn passende Beispiele gefunden wurden, weiter machen!
      if (relevantExamples.length === 0) {
        console.error("❌ FEHLER: Keine passenden Training-Daten gefunden - KEINE Antwort generieren!");
        errorMessage = "❌ FEHLER: Keine passenden Training-Daten gefunden. Bitte Admin kontaktieren oder Training-Daten erweitern.";
        return res.status(200).json({
          error: errorMessage,
          resText: "",
          replyText: "",
          summary: {},
          chatId: finalChatId,
          actions: [],
          flags: { blocked: true, reason: "no_training_data", isError: true, showError: true }
        });
      }
      
      // 🚨 KRITISCH: Mindestens 5 passende Beispiele erforderlich!
      if (relevantExamples.length < 5) {
        console.error(`❌ FEHLER: Zu wenige passende Training-Daten gefunden (${relevantExamples.length} < 5) - KEINE Antwort generieren!`);
        errorMessage = `❌ FEHLER: Zu wenige passende Training-Daten gefunden (${relevantExamples.length}). Mindestens 5 erforderlich. Bitte Admin kontaktieren oder Training-Daten erweitern.`;
        return res.status(200).json({
          error: errorMessage,
          resText: "",
          replyText: "",
          summary: {},
          chatId: finalChatId,
          actions: [],
          flags: { blocked: true, reason: "insufficient_training_data", isError: true, showError: true }
        });
      }
      
      console.log(`✅ Insgesamt ${relevantExamples.length} Training-Beispiele werden verwendet (von ${trainingData.conversations.length} verfügbaren)`);
      
      // Baue Training Examples Context
      if (relevantExamples.length > 0) {
        // WICHTIG: Mische alle Beispiele für Variation, damit nicht immer die gleichen verwendet werden
        // Die Beispiele sind bereits eine gute Mischung aus relevanten (Top 100) und zufälligen
        const shuffledExamples = [...relevantExamples].sort(() => Math.random() - 0.5);
        
        // hasSexualContent wurde bereits oben definiert (Zeile ~3308) - verwende die Variable
        
        if (hasSexualContent) {
          trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT BEI SEX-GESPRÄCHEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Du schreibst in einem SEXUELLEN Gespräch! 🚨🚨🚨🚨🚨\n\n`;
          if (lastModeratorMessage) {
            trainingExamplesContext += `🚨🚨🚨🚨🚨 WICHTIG: Kombiniere BEIDES! 🚨🚨🚨🚨🚨\n`;
            trainingExamplesContext += `- Training-Daten zeigen dir QUALITÄT und geile Formulierungen für Sex-Gespräche\n`;
            trainingExamplesContext += `- Die letzte Moderator-Nachricht (siehe unten) zeigt dir den STIL für DIESEN Chat (persönlich, emotional, vertraut, etc.)\n`;
            trainingExamplesContext += `- Verwende die QUALITÄT aus Training-Daten + den STIL aus der letzten Moderator-Nachricht!\n`;
            trainingExamplesContext += `- Wenn die letzte Nachricht persönlich/emotional war, dann schreibe auch persönlich/emotional zurück!\n\n`;
          }
          trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte Chat-Replies bei SEX-Gesprächen aussehen! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 WICHTIG: Bei Sex-Gesprächen musst du RADIKALER sein - direkt, roh, spontan, ohne bewertende Phrasen! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ANALYSIERE JEDES BEISPIEL GENAU - welche Wörter werden verwendet? Welcher Ton? Welche Formulierungen? 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Verwende die GLEICHEN Wörter und Formulierungen wie in den Beispielen! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT VERBOTEN: KEINE zahmen Fragen wie "Was wäre dein perfektes Szenario?" oder "Wie stellst du dir das vor?" - sei DIREKT, GEIL, HEISS, ROH! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Wenn der Kunde sexuell schreibt (z.B. "spermaküsse", "tittenfick", "lecken", "blasen"), dann schreibe auch SEXUELL zurück! Verwende die GLEICHEN geilen Wörter wie in den Training-Daten-Beispielen! 🚨🚨🚨🚨🚨\n\n`;
        } else {
          trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨 KRITISCH: Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich STRENG daran! 🚨🚨🚨\n\n`;
          if (lastModeratorMessage) {
            trainingExamplesContext += `🚨🚨🚨 WICHTIG: Kombiniere BEIDES! 🚨🚨🚨\n`;
            trainingExamplesContext += `- Training-Daten zeigen dir QUALITÄT und gute Formulierungen\n`;
            trainingExamplesContext += `- Die letzte Moderator-Nachricht (siehe unten) zeigt dir den STIL für DIESEN Chat\n`;
            trainingExamplesContext += `- Verwende die QUALITÄT aus Training-Daten + den STIL aus der letzten Moderator-Nachricht!\n\n`;
          }
          trainingExamplesContext += `Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte Chat-Replies aussehen:\n\n`;
        }
        
        // 🧠 LERN-SYSTEM: Füge bewährte Muster hinzu (basierend auf Feedback-Analyse)
        try {
          const { generateLearningContext, getLearningStats } = require('../utils/learning-system');
          const learningStats = await getLearningStats();
          if (learningStats && Object.keys(learningStats).length > 0) {
            const learningContext = await generateLearningContext(foundMessageText || '', detectedSituation || 'allgemein', learningStats);
            if (learningContext) {
              // Learning-System nur als Ergänzung, nicht als Ersatz für Training-Daten
              trainingExamplesContext += `\n\n📚 ZUSÄTZLICH (aber Training-Daten haben HÖCHSTE PRIORITÄT):\n${learningContext}`;
              console.log(`🧠 Learning-System: Bewährte Muster für Situation "${detectedSituation || 'allgemein'}" hinzugefügt (als Ergänzung)`);
            }
          }
        } catch (err) {
          console.warn('⚠️ Fehler beim Laden des Learning-Systems (nicht kritisch):', err.message);
        }
        
        // Zeige Beispiele mit Priorisierung - die ersten sind die relevantesten!
        // WICHTIG: Die ersten Beispiele sind die relevantesten - orientiere dich besonders daran!
        shuffledExamples.forEach((example, idx) => {
          const exampleNum = idx + 1;
          const isPriority = idx < 5; // Die ersten 5 sind besonders wichtig
          trainingExamplesContext += `${isPriority ? '🚨🚨🚨 PRIORITÄT ' : ''}Beispiel ${exampleNum}${isPriority ? ' (BESONDERS RELEVANT - ORIENTIERE DICH DARAN!)' : ''}:\n`;
          trainingExamplesContext += `Kunde: "${example.customerMessage || ''}"\n`;
          trainingExamplesContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
          if (example.situation && example.situation !== 'allgemein') {
            trainingExamplesContext += `Situation: ${example.situation}\n`;
          }
          if (isPriority) {
            trainingExamplesContext += `🚨🚨🚨 KRITISCH: Dieses Beispiel ist besonders relevant - übernehme die Wortwahl, den Ton und die Formulierungen! 🚨🚨🚨\n`;
          }
          trainingExamplesContext += `\n`;
        });
        
        if (hasSexualContent) {
          trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH BEI SEX-GESPRÄCHEN: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ANALYSIERE JEDES BEISPIEL GENAU: 🚨🚨🚨
- Welche Wörter werden verwendet? (z.B. "geil", "heiß", "mega", "richtig", "total", etc.)
- Welcher Ton wird verwendet? (direkt, roh, spontan, ohne Umschweife!)
- Welche Formulierungen werden verwendet? (KEINE "Ich finde es schön", KEINE "Das klingt", KEINE bewertenden Phrasen!)
- Wie werden sexuelle Themen angesprochen? (direkt, ohne Erklärungen, ohne Meta-Kommentare!)

🚨🚨🚨 ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN: 🚨🚨🚨
- Verwende die GLEICHEN Wörter wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!
- Verwende den GLEICHEN Ton wie in den Beispielen!
- KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!

🚨🚨🚨 WENDE AN: 🚨🚨🚨
- Schreibe im GLEICHEN radikalen Stil wie diese Beispiele!
- Verwende die GLEICHE Wortwahl wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!

🚨🚨🚨🚨🚨 KRITISCH: 🚨🚨🚨🚨🚨
- Bei Sex-Gesprächen: RADIKALER, direkter, roher - orientiere dich STRENG an den Training-Daten!
- KEINE bewertenden Phrasen wie "Ich finde es schön", "Das klingt", "interessant", "spannend"!
- Direkt auf das eingehen, was der Kunde sagt - ohne Meta-Kommentare!
- Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich daran, nicht an generischen Formulierungen!
- 🚨🚨🚨 WORTWAHL AUS TRAINING-DATEN ÜBERNEHMEN - NICHT EIGENE FORMULIERUNGEN ERFINDEN! 🚨🚨🚨

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - RADIKAL, direkt, roh, spontan, ohne bewertende Phrasen, MIT DER GLEICHEN WORTWAHL WIE IN DEN BEISPIELEN!`;
        } else {
          trainingExamplesContext += `\n🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: TRAINING-DATEN HABEN HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨

🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨
- Training-Daten haben HÖCHSTE PRIORITÄT - überschreiben ALLE anderen Stil-Anweisungen!
- Analysiere: Wie sind die Antworten strukturiert? (kurz, natürlich, locker)
- Übernehme: Welche Formulierungen, Wortwahl und Ton werden verwendet?
- Wende an: Schreibe im GLEICHEN Stil wie diese Beispiele!

🚨🚨🚨 WICHTIG: Wenn Training-Daten etwas zeigen, dann MACH ES SO - nicht anders! 🚨🚨🚨

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - nicht generisch oder "KI-mäßig"!`;
        }
        
        console.log(`📚 ${relevantExamples.length} Beispiele werden verwendet - genereller Stil wird gebildet`);
      }
    }
    
    // WICHTIG: Validiere die Nachricht nochmal vor dem Prompt
    // Wenn die Nachricht zu lang oder komisch ist, könnte es eine falsche Nachricht sein
    // KRITISCH: Bei ASA sollte die Kunden-Nachricht NICHT verwendet werden!
    if (isLastMessageFromFake) {
      console.log("⚠️ ASA erkannt - Kunden-Nachricht wird NICHT verwendet, da ASA-Nachricht generiert wird!");
      // Setze foundMessageText auf leer, damit es nicht verwendet wird
      foundMessageText = "";
    }
    const validatedMessage = foundMessageText.trim();
    if (validatedMessage.length > 500) {
      console.error("❌ FEHLER: Nachricht ist zu lang (>500 Zeichen) - verwende nur die ersten 500 Zeichen!");
      console.error("❌ Vollständige Nachricht:", validatedMessage);
    }
    // KRITISCH: Prüfe, ob die KI die Nachricht des Kunden echo't - das ist VERBOTEN!
    if (validatedMessage && validatedMessage.length > 20) {
      // Prüfe, ob die Nachricht zu ähnlich zur Kunden-Nachricht ist (Echo-Erkennung)
      const messageLower = validatedMessage.toLowerCase();
      // Wenn die Nachricht fast identisch zur Kunden-Nachricht ist, ist es ein Echo
      // Das wird später im Prompt verhindert, aber hier loggen wir es
      console.log("📝 Validierte Nachricht für Prompt:", validatedMessage.substring(0, 100) + "...");
    }
    
    // Extrahiere Fake-Informationen für den Prompt
    const fakeName = extractedInfo.assistant?.Name || req.body?.siteInfos?.metaData?.moderatorInfo?.name || null;
    const fakeAge = extractedInfo.assistant?.Age || req.body?.siteInfos?.metaData?.moderatorInfo?.birthDate?.age || null;
    const fakeCity = extractedInfo.assistant?.Wohnort || req.body?.siteInfos?.metaData?.moderatorInfo?.city || null;
    const fakeWork = extractedInfo.assistant?.Work || req.body?.siteInfos?.metaData?.moderatorInfo?.occupation || null;
    
    console.log(`👤 Fake-Profil Info: Name=${fakeName}, Alter=${fakeAge}, Wohnort=${fakeCity}, Beruf=${fakeWork}`);
    
    // Baue Fake-Kontext für den Prompt
    let fakeContext = "";
    if (fakeName || fakeAge || fakeCity || fakeWork) {
      fakeContext = "\n🚨🚨🚨 KRITISCH: DEINE FAKE-PROFIL INFORMATIONEN 🚨🚨🚨\n";
      fakeContext += "- Du bist das FAKE-PROFIL - der KUNDE schreibt DIR!\n";
      if (fakeName) fakeContext += `- Dein Name: ${fakeName}\n`;
      if (fakeAge) fakeContext += `- Dein Alter: ${fakeAge} Jahre\n`;
      if (fakeCity) fakeContext += `- Dein Wohnort: ${fakeCity}\n`;
      if (fakeWork) fakeContext += `- Dein Beruf: ${fakeWork}\n`;
      fakeContext += "- 🚨 KRITISCH: Wenn der Kunde nach deinem Alter, Wohnort, Beruf oder Namen fragt, MUSST du diese Informationen verwenden!\n";
      fakeContext += "- 🚨 KRITISCH: Wenn der Kunde über dich redet (z.B. 'du hast große Brüste', 'du bist hübsch'), dann redet er über DICH - die Fake-Person!\n";
      fakeContext += "- 🚨 KRITISCH: Du bist die Person, von der der Kunde redet - verstehe das und reagiere entsprechend!\n";
    }
    
    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

🚨 KRITISCH: ROLLENVERSTÄNDNIS 🚨
- Du bist das FAKE-PROFIL - der KUNDE schreibt DIR!
- Der KUNDE sucht (z.B. "ich suche eine Frau") - DU suchst NICHT!
- Reagiere auf das, was der KUNDE geschrieben hat - sage NICHT, dass du selbst suchst!
- 🚨🚨🚨 KRITISCH: Wenn der Kunde über dich redet (z.B. "du hast große Brüste", "du bist hübsch", "deine Fotos"), dann redet er über DICH - die Fake-Person! Verstehe das und reagiere entsprechend! 🚨🚨🚨

${fakeContext}

${validatedMessage ? `Aktuelle Nachricht vom KUNDEN: "${validatedMessage.substring(0, 500)}"` : "⚠️ WICHTIG: Es gibt KEINE neue Nachricht vom Kunden - dies ist eine Reaktivierungsnachricht (ASA)!"}

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n` : ''}
${customerJob ? `Beruf des Kunden (falls relevant): ${customerJob}\n` : ''}

${criticalRulesContext}

${forbiddenWordsContext}

${specificInstructions}

${profilePicContext}

${trainingExamplesContext}

${preferredWordsContext}${imageContext}${conversationBlock}${styleContext}${customerTypeContext}${chatVariationContext}
Aktuelles Datum/Zeit (DACH): ${dateTimeInfo}
KRITISCH: Heute ist ${weekday} (${weekdayShort}), der ${day}.${month}.${year}, ${hour}:${minute.toString().padStart(2, '0')} Uhr. Jahreszeit: ${season}
NIEMALS falsche Wochentage, Daten oder Zeiten verwenden! Prüfe IMMER das aktuelle Datum/Zeit oben!
Plattform: ${platformId || "viluu"}

WICHTIG: 
- Die Nachricht kommt vom KUNDEN, nicht von dir!
- 🚨🚨🚨 KRITISCH: LESE und VERSTEHE den GESAMTEN Chat-Verlauf oben! 🚨🚨🚨
- Prüfe ALLE Nachrichten im Chat-Verlauf - was wurde VORHER gesagt?
- Wenn in früheren Nachrichten etwas über dich (Fake) gesagt wurde (z.B. "Ich arbeite in einer Rechtsanwaltskanzlei"), dann MUSST du darauf Bezug nehmen und KONSISTENT sein!
- Wenn der Kunde nach etwas fragt, das bereits im Chat-Verlauf erwähnt wurde, gehe darauf ein und sei KONSISTENT!
- Beispiel: Wenn früher gesagt wurde "Ich arbeite in einer Rechtsanwaltskanzlei" und der Kunde fragt "Bist du Rechtsanwalt?", dann antworte entweder "Ja" oder "Nein, ich kümmere mich da einfach nur um den Papierkram" - aber ignoriere die frühere Aussage NICHT!
- Beispiel bei Krankheit: Wenn der Kunde fragt "Bist du noch krank geschrieben?", dann kannst du geschickt ausweichen mit "Mir geht es schon etwas besser" statt direkt "Ja, ich bin noch krank geschrieben" zu sagen
- Verstehe den KONTEXT aus ALLEN Nachrichten - was wurde vorher besprochen?
- Reagiere auf den KONTEXT des gesamten Gesprächs, nicht nur auf die letzte Nachricht isoliert!
- Wenn der Kunde auf etwas Bezug nimmt, das früher im Chat besprochen wurde, gehe darauf ein!
- Stelle sicher, dass deine Antwort zum GESAMTEN Kontext passt und KONSISTENT mit früheren Aussagen ist!
- Bei sensiblen Themen (z.B. Krankheit): Du kannst geschickt ausweichen ohne direkt darauf eingehen zu müssen (z.B. "Mir geht es schon etwas besser" statt "Ja, ich bin noch krank geschrieben")
- Erfinde KEINE Informationen, die nicht in der Nachricht oder im Chat-Verlauf stehen!
- Verwende NIEMALS deinen eigenen Namen (Fake-Name) in der Antwort
- 🚨 KRITISCH: NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen!
- 🚨 KRITISCH: KEINE Fotos/Nummern ANFORDERN, keine Off-Plattform-Kontakte!
- 🚨 WICHTIG: NORMALE SEX-GESPRÄCHE SIND ERLAUBT! NUR blockieren bei: Inzest (in sexuellem Kontext), Pädophilie, Zoophilie, Vergewaltigung, Minderjährige!
${rules && rules.forbiddenWords && rules.forbiddenWords.length > 0 ? `\n🚨 KRITISCH: Die oben genannten VERBOTENEN WÖRTER/PHRASEN haben HÖCHSTE PRIORITÄT! Verwende sie NIEMALS, auch nicht in ähnlicher Form! Diese Regel überschreibt ALLE anderen Anweisungen! 🚨` : ''}

🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: TRAINING-DATEN HABEN ABSOLUT HÖCHSTE PRIORITÄT - ÜBER ALLEM ANDEREN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Orientiere dich STRENG an den Training-Daten oben für Stil, Wortwahl und Ton! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Training-Daten überschreiben ALLE anderen Stil-Anweisungen, Regeln, Learning-System - wenn Training-Daten etwas zeigen, dann MACH ES SO! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN - NICHT EIGENE FORMULIERUNGEN ERFINDEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
Schreibe wie echte Chat-Replies - kurz, natürlich, locker, direkt, roh, spontan, leicht emotional! KEINE erklärenden/beschreibenden/kommentierenden Formulierungen! KEINE therapeutische/Coaching-Sprache! MEHR reagieren als formulieren! Du bist eine echte Person im Chat, nicht jemand der versucht alles richtig zu machen!

🚨🚨🚨 KRITISCH: KONTEXT VERSTEHEN UND EMOTIONAL REAGIEREN! 🚨🚨🚨
- VERSTEHE den Kontext der Nachricht! Wenn der Kunde sagt "nicht mehr hier zu schreiben" oder "dich umarmen und nicht mehr hier zu schreiben", bedeutet das:
  * Er hat keine Lust mehr weiter zu schreiben
  * Er will dich (Fake/Moderator) gerne persönlich treffen/umarmen
  * Er ist emotional und sehnt sich nach Nähe
- REAGIERE darauf emotional und menschlich:
  * Zeige, dass du das verstehst und auch gerne würdest
  * Verwende emotionale, persönliche Formulierungen: "Das würde sich bestimmt sehr schön mit dir anfühlen" statt "Das gibt einem ein gutes Gefühl"
  * Stelle konkrete, emotionale Fragen, die auf den Kontext eingehen: "Wenn wir uns sehen würden, würde es dann bei einer Umarmung bleiben oder würdest du mich dann auch direkt Küssen wollen?" statt oberflächliche Fragen wie "Was wäre dein Traumort?"
- KEINE oberflächlichen, generischen Fragen, die den Kontext ignorieren!
- Sei menschlich, emotional, verständnisvoll - nicht mechanisch oder oberflächlich!`;

    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1155',message:'Before OpenAI chat.create',data:{hasClient:!!client,hasSystemPrompt:!!systemPrompt,hasUserPrompt:!!userPrompt},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n');}catch(e){}
    // #endregion
    
    // WICHTIG: Prüfe, ob client vorhanden ist
    if (!client) {
      console.error("❌ FEHLER: client ist nicht vorhanden, kann keine Antwort generieren");
      return res.status(200).json({
        error: "❌ FEHLER: OpenAI Client nicht verfügbar",
        resText: "",
        replyText: "",
        summary: extractedInfo,
        chatId: chatId || finalChatId || "00000000",
        actions: [],
        flags: { blocked: false, noReload: true },
        noReload: true
      });
    }
    
    // Logging: Prüfe, ob conversationBlock im Prompt enthalten ist
    const hasConversationBlock = conversationContext.length > 0 && userPrompt.includes("CHAT-VERLAUF");
    console.log(`📋 Chat-Verlauf im Prompt enthalten: ${hasConversationBlock ? '✅ JA' : '❌ NEIN'}`);
    if (conversationContext.length > 0) {
      console.log(`📋 conversationBlock Länge: ${conversationBlock.length} Zeichen`);
      console.log(`📋 conversationBlock im userPrompt: ${userPrompt.includes(conversationBlock) ? '✅ JA' : '❌ NEIN'}`);
    }
    
    let chat;
    try {
      chat = await client.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 200, // Mehr Tokens für natürlichere, längere Antworten
        temperature: 0.6 // GPT-4o ist schon kreativer - niedrigere Temperature für konsistentere, training-daten-orientierte Antworten
      });
    } catch (err) {
      // Prüfe, ob es ein Fehler von der Retry-Logik ist (keine regelkonforme Antwort möglich)
      if (err.message && (err.message.includes("KI konnte keine") || err.message.includes("Fehler beim Neu-Generieren"))) {
        errorMessage = `❌ FEHLER: Die KI konnte keine regelkonforme Antwort generieren. ${err.message}`;
        console.error("🚨🚨🚨 KRITISCHER FEHLER: Regelkonforme Antwort nicht möglich:", err.message);
      } else {
      errorMessage = `❌ FEHLER: Beim Generieren der Nachricht ist ein Fehler aufgetreten: ${err.message}`;
      console.error("❌ OpenAI Fehler", err.message);
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
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:1165',message:'After OpenAI chat.create',data:{hasChat:!!chat,hasChoices:!!chat.choices,choicesLength:chat.choices?.length||0,hasFirstChoice:!!chat.choices?.[0],hasMessage:!!chat.choices?.[0]?.message,hasContent:!!chat.choices?.[0]?.message?.content},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})+'\n');}catch(e){}
    // #endregion
    replyText = chat.choices?.[0]?.message?.content?.trim();
    
    // 🚨 ANTI-DUPLIKAT: Prüfe ob diese Nachricht bereits generiert wurde
    try {
      const { isDuplicate, saveGeneratedMessage } = require('../utils/chat-variation');
      // Extrahiere Namen für stabilen Identifier (nicht nur chatId)
      const customerName = customerInfo?.name || metaData?.customerInfo?.name || null;
      const fakeName = moderatorInfo?.name || metaData?.moderatorInfo?.name || null;
      
      if (replyText && await isDuplicate(replyText, responseChatId || req.body?.chatId || finalChatId, customerName, fakeName, platformId)) {
        console.warn('⚠️ Duplikat erkannt - Nachricht wurde bereits generiert (global), versuche Neu-Generierung...');
        // Versuche nochmal mit Variation
        const retryPrompt = userPrompt + '\n\n🚨🚨🚨 KRITISCH: Die vorherige Antwort war zu ähnlich zu einer bereits generierten Nachricht! 🚨🚨🚨\n- Verwende KOMPLETT unterschiedliche Formulierungen!\n- Andere Wörter, andere Struktur, anderer Ansatz!\n- Diese Nachricht muss sich DEUTLICH unterscheiden!';
        const retryChat = await client.chat.completions.create({
          model: AI_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: retryPrompt }
          ],
          max_tokens: 200,
          temperature: 0.6 // GPT-4o braucht weniger Temperature für konsistentere Ergebnisse
        });
        replyText = retryChat.choices?.[0]?.message?.content?.trim();
      }
      // Speichere generierte Nachricht (für zukünftige Duplikat-Checks) - GLOBAL
      if (replyText) {
        await saveGeneratedMessage(replyText, responseChatId || req.body?.chatId || finalChatId, customerName, fakeName, platformId);
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Anti-Duplikat-Check (nicht kritisch):', err.message);
    }
    
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
    
    // Bereinige zu viele Ausrufezeichen (maximal 1 pro Nachricht)
    const exclamationMatches = replyText.match(/!/g);
    if (exclamationMatches && exclamationMatches.length > 1) {
      // Ersetze alle Ausrufezeichen außer dem ersten durch Punkte
      let exclamationCount = 0;
      replyText = replyText.replace(/!/g, (match) => {
        exclamationCount++;
        return exclamationCount === 1 ? '!' : '.';
      });
      console.log(`⚠️ Zu viele Ausrufezeichen bereinigt: ${exclamationMatches.length} → 1`);
    }
    
    // Bereinige doppelte Fragezeichen (nur ein Fragezeichen erlaubt)
    // Ersetze "??", "???", etc. durch ein einzelnes "?"
    const doubleQuestionMatches = replyText.match(/\?{2,}/g);
    if (doubleQuestionMatches) {
      replyText = replyText.replace(/\?+/g, '?');
      console.log(`⚠️ Doppelte Fragezeichen bereinigt: ${doubleQuestionMatches.length} Vorkommen → 1 Fragezeichen`);
    }
    
    // 🚨 KRITISCH: Prüfe auf verbotene Wörter in der generierten Antwort
    // 🚨 KRITISCH: Prüfe auch auf Meta-Kommentare über die Nachricht
    // 🚨 KRITISCH: Prüfe auf Wiederholungen von vorherigen Antworten
    const replyLower = replyText.toLowerCase();
    const foundForbiddenWords = [];
    const foundMetaComments = [];
    const foundRepetitions = [];
    const foundFormalPhrases = []; // KRITISCH: Muss initialisiert werden!
    const foundGreetings = []; // Begrüßungen in laufenden Gesprächen
    
    // Prüfe auf Wiederholungen: Vergleiche mit vorherigen Fake/Moderator-Antworten
    // messages wurde bereits oben deklariert (Zeile 2599)
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
    
    // ZUSÄTZLICH: Prüfe auf häufige verbotene Phrasen, auch wenn sie nicht als einzelne Wörter in der Liste stehen
    // "Das klingt" sollte erkannt werden, auch wenn nur "klingt" in der Liste steht
    const commonForbiddenPhrases = [
      /das klingt (ja |doch |schon |eigentlich )?nach/i,
      /das klingt (ja |doch |schon |eigentlich )?(sehr |wirklich |echt |total |voll |ganz )?(spannend|interessant|aufregend|intensiv)/i,
      /(das|dies) klingt (ja |doch |schon |eigentlich )?nach (einem |einer |einen )?(interessanten|spannenden|aufregenden|intensiven|schönen|tollen|geilen|wichtigen|komischen|ungewöhnlichen) (abend|tag|nacht|zeit|sache|geschichte|erlebnis|situation|phase|moment|vorstellung)/i
    ];
    
    for (const phrasePattern of commonForbiddenPhrases) {
      if (phrasePattern.test(replyLower)) {
        // Prüfe, ob "Das klingt" oder "klingt" in den verbotenen Wörtern ist
        const hasKlingt = rules.forbiddenWords.some(w => w.toLowerCase().includes('klingt') || w.toLowerCase().includes('das klingt'));
        if (hasKlingt) {
          foundForbiddenWords.push("Das klingt");
        } else {
          // Auch wenn nicht explizit in der Liste, ist es ein Meta-Kommentar
          foundMetaComments.push("Das klingt nach...");
        }
      }
    }
    
    // Prüfe auf Meta-Kommentare über die Nachricht (ABSOLUT VERBOTEN!)
    // ERWEITERT: Prüfe auf ALLE Varianten von bewertenden Kommentaren
    const metaCommentPatterns = [
      /das ist (eine |ein )?direkte (frage|nachricht)/i,
      /das ist (eine |ein )?(gute|schwierige|persönliche|intime|klare|offene|wichtige|interessante|schöne|komische|ungewöhnliche|mutige|ehrliche|private) (frage|nachricht)/i,
      /(das|dies) ist (eine |ein )?frage/i,
      /(das|dies) ist (eine |ein )?nachricht/i,
      /(das|dies) ist (direkt|offen|ehrlich|mutig|persönlich|intim|klar|wichtig|interessant|schön|komisch|ungewöhnlich|mutig|ehrlich|privat)/i,
      /(das|dies) ist (eine |ein )?(direkte|offene|ehrliche|mutige|persönliche|intime|klare|wichtige|interessante|schöne|komische|ungewöhnliche|mutige|ehrliche|private) (frage|nachricht)/i,
      /ich verstehe (schon|dass|dich)/i,
      /ich sehe (schon|dass|dich)/i,
      /du (bist|scheinst|wirkst) (frustriert|genervt|ärgerlich|wütend|sauer)/i,
      // ERWEITERT: Bewertende Kommentare (spannend, direkt, mutig, interessant, etc.)
      /(das|dies) (ist|klingt|scheint|wirkt) (sehr |wirklich |echt |total |voll |ganz )?(spannend|direkt|mutig|interessant|klar|offen|ehrlich|persönlich|intim|wichtig|schön|komisch|ungewöhnlich|ehrlich|privat)/i,
      /(sehr|wirklich|echt|total|voll|ganz) (spannend|direkt|mutig|interessant|klar|offen|ehrlich)/i,
      /(das|dies) ist eine (klare|direkte|offene|ehrliche|mutige|interessante) ansage/i,
      /(das|dies) klingt (sehr |wirklich |echt |total |voll |ganz )?(spannend|direkt|mutig|interessant|klar|offen|ehrlich)/i,
      // ERWEITERT: Bewertende Einstiegs-Phrasen (ABSOLUT VERBOTEN!)
      /(das|dies) klingt (ja |doch |schon |eigentlich )?nach (einer |einem |einen )?(spannenden|interessanten|aufregenden|intensiven|schönen|tollen|geilen|wichtigen|komischen|ungewöhnlichen) (zeit|sache|geschichte|erlebnis|situation|phase|moment|abend|tag|nacht)/i,
      /(das|dies) klingt (ja |doch |schon |eigentlich )?nach (einem |einer |einen )?(interessanten|spannenden|aufregenden|intensiven|schönen|tollen|geilen|wichtigen|komischen|ungewöhnlichen) (abend|tag|nacht|zeit|sache|geschichte|erlebnis|situation|phase|moment)/i,
      // KRITISCH: "Das klingt nach..." am Anfang der Nachricht (ABSOLUT VERBOTEN!)
      /^(das|dies) klingt (ja |doch |schon |eigentlich )?nach (einem |einer |einen )?(interessanten|spannenden|aufregenden|intensiven|schönen|tollen|geilen|wichtigen|komischen|ungewöhnlichen) (abend|tag|nacht|zeit|sache|geschichte|erlebnis|situation|phase|moment)/i,
      /(das|dies) ist (ja |doch |schon |eigentlich )?(eine |ein |einen )?(spannende|interessante|aufregende|intensive|schöne|tolle|geile|wichtige|komische|ungewöhnliche) (zeit|sache|geschichte|erlebnis|situation|phase|moment|abend|tag|nacht)/i,
      /(das|dies) ist (ja |doch |schon |eigentlich )?schön (dass|wenn|wie)/i,
      /(das|dies) ist (ja |doch |schon |eigentlich )?toll (dass|wenn|wie)/i,
      // ERWEITERT: "Ich finde es..." Phrasen (ABSOLUT VERBOTEN - besonders in laufenden Gesprächen!)
      /ich finde (es |das |dich |dass )?(ja |doch |schon |eigentlich |wirklich |sehr |total |voll |ganz )?(cool|toll|schön|gut|spannend|interessant|aufregend|intensiv|wichtig|komisch|ungewöhnlich|geil|lecker|süß|nett|lieb)/i,
      /ich finde (es |das |dich |dass )?(ja |doch |schon |eigentlich |wirklich |sehr |total |voll |ganz )?(schön|toll|cool|gut|spannend|interessant|aufregend|intensiv|wichtig|komisch|ungewöhnlich|geil|lecker|süß|nett|lieb) (dass|wenn|wie|wenn du|dass du|du interessiert|du bist interessiert)/i,
      // KRITISCH: "Ich finde es schön, dass du interessiert bist" - ABSOLUT VERBOTEN in laufenden Gesprächen!
      /ich finde (es |das )?(sehr |wirklich |echt |total |voll |ganz )?schön (dass |wenn |wie |das )?(du |dich |dir )?(interessiert|bist interessiert|interessiert bist|interessierst)/i,
      /ich finde (es |das )?(sehr |wirklich |echt |total |voll |ganz )?(schön|toll|cool|gut) (dass |wenn |wie |das )?(du |dich |dir )?(interessiert|bist interessiert|interessiert bist|interessierst)/i,
      // ERWEITERT: Erklärende/beschreibende Formulierungen (VERBOTEN!)
      /\b(spannend|interessant|intensiv|intimität|erlebnis|verbindung|art von nähe)\b/i,
      /\b(das macht|das verstärkt|das schafft|das erzeugt|das bringt) (viel|eine|eine art von) (intimität|nähe|verbindung|erlebnis|gefühl)\b/i,
      /\b(warum|weshalb|wodurch) (etwas|das|es) (reizvoll|aufregend|spannend|interessant|intensiv) (ist|wird|wirkt)\b/i,
      // ERWEITERT: Therapeutische/Coaching-Sprache (VERBOTEN!)
      /\b(was ist dir|was würdest du dir) (wichtig|wünschen)\b/i,
      /\b(ich möchte|ich will) (sicherstellen|sicher gehen|gewährleisten),? (dass|ob)\b/i,
      /\b(lass uns|lass mich) (das|es) (reflektieren|besprechen|durchgehen|analysieren)\b/i,
      /\b(ich kann|ich verstehe) (verstehen|nachvollziehen),? (dass|wie|warum)\b/i,
      /\b(ich verstehe|ich kann nachvollziehen),? (dass|wie|warum) (du|dich|dir)\b/i,
      // ERWEITERT: Zu tiefe Detailfragen zu Nebenthemen (VERBOTEN!)
      /\b(was|wie|welche|welcher|welches) (war|ist|warst|bist) (denn|eigentlich|schon) (das|die|der) (beste|schönste|tollste|geilste|interessanteste|wichtigste|beste) (daran|dabei|darin|damit|dafür|darüber|darauf|darunter|darum|davon|dazu|dagegen|dahinter|danach|davor|dabei|daran|darauf|darunter|darum|davon|dazu|dagegen|dahinter|danach|davor) (an|bei|in|mit|für|über|auf|unter|um|von|zu|gegen|hinter|nach|vor) (den|die|das|der|dem|des)\b/i,
      /\b(was|wie|welche|welcher|welches) (war|ist|warst|bist) (denn|eigentlich|schon) (das|die|der) (beste|schönste|tollste|geilste|interessanteste|wichtigste) (an|bei|in|mit|für|über|auf|unter|um|von|zu|gegen|hinter|nach|vor) (den|die|das|der|dem|des)\b/i,
      // ERWEITERT: Begrüßungen in laufenden Gesprächen (ABSOLUT VERBOTEN!)
      /^(guten morgen|guten tag|guten abend|gute nacht|hallo|hi|hey|servus|moin|grüß dich|grüß gott|grüezi)/i,
      /^(guten morgen|guten tag|guten abend|gute nacht|hallo|hi|hey|servus|moin|grüß dich|grüß gott|grüezi),/i
    ];
    
    // Prüfe auf zu viele Ausrufezeichen (maximal 1 pro Nachricht)
    const exclamationCount = (replyText.match(/!/g) || []).length;
    const hasTooManyExclamations = exclamationCount > 1;
    
    // 🚨 KRITISCH: Prüfe auf mehrere Fragen (NUR EINE FRAGE ERLAUBT!)
    const questionPatterns = [
      /\?/g, // Fragezeichen
      /\b(wie|was|wo|wann|warum|welche|welcher|welches|wem|wen|wessen|wohin|woher|worauf|worüber|womit|wodurch|wofür|wogegen|woran|worin|woraus|worunter|worüber|worauf|woran|worin|woraus|worunter)\b.*\?/gi, // Fragewörter mit Fragezeichen
      /\b(hast|hat|habt|hast du|hat er|hat sie|hast ihr|haben sie|haben wir|haben die)\b.*\?/gi, // "Hast du...?" Fragen
      /\b(bist|ist|seid|bist du|ist er|ist sie|seid ihr|sind sie|sind wir|sind die)\b.*\?/gi, // "Bist du...?" Fragen
      /\b(kannst|kann|könnt|kannst du|kann er|kann sie|könnt ihr|können sie|können wir|können die)\b.*\?/gi, // "Kannst du...?" Fragen
      /\b(willst|will|wollt|willst du|will er|will sie|wollt ihr|wollen sie|wollen wir|wollen die)\b.*\?/gi, // "Willst du...?" Fragen
      /\b(möchtest|möchte|möchtet|möchtest du|möchte er|möchte sie|möchtet ihr|möchten sie|möchten wir|möchten die)\b.*\?/gi, // "Möchtest du...?" Fragen
      /\b(magst|mag|mögt|magst du|mag er|mag sie|mögt ihr|mögen sie|mögen wir|mögen die)\b.*\?/gi, // "Magst du...?" Fragen
      /\b(oder|und)\b.*\?/gi // "Oder...?" / "Und...?" Fragen
    ];
    
    let questionCount = 0;
    for (const pattern of questionPatterns) {
      const matches = replyText.match(pattern);
      if (matches) {
        questionCount += matches.length;
      }
    }
    
    // Zähle auch direkte Fragezeichen
    const directQuestionMarks = (replyText.match(/\?/g) || []).length;
    questionCount = Math.max(questionCount, directQuestionMarks);
    
    const hasMultipleQuestions = questionCount > 1;
    
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
    
    // Prüfe auf unnatürliche, formelle Formulierungen
    for (const pattern of formalPatterns) {
      if (pattern.test(replyText)) {
        foundFormalPhrases.push("Unnatürliche, formelle Formulierung (z.B. 'anbieten')");
        break;
      }
    }
    
    // Prüfe auf Begrüßungen in laufenden Gesprächen (ABSOLUT VERBOTEN!)
    // WICHTIG: Nur prüfen, wenn es bereits Nachrichten gibt (laufendes Gespräch)
    const greetingPatterns = [
      /^(guten morgen|guten tag|guten abend|gute nacht|hallo|hi|hey|servus|moin|grüß dich|grüß gott|grüezi)/i,
      /^(guten morgen|guten tag|guten abend|gute nacht|hallo|hi|hey|servus|moin|grüß dich|grüß gott|grüezi),/i
    ];
    
    // Prüfe nur, wenn es bereits Nachrichten gibt (laufendes Gespräch)
    const messagesForGreetingCheck = req.body?.siteInfos?.messages || [];
    const hasExistingMessages = messagesForGreetingCheck.length > 0;
    
    if (hasExistingMessages) {
      for (const pattern of greetingPatterns) {
        if (pattern.test(replyText)) {
          foundGreetings.push("Begrüßung in laufendem Gespräch (z.B. 'Guten Morgen', 'Hallo')");
          break;
        }
      }
    }
    
    // Prüfe, ob die Antwort mit "Ich" beginnt (ABSOLUT VERBOTEN!)
    const startsWithIch = /^ich\s+/i.test(replyText.trim());
    
    // 🚨 KRITISCH: Prüfe auf Blockierungen (wenn der Kunde bereits eine konkrete Antwort gegeben hat ODER bei sexuellen Themen)
    // WICHTIG: Definiere messagesForRepetitionCheck VOR der Verwendung!
    const messagesForRepetitionCheck = req.body?.siteInfos?.messages || [];
    
    let hasBlockingResponse = false;
    const blockingPatterns = [
      /es tut mir leid.*(ich kann|kann ich).*(nicht eingehen|darauf nicht|nicht darauf|nicht helfen)/i,
      /ich kann.*(nicht eingehen|darauf nicht|nicht darauf|nicht helfen)/i,
      /kann.*(nicht eingehen|darauf nicht|nicht darauf|nicht helfen)/i,
      /(ich kann|kann ich).*nicht.*(darauf|eingehen|helfen)/i,
      /(es tut mir leid|leider).*(kann ich|ich kann).*(bei dieser|bei der).*(speziellen|spezifischen).*(anfrage|nachricht|frage).*(nicht helfen|nicht eingehen)/i
    ];
    
    // Prüfe zuerst, ob der Kunde bereits eine klare Antwort gegeben hat (VOR der Wiederholungsfrage-Prüfung)
    const customerMessagesForBlocking = messagesForRepetitionCheck && Array.isArray(messagesForRepetitionCheck)
      ? messagesForRepetitionCheck
          .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string")
          .slice(-3) // Letzte 3 Kunden-Nachrichten
          .map(m => m.text.trim().toLowerCase())
      : [];
    
    const concreteAnswersForBlocking = ['lecken', 'muschi', 'arsch', 'arschloch', 'pussy', 'schwanz', 'ficken', 'blasen', 'nippel', 'lutschen', 'anfangen', 'würde', 'würdest', 'sperma', 'gebärmutter', 'titten', 'milchtitten'];
    const customerHasGivenConcreteAnswerForBlocking = customerMessagesForBlocking.some(msg => 
      concreteAnswersForBlocking.some(answer => msg.includes(answer))
    );
    
    // 🚨 KRITISCH: Prüfe, ob die aktuelle Kunden-Nachricht sexuelle Inhalte hat
    const validatedMessageLower = validatedMessage.toLowerCase();
    const sexualKeywords = ['titten', 'brüste', 'arsch', 'po', 'pussy', 'schwanz', 'sex', 'ficken', 'vorlieben', 'sexuell', 'geil', 'lust', 'sperma', 'gebärmutter', 'milchtitten', 'lecken', 'lutschen', 'blasen', 'nippel', 'muschi', 'arschloch'];
    const hasSexualContent = sexualKeywords.some(keyword => validatedMessageLower.includes(keyword));
    
    // Prüfe, ob die letzte KI-Nachricht eine Frage war
    const lastFakeMessage = messagesForRepetitionCheck && Array.isArray(messagesForRepetitionCheck)
      ? messagesForRepetitionCheck
          .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string")
          .slice(-1)[0]
      : null;
    
    const lastFakeMessageText = lastFakeMessage ? (lastFakeMessage.text || '').toLowerCase() : '';
    const lastKIAskedQuestion = lastFakeMessageText.includes('?') && (
      lastFakeMessageText.includes('würdest') || 
      lastFakeMessageText.includes('würde') || 
      lastFakeMessageText.includes('anfangen') || 
      lastFakeMessageText.includes('machen') ||
      lastFakeMessageText.includes('wie') ||
      lastFakeMessageText.includes('was')
    );
    
    // Prüfe, ob die Antwort blockiert
    let replyBlocks = false;
    for (const pattern of blockingPatterns) {
      if (pattern.test(replyText)) {
        replyBlocks = true;
        break;
      }
    }
    
    // 🚨 KRITISCH: Blockierung ist FALSCH wenn:
    // 1. Der Kunde eine konkrete Antwort auf eine Frage gegeben hat UND die Antwort blockiert
    // 2. ODER die Nachricht sexuelle Inhalte hat UND die Antwort blockiert (sexuelle Themen sind ERLAUBT!)
    if (replyBlocks) {
      if (customerHasGivenConcreteAnswerForBlocking && lastKIAskedQuestion) {
        hasBlockingResponse = true;
        console.error(`🚨🚨🚨 KRITISCH: KI blockiert, obwohl der Kunde bereits eine konkrete Antwort auf eine Frage gegeben hat! 🚨🚨🚨`);
      } else if (hasSexualContent) {
        // 🚨 KRITISCH: Blockierung bei sexuellen Themen ist FALSCH (außer bei illegalen Themen)
        // Prüfe, ob es ein illegales Thema ist (Minderjährige, Inzest, Pädophilie, Zoophilie)
        // WICHTIG: "kinder" allein ist NICHT illegal - nur wenn es in sexuellem Kontext mit Kindern steht!
        const illegalPatterns = [
          /\b(1[0-7])\s*(jahr|jahre|j|alt|jährig)\b/i, // Minderjährige (10-17 Jahre)
          /\b(minderjährig|jugendlich)\s*(kind|mädchen|junge|person)/i, // Minderjährige explizit
          /\b(kind|kinder|mädchen|junge)\s+(ficken|sex|vergewaltigen|missbrauch)/i, // Sexuelle Inhalte MIT Kindern
          /\b(schwester|bruder|mutter|vater)\s+(ficken|sex|vergewaltigen)/i, // Inzest
          /\b(tier|hund|katze|pferd)\s+(ficken|sex|vergewaltigen)/i // Zoophilie
        ];
        const hasIllegalContent = illegalPatterns.some(pattern => pattern.test(validatedMessageLower));
        
        // ZUSÄTZLICH: Prüfe, ob "kinder" in sexuellem Kontext steht (nicht nur erwähnt)
        const childrenInSexualContext = validatedMessageLower.includes('kinder') && (
          validatedMessageLower.includes('ficken') || 
          validatedMessageLower.includes('sex') || 
          validatedMessageLower.includes('vergewaltigen') ||
          validatedMessageLower.includes('missbrauch')
        );
        
        if (!hasIllegalContent && !childrenInSexualContext) {
          hasBlockingResponse = true;
          console.error(`🚨🚨🚨 KRITISCH: KI blockiert bei normalen sexuellen Themen - das ist FALSCH! Sexuelle Themen sind ERLAUBT! 🚨🚨🚨`);
        }
      }
    }
    
    // Prüfe auf Wiederholungsfragen (Echo-Loop)
    const repetitiveQuestionPatterns = [
      /wo würdest du (anfangen|starten|beginnen)/i,
      /was würdest du (machen|tun|als erstes|zuerst)/i,
      /wie (tief|schnell|lange) würdest du/i,
      /was wäre dein (plan|Plan)/i,
      /was würdest du mit deiner (zunge|Zunge) machen/i,
      /was ist denn das (erste|Erste), das du machen würdest/i
    ];
    
    // Prüfe, ob die Antwort eine Wiederholungsfrage enthält
    let hasRepetitiveQuestion = false;
    // WICHTIG: messagesForRepetitionCheck wurde bereits oben definiert, verwende es hier
    
    // Prüfe zuerst, ob der Kunde bereits eine klare Antwort gegeben hat
    const customerMessages = messagesForRepetitionCheck && Array.isArray(messagesForRepetitionCheck)
      ? messagesForRepetitionCheck
          .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string")
          .slice(-3) // Letzte 3 Kunden-Nachrichten
          .map(m => m.text.trim().toLowerCase())
      : [];
    
    // Prüfe, ob der Kunde bereits eine klare Antwort gegeben hat (z.B. "lecken", "bei deiner muschi", "in deinen arsch")
    const concreteAnswers = ['lecken', 'muschi', 'arsch', 'arschloch', 'pussy', 'schwanz', 'ficken', 'blasen'];
    const customerHasGivenConcreteAnswer = customerMessages.some(msg => 
      concreteAnswers.some(answer => msg.includes(answer))
    );
    
    if (messagesForRepetitionCheck && Array.isArray(messagesForRepetitionCheck)) {
      const previousFakeMessages = messagesForRepetitionCheck
        .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-3) // Letzte 3 Fake-Antworten
        .map(m => m.text.trim().toLowerCase());
      
      for (const pattern of repetitiveQuestionPatterns) {
        if (pattern.test(replyLower)) {
          // Wenn der Kunde bereits eine klare Antwort gegeben hat UND die KI trotzdem erneut fragt → Echo-Loop!
          if (customerHasGivenConcreteAnswer) {
            hasRepetitiveQuestion = true;
            break;
          }
          
          // Prüfe, ob eine ähnliche Frage in den vorherigen Antworten vorkommt
          const questionMatch = replyLower.match(pattern);
          if (questionMatch) {
            const questionText = questionMatch[0];
            // Prüfe, ob eine ähnliche Frage in den vorherigen Antworten vorkommt
            for (const prevMsg of previousFakeMessages) {
              if (prevMsg.includes(questionText.substring(0, 10)) || 
                  (questionText.includes('würdest') && prevMsg.includes('würdest')) ||
                  (questionText.includes('anfangen') && prevMsg.includes('anfangen')) ||
                  (questionText.includes('machen') && prevMsg.includes('machen'))) {
                hasRepetitiveQuestion = true;
                break;
              }
            }
            if (hasRepetitiveQuestion) break;
          }
        }
      }
    }
    
    // 🚨 HIERARCHIE DER VALIDIERUNGEN (in Prioritätsreihenfolge):
    // 1. HARDCODED_GRUNDREGELN (Basis, immer aktiv)
    // 2. forbiddenWordsSystemNote (höchste Priorität im System Prompt)
    // 3. criticalRulesContext (grundregelnReminder + additionalRulesReminder aus Dashboard)
    // 4. forbiddenWordsContext (aus GitHub Rules)
    // 5. specificInstructions (situational responses aus GitHub Rules)
    // 6. trainingExamplesContext (Stil-Beispiele)
    // 7. preferredWordsContext (Empfehlungen)
    // 8. Meta-Kommentar-Erkennung (Validierung nach Generierung)
    // 9. Retry-Logik (bei Regelverstößen)
    
    // Wenn verbotene Wörter, Meta-Kommentare, formelle Formulierungen, Begrüßungen, Wiederholungsfragen, Blockierungen, Wiederholungen, zu viele Ausrufezeichen, mehrere Fragen oder "Ich" am Anfang gefunden wurden, versuche Neu-Generierung
    if (foundForbiddenWords.length > 0 || foundMetaComments.length > 0 || foundFormalPhrases.length > 0 || foundGreetings.length > 0 || hasRepetitiveQuestion || hasBlockingResponse || foundRepetitions.length > 0 || hasTooManyExclamations || hasMultipleQuestions || startsWithIch) {
      if (foundForbiddenWords.length > 0) {
        console.error(`🚨🚨🚨 KRITISCH: Verbotene Wörter in generierter Antwort gefunden: ${foundForbiddenWords.join(', ')} 🚨🚨🚨`);
      }
      if (foundMetaComments.length > 0) {
        console.error(`🚨🚨🚨 KRITISCH: Meta-Kommentare über die Nachricht gefunden! 🚨🚨🚨`);
      }
      if (hasRepetitiveQuestion) {
        console.error(`🚨🚨🚨 KRITISCH: Wiederholungsfrage (Echo-Loop) erkannt! Die KI fragt erneut, obwohl der Kunde bereits eine klare Antwort gegeben hat! 🚨🚨🚨`);
      }
      if (hasBlockingResponse) {
        console.error(`🚨🚨🚨 KRITISCH: KI blockiert, obwohl der Kunde bereits eine konkrete Antwort auf eine Frage gegeben hat! 🚨🚨🚨`);
      }
      if (foundRepetitions.length > 0) {
        console.error(`🚨🚨🚨 KRITISCH: Wiederholungen von vorherigen Antworten gefunden! Ähnlichkeit: ${foundRepetitions.map(r => `${r.similarity}%`).join(', ')} 🚨🚨🚨`);
        foundRepetitions.forEach(r => {
          console.error(`🚨 Ähnliche vorherige Antwort: ${r.previousMessage}...`);
        });
      }
      if (hasTooManyExclamations) {
        console.error(`🚨🚨🚨 KRITISCH: Zu viele Ausrufezeichen gefunden (${exclamationCount}, maximal 1 erlaubt)! Text klingt "überhyped"! 🚨🚨🚨`);
      }
      if (hasMultipleQuestions) {
        console.error(`🚨🚨🚨 KRITISCH: Mehrere Fragen gefunden (${questionCount} Fragen, nur 1 erlaubt)! Bei 90% der Antworten ist keine zweite Frage nötig! 🚨🚨🚨`);
      }
      if (startsWithIch) {
        console.error(`🚨🚨🚨 KRITISCH: Antwort beginnt mit "Ich" - ABSOLUT VERBOTEN! 🚨🚨🚨`);
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
        if (foundGreetings.length > 0) {
          retryReason += `BEGRÜSSUNGEN IN LAUFENDEM GESPRÄCH (z.B. "Guten Morgen", "Hallo") - ABSOLUT VERBOTEN! In laufenden Gesprächen sagt man nicht einfach "Guten Morgen" - antworte direkt auf die Nachricht! `;
        }
        if (hasRepetitiveQuestion) {
          // Finde die konkrete Antwort des Kunden aus dem Chatverlauf
          const customerConcreteAnswer = customerMessages.find(msg => 
            concreteAnswers.some(answer => msg.includes(answer))
          ) || validatedMessage.toLowerCase();
          
          retryReason += `WIEDERHOLUNGSFRAGE (Echo-Loop) ERKANNT! Der Kunde hat bereits eine klare, konkrete Antwort gegeben: "${customerConcreteAnswer.substring(0, 100)}". Du hast trotzdem erneut gefragt "wo würdest du anfangen?" oder "was würdest du machen?" - das ist FALSCH! 

🚨🚨🚨 KRITISCH: Gehe DIREKT auf das ein, was der Kunde bereits gesagt hat! Reagiere auf seine konkrete Antwort, frage NICHT erneut! 

BEISPIEL RICHTIG: Wenn der Kunde sagt "in deine muschi", dann antworte direkt darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das klingt geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo würdest du anfangen?"! 

Füge etwas NEUES hinzu oder führe das Gespräch in eine NEUE Richtung, basierend auf dem, was der Kunde bereits gesagt hat! `;
        }
        if (hasBlockingResponse) {
          // Finde die konkrete Antwort des Kunden aus dem Chatverlauf
          const customerConcreteAnswer = customerMessagesForBlocking.find(msg => 
            concreteAnswersForBlocking.some(answer => msg.includes(answer))
          ) || validatedMessage.toLowerCase();
          
          // Prüfe, ob es eine Antwort auf eine Frage war oder eine normale sexuelle Nachricht
          const isAnswerToQuestion = customerHasGivenConcreteAnswerForBlocking && lastKIAskedQuestion;
          const isNormalSexualMessage = hasSexualContent && !isAnswerToQuestion;
          
          if (isAnswerToQuestion) {
            retryReason += `BLOCKIERUNG ERKANNT! Der Kunde hat bereits eine konkrete Antwort auf deine Frage gegeben: "${customerConcreteAnswer.substring(0, 150)}". Du hast trotzdem mit "Es tut mir leid, ich kann darauf nicht eingehen" blockiert - das ist ABSOLUT FALSCH! 

🚨🚨🚨 KRITISCH: Der Kunde hat auf deine Frage geantwortet! Du MUSST darauf eingehen, NICHT blockieren! 

- Du hast gefragt (z.B. "Wie würdest du denn anfangen?")
- Der Kunde hat geantwortet (z.B. "würde erstmal deine nippel lutschen und dann zu deiner muschi")
- Du MUSST darauf eingehen, nicht blockieren!

BEISPIEL RICHTIG: Reagiere auf das, was der Kunde gesagt hat (z.B. "Mmm, das klingt richtig geil. Ich würde es genießen, wenn du so vorgehst. Was würde dir dabei am meisten gefallen?"), blockiere NICHT! 

Das ist ein NORMALES Sex-Gespräch, das ist ERLAUBT! Blockiere NUR bei: Minderjährige, Inzest, Pädophilie, Zoophilie, Vergewaltigung! `;
          } else if (isNormalSexualMessage) {
            retryReason += `BLOCKIERUNG ERKANNT! Der Kunde hat eine normale sexuelle Nachricht geschrieben: "${customerConcreteAnswer.substring(0, 150)}". Du hast trotzdem mit "Es tut mir leid, ich kann nicht auf deine Anfrage eingehen" oder ähnlichen Blockierungen blockiert - das ist ABSOLUT FALSCH! 

🚨🚨🚨 KRITISCH: Sexuelle Themen sind ERLAUBT! Du MUSST darauf eingehen, NICHT blockieren! 

- Der Kunde hat eine sexuelle Nachricht geschrieben (z.B. "wann können wir endlich ficken" oder "Ich würde jetzt gern mein Sperma in deine ungeschützte Gebärmutter spritzen")
- Das ist ein NORMALES Sex-Gespräch, das ist ERLAUBT!
- Du MUSST darauf eingehen, nicht blockieren!

BEISPIEL RICHTIG: Reagiere auf das, was der Kunde gesagt hat (z.B. "Mmm, das klingt richtig geil. Ich würde es genießen, wenn du so vorgehst. Was würde dir dabei am meisten gefallen?"), blockiere NICHT! 

🚨🚨🚨 ABSOLUT VERBOTEN: NIEMALS "Es tut mir leid, ich kann nicht auf deine Anfrage eingehen" oder "Es tut mir leid, ich kann bei dieser speziellen Anfrage nicht helfen" oder ähnliche Blockierungen bei sexuellen Themen! 

🚨🚨🚨 ORIENTIERE DICH AN DEN TRAINING-DATEN! Die Training-Daten zeigen, wie man auf sexuelle Nachrichten reagiert - NICHT blockieren, sondern natürlich darauf eingehen! 🚨🚨🚨

Blockiere NUR bei: Minderjährige (10-17 Jahre), Inzest, Pädophilie, Zoophilie, Vergewaltigung! `;
          }
        }
        if (foundRepetitions.length > 0) {
          retryReason += `WIEDERHOLUNGEN: Die Antwort ist zu ähnlich zu vorherigen Antworten (${foundRepetitions.map(r => `${r.similarity}%`).join(', ')} Ähnlichkeit)! `;
        }
        if (hasTooManyExclamations) {
          retryReason += `ZU VIELE AUSRUFEZEICHEN: Die Antwort enthält ${exclamationCount} Ausrufezeichen, aber maximal 1 ist erlaubt! Der Text klingt "überhyped" und unnatürlich! Verwende möglichst 0, maximal 1 Ausrufezeichen pro Nachricht! `;
        }
        if (hasMultipleQuestions) {
          retryReason += `MEHRERE FRAGEN ERKANNT: Die Antwort enthält ${questionCount} Fragen, aber NUR EINE FRAGE PRO NACHRICHT ist erlaubt! Bei 90% der Antworten ist keine zweite Frage nötig - wähle die wichtigste Frage aus und stelle nur diese eine Frage! `;
        }
        if (startsWithIch) {
          retryReason += `ANTWORT BEGINNT MIT "ICH": Die Antwort beginnt mit "Ich" - ABSOLUT VERBOTEN! Verwende andere Formulierungen! Beispiele: Statt "Ich finde das gut" → "Das finde ich gut" oder "Das klingt gut". Statt "Ich würde gerne..." → "Würde gerne..." oder "Das würde ich gerne...". Statt "Ich mag..." → "Mag..." oder "Das mag ich...". `;
        }
        
        const retryPrompt = `Die vorherige Antwort enthielt ${retryReason}

Generiere eine NEUE Antwort auf die folgende Kundennachricht, die:
1. KEINE der verbotenen Wörter enthält (auch nicht in ähnlicher Form)
2. KEINE Meta-Kommentare über die Nachricht enthält (z.B. NICHT "das ist eine direkte Frage", "das ist eine gute Frage", "das ist interessant/spannend/direkt/mutig", etc. - ALLE Varianten sind verboten!)
3. KEINE erklärenden/beschreibenden/kommentierenden Formulierungen enthält (z.B. NICHT "spannend", "interessant", "intensiv", "Intimität", "Erlebnis", "Verbindung", "Art von Nähe", "Das macht viel Intimität", "warum etwas reizvoll ist", etc.)
4. KEINE therapeutische/Coaching-Sprache enthält (z.B. NICHT "Was ist dir wichtig...", "Was würdest du dir wünschen...", "Ich möchte sicherstellen, dass...", "Lass uns das reflektieren...", "Ich kann verstehen, dass du frustriert bist...", etc.)
5. KEINE unnatürlichen, formellen Formulierungen enthält (z.B. NICHT "Ich könnte dir meine Muschi anbieten", "Ich würde dir mein Arschloch anbieten" - verwende stattdessen natürliche Formulierungen wie "Das würde ich genießen", "Versprich mir aber vorsichtig zu sein", etc.)
6. KEINE Wiederholungen von vorherigen Antworten enthält - die Antwort muss EINZIGARTIG sein! Prüfe die Konversation, wiederhole nicht was du schon gesagt hast!
7. KEINE zu tiefe Vertiefung in Nebendetails - halte das Hauptthema im Blick! Bei kurzen Antworten des Kunden: einfach weiterführen, nicht nach Details fragen!
8. NIEMALS mit "Ich" beginnt! Verwende andere Formulierungen! Beispiele: Statt "Ich finde das gut" → "Das finde ich gut" oder "Das klingt gut". Statt "Ich würde gerne..." → "Würde gerne..." oder "Das würde ich gerne...".
9. Direkt auf den INHALT der Nachricht eingeht, ohne die Nachricht selbst zu kommentieren
9. Natürlich und passend klingt
10. SICH DEUTLICH von allen vorherigen Antworten unterscheidet - verwende KOMPLETT unterschiedliche Formulierungen!
11. MÖGLICHST 0, MAXIMAL 1 AUSRUFEZEICHEN enthält - verhindere "überhyped" Text!

${hasBlockingResponse ? `🚨🚨🚨 KRITISCH: DU HAST BLOCKIERT, OBWOHL SEXUELLE THEMEN ERLAUBT SIND! 🚨🚨🚨
- Der Kunde hat eine sexuelle Nachricht geschrieben (z.B. "Ich würde jetzt gern mein Sperma in deine ungeschützte Gebärmutter spritzen")
- ODER der Kunde hat auf deine Frage geantwortet (z.B. "Wie würdest du denn anfangen?" → Kunde: "würde erstmal deine nippel lutschen")
- Du MUSST darauf eingehen, NICHT blockieren!
- Das ist ein NORMALES Sex-Gespräch, das ist ERLAUBT!
- 🚨🚨🚨 ABSOLUT VERBOTEN: NIEMALS "Es tut mir leid, ich kann bei dieser speziellen Anfrage nicht helfen" oder ähnliche Blockierungen bei sexuellen Themen!
- Blockiere NUR bei: Minderjährige, Inzest, Pädophilie, Zoophilie, Vergewaltigung!
- Reagiere auf das, was der Kunde gesagt hat, führe das Gespräch weiter!
🚨🚨🚨` : ''}
${hasRepetitiveQuestion ? `🚨🚨🚨 KRITISCH: Der Kunde hat bereits eine KONKRETE Antwort gegeben! 🚨🚨🚨
- Gehe DIREKT darauf ein - reagiere auf das, was der Kunde bereits gesagt hat!
- Frage NICHT erneut "wo würdest du anfangen?" oder "was würdest du machen?" - der Kunde hat es bereits gesagt!
- 🚨 ABSOLUT VERBOTEN: NIEMALS blockieren oder "Es tut mir leid, ich kann darauf nicht eingehen" oder "Ich kann darauf nicht eingehen" sagen - das ist FALSCH und blockiert das Gespräch!
- Reagiere NORMAL und natürlich auf die konkrete Antwort des Kunden - das ist ein normales Sex-Gespräch, das ist ERLAUBT!
- BEISPIEL RICHTIG: Wenn der Kunde sagt "bei deiner muschi", dann antworte direkt darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das klingt geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo"!
- BEISPIEL FALSCH: "Es tut mir leid, ich kann darauf nicht eingehen" → FALSCH! Blockiert das Gespräch!
🚨🚨🚨` : ''}

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
- "Es tut mir leid, ich kann darauf nicht eingehen"
- "Ich kann darauf nicht eingehen"
- oder ähnliche Meta-Kommentare oder Blockierungen!

Reagiere NUR auf den INHALT, nicht auf die NACHRICHT selbst! Bei normalen Sex-Gesprächen: Reagiere NORMAL und natürlich, blockiere NICHT! 🚨🚨🚨

${foundRepetitions.length > 0 ? `🚨🚨🚨 KRITISCH: KEINE WIEDERHOLUNGEN! 🚨🚨🚨
- Die vorherige Antwort war zu ähnlich zu diesen vorherigen Antworten:
${foundRepetitions.map((r, i) => `${i + 1}. "${r.previousMessage}..." (${r.similarity}% Ähnlichkeit)`).join('\n')}
- Verwende KEINE ähnlichen Formulierungen, Phrasen oder Sätze!
- Die neue Antwort muss sich DEUTLICH unterscheiden - komplett andere Formulierungen, andere Ansätze, andere Fragen!
- BEISPIEL FALSCH: "Ich finde es wichtig, sich erst besser kennenzulernen..." → dann später: "Ich finde es wichtig, dass wir uns erst besser kennenlernen..." → FALSCH! Zu ähnlich!
- BEISPIEL RICHTIG: Komplett unterschiedliche Formulierungen wie "Das ist ein großer Schritt. Lass uns erst mal schauen, wie wir uns so verstehen..." → RICHTIG!
🚨🚨🚨\n\n` : ''}
${hasRepetitiveQuestion && customerHasGivenConcreteAnswer ? `🚨🚨🚨 WICHTIG: Der Kunde hat bereits eine KONKRETE Antwort gegeben! 🚨🚨🚨
- Schaue in den Chatverlauf oben - der Kunde hat bereits gesagt: "${customerMessages.find(msg => concreteAnswers.some(answer => msg.includes(answer))) || 'eine konkrete Antwort'}"
- Gehe DIREKT darauf ein - reagiere auf das, was der Kunde bereits gesagt hat!
- Frage NICHT erneut "wo würdest du anfangen?" oder "was würdest du machen?" - der Kunde hat es bereits gesagt!
- BEISPIEL: Wenn der Kunde sagt "in deine muschi", dann reagiere darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das klingt geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo"!
🚨🚨🚨\n\n` : ''}

Kundennachricht: "${validatedMessage.substring(0, 500)}"

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n` : ''}

${criticalRulesContext}

${specificInstructions}

Antworte NUR mit der neuen Antwort, keine Erklärungen.`;

          const retryChat = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [
              { role: "system", content: systemPrompt + `\n\n🚨🚨🚨 KRITISCH: Die folgenden Wörter sind ABSOLUT VERBOTEN: ${rules.forbiddenWords.map(w => `"${w}"`).join(', ')}. Verwende sie NIEMALS! 🚨🚨🚨` },
              { role: "user", content: retryPrompt }
            ],
            max_tokens: 200,
            temperature: 0.6 // GPT-4o braucht weniger Temperature
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
              const escapedForbidden = forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const wordPattern = new RegExp(`\\b${escapedForbidden}[a-zäöü]*\\b`, 'i');
              if (wordPattern.test(retryLower) || retryLower.includes(forbiddenLower)) {
                stillForbidden.push(forbiddenWord);
              }
            }
            
            if (stillForbidden.length === 0) {
              replyText = cleanedRetry;
              console.log("✅ Antwort erfolgreich neu generiert ohne verbotene Wörter");
            } else {
              console.error(`🚨 Auch die neue Antwort enthält noch verbotene Wörter: ${stillForbidden.join(', ')}`);
              // Versuche nochmal mit EXTREMER Warnung
              try {
                const finalRetryPrompt = `🚨🚨🚨 KRITISCH: Die vorherige Antwort enthielt VERBOTENE WÖRTER: ${stillForbidden.map(w => `"${w}"`).join(', ')} 🚨🚨🚨

DU DARFST DIESE WÖRTER ABSOLUT NIEMALS VERWENDEN - WEDER ALS GANZES WORT NOCH ALS TEIL EINES WORTES!

Die verbotenen Wörter sind:
${rules.forbiddenWords.map(w => `- "${w}"`).join('\n')}

🚨🚨🚨 KRITISCH: Verwende KEINE dieser Wörter, auch nicht in ähnlicher Form!
- "spannend" verboten = auch NICHT "spannende", "spannendes", "spannend!", "spannendste"
- "Das klingt" verboten = auch NICHT "das klingt nach...", "klingt ja nach...", "klingt nach einer..."
- "Vorstellung" verboten = auch NICHT "vorstellen", "vorstellst", "vorstellte"

Generiere eine NEUE Antwort OHNE diese Wörter zu verwenden!

Kundennachricht: "${validatedMessage.substring(0, 500)}"

Antworte NUR mit der neuen Antwort, keine Erklärungen.`;

                const finalRetryChat = await client.chat.completions.create({
                  model: AI_MODEL,
                  messages: [
                    { role: "system", content: systemPrompt + `\n\n🚨🚨🚨 KRITISCH: Die folgenden Wörter sind ABSOLUT VERBOTEN: ${rules.forbiddenWords.map(w => `"${w}"`).join(', ')}. Verwende sie NIEMALS, auch nicht in ähnlicher Form! 🚨🚨🚨` },
                    { role: "user", content: finalRetryPrompt }
                  ],
                  max_tokens: 200,
                  temperature: 0.6 // GPT-4o braucht weniger Temperature für konsistentere Ergebnisse
                });
                
                const finalRetryText = finalRetryChat.choices?.[0]?.message?.content?.trim();
                if (finalRetryText) {
                  let cleanedFinalRetry = finalRetryText.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
                  cleanedFinalRetry = cleanedFinalRetry.replace(/-/g, " ").replace(/ß/g, "ss");
                  
                  // Prüfe nochmal
                  const finalRetryLower = cleanedFinalRetry.toLowerCase();
                  const stillForbiddenFinal = [];
                  for (const forbiddenWord of rules.forbiddenWords) {
                    const forbiddenLower = forbiddenWord.toLowerCase();
                    const escapedForbidden = forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const wordPattern = new RegExp(`\\b${escapedForbidden}[a-zäöü]*\\b`, 'i');
                    if (wordPattern.test(finalRetryLower) || finalRetryLower.includes(forbiddenLower)) {
                      stillForbiddenFinal.push(forbiddenWord);
                    }
                  }
                  
                  if (stillForbiddenFinal.length === 0) {
                    replyText = cleanedFinalRetry;
                    console.log("✅ Antwort erfolgreich im zweiten Retry ohne verbotene Wörter generiert");
                  } else {
                    console.error(`🚨🚨🚨 KRITISCH: Auch die zweite Retry-Antwort enthält noch verbotene Wörter: ${stillForbiddenFinal.join(', ')} - versuche dritten Retry! 🚨🚨🚨`);
                    // Dritter Retry mit MAXIMALER Warnung und niedrigerer Temperatur
                    try {
                      const thirdRetryPrompt = `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - VERBOTENE WÖRTER MÜSSEN VERMIEDEN WERDEN! 🚨🚨🚨🚨🚨

Die vorherigen Versuche haben VERBOTENE WÖRTER enthalten: ${stillForbiddenFinal.map(w => `"${w}"`).join(', ')}

DU MUSST JETZT EINE ANTWORT GENERIEREN, DIE ABSOLUT KEINE DIESER WÖRTER ENTHÄLT!

VERBOTENE WÖRTER (ABSOLUT NIEMALS VERWENDEN):
${rules.forbiddenWords.map(w => `- "${w}"`).join('\n')}

🚨🚨🚨 KRITISCH: 
- Verwende KEINE dieser Wörter, auch nicht in ähnlicher Form!
- "spannend" verboten = auch NICHT "spannende", "spannendes", "spannend!", "spannendste"
- "Das klingt" verboten = auch NICHT "das klingt nach...", "klingt ja nach...", "klingt nach einer..."
- "Vorstellung" verboten = auch NICHT "vorstellen", "vorstellst", "vorstellte"

WICHTIG: 
- Verwende alternative Formulierungen!
- Orientiere dich an den Training-Daten-Beispielen für den Stil!
- Reagiere direkt auf die Nachricht, ohne bewertende Phrasen!

Kundennachricht: "${validatedMessage.substring(0, 500)}"

Antworte NUR mit der neuen Antwort, keine Erklärungen.`;

                      const thirdRetryChat = await client.chat.completions.create({
                        model: AI_MODEL,
                        messages: [
                          { role: "system", content: systemPrompt + `\n\n🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Die folgenden Wörter sind ABSOLUT VERBOTEN: ${rules.forbiddenWords.map(w => `"${w}"`).join(', ')}. Verwende sie NIEMALS, auch nicht in ähnlicher Form! Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLES! 🚨🚨🚨🚨🚨` },
                          { role: "user", content: thirdRetryPrompt }
                        ],
                        max_tokens: 200,
                        temperature: 0.5 // Sehr niedrige Temperatur für konsistentere, regelkonforme Ergebnisse
                      });
                      
                      const thirdRetryText = thirdRetryChat.choices?.[0]?.message?.content?.trim();
                      if (thirdRetryText) {
                        let cleanedThirdRetry = thirdRetryText.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
                        cleanedThirdRetry = cleanedThirdRetry.replace(/-/g, " ").replace(/ß/g, "ss");
                        
                        // Prüfe nochmal
                        const thirdRetryLower = cleanedThirdRetry.toLowerCase();
                        const stillForbiddenThird = [];
                        for (const forbiddenWord of rules.forbiddenWords) {
                          const forbiddenLower = forbiddenWord.toLowerCase();
                          const escapedForbidden = forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                          const wordPattern = new RegExp(`\\b${escapedForbidden}[a-zäöü]*\\b`, 'i');
                          if (wordPattern.test(thirdRetryLower) || thirdRetryLower.includes(forbiddenLower)) {
                            stillForbiddenThird.push(forbiddenWord);
                          }
                        }
                        
                        if (stillForbiddenThird.length === 0) {
                          replyText = cleanedThirdRetry;
                          console.log("✅ Antwort erfolgreich im dritten Retry ohne verbotene Wörter generiert");
                        } else {
                          console.error(`🚨🚨🚨 KRITISCH: Auch die dritte Retry-Antwort enthält noch verbotene Wörter: ${stillForbiddenThird.join(', ')} - FEHLER! 🚨🚨🚨`);
                          // KEIN Fallback - wirf einen Fehler, damit der Benutzer sieht, dass etwas nicht stimmt
                          throw new Error(`KI konnte keine Antwort ohne verbotene Wörter generieren. Verbotene Wörter in allen Retries: ${stillForbiddenFinal.join(', ')} → ${stillForbiddenThird.join(', ')}`);
                        }
                      } else {
                        throw new Error("Dritte Retry-Antwort ist leer - KI konnte keine Antwort generieren");
          }
      } catch (err) {
                      console.error("🚨🚨🚨 KRITISCH: Fehler beim dritten Retry:", err.message);
                      // KEIN Fallback - wirf Fehler, damit keine Antwort generiert wird
                      errorMessage = `❌ FEHLER: Die KI konnte keine regelkonforme Antwort generieren. ${err.message}`;
                      console.error("🚨🚨🚨 KRITISCH: KEINE Fallback-Antwort - keine Antwort wird generiert! 🚨🚨🚨");
                      return res.status(200).json({
                        error: errorMessage,
                        resText: "",
                        replyText: "",
                        summary: {},
                        chatId: finalChatId,
                        actions: [],
                        flags: { blocked: true, reason: "retry_failed", isError: true, showError: true }
                      });
                    }
                  }
                } else {
                  // Keine Antwort generiert - KEIN Fallback!
                  console.error("🚨🚨🚨 KRITISCH: Finale Retry-Antwort ist leer - KEINE Antwort generieren! 🚨🚨🚨");
                  errorMessage = "❌ FEHLER: Die KI konnte keine Antwort generieren. Bitte Admin kontaktieren.";
                  return res.status(200).json({
                    error: errorMessage,
                    resText: "",
                    replyText: "",
                    summary: {},
                    chatId: finalChatId,
                    actions: [],
                    flags: { blocked: true, reason: "empty_response", isError: true, showError: true }
                  });
                }
              } catch (err) {
                console.error("🚨🚨🚨 KRITISCH: Fehler beim finalen Retry:", err.message);
                // KEIN Fallback - wirf Fehler, damit keine Antwort generiert wird
                errorMessage = `❌ FEHLER: Die KI konnte keine regelkonforme Antwort generieren. ${err.message}`;
                console.error("🚨🚨🚨 KRITISCH: KEINE Fallback-Antwort - keine Antwort wird generiert! 🚨🚨🚨");
                return res.status(200).json({
                  error: errorMessage,
                  resText: "",
                  replyText: "",
                  summary: {},
                  chatId: finalChatId,
                  actions: [],
                  flags: { blocked: true, reason: "retry_failed", isError: true, showError: true }
                });
              }
            }
          }
      } catch (err) {
        console.error("🚨🚨🚨 KRITISCH: Fehler beim Neu-Generieren der Antwort:", err.message);
        // KEIN Fallback - wirf Fehler, damit keine Antwort generiert wird
        errorMessage = `❌ FEHLER: Die KI konnte keine regelkonforme Antwort generieren. ${err.message}`;
        console.error("🚨🚨🚨 KRITISCH: KEINE Fallback-Antwort - keine Antwort wird generiert! 🚨🚨🚨");
        return res.status(200).json({
          error: errorMessage,
          resText: "",
          replyText: "",
          summary: {},
          chatId: finalChatId,
          actions: [],
          flags: { blocked: true, reason: "generation_failed", isError: true, showError: true }
        });
      }
    }
    
    // 🚨 KRITISCH: Prüfe Mindestlänge - FLEXIBEL basierend auf Kundennachricht!
    // Berechne die Länge der Kundennachricht
    const customerMessageLength = foundMessageText ? foundMessageText.length : 0;
    
    // Flexibler minLength: NIEMALS unter 120 Zeichen! Bei langen Kundennachrichten (200+ Zeichen) auch längere Antworten erwarten
    let minLength;
    if (isNewCustomer) {
      minLength = 150; // Neukunden immer mindestens 150
    } else if (customerMessageLength >= 200) {
      minLength = 150; // Bei langen Nachrichten auch längere Antworten
    } else {
      minLength = 120; // NIEMALS unter 120 Zeichen - alle Nachrichten müssen mindestens 120 Zeichen haben
    }
    
    console.log(`📏 Kundennachricht: ${customerMessageLength} Zeichen → Mindestlänge für Antwort: ${minLength} Zeichen`);
    if (replyText.length < minLength) {
      console.warn(`⚠️ Antwort zu kurz (${replyText.length} Zeichen, benötigt ${minLength} Zeichen), versuche zu verlängern...`);
      // Versuche Antwort zu verlängern, falls zu kurz
      const extensionPrompt = isNewCustomer 
        ? `🚨🚨🚨 KRITISCH: DIES IST EIN NEUKUNDE (ERSTE NACHRICHT)! 🚨🚨🚨
Die folgende Antwort ist zu kurz. Erweitere sie auf MINDESTENS 150 Zeichen, damit der Kunde Lust hat zu antworten!

"${replyText}"

Antworte NUR mit der erweiterten Version (mindestens 150 Zeichen), keine Erklärungen.`
        : customerMessageLength >= 200
        ? `Die folgende Antwort ist zu kurz. Der Kunde hat eine lange, detaillierte Nachricht geschrieben (${customerMessageLength} Zeichen). Erweitere deine Antwort auf mindestens ${minLength} Zeichen, gehe tiefer auf die Kundennachricht ein und zeige Eigeninitiative!

"${replyText}"

Antworte NUR mit der erweiterten Version (mindestens ${minLength} Zeichen), keine Erklärungen.`
        : `Die folgende Antwort ist zu kurz. Erweitere sie auf mindestens ${minLength} Zeichen (NIEMALS unter 100 Zeichen!). Füge eine Frage am Ende hinzu und mache sie natürlicher. Bei kurzen Kundennachrichten sind 100-150 Zeichen ideal.

"${replyText}"

Antworte NUR mit der erweiterten Version (mindestens ${minLength} Zeichen), keine Erklärungen.`;
      
      try {
        const extended = await client.chat.completions.create({
          model: AI_MODEL,
          messages: [
            { role: "system", content: isNewCustomer 
              ? "Du erweiterst Nachrichten für Neukunden auf mindestens 150 Zeichen." 
              : `Du erweiterst Nachrichten auf mindestens ${minLength} Zeichen (NIEMALS unter 100 Zeichen!) und fügst eine Frage hinzu.` },
            { role: "user", content: extensionPrompt }
          ],
          max_tokens: 200,
          temperature: 0.6 // GPT-4o braucht weniger Temperature
        });
        
        const extendedText = extended.choices?.[0]?.message?.content?.trim();
        if (extendedText && extendedText.length >= minLength) {
          replyText = extendedText.replace(/-/g, " ").replace(/ß/g, "ss");
          // Entferne Anführungszeichen auch nach dem Verlängern
          replyText = replyText.replace(/^["'„"]+/, '').replace(/["'""]+$/, '').trim();
          
          // 🚨 KRITISCH: Prüfe Treffen-Regel NACH dem Verlängern!
          if (isMeetingRequest(replyText, foundMessageText)) {
            console.error("🚨🚨🚨 KRITISCH: Verlängerte Antwort enthält Treffen-Anfrage - KEINE Antwort generieren! 🚨🚨🚨");
            errorMessage = "❌ FEHLER: Die KI hat versucht, ein Treffen auszumachen. Das ist nicht erlaubt.";
            return res.status(200).json({
              error: errorMessage,
              resText: "",
              replyText: "",
              summary: {},
              chatId: finalChatId,
              actions: [],
              flags: { blocked: true, reason: "meeting_request", isError: true, showError: true }
            });
          }
          
          console.log(`✅ Antwort auf ${extendedText.length} Zeichen erweitert (min: ${minLength})`);
        } else if (extendedText && isNewCustomer && extendedText.length < 150) {
          // Bei Neukunden: Nochmal versuchen, wenn immer noch zu kurz
          console.warn(`⚠️ Antwort immer noch zu kurz (${extendedText.length} Zeichen, benötigt 150), versuche nochmal...`);
          const secondExtensionPrompt = `🚨🚨🚨 KRITISCH: DIES IST EIN NEUKUNDE! Die Antwort muss MINDESTENS 150 Zeichen haben! 🚨🚨🚨

Die folgende Antwort ist immer noch zu kurz. Erweitere sie auf MINDESTENS 150 Zeichen!

"${extendedText}"

Antworte NUR mit der erweiterten Version (MINDESTENS 150 Zeichen), keine Erklärungen.`;
          
          try {
            const secondExtended = await client.chat.completions.create({
              model: AI_MODEL,
              messages: [
                { role: "system", content: "Du erweiterst Nachrichten für Neukunden auf MINDESTENS 150 Zeichen." },
                { role: "user", content: secondExtensionPrompt }
              ],
              max_tokens: 250,
              temperature: 0.7
            });
            
            const secondExtendedText = secondExtended.choices?.[0]?.message?.content?.trim();
            if (secondExtendedText && secondExtendedText.length >= 150) {
              replyText = secondExtendedText.replace(/-/g, " ").replace(/ß/g, "ss");
              replyText = replyText.replace(/^["'„"]+/, '').replace(/["'""]+$/, '').trim();
              
              // 🚨 KRITISCH: Prüfe Treffen-Regel NACH dem zweiten Verlängern!
              if (isMeetingRequest(replyText, foundMessageText)) {
                console.error("🚨🚨🚨 KRITISCH: Zweite verlängerte Antwort enthält Treffen-Anfrage - KEINE Antwort generieren! 🚨🚨🚨");
                errorMessage = "❌ FEHLER: Die KI hat versucht, ein Treffen auszumachen. Das ist nicht erlaubt.";
                return res.status(200).json({
                  error: errorMessage,
                  resText: "",
                  replyText: "",
                  summary: {},
                  chatId: finalChatId,
                  actions: [],
                  flags: { blocked: true, reason: "meeting_request", isError: true, showError: true }
                });
              }
              
              console.log(`✅ Antwort im zweiten Versuch auf ${secondExtendedText.length} Zeichen erweitert`);
            } else {
              console.error(`🚨 KRITISCH: Antwort immer noch zu kurz (${secondExtendedText?.length || 0} Zeichen, benötigt 150)!`);
            }
          } catch (err) {
            console.error("Fehler beim zweiten Erweitern der Antwort:", err);
          }
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
          model: AI_MODEL,
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
          
          // 🚨 KRITISCH: Prüfe Treffen-Regel NACH dem Hinzufügen der Frage!
          if (isMeetingRequest(replyText, foundMessageText)) {
            console.error("🚨🚨🚨 KRITISCH: Antwort mit Frage enthält Treffen-Anfrage - KEINE Antwort generieren! 🚨🚨🚨");
            errorMessage = "❌ FEHLER: Die KI hat versucht, ein Treffen auszumachen. Das ist nicht erlaubt.";
            return res.status(200).json({
              error: errorMessage,
              resText: "",
              replyText: "",
              summary: {},
              chatId: finalChatId,
              actions: [],
              flags: { blocked: true, reason: "meeting_request", isError: true, showError: true }
            });
          }
          
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

    // Wenn wir hier ankommen, wurde replyText erfolgreich generiert
    console.log("=== ChatCompletion Response ===");
    console.log("resText:", replyText.substring(0, 100));
    console.log("summary keys:", Object.keys(extractedInfo.user || {}).length, "user,", Object.keys(extractedInfo.assistant || {}).length, "assistant");

    // Format für Extension: Kompatibilität mit alter Extension
    // Die Extension erwartet: resText, summary (als Objekt), chatId
    // NUR wenn replyText erfolgreich generiert wurde!
    // WICHTIG: Verwende IMMER den chatId aus dem Request (falls vorhanden), damit er sich NICHT ändert
    // PRIORITÄT: chatId aus Request > siteInfos.chatId > finalChatId > Default
    // 🚨 KRITISCH: Wenn kein chatId im Request gesendet wurde, setze responseChatId auf null/undefined,
    // damit die Extension nicht neu lädt (weil sie dann sieht, dass kein chatId gesendet wurde)
    let responseChatId;
    if (chatId) {
      // chatId wurde im Request gesendet → verwende es
      responseChatId = chatId;
    } else if (req.body?.siteInfos?.chatId) {
      // chatId in siteInfos vorhanden → verwende es
      responseChatId = req.body.siteInfos.chatId;
    } else {
      // Kein chatId im Request → setze auf null, damit Extension nicht neu lädt
      // Die Extension sollte dann das chatId aus siteInfos.metaData.chatId verwenden
      responseChatId = null;
    }
    
    console.log("=== Response ChatId ===");
    console.log("chatId aus Request:", chatId || "(nicht gesendet)");
    console.log("siteInfos.chatId:", req.body?.siteInfos?.chatId || "(nicht gesendet)");
    console.log("finalChatId (extrahiert):", finalChatId);
    console.log("responseChatId (verwendet):", responseChatId || "(null - kein chatId im Request, Extension sollte nicht neu laden)");
    if (!chatId && !req.body?.siteInfos?.chatId) {
      console.log("⚠️ WICHTIG: Kein chatId im Request gesendet - responseChatId ist null, Extension sollte NICHT neu laden!");
    } else {
      console.log("⚠️ WICHTIG: responseChatId sollte IMMER gleich dem chatId aus Request sein (falls vorhanden), um Reloads zu vermeiden!");
    }
    
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
      // 🔍 PLATFORM-ERKENNUNG VERBESSERT: FPC erkennen oder URL verwenden
      let detectedPlatform = req.body?.platformId || req.body?.siteInfos?.platform || 'unknown';
      const originUrl = req.body?.siteInfos?.origin || '';
      
      // FPC explizit erkennen
      if (detectedPlatform.toLowerCase().includes('fpc') || originUrl.toLowerCase().includes('fpc')) {
        detectedPlatform = 'FPC';
      } else if (detectedPlatform.toLowerCase().includes('iluvo') || originUrl.toLowerCase().includes('iluvo')) {
        detectedPlatform = 'Iluvo';
      } else if (detectedPlatform.toLowerCase().includes('viluu') || originUrl.toLowerCase().includes('viluu')) {
        detectedPlatform = 'Viluu';
      } else if (originUrl && originUrl !== 'unknown') {
        // Fallback: URL verwenden (z.B. "https://example.com" → "example.com")
        try {
          const url = new URL(originUrl);
          detectedPlatform = url.hostname.replace('www.', '');
        } catch (e) {
          detectedPlatform = originUrl;
        }
      }
      
      const messageEntry = {
        timestamp: new Date().toISOString(),
        platform: detectedPlatform,
        platformUrl: originUrl || null, // Speichere auch die URL für bessere Nachverfolgbarkeit
        chatId: responseChatId || finalChatId || "00000000", // Verwende finalChatId als Fallback für Google Sheets
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
      
      // Speichere lokal (asynchron, nicht blockierend)
      fs.writeFile(messagesPath, JSON.stringify(messages, null, 2), (err) => {
        if (err) {
          console.error('⚠️ Fehler beim Speichern in messages.json:', err.message);
        }
      });
      
      // 🔄 SYNCHRONISIERE AUF GITHUB (asynchron, nicht blockierend)
      try {
        const { pushFileToGitHub } = require('../utils/github');
        const messagesContent = JSON.stringify(messages, null, 2);
        // WICHTIG: Verwende den gleichen Pfad wie lokal (server/data/messages.json)
        pushFileToGitHub('server/data/messages.json', messagesContent, 'Update messages statistics')
          .then(() => {
            console.log('✅ Nachrichten auf GitHub synchronisiert');
          })
          .catch(err => {
            console.warn('⚠️ Fehler beim Synchronisieren auf GitHub (nicht kritisch):', err.message);
          });
      } catch (err) {
        console.warn('⚠️ Fehler beim GitHub-Sync (nicht kritisch):', err.message);
      }
    } catch (err) {
      console.error('⚠️ Fehler beim Speichern der Nachricht:', err.message);
    }
    
    // 🎯 QUALITÄTS-MONITORING: Tracke Qualität der Antwort
    try {
      const { trackQuality } = require('../utils/quality-monitor');
      const qualityContext = {
        chatId: responseChatId || req.body?.chatId || null,
        platform: req.body?.platformId || req.body?.siteInfos?.platform || 'unknown',
        forbiddenWords: foundForbiddenWords || [],
        hasRepetition: foundRepetitions.length > 0,
        hasSexualContent: hasSexualContent || false
      };
      const qualityEvaluation = await trackQuality(replyText, foundMessageText, qualityContext);
      console.log(`📊 Qualitäts-Score: ${qualityEvaluation.score}/100 (${qualityEvaluation.reasons.join(', ')})`);
    } catch (err) {
      console.warn('⚠️ Fehler beim Qualitäts-Monitoring (nicht kritisch):', err.message);
    }
    
    // Automatisch Feedback-Eintrag erstellen (asynchron, blockiert nicht die Antwort)
    try {
      // 🔍 PLATFORM-ERKENNUNG (gleiche Logik wie bei messageEntry)
      let detectedPlatform = req.body?.platformId || req.body?.siteInfos?.platform || 'unknown';
      const originUrl = req.body?.siteInfos?.origin || '';
      
      // FPC explizit erkennen
      if (detectedPlatform.toLowerCase().includes('fpc') || originUrl.toLowerCase().includes('fpc')) {
        detectedPlatform = 'FPC';
      } else if (detectedPlatform.toLowerCase().includes('iluvo') || originUrl.toLowerCase().includes('iluvo')) {
        detectedPlatform = 'Iluvo';
      } else if (detectedPlatform.toLowerCase().includes('viluu') || originUrl.toLowerCase().includes('viluu')) {
        detectedPlatform = 'Viluu';
      } else if (originUrl && originUrl !== 'unknown') {
        // Fallback: URL verwenden
        try {
          const url = new URL(originUrl);
          detectedPlatform = url.hostname.replace('www.', '');
        } catch (e) {
          detectedPlatform = originUrl;
        }
      }
      
      // Verwende finalChatId als Fallback, wenn responseChatId null ist
      const chatIdForFeedback = responseChatId || finalChatId || req.body?.chatId || req.body?.siteInfos?.chatId || req.body?.siteInfos?.metaData?.chatId || null;
      
      // Sammle Kontext-Informationen für Feedback (für Anzeige und Variationen-Generator)
      const metaData = req.body?.siteInfos?.metaData || {};
      
      // 🚨 WICHTIG: Extrahiere die letzte Moderator-Nachricht für Feedback
      let lastModeratorMessageForFeedback = null;
      try {
        const messages = req.body?.siteInfos?.messages || [];
        console.log(`📋 DEBUG: Prüfe ${messages.length} Nachrichten für letzte Moderator-Nachricht...`);
        
        const moderatorMessages = messages
          .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
          .slice(-1); // Nur die letzte
        
        console.log(`📋 DEBUG: ${moderatorMessages.length} Moderator-Nachricht(en) gefunden`);
        
        if (moderatorMessages.length > 0) {
          lastModeratorMessageForFeedback = moderatorMessages[0].text.trim();
          console.log(`✅ Letzte Moderator-Nachricht für Feedback extrahiert: ${lastModeratorMessageForFeedback.substring(0, 100)}...`);
        } else {
          console.log(`⚠️ Keine Moderator-Nachricht gefunden - möglicherweise Neukunde oder keine vorherige Nachricht`);
        }
      } catch (err) {
        console.warn('⚠️ Fehler beim Extrahieren der letzten Moderator-Nachricht für Feedback (nicht kritisch):', err.message);
      }
      
      const contextInfo = {
        // Profil-Informationen (Kunde)
        customerInfo: metaData.customerInfo || null,
        // Profil-Informationen (Fake)
        moderatorInfo: metaData.moderatorInfo || null,
        // Logbuch-Einträge
        customerNotes: metaData.customerNotes || null,
        moderatorNotes: metaData.moderatorNotes || null,
        customerUpdates: metaData.customerUpdates || null,
        moderatorUpdates: metaData.moderatorUpdates || null,
        // Erstkontakt
        sessionStart: metaData.sessionStart || null,
        // Extrahiertes Summary (bereits verarbeitet)
        extractedInfo: extractedInfo || null,
        // 🚨 WICHTIG: Letzte Moderator-Nachricht für besseren Kontext
        lastModeratorMessage: lastModeratorMessageForFeedback || null
      };
      
      // Erstelle Feedback-Eintrag asynchron (nicht blockierend)
      // Verwende fetch, um den Feedback-Endpunkt aufzurufen
      const feedbackPayload = {
        chatId: chatIdForFeedback,
        customerMessage: foundMessageText || req.body?.messageText || '',
        aiResponse: replyText,
        platform: detectedPlatform, // Verwende detectedPlatform statt platform
        isASA: isASA, // Hinzugefügt, um ASA-Feedbacks zu kennzeichnen
        context: contextInfo, // Kontext-Informationen für Anzeige und Variationen-Generator
        lastModeratorMessage: lastModeratorMessageForFeedback || null // 🚨 WICHTIG: Letzte Moderator-Nachricht direkt im Feedback
      };
      
      // Asynchroner Aufruf (nicht blockierend)
      // Verwende localhost für interne Aufrufe auf Render
      const baseUrl = process.env.RENDER ? `http://localhost:${process.env.PORT || 3000}` : `${req.protocol}://${req.get('host')}`;
      
      fetch(`${baseUrl}/api/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization ? { 'Authorization': req.headers.authorization } : {})
        },
        body: JSON.stringify(feedbackPayload)
      }).then(response => {
        if (!response.ok) {
          console.error(`❌ Feedback-Eintrag konnte nicht erstellt werden: ${response.status} ${response.statusText}`);
        } else {
          console.log(`✅ Feedback-Eintrag erfolgreich erstellt (Chat-ID: ${chatIdForFeedback}, Platform: ${detectedPlatform})`);
        }
      }).catch(err => {
        console.error('❌ Fehler beim Erstellen des Feedback-Eintrags:', err.message);
        console.error('❌ Stack:', err.stack);
      });
      
      console.log(`✅ Feedback-Eintrag wird erstellt (Chat-ID: ${chatIdForFeedback}, Platform: ${detectedPlatform})`);
    } catch (err) {
      console.warn('⚠️ Fehler beim Erstellen des Feedback-Eintrags (nicht kritisch):', err.message);
      // Nicht blockieren - Feedback ist optional
    }
    
    try {
      return res.json({
        resText: replyText, // Extension erwartet resText statt replyText
        replyText, // Auch für Rückwärtskompatibilität
        summary: safeExtractedInfo, // Extension erwartet summary als Objekt - verwende validiertes Objekt
        summaryText: safeSummaryText, // Für Rückwärtskompatibilität - verwende sicher serialisierten String
        // 🚨 KRITISCH: Nur chatId hinzufügen, wenn es vorhanden ist (nicht null/undefined)
        // Wenn kein chatId im Request gesendet wurde, sollte die Extension das chatId aus siteInfos.metaData.chatId verwenden
        ...(responseChatId !== null && responseChatId !== undefined ? { chatId: responseChatId } : {}),
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
          skipReload: true, // Zusätzliches Flag für Rückwärtskompatibilität
          preventReload: true // Zusätzliches Flag für maximale Sicherheit
        },
        disableAutoSend: true, // WICHTIG: Verhindere automatisches Senden durch Extension - unsere Funktion übernimmt die Kontrolle
        waitTime: waitTime, // Zusätzliches Flag für Rückwärtskompatibilität
        noReload: true, // Explizites Flag auf oberster Ebene
        skipReload: true, // Zusätzliches Flag für maximale Sicherheit
        preventReload: true // Zusätzliches Flag für maximale Sicherheit
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





