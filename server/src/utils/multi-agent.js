const { getClient } = require('../openaiClient');

// 🚨 MULTI-AGENT SYSTEM: Jeder Agent ist isoliert mit Fallbacks
// Model: GPT-4o-mini (kostengünstig, gut genug für fokussierte Aufgaben)

const AGENT_MODEL = process.env.AI_MODEL === 'gpt-4o-mini' ? 'gpt-4o-mini' : 'gpt-4o-mini'; // Immer 4o-mini für Agenten

/**
 * Agent 1: Kontext-Analyst
 * Analysiert Chat-Verlauf und erkennt Thema/Kontext
 */
async function agentContextAnalyst(conversationHistory, customerMessage) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Kontext-Analyst - Fallback');
    return {
      topic: 'allgemein',
      summary: 'Keine Analyse möglich',
      keyPoints: [],
      contextFlow: 'neutral',
      success: false
    };
  }

  try {
    const analysisPrompt = `Analysiere diesen Chat-Verlauf und die Kundennachricht. Antworte NUR als JSON:

{
  "topic": "thema (z.B. 'philosophisch', 'sexuell', 'allgemein', 'beruf', 'hobby')",
  "summary": "Kurze Zusammenfassung des Gesprächsthemas (max 50 Wörter)",
  "keyPoints": ["wichtiger Punkt 1", "wichtiger Punkt 2"],
  "contextFlow": "neutral | positiv | negativ | philosophisch | sexuell"
}

Chat-Verlauf (letzte Nachrichten):
${conversationHistory.substring(0, 2000)}

Kundennachricht: "${customerMessage.substring(0, 500)}"

WICHTIG:
- Erkenne das HAUPTTHEMA (nicht Details)
- "philosophisch": Diskussionen über Leben, Sinn, Gefühle, abstrakte Themen
- "sexuell": Sexuelle Themen, Vorlieben, Fantasien
- "beruf": Arbeit, Beruf, Karriere
- "hobby": Hobbies, Interessen, Freizeit
- "allgemein": Standard-Konversation
- "contextFlow": Wie verläuft das Gespräch? Neutral, positiv, negativ, etc.

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du bist ein Kontext-Analyst für Chat-Nachrichten. Antworte IMMER nur als JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 300
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log(`✅ Agent: Kontext-Analyst - Topic: ${parsed.topic}, Flow: ${parsed.contextFlow}`);
          return { ...parsed, success: true };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Kontext-Analyst - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Kontext-Analyst - Fehler:', err.message);
  }

  // Fallback
  return {
    topic: 'allgemein',
    summary: 'Kontext-Analyse fehlgeschlagen - verwende Standard',
    keyPoints: [],
    contextFlow: 'neutral',
    success: false
  };
}

/**
 * Agent 2: Profil-Filter
 * Filtert Profil-Infos basierend auf Kontext-Relevanz
 */
async function agentProfileFilter(profileInfo, contextAnalysis) {
  const client = getClient();
  if (!client || !profileInfo || Object.keys(profileInfo).length === 0) {
    return {
      relevantInfo: [],
      irrelevantInfo: [],
      reason: 'Keine Profil-Infos vorhanden',
      success: true
    };
  }

  try {
    const profileStr = JSON.stringify(profileInfo, null, 2);
    const contextStr = JSON.stringify(contextAnalysis, null, 2);

    const analysisPrompt = `Analysiere diese Profil-Infos und bestimme, welche RELEVANT für den aktuellen Kontext sind.

Profil-Infos:
${profileStr.substring(0, 1500)}

Kontext-Analyse:
${contextStr.substring(0, 500)}

Antworte NUR als JSON:
{
  "relevantInfo": ["relevante Info 1", "relevante Info 2"],
  "irrelevantInfo": ["irrelevante Info 1"],
  "reason": "Kurze Begründung warum relevant/irrelevant"
}

WICHTIG:
- CHAT-VERLAUF hat HÖCHSTE PRIORITÄT!
- Profil-Infos (Hobbies, Interessen) NUR wenn sie zum aktuellen Thema passen!
- BEISPIEL FALSCH: Thema "Licht/Schatten" (philosophisch) → Hobby "kochen" → IRRELEVANT
- BEISPIEL RICHTIG: Thema "Essen" → Hobby "kochen" → RELEVANT
- Wenn Kontext abstrakt/philosophisch → Meistens KEINE Profil-Infos relevant
- Wenn Kontext konkret (Essen, Arbeit, Hobby) → Profil-Infos können relevant sein

Antworte NUR als JSON.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du filterst Profil-Infos nach Relevanz. Antworte IMMER nur als JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 400
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log(`✅ Agent: Profil-Filter - ${parsed.relevantInfo?.length || 0} relevant, ${parsed.irrelevantInfo?.length || 0} irrelevant`);
          return { ...parsed, success: true };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Profil-Filter - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Profil-Filter - Fehler:', err.message);
  }

  // Fallback: Alle Infos als relevant (sicherer als nichts)
  return {
    relevantInfo: Object.values(profileInfo).filter(v => v && typeof v === 'string'),
    irrelevantInfo: [],
    reason: 'Fehler bei Filterung - alle Infos als relevant behandelt',
    success: false
  };
}

/**
 * Agent 3: Training-Data-Selector
 * Findet relevante Training-Daten basierend auf Kontext
 * HINWEIS: Nutzt auch Vector-DB für bessere Ergebnisse
 */
async function agentTrainingSelector(contextAnalysis, customerMessage, situations, vectorDbFunc) {
  // Dieser Agent ist komplexer - wir nutzen die bestehende Vector-DB Logik
  // und erweitern sie mit LLM-basierter Selektion
  
  try {
    // Build query from context
    const topic = contextAnalysis.topic || 'allgemein';
    const keyPoints = contextAnalysis.keyPoints || [];
    const queryText = `${topic}: ${keyPoints.join(', ')}: ${customerMessage.substring(0, 200)}`;

    // Use existing vector search if available
    if (vectorDbFunc && typeof vectorDbFunc === 'function') {
      try {
        const vectorResults = await vectorDbFunc(queryText, {
          situations: situations || [],
          minSimilarity: 0.3,
          limit: 20
        });

        if (vectorResults && vectorResults.length > 0) {
          console.log(`✅ Agent: Training-Selector - ${vectorResults.length} Beispiele via Vector-DB`);
          return {
            selectedExamples: vectorResults.slice(0, 10), // Top 10
            reason: `Vector-DB: ${vectorResults.length} ähnliche Beispiele gefunden`,
            method: 'vector-db',
            success: true
          };
        }
      } catch (err) {
        console.warn('⚠️ Agent: Training-Selector - Vector-DB Fehler:', err.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Training-Selector - Fehler:', err.message);
  }

  // Fallback: Leere Liste (wird später mit Keyword-Matching gefüllt)
  return {
    selectedExamples: [],
    reason: 'Keine Beispiele gefunden - verwende Keyword-Matching als Fallback',
    method: 'fallback',
    success: false
  };
}

/**
 * Agent 4: Rules-Applicator
 * Filtert und wendet Regeln basierend auf Kontext an
 */
async function agentRulesApplicator(allRules, contextAnalysis, situations) {
  // Dieser Agent filtert Regeln - kann synchron sein (schneller)
  // Aber wir machen es async für Konsistenz

  try {
    // Für jetzt: Alle Regeln anwenden (sicherer)
    // Später können wir hier intelligent filtern
    return {
      applicableForbiddenWords: allRules?.forbiddenWords || [],
      applicablePreferredWords: allRules?.preferredWords || [],
      applicableCriticalRules: allRules?.criticalRules || [],
      specificInstructions: '', // Wird später aus situations gebaut
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Rules-Applicator - Fehler:', err.message);
    return {
      applicableForbiddenWords: allRules?.forbiddenWords || [],
      applicablePreferredWords: allRules?.preferredWords || [],
      applicableCriticalRules: allRules?.criticalRules || [],
      specificInstructions: '',
      success: false
    };
  }
}

/**
 * Agent 5: Image-Analyst (bereits vorhanden, wird hier integriert)
 * Analysiert Bilder - nutzt bestehende analyzeProfilePicture/analyzeImage Funktionen
 */
async function agentImageAnalyst(imageUrl, contextAnalysis, existingImageAnalysisFunc) {
  // Nutzt bestehende Image-Analyse-Funktionen
  if (!imageUrl || !existingImageAnalysisFunc) {
    return {
      imageType: null,
      reactionNeeded: null,
      success: true
    };
  }

  try {
    // Rufe bestehende Funktion auf (wird später von reply.js übergeben)
    const result = await existingImageAnalysisFunc(imageUrl, contextAnalysis);
    return {
      imageType: result?.imageType || null,
      reactionNeeded: result?.reactionNeeded || null,
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Image-Analyst - Fehler:', err.message);
    return {
      imageType: null,
      reactionNeeded: null,
      success: false
    };
  }
}

/**
 * Agent 6: Style-Analyst
 * Analysiert Schreibstil aus letzten Moderator-Nachrichten
 */
async function agentStyleAnalyst(moderatorMessages, contextAnalysis) {
  const client = getClient();
  if (!client || !moderatorMessages || moderatorMessages.length === 0) {
    return {
      style: 'neutral',
      tone: 'neutral',
      wordChoice: [],
      avgLength: 150,
      hasEmojis: false,
      success: false
    };
  }

  try {
    const messagesText = moderatorMessages.slice(-5).map(m => m.text).join('\n---\n');
    
    const analysisPrompt = `Analysiere den Schreibstil dieser Moderator-Nachrichten.

Nachrichten:
${messagesText.substring(0, 1500)}

Antworte NUR als JSON:
{
  "style": "locker | formell | flirty | philosophisch | direkt",
  "tone": "neutral | positiv | negativ | emotional",
  "wordChoice": ["häufiges Wort 1", "häufiges Wort 2"],
  "avgLength": 150,
  "hasEmojis": true/false
}

Antworte NUR als JSON.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du analysierst Schreibstil. Antworte IMMER nur als JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 300
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log(`✅ Agent: Style-Analyst - Style: ${parsed.style}, Tone: ${parsed.tone}`);
          return { ...parsed, success: true };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Style-Analyst - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Style-Analyst - Fehler:', err.message);
  }

  // Fallback: Einfache Analyse
  const texts = moderatorMessages.map(m => m.text);
  const avgLength = texts.reduce((sum, t) => sum + t.length, 0) / texts.length;
  const hasEmojis = texts.some(t => /[\u{1F300}-\u{1F9FF}]/u.test(t));

  return {
    style: 'neutral',
    tone: 'neutral',
    wordChoice: [],
    avgLength: Math.round(avgLength),
    hasEmojis,
    success: false
  };
}

/**
 * Orchestrator: Führt alle Agenten aus (parallel wo möglich)
 */
async function runMultiAgentPipeline({
  conversationHistory,
  customerMessage,
  profileInfo,
  allRules,
  situations,
  imageUrl,
  moderatorMessages,
  vectorDbFunc,
  imageAnalysisFunc
}) {
  console.log('🤖 Multi-Agent Pipeline gestartet...');

  // Schritt 1: Kontext-Analyse (sequenziell - benötigt von anderen)
  const contextResult = await agentContextAnalyst(conversationHistory, customerMessage);

  // Schritt 2: Parallel (keine Abhängigkeiten)
  const [profileResult, rulesResult] = await Promise.all([
    agentProfileFilter(profileInfo, contextResult),
    agentRulesApplicator(allRules, contextResult, situations)
  ]);

  // Schritt 3: Training & Style (benötigen Kontext, aber können parallel)
  const [trainingResult, styleResult] = await Promise.all([
    agentTrainingSelector(contextResult, customerMessage, situations, vectorDbFunc),
    agentStyleAnalyst(moderatorMessages, contextResult)
  ]);

  // Schritt 4: Image (optional, kann parallel zu Schritt 3)
  const imageResult = await agentImageAnalyst(imageUrl, contextResult, imageAnalysisFunc);

  const results = {
    context: contextResult,
    profile: profileResult,
    rules: rulesResult,
    training: trainingResult,
    style: styleResult,
    image: imageResult
  };

  console.log('✅ Multi-Agent Pipeline abgeschlossen');
  return results;
}

module.exports = {
  agentContextAnalyst,
  agentProfileFilter,
  agentTrainingSelector,
  agentRulesApplicator,
  agentImageAnalyst,
  agentStyleAnalyst,
  runMultiAgentPipeline
};

