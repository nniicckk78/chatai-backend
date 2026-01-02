/**
 * EMBEDDINGS-SYSTEM
 * 
 * Generiert Embeddings (Vektoren) für Texte, um semantische Ähnlichkeit zu finden.
 * Verwendet OpenAI Embeddings API (sehr günstig: ~$0.0001 pro 1K Tokens).
 */

const { getClient } = require('../openaiClient');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cache für Embeddings (um API-Calls zu sparen)
const embeddingsCachePath = path.join(__dirname, '../../config/embeddings-cache.json');
let embeddingsCache = {};

// Lade Cache beim Start
try {
  if (fs.existsSync(embeddingsCachePath)) {
    const cacheContent = fs.readFileSync(embeddingsCachePath, 'utf8');
    embeddingsCache = JSON.parse(cacheContent);
    console.log(`✅ Embeddings-Cache geladen: ${Object.keys(embeddingsCache).length} Einträge`);
  }
} catch (err) {
  console.warn('⚠️ Fehler beim Laden des Embeddings-Cache:', err.message);
  embeddingsCache = {};
}

// Speichere Cache (asynchron, blockiert nicht)
function saveCache() {
  try {
    const cacheDir = path.dirname(embeddingsCachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(embeddingsCachePath, JSON.stringify(embeddingsCache, null, 2));
  } catch (err) {
    console.warn('⚠️ Fehler beim Speichern des Embeddings-Cache:', err.message);
  }
}

// Generiere Hash für Text (für Cache-Key)
function hashText(text) {
  return crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex');
}

// Generiere Embedding für einen Text
async function getEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  // Prüfe Cache
  const textHash = hashText(text);
  if (embeddingsCache[textHash]) {
    return embeddingsCache[textHash].embedding;
  }

  // Generiere Embedding via OpenAI
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Embeddings können nicht generiert werden');
    return null;
  }

  try {
    // Maximal 8000 Tokens (OpenAI Embeddings Limit)
    const truncatedText = text.substring(0, 8000);
    
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small', // Günstigste Option, sehr gut
      input: truncatedText
    });

    const embedding = response.data[0].embedding;

    // Speichere im Cache
    embeddingsCache[textHash] = {
      embedding,
      text: truncatedText,
      timestamp: Date.now()
    };

    // Speichere Cache (asynchron)
    setImmediate(() => saveCache());

    return embedding;
  } catch (err) {
    console.error('❌ Fehler beim Generieren von Embedding:', err.message);
    return null;
  }
}

// Generiere Embeddings für mehrere Texte (Batch)
async function getEmbeddingsBatch(texts) {
  const embeddings = [];
  for (const text of texts) {
    const embedding = await getEmbedding(text);
    embeddings.push(embedding);
    // Kleine Pause zwischen API-Calls (Rate-Limiting)
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return embeddings;
}

// Berechne Cosinus-Ähnlichkeit zwischen zwei Vektoren
function cosineSimilarity(vec1, vec2) {
  if (!vec1 || !vec2 || vec1.length !== vec2.length) {
    return 0;
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }

  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

// Finde ähnliche Texte basierend auf Embeddings
async function findSimilarTexts(queryText, candidateTexts, topK = 10) {
  const queryEmbedding = await getEmbedding(queryText);
  if (!queryEmbedding) {
    return [];
  }

  // Generiere Embeddings für alle Kandidaten (mit Cache)
  const candidateEmbeddings = await Promise.all(
    candidateTexts.map(text => getEmbedding(text))
  );

  // Berechne Ähnlichkeiten
  const similarities = candidateTexts.map((text, idx) => {
    const embedding = candidateEmbeddings[idx];
    if (!embedding) {
      return { text, similarity: 0, index: idx };
    }
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    return { text, similarity, index: idx };
  });

  // Sortiere nach Ähnlichkeit (höchste zuerst)
  similarities.sort((a, b) => b.similarity - a.similarity);

  // Nimm Top K
  return similarities.slice(0, topK);
}

module.exports = {
  getEmbedding,
  getEmbeddingsBatch,
  cosineSimilarity,
  findSimilarTexts
};

