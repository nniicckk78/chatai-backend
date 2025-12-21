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
    const expiresAt = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 Stunden in Sekunden (Unix timestamp)
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
    const jwt = require("jsonwebtoken");
    
    // WICHTIG: Erlaube Refresh auch für abgelaufene Token (bis zu 8 Stunden)
    // Das ermöglicht lange Sessions (8+ Stunden) ohne Ausloggen
    // Token ist 24h gültig + 8h Toleranz = bis zu 32h theoretisch möglich
    let decoded;
    try {
      // Versuche zuerst normale Verifizierung (Token noch gültig)
      decoded = jwt.verify(old, process.env.JWT_SECRET);
    } catch (verifyErr) {
      // Wenn Token abgelaufen ist, versuche es mit ignoreExpiration
      if (verifyErr.name === 'TokenExpiredError') {
        // Dekodiere das Token ohne Verifizierung, um exp zu bekommen
        decoded = jwt.decode(old, { complete: true });
        if (!decoded || !decoded.payload) {
          throw new Error("Token konnte nicht dekodiert werden");
        }
        
        // Prüfe, ob das Token nicht zu alt ist (max. 8 Stunden abgelaufen für lange Sessions)
        // WICHTIG: Erlaubt Refresh auch nach 8+ Stunden Inaktivität, damit User nicht ausgeloggt werden
        const now = Math.floor(Date.now() / 1000);
        const expiredAt = decoded.payload.exp;
        const hoursSinceExpiry = (now - expiredAt) / 3600;
        
        // Erlaube Refresh für Token, die bis zu 8 Stunden abgelaufen sind
        // Das ermöglicht lange Sessions ohne Ausloggen
        if (hoursSinceExpiry > 8) {
          // Token ist mehr als 8 Stunden abgelaufen - zu alt für Refresh
          console.warn(`Token-Refresh abgelehnt: Token ist ${hoursSinceExpiry.toFixed(2)} Stunden abgelaufen (max. 8 Stunden erlaubt)`);
          return res.status(401).json({ error: "Token zu alt für Refresh" });
        }
        
        // Token ist weniger als 8 Stunden abgelaufen - erlaube Refresh
        console.log(`Token-Refresh erlaubt: Token ist ${hoursSinceExpiry.toFixed(2)} Stunden abgelaufen (innerhalb der 8-Stunden-Toleranz)`);
        decoded = decoded.payload; // Verwende nur den Payload
      } else {
        // Anderer Fehler (z.B. invalid signature) - nicht erlauben
        throw verifyErr;
      }
    }
    
    // Stelle neues Token aus (immer 24 Stunden gültig)
    const newToken = signToken(decoded.sub);
    const expiresAt = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 Stunden in Sekunden (Unix timestamp)
    
    // WICHTIG: Extension erwartet Format { session: { access_token, expires_at } }
    // Aber auch Rückwärtskompatibilität: { access_token, expires_at } direkt
    return res.json({ 
      access_token: newToken, 
      expires_at: expiresAt,
      session: {
        access_token: newToken,
        expires_at: expiresAt
      }
    });
  } catch (err) {
    console.error("Refresh Fehler", err);
    return res.status(401).json({ error: "Token ungueltig" });
  }
});

module.exports = router;

