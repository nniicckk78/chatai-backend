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
      const expiresAt = Math.floor(Date.now() / 1000) + 3600; // Unix timestamp in seconds
   return res.json({ access_token: accessToken, expires_at: expiresAt });
  } catch (err) {
    console.error("Login Fehler", err);
    return res.status(500).json({ error: "Serverfehler" });
  }
});

router.post("/refresh", async (req, res) => {
 const old = req.body?.accessToken || req.body?.access_token;
  if (!old) return res.status(400).json({ error: "accessToken fehlt" });
  try {
    // Wir verifizieren und stellen einen neuen Token aus
    // (hier ohne Blacklist; für MVP ausreichend)
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(old, process.env.JWT_SECRET);
    const newToken = signToken(decoded.sub);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; // Unix timestamp in seconds
return res.json({ access_token: newToken, expires_at: expiresAt });
  } catch (err) {
    console.error("Refresh Fehler", err);
    return res.status(401).json({ error: "Token ungueltig" });
  }
});

module.exports = router;


