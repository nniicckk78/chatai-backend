require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { runMigrations } = require("./db");
const { ensureAdminSeed } = require("./auth");
const authRoutes = require("./routes/auth");
const replyRoutes = require("./routes/reply");
const dashboardRoutes = require("./routes/dashboard");

const app = express();

// Explizite CORS-Settings für Browser-Fetches
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// WICHTIG: Limit erhöht, da Extension möglicherweise große Daten sendet (Chat-Historie, Bilder, etc.)
app.use(express.json({ limit: "10mb" }));

// Statische Dateien aus public-Ordner servieren (für Dashboard)
app.use(express.static(path.join(__dirname, '../public')));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/status", (req, res) => {
  // Logging endpoint für Extension-Status-Updates
  console.log("Status update:", req.body);
  res.json({ ok: true, received: true });
});
app.use("/api/v1/auth", authRoutes);
app.use("/auth", authRoutes); // Kompatibilität mit alter Extension
app.use("/api/v1/reply", replyRoutes);
app.use("/chatcompletion", replyRoutes); // Kompatibilität mit alter Extension
// Panel wählte bei Cherry/AVZ + nicht exakt "german" fälschlich /translatio (existierte nicht → 500). Alias = gleiche Route.
app.use("/translatio", replyRoutes);
app.use("/api/v1", dashboardRoutes); // Dashboard-Routen (training-data, feedback, rules, etc.)

const PORT = process.env.PORT || 3000;
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function start() {
  // Statische Embeddings NUR im Hintergrund (blockieren nicht den Server-Start – sonst schlägt Deploy bei OpenAI-500 fehl)
  try {
    if (hasDatabase) {
      try {
        console.log("🚀 Initialisiere Datenbank...");
      await runMigrations();
      await ensureAdminSeed();
        console.log("✅ Datenbank erfolgreich initialisiert - Dashboard und Auth sind verfügbar");
      } catch (dbError) {
        console.error("❌❌❌ KRITISCHER FEHLER: Datenbankverbindung fehlgeschlagen! ❌❌❌");
        console.error("❌ Der Server startet trotzdem, ABER:");
        console.error("   - Dashboard wird NICHT funktionieren (kein Login möglich)");
        console.error("   - Auth wird NICHT funktionieren");
        console.error("   - Vector-DB Persistierung wird NICHT funktionieren");
        console.error("");
        console.error("🔧 SOFORT-MASSNAHME:");
        console.error("   1. Gehe zu Render Dashboard");
        console.error("   2. Suche nach deiner PostgreSQL-Datenbank");
        console.error("   3. Prüfe Status: Muss 'Running' sein (nicht 'Paused')");
        console.error("   4. Falls pausiert: Klicke auf 'Resume' oder 'Start'");
        console.error("   5. Warte 30 Sekunden, dann starte den Server neu");
        console.error("");
        console.error("⚠️ Server startet trotzdem - Reply-API läuft, aber Dashboard/Auth nicht!");
      }
    } else {
      console.warn("Starte ohne Datenbank (DATABASE_URL fehlt). Auth/Seed werden übersprungen.");
    }
    
    // 🚨 NEU: Initialisiere statische Embeddings beim Start (einmalig, blockiert nicht)
    try {
      const { initializeStaticEmbeddings } = require('./utils/embeddings');
      // Starte asynchron im Hintergrund, blockiert nicht den Server-Start
      initializeStaticEmbeddings().catch(err => {
        console.warn('⚠️ Statische Embeddings Initialisierung fehlgeschlagen (nicht kritisch):', err.message);
      });
    } catch (err) {
      console.warn('⚠️ Statische Embeddings konnten nicht initialisiert werden (nicht kritisch):', err.message);
    }
    
    // 🧠 Initialisiere Learning-System im Hintergrund (blockiert nicht den Start)
    try {
      const { initializeLearningSystem } = require('./utils/learning-system');
      // Starte asynchron im Hintergrund, blockiert nicht den Server-Start
      initializeLearningSystem().catch(err => {
        console.warn('⚠️ Learning-System Initialisierung fehlgeschlagen (nicht kritisch):', err.message);
      });
    } catch (err) {
      console.warn('⚠️ Learning-System konnte nicht geladen werden (nicht kritisch):', err.message);
    }
    
    // 🔍 Initialisiere Vektor-DB im Hintergrund (blockiert nicht den Start)
    try {
      const { initializeVectorDb } = require('./utils/vector-db');
      // Lade Training-Daten direkt (ohne getTrainingData aus reply.js, da nicht exportiert)
      const { getGitHubClient, getRepoInfo } = require('./utils/github');
      const fs = require('fs');
      const path = require('path');
      
      // Lade Training-Daten (kopiert aus reply.js)
      async function loadTrainingDataForVectorDb() {
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
            console.warn('⚠️ Fehler beim Laden der Training-Daten von GitHub:', err.message);
          }
        }
        
        // Fallback: Lokale Datei
        const trainingPath = path.join(__dirname, '../config/training-data.json');
        try {
          if (fs.existsSync(trainingPath)) {
            const data = fs.readFileSync(trainingPath, 'utf8');
            return JSON.parse(data);
          }
        } catch (err) {
          console.warn('⚠️ Fehler beim Laden der lokalen Training-Daten:', err.message);
        }
        
        return { conversations: [], asaExamples: [] };
      }
      
      // 🚨 VERBESSERT: Lade Training-Daten und indexiere sie mit VERZÖGERUNG (DB braucht Zeit zum Starten)
      // Warte 30 Sekunden nach Server-Start, damit PostgreSQL Zeit hat, vollständig zu starten
      setTimeout(() => {
        loadTrainingDataForVectorDb().then(trainingData => {
          // 🚨 WICHTIG: Wrapper mit try-catch, um alle Fehler abzufangen
          (async () => {
            try {
              // 🚨 NEU: Initialisiere Training-Daten-Analyse GLOBAL
              const { analyzeTrainingData } = require('./utils/training-data-analyzer');
              global.trainingDataAnalysis = analyzeTrainingData(trainingData);
              console.log('✅ Training-Daten-Analyse initialisiert und global gespeichert');
              
              console.log('⏳ Warte 30 Sekunden, damit PostgreSQL vollständig gestartet ist...');
              await new Promise(resolve => setTimeout(resolve, 30000));
              
              await initializeVectorDb(trainingData);
              
              // 🚨 OPTIMIERUNG: Deep Learning Patterns NON-BLOCKING im Hintergrund extrahieren
              // Startet sofort, blockiert aber nicht den Server-Start
              try {
                const { getLearningStats, extractDeepPatterns } = require('./utils/learning-system');
                const { getFeedbackDataForLearning } = require('./utils/learning-system');
                const learningStats = await getLearningStats();
                const hasDeepPatterns = learningStats?.deepPatterns && learningStats.deepPatterns.lastUpdated;
                
                if (!hasDeepPatterns) {
                  console.log('🧠🧠🧠 Deep Patterns nicht vorhanden - starte Extraktion im HINTERGRUND (non-blocking)...');
                  // 🚨 WICHTIG: NON-BLOCKING - startet im Hintergrund, blockiert nicht
                  setImmediate(async () => {
                    try {
                      const feedbackData = await getFeedbackDataForLearning();
                      const result = await extractDeepPatterns(trainingData, feedbackData, learningStats);
                      if (result) {
                        console.log('✅ Deep Patterns erfolgreich im Hintergrund extrahiert - Agent kann jetzt verwendet werden');
                      } else {
                        console.warn('⚠️ Deep Pattern Extraction abgeschlossen, aber keine Patterns extrahiert');
                      }
                    } catch (err) {
                      console.warn('⚠️ Deep Pattern Extraction im Hintergrund fehlgeschlagen (nicht kritisch):', err.message);
                    }
                  });
                  console.log('✅ Deep Pattern Extraction im Hintergrund gestartet - Server läuft weiter');
                } else {
                  console.log('✅ Deep Patterns bereits vorhanden - Agent kann verwendet werden');
                }
              } catch (err) {
                console.warn('⚠️ Deep Pattern Extraction Initialisierung fehlgeschlagen (nicht kritisch):', err.message);
              }
            } catch (err) {
              console.warn('⚠️ Vektor-DB Initialisierung fehlgeschlagen (nicht kritisch):', err.message);
              console.warn('   Stack:', err.stack?.split('\n').slice(0, 3).join('\n') || 'kein Stack');
            }
          })();
        }).catch(err => {
          console.warn('⚠️ Konnte Training-Daten nicht laden für Vektor-DB (nicht kritisch):', err.message);
        });
      }, 30000); // 🚨 VERZÖGERUNG: 30 Sekunden nach Server-Start
    } catch (err) {
      console.warn('⚠️ Vektor-DB konnte nicht initialisiert werden (nicht kritisch):', err.message);
    }
    
    app.listen(PORT, () => console.log(`API läuft auf Port ${PORT}`));
  } catch (err) {
    console.error("Startfehler", err);
    process.exit(1);
  }
}

start();

