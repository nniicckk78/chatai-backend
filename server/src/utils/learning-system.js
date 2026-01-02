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
            // Speichere auch lokal als Backup
            const statsPath = path.join(__dirname, '../../config/learning-stats.json');
            const configDir = path.dirname(statsPath);
            if (!fs.existsSync(configDir)) {
              fs.mkdirSync(configDir, { recursive: true });
            }
            fs.writeFileSync(statsPath, content);
            return parsed;
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
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Learning-Statistiken:', err);
  }
  
  // Standard-Struktur
  return {
    patterns: {}, // Muster in guten Antworten (z.B. "geil" → häufig in guten Antworten)
    wordFrequency: {}, // Häufigkeit von Wörtern in guten vs. schlechten Antworten
    situationSuccess: {}, // Erfolgsrate pro Situation (z.B. "Treffen/Termine" → 80% positive Feedbacks)
    responsePatterns: [], // Bewährte Antwort-Muster
    lastUpdated: new Date().toISOString()
  };
}

// Speichere Learning-Statistiken (lokal + GitHub)
async function saveLearningStats(stats) {
  const statsPath = path.join(__dirname, '../../config/learning-stats.json');
  const configDir = path.dirname(statsPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  stats.lastUpdated = new Date().toISOString();
  const content = JSON.stringify(stats, null, 2);
  fs.writeFileSync(statsPath, content);
  
  // Versuche auch auf GitHub zu pushen
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

// Analysiere Feedback und aktualisiere Learning-Statistiken
async function analyzeFeedback(feedback) {
  const stats = getLearningStats();
  const { customerMessage, aiResponse, editedResponse, status, situation } = feedback;
  
  // Bestimme, welche Antwort als "gut" gilt
  const goodResponse = status === 'edited' && editedResponse ? editedResponse : (status === 'good' ? aiResponse : null);
  const badResponse = status === 'edited' && editedResponse ? aiResponse : null; // Original war schlecht
  
  if (goodResponse) {
    // Analysiere gute Antwort: Welche Wörter/Phrasen kommen häufig vor?
    const words = extractWords(goodResponse);
    words.forEach(word => {
      if (!stats.wordFrequency[word]) {
        stats.wordFrequency[word] = { good: 0, bad: 0 };
      }
      stats.wordFrequency[word].good++;
    });
    
    // Analysiere Muster in guten Antworten
    const patterns = extractPatterns(goodResponse);
    patterns.forEach(pattern => {
      if (!stats.patterns[pattern]) {
        stats.patterns[pattern] = { count: 0, successRate: 0 };
      }
      stats.patterns[pattern].count++;
    });
    
    // Speichere bewährte Antwort-Muster
    if (situation) {
      if (!stats.situationSuccess[situation]) {
        stats.situationSuccess[situation] = { good: 0, total: 0 };
      }
      stats.situationSuccess[situation].good++;
      stats.situationSuccess[situation].total++;
      
      // Speichere bewährtes Antwort-Muster für diese Situation
      const responsePattern = {
        situation,
        customerPattern: extractCustomerPattern(customerMessage),
        goodResponse: goodResponse.substring(0, 200), // Erste 200 Zeichen als Muster
        successCount: 1,
        lastUsed: new Date().toISOString()
      };
      
      // Prüfe, ob ähnliches Muster bereits existiert
      const existingPattern = stats.responsePatterns.find(p => 
        p.situation === situation && 
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
    // Analysiere schlechte Antwort: Welche Wörter/Phrasen vermeiden?
    const words = extractWords(badResponse);
    words.forEach(word => {
      if (!stats.wordFrequency[word]) {
        stats.wordFrequency[word] = { good: 0, bad: 0 };
      }
      stats.wordFrequency[word].bad++;
    });
    
    if (situation) {
      if (!stats.situationSuccess[situation]) {
        stats.situationSuccess[situation] = { good: 0, total: 0 };
      }
      stats.situationSuccess[situation].total++;
    }
  }
  
  // Sortiere und limitiere responsePatterns (behalte nur die besten)
  stats.responsePatterns.sort((a, b) => b.successCount - a.successCount);
  stats.responsePatterns = stats.responsePatterns.slice(0, 100); // Top 100 Muster
  
  await saveLearningStats(stats);
  return stats;
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

// Finde bewährte Antwort-Muster für eine Situation
async function findProvenPatterns(situation, customerPattern, stats) {
  if (!stats || !stats.responsePatterns) return [];
  
  // Finde Muster für diese Situation
  const situationPatterns = stats.responsePatterns.filter(p => p.situation === situation);
  
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
  
  // Sortiere nach Score und gib Top 5 zurück
  return scoredPatterns
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(p => p.pattern);
}

// Generiere Learning-Context für den Prompt
async function generateLearningContext(customerMessage, situation, stats) {
  if (!stats || Object.keys(stats).length === 0) return '';
  
  const customerPattern = extractCustomerPattern(customerMessage);
  const provenPatterns = await findProvenPatterns(situation, customerPattern, stats);
  
  let context = '\n\n🧠🧠🧠 LERN-SYSTEM - BEWÄHRTE MUSTER (ERGÄNZEND ZU ALLEN REGELN) 🧠🧠🧠\n\n';
  
  // WICHTIG: Learning-System ist ERGÄNZEND, überschreibt KEINE Regeln!
  context += `🚨🚨🚨 WICHTIG: Diese bewährten Muster sind ERGÄNZEND zu allen anderen Regeln! 🚨🚨🚨\n`;
  context += `- Hardcode-Regeln haben HÖCHSTE PRIORITÄT (z.B. "KEINE Treffen zustimmen", "KEINE verbotenen Wörter")\n`;
  context += `- Dashboard-Regeln haben hohe Priorität (situations-spezifische Antworten)\n`;
  context += `- Training-Daten zeigen Stil und Wortwahl\n`;
  context += `- Learning-System zeigt BEWÄHRTE Muster, die bereits erfolgreich waren\n`;
  context += `→ Verwende diese bewährten Muster, ABER halte dich an ALLE Regeln!\n\n`;
  
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
  
  // Zeige häufig erfolgreiche Wörter
  const topWords = Object.entries(stats.wordFrequency || {})
    .filter(([word, freq]) => freq.good > freq.bad && freq.good >= 3)
    .sort((a, b) => (b[1].good - b[1].bad) - (a[1].good - a[1].bad))
    .slice(0, 10)
    .map(([word]) => word);
  
  if (topWords.length > 0) {
    context += `⭐ HÄUFIG ERFOLGREICHE WÖRTER (verwende diese öfter): ${topWords.join(', ')}\n\n`;
  }
  
  // Zeige Erfolgsrate pro Situation
  if (stats.situationSuccess && stats.situationSuccess[situation]) {
    const success = stats.situationSuccess[situation];
    const successRate = success.total > 0 ? (success.good / success.total * 100).toFixed(0) : 0;
    context += `📊 Erfolgsrate für "${situation}": ${successRate}% (${success.good}/${success.total} positive Feedbacks)\n\n`;
  }
  
  context += `🧠🧠🧠 Das System lernt kontinuierlich aus Feedback - diese Muster basieren auf ${Object.keys(stats.responsePatterns || {}).length} bewährten Beispielen! 🧠🧠🧠\n\n`;
  
  return context;
}

module.exports = {
  getLearningStats,
  saveLearningStats,
  analyzeFeedback,
  generateLearningContext,
  findProvenPatterns
};

