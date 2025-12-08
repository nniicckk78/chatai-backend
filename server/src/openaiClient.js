const OpenAI = require("openai");

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY fehlt – Antworten werden statisch generiert.");
    return null;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

module.exports = { getClient };

