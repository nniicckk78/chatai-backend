const express = require("express");
const bcrypt = require("bcryptjs");
const { signToken, findUserByEmail } = require("../auth");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email und password sind erforderlich" });
  }
  try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: "Login fehlgeschlagen" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Login fehlgeschlagen" });
    const accessToken = signToken(user.id);
    return res.json({ accessToken, expiresInSeconds: 3600 });
  } catch (err) {
    console.error("Login Fehler", err);
    return res.status(500).json({ error: "Serverfehler" });
  }
});

router.post("/refresh", async (req, res) => {
  const old = req.body?.accessToken;
  if (!old) return res.status(400).json({ error: "accessToken fehlt" });
  try {
    // Wir verifizieren und stellen einen neuen Token aus
    // (hier ohne Blacklist; für MVP ausreichend)
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(old, process.env.JWT_SECRET);
    const newToken = signToken(decoded.sub);
    return res.json({ accessToken: newToken, expiresInSeconds: 3600 });
  } catch (err) {
    console.error("Refresh Fehler", err);
    return res.status(401).json({ error: "Token ungueltig" });
  }
});

module.exports = router;

