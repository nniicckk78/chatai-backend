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
const crypto = require('crypto');
let vectorDb = {
  conversations: [], // Array von { text, embedding, metadata }
  lastUpdated: null,
  version: 1,
  trainingDataHash: null // 🚨 NEU: Hash der Training-Daten, um zu prüfen ob sich etwas geändert hat
};

// Lade Vektor-DB
async function loadVectorDb() {
  console.log('🔄 Lade Vektor-DB...');
  
  // PRIORITÄT 1: Lade von PostgreSQL-Datenbank (persistent zwischen Deploys)
  if (pool) {
    try {
      console.log('🔍 Versuche Vektor-DB von PostgreSQL zu laden...');
      const result = await pool.query(`
        SELECT data, last_updated, version 
        FROM vector_db 
        ORDER BY id DESC 
        LIMIT 1
      `);
      
      if (result.rows.length > 0) {
        console.log(`📊 PostgreSQL-Query erfolgreich: ${result.rows.length} Zeile(n) gefunden`);
        // PostgreSQL gibt JSONB als Objekt zurück, aber prüfe ob es korrekt ist
        let dbData = result.rows[0].data;
        
        // 🚨 KRITISCH: Wenn dbData ein String ist, parse es zu JSON
        if (typeof dbData === 'string') {
          try {
            dbData = JSON.parse(dbData);
            console.log('✅ PostgreSQL-Daten von String zu JSON geparst');
          } catch (parseErr) {
            console.warn('⚠️ Fehler beim Parsen der PostgreSQL-Daten:', parseErr.message);
            dbData = null;
          }
        }
        
        // Prüfe ob dbData korrekt ist
        if (dbData && typeof dbData === 'object') {
          // Prüfe ob conversations vorhanden ist (kann Array oder undefined sein)
          if (Array.isArray(dbData.conversations)) {
            vectorDb = dbData;
            console.log(`✅ Vektor-DB von PostgreSQL geladen: ${vectorDb.conversations.length} Einträge (Version ${result.rows[0].version || 'unbekannt'}, Updated: ${result.rows[0].last_updated || 'unbekannt'}, Hash: ${vectorDb.trainingDataHash?.substring(0, 8) || 'kein'})`);
            return vectorDb;
          } else {
            console.warn(`⚠️ Vektor-DB Daten aus PostgreSQL haben kein conversations-Array (Typ: ${typeof dbData.conversations}), verwende Fallback`);
            console.warn(`   Verfügbare Keys: ${Object.keys(dbData).join(', ')}`);
          }
        } else {
          console.warn(`⚠️ Vektor-DB Daten aus PostgreSQL haben falsches Format (Typ: ${typeof dbData}), verwende Fallback`);
        }
      } else {
        console.log('📊 PostgreSQL-Query erfolgreich, aber keine Daten gefunden (Tabelle leer)');
      }
    } catch (err) {
      // Tabelle existiert noch nicht - wird bei Migration erstellt
      if (err.code === '42P01') { // 42P01 = table does not exist
        console.log('📊 PostgreSQL-Tabelle "vector_db" existiert noch nicht (wird bei Migration erstellt)');
      } else {
        console.warn('⚠️ Fehler beim Laden der Vektor-DB von PostgreSQL:', err.message);
        console.warn(`   Error Code: ${err.code}, Detail: ${err.detail || 'keine Details'}`);
      }
    }
  } else {
    console.log('⚠️ PostgreSQL-Pool nicht verfügbar - überspringe PostgreSQL-Laden');
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
    console.log(`🔍 Versuche Vektor-DB von lokaler Datei zu laden: ${vectorDbPath}`);
    if (fs.existsSync(vectorDbPath)) {
      const content = fs.readFileSync(vectorDbPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.conversations)) {
        vectorDb = parsed;
        console.log(`✅ Vektor-DB von lokaler Datei geladen: ${vectorDb.conversations.length} Einträge (Hash: ${vectorDb.trainingDataHash?.substring(0, 8) || 'kein'})`);
        // Speichere in DB für nächsten Start
        if (pool) {
          await saveVectorDb(false);
        }
        return vectorDb;
      } else {
        console.warn('⚠️ Lokale Vektor-DB-Datei hat falsches Format (kein conversations-Array)');
      }
    } else {
      console.log(`⚠️ Lokale Vektor-DB-Datei existiert nicht: ${vectorDbPath}`);
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Laden der lokalen Vektor-DB:', err.message);
  }

  console.log(`⚠️ Vektor-DB konnte von keiner Quelle geladen werden - verwende leere DB (${vectorDb.conversations.length} Einträge)`);
  return vectorDb;
}

// Speichere Vektor-DB
async function saveVectorDb(pushToGitHub = false) {
  let postgresSuccess = false;
  let localSuccess = false;
  
  try {
    vectorDb.lastUpdated = new Date().toISOString();
    
    // PRIORITÄT 1: Speichere in PostgreSQL-Datenbank (persistent zwischen Deploys)
    if (pool) {
      // 🚨 NEU: Retry-Mechanismus für robuste Speicherung
      // 🆕 ERHÖHT: Mehr Retries für Recovery Mode (DB startet manchmal länger)
      const maxRetries = 5; // Erhöht von 3 auf 5 für Recovery Mode
      let retryCount = 0;
      let lastError = null;
      
      while (retryCount < maxRetries && !postgresSuccess) {
        try {
          console.log(`💾 Speichere Vektor-DB in PostgreSQL (${vectorDb.conversations.length} Einträge, Hash: ${vectorDb.trainingDataHash?.substring(0, 8) || 'kein'})...${retryCount > 0 ? ` (Versuch ${retryCount + 1}/${maxRetries})` : ''}`);
          
          // 🚨 KRITISCH: Stelle sicher, dass vectorDb ein vollständiges Objekt ist
          const dataToSave = {
            conversations: vectorDb.conversations || [],
            lastUpdated: vectorDb.lastUpdated || new Date().toISOString(),
            version: vectorDb.version || 1,
            trainingDataHash: vectorDb.trainingDataHash || null
          };
          
          // 🚨 NEU: Health-Check vor kritischen Operationen (verhindert Fehler bei DB-Startup)
          try {
            await pool.query('SELECT 1'); // Einfacher Health-Check
          } catch (healthErr) {
            if (healthErr.code === '57P03' || healthErr.message?.includes('recovery mode')) {
              throw healthErr; // Wird vom Retry-Mechanismus behandelt
            }
            // Andere Fehler: Weiter mit normalem Connect
          }
          
          // 🚨 NEU: Verwende einen eigenen Client für diese Transaktion (verhindert Connection-Probleme)
          const client = await pool.connect();
          
          // 🚨 KRITISCH: Error-Event-Handler hinzufügen, um unhandled errors zu verhindern
          const errorHandler = (err) => {
            console.warn('⚠️ PostgreSQL Client Error Event:', err.message);
            // Verhindere, dass der Fehler den Prozess crasht
          };
          client.on('error', errorHandler);
          
          try {
            // Beginne Transaktion
            await client.query('BEGIN');
            
            // Lösche alte Einträge
            await client.query('DELETE FROM vector_db');
            
            // Füge neuen Eintrag hinzu
            await client.query(`
              INSERT INTO vector_db (data, last_updated, version)
              VALUES ($1::jsonb, NOW(), $2)
            `, [JSON.stringify(dataToSave), dataToSave.version]);
            
            // Commit Transaktion
            await client.query('COMMIT');
            
            postgresSuccess = true;
            console.log(`✅ Vektor-DB in PostgreSQL gespeichert: ${dataToSave.conversations.length} Einträge, Version ${dataToSave.version}, Hash ${dataToSave.trainingDataHash?.substring(0, 8) || 'kein'}`);
          } catch (queryErr) {
            // Rollback bei Fehler
            try {
              await client.query('ROLLBACK');
            } catch (rollbackErr) {
              // Ignoriere Rollback-Fehler
            }
            throw queryErr;
          } finally {
            // WICHTIG: Error-Handler entfernen und Client immer freigeben
            client.removeListener('error', errorHandler);
            client.release();
          }
        } catch (err) {
          lastError = err;
          retryCount++;
          
          // Tabelle existiert noch nicht - wird bei Migration erstellt
          if (err.code === '42P01') { // 42P01 = table does not exist
            console.log('📊 PostgreSQL-Tabelle "vector_db" existiert noch nicht (wird bei Migration erstellt)');
            break; // Keine Retries bei fehlender Tabelle
          } else {
            // 🆕 NEU: Spezielle Behandlung für "recovery mode" (57P03)
            const isRecoveryMode = err.code === '57P03' || err.message?.includes('recovery mode');
            const isConnectionError = err.message && (
              err.message.includes('Connection terminated') || 
              err.message.includes('connection') || 
              err.message.includes('ECONNRESET') ||
              err.message.includes('Connection closed') ||
              err.code === 'ECONNRESET' ||
              err.code === 'ECONNREFUSED'
            );
            
            // 🆕 VERBESSERT: Bei Recovery Mode: Längere Wartezeit mit exponentieller Backoff (DB startet gerade neu)
            if (isRecoveryMode) {
              if (retryCount < maxRetries) {
                // Exponentieller Backoff: 10s, 15s, 20s, 25s, 30s (max 30s)
                const delay = Math.min(10000 + (retryCount * 5000), 30000);
                console.warn(`⚠️ PostgreSQL im Recovery Mode (Versuch ${retryCount + 1}/${maxRetries}): ${err.message}`);
                console.warn(`   Datenbank startet gerade neu - warte ${delay}ms vor erneutem Versuch...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue; // Retry
              } else {
                console.error('❌ PostgreSQL Recovery Mode: Datenbank startet zu lange - verwende lokalen Fallback');
                console.error(`   Error Code: ${err.code}, Detail: ${err.detail || 'keine Details'}`);
                break; // Keine weiteren Retries
              }
            } else if (isConnectionError && retryCount < maxRetries) {
              // Exponentieller Backoff für Connection Errors: 2s, 4s, 6s, 8s, 10s
              const delay = Math.min(2000 + (retryCount * 2000), 10000);
              console.warn(`⚠️ PostgreSQL-Verbindungsfehler (Versuch ${retryCount + 1}/${maxRetries}): ${err.message}`);
              console.warn(`   Warte ${delay}ms vor erneutem Versuch...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue; // Retry
            } else {
              console.warn('⚠️ Fehler beim Speichern der Vektor-DB in PostgreSQL:', err.message);
              console.warn(`   Error Code: ${err.code || 'undefined'}, Detail: ${err.detail || 'keine Details'}`);
              if (isConnectionError) {
                console.warn('⚠️ PostgreSQL-Verbindung unterbrochen - verwende lokalen Fallback');
              }
              break; // Keine weiteren Retries
            }
          }
        }
      }
      
      if (!postgresSuccess && lastError) {
        console.warn(`⚠️ Vektor-DB konnte nach ${retryCount} Versuchen nicht in PostgreSQL gespeichert werden`);
      }
    } else {
      console.log('⚠️ PostgreSQL-Pool nicht verfügbar - überspringe PostgreSQL-Speicherung');
    }
    
    // PRIORITÄT 2: Speichere lokal als Fallback (IMMER, auch wenn PostgreSQL erfolgreich war)
    try {
      const dbDir = path.dirname(vectorDbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      fs.writeFileSync(vectorDbPath, JSON.stringify(vectorDb, null, 2));
      localSuccess = true;
      if (!postgresSuccess) {
        console.log('✅ Vektor-DB lokal gespeichert (PostgreSQL-Fallback)');
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Speichern der lokalen Vektor-DB:', err.message);
    }
    
    // 🚨 NEU: Warnung wenn beide fehlgeschlagen sind
    if (!postgresSuccess && !localSuccess) {
      console.error('❌ KRITISCH: Vektor-DB konnte weder in PostgreSQL noch lokal gespeichert werden!');
      throw new Error('Vektor-DB Speicherung fehlgeschlagen');
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
    
    // 🚨 NEU: Return-Objekt mit Status
    return {
      postgresSuccess,
      localSuccess,
      success: postgresSuccess || localSuccess
    };
  } catch (err) {
    console.error('❌ Fehler beim Speichern der Vektor-DB:', err.message);
    return {
      postgresSuccess: false,
      localSuccess: false,
      success: false
    };
  }
}

// Berechne Hash der Training-Daten (um zu prüfen ob sich etwas geändert hat)
function calculateTrainingDataHash(trainingData) {
  const conversations = trainingData?.conversations || [];
  // Erstelle einen String-Repräsentation der Training-Daten (nur IDs/Keys, nicht die kompletten Daten)
  const dataString = JSON.stringify(conversations.map(c => ({
    customer: c.customerMessage?.substring(0, 50) || '',
    moderator: c.moderatorResponse?.substring(0, 50) || '',
    situation: c.situation || '',
    priority: c.priority || false
  })));
  // Berechne SHA256-Hash
  return crypto.createHash('sha256').update(dataString).digest('hex');
}

// Indexiere Training-Daten (generiere Embeddings)
async function indexTrainingData(trainingData) {
  console.log('🔄 Indexiere Training-Daten mit Embeddings...');
  
  const conversations = trainingData.conversations || [];
  const indexed = [];
  
  // 🚨 NEU: Berechne Hash der Training-Daten
  const trainingDataHash = calculateTrainingDataHash(trainingData);

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
  vectorDb.trainingDataHash = trainingDataHash; // 🚨 NEU: Speichere Hash
  
  console.log(`✅ ${indexed.length} Training-Daten indiziert (Hash: ${trainingDataHash.substring(0, 8)}...)`);
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

  // Erkannte Situationen: Einzelstring oder Array (z.B. ["Treffen/Termine", "Sexuelle Themen"])
  const requestedSituations = Array.isArray(situation)
    ? situation.filter(s => s && s !== 'allgemein')
    : (situation ? [situation] : []);

  // Lade Vektor-DB falls noch nicht geladen
  if (vectorDb.conversations.length === 0) {
    await loadVectorDb();
  }

  // Hilfsfunktion: Item-Situationen als Array
  function getItemSituations(item) {
    if (!item || !item.metadata) return [];
    if (item.metadata.situations && Array.isArray(item.metadata.situations)) {
      return item.metadata.situations;
    }
    if (item.metadata.situation) {
      return item.metadata.situation.includes(',')
        ? item.metadata.situation.split(',').map(s => s.trim())
        : [item.metadata.situation];
    }
    return [];
  }

  // Generiere Embedding für Query
  let queryEmbedding = await getEmbedding(queryText);
  if (!queryEmbedding) {
    console.warn('⚠️ Konnte Embedding für Query nicht generieren – Fallback: zufällige Beispiele aus Training-Daten');
    // Fallback: gleiche Filter (Situation, includeSexual), dann zufällige Auswahl
    const filtered = vectorDb.conversations
      .filter((item) => {
        if (!item || !item.metadata) return false;
        const itemSituations = getItemSituations(item);
        if (requestedSituations.length > 0) {
          const hasMatch = itemSituations.some(s => requestedSituations.includes(s));
          if (!hasMatch) return false;
        }
        if (!includeSexual) {
          const hasSexual = itemSituations.some(s => (s || '').toLowerCase().includes('sexuell')) ||
            (item.metadata.situation && item.metadata.situation.toLowerCase().includes('sexuell'));
          if (hasSexual) return false;
        }
        return true;
      });
    // Wenn mit Situation-Filter nichts gefunden: alle (mit includeSexual-Filter) nehmen
    const pool = filtered.length >= topK ? filtered : vectorDb.conversations.filter((item) => {
      if (!item || !item.metadata) return false;
      if (!includeSexual) {
        const itemSituations = getItemSituations(item);
        const hasSexual = itemSituations.some(s => (s || '').toLowerCase().includes('sexuell')) ||
          (item.metadata.situation && item.metadata.situation.toLowerCase().includes('sexuell'));
        if (hasSexual) return false;
      }
      return true;
    });
    // Zufällige Auswahl (Fisher-Yates Shuffle der ersten topK aus gemischtem Array)
    const take = Math.min(topK, pool.length);
    const indices = Array.from({ length: pool.length }, (_, i) => i);
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(Math.random() * (indices.length - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const fallbackItems = indices.slice(0, take).map((i) => pool[i]);
    return fallbackItems.map((item) => ({
      customerMessage: item.metadata.customerMessage,
      moderatorResponse: item.metadata.moderatorResponse,
      situation: item.metadata.situation,
      priority: item.metadata.priority,
      source: item.metadata.source,
      similarity: 0.5,
      feedbackId: item.metadata.feedbackId || null,
      index: item.metadata.index || null
    }));
  }

  // Berechne Ähnlichkeiten
  const similarities = vectorDb.conversations
    .map((item, idx) => {
      // 🚨 KRITISCH: Null-Check für metadata (verhindert "Cannot read properties of undefined")
      if (!item || !item.embedding || !item.metadata) {
        return null; // Überspringe ungültige Einträge
      }

      const itemSituations = getItemSituations(item);

      // Filter: Mindestens eine der erkannten Situationen muss im Beispiel vorkommen
      if (requestedSituations.length > 0) {
        const hasMatch = itemSituations.some(s => requestedSituations.includes(s));
        if (!hasMatch) {
          return null;
        }
      }

      // Filter: Sexuelle Themen (wenn nicht gewünscht)
      if (!includeSexual) {
        const hasSexualSituation = itemSituations.some(s => (s || '').toLowerCase().includes('sexuell')) ||
                                   (item.metadata.situation && item.metadata.situation.toLowerCase().includes('sexuell'));
        if (hasSexualSituation) {
          return null;
        }
      }

      const similarity = cosineSimilarity(queryEmbedding, item.embedding);
      // Wie viele der erkannten Situationen hat dieses Beispiel? (für Sortierung: mehr = besser)
      const situationMatchCount = requestedSituations.length > 0
        ? itemSituations.filter(s => requestedSituations.includes(s)).length
        : 0;
      return { similarity, situationMatchCount, index: idx, item };
    })
    .filter(result => result !== null && result.similarity >= minSimilarity);

  // Sortierung: zuerst Ähnlichkeit, dann Bevorzugung für Beispiele mit mehr passenden Situationen
  const situationBoost = 0.02; // Leichter Boost pro zusätzlicher Situation
  similarities.sort((a, b) => {
    const scoreA = a.similarity + situationBoost * a.situationMatchCount;
    const scoreB = b.similarity + situationBoost * b.situationMatchCount;
    return scoreB - scoreA;
  });

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
  try {
    console.log('🚀 Initialisiere Vektor-DB...');
    
    // Lade von GitHub/lokal/PostgreSQL
    await loadVectorDb();
    
    const currentCount = vectorDb.conversations.length;
    const trainingDataCount = trainingData?.conversations?.length || 0;

    // Wenn GitHub/lokal keine Trainingsdaten liefert, niemals eine bereits gefüllte DB leeren/neu bauen
    if (trainingDataCount === 0 && currentCount > 0) {
      console.warn('⚠️ Vektor-DB: Training-Daten beim Laden leer (z. B. GitHub kurz nicht erreichbar) – behalte bestehende Vektor-DB.');
      return vectorDb;
    }
    
    console.log(`📊 Vektor-DB Status: ${currentCount} Einträge geladen, ${trainingDataCount} Training-Daten verfügbar`);
    
    // 🚨 NEU: Berechne Hash der aktuellen Training-Daten
    const currentTrainingDataHash = calculateTrainingDataHash(trainingData);
    const storedHash = vectorDb.trainingDataHash;
    
    console.log(`🔍 Hash-Vergleich: Gespeichert: ${storedHash?.substring(0, 8) || 'kein'}, Aktuell: ${currentTrainingDataHash.substring(0, 8)}`);

    // 🚨 KRITISCH: Prüfe ob Training-Daten sich geändert haben (durch Hash-Vergleich)
    // Das ist zuverlässiger als nur die Anzahl zu vergleichen!
    const hasTrainingDataChanged = storedHash !== null && storedHash !== currentTrainingDataHash;
    const hasMoreTrainingData = trainingDataCount > currentCount;

    // Nur neu indizieren, wenn echte Trainingsdaten geladen sind (sonst Hash-Leer vs. voll verwischt)
    if (currentCount > 0 && trainingDataCount > 0 && (hasTrainingDataChanged || hasMoreTrainingData)) {
      if (hasTrainingDataChanged) {
        console.log(`🔄 Vektor-DB veraltet: Training-Daten haben sich geändert (Hash: ${storedHash?.substring(0, 8) || 'kein'} → ${currentTrainingDataHash.substring(0, 8)}) - starte Neu-Indexierung...`);
      } else {
        console.log(`🔄 Vektor-DB veraltet: ${currentCount} Einträge, aber ${trainingDataCount} Training-Daten vorhanden - starte Neu-Indexierung...`);
      }
      // Lösche alte Vektor-DB und indexiere neu
      vectorDb.conversations = [];
      await indexTrainingData(trainingData);
      const saveResult = await saveVectorDb(false); // Speichere in PostgreSQL (und lokal als Fallback), aber nicht auf GitHub (zu groß)
      if (saveResult && saveResult.postgresSuccess) {
        console.log(`✅ Vektor-DB Neu-Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge (vorher: ${currentCount}) - in PostgreSQL gespeichert`);
      } else if (saveResult && saveResult.localSuccess) {
        console.log(`✅ Vektor-DB Neu-Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge (vorher: ${currentCount}) - lokal gespeichert (PostgreSQL-Fehler)`);
      } else {
        console.warn(`⚠️ Vektor-DB Neu-Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge (vorher: ${currentCount}) - ABER: Speicherung fehlgeschlagen!`);
      }
      return vectorDb;
    }

    // Wenn bereits indiziert und aktuell, nichts tun
    if (currentCount > 0 && !hasTrainingDataChanged && !hasMoreTrainingData) {
      console.log(`✅ Vektor-DB bereits initialisiert: ${currentCount} Einträge (Training-Daten: ${trainingDataCount}, Hash: ${storedHash?.substring(0, 8) || 'kein'}) - KEINE Neu-Indexierung nötig!`);
      return vectorDb;
    }

    // Wenn noch leer, indexiere Training-Daten
    if (currentCount === 0 && trainingData && trainingDataCount > 0) {
      console.log(`🔄 Vektor-DB ist leer (${currentCount} Einträge) - starte Indexierung von ${trainingDataCount} Training-Daten...`);
      await indexTrainingData(trainingData);
      const saveResult = await saveVectorDb(false); // Speichere in PostgreSQL (und lokal als Fallback), aber nicht auf GitHub (zu groß)
      if (saveResult && saveResult.postgresSuccess) {
        console.log(`✅ Vektor-DB Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge - in PostgreSQL gespeichert`);
      } else if (saveResult && saveResult.localSuccess) {
        console.log(`✅ Vektor-DB Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge - lokal gespeichert (PostgreSQL-Fehler)`);
      } else {
        console.warn(`⚠️ Vektor-DB Indexierung abgeschlossen: ${vectorDb.conversations.length} Einträge - ABER: Speicherung fehlgeschlagen!`);
      }
    } else if (currentCount === 0 && (!trainingData || trainingDataCount === 0)) {
      console.warn(`⚠️ Vektor-DB ist leer UND keine Training-Daten verfügbar - kann nicht indizieren!`);
    }

    return vectorDb;
  } catch (err) {
    // 🚨 KRITISCH: Fange alle Fehler ab, damit der Server nicht crasht
    console.error('❌ KRITISCHER FEHLER bei Vektor-DB Initialisierung:', err.message);
    console.error('   Stack:', err.stack?.split('\n').slice(0, 5).join('\n') || 'kein Stack');
    console.warn('⚠️ Vektor-DB wird mit leerem Zustand fortgesetzt (Server läuft weiter)');
    return vectorDb; // Gib zumindest leere DB zurück
  }
}

module.exports = {
  loadVectorDb,
  saveVectorDb,
  indexTrainingData,
  findSimilarExamples,
  initializeVectorDb
};

