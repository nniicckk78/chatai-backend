/**
 * QUALITÄTS-MONITORING
 * 
 * Trackt die Qualität der generierten Antworten und speichert Statistiken.
 */

const fs = require('fs');
const path = require('path');
const { getGitHubClient, getRepoInfo, pushFileToGitHub } = require('./github');

// Qualitäts-Datenbank
const qualityDbPath = path.join(__dirname, '../../config/quality-stats.json');
let qualityStats = {
  totalResponses: 0,
  qualityScores: [], // Array von { timestamp, score, reason, chatId, platform }
  averageScore: 0,
  lastUpdated: null
};

// Lade Qualitäts-Statistiken
async function loadQualityStats() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/quality-stats.json',
        'src/config/quality-stats.json',
        'config/quality-stats.json',
        'server/config/quality-stats.json'
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
            qualityStats = JSON.parse(content);
            return qualityStats;
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Laden der Qualitäts-Statistiken von GitHub:', err.message);
    }
  }

  // Fallback: Lokale Datei
  try {
    if (fs.existsSync(qualityDbPath)) {
      const content = fs.readFileSync(qualityDbPath, 'utf8');
      qualityStats = JSON.parse(content);
      return qualityStats;
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Laden der lokalen Qualitäts-Statistiken:', err.message);
  }

  return qualityStats;
}

// Speichere Qualitäts-Statistiken
async function saveQualityStats(pushToGitHub = false) {
  try {
    const dbDir = path.dirname(qualityDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    qualityStats.lastUpdated = new Date().toISOString();
    
    // Berechne Durchschnitt
    if (qualityStats.qualityScores.length > 0) {
      const sum = qualityStats.qualityScores.reduce((acc, s) => acc + s.score, 0);
      qualityStats.averageScore = sum / qualityStats.qualityScores.length;
    }
    
    fs.writeFileSync(qualityDbPath, JSON.stringify(qualityStats, null, 2));

    if (pushToGitHub) {
      try {
        await pushFileToGitHub(
          'server/src/config/quality-stats.json',
          JSON.stringify(qualityStats, null, 2),
          'Update quality statistics'
        );
      } catch (err) {
        console.warn('⚠️ Fehler beim Pushen der Qualitäts-Statistiken zu GitHub:', err.message);
      }
    }
  } catch (err) {
    console.error('❌ Fehler beim Speichern der Qualitäts-Statistiken:', err.message);
  }
}

// 🚨🚨🚨 ERWEITERTE QUALITÄTSBEWERTUNG - MULTI-LAYER VALIDATION 🚨🚨🚨
// Bewerte Qualität einer Antwort mit mehreren Validierungsschichten
async function evaluateQuality(replyText, customerMessage, context = {}) {
  let score = 50; // Basis-Score (neutral)
  const reasons = [];
  const layers = []; // Multi-Layer Validation

  // LAYER 1: Basis-Validierung (Länge, Struktur)
  const length = replyText.length;
  if (length >= 120 && length <= 200) {
    score += 10;
    reasons.push('Gute Länge');
    layers.push({ layer: 'Basis', status: 'pass', detail: 'Gute Länge' });
  } else if (length < 80) {
    score -= 15;
    reasons.push('Zu kurz');
    layers.push({ layer: 'Basis', status: 'fail', detail: 'Zu kurz' });
  } else if (length > 300) {
    score -= 10;
    reasons.push('Zu lang');
    layers.push({ layer: 'Basis', status: 'warn', detail: 'Zu lang' });
  } else {
    layers.push({ layer: 'Basis', status: 'pass', detail: 'Akzeptable Länge' });
  }

  // LAYER 2: Regelkonformität (verbotene Wörter, Meta-Kommentare)
  if (context.forbiddenWords && context.forbiddenWords.length > 0) {
    score -= 30;
    reasons.push('Verbotene Wörter');
    layers.push({ layer: 'Regeln', status: 'fail', detail: `Verbotene Wörter: ${context.forbiddenWords.join(', ')}` });
  } else {
    layers.push({ layer: 'Regeln', status: 'pass', detail: 'Keine verbotenen Wörter' });
  }

  const metaPatterns = [
    /das ist (eine|ein)/i,
    /das klingt/i,
    /ich finde es/i,
    /das ist interessant/i
  ];
  const hasMetaComment = metaPatterns.some(pattern => pattern.test(replyText));
  if (hasMetaComment) {
    score -= 20;
    reasons.push('Meta-Kommentar');
    layers.push({ layer: 'Regeln', status: 'fail', detail: 'Meta-Kommentar erkannt' });
  }

  // LAYER 3: Strukturelle Qualität (Fragen, Wiederholungen, Formulierungen)
  const questionCount = (replyText.match(/\?/g) || []).length;
  if (questionCount > 1) {
    score -= 15;
    reasons.push('Mehrere Fragen');
    layers.push({ layer: 'Struktur', status: 'fail', detail: `${questionCount} Fragen (max 1)` });
  } else if (questionCount === 1) {
    score += 5;
    reasons.push('Eine Frage');
    layers.push({ layer: 'Struktur', status: 'pass', detail: 'Eine Frage' });
  } else {
    layers.push({ layer: 'Struktur', status: 'pass', detail: 'Keine Fragen' });
  }

  if (context.hasRepetition) {
    score -= 25;
    reasons.push('Wiederholung');
    layers.push({ layer: 'Struktur', status: 'fail', detail: 'Wiederholung erkannt' });
  }

  const formalPatterns = [
    /ich könnte dir/i,
    /ich würde dir/i,
    /ich möchte sicherstellen/i
  ];
  const hasFormalPhrase = formalPatterns.some(pattern => pattern.test(replyText));
  if (hasFormalPhrase) {
    score -= 15;
    reasons.push('Formelle Phrase');
    layers.push({ layer: 'Struktur', status: 'warn', detail: 'Formelle Phrase' });
  }

  // LAYER 4: Embedding-Similarity (wenn verfügbar)
  if (context.embeddingSimilarity !== undefined) {
    if (context.embeddingSimilarity >= 0.7) {
      score += 15;
      reasons.push('Ähnlich zu Training-Daten');
      layers.push({ layer: 'Embedding', status: 'pass', detail: `${(context.embeddingSimilarity * 100).toFixed(1)}% Similarity` });
    } else if (context.embeddingSimilarity < 0.5) {
      score -= 20;
      reasons.push('Zu unterschiedlich von Training-Daten');
      layers.push({ layer: 'Embedding', status: 'fail', detail: `${(context.embeddingSimilarity * 100).toFixed(1)}% Similarity (< 50%)` });
    } else {
      score -= 5;
      reasons.push('Mäßig ähnlich zu Training-Daten');
      layers.push({ layer: 'Embedding', status: 'warn', detail: `${(context.embeddingSimilarity * 100).toFixed(1)}% Similarity (< 70%)` });
    }
  }

  // LAYER 5: Emotionale/Stil-Qualität
  const emotionalWords = ['geil', 'heiß', 'mega', 'richtig', 'total', 'super', 'toll'];
  const hasEmotional = emotionalWords.some(word => replyText.toLowerCase().includes(word));
  if (hasEmotional && context.hasSexualContent) {
    score += 10;
    reasons.push('Emotionale Sprache');
    layers.push({ layer: 'Stil', status: 'pass', detail: 'Emotionale Sprache' });
  }

  // Normalisiere Score (0-100)
  score = Math.max(0, Math.min(100, score));

  // Bestimme Gesamt-Status
  const failCount = layers.filter(l => l.status === 'fail').length;
  const warnCount = layers.filter(l => l.status === 'warn').length;
  let overallStatus = 'pass';
  if (failCount > 0) overallStatus = 'fail';
  else if (warnCount > 1) overallStatus = 'warn';

  return { score, reasons, layers, overallStatus };
}

// Tracke Qualität einer Antwort
async function trackQuality(replyText, customerMessage, context = {}) {
  const evaluation = evaluateQuality(replyText, customerMessage, context);
  
  qualityStats.totalResponses++;
  qualityStats.qualityScores.push({
    timestamp: new Date().toISOString(),
    score: evaluation.score,
    reasons: evaluation.reasons,
    chatId: context.chatId || null,
    platform: context.platform || 'unknown',
    replyLength: replyText.length,
    customerLength: customerMessage?.length || 0
  });

  // Behalte nur die letzten 1000 Einträge
  if (qualityStats.qualityScores.length > 1000) {
    qualityStats.qualityScores = qualityStats.qualityScores.slice(-1000);
  }

  // Speichere (asynchron, blockiert nicht)
  setImmediate(() => {
    saveQualityStats(false); // Nicht auf GitHub pushen bei jedem Track (zu oft)
  });

  return evaluation;
}

// Hole Qualitäts-Statistiken
async function getQualityStats() {
  if (qualityStats.totalResponses === 0) {
    await loadQualityStats();
  }
  return qualityStats;
}

module.exports = {
  evaluateQuality,
  trackQuality,
  getQualityStats,
  loadQualityStats,
  saveQualityStats
};


