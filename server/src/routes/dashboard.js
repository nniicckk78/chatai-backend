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
    const isBotAccusation = lowerMessage.includes("bot") || lowerMessage.includes("ki") || 
                           lowerMessage.includes("künstliche intelligenz") || 
                           lowerMessage.includes("chatgpt") || lowerMessage.includes("fake") ||
                           lowerMessage.includes("automatisch") || lowerMessage.includes("programmiert");
    
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
    
    // Füge allgemeine Regeln hinzu (BASIS - arbeiten mit anderen zusammen)
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      specificInstructions += `\n\n📝📝📝 ALLGEMEINE REGELN - BASIS FÜR ALLE ANTWORTEN 📝📝📝

⚠️⚠️⚠️ WICHTIG: Diese Regeln sind die BASIS für deine Antworten und müssen bei JEDER Antwort beachtet werden! ⚠️⚠️⚠️

${rules.generalRules}

📋 KLARE PRIORITÄTEN-STRUKTUR:
1. ALLGEMEINE REGELN (diese hier) - BASIS, gelten IMMER
2. SPEZIFISCHE ANTWORTEN (siehe unten) - für bestimmte Situationen, ergänzen die Allgemeinen Regeln
3. TRAINING-DATEN (siehe unten) - für Schreibstil und Wortwahl, arbeiten mit den Regeln zusammen

⚠️ WICHTIG: ⚠️
- Die Allgemeinen Regeln sind die BASIS - sie gelten IMMER
- Spezifische Antworten ergänzen die Allgemeinen Regeln für bestimmte Situationen
- Training-Daten zeigen dir den Schreibstil und die Wortwahl
- Alle drei arbeiten ZUSAMMEN - nicht gegeneinander!
- Wenn eine spezifische Antwort für eine Situation existiert, verwende sie, aber beachte trotzdem die Allgemeinen Regeln!`;
      console.log("📝 Allgemeine Regeln geladen und aktiviert (Basis für alle Antworten)");
    }

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
        // Zufällige Reihenfolge für Abwechslung
        const shuffledExamples = [...relevantExamples].sort(() => Math.random() - 0.5);
        
        trainingExamplesContext = `\n\n📚📚📚 ${relevantExamples.length} BEISPIEL-GESPRÄCHE (ALLE GLEICH WICHTIG - BILDE DARUS EINEN GENERELLEN STIL!) 📚📚📚\n`;
        
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
- Bilde einen GENERELLEN STIL aus ALLEN Beispielen!
- Dieser generelle Stil ist dein STANDARD für alle Antworten!
- Neue Beispiele werden automatisch in den generellen Stil einbezogen!
- Verwende NUR Wörter und Formulierungen, die in den Beispielen vorkommen!
- Nur wenn wirklich nichts Passendes da ist, ergänze minimal - aber im gleichen Stil!

🎯 FÜR DIESE ANTWORT JETZT:
- Analysiere ALLE ${relevantExamples.length} Beispiele GLEICHWERTIG
- Bilde daraus einen GENERELLEN STIL (Wortschatz, Formulierungen, Ton)
- Verwende diesen GENERELLEN STIL als Basis
- Passe die Antwort an die aktuelle Nachricht an, aber behalte den Stil bei
- Wenn du eine passende Formulierung findest, verwende sie - sonst ergänze minimal im gleichen Stil!`;
        
        console.log(`📚 [Dashboard] ${relevantExamples.length} Beispiele werden verwendet - genereller Stil wird gebildet`);
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
    
    // WICHTIG: Allgemeine Regeln am Anfang des System-Prompts für höchste Sichtbarkeit
    // ABER: Klare Prioritäten - Allgemeine Regeln sind die BASIS, nicht alles überschreibend
    let generalRulesSystemNote = "";
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      generalRulesSystemNote = `\n\n📝📝📝 ALLGEMEINE REGELN - BASIS FÜR ALLE ANTWORTEN 📝📝📝

⚠️⚠️⚠️ WICHTIG: Diese Regeln sind die BASIS für deine Antworten und müssen bei JEDER Antwort beachtet werden! ⚠️⚠️⚠️

${rules.generalRules}

📋 PRIORITÄTEN-ÜBERSICHT:
1. ALLGEMEINE REGELN (diese hier) - BASIS für alle Antworten, immer beachten
2. SPEZIFISCHE ANTWORTEN (im userPrompt) - für bestimmte Situationen, haben Vorrang bei passender Situation
3. TRAINING-DATEN (im userPrompt) - für Schreibstil und Wortwahl, immer beachten

⚠️ WICHTIG: ⚠️
- Die Allgemeinen Regeln sind die BASIS - sie gelten IMMER
- Spezifische Antworten ergänzen die Allgemeinen Regeln für bestimmte Situationen
- Training-Daten zeigen dir den Schreibstil und die Wortwahl
- Alle drei arbeiten ZUSAMMEN - nicht gegeneinander!

\n`;
    }

    const systemPrompt = `${generalRulesSystemNote}Du bist ein freundlicher, natürlicher Chat-Moderator auf einer Dating-Plattform. 
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
- 🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden bewerten, kommentieren oder einordnen! 🚨🚨🚨
- 🚨 ABSOLUT VERBOTEN: KEINE Meta-Kommentare wie "das ist direkt", "das ist eine direkte Frage", "das ist spannend", "das ist mutig", "das ist eine Frage", "das ist interessant", "das ist eine gute Frage", "das ist eine schwierige Frage", "das ist eine persönliche Frage", "das ist eine intime Frage", "das ist eine klare Frage", "das ist eine offene Frage", "das ist eine wichtige Frage", "das ist eine interessante Frage", "das ist eine schöne Frage", "das ist eine komische Frage", "das ist eine ungewöhnliche Frage", "das ist eine mutige Frage", "das ist eine ehrliche Frage", "das ist eine private Frage" oder ähnliches!
- 🚨 ABSOLUT VERBOTEN: KEINE Kommentare über die Art der Nachricht wie "das ist direkt", "das ist offen", "das ist ehrlich", "das ist mutig", "das ist persönlich", "das ist intim", "das ist klar", "das ist wichtig", "das ist interessant", "das ist schön", "das ist komisch", "das ist ungewöhnlich", "das ist mutig", "das ist ehrlich", "das ist privat"!
- 🚨 WICHTIG: Reagiere NUR auf den INHALT der Nachricht, nicht auf die NACHRICHT selbst! Antworte direkt auf das, was der Kunde geschrieben hat, ohne die Nachricht zu bewerten oder zu kommentieren!
- 🚨 BEISPIEL FALSCH: "Das ist eine direkte Frage, Sebastian. Ich denke..." → FALSCH! NIEMALS so antworten!
- 🚨 BEISPIEL RICHTIG: Direkt auf die Frage eingehen, ohne sie zu kommentieren! Z.B. wenn der Kunde fragt "Schluckst du??", dann antworte direkt auf die Frage, ohne zu sagen "das ist eine direkte Frage"!
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
- 🚨🚨🚨🚨🚨 KRITISCH: SCHREIBSTIL UND WORTWAHL AUS TRAINING-DATEN - HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨
- Im userPrompt findest du BEISPIEL-GESPRÄCHE aus den Training-Daten
- Diese Beispiele zeigen dir den EXAKTEN Schreibstil und die Wortwahl, die du verwenden sollst
- ORIENTIERE DICH GENERELL an diesen Beispielen - nicht nur in ähnlichen Situationen, sondern IMMER!
- Übernehme die WORTWAHL, FORMULIERUNGEN und den SCHREIBSTIL aus den Beispielen
- Die Beispiel-Antworten zeigen dir, wie "echte" Moderator/Fake-Antworten aussehen - schreibe GENAU SO!
- Analysiere die Beispiele und identifiziere wiederkehrende Muster in Wortwahl, Satzstruktur und Ton
- Verwende diese Muster GENERELL in deinen Antworten, nicht nur wenn die Situation ähnlich ist!
- Die Training-Daten sind deine HAUPTREFERENZ für Schreibstil und Wortwahl - nutze sie IMMER!
- ⚠️⚠️⚠️ WICHTIG: Die Training-Daten haben HÖCHSTE PRIORITÄT für Schreibstil und Wortwahl! ⚠️⚠️⚠️
- ⚠️⚠️⚠️ Verwende NUR Wörter und Formulierungen, die in den Beispielen vorkommen! ⚠️⚠️⚠️
- ⚠️⚠️⚠️ Wenn du unsicher bist, schaue in die Beispiele und verwende ähnliche Formulierungen! ⚠️⚠️⚠️`;

    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

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
- Wenn der Kunde nur "hi" schreibt, antworte kurz und freundlich auf "hi" - erfinde keine Daten, Termine oder andere Dinge!
- Antworte als FAKE-PROFIL auf den KUNDEN
- Verwende NIEMALS deinen eigenen Namen (Fake-Name) in der Antwort
- Antworte natürlich und persönlich auf die Nachricht des KUNDEN. Sei nicht generisch!
- KEINE Bindestriche (-) verwenden!
- Nachricht muss MINDESTENS 80 Zeichen lang sein!
- Am Ende IMMER eine passende Frage zum Kontext stellen!
- Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!
- 🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden bewerten, kommentieren oder einordnen! KEINE Meta-Kommentare wie "das ist direkt", "das ist spannend", "das ist mutig", "das ist eine Frage", "das ist interessant", "das ist cool" oder ähnliches! Reagiere NUR auf den INHALT der Nachricht, nicht auf die NACHRICHT selbst! 🚨🚨🚨
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
${rules && rules.generalRules && rules.generalRules.trim() ? `\n\n📝📝📝 ERINNERUNG: ALLGEMEINE REGELN - BASIS FÜR ALLE ANTWORTEN 📝📝📝\n\n⚠️⚠️⚠️ Die oben genannten ALLGEMEINEN REGELN sind die BASIS für deine Antworten! ⚠️⚠️⚠️\n\n- Diese Regeln gelten IMMER und müssen bei JEDER Antwort beachtet werden\n- Sie arbeiten ZUSAMMEN mit spezifischen Antworten und Training-Daten\n- Spezifische Antworten ergänzen die Allgemeinen Regeln für bestimmte Situationen\n- Training-Daten zeigen dir den Schreibstil und die Wortwahl\n- Alle drei arbeiten ZUSAMMEN - nicht gegeneinander!\n\n📋 BEACHTE: Allgemeine Regeln (Basis) + Spezifische Antworten (für Situationen) + Training-Daten (für Stil) = Perfekte Antwort!` : ''}`;

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
    
    // 🚨 KRITISCH: Prüfe auf verbotene Wörter und Meta-Kommentare (wie in reply.js)
    const replyLower = reply.toLowerCase();
    const foundForbiddenWords = [];
    const foundMetaComments = [];
    
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
    const metaCommentPatterns = [
      /das ist (eine |ein )?direkte (frage|nachricht)/i,
      /das ist (eine |ein )?(gute|schwierige|persönliche|intime|klare|offene|wichtige|interessante|schöne|komische|ungewöhnliche|mutige|ehrliche|private) (frage|nachricht)/i,
      /(das|dies) ist (eine |ein )?frage/i,
      /(das|dies) ist (eine |ein )?nachricht/i,
      /(das|dies) ist (direkt|offen|ehrlich|mutig|persönlich|intim|klar|wichtig|interessant|schön|komisch|ungewöhnlich|mutig|ehrlich|privat)/i,
      /(das|dies) ist (eine |ein )?(direkte|offene|ehrliche|mutige|persönliche|intime|klare|wichtige|interessante|schöne|komische|ungewöhnliche|mutige|ehrliche|private) (frage|nachricht)/i
    ];
    
    for (const pattern of metaCommentPatterns) {
      if (pattern.test(reply)) {
        foundMetaComments.push("Meta-Kommentar über die Nachricht");
        break;
      }
    }
    
    // Wenn verbotene Wörter oder Meta-Kommentare gefunden wurden, versuche Neu-Generierung
    if (foundForbiddenWords.length > 0 || foundMetaComments.length > 0) {
      if (foundForbiddenWords.length > 0) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Verbotene Wörter in generierter Antwort gefunden: ${foundForbiddenWords.join(', ')} 🚨🚨🚨`);
      }
      if (foundMetaComments.length > 0) {
        console.error(`🚨🚨🚨 [Dashboard] KRITISCH: Meta-Kommentare über die Nachricht gefunden! 🚨🚨🚨`);
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
        
        const retryPrompt = `Die vorherige Antwort enthielt ${retryReason}

DU MUSST DIESE WÖRTER ABSOLUT VERMEIDEN! Generiere eine NEUE Antwort auf die folgende Kundennachricht, die:
1. KEINE der verbotenen Wörter enthält (auch nicht in ähnlicher Form)
2. KEINE Meta-Kommentare über die Nachricht enthält (z.B. NICHT "das ist eine direkte Frage", "das ist eine gute Frage", "das ist interessant", etc.)
3. Direkt auf den INHALT der Nachricht eingeht, ohne die Nachricht selbst zu kommentieren
4. Natürlich und passend klingt
5. Mindestens 80 Zeichen lang ist
6. Mit einer Frage endet

VERBOTENE WÖRTER (ABSOLUT NICHT VERWENDEN): ${rules?.forbiddenWords?.map(w => `"${w}"`).join(', ') || "keine"}

🚨🚨🚨 KRITISCH: NIEMALS die Nachricht des Kunden kommentieren! KEINE Phrasen wie:
- "das ist eine direkte Frage"
- "das ist eine gute Frage"
- "das ist interessant"
- "das ist mutig"
- "das ist persönlich"
- "das ist eine Frage"
- oder ähnliche Meta-Kommentare!

Reagiere NUR auf den INHALT, nicht auf die NACHRICHT selbst! 🚨🚨🚨

Kundennachricht: "${message.substring(0, 500)}"

${forbiddenWordsContext}

${profilePicContext}

${trainingExamplesContext}

${specificInstructions}

${preferredWordsContext}${conversationBlock}
Aktuelles Datum/Zeit (DACH): ${nowString} (${season})

Antworte NUR mit der neuen Antwort, keine Erklärungen.`;
        
        const retryChat = await client.chat.completions.create({
          model: "gpt-4o-mini",
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
