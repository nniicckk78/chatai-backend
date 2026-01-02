/**
 * CHAT-VARIATION & ANTI-DUPLIKAT-SYSTEM
 * 
 * Generiert chat-spezifische Stil-Variationen (basierend auf chatId, nicht accountId)
 * und verhindert, dass die gleiche Nachricht mehrfach generiert wird.
 */

const fs = require('fs');
const path = require('path');
const { getGitHubClient, getRepoInfo, pushFileToGitHub } = require('./github');

// Anti-Duplikat-Datenbank (speichert bereits generierte Nachrichten)
const duplicateDbPath = path.join(__dirname, '../../config/duplicate-check.json');
let duplicateDb = {
  generatedMessages: [], // Array von { chatId, message, timestamp }
  lastUpdated: null
};

// Lade Anti-Duplikat-DB
async function loadDuplicateDb() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/duplicate-check.json',
        'src/config/duplicate-check.json',
        'config/duplicate-check.json',
        'server/config/duplicate-check.json'
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
            duplicateDb = JSON.parse(content);
            return duplicateDb;
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Laden der Duplikat-DB von GitHub:', err.message);
    }
  }

  // Fallback: Lokale Datei
  try {
    if (fs.existsSync(duplicateDbPath)) {
      const content = fs.readFileSync(duplicateDbPath, 'utf8');
      duplicateDb = JSON.parse(content);
      return duplicateDb;
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Laden der lokalen Duplikat-DB:', err.message);
  }

  return duplicateDb;
}

// Speichere Anti-Duplikat-DB
async function saveDuplicateDb(pushToGitHub = false) {
  try {
    const dbDir = path.dirname(duplicateDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    // Behalte nur die letzten 500 Einträge (um Datei klein zu halten und Performance zu verbessern)
    // WICHTIG: 500 reicht aus, da wir nur exakte Duplikate prüfen (nicht ähnliche)
    if (duplicateDb.generatedMessages.length > 500) {
      duplicateDb.generatedMessages = duplicateDb.generatedMessages.slice(-500);
    }
    
    duplicateDb.lastUpdated = new Date().toISOString();
    fs.writeFileSync(duplicateDbPath, JSON.stringify(duplicateDb, null, 2));

    if (pushToGitHub) {
      try {
        await pushFileToGitHub(
          'server/src/config/duplicate-check.json',
          JSON.stringify(duplicateDb, null, 2),
          'Update duplicate check database'
        );
      } catch (err) {
        console.warn('⚠️ Fehler beim Pushen der Duplikat-DB zu GitHub:', err.message);
      }
    }
  } catch (err) {
    console.error('❌ Fehler beim Speichern der Duplikat-DB:', err.message);
  }
}

// Prüfe ob eine Nachricht bereits generiert wurde (Anti-Duplikat)
// Verwendet mehrere Quellen für stabilen Check (nicht nur chatId)
async function isDuplicate(message, chatId = null, customerName = null, fakeName = null, platformId = null) {
  await loadDuplicateDb();
  
  const messageLower = message.toLowerCase().trim();
  
  // Prüfe auf exakte Duplikate (gleiche Nachricht) - GLOBAL (über alle Chats)
  // Das ist wichtig: Verhindert, dass die gleiche Nachricht bei verschiedenen Accounts/Chats generiert wird
  // WICHTIG: Nur exakte Duplikate blockieren, damit die KI genug Freiraum hat!
  const exactDuplicate = duplicateDb.generatedMessages.some(entry => {
    const entryLower = entry.message.toLowerCase().trim();
    // NUR exakte Übereinstimmung blockieren (100%)
    // Keine Ähnlichkeitsprüfung, damit die KI genug Variation hat!
    if (entryLower === messageLower) {
      return true;
    }
    // Optional: Nur bei EXTREM ähnlichen Nachrichten (>98% - sehr selten)
    // Das verhindert nur wirklich identische Nachrichten, gibt aber genug Freiraum
    const similarity = calculateSimilarity(entryLower, messageLower);
    // Nur bei >98% blockieren (sehr streng, nur fast identische Nachrichten)
    return similarity > 0.98;
  });
  
  if (exactDuplicate) {
    console.warn(`⚠️ Duplikat erkannt: Ähnliche Nachricht wurde bereits generiert (global)`);
    return true;
  }
  
  return false;
}

// Berechne Ähnlichkeit zwischen zwei Texten (verbesserte Methode)
function calculateSimilarity(text1, text2) {
  if (text1 === text2) return 1.0;
  if (text1.length === 0 || text2.length === 0) return 0;
  
  // Normalisiere: Entferne Satzzeichen, alles lowercase
  const normalize = (text) => text.toLowerCase().replace(/[.,!?;:]/g, '').trim();
  const norm1 = normalize(text1);
  const norm2 = normalize(text2);
  
  if (norm1 === norm2) return 1.0;
  
  // Wort-basierte Ähnlichkeit (nur Wörter > 2 Zeichen)
  const words1 = norm1.split(/\s+/).filter(w => w.length > 2);
  const words2 = norm2.split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // Berechne gemeinsame Wörter
  const commonWords = words1.filter(w => words2.includes(w));
  const totalWords = Math.max(words1.length, words2.length);
  
  // Basis-Ähnlichkeit
  let similarity = commonWords.length / totalWords;
  
  // Zusätzlich: Prüfe Zeichen-Ähnlichkeit (für sehr kurze Nachrichten)
  if (norm1.length < 50 || norm2.length < 50) {
    // Bei kurzen Nachrichten: Zeichen-Ähnlichkeit wichtiger
    const charSimilarity = calculateCharSimilarity(norm1, norm2);
    similarity = (similarity * 0.7) + (charSimilarity * 0.3); // Gewichtung
  }
  
  return similarity;
}

// Berechne Zeichen-Ähnlichkeit (für kurze Nachrichten)
function calculateCharSimilarity(text1, text2) {
  if (text1 === text2) return 1.0;
  
  const len1 = text1.length;
  const len2 = text2.length;
  const maxLen = Math.max(len1, len2);
  
  if (maxLen === 0) return 1.0;
  
  // Einfache Levenshtein-ähnliche Berechnung (vereinfacht)
  let matches = 0;
  const minLen = Math.min(len1, len2);
  
  for (let i = 0; i < minLen; i++) {
    if (text1[i] === text2[i]) matches++;
  }
  
  return matches / maxLen;
}

// Speichere generierte Nachricht (für Anti-Duplikat-Check)
// Speichert GLOBAL (über alle Chats), um Duplikate zwischen Accounts zu verhindern
async function saveGeneratedMessage(message, chatId = null, customerName = null, fakeName = null, platformId = null) {
  await loadDuplicateDb();
  
  // Erstelle stabilen Identifier für diesen Chat
  const chatIdentifier = generateChatIdentifier(chatId, customerName, fakeName, platformId);
  
  duplicateDb.generatedMessages.push({
    message: message.trim(),
    chatId: chatId || null,
    chatIdentifier: chatIdentifier || null,
    customerName: customerName || null,
    fakeName: fakeName || null,
    platformId: platformId || null,
    timestamp: new Date().toISOString()
  });
  
  // Speichere (asynchron, nicht blockierend)
  setImmediate(() => {
    saveDuplicateDb(false); // Nicht auf GitHub pushen bei jedem Save (zu oft)
  });
}

// Generiere stabilen Chat-Identifier (aus mehreren Quellen, nicht nur chatId)
function generateChatIdentifier(chatId, customerName, fakeName, platformId) {
  // Kombiniere mehrere Quellen für stabilen Identifier
  const parts = [];
  
  if (chatId) parts.push(String(chatId));
  if (customerName) parts.push(String(customerName).toLowerCase().trim());
  if (fakeName) parts.push(String(fakeName).toLowerCase().trim());
  if (platformId) parts.push(String(platformId));
  
  if (parts.length === 0) {
    return null; // Keine ausreichenden Daten
  }
  
  // Kombiniere alle Teile zu einem stabilen Identifier
  return parts.join('|');
}

// Generiere Chat-spezifische Stil-Variation (basierend auf stabilen Identifier)
function getChatVariation(chatId, customerName = null, fakeName = null, platformId = null) {
  // Erstelle stabilen Identifier (nicht nur chatId)
  const chatIdentifier = generateChatIdentifier(chatId, customerName, fakeName, platformId);
  
  if (!chatIdentifier) {
    return null;
  }

  // Hash Identifier zu einem konsistenten Seed
  let hash = 0;
  for (let i = 0; i < chatIdentifier.length; i++) {
    const char = chatIdentifier.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const seed = Math.abs(hash);

  // Bestimme Stil-Variation basierend auf Seed
  const styleVariations = [
    {
      name: 'locker',
      characteristics: ['locker', 'entspannt', 'unverkrampft'],
      preferredWords: ['okay', 'klar', 'gerne', 'mega'],
      tone: 'locker und entspannt'
    },
    {
      name: 'emotional',
      characteristics: ['emotional', 'gefühlsbetont', 'herzlich', 'warm'],
      preferredWords: ['richtig', 'total', 'super', 'toll'],
      tone: 'emotional und gefühlsbetont'
    },
    {
      name: 'direkt',
      characteristics: ['direkt', 'offen', 'ehrlich', 'klar'],
      preferredWords: ['genau', 'klar', 'direkt', 'offen'],
      tone: 'direkt und offen'
    },
    {
      name: 'spielerisch',
      characteristics: ['spielerisch', 'flirty', 'verspielt', 'leicht'],
      preferredWords: ['haha', 'lol', 'witzig', 'spaß'],
      tone: 'spielerisch und flirty'
    },
    {
      name: 'intensiv',
      characteristics: ['intensiv', 'leidenschaftlich', 'feurig', 'heiß'],
      preferredWords: ['geil', 'heiß', 'mega', 'richtig'],
      tone: 'intensiv und leidenschaftlich'
    }
  ];

  // Wähle Variation basierend auf Seed (konsistent für diesen Chat)
  const variationIndex = seed % styleVariations.length;
  const variation = styleVariations[variationIndex];

  return {
    name: variation.name,
    tone: variation.tone,
    characteristics: variation.characteristics,
    preferredWords: variation.preferredWords,
    seed: seed
  };
}

// Generiere Stil-Anweisung für Prompt
function generateStyleInstruction(chatVariation) {
  if (!chatVariation) {
    return '';
  }

  return `
🎨 CHAT-SPEZIFISCHER STIL (konsistent für diesen Chat):
- Dein Schreibstil sollte ${chatVariation.tone} sein
- Verwende bevorzugt diese Wörter: ${chatVariation.preferredWords.join(', ')}
- Charakteristika: ${chatVariation.characteristics.join(', ')}
- WICHTIG: Dies ist eine leichte Variation - halte dich trotzdem an Training-Daten und Regeln!
- 🚨 KRITISCH: Jede Nachricht muss EINZIGARTIG sein - keine Wiederholungen von vorherigen Nachrichten!
`;
}

// Generiere Variation in der Antwort (für mehr Einzigartigkeit)
function addResponseVariation(basePrompt, chatVariation) {
  if (!chatVariation) {
    return basePrompt;
  }

  const variationInstructions = [
    '🚨 KRITISCH: Diese Nachricht muss sich DEUTLICH von allen vorherigen Nachrichten unterscheiden!',
    '🚨 Verwende KOMPLETT unterschiedliche Formulierungen, andere Wörter, andere Struktur!',
    '🚨 Wenn du dir unsicher bist, wähle eine andere Formulierung oder einen anderen Ansatz!',
    '🚨 Jede Nachricht muss EINZIGARTIG sein - keine Wiederholungen!'
  ];

  return basePrompt + '\n\n' + variationInstructions.join('\n');
}

module.exports = {
  isDuplicate,
  saveGeneratedMessage,
  getChatVariation,
  generateStyleInstruction,
  addResponseVariation,
  generateChatIdentifier,
  loadDuplicateDb,
  saveDuplicateDb
};

