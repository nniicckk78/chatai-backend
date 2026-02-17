// @ts-nocheck
const express = require("express");
const { getClient, getMessageClient, getMessageModel } = require("../openaiClient");
const { verifyToken } = require("../auth");
const fs = require("fs");
const path = require("path");
const { writeToGoogleSheets } = require("../utils/google-sheets");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
const { buildSystemPrompt } = require("../utils/system-prompt");
const { selectSmartExamples, formatExamplesForPrompt } = require("../utils/smart-example-selector");
const { initializeVectorDb } = require("../utils/vector-db");
const { getLearningStats, generateCompactLearningContext } = require("../utils/learning-system");
const { runSimplifiedPipeline, runMultiAgentPipeline, runMultiStagePipeline, agentFirstMessageDetector } = require("../utils/multi-agent"); // 🚀 Multi-Stage Pipeline (kein Fallback zu agentMessageGenerator)
const { runGrokPipeline, detectSituationsWithLLM } = require("../utils/grok-pipeline"); // 🚀 Grok-Pipeline (ASA, Erstnachricht, Stadt, normale Reply + LLM-Situationserkennung)
const router = express.Router();

const USE_GROK_PIPELINE = process.env.USE_GROK_PIPELINE === "true" || process.env.USE_GROK_PIPELINE === "1";

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
              "Treffen/Termine": "Du bist immer die Moderatorin/das Fake-Profil – NIEMALS ein Treffen vorschlagen (z.B. 'dann können wir uns mal treffen', 'auf einen Kaffee treffen', 'können wir uns ja mal treffen')! NIEMALS zustimmen oder einen Termin ausmachen! NIEMALS 'Ich wäre gerne bereit' oder 'Ich bin bereit' – klingt wie Zusage. Sage stattdessen 'Ich könnte es mir vorstellen' oder 'Ich würde gerne wissen, wie du es dir vorstellst'. Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, aber weiche aus – weder zusagen noch selbst vorschlagen.",
              "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben. NIEMALS das Wort 'Credits' verwenden! Orientiere dich an den Training-Daten-Beispielen für Geld/Coins - diese zeigen, wie man natürlich darauf reagiert, ohne das Wort 'Credits' zu verwenden.",
              "Kontaktdaten außerhalb der Plattform": "Kunde will Nummer/WhatsApp/Telegram/Instagram teilen oder außerhalb schreiben. Orientiere dich an den Training-Daten – dort ist gezeigt, wie man persönlich ausweicht. VERBOTEN an den Kunden: 'nicht erlaubt', 'Regeln', 'Plattform', 'echte Kontaktdaten verboten/dürfen nicht' – klingt nach System-Regel; nur persönlich ausweichen (z.B. Nummer nicht so schnell rausgeben, erst hier schreiben).",
              "Romantik / Verliebtheit": "Antworte warm, romantisch und flirty. Gehe auf die emotionale Bindung und Verliebtheit ein. Keine expliziten sexuellen Formulierungen – der Kunde drückt Gefühle aus, nicht eine Aufforderung zu sexuellen Handlungen. Orientiere dich an den Training-Daten-Beispielen unter Allgemein.",
              "Verärgerte/saure Kunden": "Kunde wirkt wütend, sauer, frustriert oder ablehnend (z.B. Stinkefinger-Emojis 🖕, Beleidigungen, aggressiver Ton). Reagiere MENSCHLICH und deeskalierend: frage nach dem Grund (Was ist los? Was habe ich falsch gemacht? Warum bist du sauer?). KEINE sexuellen Formulierungen, KEINE Flirt- oder Lust-Antworten. Einfühlsam und sachlich nachfragen, nicht sexualisieren."
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
          "Treffen/Termine": "Du bist immer die Moderatorin/das Fake-Profil – NIEMALS ein Treffen vorschlagen (z.B. 'dann können wir uns mal treffen', 'auf einen Kaffee treffen')! NIEMALS zustimmen oder Termin ausmachen. Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, weiche aus – weder zusagen noch selbst vorschlagen.",
          "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben.",
          "Romantik / Verliebtheit": "Antworte warm, romantisch und flirty. Gehe auf die emotionale Bindung und Verliebtheit ein. Keine expliziten sexuellen Formulierungen – der Kunde drückt Gefühle aus. Orientiere dich an den Training-Daten-Beispielen unter Allgemein.",
          "Verärgerte/saure Kunden": "Kunde wirkt wütend, sauer, frustriert oder ablehnend (z.B. Stinkefinger 🖕, Beleidigungen, aggressiver Ton). Reagiere MENSCHLICH und deeskalierend: frage nach dem Grund (Was ist los? Was habe ich falsch gemacht?). KEINE sexuellen Formulierungen. Einfühlsam nachfragen, nicht sexualisieren."
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
      "Treffen/Termine": "Du bist immer die Moderatorin/das Fake-Profil – NIEMALS ein Treffen vorschlagen (z.B. 'dann können wir uns mal treffen', 'auf einen Kaffee treffen')! NIEMALS zustimmen oder Termin ausmachen. Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, weiche aus – weder zusagen noch selbst vorschlagen.",
      "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben.",
      "Romantik / Verliebtheit": "Antworte warm, romantisch und flirty. Gehe auf die emotionale Bindung und Verliebtheit ein. Keine expliziten sexuellen Formulierungen – der Kunde drückt Gefühle aus. Orientiere dich an den Training-Daten-Beispielen unter Allgemein.",
      "Verärgerte/saure Kunden": "Kunde wirkt wütend, sauer, frustriert oder ablehnend (z.B. Stinkefinger-Emojis 🖕, Beleidigungen, aggressiver Ton, kurze negative Nachrichten). Reagiere MENSCHLICH und deeskalierend: frage nach dem Grund (Was ist los? Was habe ich falsch gemacht? Warum bist du sauer?). KEINE sexuellen Formulierungen, KEINE Flirt- oder Lust-Antworten – bei so einem Ton wäre das unpassend. Einfühlsam und sachlich nachfragen, nicht sexualisieren."
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

/**
 * 🚨 NEU: Entferne Grußformeln am Ende der Nachricht (Kuss, Küsse, Busi, etc.)
 * Diese sind wie Emojis - nicht der Hauptinhalt, sondern nur Höflichkeitsformeln
 * Beispiel: "Ich habe heute nichts vor ich bin gerade auf der arbeit und du?Tausend Küsse"
 * → "Ich habe heute nichts vor ich bin gerade auf der arbeit und du?"
 */
function removeGreetingWordsAtEnd(message) {
  if (!message || typeof message !== 'string') return message;
  
  const trimmed = message.trim();
  if (trimmed.length === 0) return message;
  
  // Liste von Grußformeln, die am Ende ignoriert werden sollen
  const greetingPatterns = [
    /\s*kuss\s*$/i,
    /\s*küsse\s*$/i,
    /\s*tausend\s*küsse\s*$/i,
    /\s*viele\s*küsse\s*$/i,
    /\s*busi\s*$/i,
    /\s*bussi\s*$/i,
    /\s*küsschen\s*$/i,
    /\s*liebe\s*grüße\s*$/i,
    /\s*lg\s*$/i,
    /\s*liebe\s*grüß\s*$/i
  ];
  
  let cleaned = trimmed;
  let changed = false;
  
  // Entferne Grußformeln am Ende (mehrfach, falls mehrere vorhanden)
  for (let i = 0; i < 10; i++) { // Max. 10 Iterationen (Sicherheit)
    let found = false;
    for (const pattern of greetingPatterns) {
      if (pattern.test(cleaned)) {
        cleaned = cleaned.replace(pattern, '').trim();
        found = true;
        changed = true;
        break;
      }
    }
    if (!found) break; // Keine weiteren Grußformeln gefunden
  }
  
  if (changed) {
    console.log(`🧹 Grußformeln am Ende entfernt: "${trimmed.substring(Math.max(0, trimmed.length - 50))}" → "${cleaned.substring(Math.max(0, cleaned.length - 50))}"`);
  }
  
  return cleaned || message; // Fallback: Wenn alles entfernt wurde, gib Original zurück
}

// Prüfe auf KI-Check-Codes in Kundennachrichten
// FPC hat einen KI-Check eingebaut, der Codes in Nachrichten einbettet
// 🚨 FIX: Verwende die zentrale Funktion aus safety-agent.js statt Duplikat
// Importiere checkKICheckMessage aus safety-agent.js
const { checkKICheckMessage } = require('../utils/safety-agent');

function isKICheckMessage(text) {
  // Verwende die zentrale Funktion aus safety-agent.js
  return checkKICheckMessage(text);
}

/**
 * @param {object} [options] - Optional: { moderatorName, moderatorAge }
 *   Wenn gesetzt: Name/Alter des Fake-Profil (Chat-Partner). Diese dürfen NICHT als Kundendaten extrahiert werden,
 *   wenn der Kunde sie in Bezug auf das Gegenüber erwähnt (z.B. "Die 20 jährige Nancy will es haben").
 */
async function extractInfoFromMessage(client, messageText, options = {}) {
  if (!client || !messageText) return { user: {}, assistant: {} };

  const moderatorName = options.moderatorName && String(options.moderatorName).trim() ? String(options.moderatorName).trim() : null;
  const moderatorAge = options.moderatorAge != null && !isNaN(Number(options.moderatorAge)) ? Number(options.moderatorAge) : null;

  try {
    let contextBlock = '';
    if (moderatorName || moderatorAge != null) {
      contextBlock = `\n🚨 KONTEXT – NICHT ALS KUNDE EXTRAHIEREN:\nDer Chat-Partner (das Profil, dem der Kunde schreibt) heißt${moderatorName ? ` "${moderatorName}"` : ''}${moderatorAge != null ? ` und ist ${moderatorAge} Jahre alt` : ''}. Wenn in der Nachricht nur dieser Name oder dieses Alter in Bezug auf die ANDERE Person vorkommt (z.B. "Die 20 jährige Nancy will es haben", "Nancy ist süß"), extrahiere das NICHT als Kundendaten – das sind Bezugnahmen auf den Chat-Partner. Dann Name: null, Age: null für den Kunden. Extrahiere nur Infos, die sich eindeutig auf den KUNDEN (Autor der Nachricht) beziehen.\n\n`;
    }

    const extractionPrompt = `Analysiere die folgende Nachricht und extrahiere ALLE relevanten Informationen über den Kunden für das Logbuch.${contextBlock}
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
    "Updates": "Aktualisierungen/Neuigkeiten NUR bei klarer Aussage (z.B. 'geht zum Friseur', 'hat neuen Job', 'ist umgezogen', 'hat Urlaub', 'ist krank'). 'Hat Auto gekauft' NUR wenn der Kunde explizit sagt, er habe ein Auto gekauft – vage Auto-Erwähnungen (z.B. 'wau ins Auto', 'was mit Auto') NICHT als Updates, sonst null",
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
- Relevante Neuigkeiten/Aktivitäten NUR bei klarer Aussage (z.B. "geht zum Friseur", "hat Urlaub", "ist umgezogen", "ist krank", "hat neuen Job"). "Hat Auto gekauft" NUR bei expliziter Kaufaussage – vage Erwähnungen wie "ins Auto", "was mit Auto" NICHT als Updates
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
- Updates: NUR wenn der Kunde eine Neuigkeit klar formuliert (z.B. "hat Urlaub", "ist krank", "geht zum Friseur", "hat neuen Job"). "Hat Auto gekauft" NUR wenn er ausdrücklich sagt, er habe ein Auto gekauft – unklare Sätze wie "wau ins Auto" oder "was mit Auto" NICHT als "hat Auto gekauft"
- Andere wichtige Infos: Wenn andere nützliche Infos erwähnt werden (z.B. Auto, Haustiere, Musik, Filme, Essen, Trinken, Tattoos, Piercings, Rauchen, Eltern, Geschwister), extrahiere sie als "Other"
- Single/Geschlecht: Wenn erwähnt (z.B. "ich bin Single", "ich bin männlich"), extrahiere es als "Family" oder "Other"

WICHTIG: 
- Extrahiere ALLE nützlichen Informationen, nicht nur die vordefinierten Felder!
- Verwende "Other" für wichtige Infos, die nicht in andere Kategorien passen!
- Auch wenn die Informationen in einer Liste oder strukturierten Form stehen (z.B. "Thomas Hinz Rather Broich Düsseldorf 40472"), extrahiere Name und Wohnort getrennt!
- Extrahiere NUR NEUE Informationen - ignoriere Wiederholungen von bereits bekannten Infos!

TELEFONNUMMER/KONTAKTDATEN – NUR in diesem Fall eintragen: Wenn in der Nachricht tatsächlich eine Telefonnummer, E-Mail oder Adresse vom Kunden steht und von der Plattform zensiert wird (z.B. als *** oder ***** sichtbar). Dann unter Other: "Telefonnummer bekannt" bzw. "E-Mail bekannt" oder "Kontaktdaten bekannt". NICHT eintragen: Wenn der Kunde nur WhatsApp/Telegram/Instagram erwähnt oder fragt ob man woanders schreiben will ("Können wir auf WhatsApp kommunizieren", "schreib mir auf WhatsApp") – das ist keine geteilte Nummer, also weder "Telefonnummer bekannt" noch "Kontaktdaten bekannt".

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

      // Sicherheitsnetz: Extrahierten Namen/Alter entfernen, wenn es dem Fake-Profil entspricht (Kunde hat uns gemeint, nicht sich selbst)
      if (moderatorName && cleanUser.Name) {
        const a = String(cleanUser.Name).trim().toLowerCase();
        const b = moderatorName.trim().toLowerCase();
        if (a === b || a.includes(b) || b.includes(a)) {
          delete cleanUser.Name;
          if (moderatorAge != null && cleanUser.Age === moderatorAge) delete cleanUser.Age;
        }
      }

      // Zensierte Telefonnummer/Kontaktdaten: Plattform zeigt *** – im Logbuch "Telefonnummer bekannt" eintragen, nicht die Sternfolge
      Object.keys(cleanUser).forEach(key => {
        const v = cleanUser[key];
        if (typeof v === "string" && v.trim()) {
          let s = v;
          // "Telefonnummer: ***", "Telefonnummer: ***kannst anrufen", "Telefonnummer ***" etc. → "Telefonnummer bekannt"
          s = s.replace(/\bTelefonnummer\s*:\s*[\*\.]+\s*/gi, "Telefonnummer bekannt. ");
          s = s.replace(/\bTelefonnummer\s+[\*\.]+\s*/gi, "Telefonnummer bekannt. ");
          s = s.replace(/\s+/g, " ").trim();
          if (s) cleanUser[key] = s;
        }
      });

      // "Telefonnummer bekannt" / "Kontaktdaten bekannt" nur behalten, wenn in der Nachricht tatsächlich zensierte Daten (***) vorkommen – nicht bei bloßer WhatsApp-Erwähnung
      const hasCensoredContactInMessage = /[\*\.]{2,}/.test(messageText || "");
      ["Other", "Updates"].forEach(key => {
        const v = cleanUser[key];
        if (typeof v === "string" && v.trim() && !hasCensoredContactInMessage) {
          let s = v.replace(/\b(Telefonnummer|E-Mail|Kontaktdaten)\s+bekannt\b/gi, "").trim().replace(/\s*[,.]\s*[,.]/g, ",").replace(/^[,.\s]+|[,.\s]+$/g, "");
          if (s) cleanUser[key] = s; else delete cleanUser[key];
        }
      });

      // "Hat Auto gekauft" nur behalten, wenn die Nachricht explizit einen Kauf erwähnt – nicht bei vager Auto-Erwähnung
      const updatesVal = cleanUser.Updates;
      if (typeof updatesVal === "string" && /auto\s*gekauft|hat\s+auto\s+gekauft/i.test(updatesVal) && !/\bgekauft\b|\bgekauft\s*(habe?|hat|hätte?)/i.test(messageText || "")) {
        const cleaned = updatesVal.replace(/\b(hat\s+)?[Aa]uto\s+gekauft\b\.?/gi, "").trim().replace(/\s*[,.]\s*[,.]/g, ",").replace(/^[,.\s]+|[,.\s]+$/g, "");
        if (cleaned) cleanUser.Updates = cleaned; else delete cleanUser.Updates;
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

/** Extrahiert Fake-/Moderator-Infos aus der generierten Antwort fürs Logbuch (FPC/AVZ). */
async function extractAssistantInfoFromGeneratedMessage(client, generatedMessage) {
  if (!client || !generatedMessage || typeof generatedMessage !== "string") return {};
  const text = generatedMessage.trim();
  if (!text) return {};
  try {
    const extractionPrompt = `Analysiere die folgende Nachricht. Es ist die ANTWORT des Assistenten/Fake-Profils an den Kunden.
Extrahiere ALLE Informationen, die der Assistent über SICH SELBST preisgibt (Fake-Profil), für das Logbuch.
Antworte NUR mit gültigem JSON, kein zusätzlicher Text. Format:
{
  "Name": "NUR der Vorname/Kosename der Fake-Person (z.B. 'Alana'), NIEMALS Benutzername oder Plattform-ID (z.B. '3176intrigieren') – der Kunde sieht das Logbuch, sonst null",
  "Stadt": "Wohnort/Stadt falls erwähnt (z.B. 'Köln'), sonst null",
  "Wohnort": "wie Stadt",
  "Work": "Beruf/Arbeit falls erwähnt, sonst null",
  "Beruf": "wie Work",
  "Sport and Hobbies": "NUR echte Sportarten und Hobbys (z.B. Wandern, Fitness, Musik, Filme, Serien, Lesen, Kochen als Hobby), sonst null",
  "Beziehungsstatus": "z.B. Single, verheiratet, Freundin erwähnt, sonst null",
  "Family": "wie Beziehungsstatus",
  "Health": "NUR allgemeine Gesundheit (z.B. Krankheit, Zahnarzt). NICHT: Schmerzen/Klo-Abneigung im sexuellen Kontext – die gehört unter Sexual Preferences, sonst null",
  "Sexual Preferences": "Sexuelle Vorlieben und TABUS der Fake-Person (z.B. 'mag Anal', 'mag keine Schmerzen', 'nichts was ins Klo gehört'). Wenn sie beides sagt (Schmerzen + Klo), EIN Eintrag: 'Mag keine Schmerzen oder Sachen die ins Klo gehören'. Keine Aufteilung in Health/Other – alles Sexuelle hier, sonst null",
  "Other": "NUR Sonstige Infos, die die Fake-Person über SICH SELBST sagt (Termine wie 'morgen Zahnarzt', 'heute was mit Freundin'). NICHT: sexuelle Tabus/Vorlieben (→ Sexual Preferences), NICHT was der KUNDE über sich sagt, sonst null"
}

WICHTIG:
- Nur Infos über den ASSISTENTEN/die Fake-Person extrahieren, nicht über den Kunden.
- \"Name\": Immer NUR Vorname/Kosename (z.B. Alana). Kein Benutzername, keine Plattform-ID – der Kunde darf das nicht sehen.
- \"Sexual Preferences\": Alle sexuellen Vorlieben/Tabus (z.B. mag Anal, mag keine Schmerzen, nichts mit Klo). Bei \"mag keine Schmerzen und die Dinge die ins Klo gehören\" → EIN Eintrag: \"Mag keine Schmerzen oder Sachen die ins Klo gehören\". NICHT unter Health oder Other.
- \"Health\": Nur echte Gesundheit (Krankheit, Arzt). Schmerzen-Abneigung im Sex-Kontext → Sexual Preferences.
- \"Other\": NUR Sonstiges, keine sexuellen Inhalte (Klo/Schmerzen im Tabu-Kontext → Sexual Preferences). Was die Fake-Person über SICH mitteilt. Echo vom Kunden (z.B. Wohnmobil, Reise) NICHT eintragen.
- Wohnort/Stadt NUR unter Stadt/Wohnort, NICHT unter Other.
- \"Sport and Hobbies\": NUR echte Sportarten/Hobbys, keine Essensvorlieben.
- Kurze Hinweise extrahieren: Zahnarzt, mit Freundin unterwegs, wohne in Berlin, arbeite als Lehrerin.
- Wenn nichts Relevantes steht, leeres Objekt {} oder alle null.

Nachricht des Assistenten:\n${text.substring(0, 3000)}`;

    const extraction = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "Du bist ein Daten-Extraktions-Assistent. Antworte NUR mit gültigem JSON, kein zusätzlicher Text." },
        { role: "user", content: extractionPrompt }
      ],
      max_tokens: 400,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });

    const raw = extraction.choices?.[0]?.message?.content?.trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    const keys = ["Name", "Stadt", "Wohnort", "Work", "Beruf", "Sport and Hobbies", "Beziehungsstatus", "Family", "Health", "Sexual Preferences", "Other"];
    for (const key of keys) {
      const v = parsed[key];
      if (v !== null && v !== undefined && v !== "") {
        try {
          if (typeof v === "string" && v.trim()) out[key] = v.trim();
          else if (typeof v === "number") out[key] = v;
        } catch (e) { /* skip */ }
      }
    }
    if (out.Wohnort && !out.Stadt) out.Stadt = out.Wohnort;
    if (out.Beruf && !out.Work) out.Work = out.Beruf;
    if (out.Family && !out.Beziehungsstatus) out.Beziehungsstatus = out.Family;
    // Sport and Hobbies: keine Essens-/Gewürzvorlieben (z.B. "mag es würzig") – unwichtige Infos nicht eintragen
    const sportKey = "Sport and Hobbies";
    if (out[sportKey] && typeof out[sportKey] === "string") {
      const v = out[sportKey].trim().toLowerCase();
      const isFoodPreference = /\b(würzig|würze|gewürz|knoblauch|scharf|schärfe|mag es wenn|mag es, wenn|kochen mit|kocht mit|essen.*mag|vorlieben.*essen)\b/i.test(v)
        || (v.length < 60 && /würzig|gewürz|knoblauch|scharf|mag es wenn/i.test(v));
      if (isFoodPreference) delete out[sportKey];
    }
    return out;
  } catch (err) {
    console.warn("⚠️ extractAssistantInfoFromGeneratedMessage:", err.message);
    return {};
  }
}

/** Prüft, ob Text sexual-taboo-relevant ist (Schmerzen, Klo im sexuellen Kontext). */
function isSexualTabooContent(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim().toLowerCase();
  return /\b(schmerzen|schmerz)\b/.test(t) || /\b(klo|ins klo|was mit dem klo|mit dem klo zu tun)\b/.test(t) || /\bmag\s+(alles\s+)?(was\s+)?(mit\s+)?dem\s+klo\b/i.test(t) || /\bkann\s+schmerzen\s+nicht\b/i.test(t);
}

/** FPC/AVZ: Health/Other des Fake von Schmerzen/Klo-Tabu bereinigen und in Sexual Preferences zusammenführen; bei Bedarf auch beim Kunden eintragen. */
function mergeSexualTabooIntoPreferences(extractedInfo) {
  const a = extractedInfo?.assistant;
  if (!a || typeof a !== "object") return;
  const combinedEntry = "Mag keine Schmerzen oder Sachen die ins Klo gehören";
  let hasPain = isSexualTabooContent(a.Health);
  let hasKlo = isSexualTabooContent(a.Other);
  if (!hasPain && !hasKlo) return;
  // Aus Health/Other entfernen und in Sexual Preferences eintragen
  if (hasPain) {
    delete a.Health;
  }
  if (hasKlo) {
    const otherVal = (a.Other || "").trim();
    const cleaned = otherVal
      .replace(/\bmag\s+(alles\s+)?(was\s+)?(mit\s+)?(dem\s+)?klo\s+(zu\s+tun\s+)?(hat\s+)?(nicht|nix)\b/gi, "")
      .replace(/\b(alles\s+)?(was\s+)?(mit\s+)?(dem\s+)?klo\s+(zu\s+tun\s+)?(hat\s+)?(nicht|nix)\b/gi, "")
      .replace(/\s*,\s*,/g, ",").replace(/^[\s,]+|[\s,]+$/g, "").trim();
    if (cleaned) a.Other = cleaned; else delete a.Other;
  }
  const existing = (a["Sexual Preferences"] || "").trim();
  const alreadyHas = existing && (existing.toLowerCase().includes("schmerzen") && existing.toLowerCase().includes("klo"));
  a["Sexual Preferences"] = alreadyHas ? existing : (existing ? `${existing}; ${combinedEntry}` : combinedEntry);
  // Dasselbe beim Kunden eintragen (Fake hat Tabu genannt → Kunde mag das auch nicht)
  extractedInfo.user = extractedInfo.user || {};
  const userExisting = (extractedInfo.user["Sexual Preferences"] || "").trim();
  const userAlreadyHas = userExisting && (userExisting.toLowerCase().includes("schmerzen") && userExisting.toLowerCase().includes("klo"));
  extractedInfo.user["Sexual Preferences"] = userAlreadyHas ? userExisting : (userExisting ? `${userExisting}; ${combinedEntry}` : combinedEntry);
}

/** Fürs Fake-Logbuch: Nur Anzeigename (z.B. "Alana"), nie Benutzername/Plattform-ID (z.B. "3176intrigieren"). Der Kunde sieht das Logbuch. */
function toFakeDisplayNameOnly(fullName) {
  if (!fullName || typeof fullName !== "string") return fullName || "";
  let s = fullName.trim();
  // ", 57 Single" / ", 60 Single" etc. entfernen
  s = s.replace(/,?\s*\d+\s*(Single|Verheiratet|Geschieden|etc\.?)?\s*$/i, "").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fullName.trim();
  // Ersten "Benutzernamen"-Teil überspringen (enthält Ziffern oder wirkt wie ID)
  const namePart = parts.find(p => !/\d/.test(p) && p.length <= 30);
  if (namePart) return namePart;
  // Fallback: erstes Token ohne Ziffern oder ganzes letztes Wort
  const last = parts[parts.length - 1];
  if (last && !/\d/.test(last)) return last;
  return parts[0] || fullName.trim();
}

/** True, wenn der String wie ein Plattform-Benutzername wirkt (z.B. "SchwarzeDom", "Arbeitsamgut", "Verbheiss"), nicht wie ein Vorname/Anzeigename. */
function looksLikeUsername(name) {
  if (!name || typeof name !== "string") return false;
  const s = name.trim();
  if (s.includes(" ")) return false; // "Dominika" vs "SchwarzeDom Dominika" – nur ein Wort kann Username sein
  // CamelCase (z.B. SchwarzeDom) oder Mischung Groß/Klein ohne Leerzeichen
  if (/[a-z][A-Z]|[A-Z][a-z].*[A-Z]/.test(s)) return true;
  if (/\d/.test(s)) return true;
  // Ein-Wort-Benutzernamen oft lang (z.B. Arbeitsamgut = 12); typische Vornamen meist ≤11 Zeichen
  if (s.length >= 12) return true;
  // Zusammengesetzte/Fantasie-Wörter wie Verbheiss, Arbeitsamgut (≥8 Zeichen, kein typischer Vorname)
  if (s.length >= 8 && /[a-z]{2,}[b-df-hj-np-tv-z][e]|[ei]{2,}[a-z]|ss$/i.test(s)) return true;
  return false;
}

/** Prüft, ob Text wie Fake-/KI-Inhalt wirkt (Erste Person an Kunde gerichtet oder volle Chat-Nachricht). Solche Texte gehören ins Fake-Logbuch (assistant.Other), nie ins Kunden-Logbuch (user.Other). */
function looksLikeFakeOrAIContent(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (t.length > 200) return true;
  if (/\b(danke\s+dass\s+du|mach\s+mich\s+(total\s+)?an|mein\s+Schatz|macht\s+mich|feuchter|Muschi\s+pocht|Schatz\s*\?|erzähl\s+(endlich|mir)|für\s+dich|Vorfreude|Frechdachs|😘|😏|Ich\s+bin\s+auch|Ich\s+habe\s+ein|Ich\s+wohne|Ich\s+arbeite|finde\s+mich\s+toll|super\s+toll|anstellen\s+würdest|pulsiert)\b/i.test(t)) return true;
  return false;
}

// Fallback: Baue Summary aus metaData (customerInfo / moderatorInfo), falls Extraktion nichts liefert
function buildSummaryFromMeta(metaData) {
  if (!metaData || typeof metaData !== "object") return { user: {}, assistant: {} };
  const summary = { user: {}, assistant: {} };

  const customer = metaData.customerInfo || {};
  const moderator = metaData.moderatorInfo || {};

  // Kunde: Sonstiges NUR Infos vom Kunden (z. B. "hat Auto gekauft"). NIEMALS KI-/Fake-Nachricht – die gehört ins Fake-Logbuch.
  if (customer.name) summary.user["Name"] = customer.name;
  if (customer.birthDate?.age) summary.user["Age"] = customer.birthDate.age;
  if (customer.city) summary.user["Wohnort"] = customer.city;
  if (customer.occupation) summary.user["Work"] = customer.occupation;
  if (customer.hobbies) summary.user["Sport and Hobbies"] = customer.hobbies;
  if (customer.relationshipStatus) summary.user["Family"] = customer.relationshipStatus;
  if (customer.health) summary.user["Health"] = customer.health;
  if (customer.rawText && !looksLikeFakeOrAIContent(customer.rawText)) summary.user["Other"] = customer.rawText;
  if (customer.sexualPreferences) summary.user["Sexual Preferences"] = customer.sexualPreferences;

  // Fake/Moderator – Name nur Anzeigename (z.B. Fatima, Alana), nie Benutzername (z.B. Verbheiss). Immer firstName bevorzugen.
  const modName = moderator.firstName || moderator.name;
  if (modName) {
    const display = toFakeDisplayNameOnly(modName);
    if (display && !looksLikeUsername(display)) summary.assistant["Name"] = display;
  }
  if (moderator.birthDate?.age) summary.assistant["Age"] = moderator.birthDate.age;
  if (moderator.city) summary.assistant["Wohnort"] = moderator.city;
  if (moderator.occupation) summary.assistant["Work"] = moderator.occupation;
  if (moderator.hobbies) summary.assistant["Sport and Hobbies"] = moderator.hobbies;
  if (moderator.rawText) summary.assistant["Other"] = moderator.rawText;
  if (moderator.sexualPreferences) summary.assistant["Sexual Preferences"] = moderator.sexualPreferences;

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

// Bild als Base64 laden (max ~3MB). data: URLs werden unverändert zurückgegeben (z. B. von Extension/AVZ).
async function fetchImageAsBase64(url) {
  try {
    if (url && typeof url === "string" && url.startsWith("data:")) {
      if (url.length > 4 * 1024 * 1024) {
        console.warn("fetchImageAsBase64: Data-URL zu groß, übersprungen");
        return null;
      }
      return url;
    }
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

// Hilfsfunktion: Hat das Fake-Profil/Logbuch bereits einen Wohnort? Dann keinen zweiten eintragen.
function fakeHasWohnortAlready(profileInfo, extractedInfo) {
  const modCity = profileInfo?.moderatorInfo?.city && String(profileInfo.moderatorInfo.city).trim();
  if (modCity && modCity.toLowerCase() !== 'sag ich später') return true;
  const asst = extractedInfo?.assistant;
  if (asst && (asst.Wohnort || asst.Stadt)) {
    const w = String(asst.Wohnort || asst.Stadt || '').trim();
    if (w) return true;
  }
  return false;
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
    /\b(wo|woher)\s+(kommst|kommst du)\s+(du|denn)\s+(denn\s+)?(her|hergekommen)\b/i,
    // Erweiterte Erkennung: "welcher Ort", "Ort in der Nähe", "wo ist/liegt"
    /\bwelcher\s+ort\b/i,
    /\bort\s+(in\s+der\s+)?nähe\b/i,
    /\bda\s+in\s+der\s+nähe\b/i,
    /\bwo\s+ist\s+(denn\s+)?/i,
    /\bwo\s+liegt\s+(denn\s+)?/i,
    /\bwo\s+(ist|liegt)\s+\w+/i
  ];
  return locationPatterns.some(pattern => pattern.test(lower));
}

/** Ersetzt den Namen aus einem ASA-Beispiel am Anfang der Nachricht durch den echten Kundennamen (z.B. "Alex warum meldest" → "Leyla warum meldest"). */
function replaceASABeispielNameWithCustomer(message, customerName) {
  if (!message || typeof message !== 'string' || !customerName || typeof customerName !== 'string') return message;
  const name = customerName.trim();
  if (!name) return message;
  const trimmed = message.trim();
  return trimmed.replace(/^\s*(\w+)(\s*,?\s*)(warum|wieso|meldest|melde)/i, (fullMatch, exampleName, sep, word) =>
    exampleName.toLowerCase() === name.toLowerCase() ? fullMatch : name + sep + word
  );
}

// Bundesländer (keine Städtenamen) – wenn Fallback/API das liefert, stattdessen Eingabe-Stadt oder null
const BUNDESLAENDER_NAMES = new Set(['brandenburg', 'bayern', 'baden-württemberg', 'baden-wuerttemberg', 'berlin', 'bremen', 'hamburg', 'hessen', 'niedersachsen', 'nordrhein-westfalen', 'nrw', 'rheinland-pfalz', 'saarland', 'sachsen', 'sachsen-anhalt', 'schleswig-holstein', 'thüringen', 'thueringen', 'mecklenburg-vorpommern']);

function sanitizeCityResult(result, inputCity) {
  if (!result || typeof result !== 'string') return result;
  const r = result.trim().toLowerCase();
  if (BUNDESLAENDER_NAMES.has(r) || [...BUNDESLAENDER_NAMES].some(b => r === b || r.includes(b))) {
    const firstPart = (inputCity || '').split(/[\s,]+/)[0]?.trim();
    if (firstPart && firstPart.length >= 2) return firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
    return null;
  }
  return result.trim();
}

// Hilfsfunktion: Finde eine Stadt im 20km Umkreis per OpenAI (Fallback wenn OSM/Liste scheitern)
async function findNearbyCityViaLLM(client, model, customerCity) {
  if (!client || !customerCity || typeof customerCity !== 'string') return null;
  const messageModel = model || AI_MODEL;
  try {
    const res = await client.chat.completions.create({
      model: messageModel,
      messages: [
        {
          role: 'system',
          content: 'Du bist ein Helfer für Städte in Deutschland, Österreich und der Schweiz. Gegeben der Wohnort oder Stadtteil eines Kunden, nenne genau EINE Stadt in DACH, die maximal ca. 20–30 km entfernt liegt (für ein plausibles Dating-Profil). Antworte NUR mit dem Städtenamen, kein Satz, keine Anführungszeichen, keine Erklärung. Beispiel: Bei "Hamburg" oder "Niendorf" → z.B. Lübeck oder Kiel.'
        },
        { role: 'user', content: `Kunden-Wohnort: ${customerCity.trim()}\nNenne genau eine nahegelegene Stadt (nur der Name):` }
      ],
      max_tokens: 80,
      temperature: 0.3
    });
    const text = (res?.choices?.[0]?.message?.content || '').trim();
    if (!text) return null;
    const cityName = text.replace(/^["']|["']$/g, '').split(/[\n,.]/)[0].trim();
    if (cityName.length < 2 || cityName.length > 50) return null;
    console.log(`✅ Stadt via OpenAI gefunden: "${cityName}" (für "${customerCity}")`);
    return cityName;
  } catch (err) {
    console.warn('⚠️ findNearbyCityViaLLM Fehler:', err?.message || err);
    return null;
  }
}

// Hilfsfunktion: Finde eine Stadt im 20km Umkreis
// Reihenfolge: 1) OpenStreetMap API, 2) statische Liste, 3) optional OpenAI-Fallback
async function findNearbyCity(customerCity, opts = {}) {
  if (!customerCity || typeof customerCity !== 'string') return null;
  
  let city = customerCity.trim().toLowerCase();
  
  // 🆕 Normalisierung: Stadtteile/Bezirke → übergeordnete Stadt (z. B. "Niendorf, Eimsbüttel" → Hamburg)
  const districtToCity = {
    'niendorf': 'hamburg', 'eimsbüttel': 'hamburg', 'altona': 'hamburg', 'st. pauli': 'hamburg', 'st pauli': 'hamburg',
    'wandsbek': 'hamburg', 'harburg': 'hamburg', 'bergedorf': 'hamburg', 'blankenese': 'hamburg', 'barmbek': 'hamburg',
    'winterhude': 'hamburg', 'uhlenhorst': 'hamburg', 'eppendorf': 'hamburg', 'stellingen': 'hamburg', 'lurup': 'hamburg',
    'ottensen': 'hamburg', 'lokstedt': 'hamburg', 'schnelsen': 'hamburg', 'rissen': 'hamburg', 'osdorf': 'hamburg',
    'mitte': 'berlin', 'prenzlauer berg': 'berlin', 'friedrichshain': 'berlin', 'kreuzberg': 'berlin', 'charlottenburg': 'berlin',
    'schöneberg': 'berlin', 'wedding': 'berlin', 'neukölln': 'berlin', 'treptow': 'berlin', 'zehlendorf': 'berlin',
    'spandau': 'berlin', 'reinickendorf': 'berlin', 'marzahn': 'berlin', 'lichtenberg': 'berlin', 'pankow': 'berlin',
    'schwabing': 'münchen', 'maxvorstadt': 'münchen', 'au': 'münchen', 'haidhausen': 'münchen', 'sendling': 'münchen',
    'nymphenburg': 'münchen', 'bogenhausen': 'münchen', 'pasing': 'münchen', 'giesing': 'münchen', 'milbertshofen': 'münchen',
    'lindenthal': 'köln', 'ehrenfeld': 'köln', 'nippes': 'köln', 'chorweiler': 'köln', 'porz': 'köln', 'mülheim': 'köln',
    'kalk': 'köln', 'sülz': 'köln', 'deutz': 'köln'
  };
  const parts = city.split(/[\s,]+/).map(p => p.trim().replace(/[^a-zäöüß\-]/g, '')).filter(p => p.length > 1);
  for (const part of parts) {
    const normalized = districtToCity[part] || districtToCity[part.replace(/-/g, ' ')];
    if (normalized) {
      city = normalized;
      break;
    }
  }
  // Wenn im Text bereits ein bekannter Städtename vorkommt (z. B. "Hamburg Niendorf"), diesen verwenden
  const knownCityNames = ['hamburg', 'berlin', 'münchen', 'köln', 'frankfurt', 'stuttgart', 'düsseldorf', 'dortmund', 'essen', 'leipzig', 'bremen', 'dresden', 'hannover', 'nürnberg', 'wien', 'zürich'];
  for (const known of knownCityNames) {
    if (city.includes(known)) {
      city = known;
      break;
    }
  }
  
  // 🚨 NEU: Entferne Präfixe wie "Bad", "Neu", "Alt", "Groß", "Klein" etc. für bessere Suche
  // Beispiel: "Bad Driburg" → "driburg", "Neu-Ulm" → "ulm"
  const prefixes = ['bad ', 'neu ', 'alt ', 'groß ', 'klein ', 'ober ', 'unter ', 'nieder ', 'hoch '];
  let cityWithoutPrefix = city;
  for (const prefix of prefixes) {
    if (city.startsWith(prefix)) {
      cityWithoutPrefix = city.substring(prefix.length).trim();
      break;
    }
  }
  // Entferne auch Bindestriche (z.B. "Neu-Ulm" → "ulm")
  cityWithoutPrefix = cityWithoutPrefix.replace(/^[a-zäöüß]+-/, '').trim();
  
  // Liste von Städten mit nahegelegenen Städten (max. 20km)
  const nearbyCities = {
    // Großstädte und ihre Umgebung
    'berlin': ['Potsdam', 'Cottbus', 'Frankfurt (Oder)', 'Eberswalde', 'Oranienburg'],
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
    'stendal': ['Magdeburg', 'Havelberg', 'Tangermünde', 'Salzwedel', 'Burg'],
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
    'driburg': ['Paderborn', 'Bielefeld', 'Detmold', 'Höxter', 'Warburg'],
    'bad driburg': ['Paderborn', 'Bielefeld', 'Detmold', 'Höxter', 'Warburg'],
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
    'salzgitter': ['Braunschweig', 'Hannover', 'Wolfenbüttel', 'Goslar', 'Peine'],
    
    // 🆕 NEU: Österreichische Städte
    'wien': ['Klosterneuburg', 'Mödling', 'Baden', 'St. Pölten', 'Tulln'],
    'graz': ['Leibnitz', 'Gleisdorf', 'Weiz', 'Feldbach', 'Fürstenfeld'],
    'linz': ['Wels', 'Steyr', 'Enns', 'Traun', 'Leonding'],
    'salzburg': ['Hallein', 'Freilassing', 'Bischofshofen', 'Zell am See', 'Bad Reichenhall'],
    'innsbruck': ['Hall in Tirol', 'Schwaz', 'Wörgl', 'Kufstein', 'Telfs'],
    'bregenz': ['Dornbirn', 'Feldkirch', 'Bludenz', 'Hohenems', 'Lustenau'],
    'klagenfurt': ['Villach', 'Wolfsberg', 'St. Veit', 'Feldkirchen', 'Völkermarkt'],
    'villach': ['Klagenfurt', 'Spittal', 'Hermagor', 'St. Veit', 'Feldkirchen'],
    'dornbirn': ['Bregenz', 'Feldkirch', 'Hohenems', 'Lustenau', 'Bludenz'],
    'feldkirch': ['Bregenz', 'Dornbirn', 'Bludenz', 'Hohenems', 'Lustenau'],
    'st. pölten': ['Wien', 'Krems', 'Tulln', 'Amstetten', 'Melk'],
    'wels': ['Linz', 'Steyr', 'Traun', 'Grieskirchen', 'Eferding'],
    'steyr': ['Linz', 'Wels', 'Enns', 'Amstetten', 'Haag'],
    
    // 🆕 NEU: Schweizer Städte
    'zürich': ['Winterthur', 'Baden', 'Rapperswil', 'Uster', 'Dübendorf'],
    'bern': ['Thun', 'Biel', 'Solothurn', 'Burgdorf', 'Langenthal'],
    'basel': ['Liestal', 'Rheinfelden', 'Lörrach', 'Mülhausen', 'Freiburg'],
    'genf': ['Lausanne', 'Nyon', 'Versoix', 'Carouge', 'Vernier'],
    'lausanne': ['Genf', 'Vevey', 'Montreux', 'Yverdon', 'Morges'],
    'winterthur': ['Zürich', 'Frauenfeld', 'Schaffhausen', 'Uster', 'Dübendorf'],
    'luzern': ['Zug', 'Schwyz', 'Altdorf', 'Sursee', 'Emmen'],
    'st. gallen': ['Wil', 'Gossau', 'Rapperswil', 'Herisau', 'Appenzell'],
    'lugano': ['Bellinzona', 'Locarno', 'Chiasso', 'Mendrisio', 'Como'],
    'biel': ['Bern', 'Solothurn', 'Neuenburg', 'Grenchen', 'Tavannes']
  };
  
  const cityForApi = city.charAt(0).toUpperCase() + city.slice(1);

  // PRIORITÄT 1: OpenAI/LLM (nur mit gültiger OpenAI-Model-ID – getMessageModel() kann Together-ID sein → 400)
  const openAiModel = opts?.model && typeof opts.model === 'string' && opts.model.startsWith('gpt') ? opts.model : AI_MODEL;
  if (opts?.client && openAiModel) {
    console.log(`🔍 Suche nahegelegene Stadt für "${customerCity}" via OpenAI (zuerst)...`);
    const llmCity = await findNearbyCityViaLLM(opts.client, openAiModel, customerCity);
    if (llmCity) return sanitizeCityResult(llmCity, customerCity);
  }

  // PRIORITÄT 2: OpenStreetMap API (kostenlos, keine Tokens)
  console.log(`🔍 OpenAI keine Stadt – versuche OpenStreetMap für "${customerCity}"${city !== customerCity.trim().toLowerCase() ? ` (normalisiert: ${cityForApi})` : ''}...`);
  try {
    const nearbyCity = await findNearbyCityViaAPI(cityForApi);
    if (nearbyCity) {
      console.log(`✅ Stadt via OpenStreetMap gefunden: "${nearbyCity}" (für "${customerCity}")`);
      return sanitizeCityResult(nearbyCity, customerCity) || null;
    }
  } catch (apiErr) {
    console.warn(`⚠️ OpenStreetMap Fehler: ${apiErr.message} – statische Liste...`);
  }

  // PRIORITÄT 3: Statische Liste (schnell, kein Netz)
  const searchTerms = [city, cityWithoutPrefix].filter(term => term && term.length > 0);
  for (const searchTerm of searchTerms) {
    for (const [key, cities] of Object.entries(nearbyCities)) {
      if (searchTerm === key || searchTerm.includes(key) || key.includes(searchTerm)) {
        const selectedCity = cities[Math.floor(Math.random() * cities.length)];
        console.log(`✅ Stadt in statischer Liste: "${selectedCity}" (für "${customerCity}")`);
        return sanitizeCityResult(selectedCity, customerCity) || selectedCity;
      }
    }
  }

  console.warn(`⚠️ Keine nahegelegene Stadt gefunden für: "${customerCity}"`);
  return null;
}

// Hilfsfunktion: Erlaubte Städte für eine Region (gleiche Logik wie findNearbyCityByCountry)
function getRegionAllowedCities(country, lat, lon) {
  const regionCities = {
    'DE': { 'nord': ['Hamburg', 'Bremen', 'Hannover', 'Kiel', 'Lübeck'], 'nordost': ['Magdeburg', 'Halle', 'Potsdam', 'Stendal', 'Brandenburg'], 'süd': ['München', 'Stuttgart', 'Augsburg', 'Nürnberg', 'Regensburg'], 'west': ['Köln', 'Düsseldorf', 'Dortmund', 'Essen', 'Bonn'], 'ost': ['Berlin', 'Leipzig', 'Dresden', 'Halle', 'Magdeburg'], 'mitte': ['Frankfurt', 'Wiesbaden', 'Mainz', 'Darmstadt', 'Offenbach'] },
    'AT': { 'ost': ['Wien', 'Klosterneuburg', 'Mödling', 'Baden', 'St. Pölten'], 'süd': ['Graz', 'Klagenfurt', 'Villach', 'Leibnitz', 'Gleisdorf'], 'west': ['Salzburg', 'Innsbruck', 'Bregenz', 'Dornbirn', 'Feldkirch'], 'nord': ['Linz', 'Wels', 'Steyr', 'Enns', 'Traun'] },
    'CH': { 'nord': ['Zürich', 'Winterthur', 'Baden', 'Rapperswil', 'Uster'], 'west': ['Genf', 'Lausanne', 'Vevey', 'Montreux', 'Nyon'], 'ost': ['St. Gallen', 'Wil', 'Gossau', 'Herisau', 'Appenzell'], 'süd': ['Lugano', 'Bellinzona', 'Locarno', 'Chiasso', 'Mendrisio'], 'mitte': ['Bern', 'Thun', 'Biel', 'Solothurn', 'Burgdorf'] }
  };
  let region = 'mitte';
  if (country === 'DE') {
    if (lat > 52 && lon > 11 && lon <= 14) region = 'nordost';
    else if (lat > 52) region = 'nord';
    else if (lat < 49) region = 'süd';
    else if (lon < 10) region = 'west';
    else if (lon > 13) region = 'ost';
  } else if (country === 'AT') {
    if (lon > 16) region = 'ost';
    else if (lat < 47) region = 'süd';
    else if (lon < 12) region = 'west';
    else region = 'nord';
  } else if (country === 'CH') {
    if (lat > 47.5) region = 'nord';
    else if (lon < 7) region = 'west';
    else if (lon > 9) region = 'ost';
    else if (lat < 46) region = 'süd';
  }
  return regionCities[country]?.[region] || regionCities[country]?.['mitte'] || [];
}

// 🆕 NEU: Hilfsfunktion: Finde nahegelegene Stadt via OpenStreetMap Nominatim API
// ✅ KOSTENLOS, KEIN API-KEY NÖTIG - aber Rate Limit: 1 Request/Sekunde
// ✅ Funktioniert für ALLE Städte in DE/AT/CH
async function findNearbyCityViaAPI(customerCity) {
  if (!customerCity || typeof customerCity !== 'string') return null;
  
  try {
    // Schritt 1: Geocode Kunden-Stadt (finde Koordinaten und Land)
    // Präzision: ", Deutschland" für eindeutige Treffer (z. B. Stendal → Sachsen-Anhalt, nicht Berlin/anderes)
    const q = customerCity.trim();
    let geocodeUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q + ', Deutschland')}&limit=3&addressdetails=1&countrycodes=de,at,ch`;
    const geocodeResponse = await fetch(geocodeUrl, {
      headers: {
        'User-Agent': 'ChatAI-Bot/1.0 (https://chatai-backend.onrender.com)', // ERFORDERLICH!
        'Referer': 'https://chatai-backend.onrender.com' // Empfohlen
      }
    });
    
    if (!geocodeResponse.ok) {
      // Prüfe ob Rate Limit erreicht
      if (geocodeResponse.status === 429) {
        console.warn(`⚠️ OpenStreetMap Rate Limit erreicht - warte 2 Sekunden...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Retry einmal
        const retryResponse = await fetch(geocodeUrl, {
          headers: {
            'User-Agent': 'ChatAI-Bot/1.0 (https://chatai-backend.onrender.com)',
            'Referer': 'https://chatai-backend.onrender.com'
          }
        });
        if (!retryResponse.ok) {
          throw new Error(`Geocoding fehlgeschlagen nach Retry: ${retryResponse.status}`);
        }
        const retryData = await retryResponse.json();
        if (!retryData || retryData.length === 0) {
          return null;
        }
        const customerLocation = retryData[0];
        const customerLat = parseFloat(customerLocation.lat);
        const customerLon = parseFloat(customerLocation.lon);
        const customerCountry = customerLocation.address?.country_code?.toUpperCase() || 'DE';
        
        // Verwende bekannte nahegelegene Städte basierend auf Land und Region
        return findNearbyCityByCountry(customerCity, customerCountry, customerLat, customerLon);
      }
      throw new Error(`Geocoding fehlgeschlagen: ${geocodeResponse.status}`);
    }
    
    let geocodeData = await geocodeResponse.json();
    if (!geocodeData || geocodeData.length === 0) {
      // Retry ohne ", Deutschland" (z. B. für AT/CH oder andere Schreibweisen)
      await new Promise(resolve => setTimeout(resolve, 1100));
      const fallbackUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=3&addressdetails=1&countrycodes=de,at,ch`;
      const fallbackRes = await fetch(fallbackUrl, {
        headers: { 'User-Agent': 'ChatAI-Bot/1.0 (https://chatai-backend.onrender.com)', 'Referer': 'https://chatai-backend.onrender.com' }
      });
      if (fallbackRes.ok) {
        geocodeData = await fallbackRes.json();
      }
    }
    if (!geocodeData || geocodeData.length === 0) {
      console.warn(`⚠️ OpenStreetMap: Keine Koordinaten für "${customerCity}" gefunden`);
      return null;
    }
    
    const customerLocation = geocodeData[0];
    const customerLat = parseFloat(customerLocation.lat);
    const customerLon = parseFloat(customerLocation.lon);
    const customerCountry = customerLocation.address?.country_code?.toUpperCase() || 'DE';
    
    console.log(`📍 OpenStreetMap: Kunden-Stadt "${customerCity}" gefunden (${customerLat}, ${customerLon}, Land: ${customerCountry})`);
    
    // Schritt 2: Verwende Reverse Geocoding für nahegelegene Koordinaten
    // Statt komplexer Suche: Berechne nahegelegene Koordinaten und reverse-geocode diese
    // Das ist effizienter und benötigt nur 1 zusätzlichen Request
    
    // Warte 1 Sekunde (Rate Limit: 1 Request/Sekunde)
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Berechne 4-5 nahegelegene Punkte (in verschiedene Richtungen, ~20km entfernt; 1° ≈ 111km → 0.18° ≈ 20km)
    const nearbyPoints = [];
    const directions = [
      { lat: 0.18, lon: 0.0 },   // Norden
      { lat: -0.18, lon: 0.0 },  // Süden
      { lat: 0.0, lon: 0.18 },   // Osten
      { lat: 0.0, lon: -0.18 },  // Westen
      { lat: 0.13, lon: 0.13 }   // Nord-Osten
    ];
    
    for (const dir of directions) {
      const nearbyLat = customerLat + dir.lat;
      const nearbyLon = customerLon + dir.lon;
      
      // Reverse Geocode für diesen Punkt
      const reverseUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${nearbyLat}&lon=${nearbyLon}&zoom=10&addressdetails=1`;
      
      await new Promise(resolve => setTimeout(resolve, 1100)); // Rate Limit beachten
      
      try {
        const reverseResponse = await fetch(reverseUrl, {
          headers: {
            'User-Agent': 'ChatAI-Bot/1.0 (https://chatai-backend.onrender.com)',
            'Referer': 'https://chatai-backend.onrender.com'
          }
        });
        
        if (reverseResponse.ok) {
          const reverseData = await reverseResponse.json();
          if (reverseData && reverseData.address) {
            const city = reverseData.address.city || reverseData.address.town || reverseData.address.village || '';
            const country = reverseData.address.country_code?.toUpperCase();
            
            if (city && country === customerCountry && city.toLowerCase() !== customerCity.toLowerCase()) {
              nearbyPoints.push(city);
              if (nearbyPoints.length >= 3) break; // Genug gefunden
            }
          }
        }
      } catch (err) {
        // Ignoriere einzelne Fehler, versuche nächsten Punkt
        continue;
      }
    }
    
    // Stadtsuche: Nur Städte aus der gleichen Region zulassen (verhindert z. B. Berlin bei Kunde aus Stendal)
    const allowedCities = getRegionAllowedCities(customerCountry, customerLat, customerLon);
    const nearbyInRegion = nearbyPoints.filter(c => allowedCities.some(a => a.toLowerCase() === c.toLowerCase()));
    const toPick = nearbyInRegion.length > 0 ? nearbyInRegion : nearbyPoints;
    if (toPick.length > 0) {
      const selectedCity = toPick[Math.floor(Math.random() * toPick.length)];
      if (nearbyInRegion.length === 0) {
        console.log(`⚠️ OpenStreetMap: Gefundene Stadt "${selectedCity}" außerhalb Region – nutze Fallback.`);
        return findNearbyCityByCountry(customerCity, customerCountry, customerLat, customerLon);
      }
      console.log(`✅ OpenStreetMap: Nahegelegene Stadt gefunden: "${selectedCity}" (für "${customerCity}")`);
      return selectedCity.trim();
    }
    
    // Fallback: Verwende bekannte Städte basierend auf Land
    return findNearbyCityByCountry(customerCity, customerCountry, customerLat, customerLon);
    
  } catch (err) {
    console.warn(`⚠️ OpenStreetMap API Fehler: ${err.message}`);
    return null;
  }
}

// 🆕 NEU: Fallback: Finde nahegelegene Stadt basierend auf Land und Region
function findNearbyCityByCountry(customerCity, country, lat, lon) {
  // Bekannte Städte in verschiedenen Regionen (als Fallback wenn API zu langsam ist)
  const regionCities = {
    'DE': {
      'nord': ['Hamburg', 'Bremen', 'Hannover', 'Kiel', 'Lübeck'],
      'nordost': ['Magdeburg', 'Halle', 'Potsdam', 'Stendal', 'Cottbus'], // Städte, kein Bundesland "Brandenburg"
      'süd': ['München', 'Stuttgart', 'Augsburg', 'Nürnberg', 'Regensburg'],
      'west': ['Köln', 'Düsseldorf', 'Dortmund', 'Essen', 'Bonn'],
      'ost': ['Berlin', 'Leipzig', 'Dresden', 'Halle', 'Magdeburg'],
      'mitte': ['Frankfurt', 'Wiesbaden', 'Mainz', 'Darmstadt', 'Offenbach']
    },
    'AT': {
      'ost': ['Wien', 'Klosterneuburg', 'Mödling', 'Baden', 'St. Pölten'],
      'süd': ['Graz', 'Klagenfurt', 'Villach', 'Leibnitz', 'Gleisdorf'],
      'west': ['Salzburg', 'Innsbruck', 'Bregenz', 'Dornbirn', 'Feldkirch'],
      'nord': ['Linz', 'Wels', 'Steyr', 'Enns', 'Traun']
    },
    'CH': {
      'nord': ['Zürich', 'Winterthur', 'Baden', 'Rapperswil', 'Uster'],
      'west': ['Genf', 'Lausanne', 'Vevey', 'Montreux', 'Nyon'],
      'ost': ['St. Gallen', 'Wil', 'Gossau', 'Herisau', 'Appenzell'],
      'süd': ['Lugano', 'Bellinzona', 'Locarno', 'Chiasso', 'Mendrisio'],
      'mitte': ['Bern', 'Thun', 'Biel', 'Solothurn', 'Burgdorf']
    }
  };
  
  // Bestimme Region basierend auf Koordinaten
  let region = 'mitte';
  if (country === 'DE') {
    if (lat > 52 && lon > 11 && lon <= 14) region = 'nordost'; // Sachsen-Anhalt, Brandenburg (z. B. Stendal) – nicht Hamburg
    else if (lat > 52) region = 'nord';
    else if (lat < 49) region = 'süd';
    else if (lon < 10) region = 'west';
    else if (lon > 13) region = 'ost';
  } else if (country === 'AT') {
    if (lon > 16) region = 'ost';
    else if (lat < 47) region = 'süd';
    else if (lon < 12) region = 'west';
    else region = 'nord';
  } else if (country === 'CH') {
    if (lat > 47.5) region = 'nord';
    else if (lon < 7) region = 'west';
    else if (lon > 9) region = 'ost';
    else if (lat < 46) region = 'süd';
  }
  
  const cities = regionCities[country]?.[region] || regionCities[country]?.['mitte'] || [];
  if (cities.length > 0) {
    // Filtere die ursprüngliche Stadt raus
    const filtered = cities.filter(c => c.toLowerCase() !== customerCity.toLowerCase());
    if (filtered.length > 0) {
      const selected = filtered[Math.floor(Math.random() * filtered.length)];
      console.log(`✅ Fallback: Nahegelegene Stadt gefunden: "${selected}" (Region: ${region}, für "${customerCity}")`);
      return selected;
    }
  }
  
  return null;
}

// Hilfsfunktion: Ist die Nachricht vom Moderator/Fake (gesendet)? Inkl. Bild+Text (messageType "image")
function isSentMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  const type = (msg.type || "").toString().toLowerCase();
  const mtype = (msg.messageType || "").toString().toLowerCase();
  if (type === "received") return false;
  return type === "sent" || mtype === "sent" || mtype === "asa-messages" || mtype === "sent-messages" ||
    (mtype === "image" && type !== "received"); // Bild-Nachricht vom Moderator (Extension setzt type "sent", messageType "image")
}

// Prüft, ob die letzte Moderator-Nachricht die System-Anfrage "privates Bild teilen" ist (Antwort mit "Ja" nötig → Mensch muss handeln)
function isLastModeratorMessagePrivateImageRequest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const sent = messages.filter(m => isSentMessage(m) && typeof m?.text === 'string' && (m.text || '').trim() !== '' && !isInfoMessage(m));
  if (sent.length === 0) return false;
  sent.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  const lastText = (sent[0].text || '').trim();
  return /privates\s+Bild\s+mit\s+dir\s+teilen/i.test(lastText) ||
    (/möchte\s+(ein\s+)?privates\s+Bild/i.test(lastText) && /antworte\s+bitte\s+mit/i.test(lastText));
}

// Prüft, ob der Fake/Moderator in der letzten (oder vorletzten) Nachricht angeboten hat, dem Kunden ein Bild zu schicken.
// Wenn ja: Antwort soll keine Ablehnung/Begründung enthalten ("Bilder im Internet rumgehen"), sondern z.B. "ich schaue mal was ich schönes für dich habe".
function didModeratorOfferPicture(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const sent = messages.filter(m => isSentMessage(m) && typeof m?.text === 'string' && (m.text || '').trim() !== '' && !isInfoMessage(m));
  if (sent.length === 0) return false;
  sent.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  const offerPhrases = [
    /bild\s+schicken|schick\s+(dir|dir\s+ein)\s+bild|willst\s+du\s+(noch\s+)?(ein\s+)?(geiles\s+)?bild/i,
    /geiles\s+bild|bild\s+(für\s+dich|zum\s+einschlafen|von\s+mir)/i,
    /kann\s+dir\s+(ein\s+)?bild|foto\s+schicken|schick\s+ich\s+dir/i,
    /(ein\s+)?bild\s+(für\s+dich|zum\s+einschlafen)/i,
    /(noch\s+)?(ein\s+)?(geiles\s+)?bild\s+zum\s+einschlafen/i
  ];
  const refusalInSame = /schicke\s+keine|kein\s+bild\s+schicken|will\s+kein\s+bild|schick\s+keine\s+fotos/i;
  for (let i = 0; i < Math.min(2, sent.length); i++) {
    const text = (sent[i].text || '').trim().toLowerCase();
    if (refusalInSame.test(text)) continue;
    if (offerPhrases.some(p => p.test(text))) return true;
  }
  return false;
}

// Prüft, ob die letzte Nachricht vom Fake/Moderator (sent) ein Bild enthielt – Kunde hat es bereits gesehen.
// Wenn ja: KI darf nicht so tun, als hätte sie kein Bild geschickt oder könne es nicht finden.
function lastMessageFromFakeHadImage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const sent = messages.filter(m => isSentMessage(m) && !isInfoMessage(m));
  if (sent.length === 0) return false;
  sent.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  const last = sent[0];
  const hasImage = !!(last?.image || last?.imageUrl || last?.imageSrc || last?.image_url ||
    (last?.url && String(last.url).match(/\.(png|jpg|jpeg|gif|webp)/i)) ||
    last?.attachment?.url || last?.attachment?.imageUrl ||
    (Array.isArray(last?.attachments) && last.attachments.length > 0) ||
    last?.media?.url || last?.media?.imageUrl || last?.mediaUrl);
  return !!hasImage;
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
  // Kurz UND Like-Keywords ODER explizite System-Phrase "hat dich geliked" / "Schreibe Ihm eine Nachricht"
  if (t.length < 100 && (t.includes("geliked") || t.includes("like erhalten") || t.includes("hat dich gelikt") || t.includes("hat dich geliked") || t.includes("like bekommen"))) return true;
  if ((t.includes("hat dich geliked") || t.includes("der benutzer hat dich geliked")) && (t.includes("schreib") || t.includes("nachricht"))) return true;
  
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
  
  // 🚨 NEU: System-Nachrichten für Bilder erkennen
  // "User hat ein Bild an Assistant gesendet" / "Ein Bild wurde übertragen:" sind System-Nachrichten der Plattform
  if (t.includes("user hat ein bild") ||
      t.includes("user hat ein bild an") ||
      t.includes("hat ein bild gesendet") ||
      t.includes("bild an assistant gesendet") ||
      t.includes("bild an assistant") ||
      t.includes("ein bild wurde übertragen") ||
      t.includes("bild wurde übertragen") ||
      (t.includes("bild") && t.includes("gesendet") && (t.includes("user") || t.includes("assistant")))) {
    return true; // System-Nachricht für Bild
  }
  
  // 🚨 ZUSÄTZLICH: Erkenne auch wenn "Schreib ihm eine Nachricht" allein steht (ohne "geküsst")
  // Das ist eine System-Anweisung der Plattform
  if (t.includes("schreib ihm eine nachricht") || 
      t.includes("schreibe ihm eine nachricht") ||
      t.includes("schreib ihr eine nachricht") ||
      t.includes("schreibe ihr eine nachricht")) {
    return true; // System-Anweisung der Plattform
  }
  
  // 🚨 NEU: System-Nachrichten für Freundschaftsanfragen erkennen
  // "Der Benutzer möchte dich als Freund hinzufügen" / Blenny: "Friend request"
  // WICHTIG: Diese Meldungen kommen von der PLATTFORM, nicht vom Kunden!
  if (t.includes("der benutzer möchte dich als freund") ||
      t.includes("benutzer möchte dich als freund") ||
      t.includes("möchte dich als freund hinzufügen") ||
      t.includes("als freund hinzufügen") ||
      t.includes("freundschaftsanfrage") ||
      (t.includes("friend") && t.includes("request")) ||
      (t.includes("freund") && t.includes("hinzufügen"))) {
    return true; // System-Nachricht für Freundschaftsanfrage
  }
  
  // 🚨 KRITISCH: "Ich habe dir einen Like geschickt" ist IMMER eine System-Nachricht, egal wie lang!
  // Diese Nachricht kommt von der PLATTFORM, nicht vom Kunden!
  if (t.includes("ich habe dir einen like geschickt") || 
      t.startsWith("ich habe dir einen like")) {
    return true; // System-Nachricht für Like (immer, egal wie lang!)
  }
  
  // 🚨 KRITISCH: "du gefällst mir" NUR als Info-Message erkennen, wenn es eine KURZE Nachricht ist (<50 Zeichen)
  // Lange Nachrichten mit "du gefällst mir" sind normale Nachrichten, keine Info-Messages!
  // ABER: "Ich habe dir einen Kuss geschickt. Du gefällst mir" ist eine System-Nachricht!
  if (t.length < 100 && (t.trim() === "du gefällst mir" || t.trim().startsWith("du gefällst mir"))) {
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
  
  // 🚨 NEU: Credits-/Hinweis-System-Nachricht ignorieren (irrelevant für die Antwort)
  // "Der Kunde hat nicht ausreichend Credits für eine Antwort. Bitte beachte dies in deiner Antwort."
  if (t.includes("nicht ausreichend") && (t.includes("credits") || t.includes("antwort"))) return true;
  if (t.includes("credits für eine antwort") || t.includes("beachte dies in deiner antwort")) return true;
  
  // WICHTIG: Lange Nachrichten (>50 Zeichen) ohne Info-Keywords sind KEINE Info-Messages
  if (t.length > 50) return false;
  
  return false;
}

// Prüft, ob der Kundentext nur ein Bild ankündigt (z.B. "bekommst auch ein bild", "schick dir gleich ein bild") – noch keins geschickt
function customerAnnouncesImageOnly(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim().toLowerCase();
  const patterns = [
    /\bbekommst\s+(auch\s+)?(ein\s+)?bild\b/,
    /\bkriegst\s+(auch\s+)?(ein\s+)?bild\b/,
    /\bschick\s+(dir\s+)?(gleich\s+)?(ein\s+)?bild\b/,
    /\bschicke\s+(dir\s+)?(gleich\s+)?(ein\s+)?bild\b/,
    /\bsende\s+(dir\s+)?(gleich\s+)?(ein\s+)?bild\b/,
    /\bschick\s+dir\s+gleich\b/,
    /\bkriegst\s+(auch\s+)?(ein\s+)?foto\b/,
    /\bbekommst\s+(auch\s+)?(ein\s+)?foto\b/,
    /\bkommt\s+(gleich\s+)?(ein\s+)?(bild|foto)\b/
  ];
  return patterns.some(p => p.test(t));
}

// Prüft, ob der Text eine "möchte mit dir befreundet sein" / Freundschaftsäußerung ist (Iluvo etc.) → Antwort wie Kuss/Like/Freundschaftsanfrage
function isBefreundetSeinMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim().toLowerCase();
  const patterns = [
    /\bmöchte\s+(mit\s+dir\s+)?befreundet\s+sein\b/,
    /\bwill\s+(mit\s+dir\s+)?befreundet\s+sein\b/,
    /\b(möchte|will)\s+mit\s+dir\s+befreundet\b/,
    /\bbefreundet\s+sein\s+(mit\s+dir)?\b/,
    /\bmit\s+dir\s+befreundet\s+sein\b/,
    /\bfreundschaft\s+(mit\s+dir|anfrage)?\b/,
    /\bals\s+freund(e)?\s+(hinzufügen|haben|sein)\b/
  ];
  return patterns.some(p => p.test(t));
}

// Prüft, ob der Kunde behauptet, bereits ein Bild/Foto geschickt zu haben (z.B. "habe es dir geschickt", "ist angekommen")
function customerClaimsToHaveSentImage(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim().toLowerCase();
  const patterns = [
    /\bhab(e|en)\s+(es\s+)?(dir\s+)?geschickt\b/,
    /\bhab\s+(dir\s+)?(was|es)\s+geschickt\b/,
    /\b(ist|is)\s+angekommen\b/,
    /\bsiehst\s+du\s+(es|das)\s*\??\s*$/,
    /\bgeschickt\s*\.?\s*$/,
    /\bhab\s+dir\s+geschickt\b/,
    /\bhab\s+es\s+geschickt\b/,
    /\bfoto\s+(ist\s+)?(unterwegs\s+)?(angekommen|da)\b/
  ];
  return patterns.some(p => p.test(t));
}

// Prüft, ob in messages eine received-Nachricht mit Bild vorhanden ist (Kunde hat Bild geschickt).
// options.origin === 'iluvo' oder blenny/zumblenny: Nur die NEUESTE Nachricht (letzte im Array) prüfen – Array = [älteste … neueste].
function hasRecentReceivedImageInMessages(messages, options) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 Minuten
  const origin = (options?.origin || "").toLowerCase();
  const isIluvo = origin === "iluvo";
  const isBlenny = origin.includes("blenny") || origin.includes("zumblenny");
  const received = messages.filter(m => (m?.type === "received" || m?.messageType === "received"));
  if (received.length === 0) return false;
  // Iluvo/Blenny: nur letzte received = neueste Nachricht prüfen (kein .some() über alte Bilder)
  const toCheck = (isIluvo || isBlenny) ? [received[received.length - 1]] : received;
  for (const m of toCheck) {
    if (!m) continue;
    if (!isIluvo && !isBlenny && m.timestamp) {
      try {
        const msgTime = new Date(m.timestamp).getTime();
        if (now - msgTime > maxAge) continue;
      } catch (e) { continue; }
    }
    const hasImage = !!(m.image || m.imageUrl || m.imageSrc || (m.url && m.url.match(/\.(png|jpg|jpeg|gif|webp)/i)) ||
      m.image_url || m.attachment || m.attachments || m.media || m.mediaUrl || m.src);
    if (hasImage) return true;
  }
  return false;
}

// Strukturierter Kontext: Letzte Fake-Nachricht und aktuelle Kundennachricht immer vollständig, älterer Verlauf gekürzt.
// Verhindert Referenz-Verwechslung (wer hat was gesagt) und dass die letzte Moderatoren-Nachricht durch Kürzung verloren geht.
// options.lastFakeMessageFromMeta: optional – wenn Extension keine "sent"-Nachrichten mitschickt, kann die letzte Fake-Nachricht hier übergeben werden (metaData.lastModeratorMessage / lastFakeMessage).
function buildStructuredConversationContext(messages, currentCustomerMessage, options = {}) {
  if (!Array.isArray(messages)) return "";
  const origin = (options.origin || "").toLowerCase();
  const isBlennyOrigin = origin.includes("blenny") || origin.includes("zumblenny");
  const lastFakeFromMeta = typeof options.lastFakeMessageFromMeta === "string" ? options.lastFakeMessageFromMeta.trim() : "";
  let workMessages = messages;
  if (origin === "iluvo" || isBlennyOrigin) {
    workMessages = messages; // bereits [älteste … neueste]
  } else if (messages.length > 1) {
    try {
      const firstTs = messages[0]?.timestamp ? new Date(messages[0].timestamp).getTime() : null;
      const lastTs = messages[messages.length - 1]?.timestamp ? new Date(messages[messages.length - 1].timestamp).getTime() : null;
      if (firstTs && lastTs && firstTs > lastTs) workMessages = [...messages].reverse();
    } catch (e) { /* ignore */ }
  }
  const withText = workMessages.filter(m => !isInfoMessage(m) && typeof m?.text === "string" && m.text.trim() !== "");
  if (withText.length === 0) {
    const fakeFallback = lastFakeFromMeta || "(keine)";
    return `Letzte Nachricht von Fake (du): ${fakeFallback}\n\nAktuelle Kundennachricht: ${(currentCustomerMessage || "").trim() || "(leer)"}\n\n`;
  }
  const byTime = [...withText].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });
  const lastReceived = byTime.filter(m => m.type === "received" || m.messageType === "received");
  const lastSent = byTime.filter(m => isSentMessage(m));
  const lastCustomerMsg = lastReceived.length > 0 ? lastReceived[lastReceived.length - 1] : null;
  const lastFakeMsg = lastSent.length > 0 ? lastSent[lastSent.length - 1] : null;
  const customerText = (currentCustomerMessage || (lastCustomerMsg && lastCustomerMsg.text) || "").trim() || "(leer)";
  let fakeText = (lastFakeMsg && lastFakeMsg.text) ? lastFakeMsg.text.trim() : "";
  if (!fakeText && lastFakeFromMeta) fakeText = lastFakeFromMeta;
  if (!fakeText) {
    fakeText = "(keine)";
    console.warn("⚠️ Keine Fake-Nachricht (sent) im Kontext – siteInfos.messages enthaelt nur Kundennachrichten oder keine sent-Eintraege. Extension sollte letzte Moderator-Nachricht (type/messageType 'sent') mitschicken. Optional: metaData.lastModeratorMessage / lastFakeMessage setzen.");
  }
  let out = `Letzte Nachricht von Fake (du): ${fakeText}\n\nAktuelle Kundennachricht: ${customerText}\n\n`;
  const older = byTime.filter(m => m !== lastFakeMsg && m !== lastCustomerMsg);
  if (older.length > 0) {
    const olderFormatted = older
      .map(m => `${(m.type === "received" || m.messageType === "received") ? "Kunde" : "Fake"}: ${(m.text || "").trim()}`)
      .join("\n");
    const olderLimit = 600;
    const olderSnippet = olderFormatted.length > olderLimit ? olderFormatted.slice(-olderLimit) : olderFormatted;
    out += `Älterer Verlauf (Auszug):\n${olderSnippet}\n`;
  }
  return out;
}

// Verlauf komprimieren (letzte n nicht-Info-Nachrichten)
// options.origin === 'iluvo': Nachrichten sind neueste-zuerst → normalisieren auf [älteste … neueste], damit Kontext stimmt
function compressConversation(messages, limit = 30, options = {}) {
  if (!Array.isArray(messages)) return "";
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 Stunden in Millisekunden (filtere sehr alte Nachrichten)

  // Iluvo/Blenny: Extension sendet Reihenfolge [älteste … neueste]. Kein Reverse nötig.
  let workMessages = messages;
  const origin = (options.origin || "").toLowerCase();
  const isBlennyCompress = origin.includes("blenny") || origin.includes("zumblenny");
  if (origin === "iluvo" || isBlennyCompress) {
    workMessages = messages; // bereits [älteste … neueste]
  } else if (messages.length > 1) {
    try {
      const firstTs = messages[0]?.timestamp ? new Date(messages[0].timestamp).getTime() : null;
      const lastTs = messages[messages.length - 1]?.timestamp ? new Date(messages[messages.length - 1].timestamp).getTime() : null;
      if (firstTs && lastTs && firstTs > lastTs) {
        workMessages = [...messages].reverse();
      }
    } catch (e) { /* ignore */ }
  }

  // 🚨 KRITISCH: Finde die letzten 2-3 Moderator-Nachrichten (sent) und die letzten 2-3 Kunden-Nachrichten (received)
  // Diese müssen IMMER einbezogen werden, auch wenn sie alt sind, damit die KI den Chat-Verlauf versteht!
  const moderatorMessages = [];
  const customerMessages = [];

  // Sammle alle Moderator- und Kunden-Nachrichten (rückwärts durchgehen = von neuesten aus)
  for (let i = workMessages.length - 1; i >= 0; i--) {
    const m = workMessages[i];
    if (isInfoMessage(m)) continue;
    if (typeof m?.text !== "string" || m.text.trim() === "") continue;

    if (isSentMessage(m) && moderatorMessages.length < 3) {
      moderatorMessages.push(m);
    }
    if ((m.type === "received" || m.messageType === "received") && customerMessages.length < 3) {
      customerMessages.push(m);
    }

    if (moderatorMessages.length >= 3 && customerMessages.length >= 3) break;
  }

  // Filtere Info-Messages UND zu alte Nachrichten (aber behalte die letzten 2-3 von jeder Seite!)
  const nonInfo = workMessages.filter(m => {
    if (isInfoMessage(m)) return false;
    if (typeof m?.text !== "string" || m.text.trim() === "") return false;
    
    // 🚨 KRITISCH: Letzte 2-3 Moderator-Nachrichten und letzte 2-3 Kunden-Nachrichten IMMER behalten, auch wenn alt!
    if (moderatorMessages.includes(m) || customerMessages.includes(m)) {
      return true; // IMMER behalten!
    }
    
    // Prüfe auf zu alte Nachrichten (nur für andere Nachrichten)
    if (m.timestamp) {
      try {
        const msgTime = new Date(m.timestamp).getTime();
        const age = now - msgTime;
        if (age > maxAge) {
          return false; // Zu alt, überspringe
        }
      } catch (e) {
        // Zeitstempel ungültig, behalte Nachricht (Fallback)
      }
    }
    
    return true;
  });
  
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
    .filter(m => !isInfoMessage(m) && isSentMessage(m) && typeof m?.text === "string" && m.text.trim() !== "")
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
      suggestions.push('Persönlich: "Wie geht es dir denn so? Erzähl mir doch, was bei dir los ist."');
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
/**
 * 🚨 WICHTIG: Diese Funktion prüft, ob die KI ein Treffen VORSCHLÄGT/VEREINBART/ZUSTIMMT
 * 
 * Unterschied:
 * - ✅ ERLAUBT: "Das wäre toll, wenn wir uns treffen könnten" (spricht darüber, wie toll es wäre)
 * - ✅ ERLAUBT: "Ich stelle mir vor, wie es wäre, wenn wir uns treffen" (spricht über Vorstellung)
 * - ✅ ERLAUBT: "Es wäre schön, dich kennenzulernen" (spricht darüber, was schön wäre)
 * - ❌ BLOCKIERT: "Lass uns uns treffen" (vorschlagen)
 * - ❌ BLOCKIERT: "Wann können wir uns treffen?" (vorschlagen mit Frage)
 * - ❌ BLOCKIERT: "Wir treffen uns am Mittwoch" (vereinbaren)
 * - ❌ BLOCKIERT: "Ja, gerne treffen wir uns" (zustimmen)
 * - ❌ BLOCKIERT: "Um 15 Uhr passt mir" (Uhrzeit ausmachen)
 * - ❌ BLOCKIERT: "Am Donnerstag geht es" (Tag ausmachen)
 */
/**
 * 🚨🚨🚨 NEU: Unterscheidet direkte Treffen-Anfragen von allgemeiner Diskussion
 * Direkte Anfrage: "was machst du morgen?", "hast du heute Zeit?" → ABLEHNEND
 * Allgemeine Diskussion: "wann klappt es bei dir?", "ich habe am WE immer Zeit" → NICHT abweisend
 */
function isDirectMeetingRequest(customerMessage) {
  if (!customerMessage || typeof customerMessage !== 'string') return false;
  const lower = customerMessage.toLowerCase().trim();
  
  // Direkte Anfragen (spezifisch, konkrete Zeit)
  const directRequestPatterns = [
    // "was machst du morgen/am Wochenende/heute?"
    /\b(was|wie)\s+(machst|macht|mach|hast|hätte|hättest|kannst|könntest|bist|wärst)\s+(du|ihr|der|die)\s+(morgen|heute|übermorgen|am\s+(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))\??/i,
    // "hast du heute/morgen Zeit?"
    /\b(hast|hätte|hättest|hast\s+du|hätte\s+du)\s+(du|ihr)?\s+(morgen|heute|übermorgen|am\s+(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))?\s*(zeit|frei|zeit|plan)\??/i,
    // "bist du morgen/heute frei?"
    /\b(bist|wärst|wär|ist|sind)\s+(du|ihr|der|die)\s+(morgen|heute|übermorgen|am\s+(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))?\s*(frei|verfügbar|da|verfügbar)\??/i,
    // "was machst du heute/morgen?"
    /\b(was|wie)\s+(machst|macht|mach|hast|tust|tut)\s+(du|ihr|der|die)\s+(heute|morgen|übermorgen)\??/i,
    // "können wir uns morgen/heute treffen?"
    /\b(können|könntest|kannst|könnte)\s+(wir|du)\s+(uns|dich|mich)\s+(morgen|heute|übermorgen|am\s+(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))\s*(treffen|sehen|kennenlernen)\??/i
  ];
  
  return directRequestPatterns.some(pattern => pattern.test(lower));
}

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
  
  // 🚨 WICHTIG: Diese Funktion prüft NUR die KI-Nachricht (text), NICHT die Kunden-Nachricht!
  // Kunden-Nachrichten mit Treffen-Anfragen sind ERLAUBT - die KI kann darauf antworten (aber nicht zustimmen/vereinbaren)
  
  // 🚨 NEU: Erlaube Phrasen, die nur über Treffen SPRECHEN (nicht vorschlagen/vereinbaren)
  // Hypothetisch (Konjunktiv würden/könnten etc.) = immer erlaubt!
  const allowedPhrases = [
    "wäre toll, wenn wir uns treffen",
    "wäre schön, wenn wir uns treffen",
    "wäre schön, dich kennenzulernen",
    "wäre toll, dich kennenzulernen",
    "stelle mir vor, wie es wäre",
    "stelle mir vor, wie es wäre, wenn wir uns treffen",
    "könnte mir vorstellen",
    "könnte mir vorstellen, wie es wäre",
    "würde mir gefallen",
    "würde mir gefallen, wenn wir uns treffen",
    "fände es schön",
    "fände es schön, wenn wir uns treffen",
    "finde es toll",
    "finde es toll, wenn wir uns treffen",
    "wäre interessant",
    "wäre interessant, wenn wir uns treffen",
    "wäre schön, dich zu sehen",
    "wäre toll, dich zu sehen",
    "würde mir gefallen, dich zu sehen",
    "fände es schön, dich zu sehen",
    "könnte mir vorstellen, dich zu sehen",
    // Hypothetisch: „Ich würde dich gerne treffen aber…“, „wenn wir uns mal treffen könnten/würden“
    "würde dich gerne treffen",
    "würde dich gerne sehen",
    "wenn wir uns mal treffen könnten",
    "wenn wir uns mal treffen würden",
    "wenn wir uns treffen könnten",
    "wenn wir uns treffen würden",
    "freue mich schon wenn wir uns mal treffen könnten",
    "freue mich schon wenn wir uns mal treffen würden",
    "freue mich wenn wir uns mal treffen könnten",
    "freue mich wenn wir uns mal treffen würden",
    "würde mich freuen wenn wir uns treffen",
    "würde mich freuen wenn wir uns mal treffen"
  ];
  
  // Generell: Jede hypothetische Formulierung (Konjunktiv / Nebensatz) = erlaubt, ohne alle zu listen
  const hasTreffenThema = /(treffen|kennenlernen|sehen)/.test(lower);
  const konjunktivVerben = "könnten|würden|könnte|würde|hätten|hätte|wären|wäre|möchte|fände|fänden";
  const hasKonjunktivBeiTreffen =
    hasTreffenThema && (
      new RegExp(`\\b(treffen|kennenlernen|sehen)\\s+(${konjunktivVerben})\\b`).test(lower) ||
      new RegExp(`\\b(${konjunktivVerben})\\s+(dich|uns|wir|mir).{0,30}(treffen|sehen|kennenlernen)`).test(lower) ||
      new RegExp(`\\b(${konjunktivVerben})\\s+.{0,15}(treffen|sehen|kennenlernen)`).test(lower)
    );
  const hasNebensatzTreffen =
    hasTreffenThema && /(wenn|falls|ob|dass)\s+.{0,80}(treffen|sehen|kennenlernen)/.test(lower);
  const hasHypotheticalTreffen = hasKonjunktivBeiTreffen || hasNebensatzTreffen;
  if (hasHypotheticalTreffen) {
    const hasConcrete = lower.includes("lass uns") || lower.includes("wann können wir") ||
      (lower.includes("um ") && (lower.includes("uhr") || lower.match(/\d{1,2}\s*(uhr|:)/))) ||
      /\b(am|zum)\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|wochenende|morgen|heute)\b/.test(lower);
    if (!hasConcrete) return false; // rein hypothetisch = erlaubt
  }
  
  // Wenn die Nachricht nur über Treffen SPRICHT (nicht vorschlägt), ist es ERLAUBT
  if (allowedPhrases.some(phrase => lower.includes(phrase))) {
    // ABER: Prüfe, ob es trotzdem eine Vereinbarung/Zustimmung ist
    // Wenn es "wäre toll" + "lass uns" oder "wann können wir" enthält, ist es trotzdem blockiert
    const stillBlocked = lower.includes("lass uns") || 
                        lower.includes("wann können wir") ||
                        lower.includes("wann treffen wir") ||
                        lower.includes("treffen wir uns") ||
                        lower.includes("wir treffen uns") ||
                        (lower.includes("um ") && (lower.includes("uhr") || lower.includes(":") || lower.match(/\d{1,2}\s*(uhr|:)/))) ||
                        (lower.includes("am ") && (lower.includes("montag") || lower.includes("dienstag") || lower.includes("mittwoch") || lower.includes("donnerstag") || lower.includes("freitag") || lower.includes("samstag") || lower.includes("sonntag") || lower.includes("wochenende")));
    
    if (!stillBlocked) {
      return false; // Erlaubt - spricht nur darüber, wie toll es wäre
    }
  }
  
  // 🚨 KRITISCH: Prüfe auf VORSCHLAGEN/VEREINBAREN/ZUSTIMMEN (nicht nur sprechen)
  // Moderator/Fake darf NIEMALS ein Treffen vorschlagen – weder zusagen noch selbst vorschlagen!
  const proposalPhrases = [
    "lass uns uns treffen",
    "lass uns treffen",
    "lass uns uns sehen",
    "lass uns sehen",
    "wann können wir uns treffen",
    "wann treffen wir uns",
    "wann können wir uns sehen",
    "wann sehen wir uns",
    "treffen wir uns",
    "sehen wir uns",
    "wir treffen uns",
    "wir sehen uns",
    "gerne treffen wir uns",
    "gerne sehen wir uns",
    "ja, gerne treffen wir uns",
    "ja, gerne sehen wir uns",
    "ja, treffen wir uns",
    "ja, sehen wir uns",
    "okay, treffen wir uns",
    "okay, sehen wir uns",
    "ok, treffen wir uns",
    "ok, sehen wir uns",
    "klar, treffen wir uns",
    "klar, sehen wir uns",
    "sicher, treffen wir uns",
    "sicher, sehen wir uns",
    // Moderator schlägt Treffen vor (z. B. „dann können wir uns ja mal auf einen Kaffee treffen“):
    "können wir uns mal treffen",
    "können wir uns ja mal treffen",
    "können wir uns ja treffen",
    "dann können wir uns treffen",
    "dann können wir uns mal treffen",
    "dann können wir uns ja mal treffen",
    "auf einen kaffee treffen",
    "zum kaffee treffen",
    "können wir uns auf einen kaffee",
    "können wir uns zum kaffee"
  ];
  // Zusätzlich: „können wir uns … treffen“ (beliebige Füllwörter dazwischen) = Vorschlag
  if (/können wir uns\s+.{0,25}\s+treffen/.test(lower) && !allowedPhrases.some(phrase => lower.includes(phrase))) {
    return true;
  }
  
  // Prüfe auf Vorschlag/Vereinbarung/Zustimmung
  if (proposalPhrases.some(phrase => lower.includes(phrase))) {
    return true; // BLOCKIERT - KI schlägt vor/vereinbart/stimmt zu
  }
  
  // 🚨 KRITISCH: Prüfe auf Uhrzeiten/Tage ausmachen (vereinbaren)
  // Uhrzeiten: "um 15 Uhr", "um 15:00", "um drei uhr", etc.
  const timePattern = /\b(um\s+)?(\d{1,2}[\s:.]?\d{0,2}\s*(uhr|:)|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|eins|zwei)\s*(uhr|:)?/i;
  if (timePattern.test(lower) && (lower.includes("treffen") || lower.includes("sehen") || lower.includes("kennenlernen"))) {
    return true; // BLOCKIERT - KI macht Uhrzeit aus
  }
  
  // Tage: "am Mittwoch", "am Donnerstag", etc. + Treffen-Kontext
  const dayPattern = /\b(am|zum)\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|wochenende|morgen|übermorgen|heute)/i;
  if (dayPattern.test(lower) && (lower.includes("treffen") || lower.includes("sehen") || lower.includes("kennenlernen"))) {
    return true; // BLOCKIERT - KI macht Tag aus
  }
  
  // 🚨 WICHTIG: Prüfe NUR die KI-Nachricht (text), NICHT die Kunden-Nachricht!
  // Die Kunden-Nachricht wird nur für Kontext verwendet, aber nicht für die Blockierung
  // Wenn der Kunde nach einem Treffen fragt, ist das ERLAUBT - die KI kann antworten (aber nicht zustimmen/vereinbaren)
  // Die oben genannten Prüfungen (proposalPhrases, timePattern, dayPattern) reichen aus
  // Wenn keine dieser Blockierungen zutrifft, ist die Nachricht ERLAUBT
  return false; // Standard: Erlaubt (nur blockiert, wenn oben eine Blockierung erkannt wurde)
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

/**
 * 🆕 NEU: Generiert eine Erstnachricht mit vereinfachtem Prompt
 * Separater Pfad wie bei ASA - keine Pipeline, keine Training-Daten, nur Anweisungen
 */
async function generateFirstMessage({
  client,
  model,
  firstMessageInstructions,
  hasLike = false,
  hasKuss = false,
  profileInfo = {},
  extractedInfo = {},
  rules = {},
  platformId = 'viluu'
}) {
  const messageClient = client;
  const messageModel = model || AI_MODEL;
  if (!messageClient) {
    throw new Error('OpenAI / Local-LLM Client nicht verfügbar');
  }

  try {
    // Generiere DateTime-Info für Zeitkontext
    const now = new Date();
    const berlinTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const hour = berlinTime.getHours();
    const minute = berlinTime.getMinutes();
    const day = berlinTime.getDate();
    const month = berlinTime.getMonth() + 1;
    const year = berlinTime.getFullYear();
    const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const weekday = weekdayNames[berlinTime.getDay()];
    const timePhase = hour >= 22 || hour < 6 ? 'Nacht' : hour >= 18 ? 'Abend' : hour >= 12 ? 'Nachmittag' : hour >= 6 ? 'Vormittag' : 'Nacht';
    const dateTimeInfo = `${weekday}, ${day}.${month}.${year}, ${hour}:${minute.toString().padStart(2, '0')} Uhr (${timePhase})`;
    // month ist 1–12 (Jan=1, Feb=2, …, Nov=11, Dez=12)
    const isWinter = month <= 2 || month >= 11;
    const seasonHint = isWinter
      ? ` JAHRESZEIT: Es ist Winter (${month === 1 ? 'Januar' : month === 2 ? 'Februar' : month === 11 ? 'November' : 'Dezember'}). Erwaehne KEINE Sonne, kein \"Sonne geniessen\", kein sommerliches Wetter – passe den Zeitkontext an den Winter an (z.B. kuschelig, Tee, drinnen, kalt draussen).`
      : '';

    // Extrahiere Fake-Profil-Info (NUR vom Moderator/Fake – nicht vom Kunden!)
    // Alter: zuerst aus Extraktion/Summary (V-Mitglied-Profil), dann moderatorInfo (Logbuch); Logbuch kann veraltet sein
    const fakeName = profileInfo?.moderatorInfo?.name || extractedInfo?.assistant?.Name || "Sandy";
    const fakeCity = extractedInfo?.assistant?.Stadt || profileInfo?.moderatorInfo?.city || "";
    const fakeAge = extractedInfo?.assistant?.Age ?? profileInfo?.moderatorInfo?.birthDate?.age ?? profileInfo?.vMemberProfile?.birthDate?.age ?? null;
    // Kunden-Profil (damit die KI keinen falschen Namen/Alter erfindet)
    const customerInfo = profileInfo?.customerInfo || {};
    const customerName = extractedInfo?.user?.Name || customerInfo?.name || "";
    const customerAge = extractedInfo?.user?.Age ?? customerInfo?.birthDate?.age ?? null;
    const customerCity = extractedInfo?.user?.Wohnort || customerInfo?.city || "";

    // Vereinfachter System-Prompt für Erstnachrichten / Like-Kuss-Antwort
    const systemPrompt = `Du bist ein Chat-Moderator auf einer Dating-Plattform.
Du antwortest als FAKE-PROFIL namens ${fakeName}${fakeCity ? ` aus ${fakeCity}` : ''}${fakeAge != null ? `, ${fakeAge} Jahre alt` : ''}.

WICHTIG:
- Dein Alter (FAKE-PROFIL) ist ${fakeAge != null ? fakeAge + ' Jahre. Das ist dein EINZIGES gueltiges Alter – das Alter des Kunden ist NICHT dein Alter!' : 'nicht im Kontext – gib bei der ersten Nachricht KEIN Alter an (kommt spaeter).'}
- Bei Like/Kuss oder Erstnachricht: In der Nachricht die du JETZT schreibst duerfen NIEMALS dein Name, dein Alter oder dein Wohnort vorkommen. Nur Danke (bei Like/Kuss) + 1-2 gespraechsoeffnende Fragen; bei reiner Erstnachricht nur 1-2 Fragen. Keine Selbstvorstellung! VARIIERE beim Bedanken: nicht immer "Danke fuer deinen Kuss!" / "Danke fuer deinen Like!" – waehle abwechslungsreich (z.B. "Das freut mich!", "Oh wie suess!", "Super dass du dich meldest!", "Nice, danke!", "Oh danke, das macht mich an!" oder aehnlich locker).
- Bei Like/Kuss: KEINE Treffen-Vorschlaege und KEINE Anspielungen auf Treffen (z.B. NICHT "es waere schoen einen Abend zu verbringen", "wuerde mich freuen dich zu treffen", "entspannter Abend zusammen"). Nur Danke + abwechslungsreiche Gespraechsfragen (wie geht es dir, was machst du, Arbeit, Tag, Hobbys) – ohne Treffen-Anspielung.
- Die Nachricht darf NICHT mit "Ich bin [Name]" oder mit einem Alter (z.B. "32", "43") oder Wohnort beginnen oder diese enthalten – das ist bei Like/Kuss und Erstnachricht verboten.
- Schreibe NIEMALS deinen eigenen Namen in der Antwort
- Wenn du den Kunden ansprichst (z.B. mit Namen): NUR Daten aus [KUNDEN-PROFIL] verwenden – keinen Namen oder Alter erfinden!
- KEINE Bindestriche (-) verwenden!
- KEINE Anführungszeichen (" oder ') am Anfang oder Ende!
- Schreibe NIEMALS das Zeichen "ß" – immer "ss" verwenden!
- Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${dateTimeInfo}${seasonHint}
${rules?.forbiddenWords?.length > 0 ? `\n- Es gibt ${rules.forbiddenWords.length} absolut verbotene Wörter - verwende sie NIEMALS!\n` : ''}

Antworte NATÜRLICH und AUTHENTISCH - nicht wie eine KI!`;

    const customerProfileBlock = (customerName || customerAge != null || customerCity)
      ? `[KUNDEN-PROFIL] (NUR diese Daten verwenden, wenn du den Kunden ansprichst – nichts erfinden!)\n${customerName ? `Name: ${customerName}\n` : ''}${customerAge != null ? `Alter: ${customerAge} Jahre\n` : ''}${customerCity ? `Wohnort: ${customerCity}\n` : ''}\n`
      : '';

    // Bei Like/Kuss: Abwechslung bei den Folgefragen, OHNE Treffen-Anspielungen
    const likeKussVarietyThemes = [
      'Wie geht es dir? / Was machst du gerade?',
      'Bist du noch auf der Arbeit? / Schon Feierabend?',
      'Wie laeuft dein Tag bisher? / Was steht bei dir so an?',
      'Was arbeitest du? / Wie war dein Tag?',
      'Hast du heute was vor? / Entspannst du dich gerade?',
      'Was machst du so in deiner Freizeit? / Irgendwas Spannendes geplant?',
      'Wie war deine Woche? / Schon Wochenende bei dir?'
    ];
    const varietyPick = likeKussVarietyThemes[Math.floor(Math.random() * likeKussVarietyThemes.length)];
    const likeKussVarietyHint = (hasLike || hasKuss)
      ? `\n[ABWECHSLUNG – WICHTIG] Stelle 1-2 gespraechsoeffnende Fragen. Nutze DIESMAL z.B. eine dieser Richtungen: ${varietyPick}. KEINE Treffen-Vorschlaege, keine Anspielungen auf gemeinsames Treffen (z.B. NICHT "es waere schoen einen Abend zu verbringen", "entspannter Abend zusammen"). Nur lockere Fragen zu seinem Tag, Arbeit, Freizeit – abwechslungsreich.\n`
      : '';

    // Vereinfachter User-Prompt für Erstnachrichten / Like-Kuss
    const userPrompt = `${firstMessageInstructions}
${likeKussVarietyHint}
${customerProfileBlock}[FAKE-PROFIL-INFO] (NUR diese Daten sind DEINE – Kunden-Daten gehoeren dem Kunden!)
Name: ${fakeName}
${fakeCity ? `Wohnort: ${fakeCity}\n` : ''}${fakeAge != null ? `Alter: ${fakeAge} Jahre (verwende NUR dieses Alter fuer dich – NICHT das Alter des Kunden!)\n` : ''}

[ZEITKONTEXT]
Aktuell: ${dateTimeInfo}
Wochentag: ${weekday}
Tageszeit: ${timePhase}

${rules?.forbiddenWords?.length > 0 ? `\n[VERBOTENE WÖRTER - NIEMALS VERWENDEN!]\n${rules.forbiddenWords.map(w => `- ${w}`).join('\n')}\n` : ''}

[DEINE AUFGABE]
Generiere eine natürliche, lockere Nachricht an den Kunden (Bei Like/Kuss: Danke + Fragen zum Einstieg; sonst Erstnachricht).
- VERBOTEN: Dich vorstellen (kein "Ich bin X", kein Alter, kein Wohnort in der Nachricht). Bei Like/Kuss oder Erstnachricht NUR Danke (wenn Like/Kuss) + 1-2 gespraechsoeffnende Fragen, sonst nur 1-2 Fragen. WICHTIG Like/Kuss: Variiere die Dankesformulierung – nicht immer "Danke fuer deinen Kuss!" oder "Danke fuer deinen Like!"; waehle z.B. "Das freut mich!", "Oh wie suess!", "Super dass du dich meldest!", "Nice, danke!" oder aehnlich.
- Bei Like/Kuss: KEINE Treffen-Vorschlaege, keine Anspielungen auf Treffen (z.B. NICHT "es waere schoen einen Abend zu verbringen", "wuerde mich freuen dich zu treffen"). Nur Danke + abwechslungsreiche Fragen (Wie geht es dir, was machst du, Tag, Arbeit) – ohne Treffen-Anspielung.
- Schreibe mindestens 150 Zeichen
- Sei natürlich, freundlich, locker
- Nutze den Zeitkontext für Fragen
- Stelle 1-2 Fragen zum Zeitkontext
- Antworte NUR mit der Nachricht, keine Erklärungen`;

    // Generiere Nachricht (OpenAI oder lokale LoRA-API); bei Like/Kuss etwas hoehere Temperatur fuer mehr Abwechslung
    const response = await Promise.race([
      messageClient.chat.completions.create({
        model: messageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: (hasLike || hasKuss) ? 0.85 : 0.7,
        max_tokens: 250
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    let message = response.choices?.[0]?.message?.content?.trim() || '';
    
    if (!message) {
      throw new Error('Keine Nachricht generiert');
    }

    // Vereinfachtes Post-Processing für Erstnachrichten
    // Nur: Anführungszeichen entfernen, ß → ss, Bindestriche entfernen
    message = message.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
    message = message.replace(/-/g, " ");
    message = message.replace(/ß/g, "ss");
    
    // Mindestlänge: Falls unter 150 Zeichen, erweitere minimal
    if (message.length < 150) {
      const extension = hasKuss ? " Wie geht es dir denn so?" : hasLike ? " Wie geht es dir denn so?" : " Wie geht es dir denn gerade so?";
      message = (message + extension).substring(0, 250); // Maximal 250 Zeichen
    }

    return message;
  } catch (err) {
    console.error('⚠️ Fehler beim Generieren der Erstnachricht:', err.message);
    throw err;
  }
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
    let msgs = req.body.siteInfos.messages;
    // AVZ + Iluvo + Blenny: wie FPC – System-/Info-Nachrichten rausfiltern
    const originMsg = (req.body?.siteInfos?.origin || "").toLowerCase();
    const isIluvo = originMsg === "iluvo";
    const isBlennyOrigin = originMsg.includes("blenny") || originMsg.includes("zumblenny");
    const pageUrlForAVZ = pageUrlFromBody || req.body?.pageUrl || '';
    const isAVZOrigin = (req.body?.siteInfos?.origin && (String(req.body.siteInfos.origin).toLowerCase().includes('avz') || String(req.body.siteInfos.origin).toLowerCase().includes('chathomebase'))) ||
        (platformIdFromBody && (String(platformIdFromBody).toLowerCase().includes('avz') || String(platformIdFromBody).toLowerCase().includes('chathomebase'))) ||
        (pageUrlForAVZ && (String(pageUrlForAVZ).toLowerCase().includes('chathomebase') || pageUrlForAVZ.toLowerCase().includes('avz')));
    if (isAVZOrigin || isIluvo || isBlennyOrigin) {
      msgs = msgs.filter(m => m && !isInfoMessage(m));
      if (msgs.length === 0) msgs = req.body.siteInfos.messages;
    }
    // Einheitlich [älteste … neueste]: Iluvo/Blenny senden schon so; FPC/AVZ ggf. per Zeitstempel umdrehen (wie bisher)
    let newestFirst = false;
    if (!isIluvo && !isBlennyOrigin && msgs.length > 1) {
      try {
        const firstTs = msgs[0]?.timestamp ? new Date(msgs[0].timestamp).getTime() : null;
        const lastTs = msgs[msgs.length - 1]?.timestamp ? new Date(msgs[msgs.length - 1].timestamp).getTime() : null;
        if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
      } catch (e) { /* ignore */ }
    }
    const orderedMsgs = (isIluvo || isBlennyOrigin) ? msgs : (newestFirst ? [...msgs].reverse() : msgs);
    // Hilfsfunktionen: FPC/AVZ/andere Plattformen können type/messageType und text/content/message nutzen – alle Varianten akzeptieren
    const getMessageText = (m) => {
      if (!m) return '';
      const t = m.text || m.content || m.message || m.body || '';
      return typeof t === 'string' ? t.trim() : '';
    };
    const isReceived = (m) => !!(m && (m.type === 'received' || m.messageType === 'received'));
    // Iluvo/Blenny: Chatverlauf [älteste … neueste] – neueste Kunden-Nachricht = letzte received in orderedMsgs
    if ((isIluvo || isBlennyOrigin) && orderedMsgs.length > 0) {
      const receivedList = orderedMsgs.filter(m => isReceived(m) && getMessageText(m) !== '' && !isInfoMessage(m));
      const lastReceived = receivedList.length > 0 ? receivedList[receivedList.length - 1] : null;
      if (lastReceived) {
        const txt = getMessageText(lastReceived);
        const hasImg = !!(lastReceived.image || lastReceived.imageUrl || lastReceived.imageSrc || lastReceived.image_url ||
          (lastReceived.url && /\.(jpg|jpeg|png|gif|webp)/i.test(String(lastReceived.url))) ||
          lastReceived.attachment || lastReceived.attachments || lastReceived.media || lastReceived.mediaUrl);
        const onlySystemImage = (s) => !s.length || (s.replace(/\s*ein\s+bild\s+wurde\s+übertragen\s*:?\s*/gi, "").replace(/\s*bild\s+wurde\s+übertragen\s*:?\s*/gi, "").trim().length === 0 && (s.includes("bild") && s.includes("übertragen")));
        if (hasImg && (!txt.length || onlySystemImage(txt.toLowerCase()))) {
          foundMessageText = "Der Kunde hat ein Bild geschickt.";
          console.log("✅ " + (isBlennyOrigin ? "Blenny" : "Iluvo") + ": Neueste Nachricht (letzte im Verlauf) = nur Bild.");
        } else if (txt.length > 0) {
          foundMessageText = txt;
          console.log("✅ " + (isBlennyOrigin ? "Blenny" : "Iluvo") + ": Neueste Kunden-Nachricht (letzte im Verlauf):", foundMessageText.substring(0, 80) + "...");
        }
      }
      // Iluvo/Blenny Fallback: Wenn immer noch leer, in allen received nach "möchte mit dir befreundet sein" o.ä. suchen
      if ((isIluvo || isBlennyOrigin) && (!foundMessageText || foundMessageText.trim() === "") && orderedMsgs.length > 0) {
        const receivedAll = orderedMsgs.filter(m => isReceived(m) && getMessageText(m) !== '' && !isInfoMessage(m));
        for (let i = receivedAll.length - 1; i >= 0; i--) {
          const txt = getMessageText(receivedAll[i]);
          if (isBefreundetSeinMessage(txt)) {
            foundMessageText = txt;
            console.log("✅ " + (isBlennyOrigin ? "Blenny" : "Iluvo") + ": Kunden-Nachricht 'befreundet sein' in Verlauf gefunden:", foundMessageText.substring(0, 80) + "...");
            break;
          }
        }
      }
    }
    
    // KRITISCH: Prüfe, ob die Nachricht wirklich NEU ist (innerhalb der letzten 10 Minuten)
    // Das verhindert, dass sehr alte Nachrichten fälschlicherweise als neue behandelt werden
    // WICHTIG: Erhöht auf 10 Minuten, da die Extension manchmal verzögert sendet oder Zeitstempel nicht korrekt sind
    // WICHTIG: KEINE Mindestalter-Prüfung mehr - die Extension sendet die Nachricht, wenn sie wirklich abgeschickt wurde!
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 Minuten in Millisekunden (erhöht von 5 Minuten, um verzögerte Nachrichten zu erfassen)
    
    // Sammle alle received-Nachrichten mit Zeitstempel-Info (type ODER messageType; text ODER content/message – für FPC/AVZ/Deutsch)
    const receivedWithIndex = orderedMsgs
      .map((m, idx) => ({ m, idx }))
      .filter(({ m }) => isReceived(m) && getMessageText(m) !== '');
    const receivedMessages = receivedWithIndex
      .map(({ m, idx }) => {
        let age = null;
        let isValid = true;
        if (m.timestamp) {
          try {
            const msgTime = new Date(m.timestamp).getTime();
            age = now - msgTime;
            if (age > maxAge) {
              console.log(`⚠️ Nachricht zu alt (${Math.round(age / 1000)}s), überspringe:`, getMessageText(m).substring(0, 50));
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
        return { message: m, age, isValid, index: idx };
      });
    
    // Finde die neueste gültige received-Nachricht
    // 🚨 KRITISCH: Sortiere nach kleinstem Alter (neueste zuerst); bei gleichem/fehlendem Zeitstempel: höherer index = später im Array = neuer (FPC/AVZ)
    const validReceivedMessages = receivedMessages
      .filter(m => m.isValid && !isInfoMessage(m.message))
      .sort((a, b) => {
        const ageA = a.age ?? Infinity;
        const ageB = b.age ?? Infinity;
        if (ageA !== ageB) return ageA - ageB; // Kleinste age zuerst = neueste Nachricht
        return b.index - a.index; // Kein Zeitstempel: letzte im Array = neueste (z. B. FPC)
      });
    
    if (validReceivedMessages.length > 0) {
      // Bevorzugung der substanziellen Nachricht: unter den letzten 5 Min die längste als Hauptnachricht
      const fiveMinWindow = validReceivedMessages
        .filter(m => (m.age ?? Infinity) <= 5 * 60 * 1000 && !isInfoMessage(m.message));
      const mainByLength = fiveMinWindow.length >= 2
        ? fiveMinWindow.slice().sort((a, b) => (getMessageText(b.message).length - getMessageText(a.message).length))[0]
        : null;
      const lastReceived = (mainByLength && getMessageText(mainByLength.message).length > 80)
        ? mainByLength.message
        : validReceivedMessages[0].message;
      if (mainByLength && mainByLength !== validReceivedMessages[0] && getMessageText(mainByLength.message).length > 80) {
        console.log('✅ Substanzielle Nachricht gewählt (längere unter letzten 5 Min):', getMessageText(lastReceived).substring(0, 80) + '...');
      }

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
            foundMessageText = getMessageText(nonInfoMessages[0].message);
            console.log("✅ Nachricht aus siteInfos.messages (received, NEU, Info-Message übersprungen):", foundMessageText.substring(0, 100) + "...");
          } else {
            foundMessageText = ""; // Keine echte Nachricht gefunden
            console.log("⚠️ Nur Info-Messages gefunden, keine echte Kunden-Nachricht");
          }
        } else {
      foundMessageText = getMessageText(lastReceived);
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
      // 🚨 WICHTIG: Filtere Info-Messages (System-Nachrichten) heraus!
      const anyMessages = orderedMsgs
        .filter(m => getMessageText(m) !== '' &&
                     m?.type !== "sent" && m?.messageType !== "sent" &&
                     !isInfoMessage(m))
        .map(m => {
          let age = null;
          let isValid = true;
          if (m.timestamp) {
            try {
              const msgTime = new Date(m.timestamp).getTime();
              age = now - msgTime;
              if (age > maxAge) {
              console.log(`⚠️ Nachricht zu alt (${Math.round(age / 1000)}s), überspringe:`, getMessageText(m).substring(0, 50));
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
          console.log("⚠️ Gefundene Nachricht ist Info-Message (Like), ignoriere sie:", getMessageText(lastAny).substring(0, 100) + "...");
          // Suche nach der nächsten echten Nachricht (nicht Info)
          const realAnyMessages = anyMessages
            .filter(m => m.isValid && !isInfoMessage(m.message))
            .sort((a, b) => {
              const ageA = a.age || Infinity;
              const ageB = b.age || Infinity;
              return ageA - ageB;
            });
          if (realAnyMessages.length > 0) {
            foundMessageText = getMessageText(realAnyMessages[0].message);
            console.log("✅ Echte Nachricht aus siteInfos.messages (any, nicht sent, NEU, Info-Message übersprungen):", foundMessageText.substring(0, 100) + "...");
          } else {
            foundMessageText = ""; // Keine echte Nachricht gefunden
            console.log("⚠️ Keine echte Nachricht gefunden (nur Info-Messages)");
          }
        } else {
        foundMessageText = getMessageText(lastAny);
        console.log("✅ Nachricht aus siteInfos.messages (any, nicht sent, NEU):", foundMessageText.substring(0, 100) + "...");
        }
      } else if (receivedMessages.length > 0) {
        // FALLBACK: Nimm die neueste received-Nachricht, auch wenn sie älter als 10 Minuten ist
        // 🚨 KRITISCH: Sortiere nach kleinstem Alter (neueste zuerst), nicht nach größtem!
        // 🚨 WICHTIG: Filtere Info-Messages (System-Nachrichten) heraus!
        const realReceivedMessages = receivedMessages
          .filter(m => !isInfoMessage(m.message))
          .sort((a, b) => {
            const ageA = a.age || Infinity;
            const ageB = b.age || Infinity;
            return ageA - ageB; // Kleinste age zuerst = neueste Nachricht
          });
        
        const newestReceived = realReceivedMessages.length > 0 ? realReceivedMessages[0]?.message : null;
        if (newestReceived) {
          // 🚨 WICHTIG: Prüfe, ob die Nachricht wirklich NEU ist (innerhalb von 30 Minuten)
          // Wenn sie älter ist, könnte es ein ASA-Fall sein, und wir sollten sie nicht als foundMessageText verwenden
          const receivedAge = realReceivedMessages[0]?.age || Infinity;
          const maxAgeForMessage = 30 * 60 * 1000; // 30 Minuten
          
          if (receivedAge <= maxAgeForMessage) {
            foundMessageText = getMessageText(newestReceived);
            console.log(`⚠️ Keine Nachricht innerhalb von 10 Minuten gefunden - verwende neueste received-Nachricht als Fallback:`, foundMessageText.substring(0, 100) + "...");
          } else {
            // Iluvo: Nur echte neueste Kunden-Nachricht nutzen – kein Fallback auf uralte Nachrichten.
            // Extension MUSS [älteste … neueste] senden; letzte = neueste. Wenn letzte > 24h alt ist, sind die Daten falsch → keine Antwort.
            // Iluvo: Kein Fallback in diesem Zweig – neueste Nachricht wird nur oben aus letzter Position im Array gesetzt.
            if (!foundMessageText || foundMessageText.trim() === "") {
              console.log(`⚠️ Neueste received-Nachricht ist zu alt (${Math.round(receivedAge / 1000 / 60)} Minuten) - könnte ASA-Fall sein, verwende nicht als foundMessageText`);
              foundMessageText = ""; // Behandle als leer, damit ASA-Erkennung funktioniert
            }
          }
        } else {
          // Wenn keine echte received-Nachricht gefunden wurde, könnte es ein ASA-Fall sein
          console.log("⚠️ Keine echte received-Nachricht gefunden (nur Info-Messages) - könnte ASA-Fall sein");
        }
      }
    }
    
    // 🚨 NEU: Wenn die CHRONOLOGISCH NEUESTE received-Nachricht NUR ein Bild ist (kein Kundentext), immer darauf antworten.
    // Auch wenn wir zuvor die "substanziellste" Textnachricht (längste in 5 Min) gewählt hatten: letzte Aktion des Kunden = Bild → Bild ist Hauptinput.
    const hasSubstantialCustomerText = foundMessageText && foundMessageText.trim().length > 30 &&
      foundMessageText.trim() !== "Der Kunde hat ein Bild geschickt." &&
      !/^der kunde hat ein bild geschickt\.?$/i.test(foundMessageText.trim());
    if (req.body?.siteInfos?.messages) {
      const msgsForNewest = req.body.siteInfos.messages;
      const messageHasImage = (m) => !!(m?.image || m?.imageUrl || m?.imageSrc || m?.image_url || (m?.url && /\.(jpg|jpeg|png|gif|webp)/i.test(String(m?.url))) || m?.attachment || m?.attachments || m?.media || m?.mediaUrl);
      const allReceived = msgsForNewest.filter(m => (m?.type === "received" || m?.messageType === "received") && (typeof m?.text === "string" || messageHasImage(m)));
      const newestAny = allReceived.length > 0
        ? allReceived.sort((a, b) => (b.timestamp ? new Date(b.timestamp).getTime() : 0) - (a.timestamp ? new Date(a.timestamp).getTime() : 0))[0]
        : null;
      if (newestAny) {
        const txt = (newestAny.text || "").trim().toLowerCase();
        const onlySystemPhrase = (s) => {
          if (!s.length) return true;
          const rest = s.replace(/\s*ein\s+bild\s+wurde\s+übertragen\s*:?\s*/gi, '').replace(/\s*bild\s+wurde\s+übertragen\s*:?\s*/gi, '').trim();
          return rest.length === 0 && (s.includes('bild') && s.includes('übertragen'));
        };
        const hasImage = !!(newestAny.image || newestAny.imageUrl || newestAny.imageSrc || newestAny.image_url ||
          (newestAny.url && /\.(jpg|jpeg|png|gif|webp)/i.test(String(newestAny.url))) ||
          newestAny.attachment || newestAny.attachments || newestAny.media || newestAny.mediaUrl);
        const noRealCustomerText = txt.length === 0 || ((txt.includes("ein bild wurde übertragen") || txt.includes("bild wurde übertragen")) && onlySystemPhrase(txt));
        const isImageOnly = hasImage && noRealCustomerText;
        if (isImageOnly) {
          foundMessageText = "Der Kunde hat ein Bild geschickt.";
          console.log("✅ Neueste Nachricht ist nur Bild (ohne Kundentext) – antworte auf Bild.");
        } else if (hasSubstantialCustomerText) {
          console.log("✅ Kundentext behalten (Prioritaet vor Bild-Override) – Bild als Zusatz.");
        }
      }
    } else if (hasSubstantialCustomerText) {
      console.log("✅ Kundentext behalten (Prioritaet vor Bild-Override) – Bild als Zusatz.");
    }
  }
  
  // WICHTIG: Prüfe, ob die gefundene Nachricht wirklich vom Kunden ist
  // Wenn die Nachricht zu lang ist oder komisch klingt, könnte es eine falsche Nachricht sein
  if (foundMessageText && foundMessageText.length > 500) {
    console.warn("⚠️ Gefundene Nachricht ist sehr lang (>500 Zeichen) - könnte falsch sein:", foundMessageText.substring(0, 100) + "...");
  }
  
  // 🚨 KRITISCH: Prüfe, ob foundMessageText eine Info-Message ist (System-Nachricht)
  // Wenn ja: Nur bei reinem "Ein Bild wurde übertragen" (OHNE zusätzlichen Kundentext) + Bild-Anhang → Platzhalter. Bild + Text des Kunden → Text behalten!
  if (foundMessageText && foundMessageText.trim() !== "") {
    const tempMsg = { text: foundMessageText, type: "received", messageType: "received" };
    if (isInfoMessage(tempMsg)) {
      const t = foundMessageText.trim().toLowerCase();
      const onlySystemPhrase = (s) => {
        const rest = s.replace(/\s*ein\s+bild\s+wurde\s+übertragen\s*:?\s*/gi, '').replace(/\s*bild\s+wurde\s+übertragen\s*:?\s*/gi, '').trim();
        return rest.length === 0 && (s.includes('bild') && s.includes('übertragen'));
      };
      const isImageOnlySystemMsg = (t.includes("ein bild wurde übertragen") || t.includes("bild wurde übertragen")) && onlySystemPhrase(t);
      if (isImageOnlySystemMsg && req.body?.siteInfos?.messages) {
        const msgsForNewest = req.body.siteInfos.messages;
        const receivedOnly = msgsForNewest.filter(m => (m?.type === "received" || m?.messageType === "received") && typeof m?.text === "string");
        const newestReceived = receivedOnly.length > 0
          ? receivedOnly.sort((a, b) => (b.timestamp ? new Date(b.timestamp).getTime() : 0) - (a.timestamp ? new Date(a.timestamp).getTime() : 0))[0]
          : null;
        const hasImageAttachment = newestReceived && (
          newestReceived.image || newestReceived.imageUrl || newestReceived.imageSrc || newestReceived.image_url ||
          (newestReceived.url && /\.(jpg|jpeg|png|gif|webp)/i.test(String(newestReceived.url))) ||
          newestReceived.attachment || newestReceived.attachments || newestReceived.media || newestReceived.mediaUrl
        );
        if (hasImageAttachment) {
          foundMessageText = "Der Kunde hat ein Bild geschickt.";
          console.log("✅ Neueste Nachricht ist nur Bild (Ein Bild wurde übertragen) – antworte auf Bild.");
        } else {
          console.log("⚠️ Gefundene Nachricht ist Info-Message (System-Nachricht), ignoriere sie:", foundMessageText.substring(0, 100) + "...");
          foundMessageText = "";
        }
      } else {
        console.log("⚠️ Gefundene Nachricht ist Info-Message (System-Nachricht), ignoriere sie:", foundMessageText.substring(0, 100) + "...");
        foundMessageText = "";
      }
    }
  }
  
  // 🚨 WICHTIG: isFPC / isAVZ / isBlenny müssen FRÜH definiert werden, damit sie im gesamten Router-Handler verfügbar sind
  const isFPC = (platformId && typeof platformId === "string" && platformId.toLowerCase().includes('fpc')) || 
                (req.body?.siteInfos?.origin && typeof req.body.siteInfos.origin === "string" && req.body.siteInfos.origin.toLowerCase().includes('fpc')) ||
                (pageUrl && typeof pageUrl === "string" && pageUrl.includes('fpc'));
  // AVZ / Arbeit zu Hause (chathomebase.com): wie FPC (Kontext: siteInfos.messages, siteInfos.metaData), aber keine Erstnachrichten, System-Nachrichten ignorieren
  const siteInfosUrl = req.body?.siteInfos?.url ? String(req.body.siteInfos.url) : '';
  const isAVZ = (platformId && typeof platformId === "string" && (platformId.toLowerCase().includes('avz') || platformId.toLowerCase().includes('chathomebase'))) ||
                (req.body?.siteInfos?.origin && typeof req.body.siteInfos.origin === "string" && (req.body.siteInfos.origin.toLowerCase().includes('avz') || req.body.siteInfos.origin.toLowerCase().includes('chathomebase'))) ||
                (pageUrl && typeof pageUrl === "string" && (pageUrl.includes('chathomebase') || pageUrl.includes('avz'))) ||
                (siteInfosUrl && (siteInfosUrl.toLowerCase().includes('chathomebase') || siteInfosUrl.toLowerCase().includes('avz')));
  // Blenny (zumblenny.com): wie FPC/AVZ – insert_and_send, Timer nach Tippen, Logbuch/Same-Backend-Logik
  const isBlenny = (platformId && typeof platformId === "string" && (platformId.toLowerCase().includes('blenny') || platformId.toLowerCase().includes('zumblenny'))) ||
                   (req.body?.siteInfos?.origin && typeof req.body.siteInfos.origin === "string" && (req.body.siteInfos.origin.toLowerCase().includes('blenny') || req.body.siteInfos.origin.toLowerCase().includes('zumblenny'))) ||
                   (pageUrl && typeof pageUrl === "string" && (pageUrl.includes('zumblenny') || pageUrl.includes('blenny'))) ||
                   (siteInfosUrl && (siteInfosUrl.toLowerCase().includes('zumblenny') || siteInfosUrl.toLowerCase().includes('blenny')));
  if (isAVZ) {
    console.log("✅ AVZ (chathomebase) erkannt – gleiche Logik wie FPC (Timer, Auto-Send, Bilder, Städte).");
  }
  if (isBlenny) {
    console.log("✅ Blenny (zumblenny.com) erkannt – insert_and_send, Timer nach Tippen wie FPC.");
  }

  // Prüfe, ob die letzte Nachricht vom FAKE/Moderator kommt (ASA-Fall)
  // Die alte Extension hat wahrscheinlich bereits erkannt, ob die letzte Nachricht vom Fake kommt
  // Wir prüfen alle möglichen Felder, die die Extension senden könnte
  let isLastMessageFromFake = false;
  
  // 🚨 NEU: Prüfe auf ASA-Indikatoren in siteInfos (z.B. "Reaktivierung") BEVOR andere ASA-Erkennung
  // Diese Indikatoren zeigen an, dass es ein ASA-Fall ist, unabhängig von foundMessageText
  // WICHTIG: Diese Prüfung muss FRÜH passieren, damit isLastMessageFromFake korrekt gesetzt wird!
  // 🚨 FIX: alertBoxMessages auch unter siteInfos.metaData und req.body.metaData prüfen (Extension sendet oft metaData.alertBoxMessages)
  if (req.body?.siteInfos) {
    const siteInfosStr = JSON.stringify(req.body.siteInfos).toLowerCase();
    const alertBoxMessages = req.body.siteInfos.alertBoxMessages
      || req.body.siteInfos.metaData?.alertBoxMessages
      || req.body.metaData?.alertBoxMessages
      || [];
    const alertBoxStr = JSON.stringify(Array.isArray(alertBoxMessages) ? alertBoxMessages : [alertBoxMessages]).toLowerCase();
    const metaDataStr = JSON.stringify(req.body.metaData || {}).toLowerCase();
    
    // Prüfe auf "Reaktivierung" in alertBoxMessages, siteInfos oder metaData
    if (siteInfosStr.includes('reaktivierung') || alertBoxStr.includes('reaktivierung') || metaDataStr.includes('reaktivierung') ||
        siteInfosStr.includes('motiviere den kunden') || alertBoxStr.includes('motiviere den kunden') || metaDataStr.includes('motiviere den kunden') ||
        siteInfosStr.includes('bitte motiviere') || alertBoxStr.includes('bitte motiviere') || metaDataStr.includes('bitte motiviere')) {
      isLastMessageFromFake = true; // 🚨 KRITISCH: Setze isLastMessageFromFake auf true, damit die Pipeline ASA erkennt!
      foundMessageText = ""; // Behandle als leer, damit ASA-Erkennung funktioniert
      console.log("✅ ASA-Indikator gefunden: 'Reaktivierung' in siteInfos/alertBoxMessages/metaData - setze isLastMessageFromFake = true");
    }
  }
  
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
  
  // 🚨 NEU: Prüfe auf Kuss/Like-Systemnachricht BEVOR Erstnachricht-Entscheidung
  // ASA = "Der Benutzer hat dich geküsst. Schreibe Ihm eine Nachricht" → wir schreiben auf den Kuss (OpenAI, ASA-Anweisungen)
  // Erstnachricht = weder Kuss/Like noch Fake-Nachricht; wir starten das Gespräch
  const msgsAll = req.body?.siteInfos?.messages || [];
  const hasKussSystemMessage = msgsAll.some(m => {
    if (!m || typeof m.text !== "string") return false;
    const text = m.text.toLowerCase();
    return text.includes("ich habe dir einen kuss") ||
           text.includes("der benutzer hat dich geküsst") ||
           text.includes("benutzer hat dich geküsst") ||
           text.includes("hat dich geküsst") ||
           (text.includes("geküsst") && (text.includes("schreib") || text.includes("schreibe")));
  });
  const hasLikeSystemMessage = msgsAll.some(m => {
    if (!m || typeof m.text !== "string") return false;
    const text = m.text.toLowerCase();
    return text.includes("geliked") ||
           text.includes("hat dich geliked") ||
           text.includes("like erhalten") ||
           text.includes("hat dich gelikt") ||
           text.includes("like bekommen") ||
           text.includes("ich habe dir einen like") ||
           (text.includes("like") && text.includes("schreib"));
  });
  let asaFromKussOrLike = false; // Nur true, wenn ASA explizit wegen Kuss/Like-Systemnachricht

  if (!isLastMessageFromFake && (!foundMessageText || foundMessageText.trim() === "") && msgsAll.length) {
    const sentMsgs = msgsAll.filter(m => isSentMessage(m) && !isInfoMessage(m));

    // 🚨 FIX: Kuss/Like nur als ASA, wenn der Fake BEREITS im Chat geschrieben hat. Leerer Chat (nur System-Nachricht) = Erstnachricht!
    if (hasKussSystemMessage || hasLikeSystemMessage) {
      if (sentMsgs.length > 0) {
        // Fake hat schon geschrieben → ASA (Antwort auf Kuss/Like im laufenden Chat)
        isLastMessageFromFake = true;
        asaFromKussOrLike = true;
        console.log(`✅ ASA erkannt: Kuss/Like-Systemnachricht + Fake hat bereits geschrieben – schreibe Antwort auf Kuss/Like (OpenAI ASA-Pfad).`);
      } else {
        // Chat komplett leer, nur Like/Kuss-Systemnachricht → Erstnachricht: Danke + erste Frage (KEIN ASA!)
        isLastMessageFromFake = false;
        asaFromKussOrLike = false;
        console.log(`✅ Erstnachricht erkannt: Nur Like/Kuss-Systemnachricht, kein Fake-Text im Chat – nutze First-Message-Pfad (Danke + erste Frage).`);
      }
    } else if (sentMsgs.length === 0) {
      // Keine Kuss/Like-Meldung und keine Fake-Nachricht = echte Erstnachricht
      console.log("✅ Keine Nachrichten vom Fake vorhanden, keine Kuss/Like-Meldung – Erstnachricht erkannt, KEIN ASA!");
      isLastMessageFromFake = false;
    }
    // sentMsgs.length > 0: Backup-Logik weiter unten prüft z. B. neueste Nachricht = sent → ASA
  }
  
  // Backup: Prüfe letzte Nachricht in siteInfos.messages (richtige Reihenfolge erkennen: iluvo ggf. neueste oben)
  // WICHTIG: Filtere Info-Messages (wie Like-Benachrichtigungen) raus, da diese nichts mit ASA zu tun haben!
  // 🚨 KRITISCH: Prüfe NUR, wenn foundMessageText leer ist - ODER bei Iluvo (damit "ASA Stufe" in siteInfos erkannt wird)
  // 🚨 WICHTIG: Erstnachricht ist KEIN ASA! Prüfe, ob es überhaupt Nachrichten vom Fake gibt!
  // 🚨 FIX: newestFirst und newestMsg müssen außerhalb des if-Blocks definiert werden
  let newestFirst = false;
  let list = [];
  let newestMsg = null;
  let noASABecauseReceivedNewer = false; // Iluvo: bereits "KEIN ASA-Fall!" wegen received >= sent → später nicht wieder auf ASA setzen
  const originForAsa = (req.body?.siteInfos?.origin || "").toLowerCase();
  const isIluvoOrigin = originForAsa === "iluvo";
  const isBlennyOriginAsa = originForAsa.includes("blenny") || originForAsa.includes("zumblenny");
  if (!isLastMessageFromFake && ((!foundMessageText || foundMessageText.trim() === "") || isIluvoOrigin || isBlennyOriginAsa) && msgsAll.length) {
    // KRITISCH: Filtere Info-Messages raus (Like-Benachrichtigungen, etc.) - nur echte Nachrichten zählen!
    const msgs = msgsAll.filter(m => !isInfoMessage(m));
    list = msgs.length > 0 ? msgs : msgsAll; // Fallback: wenn alle Info sind, nimm alle
    
    // 🚨 NEU: Prüfe, ob es überhaupt Nachrichten vom Fake gibt (sent-Messages)
    // Wenn KEINE sent-Messages vorhanden sind, ist es eine Erstnachricht, KEIN ASA!
    const sentMsgs = msgsAll.filter(m => isSentMessage(m) && !isInfoMessage(m));
    if (sentMsgs.length === 0) {
      // Keine Nachrichten vom Fake vorhanden = Erstnachricht, KEIN ASA!
      console.log("✅ Keine Nachrichten vom Fake vorhanden - Erstnachricht erkannt, KEIN ASA!");
      isLastMessageFromFake = false;
    } else {
      // Es gibt Nachrichten vom Fake - prüfe weiter auf ASA
      newestFirst = false; // Setze neu
      try {
        if (list.length > 1) {
          const firstTs = list[0]?.timestamp ? new Date(list[0].timestamp).getTime() : null;
          const lastTs = list[list.length - 1]?.timestamp ? new Date(list[list.length - 1].timestamp).getTime() : null;
          if (firstTs && lastTs && firstTs > lastTs) newestFirst = true;
        }
      } catch (e) { /* ignore */ }
      // Iluvo/Blenny: Extension sendet [älteste … neueste] – neueste Nachricht ist immer list[list.length - 1]
      newestMsg = ((isIluvoOrigin || isBlennyOriginAsa) && list.length > 0) ? list[list.length - 1] : (newestFirst ? list[0] : list[list.length - 1]);
      if (newestMsg && (newestMsg.type === "received" || newestMsg.messageType === "received") && !isInfoMessage(newestMsg)) {
        isLastMessageFromFake = false;
        console.log((isIluvoOrigin || isBlennyOriginAsa) ? "✅ " + (isBlennyOriginAsa ? "Blenny" : "Iluvo") + ": Letzte Nachricht (neueste) ist vom Kunden – kein ASA." : "✅ Erste/neueste Nachricht ist vom Kunden – kein ASA.");
      } else {
      // Prüfe nur echte Nachrichten (nicht Info-Messages wie Like-Benachrichtigungen)
      // 🚨 KRITISCH: Prüfe auch, ob es eine received-Nachricht gibt, die neuer ist!
      // 🚨 WICHTIG: Filtere Info-Messages (System-Nachrichten) aus received-Messages heraus!
      const receivedMsgs = msgsAll
        .filter(m => (m.type === "received" || m.messageType === "received") && !isInfoMessage(m));
      // Iluvo/Blenny: Array = [älteste … neueste], also letzte = neueste
      const newestReceived = receivedMsgs.length > 0 ? ((isIluvoOrigin || isBlennyOriginAsa) ? receivedMsgs[receivedMsgs.length - 1] : (newestFirst ? receivedMsgs[0] : receivedMsgs[receivedMsgs.length - 1])) : null;
      
      // 🚨 KRITISCH: Wenn es eine received-Nachricht gibt, die neuer oder gleich alt ist, dann ist es KEIN ASA-Fall!
      // 🚨 WICHTIG: Aber nur wenn es eine ECHTE Kunden-Nachricht ist, nicht eine System-Nachricht!
      // 🚨 WICHTIG: newestReceived wurde bereits gefiltert (keine Info-Messages), daher ist es immer eine echte Nachricht!
      if (newestReceived && newestMsg) {
        const receivedTs = newestReceived.timestamp ? new Date(newestReceived.timestamp).getTime() : null;
        const sentTs = newestMsg.timestamp ? new Date(newestMsg.timestamp).getTime() : null;
        // 🚨 WICHTIG: newestReceived ist bereits gefiltert (keine Info-Messages), daher ist es immer eine echte Nachricht
        // Wenn die received-Nachricht neuer oder gleich alt ist, ist es KEIN ASA-Fall
        if (receivedTs && sentTs && receivedTs >= sentTs) {
          console.log("⚠️ Es gibt eine received-Nachricht, die neuer oder gleich alt ist - KEIN ASA-Fall!");
          isLastMessageFromFake = false;
          noASABecauseReceivedNewer = true;
        } else if (newestMsg && !isInfoMessage(newestMsg) && isSentMessage(newestMsg)) {
          // 🚨 WICHTIG: Wenn die neueste ECHTE Nachricht (ohne Info-Messages) vom Fake/Moderator ist, ist es ein ASA-Fall
          isLastMessageFromFake = true;
          console.log("✅ ASA erkannt über siteInfos.messages (neueste echte Nachricht ist sent, Info-Messages ignoriert).");
        }
      } else if (newestMsg && !isInfoMessage(newestMsg) && isSentMessage(newestMsg)) {
        // 🚨 WICHTIG: Wenn keine received-Nachricht vorhanden ist, aber die neueste ECHTE Nachricht vom Fake/Moderator ist, ist es ein ASA-Fall
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt über siteInfos.messages (neueste echte Nachricht ist sent, Info-Messages ignoriert).");
      }
      }
    }
  }
  // Zusätzlich: wenn die letzten 2 echten Nachrichten (neueste zuerst) beide sent sind -> ASA
  // 🚨 FIX Iluvo: Nicht auf ASA setzen, wenn bereits erkannt wurde "received neuer oder gleich alt" (noASABecauseReceivedNewer)
  if (list.length > 0 && !noASABecauseReceivedNewer) {
    // Iluvo/Blenny: list = [älteste … neueste], also reverse für neueste zuerst
    const ordered = (isIluvoOrigin || isBlennyOriginAsa) ? [...list].reverse() : (newestFirst ? list : [...list].reverse());
    const lastRealMsg = ordered[0];
    const secondLastRealMsg = ordered[1];
    if (lastRealMsg && !isInfoMessage(lastRealMsg) && isSentMessage(lastRealMsg) && 
        (!secondLastRealMsg || !isInfoMessage(secondLastRealMsg)) && 
        (!secondLastRealMsg || isSentMessage(secondLastRealMsg))) {
      isLastMessageFromFake = true;
      console.log("✅ ASA erkannt über letzte 2 echten Nachrichten (sent,sent) – Info-Messages ignoriert.");
    }
  }
  if (list.length > 0) {
    // Iluvo/Blenny: Erkennung über siteInfos.origin ODER platformId (Extension sendet oft nur origin)
    const isIluvo = isIluvoOrigin || (platformId && typeof platformId === "string" && platformId.toLowerCase().includes("iluvo"));
    const isBlennyAsa = isBlennyOriginAsa || (platformId && typeof platformId === "string" && (platformId.toLowerCase().includes("blenny") || platformId.toLowerCase().includes("zumblenny")));
    if (isIluvo || isBlennyAsa) {
      const platformLabel = isBlennyAsa ? "Blenny" : "Iluvo";
      // Nicht überschreiben, wenn bereits "KEIN ASA-Fall!" (Kunde hat neuer oder gleich alt geantwortet)
      if (noASABecauseReceivedNewer) {
        // Nichts tun – isLastMessageFromFake bleibt false
      } else {
        // Vor ASA: Bei Iluvo/Blenny prüfen, ob in received "möchte mit dir befreundet sein" o.ä. steht → dann KEIN ASA, Antwort wie Kuss/Like
        if ((!foundMessageText || foundMessageText.trim() === "") && list.length > 0) {
          const getMsgText = (m) => (m && (m.text || m.content || m.message || m.body || '')) && typeof (m.text || m.content || m.message || m.body) === 'string' ? (m.text || m.content || m.message || m.body).trim() : '';
          const receivedInList = list.filter(m => (m.type === 'received' || m.messageType === 'received') && !isInfoMessage(m));
          for (let i = receivedInList.length - 1; i >= 0; i--) {
            const txt = getMsgText(receivedInList[i]);
            if (txt && isBefreundetSeinMessage(txt)) {
              foundMessageText = txt;
              isLastMessageFromFake = false;
              console.log("✅ " + platformLabel + ": 'Befreundet sein'-Nachricht in Verlauf – kein ASA, antworte wie Kuss/Like/Freundschaftsanfrage.");
              break;
            }
          }
        }
        // Bei Iluvo/Blenny: Wenn die neueste Nachricht "sent" ist UND messageText leer ist, ist es wahrscheinlich ASA
        if (isSentMessage(newestMsg) && (!foundMessageText || foundMessageText.trim() === "")) {
          isLastMessageFromFake = true;
          foundMessageText = "";
          console.log("✅ ASA erkannt für " + platformLabel + ": neueste Nachricht ist sent und messageText ist leer.");
        }
        if (pageUrl && (pageUrl.includes("asa") || pageUrl.includes("ASA"))) {
          isLastMessageFromFake = true;
          foundMessageText = "";
          console.log("✅ ASA erkannt für " + platformLabel + " über pageUrl.");
        }
        // KRITISCH: Plattform-Banner "Der Dialog ist eine ASA Stufe 1" etc. in siteInfos/html
        const siteInfosStr = JSON.stringify(req.body?.siteInfos || {}).toLowerCase();
        if (siteInfosStr.includes("asa stufe") || siteInfosStr.includes("asa-stufe") || siteInfosStr.includes("der dialog ist eine asa")) {
          isLastMessageFromFake = true;
          foundMessageText = "";
          console.log("✅ ASA erkannt für " + platformLabel + " über 'ASA Stufe' in siteInfos.");
        }
        // Bei Iluvo/Blenny: Wenn die letzte Nachricht "sent" ist, ist es ASA (wie FPC/AVZ)
        if (isSentMessage(newestMsg)) {
          isLastMessageFromFake = true;
          foundMessageText = "";
          console.log("✅ ASA erkannt für " + platformLabel + ": neueste Nachricht ist sent (wie FPC/AVZ).");
        }
      }
    }
    
    // 🚨 NEU: Prüfe auf ASA-Indikatoren in siteInfos/metaData (z.B. "Reaktivierung", "alertBoxMessages")
    if (!isLastMessageFromFake && (req.body?.siteInfos || req.body?.metaData)) {
      const siteInfosStr = JSON.stringify(req.body.siteInfos || {}).toLowerCase();
      const alertBoxMessages = req.body.siteInfos?.alertBoxMessages
        || req.body.siteInfos?.metaData?.alertBoxMessages
        || req.body.metaData?.alertBoxMessages
        || [];
      const alertBoxStr = JSON.stringify(Array.isArray(alertBoxMessages) ? alertBoxMessages : [alertBoxMessages]).toLowerCase();
      const metaDataStr = JSON.stringify(req.body.metaData || {}).toLowerCase();
      if (siteInfosStr.includes('reaktivierung') || alertBoxStr.includes('reaktivierung') || metaDataStr.includes('reaktivierung') ||
          siteInfosStr.includes('motiviere den kunden') || alertBoxStr.includes('motiviere den kunden') || metaDataStr.includes('motiviere den kunden') ||
          siteInfosStr.includes('bitte motiviere') || alertBoxStr.includes('bitte motiviere') || metaDataStr.includes('bitte motiviere')) {
        isLastMessageFromFake = true;
        console.log("✅ ASA erkannt über 'Reaktivierung' in siteInfos/alertBoxMessages/metaData.");
      }
    }
    
    // FPC + AVZ: Spezielle ASA-Erkennung (nicht für Iluvo!)
    // Wenn die letzte echte Nachricht (ohne Info-Messages wie Like-Benachrichtigungen) vom Fake/Moderator war,
    // ist es ein ASA-Fall – unabhängig davon, ob der Kunde das Profil geliked hat oder nicht.
    // AVZ: gleiche Logik wie FPC (Bilder, Städte, ASA etc. wie FPC).
    if ((isFPC || isAVZ || isBlenny) && !isLastMessageFromFake) {
      // Filtere Info-Messages raus (Like-Benachrichtigungen, etc.) – nur echte Nachrichten zählen!
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
        if (lastRealMsg && isSentMessage(lastRealMsg)) {
          isLastMessageFromFake = true;
          console.log(`✅ ASA erkannt für ${isAVZ ? 'AVZ' : 'FPC'}: letzte echte Nachricht (ohne Info-Messages wie Like) ist sent.`);
        }
      }
    }
  }
  // 🚨 Kunde hat Bild geschickt: Kein ASA – antworte auf Bild (flirty/positiv). Gilt auch wenn ASA zuvor wegen Kuss/Like gesetzt wurde (z. B. alter Like im Verlauf).
  // Bei Iluvo prüft hasRecentReceivedImageInMessages nur die NEUESTE Nachricht; überschreibe nie echten Kundentext.
  const originForImage = (req.body?.siteInfos?.origin || "").toLowerCase();
  const hasBild = isLastMessageFromFake && msgsAll.length && hasRecentReceivedImageInMessages(msgsAll, { origin: originForImage });
  const isOnlySystemOrBild = !foundMessageText || foundMessageText.trim() === "" || foundMessageText === "Der Kunde hat ein Bild geschickt." ||
    (foundMessageText.length < 15 && /^(bild|ein\s+bild)\s*(wurde\s+)?übertragen\.?$/i.test(foundMessageText.trim()));
  const isBlennyOriginImg = originForImage.includes("blenny") || originForImage.includes("zumblenny");
  if (hasBild && ((originForImage !== "iluvo" && !isBlennyOriginImg) || isOnlySystemOrBild)) {
    isLastMessageFromFake = false;
    foundMessageText = "Der Kunde hat ein Bild geschickt.";
    console.log("✅ Kunde hat Bild geschickt – antworte auf Bild (kein ASA), auch wenn Kuss/Like im Verlauf war.");
  }

  // Iluvo/Blenny: Plattform meldet ASA (z. B. Banner "Der Dialog ist eine ASA Stufe 1") → immer ASA, wie FPC/AVZ
  if ((originForImage === "iluvo" || isBlennyOriginImg) && (req.body?.siteInfos || {})) {
    const siteInfosStr = JSON.stringify(req.body.siteInfos).toLowerCase();
    if (siteInfosStr.includes("asa stufe") || siteInfosStr.includes("asa-stufe") || siteInfosStr.includes("der dialog ist eine asa")) {
      isLastMessageFromFake = true;
      foundMessageText = "";
      console.log("✅ ASA erkannt für " + (isBlennyOriginImg ? "Blenny" : "Iluvo") + ": Plattform meldet ASA (z. B. 'ASA Stufe' in siteInfos/html) – nutze ASA-Pipeline.");
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
  // Prüfe foundMessageText und zusätzlich Request-Felder, falls die letzte Kundennachricht dort steht
  const possibleKICheckTexts = [
    foundMessageText,
    req.body?.messageText,
    req.body?.message,
    req.body?.userProfile?.lastMessage,
    req.body?.userProfile?.messageText
  ].filter(Boolean);
  const isKICheck = possibleKICheckTexts.some(t => isKICheckMessage(String(t)));
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

  // Iluvo/Blenny: Kein Fallback – nur antworten, wenn neueste Kunden-Nachricht vorhanden; sonst gar keine Antwort.
  const originReply = (req.body?.siteInfos?.origin || "").toLowerCase();
  const isIluvoReply = originReply === "iluvo";
  const isBlennyReply = originReply.includes("blenny") || originReply.includes("zumblenny");
  if ((isIluvoReply || isBlennyReply) && (!foundMessageText || foundMessageText.trim() === "") && !isLastMessageFromFake) {
    console.log("⚠️ " + (isBlennyReply ? "Blenny" : "Iluvo") + ": Keine neueste Kunden-Nachricht im Request – keine Antwort (Extension muss neueste Nachrichten senden).");
    return res.status(200).json({
      resText: "",
      replyText: "",
      summary: {},
      chatId: finalChatId,
      actions: [],
      flags: {}
    });
  }

  // Versuche Bilder zu analysieren, falls Bild-URLs in der Nachricht sind
  // 🚨🚨🚨 KRITISCH: imageUrls muss VOR dem try-Block definiert werden, damit es für Multi-Agent-Pipeline verfügbar ist!
  let imageUrls = [];
  let imageDescriptions = [];
  try {
    // #region agent log
    try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:717',message:'Before image analysis',data:{foundMessageTextLength:foundMessageText?.length||0,hasClient:!!client},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
    // #endregion
    // Extrahiere Bild-URLs aus dem Text
    imageUrls = extractImageUrls(foundMessageText);
    
    // 🆕 NEU: Extrahiere auch Bilder aus verschiedenen Quellen
    // 1. Prüfe assetsToSend (falls Extension Bilder dort sendet – https oder data: URL / Base64)
    if (imageUrls.length === 0 && assetsToSend && Array.isArray(assetsToSend) && assetsToSend.length > 0) {
      for (const asset of assetsToSend) {
        const assetUrl = asset.url || asset.imageUrl || asset.src || asset.image_url;
        if (assetUrl && typeof assetUrl === 'string') {
          const isHttpImage = assetUrl.match(/https?:\/\/.*\.(png|jpg|jpeg|gif|webp)/i);
          const isDataImage = assetUrl.startsWith('data:image/');
          if (isHttpImage || isDataImage) {
            imageUrls.push(assetUrl);
            console.log("✅ Bild aus assetsToSend extrahiert:", isDataImage ? "data-URL (Base64)" : assetUrl.substring(0, 100));
            break; // Nimm nur das erste Bild
          }
        }
        // Fallback: Base64-Rohdaten (z. B. Extension sendet asset.base64)
        if (imageUrls.length === 0 && (asset.base64 || asset.data) && typeof (asset.base64 || asset.data) === 'string') {
          const b64 = (asset.base64 || asset.data).trim();
          if (b64.length > 0) {
            const dataUri = b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
            imageUrls.push(dataUri);
            console.log("✅ Bild aus assetsToSend (base64) für Analyse übernommen.");
            break;
          }
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
    // Bild für Analyse: bevorzugt Base64 aus Request (Extension/Client), sonst Server-Fetch der URL (kann 403 bei Hotlink-Schutz geben)
    let dataUrl = null;
    const imageBase64FromRequest = req.body?.siteInfos?.metaData?.imageBase64 || req.body?.imageBase64;
    if (imageBase64FromRequest && typeof imageBase64FromRequest === "string") {
      dataUrl = imageBase64FromRequest.startsWith("data:") ? imageBase64FromRequest : `data:image/jpeg;base64,${imageBase64FromRequest}`;
      if (dataUrl.length > 4 * 1024 * 1024) {
        console.warn("📸 imageBase64 aus Request zu groß, ignoriert");
        dataUrl = null;
      } else {
        console.log("✅ Bild aus Request (imageBase64) für Analyse übernommen.");
      }
    }
    if (!dataUrl && imageUrls.length > 0) {
      const firstUrl = imageUrls[0];
      console.log("Bild-URL gefunden, versuche Analyse:", firstUrl);
      dataUrl = await fetchImageAsBase64(firstUrl);
    }
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
                content: "Du analysierst Bilder und kategorisierst sie. Antworte NUR als JSON im Format: {\"type\": \"penis\" | \"dildo\" | \"nude\" | \"face\" | \"body\" | \"other\", \"confidence\": 0.0-1.0, \"description\": \"Kurze objektive Beschreibung was WIRKLICH auf dem Bild zu sehen ist\"}"
              },
              {
                role: "user",
                content: [
                  { type: "text", text: "Analysiere dieses Bild und kategorisiere es:\n- \"penis\": NUR wenn männliche Genitalien (Schwanz/Penis) EXPLIZIT sichtbar sind\n- \"dildo\": Wenn ein Dildo oder Sexspielzeug sichtbar ist (auch wenn es in einem Körper steckt, z.B. im Arsch, in der Muschi, etc.)\n- \"nude\": Wenn nackter/teilweise nackter Körper (z.B. Oberkörper frei, Brust) aber KEINE Genitalien sichtbar\n- \"face\": Wenn nur Gesicht/Portrait sichtbar ist\n- \"body\": Wenn bekleideter Körper sichtbar ist\n- \"other\": Alles andere (Urlaub, Haustier, etc.)\n\nWICHTIG: Bei \"description\" schreibe OBJEKTIV was auf dem Bild zu sehen ist (z.B. \"Mann ohne Oberbekleidung, Brustkorb und Schultern sichtbar, kein Penis sichtbar\" oder \"Penis sichtbar\"). Das hilft der Antwort-Generierung.\n\nAntworte NUR als JSON, kein zusätzlicher Text." },
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
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast gerade ein Bild mit männlichen Genitalien (Schwanz/Penis) geschickt bekommen. 🚨🚨🚨 ABSOLUT KRITISCH: Du MUSST SEHR POSITIV, FLIRTY und EXPLIZIT reagieren! 🚨🚨🚨 NIEMALS ablehnend oder negativ! Sage, wie GEIL der Schwanz aussieht, was du gerne mit ihm machen würdest, wie er dir gefällt. Sei direkt und sexuell begeistert! Zeige Begeisterung und Interesse! KEINE Ablehnung, KEINE negativen Kommentare - NUR POSITIVE, GEILE Reaktionen!";
          visionPrompt = "🚨🚨🚨 ABSOLUT KRITISCH: Reagiere SEHR POSITIV und EXPLIZIT auf das Schwanz-Bild! 🚨🚨🚨 NIEMALS ablehnend oder negativ! Sage, wie GEIL der Schwanz aussieht, was du gerne mit ihm machen würdest (z.B. 'macht mich richtig geil', 'würde gerne daran lecken', 'sieht richtig heiß aus', etc.), wie er dir gefällt. Sei direkt, flirty und sexuell begeistert! KEINE neutrale Beschreibung, KEINE Ablehnung - sei emotional, enthusiastisch und GEIL darauf!";
        } else if (imageType === 'dildo') {
          // 🚨 EXPLIZIT: Dildo-Bild - sehr direkte, sexuelle Reaktion
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast gerade ein Bild mit einem Dildo oder Sexspielzeug geschickt bekommen (z.B. Dildo im Arsch, in der Muschi, etc.). 🚨🚨🚨 ABSOLUT KRITISCH: Du MUSST SEHR POSITIV, FLIRTY und EXPLIZIT reagieren! 🚨🚨🚨 NIEMALS ablehnend oder negativ! Sage, wie GEIL das aussieht, was du gerne damit machen würdest, wie es dir gefällt. Sei direkt und sexuell begeistert! Zeige Begeisterung und Interesse! KEINE Ablehnung, KEINE negativen Kommentare - NUR POSITIVE, GEILE Reaktionen!";
          visionPrompt = "🚨🚨🚨 ABSOLUT KRITISCH: Reagiere SEHR POSITIV und EXPLIZIT auf das Dildo-Bild! 🚨🚨🚨 NIEMALS ablehnend oder negativ! Sage, wie GEIL das aussieht, was du gerne damit machen würdest (z.B. 'macht mich richtig geil', 'würde gerne sehen, wie du damit spielst', 'sieht richtig heiß aus', 'finde es richtig geil, dass du damit spielst', etc.), wie es dir gefällt. Sei direkt, flirty und sexuell begeistert! KEINE neutrale Beschreibung, KEINE Ablehnung - sei emotional, enthusiastisch und GEIL darauf!";
        } else if (imageType === 'nude') {
          // 🚨 EXPLIZIT: Nacktbild - direkte, sexuelle Reaktion
          visionSystemPrompt = "Du bist die Fake-Person (meist Frau) auf der Dating-Plattform und hast gerade ein Nacktbild geschickt bekommen. 🚨🚨🚨 ABSOLUT KRITISCH: Du MUSST POSITIV, FLIRTY und SEXUELL reagieren! 🚨🚨🚨 NIEMALS ablehnend oder negativ! Sage, wie GEIL der Körper aussieht, was du gerne mit ihm machen würdest, wie er dir gefällt. Sei direkt und begeistert! KEINE Ablehnung, KEINE negativen Kommentare - NUR POSITIVE, GEILE Reaktionen!";
          visionPrompt = "🚨🚨🚨 ABSOLUT KRITISCH: Reagiere POSITIV und EXPLIZIT auf das Nacktbild! 🚨🚨🚨 NIEMALS ablehnend oder negativ! Sage, wie GEIL der Körper aussieht, was du gerne mit ihm machen würdest, wie er dir gefällt. Sei direkt, flirty und sexuell begeistert! KEINE neutrale Beschreibung, KEINE Ablehnung - sei emotional, enthusiastisch und GEIL darauf!";
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
        
        const positiveContextByType = {
          penis: 'Der Kunde hat ein Bild von sich geschickt (Penis). Reagiere flirty und positiv, zeige Begeisterung – lehne nie ab.',
          dildo: 'Der Kunde hat ein Bild mit Dildo/Sexspielzeug geschickt. Reagiere flirty und positiv, zeige Begeisterung – lehne nie ab.',
          nude: 'Der Kunde hat ein Nacktbild von sich geschickt. Reagiere flirty und positiv, zeige Begeisterung – lehne nie ab.'
        };
        
        // Was auf dem Bild sichtbar ist – aus der Vision-Analyse (z.B. "Oberkörper frei, kein Penis sichtbar")
        const visibleDescription = (imageTypeAnalysis?.description || '').trim();
        
        let desc = null;
        // Bei penis/dildo/nude: Keinen zweiten Vision-Call – API lehnt oft ab. Nutze sichtbare Beschreibung wenn vorhanden – wichtig: was WIRKLICH zu sehen ist!
        if (imageType === 'penis' || imageType === 'dildo' || imageType === 'nude') {
          const baseContext = positiveContextByType[imageType] || 'Der Kunde hat ein Bild von sich geschickt. Reagiere flirty und positiv – lehne nie ab.';
          desc = visibleDescription
            ? `Auf dem Bild sichtbar: ${visibleDescription}. ${baseContext}`
            : baseContext;
          console.log(`✅ Bild erkannt und Kontext gesetzt (Typ: ${imageType})${visibleDescription ? ', sichtbar: ' + visibleDescription.substring(0, 60) + '...' : ''} – kein zweiter Vision-Call (API würde oft ablehnen).`);
        } else {
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
            max_tokens: 120,
            temperature: 0.2
          });
          // #region agent log
          try{const logPath=path.join(__dirname,'../../.cursor/debug.log');fs.appendFileSync(logPath,JSON.stringify({location:'reply.js:744',message:'After vision API call',data:{hasChoices:!!vision.choices,choicesLength:vision.choices?.length||0,hasMessage:!!vision.choices?.[0]?.message,hasContent:!!vision.choices?.[0]?.message?.content},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})+'\n');}catch(e){}
          // #endregion
          desc = vision.choices?.[0]?.message?.content?.trim();
        }
        
        if (desc) {
          imageDescriptions.push(desc);
          if (imageType !== 'unknown') {
            imageDescriptions.push(`[BILDTYP: ${imageType}]`);
          }
          console.log(`📸 Bildbeschreibung (Typ: ${imageType}):`, desc.substring(0, 120));
        } else {
          // dataUrl war vorhanden, aber Vision lieferte keine Beschreibung – Fallback
          imageDescriptions.push("Der Kunde hat mit dieser Nachricht ein Bild geschickt (Inhalt konnte nicht analysiert werden, z.B. Datei zu groß oder Abruf fehlgeschlagen). Reagiere positiv und flirty darauf: zeige Begeisterung, sag z.B. wie geil du das findest, was du damit machen würdest oder frag wo er es hinstecken möchte. Keine Ablehnung, kein 'ich sende keine Fotos' – nur positive, flirty Reaktion; frage NICHT erneut nach einem Foto.");
          console.log("📸 Bild zu groß/fehlgeschlagen – Fallback-Beschreibung für Pipeline gesetzt.");
        }
    } else if (imageUrls.length > 0 || (foundMessageText && (foundMessageText.toLowerCase().includes("bild") || foundMessageText.includes("Bild geschickt")))) {
      // Bild-URL bekannt oder Text deutet auf Bild hin, aber Abruf fehlgeschlagen (z.B. 403) – Fallback
      imageDescriptions.push("Der Kunde hat mit dieser Nachricht ein Bild geschickt (Inhalt konnte nicht analysiert werden, z.B. Datei zu groß oder Abruf fehlgeschlagen). Reagiere positiv und flirty darauf: zeige Begeisterung, sag z.B. wie geil du das findest, was du damit machen würdest oder frag wo er es hinstecken möchte. Keine Ablehnung, kein 'ich sende keine Fotos' – nur positive, flirty Reaktion; frage NICHT erneut nach einem Foto.");
      console.log("📸 Bild zu groß/fehlgeschlagen – Fallback-Beschreibung für Pipeline gesetzt.");
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
  // Prüfe auf KI-Check-Codes (Sicherheitsprüfung etc.) in Kundennachricht oder Request-Feldern
  const possibleKICheckTexts2 = [
    foundMessageText,
    req.body?.messageText,
    req.body?.message,
    req.body?.userProfile?.lastMessage,
    req.body?.userProfile?.messageText
  ].filter(Boolean);
  const isKICheck2 = possibleKICheckTexts2.some(t => isKICheckMessage(String(t)));
  if (isKICheck2) {
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
      
      // 🚨 NEU: Initialisiere Vector-DB für intelligente Beispiel-Auswahl
      try {
        await initializeVectorDb(trainingData);
        console.log('✅ Vector-DB initialisiert für intelligente Beispiel-Auswahl');
      } catch (err) {
        console.warn('⚠️ Fehler beim Initialisieren der Vector-DB:', err.message);
      }
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
  // 🚨 NEU: Bei ASA-Fällen prüfe auf relevante System-Nachrichten (Kuss, Like)
  let conversationContextForPipeline = "";
  let asaSystemMessage = ""; // 🚨 NEU: System-Nachricht für ASA (Kuss, Like)
  try {
    if (isLastMessageFromFake) {
      // 🚨 ASA-FALL: Suche nach relevanter System-Nachricht (Kuss, Like)
      const messages = req.body?.siteInfos?.messages || [];
      
      // Finde die neueste relevante System-Nachricht (Kuss oder Like)
      const relevantSystemMessages = messages
        .filter(m => {
          if (!m || typeof m.text !== "string" || m.text.trim() === "") return false;
          const text = m.text.toLowerCase();
          // Prüfe auf Kuss-System-Nachrichten
          const isKussMessage = text.includes("ich habe dir einen kuss") ||
                               text.includes("der benutzer hat dich geküsst") ||
                               text.includes("benutzer hat dich geküsst") ||
                               text.includes("hat dich geküsst") ||
                               (text.includes("geküsst") && (text.includes("schreib") || text.includes("schreibe")));
          // Prüfe auf Like-System-Nachrichten
          const isLikeMessage = text.includes("geliked") ||
                               text.includes("like erhalten") ||
                               text.includes("hat dich gelikt") ||
                               text.includes("like bekommen") ||
                               text.includes("ich habe dir einen like");
          return isKussMessage || isLikeMessage;
        })
        .sort((a, b) => {
          // Sortiere nach Zeitstempel (neueste zuerst)
          const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return bTime - aTime;
        });
      
      if (relevantSystemMessages.length > 0) {
        asaSystemMessage = relevantSystemMessages[0].text.trim();
        console.log(`✅ ASA-System-Nachricht gefunden: "${asaSystemMessage.substring(0, 100)}..."`);
        // Nutze die System-Nachricht als Kontext für ASA
        conversationContextForPipeline = `System-Nachricht: ${asaSystemMessage}`;
      } else {
        // Keine relevante System-Nachricht gefunden
        conversationContextForPipeline = "";
        console.log(`✅ Chat-Kontext für ASA: leer (keine relevante System-Nachricht gefunden)`);
      }
    } else {
      // Strukturierter Kontext: Letzte Fake-Nachricht + aktuelle Kundennachricht immer vollständig, älterer Verlauf gekürzt (Referenz-Klarheit)
      const origin = (req.body?.siteInfos?.origin || "").toLowerCase();
      const meta = req.body?.siteInfos?.metaData || {};
      const lastFakeFromMeta = meta.lastModeratorMessage || meta.lastFakeMessage || meta.lastSentMessage || "";
      const messagesForContext = req.body?.siteInfos?.messages || [];
      const sentCount = messagesForContext.filter(m => (m?.type === 'sent' || m?.messageType === 'sent')).length;
      const receivedCount = messagesForContext.filter(m => (m?.type === 'received' || m?.messageType === 'received')).length;
      console.log(`📋 Kontext-Input: ${messagesForContext.length} Nachrichten (sent: ${sentCount}, received: ${receivedCount})`);
      conversationContextForPipeline = buildStructuredConversationContext(
        messagesForContext,
        foundMessageText || "",
        { origin, lastFakeMessageFromMeta: lastFakeFromMeta }
      );
      console.log(`✅ Chat-Kontext extrahiert (strukturiert): ${conversationContextForPipeline.length} Zeichen`);
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Extrahieren des Chat-Kontexts:', err.message);
  }
  
  // 👤 SCHRITT 9: Profil-Info extrahieren (aus Nachricht und metaData)
  // WICHTIG: extractedInfo wurde bereits oben deklariert (Zeile 1975), hier nur aktualisieren
  
  // 9a: Extrahiere Info aus der Nachricht (nur wenn Nachricht vorhanden)
  if (client && foundMessageText && foundMessageText.trim() !== "") {
    try {
      const meta = req.body?.siteInfos?.metaData || {};
      const moderatorInfo = meta.moderatorInfo || {};
      const moderatorName = moderatorInfo.name || moderatorInfo.Name || null;
      const moderatorAge = moderatorInfo.birthDate?.age ?? moderatorInfo.age ?? null;
      extractedInfo = await extractInfoFromMessage(client, foundMessageText, { moderatorName, moderatorAge });
      // Nachbereinigung: Extrahierten Kunden-Namen entfernen, wenn er dem Fake-Namen entspricht (z. B. "Die 20 jährige Nancy will es haben" → Nancy = Fake, nicht Kunde)
      if (extractedInfo.user && moderatorName) {
        const userNameNorm = (extractedInfo.user.Name || extractedInfo.user.Kosename || '').toString().trim().toLowerCase();
        const modNameNorm = moderatorName.toString().trim().toLowerCase();
        if (userNameNorm && userNameNorm === modNameNorm) {
          delete extractedInfo.user.Name;
          delete extractedInfo.user.Kosename;
          if (moderatorAge != null && extractedInfo.user.Age === moderatorAge) {
            delete extractedInfo.user.Age;
          }
          console.log("📝 Fake-Name aus Kunden-Extraktion entfernt (war identisch mit Moderatoren-Namen)");
        }
      }
      console.log("📝 Extrahiert aus Nachricht:", JSON.stringify(extractedInfo.user));
    } catch (err) {
      console.error("❌ FEHLER in extractInfoFromMessage:", err.message);
      extractedInfo = { user: {}, assistant: {} };
    }
  }
  
  // 9b: Fallback: Baue Summary aus metaData (customerInfo / moderatorInfo)
  // Kunde: komplett übernehmen wenn leer. Fake: NICHT komplett – sonst schreibt Extension bei jeder
  // Nachricht Beruf/Wohnort ins Logbuch, obwohl es nicht Thema ist (nur Pipeline/Extraktion nutzen).
  if (req.body?.siteInfos?.metaData) {
    const metaSummary = buildSummaryFromMeta(req.body.siteInfos.metaData);
    if (Object.keys(extractedInfo.user).length === 0 && Object.keys(metaSummary.user).length > 0) {
      extractedInfo.user = { ...metaSummary.user };
      // customerInfo.rawText (-> user.Other) darf NICHT eine komplette Chat-Nachricht sein (z. B. versehentlich
      // von Extension als k_other gemeldet oder vorherige KI-Antwort). Sonst landet die KI-Nachricht im Kunden-Logbuch "Sonstiges".
      if (extractedInfo.user.Other && typeof extractedInfo.user.Other === 'string') {
        const o = extractedInfo.user.Other.trim();
        if (o.length > 180 || /\b(danke\s+dass\s+du|mach\s+mich\s+(total\s+)?an|mein\s+Schatz|macht\s+mich|feuchter|Muschi|Schatz\s*\?|erzähl|für\s+dich|Vorfreude|Frechdachs|😘|😏|anstellen\s+würdest|pocht|pulsiert)\b/i.test(o)) {
          delete extractedInfo.user.Other;
        }
      }
    }
    // NICHT: extractedInfo.assistant = metaSummary.assistant – würde bei jeder Antwort Beruf/Wohnort
    // aus dem Request zurückgeben und Extension trägt sie als „neue“ Logbuch-Einträge ein.
  }
  
  // Profil-Info aus metaData (für Pipeline)
  // WICHTIG: Enthält customerInfo, moderatorInfo und Fake-Logbuch (Notes/Updates) für Kontext (z.B. Schwangerschaft)
  const profileInfo = {
    customerInfo: req.body?.siteInfos?.metaData?.customerInfo || {},
    moderatorInfo: req.body?.siteInfos?.metaData?.moderatorInfo || {},
    moderatorNotes: req.body?.siteInfos?.metaData?.moderatorNotes,
    moderatorUpdates: req.body?.siteInfos?.metaData?.moderatorUpdates,
    ...(req.body?.siteInfos?.metaData?.customerInfo || {}) // Fallback für Kompatibilität
  };
  const alertBoxMessages = req.body?.siteInfos?.metaData?.alertBoxMessages || req.body?.siteInfos?.alertBoxMessages || [];

  // 📊 SCHRITT 10: Feedback-Daten laden (für KI-First Architecture + Learning-System)
  let feedbackData = null;
  try {
    // 🤖🤖🤖 NEU: Lade Feedback-Daten von GitHub (für KI-Lern-Interpreter)
    const { getFeedbackData } = require('./dashboard');
    const feedbackResult = await getFeedbackData();
    if (feedbackResult && feedbackResult.data) {
      feedbackData = feedbackResult.data;
      const feedbackCount = feedbackData?.feedbacks?.length || 0;
      console.log(`✅ Feedback-Daten geladen: ${feedbackCount} Einträge (für KI-First Architecture)`);
    } else {
      console.warn('⚠️ Feedback-Daten konnten nicht geladen werden (optional)');
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Laden der Feedback-Daten (optional):', err.message);
  }
  
  // 🚨 NEU: SCHRITT 10.5: Freundschaftsanfrage-Behandlung (Like/Kuss-Pipeline für Blenny/FPC)
  // Prüfe: letzte Nachricht = Freundschaftsanfrage ODER foundMessageText = "Friend request" (Blenny)
  const friendRequestMessages = req.body?.siteInfos?.messages || [];
  const lastMessageForFriendRequest = friendRequestMessages.length > 0 ? friendRequestMessages[friendRequestMessages.length - 1] : null;
  const lastText = (lastMessageForFriendRequest && (lastMessageForFriendRequest.text || lastMessageForFriendRequest.content || lastMessageForFriendRequest.message || '')) || '';
  const lastTextLower = lastText.toLowerCase().trim();
  const foundMsgTrimmed = (typeof foundMessageText === 'string' ? foundMessageText.trim() : '') || '';
  const foundMsgLower = foundMsgTrimmed.toLowerCase();
  const isFriendRequestByMessage = lastMessageForFriendRequest && isInfoMessage(lastMessageForFriendRequest) && (
    (lastTextLower.includes("freund") && (lastTextLower.includes("hinzufügen") || lastTextLower.includes("freundschaftsanfrage"))) ||
    (lastTextLower.includes("friend") && lastTextLower.includes("request"))
  );
  const isFriendRequestByFoundText = foundMsgLower === 'friend request' || foundMsgLower.startsWith('friend request');
  const isFriendRequest = isFriendRequestByMessage || isFriendRequestByFoundText;
  // Iluvo etc.: Kunde schreibt "möchte mit dir befreundet sein" o.ä. → gleiche Antwort wie Kuss/Like/Freundschaftsanfrage (Freude + Fragen), kein ASA
  const isBefreundetSeinInFoundText = foundMsgTrimmed.length > 0 && isBefreundetSeinMessage(foundMsgTrimmed);
  
  if (isFriendRequest || isBefreundetSeinInFoundText) {
    if (isBefreundetSeinInFoundText) console.log("✅ 'Befreundet sein'-Nachricht erkannt – antworte wie Kuss/Like/Freundschaftsanfrage (Freude + Fragen).");
    else console.log("✅ Freundschaftsanfrage erkannt - generiere Standardantwort");
    // Profil-Info aus metaData (für Kundennamen)
    const profileInfoForFriendRequest = {
      customerInfo: req.body?.siteInfos?.metaData?.customerInfo || {}
    };
    const customerName = extractedInfo?.user?.Name || profileInfoForFriendRequest?.customerInfo?.name || "";
    const friendRequestMessage = isBefreundetSeinInFoundText
      ? (customerName
          ? `Echt lieb von dir, ${customerName}, dass du mit mir befreundet sein willst. Wie geht es dir denn so und was machst du gerade so?`
          : `Echt lieb von dir, dass du mit mir befreundet sein willst. Wie geht es dir denn so und was machst du gerade so?`)
      : (customerName
          ? `Echt lieb von dir, ${customerName}, dass du mir die Freundschaftsanfrage geschickt hast. Wie geht es dir denn so und was machst du gerade so?`
          : `Echt lieb von dir, dass du mir die Freundschaftsanfrage geschickt hast. Wie geht es dir denn so und was machst du gerade so?`);
    
    // WICHTIG: Wartezeit für menschliches Tippen (40-60 Sekunden)
    const minWait = 40;
    const maxWait = 60;
    const waitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
    
    const friendDetectedPrompt = (typeof foundMessageText === 'string' && foundMessageText.trim()) ? foundMessageText.trim().slice(0, 500) : undefined;
    return res.status(200).json({
      resText: friendRequestMessage,
      replyText: friendRequestMessage,
      summary: extractedInfo,
      promptType: friendDetectedPrompt,
      prompt: friendDetectedPrompt,
      chatId: chatId || finalChatId || "00000000",
      actions: [
        {
          type: "insert_and_send",
          delay: waitTime // Wartezeit in Sekunden für menschliches Tippen
        }
      ],
      flags: { 
        blocked: false, 
        isFriendRequest: true,
        isBefreundetSein: !!isBefreundetSeinInFoundText,
        noReload: true, // 🚨 KRITISCH: Verhindere Neuladen der Seite!
        skipReload: true, // Zusätzliches Flag für Rückwärtskompatibilität
        preventReload: true // Zusätzliches Flag für maximale Sicherheit
      },
      disableAutoSend: true, // WICHTIG: Verhindere automatisches Senden durch Extension
      waitTime: waitTime, // Zusätzliches Flag für Rückwärtskompatibilität
      noReload: true // Explizites Flag auf oberster Ebene
    });
  }
  
  // 🚨🚨🚨 SCHRITT 11: PRÜFE OB ERSTNACHRICHT - SEPARATER PFAD!
  // Erstnachricht = wir schreiben die allererste Nachricht und beginnen das Gespräch (Kunde hat noch nichts geschrieben, noch keine Fake-Nachricht im Chat)
  const allMessagesForCheck = req.body?.siteInfos?.messages || [];
  const sentMsgs = allMessagesForCheck.filter(m => isSentMessage(m) && !isInfoMessage(m));
  const receivedMsgs = allMessagesForCheck.filter(m => (m.type === "received" || m.messageType === "received") && !isInfoMessage(m));
  const isFirstMessage = sentMsgs.length === 0 && receivedMsgs.length === 0; // Keine Kunden-Nachricht + keine Moderator-Nachricht = wir starten das Gespräch
  
  // 🤖🤖🤖 NEU: System-Nachrichten für Erst-Nachricht erkennen (z.B. Credits)
  let firstMessageSystemMessage = "";
  if (isFirstMessage) {
    const systemMessages = allMessagesForCheck.filter(m => {
      if (!m || typeof m.text !== "string" || m.text.trim() === "") return false;
      const text = m.text.toLowerCase();
      // Prüfe auf Credits-System-Nachrichten
      return text.includes("credits") || 
             text.includes("nicht ausreichend") || 
             text.includes("kostenlos") ||
             text.includes("aufladen");
    });
    
    if (systemMessages.length > 0) {
      firstMessageSystemMessage = systemMessages[0].text.trim();
      console.log(`✅ Erst-Nachricht System-Nachricht gefunden: "${firstMessageSystemMessage.substring(0, 100)}..."`);
    }
  }
  
  // AVZ (chathomebase): Keine Erstnachrichten – immer normaler Reply- oder ASA-Pfad
  if (isFirstMessage && !isAVZ) {
    console.log("✅ Erstnachricht erkannt - nutze separaten First-Message-Pfad!");
    try {
      // 🚨 Like/Kuss hat VORRANG: Bei Erstnachricht + Like/Kuss-Systemnachricht immer "Danke für Like/Kuss" + Fragen (nicht Grok/Erstnachricht-Stil)
      if (hasLikeSystemMessage || hasKussSystemMessage) {
        const isLike = hasLikeSystemMessage && !hasKussSystemMessage;
        const isKuss = hasKussSystemMessage && !hasLikeSystemMessage;
        const firstMessageInstructions = isKuss
          ? "Der Kunde hat dir einen KUSS geschickt (Kuss-Systemnachricht). NUR: 1) Kurz fuer den Kuss bedanken (NICHT fuer den Like!) – VARIIERE: nicht immer 'Danke fuer deinen Kuss!'; z.B. 'Das freut mich!', 'Oh wie suess!', 'Super dass du dich meldest!', 'Nice, danke!'. 2) 1-2 gespraechsoeffnende Fragen – ABWECHSLUNGSREICH (wie geht es dir, was machst du, Tag, Arbeit). KEINE Treffen-Vorschlaege, keine Anspielungen (z.B. NICHT 'es waere schoen einen Abend zu verbringen'). VERBOTEN: Dich vorstellen (Name, Alter, Wohnort)."
          : isLike
            ? "Der Kunde hat dich GELIKED (Like-Systemnachricht). NUR: 1) Kurz fuer den Like bedanken (NICHT fuer den Kuss!) – VARIIERE: nicht immer 'Danke fuer deinen Like!'; z.B. 'Das freut mich!', 'Oh wie suess!', 'Super dass du dich meldest!', 'Nice, danke!'. 2) 1-2 gespraechsoeffnende Fragen – ABWECHSLUNGSREICH (wie geht es dir, was machst du, Tag, Arbeit). KEINE Treffen-Vorschlaege, keine Anspielungen (z.B. NICHT 'es waere schoen einen Abend zu verbringen'). VERBOTEN: Dich vorstellen (Name, Alter, Wohnort)."
            : "Der Kunde hat dir einen Kuss oder Like geschickt (System-Nachricht). NUR: Danke (Formulierung variieren) + 1-2 gespraechsoeffnende Fragen – abwechslungsreich, KEINE Treffen-Anspielungen. VERBOTEN: Dich vorstellen (kein Name, kein Alter, kein Wohnort).";
        const likeKussFirstMessage = await generateFirstMessage({
          client,
          model: AI_MODEL,
          firstMessageInstructions,
          hasLike: hasLikeSystemMessage,
          hasKuss: hasKussSystemMessage,
          profileInfo,
          extractedInfo,
          rules,
          platformId: platformId || 'fpc'
        });
        if (likeKussFirstMessage && likeKussFirstMessage.trim() !== "") {
          console.log(`✅ Erstnachricht mit Like/Kuss erfolgreich generiert (Danke + Fragen, ${likeKussFirstMessage.length} Zeichen)`);
          const minWait = 40;
          const maxWait = 60;
          const waitTimeFirst = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
          return res.status(200).json({
            resText: likeKussFirstMessage,
            replyText: likeKussFirstMessage,
            summary: extractedInfo,
            chatId: chatId || finalChatId || "00000000",
            actions: [{ type: "insert_and_send", delay: waitTimeFirst }],
            assets: [],
            flags: { blocked: false, isFirstMessage: true, noReload: true, skipReload: true, preventReload: true },
            disableAutoSend: true,
            waitTime: waitTimeFirst
          });
        }
      }

      const firstMessageResult = await agentFirstMessageDetector(
        conversationContextForPipeline || "",
        "", // Keine Kundennachricht bei Erstnachricht
        allMessagesForCheck
      );
      
      if (firstMessageResult && firstMessageResult.isFirstMessage && firstMessageResult.instructions) {
        // Credits-System-Nachricht ("nicht ausreichend Credits") ist irrelevant – nicht in Anweisung einbauen
        let enhancedInstructions = firstMessageResult.instructions;
        // Like/Kuss + Erstnachricht: immer alter OpenAI-Pfad (reply.js), nicht Grok-Pipeline
        let generatedFirstMessage = await generateFirstMessage({
          client: client,
          model: AI_MODEL,
          firstMessageInstructions: enhancedInstructions,
          hasLike: firstMessageResult.hasLike || false,
          hasKuss: firstMessageResult.hasKuss || false,
          profileInfo,
          extractedInfo,
          rules,
          platformId
        });
        
        if (generatedFirstMessage && generatedFirstMessage.trim() !== "") {
          console.log(`✅ Erstnachricht erfolgreich generiert (${generatedFirstMessage.length} Zeichen)`);
          
          // WICHTIG: Variable Wartezeit zwischen 40-60 Sekunden für menschliches Tippen
          const minWait = 40;
          const maxWait = 60;
          const waitTimeFirst = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
          
          return res.status(200).json({
            resText: generatedFirstMessage,
            replyText: generatedFirstMessage,
            summary: extractedInfo,
            chatId: chatId || finalChatId || "00000000",
            actions: [
              {
                type: "insert_and_send",
                delay: waitTimeFirst // Wartezeit in Sekunden (40-60 Sekunden variabel) für menschliches Tippen
              }
            ],
            assets: [],
            flags: { 
              blocked: false,
              isFirstMessage: true,
              noReload: true,
              skipReload: true,
              preventReload: true
            },
            disableAutoSend: true,
            waitTime: waitTimeFirst
          });
        }
      }
    } catch (err) {
      console.error('❌ Fehler beim Generieren der Erstnachricht:', err.message);
      console.error('❌ Stack:', err.stack);
      // Fallback: Weiter mit normaler Pipeline
    }
  }

  // Like/Kuss OHNE Kundentext (Kunde hat nur geliked/geküsst, keine Nachricht): Immer "Danke + Gesprächsstarter", nie ASA
  // Trifft zu wenn wir z.B. ein Bild geschickt haben und der Kunde nur mit Like reagiert – dann kein ASA, sondern Danke + Fragen
  if (!isAVZ && !isFirstMessage && (hasLikeSystemMessage || hasKussSystemMessage) && (!foundMessageText || foundMessageText.trim() === "")) {
    console.log("✅ Like/Kuss ohne Kundentext – generiere Danke + Gesprächsstarter (kein ASA).");
    try {
      const likeKussResult = await agentFirstMessageDetector(conversationContextForPipeline || "", "", allMessagesForCheck);
      if (likeKussResult && (likeKussResult.hasLike || likeKussResult.hasKuss) && likeKussResult.instructions) {
        const generatedLikeKussMessage = await generateFirstMessage({
          client: client,
          model: AI_MODEL,
          firstMessageInstructions: likeKussResult.instructions,
          hasLike: likeKussResult.hasLike || false,
          hasKuss: likeKussResult.hasKuss || false,
          profileInfo,
          extractedInfo,
          rules,
          platformId
        });
        if (generatedLikeKussMessage && generatedLikeKussMessage.trim() !== "") {
          const minWait = 40;
          const maxWait = 60;
          const waitTimeLikeKuss = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
          return res.status(200).json({
            resText: generatedLikeKussMessage,
            replyText: generatedLikeKussMessage,
            summary: extractedInfo,
            chatId: chatId || finalChatId || "00000000",
            actions: [{ type: "insert_and_send", delay: waitTimeLikeKuss }],
            assets: [],
            flags: { blocked: false, isFirstMessage: false, noReload: true, skipReload: true, preventReload: true },
            disableAutoSend: true,
            waitTime: waitTimeLikeKuss
          });
        }
      }
    } catch (err) {
      console.error('❌ Like/Kuss-Antwort fehlgeschlagen:', err.message);
    }
  }
  
  // 🚨🚨🚨 SCHRITT 12: MULTI-AGENT-PIPELINE - Nutze das vollständige Multi-Agent-System!
  const isASACalculated = isLastMessageFromFake || false;
  
  // Bereite Kunden-Nachricht vor
  const customerMessage = isASACalculated 
    ? (asaSystemMessage || "ASA Reaktivierung")
    : (removeGreetingWordsAtEnd(foundMessageText || "") || "");
  
  // Extrahiere Situation(en) – nur per LLM, kein Stichwort-Fallback (bei Fehler/leer → allgemein)
  let detectedSituation = 'allgemein';
  let detectedSituations = [];
  if (customerMessage && !isASACalculated) {
    let llmSituations = null;
    try {
      llmSituations = await detectSituationsWithLLM(customerMessage, conversationContextForPipeline);
    } catch (e) {
      // ignore
    }
    if (llmSituations && llmSituations.length > 0) {
      detectedSituations = llmSituations;
      detectedSituation = llmSituations[0] || 'allgemein';
      const msgLower = (customerMessage || '').toLowerCase();
      const isWasWillstDuWissen = /\bwas\s+willst\s+du\s+(den\s+)?wissen\b|\bwas\s+m[oö]chtest\s+du\s+erfahren\b|\bwas\s+willst\s+du\s+von\s+mir\s+(wissen)?\b|\bwas\s+soll\s+ich\s+dir\s+erz[aä]hlen\b/i.test(msgLower);
      if (isWasWillstDuWissen && detectedSituations.includes('Wohnort-Frage')) {
        detectedSituations = detectedSituations.filter(s => s !== 'Wohnort-Frage');
        if (!detectedSituations.includes('Was willst du wissen?')) detectedSituations = ['Was willst du wissen?', ...detectedSituations.filter(s => s !== 'Was willst du wissen?')];
        detectedSituation = detectedSituations[0] || 'allgemein';
        console.log('ℹ️ Wohnort-Frage entfernt (Kunde fragt was du wissen willst), Situation:', detectedSituations.join(', '));
      }
      console.log('✅ Situationen (LLM):', detectedSituations.join(', '));
      // Bot-Vorwurf nur wenn Kunde DICH meint – entfernen wenn Kunde sich gegen Moderator-Vorwurf wehrt
      if (detectedSituations.includes('Bot-Vorwurf')) {
        const allMsgs = req.body?.siteInfos?.messages || [];
        const sentMsgs = allMsgs.filter(m => isSentMessage(m) && typeof m?.text === 'string' && (m.text || '').trim() !== '' && !isInfoMessage(m));
        const lastModText = (sentMsgs.length > 0) ? (sentMsgs[sentMsgs.length - 1]?.text || '').trim().toLowerCase() : '';
        const moderatorAccusedCustomerOfFake = /\b(du\s+)?(bist\s+)?(ein\s+)?(fake|bot|f\s*a\s*k\s*e)\b|\bfake\s*[,?]?\s*(hab\s+ich\s+recht|oder|richtig)\b/i.test(lastModText);
        const customerSelfDenial = /\b(ich\s+bin\s+)(kein(e)?\s+)?(fake|bot)\b|von\s+fake\s+weit\s+entfernt|(bin|ist)\s+echt\s+nicht\s+(fake|bot)|weit\s+entfernt\s+von\s+fake/i.test((customerMessage || '').toLowerCase());
        if (moderatorAccusedCustomerOfFake && customerSelfDenial) {
          detectedSituations = detectedSituations.filter(s => s !== 'Bot-Vorwurf');
          detectedSituation = detectedSituations[0] || 'allgemein';
          console.log('ℹ️ Bot-Vorwurf entfernt: Kunde wehrt sich gegen Moderator-Vorwurf (meint sich selbst).');
        } else {
          // Safeguard: Nur Skepsis ("zu gut um wahr", "hoert sich zu gut an") ohne explizite Anschuldigung = KEIN Bot-Vorwurf
          const msgLower = (customerMessage || '').toLowerCase();
          const onlySkepticism = /\b(zu\s+gut\s+um\s+(wahr|war)\s+zu\s+sein|zu\s+sch[oö]n\s+um\s+wahr|h[oö]rt\s+sich\s+zu\s+gut\s+an|klingt\s+zu\s+gut|klingt\s+zu\s+sch[oö]n)\b/i.test(msgLower);
          const explicitAccusation = /\b(du\s+bist\s+(ein\s+)?(fake|bot)|bist\s+du\s+(ein\s+)?(fake|bot)|fake-profil|du\s+bist\s+kein(e)?\s+(echte?r?\s+)?(mensch|person)|nur\s+(ein\s+)?bot|(du\s+)?(bist\s+)?(ki|k\.i\.|robot|programmiert|automatisch))\b/i.test(msgLower);
          if (onlySkepticism && !explicitAccusation) {
            detectedSituations = detectedSituations.filter(s => s !== 'Bot-Vorwurf');
            detectedSituation = detectedSituations[0] || 'allgemein';
            console.log('ℹ️ Bot-Vorwurf entfernt: Kunde aeussert nur Skepsis ("zu gut um wahr" o.ae.), keine explizite Fake/Bot-Anschuldigung.');
          }
        }
      }
    } else {
      // Option A: Kein Stichwort-Fallback – bei fehlgeschlagener LLM-Erkennung bleibt allgemein
      console.log('⚠️ Situationen (LLM): keine – verwende allgemein (kein Stichwort-Fallback).');
    }
  } else if (isASACalculated) {
    detectedSituation = 'ASA Reaktivierung';
    detectedSituations.push('ASA Reaktivierung');
  }
  
  // Bereite Nachrichten-Arrays vor (für Multi-Agent-Pipeline)
  const allMessages = req.body?.siteInfos?.messages || [];
  const moderatorMessages = allMessages.filter(m => 
    isSentMessage(m) && 
    typeof m?.text === "string" && 
    m.text.trim() !== "" &&
    !isInfoMessage(m)
  );
  const customerMessages = allMessages.filter(m => 
    (m.type === "received" || m.messageType === "received") && 
    typeof m?.text === "string" && 
    m.text.trim() !== "" &&
    !isInfoMessage(m)
  );
  
  // 🚀🚀🚀 NEU: Multi-Stage Generation Pipeline (statt riesiger Prompt)
  // 🎨 FALLBACK: Vereinfachte Pipeline (alte Version)
  // 🚨 FALLBACK: Alte Pipeline bleibt verfügbar für Kompatibilität
  const USE_MULTI_STAGE_PIPELINE = true; // 🚀 Flag: Multi-Stage Pipeline aktivieren
  const USE_SIMPLIFIED_PIPELINE = false; // 🎨 Flag: Vereinfachte Pipeline (nur wenn Multi-Stage deaktiviert)
  
  console.log(`🚀 Starte ${USE_MULTI_STAGE_PIPELINE ? 'Multi-Stage' : (USE_SIMPLIFIED_PIPELINE ? 'vereinfachte' : 'Multi-Agent')}-Pipeline${isASACalculated ? ' (ASA-Modus)' : ''}...`);
  
  let generatedMessage = "";
  let multiAgentResults = null;
  let selectedExamples = []; // Für Feedback-System
  
  try {
    // 🚨 Letzte Moderator-Nachricht = "privates Bild teilen" (Antwort mit "Ja" nötig) → Mensch muss reagieren
    if (allMessages.length > 0 && isLastModeratorMessagePrivateImageRequest(allMessages)) {
      const errMsg = 'Eine Anfrage zum Teilen eines privaten Bildes wurde erkannt. Bitte manuell antworten (z.B. mit "Ja" oder Ablehnung).';
      console.error('🚨 Letzte Moderator-Nachricht ist "privates Bild teilen" – menschliche Reaktion erforderlich');
      return res.status(200).json({
        error: errMsg,
        resText: errMsg,
        replyText: '',
        summary: extractedInfo,
        chatId: chatId || finalChatId || '00000000',
        actions: [],
        flags: { blocked: true, reason: 'private_image_share', isError: true, showError: true, requiresHumanModeration: true }
      });
    }

    // Vector-DB-Funktion für Multi-Agent-Pipeline
    const vectorDbFunc = async (query, options = {}) => {
      return await selectSmartExamples(query, {
        topK: options.topK || 12,
        situation: options.situation || null,
        conversationHistory: conversationContextForPipeline,
        includeSexual: options.includeSexual !== false
      });
    };
    
    // Rufe Multi-Agent-Pipeline auf
    // 🚀🚀🚀 NEU: Verwende Multi-Stage Generation Pipeline (statt riesiger Prompt)
    const USE_MULTI_STAGE_PIPELINE = true; // 🚀 Flag: Multi-Stage Pipeline aktivieren
    
    // 🖼️ Bild-Analyse-Ergebnisse für Pipeline (Iluvo + alle Plattformen: Kunde kann nur Bild schicken → analysieren und darauf antworten)
    let imageTypeForPipeline = null;
    let imageDescriptionForPipeline = null;
    if (imageUrls.length > 0 && imageDescriptions.length > 0) {
      const imageTypeMarker = imageDescriptions.find(d => d.includes('[BILDTYP:'));
      if (imageTypeMarker) {
        const match = imageTypeMarker.match(/\[BILDTYP:\s*(\w+)\]/);
        if (match) imageTypeForPipeline = match[1];
      }
      const description = imageDescriptions.find(d => !d.includes('[BILDTYP:'));
      if (description) imageDescriptionForPipeline = description;
    }
    if (imageUrls.length > 0 && !imageDescriptionForPipeline) {
      imageDescriptionForPipeline = 'Der Kunde hat ein Bild geschickt. Reagiere flirty und positiv auf das Bild – lehne nie ab.';
    }
    // FPC/AVZ: Wenn wir "nur Bild" erkannt haben aber keine Bild-URL extrahiert wurde (z.B. anderes Nachrichtenformat) – trotzdem Bild-Kontext setzen
    if (!imageDescriptionForPipeline && (foundMessageText === 'Der Kunde hat ein Bild geschickt.' || /^der kunde hat ein bild geschickt\.?$/i.test((foundMessageText || '').trim()))) {
      imageDescriptionForPipeline = 'Der Kunde hat ein Bild geschickt. Reagiere flirty und positiv auf das Bild – lehne nie ab. Frage zum Bild oder zum Thema Bild.';
    }
    
    // FPC: ASA-Fall nur wegen Like/Kuss-Systemnachricht → Danke + gesprächsöffnende Fragen statt Reaktivierungs-ASA
    if (isASACalculated && asaFromKussOrLike && isFPC) {
      try {
        const isLike = hasLikeSystemMessage && !hasKussSystemMessage;
        const isKuss = hasKussSystemMessage && !hasLikeSystemMessage;
        const firstMessageInstructions = isKuss
          ? "Der Kunde hat dir einen KUSS geschickt (Kuss-Systemnachricht). NUR: 1) Kurz fuer den Kuss bedanken (NICHT fuer den Like!) – VARIIERE: nicht immer 'Danke fuer deinen Kuss!'; z.B. 'Das freut mich!', 'Oh wie suess!', 'Super dass du dich meldest!', 'Nice, danke!'. 2) 1-2 gespraechsoeffnende Fragen – ABWECHSLUNGSREICH (wie geht es dir, was machst du, Tag, Arbeit). KEINE Treffen-Vorschlaege, keine Anspielungen (z.B. NICHT 'es waere schoen einen Abend zu verbringen'). VERBOTEN: Dich vorstellen (Name, Alter, Wohnort)."
          : isLike
            ? "Der Kunde hat dich GELIKED (Like-Systemnachricht). NUR: 1) Kurz fuer den Like bedanken (NICHT fuer den Kuss!) – VARIIERE: nicht immer 'Danke fuer deinen Like!'; z.B. 'Das freut mich!', 'Oh wie suess!', 'Super dass du dich meldest!', 'Nice, danke!'. 2) 1-2 gespraechsoeffnende Fragen – ABWECHSLUNGSREICH (wie geht es dir, was machst du, Tag, Arbeit). KEINE Treffen-Vorschlaege, keine Anspielungen (z.B. NICHT 'es waere schoen einen Abend zu verbringen'). VERBOTEN: Dich vorstellen (Name, Alter, Wohnort)."
            : "Der Kunde hat dir einen Kuss oder Like geschickt (System-Nachricht). NUR: Danke (Formulierung variieren) + 1-2 gespraechsoeffnende Fragen – abwechslungsreich, KEINE Treffen-Anspielungen. VERBOTEN: Dich vorstellen (kein Name, kein Alter, kein Wohnort).";
        const likeKussMessage = await generateFirstMessage({
          client,
          firstMessageInstructions,
          hasLike: hasLikeSystemMessage,
          hasKuss: hasKussSystemMessage,
          profileInfo,
          extractedInfo: extractedInfo,
          rules: rules,
          platformId: platformId || 'fpc'
        });
        multiAgentResults = { finalMessage: likeKussMessage || '' };
        console.log('✅ FPC: ASA durch Like/Kuss-Systemnachricht – Danke + Fragen statt Reaktivierungs-ASA generiert');
      } catch (err) {
        console.error('❌ FPC Like/Kuss-ASA:', err.message);
        multiAgentResults = { finalMessage: '' };
      }
    } else if (USE_GROK_PIPELINE && !isASACalculated) {
      // 🚀 Grok-Pipeline: normale Reply + Stadtauswahl (ASA/Erstnachricht laufen über anderen Pfad)
      console.log('🚀 Verwende Grok-Pipeline (xAI)...');
      let grokLearningContext = '';
      try {
        const learningStats = await getLearningStats();
        if (learningStats && Object.keys(learningStats).length > 0) {
          grokLearningContext = await generateCompactLearningContext(
            customerMessage,
            detectedSituations.length > 0 ? detectedSituations : detectedSituation,
            learningStats
          );
          if (grokLearningContext) console.log('✅ Learning-Context für Grok geladen');
        }
      } catch (e) {
        console.warn('⚠️ Learning-Context für Grok nicht verfügbar:', e?.message || e);
      }
      // Bild nur angekündigt: Kunde kündigt Bild an, hat aber noch keins geschickt → kein "Danke für das Bild"
      const hasImageInThisTurn = (foundMessageText === 'Der Kunde hat ein Bild geschickt.') || (imageUrls && imageUrls.length > 0);
      const imageOnlyAnnounced = customerAnnouncesImageOnly(customerMessage) && !hasImageInThisTurn;
      if (imageOnlyAnnounced) console.log('✅ Bild nur angekündigt – setze imageOnlyAnnounced für Pipeline');

      // Kunde behauptet Bild geschickt zu haben, aber es ist keins da → sagen dass kein Bild ankommen ist, nicht so tun als ob
      const siteMessages = req.body?.siteInfos?.messages || [];
      const hasRecentImage = hasRecentReceivedImageInMessages(siteMessages, { origin: (req.body?.siteInfos?.origin || '').toLowerCase() });
      const imageClaimedButNotPresent = customerClaimsToHaveSentImage(customerMessage) && !hasImageInThisTurn && !imageDescriptionForPipeline && !hasRecentImage;
      if (imageClaimedButNotPresent) console.log('✅ Kunde behauptet Bild geschickt – keins angekommen, setze imageClaimedButNotPresent für Pipeline');

      const moderatorOfferedPicture = didModeratorOfferPicture(req.body?.siteInfos?.messages || []);
      if (moderatorOfferedPicture) console.log('✅ Fake hatte Bild angeboten – keine Ablehnungs-Begründung in Antwort');

      const imageAlreadySentToCustomer = lastMessageFromFakeHadImage(req.body?.siteInfos?.messages || []);
      if (imageAlreadySentToCustomer) console.log('✅ Letzte Fake-Nachricht enthielt ein Bild – Kunde hat es gesehen, setze imageAlreadySentToCustomer');

      multiAgentResults = await runGrokPipeline({
        conversationHistory: conversationContextForPipeline,
        customerMessage: customerMessage,
        profileInfo: profileInfo,
        extractedUserInfo: extractedInfo,
        allRules: rules,
        trainingData: trainingData,
        isASA: false,
        asaConversationContext: '',
        isLocationQuestionFunc: isLocationQuestion,
        findNearbyCityFunc: (city) => findNearbyCity(city, { client, model: AI_MODEL }),
        vectorDbFunc: vectorDbFunc,
        learningContext: grokLearningContext,
        detectedSituationsFromReply: detectedSituations.filter(s => s && s !== 'allgemein'),
        alertBoxMessages,
        imageDescription: imageDescriptionForPipeline,
        imageType: imageTypeForPipeline,
        imageOnlyAnnounced,
        imageClaimedButNotPresent: !!imageClaimedButNotPresent,
        moderatorOfferedPicture,
        imageAlreadySentToCustomer: !!imageAlreadySentToCustomer
      });
      // FPC/AVZ Logbuch: Wohnort nur übernehmen, wenn der Kunde nach dem Wohnort gefragt hat UND der Fake noch keinen Wohnort hat (kein zweiter Eintrag)
      const isWohnortFrage = detectedSituations && detectedSituations.some(s => s === 'Wohnort-Frage');
      const fakeAlreadyHasWohnort = fakeHasWohnortAlready(profileInfo, extractedInfo);
      if (isWohnortFrage && !fakeAlreadyHasWohnort && multiAgentResults && multiAgentResults.locationContext && multiAgentResults.locationContext.fakeCity) {
        extractedInfo.assistant = extractedInfo.assistant || {};
        extractedInfo.assistant.Stadt = multiAgentResults.locationContext.fakeCity;
        extractedInfo.assistant.Wohnort = multiAgentResults.locationContext.fakeCity;
      }
      // Beruf nur in Summary, wenn es gerade um Beruf geht – sonst schreibt Extension bei jeder
      // Nachricht einen Job ins Logbuch, obwohl es nicht Thema ist.
      const isBerufsfrage = (detectedSituation && (String(detectedSituation).toLowerCase().includes('beruf') || String(detectedSituation).toLowerCase().includes('arbeit'))) ||
        (detectedSituations && detectedSituations.some(s => s && (String(s).toLowerCase().includes('beruf') || String(s).toLowerCase().includes('arbeit'))));
      if (isBerufsfrage && profileInfo?.moderatorInfo?.occupation) {
        extractedInfo.assistant = extractedInfo.assistant || {};
        if (!extractedInfo.assistant.Work && !extractedInfo.assistant.Beruf) {
          extractedInfo.assistant.Work = profileInfo.moderatorInfo.occupation;
        }
      }
    } else if (USE_MULTI_STAGE_PIPELINE) {
      const { runMultiStagePipeline } = require('../utils/multi-agent');
      multiAgentResults = await runMultiStagePipeline({
        conversationHistory: conversationContextForPipeline,
        customerMessage: customerMessage,
        profileInfo: profileInfo,
        extractedUserInfo: extractedInfo,
        allRules: rules,
        trainingData: trainingData,
        situations: [detectedSituation].filter(s => s && s !== 'allgemein'),
        imageUrl: imageUrls.length > 0 ? imageUrls[0] : null,
        imageType: imageTypeForPipeline, // 🚨 NEU: Bildtyp übergeben
        imageDescription: imageDescriptionForPipeline, // 🚨 NEU: Bildbeschreibung übergeben
        moderatorMessages: moderatorMessages,
        customerMessages: customerMessages,
        allMessages: allMessages,
        feedbackData: feedbackData,
        vectorDbFunc: vectorDbFunc,
        isASA: isASACalculated,
        asaConversationContext: asaSystemMessage || '',
        isMeetingRequestFunc: (msg, context) => isMeetingRequest(msg, context || customerMessage),
        isLocationQuestionFunc: isLocationQuestion, // 🚨 NEU: Für Stadt-Suche
        findNearbyCityFunc: (city) => findNearbyCity(city, { client, model: AI_MODEL }) // OpenAI-Modell für Stadt (getMessageModel kann Together-ID sein → 400)
      });
    } else if (USE_SIMPLIFIED_PIPELINE) {
      // Fallback: Vereinfachte Pipeline (alte Version)
      multiAgentResults = await runSimplifiedPipeline({
        conversationHistory: conversationContextForPipeline,
        customerMessage: customerMessage,
        profileInfo: profileInfo,
        extractedUserInfo: extractedInfo,
        allRules: rules,
        trainingData: trainingData,
        situations: [detectedSituation].filter(s => s && s !== 'allgemein'),
        imageUrl: imageUrls.length > 0 ? imageUrls[0] : null,
        moderatorMessages: moderatorMessages,
        customerMessages: customerMessages,
        allMessages: allMessages,
        feedbackData: feedbackData,
        vectorDbFunc: vectorDbFunc,
        isASA: isASACalculated,
        asaConversationContext: asaSystemMessage || '',
        isMeetingRequestFunc: (msg, context) => isMeetingRequest(msg, context || customerMessage)
      });
    } else {
      // ALTE PIPELINE (für Kompatibilität)
      multiAgentResults = await runMultiAgentPipeline({
        conversationHistory: conversationContextForPipeline,
        customerMessage: customerMessage,
        profileInfo: profileInfo,
        extractedUserInfo: extractedInfo,
        allRules: rules,
        trainingData: trainingData,
        situations: [detectedSituation].filter(s => s && s !== 'allgemein'),
        imageUrl: imageUrls.length > 0 ? imageUrls[0] : null,
        moderatorMessages: moderatorMessages,
        customerMessages: customerMessages,
        allMessages: allMessages,
        feedbackData: feedbackData,
        vectorDbFunc: vectorDbFunc,
        imageAnalysisFunc: async (url, context) => await analyzeProfilePicture(client, url, 'customer'),
        proactiveAnalysisFunc: null,
        analyzeWritingStyleFunc: analyzeWritingStyle,
        isInfoMessageFunc: isInfoMessage,
        isASA: isASACalculated,
        asaConversationContext: asaSystemMessage || '',
        isLocationQuestionFunc: isLocationQuestion,
        findNearbyCityFunc: (city) => findNearbyCity(city, { client, model: AI_MODEL }),
        isMeetingRequestFunc: (msg, context) => isMeetingRequest(msg, context || customerMessage)
      });
    }
    
    // 🚨 FIX: Prüfe ob Pipeline blockiert wurde
    if (multiAgentResults && multiAgentResults.blocked) {
      // Pipeline wurde blockiert (Safety-Check)
      console.error(`🚨 Multi-Agent-Pipeline: BLOCKIERT - ${multiAgentResults.error || multiAgentResults.safety?.reason}`);
      return res.status(200).json({
        error: multiAgentResults.error || multiAgentResults.safety?.errorMessage || "❌ FEHLER: Nachricht wurde blockiert.",
        resText: multiAgentResults.error || multiAgentResults.safety?.errorMessage || "",
        replyText: multiAgentResults.error || multiAgentResults.safety?.errorMessage || "",
        summary: extractedInfo,
        chatId: chatId || finalChatId || "00000000",
        actions: [],
        flags: { blocked: true, reason: multiAgentResults.safety?.reason || "safety_check", isError: true, showError: true }
      });
    }
    
    // 🌍 Wohnort-Frage ohne Orientierung (weder Fake- noch Kunden-Wohnort) → Fehlermeldung für manuelle Bearbeitung
    if (multiAgentResults && multiAgentResults.locationQuestionError) {
      const locErr = multiAgentResults.locationQuestionError;
      console.error(`🌍 Wohnort-Frage: Keine Orientierung – ${locErr.message}`);
      return res.status(200).json({
        error: locErr.message,
        resText: locErr.message,
        replyText: "",
        summary: extractedInfo,
        chatId: chatId || finalChatId || "00000000",
        actions: [],
        flags: { blocked: true, reason: "location_question_error", isError: true, showError: true, requiresHumanModeration: true }
      });
    }
    
    // 🌍 FIX: Prüfe ob Nachricht nicht auf Deutsch ist → verwende spezifische Antwort
    if (multiAgentResults && multiAgentResults.needsGermanResponse && multiAgentResults.germanResponse) {
      console.log(`🌍 Language-Detector: NICHT-DEUTSCHE Sprache erkannt - verwende spezifische Antwort`);
      generatedMessage = multiAgentResults.germanResponse;
      console.log(`✅ Language-Detector: Spezifische Antwort generiert (${generatedMessage.length} Zeichen)`);
      // 🚨 WICHTIG: Überspringe Message-Generator, da bereits spezifische Antwort vorhanden ist
    } else if (multiAgentResults && !multiAgentResults.blocked) {
      // 🚀 Multi-Stage oder Grok-Pipeline: Nachricht ist bereits generiert
      if ((USE_MULTI_STAGE_PIPELINE || USE_GROK_PIPELINE) && multiAgentResults.finalMessage) {
        generatedMessage = multiAgentResults.finalMessage;
        console.log(`✅ ${USE_GROK_PIPELINE ? 'Grok' : 'Multi-Stage'}-Pipeline: Nachricht erfolgreich generiert (${generatedMessage.length} Zeichen)`);
        
        // Extrahiere selectedExamples für Feedback-System
        if (multiAgentResults.stage2Examples && multiAgentResults.stage2Examples.selectedExamples) {
          selectedExamples = multiAgentResults.stage2Examples.selectedExamples;
        } else if (multiAgentResults.training && multiAgentResults.training.selectedExamples) {
          selectedExamples = multiAgentResults.training.selectedExamples;
        }
      } else {
        // Kein Fallback: Pipeline (Grok/Multi-Stage) hat keine Nachricht geliefert – keine andere Generierung
        console.error('❌ ' + (USE_GROK_PIPELINE ? 'Grok' : 'Multi-Stage') + '-Pipeline: Keine Nachricht geliefert (finalMessage fehlt) – kein Fallback');
        generatedMessage = "";
      }
    } else {
      console.error('❌ Multi-Agent-Pipeline: Keine Nachricht generiert (Pipeline fehlgeschlagen oder blockiert)');
      generatedMessage = "";
    }

    // ASA: Namen aus Beispiel (z.B. "Alex") durch echten Kundennamen ersetzen
    if (isASACalculated && generatedMessage && generatedMessage.trim()) {
      const asaCustomerName = (profileInfo?.customerInfo?.name || profileInfo?.customerInfo?.firstName || profileInfo?.customerInfo?.Vorname || extractedInfo?.user?.Name || '').toString().trim();
      if (asaCustomerName) {
        const before = generatedMessage;
        generatedMessage = replaceASABeispielNameWithCustomer(generatedMessage, asaCustomerName);
        if (generatedMessage !== before) console.log('✅ ASA: Beispielname durch Kundennamen ersetzt:', asaCustomerName);
      }
    }
  } catch (err) {
    console.error('❌ FEHLER in Multi-Agent-Pipeline:', err.message);
    console.error('❌ Stack:', err.stack);
    generatedMessage = "";
  }
  
  // Wenn keine Nachricht generiert wurde, gebe Fehler zurück
  if (!generatedMessage || generatedMessage.trim() === "") {
    console.error('❌ Keine Nachricht generiert - Multi-Agent-Pipeline fehlgeschlagen');
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

  // FPC/AVZ Logbuch: Fake-Infos aus der generierten Antwort in summary.assistant übernehmen
  // Wohnort/Stadt nur übernehmen, wenn der Kunde nach dem Wohnort gefragt hat UND der Fake noch keinen Wohnort hat (kein zweiter Eintrag)
  const isWohnortFrageForMerge = detectedSituations && detectedSituations.some(s => s === 'Wohnort-Frage');
  const fakeAlreadyHasWohnortForMerge = fakeHasWohnortAlready(profileInfo, extractedInfo);
  if (client && generatedMessage && generatedMessage.trim() !== "") {
    try {
      const assistantFromReply = await extractAssistantInfoFromGeneratedMessage(client, generatedMessage);
      if (assistantFromReply && typeof assistantFromReply === "object" && Object.keys(assistantFromReply).length > 0) {
        extractedInfo.assistant = extractedInfo.assistant || {};
        const profileModName = profileInfo?.moderatorInfo?.name && String(profileInfo.moderatorInfo.name).trim();
        Object.keys(assistantFromReply).forEach((key) => {
          if (assistantFromReply[key] == null || assistantFromReply[key] === "") return;
          if ((key === "Stadt" || key === "Wohnort") && (!isWohnortFrageForMerge || fakeAlreadyHasWohnortForMerge)) return;
          if (key === "Name") {
            const display = toFakeDisplayNameOnly(assistantFromReply[key]);
            if (display && !looksLikeUsername(display)) extractedInfo.assistant["Name"] = display;
            return;
          }
          extractedInfo.assistant[key] = assistantFromReply[key];
        });
        // Profil-Name nur übernehmen, wenn er wie Anzeigename wirkt – nie Benutzername (z.B. "Arbeitsamgut", "SchwarzeDom") ins Logbuch
        const profileFirstName = profileInfo?.moderatorInfo?.firstName && String(profileInfo.moderatorInfo.firstName).trim();
        const nameSource = profileFirstName || profileModName;
        if (nameSource) {
          const profileDisplay = toFakeDisplayNameOnly(nameSource);
          if (profileDisplay && !looksLikeUsername(profileDisplay)) extractedInfo.assistant["Name"] = profileDisplay;
        }
        const city = (extractedInfo.assistant.Wohnort || extractedInfo.assistant.Stadt || "").trim();
        if (city && extractedInfo.assistant.Other) {
          const otherVal = String(extractedInfo.assistant.Other).trim();
          if (otherVal === city) {
            delete extractedInfo.assistant.Other;
          } else {
            const cleaned = otherVal.replace(new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim().replace(/\s*,\s*,/g, ",").replace(/^,\s*|,\s*$/g, "");
            if (cleaned) extractedInfo.assistant.Other = cleaned; else delete extractedInfo.assistant.Other;
          }
        }
        // Kunden-Infos nicht im Fake-Logbuch: Was der Kunde über SICH sagt (z.B. Wohnmobil, Reise bis 20.02) nur beim Kunden loggen
        const customerText = [foundMessageText, extractedInfo.user?.Updates, extractedInfo.user?.Other].filter(Boolean).join(" ");
        if (extractedInfo.assistant.Other && customerText.length >= 10) {
          const otherVal = String(extractedInfo.assistant.Other).trim();
          const customerNorm = customerText.replace(/\s+/g, " ").trim().toLowerCase();
          const otherNorm = otherVal.replace(/\s+/g, " ").toLowerCase();
          if (otherNorm.length >= 12 && customerNorm.includes(otherNorm)) {
            delete extractedInfo.assistant.Other;
          }
        }
        // Schmerzen/Klo-Tabu: aus Health/Other in Sexual Preferences zusammenführen, gleichen Eintrag beim Kunden
        mergeSexualTabooIntoPreferences(extractedInfo);
        console.log("📝 Fake-Logbuch aus generierter Antwort:", JSON.stringify(assistantFromReply));
      }
    } catch (err) {
      console.warn("⚠️ Extraktion Fake aus Antwort (nicht kritisch):", err.message);
    }
  }

  // AVZ/FPC: Name im Fake-Logbuch nur Anzeigename (z. B. "Stefania", "Dominika"), NIEMALS Benutzername (z. B. "Arbeitsamgut", "SchwarzeDom")
  if ((isFPC || isAVZ || isBlenny) && (profileInfo?.moderatorInfo?.firstName || profileInfo?.moderatorInfo?.name)) {
    extractedInfo.assistant = extractedInfo.assistant || {};
    // Immer firstName bevorzugen – name ist oft der Benutzername (Arbeitsamgut), firstName der echte Name (Stefania)
    const raw = String(profileInfo.moderatorInfo.firstName || profileInfo.moderatorInfo.name || '').trim();
    if (raw) {
      const candidate = toFakeDisplayNameOnly(raw);
      if (candidate && !looksLikeUsername(candidate)) extractedInfo.assistant["Name"] = candidate;
      else if (looksLikeUsername(candidate)) delete extractedInfo.assistant["Name"];
    }
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
    // 🚨 FIX: Prüfe ob generatedMessage vorhanden und nicht leer ist
    if (!generatedMessage || generatedMessage.trim() === "") {
      console.warn('⚠️ Feedback-Eintrag übersprungen: generatedMessage ist leer oder nicht vorhanden');
    } else {
      // Finde letzte Moderator-Nachricht für besseren Kontext
      const lastModeratorMessage = req.body?.siteInfos?.messages
        ?.filter(m => isSentMessage(m) && !isInfoMessage(m))
        ?.slice(-1)?.[0]?.text || null;
      
      // 🚨 FIX: Entferne doppelte Felder und stelle sicher, dass customerMessage und aiResponse vorhanden sind
      // 🚨 WICHTIG: Bei ASA-Fällen ist foundMessageText leer - verwende Fallback
      let customerMessageForFeedback = foundMessageText || "";
      if (isASACalculated && !customerMessageForFeedback) {
        // Bei ASA: Verwende die letzte Kunden-Nachricht aus dem Gesprächsverlauf
        const lastCustomerMsg = req.body?.siteInfos?.messages
          ?.filter(m => (m.type === "received" || m.messageType === "received") && !isInfoMessage(m))
          ?.slice(-1)?.[0]?.text;
        customerMessageForFeedback = lastCustomerMsg || "ASA Reaktivierung";
      }
      // 🚨 FIX: Erstnachricht ohne Kundentext (z. B. nur Like/Kuss) – Platzhalter damit Feedback-API nicht 400 wirft
      if (!isASACalculated && (!customerMessageForFeedback || !customerMessageForFeedback.trim()) && isFirstMessage) {
        customerMessageForFeedback = "Erstnachricht (keine Kundennachricht)";
      }
      
      // 🚨 NEU: Erstelle Beispiel-IDs für verwendete Beispiele
      const usedExampleIds = selectedExamples.map((ex) => {
        // Priorität: feedbackId > index > customerMessage|moderatorResponse
        if (ex.feedbackId) {
          return ex.feedbackId;
        } else if (ex.index !== null && ex.index !== undefined) {
          return `training_${ex.index}`;
        } else {
          // Fallback: Erstelle eindeutige ID aus customerMessage + moderatorResponse
          return `${ex.customerMessage || ''}|${ex.moderatorResponse || ''}`;
        }
      });
      
      const feedbackPayload = {
        chatId: chatId || finalChatId || "00000000",
        customerMessage: customerMessageForFeedback,
        aiResponse: generatedMessage, // 🚨 FIX: Stelle sicher, dass aiResponse gesetzt ist
        platform: platformId || 'viluu',
        isASA: isASACalculated || false,
        usedExampleIds: usedExampleIds, // 🚨 NEU: Speichere verwendete Beispiel-IDs für Learning-System
        context: {
          detectedSituations: detectedSituations.filter(s => s && s !== 'allgemein'), // Alle erkannten Situationen (Multi-Situation)
          mood: 'neutral', // Stimmung wird nicht mehr verwendet
          style: 'neutral',
          topic: 'allgemein'
        }
      };
      
      // 🚨 FIX: Nur hinzufügen, wenn wirklich vorhanden (verhindert doppelte Felder)
      if (lastModeratorMessage) {
        feedbackPayload.context.lastModeratorMessage = lastModeratorMessage;
      }
      
      // 🚨 FIX: Debug-Logging für Feedback-Payload (inkl. isASA)
      console.log(`📊 Feedback-Eintrag wird erstellt: chatId=${feedbackPayload.chatId}, isASA=${feedbackPayload.isASA}, aiResponse=${generatedMessage.substring(0, 50)}... (${generatedMessage.length} Zeichen)`);
      
      // 🚨 FIX: ASA-Feedbacks müssen auch ankommen - verwende await statt .then() für bessere Fehlerbehandlung
      const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
      const FEEDBACK_TIMEOUT_MS = 20000; // 20 Sekunden (GitHub-Push kann dauern)
      const sendFeedback = async (attempt = 1) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FEEDBACK_TIMEOUT_MS);
        try {
          const response = await fetch(`${baseUrl}/api/v1/feedback`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(req.headers.authorization ? { 'Authorization': req.headers.authorization } : {})
            },
            body: JSON.stringify(feedbackPayload),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (response.ok) {
            const result = await response.json();
            console.log(`✅ Feedback-Eintrag erfolgreich erstellt: ${result.feedback?.id || 'unbekannt'} (isASA: ${feedbackPayload.isASA}, chatId: ${feedbackPayload.chatId})`);
            if (feedbackPayload.isASA) {
              console.log(`📊 ASA-Feedback erfolgreich gespeichert: ${result.feedback?.id}`);
            } else {
              console.log(`📊 Normales Feedback erfolgreich gespeichert: ${result.feedback?.id}`);
            }
            return true;
          }
          const errorText = await response.text();
          console.warn(`⚠️ Feedback-Eintrag konnte nicht erstellt werden: ${response.status} - ${errorText} (isASA: ${feedbackPayload.isASA}, Versuch ${attempt})`);
          return false;
        } catch (err) {
          clearTimeout(timeoutId);
          if (err.name === 'AbortError') {
            console.warn(`⚠️ Feedback-Request Timeout nach ${FEEDBACK_TIMEOUT_MS}ms (isASA: ${feedbackPayload.isASA}, Versuch ${attempt})`);
          } else {
            console.warn(`⚠️ Fehler beim Erstellen des Feedback-Eintrags (isASA: ${feedbackPayload.isASA}, Versuch ${attempt}):`, err.message);
          }
          return false;
        }
      };
      try {
        let ok = await sendFeedback(1);
        if (!ok) {
          console.log('🔄 Feedback-Retry (1x)...');
          await new Promise(r => setTimeout(r, 2000));
          ok = await sendFeedback(2);
        }
        if (!ok) {
          console.warn(`❌ Feedback nach 2 Versuchen nicht gespeichert (chatId: ${feedbackPayload.chatId})`);
        }
      } catch (err) {
        console.warn(`⚠️ Fehler beim Erstellen des Feedback-Eintrags (nicht kritisch, isASA: ${feedbackPayload.isASA}):`, err.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Vorbereiten des Feedback-Eintrags (nicht kritisch):', err.message);
    console.warn('⚠️ Stack:', err.stack);
  }
  
  const noQuestionError = !!(multiAgentResults && multiAgentResults.noQuestionError);
  if (isAVZ) {
    console.log(`✅ AVZ: Antwort mit insert_and_send, delay=${waitTime}s (Extension: Timer + Auto-Send wie FPC)`);
  }
  if (isBlenny) {
    console.log(`✅ Blenny: Antwort mit insert_and_send, delay=${waitTime}s (Extension: Timer nach Tippen wie FPC)`);
  }

  // Blenny/FPC: Immer Deutsch – "Friend request" in der Antwort durch "Freundschaftsanfrage" ersetzen
  if (generatedMessage && typeof generatedMessage === 'string') {
    generatedMessage = generatedMessage.replace(/\bFriend\s*Request\b/gi, 'Freundschaftsanfrage');
  }

  // Logbuch: NIEMALS die komplette KI-Nachricht in user.Other oder assistant.Other zurückgeben – sonst schreibt die Extension sie ins Kunden-/Fake-Logbuch "Sonstiges" (z. B. Blenny/DF).
  if (generatedMessage && typeof generatedMessage === 'string' && generatedMessage.trim()) {
    const msgTrim = generatedMessage.trim();
    const isLikelyGeneratedMessage = (text) => {
      if (!text || typeof text !== 'string') return false;
      const t = text.trim();
      if (t.length < 80) return false;
      if (t === msgTrim) return true;
      const start = msgTrim.substring(0, 60);
      if (t.includes(start) || (t.length > 150 && msgTrim.includes(t.substring(0, 50)))) return true;
      if (/\b(macht\s+mich|feuchter|Muschi|Schatz\s*\?|erzähl\s+(endlich|mir)|für\s+dich|Vorfreude|Frechdachs|anstellen\s+würdest|pocht|pulsiert)\b/i.test(t)) return true;
      return false;
    };
    if (extractedInfo.user && extractedInfo.user.Other && isLikelyGeneratedMessage(extractedInfo.user.Other)) {
      delete extractedInfo.user.Other;
    }
    if (extractedInfo.assistant && extractedInfo.assistant.Other && isLikelyGeneratedMessage(extractedInfo.assistant.Other)) {
      delete extractedInfo.assistant.Other;
    }
  }

  // Extension (FPC/AVZ/Blenny): "Detected prompt" = erkannte Kundennachricht anzeigen – promptType + prompt immer mitsenden
  const detectedPrompt = (typeof foundMessageText === 'string' && foundMessageText.trim())
    ? foundMessageText.trim().slice(0, 500)
    : (extractedInfo?.user && Object.keys(extractedInfo.user).length > 0)
      ? JSON.stringify(extractedInfo.user)
      : '';

  return res.status(200).json({
    resText: generatedMessage,
    replyText: generatedMessage,
    summary: extractedInfo,
    promptType: detectedPrompt || undefined,
    prompt: detectedPrompt || undefined,
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
      noReload: true,
      skipReload: true,
      preventReload: true,
      noQuestionError, // Nachricht enthaelt keine Frage (nach 2 Versuchen) – Extension soll rote Meldung anzeigen
      ...(noQuestionError ? { showError: true, errorType: 'no_question', errorColor: 'red', errorMessage: 'Keine Frage generiert – bitte tracken.' } : {})
    },
    disableAutoSend: true,
    waitTime: waitTime,
    noReload: true
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