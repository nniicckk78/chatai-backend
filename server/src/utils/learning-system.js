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
  const { customerMessage, aiResponse, editedResponse, status, situation, reasoning } = feedback; // 🚨 NEU: reasoning
  
  // 🚨 FIX: Stelle sicher, dass alle benötigten Arrays existieren
  if (!stats.reasoningPrinciples) stats.reasoningPrinciples = [];
  if (!stats.responsePatterns) stats.responsePatterns = [];
  if (!stats.patterns) stats.patterns = {};
  if (!stats.wordFrequency) stats.wordFrequency = {};
  if (!stats.situationSuccess) stats.situationSuccess = {};
  if (!stats.messageStats) stats.messageStats = {}; // 🚨 NEU: Nachrichtenstatistiken
  if (!stats.proactivePatterns) stats.proactivePatterns = []; // 🚨 NEU: Proaktive Muster
  
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
        stats.wordFrequency[primarySituation][word] = { good: 0, bad: 0 };
      }
      stats.wordFrequency[primarySituation][word].good++;
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
        stats.wordFrequency[primarySituation][word] = { good: 0, bad: 0 };
      }
      stats.wordFrequency[primarySituation][word].bad++;
    });
    
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
  
  // Sortiere und limitiere responsePatterns (behalte nur die besten)
  stats.responsePatterns.sort((a, b) => b.successCount - a.successCount);
  stats.responsePatterns = stats.responsePatterns.slice(0, 100); // Top 100 Muster
  
  // 🚨 NEU: Sortiere und limitiere reasoningPrinciples (behalte nur die besten)
  if (stats.reasoningPrinciples) {
    stats.reasoningPrinciples.sort((a, b) => b.count - a.count);
    stats.reasoningPrinciples = stats.reasoningPrinciples.slice(0, 50); // Top 50 Prinzipien
  }
  
  // Speichere lokal, pushe auf GitHub nur wenn gewünscht (nicht während Initialisierung)
  await saveLearningStats(stats, pushToGitHub);
  return stats;
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

// 🚨 NEU: Extrahiere Prinzipien aus Begründungen (reasoning)
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
  
  // Zeige bewährte Muster für diese Situation
  if (provenPatterns.length > 0) {
    context += `🚨🚨🚨 KRITISCH: Diese Antwort-Muster haben sich bei ähnlichen Situationen BEWÄHRT (${provenPatterns.length} erfolgreiche Beispiele):\n\n`;
    
    provenPatterns.forEach((pattern, idx) => {
      context += `✅ BEWÄHRTES MUSTER ${idx + 1} (${pattern.successCount}x erfolgreich):\n`;
      context += `Kunde: "${pattern.customerPattern.keywords || 'Ähnliche Situation'}..."\n`;
      context += `Bewährte Antwort: "${pattern.goodResponse}..."\n\n`;
    });
    
    context += `🚨🚨🚨 WICHTIG: Orientiere dich an diesen BEWÄHRTEN Mustern! Diese Antworten haben sich bereits ${provenPatterns.reduce((sum, p) => sum + p.successCount, 0)}x als erfolgreich erwiesen!\n`;
    context += `🚨🚨🚨 ABER: Halte dich trotzdem an ALLE Regeln (Hardcode + Dashboard + Training-Daten)! 🚨🚨🚨\n\n`;
  }
  
  // 🚨 NEU: Zeige Nachrichtenstatistiken für diese Situation(en)
  const primarySituation = situationsArray.length > 0 ? situationsArray[0] : (situation || 'allgemein');
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
  
  // 🚨 NEU: Zeige Prinzipien aus Begründungen (reasoning)
  if (stats.reasoningPrinciples && stats.reasoningPrinciples.length > 0) {
    // Filtere relevante Prinzipien für diese Situation(en)
    const relevantPrinciples = situationsArray.length > 0
      ? stats.reasoningPrinciples.filter(p => 
          p.situations && p.situations.some(sit => situationsArray.includes(sit))
        )
      : stats.reasoningPrinciples;
    
    if (relevantPrinciples.length > 0) {
      context += `\n🧠🧠🧠 PRINZIPIEN AUS BEGRÜNDUNGEN (WARUM Antworten gut sind): 🧠🧠🧠\n\n`;
      context += `🚨🚨🚨 KRITISCH: Diese Prinzipien wurden aus Begründungen extrahiert - sie erklären, WARUM bestimmte Antworten gut sind! 🚨🚨🚨\n\n`;
      
      relevantPrinciples.slice(0, 10).forEach((principle, idx) => {
        context += `✅ Prinzip ${idx + 1} (${principle.count}x bestätigt): ${principle.text}\n`;
        if (principle.situations && principle.situations.length > 0) {
          context += `   → Gilt für: ${principle.situations.join(', ')}\n`;
        }
      });
      
      context += `\n🚨🚨🚨 WICHTIG: Nutze diese Prinzipien beim Generieren deiner Antwort! 🚨🚨🚨\n\n`;
    }
  }
  
  // 🚨 NEU: Zeige proaktive Muster (eigene Vorlieben/Interessen + Frage)
  if (stats.proactivePatterns && stats.proactivePatterns.length > 0) {
    // Filtere relevante proaktive Muster für diese Situation(en)
    const relevantProactive = situationsArray.length > 0
      ? stats.proactivePatterns.filter(p => 
          p.situation && situationsArray.includes(p.situation)
        )
      : stats.proactivePatterns;
    
    if (relevantProactive.length > 0) {
      context += `\n🚀🚀🚀 PROAKTIVE GESPRÄCHSFÜHRUNG - EIGENE VORLIEBEN/INTERESSEN NENNEN! 🚀🚀🚀\n\n`;
      context += `🚨🚨🚨 KRITISCH: Diese Muster zeigen, dass erfolgreiche Nachrichten EIGENE Vorlieben/Interessen/Erfahrungen nennen, BEVOR sie fragen! 🚨🚨🚨\n\n`;
      
      relevantProactive.slice(0, 5).forEach((pattern, idx) => {
        context += `✅ Proaktives Muster ${idx + 1} (${pattern.count}x erfolgreich):\n`;
        context += `   Beispiel: "${pattern.example}..."\n`;
        context += `   Situation: ${pattern.situation}\n`;
        context += `   Muster: ${pattern.pattern}\n\n`;
      });
      
      context += `🚨🚨🚨 WICHTIG: Nenne IMMER eigene Vorlieben/Interessen/Erfahrungen, BEVOR du fragst! 🚨🚨🚨\n`;
      context += `- Sexuell: "Ich liebe Doggy. Was magst du denn so?"\n`;
      context += `- Allgemein: "Ich gehe gerne ins Kino. Was machst du denn so in deiner Freizeit?"\n`;
      context += `- Hobbies: "Ich koche gerne italienisch. Was kochst du denn am liebsten?"\n\n`;
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
          if (conv.customer && conv.assistant && conv.situation) {
            const situation = conv.situation || 'allgemein';
            const isNegative = conv.isNegativeExample === true;
            
            // 🚨 NEU: Analysiere Nachrichtenstatistiken für Training-Daten
            if (isNegative) {
              // Negative Beispiele analysieren
              analyzeMessageStats(conv.assistant, situation, stats, false);
            } else {
              // Positive Beispiele analysieren
              analyzeMessageStats(conv.assistant, situation, stats, true);
            }
            
            // Jedes Training-Daten-Gespräch ist ein "gutes" Beispiel (außer negative)
            if (!isNegative) {
              await analyzeFeedback({
                customerMessage: conv.customer,
                aiResponse: conv.assistant,
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

module.exports = {
  getLearningStats,
  saveLearningStats,
  analyzeFeedback,
  generateLearningContext,
  findProvenPatterns,
  initializeLearningSystem,
  detectProactivePattern // 🚨 NEU: Export für Post-Processing
};

