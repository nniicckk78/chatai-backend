/**
 * VEKTOR-DATENBANK FÜR TRAINING-DATEN
 * 
 * Speichert Training-Daten mit Embeddings und ermöglicht semantische Suche.
 * Verwendet Embeddings-System für bessere Relevanz als Keyword-Matching.
 */

const { getEmbedding, cosineSimilarity } = require('./embeddings');
const fs = require('fs');
const path = require('path');
const { getGitHubClient, getRepoInfo } = require('./github');

// Cache für Vektor-Datenbank
const vectorDbPath = path.join(__dirname, '../../config/vector-db.json');
let vectorDb = {
  conversations: [], // Array von { text, embedding, metadata }
  lastUpdated: null,
  version: 1
};

// Lade Vektor-DB
async function loadVectorDb() {
  // PRIORITÄT 1: Lade von GitHub
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/vector-db.json',
        'src/config/vector-db.json',
        'config/vector-db.json',
        'server/config/vector-db.json'
      ];
      
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          if (response.data && response.data.content) {
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            const parsed = JSON.parse(content);
            vectorDb = parsed;
            console.log(`✅ Vektor-DB von GitHub geladen: ${vectorDb.conversations.length} Einträge`);
            return vectorDb;
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Laden der Vektor-DB von GitHub:', err.message);
    }
  }

  // Fallback: Lokale Datei
  try {
    if (fs.existsSync(vectorDbPath)) {
      const content = fs.readFileSync(vectorDbPath, 'utf8');
      vectorDb = JSON.parse(content);
      console.log(`✅ Vektor-DB von lokaler Datei geladen: ${vectorDb.conversations.length} Einträge`);
      return vectorDb;
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Laden der lokalen Vektor-DB:', err.message);
  }

  return vectorDb;
}

// Speichere Vektor-DB
async function saveVectorDb(pushToGitHub = false) {
  try {
    const dbDir = path.dirname(vectorDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    vectorDb.lastUpdated = new Date().toISOString();
    fs.writeFileSync(vectorDbPath, JSON.stringify(vectorDb, null, 2));

    // Push zu GitHub (optional)
    if (pushToGitHub) {
      const { pushFileToGitHub } = require('./github');
      try {
        await pushFileToGitHub(
          'server/src/config/vector-db.json',
          JSON.stringify(vectorDb, null, 2),
          'Update vector database (Embeddings für Training-Daten)'
        );
        console.log('✅ Vektor-DB zu GitHub gepusht');
      } catch (err) {
        console.warn('⚠️ Fehler beim Pushen der Vektor-DB zu GitHub:', err.message);
      }
    }
  } catch (err) {
    console.error('❌ Fehler beim Speichern der Vektor-DB:', err.message);
  }
}

// Indexiere Training-Daten (generiere Embeddings)
async function indexTrainingData(trainingData) {
  console.log('🔄 Indexiere Training-Daten mit Embeddings...');
  
  const conversations = trainingData.conversations || [];
  const indexed = [];

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    if (!conv.customerMessage || !conv.moderatorResponse) {
      continue;
    }

    // Kombiniere Kundennachricht + Moderator-Antwort für bessere Suche
    const combinedText = `${conv.customerMessage} ${conv.moderatorResponse}`;
    
    // Generiere Embedding
    const embedding = await getEmbedding(combinedText);
    if (!embedding) {
      console.warn(`⚠️ Konnte Embedding nicht generieren für: ${combinedText.substring(0, 50)}...`);
      continue;
    }

    indexed.push({
      text: combinedText,
      embedding,
      metadata: {
        customerMessage: conv.customerMessage,
        moderatorResponse: conv.moderatorResponse,
        situation: conv.situation || 'allgemein',
        priority: conv.priority || false,
        source: conv.source || 'training-data',
        index: i
      }
    });

    // Progress-Log
    if ((i + 1) % 10 === 0) {
      console.log(`  📊 ${i + 1}/${conversations.length} indiziert...`);
    }

    // Kleine Pause (Rate-Limiting)
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  vectorDb.conversations = indexed;
  vectorDb.lastUpdated = new Date().toISOString();
  
  console.log(`✅ ${indexed.length} Training-Daten indiziert`);
  return vectorDb;
}

// Suche ähnliche Training-Daten-Beispiele (semantisch)
async function findSimilarExamples(queryText, options = {}) {
  const {
    topK = 20,
    minSimilarity = 0.3,
    situation = null,
    includeSexual = true
  } = options;

  // Lade Vektor-DB falls noch nicht geladen
  if (vectorDb.conversations.length === 0) {
    await loadVectorDb();
  }

  // Generiere Embedding für Query
  const queryEmbedding = await getEmbedding(queryText);
  if (!queryEmbedding) {
    console.warn('⚠️ Konnte Embedding für Query nicht generieren');
    return [];
  }

  // Berechne Ähnlichkeiten
  const similarities = vectorDb.conversations
    .map((item, idx) => {
      if (!item.embedding) {
        return { similarity: 0, index: idx, item };
      }

      // Filter: Situation
      if (situation && item.metadata.situation !== situation) {
        return null;
      }

      // Filter: Sexuelle Themen (wenn nicht gewünscht)
      if (!includeSexual && item.metadata.situation && 
          item.metadata.situation.toLowerCase().includes('sexuell')) {
        return null;
      }

      const similarity = cosineSimilarity(queryEmbedding, item.embedding);
      return { similarity, index: idx, item };
    })
    .filter(result => result !== null && result.similarity >= minSimilarity);

  // Sortiere nach Ähnlichkeit
  similarities.sort((a, b) => b.similarity - a.similarity);

  // Nimm Top K
  const topResults = similarities.slice(0, topK);

  // Konvertiere zurück zu Training-Daten-Format
  return topResults.map(result => ({
    customerMessage: result.item.metadata.customerMessage,
    moderatorResponse: result.item.metadata.moderatorResponse,
    situation: result.item.metadata.situation,
    priority: result.item.metadata.priority,
    source: result.item.metadata.source,
    similarity: result.similarity
  }));
}

// Initialisiere Vektor-DB (beim Server-Start)
async function initializeVectorDb(trainingData) {
  // Prüfe ob bereits indiziert
  if (vectorDb.conversations.length > 0) {
    console.log(`✅ Vektor-DB bereits initialisiert: ${vectorDb.conversations.length} Einträge`);
    return vectorDb;
  }

  // Lade von GitHub/lokal
  await loadVectorDb();

  // Wenn noch leer, indexiere Training-Daten
  if (vectorDb.conversations.length === 0 && trainingData) {
    console.log('🔄 Vektor-DB ist leer - starte Indexierung...');
    await indexTrainingData(trainingData);
    await saveVectorDb(false); // Speichere lokal, aber nicht auf GitHub (zu groß)
  }

  return vectorDb;
}

module.exports = {
  loadVectorDb,
  saveVectorDb,
  indexTrainingData,
  findSimilarExamples,
  initializeVectorDb
};

