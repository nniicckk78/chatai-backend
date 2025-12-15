const express = require("express");
const fs = require("fs");
const path = require("path");
const { verifyToken } = require("../auth");
const { getClient } = require("../openaiClient");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
const router = express.Router();

// Wenn SKIP_AUTH=true gesetzt ist, Auth überspringen
const SKIP_AUTH = process.env.SKIP_AUTH === "true";

// Auth Middleware
router.use((req, res, next) => {
  if (SKIP_AUTH) {
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
    return res.status(401).json({ error: "Token ungültig" });
  }
});

// Helper: Lade Regeln aus GitHub
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
      
      let data = null;
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          data = response.data;
          break;
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
      
      if (data && data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf8');
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
        
        console.log(`✅ [Dashboard] Regeln von GITHUB geladen: ${rules.forbiddenWords.length} verbotene Wörter, ${rules.preferredWords.length} bevorzugte Wörter, ${Object.keys(rules.situationalResponses).length} Situationen`);
        return rules;
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('⚠️ [Dashboard] Fehler beim Laden der Regeln von GitHub:', err.message);
      }
    }
  }
  
  // PRIORITÄT 2: Fallback zu lokaler Datei (nur für lokale Entwicklung)
  const localRulesPath = path.join(__dirname, '../../config/rules.json');
  try {
    if (fs.existsSync(localRulesPath)) {
      const data = fs.readFileSync(localRulesPath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Prüfe ob die Datei leer oder ungültig ist
      if (!parsed || (Object.keys(parsed).length === 0 && !parsed.forbiddenWords && !parsed.preferredWords && !parsed.generalRules && !parsed.situationalResponses)) {
        console.log('⚠️ [Dashboard] Lokale rules.json ist leer oder ungültig');
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
        
        console.log(`⚠️ [Dashboard] Fallback: Regeln von LOKALER Datei geladen (nur für Entwicklung): ${rules.forbiddenWords.length} verbotene Wörter, ${rules.preferredWords.length} bevorzugte Wörter, ${Object.keys(rules.situationalResponses).length} Situationen`);
        return rules;
      }
    }
  } catch (err) {
    console.error('⚠️ [Dashboard] Fehler beim Laden der lokalen Regeln:', err.message);
  }
  
  // PRIORITÄT 3: Erstelle Standard-Struktur (nur wenn nichts gefunden wurde)
  console.log('⚠️ [Dashboard] Keine Regeln gefunden (weder GitHub noch lokal), verwende Standard-Regeln');
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
  
  // Speichere Standard-Regeln in Datei (beim ersten Mal)
  const configDir = path.dirname(localRulesPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  if (!fs.existsSync(localRulesPath)) {
    fs.writeFileSync(localRulesPath, JSON.stringify(defaultRules, null, 2));
    console.log('✅ [Dashboard] Standard-Regeln in lokale Datei gespeichert');
  }
  
  return defaultRules;
}

// Helper: Speichere Regeln auf GitHub (Hauptquelle für Render/Extension)
// WICHTIG: GitHub ist die Hauptquelle, lokale Datei ist nur für Entwicklung!
async function saveRules(rules) {
  const content = JSON.stringify(rules, null, 2);
  
  // PRIORITÄT 1: Pushe auf GitHub (wichtig für Render/Extension!)
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const { pushFileToGitHub } = require("../utils/github");
      // Versuche verschiedene Pfade
      const possiblePaths = [
        'server/src/config/rules.json',
        'src/config/rules.json',
        'config/rules.json',
        'server/config/rules.json'
      ];
      
      let pushed = false;
      for (const filePath of possiblePaths) {
        try {
          await pushFileToGitHub(filePath, content, 'Update rules via Dashboard');
          pushed = true;
          console.log(`✅ [Dashboard] Regeln auf GITHUB gespeichert (${filePath}): ${rules.forbiddenWords?.length || 0} verbotene Wörter, ${rules.preferredWords?.length || 0} bevorzugte Wörter, ${Object.keys(rules.situationalResponses || {}).length} Situationen`);
          break;
        } catch (err) {
          if (err.status === 404) continue; // Versuche nächsten Pfad
          throw err;
        }
      }
      
      if (!pushed) {
        // Falls kein Pfad funktioniert, verwende den Standard-Pfad
        await pushFileToGitHub('server/src/config/rules.json', content, 'Update rules via Dashboard');
        console.log(`✅ [Dashboard] Regeln auf GITHUB gespeichert (Standard-Pfad): ${rules.forbiddenWords?.length || 0} verbotene Wörter, ${rules.preferredWords?.length || 0} bevorzugte Wörter, ${Object.keys(rules.situationalResponses || {}).length} Situationen`);
      }
    } catch (err) {
      console.error('❌ [Dashboard] FEHLER: Konnte Regeln NICHT auf GitHub pushen:', err.message);
      throw new Error(`Regeln konnten nicht auf GitHub gespeichert werden: ${err.message}`);
    }
  } else {
    console.warn('⚠️ [Dashboard] GitHub Client nicht verfügbar - Regeln können nicht auf GitHub gespeichert werden!');
  }
  
  // PRIORITÄT 2: Speichere auch lokal (nur für lokale Entwicklung)
  const rulesPath = path.join(__dirname, '../../config/rules.json');
  try {
    const configDir = path.dirname(rulesPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(rulesPath, content);
    console.log(`✅ [Dashboard] Regeln auch lokal gespeichert (für Entwicklung)`);
  } catch (err) {
    console.warn('⚠️ [Dashboard] Konnte Regeln nicht lokal speichern:', err.message);
    // Lokale Speicherung ist nicht kritisch, daher kein Fehler werfen
  }
}

// Helper: Lade Training Data aus Datei oder GitHub
async function getTrainingData() {
  // Versuche zuerst von GitHub zu laden
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      // Versuche verschiedene Pfade
      const possiblePaths = [
        'server/src/config/training-data.json',
        'src/config/training-data.json',
        'config/training-data.json',
        'server/config/training-data.json'
      ];
      
      let data = null;
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          data = response.data;
          break;
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
      
      if (data && data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const parsed = JSON.parse(content);
        // Speichere auch lokal als Backup
        const trainingPath = path.join(__dirname, '../../config/training-data.json');
        const configDir = path.dirname(trainingPath);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(trainingPath, content);
        return parsed;
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('Fehler beim Laden der Training Data von GitHub:', err.message);
      }
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
  return { conversations: [], asaExamples: [] };
}

// Helper: Speichere Training Data in Datei und auf GitHub
async function saveTrainingData(data) {
  const content = JSON.stringify(data, null, 2);
  const trainingPath = path.join(__dirname, '../../config/training-data.json');
  const configDir = path.dirname(trainingPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(trainingPath, content);
  
  // Versuche auch auf GitHub zu pushen
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const { pushFileToGitHub } = require("../utils/github");
      // Versuche verschiedene Pfade
      const possiblePaths = [
        'server/src/config/training-data.json',
        'src/config/training-data.json',
        'config/training-data.json',
        'server/config/training-data.json'
      ];
      
      let pushed = false;
      for (const filePath of possiblePaths) {
        try {
          await pushFileToGitHub(filePath, content, 'Update training data via Dashboard');
          pushed = true;
          break;
        } catch (err) {
          if (err.status === 404) continue; // Versuche nächsten Pfad
          throw err;
        }
      }
      
      if (!pushed) {
        // Falls kein Pfad funktioniert, verwende den Standard-Pfad
        await pushFileToGitHub('server/src/config/training-data.json', content, 'Update training data via Dashboard');
      }
    } catch (err) {
      console.warn('⚠️ Konnte Training Data nicht auf GitHub pushen:', err.message);
    }
  }
}

// GET /api/v1/rules - Lade Regeln
router.get('/rules', async (req, res) => {
  try {
    let rules = await getRules();
    
    // Stelle sicher, dass Standard-Situationen vorhanden sind
    const defaultSituations = {
      "Bot-Vorwurf": "Reagiere verletzt und abweisend auf diese Unterstellung. Sage klar, dass du KEIN Bot/KI/Fake bist. Frage, warum er das denkt. Sei emotional und menschlich in deiner Reaktion.",
      "Sexuelle Themen": "Wenn der Kunde Komplimente macht, erwidere das Kompliment. Stelle dann eine flirty Frage. Sei offen und flirty, aber nicht übertrieben.",
      "Berufsfrage": "Falls kein Beruf im Logbuch steht, erfinde einen realistischen Beruf. Nenne den Beruf natürlich in deiner Antwort. Keine Flugzeugbegleiter, Zugkontrolleur oder ähnliche Berufe.",
      "Treffen/Termine": "NIEMALS einem Treffen zustimmen oder einen Termin ausmachen! Lenke ab: \"Ich möchte dich noch besser kennenlernen, bevor wir uns treffen\". Sei freundlich, aber weiche der Frage aus.",
      "Geld/Coins": "Nicht über Geld/Coins/aufladen/kostenlos sprechen. Keine Hinweise zum Aufladen geben. Freundlich ausweichen und mit einer zum aktuellen Thema passenden Frage direkt im Gespräch bleiben."
    };
    
    // Merge: Füge fehlende Standard-Situationen hinzu
    const mergedSituations = { ...defaultSituations, ...(rules.situationalResponses || {}) };
    
    // Wenn neue Situationen hinzugefügt wurden, speichere sie
    if (Object.keys(mergedSituations).length > Object.keys(rules.situationalResponses || {}).length) {
      rules.situationalResponses = mergedSituations;
      await saveRules(rules);
    } else {
      rules.situationalResponses = mergedSituations;
    }
    
    res.json(rules);
  } catch (error) {
    console.error('Fehler beim Laden der Regeln:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Regeln' });
  }
});

// PUT /api/v1/rules - Speichere Regeln
router.put('/rules', async (req, res) => {
  try {
    const rules = req.body;
    await saveRules(rules);
    res.json({ success: true, rules });
  } catch (error) {
    console.error('Fehler beim Speichern der Regeln:', error);
    res.status(500).json({ error: 'Fehler beim Speichern der Regeln' });
  }
});

// GET /api/v1/training-data - Lade Training Data
router.get('/training-data', async (req, res) => {
  try {
    const data = await getTrainingData();
    res.json(data);
  } catch (error) {
    console.error('Fehler beim Laden der Training Data:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Training Data' });
  }
});

// POST /api/v1/training-data - Füge Gespräch hinzu
router.post('/training-data', async (req, res) => {
  try {
    const { customerMessage, moderatorResponse, situation } = req.body;
    if (!customerMessage || !moderatorResponse) {
      return res.status(400).json({ error: 'Kunden-Nachricht und Moderator-Antwort sind erforderlich' });
    }

    const data = await getTrainingData();
    data.conversations = data.conversations || [];
    data.conversations.push({
      customerMessage,
      moderatorResponse,
      situation: situation || 'allgemein',
      createdAt: new Date().toISOString()
    });
    await saveTrainingData(data);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Fehler beim Hinzufügen der Training Data:', error);
    res.status(500).json({ error: 'Fehler beim Hinzufügen der Training Data' });
  }
});

// POST /api/v1/training-data/asa - Füge ASA-Beispiel hinzu
router.post('/training-data/asa', async (req, res) => {
  try {
    const { customerType, lastTopic, asaMessage } = req.body;
    if (!customerType || !asaMessage) {
      return res.status(400).json({ error: 'Kunden-Typ und ASA-Nachricht sind erforderlich' });
    }

    const data = await getTrainingData();
    data.asaExamples = data.asaExamples || [];
    data.asaExamples.push({
      customerType,
      lastTopic: lastTopic || null,
      asaMessage,
      createdAt: new Date().toISOString()
    });
    await saveTrainingData(data);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Fehler beim Hinzufügen der ASA:', error);
    res.status(500).json({ error: 'Fehler beim Hinzufügen der ASA' });
  }
});

// DELETE /api/v1/training-data/asa/:index - Lösche ASA-Beispiel
router.delete('/training-data/asa/:index', async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const data = await getTrainingData();
    if (data.asaExamples && data.asaExamples[index]) {
      data.asaExamples.splice(index, 1);
      await saveTrainingData(data);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'ASA-Beispiel nicht gefunden' });
    }
  } catch (error) {
    console.error('Fehler beim Löschen der ASA:', error);
    res.status(500).json({ error: 'Fehler beim Löschen der ASA' });
  }
});

// DELETE /api/v1/training-data/:index - Lösche Gespräch
router.delete('/training-data/:index', async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const data = await getTrainingData();
    if (data.conversations && data.conversations[index]) {
      data.conversations.splice(index, 1);
      await saveTrainingData(data);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Gespräch nicht gefunden' });
    }
  } catch (error) {
    console.error('Fehler beim Löschen der Training Data:', error);
    res.status(500).json({ error: 'Fehler beim Löschen der Training Data' });
  }
});

// POST /api/v1/test-chat - Test Chat
router.post('/test-chat', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Nachricht ist erforderlich' });
    }

    const client = getClient();
    if (!client) {
      return res.status(500).json({ error: 'OpenAI Client nicht verfügbar' });
    }

    const rules = await getRules();
    const trainingData = await getTrainingData();

    // Zeit/Datum für DACH (Europe/Berlin)
    const now = new Date();
    const nowString = now.toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour12: false });
    const month = now.getMonth() + 1;
    const season = month === 12 || month <= 2 ? "Winter" : month <= 5 ? "Frühling" : month <= 8 ? "Sommer" : "Herbst";

    const lowerMessage = message.toLowerCase();

    // Erkenne Situationen (wie im reply.js)
    const isBotAccusation = lowerMessage.includes("bot") || lowerMessage.includes("ki") || 
                           lowerMessage.includes("künstliche intelligenz") || 
                           lowerMessage.includes("chatgpt") || lowerMessage.includes("fake") ||
                           lowerMessage.includes("automatisch") || lowerMessage.includes("programmiert");
    
    const isModeratorQuestion = lowerMessage.includes("moderator") || lowerMessage.includes("chatmoderator") ||
                               lowerMessage.includes("chat-moderator") || lowerMessage.includes("chat moderator");
    
    const isSexualTopic = lowerMessage.includes("titten") || lowerMessage.includes("brüste") ||
                         lowerMessage.includes("arsch") || lowerMessage.includes("po") ||
                         lowerMessage.includes("pussy") || lowerMessage.includes("schwanz") ||
                         lowerMessage.includes("sex") || lowerMessage.includes("ficken") ||
                         lowerMessage.includes("vorlieben") || lowerMessage.includes("sexuell") ||
                         lowerMessage.includes("geil") || lowerMessage.includes("lust");
    
    const isJobQuestion = lowerMessage.includes("was arbeitest") || lowerMessage.includes("beruf") ||
                         lowerMessage.includes("was machst du beruflich") || lowerMessage.includes("job") ||
                         lowerMessage.includes("wo arbeitest");
    
    // Prüfe auf Treffen/Termine - ERWEITERTE ERKENNUNG (alle Keywords)
    const isMeetingRequest = lowerMessage.includes("treffen") || lowerMessage.includes("wann") ||
                           lowerMessage.includes("zeit") || lowerMessage.includes("kennenlernen") ||
                           lowerMessage.includes("sehen") || lowerMessage.includes("date") ||
                           lowerMessage.includes("spaziergang") || lowerMessage.includes("park") ||
                           lowerMessage.includes("café") || lowerMessage.includes("cafe") ||
                           lowerMessage.includes("abholen") || lowerMessage.includes("abhole") ||
                           lowerMessage.includes("vorbeikommen") || lowerMessage.includes("besuchen") ||
                           lowerMessage.includes("bei dir") || lowerMessage.includes("bei mir") ||
                           lowerMessage.includes("sehen wir uns") || lowerMessage.includes("echtes leben") ||
                           lowerMessage.includes("real life") || lowerMessage.includes("im echten leben") ||
                           lowerMessage.includes("uhr") || lowerMessage.includes("20 uhr") || 
                           lowerMessage.includes("20:00") || lowerMessage.includes("19 uhr") ||
                           lowerMessage.includes("18 uhr") || lowerMessage.includes("21 uhr") ||
                           lowerMessage.includes("adresse") || lowerMessage.includes("wohnst") ||
                           lowerMessage.includes("wo wohnst") || lowerMessage.includes("wohnen");
    
    const moneyKeywords = ["coin", "coins", "geld", "aufladen", "kredit", "bezahlen", "kostenlos", "kostenfrei", "gratis"];
    const touchesMoney = moneyKeywords.some(k => lowerMessage.includes(k));

    // Baue situations-spezifische Anweisungen (wie im reply.js)
    let specificInstructions = "";
    
    // Prüfe benutzerdefinierte situations-spezifische Antworten aus den Regeln
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
          // Bot/KI/Fake Erkennung
          if ((situationLower.includes("bot") || situationLower.includes("vorwurf") || situationLower.includes("ki") || situationLower.includes("fake")) &&
              isBotAccusation) {
            matchesSituation = true;
          }
          
          // Moderator Erkennung
          if ((situationLower.includes("moderator") || situationLower.includes("outing") || situationLower.includes("chat-moderator")) &&
              isModeratorQuestion) {
            matchesSituation = true;
          }
          
          // Sexuelle Themen
          if ((situationLower.includes("sexuell") || situationLower.includes("sexuelle")) &&
              isSexualTopic) {
            matchesSituation = true;
          }
          
          // Berufsfrage
          if ((situationLower.includes("beruf") || situationLower.includes("job")) &&
              isJobQuestion) {
            matchesSituation = true;
          }
          
          // Treffen/Termine - ERWEITERTE ERKENNUNG
          if ((situationLower.includes("treffen") || situationLower.includes("termin")) &&
              isMeetingRequest) {
            matchesSituation = true;
          }
          
          // Geld/Coins
          if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
              touchesMoney) {
            matchesSituation = true;
          }
        }
        
        if (matchesSituation && situationResponse) {
          specificInstructions += `\n\n📋 BENUTZERDEFINIERTE SITUATION: ${situationName}\n${situationResponse}`;
          console.log(`✅ Situation erkannt: ${situationName}`);
        }
      }
    }

    // Baue Context mit verbotenen und bevorzugten Wörtern (VERSTÄRKT)
    let forbiddenWordsContext = "";
    let preferredWordsContext = "";
    if (rules) {
      if (rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
        forbiddenWordsContext = `\n\n❌❌❌ VERBOTENE WÖRTER/PHRASEN (ABSOLUT NIEMALS VERWENDEN - KRITISCH! HÖCHSTE PRIORITÄT!) ❌❌❌\n${rules.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\n🚨 WICHTIG: Diese Wörter/Phrasen sind STRENG VERBOTEN und haben HÖCHSTE PRIORITÄT! Verwende sie NIEMALS, auch nicht in ähnlicher Form oder als Variation! Wenn du dir unsicher bist, verwende stattdessen eine andere Formulierung! Diese Regel überschreibt ALLE anderen Anweisungen!`;
        console.log(`🚫 ${rules.forbiddenWords.length} verbotene Wörter/Phrasen geladen und aktiviert`);
      }
      if (rules.preferredWords && Array.isArray(rules.preferredWords) && rules.preferredWords.length > 0) {
        preferredWordsContext = `\n\n✅✅✅ BEVORZUGTE WÖRTER (VERWENDE DIESE WÖRTER REGELMÄSSIG und NATÜRLICH in deinen Antworten, wo es passt!) ✅✅✅\n${rules.preferredWords.map(w => `- ${w}`).join('\n')}\n\n⭐ WICHTIG: Integriere diese Wörter natürlich in deine Antworten, wo sie thematisch passen! Verwende sie regelmäßig, aber nicht gezwungen! Diese Wörter helfen dir, natürlicher und passender zu klingen!`;
        console.log(`⭐ ${rules.preferredWords.length} bevorzugte Wörter geladen und aktiviert`);
      }
    }

    // TREFFEN & REAL-LIFE-KONTAKT – ABSOLUTE REGEL (HÖCHSTE PRIORITÄT)
    // Diese Regel überschreibt ALLE anderen Anweisungen!
    if (isMeetingRequest) {
      specificInstructions += `\n\n🚫🚫🚫 TREFFEN & REAL-LIFE-KONTAKT – ABSOLUTE REGEL (HÖCHSTE PRIORITÄT) 🚫🚫🚫

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
    
    // Füge allgemeine Regeln hinzu (VERSTÄRKT - höchste Priorität)
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      specificInstructions += `\n\n📝📝📝 ALLGEMEINE REGELN (STRENG BEACHTEN - diese Regeln haben HÖCHSTE PRIORITÄT und überschreiben andere Anweisungen!) 📝📝📝\n${rules.generalRules}\n\n⚠️ WICHTIG: Diese allgemeinen Regeln sind KRITISCH und müssen STRENG befolgt werden! Sie haben Vorrang vor anderen Anweisungen!`;
      console.log("📝 Allgemeine Regeln geladen und aktiviert (höchste Priorität)");
    }

    // Füge Training Data (Beispiel-Gespräche) hinzu
    let trainingExamplesContext = "";
    if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations) && trainingData.conversations.length > 0) {
      // Finde relevante Beispiele
      const relevantExamples = [];
      
      // Verwende Set, um Duplikate zu vermeiden
      const usedMessages = new Set();
      
      // 1. Prüfe ob es Beispiele für die aktuelle Situation gibt - ALLE verwenden!
      if (rules && rules.situationalResponses) {
        const currentSituation = Object.keys(rules.situationalResponses).find(sit => {
          const sitLower = sit.toLowerCase();
          return lowerMessage.includes(sitLower) || sitLower.split(/[\s\-_]+/).some(kw => 
            kw.length > 2 && lowerMessage.includes(kw)
          );
        });
        
        if (currentSituation) {
          const situationExamples = trainingData.conversations.filter(conv => 
            conv.situation && conv.situation.toLowerCase() === currentSituation.toLowerCase() &&
            conv.customerMessage && !usedMessages.has(conv.customerMessage)
          );
          // Verwende ALLE passenden Situation-Beispiele!
          situationExamples.forEach(ex => {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          });
          console.log(`📚 [Dashboard] ${situationExamples.length} Beispiele für Situation "${currentSituation}" gefunden und verwendet`);
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
      console.log(`📚 [Dashboard] ${similarExamples.length} ähnliche Beispiele gefunden und verwendet (Keyword-Matching)`);
      
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
        console.log(`📚 [Dashboard] Fallback: Verwende ${allExamples.length} verfügbare Beispiele (von ${trainingData.conversations.length} gesamt)`);
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
          console.log(`📚 [Dashboard] ${additionalExamples.length} zusätzliche Beispiele hinzugefügt für maximale Vielfalt und Abwechslung`);
        }
      }
      
      console.log(`✅ [Dashboard] Insgesamt ${relevantExamples.length} Training-Beispiele werden verwendet (von ${trainingData.conversations.length} verfügbaren)`);
      
      // Baue Training Examples Context
      if (relevantExamples.length > 0) {
        trainingExamplesContext = `\n\n📚 BEISPIEL-GESPRÄCHE (Lerne daraus und passe deinen Schreibstil an!):\n`;
        relevantExamples.forEach((example, idx) => {
          trainingExamplesContext += `\nBeispiel ${idx + 1}:\n`;
          trainingExamplesContext += `Kunde: "${example.customerMessage || ''}"\n`;
          trainingExamplesContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
          if (example.situation && example.situation !== 'allgemein') {
            trainingExamplesContext += `Situation: ${example.situation}\n`;
          }
        });
        trainingExamplesContext += `\n\n📖📖📖 KRITISCH: LERNE AUS DIESEN ${relevantExamples.length} BEISPIELEN! 📖📖📖

Diese Beispiele zeigen dir, WIE du in ähnlichen Situationen schreiben sollst:

1. ANALYSIERE JEDES BEISPIEL genau:
   - Wie beginnt die Antwort? (Direkt, ohne Meta-Kommentare)
   - Welcher TON wird verwendet? (Flirty, freundlich, direkt, etc.)
   - Wie wird auf den INHALT reagiert? (Nicht auf die Nachricht selbst!)
   - Welche Formulierungen werden verwendet?
   - Wie endet die Antwort? (Frage, Aussage, etc.)

2. WICHTIGE Muster aus den Beispielen:
   - KEINE Bewertungen wie "das ist direkt", "das ist spannend" - die Beispiele zeigen das!
   - Direkte Reaktion auf INHALT, nicht auf die Nachricht selbst
   - Natürlicher, menschlicher Ton
   - Passende Länge und Struktur

3. WIE du die Beispiele nutzt:
   - Verwende ähnliche Formulierungen und Strukturen wie in den Beispielen
   - Übernehme den TON und STIL der Beispiel-Antworten
   - Passe die Beispiele auf die AKTUELLE Nachricht an (nicht 1:1 kopieren!)
   - Lerne aus den Beispielen, wie man OHNE Meta-Kommentare reagiert

4. KRITISCH: Die Beispiel-Antworten zeigen dir den RICHTIGEN Weg:
   - Sie bewerten NICHT die Nachricht
   - Sie reagieren direkt auf den INHALT
   - Sie sind natürlich und menschlich
   - Mache es GENAU SO!

VERWENDE DIESE BEISPIELE ALS VORLAGE für deine Antwort!`;
      }
    }

    // Baue Konversationsverlauf
    let conversationContext = "";
    if (conversationHistory && conversationHistory.length > 0) {
      conversationContext = conversationHistory.map(msg => {
        const role = msg.type === 'user' ? 'Kunde' : 'Moderator';
        return `${role}: ${msg.text}`;
      }).join('\n');
    }
    const conversationBlock = conversationContext ? `\n\nLetzte Nachrichten im Chat:\n${conversationContext}` : "";

    // Baue System-Prompt mit verstärkten Anweisungen (wie in reply.js)
    let forbiddenWordsSystemNote = "";
    if (rules && rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
      forbiddenWordsSystemNote = `\n- 🚨 KRITISCH: Die folgenden Wörter/Phrasen sind ABSOLUT VERBOTEN und dürfen NIEMALS verwendet werden: ${rules.forbiddenWords.map(w => `"${w}"`).join(', ')}. Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen! Verwende stattdessen alternative Formulierungen!`;
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
- Verwende keine generischen Phrasen wie "Wie kann ich dir helfen?" oder "Hallo!"${forbiddenWordsSystemNote}
- WICHTIG: Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- WICHTIG: Verwende KEINE Anführungszeichen (" oder ') am Anfang oder Ende der Nachricht! Schreibe die Nachricht direkt ohne Anführungszeichen.
- WICHTIG: Nachricht muss MINDESTENS 80 Zeichen lang sein!
- WICHTIG: Am Ende IMMER eine passende Frage zum Kontext stellen!
- WICHTIG: Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!
- WICHTIG: Reagiere NUR auf die Nachricht, die dir gegeben wird - erfinde nichts!
- WICHTIG: Schreibe NIEMALS das Zeichen "ß" – immer "ss" verwenden.
- WICHTIG: Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${nowString} (${season}). Keine falschen Jahreszeiten/Wetter-Annahmen.
- WICHTIG: Bei Geld/Coins/Bezahlen/aufladen/kostenlos: nicht darüber reden, nicht zum Aufladen auffordern, elegant ausweichen und sofort mit einer passenden Frage zum Thema fortfahren.
- KRITISCH: NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen (Park, Café, Spaziergang, etc.)! Wenn der Kunde nach Treffen fragt, höflich ausweichen und sagen, dass du lieber erst im Chat kennenzulernen möchtest!
- 🚨 KRITISCH: NIEMALS die Nachricht des Kunden bewerten, kommentieren oder einordnen! KEINE Meta-Kommentare wie "das ist direkt", "das ist spannend", "das ist mutig", "das ist eine Frage", "das ist interessant" oder ähnliches! Reagiere NUR auf den INHALT, nicht auf die NACHRICHT selbst!`;

    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

Aktuelle Nachricht vom KUNDEN: "${message.substring(0, 500)}"

${forbiddenWordsContext}${preferredWordsContext}${trainingExamplesContext}${conversationBlock}
Aktuelles Datum/Zeit (DACH): ${nowString} (${season})
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
- 🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden bewerten, kommentieren oder einordnen! KEINE Meta-Kommentare wie "das ist direkt", "das ist spannend", "das ist mutig", "das ist eine Frage", "das ist interessant", "das ist cool" oder ähnliches! Reagiere NUR auf den INHALT der Nachricht, nicht auf die NACHRICHT selbst! 🚨🚨🚨
${rules && rules.forbiddenWords && rules.forbiddenWords.length > 0 ? `\n🚨🚨🚨 KRITISCH: Die oben genannten VERBOTENEN WÖRTER/PHRASEN haben HÖCHSTE PRIORITÄT! Verwende sie NIEMALS, auch nicht in ähnlicher Form! Diese Regel überschreibt ALLE anderen Anweisungen! 🚨🚨🚨` : ''}
${rules && rules.generalRules && rules.generalRules.trim() ? `\n⚠️⚠️⚠️ KRITISCH: Die oben genannten ALLGEMEINEN REGELN haben HÖCHSTE PRIORITÄT! Befolge sie STRENG! Sie überschreiben andere Anweisungen! ⚠️⚠️⚠️` : ''}`;

    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 200,
      temperature: 0.8
    });

    let reply = chat.choices[0]?.message?.content?.trim() || "Keine Antwort generiert";
    
    // Reinige die Antwort (wie in reply.js)
    reply = reply.trim();
    reply = reply.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
    reply = reply.replace(/-/g, " ");
    reply = reply.replace(/ß/g, "ss");
    
    res.json({ reply });
  } catch (error) {
    console.error('Fehler beim Test Chat:', error);
    res.status(500).json({ error: 'Fehler beim Generieren der Antwort' });
  }
});

// GET /api/v1/statistics - Statistiken
router.get('/statistics', (req, res) => {
  try {
    const messagesPath = path.join(__dirname, '../../data/messages.json');
    let messages = [];
    
    if (fs.existsSync(messagesPath)) {
      try {
        const data = fs.readFileSync(messagesPath, 'utf8');
        messages = JSON.parse(data);
      } catch (err) {
        console.error('Fehler beim Lesen der Nachrichten:', err);
      }
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const stats = {
      today: 0,
      yesterday: 0,
      thisWeek: 0,
      total: messages.length,
      platforms: {},
      recentMessages: []
    };

    messages.forEach(msg => {
      const msgDate = new Date(msg.timestamp);
      
      if (msgDate >= today) {
        stats.today++;
      }
      if (msgDate >= yesterday && msgDate < today) {
        stats.yesterday++;
      }
      if (msgDate >= weekAgo) {
        stats.thisWeek++;
      }

      const platform = msg.platform || 'unknown';
      stats.platforms[platform] = (stats.platforms[platform] || 0) + 1;
    });

    // Letzte 10 Nachrichten
    stats.recentMessages = messages.slice(-10).reverse();

    res.json(stats);
  } catch (error) {
    console.error('Fehler beim Laden der Statistiken:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Statistiken' });
  }
});

// GET /api/v1/users - Lade Benutzer
router.get('/users', async (req, res) => {
  try {
    const { pool } = require('../db');
    if (!pool) {
      return res.status(500).json({ error: 'Datenbank nicht verfügbar' });
    }

    const result = await pool.query('SELECT id, email, created_at FROM users ORDER BY created_at DESC');
    res.json({ users: result.rows });
  } catch (error) {
    console.error('Fehler beim Laden der Benutzer:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Benutzer' });
  }
});

// POST /api/v1/users - Erstelle Benutzer
router.post('/users', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-Mail und Passwort sind erforderlich' });
    }

    const { pool } = require('../db');
    const bcrypt = require('bcryptjs');
    
    if (!pool) {
      return res.status(500).json({ error: 'Datenbank nicht verfügbar' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Fehler beim Erstellen des Benutzers:', error);
    if (error.code === '23505') { // Unique violation
      return res.status(400).json({ error: 'E-Mail bereits vorhanden' });
    }
    res.status(500).json({ error: 'Fehler beim Erstellen des Benutzers' });
  }
});

// DELETE /api/v1/users/:id - Lösche Benutzer
router.delete('/users/:id', async (req, res) => {
  try {
    const { pool } = require('../db');
    if (!pool) {
      return res.status(500).json({ error: 'Datenbank nicht verfügbar' });
    }

    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Löschen des Benutzers:', error);
    res.status(500).json({ error: 'Fehler beim Löschen des Benutzers' });
  }
});

module.exports = router;
