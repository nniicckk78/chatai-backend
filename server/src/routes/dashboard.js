const express = require("express");
const fs = require("fs");
const path = require("path");
const { getRules, getTrainingData, reloadConfig, RULES_FILE, TRAINING_DATA_FILE } = require("../config/config-loader");
const { verifyToken, findUserByEmail, createUser } = require("../auth");
const { pool } = require("../db");
const { pushFileToGitHub } = require("../utils/github");

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

// DELETE: Training Data löschen
router.delete("/training-data/:id", (req, res) => {
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
    
    // Speichere
    fs.writeFileSync(TRAINING_DATA_FILE, JSON.stringify(trainingData, null, 2), "utf8");
    
    // Reload Config
    reloadConfig();
    
    res.json({ success: true, message: "Training Data gelöscht" });
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
      await pushFileToGitHub(
        "server/src/config/rules.json",
        content,
        "Update rules via Dashboard"
      );
      res.json({ success: true, message: "Regeln gespeichert und auf GitHub gepusht" });
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
      await pushFileToGitHub(
        "server/src/config/training-data.json",
        content,
        "Add training data via Dashboard"
      );
      res.json({ success: true, message: "Training Data gespeichert und auf GitHub gepusht", data: newConversation });
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

module.exports = router;

