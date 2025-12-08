const express = require("express");
const { getClient } = require("../openaiClient");
const { verifyToken } = require("../auth");

const router = express.Router();

// simple JWT middleware
router.use((req, res, next) => {
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
    return res.status(401).json({ error: "Token ungueltig" });
  }
});

function isMinorMention(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.includes("minderjähr")) return true;
  // naive Alterspruefung auf 10-17
  const ageMatch = lower.match(/\b(1[0-7])\b/);
  return Boolean(ageMatch);
}

router.post("/", async (req, res) => {
  const { messageText = "", pageUrl, platformId, assetsToSend, userProfile } = req.body || {};

  if (isMinorMention(messageText)) {
    return res.json({
      flags: { blocked: true, reason: "minor" },
      actions: []
    });
  }

  const client = getClient();
  let replyText = "Hi, ich antworte gleich freundlich und knapp.";

  if (client) {
    try {
      const systemPrompt =
        "Du bist ein höflicher, knapper Chat-Moderator. Keine Fotos/Nummern anfordern, keine Off-Plattform-Kontakte. Schreibe kurz.";
      const userPrompt = `Nachricht: ${messageText}\nPlattform: ${platformId || "unbekannt"}\nURL: ${pageUrl || "unbekannt"}`;

      const chat = await client.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 150,
        temperature: 0.7
      });
      replyText = chat.choices?.[0]?.message?.content?.trim() || replyText;
    } catch (err) {
      console.error("OpenAI Fehler", err);
      // fallback bleibt replyText
    }
  }

  return res.json({
    replyText,
    actions: [
      {
        type: "insert_and_send"
      }
    ],
    assets: assetsToSend || [],
    flags: { blocked: false }
  });
});

module.exports = router;

