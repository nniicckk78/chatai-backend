/**
 * LEARNING SYSTEM - Meta-Learning für die KI
 * 
 * Dieses System analysiert Feedback und Training-Daten, um Muster zu erkennen
 * und die KI-Antworten kontinuierlich zu verbessern - ähnlich wie ein menschliches Gehirn lernt.
 */

const fs = require('fs');
const path = require('path');
const { getGitHubClient, getRepoInfo } = require('./github');

// Lade Learning-Statistiken (von GitHub oder lokal)
// 🚨 NEU: Migriere alte Struktur zu neuer situationsspezifischer Struktur
// WICHTIG: Migration wird nur einmal durchgeführt (nicht bei jedem Request!)
function migrateLearningStats(stats) {
  if (!stats) return stats;
  
  // 🚨 NEU: Prüfe, ob Migration bereits durchgeführt wurde
  if (stats.migrated === true) {
    return stats; // Migration bereits durchgeführt, überspringe
  }
  
  let needsMigration = false;
  
  // Prüfe, ob wordFrequency die alte Struktur hat (direkt Wörter als Keys, nicht Situationen)
  if (stats.wordFrequency && typeof stats.wordFrequency === 'object') {
    const firstKey = Object.keys(stats.wordFrequency)[0];
    if (firstKey && stats.wordFrequency[firstKey] && typeof stats.wordFrequency[firstKey] === 'object' && 'good' in stats.wordFrequency[firstKey]) {
      // Alte Struktur erkannt: { "word": { good, bad } }
      console.log('🔄 Migriere wordFrequency von alter zu neuer Struktur...');
      const oldWordFreq = { ...stats.wordFrequency };
      stats.wordFrequency = {};
      
      // Migriere alle alten Daten unter "allgemein"
      if (!stats.wordFrequency['allgemein']) {
        stats.wordFrequency['allgemein'] = {};
      }
      
      for (const [word, freq] of Object.entries(oldWordFreq)) {
        if (freq && typeof freq === 'object' && ('good' in freq || 'bad' in freq)) {
          stats.wordFrequency['allgemein'][word] = { good: freq.good || 0, bad: freq.bad || 0 };
        }
      }
      
      needsMigration = true;
      console.log(`✅ wordFrequency migriert: ${Object.keys(oldWordFreq).length} Wörter → "allgemein"`);
    }
  }
  
  // Prüfe, ob patterns die alte Struktur hat (direkt Patterns als Keys, nicht Situationen)
  if (stats.patterns && typeof stats.patterns === 'object') {
    const firstKey = Object.keys(stats.patterns)[0];
    if (firstKey && stats.patterns[firstKey] && typeof stats.patterns[firstKey] === 'object' && 'count' in stats.patterns[firstKey]) {
      // Alte Struktur erkannt: { "pattern": { count, successRate } }
      console.log('🔄 Migriere patterns von alter zu neuer Struktur...');
      const oldPatterns = { ...stats.patterns };
      stats.patterns = {};
      
      // Migriere alle alten Daten unter "allgemein"
      if (!stats.patterns['allgemein']) {
        stats.patterns['allgemein'] = {};
      }
      
      for (const [pattern, data] of Object.entries(oldPatterns)) {
        if (data && typeof data === 'object' && 'count' in data) {
          stats.patterns['allgemein'][pattern] = { count: data.count || 0, successRate: data.successRate || 0 };
        }
      }
      
      needsMigration = true;
      console.log(`✅ patterns migriert: ${Object.keys(oldPatterns).length} Patterns → "allgemein"`);
    }
  }
  
  if (needsMigration) {
    console.log('✅ Migration abgeschlossen - alte Daten wurden unter "allgemein" gespeichert');
    stats.lastUpdated = new Date().toISOString();
    stats.migrated = true; // Flag, dass Migration durchgeführt wurde
  }
  
  return stats;
}

async function getLearningStats() {
  // PRIORITÄT 1: Lade von GitHub (Hauptquelle für Render)
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/learning-stats.json',
        'src/config/learning-stats.json',
        'config/learning-stats.json',
        'server/config/learning-stats.json'
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
            
            // 🚨 NEU: Migriere alte Struktur zu neuer Struktur
            const migrated = migrateLearningStats(parsed);
            
            // Speichere auch lokal als Backup (mit migrierter Struktur)
            const statsPath = path.join(__dirname, '../../config/learning-stats.json');
            const configDir = path.dirname(statsPath);
            if (!fs.existsSync(configDir)) {
              fs.mkdirSync(configDir, { recursive: true });
            }
            
            // Wenn Migration durchgeführt wurde, speichere die migrierte Version
            if (migrated.migrated && !migrated.migratedSaved) {
              const migratedContent = JSON.stringify(migrated, null, 2);
              fs.writeFileSync(statsPath, migratedContent);
              migrated.migratedSaved = true; // Flag, dass lokal gespeichert wurde
            } else {
            fs.writeFileSync(statsPath, content);
            }
            
            return migrated;
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('⚠️ Fehler beim Laden der Learning-Statistiken von GitHub:', err.message);
      }
    }
  }
  
  // PRIORITÄT 2: Fallback zu lokaler Datei
  const statsPath = path.join(__dirname, '../../config/learning-stats.json');
  try {
    if (fs.existsSync(statsPath)) {
      const data = fs.readFileSync(statsPath, 'utf8');
      const parsed = JSON.parse(data);
      
      // 🚨 NEU: Migriere alte Struktur zu neuer Struktur
      const migrated = migrateLearningStats(parsed);
      
      // Wenn Migration durchgeführt wurde, speichere die migrierte Version
      if (migrated.migrated && !migrated.migratedSaved) {
        const migratedContent = JSON.stringify(migrated, null, 2);
        fs.writeFileSync(statsPath, migratedContent);
        migrated.migratedSaved = true;
      }
      
      return migrated;
    }
  } catch (err) {
    console.error('Fehler beim Laden der Learning-Statistiken:', err);
  }
  
  // Standard-Struktur
  return {
    patterns: {}, // 🚨 NEU: Muster situationsspezifisch: { "Situation": { "pattern": { count, successRate } } }
    wordFrequency: {}, // 🚨 NEU: Häufigkeit situationsspezifisch: { "Situation": { "word": { good, bad } } }
    situationSuccess: {}, // Feedback-Qualität pro Situation (z.B. "Treffen/Termine" → 80% "good" vs "edited" Feedbacks) - NICHT ob Kunde geantwortet hat!
    responsePatterns: [], // Bewährte Antwort-Muster (situationsspezifisch)
    reasoningPrinciples: [], // 🚨 NEU: Prinzipien aus Begründungen (z.B. "Gehe auf ALLE Anfragen ein")
    messageStats: {}, // 🚨 NEU: Nachrichtenstatistiken pro Situation (Länge, Ausrufezeichen, Fragen)
    proactivePatterns: [], // 🚨 NEU: Proaktive Muster (eigene Vorlieben/Interessen + Frage)
    questionPatterns: {}, // 🚨 NEU: Gelernte Fragen situationsspezifisch: { "Situation": { "Frage": { count, contexts: [], successRate } } }
    emojiPatterns: {}, // 🚨 NEU: Emoji-Muster situationsspezifisch: { "Situation": { "emoji": { count, positions: [], successRate, contexts: [] } } }
    diffPatterns: {}, // 🚨 NEU: Unterschiede zwischen aiResponse und editedResponse: { "Situation": { "removed": [], "added": [], "changed": [] } }
    sentenceStructures: {}, // 🚨 NEU: Satzstrukturen situationsspezifisch: { "Situation": { "structure": { count, examples: [], successRate } } }
    communicationStyles: {}, // 🚨 NEU: Kommunikationsstile situationsspezifisch: { "Situation": { "style": { count, examples: [], successRate } } }
    examplePerformance: {}, // 🚨 NEU: Beispiel-Performance: { "exampleId": { "situation": { good, bad, successRate } } }
    negativeFilters: {}, // 🚨🚨🚨 NEU: Negativ-Filterung - Falsch gelernte Muster korrigieren: { "type": { "key": { count, lastUpdated } } }
    feedbackValidation: {}, // 🚨🚨🚨 NEU: Feedback-Loop-Validierung - Prüfung ob gelernte Muster helfen: { "patternId": { usedCount, successCount, lastValidated } }
    lastUpdated: new Date().toISOString(),
    initialized: false // Flag: Wurde die Initialisierung bereits durchgeführt?
  };
}

// Speichere Learning-Statistiken (lokal + optional GitHub)
async function saveLearningStats(stats, pushToGitHub = true) {
  const statsPath = path.join(__dirname, '../../config/learning-stats.json');
  const configDir = path.dirname(statsPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  stats.lastUpdated = new Date().toISOString();
  const content = JSON.stringify(stats, null, 2);
  fs.writeFileSync(statsPath, content);
  
  // Nur auf GitHub pushen, wenn explizit gewünscht (nicht bei jedem einzelnen Feedback während Initialisierung)
  if (pushToGitHub) {
    const githubClient = getGitHubClient();
    if (githubClient) {
      try {
        const { pushFileToGitHub } = require('./github');
        const possiblePaths = [
          'server/src/config/learning-stats.json',
          'src/config/learning-stats.json',
          'config/learning-stats.json',
          'server/config/learning-stats.json'
        ];
        
        let pushed = false;
        for (const filePath of possiblePaths) {
          try {
            await pushFileToGitHub(filePath, content, 'Update learning stats (KI lernt aus Feedback)');
            pushed = true;
            break;
          } catch (err) {
            if (err.status === 404) continue;
            throw err;
          }
        }
        
        if (!pushed) {
          await pushFileToGitHub('server/src/config/learning-stats.json', content, 'Update learning stats (KI lernt aus Feedback)');
        }
      } catch (err) {
        console.warn('⚠️ Konnte Learning-Statistiken nicht auf GitHub pushen:', err.message);
      }
    }
  }
}

// Analysiere Feedback und aktualisiere Learning-Statistiken
async function analyzeFeedback(feedback, pushToGitHub = true) {
  const stats = await getLearningStats();
  
  // 🚨 NEU: Wenn Migration durchgeführt wurde, speichere sofort auf GitHub
  if (stats.migrated && !stats.migratedSavedToGitHub) {
    console.log('💾 Speichere migrierte Learning-Statistiken auf GitHub...');
    await saveLearningStats(stats, true); // pushToGitHub = true
    stats.migratedSavedToGitHub = true; // Flag, dass auf GitHub gespeichert wurde
  }
  const { customerMessage, aiResponse, editedResponse, status, situation, reasoning, usedExampleIds } = feedback; // 🚨 NEU: reasoning, usedExampleIds
  
  const now = Date.now();
  
  // 🚨 FIX: Stelle sicher, dass alle benötigten Arrays existieren
  if (!stats.reasoningPrinciples) stats.reasoningPrinciples = [];
  if (!stats.responsePatterns) stats.responsePatterns = [];
  if (!stats.patterns) stats.patterns = {};
  if (!stats.wordFrequency) stats.wordFrequency = {};
  if (!stats.situationSuccess) stats.situationSuccess = {};
  if (!stats.messageStats) stats.messageStats = {}; // 🚨 NEU: Nachrichtenstatistiken
  if (!stats.proactivePatterns) stats.proactivePatterns = []; // 🚨 NEU: Proaktive Muster
  if (!stats.questionPatterns) stats.questionPatterns = {}; // 🚨 NEU: Gelernte Fragen
  if (!stats.emojiPatterns) stats.emojiPatterns = {}; // 🚨 NEU: Emoji-Muster
  if (!stats.diffPatterns) stats.diffPatterns = {}; // 🚨 NEU: Diff-Muster
  if (!stats.sentenceStructures) stats.sentenceStructures = {}; // 🚨 NEU: Satzstrukturen
  if (!stats.communicationStyles) stats.communicationStyles = {}; // 🚨 NEU: Kommunikationsstile
  if (!stats.examplePerformance) stats.examplePerformance = {}; // 🚨 NEU: Beispiel-Performance
  if (!stats.negativeFilters) stats.negativeFilters = {}; // 🚨🚨🚨 NEU: Negativ-Filterung
  if (!stats.feedbackValidation) stats.feedbackValidation = {}; // 🚨🚨🚨 NEU: Feedback-Loop-Validierung
  
  // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
  let situationsArray = [];
  if (Array.isArray(situation) && situation.length > 0) {
    situationsArray = situation;
  } else if (typeof situation === 'string' && situation.trim() !== '') {
    // Prüfe, ob es mehrere Situationen mit Komma-Trennung sind
    if (situation.includes(',')) {
      situationsArray = situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else {
      situationsArray = [situation];
    }
  }
  
  // Bestimme, welche Antwort als "gut" gilt
  const goodResponse = status === 'edited' && editedResponse ? editedResponse : (status === 'good' ? aiResponse : null);
  const badResponse = status === 'edited' && editedResponse ? aiResponse : null; // Original war schlecht
  
  // 🚨 NEU: Analysiere Nachrichtenstatistiken (Länge, Ausrufezeichen, Fragen) für positive UND negative Beispiele
  const primarySituation = situationsArray.length > 0 ? situationsArray[0] : (situation || 'allgemein');
  
  // Analysiere positive Beispiele
  if (goodResponse) {
    analyzeMessageStats(goodResponse, primarySituation, stats, true); // true = positive
  }
  
  // Analysiere negative Beispiele (nur bei edited Feedback)
  if (badResponse) {
    analyzeMessageStats(badResponse, primarySituation, stats, false); // false = negative
  }
  
  if (goodResponse) {
    // 🚨 NEU: Analysiere gute Antwort situationsspezifisch (nur für primäre Situation!)
    // WICHTIG: Lerne nur für die primäre Situation, um Cross-Contamination zu vermeiden
    const words = extractWords(goodResponse);
    words.forEach(word => {
      // Initialisiere situationsspezifische Struktur
      if (!stats.wordFrequency[primarySituation]) {
        stats.wordFrequency[primarySituation] = {};
      }
      if (!stats.wordFrequency[primarySituation][word]) {
        stats.wordFrequency[primarySituation][word] = { good: 0, bad: 0, lastUpdated: now };
      }
      stats.wordFrequency[primarySituation][word].good++;
      stats.wordFrequency[primarySituation][word].lastUpdated = now;
    });
    
    // 🚨 NEU: Analysiere Muster situationsspezifisch (nur für primäre Situation!)
    const patterns = extractPatterns(goodResponse);
    patterns.forEach(pattern => {
      // Initialisiere situationsspezifische Struktur
      if (!stats.patterns[primarySituation]) {
        stats.patterns[primarySituation] = {};
      }
      if (!stats.patterns[primarySituation][pattern]) {
        stats.patterns[primarySituation][pattern] = { count: 0, successRate: 0 };
      }
      stats.patterns[primarySituation][pattern].count++;
    });
    
    // 🚨 NEU: Erkenne proaktive Muster (eigene Vorlieben/Interessen + Frage)
    const proactivePattern = detectProactivePattern(goodResponse);
    if (proactivePattern && proactivePattern.isProactive) {
      // Speichere proaktives Muster
      if (!stats.proactivePatterns) {
        stats.proactivePatterns = [];
      }
      
      const existingProactive = stats.proactivePatterns.find(p => 
        p.pattern === proactivePattern.pattern && 
        p.situation === primarySituation
      );
      
      if (existingProactive) {
        existingProactive.count++;
        existingProactive.lastUsed = new Date().toISOString();
      } else {
        stats.proactivePatterns.push({
          pattern: proactivePattern.pattern,
          situation: primarySituation,
          example: goodResponse.substring(0, 150),
          count: 1,
          lastUsed: new Date().toISOString()
        });
      }
      console.log(`✅ Proaktives Muster erkannt: ${proactivePattern.pattern} (Situation: ${primarySituation})`);
    }
    
    // 🚨 NEU: Analysiere Begründungen (reasoning) und extrahiere Prinzipien
    // ⚠️ OPTIONAL: Begründungen sind NICHT notwendig! Das System lernt hauptsächlich aus Diff-Analyse.
    // Begründungen sind nur ein "Nice-to-have" für zusätzliche abstrakte Prinzipien.
    if (reasoning && typeof reasoning === 'string' && reasoning.trim() !== '') {
      const principles = extractPrinciplesFromReasoning(reasoning);
      principles.forEach(principle => {
        // Prüfe, ob ähnliches Prinzip bereits existiert
        const existingPrinciple = stats.reasoningPrinciples.find(p => 
          similarity(p.text.toLowerCase(), principle.toLowerCase()) > 0.7
        );
        
        if (existingPrinciple) {
          existingPrinciple.count++;
          existingPrinciple.lastUsed = new Date().toISOString();
          // Kombiniere Situationen
          if (situationsArray.length > 0) {
            situationsArray.forEach(sit => {
              if (!existingPrinciple.situations.includes(sit)) {
                existingPrinciple.situations.push(sit);
              }
            });
          }
        } else {
          stats.reasoningPrinciples.push({
            text: principle,
            count: 1,
            situations: situationsArray.length > 0 ? [...situationsArray] : [situation || 'allgemein'],
            lastUsed: new Date().toISOString()
          });
        }
      });
      console.log(`🧠 ${principles.length} Prinzipien aus Begründung extrahiert`);
    }
    
    // 🚨 WICHTIG: Speichere bewährte Antwort-Muster NUR für die primäre Situation
    // Grund: Vermeide Cross-Contamination - ein Pattern, das bei "Sexuelle Themen" gut ist,
    // muss nicht bei "Treffen/Termine" gut sein!
    if (primarySituation && primarySituation !== 'allgemein') {
      // Update situationSuccess für alle erkannten Situationen (für Statistiken)
    if (situationsArray.length > 0) {
      situationsArray.forEach(sit => {
        if (!stats.situationSuccess[sit]) {
          stats.situationSuccess[sit] = { good: 0, total: 0 };
        }
        stats.situationSuccess[sit].good++;
        stats.situationSuccess[sit].total++;
        });
      } else {
        // Fallback für String-Format
        if (!stats.situationSuccess[primarySituation]) {
          stats.situationSuccess[primarySituation] = { good: 0, total: 0 };
        }
        stats.situationSuccess[primarySituation].good++;
        stats.situationSuccess[primarySituation].total++;
      }
      
      // 🚨 KRITISCH: Speichere Pattern NUR für die primäre Situation!
        const responsePattern = {
        situation: primarySituation, // NUR primäre Situation!
          customerPattern: extractCustomerPattern(customerMessage),
          goodResponse: goodResponse.substring(0, 200), // Erste 200 Zeichen als Muster
          successCount: 1,
          lastUsed: new Date().toISOString()
        };
        
        // Prüfe, ob ähnliches Muster bereits existiert
        const existingPattern = stats.responsePatterns.find(p => 
        p.situation === primarySituation && 
          similarity(p.customerPattern, responsePattern.customerPattern) > 0.7
        );
        
        if (existingPattern) {
          existingPattern.successCount++;
          existingPattern.lastUsed = new Date().toISOString();
          // Aktualisiere gute Antwort, wenn diese besser ist
          if (goodResponse.length > existingPattern.goodResponse.length) {
            existingPattern.goodResponse = goodResponse.substring(0, 200);
          }
        } else {
          stats.responsePatterns.push(responsePattern);
        }
    }
  }
  
  if (badResponse) {
    // 🚨 NEU: Analysiere schlechte Antwort situationsspezifisch (nur für primäre Situation!)
    // WICHTIG: Ein Wort, das bei "Sexuelle Themen" schlecht ist, kann bei "Treffen/Termine" gut sein!
    const words = extractWords(badResponse);
    words.forEach(word => {
      // Initialisiere situationsspezifische Struktur
      if (!stats.wordFrequency[primarySituation]) {
        stats.wordFrequency[primarySituation] = {};
      }
      if (!stats.wordFrequency[primarySituation][word]) {
        stats.wordFrequency[primarySituation][word] = { good: 0, bad: 0, lastUpdated: now };
      }
      stats.wordFrequency[primarySituation][word].bad++;
      stats.wordFrequency[primarySituation][word].lastUpdated = now;
    });
    
    // 🚨 NEU: Analysiere Emojis aus schlechter Antwort (als Anti-Pattern)
    const badEmojis = extractEmojis(badResponse);
    if (badEmojis.length > 0) {
      if (!stats.emojiPatterns[primarySituation]) {
        stats.emojiPatterns[primarySituation] = {};
      }
      
      badEmojis.forEach(emojiData => {
        const emoji = emojiData.emoji;
        if (!stats.emojiPatterns[primarySituation][emoji]) {
          stats.emojiPatterns[primarySituation][emoji] = {
            count: 0,
            positions: [],
            contexts: [],
            successRate: 0
          };
        }
        // Reduziere Success Rate für schlechte Verwendung
        stats.emojiPatterns[primarySituation][emoji].successRate = 
          (stats.emojiPatterns[primarySituation][emoji].successRate * stats.emojiPatterns[primarySituation][emoji].count) / 
          (stats.emojiPatterns[primarySituation][emoji].count + 1);
        stats.emojiPatterns[primarySituation][emoji].count++;
      });
    }
    
    // Update situationSuccess für Statistiken
    if (situationsArray.length > 0) {
      situationsArray.forEach(sit => {
        if (!stats.situationSuccess[sit]) {
          stats.situationSuccess[sit] = { good: 0, total: 0 };
        }
        stats.situationSuccess[sit].total++;
      });
    } else if (primarySituation) {
      if (!stats.situationSuccess[primarySituation]) {
        stats.situationSuccess[primarySituation] = { good: 0, total: 0 };
      }
      stats.situationSuccess[primarySituation].total++;
    }
  }
  
  // 🚨 NEU: Analysiere Unterschiede zwischen aiResponse und editedResponse (Diff-Analyse)
  if (status === 'edited' && aiResponse && editedResponse) {
    const diffAnalysis = analyzeDiff(aiResponse, editedResponse);
    
    if (diffAnalysis && (diffAnalysis.removed.length > 0 || diffAnalysis.added.length > 0 || diffAnalysis.changed.length > 0)) {
      if (!stats.diffPatterns[primarySituation]) {
        stats.diffPatterns[primarySituation] = {
          removed: [], // Was wurde entfernt (schlecht)
          added: [], // Was wurde hinzugefügt (gut)
          changed: [] // Was wurde geändert
        };
      }
      
      // Speichere entfernte Phrasen/Wörter (schlecht)
      diffAnalysis.removed.forEach(item => {
        const existing = stats.diffPatterns[primarySituation].removed.find(r => 
          similarity(r.text.toLowerCase(), item.toLowerCase()) > 0.7
        );
        if (existing) {
          existing.count++;
        } else {
          stats.diffPatterns[primarySituation].removed.push({
            text: item,
            count: 1,
            contexts: [extractWords(customerMessage).slice(0, 5).join(' ')]
          });
        }
      });
      
      // Speichere hinzugefügte Phrasen/Wörter (gut)
      diffAnalysis.added.forEach(item => {
        const existing = stats.diffPatterns[primarySituation].added.find(a => 
          similarity(a.text.toLowerCase(), item.toLowerCase()) > 0.7
        );
        if (existing) {
          existing.count++;
        } else {
          stats.diffPatterns[primarySituation].added.push({
            text: item,
            count: 1,
            contexts: [extractWords(customerMessage).slice(0, 5).join(' ')]
          });
        }
      });
      
      // Speichere geänderte Phrasen
      diffAnalysis.changed.forEach(change => {
        const existing = stats.diffPatterns[primarySituation].changed.find(c => 
          similarity(c.from.toLowerCase(), change.from.toLowerCase()) > 0.7
        );
        if (existing) {
          existing.count++;
        } else {
          stats.diffPatterns[primarySituation].changed.push({
            from: change.from,
            to: change.to,
            count: 1,
            contexts: [extractWords(customerMessage).slice(0, 5).join(' ')]
          });
        }
      });
      
      // Limitiere auf Top 50 pro Kategorie
      stats.diffPatterns[primarySituation].removed.sort((a, b) => b.count - a.count);
      stats.diffPatterns[primarySituation].removed = stats.diffPatterns[primarySituation].removed.slice(0, 50);
      
      stats.diffPatterns[primarySituation].added.sort((a, b) => b.count - a.count);
      stats.diffPatterns[primarySituation].added = stats.diffPatterns[primarySituation].added.slice(0, 50);
      
      stats.diffPatterns[primarySituation].changed.sort((a, b) => b.count - a.count);
      stats.diffPatterns[primarySituation].changed = stats.diffPatterns[primarySituation].changed.slice(0, 50);
      
      console.log(`✅ Diff-Analyse durchgeführt: ${diffAnalysis.removed.length} entfernt, ${diffAnalysis.added.length} hinzugefügt, ${diffAnalysis.changed.length} geändert`);
      
      // 🚨🚨🚨 NEU: Automatische Prinzipien-Extraktion aus Diff-Analyse (OHNE Begründung!)
      // Das System lernt automatisch Prinzipien aus den Änderungen
      const autoPrinciples = extractPrinciplesFromDiff(diffAnalysis, aiResponse, editedResponse, customerMessage);
      if (autoPrinciples.length > 0) {
        autoPrinciples.forEach(principle => {
          const existingPrinciple = stats.reasoningPrinciples.find(p => 
            similarity(p.text.toLowerCase(), principle.toLowerCase()) > 0.7
          );
          
          if (existingPrinciple) {
            existingPrinciple.count++;
            existingPrinciple.lastUsed = new Date().toISOString();
            if (situationsArray.length > 0) {
              situationsArray.forEach(sit => {
                if (!existingPrinciple.situations.includes(sit)) {
                  existingPrinciple.situations.push(sit);
                }
              });
            }
          } else {
            stats.reasoningPrinciples.push({
              text: principle,
              count: 1,
              situations: situationsArray.length > 0 ? [...situationsArray] : [primarySituation],
              lastUsed: new Date().toISOString(),
              source: 'auto_diff' // Markierung: Automatisch aus Diff-Analyse extrahiert
            });
          }
        });
        console.log(`🧠 ${autoPrinciples.length} Prinzipien automatisch aus Diff-Analyse extrahiert (OHNE Begründung!): ${autoPrinciples.join(', ')}`);
      }
    }
  }
  
  // 🚨🚨🚨 NEU: VERBESSERTER FEEDBACK-LOOP: Schnelleres Lernen, Gewichtung, Analyse 🚨🚨🚨
  // Tracke, welche Training-Beispiele verwendet wurden und wie gut sie performt haben
  // WICHTIG: Wir tracken nur die Beispiele, die für die ORIGINAL-Antwort (aiResponse) verwendet wurden
  // Wenn die Antwort bearbeitet wurde, bedeutet das, dass die Original-Antwort schlecht war
  if (usedExampleIds && Array.isArray(usedExampleIds) && usedExampleIds.length > 0) {
    const isGood = status === 'good'; // Nur wenn explizit als "gut" markiert
    const isBad = status === 'edited' && editedResponse; // Wenn bearbeitet wurde, war Original schlecht
    
    // 🚨 WICHTIG: KEINE zeitliche Gewichtung - alle Feedbacks sind gleich wertvoll!
    // Alte Feedbacks sind genauso wichtig wie neue, da das System aus ihnen lernt.
    usedExampleIds.forEach(exampleId => {
      if (!exampleId) return; // Überspringe leere IDs
      
      // Initialisiere Beispiel-Performance-Struktur
      if (!stats.examplePerformance[exampleId]) {
        stats.examplePerformance[exampleId] = {};
      }
      
      // Initialisiere Situation-Performance für dieses Beispiel
      if (!stats.examplePerformance[exampleId][primarySituation]) {
        stats.examplePerformance[exampleId][primarySituation] = {
          good: 0,
          bad: 0,
          total: 0,
          successRate: 0.5, // Startwert: neutral
          lastUpdated: now
        };
      }
      
      const examplePerf = stats.examplePerformance[exampleId][primarySituation];
      
      // Alle Feedbacks haben gleiches Gewicht (keine zeitliche Gewichtung)
      if (isGood) {
        examplePerf.good++;
      }
      if (isBad) {
        examplePerf.bad++;
      }
      examplePerf.total++;
      examplePerf.lastUpdated = now;
      
      // Berechne Erfolgsrate (einfach: good - bad / total)
      const successRate = examplePerf.total > 0 
        ? (examplePerf.good - examplePerf.bad) / examplePerf.total 
        : 0.5;
      
      // Normalisiere auf 0-1 für einfachere Verwendung
      examplePerf.successRate = (successRate + 1) / 2; // -1..1 → 0..1
      
      console.log(`📊 Beispiel-Performance aktualisiert: Beispiel ${exampleId} in Situation "${primarySituation}": ${examplePerf.good} gut, ${examplePerf.bad} schlecht, Erfolgsrate: ${(examplePerf.successRate * 100).toFixed(0)}%`);
    });
  }
  
  // 🚨🚨🚨 NEU: FEEDBACK-ANALYSE: Warum war etwas gut/schlecht?
  // ⚠️ OPTIONAL: Begründungen sind NICHT notwendig! Das System lernt hauptsächlich aus Diff-Analyse.
  // Diese Analyse ist nur ein "Nice-to-have" für zusätzliche abstrakte Prinzipien.
  if (reasoning && typeof reasoning === 'string' && reasoning.trim().length > 0) {
    const reasoningLower = reasoning.toLowerCase();
    
    // Analysiere, warum etwas gut war
    if (status === 'good' || (status === 'edited' && editedResponse)) {
      const positiveKeywords = ['gut', 'passend', 'natürlich', 'authentisch', 'relevant', 'angemessen', 'hilfreich'];
      const hasPositiveReasoning = positiveKeywords.some(keyword => reasoningLower.includes(keyword));
      
      if (hasPositiveReasoning) {
        if (!stats.reasoningPrinciples) stats.reasoningPrinciples = [];
        const principle = {
          principle: reasoning.substring(0, 200),
          situation: primarySituation,
          timestamp: Date.now(),
          count: 1
        };
        
        const existingPrinciple = stats.reasoningPrinciples.find(p => 
          p.situation === primarySituation && 
          p.principle.toLowerCase().includes(reasoningLower.substring(0, 50))
        );
        
        if (existingPrinciple) {
          existingPrinciple.count++;
          existingPrinciple.timestamp = Date.now();
        } else {
          stats.reasoningPrinciples.push(principle);
        }
        
        console.log(`✅ Positive Reasoning-Prinzip gespeichert für "${primarySituation}": ${principle.principle.substring(0, 50)}...`);
      }
    }
    
    // Analysiere, warum etwas schlecht war
    if (status === 'edited' && editedResponse) {
      const negativeKeywords = ['schlecht', 'falsch', 'unpassend', 'unnatürlich', 'irrelevant', 'unangemessen', 'paraphrasieren', 'wiederholung'];
      const hasNegativeReasoning = negativeKeywords.some(keyword => reasoningLower.includes(keyword));
      
      if (hasNegativeReasoning) {
        if (!stats.negativeReasoningPrinciples) stats.negativeReasoningPrinciples = [];
        const principle = {
          principle: reasoning.substring(0, 200),
          situation: primarySituation,
          timestamp: Date.now(),
          count: 1
        };
        
        const existingPrinciple = stats.negativeReasoningPrinciples.find(p => 
          p.situation === primarySituation && 
          p.principle.toLowerCase().includes(reasoningLower.substring(0, 50))
        );
        
        if (existingPrinciple) {
          existingPrinciple.count++;
          existingPrinciple.timestamp = Date.now();
        } else {
          stats.negativeReasoningPrinciples.push(principle);
        }
        
        console.log(`❌ Negative Reasoning-Prinzip gespeichert für "${primarySituation}": ${principle.principle.substring(0, 50)}...`);
      }
    }
  }
  
  // Sortiere und limitiere responsePatterns (behalte nur die besten)
  stats.responsePatterns.sort((a, b) => b.successCount - a.successCount);
  stats.responsePatterns = stats.responsePatterns.slice(0, 100); // Top 100 Muster
  
  // 🚨 NEU: Sortiere und limitiere reasoningPrinciples (behalte nur die besten)
  if (stats.reasoningPrinciples) {
    stats.reasoningPrinciples.sort((a, b) => b.count - a.count);
    stats.reasoningPrinciples = stats.reasoningPrinciples.slice(0, 50); // Top 50 Prinzipien
  }
  
  // 🚨🚨🚨 KRITISCH: Automatische Bereinigung - Entferne alte/ungültige Muster 🚨🚨🚨
  await cleanupLearningStats(stats);
  
  // 🚨🚨🚨 KRITISCH: Feedback-Loop-Validierung - Prüfe ob gelernte Muster helfen 🚨🚨🚨
  await validateFeedbackLoop(stats, goodResponse, badResponse, primarySituation, status);
  
  // Speichere lokal, pushe auf GitHub nur wenn gewünscht (nicht während Initialisierung)
  await saveLearningStats(stats, pushToGitHub);
  return stats;
}

// 🚨🚨🚨 NEU: Feedback-Loop-Validierung - Prüft ob gelernte Muster wirklich helfen
async function validateFeedbackLoop(stats, goodResponse, badResponse, situation, status) {
  if (!stats || !stats.feedbackValidation) return;
  
  const now = Date.now();
  
  // Validiere responsePatterns: Wurden sie verwendet und waren sie erfolgreich?
  if (stats.responsePatterns && Array.isArray(stats.responsePatterns)) {
    stats.responsePatterns.forEach((pattern, idx) => {
      if (pattern.situation === situation) {
        const patternId = `responsePattern_${idx}`;
        
        if (!stats.feedbackValidation[patternId]) {
          stats.feedbackValidation[patternId] = {
            usedCount: 0,
            successCount: 0,
            lastValidated: now
          };
        }
        
        // Prüfe ob Pattern in guter Antwort verwendet wurde
        if (goodResponse && pattern.goodResponse) {
          const patternUsed = goodResponse.toLowerCase().includes(pattern.goodResponse.substring(0, 50).toLowerCase());
          if (patternUsed) {
            stats.feedbackValidation[patternId].usedCount++;
            if (status === 'good' || status === 'edited') {
              stats.feedbackValidation[patternId].successCount++;
            }
            stats.feedbackValidation[patternId].lastValidated = now;
          }
        }
        
        // Berechne Erfolgsrate
        const validation = stats.feedbackValidation[patternId];
        if (validation.usedCount > 0) {
          const successRate = validation.successCount / validation.usedCount;
          pattern.validatedSuccessRate = successRate;
          
          // Wenn Erfolgsrate < 50% nach 5+ Verwendungen, markiere als problematisch
          if (validation.usedCount >= 5 && successRate < 0.5) {
            pattern.isProblematic = true;
            console.log(`⚠️ Pattern-Validierung: Pattern ${patternId} hat niedrige Erfolgsrate (${(successRate * 100).toFixed(0)}%)`);
          }
        }
      }
    });
  }
  
  // Validiere reasoningPrinciples: Wurden sie befolgt und waren sie erfolgreich?
  if (stats.reasoningPrinciples && Array.isArray(stats.reasoningPrinciples)) {
    stats.reasoningPrinciples.forEach((principle, idx) => {
      const principleId = `reasoningPrinciple_${idx}`;
      
      if (!stats.feedbackValidation[principleId]) {
        stats.feedbackValidation[principleId] = {
          usedCount: 0,
          successCount: 0,
          lastValidated: now
        };
      }
      
      // Prüfe ob Prinzip in guter Antwort befolgt wurde (vereinfacht)
      if (goodResponse && principle.text) {
        const principleKeywords = principle.text.toLowerCase().split(/\s+/).slice(0, 3);
        const principleFollowed = principleKeywords.some(keyword => 
          goodResponse.toLowerCase().includes(keyword)
        );
        
        if (principleFollowed) {
          stats.feedbackValidation[principleId].usedCount++;
          if (status === 'good' || status === 'edited') {
            stats.feedbackValidation[principleId].successCount++;
          }
          stats.feedbackValidation[principleId].lastValidated = now;
        }
      }
    });
  }
  
  console.log(`✅ Feedback-Loop-Validierung durchgeführt: ${Object.keys(stats.feedbackValidation).length} Muster validiert`);
}

// 🚨🚨🚨 NEU: Automatische Bereinigung von Learning-Stats
async function cleanupLearningStats(stats) {
  if (!stats) return;
  
  const now = Date.now();
  const daysToKeep = 90; // Muster älter als 90 Tage werden entfernt (wenn nicht häufig verwendet)
  const minCountToKeep = 3; // Mindestanzahl Verwendungen, um altes Muster zu behalten
  
  // Bereinige responsePatterns
  if (stats.responsePatterns && Array.isArray(stats.responsePatterns)) {
    stats.responsePatterns = stats.responsePatterns.filter(pattern => {
      if (!pattern.lastUsed) return true; // Kein Datum = behalten
      const lastUsed = new Date(pattern.lastUsed).getTime();
      const daysOld = (now - lastUsed) / (1000 * 60 * 60 * 24);
      
      // Behalte wenn: neu (< 90 Tage) ODER häufig verwendet (>= 3x)
      return daysOld < daysToKeep || pattern.successCount >= minCountToKeep;
    });
    console.log(`🧹 Bereinigung: ${stats.responsePatterns.length} responsePatterns nach Bereinigung`);
  }
  
  // Bereinige reasoningPrinciples
  if (stats.reasoningPrinciples && Array.isArray(stats.reasoningPrinciples)) {
    stats.reasoningPrinciples = stats.reasoningPrinciples.filter(principle => {
      if (!principle.lastUsed) return true;
      const lastUsed = new Date(principle.lastUsed).getTime();
      const daysOld = (now - lastUsed) / (1000 * 60 * 60 * 24);
      
      return daysOld < daysToKeep || principle.count >= minCountToKeep;
    });
    console.log(`🧹 Bereinigung: ${stats.reasoningPrinciples.length} reasoningPrinciples nach Bereinigung`);
  }
  
  // Bereinige diffPatterns (entferne Einträge mit count = 1 und älter als 30 Tage)
  if (stats.diffPatterns && typeof stats.diffPatterns === 'object') {
    Object.keys(stats.diffPatterns).forEach(situation => {
      const diffData = stats.diffPatterns[situation];
      if (diffData.removed) {
        diffData.removed = diffData.removed.filter(item => {
          // Behalte wenn: count >= 2 ODER neu
          return item.count >= 2;
        });
      }
      if (diffData.added) {
        diffData.added = diffData.added.filter(item => {
          return item.count >= 2;
        });
      }
      if (diffData.changed) {
        diffData.changed = diffData.changed.filter(item => {
          return item.count >= 2;
        });
      }
    });
  }
  
  // Bereinige wordFrequency (entferne Wörter mit sehr niedriger Differenz)
  if (stats.wordFrequency && typeof stats.wordFrequency === 'object') {
    Object.keys(stats.wordFrequency).forEach(situation => {
      const wordFreq = stats.wordFrequency[situation];
      if (wordFreq && typeof wordFreq === 'object') {
        Object.keys(wordFreq).forEach(word => {
          const freq = wordFreq[word];
          const diff = Math.abs(freq.good - freq.bad);
          const total = freq.good + freq.bad;
          
          // Entferne wenn: sehr niedrige Differenz (< 2) UND niedrige Gesamtzahl (< 3)
          if (diff < 2 && total < 3) {
            delete wordFreq[word];
          }
        });
      }
    });
  }
  
  // Bereinige proactivePatterns
  if (stats.proactivePatterns && Array.isArray(stats.proactivePatterns)) {
    stats.proactivePatterns = stats.proactivePatterns.filter(pattern => {
      if (!pattern.lastUsed) return true;
      const lastUsed = new Date(pattern.lastUsed).getTime();
      const daysOld = (now - lastUsed) / (1000 * 60 * 60 * 24);
      
      return daysOld < daysToKeep || pattern.count >= minCountToKeep;
    });
  }
  
  console.log(`✅ Automatische Bereinigung abgeschlossen`);
}

// 🚨 NEU: Analysiere Nachrichtenstatistiken (Länge, Ausrufezeichen, Fragen)
function analyzeMessageStats(message, situation, stats, isPositive) {
  if (!message || typeof message !== 'string' || !situation) return;
  
  // Initialisiere Statistiken für diese Situation
  if (!stats.messageStats[situation]) {
    stats.messageStats[situation] = {
      positive: { lengths: [], exclamationMarks: [], questions: [], count: 0 },
      negative: { lengths: [], exclamationMarks: [], questions: [], count: 0 }
    };
  }
  
  const situationStats = stats.messageStats[situation];
  const targetStats = isPositive ? situationStats.positive : situationStats.negative;
  
  // Analysiere Nachricht
  const length = message.length;
  const exclamationCount = (message.match(/!/g) || []).length;
  const questionCount = (message.match(/\?/g) || []).length;
  
  // Speichere Werte
  targetStats.lengths.push(length);
  targetStats.exclamationMarks.push(exclamationCount);
  targetStats.questions.push(questionCount);
  targetStats.count++;
  
  // Berechne Statistiken (Durchschnitt, Min, Max, Median)
  if (targetStats.lengths.length > 0) {
    const sortedLengths = [...targetStats.lengths].sort((a, b) => a - b);
    const sortedExclamations = [...targetStats.exclamationMarks].sort((a, b) => a - b);
    const sortedQuestions = [...targetStats.questions].sort((a, b) => a - b);
    
    targetStats.avgLength = Math.round(targetStats.lengths.reduce((a, b) => a + b, 0) / targetStats.lengths.length);
    targetStats.minLength = sortedLengths[0];
    targetStats.maxLength = sortedLengths[sortedLengths.length - 1];
    targetStats.medianLength = sortedLengths[Math.floor(sortedLengths.length / 2)];
    
    targetStats.avgExclamationMarks = Math.round((targetStats.exclamationMarks.reduce((a, b) => a + b, 0) / targetStats.exclamationMarks.length) * 10) / 10;
    targetStats.minExclamationMarks = sortedExclamations[0];
    targetStats.maxExclamationMarks = sortedExclamations[sortedExclamations.length - 1];
    targetStats.medianExclamationMarks = sortedExclamations[Math.floor(sortedExclamations.length / 2)];
    
    targetStats.avgQuestions = Math.round((targetStats.questions.reduce((a, b) => a + b, 0) / targetStats.questions.length) * 10) / 10;
    targetStats.minQuestions = sortedQuestions[0];
    targetStats.maxQuestions = sortedQuestions[sortedQuestions.length - 1];
    targetStats.medianQuestions = sortedQuestions[Math.floor(sortedQuestions.length / 2)];
    
    // Berechne Verteilung (für Länge)
    const lengthRanges = {
      "0-100": 0,
      "100-120": 0,
      "120-150": 0,
      "150-200": 0,
      "200-250": 0,
      "250+": 0
    };
    targetStats.lengths.forEach(l => {
      if (l < 100) lengthRanges["0-100"]++;
      else if (l < 120) lengthRanges["100-120"]++;
      else if (l < 150) lengthRanges["120-150"]++;
      else if (l < 200) lengthRanges["150-200"]++;
      else if (l < 250) lengthRanges["200-250"]++;
      else lengthRanges["250+"]++;
    });
    targetStats.lengthDistribution = {};
    Object.keys(lengthRanges).forEach(range => {
      targetStats.lengthDistribution[range] = Math.round((lengthRanges[range] / targetStats.lengths.length) * 100);
    });
    
    // Berechne Verteilung (für Fragen)
    const questionDistribution = { "0": 0, "1": 0, "2": 0, "3+": 0 };
    targetStats.questions.forEach(q => {
      if (q === 0) questionDistribution["0"]++;
      else if (q === 1) questionDistribution["1"]++;
      else if (q === 2) questionDistribution["2"]++;
      else questionDistribution["3+"]++;
    });
    targetStats.questionDistribution = {};
    Object.keys(questionDistribution).forEach(key => {
      targetStats.questionDistribution[key] = Math.round((questionDistribution[key] / targetStats.questions.length) * 100);
    });
  }
}

// Extrahiere Wörter aus Text (relevante Wörter, keine Stopwords)
function extractWords(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const stopwords = ['der', 'die', 'das', 'und', 'oder', 'aber', 'dass', 'ist', 'sind', 'war', 'wurde', 'haben', 'hat', 'sein', 'wird', 'kann', 'muss', 'soll', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mir', 'dir', 'ihm', 'ihr', 'uns', 'euch', 'ihnen', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'mit', 'von', 'zu', 'auf', 'für', 'an', 'in', 'aus', 'bei', 'nach', 'über', 'unter', 'vor', 'hinter', 'neben', 'zwischen', 'durch', 'gegen', 'ohne', 'um', 'bis', 'seit', 'während', 'wegen', 'trotz', 'dank'];
  const words = lower.match(/\b[a-zäöü]{3,}\b/g) || [];
  return words.filter(w => !stopwords.includes(w) && w.length >= 3);
}

// 🚨 NEU: Extrahiere Fragen aus Text
function extractQuestions(text) {
  if (!text || typeof text !== 'string') return [];
  
  // Finde alle Sätze, die mit ? enden
  const questionMatches = text.match(/[^.!?]*\?/g);
  if (!questionMatches) return [];
  
  // Bereinige und filtere Fragen
  const questions = questionMatches
    .map(q => q.trim())
    .filter(q => {
      // Filtere zu kurze Fragen (< 5 Zeichen) und zu lange (> 200 Zeichen)
      if (q.length < 5 || q.length > 200) return false;
      // Filtere Fragen, die nur aus Interpunktion bestehen
      if (q.replace(/[?!.\s]/g, '').length === 0) return false;
      return true;
    });
  
  return questions;
}

// Extrahiere Muster aus Text (Phrasen, Satzstrukturen)
function extractPatterns(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const patterns = [];
  
  // Häufige gute Phrasen erkennen
  const goodPhrases = [
    'würde mir gefallen', 'klingt geil', 'finde ich', 'würde ich', 'könnte ich',
    'würdest du', 'würde es', 'wäre es', 'würde gerne', 'möchte ich',
    'das würde', 'das klingt', 'das finde', 'das wäre'
  ];
  
  goodPhrases.forEach(phrase => {
    if (lower.includes(phrase)) {
      patterns.push(phrase);
    }
  });
  
  // Satzstrukturen erkennen (z.B. "Wie würdest du...", "Was wäre...")
  const structurePatterns = [
    /wie würdest du .{0,30}\?/gi,
    /was wäre .{0,30}\?/gi,
    /würdest du .{0,30}\?/gi,
    /könntest du .{0,30}\?/gi
  ];
  
  structurePatterns.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => {
        patterns.push(match.substring(0, 50)); // Erste 50 Zeichen als Muster
      });
    }
  });
  
  return patterns;
}

// Extrahiere Muster aus Kundennachricht (für Matching)
function extractCustomerPattern(customerMessage) {
  if (!customerMessage || typeof customerMessage !== 'string') return '';
  const lower = customerMessage.toLowerCase();
  
  // Extrahiere Schlüsselwörter und Struktur
  const keywords = extractWords(customerMessage).slice(0, 10).join(' ');
  const hasQuestion = lower.includes('?');
  const hasMeeting = lower.includes('treffen') || lower.includes('sehen') || lower.includes('kennenlernen');
  const hasSexual = lower.includes('sex') || lower.includes('geil') || lower.includes('lust');
  
  return {
    keywords,
    hasQuestion,
    hasMeeting,
    hasSexual,
    length: customerMessage.length
  };
}

// 🚨 NEU: Extrahiere Emojis aus Text
function extractEmojis(text) {
  if (!text || typeof text !== 'string') return [];
  
  // Unicode-Emoji-Regex (erkennt die meisten Emojis)
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]/gu;
  const emojis = text.match(emojiRegex) || [];
  
  if (emojis.length === 0) return [];
  
  // Analysiere Position jedes Emojis
  const emojiData = [];
  const textLength = text.length;
  
  emojis.forEach(emoji => {
    const index = text.indexOf(emoji);
    let position = 'middle';
    
    if (index < textLength * 0.2) {
      position = 'start';
    } else if (index > textLength * 0.8) {
      position = 'end';
    }
    
    emojiData.push({ emoji, position });
  });
  
  return emojiData;
}

// 🚨🚨🚨 VERBESSERT: Semantische Diff-Analyse mit Kontext-Analyse
function analyzeDiff(original, edited) {
  if (!original || !edited || typeof original !== 'string' || typeof edited !== 'string') {
    return { removed: [], added: [], changed: [] };
  }
  
  const originalWords = original.split(/\s+/);
  const editedWords = edited.split(/\s+/);
  
  // Einfache Diff-Analyse: Finde entfernte und hinzugefügte Wörter/Phrasen
  const removed = [];
  const added = [];
  const changed = [];
  
  // 🚨 NEU: Semantisch ähnliche Wörter-Gruppen (um Falsch-Positive zu vermeiden)
  const similarWordGroups = [
    ['super', 'toll', 'geil', 'cool', 'wunderbar', 'schön', 'gut', 'spannend', 'interessant'],
    ['finde', 'mag', 'liebe', 'gefällt', 'möchte', 'würde'],
    ['klingt', 'scheint', 'wirkt', 'ist'],
    ['machst', 'tust', 'machst du', 'tust du'],
    ['denn', 'eigentlich', 'überhaupt'],
    ['so', 'denn so', 'denn']
  ];
  
  // Hilfsfunktion: Prüfe ob Wörter semantisch ähnlich sind
  const areSemanticallySimilar = (word1, word2) => {
    const w1 = word1.toLowerCase().replace(/[.,!?;:]/g, '');
    const w2 = word2.toLowerCase().replace(/[.,!?;:]/g, '');
    if (w1 === w2) return true;
    
    // Prüfe ähnliche Wort-Gruppen
    for (const group of similarWordGroups) {
      const inGroup1 = group.some(g => w1.includes(g) || g.includes(w1));
      const inGroup2 = group.some(g => w2.includes(g) || g.includes(w2));
      if (inGroup1 && inGroup2) return true;
    }
    
    // Prüfe Ähnlichkeit (gleiche Wurzel)
    if (w1.length > 4 && w2.length > 4) {
      const commonChars = w1.split('').filter(c => w2.includes(c)).length;
      const similarity = commonChars / Math.max(w1.length, w2.length);
      if (similarity > 0.7) return true;
    }
    
    return false;
  };
  
  // Finde entfernte Wörter (in original, aber nicht in edited) - mit semantischer Prüfung
  originalWords.forEach((word, idx) => {
    const cleanWord = word.replace(/[.,!?;:]/g, '').toLowerCase();
    if (cleanWord.length > 3) {
      // Prüfe ob es ein semantisch ähnliches Wort in edited gibt
      const hasSimilar = editedWords.some(ew => {
        const cleanEw = ew.replace(/[.,!?;:]/g, '').toLowerCase();
        return areSemanticallySimilar(cleanWord, cleanEw);
      });
      
      if (!hasSimilar) {
        // Prüfe ob es eine Phrase ist (mehrere Wörter zusammen)
        if (idx < originalWords.length - 1) {
          const phrase = originalWords.slice(idx, Math.min(idx + 3, originalWords.length)).join(' ');
          if (phrase.length > 10) {
            // Prüfe ob ähnliche Phrase in edited existiert
            const hasSimilarPhrase = editedWords.some((ew, eIdx) => {
              if (eIdx < editedWords.length - 1) {
                const editedPhrase = editedWords.slice(eIdx, Math.min(eIdx + 3, editedWords.length)).join(' ');
                return calculatePhraseSimilarity(phrase, editedPhrase) > 0.6;
              }
              return false;
            });
            if (!hasSimilarPhrase && !edited.toLowerCase().includes(phrase.toLowerCase())) {
              removed.push(phrase);
            }
          }
        }
        if (!removed.some(r => r.toLowerCase().includes(cleanWord) || cleanWord.includes(r.toLowerCase()))) {
          removed.push(word);
        }
      }
    }
  });
  
  // Finde hinzugefügte Wörter (in edited, aber nicht in original) - mit semantischer Prüfung
  editedWords.forEach((word, idx) => {
    const cleanWord = word.replace(/[.,!?;:]/g, '').toLowerCase();
    if (cleanWord.length > 3) {
      // Prüfe ob es ein semantisch ähnliches Wort in original gibt
      const hasSimilar = originalWords.some(ow => {
        const cleanOw = ow.replace(/[.,!?;:]/g, '').toLowerCase();
        return areSemanticallySimilar(cleanWord, cleanOw);
      });
      
      if (!hasSimilar) {
        // Prüfe ob es eine Phrase ist
        if (idx < editedWords.length - 1) {
          const phrase = editedWords.slice(idx, Math.min(idx + 3, editedWords.length)).join(' ');
          if (phrase.length > 10) {
            // Prüfe ob ähnliche Phrase in original existiert
            const hasSimilarPhrase = originalWords.some((ow, oIdx) => {
              if (oIdx < originalWords.length - 1) {
                const originalPhrase = originalWords.slice(oIdx, Math.min(oIdx + 3, originalWords.length)).join(' ');
                return calculatePhraseSimilarity(phrase, originalPhrase) > 0.6;
              }
              return false;
            });
            if (!hasSimilarPhrase && !original.toLowerCase().includes(phrase.toLowerCase())) {
              added.push(phrase);
            }
          }
        }
        if (!added.some(a => a.toLowerCase().includes(cleanWord) || cleanWord.includes(a.toLowerCase()))) {
          added.push(word);
        }
      }
    }
  });
  
  // Finde geänderte Phrasen (ähnlich, aber unterschiedlich) - verbesserte Erkennung
  const originalPhrases = [];
  const editedPhrases = [];
  
  for (let i = 0; i < originalWords.length - 2; i++) {
    originalPhrases.push(originalWords.slice(i, i + 3).join(' '));
  }
  
  for (let i = 0; i < editedWords.length - 2; i++) {
    editedPhrases.push(editedWords.slice(i, i + 3).join(' '));
  }
  
  originalPhrases.forEach(origPhrase => {
    editedPhrases.forEach(editPhrase => {
      const similarity = calculatePhraseSimilarity(origPhrase, editPhrase);
      if (similarity > 0.5 && similarity < 0.9) {
        // Ähnlich, aber nicht gleich - nur wenn wirklich unterschiedlich
        const origLower = origPhrase.toLowerCase();
        const editLower = editPhrase.toLowerCase();
        if (origLower !== editLower && !origLower.includes(editLower) && !editLower.includes(origLower)) {
          changed.push({ from: origPhrase, to: editPhrase });
        }
      }
    });
  });
  
  // Entferne Duplikate
  const uniqueRemoved = [...new Set(removed)];
  const uniqueAdded = [...new Set(added)];
  const uniqueChanged = changed.filter((c, idx, self) => 
    idx === self.findIndex(t => t.from === c.from && t.to === c.to)
  );
  
  return { removed: uniqueRemoved, added: uniqueAdded, changed: uniqueChanged };
}

// 🚨 NEU: Berechne Ähnlichkeit zwischen zwei Phrasen
function calculatePhraseSimilarity(phrase1, phrase2) {
  if (!phrase1 || !phrase2) return 0;
  
  const words1 = phrase1.toLowerCase().split(/\s+/);
  const words2 = phrase2.toLowerCase().split(/\s+/);
  const common = words1.filter(w => words2.includes(w)).length;
  return common / Math.max(words1.length, words2.length);
}

// 🚨 NEU: Analysiere Satzstrukturen
function analyzeSentenceStructures(text) {
  if (!text || typeof text !== 'string') return [];
  
  const structures = [];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  
  sentences.forEach(sentence => {
    const trimmed = sentence.trim();
    if (trimmed.length < 5) return;
    
    // Satztyp erkennen
    let type = 'statement';
    if (trimmed.endsWith('?')) {
      type = 'question';
    } else if (trimmed.endsWith('!')) {
      type = 'exclamation';
    }
    
    // Satzlänge-Kategorie
    let lengthCategory = 'short';
    if (trimmed.length > 100) {
      lengthCategory = 'long';
    } else if (trimmed.length > 50) {
      lengthCategory = 'medium';
    }
    
    // Satzstruktur erkennen
    const lower = trimmed.toLowerCase();
    let structureType = 'simple';
    
    // Komplexe Strukturen erkennen
    if (lower.includes('aber') || lower.includes('jedoch') || lower.includes('allerdings')) {
      structureType = 'contrast';
    } else if (lower.includes('weil') || lower.includes('da') || lower.includes('denn')) {
      structureType = 'causal';
    } else if (lower.includes('wenn') || lower.includes('falls')) {
      structureType = 'conditional';
    } else if (lower.includes(',') && trimmed.split(',').length > 2) {
      structureType = 'complex';
    } else if (trimmed.split(/\s+/).length > 15) {
      structureType = 'complex';
    }
    
    // Satzanfang erkennen
    let startType = 'normal';
    if (trimmed.match(/^[A-ZÄÖÜ][a-zäöü]+/)) {
      const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
      if (['ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr'].includes(firstWord)) {
        startType = 'personal';
      } else if (['das', 'die', 'der', 'ein', 'eine'].includes(firstWord)) {
        startType = 'article';
      } else if (['wie', 'was', 'wo', 'wann', 'warum', 'wieso'].includes(firstWord)) {
        startType = 'question-word';
      }
    }
    
    structures.push({
      type: `${type}_${lengthCategory}_${structureType}_${startType}`,
      example: trimmed.substring(0, 100)
    });
  });
  
  return structures;
}

// 🚨 NEU: Analysiere Kommunikationsstil
function analyzeCommunicationStyle(text) {
  if (!text || typeof text !== 'string') return null;
  
  const lower = text.toLowerCase();
  const style = {
    direct: false,
    indirect: false,
    formal: false,
    casual: false,
    emotional: false,
    factual: false,
    proactive: false,
    reactive: false
  };
  
  // Direkt vs. Indirekt
  const directIndicators = ['direkt', 'klar', 'ehrlich', 'offen', 'direkt'];
  const indirectIndicators = ['vielleicht', 'möglicherweise', 'könnte', 'würde', 'könnte sein'];
  
  if (directIndicators.some(ind => lower.includes(ind)) || 
      (lower.includes('ich') && lower.includes('will') || lower.includes('möchte'))) {
    style.direct = true;
  }
  if (indirectIndicators.some(ind => lower.includes(ind))) {
    style.indirect = true;
  }
  
  // Formal vs. Casual
  const formalIndicators = ['sehr geehrter', 'mit freundlichen grüßen', 'gerne', 'vielen dank'];
  const casualIndicators = ['hey', 'na', 'haha', 'lol', '😅', '😂', '😏'];
  
  if (formalIndicators.some(ind => lower.includes(ind))) {
    style.formal = true;
  }
  // 🚨 FIX: Verwende extractEmojis statt ungültigem Regex
  const emojis = extractEmojis(text);
  if (casualIndicators.some(ind => lower.includes(ind)) || emojis.length > 0) {
    style.casual = true;
  }
  
  // Emotional vs. Factual
  const emotionalIndicators = ['geil', 'toll', 'super', 'wunderbar', 'schön', 'liebe', 'mag', 'gefällt'];
  const factualIndicators = ['ist', 'sind', 'war', 'wurde', 'habe', 'hat'];
  
  const emotionalCount = emotionalIndicators.filter(ind => lower.includes(ind)).length;
  const factualCount = factualIndicators.filter(ind => lower.includes(ind)).length;
  
  if (emotionalCount > factualCount || lower.includes('!')) {
    style.emotional = true;
  }
  if (factualCount > emotionalCount && !lower.includes('!')) {
    style.factual = true;
  }
  
  // Proaktiv vs. Reaktiv
  // Proaktiv: Eigene Vorlieben/Interessen nennen BEVOR gefragt wird
  const proactivePatterns = [
    /ich (liebe|mag|habe gerne|möchte)/i,
    /ich (bin|war|werde)/i,
    /mein (lieblings|favorit)/i
  ];
  
  const reactivePatterns = [
    /was (machst|tust|denkst|meinst)/i,
    /wie (geht|ist|findest)/i,
    /warum (bist|hast|machst)/i
  ];
  
  const hasProactive = proactivePatterns.some(pattern => pattern.test(text));
  const hasReactive = reactivePatterns.some(pattern => pattern.test(text));
  
  // Proaktiv: Wenn eigene Vorlieben vor Fragen kommen
  const sentences = text.split(/(?<=[.!?])\s+/);
  let proactiveIndex = -1;
  let reactiveIndex = -1;
  
  sentences.forEach((sentence, idx) => {
    if (proactivePatterns.some(p => p.test(sentence)) && proactiveIndex === -1) {
      proactiveIndex = idx;
    }
    if (reactivePatterns.some(p => p.test(sentence)) && reactiveIndex === -1) {
      reactiveIndex = idx;
    }
  });
  
  if (proactiveIndex !== -1 && (reactiveIndex === -1 || proactiveIndex < reactiveIndex)) {
    style.proactive = true;
  }
  if (reactiveIndex !== -1 && (proactiveIndex === -1 || reactiveIndex < proactiveIndex)) {
    style.reactive = true;
  }
  
  return style;
}

// Berechne Ähnlichkeit zwischen zwei Mustern
function similarity(pattern1, pattern2) {
  if (!pattern1 || !pattern2) return 0;
  if (typeof pattern1 === 'string' && typeof pattern2 === 'string') {
    // Einfache String-Ähnlichkeit
    const words1 = pattern1.toLowerCase().split(/\s+/);
    const words2 = pattern2.toLowerCase().split(/\s+/);
    const common = words1.filter(w => words2.includes(w)).length;
    return common / Math.max(words1.length, words2.length);
  }
  
  // Objekt-Ähnlichkeit
  if (typeof pattern1 === 'object' && typeof pattern2 === 'object') {
    let score = 0;
    let maxScore = 0;
    
    if (pattern1.keywords && pattern2.keywords) {
      const words1 = pattern1.keywords.split(/\s+/);
      const words2 = pattern2.keywords.split(/\s+/);
      const common = words1.filter(w => words2.includes(w)).length;
      score += common / Math.max(words1.length, words2.length);
      maxScore += 1;
    }
    
    if (pattern1.hasQuestion === pattern2.hasQuestion) score += 1;
    maxScore += 1;
    if (pattern1.hasMeeting === pattern2.hasMeeting) score += 1;
    maxScore += 1;
    if (pattern1.hasSexual === pattern2.hasSexual) score += 1;
    maxScore += 1;
    
    return maxScore > 0 ? score / maxScore : 0;
  }
  
  return 0;
}

// 🚨🚨🚨 NEU: Automatische Prinzipien-Extraktion aus Diff-Analyse (OHNE Begründung!)
// Diese Funktion extrahiert automatisch Prinzipien aus den Änderungen zwischen Original und Bearbeitung
function extractPrinciplesFromDiff(diffAnalysis, original, edited, customerMessage) {
  if (!diffAnalysis || !original || !edited) return [];
  
  const principles = [];
  const originalLower = original.toLowerCase();
  const editedLower = edited.toLowerCase();
  const customerLower = customerMessage ? customerMessage.toLowerCase() : '';
  
  // 1. Prüfe, ob generische Phrasen entfernt wurden
  const genericPhrases = ['klingt super', 'klingt gut', 'klingt interessant', 'das ist cool', 'das ist geil', 'finde ich gut', 'finde ich super', 'das gefällt mir', 'das ist schön'];
  const removedGeneric = diffAnalysis.removed.some(item => 
    genericPhrases.some(phrase => item.toLowerCase().includes(phrase))
  );
  if (removedGeneric) {
    principles.push('Vermeide generische Phrasen wie "klingt super" oder "finde ich gut" - sei spezifischer');
  }
  
  // 2. Prüfe, ob Fragen hinzugefügt wurden
  const originalQuestions = (original.match(/\?/g) || []).length;
  const editedQuestions = (edited.match(/\?/g) || []).length;
  if (editedQuestions > originalQuestions) {
    principles.push('Stelle Fragen, um das Gespräch am Laufen zu halten');
  }
  
  // 3. Prüfe, ob mehrere Anfragen im Original ignoriert wurden
  const customerQuestionCount = customerMessage ? (customerMessage.match(/\?/g) || []).length : 0;
  const customerHasMultipleTopics = customerMessage ? (
    (customerLower.includes('und') && (customerLower.split('und').length - 1) > 1) ||
    (customerLower.includes(',') && customerLower.split(',').length > 2)
  ) : false;
  
  if (customerHasMultipleTopics || customerQuestionCount > 1) {
    // Prüfe, ob Original nur auf eine Anfrage eingegangen ist
    const originalTopics = extractWords(original).length;
    const editedTopics = extractWords(edited).length;
    if (editedTopics > originalTopics * 1.2) { // Bearbeitung hat deutlich mehr Themen
      principles.push('Gehe auf ALLE Anfragen/Themen ein, nicht nur auf eine');
    }
  }
  
  // 4. Prüfe, ob eigene Vorlieben/Interessen hinzugefügt wurden
  const proactivePatterns = ['ich liebe', 'ich mag', 'ich gehe', 'ich mache', 'ich finde', 'ich koche', 'ich spiele', 'ich lese', 'ich schaue', 'ich höre'];
  const originalHasProactive = proactivePatterns.some(pattern => originalLower.includes(pattern));
  const editedHasProactive = proactivePatterns.some(pattern => editedLower.includes(pattern));
  if (!originalHasProactive && editedHasProactive) {
    principles.push('Zeige Eigeninitiative - nenne eigene Vorlieben/Interessen, dann frage');
  }
  
  // 5. Prüfe, ob Antwort länger/kürzer wurde
  const lengthDiff = edited.length - original.length;
  if (lengthDiff > 50) {
    principles.push('Gehe ausführlicher auf Anfragen ein');
  } else if (lengthDiff < -50) {
    principles.push('Sei präziser und direkter - vermeide unnötige Länge');
  }
  
  // 6. Prüfe, ob Emojis hinzugefügt/entfernt wurden
  const originalEmojis = (original.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu) || []).length;
  const editedEmojis = (edited.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu) || []).length;
  if (editedEmojis > originalEmojis) {
    principles.push('Verwende Emojis für mehr Emotion und Wärme');
  } else if (editedEmojis < originalEmojis && originalEmojis > 0) {
    principles.push('Vermeide zu viele Emojis - sei natürlicher');
  }
  
  // 7. Prüfe, ob spezifische Wörter hinzugefügt wurden (statt generischer)
  const specificWords = ['interessant', 'spannend', 'cool', 'geil', 'toll', 'super', 'wunderbar', 'schön'];
  const addedSpecific = diffAnalysis.added.some(item => 
    specificWords.some(word => item.toLowerCase().includes(word))
  );
  if (addedSpecific) {
    principles.push('Verwende spezifische, emotionale Wörter statt generischer Phrasen');
  }
  
  // 8. Prüfe, ob Thema gewechselt wurde (wenn Kunde sexuelles Thema hat, aber Antwort nicht darauf eingeht)
  const hasSexualContent = customerLower.includes('sex') || customerLower.includes('ficken') || customerLower.includes('geil') || customerLower.includes('horny');
  if (hasSexualContent) {
    const originalHasSexual = originalLower.includes('sex') || originalLower.includes('geil') || originalLower.includes('lust');
    const editedHasSexual = editedLower.includes('sex') || editedLower.includes('geil') || editedLower.includes('lust');
    if (originalHasSexual && !editedHasSexual) {
      principles.push('Höflich ablehnen oder ausweichen bei sexuellen Themen');
    }
  }
  
  // 9. Prüfe, ob Treffen-Anfrage abgelehnt wurde
  const hasMeetingRequest = customerLower.includes('treffen') || customerLower.includes('sehen') || customerLower.includes('kennenlernen') || customerLower.includes('date');
  if (hasMeetingRequest) {
    const originalAccepts = originalLower.includes('gerne') || originalLower.includes('ja') || originalLower.includes('klar');
    const editedAccepts = editedLower.includes('gerne') || editedLower.includes('ja') || editedLower.includes('klar');
    if (originalAccepts && !editedAccepts) {
      principles.push('KEINE Treffen zustimmen - höflich ablehnen oder ausweichen');
    }
  }
  
  // 10. Prüfe, ob Antwort natürlicher wurde (weniger Roboter-Sprache)
  const robotPhrases = ['gerne', 'sehr gerne', 'vielen dank', 'gern geschehen', 'kein problem'];
  const removedRobot = diffAnalysis.removed.some(item => 
    robotPhrases.some(phrase => item.toLowerCase().includes(phrase))
  );
  if (removedRobot) {
    principles.push('Vermeide Roboter-Sprache - sei natürlicher und menschlicher');
  }
  
  return principles;
}

// 🚨 NEU: Extrahiere Prinzipien aus Begründungen (reasoning) - OPTIONAL, nur wenn Begründung vorhanden
function extractPrinciplesFromReasoning(reasoning) {
  if (!reasoning || typeof reasoning !== 'string') return [];
  
  const lower = reasoning.toLowerCase();
  const principles = [];
  
  // Erkenne häufige Prinzipien
  const principlePatterns = [
    { pattern: /gehe auf (alle|beide|jede|alle drei)/i, principle: 'Gehe auf ALLE Anfragen ein, nicht nur auf eine' },
    { pattern: /(nicht|keine) ignor/i, principle: 'Ignoriere KEINE Anfrage - gehe auf alle ein' },
    { pattern: /höflich (ablehn|ausweich)/i, principle: 'Höflich ablehnen oder ausweichen' },
    { pattern: /thema (wechseln|lenken)/i, principle: 'Thema natürlich wechseln/lenken' },
    { pattern: /(stelle|frage) (eine|natürlich)/i, principle: 'Stelle eine natürliche Frage' },
    { pattern: /(mehrere|viele) (situation|anfrage)/i, principle: 'Bei mehreren Situationen: Gehe auf ALLE ein' },
    { pattern: /(kombinier|verbind)/i, principle: 'Kombiniere Antworten für mehrere Situationen' },
    { pattern: /(natürlich|authentisch|menschlich)/i, principle: 'Sei natürlich, authentisch und menschlich' },
    { pattern: /(kurz|präzise|direkt)/i, principle: 'Sei kurz, präzise und direkt' },
    { pattern: /(emotional|gefühl|warm)/i, principle: 'Zeige Emotionen und Wärme' },
    { pattern: /(proaktiv|eigeninitiative|eigene vorlieben|eigene interessen)/i, principle: 'Zeige Eigeninitiative - nenne eigene Vorlieben/Interessen, dann frage' },
    { pattern: /(eigene erfahrungen|eigene gedanken|eigene hobbies)/i, principle: 'Teile eigene Erfahrungen/Gedanken/Hobbies, dann frage nach seinen' }
  ];
  
  principlePatterns.forEach(({ pattern, principle }) => {
    if (pattern.test(reasoning)) {
      principles.push(principle);
    }
  });
  
  // Wenn keine Muster gefunden, extrahiere den ersten Satz als Prinzip
  if (principles.length === 0) {
    const firstSentence = reasoning.split(/[.!?]/)[0].trim();
    if (firstSentence.length > 10 && firstSentence.length < 200) {
      principles.push(firstSentence);
    }
  }
  
  return principles;
}

// 🚨 NEU: Erkenne proaktive Muster in Nachrichten (eigene Vorlieben/Interessen + Frage)
function detectProactivePattern(message) {
  if (!message || typeof message !== 'string') return null;
  
  const lower = message.toLowerCase();
  const hasQuestion = lower.includes('?');
  
  // Erkenne Muster: "Ich liebe/gehe/mache/finde X" + Frage
  const proactivePatterns = [
    /ich (liebe|gehe|mache|finde|mag|koche|spiele|lese|schaue|höre) .{5,50}\?/i,
    /ich (liebe|gehe|mache|finde|mag|koche|spiele|lese|schaue|höre) .{5,50}\. .{5,50}\?/i,
    /(meine vorliebe|mein hobby|meine erfahrung|meine gedanken|ich würde gerne) .{5,50}\?/i
  ];
  
  const hasProactivePattern = proactivePatterns.some(pattern => pattern.test(message));
  
  // Erkenne "Ich"-Formulierungen mit eigenen Erfahrungen
  const hasOwnExperience = /ich (liebe|gehe|mache|finde|mag|koche|spiele|lese|schaue|höre|würde|könnte|möchte)/i.test(message);
  
  return {
    isProactive: hasProactivePattern || (hasOwnExperience && hasQuestion),
    hasOwnExperience: hasOwnExperience,
    hasQuestion: hasQuestion,
    pattern: hasProactivePattern ? 'eigene_vorlieben_plus_frage' : (hasOwnExperience ? 'eigene_erfahrung' : null)
  };
}

// Finde bewährte Antwort-Muster für eine oder mehrere Situationen
async function findProvenPatterns(situation, customerPattern, stats) {
  if (!stats || !stats.responsePatterns) return [];
  
  // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
  let situationsArray = [];
  if (Array.isArray(situation) && situation.length > 0) {
    situationsArray = situation;
  } else if (typeof situation === 'string' && situation.trim() !== '') {
    if (situation.includes(',')) {
      situationsArray = situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else {
      situationsArray = [situation];
    }
  }
  
  // Finde Muster für ALLE Situationen (wenn mehrere vorhanden)
  const situationPatterns = situationsArray.length > 0
    ? stats.responsePatterns.filter(p => situationsArray.includes(p.situation))
    : stats.responsePatterns; // Wenn keine Situation, nimm alle
  
  // Sortiere nach Erfolgsrate und Ähnlichkeit
  const scoredPatterns = situationPatterns.map(pattern => {
    const sim = similarity(pattern.customerPattern, customerPattern);
    const successRate = pattern.successCount / 10; // Normalisiere (max 10 = 1.0)
    const recency = new Date(pattern.lastUsed).getTime() / (1000 * 60 * 60 * 24); // Tage seit letztem Gebrauch
    const recencyScore = Math.max(0, 1 - recency / 30); // Älter als 30 Tage = 0
    
    // Kombinierter Score: Ähnlichkeit (40%) + Erfolgsrate (40%) + Aktualität (20%)
    const score = (sim * 0.4) + (Math.min(successRate, 1.0) * 0.4) + (recencyScore * 0.2);
    
    return { pattern, score };
  });
  
  // Sortiere nach Score und nimm Top 20
  const topPatterns = scoredPatterns
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  
  // WICHTIG: Für Variation - wähle zufällig 5-8 aus den Top 20 aus
  // Das verhindert, dass immer die gleichen Patterns verwendet werden
  const numToSelect = Math.min(5 + Math.floor(Math.random() * 4), topPatterns.length); // 5-8 zufällig
  const selected = [];
  const usedIndices = new Set();
  
  // Zuerst immer die Top 2 nehmen (höchste Qualität)
  if (topPatterns.length > 0) {
    selected.push(topPatterns[0].pattern);
    usedIndices.add(0);
  }
  if (topPatterns.length > 1 && selected.length < numToSelect) {
    selected.push(topPatterns[1].pattern);
    usedIndices.add(1);
  }
  
  // Dann zufällig aus den restlichen Top 20 auswählen
  while (selected.length < numToSelect && usedIndices.size < topPatterns.length) {
    const randomIdx = Math.floor(Math.random() * topPatterns.length);
    if (!usedIndices.has(randomIdx)) {
      selected.push(topPatterns[randomIdx].pattern);
      usedIndices.add(randomIdx);
    }
  }
  
  return selected;
}

// Generiere Learning-Context für den Prompt
async function generateLearningContext(customerMessage, situation, stats) {
  if (!stats || Object.keys(stats).length === 0) return '';
  
  // 🚨 WICHTIG: Unterstütze mehrere Situationen (Array oder String)
  let situationsArray = [];
  if (Array.isArray(situation) && situation.length > 0) {
    situationsArray = situation;
  } else if (typeof situation === 'string' && situation.trim() !== '') {
    if (situation.includes(',')) {
      situationsArray = situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else {
      situationsArray = [situation];
    }
  }
  
  const customerPattern = extractCustomerPattern(customerMessage);
  const provenPatterns = await findProvenPatterns(situationsArray.length > 0 ? situationsArray : situation, customerPattern, stats);
  
  let context = '\n\n🧠🧠🧠🧠🧠🧠🧠🧠🧠 LEARNING-SYSTEM: BEWÄHRTE MUSTER AUS FEEDBACK (HÖCHSTE PRIORITÄT!) 🧠🧠🧠🧠🧠🧠🧠🧠🧠\n\n';
  
  // 🚨 WICHTIG: Learning-System zeigt, was FUNKTIONIERT - das ist GOLD!
  context += `🚨🚨🚨🚨🚨 KRITISCH: Das Learning-System hat aus FEEDBACK gelernt, was GUT und SCHLECHT ist! 🚨🚨🚨🚨🚨\n`;
  context += `🚨🚨🚨🚨🚨 KRITISCH: Diese Muster basieren auf ECHTEN Feedback-Daten - sie zeigen, was WIRKLICH funktioniert! 🚨🚨🚨🚨🚨\n\n`;
  context += `🚨🚨🚨 PRIORITÄTEN: 🚨🚨🚨\n`;
  context += `1. Hardcode-Regeln haben ABSOLUT HÖCHSTE PRIORITÄT (z.B. "KEINE Treffen zustimmen", "KEINE verbotenen Wörter")\n`;
  context += `2. Learning-System zeigt BEWÄHRTE Muster, die bereits erfolgreich waren (HÖCHSTE PRIORITÄT für Inhalt/Stil!)\n`;
  context += `3. Training-Daten zeigen Stil und Wortwahl (HÖCHSTE PRIORITÄT für Beispiele!)\n`;
  context += `4. Dashboard-Regeln haben hohe Priorität (situations-spezifische Antworten)\n\n`;
  context += `🚨🚨🚨🚨🚨 KRITISCH: Kombiniere Learning-System Muster + Training-Daten + Bevorzugte Wörter für BESTE Qualität! 🚨🚨🚨🚨🚨\n\n`;
  
  // 🚨🚨🚨 KRITISCH: PRIORISIERUNG - Wichtigste Muster zuerst! 🚨🚨🚨
  // Sammle alle Learning-Daten und sortiere nach Priorität
  const learningData = [];
  // 🚨 KRITISCH: primarySituation aus situationsArray ableiten (wichtig für korrekte Funktionalität!)
  const primarySituation = situationsArray.length > 0 ? situationsArray[0] : 'allgemein';
  
  // PRIORITÄT 1: Diff-Patterns (was wurde entfernt/hinzugefügt) - HÖCHSTE PRIORITÄT!
  if (stats.diffPatterns && stats.diffPatterns[primarySituation]) {
    const diffData = stats.diffPatterns[primarySituation];
    if ((diffData.removed && diffData.removed.length > 0) || (diffData.added && diffData.added.length > 0)) {
      learningData.push({
        type: 'diff_patterns',
        priority: 1, // HÖCHSTE PRIORITÄT
        data: diffData,
        situation: primarySituation
      });
    }
  }
  
  // PRIORITÄT 2: Bewährte Muster (responsePatterns)
  if (provenPatterns.length > 0) {
    learningData.push({
      type: 'proven_patterns',
      priority: 2,
      data: provenPatterns
    });
  }
  
  // PRIORITÄT 3: Negative Wörter (vermeiden!)
  const badWords = Object.entries(stats.wordFrequency?.[primarySituation] || {})
    .filter(([word, freq]) => freq.bad > freq.good && freq.bad >= 2)
    .sort((a, b) => (b[1].bad - b[1].good) - (a[1].bad - a[1].good))
    .slice(0, 10);
  if (badWords.length > 0) {
    learningData.push({
      type: 'bad_words',
      priority: 3,
      data: badWords
    });
  }
  
  // PRIORITÄT 4: Prinzipien aus Begründungen
  if (stats.reasoningPrinciples && stats.reasoningPrinciples.length > 0) {
    const relevantPrinciples = situationsArray.length > 0
      ? stats.reasoningPrinciples.filter(p => 
          p.situations && p.situations.some(sit => situationsArray.includes(sit))
        )
      : stats.reasoningPrinciples;
    if (relevantPrinciples.length > 0) {
      learningData.push({
        type: 'reasoning_principles',
        priority: 4,
        data: relevantPrinciples.slice(0, 10)
      });
    }
  }
  
  // PRIORITÄT 5: Nachrichtenstatistiken
  if (stats.messageStats?.[primarySituation]) {
    learningData.push({
      type: 'message_stats',
      priority: 5,
      data: stats.messageStats[primarySituation]
    });
  }
  
  // PRIORITÄT 6: Proaktive Muster
  if (stats.proactivePatterns && stats.proactivePatterns.length > 0) {
    const relevantProactive = situationsArray.length > 0
      ? stats.proactivePatterns.filter(p => 
          p.situation && situationsArray.includes(p.situation)
        )
      : stats.proactivePatterns;
    if (relevantProactive.length > 0) {
      learningData.push({
        type: 'proactive_patterns',
        priority: 6,
        data: relevantProactive.slice(0, 5)
      });
    }
  }
  
  // Sortiere nach Priorität (niedrigere Zahl = höhere Priorität)
  learningData.sort((a, b) => a.priority - b.priority);
  
  // 🚨🚨🚨 KRITISCH: Zeige Learning-Daten nach Priorität sortiert 🚨🚨🚨
  learningData.forEach((item, idx) => {
    if (item.type === 'diff_patterns') {
      // PRIORITÄT 1: Diff-Patterns - DIREKTE REGELN!
      context += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 HÖCHSTE PRIORITÄT: DIREKTE REGELN AUS FEEDBACK! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
      context += `🚨🚨🚨🚨🚨 KRITISCH: Diese Regeln basieren auf ECHTEN Feedback-Änderungen - befolge sie STRENG! 🚨🚨🚨🚨🚨\n\n`;
      
      if (item.data.removed && item.data.removed.length > 0) {
        context += `❌❌❌ VERBOTEN - Diese Wörter/Phrasen für "${item.situation}" NICHT verwenden (${item.data.removed.length}x in Feedback entfernt):\n\n`;
        // Sortiere nach Häufigkeit (mehr entfernt = wichtiger)
        const sortedRemoved = [...item.data.removed].sort((a, b) => b.count - a.count);
        sortedRemoved.slice(0, 15).forEach((removedItem, i) => {
          context += `   🚫 "${removedItem.text}" (${removedItem.count}x entfernt) - VERWENDE DIESES NICHT!\n`;
        });
        context += `\n🚨🚨🚨 KRITISCH: Diese Wörter wurden in Feedback als SCHLECHT markiert - VERMEIDE sie ABSOLUT! 🚨🚨🚨\n\n`;
      }
      
      if (item.data.added && item.data.added.length > 0) {
        context += `✅✅✅ EMPFOHLEN - Diese Wörter/Phrasen für "${item.situation}" VERWENDEN (${item.data.added.length}x in Feedback hinzugefügt):\n\n`;
        // Sortiere nach Häufigkeit (mehr hinzugefügt = wichtiger)
        const sortedAdded = [...item.data.added].sort((a, b) => b.count - a.count);
        sortedAdded.slice(0, 15).forEach((addedItem, i) => {
          context += `   ✅ "${addedItem.text}" (${addedItem.count}x hinzugefügt) - VERWENDE DIESES!\n`;
        });
        context += `\n🚨🚨🚨 KRITISCH: Diese Wörter wurden in Feedback als GUT markiert - VERWENDE sie! 🚨🚨🚨\n\n`;
      }
      
      if (item.data.changed && item.data.changed.length > 0) {
        context += `🔄🔄🔄 ÄNDERUNGEN - Für "${item.situation}" diese Änderungen vornehmen:\n\n`;
        const sortedChanged = [...item.data.changed].sort((a, b) => b.count - a.count);
        sortedChanged.slice(0, 10).forEach((changeItem, i) => {
          context += `   🔄 "${changeItem.from}" → "${changeItem.to}" (${changeItem.count}x geändert)\n`;
        });
        context += `\n`;
      }
    } else if (item.type === 'proven_patterns') {
      // PRIORITÄT 2: Bewährte Muster
      context += `\n✅✅✅ BEWÄHRTE MUSTER (${item.data.length} erfolgreiche Beispiele):\n\n`;
      item.data.forEach((pattern, idx) => {
      context += `✅ BEWÄHRTES MUSTER ${idx + 1} (${pattern.successCount}x erfolgreich):\n`;
      context += `Kunde: "${pattern.customerPattern.keywords || 'Ähnliche Situation'}..."\n`;
      context += `Bewährte Antwort: "${pattern.goodResponse}..."\n\n`;
    });
      context += `🚨🚨🚨 WICHTIG: Orientiere dich an diesen BEWÄHRTEN Mustern! 🚨🚨🚨\n\n`;
    } else if (item.type === 'bad_words') {
      // PRIORITÄT 3: Negative Wörter
      context += `\n❌❌❌ VERMEIDE DIESE WÖRTER für "${primarySituation}" (wurden in Feedback als schlecht markiert!):\n`;
      item.data.forEach(([word, freq]) => {
        context += `- "${word}" (${freq.bad}x schlecht, ${freq.good}x gut) - NICHT verwenden!\n`;
      });
      context += `\n🚨🚨🚨 KRITISCH: Diese Wörter wurden in Feedback als SCHLECHT markiert - verwende sie NICHT! 🚨🚨🚨\n\n`;
    } else if (item.type === 'reasoning_principles') {
      // PRIORITÄT 4: Prinzipien
      context += `\n🧠🧠🧠 PRINZIPIEN AUS BEGRÜNDUNGEN (WARUM Antworten gut sind): 🧠🧠🧠\n\n`;
      item.data.forEach((principle, idx) => {
        context += `✅ Prinzip ${idx + 1} (${principle.count}x bestätigt): ${principle.text}\n`;
        if (principle.situations && principle.situations.length > 0) {
          context += `   → Gilt für: ${principle.situations.join(', ')}\n`;
        }
      });
      context += `\n🚨🚨🚨 WICHTIG: Nutze diese Prinzipien beim Generieren deiner Antwort! 🚨🚨🚨\n\n`;
    } else if (item.type === 'message_stats') {
      // PRIORITÄT 5: Nachrichtenstatistiken (wird später hinzugefügt, siehe weiter unten)
    } else if (item.type === 'proactive_patterns') {
      // PRIORITÄT 6: Proaktive Muster (wird später hinzugefügt, siehe weiter unten)
    }
  });
  
  // 🚨 NEU: Zeige Nachrichtenstatistiken für diese Situation(en)
  // primarySituation wurde bereits oben deklariert (Zeile 281), hier nur verwenden
  const situationStats = stats.messageStats?.[primarySituation];
  
  if (situationStats && situationStats.positive && situationStats.positive.count > 0) {
    const posStats = situationStats.positive;
    const negStats = situationStats.negative || { count: 0 };
    
    context += `\n📊📊📊 NACHRICHTENSTATISTIKEN für Situation "${primarySituation}" (basierend auf ${posStats.count} positiven${negStats.count > 0 ? ` und ${negStats.count} negativen` : ''} Beispielen): 📊📊📊\n\n`;
    
    // Länge
    if (posStats.avgLength) {
      context += `📏 LÄNGE:\n`;
      context += `- Durchschnitt: ${posStats.avgLength} Zeichen\n`;
      context += `- Median: ${posStats.medianLength} Zeichen\n`;
      context += `- Bereich: ${posStats.minLength}-${posStats.maxLength} Zeichen\n`;
      if (posStats.lengthDistribution) {
        const topRange = Object.entries(posStats.lengthDistribution)
          .sort((a, b) => b[1] - a[1])[0];
        context += `- Häufigster Bereich: ${topRange[0]} (${topRange[1]}% der Nachrichten)\n`;
      }
      if (negStats.count > 0 && negStats.avgLength) {
        context += `- ⚠️ Negative Beispiele: Durchschnitt ${negStats.avgLength} Zeichen (VERMEIDE diese Länge!)\n`;
      }
      context += `\n`;
    }
    
    // Ausrufezeichen
    if (posStats.avgExclamationMarks !== undefined) {
      context += `❗ AUSRUFZEICHEN:\n`;
      context += `- Durchschnitt: ${posStats.avgExclamationMarks} pro Nachricht\n`;
      context += `- Median: ${posStats.medianExclamationMarks} pro Nachricht\n`;
      if (negStats.count > 0 && negStats.avgExclamationMarks !== undefined) {
        context += `- ⚠️ Negative Beispiele: Durchschnitt ${negStats.avgExclamationMarks} Ausrufezeichen (VERMEIDE diese Anzahl!)\n`;
      }
      context += `\n`;
    }
    
    // Fragen
    if (posStats.avgQuestions !== undefined) {
      context += `❓ FRAGEN:\n`;
      context += `- Durchschnitt: ${posStats.avgQuestions} pro Nachricht\n`;
      context += `- Median: ${posStats.medianQuestions} pro Nachricht\n`;
      if (posStats.questionDistribution) {
        const topQuestion = Object.entries(posStats.questionDistribution)
          .sort((a, b) => b[1] - a[1])[0];
        context += `- Häufigste Anzahl: ${topQuestion[0]} Frage(n) (${topQuestion[1]}% der Nachrichten)\n`;
      }
      if (negStats.count > 0 && negStats.avgQuestions !== undefined) {
        context += `- ⚠️ Negative Beispiele: Durchschnitt ${negStats.avgQuestions} Fragen (VERMEIDE diese Anzahl!)\n`;
      }
      context += `\n`;
    }
    
    context += `🚨🚨🚨 KRITISCH: Orientiere dich an diesen Statistiken für optimale Nachrichtenqualität! 🚨🚨🚨\n\n`;
  }
  
  // 🚨 NEU: Zeige häufig erfolgreiche Wörter situationsspezifisch
  const situationWordFreq = stats.wordFrequency?.[primarySituation] || {};
  const topWords = Object.entries(situationWordFreq)
    .filter(([word, freq]) => freq.good > freq.bad && freq.good >= 3)
    .sort((a, b) => (b[1].good - b[1].bad) - (a[1].good - a[1].bad))
    .slice(0, 10)
    .map(([word]) => word);
  
  if (topWords.length > 0) {
    context += `⭐ HÄUFIG ERFOLGREICHE WÖRTER für "${primarySituation}" (verwende diese öfter): ${topWords.join(', ')}\n\n`;
  }
  
  // 🚨 WICHTIG: Zeige Erfolgsrate für ALLE Situationen
  if (situationsArray.length > 0 && stats.situationSuccess) {
    situationsArray.forEach(sit => {
      if (stats.situationSuccess[sit]) {
        const success = stats.situationSuccess[sit];
        const successRate = success.total > 0 ? (success.good / success.total * 100).toFixed(0) : 0;
        context += `📊 Feedback-Qualität für "${sit}": ${successRate}% (${success.good}/${success.total} als "good" markiert, ${success.total - success.good} als "edited" bearbeitet)\n`;
      }
    });
    if (situationsArray.length > 0) context += '\n';
  } else if (typeof situation === 'string' && stats.situationSuccess && stats.situationSuccess[situation]) {
    // Fallback für String-Format
    const success = stats.situationSuccess[situation];
    const successRate = success.total > 0 ? (success.good / success.total * 100).toFixed(0) : 0;
    context += `📊 Feedback-Qualität für "${situation}": ${successRate}% (${success.good}/${success.total} als "good" markiert, ${success.total - success.good} als "edited" bearbeitet)\n\n`;
  }
  
  // 🚨🚨🚨 NEU: Zeige proaktive Muster und Nachrichtenstatistiken (wenn nicht bereits in priorisierter Liste)
  learningData.forEach((item) => {
    if (item.type === 'message_stats') {
      const posStats = item.data.positive;
      const negStats = item.data.negative || { count: 0 };
      
      context += `\n📊📊📊 NACHRICHTENSTATISTIKEN für Situation "${primarySituation}" (basierend auf ${posStats.count} positiven${negStats.count > 0 ? ` und ${negStats.count} negativen` : ''} Beispielen): 📊📊📊\n\n`;
      
      if (posStats.avgLength) {
        context += `📏 LÄNGE: Durchschnitt ${posStats.avgLength} Zeichen, Median ${posStats.medianLength} Zeichen\n`;
        if (negStats.count > 0 && negStats.avgLength) {
          context += `⚠️ Negative Beispiele: ${negStats.avgLength} Zeichen (VERMEIDE!)\n`;
        }
      }
      if (posStats.avgQuestions !== undefined) {
        context += `❓ FRAGEN: Durchschnitt ${posStats.avgQuestions} pro Nachricht\n`;
        if (negStats.count > 0 && negStats.avgQuestions !== undefined) {
          context += `⚠️ Negative Beispiele: ${negStats.avgQuestions} Fragen (VERMEIDE!)\n`;
        }
      }
      context += `\n`;
    } else if (item.type === 'proactive_patterns') {
      context += `\n🚀🚀🚀 PROAKTIVE GESPRÄCHSFÜHRUNG - EIGENE VORLIEBEN/INTERESSEN NENNEN! 🚀🚀🚀\n\n`;
      item.data.forEach((pattern, idx) => {
        context += `✅ Proaktives Muster ${idx + 1} (${pattern.count}x erfolgreich): "${pattern.example}..."\n`;
      });
      context += `\n🚨🚨🚨 WICHTIG: Nenne IMMER eigene Vorlieben/Interessen/Erfahrungen, BEVOR du fragst! 🚨🚨🚨\n\n`;
    }
  });
  
  // 🚨 NEU: Zeige gelernte Fragen situationsspezifisch
  if (stats.questionPatterns && Object.keys(stats.questionPatterns).length > 0) {
    // Sammle Fragen für alle relevanten Situationen
    const allQuestions = [];
    
    if (situationsArray.length > 0) {
      situationsArray.forEach(sit => {
        if (stats.questionPatterns[sit]) {
          Object.values(stats.questionPatterns[sit]).forEach(qData => {
            allQuestions.push({
              question: qData.question,
              count: qData.count,
              successRate: qData.successRate,
              situation: sit,
              contexts: qData.contexts || []
            });
          });
        }
      });
    } else if (primarySituation && stats.questionPatterns[primarySituation]) {
      Object.values(stats.questionPatterns[primarySituation]).forEach(qData => {
        allQuestions.push({
          question: qData.question,
          count: qData.count,
          successRate: qData.successRate,
          situation: primarySituation,
          contexts: qData.contexts || []
        });
      });
    }
    
    // Zeige auch allgemeine Fragen, wenn keine situationsspezifischen gefunden wurden
    if (allQuestions.length === 0 && stats.questionPatterns['allgemein']) {
      Object.values(stats.questionPatterns['allgemein']).forEach(qData => {
        allQuestions.push({
          question: qData.question,
          count: qData.count,
          successRate: qData.successRate,
          situation: 'allgemein',
          contexts: qData.contexts || []
        });
      });
    }
    
    if (allQuestions.length > 0) {
      // Sortiere nach Erfolgsrate und Häufigkeit
      allQuestions.sort((a, b) => {
        const scoreA = (a.successRate * 0.6) + (Math.min(a.count / 10, 1) * 0.4);
        const scoreB = (b.successRate * 0.6) + (Math.min(b.count / 10, 1) * 0.4);
        return scoreB - scoreA;
      });
      
      context += `\n❓❓❓ GELERNTE FRAGEN AUS TRAINING-DATEN UND FEEDBACK (VERWENDE DIESE!) ❓❓❓\n\n`;
      context += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Diese Fragen wurden aus Training-Daten und Feedback gelernt! 🚨🚨🚨🚨🚨\n`;
      context += `🚨🚨🚨🚨🚨 KRITISCH: Verwende NUR diese Fragen oder sehr ähnliche - KEINE eigenen Fragen erfinden! 🚨🚨🚨🚨🚨\n\n`;
      
      // Zeige Top 15 Fragen
      allQuestions.slice(0, 15).forEach((q, idx) => {
        context += `${idx + 1}. "${q.question}"\n`;
        context += `   → Situation: ${q.situation} | ${q.count}x verwendet | Erfolgsrate: ${(q.successRate * 100).toFixed(0)}%\n`;
        if (q.contexts && q.contexts.length > 0) {
          context += `   → Kontexte: ${q.contexts.slice(0, 3).join(', ')}${q.contexts.length > 3 ? '...' : ''}\n`;
        }
        context += `\n`;
      });
      
      context += `🚨🚨🚨🚨🚨 KRITISCH: Wenn du eine Frage stellen willst, WÄHLE EINE AUS DIESER LISTE! 🚨🚨🚨🚨🚨\n`;
      context += `🚨🚨🚨🚨🚨 KRITISCH: KEINE eigenen Fragen erfinden - NUR Fragen aus dieser Liste verwenden! 🚨🚨🚨🚨🚨\n\n`;
    }
  }
  
  // 🚨 NEU: Zeige gelernte Emojis situationsspezifisch
  if (stats.emojiPatterns && Object.keys(stats.emojiPatterns).length > 0) {
    const allEmojis = [];
    
    if (situationsArray.length > 0) {
      situationsArray.forEach(sit => {
        if (stats.emojiPatterns[sit]) {
          Object.entries(stats.emojiPatterns[sit]).forEach(([emoji, data]) => {
            allEmojis.push({
              emoji,
              count: data.count,
              successRate: data.successRate,
              positions: data.positions,
              situation: sit
            });
          });
        }
      });
    } else if (primarySituation && stats.emojiPatterns[primarySituation]) {
      Object.entries(stats.emojiPatterns[primarySituation]).forEach(([emoji, data]) => {
        allEmojis.push({
          emoji,
          count: data.count,
          successRate: data.successRate,
          positions: data.positions,
          situation: primarySituation
        });
      });
    }
    
    if (allEmojis.length > 0) {
      // Sortiere nach Erfolgsrate und Häufigkeit
      allEmojis.sort((a, b) => {
        const scoreA = (a.successRate * 0.6) + (Math.min(a.count / 10, 1) * 0.4);
        const scoreB = (b.successRate * 0.6) + (Math.min(b.count / 10, 1) * 0.4);
        return scoreB - scoreA;
      });
      
      context += `\n😀😀😀 GELERNTE EMOJIS AUS TRAINING-DATEN UND FEEDBACK (VERWENDE DIESE!) 😀😀😀\n\n`;
      context += `🚨🚨🚨 KRITISCH: Diese Emojis wurden aus Training-Daten und Feedback gelernt! 🚨🚨🚨\n\n`;
      
      // Zeige Top 10 Emojis
      allEmojis.slice(0, 10).forEach((e, idx) => {
        context += `${idx + 1}. ${e.emoji} - ${e.count}x verwendet | Erfolgsrate: ${(e.successRate * 100).toFixed(0)}% | Positionen: ${e.positions.join(', ')}\n`;
      });
      
      context += `\n🚨🚨🚨 KRITISCH: Verwende diese Emojis in ähnlichen Situationen! 🚨🚨🚨\n\n`;
    }
  }
  
  // 🚨 NEU: Zeige Diff-Patterns (was wurde entfernt/hinzugefügt)
  if (stats.diffPatterns && Object.keys(stats.diffPatterns).length > 0) {
    const relevantDiff = situationsArray.length > 0
      ? situationsArray.filter(sit => stats.diffPatterns[sit]).map(sit => ({ situation: sit, data: stats.diffPatterns[sit] }))
      : (primarySituation && stats.diffPatterns[primarySituation] ? [{ situation: primarySituation, data: stats.diffPatterns[primarySituation] }] : []);
    
    if (relevantDiff.length > 0) {
      context += `\n🔄🔄🔄 WAS WURDE IN FEEDBACK GEÄNDERT? (LERN AUS FEHLERN!) 🔄🔄🔄\n\n`;
      context += `🚨🚨🚨 KRITISCH: Diese Muster zeigen, was in bearbeiteten Antworten entfernt/hinzugefügt wurde! 🚨🚨🚨\n\n`;
      
      relevantDiff.forEach(({ situation, data }) => {
        if (data.removed && data.removed.length > 0) {
          context += `❌ VERMEIDE diese Wörter/Phrasen für "${situation}" (wurden in Feedback entfernt):\n`;
          data.removed.slice(0, 10).forEach((item, idx) => {
            context += `   ${idx + 1}. "${item.text}" (${item.count}x entfernt)\n`;
          });
          context += `\n`;
        }
        
        if (data.added && data.added.length > 0) {
          context += `✅ VERWENDE diese Wörter/Phrasen für "${situation}" (wurden in Feedback hinzugefügt):\n`;
          data.added.slice(0, 10).forEach((item, idx) => {
            context += `   ${idx + 1}. "${item.text}" (${item.count}x hinzugefügt)\n`;
          });
          context += `\n`;
        }
      });
      
      context += `🚨🚨🚨 KRITISCH: Lerne aus diesen Änderungen - vermeide entfernte, verwende hinzugefügte! 🚨🚨🚨\n\n`;
    }
  }
  
  // 🚨 NEU: Zeige Satzstrukturen
  if (stats.sentenceStructures && Object.keys(stats.sentenceStructures).length > 0) {
    const allStructures = [];
    
    if (situationsArray.length > 0) {
      situationsArray.forEach(sit => {
        if (stats.sentenceStructures[sit]) {
          Object.entries(stats.sentenceStructures[sit]).forEach(([structure, data]) => {
            allStructures.push({
              structure,
              count: data.count,
              successRate: data.successRate,
              examples: data.examples,
              situation: sit
            });
          });
        }
      });
    } else if (primarySituation && stats.sentenceStructures[primarySituation]) {
      Object.entries(stats.sentenceStructures[primarySituation]).forEach(([structure, data]) => {
        allStructures.push({
          structure,
          count: data.count,
          successRate: data.successRate,
          examples: data.examples,
          situation: primarySituation
        });
      });
    }
    
    if (allStructures.length > 0) {
      // Sortiere nach Erfolgsrate
      allStructures.sort((a, b) => {
        const scoreA = (a.successRate * 0.6) + (Math.min(a.count / 10, 1) * 0.4);
        const scoreB = (b.successRate * 0.6) + (Math.min(b.count / 10, 1) * 0.4);
        return scoreB - scoreA;
      });
      
      context += `\n📝📝📝 GELERNTE SATZSTRUKTUREN für "${primarySituation}" 📝📝📝\n\n`;
      context += `🚨🚨🚨 KRITISCH: Diese Satzstrukturen haben sich bewährt! 🚨🚨🚨\n\n`;
      
      // Zeige Top 5 Strukturen
      allStructures.slice(0, 5).forEach((s, idx) => {
        context += `${idx + 1}. ${s.structure} - ${s.count}x verwendet | Erfolgsrate: ${(s.successRate * 100).toFixed(0)}%\n`;
        if (s.examples && s.examples.length > 0) {
          context += `   Beispiel: "${s.examples[0]}..."\n`;
        }
        context += `\n`;
      });
      
      context += `🚨🚨🚨 KRITISCH: Verwende ähnliche Satzstrukturen! 🚨🚨🚨\n\n`;
    }
  }
  
  // 🚨 NEU: Zeige Kommunikationsstile
  if (stats.communicationStyles && Object.keys(stats.communicationStyles).length > 0) {
    const allStyles = [];
    
    if (situationsArray.length > 0) {
      situationsArray.forEach(sit => {
        if (stats.communicationStyles[sit]) {
          Object.entries(stats.communicationStyles[sit]).forEach(([style, data]) => {
            allStyles.push({
              style,
              count: data.count,
              successRate: data.successRate,
              situation: sit
            });
          });
        }
      });
    } else if (primarySituation && stats.communicationStyles[primarySituation]) {
      Object.entries(stats.communicationStyles[primarySituation]).forEach(([style, data]) => {
        allStyles.push({
          style,
          count: data.count,
          successRate: data.successRate,
          situation: primarySituation
        });
      });
    }
    
    if (allStyles.length > 0) {
      // Gruppiere nach Stil-Typ
      const styleGroups = {};
      allStyles.forEach(s => {
        if (!styleGroups[s.style]) {
          styleGroups[s.style] = [];
        }
        styleGroups[s.style].push(s);
      });
      
      context += `\n💬💬💬 GELERNTE KOMMUNIKATIONSSTILE für "${primarySituation}" 💬💬💬\n\n`;
      context += `🚨🚨🚨 KRITISCH: Diese Kommunikationsstile haben sich bewährt! 🚨🚨🚨\n\n`;
      
      Object.entries(styleGroups).forEach(([style, items]) => {
        const totalCount = items.reduce((sum, item) => sum + item.count, 0);
        const avgSuccessRate = items.reduce((sum, item) => sum + item.successRate, 0) / items.length;
        
        if (totalCount >= 3 && avgSuccessRate > 0.5) {
          context += `✅ ${style.toUpperCase()}: ${totalCount}x verwendet | Erfolgsrate: ${(avgSuccessRate * 100).toFixed(0)}%\n`;
        }
      });
      
      context += `\n🚨🚨🚨 KRITISCH: Verwende diese Kommunikationsstile in ähnlichen Situationen! 🚨🚨🚨\n\n`;
    }
  }
  
  context += `🧠🧠🧠 Das System lernt kontinuierlich aus Feedback - diese Muster basieren auf ${(stats.responsePatterns || []).length} bewährten Beispielen und ${(stats.reasoningPrinciples || []).length} Prinzipien aus Begründungen! 🧠🧠🧠\n\n`;
  
  return context;
}

// Helper: Lade Training-Daten (kopiert aus dashboard.js, da nicht exportiert)
async function getTrainingDataForLearning() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/training-data.json',
        'src/config/training-data.json',
        'config/training-data.json',
        'server/config/training-data.json'
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
            return JSON.parse(content);
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('Fehler beim Laden der Training Data von GitHub:', err.message);
      }
    }
  }
  
  // Fallback: Lade von lokaler Datei
  const trainingPath = path.join(__dirname, '../../config/training-data.json');
  try {
    if (fs.existsSync(trainingPath)) {
      const data = fs.readFileSync(trainingPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Training Data:', err);
  }
  return { conversations: [], asaExamples: [] };
}

// Helper: Lade Feedback-Daten (kopiert aus dashboard.js, da nicht exportiert)
async function getFeedbackDataForLearning() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/feedback.json',
        'src/config/feedback.json',
        'config/feedback.json',
        'server/config/feedback.json'
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
            return JSON.parse(content);
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('Fehler beim Laden der Feedback-Daten von GitHub:', err.message);
      }
    }
  }
  
  // Fallback: Lade von lokaler Datei
  const feedbackPath = path.join(__dirname, '../../config/feedback.json');
  try {
    if (fs.existsSync(feedbackPath)) {
      const data = fs.readFileSync(feedbackPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Feedback-Daten:', err);
  }
  return { feedbacks: [] };
}

// Initialisiere Learning-System: Analysiere ALLE bestehenden Training-Daten und Feedbacks
// WICHTIG: Läuft nur einmal! Wenn bereits initialisiert, wird übersprungen.
async function initializeLearningSystem() {
  console.log('🧠 Prüfe Learning-System Initialisierung...');
  
  try {
    const stats = await getLearningStats();
    
    // Prüfe, ob bereits initialisiert wurde
    if (stats.initialized === true) {
      console.log('✅ Learning-System wurde bereits initialisiert - überspringe erneute Initialisierung');
      return stats;
    }
    
    console.log('🧠 Initialisiere Learning-System: Analysiere bestehende Daten...');
    let updated = false;
    
    // 1. Analysiere bestehende Training-Daten
    try {
      const trainingData = await getTrainingDataForLearning();
      
      if (trainingData && trainingData.conversations && trainingData.conversations.length > 0) {
        console.log(`📚 Analysiere ${trainingData.conversations.length} bestehende Training-Daten-Gespräche...`);
        
        for (const conv of trainingData.conversations) {
          // 🚨 FIX: Unterstütze beide Formate (customer/assistant und customerMessage/moderatorResponse)
          const customerMsg = conv.customerMessage || conv.customer;
          const assistantMsg = conv.moderatorResponse || conv.assistant;
          
          if (customerMsg && assistantMsg && conv.situation) {
            const situation = conv.situation || 'allgemein';
            const isNegative = conv.isNegativeExample === true;
            
            // 🚨 NEU: Analysiere Nachrichtenstatistiken für Training-Daten
            if (isNegative) {
              // Negative Beispiele analysieren
              analyzeMessageStats(assistantMsg, situation, stats, false);
            } else {
              // Positive Beispiele analysieren
              analyzeMessageStats(assistantMsg, situation, stats, true);
            }
            
            // Jedes Training-Daten-Gespräch ist ein "gutes" Beispiel (außer negative)
            if (!isNegative) {
              await analyzeFeedback({
                customerMessage: customerMsg,
                aiResponse: assistantMsg,
                editedResponse: null,
                status: 'good', // Training-Daten sind immer "gut"
                situation: situation
              }, false); // Kein Push während Initialisierung
            }
            updated = true;
          }
        }
        
        console.log(`✅ ${trainingData.conversations.length} Training-Daten-Gespräche analysiert`);
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Analysieren der Training-Daten:', err.message);
    }
    
    // 2. Analysiere bestehende Feedbacks
    try {
      const feedbackData = await getFeedbackDataForLearning();
      
      if (feedbackData && feedbackData.feedbacks && feedbackData.feedbacks.length > 0) {
        console.log(`📝 Analysiere ${feedbackData.feedbacks.length} bestehende Feedbacks...`);
        
        let analyzedCount = 0;
        for (const feedback of feedbackData.feedbacks) {
          if (feedback.status === 'good' || feedback.status === 'edited') {
            // 🚨 WICHTIG: Verwende Situation aus Feedback, falls vorhanden (sonst Fallback auf Erkennung)
            let situation = 'allgemein';
            if (feedback.situation) {
              // Situation aus Feedback verwenden (kann String oder Array sein)
              if (Array.isArray(feedback.situation) && feedback.situation.length > 0) {
                situation = feedback.situation[0]; // Primäre Situation
              } else if (typeof feedback.situation === 'string' && feedback.situation.trim() !== '') {
                situation = feedback.situation.trim();
              }
            } else {
              // Fallback: Erkenne Situation aus Kunden-Nachricht
              situation = detectSituationFromMessage(feedback.customerMessage);
            }
            
            // 🚨 NEU: Analysiere Nachrichtenstatistiken für Feedback
            if (feedback.status === 'edited' && feedback.editedResponse) {
              // Positive: editedResponse, Negative: aiResponse
              analyzeMessageStats(feedback.editedResponse, situation, stats, true);
              analyzeMessageStats(feedback.aiResponse, situation, stats, false);
            } else if (feedback.status === 'good') {
              // Positive: aiResponse
              analyzeMessageStats(feedback.aiResponse, situation, stats, true);
            }
            
            await analyzeFeedback({
              customerMessage: feedback.customerMessage,
              aiResponse: feedback.aiResponse,
              editedResponse: feedback.editedResponse || null,
              status: feedback.status,
              situation: situation, // 🚨 NEU: Verwende Situation aus Feedback!
              reasoning: feedback.reasoning || null // 🚨 NEU: Begründung mit übergeben
            }, false); // Kein Push während Initialisierung
            analyzedCount++;
            updated = true;
          }
        }
        
        console.log(`✅ ${analyzedCount} Feedbacks analysiert`);
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Analysieren der Feedbacks:', err.message);
    }
    
    if (updated) {
      const finalStats = await getLearningStats();
      // Markiere als initialisiert
      finalStats.initialized = true;
      console.log(`🎉 Learning-System initialisiert: ${(finalStats.responsePatterns || []).length} bewährte Muster, ${Object.keys(finalStats.wordFrequency || {}).length} analysierte Wörter`);
      
      // JETZT erst einmal auf GitHub pushen (nur einmal am Ende)
      try {
        await saveLearningStats(finalStats, true);
        console.log(`✅ Learning-Statistiken auf GitHub gespeichert (Initialisierung abgeschlossen)`);
      } catch (err) {
        console.warn('⚠️ Konnte Learning-Statistiken nicht auf GitHub pushen (nicht kritisch):', err.message);
      }
    } else {
      // Auch wenn keine neuen Daten, markiere als initialisiert
      stats.initialized = true;
      await saveLearningStats(stats, true);
      console.log('ℹ️ Keine neuen Daten zum Analysieren gefunden - Initialisierung abgeschlossen');
    }
    
    return stats;
  } catch (err) {
    console.error('❌ Fehler beim Initialisieren des Learning-Systems:', err);
    return await getLearningStats();
  }
}

// Hilfsfunktion: Erkenne Situation aus Kunden-Nachricht (vereinfacht, ähnlich wie in dashboard.js)
function detectSituationFromMessage(message) {
  if (!message || typeof message !== 'string') return 'allgemein';
  
  const lower = message.toLowerCase();
  
  // Vereinfachte Erkennung (ähnlich wie in dashboard.js)
  if (lower.includes('treffen') || lower.includes('sehen') || lower.includes('kennenlernen') || lower.includes('date')) {
    return 'Treffen/Termine';
  }
  if (lower.includes('geld') || lower.includes('coin') || lower.includes('credit') || lower.includes('zahlung')) {
    return 'Geld/Coins';
  }
  if (lower.includes('sex') || lower.includes('ficken') || lower.includes('geil') || lower.includes('horny')) {
    return 'Sexuelle Themen';
  }
  if (lower.includes('wo') && (lower.includes('wohnst') || lower.includes('herkommst') || lower.includes('stadt'))) {
    return 'Standort';
  }
  
  return 'allgemein';
}

// 🚨 NEU: Kompakte Version von generateLearningContext - nur Top-Regeln (~100 Tokens)
async function generateCompactLearningContext(customerMessage, situation, stats) {
  if (!stats || Object.keys(stats).length === 0) return '';
  
  // Bestimme primarySituation
  let primarySituation = 'allgemein';
  if (typeof situation === 'string' && situation.trim() !== '') {
    primarySituation = situation;
  } else if (Array.isArray(situation) && situation.length > 0) {
    primarySituation = situation[0];
  }
  
  let context = '\n\n🧠 GELERNT AUS FEEDBACK:\n';
  
  // PRIORITÄT 1: Diff-Patterns (nur Top 5)
  if (stats.diffPatterns && stats.diffPatterns[primarySituation]) {
    const diffData = stats.diffPatterns[primarySituation];
    
    if (diffData.removed && diffData.removed.length > 0) {
      const topRemoved = [...diffData.removed].sort((a, b) => b.count - a.count).slice(0, 5);
      if (topRemoved.length > 0) {
        context += `\n❌ VERMEIDE (${primarySituation}): ${topRemoved.map(r => `"${r.text}"`).join(', ')}\n`;
      }
    }
    
    if (diffData.added && diffData.added.length > 0) {
      const topAdded = [...diffData.added].sort((a, b) => b.count - a.count).slice(0, 5);
      if (topAdded.length > 0) {
        context += `✅ VERWENDE (${primarySituation}): ${topAdded.map(a => `"${a.text}"`).join(', ')}\n`;
      }
    }
  }
  
  // PRIORITÄT 2: Negative Wörter (nur Top 5)
  const badWords = Object.entries(stats.wordFrequency?.[primarySituation] || {})
    .filter(([word, freq]) => freq.bad > freq.good && freq.bad >= 2)
    .sort((a, b) => (b[1].bad - b[1].good) - (a[1].bad - a[1].good))
    .slice(0, 5);
  if (badWords.length > 0) {
    context += `\n❌ SCHLECHTE WÖRTER: ${badWords.map(([word]) => word).join(', ')}\n`;
  }
  
  // PRIORITÄT 3: Positive Wörter (nur Top 5)
  const goodWords = Object.entries(stats.wordFrequency?.[primarySituation] || {})
    .filter(([word, freq]) => freq.good > freq.bad && freq.good >= 3)
    .sort((a, b) => (b[1].good - b[1].bad) - (a[1].good - a[1].bad))
    .slice(0, 5);
  if (goodWords.length > 0) {
    context += `✅ GUTE WÖRTER: ${goodWords.map(([word]) => word).join(', ')}\n`;
  }
  
  // PRIORITÄT 4: Nachrichtenstatistiken (kompakt)
  if (stats.messageStats?.[primarySituation]?.positive) {
    const posStats = stats.messageStats[primarySituation].positive;
    if (posStats.avgLength) {
      context += `\n📏 STIL: ~${posStats.avgLength} Zeichen, ${posStats.avgQuestions || 0} Fragen\n`;
    }
  }
  
  context += '\n';
  
  return context;
}

/**
 * 🧠 DEEP LEARNING: Extrahiert tiefgreifende Muster aus Training-Daten und Feedbacks
 * Lerne kausale Zusammenhänge, emotionale Wirkung, temporale Muster, Kunden-Typen, Sequenzen
 */
async function extractDeepPatterns(trainingData, feedbackData, learningStats) {
  const client = require('../openaiClient').getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Deep Pattern Extraction übersprungen');
    return null;
  }

  try {
    console.log('🧠🧠🧠 Deep Pattern Extraction gestartet...');
    
    // Sammle alle Konversationen aus Training-Daten und Feedbacks
    const allConversations = [];
    
    // 1. Training-Daten hinzufügen
    if (trainingData && trainingData.conversations) {
      for (const conv of trainingData.conversations) {
        if (conv.customerMessage && conv.moderatorResponse && !conv.isNegativeExample) {
          allConversations.push({
            customerMessage: conv.customerMessage,
            moderatorResponse: conv.moderatorResponse,
            situation: conv.situation || 'allgemein',
            source: 'training'
          });
        }
      }
    }
    
    // 2. Feedbacks hinzufügen (nur gute Antworten)
    if (feedbackData && feedbackData.feedbacks) {
      for (const feedback of feedbackData.feedbacks) {
        if (feedback.status === 'good' && feedback.aiResponse) {
          allConversations.push({
            customerMessage: feedback.customerMessage,
            moderatorResponse: feedback.aiResponse,
            situation: feedback.situation || 'allgemein',
            source: 'feedback-good'
          });
        } else if (feedback.status === 'edited' && feedback.editedResponse) {
          allConversations.push({
            customerMessage: feedback.customerMessage,
            moderatorResponse: feedback.editedResponse,
            situation: feedback.situation || 'allgemein',
            source: 'feedback-edited'
          });
        }
      }
    }
    
    if (allConversations.length === 0) {
      console.warn('⚠️ Keine Konversationen für Deep Pattern Extraction gefunden');
      return null;
    }
    
    console.log(`📊 Analysiere ${allConversations.length} Konversationen für Deep Patterns...`);
    
    // Gruppiere nach Situationen für fokussierte Analyse
    const conversationsBySituation = {};
    for (const conv of allConversations) {
      const sit = conv.situation || 'allgemein';
      if (!conversationsBySituation[sit]) {
        conversationsBySituation[sit] = [];
      }
      conversationsBySituation[sit].push(conv);
    }
    
    const deepPatterns = {
      causalRelationships: {}, // { "situation": [{ cause: "...", effect: "...", examples: [] }] }
      emotionalImpact: {}, // { "situation": [{ response: "...", leadsTo: "...", examples: [] }] }
      temporalPatterns: {}, // { "situation": [{ phase: "...", patterns: [] }] }
      customerTypes: [], // [{ type: "...", characteristics: [], responses: [] }]
      successfulSequences: {}, // { "situation": [{ sequence: [...], outcome: "..." }] }
      metaPrinciples: [] // [{ principle: "...", appliesTo: [...], examples: [] }]
    };
    
    // Analysiere die häufigsten Situationen (Top 5)
    const topSituations = Object.entries(conversationsBySituation)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5);
    
    for (const [situation, conversations] of topSituations) {
      if (conversations.length < 10) continue; // Mindestens 10 Beispiele pro Situation
      
      console.log(`🔍 Analysiere Situation "${situation}" (${conversations.length} Beispiele)...`);
      
      // Wähle repräsentative Beispiele (divers, nicht alle gleich)
      const sampleSize = Math.min(30, conversations.length);
      const samples = conversations.slice(0, sampleSize);
      
      const examplesText = samples.map((conv, idx) => 
        `${idx + 1}. Kunde: "${conv.customerMessage.substring(0, 150)}${conv.customerMessage.length > 150 ? '...' : ''}"\n   Antwort: "${conv.moderatorResponse.substring(0, 200)}${conv.moderatorResponse.length > 200 ? '...' : ''}"`
      ).join('\n\n');
      
      const deepAnalysisPrompt = `Analysiere diese Chat-Beispiele tiefgreifend und extrahiere Muster für intelligentes Lernen.

Situation: "${situation}"
Beispiele (${samples.length}):
${examplesText}

Extrahiere:

1. **KAUSALE ZUSAMMENHÄNGE (Ursache → Wirkung):**
   - Welche Antwort-Strukturen führen zu welchen Ergebnissen?
   - Beispiel: "Ablehnung + Alternative anbieten" → führt zu längeren Gesprächen?
   - Beispiel: "Nach Vorlieben fragen + Eigeninitiative zeigen" → führt zu mehr Engagement?
   - 🚨 WICHTIG: Unterscheide zwischen direkten Treffen-Anfragen ("was machst du morgen?") und allgemeiner Diskussion ("wann klappt es bei dir?")
   - Direkte Anfragen: Ablehnend aber höflich → führt zu was?
   - Allgemeine Diskussion: Positiv aber vague → führt zu was?

2. **EMOTIONALE WIRKUNG:**
   - Welche Antworten lösen welche Reaktionen aus?
   - Welche Antworten führen zu längeren Kunden-Antworten?
   - Welche Formulierungen wirken empathisch/verständnisvoll?

3. **TEMPORALE MUSTER:**
   - In welcher Gesprächs-Phase werden welche Fragen gestellt?
   - Wie entwickelt sich das Gespräch typischerweise?
   - Wann ist es Zeit für ein Thema? (z.B. erst Name, dann Vorlieben)

4. **KUNDEN-TYPEN:**
   - Welche verschiedene Kunden-Typen erkennst du? (direkt, schüchtern, humorvoll, etc.)
   - Wie reagiert man auf unterschiedliche Persönlichkeitstypen?

5. **ERFOLGSPFADE (Sequenzen):**
   - Welche Antwort-Sequenzen führen zu positiven Ergebnissen?
   - Beispiel: "Antwort A → Antwort B → Antwort C" = erfolgreich

6. **META-PRINZIPIEN:**
   - Welche Prinzipien sind allgemeingültig?
   - Welche Prinzipien sind situationsspezifisch?
   - Wie kombiniert man mehrere Prinzipien?
   - 🚨 WICHTIG: Lerne NUANCEN - nicht alle Situationen sind gleich!
   - Beispiel: Bei Treffen-Anfragen gibt es Unterschiede zwischen direkten Anfragen und allgemeiner Diskussion
   - Beispiel: Direkte Anfragen erfordern andere Antworten als allgemeine Diskussion

Antworte NUR als JSON:
{
  "causalRelationships": [
    {
      "cause": "Ursache (z.B. 'Ablehnung + Alternative anbieten')",
      "effect": "Wirkung (z.B. 'führt zu längeren Gesprächen')",
      "confidence": 0.8,
      "examples": ["Beispiel 1", "Beispiel 2"]
    }
  ],
  "emotionalImpact": [
    {
      "response": "Antwort-Pattern (z.B. 'Empathie zeigen + Verständnis')",
      "leadsTo": "Was führt dazu? (z.B. 'längere Kunden-Antworten')",
      "confidence": 0.8,
      "examples": ["Beispiel 1"]
    }
  ],
  "temporalPatterns": [
    {
      "phase": "Gesprächs-Phase (z.B. 'Anfang', 'Mitte', 'nach 5 Nachrichten')",
      "pattern": "Was passiert in dieser Phase?",
      "confidence": 0.7
    }
  ],
  "customerTypes": [
    {
      "type": "Typ-Name (z.B. 'direkter Kunde')",
      "characteristics": ["Charakteristik 1", "Charakteristik 2"],
      "responseStyle": "Wie reagiert man darauf?"
    }
  ],
  "successfulSequences": [
    {
      "sequence": ["Antwort-Muster 1", "Antwort-Muster 2"],
      "outcome": "Was führt das zu?",
      "examples": ["Beispiel"]
    }
  ],
  "metaPrinciples": [
    {
      "principle": "Prinzip (z.B. 'Bei Ablehnung immer Alternative anbieten')",
      "appliesTo": ["Situation 1", "Situation 2"],
      "general": true
    }
  ]
}

WICHTIG:
- Sei spezifisch und konkret
- Extrahiere echte Muster, nicht nur oberflächliche Beobachtungen
- Fokussiere auf WARUM Antworten funktionieren, nicht nur WAS sie enthalten`;

      try {
        const analysis = await Promise.race([
          client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Du analysierst Chat-Konversationen tiefgreifend und extrahierst intelligente Muster für kausale Zusammenhänge, emotionale Wirkung und Meta-Prinzipien. Antworte IMMER nur als JSON.' },
              { role: 'user', content: deepAnalysisPrompt }
            ],
            temperature: 0.3,
            max_tokens: 2000
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
        ]);
        
        const result = analysis.choices?.[0]?.message?.content?.trim();
        if (result) {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            
            if (parsed.causalRelationships && parsed.causalRelationships.length > 0) {
              deepPatterns.causalRelationships[situation] = parsed.causalRelationships;
            }
            if (parsed.emotionalImpact && parsed.emotionalImpact.length > 0) {
              deepPatterns.emotionalImpact[situation] = parsed.emotionalImpact;
            }
            if (parsed.temporalPatterns && parsed.temporalPatterns.length > 0) {
              deepPatterns.temporalPatterns[situation] = parsed.temporalPatterns;
            }
            if (parsed.customerTypes && parsed.customerTypes.length > 0) {
              deepPatterns.customerTypes.push(...parsed.customerTypes);
            }
            if (parsed.successfulSequences && parsed.successfulSequences.length > 0) {
              deepPatterns.successfulSequences[situation] = parsed.successfulSequences;
            }
            if (parsed.metaPrinciples && parsed.metaPrinciples.length > 0) {
              deepPatterns.metaPrinciples.push(...parsed.metaPrinciples);
            }
            
            console.log(`✅ Deep Patterns für "${situation}" extrahiert`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ Deep Pattern Extraction für "${situation}" fehlgeschlagen:`, err.message);
      }
    }
    
    // Speichere Deep Patterns in Learning Stats
    if (learningStats) {
      if (!learningStats.deepPatterns) {
        learningStats.deepPatterns = {};
      }
      learningStats.deepPatterns = {
        ...learningStats.deepPatterns,
        ...deepPatterns,
        lastUpdated: new Date().toISOString()
      };
      
      await saveLearningStats(learningStats, false); // Kein Push während Extraktion
    }
    
    console.log('✅ Deep Pattern Extraction abgeschlossen');
    return deepPatterns;
    
  } catch (err) {
    console.warn('⚠️ Deep Pattern Extraction fehlgeschlagen:', err.message);
    return null;
  }
}

/**
 * Generiere Deep Learning Context für Prompt basierend auf extrahierten Deep Patterns
 */
function generateDeepLearningContext(situations, deepPatterns, customerMessage = '') {
  if (!deepPatterns || !situations || situations.length === 0) {
    return '';
  }
  
  const primarySituation = situations[0] || 'allgemein';
  let context = '\n\n🧠🧠🧠🧠🧠 DEEP LEARNING: INTELLIGENTE MUSTER & PRINZIPIEN 🧠🧠🧠🧠🧠\n\n';
  
  // 1. Meta-Prinzipien (allgemeingültig)
  if (deepPatterns.metaPrinciples && deepPatterns.metaPrinciples.length > 0) {
    context += '🚀 META-PRINZIPIEN (allgemeingültig):\n';
    deepPatterns.metaPrinciples.slice(0, 5).forEach((principle, idx) => {
      context += `${idx + 1}. ${principle.principle}\n`;
      if (principle.appliesTo && principle.appliesTo.length > 0) {
        context += `   Gilt für: ${principle.appliesTo.join(', ')}\n`;
      }
    });
    context += '\n';
  }
  
  // 2. Kausale Zusammenhänge für aktuelle Situation
  if (deepPatterns.causalRelationships && deepPatterns.causalRelationships[primarySituation]) {
    const causal = deepPatterns.causalRelationships[primarySituation].slice(0, 3);
    if (causal.length > 0) {
      context += `🔗 KAUSALE ZUSAMMENHÄNGE (${primarySituation}):\n`;
      causal.forEach((rel, idx) => {
        context += `${idx + 1}. ${rel.cause} → ${rel.effect}\n`;
      });
      context += '\n';
    }
  }
  
  // 3. Emotionale Wirkung
  if (deepPatterns.emotionalImpact && deepPatterns.emotionalImpact[primarySituation]) {
    const impact = deepPatterns.emotionalImpact[primarySituation].slice(0, 3);
    if (impact.length > 0) {
      context += `💭 EMOTIONALE WIRKUNG (${primarySituation}):\n`;
      impact.forEach((imp, idx) => {
        context += `${idx + 1}. ${imp.response} → ${imp.leadsTo}\n`;
      });
      context += '\n';
    }
  }
  
  // 4. Temporale Muster
  if (deepPatterns.temporalPatterns && deepPatterns.temporalPatterns[primarySituation]) {
    const temporal = deepPatterns.temporalPatterns[primarySituation].slice(0, 2);
    if (temporal.length > 0) {
      context += `⏰ TEMPORALE MUSTER (${primarySituation}):\n`;
      temporal.forEach((temp, idx) => {
        context += `${idx + 1}. ${temp.phase}: ${temp.pattern}\n`;
      });
      context += '\n';
    }
  }
  
  // 5. Kunden-Typ-Erkennung (basierend auf aktueller Nachricht)
  if (deepPatterns.customerTypes && deepPatterns.customerTypes.length > 0 && customerMessage) {
    // Versuche Kunden-Typ zu erkennen
    const customerLower = customerMessage.toLowerCase();
    const matchedTypes = deepPatterns.customerTypes.filter(ct => 
      ct.characteristics && ct.characteristics.some(char => 
        customerLower.includes(char.toLowerCase())
      )
    ).slice(0, 2);
    
    if (matchedTypes.length > 0) {
      context += '👤 ERKANNTE KUNDEN-TYPEN:\n';
      matchedTypes.forEach((type, idx) => {
        context += `${idx + 1}. ${type.type}: ${type.responseStyle}\n`;
      });
      context += '\n';
    }
  }
  
  // 6. Erfolgs-Pfade
  if (deepPatterns.successfulSequences && deepPatterns.successfulSequences[primarySituation]) {
    const sequences = deepPatterns.successfulSequences[primarySituation].slice(0, 2);
    if (sequences.length > 0) {
      context += `🎯 ERFOLGS-PFADE (${primarySituation}):\n`;
      sequences.forEach((seq, idx) => {
        context += `${idx + 1}. ${seq.sequence.join(' → ')} → ${seq.outcome}\n`;
      });
      context += '\n';
    }
  }
  
  context += '🚨🚨🚨 WICHTIG: Diese Prinzipien und Muster basieren auf erfolgreichen Gesprächen - nutze sie intelligent! 🚨🚨🚨\n\n';
  
  return context;
}

module.exports = {
  getLearningStats,
  saveLearningStats,
  analyzeFeedback,
  generateLearningContext,
  generateCompactLearningContext, // 🚨 NEU: Kompakte Version für Prompt
  extractDeepPatterns, // 🧠 NEU: Deep Pattern Extraction
  generateDeepLearningContext, // 🧠 NEU: Deep Learning Context für Prompt
  findProvenPatterns,
  initializeLearningSystem,
  detectProactivePattern, // 🚨 NEU: Export für Post-Processing
  selectRelevantLearningForPrompt, // 🚨🚨🚨 NEU: Selektive Learning-Daten für Prompt (Top 3-5)
  selectRelevantLearningForScoring, // 🚨🚨🚨 NEU: Alle relevanten Learning-Daten für Scoring
  scoreMessageByLearning, // 🚨🚨🚨 NEU: Scoring-Funktion für Multi-Generator
  getFeedbackDataForLearning // 🚨 FIX: Export für Deep Learning Agent
};

/**
 * 🚨🚨🚨 NEU: Selektive Learning-Daten für Prompt (nur Top 3-5 relevante)
 * Gibt nur die wichtigsten Learning-Daten zurück, um den Prompt kompakt zu halten
 */
function selectRelevantLearningForPrompt(customerMessage, situation, stats) {
  if (!stats || Object.keys(stats).length === 0) return null;
  
  let situationsArray = [];
  if (Array.isArray(situation) && situation.length > 0) {
    situationsArray = situation;
  } else if (typeof situation === 'string' && situation.trim() !== '') {
    if (situation.includes(',')) {
      situationsArray = situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else {
      situationsArray = [situation];
    }
  }
  
  const primarySituation = situationsArray.length > 0 ? situationsArray[0] : 'allgemein';
  
  // Top 3-5 Wörter die verwendet werden sollten
  const topWords = Object.entries(stats.wordFrequency?.[primarySituation] || {})
    .filter(([word, freq]) => freq.good > freq.bad && freq.good >= 2)
    .sort((a, b) => (b[1].good - b[1].bad) - (a[1].good - a[1].bad))
    .slice(0, 5)
    .map(([word]) => word);
  
  // Top 3 Muster die verwendet werden sollten
  const topPatterns = Object.entries(stats.patterns?.[primarySituation] || {})
    .filter(([pattern, data]) => data.count >= 2 && data.successRate > 0.5)
    .sort((a, b) => (b[1].successRate * b[1].count) - (a[1].successRate * a[1].count))
    .slice(0, 3)
    .map(([pattern]) => pattern);
  
  // Top 3 negative Wörter die vermieden werden sollten
  const badWords = Object.entries(stats.wordFrequency?.[primarySituation] || {})
    .filter(([word, freq]) => freq.bad > freq.good && freq.bad >= 2)
    .sort((a, b) => (b[1].bad - b[1].good) - (a[1].bad - a[1].good))
    .slice(0, 3)
    .map(([word]) => word);
  
  return {
    topWords,
    topPatterns,
    badWords,
    situation: primarySituation
  };
}

/**
 * 🚨🚨🚨 NEU: Alle relevanten Learning-Daten für Scoring (nicht nur Prompt)
 * Gibt ALLE relevanten Learning-Daten zurück für technisches Scoring
 */
function selectRelevantLearningForScoring(customerMessage, situation, stats) {
  if (!stats || Object.keys(stats).length === 0) return null;
  
  let situationsArray = [];
  if (Array.isArray(situation) && situation.length > 0) {
    situationsArray = situation;
  } else if (typeof situation === 'string' && situation.trim() !== '') {
    if (situation.includes(',')) {
      situationsArray = situation.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else {
      situationsArray = [situation];
    }
  }
  
  const primarySituation = situationsArray.length > 0 ? situationsArray[0] : 'allgemein';
  
  // Alle guten Wörter
  const goodWords = Object.entries(stats.wordFrequency?.[primarySituation] || {})
    .filter(([word, freq]) => freq.good > freq.bad && freq.good >= 2)
    .map(([word, freq]) => ({
      word,
      score: (freq.good - freq.bad) / (freq.good + freq.bad),
      count: freq.good
    }))
    .sort((a, b) => b.score - a.score);
  
  // Alle schlechten Wörter
  const badWords = Object.entries(stats.wordFrequency?.[primarySituation] || {})
    .filter(([word, freq]) => freq.bad > freq.good && freq.bad >= 2)
    .map(([word, freq]) => ({
      word,
      penalty: (freq.bad - freq.good) / (freq.bad + freq.good),
      count: freq.bad
    }))
    .sort((a, b) => b.penalty - a.penalty);
  
  // Alle guten Muster
  const goodPatterns = Object.entries(stats.patterns?.[primarySituation] || {})
    .filter(([pattern, data]) => data.count >= 2 && data.successRate > 0.5)
    .map(([pattern, data]) => ({
      pattern,
      successRate: data.successRate,
      count: data.count
    }))
    .sort((a, b) => (b.successRate * b.count) - (a.successRate * a.count));
  
  // Diff-Patterns (was wurde entfernt/hinzugefügt)
  const diffPatterns = stats.diffPatterns?.[primarySituation] || {};
  
  // Gute Fragen
  const goodQuestions = [];
  if (stats.questionPatterns?.[primarySituation]) {
    Object.values(stats.questionPatterns[primarySituation]).forEach(qData => {
      if (qData.count >= 2 && qData.successRate > 0.5) {
        goodQuestions.push({
          question: qData.question,
          successRate: qData.successRate,
          count: qData.count
        });
      }
    });
    goodQuestions.sort((a, b) => (b.successRate * b.count) - (a.successRate * a.count));
  }
  
  return {
    goodWords,
    badWords,
    goodPatterns,
    diffPatterns,
    goodQuestions,
    situation: primarySituation
  };
}

/**
 * 🚨🚨🚨 NEU: Score eine Nachricht basierend auf Learning-Daten
 * Nutzt ALLE Learning-Daten für technisches Scoring (nicht nur Prompt)
 */
async function scoreMessageByLearning(message, learningData, trainingData = null) {
  if (!message || !learningData) return 0;
  
  let score = 0;
  const messageLower = message.toLowerCase();
  
  // 1. Gelernte Wörter verwendet? (+20 Punkte pro Wort, gewichtet nach Score)
  if (learningData.goodWords && learningData.goodWords.length > 0) {
    learningData.goodWords.forEach(({ word, score: wordScore, count }) => {
      if (messageLower.includes(word.toLowerCase())) {
        const weight = Math.min(count / 5, 2); // Max 2x Gewichtung
        score += 20 * wordScore * weight;
      }
    });
  }
  
  // 2. Gelernte Muster erkannt? (+30 Punkte pro Muster, gewichtet nach SuccessRate)
  if (learningData.goodPatterns && learningData.goodPatterns.length > 0) {
    learningData.goodPatterns.forEach(({ pattern, successRate, count }) => {
      if (messageLower.includes(pattern.toLowerCase())) {
        const weight = Math.min(count / 5, 2);
        score += 30 * successRate * weight;
      }
    });
  }
  
  // 3. Gelernte Fragen verwendet? (+40 Punkte pro Frage, gewichtet nach SuccessRate)
  if (learningData.goodQuestions && learningData.goodQuestions.length > 0) {
    learningData.goodQuestions.forEach(({ question, successRate, count }) => {
      const questionClean = question.toLowerCase().trim();
      const messageQuestions = message.match(/[^.!?]*\?/g) || [];
      messageQuestions.forEach(msgQuestion => {
        if (msgQuestion.toLowerCase().trim().includes(questionClean.substring(0, 20))) {
          const weight = Math.min(count / 5, 2);
          score += 40 * successRate * weight;
        }
      });
    });
  }
  
  // 4. Negative Wörter vermieden? (+10 Punkte pro vermiedenes Wort)
  if (learningData.badWords && learningData.badWords.length > 0) {
    let avoidedCount = 0;
    learningData.badWords.forEach(({ word }) => {
      if (!messageLower.includes(word.toLowerCase())) {
        avoidedCount++;
      }
    });
    score += 10 * avoidedCount;
  } else {
    // Bonus wenn keine schlechten Wörter bekannt sind
    score += 10;
  }
  
  // 5. Diff-Patterns: Hinzugefügte Phrasen verwendet? (+25 Punkte)
  if (learningData.diffPatterns && learningData.diffPatterns.added && learningData.diffPatterns.added.length > 0) {
    learningData.diffPatterns.added.forEach(({ text, count }) => {
      if (messageLower.includes(text.toLowerCase())) {
        const weight = Math.min(count / 3, 2);
        score += 25 * weight;
      }
    });
  }
  
  // 6. Diff-Patterns: Entfernte Phrasen vermieden? (+15 Punkte)
  if (learningData.diffPatterns && learningData.diffPatterns.removed && learningData.diffPatterns.removed.length > 0) {
    let avoidedCount = 0;
    learningData.diffPatterns.removed.forEach(({ text }) => {
      if (!messageLower.includes(text.toLowerCase())) {
        avoidedCount++;
      }
    });
    score += 15 * avoidedCount;
  }
  
  // 7. Training-Daten-Ähnlichkeit (wenn verfügbar)
  if (trainingData && trainingData.selectedExamples && trainingData.selectedExamples.length > 0) {
    try {
      const { getEmbedding, cosineSimilarity } = require('./embeddings');
      const messageEmbedding = await getEmbedding(message);
      if (messageEmbedding) {
        const similarities = await Promise.all(
          trainingData.selectedExamples.slice(0, 3).map(async ex => {
            const exEmbedding = await getEmbedding(ex.moderatorResponse || ex.assistant || '');
            if (exEmbedding) {
              return cosineSimilarity(messageEmbedding, exEmbedding);
            }
            return 0;
          })
        );
        
        const maxSimilarity = Math.max(...similarities.filter(s => s > 0), 0);
        if (maxSimilarity > 0) {
          score += 30 * maxSimilarity; // Max +30 Punkte
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler bei Training-Daten-Similarity-Check:', err.message);
    }
  }
  
  // Normalisiere Score auf 0-100
  return Math.min(100, Math.max(0, score));
}

