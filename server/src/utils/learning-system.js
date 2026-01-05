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
    reasoningPrinciples: [], // 🚨 NEU: Prinzipien aus Begründungen (z.B. "Gehe auf ALLE Anfragen ein")
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
  const { customerMessage, aiResponse, editedResponse, status, situation, reasoning } = feedback; // 🚨 NEU: reasoning
  
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
    
    // 🚨 WICHTIG: Speichere bewährte Antwort-Muster für ALLE Situationen
    if (situationsArray.length > 0) {
      situationsArray.forEach(sit => {
        if (!stats.situationSuccess[sit]) {
          stats.situationSuccess[sit] = { good: 0, total: 0 };
        }
        stats.situationSuccess[sit].good++;
        stats.situationSuccess[sit].total++;
        
        // Speichere bewährtes Antwort-Muster für diese Situation
        const responsePattern = {
          situation: sit,
          customerPattern: extractCustomerPattern(customerMessage),
          goodResponse: goodResponse.substring(0, 200), // Erste 200 Zeichen als Muster
          successCount: 1,
          lastUsed: new Date().toISOString()
        };
        
        // Prüfe, ob ähnliches Muster bereits existiert
        const existingPattern = stats.responsePatterns.find(p => 
          p.situation === sit && 
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
      });
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
  
  // 🚨 NEU: Sortiere und limitiere reasoningPrinciples (behalte nur die besten)
  if (stats.reasoningPrinciples) {
    stats.reasoningPrinciples.sort((a, b) => b.count - a.count);
    stats.reasoningPrinciples = stats.reasoningPrinciples.slice(0, 50); // Top 50 Prinzipien
  }
  
  // Speichere lokal, pushe auf GitHub nur wenn gewünscht (nicht während Initialisierung)
  await saveLearningStats(stats, pushToGitHub);
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
    { pattern: /(emotional|gefühl|warm)/i, principle: 'Zeige Emotionen und Wärme' }
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
  
  // 🚨 WICHTIG: Zeige Erfolgsrate für ALLE Situationen
  if (situationsArray.length > 0 && stats.situationSuccess) {
    situationsArray.forEach(sit => {
      if (stats.situationSuccess[sit]) {
        const success = stats.situationSuccess[sit];
        const successRate = success.total > 0 ? (success.good / success.total * 100).toFixed(0) : 0;
        context += `📊 Erfolgsrate für "${sit}": ${successRate}% (${success.good}/${success.total} positive Feedbacks)\n`;
      }
    });
    if (situationsArray.length > 0) context += '\n';
  } else if (typeof situation === 'string' && stats.situationSuccess && stats.situationSuccess[situation]) {
    // Fallback für String-Format
    const success = stats.situationSuccess[situation];
    const successRate = success.total > 0 ? (success.good / success.total * 100).toFixed(0) : 0;
    context += `📊 Erfolgsrate für "${situation}": ${successRate}% (${success.good}/${success.total} positive Feedbacks)\n\n`;
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
            // Jedes Training-Daten-Gespräch ist ein "gutes" Beispiel
            await analyzeFeedback({
              customerMessage: conv.customer,
              aiResponse: conv.assistant,
              editedResponse: null,
              status: 'good', // Training-Daten sind immer "gut"
              situation: conv.situation || 'allgemein'
            }, false); // Kein Push während Initialisierung
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
            // Bestimme Situation aus Kunden-Nachricht
            const situation = detectSituationFromMessage(feedback.customerMessage);
            
      await analyzeFeedback({
        customerMessage: feedback.customerMessage,
        aiResponse: feedback.aiResponse,
        editedResponse: feedback.editedResponse || null,
        status: feedback.status,
        situation: situation,
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
  initializeLearningSystem
};

