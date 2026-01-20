const { Octokit } = require("@octokit/rest");
const fs = require("fs");
const path = require("path");

// GitHub Client initialisieren
function getGitHubClient() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("⚠️ GITHUB_TOKEN nicht gesetzt - GitHub Integration deaktiviert");
    return null;
  }
  
  return new Octokit({
    auth: token
  });
}

// GitHub Repository Info aus Environment Variables
function getRepoInfo() {
  return {
    owner: process.env.GITHUB_OWNER || "nniicckk78",
    repo: process.env.GITHUB_REPO || "chatai-backend",
    branch: process.env.GITHUB_BRANCH || "main"
  };
}

// Datei auf GitHub pushen (mit Retry bei SHA-Konflikten)
async function pushFileToGitHub(filePath, content, commitMessage, maxRetries = 3) {
  const client = getGitHubClient();
  if (!client) {
    throw new Error("GitHub Client nicht verfügbar (GITHUB_TOKEN fehlt)");
  }
  
  const repo = getRepoInfo();
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Lese aktuelle Datei von GitHub (falls vorhanden)
      let sha = null;
      let currentContent = null;
      try {
        const { data } = await client.repos.getContent({
          owner: repo.owner,
          repo: repo.repo,
          path: filePath,
          ref: repo.branch
        });
        sha = data.sha;
        // Lade aktuellen Content für Merge bei Konflikten
        if (data.content) {
          currentContent = Buffer.from(data.content, 'base64').toString('utf8');
        }
      } catch (err) {
        // Datei existiert noch nicht, das ist OK
        if (err.status !== 404) throw err;
      }
      
      // Bei Retry: Versuche Content zu mergen (für messages.json und feedback.json)
      let finalContent = content;
      if (attempt > 1 && currentContent && (filePath.includes('messages.json') || filePath.includes('feedback.json'))) {
        try {
          const currentData = JSON.parse(currentContent);
          const newData = JSON.parse(content);
          
          // Merge: Für messages.json - füge neue Nachrichten hinzu
          if (filePath.includes('messages.json') && Array.isArray(currentData) && Array.isArray(newData)) {
            // Kombiniere Arrays und entferne Duplikate (basierend auf timestamp + chatId)
            const combined = [...currentData, ...newData];
            const unique = combined.filter((msg, index, self) => 
              index === self.findIndex(m => 
                m.timestamp === msg.timestamp && 
                (m.chatId === msg.chatId || (!m.chatId && !msg.chatId))
              )
            );
            finalContent = JSON.stringify(unique, null, 2);
          }
          
          // Merge: Für feedback.json - füge neue Feedbacks hinzu
          if (filePath.includes('feedback.json') && currentData.feedbacks && newData.feedbacks) {
            const combined = [...currentData.feedbacks, ...newData.feedbacks];
            const unique = combined.filter((fb, index, self) => 
              index === self.findIndex(f => f.id === fb.id)
            );
            finalContent = JSON.stringify({ feedbacks: unique }, null, 2);
          }
        } catch (mergeErr) {
          console.warn(`⚠️ Konnte Content nicht mergen (Versuch ${attempt}), verwende neuen Content:`, mergeErr.message);
          // Bei Merge-Fehler: Verwende neuen Content und hole neuen SHA
          if (sha) {
            // Hole neuen SHA für nächsten Versuch
            const { data: newData } = await client.repos.getContent({
              owner: repo.owner,
              repo: repo.repo,
              path: filePath,
              ref: repo.branch
            });
            sha = newData.sha;
          }
        }
      }
      
      // Konvertiere Content zu Base64
      const contentBase64 = Buffer.from(finalContent, "utf8").toString("base64");
      
      // Pushe Datei
      const params = {
        owner: repo.owner,
        repo: repo.repo,
        path: filePath,
        message: commitMessage || `Update ${filePath} via Dashboard`,
        content: contentBase64,
        branch: repo.branch
      };
      
      if (sha) {
        params.sha = sha; // Update existing file
      }
      
      const response = await client.repos.createOrUpdateFileContents(params);
      
      if (attempt > 1) {
        console.log(`✅ Datei erfolgreich auf GitHub gepusht (nach ${attempt} Versuchen):`, filePath);
      } else {
        console.log("✅ Datei erfolgreich auf GitHub gepusht:", filePath);
      }
      console.log("📝 Commit SHA:", response.data.commit.sha);
      console.log("🔗 Commit URL:", response.data.commit.html_url);
      return { 
        success: true, 
        commit: response.data.commit,
        commitUrl: response.data.commit.html_url
      };
    } catch (err) {
      // SHA-Konflikt: Retry mit neuem SHA
      if (err.status === 409 || err.message.includes('but expected')) {
        if (attempt < maxRetries) {
          const waitTime = attempt * 500; // Exponential backoff: 500ms, 1000ms, 1500ms
          console.warn(`⚠️ SHA-Konflikt bei ${filePath} (Versuch ${attempt}/${maxRetries}), warte ${waitTime}ms und versuche erneut...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue; // Retry
        } else {
          console.error(`❌ Fehler beim Pushen auf GitHub nach ${maxRetries} Versuchen:`, err.message);
          throw err;
        }
      } else {
        // Anderer Fehler: Sofort werfen
        console.error("❌ Fehler beim Pushen auf GitHub:", err.message);
        throw err;
      }
    }
  }
}

// Mehrere Dateien auf einmal pushen
async function pushMultipleFilesToGitHub(files, commitMessage) {
  const client = getGitHubClient();
  if (!client) {
    throw new Error("GitHub Client nicht verfügbar (GITHUB_TOKEN fehlt)");
  }
  
  const repo = getRepoInfo();
  const results = [];
  
  for (const file of files) {
    try {
      const result = await pushFileToGitHub(file.path, file.content, file.message || commitMessage);
      results.push({ path: file.path, success: true, ...result });
    } catch (err) {
      results.push({ path: file.path, success: false, error: err.message });
    }
  }
  
  return results;
}

// Datei von GitHub laden
async function getFileFromGitHub(filePath) {
  const client = getGitHubClient();
  if (!client) {
    throw new Error("GitHub Client nicht verfügbar (GITHUB_TOKEN fehlt)");
  }
  
  const repo = getRepoInfo();
  
  try {
    const { data } = await client.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path: filePath,
      ref: repo.branch
    });
    
    // GitHub gibt Base64-encodierten Content zurück
    if (data.encoding === 'base64' && data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return content;
    } 
    // Wenn GitHub einen download_url zurückgibt (bei großen Dateien), lade über HTTP
    else if (data.download_url) {
      console.log(`📥 Datei zu groß für direkten Content, lade über download_url: ${data.download_url}`);
      const https = require('https');
      const http = require('http');
      const url = require('url');
      
      return new Promise((resolve, reject) => {
        const parsedUrl = url.parse(data.download_url);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        
        client.get(data.download_url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            return;
          }
          
          let content = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            content += chunk;
          });
          res.on('end', () => {
            resolve(content);
          });
        }).on('error', (err) => {
          reject(err);
        });
      });
    }
    else if (data.content) {
      return data.content;
    } else {
      throw new Error('Kein Content oder download_url in GitHub-Response gefunden');
    }
  } catch (err) {
    if (err.status === 404) {
      // Datei existiert noch nicht
      return null;
    }
    throw err;
  }
}

// messages.json von GitHub laden (Duplikat-Schutz)
async function getMessages() {
  const content = await getFileFromGitHub("messages.json");
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed;
  } catch (err) {
    console.warn("⚠️ messages.json konnte nicht geparst werden:", err.message);
    return null;
  }
}

module.exports = {
  getGitHubClient,
  getRepoInfo,
  pushFileToGitHub,
  pushMultipleFilesToGitHub,
  getFileFromGitHub,
  getMessages
};

