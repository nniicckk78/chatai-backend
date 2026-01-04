/**
 * ERFOLGSMETRIKEN - Trackt Erfolg der generierten Antworten
 * 
 * Misst: Antwortrate, Gesprächslänge, Kundenengagement, etc.
 */

const fs = require('fs');
const path = require('path');
const { getGitHubClient, getRepoInfo, pushFileToGitHub } = require('./github');

// Erfolgsmetriken-Datenbank
const metricsDbPath = path.join(__dirname, '../../config/success-metrics.json');
let successMetrics = {
  totalMessages: 0,
  totalChats: 0,
  averageReplyLength: 0,
  averageQualityScore: 0,
  responseRate: 0, // % der Nachrichten, die eine Antwort erhalten
  averageConversationLength: 0, // Durchschnittliche Anzahl Nachrichten pro Chat
  platformStats: {}, // Statistiken pro Plattform
  situationStats: {}, // Statistiken pro Situation
  recentMetrics: [], // Letzte 1000 Metriken für Analyse
  lastUpdated: null
};

// Lade Erfolgsmetriken
async function loadSuccessMetrics() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/success-metrics.json',
        'src/config/success-metrics.json',
        'config/success-metrics.json',
        'server/config/success-metrics.json'
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
            successMetrics = JSON.parse(content);
            return successMetrics;
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler beim Laden der Erfolgsmetriken von GitHub:', err.message);
    }
  }

  // Fallback: Lokale Datei
  try {
    if (fs.existsSync(metricsDbPath)) {
      const content = fs.readFileSync(metricsDbPath, 'utf8');
      successMetrics = JSON.parse(content);
      return successMetrics;
    }
  } catch (err) {
    console.warn('⚠️ Fehler beim Laden der lokalen Erfolgsmetriken:', err.message);
  }

  return successMetrics;
}

// Speichere Erfolgsmetriken
async function saveSuccessMetrics(pushToGitHub = false) {
  try {
    const dbDir = path.dirname(metricsDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    successMetrics.lastUpdated = new Date().toISOString();
    
    // Berechne Durchschnitte
    if (successMetrics.recentMetrics.length > 0) {
      const totalLength = successMetrics.recentMetrics.reduce((sum, m) => sum + (m.replyLength || 0), 0);
      const totalQuality = successMetrics.recentMetrics.reduce((sum, m) => sum + (m.qualityScore || 0), 0);
      successMetrics.averageReplyLength = totalLength / successMetrics.recentMetrics.length;
      successMetrics.averageQualityScore = totalQuality / successMetrics.recentMetrics.length;
    }
    
    fs.writeFileSync(metricsDbPath, JSON.stringify(successMetrics, null, 2));

    if (pushToGitHub) {
      try {
        await pushFileToGitHub(
          'server/src/config/success-metrics.json',
          JSON.stringify(successMetrics, null, 2),
          'Update success metrics'
        );
      } catch (err) {
        console.warn('⚠️ Fehler beim Pushen der Erfolgsmetriken zu GitHub:', err.message);
      }
    }
  } catch (err) {
    console.error('❌ Fehler beim Speichern der Erfolgsmetriken:', err.message);
  }
}

// Tracke Erfolgsmetriken für eine Antwort
async function trackSuccessMetrics(metrics) {
  if (!metrics) return;
  
  // Lade Metriken, falls noch nicht geladen
  if (successMetrics.totalMessages === 0) {
    await loadSuccessMetrics();
  }
  
  successMetrics.totalMessages++;
  
  // Speichere Metrik
  successMetrics.recentMetrics.push({
    timestamp: metrics.timestamp || new Date().toISOString(),
    chatId: metrics.chatId || null,
    platform: metrics.platform || 'unknown',
    replyLength: metrics.replyLength || 0,
    customerMessageLength: metrics.customerMessageLength || 0,
    qualityScore: metrics.qualityScore || 0,
    hasQuestion: metrics.hasQuestion || false,
    isNewCustomer: metrics.isNewCustomer || false,
    situation: metrics.situation || 'allgemein'
  });
  
  // Behalte nur die letzten 1000 Einträge
  if (successMetrics.recentMetrics.length > 1000) {
    successMetrics.recentMetrics = successMetrics.recentMetrics.slice(-1000);
  }
  
  // Plattform-Statistiken
  const platform = metrics.platform || 'unknown';
  if (!successMetrics.platformStats[platform]) {
    successMetrics.platformStats[platform] = {
      totalMessages: 0,
      averageQualityScore: 0,
      averageReplyLength: 0
    };
  }
  successMetrics.platformStats[platform].totalMessages++;
  
  // Situation-Statistiken
  const situation = metrics.situation || 'allgemein';
  if (!successMetrics.situationStats[situation]) {
    successMetrics.situationStats[situation] = {
      totalMessages: 0,
      averageQualityScore: 0
    };
  }
  successMetrics.situationStats[situation].totalMessages++;
  
  // Speichere (asynchron, blockiert nicht)
  setImmediate(() => {
    saveSuccessMetrics(false); // Nicht auf GitHub pushen bei jedem Track (zu oft)
  });
  
  return successMetrics;
}

// Hole Erfolgsmetriken
async function getSuccessMetrics() {
  if (successMetrics.totalMessages === 0) {
    await loadSuccessMetrics();
  }
  return successMetrics;
}

module.exports = {
  trackSuccessMetrics,
  getSuccessMetrics,
  loadSuccessMetrics,
  saveSuccessMetrics
};

