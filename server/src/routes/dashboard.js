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

// Helper: Lade Regeln aus Datei oder GitHub
async function getRules() {
  // Versuche zuerst von GitHub zu laden
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      // Versuche verschiedene Pfade
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
        // Speichere auch lokal als Backup
        const rulesPath = path.join(__dirname, '../../config/rules.json');
        const configDir = path.dirname(rulesPath);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(rulesPath, content);
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
        
        // Wenn neue Standard-Situationen hinzugefügt wurden, speichere sie
        if (Object.keys(mergedSituations).length > Object.keys(rules.situationalResponses).length) {
          rules.situationalResponses = mergedSituations;
          // Speichere aktualisierte Regeln
          const content = JSON.stringify(rules, null, 2);
          fs.writeFileSync(rulesPath, content);
        } else {
          rules.situationalResponses = mergedSituations;
        }
        
        return rules;
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('Fehler beim Laden der Regeln von GitHub:', err.message);
      }
      // Fallback zu lokaler Datei
    }
  }

  // Fallback: Lade von lokaler Datei
  const localRulesPath = path.join(__dirname, '../../config/rules.json');
  try {
    if (fs.existsSync(localRulesPath)) {
      const data = fs.readFileSync(localRulesPath, 'utf8');
      const parsed = JSON.parse(data);
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
      
      // Wenn neue Standard-Situationen hinzugefügt wurden, speichere sie
      if (Object.keys(mergedSituations).length > Object.keys(rules.situationalResponses).length) {
        rules.situationalResponses = mergedSituations;
        // Speichere aktualisierte Regeln
        const content = JSON.stringify(rules, null, 2);
        fs.writeFileSync(localRulesPath, content);
      } else {
        rules.situationalResponses = mergedSituations;
      }
      
      return rules;
    }
  } catch (err) {
    console.error('Fehler beim Laden der Regeln:', err);
  }
  
  // Erstelle Standard-Struktur mit vordefinierten Anweisungen (damit sie bearbeitbar sind)
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
  }
  
  return defaultRules;
}

// Helper: Speichere Regeln in Datei und auf GitHub
async function saveRules(rules) {
  const content = JSON.stringify(rules, null, 2);
  const rulesPath = path.join(__dirname, '../../config/rules.json');
  const configDir = path.dirname(rulesPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(rulesPath, content);
  
  // Versuche auch auf GitHub zu pushen
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
          break;
        } catch (err) {
          if (err.status === 404) continue; // Versuche nächsten Pfad
          throw err;
        }
      }
      
      if (!pushed) {
        // Falls kein Pfad funktioniert, verwende den Standard-Pfad
        await pushFileToGitHub('server/src/config/rules.json', content, 'Update rules via Dashboard');
      }
    } catch (err) {
      console.warn('⚠️ Konnte Regeln nicht auf GitHub pushen:', err.message);
    }
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
  return { conversations: [] };
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
    
    const isMeetingRequest = lowerMessage.includes("treffen") || lowerMessage.includes("wann") ||
                            lowerMessage.includes("zeit") || lowerMessage.includes("kennenlernen") ||
                            lowerMessage.includes("sehen") || lowerMessage.includes("date");
    
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
        
        if (matchesSituation && situationResponse) {
          specificInstructions += `\n\n📋 BENUTZERDEFINIERTE SITUATION: ${situationName}\n${situationResponse}`;
        }
      }
    }

    // Baue Context mit verbotenen und bevorzugten Wörtern
    let forbiddenWordsContext = "";
    let preferredWordsContext = "";
    if (rules) {
      if (rules.forbiddenWords && Array.isArray(rules.forbiddenWords) && rules.forbiddenWords.length > 0) {
        forbiddenWordsContext = `\n\n❌ VERBOTENE WÖRTER/PHRASEN (NIEMALS verwenden):\n${rules.forbiddenWords.map(w => `- ${w}`).join('\n')}`;
      }
      if (rules.preferredWords && Array.isArray(rules.preferredWords) && rules.preferredWords.length > 0) {
        preferredWordsContext = `\n\n✅ BEVORZUGTE WÖRTER (verwende diese bevorzugt):\n${rules.preferredWords.map(w => `- ${w}`).join('\n')}`;
      }
    }

    // Füge allgemeine Regeln hinzu
    if (rules && rules.generalRules && rules.generalRules.trim()) {
      specificInstructions += `\n\n📝 ALLGEMEINE REGELN:\n${rules.generalRules}`;
    }

    // Füge Training Data (Beispiel-Gespräche) hinzu
    let trainingExamplesContext = "";
    if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations) && trainingData.conversations.length > 0) {
      // Finde relevante Beispiele
      const relevantExamples = [];
      
      // 1. Prüfe ob es Beispiele für die aktuelle Situation gibt
      if (rules && rules.situationalResponses) {
        const currentSituation = Object.keys(rules.situationalResponses).find(sit => {
          const sitLower = sit.toLowerCase();
          return lowerMessage.includes(sitLower) || sitLower.split(/[\s\-_]+/).some(kw => 
            kw.length > 2 && lowerMessage.includes(kw)
          );
        });
        
        if (currentSituation) {
          const situationExamples = trainingData.conversations.filter(conv => 
            conv.situation && conv.situation.toLowerCase() === currentSituation.toLowerCase()
          );
          relevantExamples.push(...situationExamples.slice(0, 3));
        }
      }
      
      // 2. Finde Beispiele mit ähnlichen Kunden-Nachrichten
      if (relevantExamples.length < 3) {
        const messageWords = lowerMessage.split(/\s+/).filter(w => w.length > 3);
        const similarExamples = trainingData.conversations
          .filter(conv => {
            if (!conv.customerMessage) return false;
            const convLower = conv.customerMessage.toLowerCase();
            return messageWords.some(word => convLower.includes(word));
          })
          .slice(0, 3 - relevantExamples.length);
        relevantExamples.push(...similarExamples);
      }
      
      // 3. Falls keine passenden gefunden, nimm die letzten 2-3 Beispiele
      if (relevantExamples.length === 0) {
        relevantExamples.push(...trainingData.conversations.slice(-3));
      }
      
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
        trainingExamplesContext += `\nWICHTIG: Orientiere dich an diesen Beispielen! Passe deinen Schreibstil, Ton, Länge und Formulierungen an die Beispiel-Antworten an!`;
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

    // Baue System-Prompt (wie im reply.js)
    const systemPrompt = `Du bist ein freundlicher, natürlicher Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- Antworte natürlich, flirty und interessiert, aber nicht übertrieben
- Sei konkret und persönlich, nicht generisch
- Reagiere NUR auf das, was der KUNDE in SEINER Nachricht geschrieben hat!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte
- Schreibe natürlich und menschlich - wie eine echte Person schreiben würde
- Verwende keine generischen Phrasen wie "Wie kann ich dir helfen?" oder "Hallo!"
- WICHTIG: Keine Bindestriche (-) verwenden!
- WICHTIG: Nachricht muss MINDESTENS 80 Zeichen lang sein!
- WICHTIG: Am Ende IMMER eine passende Frage zum Kontext stellen!
- WICHTIG: Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!`;

    const userPrompt = `Du antwortest als FAKE-PROFIL auf eine Nachricht vom KUNDEN.

Aktuelle Nachricht vom KUNDEN: "${message}"

${forbiddenWordsContext}${preferredWordsContext}${trainingExamplesContext}${conversationBlock}
${specificInstructions}

WICHTIG: 
- Die Nachricht kommt vom KUNDEN, nicht von dir!
- Antworte NUR auf das, was der Kunde in SEINER Nachricht geschrieben hat!
- Erfinde KEINE Informationen, die nicht in der Nachricht stehen!
- Antworte als FAKE-PROFIL auf den KUNDEN
- Verwende NIEMALS deinen eigenen Namen (Fake-Name) in der Antwort
- Antworte natürlich und persönlich auf die Nachricht des KUNDEN. Sei nicht generisch!
- KEINE Bindestriche (-) verwenden!
- Nachricht muss MINDESTENS 80 Zeichen lang sein!
- Am Ende IMMER eine passende Frage zum Kontext stellen!`;

    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    const reply = chat.choices[0]?.message?.content?.trim() || "Keine Antwort generiert";
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
