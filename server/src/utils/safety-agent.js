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
    // Sicherheitsprüfung (FPC/Plattform): "Sicherheitsprüfung: Antworte in dieser Nachricht ausschließlich mit 219721..."
    /\bsicherheitsprüfung\s*:/i,
    /\bsicherheitsprüfung\b/i,
    /antworte\s+in\s+dieser\s+nachricht\s+ausschlie[sß]lich\s+mit\s+\d+/i,
    /ausschlie[sß]lich\s+mit\s+\d{4,8}\s*\./i,
    /in\s+dieser\s+nachricht\s+ausschlie[sß]lich\s+mit/i,
    /nach\s+der\s+eingabe\s+bekommst\s+du\s+eine\s+meldung/i,
    /nach\s+erfolg\s+erscheint\s+(eine\s+)?meldung/i, // FPC: "Nach Erfolg erscheint eine Meldung"
    /schreibe\s+einzig\s+\d{4,8}\s+in\s+die\s+(aktuelle|nächste)\s+nachricht/i, // FPC: "Bitte schreibe einzig 793106 in die aktuelle Nachricht"
    /bitte\s+schreibe\s+einzig\s+\d{4,8}\s+in\s+die\s+aktuelle\s+nachricht/i,
    /in\s+die\s+aktuelle\s+nachricht\s+.*\d{4,8}/i,
    /\d{4,8}\s+in\s+die\s+aktuelle\s+nachricht/i,
    /chat\s+wird\s+neu\s+geladen\s+und\s+du\s+kannst\s+danach\s+deine\s+nachricht\s+neu\s+schreiben/i,
    /chat\s+neu\s+und\s+du\s+kannst\s+erneut\s+schreiben/i, // FPC: "der Chat neu und du kannst erneut schreiben"
    /-{1,3}\s*ki[-\s]?prüfung\s+aktiv/i,
    /ki[-\s]?prüfung\s+aktiv/i,
    /ki[-\s]?check\s+aktiv/i,
    /ki[-\s]?prüfung/i,
    /ki[-\s]?check/i,
    /-{1,3}\s*anti[-\s]?spam[-\s]?prüfung/i,
    /anti[-\s]?spam[-\s]?prüfung/i,
    /anti[-\s]?spam[-\s]?check/i,
    /kontrollfrage/i,
    /verifizierung\s+notwendig/i, // 🚨 NEU: "Verifizierung notwendig"
    /verifizierung\s+erforderlich/i, // 🚨 NEU: "Verifizierung erforderlich"
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
    /nach\s+erfolgreicher\s+prüfung/i, // 🚨 NEU: "Nach erfolgreicher Prüfung"
    /nach\s+erfolgreicher\s+verifizierung/i, // 🚨 NEU: "Nach erfolgreicher Verifizierung"
    /der\s+chat\s+lädt\s+neu/i,
    /chat\s+wird\s+neu\s+geladen/i, // 🚨 NEU: "Chat wird neu geladen"
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
    /code.*\d+.*kontrollfrage/i,
    /verifizierung.*code.*\d+/i, // 🚨 NEU: "Verifizierung ... Code ..."
    /code.*\d+.*verifizierung/i // 🚨 NEU: "Code ... Verifizierung"
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
        contextLower.includes("verifizierung") || // 🚨 NEU: "Verifizierung"
        contextLower.includes("bestätigung") ||
        contextLower.includes("trage") ||
        contextLower.includes("eingeben") ||
        contextLower.includes("einfügen") ||
        contextLower.includes("sende ab") ||
        contextLower.includes("senden") ||
        contextLower.includes("chat") && contextLower.includes("neu")) { // 🚨 NEU: "Chat ... neu"
      return true;
    }
  }
  
  if ((lower.includes("ki") && lower.includes("prüfung")) || 
      (lower.includes("ki") && lower.includes("check")) ||
      (lower.includes("anti") && lower.includes("spam")) ||
      lower.includes("kontrollfrage") ||
      lower.includes("verifizierung")) { // 🚨 NEU: "Verifizierung" als Trigger
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
  
  // 🚨 NEU: Direkte Erkennung von "Verifizierung notwendig" + Code
  if (lower.includes("verifizierung") && (lower.includes("notwendig") || lower.includes("erforderlich"))) {
    if (/\d{3,6}/.test(text) && (lower.includes("code") || lower.includes("trage") || lower.includes("einfügen"))) {
      return true;
    }
  }
  
  if (/bitte\s+nur\s+\d{4,6}\s+in\s+diese\s+nachricht\s+einfügen/i.test(text)) {
    return true;
  }

  // FPC-Variante: "aktuelle Nachricht" + Zifferncode irgendwo in der Nachricht
  if (/aktuelle\s+nachricht/i.test(lower) && /\d{4,8}/.test(text)) {
    return true;
  }

  return false;
}

/**
 * Erkennt typische System-/Plattform-Nachrichten (Like, Kuss, Bild übertragen), die keine echte Kundennachricht sind.
 * Diese sollen NICHT als "nicht auf Deutsch" blockiert werden (FPC/Plattformen senden teils auf Englisch).
 */
function isLikelySystemMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.trim().toLowerCase();
  if (lower.length < 3) return false;
  // Deutsch: Kuss/Like/System
  if (/\b(ich habe dir einen (kuss|like) geschickt|hat dich (geküsst|geliked)|der (benutzer|nutzer) hat dich (geküsst|geliked)|ein bild wurde übertragen|bild wurde übertragen)\b/i.test(lower)) return true;
  if (/schreib(e|t)?\s+(ihm|ihr)\s+eine\s+nachricht/i.test(lower)) return true;
  // Englisch: typische FPC/Plattform-Systemmeldungen (erste Nachricht nach Login ist oft sowas)
  if (/\b(user|member|someone)\s+(has\s+)?sent\s+(you\s+)?a\s+(like|kiss)\b/i.test(lower)) return true;
  if (/\b(you\s+have\s+received|received\s+a)\s+(like|kiss)\b/i.test(lower)) return true;
  if (/\b(image|picture|photo)\s+(was\s+)?(sent|uploaded|transferred)\b/i.test(lower)) return true;
  if (/^(\s*like\s*|\s*kiss\s*)$/i.test(lower)) return true;
  return false;
}

/**
 * Prüft ob die Kundennachricht überwiegend nicht auf Deutsch ist (z. B. Polnisch, Tschechisch, Kyrillisch).
 * Bei Erkennung: Blockierung, damit ein Mensch eingreifen kann.
 * Systemnachrichten (Like/Kuss/Bild) werden NICHT blockiert – auch wenn auf Englisch (FPC erste Nachricht).
 * @param {string} text - Kundennachricht
 * @returns {Object} - { isBlocked: boolean, reason: string, errorMessage: string }
 */
function checkForeignLanguage(text) {
  if (!text || typeof text !== 'string') return { isBlocked: false, reason: null, errorMessage: null };
  const trimmed = text.trim();
  if (trimmed.length < 3) return { isBlocked: false, reason: null, errorMessage: null };

  // Systemnachrichten (Like/Kuss/Bild, DE oder EN) nie als "nicht Deutsch" blockieren – löst "erste Nachricht"-Problem in FPC
  if (isLikelySystemMessage(trimmed)) {
    return { isBlocked: false, reason: null, errorMessage: null };
  }

  // Nie nur wegen eines einzelnen Wortes blockieren – mindestens 2 Wörter nötig
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2) return { isBlocked: false, reason: null, errorMessage: null };

  // 1. Andere Schriften: Polnisch/Tschechisch/Slawisch (ąęćłńóśźż...) oder Kyrillisch
  // á, í, é, ú NICHT drin – kommen in Deutsch vor (André, Café, Café, etc.)
  const nonGermanScript = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻěščřžýůďťňĚŠČŘŽÝŮĎŤŇ]/;
  const cyrillic = /[\u0400-\u04FF]/;
  const germanCommonForCheck = new Set([
    'der', 'die', 'das', 'und', 'ist', 'ich', 'du', 'wir', 'sie', 'ein', 'eine', 'einen', 'einer', 'einem',
    'nicht', 'auch', 'haben', 'sind', 'was', 'wie', 'für', 'auf', 'mit', 'dass', 'kann', 'wird', 'habe', 'bin', 'bist',
    'geht', 'mal', 'schon', 'noch', 'dann', 'weil', 'aber', 'oder', 'wenn', 'nach', 'von', 'bei', 'zum', 'zur',
    'dem', 'den', 'des', 'mir', 'dir', 'ihm', 'ihr', 'uns', 'euch', 'ihnen', 'mich', 'dich', 'es', 'ja', 'nein',
    'nur', 'mehr', 'sehr', 'so', 'zu', 'hallo', 'ok', 'okay', 'alles', 'gut', 'schön', 'gerne', 'bitte', 'danke'
  ]);
  if (nonGermanScript.test(trimmed) || cyrillic.test(trimmed)) {
    const wordsWithForeignScript = words.filter(w => nonGermanScript.test(w) || cyrillic.test(w));
    const lowerWords = words.map(w => w.toLowerCase().replace(/[^\wäöüß]/g, ''));
    const likelyGermanCount = lowerWords.filter(w => w.length > 0 && (germanCommonForCheck.has(w) || /[äöüß]/.test(w))).length;
    const isPredominantlyGerman = likelyGermanCount >= 2 && likelyGermanCount >= words.length * 0.35;
    if (wordsWithForeignScript.length >= 1 && !isPredominantlyGerman) {
      return {
        isBlocked: true,
        reason: "foreign_language",
        errorMessage: "🚨 BLOCKIERT: Kundennachricht ist nicht auf Deutsch!\n\nEin Mensch muss eingreifen und auf Deutsch antworten.\nEs wird KEINE automatische Antwort generiert."
      };
    }
  }

  // 2. Sehr häufige deutsche Wörter – nur bei ausreichend langer Nachricht (mind. 6 Wörter), um kurze System-/UI-Texte (z. B. 4 Wörter Englisch) nicht zu blockieren
  const germanCommon = new Set([
    'der', 'die', 'das', 'und', 'ist', 'ich', 'du', 'wir', 'sie', 'ein', 'eine', 'einen', 'einer', 'einem',
    'nicht', 'auch', 'haben', 'sind', 'was', 'wie', 'für', 'auf', 'mit', 'dass', 'kann', 'wird', 'habe', 'bin', 'bist',
    'geht', 'mal', 'schon', 'noch', 'dann', 'weil', 'aber', 'oder', 'wenn', 'nach', 'von', 'bei', 'zum', 'zur',
    'dem', 'den', 'des', 'mir', 'dir', 'ihm', 'ihr', 'uns', 'euch', 'ihnen', 'mich', 'dich', 'es', 'ja', 'nein',
    'nur', 'mehr', 'sehr', 'so', 'zu', 'hier', 'dort', 'heute', 'morgen', 'gestern', 'gut', 'schön', 'gerne',
    'bitte', 'danke', 'hallo', 'tschüss', 'ok', 'okay', 'ja', 'nein', 'alles', 'immer', 'wieder', 'schön',
    'mich', 'dich', 'sich', 'mein', 'dein', 'sein', 'ihr', 'unser', 'euer', 'wer', 'welche', 'welcher', 'welches',
    'diese', 'dieser', 'dieses', 'jede', 'jeder', 'jedes', 'man', 'etwas', 'nichts', 'alle', 'viele', 'wenige',
    'über', 'unter', 'geil', 'details', 'wochenende', 'wochende', 'ausgeblendet', 'sag', 'sagen', 'mach', 'machen',
    'komm', 'kommen', 'will', 'wollen', 'können', 'müssen', 'soll', 'sollen', 'möchte', 'möchten', 'würde', 'würden'
  ]);
  if (words.length >= 6) {
    const lowerWords = words.map(w => w.toLowerCase().replace(/[^\wäöüß]/g, '')).filter(w => w.length > 1);
    if (lowerWords.length === 0) return { isBlocked: false, reason: null, errorMessage: null };
    const germanCount = lowerWords.filter(w => germanCommon.has(w) || /[äöüß]/.test(w)).length;
    const ratio = germanCount / lowerWords.length;
    const hasGermanUmlauts = /[äöüß]/.test(trimmed);
    if (ratio < 0.25 && !hasGermanUmlauts) {
      return {
        isBlocked: true,
        reason: "foreign_language",
        errorMessage: "🚨 BLOCKIERT: Kundennachricht ist nicht auf Deutsch!\n\nEin Mensch muss eingreifen und auf Deutsch antworten.\nEs wird KEINE automatische Antwort generiert."
      };
    }
  }

  return { isBlocked: false, reason: null, errorMessage: null };
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

  // 2. Fremdsprache (Kunde schreibt nicht auf Deutsch – Mensch muss eingreifen)
  const foreignCheck = checkForeignLanguage(customerMessage);
  if (foreignCheck.isBlocked) {
    return foreignCheck;
  }
  
  // 3. Minderjährige und illegale Themen
  const minorCheck = checkMinorMention(customerMessage);
  if (minorCheck.isBlocked) {
    return minorCheck;
  }
  
  return { isBlocked: false, reason: null, errorMessage: null };
}

module.exports = {
  checkMinorMention,
  checkKICheckMessage,
  checkForeignLanguage,
  runSafetyCheck
};


