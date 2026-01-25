const OpenAI = require("openai");

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY fehlt – Antworten werden statisch generiert.");
    return null;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/** Lokale LoRA-API (z.B. LLaMA-Factory auf Mac Mini). OpenAI-kompatibel. */
function getLocalClient() {
  const url = process.env.LOCAL_LLM_URL;
  if (!url || typeof url !== "string" || !url.trim()) return null;
  let base = url.trim().replace(/\/$/, "");
  if (!base.endsWith("/v1")) base += "/v1";
  // 🚨 WICHTIG: Timeout für LoRA-KI erhöht (erste Anfrage kann 30-60 Sekunden dauern)
  return new OpenAI({ 
    apiKey: "0", 
    baseURL: base,
    timeout: 120000 // 120 Sekunden Timeout für LoRA-KI (erste Anfrage kann langsam sein)
  });
}

/** Client für Nachrichtengenerierung: Local LoRA, wenn USE_LOCAL_LLM=true, sonst OpenAI. */
function getMessageClient() {
  if (process.env.USE_LOCAL_LLM === "true" || process.env.USE_LOCAL_LLM === "1") {
    console.log("🔍 USE_LOCAL_LLM ist aktiviert - versuche LoRA-KI zu verwenden...");
    console.log("🔍 LOCAL_LLM_URL:", process.env.LOCAL_LLM_URL);
    const local = getLocalClient();
    if (local) {
      console.log("✅ LoRA-KI Client erstellt - verwende lokale LoRA-API");
      return local;
    } else {
      console.warn("⚠️ LoRA-KI Client konnte nicht erstellt werden - verwende OpenAI als Fallback");
    }
  } else {
    console.log("ℹ️ USE_LOCAL_LLM ist nicht aktiviert - verwende OpenAI");
  }
  return getClient();
}

/** Modellname für Nachrichtengenerierung (Local LoRA vs. OpenAI). */
function getMessageModel() {
  if (process.env.USE_LOCAL_LLM === "true" || process.env.USE_LOCAL_LLM === "1") {
    const url = process.env.LOCAL_LLM_URL;
    if (url && typeof url === "string" && url.trim()) {
      const model = process.env.LOCAL_LLM_MODEL || "meta-llama/Llama-3.1-8B-Instruct";
      console.log("🔍 Verwende LoRA-Modell:", model);
      return model;
    }
  }
  const model = process.env.AI_MODEL || "gpt-4o-mini";
  console.log("🔍 Verwende OpenAI-Modell:", model);
  return model;
}

module.exports = { getClient, getLocalClient, getMessageClient, getMessageModel };

