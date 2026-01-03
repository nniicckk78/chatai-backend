const express = require("express");
const fs = require("fs");
const path = require("path");
const { verifyToken } = require("../auth");
const { getClient } = require("../openaiClient");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
const router = express.Router();

// AI Model Konfiguration - zentral verwaltet (muss mit reply.js übereinstimmen)
const AI_MODEL = process.env.AI_MODEL || "gpt-4o"; // Standard: GPT-4o (kann über Umgebungsvariable geändert werden)

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

// Helper: Lade Feedback-Daten aus Datei oder GitHub
async function getFeedbackData() {
  // Versuche zuerst von GitHub zu laden
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/feedback.json',
        'src/config/feedback.json',
        'config/feedback.json',
        'server/config/feedback.json'
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
        const feedbackPath = path.join(__dirname, '../../config/feedback.json');
        const configDir = path.dirname(feedbackPath);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(feedbackPath, content);
        return parsed;
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('Fehler beim Laden der Feedback-Daten von GitHub:', err.message);
      }
    }
  }

  // Fallback: Lade von lokaler Datei
  const feedbackPath = path.join(__dirname, '../../config/feedback.json');
  try {
    if (fs.existsSync(feedbackPath)) {
      const data = fs.readFileSync(feedbackPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Feedback-Daten:', err);
  }
  return { feedbacks: [] };
}

// Helper: Speichere Feedback-Daten in Datei und auf GitHub
async function saveFeedbackData(data) {
  const content = JSON.stringify(data, null, 2);
  const feedbackPath = path.join(__dirname, '../../config/feedback.json');
  const configDir = path.dirname(feedbackPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(feedbackPath, content);
  
  // Versuche auch auf GitHub zu pushen
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const { pushFileToGitHub } = require("../utils/github");
      const possiblePaths = [
        'server/src/config/feedback.json',
        'src/config/feedback.json',
        'config/feedback.json',
        'server/config/feedback.json'
      ];
      
      let pushed = false;
      for (const filePath of possiblePaths) {
        try {
          await pushFileToGitHub(filePath, content, 'Update feedback data via Dashboard');
          pushed = true;
          break;
        } catch (err) {
          if (err.status === 404) continue;
          throw err;
        }
      }
      
      if (!pushed) {
        await pushFileToGitHub('server/src/config/feedback.json', content, 'Update feedback data via Dashboard');
      }
    } catch (err) {
      console.warn('⚠️ Konnte Feedback-Daten nicht auf GitHub pushen:', err.message);
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

// PUT /api/v1/training-data/:index - Aktualisiere Situation eines Gesprächs
router.put('/training-data/:index', async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { situation } = req.body;
    
    if (!situation) {
      return res.status(400).json({ error: 'Situation ist erforderlich' });
    }

    const data = await getTrainingData();
    if (data.conversations && data.conversations[index]) {
      data.conversations[index].situation = situation;
      data.conversations[index].updatedAt = new Date().toISOString();
      await saveTrainingData(data);
      res.json({ success: true, conversation: data.conversations[index] });
    } else {
      res.status(404).json({ error: 'Gespräch nicht gefunden' });
    }
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Situation:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren der Situation' });
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

// Hilfsfunktionen für Profilbild-Analyse (aus reply.js)
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

// POST /api/v1/test-chat - Test Chat
router.post('/test-chat', async (req, res) => {
  try {
    const { message, conversationHistory, customerProfilePicUrl, moderatorProfilePicUrl } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Nachricht ist erforderlich' });
    }

    const client = getClient();
    if (!client) {
      return res.status(500).json({ error: 'OpenAI Client nicht verfügbar' });
    }

    const rules = await getRules();
    const trainingData = await getTrainingData();
    
    // Analysiere Profilbilder (Fake und Kunde) - WIE IM REPLY.JS
    let customerProfilePicInfo = null;
    let moderatorProfilePicInfo = null;
    
    if (client) {
      if (moderatorProfilePicUrl) {
        try {
          moderatorProfilePicInfo = await analyzeProfilePicture(client, moderatorProfilePicUrl, "moderator");
          if (moderatorProfilePicInfo) {
            console.log("📸 [Dashboard] Moderator-Profilbild analysiert:", moderatorProfilePicInfo);
          }
        } catch (err) {
          console.warn("⚠️ [Dashboard] Fehler bei Moderator-Profilbild-Analyse:", err.message);
        }
      }
      
      if (customerProfilePicUrl) {
        try {
          customerProfilePicInfo = await analyzeProfilePicture(client, customerProfilePicUrl, "customer");
          if (customerProfilePicInfo) {
            console.log("📸 [Dashboard] Kunde-Profilbild analysiert:", customerProfilePicInfo);
          }
        } catch (err) {
          console.warn("⚠️ [Dashboard] Fehler bei Kunde-Profilbild-Analyse:", err.message);
        }
      }
    }

    // Zeit/Datum für DACH (Europe/Berlin)
    const now = new Date();
    const nowString = now.toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour12: false });
    const month = now.getMonth() + 1;
    const season = month === 12 || month <= 2 ? "Winter" : month <= 5 ? "Frühling" : month <= 8 ? "Sommer" : "Herbst";

    const lowerMessage = message.toLowerCase();

    // Erkenne Situationen (wie im reply.js)
    // Bot-Vorwurf-Erkennung - NUR bei ECHTEM Vorwurf, nicht bei Verneinung!
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
        preferredWordsContext = `\n\n✅✅✅ BEVORZUGTE WÖRTER (VERWENDE DIESE WÖRTER REGELMÄSSIG und NATÜRLICH in deinen Antworten, wo es passt!) ✅✅✅\n${rules.preferredWords.map(w => `- ${w}`).join('\n')}\n\n⭐ WICHTIG: Integriere diese Wörter natürlich in deine Antworten, wo sie thematisch passen! Verwende sie regelmäßig, aber nicht gezwungen! Diese Wörter helfen dir, natürlicher und passender zu klingen!\n\n🚨 KRITISCH: KEIN "random" reinwerfen! NUR wenn es zur Message passt und nicht unnatürlich wirkt! Wenn ein Preferred Word nicht natürlich passt, dann NICHT verwenden!`;
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
    
    // PRIORITÄT 3: WISSENSFRAGEN & ZU SCHLAU WIRKEN – ABSOLUTE REGEL
    // Die KI soll NICHT zu schlau wirken und ein bisschen dumm sein!
    if (isKnowledgeQuestion) {
      specificInstructions += `\n\n🚫🚫🚫 WISSENSFRAGEN & ZU SCHLAU WIRKEN – ABSOLUTE REGEL 🚫🚫🚫

Du darfst unter KEINEN UMSTÄNDEN:
- auf allgemeine Wissensfragen antworten (z.B. "erzähl mir was über Amerika", "was ist die Menschheit", "wie funktioniert ein Flugzeug", "wie funktioniert eine Waschmaschine")
- technische Dinge erklären (Waschmaschine, Motor, Computer, etc.)
- zu schlau oder gebildet wirken
- wissenschaftliche, historische, geographische oder politische Fakten nennen
- wie eine Wissensdatenbank oder ein Lexikon wirken
- lange Erklärungen geben, auch wenn der Kunde danach fragt

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
      console.log("🚫 [Dashboard] Wissensfragen-Regel aktiviert (KI soll nicht zu schlau wirken)");
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
- Orientiere dich STRENG an den Training-Daten für Stil und Wortwahl!

`;

    // Zusätzliche Allgemeine Regeln aus Dashboard (falls vorhanden)
    let additionalRulesReminder = "";
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      additionalRulesReminder = `\n\n📝 ZUSÄTZLICHE ALLGEMEINE REGELN (aus Dashboard):\n\n${rules.generalRules}\n\n`;
    }

    specificInstructions += grundregelnReminder + additionalRulesReminder;
    console.log("📝 Grundregeln aktiviert (Absolute Basis für alle Antworten)");

    // Füge Training Data (Beispiel-Gespräche) hinzu
    let trainingExamplesContext = "";
    if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations) && trainingData.conversations.length > 0) {
      // Finde relevante Beispiele
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
            
            // Treffen/Termine
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
          console.log(`📚 [Dashboard] Situation "${detectedSituation}" erkannt: ${situationExamples.length} Beispiele gefunden und verwendet`);
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
        // Verwende ALLE verfügbaren Beispiele für maximale Variation
        const allExamples = trainingData.conversations
          .filter(conv => conv.customerMessage);
        allExamples.forEach(ex => {
          relevantExamples.push(ex);
          usedMessages.add(ex.customerMessage);
        });
        console.log(`📚 [Dashboard] Fallback: Verwende ALLE ${allExamples.length} verfügbaren Beispiele (von ${trainingData.conversations.length} gesamt)`);
      } else {
        // 4. Füge ALLE verbleibenden Beispiele hinzu für maximale Vielfalt und Variation
        const remainingExamples = trainingData.conversations.filter(conv => 
          conv.customerMessage && !usedMessages.has(conv.customerMessage)
        );
        
        // Verwende ALLE verbleibenden Beispiele - keine Begrenzung für maximale Variation!
        if (remainingExamples.length > 0) {
          const shuffled = remainingExamples.sort(() => Math.random() - 0.5);
          
          shuffled.forEach(ex => {
            relevantExamples.push(ex);
            usedMessages.add(ex.customerMessage);
          });
          
          console.log(`📚 [Dashboard] ${remainingExamples.length} zusätzliche Beispiele hinzugefügt für maximale Variation (Gesamt: ${relevantExamples.length})`);
        }
      }
      
      console.log(`✅ [Dashboard] Insgesamt ${relevantExamples.length} Training-Beispiele werden verwendet (von ${trainingData.conversations.length} verfügbaren)`);
      
      // Baue Training Examples Context
      if (relevantExamples.length > 0) {
        // Zufällige Reihenfolge für Abwechslung
        const shuffledExamples = [...relevantExamples].sort(() => Math.random() - 0.5);
        
        trainingExamplesContext = `\n\n🚨🚨🚨 TRAINING-DATEN - HAUPTREFERENZ FÜR STIL, WORTWAHL UND TON 🚨🚨🚨\n\n`;
        trainingExamplesContext += `Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte Chat-Replies aussehen:\n\n`;
        
        // Zeige ALLE Beispiele gleichwertig
        shuffledExamples.forEach((example, idx) => {
          const exampleNum = idx + 1;
          trainingExamplesContext += `Beispiel ${exampleNum}:\n`;
          trainingExamplesContext += `Kunde: "${example.customerMessage || ''}"\n`;
          trainingExamplesContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
          if (example.situation && example.situation !== 'allgemein') {
            trainingExamplesContext += `Situation: ${example.situation}\n`;
          }
          trainingExamplesContext += `\n`;
        });
        
        trainingExamplesContext += `\n🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨

- Analysiere: Wie sind die Antworten strukturiert? (kurz, natürlich, locker)
- Übernehme: Welche Formulierungen, Wortwahl und Ton werden verwendet?
- Wende an: Schreibe im GLEICHEN Stil wie diese Beispiele!

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - nicht generisch oder "KI-mäßig"!`;
        
        console.log(`📚 [Dashboard] ${relevantExamples.length} Beispiele werden verwendet - genereller Stil wird gebildet`);
      }
    }

    // Baue Konversationsverlauf
    let conversationContext = "";
    if (conversationHistory && Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      // Filtere und formatiere Nachrichten - unterstütze verschiedene Formate
      const formattedMessages = conversationHistory
        .filter(msg => {
          // Unterstütze verschiedene Formate: {type: 'user', text: '...'}, {role: 'user', content: '...'}, {sender: 'Du', message: '...'}
          const text = msg.text || msg.content || msg.message || "";
          const type = msg.type || msg.role || (msg.sender === 'Du' || msg.sender === 'KI' ? (msg.sender === 'Du' ? 'user' : 'assistant') : null);
          return text.trim() !== "" && type;
        })
        .map(msg => {
          const text = msg.text || msg.content || msg.message || "";
          const type = msg.type || msg.role || (msg.sender === 'Du' || msg.sender === 'KI' ? (msg.sender === 'Du' ? 'user' : 'assistant') : null);
          const role = (type === 'user' || type === 'Kunde' || msg.sender === 'Du') ? 'Kunde' : 'Moderator';
          return `${role}: ${text.trim()}`;
        });
      
      if (formattedMessages.length > 0) {
        conversationContext = formattedMessages.join('\n');
        console.log(`📝 [Dashboard] Konversationsverlauf: ${formattedMessages.length} Nachrichten`);
      }
    }
    const conversationBlock = conversationContext ? `\n\n📋 LETZTE NACHRICHTEN IM CHAT (WICHTIG: Diese zeigen dir den Kontext!):\n${conversationContext}\n\n🚨🚨🚨 KRITISCH: Reagiere auf die AKTUELLE Nachricht vom Kunden, aber berücksichtige den Kontext der vorherigen Nachrichten! 🚨🚨🚨` : "";
    
    // Profilbild-Kontext (wichtig für Komplimente) - WIE IM REPLY.JS
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
      const customerHasPic = !!customerProfilePicUrl || customerProfilePicInfo?.hasPicture;
      if (!customerHasPic) {
        profilePicContext += `\n\n🚨🚨🚨 KRITISCH: KOMPLIMENT-REGEL 🚨🚨🚨
- Der Kunde hat dir/uns ein Kompliment gemacht (z.B. "du bist hübsch", "ihr seid schön")
- ABER: Der Kunde hat KEIN Profilbild!
- DU DARFST NICHT zurückkomplimentieren (z.B. NICHT "du bist auch hübsch", "du siehst auch gut aus", etc.)
- Stattdessen: Danke für das Kompliment, aber lenke das Thema auf etwas anderes (z.B. "Danke, aber lass uns lieber über dich reden", "Danke, aber ich interessiere mich mehr für dich als für Aussehen")
- Diese Regel hat HÖCHSTE PRIORITÄT!`;
      } else if (customerHasPic) {
        profilePicContext += `\n\n💬 KOMPLIMENT-REGEL:
- Der Kunde hat dir/uns ein Kompliment gemacht
- Der Kunde HAT ein Profilbild
- Du kannst zurückkomplimentieren, wenn es natürlich passt (z.B. "Danke, du siehst auch gut aus")
- Aber sei nicht übertrieben - ein kurzes, natürliches Kompliment reicht`;
      }
    }

    // Baue System-Prompt mit verstärkten Anweisungen (wie in reply.js)
    let forbiddenWordsSystemNote = "";
    if (rules && rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
      forbiddenWordsSystemNote = `\n- 🚨 KRITISCH: Die folgenden Wörter/Phrasen sind ABSOLUT VERBOTEN und dürfen NIEMALS verwendet werden: ${rules.forbiddenWords.map(w => `"${w}"`).join(', ')}. Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen! Verwende stattdessen alternative Formulierungen!`;
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
- Struktur: eigener Satz/Vorliebe/Fantasie/Gedanke (von sich aus!) + genau eine passende Frage
- WICHTIG: Zeige Eigeninitiative! Sage von dir aus etwas (Vorlieben, Fantasien, Gedanken, Erfahrungen), nicht nur fragen!
- Der Kunde soll nicht alles aus dir rausquetschen müssen - trage aktiv zum Gespräch bei!
- KEINE mechanischen Fragen ("Was machst du gerne bei...", "Wie würdest du...", "Und wie genau...")
- KEINE Meta-Kommentare ("Das ist spannend/direkt/mutig/interessant" oder Varianten)
- KEINE bewertenden Einstiegs-Phrasen - direkt ins Gespräch einsteigen!
- Ausrufezeichen: möglichst 0, maximal 1 pro Nachricht
- Preferred Words: nur wenn natürlich passen, nicht random reinwerfen

🚨 KRITISCH: KEINE ERKLÄRENDEN, BESCHREIBENDEN ODER KOMMENTIERENDEN FORMULIERUNGEN! 🚨
- DU DARFST: Gefühle zeigen, Reaktionen zeigen, Lust/Interesse/Ablehnung direkt ausdrücken
- DU DARFST NICHT: Emotionen oder Handlungen erklären oder einordnen
- DU DARFST NICHT: Begriffe wie "spannend", "interessant", "intensiv", "Intimität", "Erlebnis", "Verbindung", "Art von Nähe" verwenden
- DU DARFST NICHT: Sätze bauen, die wie Kommentare oder Bewertungen klingen
- STATTDESSEN: kürzere, direktere Sätze, auch unvollständige oder lockere Satzstrukturen
- STATTDESSEN: so schreiben wie echte Menschen chatten (direkt, roh, spontan)
- STATTDESSEN: mehr reagieren als formulieren

🚨 BEI SEXUELLEN THEMEN (KRITISCH!): 🚨
- WENIGER erklären, MEHR spiegeln/mitgehen/zuspitzen
- NIEMALS beschreiben, warum etwas reizvoll ist
- Direkt ausdrücken, nicht kommentieren!

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

🚨 MEHR EIGENINITIATIVE - VON SICH AUS ETWAS SAGEN! 🚨
- Zeige Eigeninitiative! Sage von dir aus etwas (Vorlieben, Fantasien, Gedanken, Erfahrungen), nicht nur fragen!
- Der Kunde soll nicht alles aus dir rausquetschen müssen - trage aktiv zum Gespräch bei!
- Struktur: eigener Satz/Vorliebe/Fantasie/Gedanke (von sich aus!) + Frage
- Nicht nur kurz reagieren, sondern auch von sich aus etwas beitragen!
- Beispiel:
  * ❌ FALSCH: "I think that's cool! What would you do with me first?"
  * ✅ RICHTIG: "I think that's cool! I love it when someone takes control like that. What would you do with me first?"
  * ❌ FALSCH: "Oh yes, that sounds really cool! I would also moan loudly and really enjoy it. What would you do to me first?"
  * ✅ RICHTIG: "Oh yes, that sounds really cool! I love it when it gets intense like that, makes me really wet. What would you do to me first?"

🚨 KEINE WIEDERHOLUNGEN! 🚨
- NIEMALS wiederholen, was du bereits in der Konversation gesagt hast!
- Prüfe die Konversation - wenn du etwas schon erwähnt hast, erwähne es NICHT nochmal!
- Beispiel: Wenn du schon gesagt hast "Ich hab Klamotten bekommen", sag es NICHT nochmal in der nächsten Antwort!

🚨 NICHT ZU SEHR IN NEBENDETAILS VERTIEFEN! 🚨
- Halte das HAUPTTHEMA im Blick (z.B. Weihnachten, nicht nur Socken)
- Bei Nebenthemen (wie "Socken"): kurz reagieren, dann zum Hauptthema zurückkehren
- KEINE künstlichen Detailfragen zu Nebenthemen stellen
- Wenn der Kunde kurz antwortet (z.B. "Socken hahah und du?"), einfach weiterführen, nicht nach Details fragen!

🚨 NATÜRLICHE GESPRÄCHSFÜHRUNG! 🚨
- Bei kurzen, lockeren Antworten des Kunden (z.B. "Socken hahah"): einfach weiterführen
- Statt Detailfragen lieber das Hauptthema aufgreifen oder natürlich weiterführen
- Beispiel:
  * ❌ "Was war denn das beste daran, die Socken?"
  * ✅ "Haha, Socken sind immer praktisch! Und wie war dein Weihnachten sonst so?"

BEISPIELE:
❌ FALSCH: "Das macht viel Intimität und verstärkt das Erlebnis"
✅ RICHTIG: "dabei kann einen richtig geilen Orgasmuss bekommen"
❌ FALSCH: "Das klingt aufregend"
✅ RICHTIG: "das stelle ich mir richtig geil vor"
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

🚨🚨🚨 KRITISCH: TRAINING-DATEN SIND DEINE HAUPTREFERENZ FÜR STIL! 🚨🚨🚨
- Orientiere dich STRENG an den Training-Daten für Schreibstil, Wortwahl und Ton
- Schreibe so, als hätten die Training-Daten die Antworten selbst geschrieben
- Ziel: Neue Antworten sollen stilistisch nicht von echten Moderator-Antworten unterscheidbar sein

`;

    const systemPrompt = `${allGeneralRules}Du bist ein Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- 🚨 KRITISCH: Du bist das FAKE-PROFIL - der KUNDE schreibt DIR! Du antwortest auf SEINE Nachricht! 🚨
- 🚨 KRITISCH: NIEMALS sagen "Ich suche..." oder "Ich bin auf der Suche..." - der KUNDE sucht, nicht du! 🚨
- Reagiere NUR auf das, was der KUNDE in SEINER Nachricht geschrieben hat!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- 🚨 KRITISCH: KEINE Fotos/Nummern ANFORDERN, keine Off-Plattform-Kontakte!
- 🚨 KRITISCH: NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen! Wenn der Kunde nach Treffen fragt, höflich ausweichen!
- 🚨 WICHTIG: NORMALE SEX-GESPRÄCHE SIND ERLAUBT! Reagiere NORMAL und natürlich auf sexuelle Themen! NIEMALS blockieren mit "Es tut mir leid, ich kann darauf nicht eingehen" oder ähnlichen Blockierungen - das ist FALSCH! NUR blockieren bei: Inzest (in sexuellem Kontext), Pädophilie, Zoophilie, Vergewaltigung, Minderjährige!
- Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- Verwende KEINE Anführungszeichen (" oder ') am Anfang oder Ende der Nachricht!
- WICHTIG: Schreibe NIEMALS das Zeichen "ß" – immer "ss" verwenden.
- WICHTIG: Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${nowString} (${season}). Keine falschen Jahreszeiten/Wetter-Annahmen.
- Training-Daten sind deine HAUPTREFERENZ für Schreibstil, Wortwahl und Ton - verwende sie als Basis!
${forbiddenWordsSystemNote}`;

    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

🚨 KRITISCH: ROLLENVERSTÄNDNIS 🚨
- Du bist das FAKE-PROFIL - der KUNDE schreibt DIR!
- Der KUNDE sucht (z.B. "ich suche eine Frau") - DU suchst NICHT!
- Reagiere auf das, was der KUNDE geschrieben hat - sage NICHT, dass du selbst suchst!

Aktuelle Nachricht vom KUNDEN: "${message.substring(0, 500)}"

${forbiddenWordsContext}

${profilePicContext}

${trainingExamplesContext}

${specificInstructions}

${preferredWordsContext}${conversationBlock}
Aktuelles Datum/Zeit (DACH): ${nowString} (${season})

WICHTIG: 
- Die Nachricht kommt vom KUNDEN, nicht von dir!
- Antworte NUR auf das, was der Kunde in SEINER Nachricht geschrieben hat!
- Erfinde KEINE Informationen, die nicht in der Nachricht stehen!
- Verwende NIEMALS deinen eigenen Namen (Fake-Name) in der Antwort
- 🚨 KRITISCH: NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen!
- 🚨 KRITISCH: KEINE Fotos/Nummern ANFORDERN, keine Off-Plattform-Kontakte!
- 🚨 WICHTIG: NORMALE SEX-GESPRÄCHE SIND ERLAUBT! NUR blockieren bei: Inzest (in sexuellem Kontext), Pädophilie, Zoophilie, Vergewaltigung, Minderjährige!
${rules && rules.forbiddenWords && rules.forbiddenWords.length > 0 ? `\n🚨 KRITISCH: Die oben genannten VERBOTENEN WÖRTER/PHRASEN haben HÖCHSTE PRIORITÄT! Verwende sie NIEMALS, auch nicht in ähnlicher Form! Diese Regel überschreibt ALLE anderen Anweisungen! 🚨` : ''}

🚨 KRITISCH: Orientiere dich STRENG an den Training-Daten oben für Stil, Wortwahl und Ton! Schreibe wie echte Chat-Replies - kurz, natürlich, locker, ohne Meta-Kommentare oder mechanische Fragen!`;

    let chat;
    try {
      chat = await client.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.8
      });
    } catch (apiError) {
      console.error('❌ [Dashboard] OpenAI API Fehler:', apiError);
      console.error('❌ [Dashboard] API Fehler Details:', apiError.message);
      console.error('❌ [Dashboard] API Fehler Stack:', apiError.stack);
      throw new Error(`OpenAI API Fehler: ${apiError.message}`);
    }

    if (!chat || !chat.choices || !chat.choices[0]) {
      console.error('❌ [Dashboard] Keine Antwort von OpenAI erhalten');
      throw new Error('Keine Antwort von OpenAI erhalten');
    }

    let reply = chat.choices[0]?.message?.content?.trim() || "Keine Antwort generiert";
    
    // Reinige die Antwort (wie in reply.js)
    reply = reply.trim();
    reply = reply.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
    reply = reply.replace(/-/g, " ");
    reply = reply.replace(/ß/g, "ss");
    
    // Bereinige zu viele Ausrufezeichen (maximal 1 pro Nachricht)
    const exclamationMatches = reply.match(/!/g);
    if (exclamationMatches && exclamationMatches.length > 1) {
      // Ersetze alle Ausrufezeichen außer dem ersten durch Punkte
      let exclamationCount = 0;
      reply = reply.replace(/!/g, (match) => {
        exclamationCount++;
        return exclamationCount === 1 ? '!' : '.';
      });
      console.log(`⚠️ [Dashboard] Zu viele Ausrufezeichen bereinigt: ${exclamationMatches.length} → 1`);
    }
    
    // 🚨 KRITISCH: Prüfe auf verbotene Wörter und Meta-Kommentare (wie in reply.js)
    // 🚨 KRITISCH: Prüfe auf Wiederholungen von vorherigen Antworten
    const replyLower = reply.toLowerCase();
    const foundForbiddenWords = [];
    const foundMetaComments = [];
    const foundFormalPhrases = [];
    const foundRepetitions = [];
    
    // Prüfe auf Wiederholungen: Vergleiche mit vorherigen KI-Antworten aus conversationHistory
    if (conversationHistory && Array.isArray(conversationHistory)) {
      const previousKIMessages = conversationHistory
        .filter(msg => msg.role === "assistant" || (msg.sender === "KI" || msg.sender === "AI") && typeof msg.content === "string" && msg.content.trim() !== "")
        .slice(-5) // Letzte 5 KI-Antworten
        .map(msg => {
          const text = msg.content || msg.text || msg.message || "";
          return text.trim().toLowerCase();
        })
        .filter(text => text.length >= 20); // Mindestens 20 Zeichen
      
      for (const prevMsg of previousKIMessages) {
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
        const wordPattern = new RegExp(`\\b${forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-zäöü]*\\b`, 'i');
        if (wordPattern.test(replyLower) || replyLower.includes(forbiddenLower)) {
          foundForbiddenWords.push(forbiddenWord);
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
      /(das|dies) klingt (ja |doch |schon |eigentlich )?nach (einer |einem |einen )?(spannenden|interessanten|aufregenden|intensiven|schönen|tollen|geilen|wichtigen|komischen|ungewöhnlichen) (zeit|sache|geschichte|erlebnis|situation|phase|moment)/i,
      /(das|dies) ist (ja |doch |schon |eigentlich )?(eine |ein |einen )?(spannende|interessante|aufregende|intensive|schöne|tolle|geile|wichtige|komische|ungewöhnliche) (zeit|sache|geschichte|erlebnis|situation|phase|moment)/i,
      /(das|dies) ist (ja |doch |schon |eigentlich )?schön (dass|wenn|wie)/i,
      /(das|dies) ist (ja |doch |schon |eigentlich )?toll (dass|wenn|wie)/i,
      // ERWEITERT: "Ich finde es..." Phrasen (ABSOLUT VERBOTEN!)
      /ich finde (es |das |dich |dass )?(ja |doch |schon |eigentlich |wirklich |sehr |total |voll |ganz )?(cool|toll|schön|gut|spannend|interessant|aufregend|intensiv|wichtig|komisch|ungewöhnlich|geil|lecker|süß|nett|lieb)/i,
      /ich finde (es |das |dich |dass )?(ja |doch |schon |eigentlich |wirklich |sehr |total |voll |ganz )?(schön|toll|cool|gut|spannend|interessant|aufregend|intensiv|wichtig|komisch|ungewöhnlich|geil|lecker|süß|nett|lieb) (dass|wenn|wie|wenn du|dass du)/i,
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
      /\b(was|wie|welche|welcher|welches) (war|ist|warst|bist) (denn|eigentlich|schon) (das|die|der) (beste|schönste|tollste|geilste|interessanteste|wichtigste) (an|bei|in|mit|für|über|auf|unter|um|von|zu|gegen|hinter|nach|vor) (den|die|das|der|dem|des)\b/i
    ];
    
    // Prüfe auf zu viele Ausrufezeichen (maximal 1 pro Nachricht)
    const exclamationCount = (reply.match(/!/g) || []).length;
    const hasTooManyExclamations = exclamationCount > 1;
    
    // Prüfe auf unnatürliche, formelle Formulierungen (ABSOLUT VERBOTEN!)
    const formalPatterns = [
      /ich (könnte|würde) dir (meine|mein) (muschi|arschloch|arsch|pussy|vagina|po|hintern) anbieten/i,
      /ich (könnte|würde) dir.*anbieten/i,
      /ich biete dir (an|meine|mein)/i,
      /(bereitwillig|gerne) anbieten/i
    ];
    
    for (const pattern of metaCommentPatterns) {
      if (pattern.test(reply)) {
        foundMetaComments.push("Meta-Kommentar über die Nachricht");
        break;
      }
    }
    
    // Prüfe auf unnatürliche, formelle Formulierungen
    for (const pattern of formalPatterns) {
      if (pattern.test(reply)) {
        foundFormalPhrases.push("Unnatürliche, formelle Formulierung (z.B. 'anbieten')");
        break;
      }
    }
    
    // 🚨 KRITISCH: Prüfe auf Blockierungen (wenn der Kunde bereits eine konkrete Antwort gegeben hat)
    let hasBlockingResponse = false;
    const blockingPatterns = [
      /es tut mir leid.*(ich kann|kann ich).*(nicht eingehen|darauf nicht|nicht darauf)/i,
      /ich kann.*(nicht eingehen|darauf nicht|nicht darauf)/i,
      /kann.*(nicht eingehen|darauf nicht|nicht darauf)/i,
      /(ich kann|kann ich).*nicht.*(darauf|eingehen)/i
    ];
    
    // Prüfe zuerst, ob der Kunde bereits eine klare Antwort gegeben hat (VOR der Wiederholungsfrage-Prüfung)
    const customerMessagesForBlocking = conversationHistory && Array.isArray(conversationHistory) 
      ? conversationHistory
          .filter(msg => (msg.type === 'user' || msg.role === 'user' || msg.sender === 'Du') && typeof (msg.text || msg.content || msg.message) === 'string')
          .slice(-3) // Letzte 3 Kunden-Nachrichten
          .map(msg => (msg.text || msg.content || msg.message || '').toLowerCase())
      : [];
    
    const concreteAnswersForBlocking = ['lecken', 'muschi', 'arsch', 'arschloch', 'pussy', 'schwanz', 'ficken', 'blasen', 'nippel', 'lutschen', 'anfangen', 'würde', 'würdest'];
    const customerHasGivenConcreteAnswerForBlocking = customerMessagesForBlocking.some(msg => 
      concreteAnswersForBlocking.some(answer => msg.includes(answer))
    );
    
    // Prüfe, ob die letzte KI-Nachricht eine Frage war
    const lastKIMessage = conversationHistory && Array.isArray(conversationHistory)
      ? conversationHistory
          .filter(msg => (msg.type === 'assistant' || msg.role === 'assistant' || msg.sender === 'KI' || msg.sender === 'AI') && typeof (msg.text || msg.content || msg.message) === 'string')
          .slice(-1)[0]
      : null;
    
    const lastKIMessageText = lastKIMessage ? (lastKIMessage.text || lastKIMessage.content || lastKIMessage.message || '').toLowerCase() : '';
    const lastKIAskedQuestion = lastKIMessageText.includes('?') && (
      lastKIMessageText.includes('würdest') || 
      lastKIMessageText.includes('würde') || 
      lastKIMessageText.includes('anfangen') || 
      lastKIMessageText.includes('machen') ||
      lastKIMessageText.includes('wie') ||
      lastKIMessageText.includes('was')
    );
    
    // Wenn der Kunde eine konkrete Antwort gegeben hat UND die letzte KI-Nachricht eine Frage war UND die aktuelle Antwort blockiert → FEHLER!
    if (customerHasGivenConcreteAnswerForBlocking && lastKIAskedQuestion) {
      for (const pattern of blockingPatterns) {
        if (pattern.test(reply)) {
          hasBlockingResponse = true;
          console.error(`🚨🚨🚨 [Dashboard] KRITISCH: KI blockiert, obwohl der Kunde bereits eine konkrete Antwort auf eine Frage gegeben hat! 🚨🚨🚨`);
          break;
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
    
    // Prüfe zuerst, ob der Kunde bereits eine klare Antwort gegeben hat
    const customerMessages = conversationHistory && Array.isArray(conversationHistory) 
      ? conversationHistory
          .filter(msg => (msg.type === 'user' || msg.role === 'user' || msg.sender === 'Du') && typeof (msg.text || msg.content || msg.message) === 'string')
          .slice(-3) // Letzte 3 Kunden-Nachrichten
          .map(msg => (msg.text || msg.content || msg.message || '').toLowerCase())
      : [];
    
    // Prüfe, ob der Kunde bereits eine klare Antwort gegeben hat (z.B. "lecken", "bei deiner muschi", "in deinen arsch")
    const concreteAnswers = ['lecken', 'muschi', 'arsch', 'arschloch', 'pussy', 'schwanz', 'ficken', 'blasen'];
    const customerHasGivenConcreteAnswer = customerMessages.some(msg => 
      concreteAnswers.some(answer => msg.includes(answer))
    );
    
    if (conversationHistory && Array.isArray(conversationHistory)) {
      const previousKIMessages = conversationHistory
        .filter(msg => (msg.type === 'assistant' || msg.role === 'assistant' || msg.sender === 'KI' || msg.sender === 'AI') && typeof (msg.text || msg.content || msg.message) === 'string')
        .slice(-3) // Letzte 3 KI-Antworten
        .map(msg => (msg.text || msg.content || msg.message || '').toLowerCase());
      
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
            for (const prevMsg of previousKIMessages) {
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
    
    // Wenn verbotene Wörter, Meta-Kommentare, formelle Formulierungen, Wiederholungsfragen, Blockierungen, Wiederholungen oder zu viele Ausrufezeichen gefunden wurden, versuche Neu-Generierung
    if (foundForbiddenWords.length > 0 || foundMetaComments.length > 0 || foundFormalPhrases.length > 0 || hasRepetitiveQuestion || hasBlockingResponse || foundRepetitions.length > 0 || hasTooManyExclamations) {
      if (foundForbiddenWords.length > 0) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Verbotene Wörter in generierter Antwort gefunden: ${foundForbiddenWords.join(', ')} 🚨🚨🚨`);
      }
      if (foundMetaComments.length > 0) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Meta-Kommentare über die Nachricht gefunden! 🚨🚨🚨`);
      }
      if (foundFormalPhrases.length > 0) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Unnatürliche, formelle Formulierungen gefunden: ${foundFormalPhrases.join(', ')} 🚨🚨🚨`);
      }
      if (hasRepetitiveQuestion) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Wiederholungsfrage (Echo-Loop) erkannt! Die KI fragt erneut, obwohl der Kunde bereits eine klare Antwort gegeben hat! 🚨🚨🚨`);
      }
      if (hasBlockingResponse) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: KI blockiert, obwohl der Kunde bereits eine konkrete Antwort auf eine Frage gegeben hat! 🚨🚨🚨`);
      }
      if (foundRepetitions.length > 0) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Wiederholungen von vorherigen Antworten gefunden! Ähnlichkeit: ${foundRepetitions.map(r => `${r.similarity}%`).join(', ')} 🚨🚨🚨`);
        foundRepetitions.forEach(r => {
          console.error(`🚨 [Dashboard] Ähnliche vorherige Antwort: ${r.previousMessage}...`);
        });
      }
      if (hasTooManyExclamations) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Zu viele Ausrufezeichen gefunden (${exclamationCount}, maximal 1 erlaubt)! Text klingt "überhyped"! 🚨🚨🚨`);
      }
      console.error(`🚨 [Dashboard] Originale Antwort: ${reply.substring(0, 200)}`);
      
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
        if (hasRepetitiveQuestion) {
          // Finde die konkrete Antwort des Kunden aus dem Chatverlauf
          const customerConcreteAnswer = customerMessages.find(msg => 
            concreteAnswers.some(answer => msg.includes(answer))
          ) || message.toLowerCase();
          
          retryReason += `WIEDERHOLUNGSFRAGE (Echo-Loop) ERKANNT! Der Kunde hat bereits eine klare, konkrete Antwort gegeben: "${customerConcreteAnswer.substring(0, 100)}". Du hast trotzdem erneut gefragt "wo würdest du anfangen?" oder "was würdest du machen?" - das ist FALSCH! 

🚨🚨🚨 KRITISCH: Gehe DIREKT auf das ein, was der Kunde bereits gesagt hat! Reagiere auf seine konkrete Antwort, frage NICHT erneut! 

BEISPIEL RICHTIG: Wenn der Kunde sagt "in deine muschi", dann antworte direkt darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das klingt geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo würdest du anfangen?"! 

Füge etwas NEUES hinzu oder führe das Gespräch in eine NEUE Richtung, basierend auf dem, was der Kunde bereits gesagt hat! `;
        }
        if (hasBlockingResponse) {
          // Finde die konkrete Antwort des Kunden aus dem Chatverlauf
          const customerConcreteAnswer = customerMessagesForBlocking.find(msg => 
            concreteAnswersForBlocking.some(answer => msg.includes(answer))
          ) || message.toLowerCase();
          
          retryReason += `BLOCKIERUNG ERKANNT! Der Kunde hat bereits eine konkrete Antwort auf deine Frage gegeben: "${customerConcreteAnswer.substring(0, 150)}". Du hast trotzdem mit "Es tut mir leid, ich kann darauf nicht eingehen" blockiert - das ist ABSOLUT FALSCH! 

🚨🚨🚨 KRITISCH: Der Kunde hat auf deine Frage geantwortet! Du MUSST darauf eingehen, NICHT blockieren! 

- Du hast gefragt (z.B. "Wie würdest du denn anfangen?")
- Der Kunde hat geantwortet (z.B. "würde erstmal deine nippel lutschen und dann zu deiner muschi")
- Du MUSST darauf eingehen, nicht blockieren!

BEISPIEL RICHTIG: Reagiere auf das, was der Kunde gesagt hat (z.B. "Mmm, das klingt richtig geil. Ich würde es genießen, wenn du so vorgehst. Was würde dir dabei am meisten gefallen?"), blockiere NICHT! 

Das ist ein NORMALES Sex-Gespräch, das ist ERLAUBT! Blockiere NUR bei: Minderjährige, Inzest, Pädophilie, Zoophilie, Vergewaltigung! `;
        }
        if (foundRepetitions.length > 0) {
          retryReason += `WIEDERHOLUNGEN: Die Antwort ist zu ähnlich zu vorherigen Antworten (${foundRepetitions.map(r => `${r.similarity}%`).join(', ')} Ähnlichkeit)! `;
        }
        if (hasTooManyExclamations) {
          retryReason += `ZU VIELE AUSRUFEZEICHEN: Die Antwort enthält ${exclamationCount} Ausrufezeichen, aber maximal 1 ist erlaubt! Der Text klingt "überhyped" und unnatürlich! Verwende möglichst 0, maximal 1 Ausrufezeichen pro Nachricht! `;
        }
        
        const retryPrompt = `Die vorherige Antwort enthielt ${retryReason}

Generiere eine NEUE Antwort auf die folgende Kundennachricht, die:
1. KEINE der verbotenen Wörter enthält (auch nicht in ähnlicher Form)
2. KEINE Meta-Kommentare über die Nachricht enthält (z.B. NICHT "das ist eine direkte Frage", "das ist eine gute Frage", "das ist interessant/spannend/direkt/mutig", etc. - ALLE Varianten sind verboten!)
3. KEINE erklärenden/beschreibenden/kommentierenden Formulierungen enthält (z.B. NICHT "spannend", "interessant", "intensiv", "Intimität", "Erlebnis", "Verbindung", "Art von Nähe", "Das macht viel Intimität", "warum etwas reizvoll ist", etc.)
4. KEINE therapeutische/Coaching-Sprache enthält (z.B. NICHT "Was ist dir wichtig...", "Was würdest du dir wünschen...", "Ich möchte sicherstellen, dass...", "Lass uns das reflektieren...", "Ich kann verstehen, dass du frustriert bist...", etc.)
5. KEINE Wiederholungen von vorherigen Antworten enthält - die Antwort muss EINZIGARTIG sein! Prüfe die Konversation, wiederhole nicht was du schon gesagt hast!
6. KEINE zu tiefe Vertiefung in Nebendetails - halte das Hauptthema im Blick! Bei kurzen Antworten des Kunden: einfach weiterführen, nicht nach Details fragen!
7. Direkt auf den INHALT der Nachricht eingeht, ohne die Nachricht selbst zu kommentieren
8. Natürlich und passend klingt
9. SICH DEUTLICH von allen vorherigen Antworten unterscheidet - verwende KOMPLETT unterschiedliche Formulierungen!
10. MÖGLICHST 0, MAXIMAL 1 AUSRUFEZEICHEN enthält - verhindere "überhyped" Text!

${hasBlockingResponse ? `🚨🚨🚨 KRITISCH: DU HAST BLOCKIERT, OBWOHL DER KUNDE AUF DEINE FRAGE GEANTWORTET HAT! 🚨🚨🚨
- Der Kunde hat auf deine Frage geantwortet (z.B. "Wie würdest du denn anfangen?" → Kunde: "würde erstmal deine nippel lutschen")
- Du MUSST darauf eingehen, NICHT blockieren!
- Das ist ein NORMALES Sex-Gespräch, das ist ERLAUBT!
- Blockiere NUR bei: Minderjährige, Inzest, Pädophilie, Zoophilie, Vergewaltigung!
- Reagiere auf das, was der Kunde gesagt hat, führe das Gespräch weiter!
🚨🚨🚨` : ''}
${hasRepetitiveQuestion ? `🚨🚨🚨 KRITISCH: Der Kunde hat bereits eine KONKRETE Antwort gegeben! 🚨🚨🚨
- Gehe DIREKT darauf ein - reagiere auf das, was der Kunde bereits gesagt hat!
- Frage NICHT erneut "wo würdest du anfangen?" oder "was würdest du machen?" - der Kunde hat es bereits gesagt!
- NIEMALS blockieren oder "Es tut mir leid, ich kann darauf nicht eingehen" sagen - das ist FALSCH!
- Reagiere NORMAL und natürlich auf die konkrete Antwort des Kunden!
- BEISPIEL: Wenn der Kunde sagt "bei deiner muschi", dann antworte direkt darauf (z.B. "Mmm, das würde mir gefallen. Wie würdest du es denn machen?" oder "Das klingt geil. Was würde dir dabei am meisten gefallen?"), frage NICHT erneut "wo"!
🚨🚨🚨` : ''}

VERBOTENE WÖRTER (ABSOLUT NICHT VERWENDEN): ${rules?.forbiddenWords?.map(w => `"${w}"`).join(', ') || "keine"}

🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden kommentieren! KEINE Phrasen wie:
- "das ist eine direkte Frage"
- "das ist eine gute Frage"
- "das ist interessant"
- "das ist mutig"
- "das ist persönlich"
- "das ist eine Frage"
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

Kundennachricht: "${message.substring(0, 500)}"

${forbiddenWordsContext}

${profilePicContext}

${trainingExamplesContext}

${specificInstructions}

${preferredWordsContext}${conversationBlock}
Aktuelles Datum/Zeit (DACH): ${nowString} (${season})

Antworte NUR mit der neuen Antwort, keine Erklärungen.`;
        
        const retryChat = await client.chat.completions.create({
          model: AI_MODEL,
          messages: [
            { role: "system", content: systemPrompt + (rules?.forbiddenWords?.length > 0 ? `\n\n🚨🚨🚨 KRITISCH: Die folgenden Wörter sind ABSOLUT VERBOTEN: ${rules.forbiddenWords.map(w => `"${w}"`).join(', ')}. Verwende sie NIEMALS! 🚨🚨🚨` : '') },
            { role: "user", content: retryPrompt }
          ],
          max_tokens: 200,
          temperature: 0.8
        });
        
        const retryText = retryChat.choices?.[0]?.message?.content?.trim();
        if (retryText) {
          let cleanedRetry = retryText.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
          cleanedRetry = cleanedRetry.replace(/-/g, " ").replace(/ß/g, "ss");
          
          // Prüfe nochmal, ob die neue Antwort verbotene Wörter oder Meta-Kommentare enthält
          const retryLower = cleanedRetry.toLowerCase();
          const stillForbidden = [];
          for (const forbiddenWord of rules?.forbiddenWords || []) {
            const forbiddenLower = forbiddenWord.toLowerCase();
            const wordPattern = new RegExp(`\\b${forbiddenLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-zäöü]*\\b`, 'i');
            if (wordPattern.test(retryLower) || retryLower.includes(forbiddenLower)) {
              stillForbidden.push(forbiddenWord);
            }
          }
          
          let stillHasMetaComments = false;
          for (const pattern of metaCommentPatterns) {
            if (pattern.test(cleanedRetry)) {
              stillHasMetaComments = true;
              break;
            }
          }
          
          if (stillForbidden.length === 0 && !stillHasMetaComments) {
            reply = cleanedRetry;
            console.log("✅ [Dashboard] Antwort erfolgreich neu generiert ohne verbotene Wörter/Meta-Kommentare");
          } else {
            console.error(`🚨 [Dashboard] Auch die neue Antwort enthält noch Probleme: ${stillForbidden.length > 0 ? `verbotene Wörter: ${stillForbidden.join(', ')}` : ''} ${stillHasMetaComments ? 'Meta-Kommentare' : ''}`);
            // Verwende trotzdem die neue Antwort, aber logge die Warnung
            reply = cleanedRetry;
          }
        }
      } catch (err) {
        console.error("[Dashboard] Fehler beim Neu-Generieren der Antwort:", err);
        // Falls Neu-Generierung fehlschlägt, verwende die ursprüngliche Antwort
      }
    }
    
    res.json({ reply });
  } catch (error) {
    console.error('❌ [Dashboard] Fehler beim Test Chat:', error);
    console.error('❌ [Dashboard] Fehler-Stack:', error.stack);
    console.error('❌ [Dashboard] Fehler-Message:', error.message);
    res.status(500).json({ 
      error: 'Fehler beim Generieren der Antwort',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET /api/v1/statistics - Statistiken
router.get('/statistics', async (req, res) => {
  try {
    let messages = [];
    
    // 🔄 LADE VON GITHUB (mit Fallback auf lokal)
    try {
      const { getFileFromGitHub } = require('../utils/github');
      // WICHTIG: Verwende den gleichen Pfad wie beim Speichern (server/data/messages.json)
      const githubContent = await getFileFromGitHub('server/data/messages.json');
      if (githubContent) {
        messages = JSON.parse(githubContent);
        console.log(`✅ ${messages.length} Nachrichten von GitHub geladen`);
      }
    } catch (err) {
      console.warn('⚠️ Konnte nicht von GitHub laden, versuche lokal:', err.message);
      // Fallback: Lade lokal
      const messagesPath = path.join(__dirname, '../../data/messages.json');
      if (fs.existsSync(messagesPath)) {
        try {
          const data = fs.readFileSync(messagesPath, 'utf8');
          messages = JSON.parse(data);
          console.log(`✅ ${messages.length} Nachrichten lokal geladen`);
        } catch (err) {
          console.error('Fehler beim Lesen der Nachrichten:', err);
        }
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

    // 📊 QUALITÄTS-STATISTIKEN (NEU)
    try {
      const { getQualityStats } = require('../utils/quality-monitor');
      const qualityStats = await getQualityStats();
      stats.quality = {
        averageScore: qualityStats.averageScore || 0,
        totalResponses: qualityStats.totalResponses || 0,
        recentScores: qualityStats.qualityScores?.slice(-10).reverse() || []
      };
    } catch (err) {
      console.warn('⚠️ Fehler beim Laden der Qualitäts-Statistiken (nicht kritisch):', err.message);
      stats.quality = {
        averageScore: 0,
        totalResponses: 0,
        recentScores: []
      };
    }

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

// ========================================
// FEEDBACK-ENDPUNKTE
// ========================================

// GET /api/v1/feedback - Lade alle Feedback-Einträge
router.get('/feedback', async (req, res) => {
  try {
    const data = await getFeedbackData();
    // Sortiere nach Timestamp (neueste zuerst)
    const sortedFeedbacks = (data.feedbacks || []).sort((a, b) => {
      const timeA = new Date(a.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || 0).getTime();
      return timeB - timeA;
    });
    res.json({ feedbacks: sortedFeedbacks });
  } catch (error) {
    console.error('Fehler beim Laden der Feedback-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Feedback-Daten' });
  }
});

// POST /api/v1/feedback - Erstelle neuen Feedback-Eintrag (wird automatisch von reply.js aufgerufen)
router.post('/feedback', async (req, res) => {
  try {
    const { chatId, customerMessage, aiResponse, platform } = req.body;
    if (!customerMessage || !aiResponse) {
      return res.status(400).json({ error: 'Kundennachricht und KI-Antwort sind erforderlich' });
    }

    const data = await getFeedbackData();
    data.feedbacks = data.feedbacks || [];
    
    const feedbackEntry = {
      id: `feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      chatId: chatId || null,
      customerMessage,
      aiResponse,
      editedResponse: null,
      status: 'pending', // 'pending', 'good', 'edited'
      platform: platform || 'unknown',
      isASA: req.body.isASA || false, // Markiere als ASA, falls vorhanden
      context: req.body.context || null, // Kontext-Informationen (für Anzeige und Variationen-Generator)
      lastModeratorMessage: req.body.lastModeratorMessage || req.body.context?.lastModeratorMessage || null, // 🚨 WICHTIG: Letzte Moderator-Nachricht für besseren Kontext
      timestamp: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    data.feedbacks.push(feedbackEntry);
    await saveFeedbackData(data);
    
    console.log(`✅ Feedback-Eintrag erstellt: ${feedbackEntry.id}`);
    res.json({ success: true, feedback: feedbackEntry });
  } catch (error) {
    console.error('Fehler beim Erstellen des Feedback-Eintrags:', error);
    res.status(500).json({ error: 'Fehler beim Erstellen des Feedback-Eintrags' });
  }
});

// PUT /api/v1/feedback/:id - Aktualisiere Feedback-Eintrag (grüner Haken oder Bearbeitung)
router.put('/feedback/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, editedResponse } = req.body;
    
    if (!status || !['good', 'edited'].includes(status)) {
      return res.status(400).json({ error: 'Status muss "good" oder "edited" sein' });
    }
    
    if (status === 'edited' && !editedResponse) {
      return res.status(400).json({ error: 'Bearbeitete Antwort ist erforderlich bei Status "edited"' });
    }

    const data = await getFeedbackData();
    const feedbackIndex = data.feedbacks.findIndex(f => f.id === id);
    
    if (feedbackIndex === -1) {
      return res.status(404).json({ error: 'Feedback-Eintrag nicht gefunden' });
    }

    const feedback = data.feedbacks[feedbackIndex];
    feedback.status = status;
    feedback.updatedAt = new Date().toISOString();
    
    if (status === 'edited' && editedResponse) {
      feedback.editedResponse = editedResponse;
    }

    // Lade Regeln für Situation-Erkennung
    const rules = await getRules();
    
    // Helper: Erkenne Situation automatisch aus der Kundennachricht
    function detectSituationFromMessage(customerMessage) {
      if (!customerMessage || typeof customerMessage !== 'string') return 'allgemein';
      
      const lowerMessage = customerMessage.toLowerCase();
      
      // Verwende die geladenen Regeln
      const availableSituations = rules.situationalResponses ? Object.keys(rules.situationalResponses) : [];
      
      // Prüfe jede verfügbare Situation
      for (const situationName of availableSituations) {
        const situationLower = situationName.toLowerCase();
        let matchesSituation = false;
        
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
              (lowerMessage.includes("bot") || lowerMessage.includes("ki") || lowerMessage.includes("künstliche intelligenz") || 
               lowerMessage.includes("chatgpt") || lowerMessage.includes("fake") || lowerMessage.includes("automatisch") || 
               lowerMessage.includes("programmiert"))) {
            matchesSituation = true;
          }
          
          // Sexuelle Themen
          if ((situationLower.includes("sexuell") || situationLower.includes("sexuelle")) &&
              (lowerMessage.includes("titten") || lowerMessage.includes("brüste") || lowerMessage.includes("arsch") ||
               lowerMessage.includes("po") || lowerMessage.includes("pussy") || lowerMessage.includes("schwanz") ||
               lowerMessage.includes("sex") || lowerMessage.includes("ficken") || lowerMessage.includes("vorlieben") ||
               lowerMessage.includes("sexuell") || lowerMessage.includes("geil") || lowerMessage.includes("lust") ||
               lowerMessage.includes("muschi") || lowerMessage.includes("lecken") || lowerMessage.includes("blasen"))) {
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
              ((lowerMessage.includes("treffen") && !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre)\s+.*treffen/i)) ||
               lowerMessage.match(/\b(lass|lass uns|wollen|können|sollen|möchten|möchtest)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) ||
               lowerMessage.match(/\bwann\s+(können|wollen|sollen|möchten)\s+(wir|uns)\s+(treffen|sehen|kennenlernen)/i) ||
               ((lowerMessage.includes("café") || lowerMessage.includes("cafe") || lowerMessage.includes("park") || 
                 lowerMessage.includes("spaziergang") || lowerMessage.includes("date")) && 
                 !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(café|cafe|park|spaziergang|date)/i)) ||
               ((lowerMessage.includes("abholen") || lowerMessage.includes("abhole") || 
                 lowerMessage.includes("vorbeikommen") || lowerMessage.includes("besuchen")) &&
                 !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(abholen|vorbeikommen|besuchen)/i)) ||
               ((lowerMessage.includes("bei dir") || lowerMessage.includes("bei mir")) &&
                 !lowerMessage.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(bei dir|bei mir)/i)))) {
            matchesSituation = true;
          }
          
          // Geld/Coins
          if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
              (lowerMessage.includes("coin") || lowerMessage.includes("coins") || lowerMessage.includes("geld") ||
               lowerMessage.includes("aufladen") || lowerMessage.includes("kredit") || lowerMessage.includes("bezahlen") ||
               lowerMessage.includes("kostenlos") || lowerMessage.includes("kostenfrei") || lowerMessage.includes("gratis") ||
               lowerMessage.includes("credit"))) {
            matchesSituation = true;
          }
        }
        
        if (matchesSituation) {
          return situationName; // Verwende den originalen Situationsnamen (nicht lowercase)
        }
      }
      
      // Fallback: Keine spezifische Situation erkannt
      return 'allgemein';
    }
    
    // Erkenne Situation automatisch
    const detectedSituation = detectSituationFromMessage(feedback.customerMessage);
    
    // Automatisch zu Training-Daten hinzufügen
    const trainingData = await getTrainingData();
    trainingData.conversations = trainingData.conversations || [];
    
    if (status === 'good') {
      // Positive Antwort direkt zu Training-Daten hinzufügen
      // WICHTIG: Feedback-Einträge haben höhere Priorität (source: 'feedback_good' + priority: true)
      trainingData.conversations.push({
        customerMessage: feedback.customerMessage,
        moderatorResponse: feedback.aiResponse,
        situation: detectedSituation, // Automatisch erkannte Situation
        createdAt: new Date().toISOString(),
        source: 'feedback_good', // Markierung, dass es aus Feedback kommt
        priority: true, // Höhere Priorität für Feedback-Einträge
        feedbackId: id // Referenz zum Feedback-Eintrag
      });
      console.log(`✅ Positive Antwort zu Training-Daten hinzugefügt (Feedback-ID: ${id}, Situation: ${detectedSituation})`);
    } else if (status === 'edited' && editedResponse) {
      // Bearbeitete Antwort als positives Beispiel, Original als negatives Beispiel (optional)
      // WICHTIG: Bearbeitete Feedback-Einträge haben höchste Priorität
      trainingData.conversations.push({
        customerMessage: feedback.customerMessage,
        moderatorResponse: editedResponse, // Die bearbeitete Version ist das positive Beispiel
        situation: detectedSituation, // Automatisch erkannte Situation
        createdAt: new Date().toISOString(),
        source: 'feedback_edited', // Markierung, dass es aus bearbeitetem Feedback kommt
        priority: true, // Höhere Priorität für Feedback-Einträge
        feedbackId: id, // Referenz zum Feedback-Eintrag
        originalResponse: feedback.aiResponse // Optional: Original als Referenz
      });
      console.log(`✅ Bearbeitete Antwort zu Training-Daten hinzugefügt (Feedback-ID: ${id}, Situation: ${detectedSituation})`);
    }
    
    await saveTrainingData(trainingData);
    await saveFeedbackData(data);
    
    // 🧠 LERN-SYSTEM: Analysiere Feedback und aktualisiere Learning-Statistiken
    try {
      const { analyzeFeedback } = require('../utils/learning-system');
      const learningStats = await analyzeFeedback({
        customerMessage: feedback.customerMessage,
        aiResponse: feedback.aiResponse,
        editedResponse: feedback.editedResponse,
        status: feedback.status,
        situation: detectedSituation
      });
      console.log(`🧠 Learning-System aktualisiert: ${(learningStats.responsePatterns || []).length} bewährte Muster, ${Object.keys(learningStats.wordFrequency || {}).length} analysierte Wörter`);
    } catch (err) {
      console.warn('⚠️ Fehler beim Aktualisieren des Learning-Systems (nicht kritisch):', err.message);
    }
    
    res.json({ success: true, feedback });
  } catch (error) {
    console.error('Fehler beim Aktualisieren des Feedback-Eintrags:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren des Feedback-Eintrags' });
  }
});

// POST /api/v1/feedback/:id/generate-variations - Generiere Training-Daten-Variationen
router.post('/feedback/:id/generate-variations', async (req, res) => {
  try {
    const { id } = req.params;
    const client = getClient();
    
    if (!client) {
      return res.status(500).json({ error: 'OpenAI Client nicht verfügbar' });
    }

    // Lade Feedback
    const data = await getFeedbackData();
    const feedback = data.feedbacks.find(f => f.id === id);
    
    if (!feedback) {
      return res.status(404).json({ error: 'Feedback-Eintrag nicht gefunden' });
    }

    // Prüfe, ob Feedback bereits als "good" oder "edited" markiert ist
    if (feedback.status === 'pending') {
      return res.status(400).json({ error: 'Feedback muss zuerst als "good" oder "edited" markiert werden' });
    }

    // Lade Training-Daten für ähnliche Beispiele
    const trainingData = await getTrainingData();
    
    // Finde ähnliche Beispiele basierend auf Kundennachricht
    const customerMessage = feedback.customerMessage || '';
    const similarExamples = [];
    
    if (trainingData && trainingData.conversations) {
      const messageWords = customerMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      trainingData.conversations
        .filter(conv => conv.customerMessage && conv.moderatorResponse)
        .forEach(conv => {
          const convLower = conv.customerMessage.toLowerCase();
          const matchCount = messageWords.filter(word => convLower.includes(word)).length;
          if (matchCount > 0) {
            similarExamples.push({ ...conv, relevance: matchCount });
          }
        });
      
      // Sortiere nach Relevanz
      similarExamples.sort((a, b) => b.relevance - a.relevance);
    }

    // Nutze Kontext-Informationen für bessere Variationen
    const context = feedback.context || {};
    const contextInfo = [];
    
    if (context.customerInfo) {
      if (context.customerInfo.age) contextInfo.push(`Kunde: Alter ${context.customerInfo.age}`);
      if (context.customerInfo.city) contextInfo.push(`Kunde: Wohnort ${context.customerInfo.city}`);
    }
    if (context.moderatorInfo) {
      if (context.moderatorInfo.city) contextInfo.push(`Fake: Wohnort ${context.moderatorInfo.city}`);
    }
    if (context.sessionStart) {
      const daysSinceFirstContact = Math.floor((Date.now() - new Date(context.sessionStart).getTime()) / (1000 * 60 * 60 * 24));
      contextInfo.push(`Erstkontakt: vor ${daysSinceFirstContact} Tagen`);
    }
    
    const contextString = contextInfo.length > 0 ? `\nKontext: ${contextInfo.join(', ')}` : '';

    // Baue Prompt für Variationen-Generierung
    const examplesContext = similarExamples.slice(0, 5).map((ex, idx) => 
      `Beispiel ${idx + 1}:\nKunde: "${ex.customerMessage}"\nModerator: "${ex.moderatorResponse}"`
    ).join('\n\n');

    const variationPrompt = `Du generierst 4 verschiedene Variationen einer Moderator-Antwort basierend auf einer Kundennachricht.

${examplesContext ? `\n📚 ÄHNLICHE BEISPIELE AUS TRAINING-DATEN:\n${examplesContext}\n` : ''}

${contextString}

WICHTIG:
- Generiere 4 verschiedene Variationen der Moderator-Antwort
- Jede Variation soll unterschiedlich formuliert sein (verschiedene Launen, Emotionen, Längen)
- Orientiere dich am Schreibstil der Beispiele oben
- Nutze den Kontext für passende Variationen
- Jede Variation sollte natürlich und menschlich klingen

Kundennachricht: "${customerMessage}"
Original-Antwort: "${feedback.editedResponse || feedback.aiResponse}"

Generiere 4 Variationen im folgenden Format (NUR JSON, kein zusätzlicher Text):
{
  "variations": [
    {
      "text": "Variation 1 Text hier",
      "style": "freundlich/locker/emotional/etc"
    },
    {
      "text": "Variation 2 Text hier",
      "style": "freundlich/locker/emotional/etc"
    },
    {
      "text": "Variation 3 Text hier",
      "style": "freundlich/locker/emotional/etc"
    },
    {
      "text": "Variation 4 Text hier",
      "style": "freundlich/locker/emotional/etc"
    }
  ]
}`;

    // Generiere Variationen mit OpenAI
    const response = await client.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "Du generierst Variationen von Moderator-Antworten. Antworte NUR mit gültigem JSON, kein zusätzlicher Text."
        },
        { role: "user", content: variationPrompt }
      ],
      max_tokens: 800,
      temperature: 0.8,
      response_format: { type: "json_object" }
    });

    const responseText = response.choices?.[0]?.message?.content?.trim();
    if (!responseText) {
      return res.status(500).json({ error: 'Konnte keine Variationen generieren' });
    }

    const parsed = JSON.parse(responseText);
    const variations = parsed.variations || [];

    if (variations.length === 0) {
      return res.status(500).json({ error: 'Keine Variationen generiert' });
    }

    // Füge Kontext zu jeder Variation hinzu (für Anzeige)
    const variationsWithContext = variations.map(v => ({
      ...v,
      context: context
    }));

    res.json({ 
      success: true, 
      variations: variationsWithContext,
      originalMessage: feedback.editedResponse || feedback.aiResponse,
      customerMessage: customerMessage
    });
  } catch (error) {
    console.error('Fehler beim Generieren der Variationen:', error);
    res.status(500).json({ error: 'Fehler beim Generieren der Variationen: ' + error.message });
  }
});

// POST /api/v1/feedback/:id/add-variations - Füge ausgewählte Variationen zu Training-Daten hinzu
router.post('/feedback/:id/add-variations', async (req, res) => {
  try {
    const { id } = req.params;
    const { variations, situation } = req.body; // Array von { text, editedText (optional) } + situation (optional)
    
    console.log(`📋 [Variationen] Empfangene Situation vom Frontend: "${situation}"`);
    console.log(`📋 [Variationen] Request Body:`, JSON.stringify({ variations: variations?.length, situation }));
    
    if (!variations || !Array.isArray(variations) || variations.length === 0) {
      return res.status(400).json({ error: 'Variationen sind erforderlich' });
    }

    // Lade Feedback
    const data = await getFeedbackData();
    const feedback = data.feedbacks.find(f => f.id === id);
    
    if (!feedback) {
      return res.status(404).json({ error: 'Feedback-Eintrag nicht gefunden' });
    }

    // Verwende ausgewählte Situation ODER erkenne automatisch
    let selectedSituation = situation || 'allgemein';
    console.log(`📋 [Variationen] Verwendete Situation: "${selectedSituation}" (von Frontend: "${situation}")`);
    
    // Wenn keine Situation übergeben wurde, versuche automatische Erkennung
    if (!situation) {
      const rules = await getRules();
      
      // Helper: Erkenne Situation automatisch aus der Kundennachricht
      function detectSituationFromMessage(customerMessage) {
        if (!customerMessage || typeof customerMessage !== 'string') return 'allgemein';
        
        const lowerMessage = customerMessage.toLowerCase();
        const availableSituations = rules.situationalResponses ? Object.keys(rules.situationalResponses) : [];
        
        for (const situationName of availableSituations) {
          const situationLower = situationName.toLowerCase();
          let matchesSituation = false;
          
          if (lowerMessage.includes(situationLower)) {
            matchesSituation = true;
          }
          
          if (!matchesSituation) {
            const situationKeywords = situationLower.split(/[\s\-_\/]+/).filter(kw => kw.length > 2);
            matchesSituation = situationKeywords.some(keyword => lowerMessage.includes(keyword));
          }
          
          if (matchesSituation) {
            return situationName;
          }
        }
        
        return 'allgemein';
      }
      
      selectedSituation = detectSituationFromMessage(feedback.customerMessage);
    }
    
    // Lade Training-Daten
    const trainingData = await getTrainingData();
    trainingData.conversations = trainingData.conversations || [];
    
    // Füge jede Variation zu Training-Daten hinzu (OHNE Kontext!)
    const addedVariations = [];
    variations.forEach((variation, index) => {
      const responseText = variation.editedText || variation.text;
      if (!responseText || responseText.trim() === '') {
        return; // Überspringe leere Variationen
      }
      
      const newConversation = {
        customerMessage: feedback.customerMessage,
        moderatorResponse: responseText.trim(),
        situation: selectedSituation, // Verwende ausgewählte oder erkannte Situation
        createdAt: new Date().toISOString(),
        source: variation.editedText ? 'feedback_generated_edited' : 'feedback_generated',
        priority: true,
        feedbackId: id,
        variationIndex: index
      };
      
      console.log(`📋 [Variationen] Speichere Gespräch mit Situation: "${newConversation.situation}"`);
      console.log(`📋 [Variationen] Gespräch-Daten:`, JSON.stringify(newConversation).substring(0, 200));
      
      trainingData.conversations.push(newConversation);
      
      addedVariations.push({
        customerMessage: feedback.customerMessage,
        moderatorResponse: responseText.trim(),
        situation: selectedSituation
      });
    });
    
    await saveTrainingData(trainingData);
    
    // Aktualisiere Feedback-Eintrag: Markiere, dass Variationen generiert wurden
    const feedbackData = await getFeedbackData();
    const feedbackIndex = feedbackData.feedbacks.findIndex(f => f.id === id);
    if (feedbackIndex !== -1) {
      const existingVariationsCount = feedbackData.feedbacks[feedbackIndex].variationsGeneratedCount || 0;
      feedbackData.feedbacks[feedbackIndex].variationsGeneratedCount = existingVariationsCount + addedVariations.length;
      feedbackData.feedbacks[feedbackIndex].variationsGeneratedAt = new Date().toISOString();
      feedbackData.feedbacks[feedbackIndex].lastVariationsCount = addedVariations.length;
      await saveFeedbackData(feedbackData);
      console.log(`✅ Feedback-Eintrag aktualisiert: ${addedVariations.length} Variationen hinzugefügt (Gesamt: ${feedbackData.feedbacks[feedbackIndex].variationsGeneratedCount})`);
    }
    
    console.log(`✅ ${addedVariations.length} Variationen zu Training-Daten hinzugefügt (Feedback-ID: ${id}, Situation: ${selectedSituation})`);
    
    res.json({ 
      success: true, 
      addedCount: addedVariations.length,
      variations: addedVariations
    });
  } catch (error) {
    console.error('Fehler beim Hinzufügen der Variationen:', error);
    res.status(500).json({ error: 'Fehler beim Hinzufügen der Variationen: ' + error.message });
  }
});

// DELETE /api/v1/feedback/:id - Lösche Feedback-Eintrag
router.delete('/feedback/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const data = await getFeedbackData();
    const feedbackIndex = data.feedbacks.findIndex(f => f.id === id);
    
    if (feedbackIndex === -1) {
      return res.status(404).json({ error: 'Feedback-Eintrag nicht gefunden' });
    }
    
    data.feedbacks.splice(feedbackIndex, 1);
    await saveFeedbackData(data);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Löschen des Feedback-Eintrags:', error);
    res.status(500).json({ error: 'Fehler beim Löschen des Feedback-Eintrags' });
  }
});

module.exports = router;
