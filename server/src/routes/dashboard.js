const express = require("express");
const fs = require("fs");
const path = require("path");
const { getRules, getTrainingData, reloadConfig, RULES_FILE, TRAINING_DATA_FILE } = require("../config/config-loader");
const { verifyToken, findUserByEmail, createUser } = require("../auth");
const { pool } = require("../db");
const { pushFileToGitHub } = require("../utils/github");
const { getClient } = require("../openaiClient");

const router = express.Router();

// Wenn SKIP_AUTH=true gesetzt ist, Auth überspringen (nur für Tests!)
const SKIP_AUTH = process.env.SKIP_AUTH === "true";

// Auth Middleware
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

// GET: Aktuelle Regeln abrufen
router.get("/rules", (req, res) => {
  try {
    const rules = getRules();
    res.json({ success: true, data: rules });
  } catch (err) {
    console.error("Fehler beim Abrufen der Regeln:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Regeln aktualisieren
router.post("/rules", (req, res) => {
  try {
    const newRules = req.body;
    
    // Validiere Struktur
    if (!newRules || typeof newRules !== "object") {
      return res.status(400).json({ success: false, error: "Ungültige Regeln-Struktur" });
    }
    
    // Backup der alten Datei
    if (fs.existsSync(RULES_FILE)) {
      const backupPath = RULES_FILE + ".backup." + Date.now();
      fs.copyFileSync(RULES_FILE, backupPath);
    }
    
    // Speichere neue Regeln
    fs.writeFileSync(RULES_FILE, JSON.stringify(newRules, null, 2), "utf8");
    
    // Reload Config
    reloadConfig();
    
    res.json({ success: true, message: "Regeln erfolgreich aktualisiert" });
  } catch (err) {
    console.error("Fehler beim Speichern der Regeln:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET: Training Data abrufen
router.get("/training-data", (req, res) => {
  try {
    const trainingData = getTrainingData();
    res.json({ success: true, data: trainingData });
  } catch (err) {
    console.error("Fehler beim Abrufen der Training Data:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Training Data hinzufügen
router.post("/training-data", (req, res) => {
  try {
    const { customerMessage, moderatorResponse, situation, tags } = req.body;
    
    if (!customerMessage || !moderatorResponse) {
      return res.status(400).json({ success: false, error: "customerMessage und moderatorResponse sind erforderlich" });
    }
    
    const trainingData = getTrainingData();
    const newConversation = {
      id: Date.now().toString(),
      customerMessage: customerMessage.trim(),
      moderatorResponse: moderatorResponse.trim(),
      situation: situation || "general",
      tags: tags || [],
      createdAt: new Date().toISOString()
    };
    
    trainingData.conversations.push(newConversation);
    trainingData.totalConversations = trainingData.conversations.length;
    trainingData.lastUpdated = new Date().toISOString();
    
    // Backup
    if (fs.existsSync(TRAINING_DATA_FILE)) {
      const backupPath = TRAINING_DATA_FILE + ".backup." + Date.now();
      fs.copyFileSync(TRAINING_DATA_FILE, backupPath);
    }
    
    // Speichere
    fs.writeFileSync(TRAINING_DATA_FILE, JSON.stringify(trainingData, null, 2), "utf8");
    
    // Reload Config
    reloadConfig();
    
    res.json({ success: true, message: "Training Data hinzugefügt", data: newConversation });
  } catch (err) {
    console.error("Fehler beim Hinzufügen der Training Data:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE: Training Data löschen UND auf GitHub pushen
router.delete("/training-data/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const trainingData = getTrainingData();
    
    const index = trainingData.conversations.findIndex(c => c.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, error: "Konversation nicht gefunden" });
    }
    
    trainingData.conversations.splice(index, 1);
    trainingData.totalConversations = trainingData.conversations.length;
    trainingData.lastUpdated = new Date().toISOString();
    
    // Backup
    if (fs.existsSync(TRAINING_DATA_FILE)) {
      const backupPath = TRAINING_DATA_FILE + ".backup." + Date.now();
      fs.copyFileSync(TRAINING_DATA_FILE, backupPath);
    }
    
    // Speichere lokal
    fs.writeFileSync(TRAINING_DATA_FILE, JSON.stringify(trainingData, null, 2), "utf8");
    
    // Reload Config
    reloadConfig();
    
    // Pushe auf GitHub
    try {
      const content = JSON.stringify(trainingData, null, 2);
      await pushFileToGitHub(
        "server/src/config/training-data.json",
        content,
        "Delete training data via Dashboard"
      );
      res.json({ success: true, message: "Training Data gelöscht und auf GitHub gepusht" });
    } catch (githubErr) {
      console.error("GitHub Push fehlgeschlagen:", githubErr);
      res.json({ 
        success: true, 
        message: "Training Data lokal gelöscht, aber GitHub Push fehlgeschlagen",
        warning: githubErr.message 
      });
    }
  } catch (err) {
    console.error("Fehler beim Löschen der Training Data:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Config neu laden (Hot-Reload)
router.post("/reload", (req, res) => {
  try {
    reloadConfig();
    res.json({ success: true, message: "Config erfolgreich neu geladen" });
  } catch (err) {
    console.error("Fehler beim Neuladen der Config:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Regeln speichern UND auf GitHub pushen
router.post("/rules/push", async (req, res) => {
  try {
    const newRules = req.body;
    
    if (!newRules || typeof newRules !== "object") {
      return res.status(400).json({ success: false, error: "Ungültige Regeln-Struktur" });
    }
    
    // Speichere lokal
    if (fs.existsSync(RULES_FILE)) {
      const backupPath = RULES_FILE + ".backup." + Date.now();
      fs.copyFileSync(RULES_FILE, backupPath);
    }
    fs.writeFileSync(RULES_FILE, JSON.stringify(newRules, null, 2), "utf8");
    reloadConfig();
    
    // Pushe auf GitHub
    try {
      const content = JSON.stringify(newRules, null, 2);
      const result = await pushFileToGitHub(
        "server/src/config/rules.json",
        content,
        "Update rules via Dashboard"
      );
      res.json({ success: true, message: "Regeln gespeichert und auf GitHub gepusht", commitUrl: result.commitUrl });
    } catch (githubErr) {
      console.error("GitHub Push fehlgeschlagen:", githubErr);
      res.json({ 
        success: true, 
        message: "Regeln lokal gespeichert, aber GitHub Push fehlgeschlagen",
        warning: githubErr.message 
      });
    }
  } catch (err) {
    console.error("Fehler beim Speichern/Pushen der Regeln:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Training Data speichern UND auf GitHub pushen
router.post("/training-data/push", async (req, res) => {
  try {
    const { customerMessage, moderatorResponse, situation, tags } = req.body;
    
    if (!customerMessage || !moderatorResponse) {
      return res.status(400).json({ success: false, error: "customerMessage und moderatorResponse sind erforderlich" });
    }
    
    const trainingData = getTrainingData();
    const newConversation = {
      id: Date.now().toString(),
      customerMessage: customerMessage.trim(),
      moderatorResponse: moderatorResponse.trim(),
      situation: situation || "general",
      tags: tags || [],
      createdAt: new Date().toISOString()
    };
    
    trainingData.conversations.push(newConversation);
    trainingData.totalConversations = trainingData.conversations.length;
    trainingData.lastUpdated = new Date().toISOString();
    
    // Backup
    if (fs.existsSync(TRAINING_DATA_FILE)) {
      const backupPath = TRAINING_DATA_FILE + ".backup." + Date.now();
      fs.copyFileSync(TRAINING_DATA_FILE, backupPath);
    }
    
    // Speichere lokal
    fs.writeFileSync(TRAINING_DATA_FILE, JSON.stringify(trainingData, null, 2), "utf8");
    reloadConfig();
    
    // Pushe auf GitHub
    try {
      const content = JSON.stringify(trainingData, null, 2);
      const result = await pushFileToGitHub(
        "server/src/config/training-data.json",
        content,
        "Add training data via Dashboard"
      );
      res.json({ success: true, message: "Training Data gespeichert und auf GitHub gepusht", data: newConversation, commitUrl: result.commitUrl });
    } catch (githubErr) {
      console.error("GitHub Push fehlgeschlagen:", githubErr);
      res.json({ 
        success: true, 
        message: "Training Data lokal gespeichert, aber GitHub Push fehlgeschlagen",
        data: newConversation,
        warning: githubErr.message 
      });
    }
  } catch (err) {
    console.error("Fehler beim Speichern/Pushen der Training Data:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET: Alle User abrufen (für Extension Logins)
router.get("/users", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ success: false, error: "Datenbank nicht verfügbar" });
    }
    
    const { rows } = await pool.query("SELECT id, email, created_at FROM users ORDER BY created_at DESC");
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Fehler beim Abrufen der User:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Neuen User erstellen (für Extension Login)
router.post("/users", async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, error: "email und password sind erforderlich" });
    }
    
    if (!pool) {
      return res.status(500).json({ success: false, error: "Datenbank nicht verfügbar" });
    }
    
    // Prüfe ob User bereits existiert
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ success: false, error: "User mit dieser Email existiert bereits" });
    }
    
    const user = await createUser(email, password);
    res.json({ success: true, message: "User erfolgreich erstellt", data: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("Fehler beim Erstellen des Users:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE: User löschen
router.delete("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!pool) {
      return res.status(500).json({ success: false, error: "Datenbank nicht verfügbar" });
    }
    
    const { rows } = await pool.query("DELETE FROM users WHERE id = $1 RETURNING email", [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: "User nicht gefunden" });
    }
    
    res.json({ success: true, message: "User erfolgreich gelöscht" });
  } catch (err) {
    console.error("Fehler beim Löschen des Users:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Test Chat - Teste KI-Antworten mit aktuellen Regeln
router.post("/test-chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ success: false, error: "Nachricht erforderlich" });
    }
    
    const client = getClient();
    if (!client) {
      return res.status(500).json({ success: false, error: "OpenAI Client nicht verfügbar" });
    }
    
    // Lade aktuelle Regeln
    const rules = getRules();
    const lowerMessage = message.toLowerCase();
    
    // Zeit/Datum für DACH (Europe/Berlin)
    const now = new Date();
    const nowString = now.toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour12: false });
    const month = now.getMonth() + 1;
    const season = month === 12 || month <= 2 ? "Winter" : month <= 5 ? "Frühling" : month <= 8 ? "Sommer" : "Herbst";
    
    // System Prompt (ähnlich wie in reply.js)
    let systemPrompt = `Du bist ein freundlicher, natürlicher Chat-Moderator auf einer Dating-Plattform. 
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- Antworte natürlich, flirty und interessiert, aber nicht übertrieben
- Sei konkret und persönlich, nicht generisch
- Reagiere NUR auf das, was der KUNDE in SEINER Nachricht geschrieben hat!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte
- Schreibe natürlich und menschlich - wie eine echte Person schreiben würde
- Verwende keine generischen Phrasen wie "Wie kann ich dir helfen?" oder "Hallo!"
- WICHTIG: Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- WICHTIG: Verwende KEINE Anführungszeichen (" oder ') am Anfang oder Ende der Nachricht!
- WICHTIG: Nachricht muss MINDESTENS 80 Zeichen lang sein!
- WICHTIG: Am Ende IMMER eine passende Frage zum Kontext stellen!
- WICHTIG: Es darf NIEMALS auffallen, dass du ein Moderator bist - sei natürlich und menschlich!
- WICHTIG: Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${nowString} (${season}). Keine falschen Jahreszeiten/Wetter-Annahmen.
- WICHTIG: Wenn der Kunde Zeiten/Wecker/Schlaf erwähnt, reagiere empathisch auf wenig Schlaf usw., aber verabschiede dich nicht.
- WICHTIG: Auch bei "Gute Nacht" oder ähnlichem den Dialog offenhalten und eine passende Frage stellen.
- WICHTIG: Bei Geld/Coins/Bezahlen/aufladen/kostenlos: nicht darüber reden, nicht zum Aufladen auffordern, elegant ausweichen und sofort mit einer passenden Frage zum Thema fortfahren.`;
    
    // Füge allgemeine Regeln hinzu
    if (rules.generalRules && Array.isArray(rules.generalRules) && rules.generalRules.length > 0) {
      const generalRulesText = rules.generalRules.map(rule => `- WICHTIG: ${rule}`).join('\n');
      systemPrompt += `\n\n📋 ALLGEMEINE REGELN (IMMER beachten):\n${generalRulesText}`;
    }
    
    // Prüfe auf Situational Responses
    let specificInstructions = "";
    if (rules.situationalResponses && typeof rules.situationalResponses === "object") {
      Object.entries(rules.situationalResponses).forEach(([situationKey, situationRule]) => {
        if (!situationRule || !situationRule.enabled) return;
        
        let matches = false;
        if (situationRule.keywords && Array.isArray(situationRule.keywords) && situationRule.keywords.length > 0) {
          matches = situationRule.keywords.some(keyword => 
            lowerMessage.includes(keyword.toLowerCase())
          );
        }
        
        if (matches && situationRule.instructions) {
          const emoji = situationRule.emoji || "⚠️";
          const title = situationRule.title || situationKey;
          specificInstructions += `\n\n${emoji} SITUATION: ${title}\n${situationRule.instructions}`;
        }
      });
    }
    
    // Füge Preferred Words hinzu (besonders bei sexuellen Themen)
    let preferredWordsContext = "";
    if (rules.preferredWords) {
      const isSexualTopic = lowerMessage.includes("sex") || lowerMessage.includes("sexuell") || 
                           lowerMessage.includes("nackt") || lowerMessage.includes("intim") ||
                           lowerMessage.includes("körper") || lowerMessage.includes("lust");
      
      if (isSexualTopic && rules.preferredWords.sexual && rules.preferredWords.sexual.length > 0) {
        preferredWordsContext = `\n\n💋 BEVORZUGTE WÖRTER (verwende diese bei sexuellen Themen): ${rules.preferredWords.sexual.join(", ")}`;
      } else if (rules.preferredWords.flirty && rules.preferredWords.flirty.length > 0) {
        preferredWordsContext = `\n\n😘 BEVORZUGTE WÖRTER (verwende diese bei flirty Gesprächen): ${rules.preferredWords.flirty.join(", ")}`;
      } else if (rules.preferredWords.general && rules.preferredWords.general.length > 0) {
        preferredWordsContext = `\n\n💬 BEVORZUGTE WÖRTER (verwende diese allgemein): ${rules.preferredWords.general.join(", ")}`;
      }
    }
    
    // Baue Chat-Historie für Kontext
    const messages = [];
    messages.push({ role: "system", content: systemPrompt + specificInstructions + preferredWordsContext });
    
    // Füge Historie hinzu (letzte 10 Nachrichten)
    const recentHistory = history.slice(-10);
    recentHistory.forEach(msg => {
      if (msg.role && msg.content) {
        messages.push({ role: msg.role, content: msg.content });
      }
    });
    
    // Füge aktuelle Nachricht hinzu
    messages.push({ role: "user", content: message });
    
    // Generiere Antwort
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.8,
      max_tokens: 500
    });
    
    let replyText = completion.choices?.[0]?.message?.content?.trim() || "";
    
    if (!replyText) {
      return res.status(500).json({ success: false, error: "Keine Antwort von der KI erhalten" });
    }
    
    // Entferne Anführungszeichen am Anfang/Ende
    replyText = replyText.replace(/^["'„""]+|["'"""]+$/g, "");
    
    // Stelle sicher, dass mindestens 80 Zeichen
    if (replyText.length < 80) {
      replyText += " Was denkst du dazu?";
    }
    
    // Stelle sicher, dass eine Frage am Ende steht
    if (!replyText.match(/[.!?]$/)) {
      replyText += "?";
    }
    
    res.json({ 
      success: true, 
      data: { 
        reply: replyText,
        rulesApplied: specificInstructions ? true : false,
        preferredWordsUsed: preferredWordsContext ? true : false
      } 
    });
  } catch (err) {
    console.error("Fehler im Test-Chat:", err);
    // Stelle sicher, dass immer JSON zurückgegeben wird
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message || "Unbekannter Fehler" });
    }
  }
});

// GET: Statistiken abrufen
router.get("/statistics", (req, res) => {
  try {
    const messagesPath = path.join(__dirname, '../data/messages.json');
    let messages = [];
    
    if (fs.existsSync(messagesPath)) {
      try {
        const data = fs.readFileSync(messagesPath, 'utf8');
        messages = JSON.parse(data);
      } catch (e) {
        console.error('Fehler beim Lesen der Nachrichten:', e);
      }
    }
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const stats = {
      total: messages.length,
      today: messages.filter(m => new Date(m.timestamp) >= today).length,
      yesterday: messages.filter(m => {
        const msgDate = new Date(m.timestamp);
        return msgDate >= yesterday && msgDate < today;
      }).length,
      thisWeek: messages.filter(m => new Date(m.timestamp) >= weekAgo).length,
      platforms: {},
      recentMessages: messages.slice(-100).reverse() // Letzte 100 Nachrichten, neueste zuerst
    };
    
    // Zähle Plattformen
    messages.forEach(msg => {
      const platform = msg.platform || 'unknown';
      stats.platforms[platform] = (stats.platforms[platform] || 0) + 1;
    });
    
    // Aktive Plattformen (heute)
    const activePlatforms = new Set();
    messages.filter(m => new Date(m.timestamp) >= today).forEach(m => {
      activePlatforms.add(m.platform || 'unknown');
    });
    stats.activePlatforms = activePlatforms.size;
    
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error("Fehler beim Abrufen der Statistiken:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

