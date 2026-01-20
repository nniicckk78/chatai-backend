const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");
const fs = require("fs");
const path = require("path");
const { writeToGoogleSheets } = require("../utils/google-sheets");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
// 🚨 NEU: Multi-Agent-Pipeline importieren
const { runMultiAgentPipeline, agentMessageGenerator, validateCriticalRules } = require("../utils/multi-agent");
const router = express.Router();

// AI Model Konfiguration - zentral verwaltet
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini"; // Standard: GPT-4o-mini (kann über Umgebungsvariable geändert werden)

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
  
  // 🚨🚨🚨 KRITISCH: ALLE sexuellen Wörter (normal und hardcore) sind ERLAUBT! 🚨🚨🚨
  // 🚨🚨🚨 NUR blockieren: Minderjährige, Pädophilie, Inzest, Zoophilie 🚨🚨🚨
  // 🚨🚨🚨 NICHT blockieren: Normale Sex-Gespräche, Hardcore-Sex, BDSM, Fetische, etc. 🚨🚨🚨
  
  // Nur für Altersprüfungen: Liste von harmlosen Wörtern, die Zahlen 10-17 enthalten können
  // Diese Liste ist NUR für Altersprüfungen relevant, NICHT für sexuelle Wörter!
  const ageFalsePositiveTerms = [
    "wünsch", "wünschen", "wünscht", "wünschst", "wünschte", "wünschten", "wünsche",
    "schön", "schon", "schönsten", "schönen", "schöner", "schöne", "schönes",
    "gabi", "gab", "gabriel", "gabe",
    "tag", "tage", "tagen", "tägig", "tägige"
  ];
  
  // Prüfe nur für Altersprüfungen, ob harmlose Wörter vorhanden sind
  const hasAgeFalsePositive = ageFalsePositiveTerms.some(term => lower.includes(term));
  
  // Direkte Erwähnungen von Minderjährigkeit (nur wenn KEIN harmloser Begriff vorhanden ist)
  // 🚨 WICHTIG: Sexuelle Wörter blockieren NICHT diese Prüfung!
  if (!hasAgeFalsePositive) {
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
        
        // Prüfe, ob es NICHT um harmlose Dinge geht (nur für Altersprüfungen relevant)
        const isAgeFalsePositive = ageFalsePositiveTerms.some(term => context.includes(term));
        
        // Zusätzlich: Prüfe, ob es wirklich um Alter geht (muss "alt", "jahr", "bin", "habe" enthalten)
        const isAgeContext = context.includes("alt") || context.includes("jahr") || 
                            (context.includes("bin") && (context.includes("alt") || context.includes("jahr"))) || 
                            (context.includes("habe") && (context.includes("alt") || context.includes("jahr")));
        
        // 🚨 WICHTIG: Nur blockieren, wenn es wirklich um Alter geht UND kein harmloser Begriff vorhanden ist
        // 🚨 Sexuelle Wörter blockieren NICHT diese Prüfung - sie sind erlaubt!
        if (isAgeContext && !isAgeFalsePositive) {
          return true;
        }
      }
    }
  }
  
  // Prüfe auf Zahlen 10-17 in Kombination mit "alt", "Jahre", etc.
  // 🚨 WICHTIG: Nur blockieren, wenn es wirklich um Alter geht, nicht bei anderen Kontexten!
  // 🚨 Sexuelle Wörter blockieren NICHT diese Prüfung - sie sind erlaubt!
  const numbers = lower.match(/\b(1[0-7])\b/g);
  if (numbers && !hasAgeFalsePositive) { // Nur prüfen, wenn KEIN harmloser Begriff vorhanden ist
    for (const number of numbers) {
      const numberIndex = lower.indexOf(number);
      const context = lower.substring(Math.max(0, numberIndex - 40), Math.min(lower.length, numberIndex + number.length + 40));
      
      // Prüfe, ob es NICHT um harmlose Dinge geht (nur für Altersprüfungen relevant)
      const isAgeFalsePositive = ageFalsePositiveTerms.some(term => context.includes(term));
      
      // Nur blockieren, wenn es wirklich um Alter geht
      const isAgeContext = context.includes("alt") || context.includes("jahr") || 
                          (context.includes("bin") && (context.includes("alt") || context.includes("jahr"))) || 
                          (context.includes("habe") && (context.includes("alt") || context.includes("jahr"))) ||
                          context.includes("jährig");
      
      // 🚨 WICHTIG: Nur blockieren, wenn es wirklich um Alter geht UND kein harmloser Begriff vorhanden ist
      // 🚨 Sexuelle Wörter blockieren NICHT diese Prüfung - sie sind erlaubt!
      if (isAgeContext && !isAgeFalsePositive) {
      return true;
      }
    }
  }
  
  // Strafrechtliche Themen - NUR SPEZIFISCHE VERBOTENE THEMEN
  // 🚨🚨🚨 KRITISCH: Normale Sex-Gespräche und Hardcore-Sex-Gespräche sind ERLAUBT! 🚨🚨🚨
  // 🚨🚨🚨 NUR blockieren: Inzest, Pädophilie, Zoophilie, Minderjährige 🚨🚨🚨
  // 🚨🚨🚨 NICHT blockieren: Vergewaltigung, Zwang, Nötigung, Hardcore-Sex, BDSM, etc. - das sind normale Sex-Gespräche! 🚨🚨🚨
  
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
  
  // "tier" - nur blockieren wenn EXPLIZIT Zoophilie erwähnt wird
  // 🚨 WICHTIG: Normale Erwähnungen von "Tier" sind ERLAUBT!
  if (/\btier\b/i.test(lower)) {
    // Prüfe ob es wirklich um Zoophilie geht (nur bei expliziten Begriffen)
    const hasZoophiliaTerm = ["bestialität", "zoophilie", "tier ficken", "tier sex", "tier fick", "tier besorgen"].some(term => lower.includes(term));
    if (hasZoophiliaTerm) {
      return true; // Nur blockieren wenn explizit Zoophilie erwähnt wird
    }
    // Ansonsten NICHT blockieren - normale Erwähnungen von "Tier" sind erlaubt!
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
    // Direkte Erwähnungen (mit Bindestrichen am Anfang)
    /-{1,3}\s*ki[-\s]?prüfung\s+aktiv/i,
    /ki[-\s]?prüfung\s+aktiv/i,
    /ki[-\s]?check\s+aktiv/i,
    /ki[-\s]?prüfung/i,
    /ki[-\s]?check/i,
    
    // 🚨 NEU: Anti-Spam-Prüfung (andere Variante!)
    /-{1,3}\s*anti[-\s]?spam[-\s]?prüfung/i,
    /anti[-\s]?spam[-\s]?prüfung/i,
    /anti[-\s]?spam[-\s]?check/i,
    /kontrollfrage/i, // "Kontrollfrage" ist auch eine Variante
    
    // Code-Eingabe-Anweisungen (flexibler)
    /bitte\s+trage\s+nur\s+den\s+code/i,
    /bitte\s+nur\s+(\d+)\s+in\s+diese\s+nachricht/i, // "Bitte nur 717078 in diese Nachricht"
    /bitte\s+nur\s+(\d+)\s+einfügen/i, // "Bitte nur 717078 einfügen"
    /trage\s+nur\s+den\s+code/i,
    /trage.*code.*\d+/i,
    /code\s+\d+\s+in\s+diese\s+nachricht/i,
    /code\s+\d+\s+ein/i,
    /code\s+\d{3,6}/i, // Code mit 3-6 Ziffern
    /(\d{4,6})\s+in\s+diese\s+nachricht/i, // "717078 in diese Nachricht"
    /(\d{4,6})\s+einfügen/i, // "717078 einfügen"
    
    // Bestätigungsmeldungen
    /anschließend\s+erscheint\s+eine\s+bestätigung/i,
    /danach\s+wird\s+eine\s+bestätigung/i, // "Danach wird eine Bestätigung"
    /der\s+chat\s+lädt\s+neu/i,
    /nachricht\s+korrekt\s+neu\s+eingeben/i,
    /chat\s+lädt\s+neu/i,
    /chat\s+startet\s+neu/i, // "der Chat startet neu"
    /nachricht\s+neu\s+formulieren/i, // "du darfst die Nachricht neu formulieren"
    
    // Kombinationen (häufig zusammen)
    /ki[-\s]?prüfung.*code.*\d+/i,
    /code.*\d+.*ki[-\s]?prüfung/i,
    /-{1,3}.*ki.*prüfung.*code/i,
    /anti[-\s]?spam.*code.*\d+/i,
    /code.*\d+.*anti[-\s]?spam/i,
    /kontrollfrage.*code.*\d+/i,
    /code.*\d+.*kontrollfrage/i
  ];
  
  // Prüfe auf Patterns
  for (const pattern of kiCheckPatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  
  // Zusätzliche Prüfung: Erkenne Code-Nummern (typischerweise 3-6-stellig)
  // in Kombination mit KI-Check-Texten
  const codeMatch = text.match(/code\s+(\d{3,6})/i);
  if (codeMatch) {
    // Prüfe ob in der Nähe KI-Check-Text steht (erweiterten Kontext)
    const codeIndex = text.toLowerCase().indexOf(codeMatch[0].toLowerCase());
    const context = text.substring(Math.max(0, codeIndex - 150), Math.min(text.length, codeIndex + 250));
    const contextLower = context.toLowerCase();
    
    if (contextLower.includes("ki") || 
        contextLower.includes("prüfung") || 
        contextLower.includes("check") ||
        contextLower.includes("anti") && contextLower.includes("spam") ||
        contextLower.includes("kontrollfrage") ||
        contextLower.includes("bestätigung") ||
        contextLower.includes("trage") ||
        contextLower.includes("eingeben") ||
        contextLower.includes("einfügen") ||
        contextLower.includes("sende ab") ||
        contextLower.includes("senden")) {
      return true;
    }
  }
  
  // 🚨 ZUSÄTZLICH: Erkenne auch wenn "KI-Prüfung", "Anti-Spam-Prüfung" oder "Kontrollfrage" und "Code" in der gleichen Nachricht vorkommen
  if ((lower.includes("ki") && lower.includes("prüfung")) || 
      (lower.includes("ki") && lower.includes("check")) ||
      (lower.includes("anti") && lower.includes("spam")) ||
      lower.includes("kontrollfrage")) {
    // Prüfe ob auch Code-Erwähnung vorhanden ist
    if (lower.includes("code") && /\d{3,6}/.test(text)) {
      return true;
    }
    // Oder ob "trage" und "code" vorhanden sind
    if (lower.includes("trage") && lower.includes("code")) {
      return true;
    }
    // Oder ob "bitte nur" und eine Zahl vorhanden sind (z.B. "Bitte nur 717078")
    if (lower.includes("bitte nur") && /\d{4,6}/.test(text)) {
      return true;
    }
    // Oder ob "einfügen" und eine Zahl vorhanden sind (z.B. "717078 einfügen")
    if (lower.includes("einfügen") && /\d{4,6}/.test(text)) {
      return true;
    }
  }
  
  // 🚨 ZUSÄTZLICH: Erkenne "Bitte nur [Zahl] in diese Nachricht einfügen" Pattern direkt
  if (/bitte\s+nur\s+\d{4,6}\s+in\s+diese\s+nachricht\s+einfügen/i.test(text)) {
    return true;
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
  
  // Häufige Hinweise (FPC Like, System, Kuss) - NUR wenn der Text kurz ist oder Info-Keywords enthält
  // 🚨 WICHTIG: "du gefällst mir" ist KEIN Info-Keyword, wenn es in einer normalen Nachricht vorkommt!
  // Nur wenn es eine KURZE Nachricht ist (<100 Zeichen) UND Info-Keywords enthält, dann ist es eine Info-Message
  if (t.length < 100 && (t.includes("geliked") || t.includes("like erhalten") || t.includes("hat dich gelikt") || t.includes("like bekommen"))) return true;
  
  // 🚨 NEU: System-Nachrichten für Küsse erkennen
  // "Ich habe dir einen Kuss geschickt" ist eine System-Nachricht der Plattform
  // "Der Benutzer hat dich geküsst. Schreib ihm eine Nachricht" ist auch eine System-Nachricht
  // WICHTIG: Diese Meldungen kommen von der PLATTFORM, nicht vom Kunden!
  if (t.includes("ich habe dir einen kuss geschickt") || 
      t.includes("ich habe dir einen kuss") ||
      t.includes("der benutzer hat dich geküsst") ||
      t.includes("benutzer hat dich geküsst") ||
      t.includes("hat dich geküsst") ||
      t.includes("schreib ihm eine nachricht") ||
      t.includes("schreibe ihm eine nachricht") ||
      (t.includes("geküsst") && t.includes("schreib")) || // "Der Benutzer hat dich geküsst. Schreib ihm eine Nachricht"
      (t.includes("geküsst") && t.includes("schreibe"))) { // Variante "Schreibe ihm"
    return true; // System-Nachricht für Kuss
  }
  
  // 🚨 ZUSÄTZLICH: Erkenne auch wenn "Schreib ihm eine Nachricht" allein steht (ohne "geküsst")
  // Das ist eine System-Anweisung der Plattform
  if (t.includes("schreib ihm eine nachricht") || 
      t.includes("schreibe ihm eine nachricht") ||
      t.includes("schreib ihr eine nachricht") ||
      t.includes("schreibe ihr eine nachricht")) {
    return true; // System-Anweisung der Plattform
  }
  
  // 🚨 KRITISCH: "du gefällst mir" NUR als Info-Message erkennen, wenn es eine KURZE Nachricht ist (<50 Zeichen)
  // Lange Nachrichten mit "du gefällst mir" sind normale Nachrichten, keine Info-Messages!
  // ABER: "Ich habe dir einen Kuss geschickt. Du gefällst mir" ist eine System-Nachricht!
  if (t.length < 100 && (t.includes("ich habe dir einen like") || t.trim() === "du gefällst mir" || t.trim().startsWith("du gefällst mir"))) {
    // Prüfe ob es mit "Ich habe dir einen Kuss geschickt" beginnt
    if (t.startsWith("ich habe dir einen kuss")) {
      return true; // System-Nachricht: Kuss + "du gefällst mir"
    }
    // Nur wenn sehr kurz (<50 Zeichen)
    if (t.length < 50) {
      return true; // FPC Like-Nachrichten (nur wenn kurz!)
    }
  }
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

// 🧠 NEU: Emotionale Intelligenz - Analysiere die Stimmung des Kunden
async function analyzeCustomerMood(client, messageText, conversationHistory = "") {
  if (!client || !messageText || typeof messageText !== 'string') {
    return { mood: 'neutral', confidence: 0, instructions: '' };
  }
  
  try {
    const analysisPrompt = `Analysiere die emotionale Stimmung des Kunden in dieser Nachricht. Antworte NUR als JSON im Format:
{
  "mood": "frustriert" | "glücklich" | "traurig" | "aufgeregt" | "gelangweilt" | "neutral" | "verliebt" | "wütend",
  "confidence": 0.0-1.0,
  "reason": "Kurze Begründung"
}

Kundennachricht: "${messageText.substring(0, 500)}"
${conversationHistory ? `\nKontext (letzte Nachrichten): "${conversationHistory.substring(0, 300)}"` : ''}

WICHTIG:
- "frustriert": Kunde ist unzufrieden, enttäuscht, genervt (z.B. "warum antwortest du nicht", "das nervt")
- "glücklich": Kunde ist zufrieden, positiv, freudig (z.B. "das freut mich", "super", "geil")
- "traurig": Kunde ist traurig, niedergeschlagen (z.B. "schade", "bin traurig", "nicht gut")
- "aufgeregt": Kunde ist begeistert, euphorisch, sehr positiv (z.B. "mega", "wow", "richtig geil")
- "gelangweilt": Kunde zeigt wenig Interesse, kurze Antworten (z.B. "ok", "aha", "ja")
- "verliebt": Kunde zeigt romantische/emotionale Gefühle (z.B. "ich mag dich", "du gefällst mir")
- "wütend": Kunde ist aggressiv, verärgert (z.B. "das ist scheiße", "nerv mich nicht")
- "neutral": Standard-Stimmung, keine starke Emotion erkennbar

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const analysis = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "Du analysierst die emotionale Stimmung von Chat-Nachrichten. Antworte NUR als JSON." },
        { role: "user", content: analysisPrompt }
      ],
      max_tokens: 150,
      temperature: 0.3
    });
    
    const result = analysis.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const mood = parsed.mood || 'neutral';
          const confidence = parsed.confidence || 0.5;
          
          // Generiere Anweisungen basierend auf Stimmung
          let instructions = '';
          switch (mood) {
            case 'frustriert':
              instructions = '\n\n😔 EMOTIONALE STIMMUNG: Der Kunde ist FRUSTRIERT/ENTTÄUSCHT!\n- Reagiere VERSTÄNDNISVOLL und TRÖSTEND\n- Zeige, dass du seine Gefühle verstehst\n- Sei einfühlsam, nicht defensiv\n- Versuche, die Situation zu entspannen\n';
              break;
            case 'glücklich':
              instructions = '\n\n😊 EMOTIONALE STIMMUNG: Der Kunde ist GLÜCKLICH/POSITIV!\n- Reagiere ENTHUSIASTISCH und FREUDIG\n- Teile seine positive Stimmung\n- Sei warmherzig und aufgeschlossen\n';
              break;
            case 'traurig':
              instructions = '\n\n😢 EMOTIONALE STIMMUNG: Der Kunde ist TRAURIG/NIEDERGESCHLAGEN!\n- Reagiere MITGEFÜHLEND und TRÖSTEND\n- Zeige Verständnis für seine Gefühle\n- Sei einfühlsam und unterstützend\n';
              break;
            case 'aufgeregt':
              instructions = '\n\n🤩 EMOTIONALE STIMMUNG: Der Kunde ist AUFGEREGT/BEGEISTERT!\n- Reagiere ENTHUSIASTISCH und ENERGISCH\n- Teile seine Begeisterung\n- Sei lebendig und mitreißend\n';
              break;
            case 'gelangweilt':
              instructions = '\n\n😐 EMOTIONALE STIMMUNG: Der Kunde wirkt GELANGWEILT/UNINTERESSIERT!\n- Reagiere INTERESSIERT und AKTIVIEREND\n- Stelle interessante Fragen\n- Versuche, das Gespräch zu beleben\n- Sei proaktiv, aber nicht aufdringlich\n';
              break;
            case 'verliebt':
              instructions = '\n\n💕 EMOTIONALE STIMMUNG: Der Kunde zeigt ROMANTISCHE GEFÜHLE!\n- Reagiere WARMHERZIG und ZUGEHÖRIG\n- Zeige Interesse an einer tieferen Verbindung\n- Sei emotional und persönlich\n';
              break;
            case 'wütend':
              instructions = '\n\n😠 EMOTIONALE STIMMUNG: Der Kunde ist WÜTEND/VERÄRGERT!\n- Reagiere RUHIG und DEESKALIEREND\n- Zeige Verständnis, aber sei nicht defensiv\n- Versuche, die Situation zu beruhigen\n- Sei professionell, aber einfühlsam\n';
              break;
            default:
              // neutral - keine speziellen Anweisungen
              break;
          }
          
          console.log(`🧠 Stimmungs-Analyse: ${mood} (Confidence: ${(confidence * 100).toFixed(0)}%)`);
          return { mood, confidence, instructions };
        }
      } catch (err) {
        console.warn('⚠️ Fehler beim Parsen der Stimmungs-Analyse:', err.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Fehler bei Stimmungs-Analyse (nicht kritisch):', err.message);
  }
  
  return { mood: 'neutral', confidence: 0, instructions: '' };
}

// 🎯 NEU: Proaktive Gesprächsführung - Erkenne stagnierende Gespräche und schlage Themen vor
function detectStagnantConversation(messages, foundMessageText) {
  if (!Array.isArray(messages) || messages.length < 5) {
    return { isStagnant: false, suggestions: [] };
  }
  
  // Analysiere letzte 5 Kunden-Nachrichten
  const customerMessages = messages
    .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "")
    .slice(-5)
    .map(m => m.text.trim().toLowerCase());
  
  if (customerMessages.length < 3) {
    return { isStagnant: false, suggestions: [] };
  }
  
  // Erkenne Stagnation: Kurze, uninteressante Antworten
  const shortResponses = customerMessages.filter(msg => msg.length < 30).length;
  const genericResponses = customerMessages.filter(msg => 
    ['ok', 'okay', 'ja', 'nein', 'aha', 'mhm', 'okay', 'gut', 'schön', 'cool'].some(word => msg === word || msg.startsWith(word + ' '))
  ).length;
  
  const isStagnant = (shortResponses >= 2 || genericResponses >= 2) && customerMessages.length >= 3;
  
  if (!isStagnant) {
    return { isStagnant: false, suggestions: [] };
  }
  
  // Analysiere Gesprächs-Kontext für passende Themenvorschläge
  const allMessages = messages
    .filter(m => !isInfoMessage(m) && typeof m?.text === "string" && m.text.trim() !== "")
    .slice(-10)
    .map(m => m.text.trim().toLowerCase())
    .join(' ');
  
  const suggestions = [];
  
  // Erkenne aktuelle Themen im Gespräch
  const hasCooking = allMessages.includes('kochen') || allMessages.includes('küche') || allMessages.includes('essen');
  const hasWork = allMessages.includes('arbeit') || allMessages.includes('job') || allMessages.includes('beruf');
  const hasHobbies = allMessages.includes('hobby') || allMessages.includes('sport') || allMessages.includes('freizeit');
  const hasSexual = allMessages.includes('sex') || allMessages.includes('geil') || allMessages.includes('vorliebe');
  const hasTravel = allMessages.includes('reise') || allMessages.includes('urlaub') || allMessages.includes('reisen');
  const hasFamily = allMessages.includes('familie') || allMessages.includes('kinder') || allMessages.includes('tochter');
  
  // Generiere kontextbewusste Vorschläge
  if (hasCooking && !hasSexual) {
    suggestions.push('Kochen: "Was kochst du denn am liebsten? Ich könnte mir vorstellen, dass wir zusammen kochen könnten..."');
  }
  if (hasWork && !hasSexual) {
    suggestions.push('Arbeit: "Wie läuft es denn bei dir auf der Arbeit? Was machst du da so?"');
  }
  if (hasHobbies && !hasSexual) {
    suggestions.push('Hobbies: "Was machst du denn so in deiner Freizeit? Hast du Hobbies, die dir Spaß machen?"');
  }
  if (hasTravel && !hasSexual) {
    suggestions.push('Reisen: "Hast du schon Pläne für den nächsten Urlaub? Wohin würdest du gerne reisen?"');
  }
  if (hasFamily && !hasSexual) {
    suggestions.push('Familie: "Wie geht es denn deiner Familie? Erzähl mir mehr darüber!"');
  }
  
  // Wenn keine spezifischen Themen, generische (aber passende) Vorschläge
  if (suggestions.length === 0) {
    if (!hasSexual) {
      suggestions.push('Persönlich: "Was beschäftigt dich denn gerade so? Gibt es etwas, worüber du gerne reden würdest?"');
    } else {
      suggestions.push('Sexuell: "Was magst du denn so? Erzähl mir mehr über deine Vorlieben..."');
    }
  }
  
  console.log(`🎯 Stagnation erkannt: ${isStagnant ? 'JA' : 'NEIN'} (${shortResponses} kurze, ${genericResponses} generische Antworten)`);
  
  return { isStagnant, suggestions };
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
      // 🚨 WICHTIG: Filtere Info-Messages (System-Nachrichten) heraus, bevor wir kombinieren!
      const recentMessages = validReceivedMessages
        .filter(m => {
          const age = m.age || Infinity;
          // 🚨 Filtere Info-Messages heraus (z.B. "Ich habe dir einen Kuss geschickt")
          if (isInfoMessage(m.message)) {
            return false; // Info-Message ignorieren
          }
          return age <= 2 * 60 * 1000; // Innerhalb von 2 Minuten
        })
        .sort((a, b) => {
          const ageA = a.age || Infinity;
          const ageB = b.age || Infinity;
          return ageA - ageB; // Neueste zuerst
        });
      
      if (recentMessages.length > 1) {
        // Kombiniere mehrere Nachrichten (nur echte Kunden-Nachrichten, keine Info-Messages)
        const combinedMessages = recentMessages
          .map(m => m.message.text.trim())
          .filter(text => text && text.length > 0)
          .join(' ');
        
        // 🚨 WICHTIG: Prüfe auch die KOMBINIERTE Nachricht auf System-Meldungen am Anfang
        // System-Meldungen wie "Ich habe dir einen Kuss geschickt. Du gefällst mir seht gut" werden manchmal
        // mit echten Nachrichten kombiniert - entferne sie!
        const combinedLower = combinedMessages.toLowerCase();
        let cleanedCombined = combinedMessages;
        
        // Entferne System-Meldungen am Anfang der kombinierten Nachricht
        if (combinedLower.startsWith("ich habe dir einen kuss geschickt") || 
            combinedLower.startsWith("der benutzer hat dich geküsst") ||
            combinedLower.startsWith("benutzer hat dich geküsst")) {
          // Finde das Ende der System-Meldung (meistens vor "hey", "hallo", etc. oder nach "gut", "sehr gut")
          const systemEndPatterns = [
            /ich habe dir einen kuss geschickt[^.]*\.\s*du gefällst mir[^.]*\.\s*/i,
            /der benutzer hat dich geküsst[^.]*\.\s*schreib[^.]*\.\s*/i,
            /benutzer hat dich geküsst[^.]*\.\s*schreib[^.]*\.\s*/i
          ];
          
          for (const pattern of systemEndPatterns) {
            const match = cleanedCombined.match(pattern);
            if (match) {
              cleanedCombined = cleanedCombined.substring(match[0].length).trim();
              console.log(`🧹 System-Meldung am Anfang entfernt: "${match[0].substring(0, 50)}..."`);
              break;
            }
          }
        }
        
        foundMessageText = cleanedCombined;
        console.log(`✅ ${recentMessages.length} Nachrichten innerhalb von 2 Minuten kombiniert:`, foundMessageText.substring(0, 100) + "...");
      } else {
        // 🚨 WICHTIG: Prüfe auch bei einzelner Nachricht, ob es eine Info-Message ist
        if (isInfoMessage(lastReceived)) {
          // Info-Message gefunden, suche nach der nächsten echten Nachricht
          const nonInfoMessages = validReceivedMessages
            .filter(m => m.isValid && !isInfoMessage(m.message))
            .sort((a, b) => (a.age || 0) - (b.age || 0));
          if (nonInfoMessages.length > 0) {
            foundMessageText = nonInfoMessages[0].message.text.trim();
            console.log("✅ Nachricht aus siteInfos.messages (received, NEU, Info-Message übersprungen):", foundMessageText.substring(0, 100) + "...");
          } else {
            foundMessageText = ""; // Keine echte Nachricht gefunden
            console.log("⚠️ Nur Info-Messages gefunden, keine echte Kunden-Nachricht");
          }
        } else {
          foundMessageText = lastReceived.text.trim();
          console.log("✅ Nachricht aus siteInfos.messages (received, NEU):", foundMessageText.substring(0, 100) + "...");
        }
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
  
  // 🚨 WICHTIG: isFPC muss FRÜH definiert werden, damit es im gesamten Router-Handler verfügbar ist
  const isFPC = (platformId && typeof platformId === "string" && platformId.toLowerCase().includes('fpc')) || 
                (req.body?.siteInfos?.origin && typeof req.body.siteInfos.origin === "string" && req.body.siteInfos.origin.toLowerCase().includes('fpc')) ||
                (pageUrl && typeof pageUrl === "string" && pageUrl.includes('fpc'));
  
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
  // 🚨 KRITISCH: Prüfe IMMER, ob die letzte echte Nachricht vom Moderator kam - auch wenn foundMessageText vorhanden ist!
  // Das Problem: Eine alte Kunden-Nachricht kann gefunden werden, während die neueste Nachricht vom Moderator ist!
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
    // 🚨 KRITISCH: Prüfe auch, ob es eine received-Nachricht gibt, die neuer ist!
    const receivedMsgs = msgs.filter(m => m.type === "received" || m.messageType === "received");
    const newestReceived = receivedMsgs.length > 0 ? (newestFirst ? receivedMsgs[0] : receivedMsgs[receivedMsgs.length - 1]) : null;
    
    // 🚨 KRITISCH: Wenn es eine received-Nachricht gibt, die neuer oder gleich alt ist, dann ist es KEIN ASA-Fall!
    if (newestReceived && newestMsg) {
      const receivedTs = newestReceived.timestamp ? new Date(newestReceived.timestamp).getTime() : null;
      const sentTs = newestMsg.timestamp ? new Date(newestMsg.timestamp).getTime() : null;
      if (receivedTs && sentTs && receivedTs >= sentTs) {
        console.log("⚠️ Es gibt eine received-Nachricht, die neuer oder gleich alt ist - KEIN ASA-Fall!");
        isLastMessageFromFake = false;
      } else if (newestMsg && !isInfoMessage(newestMsg) && (newestMsg?.type === "sent" || newestMsg?.messageType === "sent")) {
      isLastMessageFromFake = true;
        console.log("✅ ASA erkannt über siteInfos.messages (neueste echte Nachricht ist sent, Info-Messages ignoriert).");
      }
    } else if (newestMsg && !isInfoMessage(newestMsg) && (newestMsg?.type === "sent" || newestMsg?.messageType === "sent")) {
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
    // 🚨 HINWEIS: isFPC wurde bereits weiter oben definiert (für Neukunden-Erkennung)
    
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
  // 🚨 DEBUG: Prüfe immer, auch wenn die Nachricht lang ist
  const isKICheck = isKICheckMessage(foundMessageText);
  if (isKICheck) {
    console.error("🚨🚨🚨 BLOCKIERT: KI-Check-Code in Kundennachricht erkannt! 🚨🚨🚨");
    console.error("🚨 Erkannte Nachricht:", foundMessageText.substring(0, 200));
    console.error("🚨 Vollständige Nachricht (Länge:", foundMessageText.length, "):", foundMessageText);
    
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
          // 🚨 WICHTIG: Prüfe auch imageSrc (häufig von Extension verwendet)
          return !!(m.image || m.imageUrl || m.imageSrc || (m.url && m.url.match(/\.(png|jpg|jpeg|gif|webp)/i)) || 
                  m.image_url || m.attachment || m.attachments || m.media || m.mediaUrl || m.src);
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
        // 🚨 WICHTIG: Prüfe auch imageSrc (häufig von Extension verwendet)
        const imageUrl = msgWithImage.image || msgWithImage.imageUrl || msgWithImage.imageSrc || msgWithImage.src ||
                        (msgWithImage.url && msgWithImage.url.match(/https?:\/\/.*\.(png|jpg|jpeg|gif|webp)/i) ? msgWithImage.url : null) ||
                        msgWithImage.image_url || msgWithImage.mediaUrl ||
                        (msgWithImage.attachment && (msgWithImage.attachment.url || msgWithImage.attachment.imageUrl || msgWithImage.attachment.imageSrc)) ||
                        (msgWithImage.attachments && msgWithImage.attachments[0] && 
                         (msgWithImage.attachments[0].url || msgWithImage.attachments[0].imageUrl || msgWithImage.attachments[0].imageSrc)) ||
                        (msgWithImage.media && (msgWithImage.media.url || msgWithImage.media.imageUrl || msgWithImage.media.imageSrc));
        
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
            hasImage: !!(msg.image || msg.imageUrl || msg.imageSrc || msg.src || msg.url || msg.attachment || msg.attachments || msg.media)
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
        // 🆕 ERWEITERTE BILD-ANALYSE: Erkenne Bildtyp für spezifische Reaktionen
        // Schritt 1: Analysiere Bildtyp (Schwanz/Nacktbild/Gesicht/Körper/etc.)
        let imageType = 'unknown';
        let imageTypeAnalysis = null;
        
        try {
          const typeAnalysis = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [
              {
                role: "system",
                content: "Du analysierst Bilder und kategorisierst sie. Antworte NUR als JSON im Format: {\"type\": \"penis\" | \"nude\" | \"face\" | \"body\" | \"other\", \"confidence\": 0.0-1.0, \"description\": \"Kurze Beschreibung\"}"
              },
              {
                role: "user",
                content: [
                  { type: "text", text: "Analysiere dieses Bild und kategorisiere es:\n- \"penis\": Wenn männliche Genitalien (Schwanz/Penis) sichtbar sind\n- \"nude\": Wenn nackter Körper (aber keine Genitalien) sichtbar ist\n- \"face\": Wenn nur Gesicht/Portrait sichtbar ist\n- \"body\": Wenn bekleideter Körper sichtbar ist\n- \"other\": Alles andere (Urlaub, Haustier, etc.)\n\nAntworte NUR als JSON, kein zusätzlicher Text." },
                  { type: "image_url", image_url: { url: dataUrl } }
                ]
              }
            ],
            max_tokens: 100,
            temperature: 0.1
          });
          
          const typeResult = typeAnalysis.choices?.[0]?.message?.content?.trim();
          if (typeResult) {
            try {
              const jsonMatch = typeResult.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                imageTypeAnalysis = JSON.parse(jsonMatch[0]);
                imageType = imageTypeAnalysis.type || 'unknown';
                console.log(`📸 Bildtyp erkannt: ${imageType} (Confidence: ${((imageTypeAnalysis.confidence || 0) * 100).toFixed(0)}%)`);
              }
            } catch (err) {
              console.warn('⚠️ Fehler beim Parsen der Bildtyp-Analyse:', err.message);
            }
          }
        } catch (err) {
          console.warn('⚠️ Fehler bei Bildtyp-Analyse (nicht kritisch):', err.message);
        }
        
        // Schritt 2: Generiere spezifische Bildbeschreibung basierend auf Typ
        let visionPrompt = "";
        let visionSystemPrompt = "";
        
        if (imageType === 'penis') {
          // 🚨 EXPLIZIT: Schwanz-Bild - sehr direkte, sexuelle Reaktion
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast gerade ein Bild mit männlichen Genitalien (Schwanz/Penis) geschickt bekommen. Reagiere SEHR POSITIV, FLIRTY und EXPLIZIT! Sage, wie geil der Schwanz aussieht, was du gerne mit ihm machen würdest, wie er dir gefällt. Sei direkt und sexuell, aber nicht vulgär. Zeige Begeisterung und Interesse!";
          visionPrompt = "Reagiere SEHR POSITIV und EXPLIZIT auf das Schwanz-Bild! Sage, wie geil der Schwanz aussieht, was du gerne mit ihm machen würdest (z.B. Blowjob, Handjob, etc.), wie er dir gefällt. Sei direkt, flirty und sexuell begeistert! KEINE neutrale Beschreibung - sei emotional und enthusiastisch!";
        } else if (imageType === 'nude') {
          // 🚨 EXPLIZIT: Nacktbild - direkte, sexuelle Reaktion
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast gerade ein Nacktbild geschickt bekommen. Reagiere POSITIV, FLIRTY und SEXUELL! Sage, wie geil der Körper aussieht, was du gerne mit ihm machen würdest, wie er dir gefällt. Sei direkt und begeistert!";
          visionPrompt = "Reagiere POSITIV und EXPLIZIT auf das Nacktbild! Sage, wie geil der Körper aussieht, was du gerne mit ihm machen würdest, wie er dir gefällt. Sei direkt, flirty und sexuell begeistert! KEINE neutrale Beschreibung - sei emotional und enthusiastisch!";
        } else if (imageType === 'face') {
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast gerade ein Gesichtsbild geschickt bekommen. Reagiere POSITIV, CHARMANT und KOMPLIMENTIEREND! Sage, wie schön das Gesicht ist, was dir gefällt (z.B. Augen, Lächeln), wie attraktiv die Person ist.";
          visionPrompt = "Reagiere POSITIV und CHARMANT auf das Gesichtsbild! Sage, wie schön das Gesicht ist, was dir gefällt (z.B. Augen, Lächeln), wie attraktiv die Person ist. Sei warmherzig und komplimentierend!";
        } else if (imageType === 'body') {
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast gerade ein Körperbild geschickt bekommen. Reagiere POSITIV, FLIRTY und KOMPLIMENTIEREND! Sage, wie attraktiv der Körper aussieht, was dir gefällt, wie sportlich/gepflegt die Person ist.";
          visionPrompt = "Reagiere POSITIV und FLIRTY auf das Körperbild! Sage, wie attraktiv der Körper aussieht, was dir gefällt, wie sportlich/gepflegt die Person ist. Sei begeistert und komplimentierend!";
        } else {
          // Fallback: Generische, positive Reaktion
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast dieses Bild gerade geschickt bekommen. Reagiere so, als ob du es selbst siehst: freundlich, positiv, flirty, menschlich. NIEMALS beleidigend oder negativ. Keine Ratespiele, keine Phantasie erfinden. Wenn Gesicht/Urlaub/Haustier/Haus: positiv, neugierig, charmant. Kurz halten.";
          visionPrompt = "Reagiere kurz und positiv auf das Bild, als ob du es gerade erhalten hast. Keine neutral-sachliche Beschreibung, sondern menschlich und freundlich/flirty.";
        }
        
        const vision = await client.chat.completions.create({
          model: AI_MODEL,
          messages: [
            {
              role: "system",
              content: visionSystemPrompt
            },
            {
              role: "user",
              content: [
                { type: "text", text: visionPrompt },
                { type: "image_url", image_url: { url: dataUrl } }
              ]
            }
          ],
          max_tokens: imageType === 'penis' || imageType === 'nude' ? 250 : 120, // 🚨 ERHÖHT: Mehr Tokens für explizite Reaktionen
          temperature: imageType === 'penis' || imageType === 'nude' ? 0.4 : 0.2 // Etwas kreativer für sexuelle Reaktionen
        });
        // #region agent log
        try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:744',message:'After vision API call',data:{hasChoices:!!vision.choices,choicesLength:vision.choices?.length||0,hasMessage:!!vision.choices?.[0]?.message,hasContent:!!vision.choices?.[0]?.message?.content},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
        // #endregion
        const desc = vision.choices?.[0]?.message?.content?.trim();
        if (desc) {
          imageDescriptions.push(desc);
          // Speichere auch Bildtyp für späteren Gebrauch im Prompt
          if (imageType !== 'unknown') {
            imageDescriptions.push(`[BILDTYP: ${imageType}]`); // Marker für später
          }
          console.log(`📸 Bildbeschreibung (Typ: ${imageType}):`, desc.substring(0, 120));
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
      console.log("🔄 ASA-Fall erkannt: Letzte Nachricht vom Fake, generiere Reaktivierungsnachricht über Multi-Agent-Pipeline...");
      
      // KRITISCH: Bei ASA die Kunden-Nachricht IGNORIEREN - setze foundMessageText auf leer!
      // Die gefundene Nachricht ist wahrscheinlich eine alte Moderator-Nachricht, nicht die neue Kunden-Nachricht!
      if (foundMessageText && foundMessageText.trim() !== "") {
        console.log("⚠️ ASA erkannt - IGNORIERE gefundene Kunden-Nachricht (wahrscheinlich falsch):", foundMessageText.substring(0, 100) + "...");
        foundMessageText = ""; // Setze auf leer, damit sie nicht verwendet wird
      }
      
      // 🚨 NEU: Verwende Multi-Agent-Pipeline für ASA-Nachrichten
      // Sammle alle nötigen Daten für Multi-Agent-Pipeline
      const messages = req.body?.siteInfos?.messages || [];
      const allMessages = messages;
      
      // Extrahiere moderatorMessages und customerMessages
      const totalMessages = messages.filter(m => !isInfoMessage(m) && typeof m?.text === "string" && m.text.trim() !== "").length;
      const contextSize = totalMessages > 20 ? 20 : totalMessages > 10 ? 15 : 10;
      
      const moderatorMessagesForPipeline = messages
        .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-contextSize);
      
      const customerMessagesForPipeline = messages
        .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-contextSize);
      
      // 🚨 KRITISCH: Definiere fakeName, fakeAge, etc. VOR ihrer Verwendung (sie werden normalerweise später definiert)
      const fakeName = extractedInfo.assistant?.Name || req.body?.siteInfos?.metaData?.moderatorInfo?.name || null;
      const fakeAge = extractedInfo.assistant?.Age || req.body?.siteInfos?.metaData?.moderatorInfo?.birthDate?.age || null;
      const fakeCity = extractedInfo.assistant?.Wohnort || req.body?.siteInfos?.metaData?.moderatorInfo?.city || null;
      const fakeWork = extractedInfo.assistant?.Work || req.body?.siteInfos?.metaData?.moderatorInfo?.occupation || null;
      const fakeGender = extractedInfo.assistant?.Gender || req.body?.siteInfos?.metaData?.moderatorInfo?.gender || null;
      
      // Sammle Profile-Info für Pipeline
      const profileInfoForPipeline = {
        name: fakeName,
        age: fakeAge,
        city: fakeCity,
        work: fakeWork,
        gender: fakeGender
      };
      
      // Sammle extractedUserInfo für Pipeline
      const extractedUserInfoForPipeline = extractedInfo;
      
      // 🚨 KRITISCH: Definiere imageUrls VOR ihrer Verwendung (sie wird normalerweise später definiert)
      // Bei ASA gibt es normalerweise keine Bilder, aber prüfe trotzdem assetsToSend
      let imageUrls = [];
      if (assetsToSend && Array.isArray(assetsToSend) && assetsToSend.length > 0) {
        for (const asset of assetsToSend) {
          const assetUrl = asset.url || asset.imageUrl || asset.src || asset.image_url;
          if (assetUrl && typeof assetUrl === 'string') {
            imageUrls.push(assetUrl);
          }
        }
      }
      
      // Bild-URL für Pipeline
      const imageUrlForPipeline = imageUrls && imageUrls.length > 0 ? imageUrls[0] : null;
      
      // Helper-Funktionen für Pipeline
      const isLocationQuestionFunc = isLocationQuestion;
      const findNearbyCityFunc = findNearbyCity;
      // 🚨 KRITISCH: isMeetingRequest ist möglicherweise nicht definiert - verwende null als Fallback
      const isMeetingRequestFuncForPipeline = typeof isMeetingRequest !== 'undefined' ? isMeetingRequest : null;
      const vectorDbFunc = async (query, options) => {
        const { findSimilarExamples } = require('../utils/vector-db');
        return await findSimilarExamples(query, options);
      };
      const imageAnalysisFunc = null; // TODO: Falls vorhanden, hier übergeben
      const proactiveAnalysisFunc = null; // TODO: Falls vorhanden, hier übergeben
      // 🚨 KRITISCH: analyzeWritingStyle ist möglicherweise nicht definiert - verwende null als Fallback
      const analyzeWritingStyleFunc = typeof analyzeWritingStyle !== 'undefined' ? analyzeWritingStyle : null;
      const isInfoMessageFunc = isInfoMessage;
      
      // ASA-Kontext für Pipeline (wird aus Chat-Verlauf extrahiert)
      const asaConversationContextForPipeline = (compressConversation(messages || [], 10) || "").toLowerCase();
      
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
      
      // 🚨 NEU: ASA-Duplikat-Schutz - lade letzte ASAs für diesen Chat
      const chatIdForASA = chatId || req.body?.siteInfos?.metaData?.chatId || 'unknown';
      let previousASAs = [];
      try {
        const { getMessages } = require('../utils/github');
        const messages = await getMessages();
        if (messages && Array.isArray(messages)) {
          // Finde letzte 10 ASAs für diesen Chat (letzte 10 Nachrichten vom Fake/Moderator)
          const chatMessages = messages
            .filter(m => m.chatId === chatIdForASA && (m.type === 'sent' || m.messageType === 'sent'))
            .slice(-10)
            .map(m => m.text?.trim() || '')
            .filter(t => t.length > 0);
          previousASAs = chatMessages;
          console.log(`🔍 ASA-Duplikat-Schutz: ${previousASAs.length} vorherige ASAs für Chat ${chatIdForASA} gefunden`);
        }
      } catch (err) {
        console.warn('⚠️ Fehler beim Laden vorheriger ASAs für Duplikat-Schutz:', err.message);
      }
      
      // Hilfsfunktion: Prüfe ob ASA bereits verwendet wurde (Ähnlichkeit > 80%)
      function isASADuplicate(newASA, previousASAs) {
        if (!newASA || !Array.isArray(previousASAs) || previousASAs.length === 0) return false;
        const newASALower = newASA.toLowerCase().trim();
        for (const prevASA of previousASAs) {
          if (!prevASA) continue;
          const prevASALower = prevASA.toLowerCase().trim();
          // Prüfe auf exakte Übereinstimmung oder sehr hohe Ähnlichkeit (>80% gemeinsame Wörter)
          if (newASALower === prevASALower) return true;
          // Prüfe auf sehr ähnliche Nachrichten (gleiche ersten 100 Zeichen)
          if (newASALower.substring(0, 100) === prevASALower.substring(0, 100)) return true;
          // Prüfe auf gemeinsame Wörter (>80% Übereinstimmung)
          const newWords = newASALower.split(/\s+/).filter(w => w.length > 3);
          const prevWords = prevASALower.split(/\s+/).filter(w => w.length > 3);
          if (newWords.length > 0 && prevWords.length > 0) {
            const commonWords = newWords.filter(w => prevWords.includes(w));
            const similarity = (commonWords.length * 2) / (newWords.length + prevWords.length);
            if (similarity > 0.8) return true;
          }
        }
        return false;
      }
      
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
            // 🚨 NEU: Rotiere durch ASAs statt zufällig (mehr Variation)
            // Filtere zuerst Duplikate raus
            const nonDuplicateASAs = filteredASAExamples.filter(asa => {
              const response = asa.moderatorResponse || '';
              return !isASADuplicate(response, previousASAs);
            });
            
            // Wenn alle Duplikate sind, verwende trotzdem alle (besser als keine ASA)
            const availableASAs = nonDuplicateASAs.length > 0 ? nonDuplicateASAs : filteredASAExamples;
            
            // Rotiere durch ASAs (verwende Index basierend auf Anzahl vorheriger ASAs)
            const asaIndex = previousASAs.length % availableASAs.length;
            const randomASA = availableASAs[asaIndex];
            
            // KRITISCH: Verwende NUR moderatorResponse, NIEMALS customerMessage!
            asaMessage = randomASA.moderatorResponse || null;
            
            if (nonDuplicateASAs.length < filteredASAExamples.length) {
              console.log(`🔄 ASA-Duplikat-Schutz: ${filteredASAExamples.length - nonDuplicateASAs.length} Duplikate gefiltert, ${nonDuplicateASAs.length} verfügbar`);
            }
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
          // 🚨 NEU: Rotiere durch generische ASAs statt zufällig (mehr Variation + Duplikat-Schutz)
          // Filtere Duplikate raus
          const nonDuplicateGenericASAs = filteredGenericASAs.filter(example => {
            let response = "";
            if (typeof example === 'string') {
              response = example;
            } else if (typeof example === 'object' && example !== null) {
              response = example.asaMessage || example.moderatorResponse || example.text || example.message || example.response || example.asa || "";
            }
            return !isASADuplicate(response, previousASAs);
          });
          
          // Wenn alle Duplikate sind, verwende trotzdem alle (besser als keine ASA)
          const availableGenericASAs = nonDuplicateGenericASAs.length > 0 ? nonDuplicateGenericASAs : filteredGenericASAs;
          
          // Rotiere durch ASAs (verwende Index basierend auf Anzahl vorheriger ASAs)
          const genericASAIndex = previousASAs.length % availableGenericASAs.length;
          const randomGenericASA = availableGenericASAs[genericASAIndex];
          
          if (nonDuplicateGenericASAs.length < filteredGenericASAs.length) {
            console.log(`🔄 ASA-Duplikat-Schutz: ${filteredGenericASAs.length - nonDuplicateGenericASAs.length} generische Duplikate gefiltert, ${nonDuplicateGenericASAs.length} verfügbar`);
          }
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
        // 🚨🚨🚨 KRITISCH: KEIN Fallback über Multi-Agent-Pipeline! ASA-Nachrichten MÜSSEN aus Training-Daten kommen!
        // Fallback-Nachrichten können zu Sperrungen führen und sind nicht gewünscht!
        return res.status(200).json({
          error: "❌ FEHLER: Keine ASA-Beispiele in Training-Daten gefunden - keine ASA-Nachricht generiert (verhindert Fallback-Nachrichten)",
          resText: "",
          replyText: "",
          summary: extractedInfo,
          chatId: chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000",
          actions: [],
          flags: { blocked: true, reason: "no_asa_examples", isError: true, showError: false } // showError: false, damit Extension nicht blockiert
        });
      }
      
      // ✅ ASA-Nachricht erfolgreich aus Training-Daten generiert - verwende diese!
      console.log("✅ ASA-Nachricht aus Training-Daten generiert:", asaMessage.substring(0, 100) + "...", `(${asaMessage.length} Zeichen)`);
      
      // Post-Processing: Bereinige Nachricht
      if (asaMessage) {
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
      }
      
      // Stelle sicher, dass ASA-Nachricht mindestens 150 Zeichen hat (laut Memories)
      const asaMinLen = 150;
      if (asaMessage && asaMessage.length < asaMinLen) {
        console.warn(`⚠️ ASA-Nachricht zu kurz (${asaMessage.length} Zeichen, benötigt >=150) - füge zusätzlichen Text hinzu...`);
        const additionalFiller = " Ich würde wirklich gerne wieder von dir hören und unsere Unterhaltung fortsetzen. Was hält dich denn gerade ab, mir zu schreiben?";
        asaMessage = (asaMessage + additionalFiller).trim();
      }
      
      // Stelle sicher, dass sie mit Interpunktion endet
      if (asaMessage && !asaMessage.match(/[.!?]$/)) {
        asaMessage += "?";
      }
      
      if (!asaMessage || asaMessage.trim() === "") {
        console.error("❌ FEHLER: ASA-Nachricht ist leer nach Post-Processing!");
        return res.status(200).json({
          error: "❌ FEHLER: ASA-Nachricht ist leer nach Post-Processing",
          resText: "",
          replyText: "",
          summary: extractedInfo,
          chatId: chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000",
          actions: [],
          flags: { blocked: true, reason: "empty_asa_response", isError: true, showError: false }
        });
      }

      // ASA-Antwort jetzt direkt zurückgeben (Multi-Agent-Pipeline bleibt deaktiviert)
      const asaChatId = chatId || req.body?.siteInfos?.chatId || finalChatId || "00000000";
      const minWait = 40;
      const maxWait = 60;
      const asaWaitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
      const asaValidAssets = validateAssets(assetsToSend);

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
        assets: asaValidAssets,
        flags: {
          blocked: false,
          noReload: true,
          skipReload: true
        },
        disableAutoSend: true,
        waitTime: asaWaitTime,
        noReload: true
      });
      
      // 🚨🚨🚨 ENTFERNT: Multi-Agent-Pipeline für ASA-Nachrichten!
      // ASA-Nachrichten sollen NUR aus trainingData.asaExamples kommen, NICHT über Multi-Agent-Pipeline generiert werden!
      // Die Multi-Agent-Pipeline ist für normale Konversationen gedacht, nicht für Reaktivierungsnachrichten!
      // Dies verhindert auch Fallback-Nachrichten, die zu Sperrungen führen können!
    }
    
    // 🚨 ENTFERNT: Multi-Agent-Pipeline für ASA-Nachrichten
    // ASA-Nachrichten kommen jetzt NUR aus trainingData.asaExamples!
    // Die nachfolgende Multi-Agent-Pipeline-Logik wurde entfernt, da sie Fallback-Nachrichten generiert!
    /*
    try {
      console.log('🤖 Multi-Agent-Pipeline wird gestartet für ASA...');
      
      // 🚨 NEU: Rufe Multi-Agent-Pipeline auf mit isASA: true
      const multiAgentResults = await runMultiAgentPipeline({
        conversationHistory: compressConversation(messages || [], 10) || "",
        customerMessage: '', // Bei ASA gibt es keine neue Kunden-Nachricht
        profileInfo: profileInfoForPipeline,
        extractedUserInfo: extractedUserInfoForPipeline,
        allRules: rules,
        trainingData: trainingData,
        situations: ['ASA'], // ASA-Situation
        imageUrl: imageUrlForPipeline,
        moderatorMessages: moderatorMessagesForPipeline,
        customerMessages: customerMessagesForPipeline,
        allMessages: allMessages,
        feedbackData: null,
        vectorDbFunc: vectorDbFunc,
        imageAnalysisFunc: imageAnalysisFunc,
        proactiveAnalysisFunc: proactiveAnalysisFunc,
        analyzeWritingStyleFunc: analyzeWritingStyleFunc,
        isInfoMessageFunc: isInfoMessageFunc,
        isASA: true, // 🚨 WICHTIG: ASA-Flag aktivieren
        asaConversationContext: asaConversationContextForPipeline,
        isLocationQuestionFunc: isLocationQuestionFunc,
        findNearbyCityFunc: findNearbyCityFunc,
        isMeetingRequestFunc: isMeetingRequestFuncForPipeline
      });
      
      // Prüfe, ob Pipeline blockiert wurde (Safety-Check)
      if (multiAgentResults.blocked) {
        console.error(`🚨 Multi-Agent-Pipeline (ASA): BLOCKIERT - ${multiAgentResults.error || 'Unbekannter Fehler'}`);
        return res.status(200).json({
          error: multiAgentResults.error || "❌ FEHLER: ASA-Nachricht wurde blockiert",
          resText: multiAgentResults.error || "❌ FEHLER: ASA-Nachricht wurde blockiert",
          replyText: "",
          summary: extractedInfo,
          chatId: finalChatId,
          actions: [],
          flags: { blocked: true, reason: multiAgentResults.safety?.reason || "safety_blocked", isError: true, showError: true }
        });
      }
      
      console.log('✅ Multi-Agent-Pipeline (ASA) erfolgreich abgeschlossen');
      
      // 🚨 NEU: Rufe agentMessageGenerator auf für ASA
      const messageResult = await agentMessageGenerator(multiAgentResults, {
        conversationHistory: compressConversation(messages || [], 10) || "",
        customerMessage: '', // Bei ASA gibt es keine neue Kunden-Nachricht
        profileInfo: profileInfoForPipeline,
        extractedUserInfo: extractedUserInfoForPipeline,
        allRules: rules,
        isASA: true, // 🚨 WICHTIG: ASA-Flag aktivieren
        asaConversationContext: asaConversationContextForPipeline,
        platformId: platformId || 'viluu',
        isMeetingRequestFunc: isMeetingRequestFuncForPipeline
      });
      
      if (!messageResult.success) {
        throw new Error(messageResult.error || 'Fehler bei agentMessageGenerator (ASA)');
      }
      
      let asaMessage = messageResult.message || '';
      console.log('✅ ASA-Nachricht von Multi-Agent-Pipeline generiert:', asaMessage ? asaMessage.substring(0, 100) + '...' : '(leer)');
      
      // Post-Processing: Bereinige Nachricht
      if (asaMessage) {
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
      }
      
      // Stelle sicher, dass ASA-Nachricht mindestens 150 Zeichen hat
      const asaMinLen = 150;
      if (asaMessage && asaMessage.length < asaMinLen) {
        console.warn(`⚠️ ASA-Nachricht zu kurz (${asaMessage.length} Zeichen), füge zusätzlichen Text hinzu...`);
        const additionalFiller = " Ich würde wirklich gerne wieder von dir hören und unsere Unterhaltung fortsetzen. Was hält dich denn gerade ab, mir zu schreiben?";
        asaMessage = (asaMessage + additionalFiller).trim();
      }
      
      // Stelle sicher, dass sie mit Interpunktion endet
      if (asaMessage && !asaMessage.match(/[.!?]$/)) {
        asaMessage += "?";
      }
      
      if (!asaMessage || asaMessage.trim() === "") {
        console.error("❌ FEHLER: ASA-Nachricht ist leer!");
        return res.status(200).json({
          error: "❌ FEHLER: ASA-Nachricht konnte nicht generiert werden",
          resText: "",
          replyText: "",
          summary: extractedInfo,
          chatId: finalChatId,
          actions: [],
          flags: { blocked: true, reason: "empty_asa_response", isError: true, showError: true }
        });
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
          platform: detectedPlatform, // 🚨 FIX: Verwende detectedPlatform statt undefined platform
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
        
        console.log(`✅ ASA-Feedback-Eintrag wird erstellt (Chat-ID: ${chatIdForFeedback}, Platform: ${detectedPlatform})`);
      } catch (err) {
        console.warn('⚠️ Fehler beim Erstellen des ASA-Feedback-Eintrags (nicht kritisch):', err.message);
      }
      
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
    
    // 🚨🚨🚨 ENTFERNT: Fallback-Logik für ASA-Nachrichten!
    // Keine Fallback-Nachrichten mehr - diese führen zu Sperrungen!
    // ASA-Nachrichten MÜSSEN aus trainingData.asaExamples kommen!
    */
  } // Ende: if (isLastMessageFromFake)
  
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
  
  // Wenn es ein ASA-Fall war, sollte bereits eine ASA generiert worden sein und der Code sollte nicht hier ankommen
  // Diese Prüfung ist redundant, da der ASA-Block bereits alle Fälle abdeckt
  // Entfernt, um zu vermeiden, dass der Code fälschlicherweise hier ankommt
    
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
    
    // 🚨 WICHTIG: isMeetingRequest als FUNKTION definieren (wird später als Funktion aufgerufen!)
    // Prüfe auf Treffen/Termine - NUR ECHTE TREFFEN-ANFRAGEN, NICHT FANTASIE!
    // WICHTIG: "würde/könnte/hätte" allein = FANTASIE, kein Treffen!
    // WICHTIG: "wann können wir ficken" ist KEINE Treffen-Anfrage, sondern sexuelle Fantasie!
    // Nur blockieren wenn es wirklich um ein REALES Treffen geht!
    function isMeetingRequest(text, customerMessage = "") {
      if (!text || typeof text !== 'string') return false;
      const lower = text.toLowerCase();
      const lowerCustomer = (customerMessage || "").toLowerCase();
      const combinedLower = `${lower} ${lowerCustomer}`.toLowerCase();
      
      // Prüfe sowohl KI-Antwort als auch Kunden-Nachricht
      return (
      // Direkte Treffen-Anfragen (ohne "würde/könnte/hätte")
        (combinedLower.includes("treffen") && !combinedLower.match(/\b(würde|könnte|hätte|wenn|falls|wäre)\s+.*treffen/i) && !combinedLower.includes("ficken")) ||
      // "Lass uns treffen", "wollen wir uns treffen", "können wir uns treffen" (echte Anfragen)
        (combinedLower.match(/\b(lass|lass uns|wollen|können|sollen|möchten|möchtest)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
        // "Wann können wir uns sehen/treffen" (ABER NICHT "wann können wir ficken"!)
        (combinedLower.match(/\bwann\s+(können|wollen|sollen|möchten)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
        // 🚨 KRITISCH: "Wann hättest du Zeit/Möglichkeit" - Treffen-Anfrage!
        (combinedLower.match(/\bwann\s+(hättest|hast|hättest du|hast du)\s+(du|die)\s+(zeit|möglichkeit|gelegenheit)/i) && !combinedLower.includes("ficken")) ||
        (combinedLower.match(/\bwann\s+(könntest|kannst|könntest du|kannst du)\s+(du|die)\s+(zeit|möglichkeit|gelegenheit)\s+(finden|haben)/i) && !combinedLower.includes("ficken")) ||
        (combinedLower.match(/\b(hättest|hast|hättest du|hast du)\s+(du|die)\s+(zeit|möglichkeit|gelegenheit)\s+(für|für uns|für mich)/i) && !combinedLower.includes("ficken")) ||
      // Orte/Aktivitäten für Treffen (nur wenn nicht in Fantasie-Kontext)
        ((combinedLower.includes("café") || combinedLower.includes("cafe") || combinedLower.includes("park") || 
          combinedLower.includes("spaziergang") || combinedLower.includes("date")) && 
          !combinedLower.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(café|cafe|park|spaziergang|date)/i)) ||
      // "Abholen", "vorbeikommen", "besuchen" (nur wenn nicht in Fantasie-Kontext)
        ((combinedLower.includes("abholen") || combinedLower.includes("abhole") || 
          combinedLower.includes("vorbeikommen") || combinedLower.includes("besuchen")) &&
          !combinedLower.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(abholen|vorbeikommen|besuchen)/i)) ||
      // "Bei dir/bei mir" (nur wenn nicht in Fantasie-Kontext)
        ((combinedLower.includes("bei dir") || combinedLower.includes("bei mir")) &&
          !combinedLower.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(bei dir|bei mir)/i)) ||
      // "Sehen wir uns", "echtes Leben", "real life" (nur wenn nicht in Fantasie-Kontext)
        ((combinedLower.includes("sehen wir uns") || combinedLower.includes("echtes leben") || 
          combinedLower.includes("real life") || combinedLower.includes("im echten leben")) &&
          !combinedLower.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(sehen|echtes leben|real life)/i)) ||
      // Uhrzeiten/Adressen (nur wenn nicht in Fantasie-Kontext)
        ((combinedLower.match(/\b(1[89]|20|21)\s*uhr/i) || combinedLower.match(/\b(1[89]|20|21):00/i) ||
          combinedLower.includes("adresse") || combinedLower.includes("wohnst") ||
          combinedLower.includes("wo wohnst") || combinedLower.includes("wohnen")) &&
          !combinedLower.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(uhr|adresse|wohnst|wohnen)/i))
      );
    }
    
    // Prüfe Kunden-Nachricht auf Treffen-Anfrage (für Prompt)
    const isCustomerMeetingRequest = isMeetingRequest(foundMessageText, "");
    
    // 🚨 KRITISCH: Extrahiere Geschlecht des FAKE-PROFILS (für Rollenverständnis)
    // PRIORITÄT 1: Profilbild-Analyse (genaueste Methode)
    // PRIORITÄT 2: moderatorInfo.gender (aus metaData)
    // PRIORITÄT 3: userProfile.gender (Fallback)
    let fakeGender = null;
    let customerGender = null;
    
    // PRIORITÄT 1: Profilbild-Analyse (wird später gemacht, aber hier vorbereitet)
    // PRIORITÄT 2: moderatorInfo.gender
    const moderatorInfo = req.body?.siteInfos?.metaData?.moderatorInfo || {};
    if (moderatorInfo.gender) {
      fakeGender = moderatorInfo.gender.toLowerCase();
      console.log(`✅ Fake-Geschlecht aus moderatorInfo: ${fakeGender}`);
    }
    
    // PRIORITÄT 3: userProfile.gender (Fallback)
    if (!fakeGender && userProfile && typeof userProfile === 'object') {
      if (userProfile.gender) fakeGender = userProfile.gender.toLowerCase();
      if (!fakeGender && userProfile.sex) fakeGender = userProfile.sex.toLowerCase();
      if (fakeGender) console.log(`✅ Fake-Geschlecht aus userProfile: ${fakeGender}`);
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
    // 🚨 WICHTIG: moderatorInfo wurde bereits oben deklariert (Zeile 2637), nicht nochmal!
    const customerInfo = req.body?.siteInfos?.metaData?.customerInfo || {};
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
      // 🚨 PROAKTIVE PRÄVENTION: Liste der verbotenen Wörter für explizite Vermeidung
      const forbiddenWordsList = rulesForSystem.forbiddenWords.map(w => `"${w}"`).join(', ');
      forbiddenWordsSystemNote = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH - VERBOTENE WÖRTER (ABSOLUT NIEMALS VERWENDEN!) 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\nDie folgenden ${rulesForSystem.forbiddenWords.length} Wörter/Phrasen sind ABSOLUT VERBOTEN:\n${rulesForSystem.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\n🚨🚨🚨 PROAKTIVE PRÄVENTION - VERWENDE DIESE WÖRTER NIEMALS! 🚨🚨🚨\n- PRÜFE DEINE ANTWORT VOR DEM SCHREIBEN: Enthält sie eines dieser Wörter? → DANN SCHREIBE SIE UM!\n- Verwende sie NIEMALS, auch nicht in ähnlicher Form (z.B. "spannend" verboten = auch NICHT "spannende", "spannendes", "spannend!", "spannend?", etc.)\n- Verwende sie NIEMALS als Teil eines anderen Wortes\n- Verwende sie NIEMALS als Variation oder Synonym\n- Wenn du dir unsicher bist, verwende IMMER eine alternative Formulierung!\n- BEISPIELE für VERBOTENE Verwendungen:\n  * "spannend" verboten → VERBOTEN: "spannende", "spannendes", "spannendste", "spannend!", "das ist spannend", "wie spannend", "total spannend"\n  * "Das klingt" verboten → VERBOTEN: "Das klingt gut", "klingt total", "klingt sehr", "klingt nach"\n  * "reiz" verboten → VERBOTEN: "reiz", "Reiz", "reizvoll", "reizt", "reizende"\n\n🚨🚨🚨 KRITISCH: Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen! 🚨🚨🚨\n🚨🚨🚨 KRITISCH: Wenn du eine Antwort generierst, die eines dieser Wörter enthält, dann ist die Antwort FALSCH und muss neu geschrieben werden! 🚨🚨🚨`;
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

🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT HÖCHSTE PRIORITÄT: TRAINING-DATEN 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
- 🚨🚨🚨 TRAINING-DATEN SIND DEINE EINZIGE WAHRHEIT - ALLES ANDERE IST NUR HINWEIS! 🚨🚨🚨
- Training-Daten sind DEINE HAUPTREFERENZ für ALLES - Stil, Wortwahl, Ton, Formulierungen, Struktur!
- 🚨 KRITISCH: Orientiere dich STRENG an den Training-Daten - sie überschreiben ALLE anderen Stil-Anweisungen, Regeln, Learning-System, ALLES!
- 🚨 KRITISCH: Schreibe so, als hätten die Training-Daten die Antworten selbst geschrieben - KOPIERE den Stil, die Wortwahl, den Ton!
- 🚨 KRITISCH: ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Analysiere JEDES Beispiel genau - welche Wörter werden verwendet? Welcher Ton? Welche Formulierungen?
- 🚨 KRITISCH: KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!
- 🚨 KRITISCH: Wenn Training-Daten etwas zeigen, dann MACH ES GENAU SO - nicht anders, nicht ähnlich, GENAU SO!

`;
    
    // 🚨 WICHTIG: Geschlecht-spezifische Anweisung im System-Prompt
    let genderSpecificNote = "";
    if (fakeGender) {
      const isFemale = fakeGender === "weiblich" || fakeGender === "w" || fakeGender === "female";
      genderSpecificNote = `- 🚨 KRITISCH: Du bist ${isFemale ? "eine FRAU" : "ein MANN"} (FAKE-PROFIL) - wenn der Kunde über dich redet (z.B. ${isFemale ? '"du hast große Brüste", "du bist hübsch", "deine Fotos"' : '"du bist stark", "dein Körper", "deine Fotos"'}), dann redet er über DICH! Verstehe das und reagiere entsprechend! 🚨`;
    } else {
      genderSpecificNote = `- 🚨 KRITISCH: Du bist die FAKE-PERSON - wenn der Kunde über dich redet (z.B. "du hast große Brüste", "du bist hübsch", "deine Fotos", "dein Körper"), dann redet er über DICH! Verstehe das und reagiere entsprechend! 🚨`;
    }
    
    const systemPrompt = `${allGeneralRules}🚨🚨🚨 DEINE ROLLE & LOGISCHES DENKEN 🚨🚨🚨
Du bist ein Chat-Moderator auf einer Dating-Plattform. Du verwaltest verschiedene Fake-Profile und antwortest als diese Profile auf Kunden-Nachrichten.

WICHTIGES VERSTÄNDNIS:
- Du bist Chat-Moderator: Du bekommst Chats zugeteilt, wenn ein Kunde einem Fake-Profil antwortet
- Andere Moderatoren schreiben auch: Du siehst ihre Nachrichten im Chat-Verlauf - nutze sie für Kontext!
- Du antwortest als FAKE-PROFIL: Der Kunde schreibt DIR (dem Fake-Profil), nicht dir (dem Moderator)!
- Dating-Plattform: Menschen suchen hier Dates, Sex, Beziehungen oder Freundschaften - das ist der KONTEXT!

LOGISCHES DENKEN:
- Wenn der Kunde ablehnt (z.B. "ich will nie Sex", "lass mich in Ruhe"), dann denke LOGISCH:
  * Er ist auf einer Dating-Seite → Was sucht er dann hier? (Freundschaft? Beziehung ohne Sex?)
  * Logische Frage: "Okay, das kann ich verstehen. Aber was suchst du dann hier genau? Suchst du hier nur eine Freundschaft?"
- Wenn der Kunde etwas sagt, das nicht zum Kontext passt → Denke logisch: Was meint er wirklich?
- Nutze den Chat-Verlauf: Wenn andere Moderatoren vorher geschrieben haben, verstehe den Kontext!

🚨🚨🚨 KRITISCH: DU BIST DAS FAKE-PROFIL 🚨🚨🚨
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- Der KUNDE schreibt DIR (dem Fake-Profil)! Du antwortest auf SEINE Nachricht!
${genderSpecificNote}
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

🚨🚨🚨 ERWEITERTE KONTEXTANALYSE - ZEITKONTEXT 🚨🚨🚨
- Aktuelle Tageszeit: ${hour}:${minute.toString().padStart(2, '0')} Uhr
- Tagesphase: ${hour >= 22 || hour < 6 ? 'Nacht' : hour >= 18 ? 'Abend' : hour >= 12 ? 'Nachmittag' : hour >= 6 ? 'Vormittag' : 'Nacht'}
- Wochentag: ${weekday} (${weekdayShort === 'Sa' || weekdayShort === 'So' ? 'Wochenende' : 'Wochentag'})
- Jahreszeit: ${season}
- Nutze diesen Zeitkontext für natürlichere Antworten (z.B. "Guten Morgen" nur morgens, "Gute Nacht" nur abends, Wochenende-Erwähnungen nur am Wochenende)!
${forbiddenWordsSystemNote}`;
    
    // WICHTIG: userProfile könnte die Daten vom FAKE enthalten, nicht vom KUNDEN
    // Verwende daher NUR die extrahierten Infos vom KUNDEN (aus der Nachricht)
    // NICHT userProfile, da das die Daten vom Fake sein könnten!
    
    // 🚨🚨🚨 ERWEITERTE KONTEXTANALYSE - KUNDENPROFIL BESSER NUTZEN 🚨🚨🚨
    // Baue Kontext für bessere Antworten - NUR aus extrahierten Kunden-Infos
    const customerContext = [];
    if (extractedInfo.user && Object.keys(extractedInfo.user).length > 0) {
      Object.entries(extractedInfo.user).forEach(([key, value]) => {
        if (value) customerContext.push(`${key}: ${value}`);
      });
    }
    
    // 🚨 NEU: Nutze auch metaData für erweiterte Kundenprofil-Infos
    if (req.body?.siteInfos?.metaData?.customerInfo) {
      const customerInfo = req.body.siteInfos.metaData.customerInfo;
      if (customerInfo.name && !customerContext.some(c => c.includes('Name'))) {
        customerContext.push(`Name: ${customerInfo.name}`);
      }
      if (customerInfo.city && !customerContext.some(c => c.includes('Stadt'))) {
        customerContext.push(`Stadt: ${customerInfo.city}`);
      }
      if (customerInfo.country && !customerContext.some(c => c.includes('Land'))) {
        customerContext.push(`Land: ${customerInfo.country}`);
      }
      if (customerInfo.gender && !customerContext.some(c => c.includes('Geschlecht'))) {
        customerContext.push(`Geschlecht: ${customerInfo.gender}`);
      }
      if (customerInfo.birthDate && !customerContext.some(c => c.includes('Geburtsdatum'))) {
        customerContext.push(`Geburtsdatum: ${customerInfo.birthDate}`);
      }
      if (customerInfo.hasProfilePic) {
        customerContext.push(`Hat Profilbild: Ja`);
      }
      if (customerInfo.hasPictures) {
        customerContext.push(`Hat weitere Bilder: Ja`);
      }
    }
    
    // Extrahiere den Namen des KUNDEN aus der Nachricht (nicht vom userProfile!)
    // WICHTIG: Name kleingeschrieben verwenden (wie in Training-Daten)
    const customerNameRaw = extractedInfo.user?.Name || req.body?.siteInfos?.metaData?.customerInfo?.name || null;
    const customerName = customerNameRaw ? customerNameRaw.toLowerCase() : null;
    const customerJob = extractedInfo.user?.Work || null;
    
    console.log(`📊 Erweiterte Kontextanalyse: ${customerContext.length} Kundenprofil-Infos`);
    
    // 🚨 WICHTIG: Analysiere die letzte Moderator-Nachricht für Stil-Konsistenz!
    // Die KI soll sich an Training-Daten UND der letzten Moderator-Nachricht orientieren!
    let styleContext = "";
    let lastModeratorMessage = null;
    try {
      const messages = req.body?.siteInfos?.messages || [];
      // 🚨🚨🚨 ERWEITERTE KONTEXTANALYSE: Letzte 10-20 Nachrichten für besseren Kontext!
      // Dynamisch: Bei langen Gesprächen mehr Nachrichten, bei kurzen weniger
      const totalMessages = messages.filter(m => !isInfoMessage(m) && typeof m?.text === "string" && m.text.trim() !== "").length;
      const contextSize = totalMessages > 20 ? 20 : totalMessages > 10 ? 15 : 10; // Dynamisch: 10-20 Nachrichten
      
      const moderatorMessages = messages
        .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-contextSize); // 🚨 ERWEITERT: Letzte 10-20 Moderator-Nachrichten für besseren Kontext!
      
      const customerMessages = messages
        .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-contextSize); // 🚨 ERWEITERT: Letzte 10-20 Kunden-Nachrichten für besseren Kontext!
      
      console.log(`📊 Erweiterte Kontextanalyse: ${moderatorMessages.length} Moderator + ${customerMessages.length} Kunden-Nachrichten (Gesamt: ${totalMessages} Nachrichten, Context-Size: ${contextSize})`);
      
      if (moderatorMessages.length > 0) {
        lastModeratorMessage = moderatorMessages[moderatorMessages.length - 1].text.trim(); // Die neueste
        const writingStyle = analyzeWritingStyle(messages);
        
        if (lastModeratorMessage && lastModeratorMessage.length > 0) {
          styleContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: GESPRÄCHS-KONTEXT - MODERATOR & KUNDE! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
          
          // 🚨 NEU: Zeige ALLE letzten Moderator-Nachrichten (bis zu 5) für besseren Kontext
          if (moderatorMessages.length > 0) {
            styleContext += `📤 DEINE letzten ${moderatorMessages.length} Nachrichten (als Fake/Moderator, von ältest zu neuest):\n\n`;
            moderatorMessages.forEach((msg, idx) => {
              const msgText = msg.text.trim();
              if (msgText.length > 0) {
                styleContext += `${idx + 1}. "${msgText.substring(0, 200)}${msgText.length > 200 ? '...' : ''}"\n`;
              }
            });
            styleContext += `\n`;
          }
          
          // 🚨 NEU: Zeige ALLE letzten Kunden-Nachrichten (bis zu 5) für besseren Kontext
          if (customerMessages.length > 0) {
            styleContext += `📥 KUNDE'S letzten ${customerMessages.length} Nachrichten (von ältest zu neuest):\n\n`;
            customerMessages.forEach((msg, idx) => {
              const msgText = msg.text.trim();
              if (msgText.length > 0) {
                styleContext += `${idx + 1}. "${msgText.substring(0, 200)}${msgText.length > 200 ? '...' : ''}"\n`;
              }
            });
            styleContext += `\n`;
          }
          
          styleContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - KONTEXT VERSTEHEN! 🚨🚨🚨🚨🚨\n`;
          styleContext += `- Die Nachrichten oben zeigen dir, WORUM es im Gespräch geht!\n`;
          styleContext += `- Analysiere ALLE Moderator-Nachrichten UND Kunden-Nachrichten, um den vollen KONTEXT zu verstehen!\n`;
          styleContext += `- Was war das THEMA in diesen Nachrichten? Worauf bezieht sich die letzte Kunden-Nachricht?\n`;
          styleContext += `- 🚨🚨🚨🚨🚨 KRITISCH: WER ANGEBOTEN HAT vs. WER ZUGESTIMMT HAT! 🚨🚨🚨🚨🚨\n`;
          styleContext += `- 🚨🚨🚨 KRITISCH: Wenn DU (Moderatorin) etwas ANGEBOTEN hast (z.B. "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??"), und der Kunde ZUSTIMMT (z.B. "Ja sicher immer erzählen"), dann MUSST DU DAS TUN, WAS DU ANGEBOTEN HAST!\n`;
          styleContext += `- 🚨🚨🚨 KRITISCH: Wenn DU etwas anbietest und der Kunde zustimmt, dann ist es DEINE Aufgabe, das anzubieten, nicht die des Kunden!\n`;
          styleContext += `- 🚨🚨🚨 KRITISCH: Beispiel: Du schreibst "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??" → Kunde antwortet "Ja sicher immer erzählen" → Du MUSST JETZT VON DEINEM TRAUM ERZÄHLEN, NICHT den Kunden fragen, ob ER erzählen will!\n`;
          styleContext += `- Wenn diese Nachrichten sexuell waren (z.B. "Treffen im Pflegeheim"), dann geht es weiterhin um SEXUELLE Themen!\n`;
          styleContext += `- Wenn der Kunde jetzt "im Krankenhaus" sagt, bezieht er sich auf die SEXUELLE Fantasie aus deinen Nachrichten, NICHT auf Arbeit!\n`;
          styleContext += `- Wenn diese Nachrichten um ein Treffen gingen, dann bezieht sich "im Krankenhaus" auf das TREFFEN, nicht auf einen Job!\n`;
          styleContext += `- VERSTEHE den KONTEXT: Was war das THEMA in deinen letzten Nachrichten? Der Kunde antwortet darauf!\n`;
          styleContext += `- Wenn deine letzten Nachrichten sexuell waren, dann ist die Kunden-Antwort auch sexuell gemeint!\n`;
          styleContext += `- Wenn deine letzten Nachrichten um ein Treffen gingen, dann bezieht sich "im Krankenhaus" auf das Treffen, nicht auf Arbeit!\n`;
          styleContext += `- 🚨🚨🚨 WICHTIG: Analysiere ALLE Moderator-Nachrichten UND Kunden-Nachrichten oben, um den vollen Kontext zu verstehen! 🚨🚨🚨\n`;
          styleContext += `- 🚨🚨🚨 WICHTIG: Die Kunden-Nachrichten zeigen dir, wie der Kunde auf deine Nachrichten reagiert hat - nutze das für den Kontext! 🚨🚨🚨\n\n`;
          styleContext += `🚨🚨🚨 ABSOLUT KRITISCH - STIL BEIBEHALTEN! 🚨🚨🚨\n`;
          styleContext += `- Du MUSST den STIL der letzten Moderator-Nachrichten BEIBEHALTEN!\n`;
          styleContext += `- Wenn die letzten Nachrichten persönlich/emotional waren, dann schreibe auch persönlich/emotional!\n`;
          styleContext += `- Wenn die letzten Nachrichten spielerisch/vertraut waren, dann schreibe auch spielerisch/vertraut!\n`;
          styleContext += `- Wenn die letzten Nachrichten direkt/roh waren, dann schreibe auch direkt/roh!\n`;
          styleContext += `- Übernehme die WORTWAHL, den TON und die FORMULIERUNGEN aus den letzten Nachrichten!\n`;
          styleContext += `- Passe dich dem KUNDEN an (wie in den letzten Nachrichten), aber behalte den STIL bei!\n`;
          styleContext += `- Training-Daten zeigen dir QUALITÄT, aber die letzten Moderator-Nachrichten zeigen dir den STIL und KONTEXT für DIESEN Chat!\n`;
          styleContext += `- Kombiniere BEIDES: Qualität aus Training-Daten + Stil/Kontext aus letzten Moderator-Nachrichten!\n\n`;
          
          if (writingStyle) {
            styleContext += `📊 Stil-Analyse der letzten Moderator-Nachrichten:\n`;
            styleContext += `- Durchschnittliche Länge: ${writingStyle.avgLength} Zeichen\n`;
            if (writingStyle.hasEmojis) styleContext += `- Emojis verwendet: Ja\n`;
            if (writingStyle.hasExclamation) styleContext += `- Ausrufezeichen verwendet: Ja\n`;
            if (writingStyle.hasQuestion) styleContext += `- Fragen gestellt: Ja\n`;
            if (writingStyle.hasCasual) styleContext += `- Lockere Sprache verwendet: Ja\n`;
            styleContext += `\n`;
          }
          
          console.log(`✅ ${moderatorMessages.length} Moderator-Nachricht(en) und ${customerMessages.length} Kunden-Nachricht(en) analysiert (letzte Moderator: ${lastModeratorMessage.substring(0, 100)}...)`);
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Analysieren der Moderator- und Kunden-Nachrichten (nicht kritisch):', err.message);
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
- 🚨🚨🚨 KRITISCH: Wenn die letzte Kunden-Nachricht KURZ ist (z.B. "Sehr lange", "Ja", "Ok", "Gut", "Aha", "im Krankenhaus ja das wäre so ne idee", "Ja sicher immer erzählen"), dann ist es wahrscheinlich eine ANTWORT auf eine VORHERIGE NACHRICHT von dir!
- 🚨🚨🚨 KRITISCH: Prüfe die VORHERIGE Moderator-Nachricht im Chat-Verlauf - was war das THEMA? Der Kunde antwortet darauf!
- 🚨🚨🚨🚨🚨 KRITISCH: WER ANGEBOTEN HAT vs. WER ZUGESTIMMT HAT! 🚨🚨🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Wenn DU (Moderatorin) etwas ANGEBOTEN hast (z.B. "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??"), und der Kunde ZUSTIMMT (z.B. "Ja sicher immer erzählen"), dann MUSST DU DAS TUN, WAS DU ANGEBOTEN HAST!
- 🚨🚨🚨 KRITISCH: Beispiel: Du schreibst "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??" → Kunde antwortet "Ja sicher immer erzählen" → Du MUSST JETZT VON DEINEM TRAUM ERZÄHLEN, NICHT den Kunden fragen, ob ER erzählen will!
- 🚨🚨🚨 KRITISCH: Wenn DU etwas anbietest und der Kunde zustimmt, dann ist es DEINE Aufgabe, das anzubieten, nicht die des Kunden!
- 🚨🚨🚨 KRITISCH: Beispiel 1: Du fragst "Wie lange bist du schon single?" → Kunde antwortet "Sehr lange" → Du MUSST darauf eingehen (z.B. "Oh, das ist schon eine Weile. Wie geht es dir damit?"), NICHT eine neue Frage stellen, die den Kontext ignoriert!
- 🚨🚨🚨 KRITISCH: Beispiel 2: Du schreibst "Treffen im Pflegeheim" (sexuelle Fantasie) → Kunde antwortet "im Krankenhaus ja das wäre so ne idee" → Der Kunde bezieht sich auf die SEXUELLE Fantasie, NICHT auf Arbeit! Reagiere sexuell darauf, nicht über "im Krankenhaus arbeiten"!
- 🚨🚨🚨 KRITISCH: Beispiel 3: Du schreibst "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??" → Kunde antwortet "Ja sicher immer erzählen" → Du MUSST JETZT VON DEINEM TRAUM ERZÄHLEN (z.B. "Also, in meinem Traum haben wir uns in einer gemütlichen Hütte im Schnee getroffen..."), NICHT den Kunden fragen, ob ER gerne erzählt!
- 🚨🚨🚨 KRITISCH: Wenn deine letzte Moderator-Nachricht sexuell war, dann ist die Kunden-Antwort auch sexuell gemeint - auch wenn sie kurz ist!
- 🚨🚨🚨 KRITISCH: Wenn deine letzte Moderator-Nachricht um ein Treffen ging, dann bezieht sich "im Krankenhaus" auf das Treffen, nicht auf einen Jobwechsel!
- 🚨🚨🚨 KRITISCH: Bei kurzen Antworten des Kunden: Gehe auf die VORHERIGE Moderator-Nachricht ein, stelle KEINE neue Frage, die den Kontext ignoriert!
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
    
    // 🆕 ERWEITERTE BILD-KONTEXT: Spezifische Reaktionen basierend auf Bildtyp
    let imageContext = "";
    if (imageDescriptions.length > 0) {
      // Prüfe, ob Bildtyp erkannt wurde (Marker [BILDTYP: ...])
      const imageTypeMarker = imageDescriptions.find(desc => desc.includes('[BILDTYP:'));
      let imageType = 'unknown';
      if (imageTypeMarker) {
        const match = imageTypeMarker.match(/\[BILDTYP: (\w+)\]/);
        if (match) imageType = match[1];
      }
      
      // Filtere Marker aus Beschreibungen
      const cleanDescriptions = imageDescriptions.filter(desc => !desc.includes('[BILDTYP:'));
      
      if (imageType === 'penis') {
        // 🚨 EXPLIZIT: Schwanz-Bild - sehr direkte, sexuelle Reaktion
        imageContext = `\n\n🖼️🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: SCHWANZ-BILD ERKANNT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\nDer Kunde hat ein Bild mit seinem Schwanz/Penis geschickt!\n\n🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - EXPLIZITE REAKTION ERFORDERLICH! 🚨🚨🚨🚨🚨\n- Du MUSST SEHR POSITIV und EXPLIZIT reagieren!\n- Sage, wie GEIL der Schwanz aussieht!\n- Sage, was du gerne mit ihm machen würdest (z.B. Blowjob, Handjob, etc.)!\n- Zeige BEGEISTERUNG und INTERESSE!\n- Sei DIREKT, FLIRTY und SEXUELL begeistert!\n- KEINE neutrale Beschreibung - sei EMOTIONAL und ENTHUSIASTISCH!\n- Stelle eine flirty, sexuelle Frage wie "In welches Loch würdest du ihn dann gerne als erstes schieben bei mir?" oder ähnlich!\n- Die Bildbeschreibung ist: "${cleanDescriptions.join(' ')}"\n\n🚨🚨🚨🚨🚨 WICHTIG: Reagiere JETZT auf das Bild - es ist ein Schwanz-Bild, also sei sehr explizit und begeistert! Stelle eine flirty Frage! 🚨🚨🚨🚨🚨\n`;
      } else if (imageType === 'nude') {
        // 🚨 EXPLIZIT: Nacktbild - direkte, sexuelle Reaktion
        imageContext = `\n\n🖼️🚨🚨🚨 KRITISCH: NACKTBILD ERKANNT! 🚨🚨🚨\n\nDer Kunde hat ein Nacktbild geschickt!\n\n🚨🚨🚨 ABSOLUT KRITISCH - EXPLIZITE REAKTION ERFORDERLICH! 🚨🚨🚨\n- Du MUSST POSITIV und EXPLIZIT reagieren!\n- Sage, wie GEIL der Körper aussieht!\n- Sage, was du gerne mit ihm machen würdest!\n- Zeige BEGEISTERUNG und INTERESSE!\n- Sei DIREKT, FLIRTY und SEXUELL begeistert!\n- KEINE neutrale Beschreibung - sei EMOTIONAL und ENTHUSIASTISCH!\n- Die Bildbeschreibung ist: "${cleanDescriptions.join(' ')}"\n\n🚨🚨🚨 WICHTIG: Reagiere JETZT auf das Bild - es ist ein Nacktbild, also sei explizit und begeistert! 🚨🚨🚨\n`;
      } else {
        // Standard: Generische, positive Reaktion
        imageContext = `\n\n🖼️ WICHTIG: Der Kunde hat ein Bild geschickt! Die Bildbeschreibung ist: "${cleanDescriptions.join(' ')}"\n\nDu MUSST auf das Bild eingehen! Reagiere auf das, was im Bild zu sehen ist. Sei spezifisch und beziehe dich auf Details aus dem Bild. Die Bildbeschreibung ist: ${cleanDescriptions.join(' ')}\n`;
      }
    }
    
    // 🧠 NEU: Emotionale Intelligenz - Analysiere Stimmung des Kunden
    let moodContext = "";
    if (client && foundMessageText && foundMessageText.trim().length > 10) {
      try {
        const moodAnalysis = await analyzeCustomerMood(client, foundMessageText, conversationContext.substring(0, 500));
        if (moodAnalysis && moodAnalysis.mood !== 'neutral' && moodAnalysis.confidence > 0.5) {
          moodContext = moodAnalysis.instructions;
          console.log(`🧠 Stimmungs-Analyse integriert: ${moodAnalysis.mood} (Confidence: ${(moodAnalysis.confidence * 100).toFixed(0)}%)`);
        }
      } catch (err) {
        console.warn('⚠️ Fehler bei Stimmungs-Analyse (nicht kritisch):', err.message);
      }
    }
    
    // 🎯 NEU: Proaktive Gesprächsführung - Erkenne stagnierende Gespräche
    let proactiveContext = "";
    if (foundMessageText && foundMessageText.trim().length > 0) {
      try {
        const stagnation = detectStagnantConversation(req.body?.siteInfos?.messages || [], foundMessageText);
        if (stagnation.isStagnant && stagnation.suggestions.length > 0) {
          proactiveContext = `\n\n🎯 PROAKTIVE GESPRÄCHSFÜHRUNG: Stagnation erkannt!\n\nDas Gespräch wirkt etwas langweilig/uninteressant (kurze, generische Antworten).\n\n🚨🚨🚨 WICHTIG: Sei PROAKTIV und BELEBE das Gespräch! 🚨🚨🚨\n- Stelle INTERESSANTE Fragen, die zum aktuellen Gespräch passen!\n- Wechsle NICHT abrupt das Thema - es muss zum Kontext passen!\n- Wenn das Gespräch über Kochen geht, kannst du flirty werden: "Was würdest du denn gerne mit mir kochen?"\n- Wenn das Gespräch über Arbeit geht, frage nach Details: "Was machst du denn da so?"\n- Wenn das Gespräch über Hobbies geht, zeige Interesse: "Erzähl mir mehr darüber!" (🚨 KRITISCH: NICHT "Das klingt spannend" - "spannend" ist VERBOTEN!)\n\nMögliche Themenvorschläge (NUR wenn sie zum Gespräch passen!):\n${stagnation.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n🚨🚨🚨 KRITISCH: Diese Vorschläge sind NUR Beispiele - verwende sie NUR wenn sie zum aktuellen Gespräch passen! 🚨🚨🚨\n`;
          console.log(`🎯 Proaktive Gesprächsführung aktiviert: ${stagnation.suggestions.length} Vorschläge`);
        }
      } catch (err) {
        console.warn('⚠️ Fehler bei proaktiver Gesprächsführung (nicht kritisch):', err.message);
      }
    }
    
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
        // 🚨 PROAKTIVE PRÄVENTION: Explizite Liste der verbotenen Wörter
        const forbiddenWordsList = rules.forbiddenWords.map(w => `"${w}"`).join(', ');
        forbiddenWordsContext = `\n\n❌❌❌❌❌❌❌❌❌ VERBOTENE WÖRTER/PHRASEN (ABSOLUT NIEMALS VERWENDEN!) ❌❌❌❌❌❌❌❌❌\n\nDie folgenden ${rules.forbiddenWords.length} Wörter/Phrasen sind ABSOLUT VERBOTEN:\n${rules.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\n🚨🚨🚨🚨🚨 PROAKTIVE PRÄVENTION - VERWENDE DIESE WÖRTER NIEMALS! 🚨🚨🚨🚨🚨\n\n🚨🚨🚨 KRITISCH: PRÜFE DEINE ANTWORT VOR DEM SCHREIBEN! 🚨🚨🚨\n- Enthält deine Antwort eines dieser Wörter? → DANN SCHREIBE SIE UM!\n- Verwende sie NIEMALS, auch nicht in ähnlicher Form (z.B. "spannend" verboten = auch NICHT "spannende", "spannendes", "spannend!", "spannend?", etc.)\n- Verwende sie NIEMALS als Teil eines anderen Wortes\n- Verwende sie NIEMALS als Variation oder Synonym\n- Verwende sie NIEMALS in Kombination mit anderen Wörtern\n\nBEISPIELE für VERBOTENE Verwendungen:\n- "spannend" verboten → VERBOTEN: "spannende", "spannendes", "spannendste", "spannend!", "das ist spannend", "wie spannend", "total spannend"\n- "Das klingt" verboten → VERBOTEN: "Das klingt gut", "klingt total", "klingt sehr", "klingt nach", "klingt interessant"\n- "reiz" verboten → VERBOTEN: "reiz", "Reiz", "reizvoll", "reizt", "reizende", "reizend"\n\n🚨🚨🚨 KRITISCH: Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen! 🚨🚨🚨\n🚨🚨🚨 KRITISCH: Wenn du eine Antwort generierst, die eines dieser Wörter enthält, dann ist die Antwort FALSCH und muss neu geschrieben werden! 🚨🚨🚨\n🚨🚨🚨 KRITISCH: Wenn du dir unsicher bist, ob ein Wort verboten ist, verwende IMMER eine andere Formulierung! 🚨🚨🚨`;
        console.log(`🚫 ${rules.forbiddenWords.length} verbotene Wörter/Phrasen geladen und aktiviert`);
      }
      if (rules.preferredWords && Array.isArray(rules.preferredWords) && rules.preferredWords.length > 0) {
        preferredWordsContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER - HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\nDie folgenden ${rules.preferredWords.length} Wörter sind BEVORZUGT und sollten REGELMÄSSIG verwendet werden:\n${rules.preferredWords.map(w => `- "${w}"`).join('\n')}\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - VERWENDE DIESE WÖRTER! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n🚨🚨🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER HABEN HÖCHSTE PRIORITÄT NACH TRAINING-DATEN! 🚨🚨🚨🚨🚨\n⭐⭐⭐ WICHTIG: Diese Wörter sind NICHT ohne Grund da - sie wurden basierend auf Feedback und Qualität ausgewählt! ⭐⭐⭐\n⭐ WICHTIG: Integriere diese Wörter NATÜRLICH in deine Antworten, wo sie thematisch passen!\n⭐ Verwende sie REGELMÄSSIG - nicht nur bei Neukunden, sondern IMMER wenn es passt!\n⭐ Diese Wörter helfen dir, natürlicher und passender zu klingen!\n⭐ Orientiere dich an den Training-Daten - dort siehst du, wie diese Wörter verwendet werden!\n⭐ Kombiniere bevorzugte Wörter MIT Training-Daten - beide zusammen = BESTE Qualität!\n\n🚨 KRITISCH: KEIN "random" reinwerfen! NUR wenn es zur Message passt und nicht unnatürlich wirkt!\n🚨 ABER: Wenn ein Preferred Word thematisch passt, dann VERWENDE ES - nicht weglassen!\n🚨🚨🚨 WICHTIG: Bevorzugte Wörter + Training-Daten + Learning-System = BESTE Kombination! 🚨🚨🚨\n\n`;
        console.log(`⭐ ${rules.preferredWords.length} bevorzugte Wörter geladen und aktiviert`);
      }
    }
    
    // Baue spezifischen Prompt basierend auf Situation
    let specificInstructions = "";
    
    // 🚨 WICHTIG: MEHRFACH-SITUATIONSERKENNUNG - erkenne ALLE passenden Situationen!
    let detectedSituations = []; // Array statt einzelner String
    
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
          
          // Bilder-Anfrage (kann KOMBINIERT mit sexuellen Themen sein!)
          // 🚨 WICHTIG: Nur erkennen, wenn WIRKLICH eine Bilder-Anfrage vorhanden ist (zeig/schick/bild/foto), nicht nur bei sexuellen Themen!
          const hasImageRequest = lowerMessage.includes("zeig") || lowerMessage.includes("zeige") || 
                                  lowerMessage.includes("schick") || lowerMessage.includes("schicke") ||
                                  lowerMessage.includes("bild") || lowerMessage.includes("foto") ||
                                  lowerMessage.includes("photo") || lowerMessage.includes("zeig mir") ||
                                  lowerMessage.includes("schick mir") || lowerMessage.includes("kannst du mir zeigen") ||
                                  lowerMessage.includes("kannst du mir schicken");
          
          if ((situationLower.includes("bild") || situationLower.includes("foto") || situationLower.includes("photo") || 
               situationLower.includes("anfrage") || situationLower.includes("zeig")) && hasImageRequest) {
            matchesSituation = true;
          }
          
          // Berufsfrage - ERWEITERT: Erkenne auch wenn Kunde seinen Beruf NENNT (nicht nur fragt)
          const isJobQuestion = lowerMessage.includes("was arbeitest") || lowerMessage.includes("beruf") ||
               lowerMessage.includes("was machst du beruflich") || lowerMessage.includes("job") ||
                               lowerMessage.includes("wo arbeitest");
          const isJobAnswer = /ich bin (ein|eine|der|die) (autohändler|verkäufer|lehrer|arzt|krankenschwester|pfleger|ingenieur|mechaniker|elektriker|handwerker|bäcker|koch|friseur|kellner|fahrer|pilot|polizist|feuerwehrmann|anwalt|notar|steuerberater|architekt|designer|fotograf|journalist|schriftsteller|musiker|künstler|schauspieler|sportler|trainer|berater|manager|direktor|chef|mitarbeiter|angestellter|arbeiter|student|studentin|schüler|schülerin|rentner|pensionär|arbeitslos|selbstständig|freiberufler|unternehmer|geschäftsführer|inhaber|besitzer)/i.test(lowerMessage) ||
                             /ich arbeite (als|bei|in|als|seit)/i.test(lowerMessage) ||
                             /mein beruf (ist|war|wäre)/i.test(lowerMessage) ||
                             /ich (mache|mach|tue|tu) (beruflich|beruf)/i.test(lowerMessage);
          
          if ((situationLower.includes("beruf") || situationLower.includes("job")) &&
              (isJobQuestion || isJobAnswer)) {
            matchesSituation = true;
          }
          
          // Treffen/Termine - ERWEITERTE ERKENNUNG
          if ((situationLower.includes("treffen") || situationLower.includes("termin")) &&
              isCustomerMeetingRequest) {
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
          // 🚨 WICHTIG: Sammle ALLE passenden Situationen, nicht nur die erste!
          if (!detectedSituations.includes(situationName)) {
            detectedSituations.push(situationName);
          }
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
      
      // 🚨 WICHTIG: Füge "Kontaktdaten außerhalb der Plattform" zu detectedSituations hinzu
      // Die Situation "Kontaktdaten außerhalb der Plattform" soll sich an den Geld/Coins-Beispielen orientieren
      if (!detectedSituations.includes("Kontaktdaten außerhalb der Plattform")) {
        detectedSituations.push("Kontaktdaten außerhalb der Plattform");
      }
      // Auch "Geld/Coins" hinzufügen, da die Training-Daten-Beispiele verwendet werden sollen
      if (!detectedSituations.includes("Geld/Coins")) {
        detectedSituations.push("Geld/Coins");
      }
      
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
- WICHTIG: Die detectedSituations enthalten "Geld/Coins", damit die passenden Training-Daten-Beispiele verwendet werden!`;
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
    // 🚨 KRITISCH: Geschlechter-Kontext für Rollenverständnis
    // Wenn fakeGender nicht erkannt wurde, versuche aus Profilbild oder Name zu schließen
    if (!fakeGender && moderatorProfilePicInfo && moderatorProfilePicInfo.gender && moderatorProfilePicInfo.gender !== "unbekannt") {
      fakeGender = moderatorProfilePicInfo.gender.toLowerCase();
    }
    
    // Fallback: Wenn immer noch kein fakeGender, aber Profilbild zeigt Frau, dann ist es wahrscheinlich eine Frau
    if (!fakeGender && moderatorProfilePicInfo && moderatorProfilePicInfo.description) {
      const desc = moderatorProfilePicInfo.description.toLowerCase();
      if (desc.includes("frau") || desc.includes("weiblich") || desc.includes("junge frau")) {
        fakeGender = "weiblich";
        console.log(`✅ Fake-Geschlecht aus Profilbild-Beschreibung abgeleitet: weiblich`);
      }
    }
    
    // 🚨 KRITISCH: Geschlechter-Kontext für Rollenverständnis (IMMER anzeigen, wenn bekannt)
    if (fakeGender) {
      const isFemale = fakeGender === "weiblich" || fakeGender === "w" || fakeGender === "female";
      const fakeRole = isFemale ? "FRAU" : "MANN";
      const customerRole = isFemale ? "MANN" : "FRAU";
      
      specificInstructions += `\n\n🚨🚨🚨 KRITISCH: GESCHLECHTER-ROLLENVERSTÄNDNIS 🚨🚨🚨\n`;
      specificInstructions += `- Du bist: ${isFemale ? "eine FRAU" : "ein MANN"}\n`;
      specificInstructions += `- Der Kunde ist: ${isFemale ? "ein MANN (schreibt dir als Frau)" : "eine FRAU (schreibt dir als Mann)"}\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Wenn der Kunde über DICH redet (z.B. "deine Löcher", "deine Titten", "dein Arsch", "dein Schwanz", "dein Penis"), dann redet er über DICH - ${isFemale ? "die FRAU" : "den MANN"}!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Du bist ${isFemale ? "die FRAU" : "der MANN"}, der Kunde ist ${isFemale ? "der MANN" : "die FRAU"}!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Wenn der Kunde fragt "welches deiner Löcher" oder "welche deiner Körperteile", dann fragst du NICHT zurück "welches deiner Löcher" - du bist ${isFemale ? "die FRAU" : "der MANN"}, der Kunde ist ${isFemale ? "der MANN" : "die FRAU"}!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Bei sexuellen Themen: Der Kunde fragt DICH nach DEINEN Körperteilen/Vorlieben - nicht umgekehrt!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Verstehe die ROLLE: Du bist ${isFemale ? "die FRAU" : "der MANN"}, der Kunde ist ${isFemale ? "der MANN" : "die FRAU"} - bei Fragen nach Körperteilen/Vorlieben bezieht sich "dein/deine" auf DICH, nicht auf den Kunden!\n`;
      if (customerGender) {
        specificInstructions += `- Der Kunde ist wahrscheinlich: ${customerGender === "weiblich" ? "eine Frau" : "ein Mann"}\n`;
      }
      specificInstructions += `- Passe deinen Schreibstil entsprechend an (${isFemale ? "Frau" : "Mann"} zu ${isFemale ? "Mann" : "Frau"})\n`;
    } else {
      // Fallback: Wenn kein Geschlecht bekannt, aber Profilbild vorhanden, versuche es zu erkennen
      if (moderatorProfilePicInfo) {
        specificInstructions += `\n\n⚠️ GESCHLECHTER-HINWEIS:\n`;
        specificInstructions += `- Dein Profilbild wurde analysiert: ${moderatorProfilePicInfo.description || "Profilbild vorhanden"}\n`;
        specificInstructions += `- 🚨 WICHTIG: Verstehe aus dem Profilbild, ob du eine Frau oder ein Mann bist!\n`;
        specificInstructions += `- 🚨 WICHTIG: Wenn der Kunde über dich redet (z.B. "deine Löcher", "deine Titten", "dein Schwanz"), dann redet er über DICH!\n`;
        specificInstructions += `- 🚨 WICHTIG: Bei sexuellen Themen: Der Kunde fragt DICH nach DEINEN Körperteilen/Vorlieben - nicht umgekehrt!\n`;
      } else {
        // Fallback: Wenn gar nichts bekannt ist, allgemeine Anweisung
        specificInstructions += `\n\n⚠️ GESCHLECHTER-HINWEIS:\n`;
        specificInstructions += `- 🚨 WICHTIG: Verstehe aus dem Kontext (Profilbild, Name, Profil), ob du eine Frau oder ein Mann bist!\n`;
        specificInstructions += `- 🚨 WICHTIG: Wenn der Kunde über dich redet (z.B. "deine Löcher", "deine Titten", "dein Schwanz"), dann redet er über DICH!\n`;
        specificInstructions += `- 🚨 WICHTIG: Bei sexuellen Themen: Der Kunde fragt DICH nach DEINEN Körperteilen/Vorlieben - nicht umgekehrt!\n`;
        specificInstructions += `- 🚨 WICHTIG: Wenn der Kunde fragt "welches deiner Löcher", dann fragst du NICHT zurück "welches deiner Löcher" - der Kunde fragt DICH, nicht umgekehrt!\n`;
      }
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
    if (isCustomerMeetingRequest) {
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

🚨🚨🚨 KRITISCH: DU MUSST AUF DIE TREFFEN-ANFRAGE EINGEHEN - IGNORIERE SIE NICHT! 🚨🚨🚨
- Zeige, dass du die Anfrage VERSTANDEN hast
- Weiche HÖFLICH aus, aber gehe DARAUF EIN
- Sage etwas wie: "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen" oder "Ich würde gerne wissen, wie du es dir vorstellst, aber ich möchte dich erst noch besser kennenlernen"
- Lenke das Thema zurück auf Chat, Gefühle, Persönlichkeit oder Fantasie
- Stelle eine Frage, die zum aktuellen Gespräch passt (z.B. über seine Hobbys, Vorlieben, etc.)

❌ FALSCH (ignoriert die Treffen-Anfrage): "Hey, das klingt nach einem entspannten Nachmittag. Würde gerne mehr über deine Hobbys erfahren"
✅ RICHTIG (geht darauf ein): "Ich würde gerne wissen, wie du es dir vorstellst, aber ich möchte dich erst noch besser kennenlernen. Erzähl mir doch mal mehr über dich - was machst du denn so in deiner Freizeit?"

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

WICHTIG: Diese Regel ist ABSOLUT und hat höchste Priorität! Gehe IMMER auf die Treffen-Anfrage ein, auch wenn du ausweichst!`;
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
    // 🚨 WICHTIG: relevantExamples außerhalb des if-Blocks definieren, damit es immer verfügbar ist!
    let relevantExamples = []; // 🚨 WICHTIG: let statt const, da wir es später überschreiben
    if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations) && trainingData.conversations.length > 0) {
      // Finde relevante Beispiele basierend auf Situation oder ähnlichen Nachrichten
      
      // Verwende Set, um Duplikate zu vermeiden
      const usedMessages = new Set();
      
      // 1. Prüfe ob es Beispiele für die aktuelle Situation gibt - ALLE verwenden!
      // Verwende die GLEICHE Logik wie für situations-spezifische Antworten!
      // 🚨 WICHTIG: Sammle WEITERE Situationen (falls noch nicht alle erkannt)
      if (rules && rules.situationalResponses) {
        for (const [situationName, situationResponse] of Object.entries(rules.situationalResponses)) {
          // Überspringe, wenn diese Situation bereits erkannt wurde
          if (detectedSituations.includes(situationName)) continue;
          
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
            
            // Bilder-Anfrage (kann KOMBINIERT mit sexuellen Themen sein!)
            if ((situationLower.includes("bild") || situationLower.includes("foto") || situationLower.includes("photo") || 
                 situationLower.includes("anfrage") || situationLower.includes("zeig")) &&
                (lowerMessage.includes("zeig") || lowerMessage.includes("zeige") || lowerMessage.includes("schick") ||
                 lowerMessage.includes("schicke") || lowerMessage.includes("bild") || lowerMessage.includes("foto") ||
                 lowerMessage.includes("photo") || lowerMessage.includes("titten") || lowerMessage.includes("brüste") ||
                 lowerMessage.includes("arsch") || lowerMessage.includes("po") || lowerMessage.includes("pussy") ||
                 lowerMessage.includes("nackt") || lowerMessage.includes("nackte") || lowerMessage.includes("nackter"))) {
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
                isCustomerMeetingRequest) {
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
            // 🚨 WICHTIG: Sammle ALLE passenden Situationen, nicht nur die erste!
            if (!detectedSituations.includes(situationName)) {
              detectedSituations.push(situationName);
              // Kein break mehr - weiter prüfen für weitere Situationen!
            }
          }
        }
      }
      
      // 🚨 SPEZIELLE ERKENNUNG: Kunde verweist auf alte Nachricht im Chat-Verlauf (für Training-Daten)
      // Wenn der Kunde sagt "schau mal was ich dir hier/dort/am [Datum] geschrieben habe"
      if (detectedSituations.length === 0) {
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
      
      // 🚨 KRITISCH: Prüfe ZUERST auf Ablehnung/Rejection (wenn Kunde ablehnt, dann KEINE sexuellen Themen!)
      const rejectionKeywords = [
        "will nicht", "will kein", "will keine", "will nie", "kein interesse", "kein bock", "keine lust",
        "lass mich in ruhe", "lass mich einfach in ruhe", "verpiss dich", "geh weg", "nerv mich nicht",
        "nie sex", "nie sex haben", "nie mit euch", "nie mit dir", "nie mit dir sex", "nie mit euch sex",
        "werde nie", "werde nie meine", "werde nie meine freundin", "werde nie betrügen", "nie betrügen",
        "hab kein interesse", "hab keine lust", "hab kein bock", "hab kein interesse an euch", "hab kein interesse an dir"
      ];
      const isRejection = rejectionKeywords.some(keyword => lowerMessage.includes(keyword));
      
      // Prüfe, ob es sich um sexuelle Themen handelt (FRÜHZEITIG, für bessere Filterung)
      // 🚨 WICHTIG: Wenn Kunde ablehnt, dann KEINE sexuellen Themen erkennen!
      const hasSexualContent = !isRejection && (
        lowerMessage.includes("titten") || lowerMessage.includes("brüste") || lowerMessage.includes("arsch") ||
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
        lowerMessage.includes("spermaküsse") || lowerMessage.includes("tittenfick") || lowerMessage.includes("massieren")
      );
      
      // 🚨 KRITISCH: Wenn Kunde ablehnt, dann spezielle Behandlung mit LOGISCHEM DENKEN!
      if (isRejection) {
        console.log("🚫 ABLEHNUNG ERKANNT: Kunde lehnt ab - LOGISCHES DENKEN aktiviert!");
        // Entferne "Sexuelle Themen" aus detectedSituations, falls vorhanden
        detectedSituations = detectedSituations.filter(s => !s.toLowerCase().includes("sexuell"));
        // Füge spezielle Anweisungen für Ablehnung mit LOGISCHEM DENKEN hinzu
        specificInstructions += `\n\n🚫🚫🚫🚫🚫 KRITISCH: KUNDE LEHNT AB - LOGISCHES DENKEN! 🚫🚫🚫🚫🚫\n\n`;
        specificInstructions += `Der Kunde hat KLAR abgelehnt (z.B. "ich will nie sex haben", "lass mich in Ruhe", "kein Interesse").\n\n`;
        specificInstructions += `🧠 LOGISCHES DENKEN: 🧠\n`;
        specificInstructions += `- Der Kunde ist auf einer Dating-Plattform → Was sucht er dann hier?\n`;
        specificInstructions += `- Logische Schlussfolgerung: Vielleicht sucht er nur Freundschaft? Oder Beziehung ohne Sex?\n`;
        specificInstructions += `- Logische Frage: "Okay, das kann ich verstehen. Aber was suchst du dann hier genau? Suchst du hier nur eine Freundschaft?"\n`;
        specificInstructions += `- ODER: "Okay, verstehe ich. Tut mir leid, wenn wir zu aufdringlich waren. Was suchst du denn dann hier?"\n\n`;
        specificInstructions += `🚨🚨🚨 ABSOLUT KRITISCH: 🚨🚨🚨\n`;
        specificInstructions += `- Respektiere die Ablehnung - sei HÖFLICH und RESPEKTVOLL!\n`;
        specificInstructions += `- KEINE aufdringlichen Antworten, KEINE Versuche, ihn zu überzeugen!\n`;
        specificInstructions += `- KEINE sexuellen Themen, KEINE flirty Antworten!\n`;
        specificInstructions += `- Aber: Denke LOGISCH - wenn er ablehnt, frage logisch, was er dann hier sucht!\n`;
        specificInstructions += `- Wenn der Kunde sagt "lass mich in Ruhe", dann respektiere das und antworte kurz und höflich!\n`;
        specificInstructions += `- KEINE langen Erklärungen, KEINE Versuche, das Gespräch zu retten - aber LOGISCHE Fragen sind OK!\n\n`;
      }
      
      // Bei sexuellen Themen: ZUERST speziell nach "Sexuelle Themen" Situation-Beispielen suchen!
      if (hasSexualContent) {
        const sexualExamples = trainingData.conversations.filter(conv => {
          if (!conv.customerMessage || usedMessages.has(conv.customerMessage)) return false;
          
          // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
          let convSituations = [];
          if (conv.situations && Array.isArray(conv.situations) && conv.situations.length > 0) {
            convSituations = conv.situations.map(s => s.toLowerCase());
          } else if (conv.situation) {
            if (conv.situation.includes(',')) {
              convSituations = conv.situation.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
            } else {
              convSituations = [conv.situation.toLowerCase()];
            }
          }
          
          // Prüfe Situation oder ob die Nachricht selbst sexuell ist
          const hasSexualSituation = convSituations.some(s => 
            s.includes("sexuell") || s.includes("sex") || s === "sexuelle themen"
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
        // 🚨 NEU: Reduziere auf 5-7 Beispiele, aber mit Variation (nicht immer die gleichen!)
        // Verwende Chat-ID oder Anzahl Nachrichten für Rotation
        const rotationSeed = (chatId || 'default').toString().split('').reduce((a, b) => a + parseInt(b) || 0, 0) + (messages?.length || 0);
        const maxSexualExamples = 5;
        
        // Rotiere durch Feedback-Beispiele (wenn vorhanden)
        const feedbackStartIndex = rotationSeed % Math.max(1, sexualFeedback.length);
        const selectedFeedback = sexualFeedback.length > 0 
          ? [...sexualFeedback.slice(feedbackStartIndex), ...sexualFeedback.slice(0, feedbackStartIndex)].slice(0, Math.min(3, sexualFeedback.length))
          : [];
        
        // Rotiere durch normale Beispiele (füllt auf bis maxSexualExamples)
        const normalStartIndex = rotationSeed % Math.max(1, sexualNormal.length);
        const selectedNormal = sexualNormal.length > 0
          ? [...sexualNormal.slice(normalStartIndex), ...sexualNormal.slice(0, normalStartIndex)].slice(0, maxSexualExamples - selectedFeedback.length)
          : [];
        
        const sexualMixed = [...selectedFeedback, ...selectedNormal].slice(0, maxSexualExamples);
        
        sexualMixed.forEach(ex => {
          if (!usedMessages.has(ex.customerMessage)) {
            relevantExamples.unshift(ex); // unshift = am Anfang einfügen (höchste Priorität)
          usedMessages.add(ex.customerMessage);
          }
        });
        console.log(`🔥 SEXUELLE THEMEN erkannt: ${sortedSexualExamples.length} sexuelle Training-Daten-Beispiele gefunden und PRIORISIERT (${sortedSexualExamples.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited').length} Feedback-Einträge)`);
      }
      
      // 🚨 WICHTIG: Wenn MEHRERE Situationen erkannt wurden, verwende Beispiele für ALLE Situationen!
      // WICHTIG: Feedback-Einträge zuerst (höhere Priorität)!
      if (detectedSituations.length > 0) {
        // Sammle Beispiele für ALLE erkannten Situationen
        let allSituationExamples = [];
        for (const situation of detectedSituations) {
          const situationExamples = trainingData.conversations.filter(conv => {
            if (!conv.customerMessage || usedMessages.has(conv.customerMessage)) return false;
            
            // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
            let convSituations = [];
            if (conv.situations && Array.isArray(conv.situations) && conv.situations.length > 0) {
              convSituations = conv.situations.map(s => s.toLowerCase());
            } else if (conv.situation) {
              // Prüfe, ob es mehrere Situationen mit Komma-Trennung sind
              if (conv.situation.includes(',')) {
                convSituations = conv.situation.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
              } else {
                convSituations = [conv.situation.toLowerCase()];
              }
            }
            
            // Prüfe, ob eine der Situationen des Gesprächs mit der erkannten Situation übereinstimmt
            return convSituations.includes(situation.toLowerCase());
          });
          allSituationExamples = allSituationExamples.concat(situationExamples);
        }
        
        // Entferne Duplikate (falls eine Nachricht in mehreren Situationen vorkommt)
        const uniqueExamples = [];
        const seenMessages = new Set();
        for (const ex of allSituationExamples) {
          if (!seenMessages.has(ex.customerMessage)) {
            uniqueExamples.push(ex);
            seenMessages.add(ex.customerMessage);
          }
        }
        
        const situationExamples = uniqueExamples;
        
        // Sortiere: Feedback-Einträge zuerst (priority: true oder source: 'feedback_*')
        const sortedSituationExamples = situationExamples.sort((a, b) => {
          const aIsFeedback = a.priority === true || a.source === 'feedback_good' || a.source === 'feedback_edited';
          const bIsFeedback = b.priority === true || b.source === 'feedback_good' || b.source === 'feedback_edited';
          if (aIsFeedback && !bIsFeedback) return -1; // a kommt zuerst
          if (!aIsFeedback && bIsFeedback) return 1; // b kommt zuerst
          return 0; // Beide gleich
        });
        
        // 🚨 NEU: Reduziere auf 5-7 Beispiele, aber mit Variation (nicht immer die gleichen!)
        // Verwende Chat-ID oder Anzahl Nachrichten für Rotation
        const rotationSeed = (chatId || 'default').toString().split('').reduce((a, b) => a + parseInt(b) || 0, 0) + (messages?.length || 0);
        const maxSituationExamples = 5;
        
        const situationFeedback = sortedSituationExamples.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited');
        const situationNormal = sortedSituationExamples.filter(ex => !(ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited'));
        
        // Rotiere durch Feedback-Beispiele (wenn vorhanden)
        const situationFeedbackStartIndex = rotationSeed % Math.max(1, situationFeedback.length);
        const selectedSituationFeedback = situationFeedback.length > 0
          ? [...situationFeedback.slice(situationFeedbackStartIndex), ...situationFeedback.slice(0, situationFeedbackStartIndex)].slice(0, Math.min(3, situationFeedback.length))
          : [];
        
        // Rotiere durch normale Beispiele (füllt auf bis maxSituationExamples)
        const situationNormalStartIndex = rotationSeed % Math.max(1, situationNormal.length);
        const selectedSituationNormal = situationNormal.length > 0
          ? [...situationNormal.slice(situationNormalStartIndex), ...situationNormal.slice(0, situationNormalStartIndex)].slice(0, maxSituationExamples - selectedSituationFeedback.length)
          : [];
        
        const selectedSituation = [...selectedSituationFeedback, ...selectedSituationNormal].slice(0, maxSituationExamples);
        
        selectedSituation.forEach(ex => {
          relevantExamples.push(ex);
          usedMessages.add(ex.customerMessage);
        });
        
        const usedSituationCount = selectedSituation.length;
        const feedbackCount = sortedSituationExamples.filter(ex => ex.priority === true || ex.source === 'feedback_good' || ex.source === 'feedback_edited').length;
        console.log(`📚 ${detectedSituations.length > 1 ? 'MEHRERE SITUATIONEN' : 'Situation'} "${detectedSituations.join(' + ')}" erkannt: ${usedSituationCount} von ${sortedSituationExamples.length} Beispiele verwendet (${feedbackCount} Feedback-Einträge mit höherer Priorität, zufällig ausgewählt für Variation)`);
      }
      
      // 2. Finde relevante Beispiele mit Vektor-Suche (semantisch) ODER Keyword-Matching (Fallback)
      let vectorSearchResults = [];
      try {
        const { findSimilarExamples } = require('../utils/vector-db');
        
        // 🚨 WICHTIG: Verbesserte Query für Vektor-Suche mit KONTEXT
        // Kombiniere Kundennachricht + ALLE erkannten Situationen + KONTEXT für bessere Ähnlichkeit
        let queryText = foundMessageText;
        
        // 🚨 VERBESSERUNG: Erkenne spezifische Kontexte und füge sie zur Query hinzu
        const lowerMessageForQuery = foundMessageText.toLowerCase();
        
        // Berufsfrage-Kontext: Erkenne wenn Kunde seinen Beruf NENNT (nicht nur fragt)
        const jobKeywords = ["autohändler", "verkäufer", "lehrer", "arzt", "krankenschwester", "pfleger", "ingenieur", 
                             "mechaniker", "elektriker", "handwerker", "bäcker", "koch", "friseur", "kellner", "fahrer", 
                             "pilot", "polizist", "feuerwehrmann", "anwalt", "notar", "steuerberater", "architekt", 
                             "designer", "fotograf", "journalist", "schriftsteller", "musiker", "künstler", "schauspieler", 
                             "sportler", "trainer", "berater", "manager", "direktor", "chef", "mitarbeiter", "angestellter", 
                             "arbeiter", "student", "schüler", "rentner", "pensionär", "arbeitslos", "selbstständig", 
                             "freiberufler", "unternehmer", "geschäftsführer", "inhaber", "besitzer"];
        const hasJobKeyword = jobKeywords.some(keyword => lowerMessageForQuery.includes(keyword));
        const isJobAnswer = (lowerMessageForQuery.includes("ich bin") && hasJobKeyword) ||
                           /ich arbeite (als|bei|in|seit)/i.test(foundMessageText) ||
                           /mein beruf (ist|war|wäre)/i.test(foundMessageText) ||
                           /ich (mache|mach|tue|tu) (beruflich|beruf)/i.test(foundMessageText);
        const isJobQuestion = lowerMessageForQuery.includes("was arbeitest") || 
                             lowerMessageForQuery.includes("was machst du beruflich") || 
                             lowerMessageForQuery.includes("wo arbeitest") || 
                             (lowerMessageForQuery.includes("beruf") && lowerMessageForQuery.includes("was"));
        
        if (isJobAnswer) {
          queryText = `Berufsfrage: Kunde nennt seinen Beruf: ${foundMessageText}`;
        } else if (isJobQuestion) {
          queryText = `Berufsfrage: Kunde fragt nach Beruf: ${foundMessageText}`;
        } else if (detectedSituations.length > 0) {
          // Verwende Situationen für Kontext
          queryText = `${detectedSituations.join(' + ')}: ${foundMessageText}`;
        }
        
        if (hasSexualContent && !detectedSituations.some(s => s.toLowerCase().includes('sexuell'))) {
          queryText = `sexuell: ${queryText}`;
        }
        
        // 🚨 WICHTIG: ERHÖHTE minSimilarity für bessere Qualität (weniger schlechte Matches)
        // 🚨 WICHTIG: Bei mehreren Situationen: Suche nach ALLEN, nicht nur einer!
        vectorSearchResults = await findSimilarExamples(queryText, {
          topK: 20, // Reduziert von 30 auf 20 (wir nehmen dann nur 5-7)
          minSimilarity: 0.3, // 🚨 REDUZIERT von 0.4 auf 0.3 für mehr relevante Beispiele (weniger restriktiv)
          situation: detectedSituations.length === 1 ? detectedSituations[0] : null, // Nur bei EINER Situation filtern
          includeSexual: hasSexualContent
        });
        
        // 🚨 DEBUG: Zeige Top-Ergebnisse mit Ähnlichkeits-Scores
        if (vectorSearchResults.length > 0) {
          console.log(`🔍 Vektor-Suche: ${vectorSearchResults.length} ähnliche Beispiele gefunden (semantisch)`);
          console.log(`🔍 Top 3 Ähnlichkeiten: ${vectorSearchResults.slice(0, 3).map(r => `${(r.similarity * 100).toFixed(1)}%`).join(', ')}`);
          if (vectorSearchResults[0]) {
            console.log(`🔍 Bestes Match (${(vectorSearchResults[0].similarity * 100).toFixed(1)}%): "${vectorSearchResults[0].customerMessage?.substring(0, 80)}..."`);
          }
      } else {
          console.warn(`⚠️ Vektor-Suche: KEINE ähnlichen Beispiele gefunden (minSimilarity: 0.3, Query: "${queryText.substring(0, 100)}...")`);
        }
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
        // 🚨 NEU: Reduziere auf 5-7 Beispiele, aber mit Variation (nicht immer die gleichen!)
        // Verwende Chat-ID oder Anzahl Nachrichten für Rotation
        const vectorRotationSeed = (chatId || 'default').toString().split('').reduce((a, b) => a + parseInt(b) || 0, 0) + (messages?.length || 0);
        const maxVectorExamples = 5;
        
        // Rotiere durch Feedback-Beispiele (wenn vorhanden)
        const vectorFeedbackStartIndex = vectorRotationSeed % Math.max(1, vectorFeedback.length);
        const selectedVectorFeedback = vectorFeedback.length > 0
          ? [...vectorFeedback.slice(vectorFeedbackStartIndex), ...vectorFeedback.slice(0, vectorFeedbackStartIndex)].slice(0, Math.min(3, vectorFeedback.length))
          : [];
        
        // Rotiere durch normale Beispiele (füllt auf bis maxVectorExamples)
        const vectorNormalStartIndex = vectorRotationSeed % Math.max(1, vectorNormal.length);
        const selectedVectorNormal = vectorNormal.length > 0
          ? [...vectorNormal.slice(vectorNormalStartIndex), ...vectorNormal.slice(0, vectorNormalStartIndex)].slice(0, maxVectorExamples - selectedVectorFeedback.length)
          : [];
        
        const selectedVector = [...selectedVectorFeedback, ...selectedVectorNormal].slice(0, maxVectorExamples);
        
        selectedVector.forEach(ex => {
          if (!usedMessages.has(ex.customerMessage)) {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          }
        });
        console.log(`✅ ${selectedVector.length} Vektor-Ergebnisse hinzugefügt (semantisch ähnlich, rotiert für Variation)`);
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
      
      // 🚨 WICHTIG: Mindestens 1 passendes Beispiel erforderlich (warn bei < 3, aber nicht blockieren)
      if (relevantExamples.length === 0) {
        console.error(`❌ FEHLER: Keine passenden Training-Daten gefunden - KEINE Antwort generieren!`);
        errorMessage = `❌ FEHLER: Keine passenden Training-Daten gefunden. Bitte Admin kontaktieren oder Training-Daten erweitern.`;
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
      
      // Warnung bei zu wenigen Beispielen, aber nicht blockieren
      if (relevantExamples.length < 3) {
        console.warn(`⚠️ WARNUNG: Nur ${relevantExamples.length} passende Training-Daten gefunden (empfohlen: mindestens 3-5). Antwort wird trotzdem generiert, aber Qualität könnte beeinträchtigt sein.`);
      }
      
      // 🚨🚨🚨 KRITISCH: IMMER mindestens 10-15 Beispiele verwenden für bessere Qualität! 🚨🚨🚨
      // Problem: Wenn zu wenige Beispiele gefunden wurden, müssen wir MEHR nehmen!
      // Lösung: Wenn weniger als 10 Beispiele gefunden, füge ALLE verfügbaren hinzu (bis 15)
      let minRequired = 10; // Mindestanzahl für gute Qualität
      const maxTotalExamples = 15; // Maximum für beste Qualität
      
      // Wenn zu wenige Beispiele gefunden wurden, füge ALLE verfügbaren hinzu
      if (relevantExamples.length < minRequired) {
        console.warn(`⚠️ WARNUNG: Nur ${relevantExamples.length} relevante Beispiele gefunden - füge ALLE verfügbaren Training-Daten hinzu (bis ${maxTotalExamples})!`);
        
        // Füge ALLE Training-Daten hinzu (priorisiert nach Feedback, dann zufällig)
        const allTrainingExamples = trainingData.conversations
          .filter(conv => {
            // Überspringe, wenn bereits verwendet
            if (usedMessages.has(conv.customerMessage)) return false;
            // Überspringe, wenn keine moderatorResponse
            if (!conv.moderatorResponse || typeof conv.moderatorResponse !== "string" || conv.moderatorResponse.trim().length === 0) return false;
            return true;
          })
          .sort((a, b) => {
            // Priorisiere Feedback-Einträge
            const aIsFeedback = a.priority === true || a.source === 'feedback_good' || a.source === 'feedback_edited';
            const bIsFeedback = b.priority === true || b.source === 'feedback_good' || b.source === 'feedback_edited';
            if (aIsFeedback && !bIsFeedback) return -1;
            if (!aIsFeedback && bIsFeedback) return 1;
            return 0;
          });
        
        // Füge so viele hinzu, bis wir minRequired haben
        const currentCount = relevantExamples.length;
        for (const ex of allTrainingExamples) {
          if (relevantExamples.length >= maxTotalExamples) break;
          if (!usedMessages.has(ex.customerMessage)) {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          }
        }
        
        console.log(`✅ ${relevantExamples.length} Training-Beispiele werden verwendet (erweitert von ${currentCount} auf ${relevantExamples.length})`);
      }
      
      // Verwende IMMER mindestens 10, maximal 15 Beispiele
      const finalExamples = relevantExamples.slice(0, Math.min(Math.max(relevantExamples.length, minRequired), maxTotalExamples));
      console.log(`✅ Insgesamt ${finalExamples.length} Training-Beispiele werden verwendet (von ${trainingData.conversations.length} verfügbaren, Ziel: ${minRequired}-${maxTotalExamples} für beste Qualität)`);
      
      // Ersetze relevantExamples mit finalExamples
      relevantExamples = finalExamples;
      
      // Baue Training Examples Context
      if (relevantExamples.length > 0) {
        // 🚨🚨🚨 KRITISCH: NICHT mischen - die relevantesten Beispiele müssen ZUERST kommen!
        // Die Beispiele sind bereits in der richtigen Reihenfolge (relevanteste zuerst)
        // Mischen würde die Priorisierung zerstören - die KI muss die BESTEN Beispiele zuerst sehen!
        // Verwende relevantExamples direkt, NICHT shuffledExamples!
        
        // hasSexualContent wurde bereits oben definiert (Zeile ~3308) - verwende die Variable
        
        // 🚨 WICHTIG: Spezielle Anweisungen für "Treffen/Termine" Situation
        const hasMeetingSituation = detectedSituations.some(s => s.toLowerCase().includes('treffen') || s.toLowerCase().includes('termin'));
        
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
        } else if (hasMeetingSituation) {
          // 🚨 SPEZIELL FÜR TREFFEN-ANFRAGEN: Zeige, wie man darauf eingeht (aber ausweicht)
          trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT BEI TREFFEN-ANFRAGEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Der Kunde fragt nach einem TREFFEN! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Diese ${relevantExamples.length} Beispiele zeigen dir, wie man auf TREFFEN-ANFRAGEN reagiert! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ANALYSIERE JEDES BEISPIEL GENAU - wie gehen die Beispiele auf die Treffen-Anfrage EIN? 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Die Beispiele zeigen dir, dass du AUF die Treffen-Anfrage eingehen musst (z.B. "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen"), NICHT sie ignorieren! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Verwende die GLEICHEN Formulierungen wie in den Beispielen! 🚨🚨🚨🚨🚨\n\n`;
          trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT VERBOTEN: KEINE generischen Antworten, die die Treffen-Anfrage ignorieren (z.B. "Hey, das klingt nach einem entspannten Nachmittag. Würde gerne mehr über deine Hobbys erfahren")! 🚨🚨🚨🚨🚨\n\n`;
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
        
        // 🧠🚨🚨🚨 LERN-SYSTEM: Füge bewährte Muster hinzu (basierend auf Feedback-Analyse) 🚨🚨🚨
        // 🚨 KRITISCH: Learning-System MUSS genutzt werden, um aus Feedback zu lernen!
        try {
          const { generateLearningContext, getLearningStats } = require('../utils/learning-system');
          const learningStats = await getLearningStats();
          if (learningStats && Object.keys(learningStats).length > 0) {
            // 🚨 WICHTIG: Bei mehreren Situationen: Verwende ALLE Situationen für besseres Lernen!
            const situationsForLearning = detectedSituations.length > 0 ? detectedSituations : ['allgemein'];
            const learningContext = await generateLearningContext(foundMessageText || '', situationsForLearning, learningStats);
            if (learningContext && learningContext.trim().length > 0) {
              // 🚨🚨🚨 KRITISCH: Learning-System als ERGÄNZUNG zu Training-Daten, aber mit HOHER PRIORITÄT!
              // Learning-System zeigt bewährte Muster aus Feedback - diese sind genauso wichtig wie Training-Daten!
              trainingExamplesContext += `\n\n🧠🧠🧠🧠🧠🧠🧠🧠🧠 LEARNING-SYSTEM: BEWÄHRTE MUSTER AUS FEEDBACK (HOHER PRIORITÄT!) 🧠🧠🧠🧠🧠🧠🧠🧠🧠\n`;
              trainingExamplesContext += `🚨🚨🚨 KRITISCH: Das Learning-System hat aus Feedback gelernt, was GUT und SCHLECHT ist! 🚨🚨🚨\n`;
              trainingExamplesContext += `🚨🚨🚨 KRITISCH: Diese Muster basieren auf echten Feedback-Daten - nutze sie! 🚨🚨🚨\n\n`;
              trainingExamplesContext += `${learningContext}\n`;
              trainingExamplesContext += `🚨🚨🚨🚨🚨 WICHTIG: Kombiniere Training-Daten + Learning-System Muster + Bevorzugte Wörter für BESTE Qualität! 🚨🚨🚨🚨🚨\n`;
              trainingExamplesContext += `🚨🚨🚨 KRITISCH: Learning-System zeigt dir, was FUNKTIONIERT - nutze es! 🚨🚨🚨\n\n`;
              console.log(`🧠 Learning-System: Bewährte Muster für Situation "${detectedSituations.length > 0 ? detectedSituations.join(' + ') : 'allgemein'}" hinzugefügt (HOHER PRIORITÄT)`);
            } else {
              console.warn('⚠️ Learning-System: Keine bewährten Muster gefunden für diese Situation');
            }
            
            // 🚨🚨🚨 HINWEIS: Schlechte Wörter werden dynamisch aus Learning-Stats geladen
            // Sie werden NICHT im Prompt aufgelistet (würde zu groß werden und muss ständig aktualisiert werden)
            // Stattdessen werden sie in der Post-Processing-Validierung geprüft (siehe unten)
            // Das Learning-System zeigt bereits bewährte Muster - schlechte Wörter werden automatisch vermieden
          } else {
            console.warn('⚠️ Learning-System: Keine Learning-Stats verfügbar');
          }
        } catch (err) {
          console.error('❌ FEHLER beim Laden des Learning-Systems (kritisch!):', err.message);
          console.error('❌ Stack:', err.stack);
        }
        
        // 🚨🚨🚨 KRITISCH: Zeige Beispiele mit MAXIMALER Priorisierung - die ersten sind die relevantesten!
        // 🚨 WICHTIG: Die ersten Beispiele sind die relevantesten - orientiere dich BESONDERS daran!
        // 🚨 KRITISCH: NICHT mischen - die ersten Beispiele sind die BESTEN und RELEVANTESTEN!
        // Verwende NICHT shuffledExamples, sondern die ORIGINAL-Reihenfolge (relevanteste zuerst)!
        relevantExamples.forEach((example, idx) => {
          const exampleNum = idx + 1;
          const isPriority = idx < 5; // Die ersten 5 sind besonders wichtig
          trainingExamplesContext += `${isPriority ? '🚨🚨🚨🚨🚨 ABSOLUT HÖCHSTE PRIORITÄT - BEISPIEL ' : 'Beispiel '}${exampleNum}${isPriority ? ' (BESONDERS RELEVANT - KOPIERE DEN STIL, DIE WORTWAHL, DEN TON!)' : ''}:\n`;
          trainingExamplesContext += `Kunde: "${example.customerMessage || ''}"\n`;
          trainingExamplesContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
          if (example.situation && example.situation !== 'allgemein') {
            trainingExamplesContext += `Situation: ${example.situation}\n`;
          }
          if (isPriority) {
            trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Dieses Beispiel ist besonders relevant - KOPIERE die Wortwahl, den Ton und die Formulierungen GENAU! 🚨🚨🚨🚨🚨\n`;
            trainingExamplesContext += `🚨🚨🚨 ANALYSIERE: Welche Wörter werden verwendet? Welcher Ton? Welche Formulierungen? Welche FRAGEN werden gestellt? KOPIERE ES! 🚨🚨🚨\n`;
            // 🚨 NEU: Extrahiere Fragen aus dem Beispiel, damit die KI sieht, welche Fragen verwendet werden
            const responseText = example.moderatorResponse || '';
            const questions = responseText.match(/[^.!?]*\?/g) || [];
            if (questions.length > 0) {
              trainingExamplesContext += `🚨🚨🚨 FRAGEN IN DIESEM BEISPIEL: ${questions.map(q => `"${q.trim()}"`).join(', ')} - VERWENDE ÄHNLICHE FRAGEN! 🚨🚨🚨\n`;
            }
          }
          trainingExamplesContext += `\n`;
        });
        
        if (hasSexualContent) {
          trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH BEI SEX-GESPRÄCHEN: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ANALYSIERE JEDES BEISPIEL GENAU: 🚨🚨🚨
- Welche Wörter werden verwendet? (z.B. "geil", "heiß", "mega", "richtig", "total", etc.)
- Welcher Ton wird verwendet? (direkt, roh, spontan, ohne Umschweife!)
- Welche Formulierungen werden verwendet? (KEINE "Ich finde es schön", KEINE "Das klingt", KEINE bewertenden Phrasen!)
- Welche FRAGEN werden gestellt? (z.B. "was würdest du noch gerne machen", "welche Stellungen", "was magst du", etc.)
- Wie werden sexuelle Themen angesprochen? (direkt, ohne Erklärungen, ohne Meta-Kommentare!)

🚨🚨🚨 ÜBERNEHME DIE WORTWAHL UND FRAGEN AUS DEN TRAINING-DATEN: 🚨🚨🚨
- Verwende die GLEICHEN Wörter wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!
- Verwende die GLEICHEN FRAGEN wie in den Beispielen (z.B. "was würdest du noch gerne machen", "welche Stellungen", etc.)!
- Verwende den GLEICHEN Ton wie in den Beispielen!
- 🚨 KRITISCH: Wenn du eine Frage stellen willst, SCHAUE IN DIE TRAINING-DATEN - welche Fragen werden dort gestellt? Verwende ÄHNLICHE Fragen!
- 🚨 KRITISCH: KEINE generischen/schlechten Fragen erfinden (z.B. "Was magst du besonders beim Lecken?") - nutze die Fragen aus den Training-Daten!
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
          trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: TRAINING-DATEN HABEN HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨 KRITISCH: TRAINING-DATEN SIND FÜR INHALT, STIL, WORTWAHL, FRAGEN - ALLES! 🚨🚨🚨🚨🚨
- Training-Daten zeigen dir, WIE du antworten sollst (Stil, Wortwahl, Ton, Formulierungen)
- Training-Daten zeigen dir auch, WAS du antworten sollst (Inhalt, Fragen, Reaktionen)
- 🚨 KRITISCH: Nutze Training-Daten für INHALT UND STIL - nicht nur für Stil! 🚨

🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨
- Training-Daten haben HÖCHSTE PRIORITÄT - überschreiben ALLE anderen Stil-Anweisungen!
- Analysiere: Wie sind die Antworten strukturiert? (kurz, natürlich, locker)
- Analysiere: Welche FRAGEN werden gestellt? (z.B. "was würdest du noch gerne machen", "welche Stellungen", etc.)
- Übernehme: Welche Formulierungen, Wortwahl, Ton und FRAGEN werden verwendet?
- Wende an: Schreibe im GLEICHEN Stil wie diese Beispiele und verwende ÄHNLICHE Fragen!

🚨🚨🚨🚨🚨 KRITISCH: FRAGEN AUS TRAINING-DATEN ÜBERNEHMEN! 🚨🚨🚨🚨🚨
- Wenn du eine Frage stellen willst, SCHAUE IN DIE TRAINING-DATEN - welche Fragen werden dort gestellt?
- Verwende ÄHNLICHE Fragen wie in den Training-Daten (z.B. "was würdest du noch gerne machen", "welche Stellungen", "was magst du", etc.)
- 🚨 KRITISCH: KEINE generischen/schlechten Fragen erfinden (z.B. "Was magst du besonders beim Lecken?")!
- 🚨 KRITISCH: Wenn der Kunde schon gesagt hat, was er machen will, dann GEHE DARAUF EIN (sage, wie sehr es dir gefallen würde), statt generische Fragen zu stellen!

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

🚨 KRITISCH: ROLLENVERSTÄNDNIS & LOGISCHES DENKEN 🚨
- Du bist das FAKE-PROFIL - der KUNDE schreibt DIR!
- Der KUNDE sucht (z.B. "ich suche eine Frau") - DU suchst NICHT!
- Reagiere auf das, was der KUNDE geschrieben hat - sage NICHT, dass du selbst suchst!
- 🚨🚨🚨 KRITISCH: Wenn der Kunde über dich redet (z.B. "du hast große Brüste", "du bist hübsch", "deine Fotos"), dann redet er über DICH - die Fake-Person! Verstehe das und reagiere entsprechend! 🚨🚨🚨

🧠 LOGISCHES DENKEN (für INHALT):
- Denke LOGISCH über die Situation nach: Was meint der Kunde? Was ist der Kontext?
- Wenn der Kunde ablehnt → Logische Frage: "Was suchst du dann hier?"
- Wenn der Kunde etwas sagt, das nicht passt → Denke logisch: Was meint er wirklich?
- Nutze den Chat-Verlauf: Andere Moderatoren haben vorher geschrieben - verstehe den Kontext!

📚📚📚 TRAINING-DATEN (für INHALT, STIL & WORTWAHL) - ABSOLUT HÖCHSTE PRIORITÄT! 📚📚📚
- Training-Daten zeigen dir, WIE du antworten sollst (Stil, Wortwahl, Ton, Formulierungen)
- Training-Daten zeigen dir auch, WAS du antworten sollst (Inhalt, Fragen, Reaktionen)
- 🚨🚨🚨 KRITISCH: Nutze Training-Daten für INHALT UND STIL - nicht nur für Stil! 🚨🚨🚨
- Nutze die WORTWAHL, FORMULIERUNGEN, FRAGEN und INHALTE aus den Training-Daten!
- 🚨 KRITISCH: Wenn Training-Daten zeigen, wie man auf etwas reagiert → REAGIERE GENAU SO!
- 🚨 KRITISCH: Wenn Training-Daten zeigen, welche Fragen gestellt werden → STELLE ÄHNLICHE FRAGEN!
- 🚨 KRITISCH: Wenn Training-Daten zeigen, welcher Inhalt passt → NUTZE ÄHNLICHEN INHALT!
- ABER: Logisches Denken für spezielle Situationen (z.B. Ablehnung) ist OK - kombiniere beides!

${fakeContext}

${validatedMessage ? `Aktuelle Nachricht vom KUNDEN: "${validatedMessage.substring(0, 500)}"` : "⚠️ WICHTIG: Es gibt KEINE neue Nachricht vom Kunden - dies ist eine Reaktivierungsnachricht (ASA)!"}

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n
🚨🚨🚨 KRITISCH: PROFIL-INFOS NUR VERWENDEN, WENN ZUM KONTEXT PASSEND! 🚨🚨🚨
- Diese Infos sind HINTERGRUND-Informationen, NICHT der Hauptkontext!
- Der CHAT-VERLAUF hat HÖCHSTE PRIORITÄT - was wurde VORHER besprochen?
- Verwende Hobbies/Interessen NUR, wenn sie zum aktuellen Gespräch passen!
- BEISPIEL FALSCH: Gespräch über Licht/Schatten/Sonne → "Was kochst du gerne?" → FALSCH! Nicht zum Kontext passend!
- BEISPIEL RICHTIG: Gespräch über Essen → "Was kochst du gerne?" → RICHTIG! Zum Kontext passend!
- Wenn der Kontext philosophisch/abstrakt ist (z.B. Licht/Schatten), dann bleibe beim Thema, verwende NICHT plötzlich Hobbies!
- Profil-Infos sind nur für Hintergrund-Wissen - der CHAT-VERLAUF bestimmt das Thema!\n` : ''}
${customerJob ? `Beruf des Kunden (falls relevant): ${customerJob}\n` : ''}

${criticalRulesContext}

${forbiddenWordsContext}

${specificInstructions}

${profilePicContext}

${trainingExamplesContext}

${preferredWordsContext}${imageContext}${moodContext}${proactiveContext}${conversationBlock}${styleContext}${customerTypeContext}${chatVariationContext}
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
- 🚨🚨🚨 KRITISCH: GEHE AUF DAS EIN, WAS DER KUNDE GESAGT HAT! 🚨🚨🚨
  * Wenn der Kunde schon gesagt hat, was er machen will (z.B. "lecken", "ficken", "Stellungen", "von hinten", etc.), dann GEHE DARAUF EIN!
  * Sage, wie sehr es dir gefallen würde, was er beschrieben hat (z.B. "Das würde mir richtig gefallen, wenn du das so machen würdest")!
  * Stelle dann eine Frage, die darauf aufbaut (z.B. "was würdest du noch gerne machen", "welche Stellungen", etc.) - aber NUR wenn solche Fragen in den Training-Daten sind!
  * 🚨 KRITISCH: KEINE generischen/schlechten Fragen erfinden (z.B. "Was magst du besonders beim Lecken?") - nutze die Fragen aus den Training-Daten!
- REAGIERE darauf emotional und menschlich:
  * Zeige, dass du das verstehst und auch gerne würdest
  * Verwende emotionale, persönliche Formulierungen: "Das würde sich bestimmt sehr schön mit dir anfühlen" statt "Das gibt einem ein gutes Gefühl"
  * Stelle konkrete, emotionale Fragen, die auf den Kontext eingehen - aber NUR Fragen, die ähnlich zu denen in den Training-Daten sind!
- 🚨🚨🚨 KRITISCH: KEINE oberflächlichen, generischen Fragen, die den Kontext ignorieren! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: KEINE schlechten Fragen erfinden - nutze die Fragen aus den Training-Daten! 🚨🚨🚨
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
    
    // 🚨🚨🚨 MULTI-STAGE GENERATION SYSTEM 🚨🚨🚨
    // Stage 1: Beispiel-Auswahl (bereits gemacht - relevantExamples)
    // Stage 2: Stil-Anpassung (bereits gemacht - styleContext, moodContext, etc.)
    // Stage 3: Generation mit Logit Bias (strukturelle Blockierung schlechter Wörter)
    // Stage 4: Validation (Embedding-Similarity-Check + Post-Processing)
    
    // 🚨 STAGE 3: Logit Bias für schlechte Wörter (strukturelle Blockierung)
    // Lade Learning-Stats für schlechte Wörter
    let logitBias = {};
    try {
      const { getLearningStats } = require('../utils/learning-system');
      const learningStats = await getLearningStats();
      if (learningStats && learningStats.wordFrequency) {
        // Finde Wörter mit hoher "bad" Rate (>50% bad oder 0% successRate)
        const badWords = [];
        for (const [word, stats] of Object.entries(learningStats.wordFrequency)) {
          const total = (stats.good || 0) + (stats.bad || 0);
          if (total > 0) {
            const badRate = (stats.bad || 0) / total;
            if (badRate > 0.5 || (stats.good === 0 && stats.bad > 0)) {
              badWords.push(word.toLowerCase());
            }
          }
        }
        
        // Füge auch problematische Patterns hinzu
        if (learningStats.patterns) {
          for (const [pattern, stats] of Object.entries(learningStats.patterns)) {
            if (stats.successRate === 0 && stats.count > 5) {
              // Teile Pattern in Wörter auf
              const words = pattern.toLowerCase().split(/\s+/);
              badWords.push(...words);
            }
          }
        }
        
        // Erstelle Logit Bias (negative Werte = weniger wahrscheinlich)
        // OpenAI Logit Bias: -100 = sehr unwahrscheinlich, -50 = unwahrscheinlich, 0 = neutral
        // Wir verwenden -50 für schlechte Wörter (strukturelle Blockierung, aber nicht komplett)
        const uniqueBadWords = [...new Set(badWords)];
        console.log(`🚨 Logit Bias: ${uniqueBadWords.length} schlechte Wörter werden strukturell blockiert`);
        
        // OpenAI benötigt Token-IDs für Logit Bias
        // Da wir keine direkte Token-ID-Mapping haben, verwenden wir einen anderen Ansatz:
        // Wir fügen die schlechten Wörter explizit in den Prompt ein als "ABSOLUT VERBOTEN"
        // UND reduzieren die Temperature bei Retries
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Laden der Learning-Stats für Logit Bias (nicht kritisch):', err.message);
    }
    
    // 🚨🚨🚨 MULTI-AGENT-PIPELINE: Verwende Multi-Agent-System statt direkt chat.completions.create 🚨🚨🚨
    // 🚨 WICHTIG: Nur für normale Nachrichten (NICHT ASA - ASA wird separat gehandhabt)
    
    if (!isLastMessageFromFake) {
      // 🚨 NEU: Sammle alle nötigen Daten für Multi-Agent-Pipeline
      const messages = req.body?.siteInfos?.messages || [];
      const allMessages = messages; // Alle Nachrichten für Pipeline
      
      // Extrahiere moderatorMessages und customerMessages (bereits oben gemacht, hier nochmal für Pipeline)
      const totalMessages = messages.filter(m => !isInfoMessage(m) && typeof m?.text === "string" && m.text.trim() !== "").length;
      const contextSize = totalMessages > 20 ? 20 : totalMessages > 10 ? 15 : 10;
      
      const moderatorMessagesForPipeline = messages
        .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-contextSize);
      
      const customerMessagesForPipeline = messages
        .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "")
        .slice(-contextSize);
      
      // 🚨 KRITISCH: Definiere fakeName, fakeAge, etc. VOR ihrer Verwendung (sie werden normalerweise später definiert)
      const fakeName = extractedInfo.assistant?.Name || req.body?.siteInfos?.metaData?.moderatorInfo?.name || null;
      const fakeAge = extractedInfo.assistant?.Age || req.body?.siteInfos?.metaData?.moderatorInfo?.birthDate?.age || null;
      const fakeCity = extractedInfo.assistant?.Wohnort || req.body?.siteInfos?.metaData?.moderatorInfo?.city || null;
      const fakeWork = extractedInfo.assistant?.Work || req.body?.siteInfos?.metaData?.moderatorInfo?.occupation || null;
      const fakeGender = extractedInfo.assistant?.Gender || req.body?.siteInfos?.metaData?.moderatorInfo?.gender || null;
      
      // Sammle Profile-Info für Pipeline
      const profileInfoForPipeline = {
        name: fakeName,
        age: fakeAge,
        city: fakeCity,
        work: fakeWork,
        gender: fakeGender
      };
      
      // Sammle extractedUserInfo für Pipeline
      const extractedUserInfoForPipeline = extractedInfo;
      
      // 🚨 KRITISCH: Definiere imageUrls VOR ihrer Verwendung (sie wird normalerweise später definiert)
      // Prüfe assetsToSend (falls Extension Bilder dort sendet)
      let imageUrls = [];
      if (assetsToSend && Array.isArray(assetsToSend) && assetsToSend.length > 0) {
        for (const asset of assetsToSend) {
          const assetUrl = asset.url || asset.imageUrl || asset.src || asset.image_url;
          if (assetUrl && typeof assetUrl === 'string') {
            imageUrls.push(assetUrl);
          }
        }
      }
      // Falls keine Bilder in assetsToSend, versuche aus foundMessageText zu extrahieren
      if (imageUrls.length === 0 && foundMessageText) {
        const extractedUrls = extractImageUrls(foundMessageText);
        if (extractedUrls.length > 0) {
          imageUrls = extractedUrls;
        }
      }
      
      // Bild-URL für Pipeline
      const imageUrlForPipeline = imageUrls && imageUrls.length > 0 ? imageUrls[0] : null;
      
      // Helper-Funktionen für Pipeline
      const isLocationQuestionFunc = null; // TODO: Falls vorhanden, hier übergeben
      const findNearbyCityFunc = findNearbyCity;
      // 🚨 KRITISCH: isMeetingRequest ist möglicherweise nicht definiert - verwende null als Fallback
      const isMeetingRequestFuncForPipeline = typeof isMeetingRequest !== 'undefined' ? isMeetingRequest : null;
      const vectorDbFunc = async (query, options) => {
        const { findSimilarExamples } = require('../utils/vector-db');
        return await findSimilarExamples(query, options);
      };
      const imageAnalysisFunc = null; // TODO: Falls vorhanden, hier übergeben
      const proactiveAnalysisFunc = null; // TODO: Falls vorhanden, hier übergeben
      // 🚨 KRITISCH: analyzeWritingStyle ist möglicherweise nicht definiert - verwende null als Fallback
      const analyzeWritingStyleFunc = typeof analyzeWritingStyle !== 'undefined' ? analyzeWritingStyle : null;
      const isInfoMessageFunc = isInfoMessage;
      
      // ASA-Kontext für Pipeline (leer bei normalen Nachrichten)
      const asaConversationContextForPipeline = '';
      
      try {
        console.log('🤖 Multi-Agent-Pipeline wird gestartet...');
        
        // 🚨 NEU: Rufe Multi-Agent-Pipeline auf
        const multiAgentResults = await runMultiAgentPipeline({
          conversationHistory: conversationContext,
          customerMessage: validatedMessage,
          profileInfo: profileInfoForPipeline,
          extractedUserInfo: extractedUserInfoForPipeline,
          allRules: rules,
          trainingData: trainingData,
          situations: detectedSituations,
          imageUrl: imageUrlForPipeline,
          moderatorMessages: moderatorMessagesForPipeline,
          customerMessages: customerMessagesForPipeline,
          allMessages: allMessages,
          feedbackData: null, // TODO: Falls verfügbar, hier übergeben
          vectorDbFunc: vectorDbFunc,
          imageAnalysisFunc: imageAnalysisFunc,
          proactiveAnalysisFunc: proactiveAnalysisFunc,
          analyzeWritingStyleFunc: analyzeWritingStyleFunc,
          isInfoMessageFunc: isInfoMessageFunc,
          isASA: false, // Normale Nachricht, NICHT ASA
          asaConversationContext: asaConversationContextForPipeline,
          isLocationQuestionFunc: isLocationQuestionFunc,
          findNearbyCityFunc: findNearbyCityFunc,
          isMeetingRequestFunc: isMeetingRequestFuncForPipeline
        });
        
        // Prüfe, ob Pipeline blockiert wurde (Safety-Check)
        if (multiAgentResults.blocked) {
          console.error(`🚨 Multi-Agent-Pipeline: BLOCKIERT - ${multiAgentResults.error || 'Unbekannter Fehler'}`);
          return res.status(200).json({
            error: multiAgentResults.error || "❌ FEHLER: Nachricht wurde blockiert",
            resText: multiAgentResults.error || "❌ FEHLER: Nachricht wurde blockiert",
            replyText: "",
            summary: extractedInfo,
            chatId: finalChatId,
            actions: [],
            flags: { blocked: true, reason: multiAgentResults.safety?.reason || "safety_blocked", isError: true, showError: true }
          });
        }
        
        console.log('✅ Multi-Agent-Pipeline erfolgreich abgeschlossen');
        
        // 🚨 NEU: Rufe agentMessageGenerator auf statt direkt chat.completions.create
        const messageResult = await agentMessageGenerator(multiAgentResults, {
          conversationHistory: conversationContext,
          customerMessage: validatedMessage,
          profileInfo: profileInfoForPipeline,
          extractedUserInfo: extractedUserInfoForPipeline,
          allRules: rules,
          isASA: false,
          asaConversationContext: '',
          platformId: platformId || 'viluu',
          isMeetingRequestFunc: isMeetingRequestFuncForPipeline
        });
        
        if (!messageResult.success) {
          throw new Error(messageResult.error || 'Fehler bei agentMessageGenerator');
        }
        
        replyText = messageResult.message || '';
        console.log('✅ Nachricht von Multi-Agent-Pipeline generiert:', replyText ? replyText.substring(0, 100) + '...' : '(leer)');
        
      } catch (err) {
        console.error('❌ Fehler in Multi-Agent-Pipeline:', err.message);
        console.error('❌ Stack:', err.stack);
        
        // Fallback: Versuche direkt mit chat.completions.create (falls Pipeline fehlschlägt)
        console.warn('⚠️ Fallback: Verwende direkt chat.completions.create');
        try {
          const chat = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            max_tokens: 250,
            temperature: 0.7
          });
          replyText = chat.choices?.[0]?.message?.content?.trim();
          console.log('✅ Fallback: Nachricht direkt generiert');
        } catch (fallbackErr) {
          errorMessage = `❌ FEHLER: Beim Generieren der Nachricht ist ein Fehler aufgetreten: ${fallbackErr.message}`;
          console.error("❌ OpenAI Fehler (Fallback):", fallbackErr.message);
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
      }
    } else {
      // ASA-Fall: Wird bereits oben separat gehandhabt und sollte hier nicht ankommen
      console.error("❌ FEHLER: ASA-Fall sollte bereits oben behandelt worden sein!");
      return res.status(200).json({
        resText: "",
        replyText: "",
        summary: extractedInfo,
        chatId: finalChatId,
        actions: [],
        flags: { blocked: false, noReload: true },
        noReload: true
      });
    }
    
    // 🚨🚨🚨 STAGE 4: Embedding-Similarity-Check (strukturelle Validierung)
    // Prüfe, ob die generierte Antwort ähnlich genug zu Training-Daten ist (>0.7 Similarity)
    let embeddingSimilarity = 0;
    if (replyText && relevantExamples && relevantExamples.length > 0) {
      try {
        const { getEmbedding, cosineSimilarity } = require('../utils/embeddings');
        const replyEmbedding = await getEmbedding(replyText);
        if (replyEmbedding) {
          let maxSimilarity = 0;
          let bestMatch = null;
          
          // Vergleiche mit allen relevanten Training-Daten-Beispielen
          for (const example of relevantExamples) {
            if (example.moderatorResponse) {
              const exampleEmbedding = await getEmbedding(example.moderatorResponse);
              if (exampleEmbedding) {
                const similarity = cosineSimilarity(replyEmbedding, exampleEmbedding);
                if (similarity > maxSimilarity) {
                  maxSimilarity = similarity;
                  bestMatch = example.moderatorResponse.substring(0, 100);
                }
              }
            }
          }
          
          embeddingSimilarity = maxSimilarity;
          console.log(`🔍 Embedding-Similarity-Check: ${(maxSimilarity * 100).toFixed(1)}% Ähnlichkeit zu Training-Daten (Schwellwert: 70%)`);
          
          // 🚨 KRITISCH: Wenn Similarity < 0.6, ist die Antwort zu unterschiedlich von Training-Daten
          // 🚨 WICHTIG: 60% ist realistischer als 70%, da jeder Mensch anders schreibt
          // Das bedeutet, die KI hat nicht die Training-Daten befolgt
          if (maxSimilarity < 0.6) {
            console.warn(`⚠️ Embedding-Similarity zu niedrig (${(maxSimilarity * 100).toFixed(1)}% < 60%) - Antwort ist zu unterschiedlich von Training-Daten!`);
            console.warn(`⚠️ Beste Übereinstimmung: "${bestMatch}..."`);
            // 🚨 WICHTIG: Wir markieren es, aber blockieren nicht sofort - Post-Processing prüft es nochmal
            // Wenn Post-Processing auch Probleme findet, wird neu generiert
          } else if (maxSimilarity < 0.7) {
            console.warn(`⚠️ Embedding-Similarity mäßig (${(maxSimilarity * 100).toFixed(1)}% < 70%) - könnte besser sein, aber akzeptabel`);
          } else {
            console.log(`✅ Embedding-Similarity OK: ${(maxSimilarity * 100).toFixed(1)}% - Antwort ist ähnlich genug zu Training-Daten`);
          }
        }
      } catch (err) {
        console.warn('⚠️ Fehler beim Embedding-Similarity-Check (nicht kritisch):', err.message);
      }
    }
    
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
          max_tokens: 250, // 🚨 ERHÖHT: Mehr Tokens für vollständige Antworten
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
    // 🚨 WICHTIG: Filtere "klingt" und "Das klingt" aus, da diese Wörter zu häufig verwendet werden müssen
    if (rules && rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
      const filteredForbiddenWords = rules.forbiddenWords.filter(w => {
        const wLower = w.toLowerCase();
        // Entferne "klingt" und "Das klingt" aus der Validierung
        return !wLower.includes("klingt");
      });
      
      for (const forbiddenWord of filteredForbiddenWords) {
        const forbiddenLower = forbiddenWord.toLowerCase();
        
        // 🚨 AUSNAHME: "Vorstellung" ist erlaubt, wenn es im Kontext von Treffen verwendet wird (z.B. "wie du es dir vorstellst")
        // Dies ist eine erlaubte Formulierung für Treffen-Anfragen laut rules.json
        if (forbiddenLower.includes("vorstellung")) {
          // Prüfe, ob es im erlaubten Kontext verwendet wird
          const allowedContexts = [
            /wie (du|er|sie|ihr) (es|sich) (dir|sich) vorstell/i,
            /wie (du|er|sie|ihr) (es|sich) vorstell/i,
            /(dir|sich) vorstell/i
          ];
          const isAllowedContext = allowedContexts.some(pattern => pattern.test(replyLower));
          if (isAllowedContext) {
            console.log(`✅ "Vorstellung" erkannt, aber im erlaubten Kontext (Treffen-Anfrage) - NICHT blockiert`);
            continue; // Überspringe diese Prüfung - "Vorstellung" ist hier erlaubt
          }
        }
        
        // 🚨 AUSNAHME: "treffen" ist erlaubt, wenn der Kunde eine Treffen-Anfrage gestellt hat
        // Die KI MUSS darauf reagieren können (z.B. "das schauen wir noch wann es bei uns am besten klappt")
        // ABER: Die KI soll NICHT selbst ein Treffen vorschlagen!
        if (forbiddenLower.includes("treffen")) {
          // Prüfe, ob der Kunde eine Treffen-Anfrage gestellt hat
          // isCustomerMeetingRequest wird weiter oben definiert (Zeile 3125)
          if (typeof isCustomerMeetingRequest !== 'undefined' && isCustomerMeetingRequest) {
            // Prüfe, ob die Antwort eine Reaktion auf die Treffen-Anfrage ist (nicht selbst ein Vorschlag)
            // Erlaubte Kontexte: Reaktionen auf Treffen-Anfragen (z.B. "schauen wir noch", "klappt bei uns", "wann es passt")
            const allowedMeetingContexts = [
              /schauen wir noch/i,
              /schauen wir/i,
              /klappt bei uns/i,
              /klappt bei mir/i,
              /wann es (bei uns|bei mir|bei dir|dir|uns|mir) (am besten|gut|passt|klappt)/i,
              /wann es (am besten|gut|passt|klappt)/i,
              /wie (du|er|sie|ihr) es (dir|sich) (vorstell|vorstellen)/i,
              /was ausmachen/i, // "wir was ausmachen" (Reaktion auf "wir was ausmachen")
              /bereit (für|für dich|für euch|für uns)/i // "ich bin bereit für dich"
            ];
            const isAllowedMeetingContext = allowedMeetingContexts.some(pattern => pattern.test(replyLower));
            if (isAllowedMeetingContext) {
              console.log(`✅ "treffen" erkannt, aber im erlaubten Kontext (Reaktion auf Treffen-Anfrage) - NICHT blockiert`);
              continue; // Überspringe diese Prüfung - "treffen" ist hier erlaubt
            }
          }
        }
        
        // Prüfe auf exakte Übereinstimmung oder als Teilwort
        // Erkenne auch Variationen (z.B. "spannend" erkennt auch "spannende", "spannendes", "spannend!", etc.)
        const wordPattern = new RegExp(`\\b${forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-zäöü]*\\b`, 'i');
        if (wordPattern.test(replyLower) || replyLower.includes(forbiddenLower)) {
          foundForbiddenWords.push(forbiddenWord);
        }
      }
    }
    
    // 🚨 ENTFERNT: "Das klingt" Phrasen-Erkennung - "klingt" ist jetzt erlaubt!
    
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
      /^(guten morgen|guten tag|guten abend|gute nacht|hallo|hi|hey|servus|moin|grüß dich|grüß gott|grüezi),/i,
      // 🚨 KRITISCH: Generische, bewertende Phrasen (ABSOLUT VERBOTEN!)
      /^(oh|ah|aha|oh je|oh man),? (da wird|da ist|da scheint|da wirkt) (jemand|du|der kunde|er|sie) (neugierig|interessiert|aufgeregt|gespannt|wissbegierig)/i,
      /(oh|ah|aha),? (da wird|da ist|da scheint|da wirkt) (jemand|du|der kunde|er|sie) (neugierig|interessiert|aufgeregt|gespannt|wissbegierig)/i,
      /ich bin gespannt,? (was|wie|ob|wann|wo|warum|wodurch|womit) (du|der kunde|er|sie|jemand) (gerne|würde|möchte|will|könnte) (über mich|von mir|über|von) (erfahren|wissen|erzählen|hören|lernen|erfahren würdest|wissen würdest)/i,
      /(was|wie|ob|wann|wo|warum|wodurch|womit) (du|der kunde|er|sie|jemand) (gerne|würde|möchte|will|könnte) (über mich|von mir|über|von) (erfahren|wissen|erzählen|hören|lernen|erfahren würdest|wissen würdest)/i,
      /(ich|ich würde|ich könnte|ich möchte) (gerne|würde gerne|möchte gerne) (wissen|erfahren|hören|erzählen|lernen),? (was|wie|ob|wann|wo|warum|wodurch|womit) (du|der kunde|er|sie|jemand) (gerne|würde|möchte|will|könnte) (über mich|von mir|über|von) (erfahren|wissen|erzählen|hören|lernen)/i,
      // Generische, KI-hafte Phrasen (VERBOTEN!)
      /(ich bin gespannt|ich würde gerne wissen|ich möchte gerne wissen|ich würde gerne erfahren|ich möchte gerne erfahren),? (was|wie|ob|wann|wo|warum|wodurch|womit) (du|der kunde|er|sie|jemand) (gerne|würde|möchte|will|könnte) (über mich|von mir|über|von) (erfahren|wissen|erzählen|hören|lernen)/i
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
    
    // 🚨🚨🚨 KRITISCH: Wenn verbotene Wörter, Meta-Kommentare, mehrere Fragen, etc. gefunden wurden, MUSS neu generiert werden! 🚨🚨🚨
    // Diese Fehler dürfen NICHT durchgehen - die Antwort ist sonst UNBRAUCHBAR!
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
      
      // 🚨🚨🚨 STAGE 4: Multi-Retry-Logik (reduziert auf 3 Versuche für weniger Blockierungen)
      const MAX_RETRIES = 3; // 🚨 REDUZIERT von 5 auf 3 für weniger Blockierungen, mehr natürliche Antworten
      let retryAttempt = 0;
      let retrySuccessful = false;
      
      try {
        while (retryAttempt < MAX_RETRIES && !retrySuccessful) {
          retryAttempt++;
          console.log(`🔄 Retry-Versuch ${retryAttempt}/${MAX_RETRIES}...`);
          
      try {
        let retryReason = "";
        if (foundForbiddenWords.length > 0) {
          retryReason += `🚨🚨🚨 KRITISCH: VERBOTENE WÖRTER GEFUNDEN: ${foundForbiddenWords.map(w => `"${w}"`).join(', ')}! 🚨🚨🚨\n\n`;
          retryReason += `🚨🚨🚨 ABSOLUT VERBOTEN - DIESE WÖRTER DÜRFEN NIEMALS VERWENDET WERDEN! 🚨🚨🚨\n`;
          retryReason += `- Verwende diese Wörter NIEMALS, auch nicht in ähnlicher Form!\n`;
          if (foundForbiddenWords.some(w => w.toLowerCase().includes('spannend'))) {
            retryReason += `- 🚨 KRITISCH: "spannend" ist VERBOTEN! Verwende stattdessen: "geil", "heiß", "mega", "richtig gut", "toll", "cool", etc.\n`;
          }
          if (foundForbiddenWords.some(w => w.toLowerCase().includes('interessant'))) {
            retryReason += `- 🚨 KRITISCH: "interessant" ist VERBOTEN! Verwende stattdessen: "geil", "heiß", "mega", "richtig gut", etc.\n`;
          }
          retryReason += `- 🚨 KRITISCH: Diese Wörter sind in den VERBOTENEN WÖRTERN - sie werden bei jedem Versuch blockiert! 🚨\n\n`;
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

BEISPIEL RICHTIG: Wenn der Kunde sagt "in deine muschi", dann antworte direkt darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das finde ich geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo würdest du anfangen?"! 

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
- BEISPIEL RICHTIG: Wenn der Kunde sagt "bei deiner muschi", dann antworte direkt darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das finde ich geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo"!
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
- BEISPIEL: Wenn der Kunde sagt "in deine muschi", dann reagiere darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das finde ich geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo"!
🚨🚨🚨\n\n` : ''}

Kundennachricht: "${validatedMessage.substring(0, 500)}"

${customerName ? `Der Kunde heißt: ${customerName}\n` : ''}
${customerContext.length > 0 ? `Bekannte Infos über den KUNDEN:\n${customerContext.join('\n')}\n
🚨🚨🚨 KRITISCH: PROFIL-INFOS NUR VERWENDEN, WENN ZUM KONTEXT PASSEND! 🚨🚨🚨
- Diese Infos sind HINTERGRUND-Informationen, NICHT der Hauptkontext!
- Der CHAT-VERLAUF hat HÖCHSTE PRIORITÄT - was wurde VORHER besprochen?
- Verwende Hobbies/Interessen NUR, wenn sie zum aktuellen Gespräch passen!
- BEISPIEL FALSCH: Gespräch über Licht/Schatten/Sonne → "Was kochst du gerne?" → FALSCH! Nicht zum Kontext passend!
- BEISPIEL RICHTIG: Gespräch über Essen → "Was kochst du gerne?" → RICHTIG! Zum Kontext passend!
- Wenn der Kontext philosophisch/abstrakt ist (z.B. Licht/Schatten), dann bleibe beim Thema, verwende NICHT plötzlich Hobbies!
- Profil-Infos sind nur für Hintergrund-Wissen - der CHAT-VERLAUF bestimmt das Thema!\n` : ''}

${criticalRulesContext}

${specificInstructions}

Antworte NUR mit der neuen Antwort, keine Erklärungen.`;

          // 🚨 REDUZIERE Temperature bei jedem Retry (strukturelle Blockierung)
          // Retry 1: 0.4, Retry 2: 0.3, Retry 3: 0.2, Retry 4: 0.1, Retry 5: 0.1
          const retryTemperature = Math.max(0.1, 0.4 - (retryAttempt - 1) * 0.1);
          console.log(`🌡️ Retry ${retryAttempt}: Temperature = ${retryTemperature}`);
          
          let retryChat;
          try {
            retryChat = await client.chat.completions.create({
              model: AI_MODEL,
            messages: [
                { role: "system", content: systemPrompt + `\n\n🚨🚨🚨🚨🚨 KRITISCH: Die folgenden Wörter sind ABSOLUT VERBOTEN: ${rules.forbiddenWords.filter(w => !w.toLowerCase().includes("klingt")).map(w => `"${w}"`).join(', ')}. Verwende sie NIEMALS! 🚨🚨🚨🚨🚨\n\n🚨🚨🚨 KRITISCH: Wenn du "spannend" verwenden willst, verwende stattdessen: "geil", "heiß", "mega", "richtig gut", "toll", "cool"! 🚨🚨🚨` },
              { role: "user", content: retryPrompt }
            ],
              max_tokens: 250, // 🚨 ERHÖHT: Mehr Tokens für vollständige Antworten
              temperature: retryTemperature // 🚨 REDUZIERT: Strukturelle Blockierung durch niedrigere Temperature
            });
          } catch (retryErr) {
            // 🚨 RATE-LIMIT-HANDLING: Wenn Rate-Limit erreicht, warte und versuche es erneut
            if (retryErr.message && retryErr.message.includes('429') && retryErr.message.includes('Rate limit')) {
              const waitMatch = retryErr.message.match(/try again in ([\d.]+)s/);
              const waitSeconds = waitMatch ? parseFloat(waitMatch[1]) : 2;
              console.warn(`⚠️ Rate-Limit erreicht, warte ${waitSeconds} Sekunden...`);
              await new Promise(resolve => setTimeout(resolve, (waitSeconds + 0.5) * 1000)); // Warte + 0.5s Puffer
              
              // Versuche es nochmal (nur einmal)
              try {
                retryChat = await client.chat.completions.create({
                  model: AI_MODEL,
                  messages: [
                    { role: "system", content: systemPrompt + `\n\n🚨🚨🚨🚨🚨 KRITISCH: Die folgenden Wörter sind ABSOLUT VERBOTEN: ${rules.forbiddenWords.filter(w => !w.toLowerCase().includes("klingt")).map(w => `"${w}"`).join(', ')}. Verwende sie NIEMALS! 🚨🚨🚨🚨🚨\n\n🚨🚨🚨 KRITISCH: Wenn du "spannend" verwenden willst, verwende stattdessen: "geil", "heiß", "mega", "richtig gut", "toll", "cool"! 🚨🚨🚨` },
                    { role: "user", content: retryPrompt }
                  ],
                  max_tokens: 250,
                  temperature: retryTemperature
                });
                console.log(`✅ Nach Rate-Limit-Wartezeit erfolgreich generiert`);
              } catch (retryErr2) {
                console.error(`🚨 Retry ${retryAttempt}: Fehler beim Generieren (auch nach Rate-Limit-Wartezeit):`, retryErr2.message);
                throw retryErr2; // Wirf den Fehler weiter, damit der äußere catch ihn behandelt
              }
            } else {
              // Anderer Fehler - wirf weiter
              throw retryErr;
            }
          }
          
          const retryText = retryChat.choices?.[0]?.message?.content?.trim();
          if (retryText) {
            // Bereinige die neue Antwort
            let cleanedRetry = retryText.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
            cleanedRetry = cleanedRetry.replace(/-/g, " ").replace(/ß/g, "ss");
            
            // 🚨 STAGE 4: Validation - Prüfe auf alle Probleme
            const retryLower = cleanedRetry.toLowerCase();
            const stillForbidden = [];
            const filteredForbiddenWords = rules.forbiddenWords.filter(w => !w.toLowerCase().includes("klingt"));
            for (const forbiddenWord of filteredForbiddenWords) {
              const forbiddenLower = forbiddenWord.toLowerCase();
              const escapedForbidden = forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const wordPattern = new RegExp(`\\b${escapedForbidden}[a-zäöü]*\\b`, 'i');
              if (wordPattern.test(retryLower) || retryLower.includes(forbiddenLower)) {
                stillForbidden.push(forbiddenWord);
              }
            }
            
            // Prüfe auch auf andere Probleme (Meta-Kommentare, etc.)
            const metaCommentPatterns = [
              /das (ist|klingt|wäre|wird) (eine|ein) (direkte|gute|interessante|spannende|mutige|persönliche) (frage|nachricht|antwort)/i,
              /das (ist|klingt|wäre|wird) (interessant|spannend|mutig|persönlich|direkt)/i,
              /ich (verstehe|sehe|kann verstehen|kann sehen), dass du/i,
              /es tut mir leid, ich kann (nicht|darauf nicht)/i
            ];
            const hasMetaComments = metaCommentPatterns.some(pattern => pattern.test(retryLower));
            const startsWithIchRetry = /^ich\s+/i.test(cleanedRetry.trim());
            
            // 🚨🚨🚨 KRITISCH: Prüfe AUCH auf mehrere Fragen im Retry! 🚨🚨🚨
            const retryQuestionMarks = (cleanedRetry.match(/\?/g) || []).length;
            const hasMultipleQuestionsRetry = retryQuestionMarks > 1;
            
            if (stillForbidden.length === 0 && !hasMetaComments && !startsWithIchRetry && !hasMultipleQuestionsRetry) {
              replyText = cleanedRetry;
              retrySuccessful = true;
              console.log(`✅ Antwort erfolgreich neu generiert (Retry ${retryAttempt}/${MAX_RETRIES})`);
            } else {
              // Fehler gefunden - nächster Retry-Versuch
              if (stillForbidden.length > 0) {
                console.error(`🚨 Retry ${retryAttempt}: Antwort enthält noch verbotene Wörter: ${stillForbidden.join(', ')}`);
              }
              if (hasMetaComments) {
                console.error(`🚨 Retry ${retryAttempt}: Antwort enthält noch Meta-Kommentare`);
              }
              if (startsWithIchRetry) {
                console.error(`🚨 Retry ${retryAttempt}: Antwort beginnt noch mit "Ich"`);
              }
              if (hasMultipleQuestionsRetry) {
                console.error(`🚨 Retry ${retryAttempt}: Antwort enthält noch mehrere Fragen (${retryQuestionMarks} Fragen, nur 1 erlaubt!)`);
              }
              
              // Fehler gefunden - nächster Retry-Versuch (wird in while-Schleife fortgesetzt)
              // Wenn letzter Versuch, wird die while-Schleife beendet und Fehler geworfen
            }
          } else {
            // Keine Antwort generiert - nächster Retry-Versuch
            console.error(`🚨 Retry ${retryAttempt}: Antwort ist leer`);
          }
      } catch (err) {
          console.error(`🚨 Retry ${retryAttempt}: Fehler beim Generieren:`, err.message);
          // Bei Fehler: nächster Versuch (außer letzter)
          if (retryAttempt >= MAX_RETRIES) {
            errorMessage = `❌ FEHLER: Die KI konnte nach ${MAX_RETRIES} Versuchen keine regelkonforme Antwort generieren. ${err.message}`;
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
      } // Ende while-Schleife
      
      // Wenn alle Retries fehlgeschlagen sind
      if (!retrySuccessful) {
        console.error("🚨🚨🚨 KRITISCH: Alle Retry-Versuche fehlgeschlagen! 🚨🚨🚨");
        errorMessage = `❌ FEHLER: Die KI konnte nach ${MAX_RETRIES} Versuchen keine regelkonforme Antwort generieren.`;
        return res.status(200).json({
          error: errorMessage,
          resText: "",
          replyText: "",
          summary: {},
          chatId: finalChatId,
          actions: [],
          flags: { blocked: true, reason: "all_retries_failed", isError: true, showError: true }
        });
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
          max_tokens: 250, // 🚨 ERHÖHT: Mehr Tokens für vollständige Antworten
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
    
    // 🎯 ERWEITERTE QUALITÄTS-MONITORING & ERFOLGSMETRIKEN: Tracke Qualität und Erfolg
    let qualityEvaluation = null;
    try {
      const { trackQuality } = require('../utils/quality-monitor');
      const qualityContext = {
        chatId: responseChatId || req.body?.chatId || null,
        platform: req.body?.platformId || req.body?.siteInfos?.platform || 'unknown',
        forbiddenWords: foundForbiddenWords || [],
        hasRepetition: foundRepetitions.length > 0,
        hasSexualContent: hasSexualContent || false,
        embeddingSimilarity: embeddingSimilarity || 0 // 🚨 NEU: Embedding-Similarity für Multi-Layer Validation
      };
      qualityEvaluation = await trackQuality(replyText, foundMessageText, qualityContext);
      console.log(`📊 Qualitäts-Score: ${qualityEvaluation.score}/100 (${qualityEvaluation.reasons.join(', ')})`);
      if (qualityEvaluation.layers) {
        const passedLayers = qualityEvaluation.layers.filter(l => l.status === 'pass').length;
        console.log(`📊 Multi-Layer Validation: ${passedLayers}/${qualityEvaluation.layers.length} Layers bestanden`);
        if (passedLayers < qualityEvaluation.layers.length) {
          console.warn(`⚠️ ${qualityEvaluation.layers.length - passedLayers} Layer(s) nicht bestanden - Qualität könnte verbessert werden`);
        }
      }
      
      // 🚨🚨🚨 ERFOLGSMETRIKEN: Tracke zusätzliche Metriken für besseres Verständnis 🚨🚨🚨
      try {
        const { trackSuccessMetrics } = require('../utils/success-metrics');
        await trackSuccessMetrics({
          chatId: responseChatId || req.body?.chatId || null,
          platform: req.body?.platformId || req.body?.siteInfos?.platform || 'unknown',
          replyLength: replyText.length,
          customerMessageLength: foundMessageText?.length || 0,
          qualityScore: qualityEvaluation.score,
          hasQuestion: replyText.includes('?'),
          isNewCustomer: isNewCustomer || false,
          situation: detectedSituations.length > 0 ? detectedSituations.join(' + ') : 'allgemein',
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.warn('⚠️ Fehler beim Tracking der Erfolgsmetriken (nicht kritisch):', err.message);
      }
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
      }).then(async response => {
        if (!response.ok) {
          console.error(`❌ Feedback-Eintrag konnte nicht erstellt werden: ${response.status} ${response.statusText}`);
        } else {
          console.log(`✅ Feedback-Eintrag erfolgreich erstellt (Chat-ID: ${chatIdForFeedback}, Platform: ${detectedPlatform})`);
          
          // 🚨🚨🚨 REAL-TIME LEARNING: Verarbeite Feedback sofort (nicht nur beim Speichern) 🚨🚨🚨
          try {
            const { analyzeFeedback } = require('../utils/learning-system');
            const feedbackData = await response.json();
            if (feedbackData && feedbackData.feedback) {
              // Analysiere Feedback sofort (Real-Time Learning)
              await analyzeFeedback(feedbackData.feedback, false); // Kein Push, wird später gebatcht
              console.log('🧠 Real-Time Learning: Feedback sofort analysiert');
            }
          } catch (err) {
            console.warn('⚠️ Fehler beim Real-Time Learning (nicht kritisch):', err.message);
          }
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





