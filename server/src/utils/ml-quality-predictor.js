/**
 * ML-QUALITY-PREDICTOR
 * 
 * Nutzt OpenAI API, um die Qualität von Nachrichten vorherzusagen.
 * Analysiert Feedback-Daten und lernt, welche Nachrichten gut/schlecht sind.
 */

const { getClient } = require('../openaiClient');

// Cache für ML-Vorhersagen (um API-Calls zu sparen)
const predictionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten Cache

/**
 * Vorhersage der Nachrichtenqualität mit ML (OpenAI)
 * @param {string} message - Die zu bewertende Nachricht
 * @param {object} context - Kontext (Situation, Training-Daten, etc.)
 * @returns {Promise<object>} - { score: 0-100, confidence: 0-1, reasoning: string }
 */
async function predictQualityWithML(message, context = {}) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return { score: 50, confidence: 0, reasoning: 'Keine Nachricht vorhanden' };
  }

  // Cache-Check
  const cacheKey = `${message.substring(0, 100)}_${JSON.stringify(context).substring(0, 50)}`;
  const cached = predictionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - ML-Vorhersage nicht möglich');
    return { score: 50, confidence: 0, reasoning: 'OpenAI Client nicht verfügbar' };
  }

  try {
    // Lade Feedback-Daten für Kontext
    let feedbackContext = '';
    try {
      const { getFeedbackData } = require('../routes/dashboard');
      const feedbackData = await getFeedbackData();
      
      if (feedbackData && feedbackData.feedbacks && feedbackData.feedbacks.length > 0) {
        // Filtere relevante Feedbacks (letzte 20 mit Status 'good' oder 'edited')
        const relevantFeedbacks = feedbackData.feedbacks
          .filter(f => f.status === 'good' || f.status === 'edited')
          .slice(-20)
          .map(f => ({
            message: f.aiResponse || '',
            status: f.status,
            situation: f.situation || 'allgemein',
            reasoning: f.reasoning || ''
          }))
          .filter(f => f.message.length > 0);
        
        if (relevantFeedbacks.length > 0) {
          feedbackContext = `\n\nBeispiele für gute Nachrichten (aus Feedback):\n${relevantFeedbacks.slice(0, 5).map((f, i) => 
            `${i + 1}. Situation: ${f.situation}, Status: ${f.status}\n   Nachricht: "${f.message.substring(0, 150)}..."\n   ${f.reasoning ? `Begründung: ${f.reasoning.substring(0, 100)}` : ''}`
          ).join('\n\n')}`;
        }
      }
    } catch (err) {
      console.warn('⚠️ Konnte Feedback-Daten nicht laden für ML-Kontext:', err.message);
    }

    // Erstelle Prompt für OpenAI
    const analysisPrompt = `Du bist ein Experte für die Bewertung von Chat-Nachrichten. Analysiere die folgende Nachricht und bewerte ihre Qualität auf einer Skala von 0-100.

KONTEXT:
- Situation: ${context.situation || 'allgemein'}
- Training-Daten genutzt: ${context.trainingExamplesCount || 0} Beispiele
- Learning-System genutzt: ${context.learningPatternsCount || 0} Muster
${feedbackContext}

KRITERIEN FÜR GUTE NACHRICHTEN:
1. Natürlich und authentisch (wie eine echte Person schreibt)
2. Geht auf die Kundennachricht ein
3. Keine Meta-Kommentare (z.B. "Ich finde es toll, dass...")
4. Keine verbotenen Wörter
5. Passende Länge (150-200 Zeichen ideal)
6. Genau 1 Frage (nicht mehr)
7. Keine Ausrufezeichen (oder maximal 1)
8. Orientiert sich an Training-Daten und bewährten Mustern
9. Passt zur Situation
10. Verwendet bevorzugte Wörter (wenn relevant)

ZU BEWERTENDE NACHRICHT:
"${message}"

Antworte NUR als JSON im Format:
{
  "score": 0-100,
  "confidence": 0.0-1.0,
  "reasoning": "Kurze Begründung (max 100 Zeichen)"
}

WICHTIG:
- score: 0-100 (0 = sehr schlecht, 100 = sehr gut)
- confidence: 0.0-1.0 (wie sicher du dir bist)
- reasoning: Kurze Begründung, warum diese Bewertung`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: 'gpt-4o-mini', // Günstiger als GPT-4, aber immer noch sehr gut
        messages: [
          {
            role: 'system',
            content: 'Du bist ein Experte für die Bewertung von Chat-Nachrichten. Antworte IMMER nur als JSON, keine zusätzlichen Erklärungen.'
          },
          {
            role: 'user',
            content: analysisPrompt
          }
        ],
        temperature: 0.3, // Niedrige Temperatur für konsistente Bewertungen
        max_tokens: 200
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ML-API Timeout')), 5000))
    ]);

    const resultText = response.choices?.[0]?.message?.content?.trim() || '';
    
    // Parse JSON (kann in Code-Blöcken sein)
    let result = null;
    try {
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Kein JSON gefunden');
      }
    } catch (err) {
      console.warn('⚠️ Konnte ML-Vorhersage nicht parsen:', resultText);
      // Fallback: Versuche Score aus Text zu extrahieren
      const scoreMatch = resultText.match(/score["\s:]+(\d+)/i);
      const confidenceMatch = resultText.match(/confidence["\s:]+([\d.]+)/i);
      result = {
        score: scoreMatch ? parseInt(scoreMatch[1]) : 50,
        confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
        reasoning: 'Automatisch extrahiert'
      };
    }

    // Validiere Ergebnis
    if (!result || typeof result.score !== 'number') {
      result = { score: 50, confidence: 0, reasoning: 'Ungültige Antwort von ML' };
    }

    // Begrenze Werte
    result.score = Math.max(0, Math.min(100, Math.round(result.score)));
    result.confidence = Math.max(0, Math.min(1, result.confidence || 0.5));
    result.reasoning = (result.reasoning || 'Keine Begründung').substring(0, 100);

    // Cache speichern
    predictionCache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });

    // Cache aufräumen (alte Einträge entfernen)
    if (predictionCache.size > 100) {
      const now = Date.now();
      for (const [key, value] of predictionCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
          predictionCache.delete(key);
        }
      }
    }

    console.log(`🤖 ML-Quality-Score: ${result.score}/100 (Confidence: ${(result.confidence * 100).toFixed(0)}%)`);
    
    return result;
  } catch (err) {
    console.warn('⚠️ Fehler bei ML-Quality-Vorhersage:', err.message);
    // Fallback: Neutrale Bewertung
    return { score: 50, confidence: 0, reasoning: `Fehler: ${err.message}` };
  }
}

/**
 * Kombiniere ML-Score mit altem Score
 * @param {number} oldScore - Alter Score (0-100)
 * @param {object} mlResult - ML-Ergebnis { score, confidence }
 * @param {number} mlWeight - Gewichtung für ML (0.0-1.0, Standard: 0.5)
 * @returns {number} - Kombinierter Score (0-100)
 */
function combineScores(oldScore, mlResult, mlWeight = 0.5) {
  if (!mlResult || mlResult.confidence < 0.5) {
    // Wenn ML unsicher ist, nutze hauptsächlich alten Score
    return oldScore;
  }

  // Kombiniere beide Scores basierend auf ML-Confidence
  const effectiveMLWeight = mlWeight * mlResult.confidence;
  const effectiveOldWeight = 1 - effectiveMLWeight;

  const combinedScore = (oldScore * effectiveOldWeight) + (mlResult.score * effectiveMLWeight);
  
  return Math.round(Math.max(0, Math.min(100, combinedScore)));
}

module.exports = {
  predictQualityWithML,
  combineScores
};

