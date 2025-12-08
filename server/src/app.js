require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { runMigrations } = require("./db");
const { ensureAdminSeed } = require("./auth");
const authRoutes = require("./routes/auth");
const replyRoutes = require("./routes/reply");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

async function start() {
  try {
    await runMigrations();
    await ensureAdminSeed();
    app.listen(PORT, () => console.log(`API läuft auf Port ${PORT}`));
  } catch (err) {
    console.error("Startfehler", err);
    process.exit(1);
  }
}

start();
