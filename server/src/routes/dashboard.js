const express = require("express");
const fs = require("fs");
const path = require("path");
const { getRules, getTrainingData, reloadConfig, RULES_FILE, TRAINING_DATA_FILE } = require("../config/config-loader");
const { verifyToken } = require("../auth");

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

module.exports = router;

