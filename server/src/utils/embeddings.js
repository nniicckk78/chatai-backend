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

  const doRequest = async () => {
    const truncatedText = text.substring(0, 8000);
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small', // Günstigste Option, sehr gut
      input: truncatedText
    });
    return response.data[0].embedding;
  };

  try {
    const embedding = await doRequest();
    embeddingsCache[textHash] = {
      embedding,
      text: text.substring(0, 8000),
      timestamp: Date.now()
    };
    setImmediate(() => saveCache());
    return embedding;
  } catch (err) {
    const status = err.status ?? err.response?.status;
    const isRetryable = (status === 500 || status === 502 || status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT');
    if (isRetryable) {
      console.warn('⚠️ Embedding fehlgeschlagen (retry in 2s):', err.message);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const embedding = await doRequest();
        embeddingsCache[textHash] = { embedding, text: text.substring(0, 8000), timestamp: Date.now() };
        setImmediate(() => saveCache());
        console.log('✅ Embedding nach Retry erfolgreich');
        return embedding;
      } catch (retryErr) {
        console.error('❌ Fehler beim Generieren von Embedding (nach Retry):', retryErr.message);
        return null;
      }
    }
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

// 🚨 NEU: Cache für statische Embeddings (Situationen, Themen)
// Diese ändern sich nie und sollten nur einmal generiert werden
let staticEmbeddingsCache = {
  situations: {},
  topics: {},
  initialized: false
};

// 🚨 NEU: Initialisiere statische Embeddings (einmalig beim Start)
// Nutzt bestehenden Cache, generiert nur wenn nicht vorhanden
async function initializeStaticEmbeddings() {
  if (staticEmbeddingsCache.initialized) {
    return staticEmbeddingsCache;
  }
  
  console.log('🔄 Initialisiere statische Embeddings (Situationen & Themen)...');
  
  // Situation-Beschreibungen
  const situationDescriptions = {
    "Treffen/Termine": "Der Kunde möchte sich treffen, ein Date vereinbaren, einen Termin ausmachen, sich persönlich kennenlernen",
    "Geld/Coins": "Der Kunde spricht über Kosten der Plattform, Coins, Credits, aufladen, zu teuer, woanders schreiben",
    "Sexuelle Themen": "Der Kunde spricht über Sex, sexuelle Vorlieben, Fantasien, intime Themen, erotische Inhalte",
    "Bilder Anfrage": "Der Kunde möchte ein Foto, Bild, oder Bild sehen, fragt nach Bildern",
    "Kontaktdaten außerhalb der Plattform": "Der Kunde möchte WhatsApp, Telegram, Instagram, Nummer, Kontaktdaten außerhalb der Plattform",
    "Bot-Vorwurf": "Der Kunde beschuldigt die Person, ein Bot, KI, Fake, automatisch, programmiert zu sein",
    "Standort": "Der Kunde fragt nach Wohnort, Stadt, wo wohnst du, woher kommst du",
    "Beruf": "Der Kunde fragt nach Beruf, Job, was arbeitest du, was machst du beruflich",
    "Wonach suchst du?": "Der Kunde fragt wonach die Person sucht, was sie sucht, was sie hier sucht"
  };
  
  // Themen-Beschreibungen
  const topicDescriptions = {
    'kaffee': "Kaffee, Kaffeetrinken, Kaffee trinken, Kaffee mit Milch, Kaffee trinken",
    'essen': "Essen, Kochen, Küche, kochen, italienisch kochen, kulinarisch",
    'kino': "Kino, Film, Filme, Serien, Filme schauen, ins Kino gehen",
    'musik': "Musik, Musik hören, Songs, Lieder, Musik hören",
    'sport': "Sport, Fitness, Training, Sport machen, Fitness machen",
    'buch': "Bücher, Lesen, Bücher lesen, lesen",
    'reisen': "Reisen, Urlaub, Reise, verreisen, Urlaub machen"
  };
  
  try {
    // 🚨 WICHTIG: Nutze getEmbedding, das bereits cached wird!
    // Generiere Situation-Embeddings (parallel, nutzt Cache)
    // 🚨 FIX: Fange Fehler pro Embedding ab, damit nicht alle fehlschlagen
    const situationPromises = Object.entries(situationDescriptions).map(async ([name, description]) => {
      try {
        // getEmbedding nutzt automatisch den Cache (embeddingsCache)
        const embedding = await getEmbedding(description);
        if (embedding) {
          staticEmbeddingsCache.situations[name] = embedding;
        }
        return { name, embedding };
      } catch (err) {
        // Einzelner Fehler blockiert nicht die gesamte Initialisierung
        console.warn(`⚠️ Fehler beim Generieren von Situation-Embedding für "${name}":`, err.message);
        return { name, embedding: null };
      }
    });
    
    await Promise.allSettled(situationPromises); // 🚨 FIX: allSettled statt all - fängt alle Fehler ab
    const situationCount = Object.keys(staticEmbeddingsCache.situations).length;
    if (situationCount > 0) {
      console.log(`✅ ${situationCount} Situation-Embeddings geladen/generiert`);
    } else {
      console.warn(`⚠️ Keine Situation-Embeddings generiert (möglicherweise Quota-Fehler - nicht kritisch, Service läuft trotzdem)`);
    }
    
    // Generiere Themen-Embeddings (parallel, nutzt Cache)
    // 🚨 FIX: Fange Fehler pro Embedding ab, damit nicht alle fehlschlagen
    const topicPromises = Object.entries(topicDescriptions).map(async ([name, description]) => {
      try {
        // getEmbedding nutzt automatisch den Cache (embeddingsCache)
        const embedding = await getEmbedding(description);
        if (embedding) {
          staticEmbeddingsCache.topics[name] = embedding;
        }
        return { name, embedding };
      } catch (err) {
        // Einzelner Fehler blockiert nicht die gesamte Initialisierung
        console.warn(`⚠️ Fehler beim Generieren von Themen-Embedding für "${name}":`, err.message);
        return { name, embedding: null };
      }
    });
    
    await Promise.allSettled(topicPromises); // 🚨 FIX: allSettled statt all - fängt alle Fehler ab
    const topicCount = Object.keys(staticEmbeddingsCache.topics).length;
    if (topicCount > 0) {
      console.log(`✅ ${topicCount} Themen-Embeddings geladen/generiert`);
    } else {
      console.warn(`⚠️ Keine Themen-Embeddings generiert (möglicherweise Quota-Fehler - nicht kritisch, Service läuft trotzdem)`);
    }
    
    staticEmbeddingsCache.initialized = true;
    const totalCount = situationCount + topicCount;
    if (totalCount > 0) {
      console.log('✅ Statische Embeddings initialisiert (werden bei jeder Nachricht wiederverwendet)');
    } else {
      console.warn('⚠️ Statische Embeddings konnten nicht initialisiert werden (Quota-Fehler oder andere Probleme). Service läuft trotzdem - Embeddings werden bei Bedarf generiert.');
    }
  } catch (err) {
    console.error('❌ Fehler beim Initialisieren der statischen Embeddings:', err.message);
    // Setze trotzdem auf initialisiert, um weitere Versuche zu vermeiden
    staticEmbeddingsCache.initialized = true;
    console.warn('⚠️ Service läuft trotzdem - Embeddings werden bei Bedarf generiert.');
  }
  
  return staticEmbeddingsCache;
}

// 🚨 NEU: Hole gecachtes Situation-Embedding
function getSituationEmbedding(situationName) {
  return staticEmbeddingsCache.situations[situationName] || null;
}

// 🚨 NEU: Hole gecachtes Themen-Embedding
function getTopicEmbedding(topicName) {
  return staticEmbeddingsCache.topics[topicName] || null;
}

// 🚨 NEU: Hole alle Situation-Embeddings
function getAllSituationEmbeddings() {
  return staticEmbeddingsCache.situations;
}

// 🚨 NEU: Hole alle Themen-Embeddings
function getAllTopicEmbeddings() {
  return staticEmbeddingsCache.topics;
}

module.exports = {
  getEmbedding,
  getEmbeddingsBatch,
  cosineSimilarity,
  findSimilarTexts,
  initializeStaticEmbeddings,
  getSituationEmbedding,
  getTopicEmbedding,
  getAllSituationEmbeddings,
  getAllTopicEmbeddings
};





