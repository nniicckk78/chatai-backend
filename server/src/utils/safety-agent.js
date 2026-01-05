/**
 * 🛡️ SAFETY AGENT
 * Prüft auf kritische Sicherheitsprobleme:
 * - Minderjährige
 * - KI-Check-Codes
 * - Illegale Themen (Inzest, Pädophilie, Zoophilie)
 */

/**
 * Prüft ob eine Nachricht Minderjährige oder illegale Themen enthält
 * @param {string} text - Zu prüfender Text
 * @returns {Object} - { isBlocked: boolean, reason: string, errorMessage: string }
 */
function checkMinorMention(text) {
  if (!text) return { isBlocked: false, reason: null, errorMessage: null };
  
  const lower = text.toLowerCase();
  
  // 🚨🚨🚨 KRITISCH: ALLE sexuellen Wörter (normal und hardcore) sind ERLAUBT! 🚨🚨🚨
  // 🚨🚨🚨 NUR blockieren: Minderjährige, Pädophilie, Inzest, Zoophilie 🚨🚨🚨
  
  // Nur für Altersprüfungen: Liste von harmlosen Wörtern
  const ageFalsePositiveTerms = [
    "wünsch", "wünschen", "wünscht", "wünschst", "wünschte", "wünschten", "wünsche",
    "schön", "schon", "schönsten", "schönen", "schöner", "schöne", "schönes",
    "gabi", "gab", "gabriel", "gabe",
    "tag", "tage", "tagen", "tägig", "tägige"
  ];
  
  const hasAgeFalsePositive = ageFalsePositiveTerms.some(term => lower.includes(term));
  
  // Direkte Erwähnungen von Minderjährigkeit
  if (!hasAgeFalsePositive) {
    if (lower.includes("minderjähr")) {
      return { isBlocked: true, reason: "minor", errorMessage: "🚨 BLOCKIERT: Minderjähriger Kunde erkannt (unter 18)!" };
    }
    if (lower.includes("unter 18") || lower.includes("unter achtzehn") || lower.includes("noch nicht volljährig") || lower.includes("noch nicht 18")) {
      return { isBlocked: true, reason: "minor", errorMessage: "🚨 BLOCKIERT: Minderjähriger Kunde erkannt (unter 18)!" };
    }
    if (lower.includes("jugendlich") && (lower.includes("14") || lower.includes("15") || lower.includes("16") || lower.includes("17"))) {
      return { isBlocked: true, reason: "minor", errorMessage: "🚨 BLOCKIERT: Minderjähriger Kunde erkannt (unter 18)!" };
    }
  }
  
  // Altersprüfung: 10-17 Jahre
  const agePatterns = [
    /\b(1[0-7])\s*(jahr|jahre|j|alt|jährig)\b/i,
    /\bich bin (1[0-7])\s*(jahr|jahre|j|alt|jährig)?\b/i,
    /\b(1[0-7])\s*jahre alt\b/i,
    /\b(1[0-7])\s*und\s*(halb|halbjahr)\b/i
  ];
  
  for (const pattern of agePatterns) {
    if (pattern.test(lower)) {
      const match = lower.match(pattern);
      if (match) {
        const matchIndex = lower.indexOf(match[0]);
        const context = lower.substring(Math.max(0, matchIndex - 30), Math.min(lower.length, matchIndex + match[0].length + 30));
        const isAgeFalsePositive = ageFalsePositiveTerms.some(term => context.includes(term));
        const isAgeContext = context.includes("alt") || context.includes("jahr") || 
                            (context.includes("bin") && (context.includes("alt") || context.includes("jahr"))) || 
                            (context.includes("habe") && (context.includes("alt") || context.includes("jahr")));
        
        if (isAgeContext && !isAgeFalsePositive) {
          return { isBlocked: true, reason: "minor", errorMessage: "🚨 BLOCKIERT: Minderjähriger Kunde erkannt (unter 18)!" };
        }
      }
    }
  }
  
  // Zahlen 10-17 in Kombination mit "alt", "Jahre", etc.
  const numbers = lower.match(/\b(1[0-7])\b/g);
  if (numbers && !hasAgeFalsePositive) {
    for (const number of numbers) {
      const numberIndex = lower.indexOf(number);
      const context = lower.substring(Math.max(0, numberIndex - 40), Math.min(lower.length, numberIndex + number.length + 40));
      const isAgeFalsePositive = ageFalsePositiveTerms.some(term => context.includes(term));
      const isAgeContext = context.includes("alt") || context.includes("jahr") || 
                          (context.includes("bin") && (context.includes("alt") || context.includes("jahr"))) || 
                          (context.includes("habe") && (context.includes("alt") || context.includes("jahr"))) ||
                          context.includes("jährig");
      
      if (isAgeContext && !isAgeFalsePositive) {
        return { isBlocked: true, reason: "minor", errorMessage: "🚨 BLOCKIERT: Minderjähriger Kunde erkannt (unter 18)!" };
      }
    }
  }
  
  // Inzest - nur wenn in sexuellem Kontext
  const incestTerms = ["inzest", "inzestuös", "geschwisterliebe", "geschwisterlich"];
  for (const term of incestTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      return { isBlocked: true, reason: "incest", errorMessage: "🚨 BLOCKIERT: Inzest-Themen erkannt!" };
    }
  }
  
  // Familienmitglieder - nur blockieren wenn in EXPLIZIT sexuellem Kontext
  const familyTerms = ["mutter", "vater", "tochter", "sohn", "bruder", "schwester", "cousin", "cousine", "onkel", "tante", "neffe", "nichte"];
  for (const term of familyTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      const context = lower.substring(Math.max(0, lower.indexOf(term) - 50), Math.min(lower.length, lower.indexOf(term) + 50));
      const explicitSexualTerms = ["sex", "ficken", "fick", "besorgen", "besorg", "geil", "heiß", "vögeln", "blasen", "lecken", "lutschen", "schwanz", "pussy", "muschi", "arsch", "titten", "brüste", "sperma", "orgasmus", "kommen"];
      const hasExplicitSexualContext = explicitSexualTerms.some(word => context.includes(word));
      const incestIndicators = ["mit", "und", "zusammen", "oder"];
      const hasIncestContext = hasExplicitSexualContext && incestIndicators.some(indicator => {
        const beforeTerm = context.substring(0, context.indexOf(term));
        const afterTerm = context.substring(context.indexOf(term) + term.length);
        return (beforeTerm.includes(indicator) || afterTerm.includes(indicator)) && 
               (beforeTerm.includes("sex") || beforeTerm.includes("fick") || afterTerm.includes("sex") || afterTerm.includes("fick"));
      });
      
      if (hasExplicitSexualContext && hasIncestContext) {
        return { isBlocked: true, reason: "incest", errorMessage: "🚨 BLOCKIERT: Inzest-Themen erkannt!" };
      }
    }
  }
  
  // Pädophilie - direkt blockieren
  const pedoTerms = ["pädophil", "pedophil", "pedo", "kinderschänder", "kindesmissbrauch", "kinderpornografie", "kinderporno", "cp", "lolita"];
  for (const term of pedoTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      return { isBlocked: true, reason: "pedophilia", errorMessage: "🚨 BLOCKIERT: Pädophilie-Themen erkannt!" };
    }
  }
  
  // Zoophilie
  const zoophiliaTerms = ["bestialität", "zoophilie"];
  for (const term of zoophiliaTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(lower)) {
      return { isBlocked: true, reason: "zoophilia", errorMessage: "🚨 BLOCKIERT: Zoophilie-Themen erkannt!" };
    }
  }
  
  // "tier" - nur blockieren wenn EXPLIZIT Zoophilie erwähnt wird
  if (/\btier\b/i.test(lower)) {
    const hasZoophiliaTerm = ["bestialität", "zoophilie", "tier ficken", "tier sex", "tier fick", "tier besorgen"].some(term => lower.includes(term));
    if (hasZoophiliaTerm) {
      return { isBlocked: true, reason: "zoophilia", errorMessage: "🚨 BLOCKIERT: Zoophilie-Themen erkannt!" };
    }
  }
  
  return { isBlocked: false, reason: null, errorMessage: null };
}

/**
 * Prüft ob eine Nachricht einen KI-Check-Code enthält
 * @param {string} text - Zu prüfender Text
 * @returns {boolean} - true wenn KI-Check erkannt
 */
function checkKICheckMessage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  const kiCheckPatterns = [
    /-{1,3}\s*ki[-\s]?prüfung\s+aktiv/i,
    /ki[-\s]?prüfung\s+aktiv/i,
    /ki[-\s]?check\s+aktiv/i,
    /ki[-\s]?prüfung/i,
    /ki[-\s]?check/i,
    /-{1,3}\s*anti[-\s]?spam[-\s]?prüfung/i,
    /anti[-\s]?spam[-\s]?prüfung/i,
    /anti[-\s]?spam[-\s]?check/i,
    /kontrollfrage/i,
    /bitte\s+trage\s+nur\s+den\s+code/i,
    /bitte\s+nur\s+(\d+)\s+in\s+diese\s+nachricht/i,
    /bitte\s+nur\s+(\d+)\s+einfügen/i,
    /trage\s+nur\s+den\s+code/i,
    /trage.*code.*\d+/i,
    /code\s+\d+\s+in\s+diese\s+nachricht/i,
    /code\s+\d+\s+ein/i,
    /code\s+\d{3,6}/i,
    /(\d{4,6})\s+in\s+diese\s+nachricht/i,
    /(\d{4,6})\s+einfügen/i,
    /anschließend\s+erscheint\s+eine\s+bestätigung/i,
    /danach\s+wird\s+eine\s+bestätigung/i,
    /der\s+chat\s+lädt\s+neu/i,
    /nachricht\s+korrekt\s+neu\s+eingeben/i,
    /chat\s+lädt\s+neu/i,
    /chat\s+startet\s+neu/i,
    /nachricht\s+neu\s+formulieren/i,
    /ki[-\s]?prüfung.*code.*\d+/i,
    /code.*\d+.*ki[-\s]?prüfung/i,
    /-{1,3}.*ki.*prüfung.*code/i,
    /anti[-\s]?spam.*code.*\d+/i,
    /code.*\d+.*anti[-\s]?spam/i,
    /kontrollfrage.*code.*\d+/i,
    /code.*\d+.*kontrollfrage/i
  ];
  
  for (const pattern of kiCheckPatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  
  const codeMatch = text.match(/code\s+(\d{3,6})/i);
  if (codeMatch) {
    const codeIndex = text.toLowerCase().indexOf(codeMatch[0].toLowerCase());
    const context = text.substring(Math.max(0, codeIndex - 150), Math.min(text.length, codeIndex + 250));
    const contextLower = context.toLowerCase();
    
    if (contextLower.includes("ki") || 
        contextLower.includes("prüfung") || 
        contextLower.includes("check") ||
        (contextLower.includes("anti") && contextLower.includes("spam")) ||
        contextLower.includes("kontrollfrage") ||
        contextLower.includes("bestätigung") ||
        contextLower.includes("trage") ||
        contextLower.includes("eingeben") ||
        contextLower.includes("einfügen") ||
        contextLower.includes("sende ab") ||
        contextLower.includes("senden")) {
      return true;
    }
  }
  
  if ((lower.includes("ki") && lower.includes("prüfung")) || 
      (lower.includes("ki") && lower.includes("check")) ||
      (lower.includes("anti") && lower.includes("spam")) ||
      lower.includes("kontrollfrage")) {
    if (lower.includes("code") && /\d{3,6}/.test(text)) {
      return true;
    }
    if (lower.includes("trage") && lower.includes("code")) {
      return true;
    }
    if (lower.includes("bitte nur") && /\d{4,6}/.test(text)) {
      return true;
    }
    if (lower.includes("einfügen") && /\d{4,6}/.test(text)) {
      return true;
    }
  }
  
  if (/bitte\s+nur\s+\d{4,6}\s+in\s+diese\s+nachricht\s+einfügen/i.test(text)) {
    return true;
  }
  
  return false;
}

/**
 * Safety Agent: Prüft alle Sicherheitsaspekte
 * @param {string} customerMessage - Kundennachricht
 * @returns {Object} - { isBlocked: boolean, reason: string, errorMessage: string }
 */
function runSafetyCheck(customerMessage) {
  // 1. KI-Check (höchste Priorität)
  if (checkKICheckMessage(customerMessage)) {
    return {
      isBlocked: true,
      reason: "ki_check",
      errorMessage: "🚨 BLOCKIERT: KI-Prüfung aktiv erkannt!\n\nFPC hat einen KI-Check-Code in die Kundennachricht eingebaut.\nBitte Code manuell eingeben und Nachricht absenden.\n\nEs wird KEINE automatische Antwort generiert."
    };
  }
  
  // 2. Minderjährige und illegale Themen
  const minorCheck = checkMinorMention(customerMessage);
  if (minorCheck.isBlocked) {
    return minorCheck;
  }
  
  return { isBlocked: false, reason: null, errorMessage: null };
}

module.exports = {
  checkMinorMention,
  checkKICheckMessage,
  runSafetyCheck
};

