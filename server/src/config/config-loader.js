const fs = require("fs");
const path = require("path");

const CONFIG_DIR = path.join(__dirname, "..", "config");
const RULES_FILE = path.join(CONFIG_DIR, "rules.json");
const TRAINING_DATA_FILE = path.join(CONFIG_DIR, "training-data.json");

// Lade Config beim Start
let cachedRules = null;
let cachedTrainingData = null;

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      const content = fs.readFileSync(RULES_FILE, "utf8");
      cachedRules = JSON.parse(content);
      console.log("✅ Rules config geladen");
      return cachedRules;
    } else {
      console.warn("⚠️ Rules config nicht gefunden, verwende Defaults");
      return getDefaultRules();
    }
  } catch (err) {
    console.error("❌ Fehler beim Laden der Rules config:", err.message);
    return getDefaultRules();
  }
}

function loadTrainingData() {
  try {
    if (fs.existsSync(TRAINING_DATA_FILE)) {
      const content = fs.readFileSync(TRAINING_DATA_FILE, "utf8");
      cachedTrainingData = JSON.parse(content);
      console.log("✅ Training data geladen:", cachedTrainingData.totalConversations, "Gespräche");
      return cachedTrainingData;
    } else {
      console.warn("⚠️ Training data nicht gefunden, verwende leere Liste");
      return { conversations: [], lastUpdated: null, totalConversations: 0 };
    }
  } catch (err) {
    console.error("❌ Fehler beim Laden der Training data:", err.message);
    return { conversations: [], lastUpdated: null, totalConversations: 0 };
  }
}

function getDefaultRules() {
  return {
    forbiddenWords: [],
    forbiddenPhrases: [],
    situationalResponses: {
      botAccusation: {
        enabled: true,
        instructions: "Reagiere verletzt und abweisend auf diese Unterstellung. Sage klar, dass du KEIN Bot/KI/Fake bist."
      },
      sexualTopics: {
        enabled: true,
        instructions: "Sei offen und flirty, aber nicht übertrieben."
      },
      meetingRequest: {
        enabled: true,
        instructions: "NIEMALS einem Treffen zustimmen oder einen Termin ausmachen!"
      },
      moneyTopics: {
        enabled: true,
        instructions: "Nicht über Geld/Coins/aufladen/kostenlos sprechen."
      }
    },
    allowedPhrases: {
      greetings: [],
      compliments: [],
      questions: []
    }
  };
}

// Reload Config (für Hot-Reload)
function reloadConfig() {
  cachedRules = loadRules();
  cachedTrainingData = loadTrainingData();
  console.log("🔄 Config neu geladen");
}

// Initial Load beim Start
cachedRules = loadRules();
cachedTrainingData = loadTrainingData();

module.exports = {
  getRules: () => cachedRules,
  getTrainingData: () => cachedTrainingData,
  reloadConfig,
  CONFIG_DIR,
  RULES_FILE,
  TRAINING_DATA_FILE
};

