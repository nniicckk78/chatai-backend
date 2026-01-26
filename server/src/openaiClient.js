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
  // 🚨 WICHTIG: Timeout für LoRA-KI auf CPU (2 Minuten max, dann Fallback zu OpenAI)
  return new OpenAI({ 
    apiKey: "0", 
    baseURL: base,
    timeout: 120000 // 120 Sekunden (2 Minuten) Timeout für LoRA-KI auf CPU
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

/** Together.ai Client (OpenAI-kompatibel, aber mit Together.ai baseURL). */
function getTogetherClient() {
  if (!process.env.TOGETHER_API_KEY) {
    return null;
  }
  return new OpenAI({
    apiKey: process.env.TOGETHER_API_KEY,
    baseURL: "https://api.together.xyz/v1"
  });
}

/** Modellname für Nachrichtengenerierung (Local LoRA vs. Together.ai vs. OpenAI). */
function getMessageModel() {
  // 🚀 Together.ai hat Priorität (wenn aktiviert)
  if (process.env.USE_TOGETHER_AI === "true" || process.env.USE_TOGETHER_AI === "1") {
    const model = process.env.TOGETHER_MODEL_ID || "meta-llama/Llama-3.1-8B-Instruct";
    console.log("🔍 Verwende Together.ai Modell:", model);
    return model;
  }
  
  // Lokale LoRA (wenn aktiviert)
  if (process.env.USE_LOCAL_LLM === "true" || process.env.USE_LOCAL_LLM === "1") {
    const url = process.env.LOCAL_LLM_URL;
    if (url && typeof url === "string" && url.trim()) {
      const model = process.env.LOCAL_LLM_MODEL || "meta-llama/Llama-3.1-8B-Instruct";
      console.log("🔍 Verwende LoRA-Modell:", model);
      return model;
    }
  }
  
  // Standard: OpenAI
  const model = process.env.AI_MODEL || "gpt-4o-mini";
  console.log("🔍 Verwende OpenAI-Modell:", model);
  return model;
}

/** Client für Nachrichtengenerierung: Together.ai > Local LoRA > OpenAI. */
function getMessageClient() {
  // 🚀 Together.ai hat Priorität (wenn aktiviert)
  if (process.env.USE_TOGETHER_AI === "true" || process.env.USE_TOGETHER_AI === "1") {
    console.log("🔍 USE_TOGETHER_AI ist aktiviert - versuche Together.ai zu verwenden...");
    const together = getTogetherClient();
    if (together) {
      console.log("✅ Together.ai Client erstellt - verwende Together.ai Fine-Tuned Model");
      return together;
    } else {
      console.warn("⚠️ Together.ai Client konnte nicht erstellt werden - verwende Fallback");
    }
  }
  
  // Lokale LoRA (wenn aktiviert)
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

module.exports = { getClient, getLocalClient, getTogetherClient, getMessageClient, getMessageModel };

