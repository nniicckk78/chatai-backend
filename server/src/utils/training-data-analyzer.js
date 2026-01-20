/**
 * Training-Daten-Analyse-Modul
 * Analysiert Training-Daten und erstellt dynamische Validierungs-Regeln
 * 
 * Ziele:
 * 1. Lerne aus Training-Daten statt Hard-Coded Rules
 * 2. Kontext-bewusste Validierung
 * 3. Automatische Anpassung bei neuen Training-Daten
 */

/**
 * Analysiert alle Training-Daten und extrahiert Muster
 */
function analyzeTrainingData(trainingData) {
  if (!trainingData || !trainingData.conversations || !Array.isArray(trainingData.conversations)) {
    console.warn('⚠️ Training-Daten-Analyse: Keine gültigen Training-Daten gefunden');
    return getDefaultAnalysis();
  }

  const conversations = trainingData.conversations;
  console.log(`📊 Analysiere ${conversations.length} Training-Daten-Gespräche...`);

  const analysis = {
    questionCountStats: analyzeQuestionCounts(conversations),
    forbiddenWords: analyzeForbiddenWords(conversations),
    metaComments: analyzeMetaComments(conversations),
    sentenceStructure: analyzeSentenceStructure(conversations),
    contextPatterns: analyzeContextPatterns(conversations)
  };

  console.log(`✅ Training-Daten-Analyse abgeschlossen:`);
  console.log(`   - Frage-Statistiken: ${JSON.stringify(analysis.questionCountStats.summary)}`);
  console.log(`   - Verbotene Wörter-Kontexte: ${Object.keys(analysis.forbiddenWords.contextExceptions).length} Ausnahmen`);
  console.log(`   - Meta-Kommentar-Patterns: ${analysis.metaComments.patterns.length} erlaubte Patterns`);

  return analysis;
}

/**
 * Analysiert Frage-Anzahl in Training-Daten
 */
function analyzeQuestionCounts(conversations) {
  const questionCounts = [];
  const twoQuestionExamples = [];
  const threeQuestionExamples = [];
  
  // Kontexte, in denen 2+ Fragen vorkommen
  const contextsWithMultipleQuestions = {
    hobbiesAndPreferences: 0,
    sexualAndGeneral: 0,
    generalAndSpecific: 0,
    other: 0
  };

  for (const conv of conversations) {
    const moderatorResponse = conv.moderatorResponse || conv.assistant || '';
    if (!moderatorResponse || typeof moderatorResponse !== 'string') continue;

    const questionCount = (moderatorResponse.match(/\?/g) || []).length;
    questionCounts.push(questionCount);

    if (questionCount === 2) {
      twoQuestionExamples.push({
        response: moderatorResponse.substring(0, 200),
        customerMessage: (conv.customerMessage || conv.user || '').substring(0, 150),
        context: analyzeContextForQuestions(moderatorResponse, conv)
      });
      
      // Analysiere Kontext
      const context = analyzeContextForQuestions(moderatorResponse, conv);
      if (context.includes('hobbies') && context.includes('preferences')) {
        contextsWithMultipleQuestions.hobbiesAndPreferences++;
      } else if (context.includes('sexual') && context.includes('general')) {
        contextsWithMultipleQuestions.sexualAndGeneral++;
      } else if (context.includes('general') && context.includes('specific')) {
        contextsWithMultipleQuestions.generalAndSpecific++;
      } else {
        contextsWithMultipleQuestions.other++;
      }
    } else if (questionCount >= 3) {
      threeQuestionExamples.push({
        response: moderatorResponse.substring(0, 200),
        customerMessage: (conv.customerMessage || conv.user || '').substring(0, 150)
      });
    }
  }

  const avgQuestions = questionCounts.reduce((sum, count) => sum + count, 0) / questionCounts.length;
  const maxQuestions = Math.max(...questionCounts, 1);
  const commonCount = getMostCommon(questionCounts);
  
  // Berechne, wie oft 2 Fragen vorkommen
  const twoQuestionFrequency = questionCounts.filter(c => c === 2).length / questionCounts.length;

  return {
    avg: Math.round(avgQuestions * 10) / 10,
    max: maxQuestions,
    common: commonCount,
    twoQuestionFrequency: Math.round(twoQuestionFrequency * 100) / 100,
    contextsWithMultipleQuestions,
    twoQuestionExamples: twoQuestionExamples.slice(0, 10), // Nur erste 10 als Beispiele
    threeQuestionExamples: threeQuestionExamples.slice(0, 5),
    summary: {
      avg: Math.round(avgQuestions * 10) / 10,
      max: maxQuestions,
      common: commonCount,
      twoQuestionPercent: Math.round(twoQuestionFrequency * 100)
    }
  };
}

/**
 * Analysiert Kontext für Fragen in einer Antwort
 */
function analyzeContextForQuestions(response, conversation) {
  const context = [];
  const lowerResponse = response.toLowerCase();
  const customerMsg = (conversation.customerMessage || conversation.user || '').toLowerCase();
  
  // Hobbies
  if (lowerResponse.includes('hobby') || lowerResponse.includes('freizeit') || 
      lowerResponse.includes('sport') || customerMsg.includes('hobby')) {
    context.push('hobbies');
  }
  
  // Vorlieben/Präferenzen
  if (lowerResponse.includes('vorlieb') || lowerResponse.includes('präferenz') ||
      lowerResponse.includes('magst') || customerMsg.includes('vorlieb')) {
    context.push('preferences');
  }
  
  // Sexuell
  if (lowerResponse.includes('geil') || lowerResponse.includes('sex') ||
      lowerResponse.includes('ficken') || customerMsg.includes('geil')) {
    context.push('sexual');
  }
  
  // Allgemein
  if (lowerResponse.includes('wie geht') || lowerResponse.includes('was machst') ||
      customerMsg.includes('wie geht')) {
    context.push('general');
  }
  
  // Spezifisch
  if (lowerResponse.includes('was') && lowerResponse.includes('genau') ||
      lowerResponse.includes('welche')) {
    context.push('specific');
  }
  
  return context.join('_');
}

/**
 * Analysiert verbotene Wörter und deren Kontexte
 */
function analyzeForbiddenWords(conversations) {
  // Bekannte verbotene Wörter (werden später aus rules.json geladen)
  const commonForbiddenWords = ['reiz', 'spannend', 'interessant', 'reizvoll'];
  
  const contextExceptions = {};
  
  for (const word of commonForbiddenWords) {
    const examples = [];
    
    for (const conv of conversations) {
      const moderatorResponse = conv.moderatorResponse || conv.assistant || '';
      if (!moderatorResponse || typeof moderatorResponse !== 'string') continue;
      
      const lowerResponse = moderatorResponse.toLowerCase();
      
      // Suche nach dem Wort
      if (lowerResponse.includes(word)) {
        // Extrahiere Kontext (Satz um das Wort)
        const wordIndex = lowerResponse.indexOf(word);
        const contextStart = Math.max(0, wordIndex - 50);
        const contextEnd = Math.min(lowerResponse.length, wordIndex + word.length + 50);
        const context = lowerResponse.substring(contextStart, contextEnd);
        
        examples.push({
          fullText: moderatorResponse.substring(0, 200),
          context: context,
          word: word
        });
      }
    }
    
    // Analysiere, welche Kontexte erlaubt sind
    if (word === 'reiz') {
      // Prüfe, ob "reizt" (Verb) erlaubt ist
      const reiztExamples = examples.filter(ex => 
        ex.context.includes('reizt') && !ex.context.includes('reizvoll')
      );
      
      if (reiztExamples.length > 0) {
        contextExceptions[word] = {
          allowedInContext: ['reizt', 'reizt dich', 'was dich reizt', 'besonders reizt'],
          forbiddenForms: ['reizvoll'],
          examples: reiztExamples.slice(0, 5)
        };
      }
    }
  }
  
  return {
    contextExceptions,
    summary: Object.keys(contextExceptions).length
  };
}

/**
 * Analysiert Meta-Kommentare in Training-Daten
 */
function analyzeMetaComments(conversations) {
  // Meta-Kommentar-Patterns, die in Training-Daten vorkommen (aber vielleicht OK sind)
  const metaCommentPatterns = [
    /ich finde (es |das )?(sehr |wirklich )?(toll|gut|schön|geil)/i,
    /das (ist|klingt) (toll|gut|schön|geil)/i,
    /ich finde (es |das )?super/i,
    /das finde ich (toll|gut|schön|geil)/i
  ];
  
  const allowedPatterns = [];
  const forbiddenPatterns = [];
  
  for (const conv of conversations) {
    const moderatorResponse = conv.moderatorResponse || conv.assistant || '';
    if (!moderatorResponse || typeof moderatorResponse !== 'string') continue;
    
    for (const pattern of metaCommentPatterns) {
      if (pattern.test(moderatorResponse)) {
        // Prüfe, ob es wirklich ein Meta-Kommentar ist oder eine Reaktion auf Inhalt
        const match = moderatorResponse.match(pattern);
        if (match) {
          const matchText = match[0];
          const beforeMatch = moderatorResponse.substring(0, moderatorResponse.indexOf(matchText));
          const afterMatch = moderatorResponse.substring(moderatorResponse.indexOf(matchText) + matchText.length);
          
          // Wenn nach dem Match "dass", "wenn", "wie" kommt = Meta-Kommentar (verboten)
          // Wenn direkt auf Inhalt reagiert = erlaubt
          if (/^\s*(dass|wenn|wie|das)/i.test(afterMatch)) {
            // Meta-Kommentar - aber vielleicht OK in Training-Daten?
            // Speichere für Analyse
            if (!forbiddenPatterns.some(p => p.pattern.source === pattern.source)) {
              forbiddenPatterns.push({
                pattern: pattern,
                example: moderatorResponse.substring(0, 200),
                context: analyzeContextForMetaComment(moderatorResponse, conv)
              });
            }
          } else {
            // Reaktion auf Inhalt - erlaubt
            if (!allowedPatterns.some(p => p.pattern.source === pattern.source)) {
              allowedPatterns.push({
                pattern: pattern,
                example: moderatorResponse.substring(0, 200),
                context: analyzeContextForMetaComment(moderatorResponse, conv)
              });
            }
          }
        }
      }
    }
  }
  
  return {
    allowedPatterns: allowedPatterns.slice(0, 10),
    forbiddenPatterns: forbiddenPatterns.slice(0, 10),
    patterns: allowedPatterns.map(p => p.pattern)
  };
}

/**
 * Analysiert Kontext für Meta-Kommentare
 */
function analyzeContextForMetaComment(response, conversation) {
  const customerMsg = (conversation.customerMessage || conversation.user || '').toLowerCase();
  const context = [];
  
  if (customerMsg.includes('geil') || customerMsg.includes('sex') || customerMsg.includes('ficken')) {
    context.push('sexual');
  }
  if (customerMsg.includes('toll') || customerMsg.includes('super') || customerMsg.includes('gut')) {
    context.push('positive');
  }
  
  return context.join('_');
}

/**
 * Analysiert Satz-Struktur
 */
function analyzeSentenceStructure(conversations) {
  const startsWithIch = [];
  const startsWithOther = [];
  
  for (const conv of conversations) {
    const moderatorResponse = conv.moderatorResponse || conv.assistant || '';
    if (!moderatorResponse || typeof moderatorResponse !== 'string') continue;
    
    const trimmed = moderatorResponse.trim();
    if (/^ich\s+/i.test(trimmed)) {
      startsWithIch.push(trimmed.substring(0, 100));
    } else {
      startsWithOther.push(trimmed.substring(0, 100));
    }
  }
  
  const ichPercentage = (startsWithIch.length / conversations.length) * 100;
  
  return {
    startsWithIchPercentage: Math.round(ichPercentage * 10) / 10,
    startsWithIchExamples: startsWithIch.slice(0, 5),
    startsWithOtherExamples: startsWithOther.slice(0, 10)
  };
}

/**
 * Analysiert Kontext-Muster
 */
function analyzeContextPatterns(conversations) {
  // Z.B. Wann werden 2 Fragen verwendet? In welchen Situationen?
  return {
    // Wird später erweitert
  };
}

/**
 * Hilfsfunktion: Findet häufigsten Wert
 */
function getMostCommon(arr) {
  const counts = {};
  for (const val of arr) {
    counts[val] = (counts[val] || 0) + 1;
  }
  return parseInt(Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b));
}

/**
 * Standard-Analyse (Fallback)
 */
function getDefaultAnalysis() {
  return {
    questionCountStats: {
      avg: 1,
      max: 1,
      common: 1,
      twoQuestionFrequency: 0.1,
      contextsWithMultipleQuestions: {},
      summary: { avg: 1, max: 1, common: 1, twoQuestionPercent: 10 }
    },
    forbiddenWords: {
      contextExceptions: {},
      summary: 0
    },
    metaComments: {
      allowedPatterns: [],
      forbiddenPatterns: [],
      patterns: []
    },
    sentenceStructure: {
      startsWithIchPercentage: 5,
      startsWithIchExamples: [],
      startsWithOtherExamples: []
    },
    contextPatterns: {}
  };
}

/**
 * Ermittelt erlaubte Frage-Anzahl basierend auf Kontext
 */
function getAllowedQuestionCount(context, analysis) {
  const stats = analysis.questionCountStats;
  
  // Standard: 1 Frage (wie in meisten Training-Daten)
  let maxQuestions = 1;
  
  // Wenn 2 Fragen in Training-Daten häufig vorkommen (z.B. >15%), erlaube 2
  if (stats.twoQuestionFrequency > 0.15) {
    maxQuestions = 2;
  }
  
  // Kontext-spezifische Regeln
  if (context) {
    const ctx = context.toLowerCase();
    
    // Wenn Kontext zeigt: Hobbies + Vorlieben, erlaube 2 Fragen
    if ((ctx.includes('hobbies') || ctx.includes('hobby')) && 
        (ctx.includes('vorlieb') || ctx.includes('preference'))) {
      maxQuestions = 2;
    }
    
    // Wenn Kontext zeigt: Sexuell + Allgemein, erlaube 2 Fragen
    if (ctx.includes('sexual') && ctx.includes('general')) {
      maxQuestions = 2;
    }
  }
  
  return maxQuestions;
}

/**
 * Prüft, ob verbotenes Wort im erlaubten Kontext verwendet wurde
 */
function checkForbiddenWordInContext(word, text, analysis) {
  const wordLower = word.toLowerCase();
  const textLower = text.toLowerCase();
  
  if (!textLower.includes(wordLower)) {
    return { isForbidden: false, reason: 'Word not found' };
  }
  
  // Prüfe Kontext-Ausnahmen
  const exceptions = analysis.forbiddenWords.contextExceptions[wordLower];
  if (exceptions) {
    // Prüfe, ob Wort in erlaubtem Kontext verwendet wurde
    for (const allowedContext of exceptions.allowedInContext) {
      if (textLower.includes(allowedContext)) {
        return { isForbidden: false, reason: `Allowed in context: ${allowedContext}` };
      }
    }
    
    // Prüfe, ob verbotene Form verwendet wurde
    for (const forbiddenForm of exceptions.forbiddenForms) {
      if (textLower.includes(forbiddenForm)) {
        return { isForbidden: true, reason: `Forbidden form: ${forbiddenForm}` };
      }
    }
  }
  
  // Standard: Blockieren wenn Wort gefunden
  return { isForbidden: true, reason: 'Word found without allowed context' };
}

/**
 * Prüft, ob Fragen zu unterschiedlichen Themen gehören
 */
function questionsAreOnDifferentTopics(questions, conversationContext = '') {
  if (!questions || questions.length < 2) return false;
  
  const q1 = questions[0].toLowerCase().trim();
  const q2 = questions[1].toLowerCase().trim();
  
  // Themen-Kategorien
  const topicCategories = {
    hobbies: ['hobby', 'freizeit', 'sport', 'machst du gerne', 'was machst du'],
    preferences: ['vorlieb', 'magst', 'präferenz', 'was magst', 'was gefällt'],
    sexual: ['geil', 'sex', 'ficken', 'was würdest', 'wie würdest', 'anfangen'],
    general: ['wie geht', 'was machst', 'woher', 'wo wohnst'],
    specific: ['was genau', 'welche', 'welcher', 'wie genau']
  };
  
  // Finde Kategorien für jede Frage
  const q1Categories = [];
  const q2Categories = [];
  
  for (const [category, keywords] of Object.entries(topicCategories)) {
    if (keywords.some(kw => q1.includes(kw))) {
      q1Categories.push(category);
    }
    if (keywords.some(kw => q2.includes(kw))) {
      q2Categories.push(category);
    }
  }
  
  // Wenn Fragen zu unterschiedlichen Kategorien gehören, sind sie unterschiedlich
  const hasDifferentCategories = q1Categories.some(cat => !q2Categories.includes(cat)) ||
                                  q2Categories.some(cat => !q1Categories.includes(cat));
  
  // Zusätzlich: Prüfe auf ähnliche Fragewörter (redundant)
  const similarQuestionWords = ['was machst', 'was tust', 'wie geht', 'was machst du', 'was tust du'];
  const q1HasSimilar = similarQuestionWords.some(w => q1.includes(w));
  const q2HasSimilar = similarQuestionWords.some(w => q2.includes(w));
  
  // Wenn beide ähnliche Fragewörter haben = redundant
  if (q1HasSimilar && q2HasSimilar) {
    return false; // Redundant, nicht unterschiedlich
  }
  
  return hasDifferentCategories;
}

/**
 * Analysiert Kontext für Validierung
 */
function analyzeContextForValidation(customerMessage, conversationHistory = '', profileInfo = {}) {
  const context = {
    topics: [],
    isSexual: false,
    hasHobbies: false,
    hasPreferences: false,
    isLocationQuestion: false,
    isGeneralQuestion: false
  };
  
  const lowerMessage = customerMessage.toLowerCase();
  const lowerHistory = conversationHistory.toLowerCase();
  const combinedText = (lowerMessage + ' ' + lowerHistory).toLowerCase();
  
  // Sexueller Kontext
  if (combinedText.includes('geil') || combinedText.includes('sex') || 
      combinedText.includes('ficken') || combinedText.includes('muschi')) {
    context.isSexual = true;
    context.topics.push('sexual');
  }
  
  // Hobbies
  if (combinedText.includes('hobby') || combinedText.includes('freizeit') || 
      combinedText.includes('sport') || profileInfo.hobbies) {
    context.hasHobbies = true;
    context.topics.push('hobbies');
  }
  
  // Vorlieben
  if (combinedText.includes('vorlieb') || combinedText.includes('präferenz') ||
      combinedText.includes('magst') || profileInfo.sexualPreferences) {
    context.hasPreferences = true;
    context.topics.push('preferences');
  }
  
  // Wohnort-Frage
  if (/^(woher|wo kommst|wo wohnst)/i.test(customerMessage.trim())) {
    context.isLocationQuestion = true;
    context.topics.push('location');
  }
  
  // Allgemeine Frage
  if (combinedText.includes('wie geht') || combinedText.includes('was machst')) {
    context.isGeneralQuestion = true;
    context.topics.push('general');
  }
  
  return context;
}

module.exports = {
  analyzeTrainingData,
  getAllowedQuestionCount,
  checkForbiddenWordInContext,
  questionsAreOnDifferentTopics,
  analyzeContextForValidation,
  getDefaultAnalysis
};
