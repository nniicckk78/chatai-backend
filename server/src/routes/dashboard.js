const express = require("express");
const fs = require("fs");
const path = require("path");
const { verifyToken } = require("../auth");
const { getClient } = require("../openaiClient");
const { getGitHubClient, getRepoInfo } = require("../utils/github");
const fineTuningUtils = require("../utils/fine-tuning");
const { runMultiStagePipeline } = require("../utils/multi-agent"); // 🚀 NEU: Für Test-Chat mit Together.ai
const { 
  collectPerfectExamples, 
  convertToJSONL, 
  uploadToOpenAI, 
  startFineTuning, 
  checkFineTuningStatus,
  listFineTuningJobs,
  getFineTuningConfig,
  saveFineTuningConfig,
  buildSystemPrompt,
  filterWithModeration
} = fineTuningUtils;
const router = express.Router();

// AI Model Konfiguration - zentral verwaltet (muss mit reply.js übereinstimmen)
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini"; // 🚨 Standard: GPT-4o-mini (kostengünstig, gute Qualität)

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
  
  // 🚨 WICHTIG: Versuche IMMER auf GitHub zu pushen (auch bei lokalen Änderungen!)
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
      let lastError = null;
      
      for (const filePath of possiblePaths) {
        try {
          await pushFileToGitHub(filePath, content, 'Update training data via Dashboard');
          console.log(`✅ Training-Daten erfolgreich auf GitHub gepusht: ${filePath}`);
          pushed = true;
          break;
        } catch (err) {
          if (err.status === 404) {
            // Versuche nächsten Pfad
            continue;
          }
          lastError = err;
          // Bei anderen Fehlern: Versuche trotzdem weiter
        }
      }
      
      if (!pushed) {
        // Falls kein Pfad funktioniert, verwende den Standard-Pfad
        try {
          await pushFileToGitHub('server/src/config/training-data.json', content, 'Update training data via Dashboard');
          console.log(`✅ Training-Daten erfolgreich auf GitHub gepusht (Standard-Pfad)`);
          pushed = true;
        } catch (err) {
          lastError = err;
        }
      }
      
      if (!pushed && lastError) {
        console.error(`❌ FEHLER: Training-Daten konnten NICHT auf GitHub gepusht werden:`, lastError.message);
        console.error(`❌ Die Änderungen wurden nur lokal gespeichert! Bitte manuell auf GitHub pushen.`);
        // 🚨 WICHTIG: Wirf den Fehler weiter, damit der Nutzer es sieht
        throw new Error(`GitHub-Push fehlgeschlagen: ${lastError.message}`);
      }
    } catch (err) {
      console.error('❌ KRITISCHER FEHLER beim Pushen der Training-Daten auf GitHub:', err.message);
      // 🚨 WICHTIG: Wirf den Fehler weiter, damit der API-Call fehlschlägt und der Nutzer es sieht
      throw err;
    }
  } else {
    console.warn('⚠️ GitHub Client nicht verfügbar - Training-Daten wurden nur lokal gespeichert');
  }
}

// Kurzlebiger Cache: Nach "Als gut markieren" / Bearbeiten liefert getFeedbackData() sofort die
// gespeicherten Daten statt von GitHub (GitHub-API kann Sekunden verzögert sein).
const FEEDBACK_CACHE_TTL_MS = 15000; // 15 Sekunden
let lastSavedFeedbackCache = null;

// Helper: Lade Feedback-Daten aus Datei oder GitHub
async function getFeedbackData() {
  if (lastSavedFeedbackCache && (Date.now() - lastSavedFeedbackCache.savedAt) < FEEDBACK_CACHE_TTL_MS) {
    console.log('✅ Feedback-Daten aus kurzfristigem Cache (nach Speichern)');
    return lastSavedFeedbackCache.data;
  }
  lastSavedFeedbackCache = null;

  const feedbackPath = path.join(__dirname, '../../config/feedback.json');

  const loadLocalFeedback = () => {
    try {
      if (fs.existsSync(feedbackPath)) {
        const data = fs.readFileSync(feedbackPath, 'utf8');
        const parsed = JSON.parse(data);
        const stats = fs.statSync(feedbackPath);
        console.log(`✅ Lokale Feedback-Daten geladen: ${Array.isArray(parsed.feedbacks) ? parsed.feedbacks.length : 0} Feedbacks`);
        return { data: parsed, mtime: stats.mtime };
      }
    } catch (err) {
      console.error('❌ Fehler beim Laden der lokalen Feedback-Daten:', err.message);
    }
    return null;
  };

  // 🚨 WICHTIG: GitHub ist die HAUPTQUELLE, lokale Datei nur als Backup!
  // Versuche zuerst von GitHub zu laden
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const { getFileFromGitHub } = require("../utils/github");
      const possiblePaths = [
        'server/src/config/feedback.json',
        'src/config/feedback.json',
        'config/feedback.json',
        'server/config/feedback.json'
      ];

      // 🚨 ROOT CAUSE FIX: Für feedback.json nutze Branch-Name statt 'HEAD' (zuverlässiger)
      // Das Problem: 'HEAD' kann manchmal nicht funktionieren, Branch-Name ist zuverlässiger
      // Lösung: Nutze API direkt mit Branch-Name für feedback.json (umgeht Cache)
      let content = null;
      let usedPath = null;
      
      const { getGitHubClient, getRepoInfo } = require("../utils/github");
      const client = getGitHubClient();
      const repo = getRepoInfo();
      
      // 🚨 ROOT CAUSE FIX: Logge Repo-Info für Debugging
      console.log(`🔍 GitHub Repo-Info: owner=${repo.owner}, repo=${repo.repo}, branch=${repo.branch}`);
      
      // 🚨 ROOT CAUSE FIX: Verwende Branch-Name statt 'HEAD' (zuverlässiger)
      // WICHTIG: Versuche zuerst den Standard-Pfad, der beim Speichern verwendet wird
      if (client) {
        // 🚨 ROOT CAUSE FIX: Versuche zuerst den Standard-Pfad (server/src/config/feedback.json)
        // Dieser Pfad wird auch beim Speichern verwendet
        const standardPath = 'server/src/config/feedback.json';
        try {
          console.log(`🔍 Lade Feedback-Daten von GitHub (Branch: ${repo.branch}): ${standardPath} (Standard-Pfad)`);
          const { data } = await client.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: standardPath,
            ref: repo.branch
          });
          if (data.encoding === 'base64' && data.content) {
            content = Buffer.from(data.content, 'base64').toString('utf8');
            usedPath = standardPath;
            console.log(`✅ Feedback-Daten von GitHub geladen (Standard-Pfad, Branch: ${repo.branch}): ${standardPath}`);
          } else if (data.download_url) {
            // Datei zu groß, lade über download_url
            console.log(`📥 Datei zu groß für direkten Content, lade über download_url: ${data.download_url}`);
            const https = require('https');
            const http = require('http');
            const url = require('url');
            const urlObj = url.parse(data.download_url);
            const clientModule = urlObj.protocol === 'https:' ? https : http;
            
            content = await new Promise((resolve, reject) => {
              const req = clientModule.get(data.download_url, (res) => {
                if (res.statusCode !== 200) {
                  reject(new Error(`HTTP ${res.statusCode}`));
                  return;
                }
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => resolve(body));
              });
              req.on('error', reject);
              req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Download timeout'));
              });
            });
            
            usedPath = standardPath;
            console.log(`✅ Feedback-Daten von GitHub geladen (via download_url, Branch: ${repo.branch}): ${standardPath}`);
          }
        } catch (err) {
          if (err.status !== 404) {
            console.error(`❌ Fehler beim Laden von GitHub (${standardPath}, Branch: ${repo.branch}):`, err.message);
            console.error(`❌ Error Details:`, err.status, err.response?.data || '');
          }
          // Falls Standard-Pfad fehlschlägt, versuche andere Pfade
          console.log(`⚠️ Standard-Pfad nicht gefunden, versuche alternative Pfade...`);
        }
        
        // Falls Standard-Pfad nicht funktioniert, versuche andere Pfade
        if (!content) {
          for (const filePath of possiblePaths) {
            if (filePath === standardPath) continue; // Bereits versucht
            try {
              console.log(`🔍 Lade Feedback-Daten von GitHub (Branch: ${repo.branch}): ${filePath}`);
              // Nutze API direkt mit Branch-Name (zuverlässiger als 'HEAD')
              const { data } = await client.repos.getContent({
                owner: repo.owner,
                repo: repo.repo,
                path: filePath,
                ref: repo.branch // Branch-Name statt 'HEAD' (z.B. 'main')
              });
              if (data.encoding === 'base64' && data.content) {
                content = Buffer.from(data.content, 'base64').toString('utf8');
                usedPath = filePath;
                console.log(`✅ Feedback-Daten von GitHub geladen (Branch: ${repo.branch}): ${filePath}`);
                break;
              } else if (data.download_url) {
                // 🚨 ROOT CAUSE FIX: Wenn Datei zu groß, lade über download_url
                console.log(`📥 Datei zu groß für direkten Content, lade über download_url: ${data.download_url}`);
                const https = require('https');
                const http = require('http');
                const url = require('url');
                const urlObj = url.parse(data.download_url);
                const clientModule = urlObj.protocol === 'https:' ? https : http;
                
                content = await new Promise((resolve, reject) => {
                  const req = clientModule.get(data.download_url, (res) => {
                    if (res.statusCode !== 200) {
                      reject(new Error(`HTTP ${res.statusCode}`));
                      return;
                    }
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve(body));
                  });
                  req.on('error', reject);
                  req.setTimeout(10000, () => {
                    req.destroy();
                    reject(new Error('Download timeout'));
                  });
                });
                
                usedPath = filePath;
                console.log(`✅ Feedback-Daten von GitHub geladen (via download_url, Branch: ${repo.branch}): ${filePath}`);
                break;
              }
            } catch (err) {
              if (err.status === 404) {
                console.log(`⚠️ Datei nicht gefunden auf GitHub (Branch: ${repo.branch}): ${filePath}`);
                continue;
              }
              console.error(`❌ Fehler beim Laden von GitHub (${filePath}, Branch: ${repo.branch}):`, err.message);
              console.error(`❌ Error Details:`, err.status, err.response?.data || '');
            }
          }
        }
        
        if (content) {
          try {
            const parsed = JSON.parse(content);
            const feedbackCount = Array.isArray(parsed.feedbacks) ? parsed.feedbacks.length : 0;
            console.log(`✅ Feedback-Daten geparst: ${feedbackCount} Feedbacks gefunden`);

            // Speichere auch lokal als Backup (GitHub ist Hauptquelle)
            const configDir = path.dirname(feedbackPath);
            if (!fs.existsSync(configDir)) {
              fs.mkdirSync(configDir, { recursive: true });
            }
            fs.writeFileSync(feedbackPath, content);
            console.log(`✅ Feedback-Daten lokal gespeichert als Backup: ${feedbackPath}`);

            if (feedbackCount > 0) {
              // 🚨 FIX: Debug-Logging für ASA-Feedbacks
              const asaCount = parsed.feedbacks?.filter(f => f.isASA).length || 0;
              const nonAsaCount = feedbackCount - asaCount;
              console.log(`✅ Feedback-Daten geladen: ${feedbackCount} total (${asaCount} ASA, ${nonAsaCount} normale)`);
              return parsed;
            } else {
              console.warn('⚠️ Feedback-Daten von GitHub sind leer (0 Feedbacks), nutze lokale Datei als Fallback');
            }
          } catch (parseErr) {
            console.error('❌ Fehler beim Parsen der Feedback-Daten von GitHub:', parseErr.message);
            console.error('❌ Content-Länge:', content ? content.length : 0);
          }
        } else {
          console.warn('⚠️ Keine Feedback-Daten von GitHub gefunden (alle Pfade versucht)');
        }
      }
    } catch (err) {
      console.error('❌ Fehler beim Laden der Feedback-Daten von GitHub:', err.message);
      console.error('❌ Stack:', err.stack);
    }
  } else {
    console.warn('⚠️ GitHub Client nicht verfügbar - gebe leeres Array zurück (KEIN Fallback auf lokale Datei)');
  }

  // 🚨 ROOT CAUSE FIX: KEIN Fallback auf lokale Datei - GitHub MUSS funktionieren!
  // Wenn GitHub fehlschlägt, ist das ein kritisches Problem, das behoben werden muss
  console.error('❌❌❌ KRITISCH: Keine Feedback-Daten von GitHub gefunden!');
  console.error('❌ Alle Pfade versucht:', possiblePaths.join(', '));
  console.error('❌ Repo:', `${repo.owner}/${repo.repo}`, 'Branch:', repo.branch);
  console.error('❌ Bitte prüfe:');
  console.error('   1. Existiert die Datei auf GitHub?');
  console.error('   2. Ist der Pfad korrekt?');
  console.error('   3. Ist der Branch korrekt?');
  console.error('   4. Hat der GitHub-Token die richtigen Permissions?');
  
  // Gebe leeres Array zurück - KEIN Fallback!
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
  
  // 🚨🚨🚨 KRITISCH: Pushe IMMER auf GitHub ZUERST (bevor lokal gespeichert wird ist schon passiert)
  // GitHub ist die HAUPTQUELLE - das Dashboard lädt von dort!
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const { pushFileToGitHub } = require("../utils/github");
      
      // 🚨 ROOT CAUSE FIX: Verwende IMMER den Standard-Pfad (server/src/config/feedback.json)
      // Dieser Pfad wird auch beim Laden verwendet - Konsistenz ist wichtig!
      const standardPath = 'server/src/config/feedback.json';
      
      // Parse content, um Feedback-Count zu loggen
      let feedbackCount = 0;
      let asaCount = 0;
      try {
        const parsed = JSON.parse(content);
        feedbackCount = Array.isArray(parsed.feedbacks) ? parsed.feedbacks.length : 0;
        asaCount = parsed.feedbacks?.filter(f => f.isASA).length || 0;
      } catch (e) {
        // Ignoriere Parse-Fehler
      }
      
      console.log(`🚀 Pushe Feedback-Daten auf GitHub: ${standardPath} (${feedbackCount} Feedbacks, ${asaCount} ASA)`);
      await pushFileToGitHub(standardPath, content, 'Update feedback data via Dashboard');
      console.log(`✅ Feedback-Daten erfolgreich auf GitHub gepusht: ${standardPath} (${feedbackCount} Feedbacks, ${asaCount} ASA)`);
      
      // Sofort nach Speichern: Cache setzen, damit das Dashboard beim nächsten GET die aktuellen
      // Daten bekommt (GitHub-API liefert oft noch alte Daten).
      try {
        const parsed = JSON.parse(content);
        lastSavedFeedbackCache = { data: parsed, savedAt: Date.now() };
      } catch (e) { /* ignore */ }
      
      // 🚨 ROOT CAUSE FIX: Cache wird in pushFileToGitHub invalidiert, aber wir loggen nochmal
      const { invalidateGitHubCache } = require("../utils/github");
      invalidateGitHubCache(standardPath);
      console.log(`✅ GitHub-Cache invalidiert für: ${standardPath}`);
    } catch (err) {
      console.error('❌❌❌ KRITISCHER FEHLER: Konnte Feedback-Daten nicht auf GitHub pushen:', err.message);
      console.error('❌ Stack:', err.stack);
      // 🚨 WICHTIG: Fehler werfen, damit reply.js 500 bekommt und ggf. Retry auslöst – Feedbacks sollen auf GitHub landen
      throw err;
    }
  } else {
    console.warn('⚠️ GitHub Client nicht verfügbar - Feedback-Daten werden nur lokal gespeichert (Dashboard kann sie nicht laden!)');
    throw new Error('GitHub Client nicht verfügbar – Feedback konnte nicht auf GitHub gespeichert werden');
  }
}

// Auto-Feedback: Steuert nur, ob reply.js neue Einträge anhängt. Bestehende feedback.json wird nie gelöscht.
const AUTO_FEEDBACK_SETTINGS_GITHUB_PATH = 'server/src/config/auto-feedback-settings.json';
let autoFeedbackSettingsMemCache = { data: null, at: 0 };
const AUTO_FEEDBACK_SETTINGS_CACHE_MS = 15000;

async function getAutoFeedbackSettings() {
  if (autoFeedbackSettingsMemCache.data != null && (Date.now() - autoFeedbackSettingsMemCache.at) < AUTO_FEEDBACK_SETTINGS_CACHE_MS) {
    return autoFeedbackSettingsMemCache.data;
  }
  const localPath = path.join(__dirname, '../config/auto-feedback-settings.json');
  const defaultSettings = { saveAutoFeedback: true };
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const { data } = await githubClient.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path: AUTO_FEEDBACK_SETTINGS_GITHUB_PATH,
        ref: repo.branch
      });
      if (data.encoding === 'base64' && data.content) {
        const parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
        const out = { saveAutoFeedback: parsed.saveAutoFeedback !== false };
        autoFeedbackSettingsMemCache = { data: out, at: Date.now() };
        try {
          const configDir = path.dirname(localPath);
          if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(localPath, JSON.stringify(out, null, 2));
        } catch (e) { /* ignore */ }
        return out;
      }
    } catch (e) {
      if (e.status !== 404) console.warn('⚠️ [Dashboard] auto-feedback-settings von GitHub:', e.message);
    }
  }
  try {
    if (fs.existsSync(localPath)) {
      const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      const out = { saveAutoFeedback: parsed.saveAutoFeedback !== false };
      autoFeedbackSettingsMemCache = { data: out, at: Date.now() };
      return out;
    }
  } catch (e) {
    console.warn('⚠️ [Dashboard] auto-feedback-settings lokal:', e.message);
  }
  autoFeedbackSettingsMemCache = { data: defaultSettings, at: Date.now() };
  return defaultSettings;
}

async function saveAutoFeedbackSettings(data) {
  const out = { saveAutoFeedback: Boolean(data.saveAutoFeedback) };
  const content = JSON.stringify(out, null, 2);
  const localPath = path.join(__dirname, '../config/auto-feedback-settings.json');
  const configDir = path.dirname(localPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(localPath, content);
  autoFeedbackSettingsMemCache = { data: out, at: Date.now() };
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const { pushFileToGitHub } = require('../utils/github');
      const { invalidateGitHubCache } = require('../utils/github');
      await pushFileToGitHub(AUTO_FEEDBACK_SETTINGS_GITHUB_PATH, content, 'Dashboard: Auto-Feedback-Einstellung');
      invalidateGitHubCache(AUTO_FEEDBACK_SETTINGS_GITHUB_PATH);
    } catch (e) {
      console.warn('⚠️ Auto-Feedback-Einstellung nur lokal gespeichert (GitHub:', e.message, ')');
    }
  }
  return out;
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
    const { customerMessage, moderatorResponse, situation, isNegativeExample, feedbackId } = req.body;
    if (!customerMessage || !moderatorResponse) {
      return res.status(400).json({ error: 'Kunden-Nachricht und Moderator-Antwort sind erforderlich' });
    }

    // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
    let finalSituation = 'allgemein';
    let situationsArray = ['allgemein'];
    
    if (Array.isArray(situation) && situation.length > 0) {
      finalSituation = situation.length === 1 ? situation[0] : situation.join(', ');
      situationsArray = situation;
    } else if (typeof situation === 'string' && situation.trim() !== '') {
      finalSituation = situation;
      // Prüfe, ob es mehrere Situationen mit Komma-Trennung sind
      if (situation.includes(',')) {
        situationsArray = situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
      } else {
        situationsArray = [situation];
      }
    }

    const data = await getTrainingData();
    data.conversations = data.conversations || [];
    const newConversation = {
      customerMessage,
      moderatorResponse,
      situation: finalSituation,
      situations: situationsArray, // 🚨 NEU: Array für bessere Verarbeitung
      isNegativeExample: Boolean(isNegativeExample || false), // 🚨 NEU: Negative Beispiele
      createdAt: new Date().toISOString()
    };
    
    // 🆕 NEU: Wenn feedbackId vorhanden ist, speichere Referenz und aktualisiere Feedback-Status
    if (feedbackId) {
      newConversation.feedbackId = feedbackId;
      newConversation.source = 'feedback_direct'; // Markierung, dass es direkt aus Feedback hinzugefügt wurde
      
      // Aktualisiere Feedback-Status auf "edited", da es zu Training-Daten hinzugefügt wurde
      const feedbackData = await getFeedbackData();
      const feedbackIndex = feedbackData.feedbacks.findIndex(f => f.id === feedbackId);
      if (feedbackIndex !== -1) {
        if (feedbackData.feedbacks[feedbackIndex].status === 'pending') {
          feedbackData.feedbacks[feedbackIndex].status = 'edited';
          feedbackData.feedbacks[feedbackIndex].editedResponse = moderatorResponse; // Setze bearbeitete Antwort
          feedbackData.feedbacks[feedbackIndex].updatedAt = new Date().toISOString();
          await saveFeedbackData(feedbackData);
          console.log(`✅ Feedback-Status aktualisiert: pending → edited (Feedback-ID: ${feedbackId})`);
        }
      } else {
        console.warn(`⚠️ Feedback mit ID ${feedbackId} nicht gefunden beim Hinzufügen zu Training-Daten`);
      }
    }
    
    data.conversations.push(newConversation);
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

// PUT /api/v1/training-data/:index - Aktualisiere vollständig ein Gespräch (Nachricht, Antwort, Situation(en))
router.put('/training-data/:index', async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const { customerMessage, moderatorResponse, situation, isNegativeExample } = req.body;
    
    const data = await getTrainingData();
    if (!data.conversations || !data.conversations[index]) {
      return res.status(404).json({ error: 'Gespräch nicht gefunden' });
    }
    
    // 🚨 FIX: Speichere alte Situation VOR Änderungen (für Vergleich später)
    const conversation = data.conversations[index];
    const oldSituationBeforeChange = conversation.situation || 'allgemein';
    
    // 🚨 NEU: Vollständige Bearbeitung - alle Felder können aktualisiert werden
    if (customerMessage !== undefined) {
      data.conversations[index].customerMessage = customerMessage;
    }
    if (moderatorResponse !== undefined) {
      data.conversations[index].moderatorResponse = moderatorResponse;
    }
    if (isNegativeExample !== undefined) {
      data.conversations[index].isNegativeExample = Boolean(isNegativeExample);
    }
    
    // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
    let finalSituation = 'allgemein';
    let situationsArray = ['allgemein'];
    
    // 🚨 FIX: Setze finalSituation IMMER (auch wenn situation nicht geändert wird)
    if (situation !== undefined) {
      if (Array.isArray(situation) && situation.length > 0) {
        finalSituation = situation.length === 1 ? situation[0] : situation.join(', ');
        situationsArray = situation;
      } else if (typeof situation === 'string' && situation.trim() !== '') {
        finalSituation = situation;
        // Prüfe, ob es mehrere Situationen mit Komma-Trennung sind
        if (situation.includes(',')) {
          situationsArray = situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
        } else {
          situationsArray = [situation];
        }
      }
      
      // 🚨 WICHTIG: Speichere sowohl String (für Kompatibilität) als auch Array (für bessere Verarbeitung)
      data.conversations[index].situation = finalSituation;
      data.conversations[index].situations = situationsArray; // 🚨 NEU: Array für bessere Verarbeitung
    } else {
      // 🚨 FIX: Wenn situation nicht geändert wird, nutze die aktuelle Situation
      const conversation = data.conversations[index];
      if (conversation.situation) {
        finalSituation = conversation.situation;
        if (conversation.situations && Array.isArray(conversation.situations)) {
          situationsArray = conversation.situations;
        } else if (typeof finalSituation === 'string' && finalSituation.includes(',')) {
          situationsArray = finalSituation.split(',').map(s => s.trim()).filter(s => s.length > 0);
        } else {
          situationsArray = [finalSituation];
        }
      }
    }
    
    data.conversations[index].updatedAt = new Date().toISOString();
    
    // 🚨 NEU: Synchronisiere Situation zurück zum Feedback (falls vorhanden)
    // 🚨 FIX: conversation ist bereits oben definiert (vor Änderungen)
    let feedbackUpdated = false;
    
    try {
      const feedbackData = await getFeedbackData();
      
      // Methode 1: Suche über feedbackId (wenn vorhanden)
      if (conversation.feedbackId) {
        const feedbackIndex = feedbackData.feedbacks.findIndex(f => f.id === conversation.feedbackId);
        if (feedbackIndex !== -1) {
          const feedback = feedbackData.feedbacks[feedbackIndex];
          const oldSituation = feedback.situation || feedback.context?.detectedSituations?.[0] || 'keine'; // Speichere alte Situation (auch aus context, falls vorhanden)
          
          // Aktualisiere Situation im Feedback
          feedback.situation = finalSituation;
          feedback.situations = situationsArray;
          feedback.updatedAt = new Date().toISOString();
          feedbackUpdated = true;
          console.log(`✅ Situation im Feedback synchronisiert (via feedbackId: ${conversation.feedbackId}, Situation: ${oldSituation} → ${finalSituation})`);
          
          // 🚨 NEU: Analysiere Learning-Stats IMMER neu (auch wenn Situation gleich bleibt)
          // Das stellt sicher, dass Learning-Stats mit der korrigierten Situation synchronisiert ist
          if (feedback.status === 'good' || feedback.status === 'edited') {
            try {
              const { analyzeFeedback } = require('../utils/learning-system');
              const situationChanged = oldSituation !== finalSituation && oldSituation !== finalSituation.split(',')[0];
              if (situationChanged) {
                console.log(`🔄 Analysiere Learning-Stats neu mit korrigierter Situation (${oldSituation} → ${finalSituation})...`);
              } else {
                console.log(`🔄 Aktualisiere Learning-Stats mit aktueller Situation (${finalSituation})...`);
              }
              
              // Analysiere Feedback neu mit korrigierter Situation
              await analyzeFeedback({
                customerMessage: feedback.customerMessage,
                aiResponse: feedback.aiResponse,
                editedResponse: feedback.editedResponse || null,
                status: feedback.status,
                situation: finalSituation, // 🚨 NEU: Verwende korrigierte Situation
                reasoning: feedback.reasoning || null
              }, true); // Push auf GitHub
              
              console.log(`✅ Learning-Stats aktualisiert (${finalSituation})`);
            } catch (err) {
              console.warn('⚠️ Fehler beim Neu-Analysieren der Learning-Stats:', err.message);
              // Nicht kritisch - weiter machen
            }
          }
        } else {
          console.warn(`⚠️ Feedback mit ID ${conversation.feedbackId} nicht gefunden`);
        }
      }
      
      // 🚨 NEU: Methode 2: Suche über Kundennachricht (falls keine feedbackId vorhanden)
      // Finde Feedback-Einträge, die zur gleichen Kundennachricht gehören
      if (!feedbackUpdated && conversation.customerMessage) {
        const matchingFeedbacks = feedbackData.feedbacks.filter(f => {
          // Prüfe auf exakte Übereinstimmung oder sehr hohe Ähnlichkeit
          const feedbackMsg = (f.customerMessage || '').trim();
          const trainingMsg = (conversation.customerMessage || '').trim();
          
          // Exakte Übereinstimmung
          if (feedbackMsg === trainingMsg) return true;
          
          // Sehr hohe Ähnlichkeit (>90% gleiche Wörter)
          const feedbackWords = feedbackMsg.toLowerCase().split(/\s+/);
          const trainingWords = trainingMsg.toLowerCase().split(/\s+/);
          const commonWords = feedbackWords.filter(w => trainingWords.includes(w));
          const similarity = commonWords.length / Math.max(feedbackWords.length, trainingWords.length);
          if (similarity > 0.9) return true;
          
          return false;
        });
        
        // Aktualisiere alle passenden Feedback-Einträge
        for (const feedback of matchingFeedbacks) {
          const oldSituation = feedback.situation || feedback.context?.detectedSituations?.[0] || 'keine'; // Speichere alte Situation (auch aus context, falls vorhanden)
          
          // Aktualisiere Situation im Feedback
          feedback.situation = finalSituation;
          feedback.situations = situationsArray;
          feedback.updatedAt = new Date().toISOString();
          feedbackUpdated = true;
          console.log(`✅ Situation im Feedback synchronisiert (via Kundennachricht-Matching: ${feedback.id}, Situation: ${oldSituation} → ${finalSituation})`);
          
          // 🚨 NEU: Analysiere Learning-Stats IMMER neu (auch wenn Situation gleich bleibt)
          // Das stellt sicher, dass Learning-Stats mit der korrigierten Situation synchronisiert ist
          if (feedback.status === 'good' || feedback.status === 'edited') {
            try {
              const { analyzeFeedback } = require('../utils/learning-system');
              const situationChanged = oldSituation !== finalSituation && oldSituation !== finalSituation.split(',')[0];
              if (situationChanged) {
                console.log(`🔄 Analysiere Learning-Stats neu mit korrigierter Situation (${oldSituation} → ${finalSituation})...`);
              } else {
                console.log(`🔄 Aktualisiere Learning-Stats mit aktueller Situation (${finalSituation})...`);
              }
              
              // Analysiere Feedback neu mit korrigierter Situation
              await analyzeFeedback({
                customerMessage: feedback.customerMessage,
                aiResponse: feedback.aiResponse,
                editedResponse: feedback.editedResponse || null,
                status: feedback.status,
                situation: finalSituation, // 🚨 NEU: Verwende korrigierte Situation
                reasoning: feedback.reasoning || null
              }, true); // Push auf GitHub
              
              console.log(`✅ Learning-Stats aktualisiert (${finalSituation})`);
            } catch (err) {
              console.warn('⚠️ Fehler beim Neu-Analysieren der Learning-Stats:', err.message);
              // Nicht kritisch - weiter machen
            }
          }
        }
      }
      
      // Speichere Feedback-Daten, wenn Änderungen vorgenommen wurden
      if (feedbackUpdated) {
        await saveFeedbackData(feedbackData);
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Synchronisieren der Situation zum Feedback:', err.message);
      // Nicht kritisch - weiter machen
    }
    
    // 🚨 NEU: Direktes Lernen aus Training-Daten (auch wenn kein Feedback vorhanden ist)
    // Analysiere Training-Daten IMMER für Learning-Stats (auch wenn Situation gleich bleibt)
    // 🚨 FIX: Prüfe auf finalSituation statt situation, damit es auch funktioniert, wenn Situation nicht geändert wird
    if (finalSituation && conversation.customerMessage && conversation.moderatorResponse) {
      try {
        const { analyzeFeedback } = require('../utils/learning-system');
        // 🚨 FIX: Nutze oldSituationBeforeChange (die Situation VOR der Änderung)
        const situationChanged = oldSituationBeforeChange !== finalSituation;
        
        if (situationChanged) {
          console.log(`🔄 Analysiere Training-Daten direkt für Learning-Stats (Situation: ${oldSituationBeforeChange} → ${finalSituation})...`);
        } else {
          console.log(`🔄 Aktualisiere Learning-Stats mit Training-Daten (Situation: ${finalSituation})...`);
        }
        
        // Analysiere Training-Daten direkt (als positives Beispiel)
        // 🚨 WICHTIG: IMMER analysieren, auch wenn Situation gleich bleibt (für Konsistenz)
        await analyzeFeedback({
          customerMessage: conversation.customerMessage,
          aiResponse: conversation.moderatorResponse,
          editedResponse: null,
          status: 'good', // Training-Daten sind positives Beispiel
          situation: finalSituation, // Verwende korrigierte/aktuelle Situation
          reasoning: conversation.explanation || null
        }, true); // Push auf GitHub
        
        console.log(`✅ Learning-Stats direkt aus Training-Daten aktualisiert (${finalSituation})`);
      } catch (err) {
        console.warn('⚠️ Fehler beim direkten Lernen aus Training-Daten:', err.message);
        // Nicht kritisch - weiter machen
      }
    }
    
    await saveTrainingData(data);
    res.json({ success: true, conversation: data.conversations[index] });
  } catch (error) {
    console.error('Fehler beim Aktualisieren des Gesprächs:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren des Gesprächs' });
  }
});

// ==========================================
// KEYWORD-MANAGEMENT-SYSTEM
// ==========================================

// GET /api/v1/keywords - Lade alle Keywords für Situationen
router.get('/keywords', async (req, res) => {
  try {
    const rules = await getRules();
    const keywords = {};
    
    // Extrahiere Keywords aus situationalResponses
    if (rules && rules.situationalResponses) {
      for (const [situationName, situationResponse] of Object.entries(rules.situationalResponses)) {
        keywords[situationName] = {
          situation: situationName,
          keywords: [], // Wird später aus einer separaten Datei geladen
          description: typeof situationResponse === 'string' ? situationResponse.substring(0, 200) : ''
        };
      }
    }
    
    // Lade Keywords aus einer separaten Datei (falls vorhanden)
    // TODO: Implementiere separate Keywords-Datei für bessere Verwaltung
    res.json({ keywords, success: true });
  } catch (error) {
    console.error('Fehler beim Laden der Keywords:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Keywords' });
  }
});

// POST /api/v1/keywords - Füge Keywords für eine Situation hinzu
router.post('/keywords', async (req, res) => {
  try {
    const { situation, keywords } = req.body;
    
    if (!situation || !keywords || !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'Situation und Keywords (Array) sind erforderlich' });
    }
    
    // Lade Regeln
    const rules = await getRules();
    
    // Erweitere situationalResponses mit Keywords (falls noch nicht vorhanden)
    if (!rules.situationalResponses) {
      rules.situationalResponses = {};
    }
    
    // Speichere Keywords in einer separaten Struktur
    // TODO: Implementiere separate Keywords-Datei für bessere Verwaltung
    // Für jetzt: Speichere in rules.json als Metadaten
    
    await saveRules(rules);
    res.json({ success: true, situation, keywords });
  } catch (error) {
    console.error('Fehler beim Hinzufügen der Keywords:', error);
    res.status(500).json({ error: 'Fehler beim Hinzufügen der Keywords' });
  }
});

// PUT /api/v1/keywords/:situation - Aktualisiere Keywords für eine Situation
router.put('/keywords/:situation', async (req, res) => {
  try {
    const { situation } = req.params;
    const { keywords } = req.body;
    
    if (!keywords || !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'Keywords (Array) sind erforderlich' });
    }
    
    // Lade Regeln
    const rules = await getRules();
    
    // Aktualisiere Keywords
    // TODO: Implementiere separate Keywords-Datei für bessere Verwaltung
    
    await saveRules(rules);
    res.json({ success: true, situation, keywords });
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Keywords:', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren der Keywords' });
  }
});

// DELETE /api/v1/keywords/:situation/:keyword - Lösche ein Keyword für eine Situation
router.delete('/keywords/:situation/:keyword', async (req, res) => {
  try {
    const { situation, keyword } = req.params;
    
    // Lade Regeln
    const rules = await getRules();
    
    // Lösche Keyword
    // TODO: Implementiere separate Keywords-Datei für bessere Verwaltung
    
    await saveRules(rules);
    res.json({ success: true, situation, deletedKeyword: keyword });
  } catch (error) {
    console.error('Fehler beim Löschen des Keywords:', error);
    res.status(500).json({ error: 'Fehler beim Löschen des Keywords' });
  }
});

// 🚨 NEU: GET /api/v1/keywords/suggestions - Hole Keyword-Vorschläge basierend auf Feedback
router.get('/keywords/suggestions', async (req, res) => {
  try {
    const feedbackData = await getFeedbackData();
    const rules = await getRules();
    
    // Analysiere Feedback für Keyword-Vorschläge
    const suggestions = [];
    
    if (feedbackData && feedbackData.feedbacks && feedbackData.feedbacks.length > 0) {
      // Analysiere Feedbacks, die bearbeitet wurden (edited) - diese zeigen, was nicht erkannt wurde
      const editedFeedbacks = feedbackData.feedbacks.filter(f => f.status === 'edited' && f.reasoning);
      
      for (const feedback of editedFeedbacks) {
        const customerMessage = feedback.customerMessage || '';
        const lowerMessage = customerMessage.toLowerCase();
        
        // Erkenne Situation automatisch
        const detectedSituation = detectSituationFromMessage(customerMessage);
        
        // Extrahiere potenzielle Keywords aus der Kundennachricht
        const potentialKeywords = extractPotentialKeywords(customerMessage);
        
        // Prüfe, ob diese Keywords bereits für diese Situation existieren
        const existingKeywords = getKeywordsForSituation(detectedSituation, rules);
        
        // Filtere neue Keywords (die noch nicht existieren)
        const newKeywords = potentialKeywords.filter(kw => 
          !existingKeywords.some(ek => ek.toLowerCase() === kw.toLowerCase())
        );
        
        if (newKeywords.length > 0) {
          suggestions.push({
            situation: detectedSituation,
            keywords: newKeywords,
            customerMessage: customerMessage.substring(0, 100),
            reasoning: feedback.reasoning ? feedback.reasoning.substring(0, 200) : null,
            feedbackId: feedback.id
          });
        }
      }
    }
    
    // Gruppiere Vorschläge nach Situation
    const groupedSuggestions = {};
    suggestions.forEach(suggestion => {
      if (!groupedSuggestions[suggestion.situation]) {
        groupedSuggestions[suggestion.situation] = [];
      }
      groupedSuggestions[suggestion.situation].push(suggestion);
    });
    
    res.json({ success: true, suggestions: groupedSuggestions });
  } catch (error) {
    console.error('Fehler beim Generieren der Keyword-Vorschläge:', error);
    res.status(500).json({ error: 'Fehler beim Generieren der Keyword-Vorschläge' });
  }
});

// 🚨 NEU: Helper: Extrahiere potenzielle Keywords aus einer Nachricht
function extractPotentialKeywords(message) {
  if (!message || typeof message !== 'string') return [];
  
  const lower = message.toLowerCase();
  const keywords = [];
  
  // Erkenne häufige Phrasen, die als Keywords dienen könnten
  const keywordPatterns = [
    /wie.*(du|ihr).*(auf|in|bei|unterwegs|draußen|gehst|geht|läufst|lauft|aussiehst|ausseht)/i,
    /(würdest|würdet|kannst|könntest|könntet).*(mir).*(zeigen|schicken|schickst|schickt)/i,
    /(zeig|zeige|schick|schicke).*(mir).*(wie|wie du|wie ihr)/i,
    /(wann|wann hast|wann hättest).*(zeit|möglichkeit|gelegenheit)/i,
    /(hoffe|will|würde gerne|habe zeit).*(treffen|sehen|kennenlernen)/i
  ];
  
  keywordPatterns.forEach(pattern => {
    const match = message.match(pattern);
    if (match) {
      // Extrahiere relevante Teile als Keyword
      const keyword = match[0].substring(0, 50).trim();
      if (keyword.length > 5 && keyword.length < 50) {
        keywords.push(keyword);
      }
    }
  });
  
  // Extrahiere auch einzelne relevante Wörter
  const relevantWords = lower.match(/\b(wie|wann|wo|was|warum|würdest|kannst|zeig|schick|treffen|zeit|möglichkeit|gelegenheit|aussiehst|gehst|unterwegs|draußen)\b/g);
  if (relevantWords) {
    relevantWords.forEach(word => {
      if (!keywords.includes(word)) {
        keywords.push(word);
      }
    });
  }
  
  return keywords.slice(0, 10); // Maximal 10 Keywords pro Nachricht
}

// 🚨 NEU: Helper: Hole Keywords für eine Situation aus Regeln
function getKeywordsForSituation(situation, rules) {
  if (!rules || !rules.situationalResponses || !rules.situationalResponses[situation]) {
    return [];
  }
  
  // TODO: Wenn Keywords in separater Datei gespeichert werden, hole sie von dort
  // Für jetzt: Extrahiere Keywords aus dem Situationsnamen
  const situationLower = situation.toLowerCase();
  const keywords = situationLower.split(/[\s\-_\/]+/).filter(kw => kw.length > 2);
  
  return keywords;
}

// 🚨 NEU: Helper: Erkenne Situation aus Nachricht (vereinfacht)
function detectSituationFromMessage(message) {
  if (!message || typeof message !== 'string') return 'allgemein';
  
  const lower = message.toLowerCase();
  
  if (lower.includes('treffen') || lower.includes('sehen') || lower.includes('kennenlernen') || lower.includes('date')) {
    return 'Treffen/Termine';
  }
  if (lower.includes('bild') || lower.includes('foto') || lower.includes('photo') || lower.includes('zeig') || lower.includes('schick')) {
    return 'Bilder Anfrage';
  }
  if (lower.includes('nummer') || lower.includes('whatsapp') || lower.includes('telegram') || lower.includes('instagram')) {
    return 'Kontaktdaten außerhalb der Plattform';
  }
  if (lower.includes('geld') || lower.includes('coin') || lower.includes('credit')) {
    return 'Geld/Coins';
  }
  
  return 'allgemein';
}

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

    // 🚀 NEU: Verwende Multi-Stage-Pipeline (wie in reply.js) - nutzt automatisch Together.ai wenn aktiviert!
    console.log("🚀 [Dashboard] Verwende Multi-Stage-Pipeline für Test-Chat (Together.ai wird automatisch verwendet wenn aktiviert)");
    
    // Baue conversationHistory für Pipeline
    const conversationHistoryForPipeline = conversationHistory && Array.isArray(conversationHistory) 
      ? conversationHistory
        .filter(msg => {
          const text = msg.text || msg.content || msg.message || "";
          const type = msg.type || msg.role || (msg.sender === 'Du' || msg.sender === 'KI' ? (msg.sender === 'Du' ? 'user' : 'assistant') : null);
          return text.trim() !== "" && type;
        })
        .map(msg => {
          const text = msg.text || msg.content || msg.message || "";
          const type = msg.type || msg.role || (msg.sender === 'Du' || msg.sender === 'KI' ? (msg.sender === 'Du' ? 'user' : 'assistant') : null);
          return {
            role: (type === 'user' || type === 'Kunde' || msg.sender === 'Du') ? 'user' : 'assistant',
            content: text.trim()
          };
        })
        .slice(-10) // Letzte 10 Nachrichten
        .map(m => `${m.role === 'user' ? 'Kunde' : 'Moderator'}: ${m.content}`)
        .join('\n')
      : '';
    
    // Erkenne Situationen für Pipeline
    let detectedSituation = null;
    if (rules && rules.situationalResponses) {
      for (const [situationName] of Object.entries(rules.situationalResponses)) {
        const situationLower = situationName.toLowerCase();
        if (isBotAccusation && (situationLower.includes("bot") || situationLower.includes("vorwurf"))) {
          detectedSituation = situationName;
          break;
        }
        if (isSexualTopic && situationLower.includes("sexuell")) {
          detectedSituation = situationName;
          break;
        }
        if (isJobQuestion && (situationLower.includes("beruf") || situationLower.includes("job"))) {
          detectedSituation = situationName;
          break;
        }
        if (isMeetingRequest && (situationLower.includes("treffen") || situationLower.includes("termin"))) {
          detectedSituation = situationName;
          break;
        }
        if (touchesMoney && (situationLower.includes("geld") || situationLower.includes("coin"))) {
          detectedSituation = situationName;
          break;
        }
      }
    }
    
    // Lade Feedback-Daten (für Pipeline)
    let feedbackData = null;
    try {
      const { getFeedbackData } = require('./dashboard');
      const feedbackResult = await getFeedbackData();
      if (feedbackResult && feedbackResult.data) {
        feedbackData = feedbackResult.data;
      }
    } catch (err) {
      console.warn('⚠️ [Dashboard] Fehler beim Laden der Feedback-Daten (optional):', err.message);
    }
    
    // Initialisiere Vector-DB (für Pipeline)
    const { initializeVectorDb } = require("../utils/vector-db");
    let vectorDbFunc = null;
    try {
      vectorDbFunc = await initializeVectorDb(trainingData);
    } catch (err) {
      console.warn('⚠️ [Dashboard] Fehler beim Initialisieren der Vector-DB (optional):', err.message);
    }
    
    // Baue profileInfo für Pipeline
    const profileInfoForPipeline = {
      customerInfo: {},
      moderatorInfo: {}
    };
    
    // Baue extractedUserInfo (vereinfacht für Test-Chat)
    const extractedUserInfo = {};
    
    // Rufe Multi-Stage-Pipeline auf (nutzt automatisch Together.ai wenn USE_TOGETHER_AI=true)
    let multiAgentResults;
    try {
      multiAgentResults = await runMultiStagePipeline({
        conversationHistory: conversationHistoryForPipeline,
        customerMessage: message,
        profileInfo: profileInfoForPipeline,
        extractedUserInfo: extractedUserInfo,
        allRules: rules,
        trainingData: trainingData,
        situations: detectedSituation ? [detectedSituation] : [],
        imageUrl: null,
        imageType: null,
        imageDescription: null,
        moderatorMessages: [],
        customerMessages: [],
        allMessages: [],
        feedbackData: feedbackData,
        vectorDbFunc: vectorDbFunc,
        isASA: false,
        asaConversationContext: '',
        isMeetingRequestFunc: (msg, context) => {
          const lower = (msg || context || '').toLowerCase();
          return lower.includes("treffen") || lower.includes("besuchen") || lower.includes("vorbeikommen");
        },
        isLocationQuestionFunc: (msg) => false,
        findNearbyCityFunc: (city) => null
      });
    } catch (pipelineError) {
      console.error('❌ [Dashboard] Fehler in Multi-Stage-Pipeline:', pipelineError);
      throw new Error(`Pipeline-Fehler: ${pipelineError.message}`);
    }
    
    // Prüfe ob Pipeline blockiert wurde
    if (multiAgentResults && multiAgentResults.blocked) {
      return res.status(200).json({
        reply: multiAgentResults.error || multiAgentResults.safety?.errorMessage || "❌ Nachricht wurde blockiert."
      });
    }
    
    // Extrahiere generierte Nachricht
    let reply = multiAgentResults?.finalMessage || "Keine Antwort generiert";
    
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
    // 🚨🚨🚨 NEU: Retry-Mechanismus für Feedback-Laden (3 Versuche mit 2s Delay)
    // Problem: Race Condition - Dashboard lädt bevor GitHub aktualisiert ist
    let data = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000; // 2 Sekunden
    
    while (retryCount < MAX_RETRIES && !data) {
      try {
        data = await getFeedbackData();
        
        // Prüfe ob Daten gültig sind
        if (data && Array.isArray(data.feedbacks) && data.feedbacks.length > 0) {
          console.log(`✅ Feedback-Daten erfolgreich geladen: ${data.feedbacks.length} Feedbacks (Versuch ${retryCount + 1}/${MAX_RETRIES})`);
          break;
        } else if (retryCount < MAX_RETRIES - 1) {
          console.warn(`⚠️ Feedback-Daten leer oder ungültig (Versuch ${retryCount + 1}/${MAX_RETRIES}) - warte ${RETRY_DELAY}ms und versuche erneut...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          retryCount++;
          
          // 🚨 NEU: Cache explizit invalidieren vor Retry
          const { invalidateGitHubCache } = require("../utils/github");
          invalidateGitHubCache('server/src/config/feedback.json');
          console.log(`🗑️ GitHub-Cache invalidiert vor Retry ${retryCount + 1}`);
        } else {
          console.warn(`⚠️ Feedback-Daten nach ${MAX_RETRIES} Versuchen leer oder ungültig - verwende leeres Array`);
          data = { feedbacks: [] };
          break;
        }
      } catch (err) {
        if (retryCount < MAX_RETRIES - 1) {
          console.warn(`⚠️ Fehler beim Laden der Feedback-Daten (Versuch ${retryCount + 1}/${MAX_RETRIES}):`, err.message);
          console.warn(`⚠️ Warte ${RETRY_DELAY}ms und versuche erneut...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          retryCount++;
          
          // 🚨 NEU: Cache explizit invalidieren vor Retry
          const { invalidateGitHubCache } = require("../utils/github");
          invalidateGitHubCache('server/src/config/feedback.json');
          console.log(`🗑️ GitHub-Cache invalidiert vor Retry ${retryCount + 1}`);
        } else {
          console.error(`❌ Fehler beim Laden der Feedback-Daten nach ${MAX_RETRIES} Versuchen:`, err.message);
          throw err;
        }
      }
    }
    
    if (!data) {
      data = { feedbacks: [] };
    }
    const feedbacks = data.feedbacks || [];
    
    // 🆕 NEU: Prüfe, ob Feedback-Einträge bereits in Training-Daten vorhanden sind, aber Status noch "pending"
    // Das kann passieren, wenn Training-Daten manuell hinzugefügt wurden oder über andere Wege
    try {
      const trainingData = await getTrainingData();
      const conversations = trainingData.conversations || [];
      const asaExamples = trainingData.asaExamples || [];
      
      let statusUpdatedCount = 0;
      
      // Prüfe alle Feedback-Einträge mit Status "pending"
      feedbacks.forEach((feedback, index) => {
        if (feedback.status === 'pending' && feedback.id) {
          // Prüfe, ob es in conversations vorhanden ist
          const foundInConversations = conversations.some(conv => conv.feedbackId === feedback.id);
          
          // Prüfe, ob es in asaExamples vorhanden ist
          const foundInASA = asaExamples.some(asa => asa.feedbackId === feedback.id);
          
          if (foundInConversations || foundInASA) {
            // Feedback wurde zu Training-Daten hinzugefügt, aber Status ist noch "pending"
            // Setze Status auf "edited" (da es bearbeitet/hinzugefügt wurde)
            const foundConv = conversations.find(conv => conv.feedbackId === feedback.id);
            feedback.status = 'edited';
            feedback.editedResponse = foundConv ? foundConv.moderatorResponse : feedback.aiResponse;
            feedback.updatedAt = new Date().toISOString();
            statusUpdatedCount++;
            console.log(`✅ Feedback-Status automatisch aktualisiert: pending → edited (Feedback-ID: ${feedback.id})`);
          }
        }
      });
      
      // Speichere aktualisierte Feedback-Daten, wenn Änderungen vorgenommen wurden
      if (statusUpdatedCount > 0) {
        await saveFeedbackData(data);
        console.log(`✅ ${statusUpdatedCount} Feedback-Status(se) automatisch aktualisiert (von pending zu edited)`);
      }
    } catch (syncErr) {
      console.warn('⚠️ Fehler beim Synchronisieren der Feedback-Status mit Training-Daten (nicht kritisch):', syncErr.message);
      // Nicht kritisch - weiter machen
    }
    
    // 🚨🚨🚨 FIX: Sortiere nach Timestamp oder createdAt oder id (neueste zuerst)
    const sortedFeedbacks = feedbacks.sort((a, b) => {
      // Priorität: timestamp > updatedAt > createdAt > id (enthält Timestamp)
      const timeA = a.timestamp 
        ? new Date(a.timestamp).getTime() 
        : (a.updatedAt 
          ? new Date(a.updatedAt).getTime() 
          : (a.createdAt 
            ? new Date(a.createdAt).getTime()
            : (a.id && a.id.includes('_') 
              ? parseInt(a.id.split('_')[1]) || 0 
              : 0)));
      
      const timeB = b.timestamp 
        ? new Date(b.timestamp).getTime() 
        : (b.updatedAt 
          ? new Date(b.updatedAt).getTime() 
          : (b.createdAt 
            ? new Date(b.createdAt).getTime()
            : (b.id && b.id.includes('_') 
              ? parseInt(b.id.split('_')[1]) || 0 
              : 0)));
      
      return timeB - timeA; // Neueste zuerst
    });
    
    // 🚨 ROOT CAUSE FIX: Verbessertes Debug-Logging für ASA-Feedbacks
    const asaFeedbacks = sortedFeedbacks.filter(f => f.isASA);
    const nonAsaFeedbacks = sortedFeedbacks.filter(f => !f.isASA);
    const pendingFeedbacks = sortedFeedbacks.filter(f => f.status === 'pending');
    const editedFeedbacks = sortedFeedbacks.filter(f => f.status === 'edited');
    const goodFeedbacks = sortedFeedbacks.filter(f => f.status === 'good');
    
    console.log(`✅ Feedbacks geladen: ${sortedFeedbacks.length} Einträge (${asaFeedbacks.length} ASA, ${nonAsaFeedbacks.length} normale) (sortiert nach neueste zuerst)`);
    console.log(`📊 Feedback-Status: ${pendingFeedbacks.length} pending, ${editedFeedbacks.length} edited, ${goodFeedbacks.length} good`);
    
    // 🚨 ROOT CAUSE FIX: Logge die letzten 5 Feedback-IDs für Debugging
    const last5Ids = sortedFeedbacks.slice(0, 5).map(f => ({ id: f.id, isASA: f.isASA, status: f.status, timestamp: f.timestamp }));
    console.log(`📊 Letzte 5 Feedbacks:`, JSON.stringify(last5Ids, null, 2));
    
    res.json({ feedbacks: sortedFeedbacks, count: sortedFeedbacks.length });
  } catch (error) {
    console.error('Fehler beim Laden der Feedback-Daten:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Feedback-Daten' });
  }
});

// GET /api/v1/auto-feedback-settings – ob neue generierte Antworten automatisch in feedback.json landen
router.get('/auto-feedback-settings', async (req, res) => {
  try {
    const settings = await getAutoFeedbackSettings();
    res.json(settings);
  } catch (error) {
    console.error('Fehler beim Laden der Auto-Feedback-Einstellung:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Einstellung' });
  }
});

// PUT /api/v1/auto-feedback-settings – nur Schalter; löscht keine bestehenden Feedbacks
router.put('/auto-feedback-settings', async (req, res) => {
  try {
    if (typeof req.body?.saveAutoFeedback !== 'boolean') {
      return res.status(400).json({ error: 'saveAutoFeedback (boolean) ist erforderlich' });
    }
    const saved = await saveAutoFeedbackSettings({ saveAutoFeedback: req.body.saveAutoFeedback });
    res.json({ success: true, ...saved });
  } catch (error) {
    console.error('Fehler beim Speichern der Auto-Feedback-Einstellung:', error);
    res.status(500).json({ error: 'Fehler beim Speichern der Einstellung' });
  }
});

// POST /api/v1/feedback - Erstelle neuen Feedback-Eintrag (wird automatisch von reply.js aufgerufen)
router.post('/feedback', async (req, res) => {
  try {
    const { chatId, customerMessage, aiResponse, platform } = req.body;
    const isASA = req.body.isASA || false;
    
    // 🚨🚨🚨 KRITISCH: Bei ASA-Fällen ist customerMessage leer oder "ASA Reaktivierung" - das ist OK!
    // Validierung anpassen: Bei ASA ist customerMessage optional (wird später auf "ASA Reaktivierung" gesetzt)
    if (!aiResponse) {
      return res.status(400).json({ error: 'KI-Antwort ist erforderlich' });
    }
    
    // Bei ASA: customerMessage ist optional (wird später auf "ASA Reaktivierung" gesetzt)
    if (!isASA && (!customerMessage || customerMessage.trim() === "")) {
      return res.status(400).json({ error: 'Kundennachricht ist erforderlich (außer bei ASA)' });
    }

    const autoSettings = await getAutoFeedbackSettings();
    if (autoSettings.saveAutoFeedback === false) {
      console.log('📊 Auto-Feedback aus (Dashboard): Kein neuer Eintrag – bestehende Feedbacks unverändert.');
      return res.json({ success: true, skipped: true, message: 'Auto-Feedback ist deaktiviert', feedback: null });
    }

    const data = await getFeedbackData();
    data.feedbacks = data.feedbacks || [];
    const feedbackEntry = {
      id: `feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      chatId: chatId || null,
      customerMessage: isASA ? "ASA Reaktivierung" : customerMessage, // 🚨 ASA: Generischer Wert, damit Learning-System nicht verwirrt wird
      aiResponse,
      editedResponse: null,
      status: 'pending', // 'pending', 'good', 'edited'
      platform: platform || 'unknown',
      isASA: isASA, // Markiere als ASA, falls vorhanden
      // 🚨 NEU: Speichere verwendete Beispiel-IDs für Performance-Tracking
      usedExampleIds: req.body.usedExampleIds || [],
      context: req.body.context || null, // Kontext-Informationen (für Anzeige und Variationen-Generator)
      lastModeratorMessage: isASA ? null : (req.body.lastModeratorMessage || req.body.context?.lastModeratorMessage || null), // 🚨 ASA: Leer, da irrelevant
      timestamp: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    data.feedbacks.push(feedbackEntry);
    
    // 🚨 ROOT CAUSE FIX: Verbessertes Logging für Debugging
    const asaCount = data.feedbacks.filter(f => f.isASA).length;
    const nonAsaCount = data.feedbacks.length - asaCount;
    console.log(`📊 Feedback-Eintrag wird gespeichert: id=${feedbackEntry.id}, isASA=${isASA}, total Feedbacks: ${data.feedbacks.length} (${asaCount} ASA, ${nonAsaCount} normale)`);
    
    await saveFeedbackData(data);
    
    // 🚨 ROOT CAUSE FIX: Nach dem Push Cache invalidiert (wird in pushFileToGitHub gemacht)
    // Aber wir loggen nochmal, um sicherzustellen, dass es funktioniert
    console.log(`✅ Feedback-Eintrag erfolgreich erstellt und auf GitHub gepusht: ${feedbackEntry.id} (isASA: ${isASA})`);
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
    const { status, editedResponse, reasoning } = req.body; // 🚨 NEU: reasoning-Feld
    
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
    
    // 🚨 NEU: Speichere Begründung (reasoning) - erklärt warum die Antwort gut ist
    if (reasoning && typeof reasoning === 'string' && reasoning.trim() !== '') {
      feedback.reasoning = reasoning.trim();
      console.log(`✅ Begründung gespeichert für Feedback ${id}: ${reasoning.substring(0, 100)}...`);
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
    
    // 🚨 NEU: Bei ASA-Fällen: Setze Situation auf "ASA" oder "Generische ASA (Neukunde)"
    // Bei ASA-Fällen ist die customerMessage oft leer oder "ASA Reaktivierung", daher kann die Situation nicht aus der Nachricht erkannt werden
    let detectedSituation;
    if (feedback.isASA) {
      // 🚨 ASA-FALL: Setze Situation auf "Generische ASA (Neukunde)" (wie in Training-Daten)
      detectedSituation = 'Generische ASA (Neukunde)';
      console.log(`🚨 ASA-Fall erkannt - setze Situation auf: "${detectedSituation}"`);
    } else {
      // Normale Fälle: Erkenne Situation aus der Kundennachricht
      detectedSituation = detectSituationFromMessage(feedback.customerMessage);
    }
    
    // Automatisch zu Training-Daten hinzufügen
    const trainingData = await getTrainingData();
    
    // 🚨 NEU: Bei ASA-Fällen: Zu asaExamples hinzufügen, nicht zu conversations!
    if (feedback.isASA) {
      trainingData.asaExamples = trainingData.asaExamples || [];
      
      if (status === 'good') {
        // ASA-Feedback zu asaExamples hinzufügen
        trainingData.asaExamples.push({
          customerType: 'neukunde', // Standard: Neukunde (kann später erweitert werden)
          lastTopic: null, // Kein spezifisches Thema (generische ASA)
          asaMessage: feedback.aiResponse, // Die ASA-Nachricht
          createdAt: new Date().toISOString(),
          source: 'feedback_good', // Markierung, dass es aus Feedback kommt
          feedbackId: id // Referenz zum Feedback-Eintrag
        });
        console.log(`✅ ASA-Feedback zu asaExamples hinzugefügt (Feedback-ID: ${id})`);
      } else if (status === 'edited' && editedResponse) {
        // Bearbeitete ASA-Nachricht zu asaExamples hinzufügen
        trainingData.asaExamples.push({
          customerType: 'neukunde', // Standard: Neukunde (kann später erweitert werden)
          lastTopic: null, // Kein spezifisches Thema (generische ASA)
          asaMessage: editedResponse, // Die bearbeitete ASA-Nachricht
          createdAt: new Date().toISOString(),
          source: 'feedback_edited', // Markierung, dass es aus bearbeitetem Feedback kommt
          feedbackId: id, // Referenz zum Feedback-Eintrag
          originalResponse: feedback.aiResponse // Optional: Original als Referenz
        });
        console.log(`✅ Bearbeitete ASA-Feedback zu asaExamples hinzugefügt (Feedback-ID: ${id})`);
      }
    } else {
      // Normale Fälle: Zu conversations hinzufügen
      trainingData.conversations = trainingData.conversations || [];
      
      if (status === 'good') {
        // Positive Antwort direkt zu Training-Daten hinzufügen
        // WICHTIG: Feedback-Einträge haben höhere Priorität (source: 'feedback_good' + priority: true)
        trainingData.conversations.push({
          customerMessage: feedback.customerMessage,
          moderatorResponse: feedback.aiResponse,
          situation: detectedSituation, // Automatisch erkannte Situation
          situations: Array.isArray(detectedSituation) ? detectedSituation : [detectedSituation], // 🚨 NEU: Array für bessere Verarbeitung
          explanation: feedback.reasoning || null, // 🚨 NEU: Begründung warum die Antwort gut ist
          createdAt: new Date().toISOString(),
          source: 'feedback_good', // Markierung, dass es aus Feedback kommt
          priority: true, // Höhere Priorität für Feedback-Einträge
          feedbackId: id // Referenz zum Feedback-Eintrag
        });
        
        // 🚨 NEU: Speichere Situation auch im Feedback
        feedback.situation = detectedSituation;
        feedback.situations = Array.isArray(detectedSituation) ? detectedSituation : [detectedSituation];
        console.log(`✅ Positive Antwort zu Training-Daten hinzugefügt (Feedback-ID: ${id}, Situation: ${detectedSituation}${feedback.reasoning ? ', mit Begründung' : ''})`);
      } else if (status === 'edited' && editedResponse) {
        // Bearbeitete Antwort als positives Beispiel, Original als negatives Beispiel (optional)
        // WICHTIG: Bearbeitete Feedback-Einträge haben höchste Priorität
        trainingData.conversations.push({
          customerMessage: feedback.customerMessage,
          moderatorResponse: editedResponse, // Die bearbeitete Version ist das positive Beispiel
          situation: detectedSituation, // Automatisch erkannte Situation
          situations: Array.isArray(detectedSituation) ? detectedSituation : [detectedSituation], // 🚨 NEU: Array für bessere Verarbeitung
          explanation: feedback.reasoning || null, // 🚨 NEU: Begründung warum die bearbeitete Antwort besser ist
          createdAt: new Date().toISOString(),
          source: 'feedback_edited', // Markierung, dass es aus bearbeitetem Feedback kommt
          priority: true, // Höhere Priorität für Feedback-Einträge
          feedbackId: id, // Referenz zum Feedback-Eintrag
          originalResponse: feedback.aiResponse // Optional: Original als Referenz
        });
        
        // 🚨 NEU: Speichere Situation auch im Feedback
        feedback.situation = detectedSituation;
        feedback.situations = Array.isArray(detectedSituation) ? detectedSituation : [detectedSituation];
        console.log(`✅ Bearbeitete Antwort zu Training-Daten hinzugefügt (Feedback-ID: ${id}, Situation: ${detectedSituation}${feedback.reasoning ? ', mit Begründung' : ''})`);
      }
    }
    
    await saveTrainingData(trainingData);
    await saveFeedbackData(data);
    
    // 🧠 LERN-SYSTEM: Analysiere Feedback und aktualisiere Learning-Statistiken
    // 🚨 NEU: Bei ASA-Fällen: customerMessage auf generischen Wert setzen (damit Learning-System nicht verwirrt wird)
    try {
      const { analyzeFeedback } = require('../utils/learning-system');
      const learningStats = await analyzeFeedback({
        customerMessage: feedback.isASA ? "ASA Reaktivierung" : feedback.customerMessage, // 🚨 ASA: Generischer Wert
        aiResponse: feedback.aiResponse,
        editedResponse: feedback.editedResponse,
        status: feedback.status,
        situation: detectedSituation,
        reasoning: feedback.reasoning || null, // 🚨 NEU: Begründung mit übergeben
        usedExampleIds: feedback.usedExampleIds || [] // 🚨 NEU: Verwendete Beispiel-IDs für Performance-Tracking
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
      
      // 🚨 NEU: Bei ASA-Fällen: Setze Situation auf "Generische ASA (Neukunde)"
      if (feedback.isASA) {
        selectedSituation = 'Generische ASA (Neukunde)';
        console.log(`🚨 ASA-Fall erkannt bei Variationen - setze Situation auf: "${selectedSituation}"`);
      } else {
        selectedSituation = detectSituationFromMessage(feedback.customerMessage);
      }
    }
    
    // Lade Training-Daten
    const trainingData = await getTrainingData();
    
    // 🚨 NEU: Bei ASA-Fällen: Zu asaExamples hinzufügen, nicht zu conversations!
    if (feedback.isASA) {
      trainingData.asaExamples = trainingData.asaExamples || [];
      
      // Füge jede Variation zu asaExamples hinzu
      const addedVariations = [];
      variations.forEach((variation, index) => {
        const responseText = variation.editedText || variation.text;
        if (!responseText || responseText.trim() === '') {
          return; // Überspringe leere Variationen
        }
        
        const newASAExample = {
          customerType: 'neukunde', // Standard: Neukunde (kann später erweitert werden)
          lastTopic: null, // Kein spezifisches Thema (generische ASA)
          asaMessage: responseText.trim(),
          createdAt: new Date().toISOString(),
          source: variation.editedText ? 'feedback_generated_edited' : 'feedback_generated',
          feedbackId: id,
          variationIndex: index
        };
        
        console.log(`📋 [Variationen] Speichere ASA-Beispiel`);
        console.log(`📋 [Variationen] ASA-Daten:`, JSON.stringify(newASAExample).substring(0, 200));
        
        trainingData.asaExamples.push(newASAExample);
        
        addedVariations.push({
          customerType: 'neukunde',
          lastTopic: null,
          asaMessage: responseText.trim()
        });
      });
      
      await saveTrainingData(trainingData);
      
      // Aktualisiere Feedback-Eintrag: Markiere, dass Variationen generiert wurden
      // 🆕 NEU: Setze Status auf "edited", da Feedback zu Training-Daten hinzugefügt wurde
      const feedbackData = await getFeedbackData();
      const feedbackIndex = feedbackData.feedbacks.findIndex(f => f.id === id);
      if (feedbackIndex !== -1) {
        const existingVariationsCount = feedbackData.feedbacks[feedbackIndex].variationsGeneratedCount || 0;
        feedbackData.feedbacks[feedbackIndex].variationsGeneratedCount = existingVariationsCount + addedVariations.length;
        feedbackData.feedbacks[feedbackIndex].updatedAt = new Date().toISOString();
        // 🆕 NEU: Setze Status auf "edited", da Feedback zu Training-Daten hinzugefügt wurde
        if (feedbackData.feedbacks[feedbackIndex].status === 'pending') {
          feedbackData.feedbacks[feedbackIndex].status = 'edited';
          console.log(`✅ Feedback-Status aktualisiert: pending → edited (Feedback-ID: ${id})`);
        }
        await saveFeedbackData(feedbackData);
      }
      
      console.log(`✅ ${addedVariations.length} ASA-Variationen zu asaExamples hinzugefügt (Feedback-ID: ${id})`);
      res.json({ success: true, addedVariations });
      return; // 🚨 WICHTIG: Früh zurückkehren, damit normale Logik nicht ausgeführt wird
    }
    
    // Normale Fälle: Zu conversations hinzufügen
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
    // 🆕 NEU: Setze Status auf "edited", da Feedback zu Training-Daten hinzugefügt wurde
    const feedbackData = await getFeedbackData();
    const feedbackIndex = feedbackData.feedbacks.findIndex(f => f.id === id);
    if (feedbackIndex !== -1) {
      const existingVariationsCount = feedbackData.feedbacks[feedbackIndex].variationsGeneratedCount || 0;
      feedbackData.feedbacks[feedbackIndex].variationsGeneratedCount = existingVariationsCount + addedVariations.length;
      feedbackData.feedbacks[feedbackIndex].variationsGeneratedAt = new Date().toISOString();
      feedbackData.feedbacks[feedbackIndex].lastVariationsCount = addedVariations.length;
      // 🆕 NEU: Setze Status auf "edited", da Feedback zu Training-Daten hinzugefügt wurde
      if (feedbackData.feedbacks[feedbackIndex].status === 'pending') {
        feedbackData.feedbacks[feedbackIndex].status = 'edited';
        feedbackData.feedbacks[feedbackIndex].updatedAt = new Date().toISOString();
        console.log(`✅ Feedback-Status aktualisiert: pending → edited (Feedback-ID: ${id})`);
      }
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

// ============================================
// FINE-TUNING ROUTES
// ============================================

// GET /api/v1/fine-tuning/status - Prüfe Fine-Tuning-Status
// WICHTIG: Die globale Auth-Middleware (router.use) prüft bereits den Token
router.get('/fine-tuning/status', async (req, res) => {
  try {
    const config = await getFineTuningConfig();
    
    // Wenn ein Job läuft, prüfe Status
    if (config.currentJobId) {
      const status = await checkFineTuningStatus(config.currentJobId);
      
      // Wenn Job erfolgreich, aktualisiere Config
      if (status.status === 'succeeded' && status.modelId) {
        config.modelId = status.modelId;
        config.lastTrained = new Date().toISOString();
        config.status = 'succeeded';
        config.currentJobId = null;
        await saveFineTuningConfig(config);
      } else if (status.status === 'failed' || status.status === 'cancelled') {
        config.status = status.status;
        config.currentJobId = null;
        await saveFineTuningConfig(config);
      } else {
        config.status = status.status;
        await saveFineTuningConfig(config);
      }
      
      return res.json({
        status: config.status,
        modelId: config.modelId,
        lastTrained: config.lastTrained,
        currentJobId: config.currentJobId,
        error: status.error
      });
    }
    
    res.json({
      status: config.status || 'idle',
      modelId: config.modelId,
      lastTrained: config.lastTrained,
      currentJobId: config.currentJobId,
      trainingExamplesCount: config.trainingExamplesCount || 0,
      nextRetrainAt: config.nextRetrainAt || 50,
      lastError: config.lastError || null,
      lastErrorTimestamp: config.lastErrorTimestamp || null
    });
  } catch (error) {
    console.error('Fehler beim Prüfen des Fine-Tuning-Status:', error);
    res.status(500).json({ error: 'Fehler beim Prüfen des Fine-Tuning-Status' });
  }
});

// POST /api/v1/fine-tuning/retrain - Starte Fine-Tuning
// WICHTIG: Die globale Auth-Middleware (router.use) prüft bereits den Token
router.post('/fine-tuning/retrain', async (req, res) => {
  try {
    console.log('🚀 Starte Fine-Tuning-Prozess...');
    
    // 1. Sammle perfekte Beispiele
    console.log('📊 Sammle perfekte Beispiele...');
    const examples = await collectPerfectExamples();
    
    if (examples.length < 10) {
      return res.status(400).json({ 
        error: `Zu wenige Beispiele (${examples.length}). Mindestens 10 benötigt.` 
      });
    }
    
    // 2. Filtere mit Moderation API (WICHTIG: Vor dem Upload!)
    // Filtert nur kritische Kategorien (Gewalt, Selbstverletzung, etc.)
    // "Sexual" wird NICHT gefiltert, da das für Chat-Moderation normal ist
    console.log('🔍 Prüfe Beispiele mit OpenAI Moderation API...');
    
    // 🚨 FALLBACK: Wenn filterWithModeration nicht verfügbar ist, verwende alle Beispiele
    let safeExamples, flaggedExamples, warningExamples;
    
    if (!filterWithModeration || typeof filterWithModeration !== 'function') {
      console.warn('⚠️ WARNUNG: filterWithModeration ist nicht verfügbar! Verwende alle Beispiele ohne Filterung.');
      try {
        const fineTuningUtilsCheck = require("../utils/fine-tuning");
        console.warn('Verfügbare Funktionen:', Object.keys(fineTuningUtilsCheck));
      } catch (e) {
        console.warn('Konnte fine-tuning.js nicht laden:', e.message);
      }
      
      // Fallback: Verwende alle Beispiele ohne Filterung
      safeExamples = examples;
      flaggedExamples = [];
      warningExamples = [];
      
      console.warn(`⚠️ Moderation-Filterung übersprungen: ${safeExamples.length} Beispiele werden verwendet`);
    } else {
      try {
        const result = await filterWithModeration(examples);
        safeExamples = result.safe || [];
        flaggedExamples = result.flagged || [];
        warningExamples = result.warnings || [];
      } catch (moderationError) {
        console.error('❌ Fehler bei Moderation-Filterung:', moderationError.message);
        // Fallback: Verwende alle Beispiele wenn Moderation fehlschlägt
        safeExamples = examples;
        flaggedExamples = [];
        warningExamples = [];
        console.warn(`⚠️ Moderation-Filterung fehlgeschlagen, verwende alle ${safeExamples.length} Beispiele`);
      }
    }
    
    if (safeExamples.length === 0) {
      return res.status(400).json({
        error: `Alle Beispiele wurden von der Moderation API gefiltert (${flaggedExamples.length} Beispiele mit kritischen Kategorien). Bitte überprüfe deine Training-Daten.`,
        flaggedCount: flaggedExamples.length,
        flaggedCategories: [...new Set(flaggedExamples.flatMap(f => f.flaggedCategories || []))]
      });
    }
    
    if (safeExamples.length < 10) {
      return res.status(400).json({
        error: `Nach Moderation-Filterung zu wenige sichere Beispiele. Benötigt: 10, Aktuell: ${safeExamples.length} (${flaggedExamples.length} wurden gefiltert)`,
        safeCount: safeExamples.length,
        flaggedCount: flaggedExamples.length,
        flaggedCategories: [...new Set(flaggedExamples.flatMap(f => f.flaggedCategories || []))]
      });
    }
    
    console.log(`✅ ${safeExamples.length} sichere Beispiele nach Moderation-Check (${flaggedExamples.length} kritisch gefiltert, ${warningExamples.length} Warnungen)`);
    
    // Warnung ausgeben, aber nicht blockieren
    if (warningExamples.length > 0) {
      const warningCategories = [...new Set(warningExamples.flatMap(w => w.flaggedCategories || []))];
      console.log(`⚠️ ${warningExamples.length} Beispiele haben Warnungen (werden aber verwendet): ${warningCategories.join(', ')}`);
    }
    
    // 3. Erstelle System-Prompt
    console.log('📝 Erstelle System-Prompt...');
    const systemPrompt = await buildSystemPrompt();
    
    // 4. Konvertiere zu JSONL (nur sichere Beispiele)
    console.log('🔄 Konvertiere zu JSONL...');
    const rules = await getRules();
    const jsonlData = convertToJSONL(safeExamples, systemPrompt, rules);
    
    // 5. Lade zu OpenAI hoch
    console.log('☁️ Lade Daten zu OpenAI hoch...');
    const fileId = await uploadToOpenAI(jsonlData);
    
    // 6. Starte Fine-Tuning-Job
    console.log('🎯 Starte Fine-Tuning-Job...');
    const baseModel = req.body.baseModel || 'gpt-3.5-turbo'; // gpt-4o-mini ist nicht für Fine-Tuning verfügbar
    const jobId = await startFineTuning(fileId, baseModel);
    
    // 7. Aktualisiere Config
    const config = await getFineTuningConfig();
    config.currentJobId = jobId;
    config.status = 'running';
    config.trainingExamplesCount = safeExamples.length; // Nur sichere Beispiele zählen
    await saveFineTuningConfig(config);
    
    console.log(`✅ Fine-Tuning gestartet: Job ${jobId} mit ${safeExamples.length} sicheren Beispielen (${flaggedExamples.length} kritisch gefiltert, ${warningExamples.length} Warnungen)`);
    
    let message = `Fine-Tuning gestartet mit ${safeExamples.length} sicheren Beispielen.`;
    if (flaggedExamples.length > 0) {
      message += ` ⚠️ ${flaggedExamples.length} Beispiele wurden gefiltert (kritische Kategorien: Gewalt, Selbstverletzung, etc.).`;
    }
    if (warningExamples.length > 0) {
      message += ` ℹ️ ${warningExamples.length} Beispiele haben Warnungen (werden aber verwendet).`;
    }
    message += ` Job-ID: ${jobId}`;
    
    // 🚨 NEU: Speichere gefilterte Beispiele in Config für spätere Analyse
    config.lastFilteredExamples = {
      flagged: flaggedExamples.map(ex => ({
        customerMessage: ex.customerMessage,
        moderatorResponse: ex.moderatorResponse,
        reason: ex.reason,
        flaggedCategories: ex.flaggedCategories || [],
        source: ex.source,
        situation: ex.situation
      })),
      warnings: warningExamples.map(ex => ({
        customerMessage: ex.customerMessage,
        moderatorResponse: ex.moderatorResponse,
        reason: ex.reason,
        flaggedCategories: ex.flaggedCategories || [],
        source: ex.source,
        situation: ex.situation
      })),
      timestamp: new Date().toISOString()
    };
    await saveFineTuningConfig(config);
    
    res.json({
      success: true,
      jobId,
      examplesCount: safeExamples.length,
      flaggedCount: flaggedExamples.length,
      warningCount: warningExamples.length,
      flaggedExamples: flaggedExamples.slice(0, 20), // Erste 20 für sofortige Anzeige
      status: 'running',
      message: message
    });
  } catch (error) {
    console.error('❌ Fehler beim Fine-Tuning:', error);
    res.status(500).json({ 
      error: 'Fehler beim Fine-Tuning',
      message: error.message 
    });
  }
});

// GET /api/v1/fine-tuning/stats - Hole Fine-Tuning-Statistiken
// WICHTIG: Die globale Auth-Middleware (router.use) prüft bereits den Token
router.get('/fine-tuning/stats', async (req, res) => {
  try {
    const config = await getFineTuningConfig();
    const includeExcluded = req.query.includeExcluded === 'true';
    const result = await collectPerfectExamples(includeExcluded);
    
    const examples = Array.isArray(result) ? result : result.examples;
    const excluded = result.excluded || null;
    
    // Zähle Beispiele nach Quelle
    const stats = {
      total: examples.length,
      fromFeedbackGood: examples.filter(e => e.source === 'feedback_good').length,
      fromFeedbackEdited: examples.filter(e => e.source === 'feedback_edited').length,
      fromTrainingData: examples.filter(e => e.source === 'training_data').length,
      fromASA: examples.filter(e => e.source === 'asa_training_data').length,
      modelId: config.modelId,
      lastTrained: config.lastTrained,
      nextRetrainAt: config.nextRetrainAt || 50,
      examplesNeeded: Math.max(0, (config.nextRetrainAt || 50) - examples.length)
    };
    
    if (excluded) {
      stats.excluded = {
        tooShort: excluded.tooShort.length,
        duplicate: excluded.duplicate.length,
        noMessage: excluded.noMessage.length,
        total: excluded.tooShort.length + excluded.duplicate.length + excluded.noMessage.length
      };
      if (includeExcluded) {
        stats.excludedDetails = excluded;
      }
    }
    
    // 🚨 NEU: Füge gefilterte Beispiele hinzu (aus letztem Training)
    // config wurde bereits oben deklariert (Zeile 3456)
    if (config.lastFilteredExamples) {
      stats.filteredExamples = {
        flagged: config.lastFilteredExamples.flagged || [],
        warnings: config.lastFilteredExamples.warnings || [],
        timestamp: config.lastFilteredExamples.timestamp
      };
    }
    
    res.json(stats);
  } catch (error) {
    console.error('Fehler beim Laden der Fine-Tuning-Statistiken:', error);
    res.status(500).json({ error: 'Fehler beim Laden der Statistiken' });
  }
});

// GET /api/v1/fine-tuning/jobs - Liste alle Fine-Tuning-Jobs von OpenAI
router.get('/fine-tuning/jobs', async (req, res) => {
  try {
    const jobs = await listFineTuningJobs(20);
    res.json({
      success: true,
      jobs: jobs,
      total: jobs.length
    });
  } catch (error) {
    console.error('Fehler beim Abrufen der Fine-Tuning-Jobs:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Jobs', message: error.message });
  }
});

// GET /api/v1/fine-tuning/export-jsonl - Exportiere JSONL-Datei für manuelles Fine-Tuning
router.get('/fine-tuning/export-jsonl', async (req, res) => {
  try {
    console.log('📤 Exportiere JSONL-Datei für manuelles Fine-Tuning...');
    
    // 1. Sammle ALLE perfekten Beispiele (OHNE Filterung!)
    const examples = await collectPerfectExamples();
    
    if (examples.length < 10) {
      return res.status(400).json({ 
        error: `Zu wenige Beispiele (${examples.length}). Mindestens 10 benötigt.` 
      });
    }
    
    // 2. Erstelle System-Prompt
    const systemPrompt = await buildSystemPrompt();
    
    // 3. Konvertiere zu JSONL (OHNE Filterung - MIT sexuellen Inhalten!)
    const rules = await getRules();
    const jsonlData = convertToJSONL(examples, systemPrompt, rules);
    
    // 4. Sende als Download
    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', `attachment; filename="fine-tuning-data-${Date.now()}.jsonl"`);
    res.send(jsonlData);
    
    console.log(`✅ JSONL-Datei exportiert: ${examples.length} Beispiele (${jsonlData.length} Bytes)`);
  } catch (error) {
    console.error('❌ Fehler beim Exportieren der JSONL-Datei:', error);
    res.status(500).json({ 
      error: 'Fehler beim Exportieren',
      message: error.message 
    });
  }
});

// GET /api/v1/fine-tuning/filtered - Hole gefilterte Beispiele vom letzten Training
router.get('/fine-tuning/filtered', async (req, res) => {
  try {
    const config = await getFineTuningConfig();
    
    if (!config.lastFilteredExamples) {
      return res.json({
        flagged: [],
        warnings: [],
        message: 'Keine gefilterten Beispiele gefunden. Starte ein Training, um gefilterte Beispiele zu sehen.'
      });
    }
    
    res.json({
      flagged: config.lastFilteredExamples.flagged || [],
      warnings: config.lastFilteredExamples.warnings || [],
      timestamp: config.lastFilteredExamples.timestamp,
      total: (config.lastFilteredExamples.flagged || []).length + (config.lastFilteredExamples.warnings || []).length
    });
  } catch (error) {
    console.error('Fehler beim Laden der gefilterten Beispiele:', error);
    res.status(500).json({ error: 'Fehler beim Laden der gefilterten Beispiele' });
  }
});

// Exportiere Helper-Funktionen für andere Module
module.exports = router;
module.exports.getFeedbackData = getFeedbackData;
module.exports.getTrainingData = getTrainingData;