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

// Datei auf GitHub pushen
async function pushFileToGitHub(filePath, content, commitMessage) {
  const client = getGitHubClient();
  if (!client) {
    throw new Error("GitHub Client nicht verfügbar (GITHUB_TOKEN fehlt)");
  }
  
  const repo = getRepoInfo();
  
  try {
    // Lese aktuelle Datei von GitHub (falls vorhanden)
    let sha = null;
    try {
      const { data } = await client.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path: filePath,
        ref: repo.branch
      });
      sha = data.sha;
    } catch (err) {
      // Datei existiert noch nicht, das ist OK
      if (err.status !== 404) throw err;
    }
    
    // Konvertiere Content zu Base64
    const contentBase64 = Buffer.from(content, "utf8").toString("base64");
    
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
    
    console.log("✅ Datei erfolgreich auf GitHub gepusht:", filePath);
    console.log("📝 Commit SHA:", response.data.commit.sha);
    console.log("🔗 Commit URL:", response.data.commit.html_url);
    return { 
      success: true, 
      commit: response.data.commit,
      commitUrl: response.data.commit.html_url
    };
  } catch (err) {
    console.error("❌ Fehler beim Pushen auf GitHub:", err.message);
    throw err;
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
    if (data.encoding === 'base64') {
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return content;
    } else {
      return data.content;
    }
  } catch (err) {
    if (err.status === 404) {
      // Datei existiert noch nicht
      return null;
    }
    throw err;
  }
}

module.exports = {
  getGitHubClient,
  getRepoInfo,
  pushFileToGitHub,
  pushMultipleFilesToGitHub,
  getFileFromGitHub
};

