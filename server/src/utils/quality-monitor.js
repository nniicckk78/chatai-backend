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

// Bewerte Qualität einer Antwort
function evaluateQuality(replyText, customerMessage, context = {}) {
  let score = 50; // Basis-Score (neutral)
  const reasons = [];

  // Prüfe Länge (optimal: 120-200 Zeichen)
  const length = replyText.length;
  if (length >= 120 && length <= 200) {
    score += 10;
    reasons.push('Gute Länge');
  } else if (length < 80) {
    score -= 15;
    reasons.push('Zu kurz');
  } else if (length > 300) {
    score -= 10;
    reasons.push('Zu lang');
  }

  // Prüfe auf verbotene Wörter (wenn vorhanden)
  if (context.forbiddenWords && context.forbiddenWords.length > 0) {
    score -= 30;
    reasons.push('Verbotene Wörter');
  }

  // Prüfe auf Meta-Kommentare
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
  }

  // Prüfe auf mehrere Fragen
  const questionCount = (replyText.match(/\?/g) || []).length;
  if (questionCount > 1) {
    score -= 15;
    reasons.push('Mehrere Fragen');
  } else if (questionCount === 1) {
    score += 5;
    reasons.push('Eine Frage');
  }

  // Prüfe auf Wiederholungen (wenn vorhanden)
  if (context.hasRepetition) {
    score -= 25;
    reasons.push('Wiederholung');
  }

  // Prüfe auf natürliche Sprache (keine formellen Phrasen)
  const formalPatterns = [
    /ich könnte dir/i,
    /ich würde dir/i,
    /ich möchte sicherstellen/i
  ];
  const hasFormalPhrase = formalPatterns.some(pattern => pattern.test(replyText));
  if (hasFormalPhrase) {
    score -= 15;
    reasons.push('Formelle Phrase');
  }

  // Prüfe auf emotionale Sprache (gut)
  const emotionalWords = ['geil', 'heiß', 'mega', 'richtig', 'total', 'super', 'toll'];
  const hasEmotional = emotionalWords.some(word => replyText.toLowerCase().includes(word));
  if (hasEmotional && context.hasSexualContent) {
    score += 10;
    reasons.push('Emotionale Sprache');
  }

  // Normalisiere Score (0-100)
  score = Math.max(0, Math.min(100, score));

  return { score, reasons };
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

