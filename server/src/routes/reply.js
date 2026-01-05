// @ts-nocheck
const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");
const fs = require("fs");
const path = require("path");
const { writeToGoogleSheets } = require("../utils/google-sheets");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
const { runMultiAgentPipeline, agentMessageGenerator } = require("../utils/multi-agent");
const router = express.Router();

// AI Model Konfiguration - zentral verwaltet
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini"; // 🚨 MULTI-AGENT: GPT-4o-mini für kostengünstigere Multi-Agent-Pipeline

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

// Prüfe ob eine ASA-Nachricht bereits verwendet wurde (Duplikat-Schutz)
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

// Prüfe auf Treffen/Termine - NUR ECHTE TREFFEN-ANFRAGEN, NICHT FANTASIE!
// WICHTIG: "würde/könnte/hätte" allein = FANTASIE, kein Treffen!
// WICHTIG: "wann können wir ficken" ist KEINE Treffen-Anfrage, sondern sexuelle Fantasie!
// Nur blockieren wenn es wirklich um ein REALES Treffen geht!
function isMeetingRequest(text, customerMessage = "") {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  const lowerCustomer = (customerMessage || "").toLowerCase();
  const combinedLower = `${lower} ${lowerCustomer}`.toLowerCase();
  
  // 🚨 KRITISCH: Ignoriere höfliche Ablehnungen/Ausweichungen - diese sind KORREKT!
  // Diese Phrasen sind KEINE Treffen-Anfragen, sondern höfliche Ablehnungen:
  const rejectionPhrases = [
    "bevor wir uns treffen",
    "bevor wir uns treffen können",
    "bevor wir uns treffen würden",
    "kennenzulernen, bevor wir uns treffen",
    "kennenzulernen bevor wir uns treffen",
    "besser kennenzulernen, bevor wir uns treffen",
    "besser kennenzulernen bevor wir uns treffen",
    "möchte dich noch besser kennenlernen, bevor wir uns treffen",
    "möchte dich noch besser kennenlernen bevor wir uns treffen",
    "würde gerne, bevor wir uns treffen",
    "würde gerne bevor wir uns treffen",
    "erst besser kennenlernen, bevor wir uns treffen",
    "erst besser kennenlernen bevor wir uns treffen"
  ];
  
  // Wenn die Nachricht eine dieser Ablehnungs-Phrasen enthält, ist es KEINE Treffen-Anfrage!
  if (rejectionPhrases.some(phrase => lower.includes(phrase))) {
    return false;
  }
  
  // Prüfe sowohl KI-Antwort als auch Kunden-Nachricht
  return (
    // Direkte Treffen-Anfragen (ohne "würde/könnte/hätte", ABER "wenn" + konkrete Tage/Zeiten = Treffen!)
    (combinedLower.includes("treffen") && !combinedLower.match(/\b(würde|könnte|hätte)\s+.*treffen/i) && !combinedLower.includes("ficken") && 
     // "wenn" + konkrete Tage/Zeiten = Treffen-Anfrage (z.B. "wenn wir uns am Mittwoch treffen")
     (combinedLower.match(/\b(wenn|falls)\s+.*(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|morgen|übermorgen|heute|nächste woche|nächste wochen|uhr|uhrzeit|mittagszeit|abend|vormittag|nachmittag)/i) || 
      !combinedLower.match(/\b(wenn|falls)\s+.*treffen/i))) ||
    // 🚨 NEU: "hoffe" + "treffen" Kombinationen (aus Training-Daten gelernt)
    (combinedLower.match(/\b(hoffe|hoffen|würde hoffen)\s+.*(dass|das)\s+(wir|uns)\s+(uns|wir)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    (combinedLower.match(/\b(hoffe|hoffen)\s+.*(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    // 🚨 NEU: "will" + "treffen" Kombinationen (aus Training-Daten gelernt)
    (combinedLower.match(/\b(will|wollen|möchte|möchtest)\s+(dich|dich|uns|wir)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    (combinedLower.match(/\b(will|wollen)\s+.*(endlich|jetzt|bald|mal)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    // 🚨 NEU: "habe Zeit" + "treffen" Kombinationen (aus Training-Daten gelernt)
    (combinedLower.match(/\b(habe|hast|haben|hat)\s+(jetzt|gerade|morgen|heute|diese woche|jeden|jede)\s+(zeit|nachmittag|vormittag|abend)\s+.*(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    (combinedLower.match(/\b(habe|hast|haben|hat)\s+.*(zeit|nachmittag|vormittag|abend)\s+.*(für|für uns|für dich)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    // 🚨 NEU: "wann" + "Zeit" + "treffen" Kombinationen (aus Training-Daten gelernt)
    (combinedLower.match(/\bwann\s+(hast|hast du|habt|habt ihr|haben|haben wir)\s+(du|ihr|wir|die)\s+(zeit|möglichkeit|gelegenheit)\s+.*(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    // 🚨 NEU: "würde gerne" + "treffen" (nur wenn nicht Fantasie)
    (combinedLower.match(/\b(würde|würdest)\s+gerne\s+(dich|uns|wir)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken") && !combinedLower.match(/\b(wenn|falls)\s+.*(würde|würdest)\s+gerne/i)) ||
    // "Lass uns treffen", "wollen wir uns treffen", "können wir uns treffen" (echte Anfragen)
    (combinedLower.match(/\b(lass|lass uns|wollen|können|sollen|möchten|möchtest)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    // "Wann können wir uns sehen/treffen" (ABER NICHT "wann können wir ficken"!)
    (combinedLower.match(/\bwann\s+(können|wollen|sollen|möchten)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) && !combinedLower.includes("ficken")) ||
    // 🚨 KRITISCH: "Wann hättest du Zeit/Möglichkeit" - Treffen-Anfrage!
    (combinedLower.match(/\bwann\s+(hättest|hast|hättest du|hast du)\s+(du|die)\s+(zeit|möglichkeit|gelegenheit)/i) && !combinedLower.includes("ficken")) ||
    (combinedLower.match(/\bwann\s+(könntest|kannst|könntest du|kannst du)\s+(du|die)\s+(zeit|möglichkeit|gelegenheit)\s+(finden|haben)/i) && !combinedLower.includes("ficken")) ||
    (combinedLower.match(/\b(hättest|hast|hättest du|hast du)\s+(du|die)\s+(zeit|möglichkeit|gelegenheit)\s+(für|für uns|für mich)/i) && !combinedLower.includes("ficken")) ||
    // 🚨 KRITISCH: "sag mir wann es passt" / "wann passt es" / "wann es passt" - Treffen-Anfrage!
    (combinedLower.match(/\b(sag|sage|sag mir|sage mir)\s+(mir|du)\s+(wann|wann es|wann es dir|wann es für dich|wann es für uns)\s+(passt|passen|passen würde|passen würde für dich)/i) && !combinedLower.includes("ficken")) ||
    (combinedLower.match(/\bwann\s+(passt|passen|passen würde|passen würde für dich|passt es|passt es dir|passt es für dich)\s+(es|es dir|es für dich|es für uns|dir|für dich|für uns)/i) && !combinedLower.includes("ficken")) ||
    (combinedLower.match(/\bwann\s+(es|es dir|es für dich|es für uns)\s+(passt|passen|passen würde)/i) && !combinedLower.includes("ficken")) ||
    // 🚨 KRITISCH: "ich werde da sein" / "ich bin da" / "ich komme" - Zusage für Treffen!
    ((combinedLower.includes("ich werde da sein") || combinedLower.includes("ich bin da") || combinedLower.includes("ich komme") || combinedLower.includes("ich werde kommen")) && 
     (combinedLower.includes("wann") || combinedLower.includes("sag") || combinedLower.includes("zeit") || combinedLower.includes("passt")) && 
     !combinedLower.includes("ficken")) ||
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
  // 🚨 FIX: Ignoriere Requests mit origin="fpc" und reason="not_matching_chat_id" (Extension-Reload)
  // Diese Requests werden von der Extension gesendet, wenn der chatId nicht übereinstimmt
  // Sie sollten IGNORIERT werden, um doppelte Nachrichten zu vermeiden
  if (req.body?.origin === "fpc" && req.body?.reason && req.body.reason.includes("not_matching_chat_id")) {
    console.log("⚠️ Extension-Reload-Request erkannt (origin=fpc, reason=not_matching_chat_id) - IGNORIERE");
    return res.status(200).json({
      resText: "",
      replyText: "",
      summary: {},
      chatId: req.body?.chatId || "00000000",
      actions: [],
      flags: { blocked: false, noReload: true, skipProcessing: true }
    });
  }
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
  // 🚨 KRITISCH: Prüfe NUR, wenn foundMessageText leer ist - wenn es eine Kunden-Nachricht gibt, ist es KEIN ASA-Fall!
  if (!isLastMessageFromFake && (!foundMessageText || foundMessageText.trim() === "") && req.body?.siteInfos?.messages?.length) {
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

  // ==========================================
  // REIHENFOLGE GEMÄSS ALTER REPLY.JS:
  // 1. Request-Parsing (bereits erledigt)
  // 2. KI-Check (HÖCHSTE PRIORITÄT)
  // 3. Safety-Check (Minderjährige, etc.)
  // 4. OpenAI Client prüfen
  // 5. Regeln laden
  // 6. Training Data laden
  // 7. ASA-Erkennung
  // 8. Chat-Kontext extrahieren
  // 9. Profil-Info extrahieren
  // 10. Feedback-Daten laden (optional)
  // 11. Multi-Agent-Pipeline aufrufen
  // ==========================================
  
  // 🚨 SCHRITT 2: KI-Check (HÖCHSTE PRIORITÄT - vor allen anderen Checks!)
  // Prüfe auf KI-Check-Codes in Kundennachrichten
  if (foundMessageText && foundMessageText.trim() !== "") {
    const isKICheck = isKICheckMessage(foundMessageText);
    if (isKICheck) {
      console.error("🚨🚨🚨 BLOCKIERT: KI-Check-Code in Kundennachricht erkannt! 🚨🚨🚨");
      const errorMessage = "🚨 BLOCKIERT: KI-Prüfung aktiv erkannt!\n\nFPC hat einen KI-Check-Code in die Kundennachricht eingebaut.\nBitte Code manuell eingeben und Nachricht absenden.\n\nEs wird KEINE automatische Antwort generiert.";
      return res.status(200).json({
        error: errorMessage,
        resText: errorMessage,
        replyText: errorMessage,
        summary: {},
        chatId: chatId || finalChatId || "00000000",
        actions: [],
        flags: { 
          blocked: true, 
          reason: "ki_check", 
          isError: true, 
          showError: true,
          requiresAttention: true,
          errorType: "critical",
          errorColor: "red",
          errorStyle: "critical"
        }
      });
    }
  }
  
  // 🛡️ SCHRITT 3: Safety-Check (Minderjährige, strafrechtliche Themen)
  // KRITISCH: Nur prüfen, wenn foundMessageText vorhanden ist und nicht leer!
  if (foundMessageText && foundMessageText.trim() !== "") {
    const { runSafetyCheck } = require('../utils/safety-agent');
    const safetyCheck = runSafetyCheck(foundMessageText);
    if (safetyCheck.isBlocked) {
      console.error(`🛡️ Safety-Check: BLOCKIERT - ${safetyCheck.reason}`);
      return res.status(200).json({
        error: safetyCheck.errorMessage,
        resText: safetyCheck.errorMessage,
        replyText: safetyCheck.errorMessage,
        summary: {},
        chatId: chatId || finalChatId || "00000000",
        actions: [],
        flags: { 
          blocked: true, 
          reason: safetyCheck.reason, 
          isError: true, 
          showError: true,
          requiresAttention: true,
          errorType: "critical",
          errorColor: "red",
          errorStyle: "critical"
        }
      });
    }
  }
  
  // 🔧 SCHRITT 4: OpenAI Client prüfen (bereits bei Zeile 1973 deklariert, hier nur prüfen)
  // WICHTIG: client wurde bereits oben deklariert (Zeile 1973), hier nur nochmal prüfen
  if (!client) {
    const errorMessage = "❌ FEHLER: OpenAI Client nicht verfügbar. Bitte Admin kontaktieren.";
    return res.status(200).json({
      error: errorMessage,
      resText: errorMessage,
      replyText: errorMessage,
      summary: {},
      chatId: chatId || finalChatId || "00000000",
      actions: [],
      flags: { blocked: true, reason: "no_client", isError: true, showError: true }
    });
  }
  
  // 📋 SCHRITT 5: Regeln laden (inkl. situations-spezifische Antworten, verbotene/bevorzugte Wörter)
  let rules = null;
  try {
    rules = await getRules();
    console.log(`✅ Regeln geladen: ${rules?.forbiddenWords?.length || 0} verbotene Wörter, ${rules?.preferredWords?.length || 0} bevorzugte Wörter, ${Object.keys(rules?.situationalResponses || {}).length} Situationen`);
  } catch (err) {
    console.error('⚠️ Fehler beim Laden der Regeln:', err.message);
  }
  
  // 📚 SCHRITT 6: Training Data laden (Beispiel-Gespräche zum Lernen)
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
  
  // 🔄 SCHRITT 7: ASA-Erkennung (wenn letzte Nachricht vom Fake/Moderator kommt)
  // WICHTIG: ASA-Erkennung passiert bereits früher im Code (Zeile ~1580), hier nur zur Dokumentation
  // isLastMessageFromFake wurde bereits ermittelt
  
  // 💬 SCHRITT 8: Chat-Kontext extrahieren (komprimierter Gesprächsverlauf)
  let conversationContextForPipeline = "";
  try {
    conversationContextForPipeline = compressConversation(req.body?.siteInfos?.messages || [], 50);
    console.log(`✅ Chat-Kontext extrahiert: ${conversationContextForPipeline.length} Zeichen`);
  } catch (err) {
    console.warn('⚠️ Fehler beim Extrahieren des Chat-Kontexts:', err.message);
  }
  
  // 👤 SCHRITT 9: Profil-Info extrahieren (aus Nachricht und metaData)
  // WICHTIG: extractedInfo wurde bereits oben deklariert (Zeile 1975), hier nur aktualisieren
  
  // 9a: Extrahiere Info aus der Nachricht (nur wenn Nachricht vorhanden)
  if (client && foundMessageText && foundMessageText.trim() !== "") {
    try {
      extractedInfo = await extractInfoFromMessage(client, foundMessageText);
      console.log("📝 Extrahiert aus Nachricht:", JSON.stringify(extractedInfo.user));
    } catch (err) {
      console.error("❌ FEHLER in extractInfoFromMessage:", err.message);
      extractedInfo = { user: {}, assistant: {} };
    }
  }
  
  // 9b: Fallback: Baue Summary aus metaData (customerInfo / moderatorInfo)
  if (req.body?.siteInfos?.metaData) {
    const metaSummary = buildSummaryFromMeta(req.body.siteInfos.metaData);
    // Merge: Füge metaData-Info hinzu, falls extractInfoFromMessage nichts gefunden hat
    if (Object.keys(extractedInfo.user).length === 0 && Object.keys(metaSummary.user).length > 0) {
      extractedInfo.user = metaSummary.user;
    }
    if (Object.keys(extractedInfo.assistant).length === 0 && Object.keys(metaSummary.assistant).length > 0) {
      extractedInfo.assistant = metaSummary.assistant;
    }
  }
  
  // Profil-Info aus metaData (für Pipeline)
  // WICHTIG: Enthält sowohl customerInfo als auch moderatorInfo für Wohnort-Fragen
  const profileInfo = {
    customerInfo: req.body?.siteInfos?.metaData?.customerInfo || {},
    moderatorInfo: req.body?.siteInfos?.metaData?.moderatorInfo || {},
    ...(req.body?.siteInfos?.metaData?.customerInfo || {}) // Fallback für Kompatibilität
  };
  
  // 📊 SCHRITT 10: Feedback-Daten laden (optional - für Learning-System)
  let feedbackData = null;
  try {
    // TODO: Implementiere Feedback-Daten-Laden (falls vorhanden)
    // const { getFeedbackData } = require('../utils/feedback');
    // feedbackData = await getFeedbackData(chatId || finalChatId);
    // console.log(`✅ Feedback-Daten geladen: ${feedbackData?.length || 0} Einträge`);
  } catch (err) {
    console.warn('⚠️ Fehler beim Laden der Feedback-Daten (optional):', err.message);
  }
  
  // 🤖🤖🤖 SCHRITT 11: MULTI-AGENT PIPELINE - Führe Multi-Agent-Analyse durch (HAUPTWEG) 🤖🤖🤖
  // 🤖 ASA-UNTERSTÜTZUNG: Bereite ASA-Parameter vor (AUßERHALB try-Block, damit sie immer verfügbar sind)
  // WICHTIG: isASA ist bereits ein Funktionsparameter (aus req.body), verwende isLastMessageFromFake für den berechneten Wert
  const isASACalculated = isLastMessageFromFake || false;
  const asaConversationContext = isASACalculated ? (compressConversation(req.body?.siteInfos?.messages || [], 10) || "").toLowerCase() : '';
  
  let multiAgentResults = null;
  try {
    // Sammle alle notwendigen Variablen für die Pipeline
    const conversationHistory = conversationContextForPipeline || "";
    const customerMessage = foundMessageText || "";
    const allRules = rules || { forbiddenWords: [], preferredWords: [], situationalResponses: {} };
    
    // Situations-Erkennung (wird später von Rules-Applicator-Agent gemacht)
    // Für jetzt: Leeres Array, wird von Pipeline gefüllt
    const situations = [];
    
    // Extrahiere erste Bild-URL (falls vorhanden)
    let imageUrlForPipeline = null;
    try {
      const imageUrlsTemp = extractImageUrls(foundMessageText || "");
      if (imageUrlsTemp && imageUrlsTemp.length > 0) {
        imageUrlForPipeline = imageUrlsTemp[0];
      }
    } catch (err) {
      // Ignoriere Fehler bei Bild-Extraktion
    }
    
    // Sammle Moderator-Nachrichten für Style-Analyse
    const messages = req.body?.siteInfos?.messages || [];
    const moderatorMessagesForPipeline = messages
      .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
      .slice(-20)
      .map(m => ({ text: m.text.trim() }));
    
    // Sammle Kunden-Nachrichten für Style-Analyse
    const customerMessagesForPipeline = messages
      .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "")
      .slice(-20)
      .map(m => ({ text: m.text.trim() }));
    
    // Wrapper-Funktion für Vector-DB (wird dynamisch geladen)
    const vectorDbFunc = async (queryText, options) => {
      try {
        const { findSimilarExamples } = require('../utils/vector-db');
        const situation = options?.situation || (situations.length > 0 ? situations[0] : null);
        const topK = options?.topK || 20;
        const minSimilarity = options?.minSimilarity || 0.3;
        return await findSimilarExamples(queryText, { situation, topK, minSimilarity });
      } catch (err) {
        console.warn('⚠️ Vector-DB Fehler in Multi-Agent Pipeline:', err.message);
        return [];
      }
    };
    
    // Wrapper-Funktion für Bild-Analyse (nutzt bestehende Logik)
    const imageAnalysisFunc = async (imageUrl, contextAnalysis) => {
      try {
        if (!imageUrl || !client) return { imageType: null, reactionNeeded: null };
        const dataUrl = await fetchImageAsBase64(imageUrl);
        if (!dataUrl) return { imageType: null, reactionNeeded: null };
        
        // Analysiere Bildtyp (vereinfachte Version)
        const typeAnalysis = await client.chat.completions.create({
          model: AI_MODEL,
          messages: [
            {
              role: "system",
              content: "Du analysierst Bilder und kategorisierst sie. Antworte NUR als JSON im Format: {\"type\": \"penis\" | \"nude\" | \"face\" | \"body\" | \"other\", \"confidence\": 0.0-1.0}"
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Analysiere dieses Bild und kategorisiere es. Antworte NUR als JSON." },
                { type: "image_url", image_url: { url: dataUrl } }
              ]
            }
          ],
          max_tokens: 100,
          temperature: 0.1
        });
        
        const typeResult = typeAnalysis.choices?.[0]?.message?.content?.trim();
        if (typeResult) {
          const jsonMatch = typeResult.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return { imageType: parsed.type || null, reactionNeeded: parsed.type || null };
          }
        }
      } catch (err) {
        console.warn('⚠️ Bild-Analyse Fehler in Multi-Agent Pipeline:', err.message);
      }
      return { imageType: null, reactionNeeded: null };
    };
    
    // Wrapper-Funktion für Proactive-Analyse (nutzt bestehende Logik)
    const proactiveAnalysisFunc = async (allMessages, customerMessage) => {
      try {
        return detectStagnantConversation(allMessages, customerMessage);
      } catch (err) {
        console.warn('⚠️ Proactive-Analyse Fehler:', err.message);
        return { isStagnant: false, suggestions: [] };
      }
    };
    
    // Wrapper-Funktion für analyzeWritingStyle (nutzt bestehende Logik)
    const analyzeWritingStyleFunc = (allMessages) => {
      try {
        return analyzeWritingStyle(allMessages);
      } catch (err) {
        console.warn('⚠️ analyzeWritingStyle Fehler:', err.message);
        return null;
      }
    };
    
    // Wrapper-Funktion für isInfoMessage (nutzt bestehende Logik)
    const isInfoMessageFunc = (msg) => {
      try {
        return isInfoMessage(msg);
      } catch (err) {
        console.warn('⚠️ isInfoMessage Fehler:', err.message);
        return false;
      }
    };
    
    // Rufe Multi-Agent Pipeline auf (HAUPTWEG!)
    // WICHTIG: isASA und asaConversationContext wurden bereits oben definiert
    // Übergib alle geladenen Daten: Regeln, Training Data, Profil-Info, Chat-Kontext, Feedback-Daten
    multiAgentResults = await runMultiAgentPipeline({
      conversationHistory,
      customerMessage,
      profileInfo,
      extractedUserInfo: extractedInfo,
      allRules,
      trainingData, // 📚 Training Data für Training-Selector-Agent
      situations,
      imageUrl: imageUrlForPipeline,
      moderatorMessages: moderatorMessagesForPipeline,
      customerMessages: customerMessagesForPipeline,
      allMessages: messages,
      feedbackData, // 📊 Feedback-Daten für Learning-System
      vectorDbFunc,
      imageAnalysisFunc,
      proactiveAnalysisFunc,
      analyzeWritingStyleFunc,
      isInfoMessageFunc,
      isASA: isASACalculated, // 🤖 ASA-UNTERSTÜTZUNG: Übergib ASA-Flag (berechneter Wert)
      asaConversationContext: asaConversationContext, // 🤖 ASA-UNTERSTÜTZUNG: Übergib ASA-Kontext
      isLocationQuestionFunc: isLocationQuestion, // Helper-Funktion für Wohnort-Fragen
      findNearbyCityFunc: findNearbyCity, // Helper-Funktion für nahegelegene Städte
      isMeetingRequestFunc: isMeetingRequest // Helper-Funktion für Treffen-Erkennung
    });
    
    console.log('🤖 Multi-Agent Pipeline abgeschlossen (HAUPTWEG):', {
      context: multiAgentResults?.context?.topic || 'unknown',
      training: multiAgentResults?.training?.selectedExamples?.length || 0,
      style: multiAgentResults?.style?.style || 'neutral',
      mood: multiAgentResults?.mood?.mood || 'neutral',
      proactive: multiAgentResults?.proactive?.isStagnant || false,
      image: multiAgentResults?.image?.imageType || null,
      profile: multiAgentResults?.profile?.relevantInfo?.length || 0
    });
    console.log('🤖 Multi-Agent Pipeline Status:', multiAgentResults ? 'ERFOLGREICH' : 'FEHLGESCHLAGEN');
  } catch (err) {
    console.error('❌ Multi-Agent Pipeline Fehler (Fallback auf altes System):', err.message);
    console.error('❌ Multi-Agent Pipeline Stack:', err.stack);
    // Pipeline-Fehler blockiert nicht den Hauptprozess - altes System wird als Fallback verwendet
    multiAgentResults = null;
  }
  
  // 🤖 MULTI-AGENT PIPELINE erfolgreich - verwende Ergebnisse für Nachrichtengenerierung
  if (!multiAgentResults || multiAgentResults.blocked) {
    console.error('❌ Multi-Agent Pipeline fehlgeschlagen oder blockiert');
    const errorMsg = multiAgentResults?.error || 'Keine Ergebnisse verfügbar';
    return res.status(200).json({
      resText: errorMsg,
      replyText: errorMsg,
      summary: extractedInfo,
      chatId: chatId || finalChatId || "00000000",
      actions: [],
      flags: { blocked: true, reason: "pipeline_failed", isError: true, showError: true }
    });
  }
  
  // 🚨 SPEZIELLE FEHLERBEHANDLUNG: Wohnort-Frage ohne verfügbare Informationen
  if (multiAgentResults.situation?.locationQuestionError) {
    const locationError = multiAgentResults.situation.locationQuestionError;
    console.error('❌ Wohnort-Frage Fehler:', locationError.error);
    return res.status(400).json({
      error: locationError.error,
      message: locationError.message,
      requiresHumanModeration: locationError.requiresHumanModeration,
      customerCity: locationError.customerCity,
      fakeCity: locationError.fakeCity,
      summary: extractedInfo,
      chatId: chatId || finalChatId || "00000000"
    });
  }
  
  // 🤖 SCHRITT 12: MESSAGE-GENERATOR-AGENT - Generiere finale Nachricht
  let generatedMessage = "";
  try {
    const messageResult = await agentMessageGenerator(multiAgentResults, {
      conversationHistory: conversationContextForPipeline || "",
      customerMessage: foundMessageText || "",
      profileInfo: profileInfo || {},
      extractedUserInfo: extractedInfo,
      allRules: rules || {},
      isASA: isASACalculated,
      asaConversationContext: asaConversationContext || '',
      platformId: platformId || 'viluu'
    });
    
    if (messageResult.success && messageResult.message) {
      generatedMessage = messageResult.message;
      console.log(`✅ Message-Generator-Agent: Nachricht generiert (${generatedMessage.length} Zeichen)`);
    } else {
      console.error('❌ Message-Generator-Agent: Fehler beim Generieren:', messageResult.error || 'Unbekannter Fehler');
      generatedMessage = "";
    }
  } catch (err) {
    console.error('❌ Message-Generator-Agent: Exception:', err.message);
    generatedMessage = "";
  }
  
  // Wenn keine Nachricht generiert wurde, gebe Fehler zurück
  if (!generatedMessage || generatedMessage.trim() === "") {
    console.error('❌ Keine Nachricht generiert - Pipeline fehlgeschlagen');
    return res.status(200).json({
      resText: "❌ FEHLER: Konnte keine Antwort generieren. Bitte versuche es erneut.",
      replyText: "❌ FEHLER: Konnte keine Antwort generieren. Bitte versuche es erneut.",
      summary: extractedInfo,
      chatId: chatId || finalChatId || "00000000",
      actions: [],
      flags: { blocked: true, reason: "generation_failed", isError: true, showError: true }
    });
  }
  
  // ✅ ERFOLG: Nachricht wurde generiert - prüfe auf Treffen-Anfragen
  console.log(`✅ Nachricht erfolgreich generiert: "${generatedMessage.substring(0, 100)}${generatedMessage.length > 100 ? '...' : ''}"`);
  
  // 🚨 KRITISCH: Prüfe ob die generierte Nachricht ein Treffen vorschlägt (nicht erlaubt!)
  if (isMeetingRequest(generatedMessage, foundMessageText || "")) {
    console.error("🚨🚨🚨 KRITISCH: Generierte Antwort enthält Treffen-Anfrage - KEINE Antwort generieren! 🚨🚨🚨");
    return res.status(200).json({
      error: "❌ FEHLER: Die KI hat versucht, ein Treffen auszumachen. Das ist nicht erlaubt.",
      resText: "",
      replyText: "",
      summary: extractedInfo,
      chatId: chatId || finalChatId || "00000000",
      actions: [],
      flags: { blocked: true, reason: "meeting_request", isError: true, showError: true }
    });
  }
  
  // 📊 GOOGLE SHEETS: Speichere Nachricht in Google Sheets (asynchron, blockiert nicht)
  try {
    await writeToGoogleSheets({
      timestamp: new Date().toISOString(),
      platform: platformId || 'viluu',
      chatId: chatId || finalChatId || "00000000",
      isASA: isASACalculated || false,
      customerMessage: foundMessageText || "",
      aiResponse: generatedMessage
    });
  } catch (err) {
    // Nicht kritisch - Google Sheets ist optional
    console.warn('⚠️ Fehler beim Schreiben in Google Sheets (nicht kritisch):', err.message);
  }
  
  // WICHTIG: Variable Wartezeit zwischen 40-60 Sekunden für menschliches Tippen
  const minWait = 40;
  const maxWait = 60;
  const waitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
  
  // Validiere assetsToSend (falls vorhanden)
  const validAssets = validateAssets(assetsToSend || []);
  
  // 📊 FEEDBACK: Speichere generierte Nachricht im Feedback-System (asynchron, blockiert nicht)
  try {
    // Finde letzte Moderator-Nachricht für besseren Kontext
    const lastModeratorMessage = req.body?.siteInfos?.messages
      ?.filter(m => (m.type === "sent" || m.messageType === "sent") && !isInfoMessage(m))
      ?.slice(-1)?.[0]?.text || null;
    
    // 🚨 FIX: Entferne doppelte Felder und stelle sicher, dass customerMessage und aiResponse vorhanden sind
    const feedbackPayload = {
      chatId: chatId || finalChatId || "00000000",
      customerMessage: foundMessageText || "",
      aiResponse: generatedMessage,
      platform: platformId || 'viluu',
      isASA: isASACalculated || false,
      context: {
        detectedSituations: multiAgentResults?.situation?.detectedSituations || [],
        mood: multiAgentResults?.mood?.mood || 'neutral',
        style: multiAgentResults?.style?.style || 'neutral',
        topic: multiAgentResults?.context?.topic || 'allgemein'
      }
    };
    
    // 🚨 FIX: Nur hinzufügen, wenn wirklich vorhanden (verhindert doppelte Felder)
    if (lastModeratorMessage) {
      feedbackPayload.context.lastModeratorMessage = lastModeratorMessage;
    }
    
    // Asynchroner Aufruf - blockiert nicht die Antwort
    const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    fetch(`${baseUrl}/api/v1/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { 'Authorization': req.headers.authorization } : {})
      },
      body: JSON.stringify(feedbackPayload)
    }).then(response => {
      if (response.ok) {
        console.log('✅ Feedback-Eintrag erfolgreich erstellt');
      } else {
        console.warn('⚠️ Feedback-Eintrag konnte nicht erstellt werden:', response.status);
      }
    }).catch(err => {
      console.warn('⚠️ Fehler beim Erstellen des Feedback-Eintrags (nicht kritisch):', err.message);
    });
  } catch (err) {
    console.warn('⚠️ Fehler beim Vorbereiten des Feedback-Eintrags (nicht kritisch):', err.message);
  }
  
  return res.status(200).json({
    resText: generatedMessage,
    replyText: generatedMessage,
    summary: extractedInfo,
    chatId: chatId || finalChatId || "00000000",
    actions: [
      {
        type: "insert_and_send",
        delay: waitTime // Wartezeit in Sekunden (40-60 Sekunden variabel) für menschliches Tippen
      }
    ],
    assets: validAssets,
    flags: { 
      blocked: false, // WICHTIG: Immer false, damit Extension nicht neu lädt
      noReload: true, // Explizites Flag: Nicht neu laden
      skipReload: true, // Zusätzliches Flag für Rückwärtskompatibilität
      preventReload: true // Zusätzliches Flag für maximale Sicherheit
    },
    disableAutoSend: true, // WICHTIG: Verhindere automatisches Senden durch Extension - unsere Funktion übernimmt die Kontrolle
    waitTime: waitTime, // Zusätzliches Flag für Rückwärtskompatibilität
    noReload: true // Explizites Flag auf oberster Ebene
  });
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





