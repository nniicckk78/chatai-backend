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
const { pool } = require('../db');

// Cache für Vektor-Datenbank
const vectorDbPath = path.join(__dirname, '../../config/vector-db.json');
let vectorDb = {
  conversations: [], // Array von { text, embedding, metadata }
  lastUpdated: null,
  version: 1
};

// Lade Vektor-DB
async function loadVectorDb() {
  // PRIORITÄT 1: Lade von PostgreSQL-Datenbank (persistent zwischen Deploys)
  if (pool) {
    try {
      const result = await pool.query(`
        SELECT data, last_updated, version 
        FROM vector_db 
        ORDER BY id DESC 
        LIMIT 1
      `);
      
      if (result.rows.length > 0) {
        // PostgreSQL gibt JSONB als Objekt zurück, aber prüfe ob es korrekt ist
        const dbData = result.rows[0].data;
        if (dbData && typeof dbData === 'object' && Array.isArray(dbData.conversations)) {
          vectorDb = dbData;
          console.log(`✅ Vektor-DB von PostgreSQL geladen: ${vectorDb.conversations.length} Einträge (Version ${result.rows[0].version}, Updated: ${result.rows[0].last_updated})`);
          return vectorDb;
        } else {
          console.warn('⚠️ Vektor-DB Daten aus PostgreSQL haben falsches Format, verwende Fallback');
        }
      }
    } catch (err) {
      // Tabelle existiert noch nicht - wird bei Migration erstellt
      if (err.code !== '42P01') { // 42P01 = table does not exist
        console.warn('⚠️ Fehler beim Laden der Vektor-DB von PostgreSQL:', err.message);
      }
    }
  }

  // PRIORITÄT 2: Lade von GitHub (Fallback)
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
            // Speichere in DB für nächsten Start
            await saveVectorDb(false);
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

  // PRIORITÄT 3: Fallback: Lokale Datei
  try {
    if (fs.existsSync(vectorDbPath)) {
      const content = fs.readFileSync(vectorDbPath, 'utf8');
      vectorDb = JSON.parse(content);
      console.log(`✅ Vektor-DB von lokaler Datei geladen: ${vectorDb.conversations.length} Einträge`);
      // Speichere in DB für nächsten Start
      if (pool) {
        await saveVectorDb(false);
      }
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
    vectorDb.lastUpdated = new Date().toISOString();
    
    // PRIORITÄT 1: Speichere in PostgreSQL-Datenbank (persistent zwischen Deploys)
    if (pool) {
      try {
        // Lösche alte Einträge und füge neuen hinzu
        await pool.query('DELETE FROM vector_db');
        await pool.query(`
          INSERT INTO vector_db (data, last_updated, version)
          VALUES ($1, NOW(), $2)
        `, [JSON.stringify(vectorDb), vectorDb.version || 1]);
        console.log('✅ Vektor-DB in PostgreSQL gespeichert');
      } catch (err) {
        // Tabelle existiert noch nicht - wird bei Migration erstellt
        if (err.code !== '42P01') { // 42P01 = table does not exist
          console.warn('⚠️ Fehler beim Speichern der Vektor-DB in PostgreSQL:', err.message);
        }
      }
    }
    
    // PRIORITÄT 2: Speichere lokal als Fallback
    try {
      const dbDir = path.dirname(vectorDbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      fs.writeFileSync(vectorDbPath, JSON.stringify(vectorDb, null, 2));
    } catch (err) {
      console.warn('⚠️ Fehler beim Speichern der lokalen Vektor-DB:', err.message);
    }

    // Push zu GitHub (optional, nur wenn explizit gewünscht)
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

    // 🚨 WICHTIG: Kombiniere Kundennachricht + Moderator-Antwort + ALLE Situationen für bessere Suche
    // Das verbessert die semantische Ähnlichkeit erheblich!
    let combinedText = conv.customerMessage;
    if (conv.moderatorResponse) {
      combinedText += ` ${conv.moderatorResponse}`;
    }
    
    // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
    let situationsArray = [];
    if (conv.situations && Array.isArray(conv.situations) && conv.situations.length > 0) {
      situationsArray = conv.situations;
    } else if (conv.situation && conv.situation !== 'allgemein') {
      if (conv.situation.includes(',')) {
        situationsArray = conv.situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
      } else {
        situationsArray = [conv.situation];
      }
    }
    
    if (situationsArray.length > 0) {
      combinedText = `${situationsArray.join(' + ')}: ${combinedText}`;
    }
    
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
        situation: conv.situation || 'allgemein', // String für Kompatibilität
        situations: situationsArray.length > 0 ? situationsArray : (conv.situation ? [conv.situation] : ['allgemein']), // 🚨 NEU: Array für bessere Verarbeitung
        priority: conv.priority || false,
        source: conv.source || 'training-data',
        index: i
      }
    });

    // Progress-Log: Nur alle 25 Einträge oder am Ende
    if ((i + 1) % 25 === 0 || i === conversations.length - 1) {
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
      // 🚨 KRITISCH: Null-Check für metadata (verhindert "Cannot read properties of undefined")
      if (!item || !item.embedding || !item.metadata) {
        return null; // Überspringe ungültige Einträge
      }

      // 🚨 WICHTIG: Filter: Situation (unterstützt mehrere Situationen)
      if (situation) {
        // Prüfe sowohl String als auch Array
        const itemSituations = item.metadata.situations && Array.isArray(item.metadata.situations) 
          ? item.metadata.situations 
          : (item.metadata.situation ? (item.metadata.situation.includes(',') ? item.metadata.situation.split(',').map(s => s.trim()) : [item.metadata.situation]) : []);
        
        // Wenn eine einzelne Situation gefiltert wird, prüfe ob sie in den Situationen enthalten ist
        if (!itemSituations.includes(situation)) {
          return null;
        }
      }

      // Filter: Sexuelle Themen (wenn nicht gewünscht)
      if (!includeSexual) {
        const itemSituations = item.metadata.situations && Array.isArray(item.metadata.situations) 
          ? item.metadata.situations 
          : (item.metadata.situation ? (item.metadata.situation.includes(',') ? item.metadata.situation.split(',').map(s => s.trim()) : [item.metadata.situation]) : []);
        
        const hasSexualSituation = itemSituations.some(s => s.toLowerCase().includes('sexuell')) ||
                                   (item.metadata.situation && item.metadata.situation.toLowerCase().includes('sexuell'));
        
        if (hasSexualSituation) {
          return null;
        }
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
    similarity: result.similarity,
    feedbackId: result.item.metadata.feedbackId || null, // 🚨 NEU: Feedback-ID falls vorhanden
    index: result.item.metadata.index || null // 🚨 NEU: Index für Training-Daten
  }));
}

// Initialisiere Vektor-DB (beim Server-Start)
async function initializeVectorDb(trainingData) {
  // Lade von GitHub/lokal/PostgreSQL
  await loadVectorDb();
  
  const currentCount = vectorDb.conversations.length;
  const trainingDataCount = trainingData?.conversations?.length || 0;

  // 🚨 KRITISCH: Prüfe ob neue Training-Daten hinzugekommen sind!
  // Wenn Training-Daten mehr sind als Vektor-DB Einträge, muss neu indiziert werden!
  if (currentCount > 0 && trainingDataCount > currentCount) {
    console.log(`🔄 Vektor-DB veraltet: ${currentCount} Einträge, aber ${trainingDataCount} Training-Daten vorhanden - starte Neu-Indexierung...`);
    // Lösche alte Vektor-DB und indexiere neu
    vectorDb.conversations = [];
    await indexTrainingData(trainingData);
    await saveVectorDb(false); // Speichere in PostgreSQL (und lokal als Fallback), aber nicht auf GitHub (zu groß)
    console.log(`✅ Vektor-DB Neu-Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge (vorher: ${currentCount})`);
    return vectorDb;
  }

  // Wenn bereits indiziert und aktuell, nichts tun
  if (currentCount > 0) {
    console.log(`✅ Vektor-DB bereits initialisiert: ${currentCount} Einträge (Training-Daten: ${trainingDataCount})`);
    return vectorDb;
  }

  // Wenn noch leer, indexiere Training-Daten
  if (currentCount === 0 && trainingData && trainingDataCount > 0) {
    console.log('🔄 Vektor-DB ist leer - starte Indexierung...');
    await indexTrainingData(trainingData);
    await saveVectorDb(false); // Speichere in PostgreSQL (und lokal als Fallback), aber nicht auf GitHub (zu groß)
    console.log(`✅ Vektor-DB Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge`);
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

