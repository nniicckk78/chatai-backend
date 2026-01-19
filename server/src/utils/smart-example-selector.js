/**
 * SMART EXAMPLE SELECTOR
 * 
 * Wählt intelligently die besten Beispiele aus Training-Daten und Feedbacks
 * basierend auf:
 * - Semantischer Ähnlichkeit (Embeddings)
 * - Feedback-Score (examplePerformance)
 * - Kontext (Chat-Verlauf, Situationen)
 * - Regeln (verbotene Wörter, etc.)
 */

const { findSimilarExamples } = require('./vector-db');
const { getLearningStats } = require('./learning-system');
const { checkModeration } = require('./fine-tuning');

// Berechne Feedback-Score für ein Beispiel
async function calculateFeedbackScore(example, situation = 'allgemein') {
  const stats = await getLearningStats();
  if (!stats || !stats.examplePerformance) {
    return 0.5; // Neutraler Score wenn keine Daten
  }

  // Finde Beispiel-ID (kann customerMessage + moderatorResponse sein)
  const exampleId = `${example.customerMessage || ''}|${example.moderatorResponse || ''}`;
  const examplePerf = stats.examplePerformance[exampleId];
  
  if (!examplePerf || !examplePerf[situation]) {
    return 0.5; // Neutraler Score
  }

  const perf = examplePerf[situation];
  const total = (perf.good || 0) + (perf.bad || 0);
  
  if (total === 0) {
    return 0.5; // Neutraler Score
  }

  // Success-Rate: 0.0 (schlecht) bis 1.0 (gut)
  const successRate = perf.successRate || (perf.good / total);
  
  // Gewichte mit Anzahl: Mehr Feedback = zuverlässiger
  const confidence = Math.min(total / 10, 1.0); // Max. Confidence bei 10+ Feedbacks
  
  return successRate * confidence + 0.5 * (1 - confidence); // Gewichteter Score
}

// Wähle intelligente Beispiele aus
async function selectSmartExamples(customerMessage, options = {}) {
  const {
    topK = 5, // Anzahl der Beispiele
    situation = null, // Spezifische Situation
    conversationHistory = '', // Chat-Verlauf für Kontext
    includeSexual = true, // Sexuelle Beispiele einschließen?
    minSimilarity = 0.3 // Minimale Ähnlichkeit
  } = options;

  console.log(`🔍 Suche intelligente Beispiele für: "${customerMessage.substring(0, 50)}..."`);

  // 1. Erstelle Query-Text (Kunden-Nachricht + Kontext)
  let queryText = customerMessage;
  if (conversationHistory && conversationHistory.length > 0) {
    // Nutze letzten Teil des Chat-Verlaufs als Kontext
    const contextSnippet = conversationHistory.substring(Math.max(0, conversationHistory.length - 200));
    queryText = `${contextSnippet} ${customerMessage}`;
  }

  // 2. Suche ähnliche Beispiele (semantisch)
  const similarExamples = await findSimilarExamples(queryText, {
    topK: topK * 3, // Nimm mehr, dann filtern wir
    minSimilarity,
    situation,
    includeSexual
  });

  if (similarExamples.length === 0) {
    console.log('⚠️ Keine ähnlichen Beispiele gefunden');
    return [];
  }

  console.log(`✅ ${similarExamples.length} ähnliche Beispiele gefunden`);

  // 3. Berechne kombinierte Scores (Ähnlichkeit + Feedback)
  const scoredExamples = await Promise.all(
    similarExamples.map(async (example) => {
      const feedbackScore = await calculateFeedbackScore(example, situation || 'allgemein');
      const similarityScore = example.similarity || 0;
      
      // Kombinierter Score: 60% Ähnlichkeit, 40% Feedback
      const combinedScore = (similarityScore * 0.6) + (feedbackScore * 0.4);
      
      return {
        ...example,
        feedbackScore,
        combinedScore
      };
    })
  );

  // 4. Sortiere nach kombiniertem Score
  scoredExamples.sort((a, b) => b.combinedScore - a.combinedScore);

  // 5. Nimm Top K Beispiele
  const selected = scoredExamples.slice(0, topK);

  console.log(`✅ ${selected.length} intelligente Beispiele ausgewählt`);
  selected.forEach((ex, idx) => {
    console.log(`  ${idx + 1}. Ähnlichkeit: ${(ex.similarity * 100).toFixed(1)}%, Feedback: ${(ex.feedbackScore * 100).toFixed(1)}%, Combined: ${(ex.combinedScore * 100).toFixed(1)}%`);
  });

  return selected;
}

// Formatiere Beispiele für System-Prompt
function formatExamplesForPrompt(examples) {
  if (!examples || examples.length === 0) {
    return '';
  }

  let prompt = '\n\n📚 RELEVANTE BEISPIELE (nutze diese als Inspiration, aber variiere!):\n\n';
  
  examples.forEach((example, idx) => {
    const situation = example.situation ? `[${example.situation}] ` : '';
    prompt += `${idx + 1}. ${situation}Kunde: "${example.customerMessage}"\n`;
    prompt += `   → Antwort: "${example.moderatorResponse}"\n\n`;
  });

  return prompt;
}

module.exports = {
  selectSmartExamples,
  calculateFeedbackScore,
  formatExamplesForPrompt
};
