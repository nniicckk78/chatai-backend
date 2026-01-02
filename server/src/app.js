require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { runMigrations } = require("./db");
const { ensureAdminSeed } = require("./auth");
const authRoutes = require("./routes/auth");
const replyRoutes = require("./routes/reply");

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

const PORT = process.env.PORT || 3000;
const hasDatabase = Boolean(process.env.DATABASE_URL);

async function start() {
  try {
    if (hasDatabase) {
      await runMigrations();
      await ensureAdminSeed();
    } else {
      console.warn("Starte ohne Datenbank (DATABASE_URL fehlt). Auth/Seed werden übersprungen.");
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
    
    app.listen(PORT, () => console.log(`API läuft auf Port ${PORT}`));
  } catch (err) {
    console.error("Startfehler", err);
    process.exit(1);
  }
}

start();

