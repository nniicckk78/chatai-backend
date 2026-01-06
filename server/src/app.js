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
app.use("/api/v1", dashboardRoutes); // Dashboard-Routen (training-data, feedback, rules, etc.)

const PORT = process.env.PORT || 3000;
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function start() {
  // 🚨 NEU: Initialisiere statische Embeddings beim Start (einmalig)
  try {
    const { initializeStaticEmbeddings } = require('./utils/embeddings');
    await initializeStaticEmbeddings();
  } catch (err) {
    console.warn('⚠️ Fehler beim Initialisieren der statischen Embeddings:', err.message);
  }
  try {
    if (hasDatabase) {
      await runMigrations();
      await ensureAdminSeed();
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
      
      // Lade Training-Daten und indexiere sie
      loadTrainingDataForVectorDb().then(trainingData => {
        initializeVectorDb(trainingData).catch(err => {
          console.warn('⚠️ Vektor-DB Initialisierung fehlgeschlagen (nicht kritisch):', err.message);
        });
      }).catch(err => {
        console.warn('⚠️ Konnte Training-Daten nicht laden für Vektor-DB (nicht kritisch):', err.message);
      });
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

