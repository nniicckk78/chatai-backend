require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { runMigrations } = require("./db");
const { ensureAdminSeed } = require("./auth");
const authRoutes = require("./routes/auth");
const replyRoutes = require("./routes/reply");

const app = express();

// CORS
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// JSON-Limit
app.use(express.json({ limit: "10mb" }));

// JSON-Parsing-Error
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
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

// Health/Status
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/status", (req, res) => {
  console.log("Status update:", req.body);
  res.json({ ok: true, received: true });
});

// Routes
app.use("/api/v1/auth", authRoutes);
app.use("/auth", authRoutes);
app.use("/api/v1/reply", replyRoutes);
app.use("/chatcompletion", replyRoutes);

// Globaler Error-Handler
app.use((err, req, res, next) => {
  console.error("❌ GLOBALER FEHLER:", err);
  console.error("❌ Stack:", err.stack);
  console.error("❌ Request URL:", req.url);
  console.error("❌ Request Method:", req.method);

  if (res.headersSent) return next(err);

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
  // sofort starten, damit Render nicht in Timeout läuft
  app.listen(PORT, "0.0.0.0", () => console.log(`API läuft auf Port ${PORT}`));

  // Migrations/Seed nur wenn DB vorhanden; Fehler nicht tödlich
  try {
    if (hasDatabase) {
      await runMigrations();
      await ensureAdminSeed();
    } else {
      console.warn("Starte ohne Datenbank (DATABASE_URL fehlt). Auth/Seed werden übersprungen.");
    }
  } catch (err) {
    console.error("Startfehler (Migrations/Seed)", err);
  }
}

start();
