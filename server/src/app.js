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

// Error-Handler für JSON-Parsing-Fehler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error("❌ JSON-Parsing-Fehler:", err.message);
    return res.status(400).json({
      error: "❌ FEHLER: Ungültiges JSON-Format",
      resText: "❌ FEHLER: Ungültiges JSON-Format",
      replyText: "❌ FEHLER: Ungültiges JSON-Format",
      summary: {},
      chatId: "00000000",
      actions: [],
      flags: { blocked: true, reason: "invalid_json", isError: true, showError: true }
    });
  }
  next(err);
});

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

// Globaler Error-Handler für alle unerwarteten Fehler
app.use((err, req, res, next) => {
  console.error("❌ GLOBALER FEHLER:", err);
  console.error("❌ Stack:", err.stack);
  console.error("❌ Request URL:", req.url);
  console.error("❌ Request Method:", req.method);
  
  // Wenn Response bereits gesendet wurde, nichts tun
  if (res.headersSent) {
    return next(err);
  }
  
  return res.status(err.status || 500).json({
    error: `❌ FEHLER: ${err.message || "Unerwarteter Server-Fehler"}`,
    resText: `❌ FEHLER: ${err.message || "Unerwarteter Server-Fehler"}`,
    replyText: `❌ FEHLER: ${err.message || "Unerwarteter Server-Fehler"}`,
    summary: {},
    chatId: req.body?.chatId || "00000000",
    actions: [],
    flags: { blocked: true, reason: "server_error", isError: true, showError: true }
  });
});

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
    app.listen(PORT, () => console.log(`API läuft auf Port ${PORT}`));
  } catch (err) {
    console.error("Startfehler", err);
    process.exit(1);
  }
}

start();
