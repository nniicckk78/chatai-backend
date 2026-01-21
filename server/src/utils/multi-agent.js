const { getClient } = require('../openaiClient');
const { runSafetyCheck } = require('./safety-agent');
const { getEmbedding, cosineSimilarity } = require('./embeddings');

// 🚨 MULTI-AGENT SYSTEM: Jeder Agent ist isoliert mit Fallbacks
// Model: GPT-4o-mini (kostengünstig, gut genug für fokussierte Aufgaben)

const AGENT_MODEL = process.env.AI_MODEL === 'gpt-4o-mini' ? 'gpt-4o-mini' : 'gpt-4o-mini'; // Immer 4o-mini für Agenten

/**
 * 🧠 SHARED KNOWLEDGE BASE (Blackboard Pattern)
 * Gemeinsamer Speicher für alle Agents - ermöglicht intelligente Kommunikation
 */
class SharedKnowledgeBase {
  constructor() {
    this.reset();
  }

  reset() {
    this.learningStats = null;
    this.agentInsights = {}; // { agentName: { insights: [], recommendations: [], data: {} } }
    this.contextualPatterns = {}; // { situation: { patterns: [], words: [], structures: [] } }
    this.feedbackKnowledge = {}; // { situation: { good: [], bad: [], avoid: [] } }
    this.priorityGuidance = []; // [{ priority: 'high', guidance: '...', source: '...' }]
    this.synthesizedKnowledge = null; // Wird vom Knowledge Synthesizer gefüllt
  }

  // Agent schreibt Erkenntnisse
  writeAgentInsights(agentName, insights, recommendations = [], data = {}) {
    this.agentInsights[agentName] = {
      insights: Array.isArray(insights) ? insights : [insights],
      recommendations: Array.isArray(recommendations) ? recommendations : [recommendations],
      data: data,
      timestamp: Date.now()
    };
  }

  // Agent liest Erkenntnisse anderer Agents
  readAgentInsights(agentName) {
    return this.agentInsights[agentName] || { insights: [], recommendations: [], data: {} };
  }

  // Alle Erkenntnisse lesen
  readAllInsights() {
    return this.agentInsights;
  }

  // Learning-Stats setzen
  setLearningStats(stats) {
    this.learningStats = stats;
  }

  // Learning-Stats lesen
  getLearningStats() {
    return this.learningStats;
  }

  // Kontextuelle Muster hinzufügen
  addContextualPattern(situation, pattern, type = 'pattern') {
    if (!this.contextualPatterns[situation]) {
      this.contextualPatterns[situation] = { patterns: [], words: [], structures: [] };
    }
    if (type === 'word') {
      this.contextualPatterns[situation].words.push(pattern);
    } else if (type === 'structure') {
      this.contextualPatterns[situation].structures.push(pattern);
    } else {
      this.contextualPatterns[situation].patterns.push(pattern);
    }
  }

  // Kontextuelle Muster lesen
  getContextualPatterns(situation) {
    return this.contextualPatterns[situation] || { patterns: [], words: [], structures: [] };
  }

  // Feedback-Wissen hinzufügen
  addFeedbackKnowledge(situation, knowledge, type = 'good') {
    if (!this.feedbackKnowledge[situation]) {
      this.feedbackKnowledge[situation] = { good: [], bad: [], avoid: [] };
    }
    if (type === 'bad' || type === 'avoid') {
      this.feedbackKnowledge[situation][type].push(knowledge);
    } else {
      this.feedbackKnowledge[situation].good.push(knowledge);
    }
  }

  // Feedback-Wissen lesen
  getFeedbackKnowledge(situation) {
    return this.feedbackKnowledge[situation] || { good: [], bad: [], avoid: [] };
  }

  // Priority Guidance hinzufügen
  addPriorityGuidance(guidance, priority = 'medium', source = 'unknown') {
    this.priorityGuidance.push({
      guidance,
      priority,
      source,
      timestamp: Date.now()
    });
    // Sortiere nach Priorität (high > medium > low)
    this.priorityGuidance.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  // Priority Guidance lesen
  getPriorityGuidance(priority = null) {
    if (priority) {
      return this.priorityGuidance.filter(g => g.priority === priority);
    }
    return this.priorityGuidance;
  }

  // Synthesized Knowledge setzen
  setSynthesizedKnowledge(knowledge) {
    this.synthesizedKnowledge = knowledge;
  }

  // Synthesized Knowledge lesen
  getSynthesizedKnowledge() {
    return this.synthesizedKnowledge;
  }
}

// Globale Instanz der Shared Knowledge Base
let sharedKnowledgeBase = null;

/**
 * 🛡️ Wrapper-Funktion für kritische Agents mit Fallback-Strategie
 * Verhindert, dass die Pipeline abbricht, wenn ein kritischer Agent fehlschlägt
 */
async function runAgentWithFallback(agentFunction, agentName, fallbackValue, timeoutMs = 15000, ...args) {
  try {
    const result = await Promise.race([
      agentFunction(...args),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
    ]);
    
    // Prüfe, ob Ergebnis gültig ist
    if (result && (result.success !== false || result.detectedSituations || result.selectedExamples)) {
      return result;
    }
    
    // Wenn success: false, aber kein Fallback nötig (Agent hat bewusst false zurückgegeben)
    return result;
  } catch (err) {
    if (err.message === 'Timeout') {
      console.error(`⏱️ Agent ${agentName} hat Timeout erreicht (${timeoutMs}ms)`);
    } else {
      console.error(`⚠️ Agent ${agentName} fehlgeschlagen:`, err.message);
    }
    console.log(`🔄 Verwende Fallback für ${agentName}`);
    return fallbackValue;
  }
}

function getSharedKnowledgeBase() {
  if (!sharedKnowledgeBase) {
    sharedKnowledgeBase = new SharedKnowledgeBase();
  }
  return sharedKnowledgeBase;
}

function resetSharedKnowledgeBase() {
  sharedKnowledgeBase = new SharedKnowledgeBase();
  return sharedKnowledgeBase;
}

/**
 * Agent 1: Kontext-Analyst
 * Analysiert Chat-Verlauf und erkennt Thema/Kontext
 */
async function agentContextAnalyst(conversationHistory, customerMessage, isASA = false) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Kontext-Analyst - Fallback');
    return {
      topic: 'allgemein',
      summary: 'Keine Analyse möglich',
      keyPoints: [],
      contextFlow: 'neutral',
      situations: [],
      success: false
    };
  }

  // 🚨 ASA-FALL: Kontext-Analyse ist irrelevant - einfach Standard-Werte zurückgeben
  if (isASA) {
    console.log('🤖 Agent: Kontext-Analyst - ASA-Modus: Kontext wird ignoriert');
    return {
      topic: 'allgemein',
      summary: 'ASA-Reaktivierung',
      keyPoints: [],
      contextFlow: 'neutral',
      situations: [],
      success: true
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
- "contextFlow": Wie verläuft das Gespräch? Neutral, positiv | negativ | philosophisch | sexuell

⚠️ HINWEIS: Situation-Erkennung wird von einem separaten Agent (Situation-Detector) gemacht - hier nur topic, summary, keyPoints, contextFlow!

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
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          // Stelle sicher, dass situations ein Array ist
          if (!parsed.situations || !Array.isArray(parsed.situations)) {
            parsed.situations = [];
          }
          
          // 🚨 HINWEIS: Situationen werden NICHT mehr hier erkannt - das macht agentSituationDetector!
          // Entferne situations aus dem Ergebnis, falls vorhanden
          if (parsed.situations) {
            delete parsed.situations;
          }
          
          // 🚨 NEU: Prüfe, ob "sexuell" wirklich zutrifft (nicht fälschlicherweise erkannt)
          // Problem: "Chemie", "verstehen", "Beziehung" werden fälschlicherweise als "sexuell" interpretiert
          // Lösung: Prüfe auf explizite sexuelle Wörter
          if (parsed.topic === 'sexuell' || parsed.contextFlow === 'sexuell') {
            const fullText = (conversationHistory + " " + customerMessage).toLowerCase();
            const explicitSexualKeywords = ["titten", "brüste", "arsch", "po", "pussy", "schwanz", "sex", "ficken", 
                                           "wichsen", "lecken", "blasen", "squiten", "muschi", "zunge", "schamlippen", 
                                           "kitzler", "clitoris", "penis", "dick", "sperma", "orgasmus", "komm", 
                                           "nass", "feucht", "erregt", "horny", "hard", "vorlieben"];
            const hasExplicitSexual = explicitSexualKeywords.some(keyword => fullText.includes(keyword));
            
            // Wenn nicht explizit sexuell → ändere zu "allgemein"
            if (!hasExplicitSexual) {
              if (parsed.topic === 'sexuell') {
                parsed.topic = 'allgemein';
                console.log(`📊 Topic korrigiert: "sexuell" → "allgemein" (nicht explizit sexuell)`);
              }
              if (parsed.contextFlow === 'sexuell') {
                parsed.contextFlow = 'neutral';
                console.log(`📊 ContextFlow korrigiert: "sexuell" → "neutral" (nicht explizit sexuell)`);
              }
            }
          }
          
          console.log(`✅ Agent: Kontext-Analyst - Topic: ${parsed.topic}, Flow: ${parsed.contextFlow} (Situations werden separat erkannt)`);
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
    situations: [],
    success: false
  };
}

/**
 * 🧠 NEU: Agent: Conversation Flow Analyzer
 * Analysiert Chat-Verlauf und erkennt:
 * - Was ist aktuell relevant (letzte 3-5 Nachrichten)
 * - Was ist veraltet (älter als X Nachrichten oder Y Zeit)
 * - Auf welche Nachricht antwortet der Kunde
 * - Welches Thema ist aktiv (nicht abgeschlossen)
 * 
 * Verhindert, dass die KI auf alte Themen zurückkommt und erzwingt Vorwärts-Bewegung
 */
async function agentConversationFlowAnalyzer(customerMessage, conversationHistory, moderatorMessages, customerMessages, sharedKB) {
  const client = getClient();
  if (!client || !sharedKB) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Conversation Flow Analyzer - Fallback');
    return {
      activeContext: null,
      outdatedContext: null,
      isResponseToLastModeratorMessage: false,
      referenceMessage: null,
      recommendations: [],
      success: false
    };
  }

  try {
    // Extrahiere Nachrichten mit Timestamps (falls verfügbar)
    const recentModeratorMessages = (moderatorMessages || []).slice(-5); // Letzte 5
    const recentCustomerMessages = (customerMessages || []).slice(-5); // Letzte 5
    
    // Erstelle strukturierte Verlauf-Darstellung
    let structuredHistory = '';
    if (recentModeratorMessages.length > 0 || recentCustomerMessages.length > 0) {
      structuredHistory = 'Letzte Nachrichten im Chat-Verlauf (neueste zuerst):\n\n';
      
      // Kombiniere und sortiere nach Timestamp (falls verfügbar)
      const allRecentMessages = [];
      recentModeratorMessages.forEach((msg, idx) => {
        allRecentMessages.push({
          type: 'Moderator',
          text: msg?.text || '',
          timestamp: msg?.timestamp || null,
          index: recentModeratorMessages.length - idx // Neueste = höchster Index
        });
      });
      recentCustomerMessages.forEach((msg, idx) => {
        allRecentMessages.push({
          type: 'Kunde',
          text: msg?.text || '',
          timestamp: msg?.timestamp || null,
          index: recentCustomerMessages.length - idx
        });
      });
      
      // Sortiere nach Index (neueste zuerst)
      allRecentMessages.sort((a, b) => b.index - a.index);
      
      // Zeige letzte 10 Nachrichten
      allRecentMessages.slice(0, 10).forEach((msg, idx) => {
        structuredHistory += `${idx + 1}. [${msg.type}]: "${msg.text.substring(0, 150)}${msg.text.length > 150 ? '...' : ''}"\n`;
        if (msg.timestamp) {
          const msgDate = new Date(msg.timestamp);
          const now = new Date();
          const hoursAgo = (now - msgDate) / (1000 * 60 * 60);
          if (hoursAgo > 24) {
            structuredHistory += `   ⚠️ Veraltet: ${Math.round(hoursAgo / 24)} Tage alt\n`;
          } else if (hoursAgo > 1) {
            structuredHistory += `   ⚠️ Alt: ${Math.round(hoursAgo)} Stunden alt\n`;
          }
        }
      });
    } else if (conversationHistory) {
      // Fallback: Verwende conversationHistory String
      structuredHistory = conversationHistory.substring(0, 2000);
    }
    
    // LLM-basierte Flow-Analyse
    const flowAnalysisPrompt = `Analysiere diesen Chat-Verlauf und die aktuelle Kundennachricht. Erkenne, was AKTUELL relevant ist und was VERALTET ist.

${structuredHistory}

Aktuelle Kundennachricht: "${customerMessage}"

Aufgabe:
1. **Temporal Relevance (Zeitliche Relevanz)**: 
   - Erkenne, welche Nachrichten/Themen AKTUELL sind (letzte 3-5 Nachrichten)
   - Erkenne, welche Nachrichten/Themen VERALTET sind (älter als 10 Nachrichten oder 24 Stunden)
   - Nachrichten mit "⚠️ Veraltet" oder "⚠️ Alt" sind NICHT mehr relevant!

2. **Topic Continuity (Themen-Kontinuität)**:
   - Erkenne, welche Themen noch AKTIV sind (in letzten 3-5 Nachrichten erwähnt)
   - Erkenne, welche Themen ABGESCHLOSSEN/VERALTET sind (nicht mehr in letzten 5 Nachrichten)
   - Beispiel: "Beruf" wurde vor 2 Tagen erwähnt, aber nicht mehr → VERALTET

3. **Reference Detection (Referenz-Erkennung)**:
   - Auf welche Nachricht antwortet der Kunde? (letzte Moderator-Nachricht? vorherige?)
   - Erkenne Referenzen ("das", "es", "dann", "ja", "ok")
   - Ist es eine Antwort auf die letzte Moderator-Nachricht?

4. **Context Freshness (Kontext-Frische)**:
   - Priorisiere NUR neueste Kontexte
   - Ignoriere ALTE Kontexte (auch wenn sie im Verlauf stehen)
   - Erkenne, wenn ein Thema "abgeschlossen" ist

WICHTIG:
- Die KI soll NUR auf aktuelle Nachrichten reagieren, NICHT auf alte Themen zurückkommen!
- Wenn ein Thema vor 2 Tagen war, aber nicht mehr in letzten 5 Nachrichten → IGNORIEREN!
- Gehe VORWÄRTS, nicht zurück!

Antworte NUR als JSON:
{
  "activeContext": {
    "relevantMessages": ["Beschreibung der letzten 3-5 relevanten Nachrichten"],
    "currentTopic": "Aktuelles Thema (z.B. 'sexuell', 'allgemein', 'treffen')",
    "isResponseToLastModeratorMessage": true/false,
    "referenceMessage": "Auf welche Nachricht antwortet der Kunde? (z.B. 'Letzte Moderator-Nachricht über sexuelle Themen')"
  },
  "outdatedContext": {
    "oldTopics": ["Liste veralteter Themen (z.B. 'Beruf (vor 2 Tagen)', 'Hobby (gestern)')"],
    "reason": "Warum sind diese Themen veraltet? (z.B. 'Nicht mehr in letzten 5 Nachrichten erwähnt')"
  },
  "recommendations": [
    "Reagiere NUR auf aktuelle Nachricht",
    "IGNORIERE alte Themen: [Liste]",
    "Gehe VORWÄRTS, nicht zurück"
  ],
  "forwardMovement": {
    "shouldStartNewTopic": true/false,
    "shouldContinueCurrentTopic": true/false,
    "topicsToIgnore": ["Liste der zu ignorierenden Themen"]
  }
}

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du bist ein Experte für Chat-Verlauf-Analyse. Du erkennst aktuelle vs. veraltete Kontexte. Antworte IMMER nur als JSON.' },
          { role: 'user', content: flowAnalysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 600
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          // Schreibe Erkenntnisse in Shared Knowledge Base
          const insights = [];
          if (parsed.activeContext && parsed.activeContext.currentTopic) {
            insights.push(`Aktuelles Thema: ${parsed.activeContext.currentTopic}`);
          }
          if (parsed.activeContext && parsed.activeContext.isResponseToLastModeratorMessage) {
            insights.push('Kunde antwortet auf letzte Moderator-Nachricht');
          }
          if (parsed.outdatedContext && parsed.outdatedContext.oldTopics && parsed.outdatedContext.oldTopics.length > 0) {
            insights.push(`Veraltete Themen (ignorieren): ${parsed.outdatedContext.oldTopics.join(', ')}`);
          }
          
          sharedKB.writeAgentInsights('conversationFlowAnalyzer', insights, parsed.recommendations || [], parsed);
          
          // Füge Priority Guidance hinzu
          if (parsed.recommendations && parsed.recommendations.length > 0) {
            parsed.recommendations.forEach(rec => {
              sharedKB.addPriorityGuidance(rec, 'high', 'conversationFlowAnalyzer');
            });
          }
          
          // Füge kontextuelles Muster hinzu
          if (parsed.activeContext && parsed.activeContext.currentTopic) {
            sharedKB.addContextualPattern('current_topic', parsed.activeContext.currentTopic, 'topic');
          }
          
          // Füge veraltete Themen als "avoid" hinzu
          if (parsed.outdatedContext && parsed.outdatedContext.oldTopics && parsed.outdatedContext.oldTopics.length > 0) {
            parsed.outdatedContext.oldTopics.forEach(topic => {
              sharedKB.addFeedbackKnowledge('allgemein', `IGNORIERE Thema: ${topic}`, 'avoid');
            });
          }
          
          console.log(`✅ Agent: Conversation Flow Analyzer - Aktuelles Thema: "${parsed.activeContext?.currentTopic || 'keines'}", Veraltete Themen: ${parsed.outdatedContext?.oldTopics?.length || 0}`);
          
          return {
            ...parsed,
            success: true
          };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Conversation Flow Analyzer - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    if (err.message !== 'Timeout') {
      console.warn('⚠️ Agent: Conversation Flow Analyzer - Fehler:', err.message);
    } else {
      console.warn('⚠️ Agent: Conversation Flow Analyzer - Timeout');
    }
  }

  // Fallback
  return {
    activeContext: null,
    outdatedContext: null,
    isResponseToLastModeratorMessage: false,
    referenceMessage: null,
    recommendations: [],
    forwardMovement: {
      shouldStartNewTopic: false,
      shouldContinueCurrentTopic: true,
      topicsToIgnore: []
    },
    success: false
  };
}

/**
 * 🧠 NEU: Agent: Ambiguity Resolver
 * Erkennt mehrdeutige Phrasen und interpretiert sie im Kontext des Kundenprofils
 * Verknüpft Profil-Informationen (Stiefel, Andenken, sexuelle Vorlieben) mit der Nachricht
 */
async function agentAmbiguityResolver(customerMessage, customerProfile, moderatorProfile, conversationHistory, sharedKB) {
  const client = getClient();
  if (!client || !sharedKB) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Ambiguity Resolver - Fallback');
    return {
      resolvedMeaning: null,
      profileConnections: [],
      sexualContext: false,
      recommendations: [],
      success: false
    };
  }

  try {
    // Extrahiere wichtige Profil-Informationen
    const customerOther = customerProfile?.Other || customerProfile?.other || '';
    const customerSexualPrefs = customerProfile?.['Sexual Preferences'] || customerProfile?.sexualPreferences || '';
    const moderatorSucht = moderatorProfile?.Other || moderatorProfile?.other || '';
    const hasSexualSucht = moderatorSucht.toLowerCase().includes('sucht: sex') || moderatorSucht.toLowerCase().includes('sucht sex');
    
    // Erkenne Profil-Referenzen
    const hasProfileReference = customerMessage.toLowerCase().includes('profil') || 
                                customerMessage.toLowerCase().includes('wie es in') ||
                                customerMessage.toLowerCase().includes('wie in meinem profil') ||
                                customerMessage.toLowerCase().includes('wie in mein profil');
    
    // Erkenne mehrdeutige Phrasen
    const ambiguousPhrases = [
      'was los werden',
      'was los wirst',
      'etwas los werden',
      'etwas mitbringen',
      'was mitbringen',
      'etwas dabei haben',
      'was dabei haben',
      'etwas vorbereiten',
      'was vorbereiten'
    ];
    
    const hasAmbiguousPhrase = ambiguousPhrases.some(phrase => 
      customerMessage.toLowerCase().includes(phrase)
    );
    
    // Wenn keine mehrdeutige Phrase oder Profil-Referenz → kein Bedarf
    if (!hasAmbiguousPhrase && !hasProfileReference) {
      return {
        resolvedMeaning: null,
        profileConnections: [],
        sexualContext: false,
        recommendations: [],
        success: true
      };
    }
    
    // Extrahiere relevante Profil-Informationen
    const profileInfo = [];
    if (customerOther) {
      // Suche nach Stiefel, Schuhe, Andenken
      if (customerOther.toLowerCase().includes('stiefel') || customerOther.toLowerCase().includes('schuhe') || 
          customerOther.toLowerCase().includes('high heels') || customerOther.toLowerCase().includes('high heils')) {
        profileInfo.push('Kunde sammelt Stiefel/High Heels als "Andenken"');
      }
      if (customerOther.toLowerCase().includes('andenken')) {
        profileInfo.push('Kunde erwähnt "Andenken" im Profil');
      }
    }
    if (customerSexualPrefs) {
      profileInfo.push(`Sexuelle Vorlieben: ${customerSexualPrefs}`);
    }
    if (hasSexualSucht) {
      profileInfo.push('Moderator hat "Sucht: Sex" im Profil - sexueller Kontext ist ERWÜNSCHT');
    }
    
    // LLM-basierte Interpretation
    const ambiguityPrompt = `Analysiere diese mehrdeutige Kundennachricht im Kontext des Kundenprofils.

Kundennachricht: "${customerMessage}"

Kundenprofil-Informationen:
${profileInfo.length > 0 ? profileInfo.join('\n') : 'Keine spezifischen Profil-Informationen verfügbar'}

${hasProfileReference ? '🚨 WICHTIG: Der Kunde verweist auf sein Profil ("wie es in mein profil steht") - verbinde die Nachricht mit den Profil-Informationen!' : ''}

${hasSexualSucht ? '🚨 WICHTIG: Der Moderator hat "Sucht: Sex" im Profil - sexuelle Interpretation ist ERWÜNSCHT und ERLAUBT!' : ''}

Mehrdeutige Phrasen die erkannt wurden:
${ambiguousPhrases.filter(p => customerMessage.toLowerCase().includes(p)).join(', ')}

Aufgabe:
1. Interpretiere die mehrdeutige Phrase im Kontext des Profils
2. Erkenne sexuelle Anspielungen (besonders wenn "Sucht: Sex" im Moderator-Profil steht)
3. Verknüpfe Profil-Informationen (z.B. Stiefel, Andenken) mit der Nachricht
4. Erkenne, ob "was los werden" sich auf sexuelle Dinge bezieht (z.B. Stiefel als Andenken)

Beispiele:
- "was los werden" + Profil erwähnt Stiefel/Andenken → bedeutet: "Stiefel mitbringen/geben"
- "was los werden" + sexueller Kontext → bedeutet: sexuelle Aktivität, nicht Entrümpelung
- "etwas mitbringen" + Profil erwähnt Stiefel → bedeutet: Stiefel mitbringen

Antworte NUR als JSON:
{
  "resolvedMeaning": "Die tatsächliche Bedeutung der mehrdeutigen Phrase im Profil-Kontext (z.B. 'Der Kunde meint, dass Stiefel mitgebracht werden sollen')",
  "profileConnections": ["Verbindung 1 (z.B. 'Stiefel als Andenken')", "Verbindung 2"],
  "sexualContext": true/false,
  "interpretation": "Detaillierte Interpretation (max 200 Zeichen)",
  "recommendations": ["Empfehlung 1 für die Antwort", "Empfehlung 2"]
}

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du bist ein Experte für mehrdeutige Phrasen und Profil-Interpretation. Antworte IMMER nur als JSON.' },
          { role: 'user', content: ambiguityPrompt }
        ],
        temperature: 0.3,
        max_tokens: 400
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          // Schreibe Erkenntnisse in Shared Knowledge Base
          const insights = [];
          if (parsed.resolvedMeaning) {
            insights.push(`Mehrdeutige Phrase interpretiert: "${parsed.resolvedMeaning}"`);
          }
          if (parsed.profileConnections && parsed.profileConnections.length > 0) {
            insights.push(`Profil-Verbindungen: ${parsed.profileConnections.join(', ')}`);
          }
          if (parsed.sexualContext) {
            insights.push('Sexueller Kontext erkannt - direkte sexuelle Antwort ist ERWÜNSCHT');
          }
          
          sharedKB.writeAgentInsights('ambiguityResolver', insights, parsed.recommendations || [], parsed);
          
          // Füge Priority Guidance hinzu
          if (parsed.recommendations && parsed.recommendations.length > 0) {
            parsed.recommendations.forEach(rec => {
              sharedKB.addPriorityGuidance(rec, 'high', 'ambiguityResolver');
            });
          }
          
          // Füge kontextuelles Muster hinzu
          if (parsed.resolvedMeaning) {
            sharedKB.addContextualPattern('mehrdeutige_phrase', parsed.resolvedMeaning, 'interpretation');
          }
          
          console.log(`✅ Agent: Ambiguity Resolver - Bedeutung: "${parsed.resolvedMeaning || 'keine'}", Sexueller Kontext: ${parsed.sexualContext ? 'JA' : 'NEIN'}`);
          
          return {
            ...parsed,
            success: true
          };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Ambiguity Resolver - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    if (err.message !== 'Timeout') {
      console.warn('⚠️ Agent: Ambiguity Resolver - Fehler:', err.message);
    } else {
      console.warn('⚠️ Agent: Ambiguity Resolver - Timeout');
    }
  }

  // Fallback
  return {
    resolvedMeaning: null,
    profileConnections: [],
    sexualContext: false,
    recommendations: [],
    success: false
  };
}

/**
 * Agent 2: Profil-Filter
 * Filtert Profil-Infos basierend auf Kontext-Relevanz
 * ERWEITERT: Generiert vollständiges customerContext-Array (wie im alten System)
 */
async function agentProfileFilter(profileInfo, contextAnalysis, extractedUserInfo) {
  const client = getClient();
  
  // Erstelle customerContext-Array (wie im alten System)
  const customerContext = [];
  
  // 1. Extrahiere aus extractedUserInfo.user (wie im alten System)
  if (extractedUserInfo && extractedUserInfo.user && Object.keys(extractedUserInfo.user).length > 0) {
    Object.entries(extractedUserInfo.user).forEach(([key, value]) => {
      if (value) customerContext.push(`${key}: ${value}`);
    });
  }
  
  // 2. Füge metaData.customerInfo hinzu (wie im alten System)
  if (profileInfo && Object.keys(profileInfo).length > 0) {
    if (profileInfo.name && !customerContext.some(c => c.includes('Name'))) {
      customerContext.push(`Name: ${profileInfo.name}`);
    }
    if (profileInfo.city && !customerContext.some(c => c.includes('Stadt'))) {
      customerContext.push(`Stadt: ${profileInfo.city}`);
    }
    if (profileInfo.country && !customerContext.some(c => c.includes('Land'))) {
      customerContext.push(`Land: ${profileInfo.country}`);
    }
    if (profileInfo.gender && !customerContext.some(c => c.includes('Geschlecht'))) {
      customerContext.push(`Geschlecht: ${profileInfo.gender}`);
    }
    if (profileInfo.birthDate && !customerContext.some(c => c.includes('Geburtsdatum'))) {
      customerContext.push(`Geburtsdatum: ${profileInfo.birthDate}`);
    }
    if (profileInfo.hasProfilePic) {
      customerContext.push(`Hat Profilbild: Ja`);
    }
    if (profileInfo.hasPictures) {
      customerContext.push(`Hat weitere Bilder: Ja`);
    }
  }
  
  // 3. Filtere basierend auf Kontext-Relevanz (falls LLM verfügbar)
  let relevantInfo = customerContext;
  let irrelevantInfo = [];
  
  if (client && contextAnalysis && contextAnalysis.topic && customerContext.length > 0) {
    try {
      const profileStr = JSON.stringify(profileInfo, null, 2);
      const contextStr = JSON.stringify(contextAnalysis, null, 2);
      const contextArrayStr = customerContext.join(', ');

      const analysisPrompt = `Analysiere diese Profil-Infos und bestimme, welche RELEVANT für den aktuellen Kontext sind.

Profil-Infos:
${profileStr.substring(0, 1500)}

Kontext-Analyse:
${contextStr.substring(0, 500)}

Aktueller customerContext:
${contextArrayStr.substring(0, 1000)}

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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);

      const result = response.choices?.[0]?.message?.content?.trim();
      if (result) {
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            // Filtere customerContext basierend auf relevantInfo
            if (parsed.relevantInfo && Array.isArray(parsed.relevantInfo) && parsed.relevantInfo.length > 0) {
              relevantInfo = customerContext.filter(c => 
                parsed.relevantInfo.some(r => c.includes(r) || r.includes(c.split(':')[0]?.trim()))
              );
              irrelevantInfo = customerContext.filter(c => !relevantInfo.includes(c));
            }
            console.log(`✅ Agent: Profil-Filter - ${relevantInfo.length} relevant, ${irrelevantInfo.length} irrelevant (von ${customerContext.length} total)`);
          }
        } catch (e) {
          console.warn('⚠️ Agent: Profil-Filter - JSON Parse Fehler:', e.message);
        }
      }
    } catch (err) {
      console.warn('⚠️ Agent: Profil-Filter - Fehler:', err.message);
    }
  }
  
  // Profilbild-Kontext (wird später vom Image-Analyst geliefert, hier nur Platzhalter)
  let profilePicContext = "";
  
  // Customer Type Context (Neukunde vs. Langzeitkunde)
  let customerTypeContext = "";
  const customerMessageCount = profileInfo?.messageCount || 0;
  const isNewCustomer = profileInfo?.isNewCustomer || false;
  
  if (customerMessageCount >= 10) {
    customerTypeContext = "\n\nWICHTIG: Dies ist ein Langzeitkunde (bereits viele Nachrichten ausgetauscht). Orientiere dich an Training-Daten für Langzeitkunden-Gespräche.";
  } else if (isNewCustomer) {
    customerTypeContext = "\n\n🆕🆕🆕 KRITISCH: DIES IST EIN NEUKUNDE (ERSTE NACHRICHT, NOCH KEINE FAKE-ANTWORT IM CHAT)! 🆕🆕🆕\n- Orientiere dich an Training-Daten für erste Nachrichten!\n- Das Learning-System zeigt dir bewährte Muster für Neukunden!\n- Stelle Fragen zum Kunden und zeige Interesse!";
  } else if (customerMessageCount > 0) {
    customerTypeContext = "\n\nWICHTIG: Dies ist ein Neukunde (erst wenige Nachrichten). Orientiere dich an Training-Daten für Neukunden-Gespräche.";
  }
  
  return {
    customerContext: relevantInfo, // Vollständiges customerContext-Array (gefiltert nach Relevanz)
    relevantInfo: relevantInfo,
    irrelevantInfo: irrelevantInfo,
    reason: irrelevantInfo.length > 0 ? 'Gefiltert nach Kontext-Relevanz' : 'Alle Infos relevant',
    profilePicContext, // Wird später vom Image-Analyst erweitert
    customerTypeContext,
    customerMessageCount,
    isNewCustomer,
    success: true
  };
}

/**
 * Agent 3: Training-Data-Selector
 * Findet relevante Training-Daten basierend auf Kontext
 * HINWEIS: Nutzt auch Vector-DB für bessere Ergebnisse
 */
async function agentTrainingSelector(contextAnalysis, customerMessage, situations, vectorDbFunc, isASA = false, conversationContext = '', trainingData = null, learningContextResult = null) {
  // Dieser Agent ist komplexer - wir nutzen die bestehende Vector-DB Logik
  // und erweitern sie mit LLM-basierter Selektion
  // 🤖 ASA-UNTERSTÜTZUNG: Erkennt und filtert ASA-Beispiele
  // 📚 TRAINING DATA: Nutzt übergebenes trainingData (aus reply.js geladen)
  
  try {
    // 📚 Lade Training Data, falls nicht übergeben (Fallback)
    let conversations = [];
    if (trainingData && trainingData.conversations && Array.isArray(trainingData.conversations)) {
      conversations = trainingData.conversations;
      console.log(`📚 Agent: Training-Selector - ${conversations.length} Gespräche aus übergebenem trainingData`);
    } else {
      // Fallback: Lade selbst (sollte nicht nötig sein, da reply.js bereits lädt)
      try {
        const { getTrainingData } = require('./reply-helpers');
        const fallbackTrainingData = await getTrainingData();
        if (fallbackTrainingData && fallbackTrainingData.conversations && Array.isArray(fallbackTrainingData.conversations)) {
          conversations = fallbackTrainingData.conversations;
          console.log(`📚 Agent: Training-Selector - Fallback: ${conversations.length} Gespräche geladen`);
        }
      } catch (err) {
        console.warn('⚠️ Agent: Training-Selector - Konnte Training Data nicht laden:', err.message);
      }
    }
    
    // Build query from context
    const topic = contextAnalysis.topic || 'allgemein';
    const keyPoints = contextAnalysis.keyPoints || [];
    let queryText = `${topic}: ${keyPoints.join(', ')}: ${customerMessage.substring(0, 200)}`;
    
    // 🤖 ASA-UNTERSTÜTZUNG: Wenn ASA-Fall, verwende ASA-Beispiele aus trainingData.asaExamples!
    // 🚨🚨🚨 KRITISCH: NUR asaExamples verwenden, NICHT conversations (waren ein Fehler)!
    if (isASA) {
      console.log('🤖 Agent: Training-Selector - ASA-Modus aktiviert (verwende ASA-Beispiele aus trainingData.asaExamples)');
      
      try {
        // 🚨🚨🚨 NEU: Lade ASA-Beispiele AUSSCHLIESSLICH aus trainingData.asaExamples!
        let asaExamplesRaw = [];
        if (trainingData && trainingData.asaExamples && Array.isArray(trainingData.asaExamples)) {
          asaExamplesRaw = trainingData.asaExamples;
        } else {
          // Fallback: Versuche selbst zu laden
          try {
            const { getTrainingData } = require('./reply-helpers');
            const fallbackTrainingData = await getTrainingData();
            if (fallbackTrainingData && fallbackTrainingData.asaExamples && Array.isArray(fallbackTrainingData.asaExamples)) {
              asaExamplesRaw = fallbackTrainingData.asaExamples;
            }
          } catch (err) {
            console.warn('⚠️ Agent: Training-Selector - Konnte ASA-Beispiele nicht laden:', err.message);
          }
        }
        
        if (asaExamplesRaw.length > 0) {
          console.log(`✅ Agent: Training-Selector - ${asaExamplesRaw.length} ASA-Beispiele aus asaExamples gefunden`);
          
          // 🚨 NEU: Normalisiere Format: asaMessage → moderatorResponse für einheitliche Verarbeitung
          const asaExamples = asaExamplesRaw.map(ex => ({
            ...ex,
            moderatorResponse: ex.asaMessage || ex.moderatorResponse || '',
            situation: 'Generische ASA (Neukunde)',
            // Behalte Original-ID falls vorhanden
            id: ex.id || ex._id || null
          }));
          
          // 🚨🚨🚨 NEU: Filtere "huhu" aus, wenn Learning-Stats es als schlecht markieren
          let filteredASAExamples = asaExamples;
          if (learningContextResult && learningContextResult.learningStats) {
            const learningStats = learningContextResult.learningStats;
            const huhuStats = learningStats.wordFrequencies && learningStats.wordFrequencies.huhu;
            if (huhuStats && huhuStats.bad > huhuStats.good) {
              // "huhu" ist mehrfach als schlecht markiert - filtere Beispiele mit "huhu" heraus
              const filteredExamples = asaExamples.filter(ex => {
                const response = (ex.moderatorResponse || '').toLowerCase();
                return !response.startsWith('huhu') && !response.includes('huhu,') && !response.includes('huhu ');
              });
              if (filteredExamples.length > 0) {
                filteredASAExamples = filteredExamples;
                console.log(`⚠️ Agent: Training-Selector - ${asaExamples.length - filteredExamples.length} ASA-Beispiele mit "huhu" herausgefiltert (Learning-Stats: ${huhuStats.bad}x bad, ${huhuStats.good}x good)`);
              } else {
                console.log(`⚠️ Agent: Training-Selector - Alle ASA-Beispiele enthalten "huhu", verwende trotzdem alle (keine Alternative)`);
              }
            }
          }
          
          // 🚨🚨🚨 NEU: Zufällige Auswahl von 3-4 Beispielen für bessere Variation!
          const numToSelect = Math.min(4, Math.max(3, Math.floor(filteredASAExamples.length * 0.3))); // 3-4 Beispiele oder 30% wenn weniger vorhanden
          const shuffled = [...filteredASAExamples].sort(() => Math.random() - 0.5); // Zufällig mischen
          const selectedASAExamples = shuffled.slice(0, numToSelect);
          
          console.log(`✅ Agent: Training-Selector - ${selectedASAExamples.length} ASA-Beispiele zufällig ausgewählt (von ${filteredASAExamples.length} verfügbar)`);
          
          const trainingExamplesContext = buildTrainingExamplesContext(
            selectedASAExamples,
            isASA,
            [], // Keine Situationen bei ASA
            learningContextResult,
            false,
            null
          );
          
          return {
            selectedExamples: selectedASAExamples,
            trainingExamplesContext,
            reason: `ASA-Modus: ${selectedASAExamples.length} ASA-Beispiele zufällig ausgewählt (von ${filteredASAExamples.length} verfügbar)`,
            method: 'asa-direct',
            success: true,
            isASA: true,
            // 🚨 NEU: Speichere Beispiel-IDs für Feedback-Tracking
            exampleIds: selectedASAExamples.map(ex => ex.id || ex._id || null).filter(id => id !== null),
            exampleTexts: selectedASAExamples.map(ex => (ex.moderatorResponse || '').substring(0, 100)),
            hybridScores: selectedASAExamples.map(ex => ({
              hybrid: 0.5, // ASA-Beispiele haben keinen Hybrid-Score
              semantic: 0.5,
              feedback: 0.5,
              context: 0.5
            }))
          };
        } else {
          console.warn('⚠️ Agent: Training-Selector - KEINE ASA-Beispiele in trainingData.asaExamples gefunden!');
        }
      } catch (err) {
        console.warn('⚠️ Agent: Training-Selector - Fehler beim Laden von ASA-Beispielen:', err.message);
      }
    }

    // Build query from context (topic wurde bereits oben deklariert)
    // const topic = contextAnalysis.topic || 'allgemein'; // 🚨 ENTFERNT: Bereits in Zeile 337 deklariert
    // const keyPoints = contextAnalysis.keyPoints || []; // 🚨 ENTFERNT: Bereits in Zeile 338 deklariert
    // queryText wurde bereits in Zeile 339 deklariert, aber wir müssen es möglicherweise neu setzen
    
    // 🚨🚨🚨 NEU: Verbesserte Query-Generierung mit Antwort-Patterns (GENERISCH für alle Situationen)
    // Extrahiere erwartete Antwort-Patterns basierend auf Situationen
    function extractAnswerPatterns(situations, customerMessage) {
      const patterns = [];
      const lowerMsg = customerMessage.toLowerCase();
      
      // Treffen-Anfrage: Erwartete Antwort-Patterns
      if (situations.includes("Treffen/Termine")) {
        patterns.push("morgen kann ich leider nicht aber was würdest du gerne machen");
        patterns.push("geht leider nicht aber besser kennenlernen bevor wir uns sehen");
        patterns.push("treffen ablehnen Alternative Frage stellen");
        patterns.push("vorher kennenlernen was hast du vor");
        // Füge auch Kundennachricht-Kontext hinzu
        if (lowerMsg.includes("morgen")) {
          patterns.push("morgen geht es bei mir leider nicht aber");
        }
        if (lowerMsg.includes("treffen")) {
          patterns.push("treffen ausmachen ablehnen was möchtest du");
        }
      }
      
      // Kontaktdaten außerhalb: Erwartete Antwort-Patterns
      if (situations.includes("Kontaktdaten außerhalb der Plattform")) {
        patterns.push("hier bleiben quatschen kennenlernen");
        patterns.push("hier weiter schreiben besser kennenlernen");
        patterns.push("nummer nicht rausgeben was suchst du hier");
        patterns.push("schnell nummer nicht rausgeben was suchst du");
        patterns.push("ablehnen spezifische frage stellen");
        patterns.push("was du eigentlich genau hier suchst");
        patterns.push("was du vorhast interessiert");
      }
      
      // Sexuelle Themen: Erwartete Antwort-Patterns
      if (situations.some(s => s.toLowerCase().includes('sexuell'))) {
        patterns.push("was magst du denn so vorlieben");
        patterns.push("was würdest du gerne machen ausprobieren");
      }
      
      // Berufsfrage: Erwartete Antwort-Patterns
      if (situations.includes("Beruf") || lowerMsg.includes("arbeit") || lowerMsg.includes("beruf")) {
        patterns.push("beruf erzählen arbeiten");
      }
      
      // Geld/Coins: Erwartete Antwort-Patterns
      if (situations.includes("Geld/Coins")) {
        patterns.push("freundlich ausweichen Thema wechseln");
      }
      
      return patterns;
    }
    
    const answerPatterns = extractAnswerPatterns(situations || [], customerMessage);
    const hasMeetingRequest = situations && situations.includes("Treffen/Termine");
    
    if (hasMeetingRequest) {
      // Bei Treffen-Anfragen: Fokussiere auf Treffen-spezifische Semantik + Antwort-Patterns
      const patternPart = answerPatterns.length > 0 ? ` Antwort: ${answerPatterns.join(' ')}` : '';
      queryText = `Treffen Termine Besuch vorbeikommen zu mir zu dir: ${customerMessage.substring(0, 200)}${patternPart}`;
      console.log(`🚨 Vector-DB-Suche: Treffen-Anfrage erkannt - fokussiere auf Treffen-spezifische Beispiele + Antwort-Patterns`);
    } else {
      // 🚨 NEU: Generell: Füge Antwort-Patterns zur Query hinzu
      const patternPart = answerPatterns.length > 0 ? ` Antwort: ${answerPatterns.join(' ')}` : '';
      queryText = `${topic}: ${keyPoints.join(', ')}: ${customerMessage.substring(0, 200)}${patternPart}`;
      if (answerPatterns.length > 0) {
        console.log(`🚨 Vector-DB-Suche: Antwort-Patterns hinzugefügt (${answerPatterns.length} Patterns)`);
      }
    }

    // Use existing vector search if available
    let vectorResults = null; // 🚨 WICHTIG: Außerhalb des if-Blocks deklarieren, damit es später verfügbar ist
    if (vectorDbFunc && typeof vectorDbFunc === 'function') {
      try {
        // 🚨 OPTION 1: Reine semantische Suche OHNE Situation-Filter
        // Situationen werden nur für Regeln/Kontext verwendet, NICHT für Training-Daten-Filterung
        // Die Vector-DB ist bereits semantisch und findet die besten Beispiele basierend auf der Kundennachricht
        
        // 🚨🚨🚨 NEU: Bei Treffen-Anfragen: Zwei separate Suchen für bessere Ergebnisse
        if (hasMeetingRequest) {
          // Primär: Suche nach Treffen-Beispielen (topK: 25)
          const meetingResults = await vectorDbFunc(queryText, {
            topK: 25,
            minSimilarity: 0.25,
            situation: "Treffen/Termine" // 🚨 Explizit nach Treffen-Beispielen suchen!
          });
          
          // Sekundär: Suche nach anderen relevanten Beispielen (topK: 15)
          const otherResults = await vectorDbFunc(`${topic}: ${keyPoints.join(', ')}: ${customerMessage.substring(0, 200)}`, {
            topK: 15,
            minSimilarity: 0.25,
            situation: null
          });
          
          // Kombiniere Ergebnisse: Treffen-Beispiele zuerst, dann andere
          vectorResults = [...(meetingResults || []), ...(otherResults || [])];
          console.log(`✅ Vector-DB-Suche: ${meetingResults?.length || 0} Treffen-Beispiele + ${otherResults?.length || 0} andere Beispiele = ${vectorResults.length} total`);
        } else {
          // Normale Suche (keine Treffen-Anfrage)
          const topK = isASA ? 40 : 40; // Erhöht von 30 auf 40 für mehr relevante Beispiele
          vectorResults = await vectorDbFunc(queryText, {
            topK: topK,
            minSimilarity: 0.25, // Niedrigere Schwelle für mehr Kandidaten
            situation: null // 🚨 KEINE Situation-Filterung - rein semantische Suche basierend auf Kundennachricht
          });
        }

        if (vectorResults && vectorResults.length > 0) {
          let filteredResults = vectorResults;
          
          // 🚨 OPTION 1: KEINE Situation-Filterung mehr!
          // Die Vector-DB findet bereits die besten semantisch ähnlichen Beispiele basierend auf der Kundennachricht
          // Situationen werden nur noch für Regeln/Kontext verwendet, nicht für Daten-Auswahl
          
          // 🤖 ASA-UNTERSTÜTZUNG: Filtere ASA-Beispiele basierend auf Kontext
          if (isASA && conversationContext) {
            const contextLower = conversationContext.toLowerCase();
            
            // Prüfe ob Kunde Nummer/Treffen will oder nicht
            const hasNegativeNumberSignals = (
              contextLower.includes("nummer nicht") || 
              contextLower.includes("keine nummer") || 
              contextLower.includes("nummer nicht raus")
            );
            const hasPositiveNumberSignals = (
              contextLower.includes("deine nummer") ||
              contextLower.includes("ihre nummer") ||
              contextLower.includes("nummer geben")
            );
            const customerWantsNumber = hasPositiveNumberSignals && !hasNegativeNumberSignals;
            
            const hasNegativeMeetingSignals = (
              contextLower.includes("treffen nicht") || 
              contextLower.includes("kein treffen")
            );
            const hasPositiveMeetingSignals = (
              contextLower.includes("treffen wollen") || 
              contextLower.includes("treffen können")
            );
            const customerWantsMeeting = hasPositiveMeetingSignals && !hasNegativeMeetingSignals;
            
            // Filtere ASA-Beispiele basierend auf Kontext
            filteredResults = vectorResults.filter(example => {
              const response = (example.moderatorResponse || "").toLowerCase();
              
              // Wenn Kunde keine Nummer will, filtere Nummern-Beispiele raus
              if (!customerWantsNumber && (response.includes("nummer") || response.includes("telefon") || response.includes("handy"))) {
                return false;
              }
              
              // Wenn Kunde kein Treffen will, filtere Treffen-Beispiele raus
              if (!customerWantsMeeting && (response.includes("treffen") || response.includes("sehen") || response.includes("kennenlernen"))) {
                return false;
              }
              
              // Prüfe ob es ein ASA-Beispiel ist
              const situation = (example.situation || "").toLowerCase();
              return situation.includes("asa") || situation.includes("reaktivierung") || 
                     response.includes("warum schreibst") || 
                     response.includes("warum antwortest") ||
                     response.includes("nicht mehr") ||
                     response.includes("kein interesse") ||
                     response.includes("verloren") ||
                     response.includes("funkstille") ||
                     response.includes("hängen lassen");
            });
            
            // 🚨 WICHTIG: KEIN Fallback für ASA! Wenn keine ASA-Beispiele gefunden werden, bleibt filteredResults leer
            // Das verhindert Account-Sperrung durch Fallback-Nachrichten
            if (filteredResults.length > 0) {
              console.log(`🤖 Agent: Training-Selector - ${filteredResults.length} ASA-Beispiele nach Kontext-Filterung (von ${vectorResults.length})`);
            } else {
              console.warn(`⚠️ Agent: Training-Selector - KEINE ASA-Beispiele gefunden! Kein Fallback verwendet (verhindert Account-Sperrung).`);
            }
          }
          
          console.log(`✅ Agent: Training-Selector - ${filteredResults.length} Beispiele via Vector-DB (rein semantische Suche)${isASA ? ' (ASA-Modus)' : ''}`);
          
          // 🚨🚨🚨 NEU: HYBRID-SCORING-SYSTEM 🚨🚨🚨
          // Kombiniert: Semantische Similarity + Feedback-Score + Kontext-Relevanz
          
          // Hilfsfunktion: Berechne Feedback-Score für ein Beispiel
          const calculateFeedbackScore = (example) => {
            if (!learningContextResult || !learningContextResult.learningStats) {
              return 0; // Kein Feedback verfügbar
            }
            
            const learningStats = learningContextResult.learningStats;
            const exampleId = example.id || example._id || null;
            const exampleText = (example.moderatorResponse || '').substring(0, 100).toLowerCase();
            
            // 🚨🚨🚨 NEU: Nutze Beispiel-Performance (examplePerformance) statt exampleFeedback
            // Das ist genauer, weil es situationsspezifisch ist!
            if (learningStats.examplePerformance && exampleId) {
              const examplePerf = learningStats.examplePerformance[exampleId];
              
              // Prüfe ob es Performance-Daten für die aktuelle Situation gibt
              if (situations && situations.length > 0) {
                for (const situation of situations) {
                  if (examplePerf && examplePerf[situation]) {
                    const perf = examplePerf[situation];
                    if (perf.total > 0) {
                      // Erfolgsrate: 0 (schlecht) bis 1 (gut)
                      // Konvertiere zu -1..1 für Konsistenz
                      const successRate = (perf.successRate * 2) - 1; // 0..1 → -1..1
                      console.log(`📊 Beispiel-Performance gefunden: Beispiel ${exampleId} in Situation "${situation}": Erfolgsrate ${(perf.successRate * 100).toFixed(0)}% (${perf.good} gut, ${perf.bad} schlecht)`);
                      return successRate;
                    }
                  }
                }
              }
              
              // Fallback: Prüfe "allgemein" Situation
              if (examplePerf && examplePerf['allgemein']) {
                const perf = examplePerf['allgemein'];
                if (perf.total > 0) {
                  const successRate = (perf.successRate * 2) - 1; // 0..1 → -1..1
                  return successRate * 0.7; // Reduziere Score für allgemeine Situation
                }
              }
            }
            
            // 🚨 LEGACY: Fallback zu altem exampleFeedback-System (für Rückwärtskompatibilität)
            if (learningStats.exampleFeedback && exampleId) {
              const feedback = learningStats.exampleFeedback[exampleId];
              if (feedback) {
                const total = feedback.good + feedback.bad + feedback.neutral;
                if (total > 0) {
                  const successRate = (feedback.good - feedback.bad) / total;
                  return successRate * 0.5; // Reduziere Score für Legacy-Daten
                }
              }
            }
            
            return 0; // Kein Feedback gefunden
          };
          
          // Hilfsfunktion: Berechne Kontext-Relevanz
          const calculateContextRelevance = (example) => {
            let relevance = 0.5; // Basis-Relevanz
              
              // Prüfe Situation-Match
            if (situations && situations.length > 0 && example.situation) {
              const exampleSituation = (example.situation || '').toLowerCase();
              const hasMatchingSituation = situations.some(s => 
                exampleSituation.includes(s.toLowerCase()) || s.toLowerCase().includes(exampleSituation)
              );
              if (hasMatchingSituation) {
                relevance += 0.3; // Situation-Match erhöht Relevanz
              }
            }
            
            // 🚨 NEU: Prüfe ob Beispiel in ähnlichen Situationen gut performt hat
            if (learningContextResult && learningContextResult.learningStats) {
              const learningStats = learningContextResult.learningStats;
              
              // Prüfe Situation-Feedback
              if (learningStats.situationFeedback && situations && situations.length > 0) {
                for (const situation of situations) {
                  const situationFeedback = learningStats.situationFeedback[situation];
                  if (situationFeedback && example.situation && 
                      (example.situation.toLowerCase().includes(situation.toLowerCase()) ||
                       situation.toLowerCase().includes(example.situation.toLowerCase()))) {
                    // Wenn Beispiel in dieser Situation gut performt hat
                    const total = situationFeedback.good + situationFeedback.bad;
                    if (total > 0) {
                      const successRate = (situationFeedback.good - situationFeedback.bad) / total;
                      relevance += successRate * 0.2; // Erfolgsrate erhöht Relevanz
                    }
                  }
                }
              }
              
              // 🚨 NEU: Prüfe Topic-Match (aus contextAnalysis)
              if (contextAnalysis && contextAnalysis.topic && example.situation) {
                const topic = contextAnalysis.topic.toLowerCase();
                const exampleSituation = (example.situation || '').toLowerCase();
                if (topic === 'sexuell' && exampleSituation.includes('sexuell')) {
                  relevance += 0.15; // Topic-Match erhöht Relevanz
                } else if (topic === 'allgemein' && !exampleSituation.includes('sexuell') && !exampleSituation.includes('treffen')) {
                  relevance += 0.15;
                }
              }
              
              // 🚨 NEU: Prüfe ob Beispiel für ähnliche Kundennachrichten gut performt hat
              if (learningStats.messagePatternFeedback && customerMessage) {
                const messageLower = customerMessage.toLowerCase();
                const messageWords = messageLower.split(/\s+/).filter(w => w.length > 3);
                
                // Suche nach ähnlichen Nachrichten in Feedback
                for (const [pattern, feedback] of Object.entries(learningStats.messagePatternFeedback)) {
                  const patternWords = pattern.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                  const commonWords = messageWords.filter(w => patternWords.includes(w));
                  const similarity = commonWords.length / Math.max(messageWords.length, patternWords.length, 1);
                  
                  if (similarity > 0.4) {
                    // Ähnliche Nachricht gefunden - prüfe ob Beispiel in diesem Kontext gut war
                    const total = feedback.good + feedback.bad;
                    if (total > 0) {
                      const successRate = (feedback.good - feedback.bad) / total;
                      relevance += successRate * 0.1 * similarity; // Gewichtet nach Ähnlichkeit
                    }
                  }
                }
              }
            }
            
            return Math.min(1, Math.max(0, relevance)); // Normalisiere auf 0-1
          };
          
          // 🚨 NEU: Adaptive Gewichtung basierend auf Feedback-Qualität
          // Wenn viele Beispiele mit gutem Feedback vorhanden sind, erhöhe Feedback-Gewichtung
          const adaptiveWeighting = () => {
            let goodFeedbackCount = 0;
            let totalFeedbackCount = 0;
            
            filteredResults.forEach(example => {
              const feedbackScore = calculateFeedbackScore(example);
              if (feedbackScore !== 0) {
                totalFeedbackCount++;
                if (feedbackScore > 0) {
                  goodFeedbackCount++;
                }
              }
            });
            
            if (totalFeedbackCount > 0) {
              const goodFeedbackRatio = goodFeedbackCount / totalFeedbackCount;
              
              // Wenn viele gute Feedbacks vorhanden sind, erhöhe Feedback-Gewichtung
              if (goodFeedbackRatio > 0.6) {
                return { semantic: 0.3, feedback: 0.5, context: 0.2 }; // Mehr Gewicht auf Feedback
              } else if (goodFeedbackRatio < 0.3) {
                return { semantic: 0.5, feedback: 0.3, context: 0.2 }; // Mehr Gewicht auf Semantik
              }
            }
            
            return { semantic: 0.4, feedback: 0.4, context: 0.2 }; // Standard-Gewichtung
          };
          
          const weights = adaptiveWeighting();
          
          // Berechne Hybrid-Score für jedes Beispiel
          filteredResults.forEach(example => {
            const semanticScore = example.similarity || 0; // 0-1
            const feedbackScore = calculateFeedbackScore(example); // -1 bis +1, normalisiert zu 0-1
            const contextRelevance = calculateContextRelevance(example); // 0-1
            
            // Normalisiere Feedback-Score von -1..1 zu 0..1
            const normalizedFeedbackScore = (feedbackScore + 1) / 2;
            
            // Hybrid-Score: Adaptive Gewichtung basierend auf Feedback-Qualität
            const hybridScore = (semanticScore * weights.semantic) + 
                               (normalizedFeedbackScore * weights.feedback) + 
                               (contextRelevance * weights.context);
            
            example.hybridScore = hybridScore;
            example.semanticScore = semanticScore;
            example.feedbackScore = normalizedFeedbackScore;
            example.contextRelevance = contextRelevance;
          });
          
          // Sortiere nach Hybrid-Score (höher = besser)
          filteredResults.sort((a, b) => {
            return (b.hybridScore || 0) - (a.hybridScore || 0);
          });
          
          // Log Top 5 Beispiele mit ihren Scores
          const top5 = filteredResults.slice(0, 5);
          console.log(`🧠 Hybrid-Scoring: Top 5 Beispiele:`);
          top5.forEach((ex, idx) => {
            console.log(`  ${idx + 1}. Hybrid: ${(ex.hybridScore || 0).toFixed(3)} (Sem: ${(ex.semanticScore || 0).toFixed(3)}, FB: ${(ex.feedbackScore || 0).toFixed(3)}, Ctx: ${(ex.contextRelevance || 0).toFixed(3)})`);
          });
          
          const selectedExamples = filteredResults.slice(0, isASA ? 20 : 15); // Mehr Beispiele für bessere Qualität
          
          // Generiere trainingExamplesContext mit allen Anweisungen
          const trainingExamplesContext = buildTrainingExamplesContext(
            selectedExamples, 
            isASA, 
            situations || [], 
            learningContextResult,
            false, // hasSexualContent wird später vom Situation-Detector übergeben
            null // lastModeratorMessage wird später vom Style-Analyst übergeben
          );
          
          return {
            selectedExamples,
            trainingExamplesContext,
            reason: `Vector-DB: ${filteredResults.length} ähnliche Beispiele gefunden${isASA ? ' (ASA)' : ''}`,
            method: 'vector-db',
            success: true,
            isASA: isASA,
            // 🚨 NEU: Speichere Beispiel-IDs für Feedback-Tracking
            exampleIds: selectedExamples.map(ex => ex.id || ex._id || null).filter(id => id !== null),
            exampleTexts: selectedExamples.map(ex => (ex.moderatorResponse || '').substring(0, 100)),
            hybridScores: selectedExamples.map(ex => ({
              hybrid: ex.hybridScore || 0,
              semantic: ex.semanticScore || 0,
              feedback: ex.feedbackScore || 0,
              context: ex.contextRelevance || 0
            })),
            // 🚨 NEU: Speichere Vector-Suche-Ergebnisse für Fallback-Modus-Prüfung
            vectorSearchResults: filteredResults.map(ex => ({
              similarity: ex.similarity || ex.semanticScore || 0,
              customerMessage: ex.customerMessage,
              moderatorResponse: ex.moderatorResponse
            }))
          };
        }
      } catch (err) {
        console.warn('⚠️ Agent: Training-Selector - Vector-DB Fehler:', err.message);
      }
    }
    
    // 🚨 ENTFERNT: ASA-Fallback nicht mehr nötig, da ASA jetzt direkt am Anfang behandelt wird
  } catch (err) {
    console.warn('⚠️ Agent: Training-Selector - Fehler:', err.message);
  }

  // 🚨 WICHTIG: KEIN Fallback für ASA! Wenn keine Beispiele gefunden wurden, return mit leeren Beispielen
  // Das verhindert Account-Sperrung durch Fallback-Nachrichten (2x Fallback = Account gesperrt)
  if (isASA) {
    console.warn('⚠️ Agent: Training-Selector - Keine ASA-Beispiele gefunden! KEIN Fallback verwendet (verhindert Account-Sperrung).');
  return {
    selectedExamples: [],
      trainingExamplesContext: '',
      reason: 'Keine ASA-Beispiele gefunden - KEIN Fallback (verhindert Account-Sperrung)',
      method: 'no-fallback',
      success: false,
      isASA: isASA
    };
  }

  // Fallback: Leere Liste (nur für NICHT-ASA-Fälle)
  return {
    selectedExamples: [],
    trainingExamplesContext: '',
    reason: 'Keine Beispiele gefunden - verwende Keyword-Matching als Fallback',
    method: 'fallback',
    success: false,
    isASA: isASA
  };
}

/**
 * Helper: Baut trainingExamplesContext mit allen Anweisungen
 */
function buildTrainingExamplesContext(relevantExamples, isASA, detectedSituations, learningContextResult, hasSexualContent = false, lastModeratorMessage = null) {
  if (!relevantExamples || relevantExamples.length === 0) {
    return '';
  }
  
  // 🚨 NEU: Trenne positive und negative Beispiele
  const positiveExamples = relevantExamples.filter(ex => !ex.isNegativeExample);
  const negativeExamples = relevantExamples.filter(ex => ex.isNegativeExample);
  
  let trainingExamplesContext = '';
  
  if (isASA) {
    // ASA-spezifischer Context
    // 🚨 NEU: Extrahiere ALLE Fragen aus ASA-Beispielen
    const allASAQuestions = [];
    relevantExamples.forEach(example => {
      const responseText = example.moderatorResponse || '';
      const questions = responseText.match(/[^.!?]*\?/g) || [];
      questions.forEach(q => {
        const trimmed = q.trim();
        if (trimmed && !allASAQuestions.includes(trimmed)) {
          allASAQuestions.push(trimmed);
        }
      });
    });
    
    trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT BEI ASA! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: Du schreibst eine REAKTIVIERUNGSNACHRICHT (ASA)! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte ASA-Nachrichten aussehen! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: NUTZE DIE BEISPIELE ALS INSPIRATION - VARIERE NATÜRLICH! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: ANALYSIERE JEDES BEISPIEL - welche Wörter, welcher Ton, welche Formulierungen, welche FRAGEN? 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: KOMBINIERE VERSCHIEDENE BEISPIELE für natürliche Variation - nutze verschiedene Begrüßungen, verschiedene Fragen, verschiedene Formulierungen! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: KOPIERE WORTWAHL UND FORMULIERUNGEN - aber variiere in der STRUKTUR! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
    trainingExamplesContext += `- Verwende die GLEICHEN Wörter und Formulierungen wie in den Beispielen (KOPIERE!)\n`;
    trainingExamplesContext += `- Aber variiere in der Reihenfolge oder Kombination für natürliche Variation\n`;
    trainingExamplesContext += `- Beispiel: Wenn Beispiel zeigt "Ich liebe Doggy. Was magst du?", dann kopiere "Ich liebe Doggy" und "Was magst du?", aber du kannst auch mal "Was magst du? Ich liebe Doggy" sagen\n\n`;
    
    // 🎨🎨🎨 NEU: Explizite Stil-Constraints
    if (relevantExamples.length > 0) {
      const styleFeatures = extractStyleFeatures(relevantExamples);
      if (styleFeatures) {
        trainingExamplesContext += `🎨🎨🎨🎨🎨 EXPLIZITE STIL-ANFORDERUNGEN (ABSOLUT KRITISCH!) 🎨🎨🎨🎨🎨\n\n`;
        trainingExamplesContext += `🚨🚨🚨 KRITISCH: Die Beispiele zeigen dir den GEWÜNSCHTEN STIL - KOPIERE DIESEN STIL! 🚨🚨🚨\n\n`;
        trainingExamplesContext += `📏 SATZBAU:\n`;
        trainingExamplesContext += `- Durchschnittliche Satzlänge in den Beispielen: ${styleFeatures.avgSentenceLength.toFixed(1)} Wörter\n`;
        trainingExamplesContext += `- Durchschnittliche Anzahl Sätze in den Beispielen: ${styleFeatures.avgSentenceCount.toFixed(1)}\n`;
        trainingExamplesContext += `- VERWENDE GLEICHE SATZLÄNGEN wie in den Beispielen (nicht viel kürzer/länger!)\n`;
        trainingExamplesContext += `- VERWENDE GLEICHE ANZAHL SÄTZE wie in den Beispielen\n\n`;
        
        trainingExamplesContext += `🔤 INTERPUNKTION:\n`;
        if (styleFeatures.punctuationPerChar.commas > 0.01) {
          trainingExamplesContext += `- Verwende KOMMAS wie in den Beispielen (${(styleFeatures.punctuationPerChar.commas * 100).toFixed(1)}% pro Zeichen)\n`;
        }
        if (styleFeatures.punctuationPerChar.questions > 0) {
          trainingExamplesContext += `- Stelle FRAGEN wie in den Beispielen (${styleFeatures.punctuationPerChar.questions.toFixed(1)} Fragen pro Satz)\n`;
        }
        trainingExamplesContext += `- VERWENDE GLEICHE INTERPUNKTION wie in den Beispielen (Kommas, Fragezeichen, Punkte)\n\n`;
        
        if (styleFeatures.commonSentenceStarts.length > 0) {
          trainingExamplesContext += `📝 SATZ-ANFÄNGE:\n`;
          trainingExamplesContext += `- Häufige Satz-Anfänge in den Beispielen: ${styleFeatures.commonSentenceStarts.slice(0, 5).map(s => `"${s}"`).join(', ')}\n`;
          trainingExamplesContext += `- VERWENDE ÄHNLICHE SATZ-ANFÄNGE wie in den Beispielen\n\n`;
        }
        
        trainingExamplesContext += `🎭 TON & STIL:\n`;
        trainingExamplesContext += `- Formality-Level in den Beispielen: ${styleFeatures.dominantFormality === 'informal' ? 'INFORMAL (locker, direkt)' : 'FORMAL (höflich, zurückhaltend)'}\n`;
        trainingExamplesContext += `- Directness-Level in den Beispielen: ${styleFeatures.dominantDirectness === 'direct' ? 'DIREKT (direkt, klar)' : 'INDIREKT (vorsichtig, zurückhaltend)'}\n`;
        trainingExamplesContext += `- VERWENDE GLEICHEN TON wie in den Beispielen (${styleFeatures.dominantFormality}, ${styleFeatures.dominantDirectness})\n\n`;
        
        trainingExamplesContext += `🚨🚨🚨 ABSOLUT KRITISCH: KOPIERE DIESEN STIL GENAU! 🚨🚨🚨\n`;
        trainingExamplesContext += `- Satzlängen: GLEICH wie in den Beispielen\n`;
        trainingExamplesContext += `- Interpunktion: GLEICH wie in den Beispielen\n`;
        trainingExamplesContext += `- Ton: GLEICH wie in den Beispielen\n`;
        trainingExamplesContext += `- Satz-Anfänge: ÄHNLICH wie in den Beispielen\n\n`;
      }
    }
    
    // 🚨🚨🚨 NEU: Warnung vor "huhu", wenn Learning-Stats es als schlecht markieren
    if (learningContextResult && learningContextResult.learningStats) {
      const learningStats = learningContextResult.learningStats;
      const huhuStats = learningStats.wordFrequencies && learningStats.wordFrequencies.huhu;
      if (huhuStats && huhuStats.bad > huhuStats.good) {
        trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: VARIATION bei Begrüßungen! 🚨🚨🚨🚨🚨\n`;
        trainingExamplesContext += `- Learning-Stats zeigen: "huhu" wurde ${huhuStats.bad}x als schlecht markiert (nur ${huhuStats.good}x als gut)\n`;
        trainingExamplesContext += `- VERMEIDE "huhu" als Begrüßung - nutze stattdessen: "Hey", "Hallo", "Hallöchen", "Hi", "Na", "Servus", "Moin", "Hey na"\n`;
        trainingExamplesContext += `- Wechsle zwischen verschiedenen Begrüßungen - nutze nicht immer die gleiche!\n\n`;
      }
    }
    
    // 🚨 NEU: Zeige explizit alle Fragen aus ASA-Beispielen
    if (allASAQuestions.length > 0) {
      trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: DIESE FRAGEN WERDEN IN DEN ASA-BEISPIELEN VERWENDET: 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
      allASAQuestions.forEach((q, idx) => {
        trainingExamplesContext += `${idx + 1}. "${q}"\n`;
      });
      trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: VERWENDE NUR DIESE FRAGEN ODER SEHR ÄHNLICHE! KEINE EIGENEN FRAGEN ERFINDEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    }
    
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 WICHTIG FÜR VARIATION: 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
    trainingExamplesContext += `- ✅ NUTZE verschiedene Begrüßungen aus verschiedenen Beispielen (nicht immer die gleiche!)\n`;
    trainingExamplesContext += `- ✅ KOMBINIERE verschiedene Fragen aus verschiedenen Beispielen\n`;
      trainingExamplesContext += `- ✅ KOPIERE die Formulierungen und Wörter - aber variiere in der Struktur/Kombination\n`;
    trainingExamplesContext += `- ✅ Jede Nachricht soll UNIQUE sein - nutze verschiedene Beispiele als Inspiration!\n`;
    trainingExamplesContext += `- ❌ KEINE generischen Fragen wie 'Was denkst du?', 'Wie geht es dir?', 'Was machst du?' - NUR Fragen aus den ASA-Beispielen!\n`;
    trainingExamplesContext += `- ❌ KEINE eigenen Fragen erfinden - NUR Fragen aus den Training-Daten verwenden!\n\n`;
  } else if (hasSexualContent) {
    trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT BEI SEX-GESPRÄCHEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Du schreibst in einem SEXUELLEN Gespräch! 🚨🚨🚨🚨🚨\n\n`;
    if (lastModeratorMessage) {
      trainingExamplesContext += `🚨🚨🚨🚨🚨 WICHTIG: Kombiniere BEIDES! 🚨🚨🚨🚨🚨\n`;
      trainingExamplesContext += `- Training-Daten zeigen dir QUALITÄT und geile Formulierungen für Sex-Gespräche\n`;
      trainingExamplesContext += `- Die letzte Moderator-Nachricht (siehe unten) zeigt dir den STIL für DIESEN Chat (für Stil-Kontinuität)\n`;
      trainingExamplesContext += `- Training-Daten haben HÖCHSTE PRIORITÄT für Qualität/Formulierungen!\n`;
      trainingExamplesContext += `- Letzte Moderator-Nachricht dient NUR für Stil-Kontinuität innerhalb dieses Chats!\n\n`;
    }
    trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte Chat-Replies bei SEX-Gesprächen aussehen! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 WICHTIG: Bei Sex-Gesprächen musst du RADIKALER sein - direkt, roh, spontan, ohne bewertende Phrasen! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Verwende die GLEICHEN Wörter und Formulierungen wie in den Beispielen! 🚨🚨🚨🚨🚨\n\n`;
    
    // 🎨🎨🎨 NEU: Explizite Stil-Constraints für Sex-Gespräche
    if (relevantExamples.length > 0) {
      const styleFeatures = extractStyleFeatures(relevantExamples);
      if (styleFeatures) {
        trainingExamplesContext += `🎨🎨🎨 STIL-ANFORDERUNGEN: VERWENDE GLEICHE SATZLÄNGEN (${styleFeatures.avgSentenceLength.toFixed(1)} Wörter), GLEICHE INTERPUNKTION, GLEICHEN TON (${styleFeatures.dominantFormality}, ${styleFeatures.dominantDirectness}) wie in den Beispielen! 🎨🎨🎨\n\n`;
      }
    }
  } else {
    trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Training-Daten + Learning-System sind die HAUPTQUELLE für Stil, Formulierungen, Struktur und Fragen! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: Training-Daten zeigen dir konkrete Beispiele - Learning-System zeigt dir bewährte Muster und statistische Ziele! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: Orientiere dich STRENG an den Training-Daten - übernehme Wortwahl, Ton, Formulierungen und Struktur! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    
    // 🎨🎨🎨 NEU: Explizite Stil-Constraints für normale Gespräche
    if (relevantExamples.length > 0) {
      const styleFeatures = extractStyleFeatures(relevantExamples);
      if (styleFeatures) {
        trainingExamplesContext += `🎨🎨🎨🎨🎨 EXPLIZITE STIL-ANFORDERUNGEN (ABSOLUT KRITISCH!) 🎨🎨🎨🎨🎨\n\n`;
        trainingExamplesContext += `📏 SATZBAU: VERWENDE GLEICHE SATZLÄNGEN (${styleFeatures.avgSentenceLength.toFixed(1)} Wörter) und GLEICHE ANZAHL SÄTZE (${styleFeatures.avgSentenceCount.toFixed(1)}) wie in den Beispielen!\n\n`;
        trainingExamplesContext += `🔤 INTERPUNKTION: VERWENDE GLEICHE INTERPUNKTION (Kommas, Fragezeichen) wie in den Beispielen!\n\n`;
        trainingExamplesContext += `🎭 TON: VERWENDE GLEICHEN TON (${styleFeatures.dominantFormality}, ${styleFeatures.dominantDirectness}) wie in den Beispielen!\n\n`;
        trainingExamplesContext += `🚨🚨🚨 KRITISCH: KOPIERE DIESEN STIL GENAU - nicht erfinden! 🚨🚨🚨\n\n`;
      }
    }
    if (lastModeratorMessage) {
      trainingExamplesContext += `🚨🚨🚨 WICHTIG: Kombiniere BEIDES! 🚨🚨🚨\n`;
      trainingExamplesContext += `- Training-Daten zeigen dir QUALITÄT, Formulierungen und bewährte Muster (HÖCHSTE PRIORITÄT!)\n`;
      trainingExamplesContext += `- Die letzte Moderator-Nachricht (siehe unten) zeigt dir den STIL für DIESEN Chat (für Stil-Kontinuität)\n`;
      trainingExamplesContext += `- Training-Daten haben HÖCHSTE PRIORITÄT - letzte Nachricht dient NUR für Stil-Kontinuität!\n\n`;
    }
    trainingExamplesContext += `Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte Chat-Replies aussehen:\n\n`;
  }
  
  // Zeige positive Beispiele (RICHTIG)
  if (positiveExamples.length > 0) {
    trainingExamplesContext += `\n✅✅✅ RICHTIGE BEISPIELE (SO SOLLST DU ES MACHEN): ✅✅✅\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: VARIATION! 🚨🚨🚨🚨🚨\n`;
    trainingExamplesContext += `- Es werden ${positiveExamples.length} Beispiele gezeigt\n`;
    trainingExamplesContext += `- Nutze VERSCHIEDENE Beispiele - nicht immer das gleiche!\n`;
    trainingExamplesContext += `- Wechsle ab zwischen verschiedenen Beispielen für natürliche Variation!\n`;
    trainingExamplesContext += `- Auch wenn ein Beispiel besonders gut ist - nutze auch andere für Variation!\n\n`;
    positiveExamples.forEach((example, idx) => {
      const exampleNum = idx + 1;
      const isPriority = idx < 5;
      trainingExamplesContext += `${isPriority ? '🚨🚨🚨🚨🚨 ABSOLUT HÖCHSTE PRIORITÄT - BEISPIEL ' : 'Beispiel '}${exampleNum}${isPriority ? ' (BESONDERS RELEVANT - KOPIERE DEN STIL, DIE WORTWAHL, DEN TON!)' : ''}:\n`;
      trainingExamplesContext += `Kunde: "${example.customerMessage || ''}"\n`;
      trainingExamplesContext += `Moderator/Fake Antwort: "${example.moderatorResponse || ''}"\n`;
      if (example.situation && example.situation !== 'allgemein') {
        trainingExamplesContext += `Situation: ${example.situation}\n`;
      }
      // 🚨 NEU: Zeige Begründung (explanation), wenn vorhanden
      if (example.explanation && example.explanation.trim() !== '') {
        trainingExamplesContext += `🧠 BEGRÜNDUNG (WARUM diese Antwort gut ist): ${example.explanation}\n`;
        trainingExamplesContext += `🚨 KRITISCH: Nutze diese Begründung, um zu verstehen, WARUM diese Antwort gut ist! 🚨\n`;
      }
      if (isPriority) {
        trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Dieses Beispiel ist besonders relevant - KOPIERE die Wortwahl, den Ton und die Formulierungen GENAU! 🚨🚨🚨🚨🚨\n`;
        trainingExamplesContext += `🚨🚨🚨 ANALYSIERE: Welche Wörter werden verwendet? Welcher Ton? Welche Formulierungen? Welche FRAGEN werden gestellt? KOPIERE ES! 🚨🚨🚨\n`;
        const responseText = example.moderatorResponse || '';
        const questions = responseText.match(/[^.!?]*\?/g) || [];
        if (questions.length > 0) {
          if (isASA) {
            trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - FRAGEN IN DIESEM BEISPIEL: ${questions.map(q => `"${q.trim()}"`).join(', ')} - VERWENDE GENAU DIESE FRAGEN ODER SEHR ÄHNLICHE! KEINE EIGENEN ERFINDEN! 🚨🚨🚨🚨🚨\n`;
          } else {
          trainingExamplesContext += `🚨🚨🚨 FRAGEN IN DIESEM BEISPIEL: ${questions.map(q => `"${q.trim()}"`).join(', ')} - VERWENDE ÄHNLICHE FRAGEN! 🚨🚨🚨\n`;
          }
        }
      }
      trainingExamplesContext += `\n`;
    });
  }
  
  // 🚨 NEU: Zeige negative Beispiele (FALSCH - SO NICHT!)
  if (negativeExamples.length > 0) {
    trainingExamplesContext += `\n\n🚫🚫🚫 FALSCHE BEISPIELE (SO NICHT - VERMEIDE DIESE ANTWORTEN!): 🚫🚫🚫\n\n`;
    trainingExamplesContext += `🚨🚨🚨 KRITISCH: Diese Beispiele zeigen, was du NICHT tun sollst! 🚨🚨🚨\n`;
    trainingExamplesContext += `- Analysiere, was an diesen Antworten FALSCH ist\n`;
    trainingExamplesContext += `- Vermeide diese Formulierungen, diesen Ton und diese Reaktionen\n`;
    trainingExamplesContext += `- Verwende stattdessen die RICHTIGEN Beispiele oben!\n\n`;
    
    negativeExamples.forEach((example, idx) => {
      const exampleNum = idx + 1;
      trainingExamplesContext += `❌ FALSCHES BEISPIEL ${exampleNum} (SO NICHT!):\n`;
      trainingExamplesContext += `Kunde: "${example.customerMessage || ''}"\n`;
      trainingExamplesContext += `Moderator/Fake Antwort (FALSCH): "${example.moderatorResponse || ''}"\n`;
      if (example.situation && example.situation !== 'allgemein') {
        trainingExamplesContext += `Situation: ${example.situation}\n`;
      }
      trainingExamplesContext += `🚫🚫🚫 KRITISCH: Diese Antwort ist FALSCH - verwende sie NICHT! 🚫🚫🚫\n`;
      trainingExamplesContext += `- Analysiere, was hier falsch ist (z.B. zu generisch, falscher Ton, falsche Reaktion)\n`;
      trainingExamplesContext += `- Verwende stattdessen die RICHTIGEN Beispiele oben!\n\n`;
    });
  }
  
  // 🚨 WICHTIG: Learning-Context wird jetzt SEPARAT und PROMINENT im User-Prompt platziert (VOR Training-Daten)
  // Daher hier NICHT mehr hinzufügen, um Duplikate zu vermeiden
  // Learning-Context wird in agentMessageGenerator direkt nach Multi-Situation Instructions platziert
  
  // Abschluss-Anweisungen
  if (hasSexualContent) {
    trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH BEI SEX-GESPRÄCHEN: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ANALYSIERE JEDES BEISPIEL GENAU: 🚨🚨🚨
- Welche Wörter werden verwendet? (z.B. "geil", "heiß", "mega", "richtig", "total", etc.)
- Welcher Ton wird verwendet? (direkt, roh, spontan, ohne Umschweife!)
- Welche Formulierungen werden verwendet? (KEINE "Ich finde es schön", KEINE "Das klingt", KEINE bewertenden Phrasen!)
- Welche FRAGEN werden gestellt? (z.B. "was würdest du noch gerne machen", "welche Stellungen", "was magst du", etc.)
- Wie werden sexuelle Themen angesprochen? (direkt, ohne Erklärungen, ohne Meta-Kommentare!)

🚨🚨🚨 ÜBERNEHME DIE WORTWAHL UND FRAGEN AUS DEN TRAINING-DATEN: 🚨🚨🚨
- Verwende die GLEICHEN Wörter wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!
- Verwende die GLEICHEN FRAGEN wie in den Beispielen (z.B. "was würdest du noch gerne machen", "welche Stellungen", etc.)!
- Verwende den GLEICHEN Ton wie in den Beispielen!
- 🚨 KRITISCH: Wenn du eine Frage stellen willst, SCHAUE IN DIE TRAINING-DATEN - welche Fragen werden dort gestellt? Verwende ÄHNLICHE Fragen!
- 🚨 KRITISCH: KEINE generischen/schlechten Fragen erfinden (z.B. "Was magst du besonders beim Lecken?") - nutze die Fragen aus den Training-Daten!
- KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!

🚨🚨🚨 WENDE AN: 🚨🚨🚨
- Schreibe im GLEICHEN radikalen Stil wie diese Beispiele!
- Verwende die GLEICHE Wortwahl wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!

🚨🚨🚨🚨🚨 KRITISCH: 🚨🚨🚨🚨🚨
- Bei Sex-Gesprächen: RADIKALER, direkter, roher - orientiere dich STRENG an den Training-Daten!
- KEINE bewertenden Phrasen wie "Ich finde es schön", "Das klingt", "interessant", "spannend"!
- 🚨🚨🚨 KRITISCH: KEINE Meta-Kommentare wie "Ich bin gespannt" oder "ich bin schon ganz neugierig" - diese sind VERBOTEN! Stelle einfach die Frage, ohne vorher zu kommentieren!
- 🚨🚨🚨 KRITISCH: Wenn der Kunde FRAGT (z.B. "Was magst du beim Sex?"), DIREKT ANTWORTEN - NICHT die Frage wiederholen, NICHT "Es klingt geil, dass du fragst" sagen, einfach DIREKT antworten wie in Training-Daten! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Beispiel FALSCH: "Es klingt richtig geil, dass du mich verwöhnen möchtest. Ich mag..." 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Beispiel RICHTIG: "Ich mag Oralverkehr und langes Vorspiel. Was magst du?" (direkt, keine Wiederholung!) 🚨🚨🚨
- Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich daran, nicht an generischen Formulierungen!
- 🚨🚨🚨 WORTWAHL AUS TRAINING-DATEN ÜBERNEHMEN - NICHT EIGENE FORMULIERUNGEN ERFINDEN! 🚨🚨🚨
- 🎨🎨🎨 STIL: VERWENDE GLEICHE SATZLÄNGEN, INTERPUNKTION UND TON wie in den Beispielen! 🎨🎨🎨

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - RADIKAL, direkt, roh, spontan, ohne bewertende Phrasen, MIT DER GLEICHEN WORTWAHL WIE IN DEN BEISPIELEN!`;
  } else {
    trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: TRAINING-DATEN HABEN HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨 KRITISCH: TRAINING-DATEN SIND FÜR INHALT, STIL, WORTWAHL, FRAGEN - ALLES! 🚨🚨🚨🚨🚨
- Training-Daten zeigen dir, WIE du antworten sollst (Stil, Wortwahl, Ton, Formulierungen)
- Training-Daten zeigen dir auch, WAS du antworten sollst (Inhalt, Fragen, Reaktionen)
- 🚨 KRITISCH: Nutze Training-Daten für INHALT UND STIL - nicht nur für Stil! 🚨

🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨
- Training-Daten + Learning-System haben HÖCHSTE PRIORITÄT für Stil, Formulierungen und Struktur!
- Analysiere: Wie sind die Antworten strukturiert? Welche FRAGEN werden gestellt? Welche Formulierungen werden verwendet?
- Übernehme: Wortwahl, Ton, Formulierungen und FRAGEN aus den Training-Daten!
- Wende an: Schreibe im GLEICHEN Stil wie diese Beispiele und verwende ÄHNLICHE Fragen!
- 🚨🚨🚨 WICHTIG: KOPIERE WORTWAHL UND FORMULIERUNGEN aus den Beispielen! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Verwende die GLEICHEN Wörter wie in den Beispielen - erfinde KEINE neuen! 🚨🚨🚨
- 🚨🚨🚨 Variation nur in der Struktur/Kombination - nicht in den Formulierungen! 🚨🚨🚨

🚨🚨🚨🚨🚨 KRITISCH: FRAGEN AUS TRAINING-DATEN ÜBERNEHMEN! 🚨🚨🚨🚨🚨
- Wenn du eine Frage stellen willst, SCHAUE IN DIE TRAINING-DATEN - welche Fragen werden dort gestellt?
- Verwende ÄHNLICHE Fragen wie in den Training-Daten (z.B. "was würdest du noch gerne machen", "welche Stellungen", "was magst du", etc.)
- 🚨 KRITISCH: KEINE generischen/schlechten Fragen erfinden (z.B. "Was magst du besonders beim Lecken?")!
- 🚨 KRITISCH: Wenn der Kunde FRAGT (z.B. "Was magst du beim Sex?"), DIREKT ANTWORTEN - NICHT wiederholen, was er gesagt hat, NICHT "Es klingt geil, dass du fragst" sagen!
- 🚨 KRITISCH: Wenn der Kunde schon gesagt hat, was er machen will (z.B. "Ich würde dich verwöhnen"), dann GEHE DARAUF EIN (sage, wie sehr es dir gefallen würde), statt generische Fragen zu stellen! (NUR für Treffen-Anfragen, NICHT für Fragen!)

🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: STRUKTUR-REGELN AUS TRAINING-DATEN BEFOLGEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Wenn Training-Daten eine bestimmte STRUKTUR zeigen, dann FOLGE DIESER STRUKTUR EXAKT! 🚨🚨🚨🚨🚨

📋 STRUKTUR-REGEL 1: UMLENKUNGEN BEI PROBLEMATISCHEN ANFRAGEN (Treffen, WhatsApp, Zeit)
- Wenn Training-Daten zeigen: "Ablehnen → DANN SPEZIFISCHE Frage stellen", dann MACH ES GENAU SO!
- ✅ RICHTIGE STRUKTUR (Treffen): "Freitag passt leider nicht für mich, da ich schon was vor habe. Was würdest du denn gerne machen?" (Ablehnen → spezifische Frage)
- ✅ RICHTIGE STRUKTUR (WhatsApp): "Ich weis aber so schnell gebe ich jetzt auch nicht meine nummer raus, ich würde noch gerne vorher wissen was du eigentlich genau hier suchst?" (Ablehnen → spezifische Frage)
- ❌ FALSCH: "Freitag ist zwar nicht optimal..." (Nur ablehnen, keine Frage!)
- ❌ FALSCH: "Was möchtest du denn noch wissen?" (zu generisch!)
- 🚨 KRITISCH: Bei Treffen/WhatsApp/Zeit-Anfragen IMMER ZUERST ablehnen, DANN eine SPEZIFISCHE Ablenkungsfrage stellen (wie in Training-Daten)!
- 🚨 KRITISCH: Die Ablenkungsfrage muss SPEZIFISCH sein - nicht generisch! Nutze Fragen aus Training-Daten/Learning-System (z.B. "was du eigentlich genau hier suchst", "was du vorhast", "was dich interessiert")!
- 🚨 KRITISCH: Wenn letzte Moderator-Nachricht "mehr erfahren" wollte und Kunde reagiert verwirrt/fragt nach problematischen Dingen → PROAKTIV mit spezifischer Frage umlenken!

📋 STRUKTUR-REGEL 2: JA/NEIN-FRAGEN (z.B. "Hast du schonmal Outdoor-Sex gehabt?", "Magst du Anal?")
- Wenn der Kunde eine JA/NEIN-Frage stellt, dann BEANTWORTE ZUERST mit JA/NEIN, DANN stelle eine Frage!
- ✅ RICHTIGE STRUKTUR: "Ja, das habe ich schonmal gemacht. Was würdest du denn gerne machen?" (Ja/Nein → Frage)
- ✅ RICHTIGE STRUKTUR: "Nein, das habe ich noch nie gemacht, aber es klingt geil. Wie stellst du dir das vor?" (Nein → Frage)
- ❌ FALSCH: "Das klingt geil. Was magst du denn so?" (Kein ja/nein, direkt Frage!)
- 🚨 KRITISCH: Bei JA/NEIN-Fragen IMMER ZUERST die Frage beantworten, DANN eine Frage stellen!

📋 STRUKTUR-REGEL 3: ALLGEMEINE STRUKTUR AUS TRAINING-DATEN
- Wenn Training-Daten zeigen: "Eigener Satz → Frage", dann verwende diese Struktur!
- Wenn Training-Daten zeigen: "Reaktion → Frage", dann verwende diese Struktur!
- Wenn Training-Daten zeigen: "Antwort → Frage", dann verwende diese Struktur!
- 🚨 KRITISCH: KOPIERE die STRUKTUR aus den Training-Daten - nicht nur die Wörter, sondern auch den ABLAUF!

🚨🚨🚨 WICHTIG: Wenn Training-Daten etwas zeigen, dann MACH ES SO - nicht anders! 🚨🚨🚨

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - nicht generisch oder "KI-mäßig"!`;
  }
  
  // 🚨 NEU: ASA-spezifische Abschluss-Anweisungen (NACH dem if/else Block)
  if (isASA) {
    trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH FÜR ASA: ORIENTIERE DICH EXTREM STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨🚨🚨🚨🚨 ANALYSIERE JEDES BEISPIEL GENAU: 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- Welche Wörter werden verwendet? KOPIERE sie GENAU!
- Welcher Ton wird verwendet? KOPIERE ihn GENAU!
- Welche Formulierungen werden verwendet? KOPIERE sie GENAU!
- Welche FRAGEN werden gestellt? KOPIERE sie GENAU oder verwende SEHR ÄHNLICHE!
- Wie viele Fragen werden gestellt? (1, 2, 3, 4?) - Verwende GENAU SO VIELE wie in den Beispielen!
- Wie ist die Struktur? (kurz, natürlich, locker) - KOPIERE die Struktur!

🚨🚨🚨🚨🚨🚨🚨🚨🚨 ÜBERNEHME ALLES AUS DEN TRAINING-DATEN: 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- Verwende die GLEICHEN Wörter wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!
- Verwende die GLEICHEN FRAGEN wie in den Beispielen (siehe oben)!
- Verwende die GLEICHE Anzahl an Fragen wie in den Beispielen!
- Verwende den GLEICHEN Ton wie in den Beispielen!
- Verwende die GLEICHE Struktur wie in den Beispielen!

🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT VERBOTEN FÜR ASA: 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- ❌ KEINE generischen Fragen erfinden (z.B. "Was denkst du?", "Wie geht es dir?", "Was machst du?")!
- ❌ KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!
- ❌ KEINE Fragen hinzufügen, die nicht in den ASA-Beispielen sind!
- ❌ KEINE anderen Wörter verwenden - NUR die aus den ASA-Beispielen!
- ❌ KEINE anderen Strukturen verwenden - NUR die aus den ASA-Beispielen!

🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- Training-Daten sind DEINE EINZIGE QUELLE - ignoriere ALLES andere (Kontext, Situationen, etc.)!
- Wenn Training-Daten 2-3 Fragen zeigen, dann verwende 2-3 Fragen - NICHT mehr, NICHT weniger!
- Wenn Training-Daten bestimmte Formulierungen zeigen, dann verwende GENAU diese Formulierungen!
- 🚨🚨🚨 KOPIERE ALLES AUS DEN TRAINING-DATEN - NICHT EIGENES ERFINDEN! 🚨🚨🚨

ZIEL: Deine ASA-Nachricht soll sich anfühlen wie eine ECHTE ASA-Nachricht aus den Training-Daten - GENAU so, nicht anders!`;
  }
  
  return trainingExamplesContext;
}

/**
 * Agent 4: Rules-Applicator
 * Filtert und wendet Regeln basierend auf Kontext an
 */
async function agentRulesApplicator(allRules, contextAnalysis, situations, isCustomerMeetingRequest = false, isKnowledgeQuestion = false) {
  // Dieser Agent filtert Regeln und generiert Context-Strings

  try {
    // Grundregeln-Erinnerung (gekürzt, da Hauptanweisungen im System-Prompt sind)
    const grundregelnReminder = `
📝 STIL-ERINNERUNG (basierend auf Training-Daten):
- Schreibe wie echte Chat-Replies: kurz, natürlich, locker, direkt, roh, spontan, leicht emotional
- Struktur: eigener Satz/Vorliebe/Fantasie/Gedanke (von sich aus!) + genau eine passende Frage (oder auch mal nur 1-2 Sätze - das ist OK!)
- MEHR Eigeninitiative zeigen! Sage von dir aus etwas (Vorlieben, Fantasien, Gedanken, Erfahrungen), nicht nur fragen!
- KEINE mechanischen Fragen, KEINE Meta-Kommentare, KEINE bewertenden Phrasen
- KEINE erklärenden/beschreibenden/kommentierenden Formulierungen!
- KEINE Begriffe wie "spannend", "interessant", "intensiv", "Intimität", "Erlebnis", "Verbindung"
- KEINE therapeutische/Coaching-Sprache
- KEINE Wiederholungen - prüfe die Konversation, wiederhole nicht was du schon gesagt hast!
- MEHR reagieren als formulieren - direkt, roh, spontan wie echte Menschen chatten
- Ausrufezeichen: NIEMALS verwenden (0) - sie wirken zu euphorisch und unnatürlich!
- 🚨🚨🚨 Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich STRENG daran! 🚨🚨🚨

`;

    // Zusätzliche Allgemeine Regeln aus Dashboard
    let additionalRulesReminder = "";
    if (allRules && allRules.generalRules && allRules.generalRules.trim()) {
      additionalRulesReminder = `\n\n📝 ZUSÄTZLICHE ALLGEMEINE REGELN (aus Dashboard):\n\n${allRules.generalRules}\n\n`;
    }

    let criticalRulesContext = grundregelnReminder + additionalRulesReminder;
    
    // PRIORITÄT 2: TREFFEN & REAL-LIFE-KONTAKT – ABSOLUTE REGEL (HÖCHSTE PRIORITÄT)
    if (isCustomerMeetingRequest) {
      criticalRulesContext += `\n\n🚫🚫🚫 TREFFEN & REAL-LIFE-KONTAKT – HÖCHSTE PRIORITÄT 🚫🚫🚫
🚨 KRITISCH: NIEMALS eine Zusage formulieren! 🚨
- NIEMALS sagen "Ich wäre gerne bereit", "Ich bin bereit", "Ich würde gerne kommen" - das klingt wie eine Zusage!
- Sage stattdessen: "Ich könnte es mir vorstellen", "Ich würde gerne wissen, wie du es dir vorstellst", "Das könnte ich mir vorstellen"
- Frage nach, wie ER es sich vorstellt, aber mache KEINE Zusage!

Du darfst unter KEINEN UMSTÄNDEN:
- ein Treffen vorschlagen oder andeuten
- einem Treffen zustimmen, egal wie indirekt
- Orte oder Aktivitäten für ein Treffen nennen (z. B. Café, Park, Spaziergang, Date)
- Abholen, Vorbeikommen, Besuchen oder "bei dir / bei mir" akzeptieren
- so formulieren, als wäre ein Treffen in Zukunft möglich
- sagen oder implizieren, dass ihr euch "kennenlernen" oder "sehen" werdet

🚨🚨🚨 KRITISCH: DU MUSST AUF DIE TREFFEN-ANFRAGE EINGEHEN - IGNORIERE SIE NICHT! 🚨🚨🚨
- Zeige, dass du die Anfrage VERSTANDEN hast
- Weiche HÖFLICH und SUBTIL aus, aber gehe DARAUF EIN
- 🚨 NEU: Verwende SUBTILE Ausweichstrategien (z.B. "Wir schauen einfach mal wie das dann bei uns passt")
- 🚨 NEU: Wenn Nebenthemen erwähnt werden (z.B. "kochen"), greife diese auf (z.B. "hast du schon eine Idee was kochen würdest?")
- 🚨 NEU: Sei NICHT zu direkt/aggressiv bei Treffen-Anfragen - subtile Antworten sind besser!
- Sage etwas wie: "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen" oder "Wir schauen einfach mal wie das dann bei uns passt"
- Lenke das Thema zurück auf Chat, Gefühle, Persönlichkeit, Fantasie oder Nebenthemen (wie Kochen, Essen, etc.)
- Stelle eine Frage, die zum aktuellen Gespräch passt

VERBOTENE WÖRTER & FORMULIERUNGEN (dürfen NIEMALS vorkommen):
- treffen / Treffen, Date, Café / Cafe, Park, Spaziergang
- abholen / abhole, vorbeikommen / besuchen
- bei dir / bei mir, sehen wir uns
- echtes Leben / real life / im echten Leben

WICHTIG: Diese Regel ist ABSOLUT und hat höchste Priorität! Gehe IMMER auf die Treffen-Anfrage ein, auch wenn du ausweichst! Verwende SUBTILE Ausweichstrategien!`;
    }
    
    // PRIORITÄT 3: WISSENSFRAGEN & ZU SCHLAU WIRKEN – ABSOLUTE REGEL
    if (isKnowledgeQuestion) {
      criticalRulesContext += `\n\n🚫🚫🚫 WISSENSFRAGEN & ZU SCHLAU WIRKEN – HÖCHSTE PRIORITÄT 🚫🚫🚫

Du darfst unter KEINEN UMSTÄNDEN:
- auf allgemeine Wissensfragen antworten (z.B. "erzähl mir was über Amerika", "was ist die Menschheit", "wie funktioniert ein Flugzeug", "wie funktioniert eine Waschmaschine", "wie denken Ameisen")
- technische Dinge erklären (Waschmaschine, Motor, Computer, etc.)
- wissenschaftliche oder biologische Dinge erklären (Tiere, Ameisen, Gehirn, etc.)
- zu schlau oder gebildet wirken
- historische, geographische oder politische Fakten nennen
- wie eine Wissensdatenbank oder ein Lexikon wirken
- lange Erklärungen geben, auch wenn der Kunde danach fragt
- SACHLICH oder WISSENSCHAFTLICH antworten - NIEMALS!

Wenn der Kunde nach allgemeinem Wissen, technischen Dingen, Biologie, Tieren oder wissenschaftlichen Themen fragt:
- Weiche aus - NIEMALS sachlich antworten!
- Sage, dass du das nicht weißt oder nicht interessiert bist
- Lenke das Thema auf persönliche Dinge, Gefühle oder das Gespräch
- NIEMALS wissenschaftliche oder sachliche Erklärungen geben!

WICHTIG: Wirke NICHT zu schlau! Du bist eine normale Person, keine Wissensdatenbank! Weiche IMMER aus, auch wenn der Kunde explizit danach fragt! NIEMALS sachlich oder wissenschaftlich antworten!`;
    }
    
    // Forbidden Words Context (NUR EINMAL - nicht doppelt!)
    let forbiddenWordsContext = "";
    if (allRules && allRules.forbiddenWords && Array.isArray(allRules.forbiddenWords) && allRules.forbiddenWords.length > 0) {
      forbiddenWordsContext = `\n\n❌❌❌❌❌❌❌❌❌ VERBOTENE WÖRTER/PHRASEN (ABSOLUT NIEMALS VERWENDEN!) ❌❌❌❌❌❌❌❌❌\n\nDie folgenden ${allRules.forbiddenWords.length} Wörter/Phrasen sind ABSOLUT VERBOTEN:\n${allRules.forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\n🚨🚨🚨🚨🚨 PROAKTIVE PRÄVENTION - VERWENDE DIESE WÖRTER NIEMALS! 🚨🚨🚨🚨🚨\n\n🚨🚨🚨 KRITISCH: PRÜFE DEINE ANTWORT VOR DEM SCHREIBEN! 🚨🚨🚨\n- Enthält deine Antwort eines dieser Wörter? → DANN SCHREIBE SIE UM!\n- Verwende sie NIEMALS, auch nicht in ähnlicher Form (z.B. "spannend" verboten = auch NICHT "spannende", "spannendes", "spannend!", "spannend?", etc.)\n- Verwende sie NIEMALS als Teil eines anderen Wortes\n- Verwende sie NIEMALS als Variation oder Synonym\n- Verwende sie NIEMALS in Kombination mit anderen Wörtern\n\nBEISPIELE für VERBOTENE Verwendungen:\n- "spannend" verboten → VERBOTEN: "spannende", "spannendes", "spannendste", "spannend!", "das ist spannend", "wie spannend", "total spannend"\n- "Das klingt" verboten → VERBOTEN: "Das klingt gut", "klingt total", "klingt sehr", "klingt nach", "klingt interessant"\n- "reiz" verboten → VERBOTEN: "reiz", "Reiz", "reizvoll", "reizt", "reizende", "reizend"\n\n🚨🚨🚨 KRITISCH: Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen! 🚨🚨🚨\n🚨🚨🚨 KRITISCH: Wenn du eine Antwort generierst, die eines dieser Wörter enthält, dann ist die Antwort FALSCH und muss neu geschrieben werden! 🚨🚨🚨\n🚨🚨🚨 KRITISCH: Wenn du dir unsicher bist, ob ein Wort verboten ist, verwende IMMER eine andere Formulierung! 🚨🚨🚨`;
    }
    
    // Preferred Words Context
    let preferredWordsContext = "";
    if (allRules && allRules.preferredWords && Array.isArray(allRules.preferredWords) && allRules.preferredWords.length > 0) {
      // Prüfe ob es sexuelle Wörter in den bevorzugten Wörtern gibt
      // 🚨 ERWEITERT: Erkenne ALLE sexuellen Wörter aus bevorzugten Wörtern
      const sexualKeywords = ['geil', 'heiß', 'mega', 'fick', 'sex', 'lust', 'titten', 'arsch', 'pussy', 
                             'schwanz', 'richtig', 'total', 'muschi', 'blasen', 'lutschen', 'sperma', 
                             'lecken', 'kitzler', 'vagina', 'penis', 'oral', 'anal', 'doggy', 'horny', 
                             'feucht', 'vorlieben', 'maulfotze', 'fotze', 'ficksahne', 'muschisaft'];
      const sexualWords = allRules.preferredWords.filter(w => {
        const lower = w.toLowerCase();
        return sexualKeywords.some(keyword => lower.includes(keyword));
      });
      
      const hasSexualPreferredWords = sexualWords.length > 0;
      
      preferredWordsContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER - HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\nDie folgenden ${allRules.preferredWords.length} Wörter sind BEVORZUGT und sollten REGELMÄSSIG verwendet werden:\n${allRules.preferredWords.map(w => `- "${w}"`).join('\n')}\n\n${hasSexualPreferredWords ? `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: SEXUELLE WÖRTER IN BEVORZUGTEN WÖRTERN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\nDie folgenden sexuellen Wörter sind BEVORZUGT: ${sexualWords.map(w => `"${w}"`).join(', ')}\n🚨🚨🚨 KRITISCH: Bei Sex-Gesprächen - VERWENDE DIESE WÖRTER REGELMÄSSIG! 🚨🚨🚨\n🚨🚨🚨 KRITISCH: Diese Wörter sind BEVORZUGT - verwende sie, wenn es passt! 🚨🚨🚨\n\n` : ''}🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - VERWENDE DIESE WÖRTER! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n🚨🚨🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER HABEN HÖCHSTE PRIORITÄT NACH TRAINING-DATEN! 🚨🚨🚨🚨🚨\n⭐⭐⭐ WICHTIG: Diese Wörter sind NICHT ohne Grund da - sie wurden basierend auf Feedback und Qualität ausgewählt! ⭐⭐⭐\n⭐ WICHTIG: Integriere diese Wörter NATÜRLICH in deine Antworten, wo sie thematisch passen!\n⭐ Verwende sie REGELMÄSSIG - nicht nur bei Neukunden, sondern IMMER wenn es passt!\n⭐ Diese Wörter helfen dir, natürlicher und passender zu klingen!\n⭐ Orientiere dich an den Training-Daten - dort siehst du, wie diese Wörter verwendet werden!\n⭐ Kombiniere bevorzugte Wörter MIT Training-Daten - beide zusammen = BESTE Qualität!\n\n🚨 KRITISCH: KEIN "random" reinwerfen! NUR wenn es zur Message passt und nicht unnatürlich wirkt!\n🚨 ABER: Wenn ein Preferred Word thematisch passt, dann VERWENDE ES - nicht weglassen!\n${hasSexualPreferredWords ? '🚨🚨🚨🚨🚨 KRITISCH: Bei Sex-Gesprächen - VERWENDE die sexuellen bevorzugten Wörter REGELMÄSSIG! 🚨🚨🚨🚨🚨\n' : ''}🚨🚨🚨 WICHTIG: Bevorzugte Wörter + Training-Daten + Learning-System = BESTE Kombination! 🚨🚨🚨\n\n`;
    }
    
    return {
      applicableForbiddenWords: allRules?.forbiddenWords || [],
      applicablePreferredWords: allRules?.preferredWords || [],
      applicableCriticalRules: allRules?.criticalRules || [],
      criticalRulesContext,
      forbiddenWordsContext,
      preferredWordsContext,
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Rules-Applicator - Fehler:', err.message);
    return {
      applicableForbiddenWords: allRules?.forbiddenWords || [],
      applicablePreferredWords: allRules?.preferredWords || [],
      applicableCriticalRules: allRules?.criticalRules || [],
      criticalRulesContext: '',
      forbiddenWordsContext: '',
      preferredWordsContext: '',
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
    const imageType = result?.imageType || null;
    const description = result?.description || '';
    const cleanDescriptions = description ? [description] : [];
    
    // Generiere imageContext basierend auf Bildtyp
    let imageContext = "";
    if (imageType || description) {
      if (imageType === 'penis') {
        // 🚨 EXPLIZIT: Schwanz-Bild - sehr direkte, sexuelle Reaktion
        imageContext = `\n\n🖼️🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: SCHWANZ-BILD ERKANNT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\nDer Kunde hat ein Bild mit seinem Schwanz/Penis geschickt!\n\n🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - EXPLIZITE REAKTION ERFORDERLICH! 🚨🚨🚨🚨🚨\n- Du MUSST SEHR POSITIV und EXPLIZIT reagieren!\n- Sage, wie GEIL der Schwanz aussieht!\n- Sage, was du gerne mit ihm machen würdest (z.B. Blowjob, Handjob, etc.)!\n- Zeige BEGEISTERUNG und INTERESSE!\n- Sei DIREKT, FLIRTY und SEXUELL begeistert!\n- KEINE neutrale Beschreibung - sei EMOTIONAL und ENTHUSIASTISCH!\n- Stelle eine flirty, sexuelle Frage wie "In welches Loch würdest du ihn dann gerne als erstes schieben bei mir?" oder ähnlich!\n- Die Bildbeschreibung ist: "${cleanDescriptions.join(' ')}"\n\n🚨🚨🚨🚨🚨 WICHTIG: Reagiere JETZT auf das Bild - es ist ein Schwanz-Bild, also sei sehr explizit und begeistert! Stelle eine flirty Frage! 🚨🚨🚨🚨🚨\n`;
      } else if (imageType === 'dildo') {
        // 🚨 EXPLIZIT: Dildo-Bild - sehr direkte, sexuelle Reaktion
        imageContext = `\n\n🖼️🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: DILDO-BILD ERKANNT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\nDer Kunde hat ein Bild mit einem Dildo oder Sexspielzeug geschickt (z.B. Dildo im Arsch, in der Muschi, etc.)!\n\n🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - EXPLIZITE REAKTION ERFORDERLICH! 🚨🚨🚨🚨🚨\n- Du MUSST SEHR POSITIV und EXPLIZIT reagieren!\n- Sage, wie GEIL das aussieht!\n- Sage, was du gerne damit machen würdest (z.B. "würde gerne sehen, wie du damit spielst", "macht mich richtig geil", etc.)!\n- Zeige BEGEISTERUNG und INTERESSE!\n- Sei DIREKT, FLIRTY und SEXUELL begeistert!\n- KEINE neutrale Beschreibung - sei EMOTIONAL und ENTHUSIASTISCH!\n- Stelle eine flirty, sexuelle Frage wie "Würdest du gerne, dass ich dir dabei helfe?" oder ähnlich!\n- Die Bildbeschreibung ist: "${cleanDescriptions.join(' ')}"\n\n🚨🚨🚨🚨🚨 WICHTIG: Reagiere JETZT auf das Bild - es ist ein Dildo-Bild, also sei sehr explizit und begeistert! Stelle eine flirty Frage! 🚨🚨🚨🚨🚨\n`;
      } else if (imageType === 'nude') {
        // 🚨 EXPLIZIT: Nacktbild - direkte, sexuelle Reaktion
        imageContext = `\n\n🖼️🚨🚨🚨 KRITISCH: NACKTBILD ERKANNT! 🚨🚨🚨\n\nDer Kunde hat ein Nacktbild geschickt!\n\n🚨🚨🚨 ABSOLUT KRITISCH - EXPLIZITE REAKTION ERFORDERLICH! 🚨🚨🚨\n- Du MUSST POSITIV und EXPLIZIT reagieren!\n- Sage, wie GEIL der Körper aussieht!\n- Sage, was du gerne mit ihm machen würdest!\n- Zeige BEGEISTERUNG und INTERESSE!\n- Sei DIREKT, FLIRTY und SEXUELL begeistert!\n- KEINE neutrale Beschreibung - sei EMOTIONAL und ENTHUSIASTISCH!\n- Die Bildbeschreibung ist: "${cleanDescriptions.join(' ')}"\n\n🚨🚨🚨 WICHTIG: Reagiere JETZT auf das Bild - es ist ein Nacktbild, also sei explizit und begeistert! 🚨🚨🚨\n`;
      } else {
        // Standard: Generische, positive Reaktion
        imageContext = `\n\n🖼️ WICHTIG: Der Kunde hat ein Bild geschickt! Die Bildbeschreibung ist: "${cleanDescriptions.join(' ')}"\n\nDu MUSST auf das Bild eingehen! Reagiere auf das, was im Bild zu sehen ist. Sei spezifisch und beziehe dich auf Details aus dem Bild. Die Bildbeschreibung ist: ${cleanDescriptions.join(' ')}\n`;
      }
    }
    
    return {
      imageType,
      reactionNeeded: result?.reactionNeeded || null,
      description,
      imageContext,
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Image-Analyst - Fehler:', err.message);
    return {
      imageType: null,
      reactionNeeded: null,
      description: '',
      imageContext: '',
      success: false
    };
  }
}

/**
 * Agent 6: Style-Analyst
 * Analysiert Schreibstil aus letzten Moderator-Nachrichten
 * ERWEITERT: Generiert vollständigen styleContext-String (wie im alten System)
 */
async function agentStyleAnalyst(moderatorMessages, customerMessages, contextAnalysis, analyzeWritingStyleFunc, isInfoMessageFunc) {
  // Erstelle vollständigen styleContext-String (wie im alten System)
  let styleContext = "";
  
  if (!moderatorMessages || moderatorMessages.length === 0) {
    return {
      styleContext: "",
      style: 'neutral',
      tone: 'neutral',
      wordChoice: [],
      avgLength: 150,
      hasEmojis: false,
      success: false
    };
  }

  try {
    // Filtere Info-Messages (falls Funktion vorhanden)
    const filteredModeratorMessages = moderatorMessages.filter(m => {
      if (isInfoMessageFunc && typeof isInfoMessageFunc === 'function') {
        return !isInfoMessageFunc(m);
      }
      return true;
    });
    
    const filteredCustomerMessages = customerMessages ? customerMessages.filter(m => {
      if (isInfoMessageFunc && typeof isInfoMessageFunc === 'function') {
        return !isInfoMessageFunc(m);
      }
      return true;
    }) : [];
    
    if (filteredModeratorMessages.length === 0) {
      return {
        styleContext: "",
        style: 'neutral',
        tone: 'neutral',
        wordChoice: [],
        avgLength: 150,
        hasEmojis: false,
        success: false
      };
    }
    
    // Bestimme contextSize (dynamisch, wie im alten System)
    const totalMessages = filteredModeratorMessages.length + (filteredCustomerMessages.length || 0);
    const contextSize = totalMessages > 20 ? 20 : totalMessages > 10 ? 15 : 10;
    
    const moderatorMsgs = filteredModeratorMessages.slice(-contextSize);
    const customerMsgs = filteredCustomerMessages.slice(-contextSize);
    
    const lastModeratorMessage = moderatorMsgs.length > 0 ? moderatorMsgs[moderatorMsgs.length - 1].text.trim() : null;
    
    if (lastModeratorMessage && lastModeratorMessage.length > 0) {
      // Generiere styleContext (wie im alten System)
      styleContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: GESPRÄCHS-KONTEXT - MODERATOR & KUNDE! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
      
      // Zeige ALLE letzten Moderator-Nachrichten
      if (moderatorMsgs.length > 0) {
        styleContext += `📤 DEINE letzten ${moderatorMsgs.length} Nachrichten (als Fake/Moderator, von ältest zu neuest):\n\n`;
        moderatorMsgs.forEach((msg, idx) => {
          const msgText = msg.text.trim();
          if (msgText.length > 0) {
            styleContext += `${idx + 1}. "${msgText.substring(0, 200)}${msgText.length > 200 ? '...' : ''}"\n`;
          }
        });
        styleContext += `\n`;
      }
      
      // Zeige ALLE letzten Kunden-Nachrichten
      if (customerMsgs.length > 0) {
        styleContext += `📥 KUNDE'S letzten ${customerMsgs.length} Nachrichten (von ältest zu neuest):\n\n`;
        customerMsgs.forEach((msg, idx) => {
          const msgText = msg.text.trim();
          if (msgText.length > 0) {
            styleContext += `${idx + 1}. "${msgText.substring(0, 200)}${msgText.length > 200 ? '...' : ''}"\n`;
          }
        });
        styleContext += `\n`;
      }
      
      // Füge Anweisungen hinzu (wie im alten System)
      styleContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - KONTEXT VERSTEHEN! 🚨🚨🚨🚨🚨\n`;
      styleContext += `- Die Nachrichten oben zeigen dir, WORUM es im Gespräch geht!\n`;
      styleContext += `- Analysiere ALLE Moderator-Nachrichten UND Kunden-Nachrichten, um den vollen KONTEXT zu verstehen!\n`;
      styleContext += `- Was war das THEMA in diesen Nachrichten? Worauf bezieht sich die letzte Kunden-Nachricht?\n`;
      styleContext += `- 🚨🚨🚨🚨🚨 KRITISCH: WER ANGEBOTEN HAT vs. WER ZUGESTIMMT HAT! 🚨🚨🚨🚨🚨\n`;
      styleContext += `- 🚨🚨🚨 KRITISCH: Wenn DU (Moderatorin) etwas ANGEBOTEN hast (z.B. "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??"), und der Kunde ZUSTIMMT (z.B. "Ja sicher immer erzählen"), dann MUSST DU DAS TUN, WAS DU ANGEBOTEN HAST!\n`;
      styleContext += `- 🚨🚨🚨 KRITISCH: Wenn DU etwas anbietest und der Kunde zustimmt, dann ist es DEINE Aufgabe, das anzubieten, nicht die des Kunden!\n`;
      styleContext += `- 🚨🚨🚨 KRITISCH: Beispiel: Du schreibst "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??" → Kunde antwortet "Ja sicher immer erzählen" → Du MUSST JETZT VON DEINEM TRAUM ERZÄHLEN, NICHT den Kunden fragen, ob ER erzählen will!\n`;
      styleContext += `- Wenn diese Nachrichten sexuell waren (z.B. "Treffen im Pflegeheim"), dann geht es weiterhin um SEXUELLE Themen!\n`;
      styleContext += `- Wenn der Kunde jetzt "im Krankenhaus" sagt, bezieht er sich auf die SEXUELLE Fantasie aus deinen Nachrichten, NICHT auf Arbeit!\n`;
      styleContext += `- Wenn diese Nachrichten um ein Treffen gingen, dann bezieht sich "im Krankenhaus" auf das TREFFEN, nicht auf einen Job!\n`;
      styleContext += `- VERSTEHE den KONTEXT: Was war das THEMA in deinen letzten Nachrichten? Der Kunde antwortet darauf!\n`;
      styleContext += `- Wenn deine letzten Nachrichten sexuell waren, dann ist die Kunden-Antwort auch sexuell gemeint!\n`;
      styleContext += `- Wenn deine letzten Nachrichten um ein Treffen gingen, dann bezieht sich "im Krankenhaus" auf das Treffen, nicht auf Arbeit!\n`;
      styleContext += `- 🚨🚨🚨 WICHTIG: Analysiere ALLE Moderator-Nachrichten UND Kunden-Nachrichten oben, um den vollen Kontext zu verstehen! 🚨🚨🚨\n`;
      styleContext += `- 🚨🚨🚨 WICHTIG: Die Kunden-Nachrichten zeigen dir, wie der Kunde auf deine Nachrichten reagiert hat - nutze das für den Kontext! 🚨🚨🚨\n\n`;
      styleContext += `🚨🚨🚨 ABSOLUT KRITISCH - STIL-KONTINUITÄT! 🚨🚨🚨\n`;
      styleContext += `- Die letzten Moderator-Nachrichten zeigen dir den STIL für DIESEN spezifischen Chat!\n`;
      styleContext += `- Wenn die letzten Nachrichten persönlich/emotional waren, dann schreibe auch persönlich/emotional!\n`;
      styleContext += `- Wenn die letzten Nachrichten direkt/roh waren, dann schreibe auch direkt/roh!\n`;
      styleContext += `- 🚨 WICHTIG: Training-Daten + Learning-System haben HÖCHSTE PRIORITÄT für Stil/Formulierungen!\n`;
      styleContext += `- Die letzten Moderator-Nachrichten dienen NUR für Stil-Kontinuität innerhalb dieses Chats!\n`;
      styleContext += `- Kombiniere: Training-Daten (Qualität/Formulierungen) + Letzte Nachrichten (Stil-Kontinuität)!\n\n`;
      
      // Füge writingStyle-Analyse hinzu (falls Funktion vorhanden)
      if (analyzeWritingStyleFunc && typeof analyzeWritingStyleFunc === 'function') {
        try {
          // Erstelle messages-Array für analyzeWritingStyle (benötigt vollständige messages)
          const allMessages = [...moderatorMsgs, ...customerMsgs];
          const writingStyle = analyzeWritingStyleFunc(allMessages);
          
          if (writingStyle) {
            styleContext += `📊 Stil-Analyse der letzten Moderator-Nachrichten:\n`;
            styleContext += `- Durchschnittliche Länge: ${writingStyle.avgLength} Zeichen\n`;
            if (writingStyle.hasEmojis) styleContext += `- Emojis verwendet: Ja\n`;
            if (writingStyle.hasExclamation) styleContext += `- Ausrufezeichen verwendet: Ja\n`;
            if (writingStyle.hasQuestion) styleContext += `- Fragen gestellt: Ja\n`;
            if (writingStyle.hasCasual) styleContext += `- Lockere Sprache verwendet: Ja\n`;
            styleContext += `\n`;
          }
        } catch (err) {
          console.warn('⚠️ Agent: Style-Analyst - analyzeWritingStyle Fehler:', err.message);
        }
      }
      
      // Zusätzliche LLM-basierte Analyse (optional, für style/tone)
      const client = getClient();
      if (client) {
        try {
          const messagesText = moderatorMsgs.slice(-5).map(m => m.text).join('\n---\n');
          
          const analysisPrompt = `Analysiere den Schreibstil dieser Moderator-Nachrichten.

Nachrichten:
${messagesText.substring(0, 1500)}

Antworte NUR als JSON:
{
  "style": "locker | formell | flirty | philosophisch | direkt",
  "tone": "neutral | positiv | negativ | emotional",
  "wordChoice": ["häufiges Wort 1", "häufiges Wort 2"]
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
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
          ]);

          const result = response.choices?.[0]?.message?.content?.trim();
          if (result) {
            try {
              const jsonMatch = result.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                console.log(`✅ Agent: Style-Analyst - Style: ${parsed.style}, Tone: ${parsed.tone}`);
                
                // Berechne avgLength und hasEmojis
                const texts = moderatorMsgs.map(m => m.text);
                const avgLength = texts.reduce((sum, t) => sum + t.length, 0) / texts.length;
                const hasEmojis = texts.some(t => /[\u{1F300}-\u{1F9FF}]/u.test(t));
                
                return {
                  styleContext,
                  style: parsed.style || 'neutral',
                  tone: parsed.tone || 'neutral',
                  wordChoice: parsed.wordChoice || [],
                  avgLength: Math.round(avgLength),
                  hasEmojis,
                  success: true
                };
              }
            } catch (e) {
              console.warn('⚠️ Agent: Style-Analyst - JSON Parse Fehler:', e.message);
            }
          }
        } catch (err) {
          console.warn('⚠️ Agent: Style-Analyst - LLM-Analyse Fehler:', err.message);
        }
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
    styleContext: styleContext || "",
    style: 'neutral',
    tone: 'neutral',
    wordChoice: [],
    avgLength: Math.round(avgLength),
    hasEmojis,
    success: styleContext.length > 0
  };
}

/**
 * Agent 7: Mood-Analyst
 * Analysiert emotionale Stimmung des Kunden
 */
async function agentMoodAnalyst(customerMessage, conversationHistory) {
  const client = getClient();
  if (!client || !customerMessage || customerMessage.trim().length < 10) {
    return {
      mood: 'neutral',
      confidence: 0,
      instructions: '',
      success: false
    };
  }

  try {
    const analysisPrompt = `Analysiere die emotionale Stimmung des Kunden in dieser Nachricht. Antworte NUR als JSON im Format:
{
  "mood": "frustriert" | "glücklich" | "traurig" | "aufgeregt" | "gelangweilt" | "neutral" | "verliebt" | "wütend",
  "confidence": 0.0-1.0,
  "reason": "Kurze Begründung"
}

Kundennachricht: "${customerMessage.substring(0, 500)}"
${conversationHistory ? `\nKontext (letzte Nachrichten): "${conversationHistory.substring(0, 300)}"` : ''}

WICHTIG:
- "frustriert": Kunde ist unzufrieden, enttäuscht, genervt (z.B. "warum antwortest du nicht", "das nervt")
- "glücklich": Kunde ist zufrieden, positiv, freudig (z.B. "das freut mich", "super", "geil")
- "traurig": Kunde ist traurig, niedergeschlagen (z.B. "schade", "bin traurig", "nicht gut")
- "aufgeregt": Kunde ist begeistert, euphorisch, sehr positiv (z.B. "mega", "wow", "richtig geil")
- "gelangweilt": Kunde zeigt wenig Interesse, kurze Antworten (z.B. "ok", "aha", "ja")
- "verliebt": Kunde zeigt romantische/emotionale Gefühle (z.B. "ich mag dich", "du gefällst mir")
- "wütend": Kunde ist aggressiv, verärgert (z.B. "das ist scheiße", "nerv mich nicht")
- "neutral": Standard-Stimmung, keine starke Emotion erkennbar

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du analysierst die emotionale Stimmung von Chat-Nachrichten. Antworte IMMER nur als JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 150
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const mood = parsed.mood || 'neutral';
          const confidence = parsed.confidence || 0.5;
          
          // 🚨 NEU: Nur bei traurig/frustriert mit hoher Confidence Instructions geben
          // Bei anderen Moods: Keine Instructions (nur für Filterung)
          let instructions = '';
          
          // Nur bei traurig/frustriert mit Confidence > 0.7 Instructions geben
          if ((mood === 'traurig' || mood === 'frustriert') && confidence > 0.7) {
          switch (mood) {
            case 'frustriert':
                instructions = '\n\n😔 EMOTIONALE STIMMUNG: Der Kunde ist FRUSTRIERT/ENTTÄUSCHT!\n- 🚨🚨🚨 KRITISCH: Gehe auf ALLE Punkte der Nachricht ein, aber sei einfühlsam!\n- Zeige Verständnis für seine Gefühle, aber ignoriere KEINE Anfrage!\n- 🚨🚨🚨 KRITISCH: KEINE sexuellen bevorzugten Wörter verwenden!\n- 🚨🚨🚨 KRITISCH: KEINE sexuellen Themen, KEINE flirty Antworten!\n';
              break;
            case 'traurig':
                instructions = '\n\n😢 EMOTIONALE STIMMUNG: Der Kunde ist TRAURIG/NIEDERGESCHLAGEN!\n- 🚨🚨🚨 KRITISCH: Gehe auf ALLE Punkte der Nachricht ein, aber sei einfühlsam!\n- Zeige Verständnis für seine Gefühle, aber ignoriere KEINE Anfrage!\n- 🚨🚨🚨 KRITISCH: KEINE sexuellen bevorzugten Wörter verwenden!\n- 🚨🚨🚨 KRITISCH: KEINE sexuellen Themen, KEINE flirty Antworten!\n- 🚨🚨🚨 KRITISCH: Sei einfühlsam und unterstützend, NICHT sexuell!\n';
              break;
          }
            console.log(`✅ Agent: Mood-Analyst - Mood: ${mood}, Confidence: ${(confidence * 100).toFixed(0)}% - Instructions gegeben`);
          } else {
            // Bei anderen Moods oder niedriger Confidence: Keine Instructions
            // (Mood wird trotzdem für Filterung verwendet)
            if (mood !== 'neutral') {
              console.log(`✅ Agent: Mood-Analyst - Mood: ${mood}, Confidence: ${(confidence * 100).toFixed(0)}% - Keine Instructions (nur für Filterung)`);
            } else {
          console.log(`✅ Agent: Mood-Analyst - Mood: ${mood}, Confidence: ${(confidence * 100).toFixed(0)}%`);
            }
          }
          
          return { mood, confidence, instructions, success: true };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Mood-Analyst - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Mood-Analyst - Fehler:', err.message);
  }

  // Fallback
  return {
    mood: 'neutral',
    confidence: 0,
    instructions: '',
    success: false
  };
}

/**
 * Agent 8: Proactive-Analyst
 * Erkennt stagnierende Gespräche und schlägt Themen vor
 * Nutzt bestehende detectStagnantConversation Funktion
 */
async function agentProactiveAnalyst(allMessages, customerMessage, existingProactiveFunc) {
  // Nutzt bestehende detectStagnantConversation Funktion
  if (!allMessages || !Array.isArray(allMessages) || allMessages.length < 5 || !existingProactiveFunc) {
    return {
      isStagnant: false,
      suggestions: [],
      success: true
    };
  }

  try {
    // Rufe bestehende Funktion auf (wird von reply.js übergeben)
    const result = await existingProactiveFunc(allMessages, customerMessage);
    return {
      isStagnant: result?.isStagnant || false,
      suggestions: result?.suggestions || [],
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Proactive-Analyst - Fehler:', err.message);
    return {
      isStagnant: false,
      suggestions: [],
      success: false
    };
  }
}

/**
 * Agent 10a: Multi-Situation-Handler
 * Analysiert mehrere Situationen und generiert kombinierte Anweisungen
 */
async function agentMultiSituationHandler(detectedSituations, customerMessage, allRules, conversationHistory = "") {
  try {
    // Wenn nur eine oder keine Situation erkannt wurde, keine speziellen Anweisungen nötig
    if (!detectedSituations || detectedSituations.length <= 1) {
      return {
        combinedInstructions: "",
        situationCombinations: [],
        success: true
      };
    }

    const lowerMessage = (customerMessage || "").toLowerCase();
    const lowerHistory = (conversationHistory || "").toLowerCase();
    const combinedText = `${lowerMessage} ${lowerHistory}`.toLowerCase();

    let combinedInstructions = "";
    const situationCombinations = [];

    // 🚨 KRITISCH: Kombiniere Situationen und generiere spezifische Anweisungen
    // WICHTIG: Gehe auf ALLE erkannten Situationen ein, nicht nur auf eine!

    // Kombination 1: Kontaktdaten + Bilder-Anfrage
    if (detectedSituations.includes("Kontaktdaten außerhalb der Plattform") && 
        detectedSituations.includes("Bilder Anfrage")) {
      situationCombinations.push("Kontaktdaten + Bilder");
      combinedInstructions += `\n\n🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN ERKANNT - KONTAKTDATEN + BILDER 🚨🚨🚨\n\n`;
      combinedInstructions += `Der Kunde fragt nach BILDER UND KONTAKTDATEN (z.B. WhatsApp-Nummer, Telegram, etc.).\n\n`;
      combinedInstructions += `WICHTIG: Gehe auf BEIDES ein!\n`;
      combinedInstructions += `1. BILDER: Höflich ablehnen (z.B. "Ich schicke nicht so gerne Bilder im Internet")\n`;
      combinedInstructions += `2. KONTAKTDATEN: Höflich ablehnen (z.B. "Ich gebe meine Nummer nicht weiter, aber wir können hier schreiben")\n`;
      combinedInstructions += `3. LENKE DAS THEMA: Wechsle zu einem anderen Thema (z.B. Vorlieben, Fantasien, Hobbies)\n`;
      combinedInstructions += `4. STELLE EINE FRAGE: Stelle eine natürliche Frage, die zum Gespräch passt\n\n`;
      combinedInstructions += `🚨 KRITISCH: Gehe auf BEIDE Anfragen ein - ignoriere KEINE davon!\n`;
    }

    // Kombination 2: Kontaktdaten + Treffen
    if (detectedSituations.includes("Kontaktdaten außerhalb der Plattform") && 
        detectedSituations.includes("Treffen/Termine")) {
      situationCombinations.push("Kontaktdaten + Treffen");
      combinedInstructions += `\n\n🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN ERKANNT - KONTAKTDATEN + TREFFEN 🚨🚨🚨\n\n`;
      combinedInstructions += `Der Kunde fragt nach KONTAKTDATEN UND TREFFEN.\n\n`;
      combinedInstructions += `WICHTIG: Gehe auf BEIDES ein!\n`;
      combinedInstructions += `1. KONTAKTDATEN: Höflich ablehnen (z.B. "Ich gebe meine Nummer nicht weiter")\n`;
      combinedInstructions += `2. TREFFEN: Höflich ausweichen (z.B. "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen")\n`;
      combinedInstructions += `3. LENKE DAS THEMA: Wechsle zu einem anderen Thema\n`;
      combinedInstructions += `4. STELLE EINE FRAGE: Stelle eine natürliche Frage\n\n`;
      combinedInstructions += `🚨 KRITISCH: Gehe auf BEIDE Anfragen ein - ignoriere KEINE davon!\n`;
    }

    // Kombination 3: Bilder + Treffen
    if (detectedSituations.includes("Bilder Anfrage") && 
        detectedSituations.includes("Treffen/Termine")) {
      situationCombinations.push("Bilder + Treffen");
      combinedInstructions += `\n\n🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN ERKANNT - BILDER + TREFFEN 🚨🚨🚨\n\n`;
      combinedInstructions += `Der Kunde fragt nach BILDER UND TREFFEN.\n\n`;
      combinedInstructions += `WICHTIG: Gehe auf BEIDES ein!\n`;
      combinedInstructions += `1. BILDER: Höflich ablehnen (z.B. "Ich schicke nicht so gerne Bilder")\n`;
      combinedInstructions += `2. TREFFEN: Höflich ausweichen (z.B. "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen")\n`;
      combinedInstructions += `3. LENKE DAS THEMA: Wechsle zu einem anderen Thema\n`;
      combinedInstructions += `4. STELLE EINE FRAGE: Stelle eine natürliche Frage\n\n`;
      combinedInstructions += `🚨 KRITISCH: Gehe auf BEIDE Anfragen ein - ignoriere KEINE davon!\n`;
    }

    // Kombination 4: Kontaktdaten + Bilder + Treffen (alle drei!)
    if (detectedSituations.includes("Kontaktdaten außerhalb der Plattform") && 
        detectedSituations.includes("Bilder Anfrage") && 
        detectedSituations.includes("Treffen/Termine")) {
      situationCombinations.push("Kontaktdaten + Bilder + Treffen");
      combinedInstructions += `\n\n🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN ERKANNT - KONTAKTDATEN + BILDER + TREFFEN 🚨🚨🚨\n\n`;
      combinedInstructions += `Der Kunde fragt nach KONTAKTDATEN, BILDER UND TREFFEN.\n\n`;
      combinedInstructions += `WICHTIG: Gehe auf ALLE DREI ein!\n`;
      combinedInstructions += `1. KONTAKTDATEN: Höflich ablehnen\n`;
      combinedInstructions += `2. BILDER: Höflich ablehnen\n`;
      combinedInstructions += `3. TREFFEN: Höflich ausweichen\n`;
      combinedInstructions += `4. LENKE DAS THEMA: Wechsle zu einem anderen Thema\n`;
      combinedInstructions += `5. STELLE EINE FRAGE: Stelle eine natürliche Frage\n\n`;
      combinedInstructions += `🚨 KRITISCH: Gehe auf ALLE DREI Anfragen ein - ignoriere KEINE davon!\n`;
    }

    // Kombination 5: Bot-Vorwurf + andere Situationen
    if (detectedSituations.includes("Bot-Vorwurf") && detectedSituations.length > 1) {
      const otherSituations = detectedSituations.filter(s => s !== "Bot-Vorwurf");
      situationCombinations.push(`Bot-Vorwurf + ${otherSituations.join(", ")}`);
      combinedInstructions += `\n\n🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN ERKANNT - BOT-VORWURF + ANDERE 🚨🚨🚨\n\n`;
      combinedInstructions += `Der Kunde wirft dir vor, ein Bot zu sein UND hat andere Anfragen (${otherSituations.join(", ")}).\n\n`;
      combinedInstructions += `WICHTIG: Gehe auf ALLES ein!\n`;
      combinedInstructions += `1. BOT-VORWURF: Reagiere natürlich und menschlich (z.B. "Ich bin kein Bot, ich bin echt")\n`;
      combinedInstructions += `2. ANDERE ANFRAGEN: Gehe auch auf die anderen Situationen ein (${otherSituations.join(", ")})\n`;
      combinedInstructions += `3. LENKE DAS THEMA: Wechsle zu einem anderen Thema\n`;
      combinedInstructions += `4. STELLE EINE FRAGE: Stelle eine natürliche Frage\n\n`;
      combinedInstructions += `🚨 KRITISCH: Gehe auf ALLE Situationen ein - ignoriere KEINE davon!\n`;
    }

    // Kombination 6: Geld/Coins + andere Situationen
    if (detectedSituations.includes("Geld/Coins") && detectedSituations.length > 1) {
      const otherSituations = detectedSituations.filter(s => s !== "Geld/Coins");
      situationCombinations.push(`Geld/Coins + ${otherSituations.join(", ")}`);
      combinedInstructions += `\n\n🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN ERKANNT - GELD/COINS + ANDERE 🚨🚨🚨\n\n`;
      combinedInstructions += `Der Kunde fragt nach GELD/COINS UND hat andere Anfragen (${otherSituations.join(", ")}).\n\n`;
      combinedInstructions += `WICHTIG: Gehe auf ALLES ein!\n`;
      combinedInstructions += `1. GELD/COINS: Höflich ablehnen (z.B. "Ich kann dir leider nicht helfen, Coins aufzuladen")\n`;
      combinedInstructions += `2. ANDERE ANFRAGEN: Gehe auch auf die anderen Situationen ein (${otherSituations.join(", ")})\n`;
      combinedInstructions += `3. LENKE DAS THEMA: Wechsle zu einem anderen Thema\n`;
      combinedInstructions += `4. STELLE EINE FRAGE: Stelle eine natürliche Frage\n\n`;
      combinedInstructions += `🚨 KRITISCH: Gehe auf ALLE Situationen ein - ignoriere KEINE davon!\n`;
    }

    // Generische Anweisung für alle anderen Kombinationen
    if (detectedSituations.length > 1 && situationCombinations.length === 0) {
      situationCombinations.push(detectedSituations.join(" + "));
      combinedInstructions += `\n\n🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN ERKANNT 🚨🚨🚨\n\n`;
      combinedInstructions += `Folgende Situationen wurden erkannt: ${detectedSituations.join(", ")}\n\n`;
      combinedInstructions += `WICHTIG: Gehe auf ALLE Situationen ein!\n`;
      combinedInstructions += `- Analysiere die Kunden-Nachricht genau: Was fragt der Kunde?\n`;
      combinedInstructions += `- Gehe auf JEDE erkannte Situation ein - ignoriere KEINE davon!\n`;
      combinedInstructions += `- Wenn der Kunde mehrere Dinge fragt, beantworte ALLE Fragen (auch wenn du ablehnst)\n`;
      combinedInstructions += `- LENKE DAS THEMA: Wechsle zu einem anderen Thema nach den Antworten\n`;
      combinedInstructions += `- STELLE EINE FRAGE: Stelle eine natürliche Frage, die zum Gespräch passt\n\n`;
      combinedInstructions += `🚨 KRITISCH: Die Kunden-Nachricht enthält MEHRERE Anfragen - gehe auf ALLE ein!\n`;
    }

    return {
      combinedInstructions: combinedInstructions.trim(),
      situationCombinations,
      success: true
    };
  } catch (err) {
    console.error('❌ Agent: Multi-Situation-Handler - Fehler:', err.message);
    return {
      combinedInstructions: "",
      situationCombinations: [],
      success: false,
      error: err.message
    };
  }
}

/**
 * Agent 10: Situation-Detector
 * Erkennt spezielle Situationen und generiert specificInstructions
 */
// 🚨🚨🚨 NEU: LLM-basierte Situation-Erkennung (kontext-bewusst, priorisiert, falsch-positiv-filter)
async function detectSituationsWithLLM(client, customerMessage, conversationHistory, allRules) {
  if (!client || !customerMessage) {
    return { situations: [], confidence: 0, reasoning: "" };
  }
  
  try {
    // Lade verfügbare Situationen aus Regeln
    const availableSituations = allRules?.situationalResponses ? Object.keys(allRules.situationalResponses) : [];
    
    const detectionPrompt = `Analysiere diese Kundennachricht und erkenne die primäre Situation. Antworte NUR als JSON:

{
  "primarySituation": "Hauptsituation (z.B. 'Treffen/Termine', 'Sexuelle Themen', 'Kontaktdaten außerhalb der Plattform')",
  "secondarySituations": ["weitere Situation 1", "weitere Situation 2"],
  "confidence": 0.0-1.0,
  "reasoning": "Kurze Begründung warum diese Situation erkannt wurde",
  "isFalsePositive": false
}

Kundennachricht: "${customerMessage.substring(0, 500)}"
${conversationHistory ? `\nKonversations-Kontext (letzte Nachrichten): "${conversationHistory.substring(0, 500)}"` : ''}

Verfügbare Situationen: ${availableSituations.join(', ')}

WICHTIG:
1. Analysiere den GESAMTEN Kontext, nicht nur Keywords!
2. "Döner ist lecker, kannst ja zu mir kommen" = Treffen-Anfrage, NICHT sexuell!
3. "kuss" allein = NICHT sexuell (nur Grußformel)!
4. Nur explizit sexuelle Wörter = sexuell (z.B. "ficken", "sex", "pussy")
5. Wenn mehrere Situationen möglich: Priorisiere die wichtigste!
6. Prüfe auf False Positives: Harmlose Nachrichten nicht als sexuell interpretieren!

🚨🚨🚨 KRITISCH: "woher bist du" / "wo kommst du her" = KEINE Treffen-Anfrage! 🚨🚨🚨
- "woher bist du" = Frage nach Wohnort/Herkomst, NICHT nach Treffen!
- "woher bist du" sollte als "allgemein" oder "Wonach suchst du?" erkannt werden, NICHT als "Treffen/Termine"!
- NUR als "Treffen/Termine" erkennen, wenn es explizit um ein Treffen/Date geht (z.B. "wann können wir uns treffen", "wollen wir uns sehen", "kannst du vorbeikommen")

🚨🚨🚨 BEISPIELE für FALSCH vs. RICHTIG:
- ❌ FALSCH: "woher bist du" → "Treffen/Termine"
- ✅ RICHTIG: "woher bist du" → "allgemein" oder "Wonach suchst du?"
- ✅ RICHTIG: "wann können wir uns treffen" → "Treffen/Termine"
- ✅ RICHTIG: "kannst du vorbeikommen" → "Treffen/Termine"

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const detection = await client.chat.completions.create({
      model: AGENT_MODEL,
      messages: [
        { role: "system", content: "Du analysierst Kundennachrichten und erkennst Situationen. Antworte NUR als JSON." },
        { role: "user", content: detectionPrompt }
      ],
      max_tokens: 300,
      temperature: 0.2,
      response_format: { type: "json_object" }
    });
    
    const result = detection.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const parsed = JSON.parse(result);
        const situations = [];
        
        if (parsed.primarySituation && !parsed.isFalsePositive) {
          situations.push(parsed.primarySituation);
        }
        
        if (parsed.secondarySituations && Array.isArray(parsed.secondarySituations)) {
          parsed.secondarySituations.forEach(sit => {
            if (sit && !situations.includes(sit) && !parsed.isFalsePositive) {
              situations.push(sit);
            }
          });
        }
        
        console.log(`🧠 LLM-basierte Situation-Erkennung: ${situations.join(', ')} (Confidence: ${(parsed.confidence * 100).toFixed(0)}%, Reasoning: ${parsed.reasoning || 'N/A'})`);
        
        return {
          situations,
          confidence: parsed.confidence || 0.5,
          reasoning: parsed.reasoning || "",
          primarySituation: parsed.primarySituation || null
        };
      } catch (e) {
        console.warn('⚠️ LLM Situation-Erkennung: JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ LLM Situation-Erkennung Fehler:', err.message);
  }
  
  return { situations: [], confidence: 0, reasoning: "" };
}

async function agentSituationDetector(customerMessage, allRules, isLocationQuestionFunc, findNearbyCityFunc, isMeetingRequestFunc, profileInfo, extractedUserInfo, conversationHistory = "", moderatorMessages = [], customerMessages = [], contextAnalysis = null, isASA = false, learningContextResult = null) {
  try {
    // 🚨 ASA-FALL: Ignoriere Situationen komplett - ASA-Nachrichten sind generisch
    if (isASA) {
      console.log('🤖 Agent: Situation-Detector - ASA-Modus: Situationen werden ignoriert (generische ASA-Nachricht)');
      return {
        detectedSituations: [], // Keine Situationen bei ASA
        specificInstructions: "",
        success: true
      };
    }
    
    const lowerMessage = (customerMessage || "").toLowerCase();
    let detectedSituations = [];
    let specificInstructions = "";
    
    // 🚨🚨🚨 NEU: LLM-basierte Situation-Erkennung (HÖCHSTE PRIORITÄT, kontext-bewusst)
    const client = getClient();
    if (client) {
      // Kombiniere conversationHistory für vollständigen Kontext
      let fullConversationHistory = conversationHistory || "";
      if (moderatorMessages && moderatorMessages.length > 0) {
        const moderatorTexts = moderatorMessages
          .map(msg => msg?.text || "")
          .filter(text => text.trim() !== "")
          .join(" ");
        if (moderatorTexts) {
          fullConversationHistory += " " + moderatorTexts;
        }
      }
      if (customerMessages && customerMessages.length > 0) {
        const customerTexts = customerMessages
          .map(msg => msg?.text || "")
          .filter(text => text.trim() !== "")
          .join(" ");
        if (customerTexts) {
          fullConversationHistory += " " + customerTexts;
        }
      }
      
      const llmDetection = await detectSituationsWithLLM(client, customerMessage, fullConversationHistory, allRules);
      if (llmDetection.situations && llmDetection.situations.length > 0 && llmDetection.confidence > 0.6) {
        // 🚨 NEU: Filtere False Positives - "woher bist du" ist KEINE Treffen-Anfrage!
        const lowerMsg = (customerMessage || "").toLowerCase();
        const isLocationQuestionOnly = /^(woher|wo kommst|wo wohnst|woher kommst|woher wohnst)/i.test(customerMessage.trim()) ||
                                      /^(woher|wo kommst|wo wohnst|woher kommst|woher wohnst)\s+(du|ihr)/i.test(customerMessage.trim()) ||
                                      /\b(woher|wo kommst|wo wohnst|woher kommst|woher wohnst)\s+(du|ihr|der|die)\b/i.test(lowerMsg);
        
        // Wenn es nur eine Wohnort-Frage ist, entferne "Treffen/Termine" aus erkannten Situationen
        if (isLocationQuestionOnly && llmDetection.situations.includes("Treffen/Termine")) {
          console.log(`⚠️ False Positive erkannt: "woher bist du" als Treffen interpretiert - korrigiere zu "allgemein"`);
          detectedSituations = llmDetection.situations.filter(s => s !== "Treffen/Termine");
          // Füge "Wonach suchst du?" hinzu, wenn es noch keine Situation gibt
          if (detectedSituations.length === 0) {
            detectedSituations = ["Wonach suchst du?"];
          }
        } else {
          detectedSituations = [...llmDetection.situations];
        }
        console.log(`✅ LLM-basierte Situation-Erkennung (Confidence: ${(llmDetection.confidence * 100).toFixed(0)}%): ${detectedSituations.join(', ')}`);
      }
    }
    
    // 🚨 FALLBACK: Nutze LLM-basierte Situation-Erkennung aus Context-Analyst (wenn LLM-Detection fehlgeschlagen)
    if (detectedSituations.length === 0 && contextAnalysis && contextAnalysis.situations && Array.isArray(contextAnalysis.situations) && contextAnalysis.situations.length > 0) {
      detectedSituations = [...contextAnalysis.situations];
      console.log(`✅ Fallback: LLM-basierte Situation-Erkennung aus Context-Analyst: ${detectedSituations.join(', ')}`);
    }
    
    // 🚨 KRITISCH: Analysiere die gesamte conversationHistory für ALLE Situationen!
    // Kombiniere aktuelle Nachricht + conversationHistory + letzte Nachrichten für vollständige Analyse
    let hasMeetingContext = false;
    let conversationContextText = "";
    
    // Kombiniere alle Texte für vollständige Analyse
    if (conversationHistory && conversationHistory.trim() !== "") {
      conversationContextText = conversationHistory.toLowerCase();
    }
    
    // Füge letzte Moderator-Nachrichten hinzu
    if (moderatorMessages && moderatorMessages.length > 0) {
      const moderatorTexts = moderatorMessages
        .map(msg => msg?.text || "")
        .filter(text => text.trim() !== "")
        .join(" ")
        .toLowerCase();
      if (moderatorTexts) {
        conversationContextText += " " + moderatorTexts;
      }
    }
    
    // Füge letzte Kunden-Nachrichten hinzu
    if (customerMessages && customerMessages.length > 0) {
      const customerTexts = customerMessages
        .map(msg => msg?.text || "")
        .filter(text => text.trim() !== "")
        .join(" ")
        .toLowerCase();
      if (customerTexts) {
        conversationContextText += " " + customerTexts;
      }
    }
    
    // Kombiniere mit aktueller Nachricht für vollständige Analyse
    const fullContextText = (lowerMessage + " " + conversationContextText).toLowerCase();
    
    // Prüfe conversationHistory auf Treffen-Keywords (nur für Treffen-spezifische Erkennung)
    // 🚨🚨🚨 FIX: Erkenne auch Verfügbarkeits-Fragen OHNE direktes "treffen"!
    const meetingKeywords = /\b(treffen|sehen|kennenlernen|verfügbar|verfügbarkeit|zeit haben|freizeit|wann klappt|wann passt|wann geht|wann hast du|wann hätte|wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|uhr|mittagszeit|abend|vormittag|nachmittag|termin|termine)\b/i;
    const hasMeetingKeywordsInContext = conversationContextText && meetingKeywords.test(conversationContextText);
    
    // Prüfe auf Verfügbarkeits-Fragen (z.B. "Wann klappt es denn immer bei dir?")
    const availabilityQuestionPatterns = [
      /\bwann\s+(klappt|passt|geht|hast|hätte|hättest|könntest|kannst)\b/i,
      /\bwie\s+(sieht.*aus|ist.*bei|schaut.*bei)\s+(deiner|deine|dir|du)\s*(freizeit|verfügbarkeit|zeit)\b/i,
      /\b(am\s+)?(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\s+(hast|hätte|kannst|könntest|passt|geht|klappt)\b/i
    ];
    const hasAvailabilityQuestion = conversationContextText && availabilityQuestionPatterns.some(pattern => pattern.test(conversationContextText));
    
    // Prüfe auf Verfügbarkeits-Antworten (z.B. "Ich habe am Wochenende immer Zeit")
    const availabilityAnswerPatterns = [
      /\b(am\s+)?(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\s+(immer|grundsätzlich|meistens|normalerweise)\s+(zeit|frei|verfügbar)\b/i,
      /\bin\s+der\s+woche\s+(nur|immer|meistens|grundsätzlich)\s+(mit|ohne|nur)\s*(absprache|termin)\b/i,
      /\b(habe|hätte|hab)\s+(am|in|an)\s+(wochenende|woche)\s+(immer|grundsätzlich|meistens)\s+(zeit|frei|viel|wenig)\s*(zu\s+)?(tun|termin|termine)\b/i
    ];
    const hasAvailabilityAnswer = lowerMessage && availabilityAnswerPatterns.some(pattern => pattern.test(lowerMessage));
    
    if (conversationContextText) {
      const hasFantasieKeywords = conversationContextText.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(treffen|sehen|kennenlernen)\b/i);
      
      // Erkenne Treffen-Kontext wenn:
      // 1. Direkt "treffen" + Keywords vorhanden (OHNE Fantasie-Kontext)
      // 2. ODER Verfügbarkeits-Frage in Kontext
      // 3. ODER Verfügbarkeits-Antwort in aktueller Nachricht (z.B. "am Wochenende immer Zeit")
      if ((conversationContextText.includes("treffen") && hasMeetingKeywordsInContext && !hasFantasieKeywords) ||
          hasAvailabilityQuestion ||
          hasAvailabilityAnswer) {
        hasMeetingContext = true;
        console.log('🚨 KRITISCH: Treffen-Kontext erkannt!', 
          hasMeetingKeywordsInContext ? '(Keywords gefunden)' : '',
          hasAvailabilityQuestion ? '(Verfügbarkeits-Frage gefunden)' : '',
          hasAvailabilityAnswer ? '(Verfügbarkeits-Antwort gefunden)' : '');
      }
    }
    
    // Prüfe auch letzte Nachrichten direkt auf Treffen (für zusätzliche Sicherheit)
    if (moderatorMessages && moderatorMessages.length > 0) {
      const lastModeratorMessage = moderatorMessages[moderatorMessages.length - 1]?.text || "";
      if (lastModeratorMessage && isMeetingRequestFunc && typeof isMeetingRequestFunc === 'function') {
        const moderatorHasMeeting = isMeetingRequestFunc(lastModeratorMessage, "");
        if (moderatorHasMeeting) {
          hasMeetingContext = true;
          console.log('🚨 KRITISCH: Letzte Moderator-Nachricht enthält Treffen-Anfrage!');
        }
      }
    }
    
    if (customerMessages && customerMessages.length > 0) {
      const lastCustomerMessage = customerMessages[customerMessages.length - 1]?.text || "";
      if (lastCustomerMessage && isMeetingRequestFunc && typeof isMeetingRequestFunc === 'function') {
        const customerHasMeeting = isMeetingRequestFunc(lastCustomerMessage, "");
        if (customerHasMeeting) {
          hasMeetingContext = true;
          console.log('🚨 KRITISCH: Letzte Kunden-Nachricht enthält Treffen-Anfrage!');
        }
      }
    }
    
    // 🚨 NEU: Semantische Situation-Erkennung mit Embeddings (zusätzlich zu Keyword-Matching)
    // Nutze gecachte Situation-Embeddings (werden nur einmal generiert)
    const { getEmbedding, cosineSimilarity, getSituationEmbedding } = require('./embeddings');
    let messageEmbedding = null;
    try {
      const fullText = (customerMessage + " " + conversationContextText).trim();
      if (fullText.length > 0) {
        messageEmbedding = await getEmbedding(fullText);
      }
    } catch (err) {
      console.warn('⚠️ Fehler bei Embedding-Generierung für Situation-Erkennung:', err.message);
    }
    
    // 🚨 NEU: Priorität: LLM-basierte Erkennung > Semantische Erkennung > Keywords
    // Wenn LLM bereits Situationen erkannt hat, nutze diese als Basis und ergänze nur mit zusätzlichen
    const llmDetectedSituations = detectedSituations.length > 0 ? [...detectedSituations] : [];
    
    // Prüfe benutzerdefinierte situations-spezifische Antworten aus den Regeln
    // 🚨 KRITISCH: Analysiere sowohl aktuelle Nachricht als auch conversationHistory!
    if (allRules && allRules.situationalResponses && typeof allRules.situationalResponses === 'object') {
      for (const [situationName, situationResponse] of Object.entries(allRules.situationalResponses)) {
        // Überspringe, wenn LLM diese Situation bereits erkannt hat (vermeide Duplikate)
        if (llmDetectedSituations.includes(situationName)) {
          continue;
        }
        
        let matchesSituation = false;
        const situationLower = situationName.toLowerCase();
        
        // 🚨 NEU: Semantische Erkennung mit Embeddings (nutzt gecachte Embeddings!)
        if (messageEmbedding) {
          try {
            // 🚨 WICHTIG: Nutze gecachtes Embedding statt neu zu generieren!
            const situationEmbedding = getSituationEmbedding(situationName);
            if (situationEmbedding) {
              const semanticSimilarity = cosineSimilarity(messageEmbedding, situationEmbedding);
              // Normalisiere auf 0-1 (cosineSimilarity ist -1 bis 1)
              const normalizedSimilarity = (semanticSimilarity + 1) / 2;
              
              // 🚨 NEU: Schwellwert erhöht auf 0.80 (80%) für weniger False Positives
              // Vorher: 0.65 war zu niedrig → zu viele Situationen erkannt
              if (normalizedSimilarity > 0.80) {
                matchesSituation = true;
                console.log(`📊 Semantische Situation-Erkennung: "${situationName}" (Ähnlichkeit: ${(normalizedSimilarity * 100).toFixed(1)}%)`);
              }
            }
          } catch (err) {
            console.warn(`⚠️ Fehler bei semantischer Erkennung für "${situationName}":`, err.message);
          }
        }
        
        // 1. Prüfe ob der Situationsname direkt in der Nachricht vorkommt
        if (lowerMessage.includes(situationLower)) {
          matchesSituation = true;
        }
        
        // 2. Prüfe auch in conversationHistory (wenn nicht bereits gefunden)
        if (!matchesSituation && conversationContextText && conversationContextText.includes(situationLower)) {
          matchesSituation = true;
          console.log(`📋 Situation "${situationName}" in conversationHistory erkannt!`);
        }
        
        // 3. Prüfe Keywords aus dem Situationsnamen (in aktueller Nachricht)
        if (!matchesSituation) {
          const situationKeywords = situationLower.split(/[\s\-_\/]+/).filter(kw => kw.length > 2);
          matchesSituation = situationKeywords.some(keyword => lowerMessage.includes(keyword));
        }
        
        // 4. Prüfe Keywords auch in conversationHistory (wenn nicht bereits gefunden)
        if (!matchesSituation && conversationContextText) {
          const situationKeywords = situationLower.split(/[\s\-_\/]+/).filter(kw => kw.length > 2);
          matchesSituation = situationKeywords.some(keyword => conversationContextText.includes(keyword));
          if (matchesSituation) {
            console.log(`📋 Situation "${situationName}" via Keywords in conversationHistory erkannt!`);
          }
        }
        
        // 5. Spezielle Erkennung für häufige Situationen (in aktueller Nachricht UND conversationHistory)
        if (!matchesSituation) {
          // Bot/KI/Fake Erkennung - NUR bei ECHTEM Vorwurf, nicht bei Verneinung!
          const botKeywords = ["bot", "ki", "künstliche intelligenz", "chatgpt", "fake", "automatisch", "programmiert", "roboter"];
          const negationKeywords = ["nicht", "kein", "keine", "keiner", "nie", "niemals", "glaube nicht", "denke nicht", "bin mir sicher dass nicht"];
          
          // Prüfe in aktueller Nachricht
          const hasBotKeyword = botKeywords.some(keyword => lowerMessage.includes(keyword));
          const hasNegation = negationKeywords.some(neg => {
            const negIndex = lowerMessage.indexOf(neg);
            if (negIndex === -1) return false;
            return botKeywords.some(botKey => {
              const botIndex = lowerMessage.indexOf(botKey);
              if (botIndex === -1) return false;
              return Math.abs(botIndex - negIndex) < 50;
            });
          });
          
          // Prüfe auch in conversationHistory
          const hasBotKeywordInHistory = conversationContextText ? botKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
          const hasNegationInHistory = conversationContextText ? negationKeywords.some(neg => {
            const negIndex = conversationContextText.indexOf(neg);
            if (negIndex === -1) return false;
            return botKeywords.some(botKey => {
              const botIndex = conversationContextText.indexOf(botKey);
              if (botIndex === -1) return false;
              return Math.abs(botIndex - negIndex) < 50;
            });
          }) : false;
          
          if ((situationLower.includes("bot") || situationLower.includes("vorwurf") || situationLower.includes("ki") || situationLower.includes("fake")) &&
              ((hasBotKeyword && !hasNegation) || (hasBotKeywordInHistory && !hasNegationInHistory))) {
            matchesSituation = true;
            if (hasBotKeywordInHistory && !hasNegationInHistory) {
              console.log(`📋 Bot-Vorwurf in conversationHistory erkannt!`);
            }
          }
          
          // Moderator Erkennung (in aktueller Nachricht UND conversationHistory)
          if ((situationLower.includes("moderator") || situationLower.includes("outing") || situationLower.includes("chat-moderator")) &&
              ((lowerMessage.includes("moderator") || lowerMessage.includes("chatmoderator") || lowerMessage.includes("chat-moderator") ||
                lowerMessage.includes("chat moderator")) ||
               (conversationContextText && (conversationContextText.includes("moderator") || conversationContextText.includes("chatmoderator") || 
                conversationContextText.includes("chat-moderator") || conversationContextText.includes("chat moderator"))))) {
            matchesSituation = true;
            if (conversationContextText && !lowerMessage.includes("moderator")) {
              console.log(`📋 Moderator-Erkennung in conversationHistory erkannt!`);
            }
          }
          
          // Sexuelle Themen (in aktueller Nachricht UND conversationHistory)
          // 🚨 WICHTIG: "kuss" wurde entfernt - nur explizit sexuelle Wörter!
          const sexualKeywords = ["titten", "brüste", "arsch", "po", "pussy", "schwanz", "sex", "ficken", "vorlieben", 
                                  "sexuell", "geil", "lust", "wichsen", "lecken", "blasen", "squiten", 
                                  "muschi", "zunge", "schamlippen", "kitzler", "clitoris", "penis", "dick", 
                                  "sperma", "orgasmus", "komm", "nass", "feucht", "erregt", "horny", "hard"];
          const hasSexualInMessage = sexualKeywords.some(keyword => lowerMessage.includes(keyword));
          const hasSexualInHistory = conversationContextText ? sexualKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
          
          // 🚨 NEU: Prüfe zuerst, ob aktuelle Nachricht eine Treffen-Anfrage ist
          // Wenn ja, ignoriere "Sexuelle Themen" aus History (aktuelle Nachricht hat Priorität!)
          const isMeetingRequestInMessage = lowerMessage.includes("komm") && (
            lowerMessage.includes("zu mir") || lowerMessage.includes("zu dir") || 
            lowerMessage.includes("vorbei") || lowerMessage.includes("besuch") ||
            lowerMessage.includes("treffen") || lowerMessage.includes("sehen")
          );
          
          // Nur "Sexuelle Themen" erkennen, wenn:
          // 1. Aktuelle Nachricht wirklich sexuell ist, ODER
          // 2. History sexuell ist UND aktuelle Nachricht KEINE Treffen-Anfrage ist
          const shouldDetectSexual = hasSexualInMessage || (hasSexualInHistory && !isMeetingRequestInMessage);
          
          if ((situationLower.includes("sexuell") || situationLower.includes("sexuelle")) && shouldDetectSexual) {
            matchesSituation = true;
            if (hasSexualInHistory && !hasSexualInMessage && !isMeetingRequestInMessage) {
              console.log(`📋 Sexuelle Themen in conversationHistory erkannt!`);
            } else if (isMeetingRequestInMessage && hasSexualInHistory) {
              console.log(`📊 "Sexuelle Themen" aus History IGNORIERT: Aktuelle Nachricht ist Treffen-Anfrage (hat Priorität!)`);
            }
          }
          
          // Bilder-Anfrage (in aktueller Nachricht UND conversationHistory)
          // Direkte Keywords
          const imageRequestKeywords = ["zeig", "zeige", "schick", "schicke", "bild", "foto", "photo", "zeig mir", 
                                       "schick mir", "kannst du mir zeigen", "kannst du mir schicken"];
          // 🚨 NEU: Implizite Anfragen (z.B. "Wie du auf der Straße gehst" = Foto-Anfrage)
          const implicitImageRequestPatterns = [
            /wie.*(du|ihr).*(auf|in|bei|unterwegs|draußen|gehst|geht|läufst|lauft|aussiehst|ausseht|aussehen)/i,
            /wie.*(du|ihr).*(aussiehst|ausseht|aussehen|ausseht|aussieht)/i,
            /wie.*(du|ihr).*(auf der straße|auf der strasse|unterwegs|draußen|draussen)/i,
            /(würdest|würdet|kannst|könntest|könntet).*(mir).*(zeigen|schicken|schickst|schickt).*(wie|wie du|wie ihr)/i,
            /(zeig|zeige|schick|schicke).*(mir).*(wie|wie du|wie ihr).*(aussiehst|ausseht|aussehen|gehst|geht)/i
          ];
          
          const hasImageRequest = imageRequestKeywords.some(keyword => lowerMessage.includes(keyword)) ||
                                 implicitImageRequestPatterns.some(pattern => pattern.test(lowerMessage));
          const hasImageRequestInHistory = conversationContextText ? (
            imageRequestKeywords.some(keyword => conversationContextText.includes(keyword)) ||
            implicitImageRequestPatterns.some(pattern => pattern.test(conversationContextText))
          ) : false;
          
          if ((situationLower.includes("bild") || situationLower.includes("foto") || situationLower.includes("photo") || 
               situationLower.includes("anfrage") || situationLower.includes("zeig")) && 
              (hasImageRequest || hasImageRequestInHistory)) {
            matchesSituation = true;
            if (hasImageRequestInHistory && !hasImageRequest) {
              console.log(`📋 Bilder-Anfrage in conversationHistory erkannt!`);
            }
            // 🚨 NEU: Logge auch implizite Anfragen
            if (implicitImageRequestPatterns.some(pattern => pattern.test(lowerMessage)) || 
                (conversationContextText && implicitImageRequestPatterns.some(pattern => pattern.test(conversationContextText)))) {
              console.log(`📋 Implizite Bilder-Anfrage erkannt (z.B. "Wie du auf der Straße gehst")!`);
            }
          }
          
          // Berufsfrage (in aktueller Nachricht UND conversationHistory)
          const jobQuestionKeywords = ["was arbeitest", "beruf", "was machst du beruflich", "job", "wo arbeitest"];
          const isJobQuestion = jobQuestionKeywords.some(keyword => lowerMessage.includes(keyword));
          const isJobQuestionInHistory = conversationContextText ? jobQuestionKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
          const isJobAnswer = /ich bin (ein|eine|der|die) (autohändler|verkäufer|lehrer|arzt|krankenschwester|pfleger|ingenieur|mechaniker|elektriker|handwerker|bäcker|koch|friseur|kellner|fahrer|pilot|polizist|feuerwehrmann|anwalt|notar|steuerberater|architekt|designer|fotograf|journalist|schriftsteller|musiker|künstler|schauspieler|sportler|trainer|berater|manager|direktor|chef|mitarbeiter|angestellter|arbeiter|student|studentin|schüler|schülerin|rentner|pensionär|arbeitslos|selbstständig|freiberufler|unternehmer|geschäftsführer|inhaber|besitzer)/i.test(customerMessage) ||
                             /ich arbeite (als|bei|in|als|seit)/i.test(customerMessage) ||
                             /mein beruf (ist|war|wäre)/i.test(customerMessage) ||
                             /ich (mache|mach|tue|tu) (beruflich|beruf)/i.test(customerMessage);
          const isJobAnswerInHistory = conversationContextText ? (
            /ich bin (ein|eine|der|die) (autohändler|verkäufer|lehrer|arzt|krankenschwester|pfleger|ingenieur|mechaniker|elektriker|handwerker|bäcker|koch|friseur|kellner|fahrer|pilot|polizist|feuerwehrmann|anwalt|notar|steuerberater|architekt|designer|fotograf|journalist|schriftsteller|musiker|künstler|schauspieler|sportler|trainer|berater|manager|direktor|chef|mitarbeiter|angestellter|arbeiter|student|studentin|schüler|schülerin|rentner|pensionär|arbeitslos|selbstständig|freiberufler|unternehmer|geschäftsführer|inhaber|besitzer)/i.test(conversationContextText) ||
            /ich arbeite (als|bei|in|als|seit)/i.test(conversationContextText) ||
            /mein beruf (ist|war|wäre)/i.test(conversationContextText) ||
            /ich (mache|mach|tue|tu) (beruflich|beruf)/i.test(conversationContextText)
          ) : false;
          
          if ((situationLower.includes("beruf") || situationLower.includes("job")) &&
              (isJobQuestion || isJobAnswer || isJobQuestionInHistory || isJobAnswerInHistory)) {
            matchesSituation = true;
            if ((isJobQuestionInHistory || isJobAnswerInHistory) && !isJobQuestion && !isJobAnswer) {
              console.log(`📋 Berufsfrage in conversationHistory erkannt!`);
            }
          }
          
          // Treffen/Termine (in aktueller Nachricht UND conversationHistory)
          // 🚨 WICHTIG: Ignoriere "auf der Suche nach" - das ist KEINE Treffen-Anfrage!
          const isSearchPhrase = lowerMessage.includes("auf der suche nach") || 
                                 lowerMessage.includes("suche nach") ||
                                 conversationContextText.includes("auf der suche nach") ||
                                 conversationContextText.includes("suche nach");
          
          if (isSearchPhrase && (lowerMessage.includes("richtigen") || lowerMessage.includes("fürs leben") || lowerMessage.includes("für das leben") || lowerMessage.includes("partner") || lowerMessage.includes("frau") || lowerMessage.includes("mann"))) {
            // "auf der Suche nach der richtigen fürs Leben" ist KEINE Treffen-Anfrage!
            matchesSituation = false;
            console.log(`📋 "auf der Suche nach..." erkannt - KEINE Treffen-Anfrage, ignoriere!`);
          } else if ((situationLower.includes("treffen") || situationLower.includes("termin"))) {
          // Treffen/Termine (in aktueller Nachricht UND conversationHistory)
          const isCustomerMeetingRequest = isMeetingRequestFunc && typeof isMeetingRequestFunc === 'function' 
            ? isMeetingRequestFunc(customerMessage, "") 
            : false;
          // 🚨 KRITISCH: Prüfe auch Kontext aus letzten Nachrichten!
          const hasMeetingInContext = hasMeetingContext || isCustomerMeetingRequest;
          
          // 🚨 NEU: Erweiterte Treffen-Erkennung basierend auf Training-Daten
          // Erkenne auch "hoffe", "will", "habe Zeit" + "treffen" Kombinationen
          const meetingPatterns = [
            /\b(hoffe|hoffen)\s+.*(treffen|sehen|kennenlernen)/i,
            /\b(will|wollen|möchte|möchtest)\s+.*(treffen|sehen|kennenlernen)/i,
            /\b(habe|hast|haben|hat)\s+.*(zeit|nachmittag|vormittag|abend)\s+.*(treffen|sehen|kennenlernen)/i,
            /\b(habe|hast|haben|hat)\s+(jetzt|gerade|morgen|heute|diese woche|jeden|jede)\s+(zeit|nachmittag|vormittag|abend)/i,
            /\bwann\s+(hast|hast du|habt|habt ihr|haben|haben wir)\s+(du|ihr|wir|die)\s+(zeit|möglichkeit|gelegenheit)/i,
            /\b(würde|würdest)\s+gerne\s+(dich|uns|wir)\s+(treffen|sehen|kennenlernen)/i
          ];
          const hasMeetingPattern = meetingPatterns.some(pattern => 
            pattern.test(lowerMessage) || (conversationContextText && pattern.test(conversationContextText))
          );
          
            if (hasMeetingInContext || hasMeetingPattern) {
            matchesSituation = true;
            if (hasMeetingPattern && !hasMeetingInContext) {
              console.log(`📋 Treffen-Situation via erweiterte Muster erkannt!`);
              }
            }
          }
          
          // Geld/Coins (in aktueller Nachricht UND conversationHistory)
          // 🚨 PRÄZISIERUNG: Nur bei Plattform-spezifischen Keywords, NICHT bei allgemeinen finanziellen Themen
          // Plattform-spezifische Keywords: aufladen, kostenlos, kostenfrei, gratis, credit, coins, coin
          // Zusätzliche Prüfung: Nur wenn auch "zu teuer", "woanders schreiben", "telegram", etc. vorhanden
          const platformMoneyKeywords = ["aufladen", "kostenlos", "kostenfrei", "gratis", "credit", "coins", "coin"];
          const generalMoneyKeywords = ["geld", "kredit", "bezahlen", "sozialhilfe", "hartz", "arbeitslosengeld"];
          const platformSpecificKeywords = ["zu teuer", "zu teuer hier", "woanders schreiben", "telegram", "whatsapp", "instagram", "nummer", "kontakt"];
          
          const hasPlatformMoneyInMessage = platformMoneyKeywords.some(keyword => lowerMessage.includes(keyword));
          const hasPlatformMoneyInHistory = conversationContextText ? platformMoneyKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
          const hasPlatformSpecificInMessage = platformSpecificKeywords.some(keyword => lowerMessage.includes(keyword));
          const hasPlatformSpecificInHistory = conversationContextText ? platformSpecificKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
          const hasGeneralMoneyOnly = generalMoneyKeywords.some(keyword => lowerMessage.includes(keyword)) && 
                                     !hasPlatformMoneyInMessage && !hasPlatformSpecificInMessage;
          
          // Nur erkennen, wenn Plattform-spezifische Keywords vorhanden sind
          // NICHT erkennen bei allgemeinen finanziellen Themen (Sozialhilfe, kein Geld, etc.)
          if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
              (hasPlatformMoneyInMessage || hasPlatformMoneyInHistory || hasPlatformSpecificInMessage || hasPlatformSpecificInHistory) &&
              !hasGeneralMoneyOnly) {
            matchesSituation = true;
            if ((hasPlatformMoneyInHistory || hasPlatformSpecificInHistory) && !hasPlatformMoneyInMessage && !hasPlatformSpecificInMessage) {
              console.log(`📋 Geld/Coins in conversationHistory erkannt!`);
            }
          }
          
          // Kontaktdaten außerhalb der Plattform (in aktueller Nachricht UND conversationHistory)
          const hasRemovedTag = lowerMessage.includes("[removed]") || lowerMessage.includes("removed") ||
                               (conversationContextText && (conversationContextText.includes("[removed]") || conversationContextText.includes("removed")));
          const hasMaskedPhone = /\d{3,4}\*{3,}/.test(customerMessage) || /\d{3,4}\.{3,}/.test(customerMessage) ||
                                (conversationContextText && (/\d{3,4}\*{3,}/.test(conversationContextText) || /\d{3,4}\.{3,}/.test(conversationContextText)));
          const hasMaskedEmail = /[a-zA-Z0-9._%+-]+\*{3,}@/.test(customerMessage) || /[a-zA-Z0-9._%+-]+\*{3,}/.test(customerMessage) ||
                               (conversationContextText && (/[a-zA-Z0-9._%+-]+\*{3,}@/.test(conversationContextText) || /[a-zA-Z0-9._%+-]+\*{3,}/.test(conversationContextText)));
          const hasMaskedContact = /\*{4,}/.test(customerMessage) || /\*{3,}/.test(customerMessage) ||
                                 (conversationContextText && (/\*{4,}/.test(conversationContextText) || /\*{3,}/.test(conversationContextText)));
          const contactKeywords = ["telegram", "instagram", "whatsapp", "nummer", "schreib mir an", "schreib mir doch an", "kontakt", "email"];
          const hasContactKeywords = contactKeywords.some(keyword => lowerMessage.includes(keyword)) ||
                                    (conversationContextText && contactKeywords.some(keyword => conversationContextText.includes(keyword)));
          
          if ((situationLower.includes("kontakt") || situationLower.includes("plattform")) &&
              (hasRemovedTag || hasMaskedPhone || hasMaskedEmail || hasMaskedContact || hasContactKeywords)) {
            matchesSituation = true;
            if (conversationContextText && !lowerMessage.includes("telegram") && !lowerMessage.includes("instagram") && !lowerMessage.includes("whatsapp")) {
              console.log(`📋 Kontaktdaten in conversationHistory erkannt!`);
            }
          }
        }
        
        // 🚨 NEU: Überspringe, wenn LLM diese Situation bereits erkannt hat (vermeide Duplikate)
        if (matchesSituation && situationResponse && !llmDetectedSituations.includes(situationName)) {
          if (!detectedSituations.includes(situationName)) {
            detectedSituations.push(situationName);
          }
          specificInstructions += `\n\n📋 BENUTZERDEFINIERTE SITUATION: ${situationName}\n${situationResponse}`;
        }
      }
    }
    
    // 🚨 NEU: Top-Situationen begrenzen (nur Top 3, nicht alle!)
    // Problem: Zu viele Situationen verwässern die Nachricht
    // Lösung: Sortiere nach Relevanz und nimm nur die Top 3
    if (detectedSituations.length > 3) {
      // Sammle Situationen mit ihren Ähnlichkeits-Scores (für semantische Erkennung)
      const situationScores = [];
      if (messageEmbedding) {
        for (const situationName of detectedSituations) {
          try {
            const situationEmbedding = getSituationEmbedding(situationName);
            if (situationEmbedding) {
              const semanticSimilarity = cosineSimilarity(messageEmbedding, situationEmbedding);
              const normalizedSimilarity = (semanticSimilarity + 1) / 2;
              situationScores.push({ situation: situationName, score: normalizedSimilarity });
            } else {
              // Fallback: Wenn kein Embedding, Score = 0.5 (mittlere Priorität)
              situationScores.push({ situation: situationName, score: 0.5 });
            }
          } catch (err) {
            // Ignoriere Fehler, Score = 0.5
            situationScores.push({ situation: situationName, score: 0.5 });
          }
        }
      } else {
        // Fallback: Wenn kein messageEmbedding, alle gleich gewichten
        detectedSituations.forEach(s => situationScores.push({ situation: s, score: 0.5 }));
      }
      
      // Sortiere nach Score (höchste zuerst) und nimm nur Top 2
      if (situationScores.length > 0) {
        situationScores.sort((a, b) => b.score - a.score);
        const topSituations = situationScores.slice(0, 2).map(s => s.situation);
        
        console.log(`📊 Reduziere Situationen von ${detectedSituations.length} auf Top 2: ${topSituations.join(', ')}`);
        detectedSituations = topSituations;
      } else {
        // Fallback: Wenn keine Scores, nimm einfach die ersten 2
        console.log(`📊 Reduziere Situationen von ${detectedSituations.length} auf Top 2 (keine Scores verfügbar)`);
        detectedSituations = detectedSituations.slice(0, 2);
      }
    }
    
    // 🚨🚨🚨 PRIORISIERUNG & FALSCH-POSITIV-FILTER 🚨🚨🚨
    // 1. Treffen-Anfragen haben HÖCHSTE PRIORITÄT
    // 2. Filtere Falsch-Positiv-Erkennungen (z.B. "sexuell" bei harmlosen Nachrichten)
    // 3. Priorisiere nach Wichtigkeit: Treffen > Kontaktdaten > Bilder > Sexuelle Themen > Andere
    
    const hasMeetingRequest = detectedSituations.includes("Treffen/Termine");
    const hasSexualTopics = detectedSituations.includes("Sexuelle Themen");
    
    // 🚨 VEREINHEITLICHT: Einheitliche Logik für "Sexuelle Themen"-Filterung
    // Prüfe zuerst, ob aktuelle Nachricht wirklich explizit sexuell ist
    const explicitSexualKeywords = ["titten", "brüste", "arsch", "po", "pussy", "schwanz", "sex", "ficken", 
                                   "wichsen", "lecken", "blasen", "squiten", "muschi", "zunge", "schamlippen", 
                                   "kitzler", "clitoris", "penis", "dick", "sperma", "orgasmus", 
                                   "nass", "feucht", "erregt", "horny", "hard"];
    const hasExplicitSexualInMessage = explicitSexualKeywords.some(keyword => 
      lowerMessage.includes(keyword) || (conversationContextText && conversationContextText.toLowerCase().includes(keyword))
    );
    
    // 🚨 PRIORISIERUNG: Treffen-Anfrage hat höchste Priorität - wenn keine explizit sexuellen Wörter → entferne "Sexuelle Themen"
    if (hasSexualTopics && hasMeetingRequest && !hasExplicitSexualInMessage) {
      detectedSituations = detectedSituations.filter(s => s !== "Sexuelle Themen");
      console.log(`🚨 PRIORISIERUNG: "Sexuelle Themen" entfernt - Treffen-Anfrage hat Priorität (aktuelle Nachricht nicht explizit sexuell)`);
    }
    // Wenn aktuelle Nachricht explizit sexuell ist → behalte "Sexuelle Themen" (auch bei Treffen-Anfrage)
    else if (hasSexualTopics && hasMeetingRequest && hasExplicitSexualInMessage) {
      console.log(`📊 "Sexuelle Themen" behalten: Aktuelle Nachricht ist explizit sexuell UND Treffen-Anfrage`);
    }
    // Wenn keine Treffen-Anfrage, aber "Sexuelle Themen" erkannt → prüfe ob wirklich sexuell
    else if (hasSexualTopics && !hasMeetingRequest && !hasExplicitSexualInMessage) {
      detectedSituations = detectedSituations.filter(s => s !== "Sexuelle Themen");
      console.log(`📊 "Sexuelle Themen" entfernt: Falsch erkannt (keine explizit sexuellen Wörter in aktueller Nachricht)`);
    }
    else if (hasSexualTopics && hasExplicitSexualInMessage) {
      console.log(`📊 "Sexuelle Themen" behalten: Explizit sexuelle Wörter gefunden`);
    }
    
    // 🚨 NEU: Priorisierung nach Wichtigkeit
    const situationPriority = {
      "Treffen/Termine": 10,
      "Kontaktdaten außerhalb der Plattform": 9,
      "Bilder Anfrage": 8,
      "Geld/Coins": 7,
      "Sexuelle Themen": 6,
      "Bot-Vorwurf": 5,
      "Standort": 4,
      "Beruf": 3,
      "Moderator-Outing": 2
    };
    
    // Sortiere Situationen nach Priorität (höchste zuerst)
    detectedSituations.sort((a, b) => {
      const priorityA = situationPriority[a] || 1;
      const priorityB = situationPriority[b] || 1;
      return priorityB - priorityA;
    });
    
    // 🚨 OPTIONAL: Learning-System für Priorisierung (nur wenn Daten verfügbar)
    if (hasMeetingRequest && detectedSituations.includes("Sexuelle Themen") && learningContextResult && learningContextResult.learningStats) {
      const learningStats = learningContextResult.learningStats;
      const sexualTopicsBadAtMeetings = learningStats.situationFeedback && 
                                       learningStats.situationFeedback["Sexuelle Themen"] &&
                                       learningStats.situationFeedback["Sexuelle Themen"].badAtMeetings;
      if (sexualTopicsBadAtMeetings && sexualTopicsBadAtMeetings > 2) {
        const index = detectedSituations.indexOf("Sexuelle Themen");
        if (index > -1) {
          detectedSituations.splice(index, 1);
          console.log(`🚨 LEARNING-SYSTEM: "Sexuelle Themen" entfernt - ${sexualTopicsBadAtMeetings}x schlechte Performance bei Treffen-Anfragen`);
        }
      }
    }
    
    // Prüfe auf Ablehnung/Rejection (in aktueller Nachricht UND conversationHistory)
    const rejectionKeywords = [
      "will nicht", "will kein", "will keine", "will nie", "kein interesse", "kein bock", "keine lust",
      "lass mich in ruhe", "lass mich einfach in ruhe", "verpiss dich", "geh weg", "nerv mich nicht",
      "nie sex", "nie sex haben", "nie mit euch", "nie mit dir", "nie mit dir sex", "nie mit euch sex",
      "werde nie", "werde nie meine", "werde nie meine freundin", "werde nie betrügen", "nie betrügen",
      "hab kein interesse", "hab keine lust", "hab kein bock", "hab kein interesse an euch", "hab kein interesse an dir"
    ];
    const isRejection = rejectionKeywords.some(keyword => lowerMessage.includes(keyword)) ||
                       (conversationContextText && rejectionKeywords.some(keyword => conversationContextText.includes(keyword)));
    
    // Prüfe auf sexuelle Themen (nur wenn KEINE Ablehnung) - in aktueller Nachricht UND conversationHistory
    const sexualKeywords = [
      "titten", "brüste", "arsch", "po", "pussy", "schwanz", "sex", "ficken", "vorlieben",
      "sexuell", "geil", "lust", "wichsen", "lecken", "blasen", "squiten", "kuss",
      "muschi", "zunge", "schamlippen", "kitzler", "clitoris", "penis", "dick", "sperma", "orgasmus",
      "komm", "nass", "feucht", "erregt", "horny", "hard", "krakel", "glasur", "zucker",
      "spermaküsse", "tittenfick", "massieren"
    ];
    const hasSexualInMessage = sexualKeywords.some(keyword => lowerMessage.includes(keyword));
    const hasSexualInHistory = conversationContextText ? sexualKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
    const hasSexualContent = !isRejection && (hasSexualInMessage || hasSexualInHistory);
    
    if (isRejection) {
      detectedSituations = detectedSituations.filter(s => !s.toLowerCase().includes("sexuell"));
      specificInstructions += `\n\n🚫🚫🚫🚫🚫 KRITISCH: KUNDE LEHNT AB - LOGISCHES DENKEN! 🚫🚫🚫🚫🚫\n\n`;
      specificInstructions += `Der Kunde hat KLAR abgelehnt (z.B. "ich will nie sex haben", "lass mich in Ruhe", "kein Interesse").\n\n`;
      specificInstructions += `🧠 LOGISCHES DENKEN: 🧠\n`;
      specificInstructions += `- Der Kunde ist auf einer Dating-Plattform → Was sucht er dann hier?\n`;
      specificInstructions += `- Logische Schlussfolgerung: Vielleicht sucht er nur Freundschaft? Oder Beziehung ohne Sex?\n`;
      specificInstructions += `- Logische Frage: "Okay, das kann ich verstehen. Aber was suchst du dann hier genau? Suchst du hier nur eine Freundschaft?"\n`;
      specificInstructions += `- ODER: "Okay, verstehe ich. Tut mir leid, wenn wir zu aufdringlich waren. Was suchst du denn dann hier?"\n\n`;
      specificInstructions += `🚨🚨🚨 ABSOLUT KRITISCH: 🚨🚨🚨\n`;
      specificInstructions += `- Respektiere die Ablehnung - sei HÖFLICH und RESPEKTVOLL!\n`;
      specificInstructions += `- KEINE aufdringlichen Antworten, KEINE Versuche, ihn zu überzeugen!\n`;
      specificInstructions += `- KEINE sexuellen Themen, KEINE flirty Antworten!\n`;
      specificInstructions += `- Aber: Denke LOGISCH - wenn er ablehnt, frage logisch, was er dann hier sucht!\n`;
      specificInstructions += `- Wenn der Kunde sagt "lass mich in Ruhe", dann respektiere das und antworte kurz und höflich!\n`;
      specificInstructions += `- KEINE langen Erklärungen, KEINE Versuche, das Gespräch zu retten - aber LOGISCHE Fragen sind OK!\n\n`;
    }
    
    // Prüfe auf verschleierte Kontaktdaten (in aktueller Nachricht UND conversationHistory)
    const hasRemovedTag = lowerMessage.includes("[removed]") || lowerMessage.includes("removed") ||
                         (conversationContextText && (conversationContextText.includes("[removed]") || conversationContextText.includes("removed")));
    const hasMaskedPhone = /\d{3,4}\*{3,}/.test(customerMessage) || /\d{3,4}\.{3,}/.test(customerMessage) ||
                         (conversationContextText && (/\d{3,4}\*{3,}/.test(conversationContextText) || /\d{3,4}\.{3,}/.test(conversationContextText)));
    const hasMaskedEmail = /[a-zA-Z0-9._%+-]+\*{3,}@/.test(customerMessage) || /[a-zA-Z0-9._%+-]+\*{3,}/.test(customerMessage) ||
                          (conversationContextText && (/[a-zA-Z0-9._%+-]+\*{3,}@/.test(conversationContextText) || /[a-zA-Z0-9._%+-]+\*{3,}/.test(conversationContextText)));
    const hasMaskedContact = /\*{4,}/.test(customerMessage) || /\*{3,}/.test(customerMessage) ||
                            (conversationContextText && (/\*{4,}/.test(conversationContextText) || /\*{3,}/.test(conversationContextText)));
    const contactKeywords = ["telegram", "instagram", "whatsapp", "nummer", "schreib mir an", "schreib mir doch an", "kontakt", "email"];
    const hasContactKeywordsInMessage = contactKeywords.some(keyword => lowerMessage.includes(keyword)) ||
                                       (lowerMessage.includes("nummer") && (lowerMessage.includes("schreib") || lowerMessage.includes("kontakt"))) ||
                                       (lowerMessage.includes("kontakt") && (lowerMessage.includes("außerhalb") || lowerMessage.includes("anders"))) ||
                                       (lowerMessage.includes("email") && (lowerMessage.includes("schreib") || lowerMessage.includes("kontakt")));
    const hasContactKeywordsInHistory = conversationContextText ? (
      contactKeywords.some(keyword => conversationContextText.includes(keyword)) ||
      (conversationContextText.includes("nummer") && (conversationContextText.includes("schreib") || conversationContextText.includes("kontakt"))) ||
      (conversationContextText.includes("kontakt") && (conversationContextText.includes("außerhalb") || conversationContextText.includes("anders"))) ||
      (conversationContextText.includes("email") && (conversationContextText.includes("schreib") || conversationContextText.includes("kontakt")))
    ) : false;
    const hasContactKeywords = hasContactKeywordsInMessage || hasContactKeywordsInHistory;
    
    if (hasRemovedTag || hasMaskedPhone || hasMaskedEmail || hasMaskedContact || hasContactKeywords) {
      if (!detectedSituations.includes("Kontaktdaten außerhalb der Plattform")) {
        detectedSituations.push("Kontaktdaten außerhalb der Plattform");
      }
      if (!detectedSituations.includes("Geld/Coins")) {
        detectedSituations.push("Geld/Coins");
      }
      const contactSituation = allRules?.situationalResponses?.["Kontaktdaten außerhalb der Plattform"];
      if (contactSituation) {
        specificInstructions += `\n\n🚫🚫🚫 KRITISCH: KONTAKTDATEN AUSSERHALB DER PLATTFORM ERKANNT 🚫🚫🚫\n${contactSituation}`;
      } else {
        specificInstructions += `\n\n🚫🚫🚫 KRITISCH: KONTAKTDATEN AUSSERHALB DER PLATTFORM ERKANNT 🚫🚫🚫
- Der Kunde versucht, seine Kontaktdaten (Telefonnummer, Email, Telegram, Instagram) zu teilen, um außerhalb der Plattform zu kommunizieren.
- Das ist NICHT erlaubt - wir dürfen nur auf dieser Plattform schreiben.
- Reagiere NATÜRLICH und höflich, GENAU WIE bei Geld/Coins.
- NIEMALS direkt sagen 'Es ist wichtig, dass wir hier bleiben' oder 'Wir müssen hier schreiben' - das klingt zu roboterhaft!
- Orientiere dich STRENG an den Training-Daten-Beispielen für Geld/Coins - diese zeigen, wie man natürlich darauf reagiert.
- Weiche freundlich aus und lenke das Gespräch zurück zum aktuellen Thema, OHNE explizit die Plattform-Regeln zu erwähnen.
- WICHTIG: Die detectedSituations enthalten "Geld/Coins", damit die passenden Training-Daten-Beispiele verwendet werden!`;
      }
    }
    
    // Prüfe auf Wohnort-Frage
    let locationQuestionError = null;
    if (isLocationQuestionFunc && typeof isLocationQuestionFunc === 'function' && isLocationQuestionFunc(customerMessage)) {
      console.log("📍 Wohnort-Frage erkannt!");
      
      // WICHTIG: Datenquellen wie in alter reply.js
      const customerInfo = profileInfo?.customerInfo || profileInfo || {};
      // 🚨🚨🚨 FIX: Sicherstellen, dass moderatorInfo.city korrekt extrahiert wird
      const moderatorInfo = extractedUserInfo?.assistant || profileInfo?.moderatorInfo || {};
      const customerCity = customerInfo.city || customerInfo.wohnort || null;
      // 🚨 FIX: Prüfe zuerst profileInfo.moderatorInfo.city (direkt aus metaData), dann extractedUserInfo
      const fakeCity = profileInfo?.moderatorInfo?.city || 
                       profileInfo?.moderatorInfo?.Wohnort || 
                       moderatorInfo.Wohnort || 
                       moderatorInfo.city || 
                       extractedUserInfo?.assistant?.city ||
                       extractedUserInfo?.assistant?.Wohnort || 
                       null;
      
      console.log("📍 Kunden-Wohnort:", customerCity || "(nicht gefunden)");
      console.log("📍 Fake-Wohnort:", fakeCity || "(nicht gefunden)");
      console.log("📍 DEBUG - profileInfo.moderatorInfo:", JSON.stringify(profileInfo?.moderatorInfo || {}));
      console.log("📍 DEBUG - extractedUserInfo.assistant:", JSON.stringify(extractedUserInfo?.assistant || {}));
      
      // Wenn im Fake-Profil bereits ein Wohnort steht, verwende diesen
      if (fakeCity && fakeCity.trim() !== "" && fakeCity.toLowerCase() !== "sag ich später") {
        console.log("✅ Verwende Wohnort aus Fake-Profil:", fakeCity);
        specificInstructions += `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: WOHNORT-FRAGE ERKANNT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
        specificInstructions += `- Der Kunde fragt, woher du kommst / wo du wohnst.\n`;
        specificInstructions += `- Im Fake-Profil steht bereits: "${fakeCity}"\n`;
        specificInstructions += `🚨🚨🚨 ABSOLUT KRITISCH: NENNE DIESEN WOHNORT "${fakeCity}" ZUERST in deiner Antwort, DANN stelle eine Frage zurück!\n`;
        specificInstructions += `✅ RICHTIGE STRUKTUR: "Ich wohne in ${fakeCity}. Woher kommst du denn?" ODER "Ich komme aus ${fakeCity}. Und du?"\n`;
        specificInstructions += `❌ FALSCH: "Woher kommst du denn?" OHNE den Wohnort zu nennen!\n`;
        specificInstructions += `🚨🚨🚨 WICHTIG: Der Kunde hat NACH DEM WOHNORT GEFRAGT - du MUSST ihn nennen, nicht zurückfragen ohne ihn zu nennen! 🚨🚨🚨\n`;
      } else if (customerCity && customerCity.trim() !== "" && customerCity.toLowerCase() !== "sag ich später") {
        // Wenn kein Fake-Wohnort, aber Kunden-Wohnort vorhanden: Finde eine Stadt im 50km Umkreis
        const nearbyCity = findNearbyCityFunc && typeof findNearbyCityFunc === 'function' 
          ? findNearbyCityFunc(customerCity) 
          : null;
        if (nearbyCity) {
          console.log(`✅ Wohnort im 50km Umkreis gefunden: ${nearbyCity} (nahe ${customerCity})`);
          specificInstructions += `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: WOHNORT-FRAGE ERKANNT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
          specificInstructions += `- Der Kunde fragt, woher du kommst / wo du wohnst.\n`;
          specificInstructions += `- Der Kunde kommt aus: "${customerCity}"\n`;
          specificInstructions += `- Nenne eine Stadt/Dorf im 50km Umkreis: "${nearbyCity}"\n`;
          specificInstructions += `🚨🚨🚨 ABSOLUT KRITISCH: NENNE DIESEN WOHNORT "${nearbyCity}" ZUERST in deiner Antwort, DANN stelle eine Frage zurück!\n`;
          specificInstructions += `✅ RICHTIGE STRUKTUR: "Ich wohne in ${nearbyCity}. Woher kommst du denn?" ODER "Ich komme aus ${nearbyCity}. Und du?"\n`;
          specificInstructions += `❌ FALSCH: "Woher kommst du denn?" OHNE den Wohnort zu nennen!\n`;
          specificInstructions += `🚨🚨🚨 WICHTIG: Der Kunde hat NACH DEM WOHNORT GEFRAGT - du MUSST ihn nennen, nicht zurückfragen ohne ihn zu nennen! 🚨🚨🚨\n`;
        } else {
          // Keine passende Stadt gefunden - Fehlermeldung
          console.error("❌ FEHLER: Keine Stadt im 50km Umkreis gefunden für:", customerCity);
          console.error("❌ FEHLER: Menschliche Moderation erforderlich!");
          locationQuestionError = {
            error: "WOHNORT-FRAGE: Keine passende Stadt im Umkreis gefunden",
            message: "Der Kunde fragt nach dem Wohnort, aber es konnte keine passende Stadt im 50km Umkreis gefunden werden. Bitte manuell reagieren.",
            requiresHumanModeration: true,
            customerCity: customerCity,
            fakeCity: fakeCity
          };
        }
      } else {
        // Weder Fake-Wohnort noch Kunden-Wohnort vorhanden - Fehlermeldung
        console.error("❌ FEHLER: Weder Fake-Wohnort noch Kunden-Wohnort gefunden!");
        console.error("❌ FEHLER: Menschliche Moderation erforderlich!");
        locationQuestionError = {
          error: "WOHNORT-FRAGE: Keine Wohnort-Informationen verfügbar",
          message: "Der Kunde fragt nach dem Wohnort, aber weder im Fake-Profil noch beim Kunden ist ein Wohnort hinterlegt. Bitte manuell reagieren.",
          requiresHumanModeration: true,
          customerCity: customerCity || null,
          fakeCity: fakeCity || null
        };
      }
    }
    
    // Prüfe auf Chat-Verlauf-Referenz
    const chatHistoryReferencePatterns = [
      /schau.*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(hier|dort|am|vom|geschrieben|geschickt)/i,
      /(sieh|siehe|schau).*(mal|doch|bitte).*(mein|meine).*(chat|nachricht|nachrichten|schreiben|geschrieben)/i,
      /(sieh|siehe|schau).*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(am|vom|geschrieben|geschickt)/i,
      /(schau|sieh|siehe).*(mal|doch|bitte).*(was|was ich).*(dir|dich|ihr).*(\d{1,2}\.\d{1,2}\.\d{2,4})/i,
      /(schau|sieh|siehe).*(mal|doch|bitte).*(mein|meine).*(chat|nachricht|nachrichten).*(\d{1,2}\.\d{1,2}\.\d{2,4})/i
    ];
    const isChatHistoryReference = chatHistoryReferencePatterns.some(pattern => pattern.test(lowerMessage));
    
    if (isChatHistoryReference) {
      specificInstructions += `\n\n🚨🚨🚨 KRITISCH: KUNDE VERWEIST AUF ALTE NACHRICHT IM CHAT-VERLAUF 🚨🚨🚨
- Der Kunde sagt, dass du dir eine alte Nachricht anschauen sollst (z.B. "schau mal was ich dir am 13.10. geschrieben habe")
- Du kannst NICHT den gesamten Chat-Verlauf sehen/laden
- Antworte so: "Tut mir leid, bei mir lädt gerade nicht der ganze Chat. Was genau hast du denn da geschrieben?"
- Oder ähnlich: "Oh, das tut mir leid. Bei mir funktioniert der Chat-Verlauf gerade nicht richtig. Kannst du mir nochmal sagen, was du da geschrieben hast?"
- Sei natürlich und entschuldigend, aber frage nach, was genau geschrieben wurde
- KEINE technischen Erklärungen, einfach natürlich und menschlich reagieren`;
    }
    
    // Prüfe auf Wissensfragen (in aktueller Nachricht UND conversationHistory)
    const knowledgeQuestionPatterns = [
      /erzähl.*(mir|du).*(was|etwas).*(über|von)/i,
      /was.*(ist|sind|bedeutet).*(die|der|das|die menschheit|amerika|flugzeug|waschmaschine|ameisen)/i,
      /wie.*(funktioniert|denken|arbeiten).*(flugzeug|waschmaschine|motor|computer|ameisen|gehirn|tiere)/i
    ];
    const isKnowledgeQuestion = knowledgeQuestionPatterns.some(pattern => pattern.test(lowerMessage)) ||
                               (conversationContextText && knowledgeQuestionPatterns.some(pattern => pattern.test(conversationContextText)));
    
    if (isKnowledgeQuestion) {
      specificInstructions += `\n\n🚫🚫🚫 WISSENSFRAGEN & ZU SCHLAU WIRKEN – HÖCHSTE PRIORITÄT 🚫🚫🚫

Du darfst unter KEINEN UMSTÄNDEN:
- auf allgemeine Wissensfragen antworten (z.B. "erzähl mir was über Amerika", "was ist die Menschheit", "wie funktioniert ein Flugzeug", "wie funktioniert eine Waschmaschine", "wie denken Ameisen")
- technische Dinge erklären (Waschmaschine, Motor, Computer, etc.)
- wissenschaftliche oder biologische Dinge erklären (Tiere, Ameisen, Gehirn, etc.)
- zu schlau oder gebildet wirken
- historische, geographische oder politische Fakten nennen
- wie eine Wissensdatenbank oder ein Lexikon wirken
- lange Erklärungen geben, auch wenn der Kunde danach fragt
- SACHLICH oder WISSENSCHAFTLICH antworten - NIEMALS!

Diese Regel hat HÖCHSTE PRIORITÄT!

Wenn der Kunde nach allgemeinem Wissen, technischen Dingen, Biologie, Tieren oder wissenschaftlichen Themen fragt:
- Weiche aus - NIEMALS sachlich antworten!
- Sage, dass du das nicht weißt oder nicht interessiert bist
- Lenke das Thema auf persönliche Dinge, Gefühle oder das Gespräch
- NIEMALS wissenschaftliche oder sachliche Erklärungen geben!

WICHTIG: Wirke NICHT zu schlau! Du bist eine normale Person, keine Wissensdatenbank! Weiche IMMER aus, auch wenn der Kunde explizit danach fragt! NIEMALS sachlich oder wissenschaftlich antworten!`;
    }
    
    // Geschlechter-Rollenverständnis
    const fakeGender = extractedUserInfo?.assistant?.Gender || null;
    if (fakeGender) {
      const isFemale = fakeGender === "weiblich" || fakeGender === "w" || fakeGender === "female";
      specificInstructions += `\n\n🚨🚨🚨 KRITISCH: GESCHLECHTER-ROLLENVERSTÄNDNIS 🚨🚨🚨\n`;
      specificInstructions += `- Du bist: ${isFemale ? "eine FRAU" : "ein MANN"}\n`;
      specificInstructions += `- Der Kunde ist: ${isFemale ? "ein MANN (schreibt dir als Frau)" : "eine FRAU (schreibt dir als Mann)"}\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Wenn der Kunde über DICH redet (z.B. "deine Löcher", "deine Titten", "dein Arsch", "dein Schwanz", "dein Penis"), dann redet er über DICH - ${isFemale ? "die FRAU" : "den MANN"}!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Du bist ${isFemale ? "die FRAU" : "der MANN"}, der Kunde ist ${isFemale ? "der MANN" : "die FRAU"}!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Wenn der Kunde fragt "welches deiner Löcher" oder "welche deiner Körperteile", dann fragst du NICHT zurück "welches deiner Löcher" - du bist ${isFemale ? "die FRAU" : "der MANN"}, der Kunde ist ${isFemale ? "der MANN" : "die FRAU"}!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Bei sexuellen Themen: Der Kunde fragt DICH nach DEINEN Körperteilen/Vorlieben - nicht umgekehrt!\n`;
      specificInstructions += `- 🚨🚨🚨 KRITISCH: Verstehe die ROLLE: Du bist ${isFemale ? "die FRAU" : "der MANN"}, der Kunde ist ${isFemale ? "der MANN" : "die FRAU"} - bei Fragen nach Körperteilen/Vorlieben bezieht sich "dein/deine" auf DICH, nicht auf den Kunden!\n`;
      
      // 🚨 NEU: Spezifische Anweisungen für sexuelle Rollen/Positionen
      if (isFemale) {
        specificInstructions += `\n🚨🚨🚨 KRITISCH: SEXUELLE ROLLEN/POSITIONEN (FRAU zu MANN) 🚨🚨🚨\n`;
        specificInstructions += `- Du bist die FRAU, der Kunde ist der MANN\n`;
        specificInstructions += `- Du nimmst PASSIVE/RECEPTIVE Rollen ein (du wirst "genommen", nicht du "nimmst")\n`;
        specificInstructions += `- ✅ RICHTIG: "Ich würde gerne doggy genommen werden", "Ich liebe es, wenn du mich doggy nimmst", "Ich würde gerne von dir genommen werden"\n`;
        specificInstructions += `- ❌ FALSCH: "Ich würde dich doggy nehmen", "Ich würde dich nehmen", "Ich würde dich ficken" (das sind aktive Rollen für Männer!)\n`;
        specificInstructions += `- ✅ RICHTIG: "Ich würde gerne, dass du mich leckst", "Ich liebe es, wenn du mich verwöhnst", "Ich würde gerne von dir verwöhnt werden"\n`;
        specificInstructions += `- ❌ FALSCH: "Ich würde dich lecken", "Ich würde dich verwöhnen" (wenn du die aktive Rolle beschreibst, die der MANN einnimmt)\n`;
        specificInstructions += `- 🚨 KRITISCH: Bei sexuellen Positionen/Rollen: Du bist die PASSIVE Partei, der Kunde ist die AKTIVE Partei!\n`;
      } else {
        specificInstructions += `\n🚨🚨🚨 KRITISCH: SEXUELLE ROLLEN/POSITIONEN (MANN zu FRAU) 🚨🚨🚨\n`;
        specificInstructions += `- Du bist der MANN, der Kunde ist die FRAU\n`;
        specificInstructions += `- Du nimmst AKTIVE Rollen ein (du "nimmst", nicht du wirst "genommen")\n`;
        specificInstructions += `- ✅ RICHTIG: "Ich würde dich doggy nehmen", "Ich würde dich gerne nehmen", "Ich würde dich ficken"\n`;
        specificInstructions += `- ❌ FALSCH: "Ich würde gerne doggy genommen werden", "Ich würde gerne von dir genommen werden" (das sind passive Rollen für Frauen!)\n`;
        specificInstructions += `- ✅ RICHTIG: "Ich würde dich gerne lecken", "Ich würde dich verwöhnen", "Ich würde dich gerne verwöhnen"\n`;
        specificInstructions += `- ❌ FALSCH: "Ich würde gerne, dass du mich leckst", "Ich würde gerne von dir verwöhnt werden" (wenn du die passive Rolle beschreibst, die die FRAU einnimmt)\n`;
        specificInstructions += `- 🚨 KRITISCH: Bei sexuellen Positionen/Rollen: Du bist die AKTIVE Partei, der Kunde ist die PASSIVE Partei!\n`;
      }
      
      specificInstructions += `- Passe deinen Schreibstil entsprechend an (${isFemale ? "Frau" : "Mann"} zu ${isFemale ? "Mann" : "Frau"})\n`;
    }
    
    // Berufsfrage: Spezielle Logik für realistische Berufe
    const isJobQuestion = lowerMessage.includes("was arbeitest") || lowerMessage.includes("beruf") ||
         lowerMessage.includes("was machst du beruflich") || lowerMessage.includes("job") ||
                         lowerMessage.includes("wo arbeitest");
    if (isJobQuestion && !specificInstructions.includes("Beruf") && !specificInstructions.includes("beruf")) {
      const realisticJobs = {
        "weiblich": ["Bürokauffrau", "Erzieherin", "Krankenschwester", "Verkäuferin", "Friseurin", "Köchin", "Rezeptionistin", "Marketing Managerin", "Designerin"],
        "männlich": ["Elektriker", "Mechaniker", "Verkäufer", "Koch", "Bürokaufmann", "IT-Support", "Marketing Manager", "Designer", "Handwerker"]
      };
      const fakeGender = extractedUserInfo?.assistant?.Gender || null;
      const isFemale = fakeGender === "weiblich" || fakeGender === "w" || fakeGender === "female";
      const jobList = isFemale ? realisticJobs["weiblich"] : realisticJobs["männlich"];
      const randomJob = jobList[Math.floor(Math.random() * jobList.length)];
      specificInstructions += `\n\n💼 BERUFSFRAGE:
- Der Kunde fragt nach deinem Beruf
- Falls kein Beruf im Logbuch steht, erfinde einen realistischen Beruf: "${randomJob}"
- Nenne den Beruf natürlich in deiner Antwort
- Keine Flugzeugbegleiter, Zugkontrolleur oder ähnliche Berufe (zu spezifisch, könnte zu Treffen führen)`;
    }
    
    // Kompliment-Regel (wird später im Profile-Filter hinzugefügt, hier nur Platzhalter)
    
    // 🚨 KRITISCH: Prüfe auch Kontext aus letzten Nachrichten für Treffen-Erkennung!
    let isCustomerMeetingRequest = isMeetingRequestFunc && typeof isMeetingRequestFunc === 'function' 
      ? isMeetingRequestFunc(customerMessage, "") 
      : false;
    
    // 🚨🚨🚨 NEU: Unterscheide zwischen direkter Anfrage und allgemeiner Diskussion!
    // Importiere isDirectMeetingRequest (falls verfügbar)
    let isDirectMeetingRequest = false;
    try {
      // Versuche die Funktion aus reply.js zu importieren
      const { isDirectMeetingRequest: checkDirect } = require('../routes/reply');
      if (typeof checkDirect === 'function') {
        isDirectMeetingRequest = checkDirect(customerMessage);
      }
    } catch (e) {
      // Fallback: Pattern-Matching direkt hier
      const lower = customerMessage.toLowerCase();
      isDirectMeetingRequest = /\b(was|wie)\s+(machst|hast|bist)\s+du\s+(morgen|heute|am\s+wochenende)\??/i.test(lower) ||
                               /\b(hast|hättest|bist)\s+du\s+(morgen|heute|am\s+wochenende)\s+(zeit|frei)\??/i.test(lower);
    }
    
    // Wenn Kontext aus letzten Nachrichten Treffen zeigt, dann ist es auch eine Treffen-Anfrage!
    if (hasMeetingContext && !isCustomerMeetingRequest) {
      isCustomerMeetingRequest = true;
      console.log('🚨 KRITISCH: Treffen-Anfrage aus Kontext erkannt (nicht direkt in aktueller Nachricht)!');
      
      // 🚨🚨🚨 FIX: Füge "Treffen/Termine" zu detectedSituations hinzu, wenn es noch nicht vorhanden ist!
      // Das ist KRITISCH, damit die richtigen Training-Daten geladen werden!
      if (!detectedSituations.includes("Treffen/Termine")) {
        detectedSituations.push("Treffen/Termine");
        console.log('✅ Situation "Treffen/Termine" hinzugefügt (aus Kontext erkannt)');
      }
      
      // 🚨🚨🚨 NEU: Unterscheide zwischen direkter Anfrage und allgemeiner Diskussion!
      if (isDirectMeetingRequest) {
        // DIREKTE ANFRAGE: Abweisend, aber höflich
        if (!specificInstructions.includes("DIREKTE TREFFEN-ANFRAGE")) {
          specificInstructions += `\n\n🚨🚨🚨🚨🚨 DIREKTE TREFFEN-ANFRAGE ERKANNT! 🚨🚨🚨🚨🚨\n`;
          specificInstructions += `- Der Kunde fragt DIREKT nach einem Treffen (z.B. "was machst du morgen?", "hast du heute Zeit?")\n`;
          specificInstructions += `- 🚨 KRITISCH: Du MUSST ABLEHNEN, aber HÖFLICH!\n`;
          specificInstructions += `- Nutze NUR Training-Daten-Beispiele, die ABLEHNEN (z.B. "morgen geht es leider nicht", "heute passt es nicht")\n`;
          specificInstructions += `- Stelle KEINE generischen Fragen wie "was machst du am Wochenende?"\n`;
          specificInstructions += `- Biete eine ALTERNATIVE an (z.B. "aber ich würde dich gerne noch besser kennenlernen")\n`;
          specificInstructions += `- Orientiere dich STRENG an Training-Daten für ABLEHNUNGEN von direkten Treffen-Anfragen!\n\n`;
        }
      } else {
        // ALLGEMEINE DISKUSSION: NICHT abweisend, Gefühl geben, dass es eventuell möglich ist
        if (!specificInstructions.includes("TREFFEN-DISKUSSION")) {
          specificInstructions += `\n\n🚨🚨🚨🚨🚨 TREFFEN-DISKUSSION (NICHT DIREKTE ANFRAGE)! 🚨🚨🚨🚨🚨\n`;
          specificInstructions += `- Der Kunde spricht ALLGEMEIN über Treffen/Verfügbarkeit (z.B. "wann klappt es bei dir?", "ich habe am WE immer Zeit")\n`;
          specificInstructions += `- 🚨 KRITISCH: Sei NICHT ABWEISEND! Der Kunde muss das Gefühl haben, dass es EVENTUELL möglich ist!\n`;
          specificInstructions += `- Du darfst NICHT sagen "bei mir klappt es nie am Wochenende" oder ähnliches - das würde den Kunden abschrecken!\n`;
          specificInstructions += `- Nutze Training-Daten-Beispiele, die POSITIV aber VAGUE sind (z.B. "ich schaue mal wann es bei mir klappt")\n`;
          specificInstructions += `- Stelle KEINE generischen Fragen - nutze Fragen aus Training-Daten für Treffen-Diskussion!\n`;
          specificInstructions += `- Lenke das Thema auf Chat, Gefühle, Persönlichkeit - aber ohne zu sagen, dass Treffen ausgeschlossen ist!\n`;
          specificInstructions += `- 🚨 WICHTIG: Du darfst KEIN konkretes Treffen vorschlagen/zustimmen, aber auch NICHT sagen, dass es nie klappt!\n\n`;
        }
      }
    }
    
    // 🚨🚨🚨 FIX: Wenn isCustomerMeetingRequest true ist (direkt erkannt), aber "Treffen/Termine" noch nicht in detectedSituations
    if (isCustomerMeetingRequest && !detectedSituations.includes("Treffen/Termine")) {
      detectedSituations.push("Treffen/Termine");
      console.log('✅ Situation "Treffen/Termine" hinzugefügt (direkt erkannt)');
    }
    
    // 🚨🚨🚨 NEU: Wenn direkt erkannt, aber noch keine spezifischen Anweisungen vorhanden
    if (isCustomerMeetingRequest && isDirectMeetingRequest && !specificInstructions.includes("DIREKTE TREFFEN-ANFRAGE")) {
      specificInstructions += `\n\n🚨🚨🚨🚨🚨 DIREKTE TREFFEN-ANFRAGE ERKANNT! 🚨🚨🚨🚨🚨\n`;
      specificInstructions += `- Der Kunde fragt DIREKT nach einem Treffen (z.B. "was machst du morgen?", "hast du heute Zeit?")\n`;
      specificInstructions += `- 🚨 KRITISCH: Du MUSST ABLEHNEN, aber HÖFLICH!\n`;
      specificInstructions += `- Nutze NUR Training-Daten-Beispiele, die ABLEHNEN (z.B. "morgen geht es leider nicht", "heute passt es nicht")\n`;
      specificInstructions += `- Stelle KEINE generischen Fragen wie "was machst du am Wochenende?"\n`;
      specificInstructions += `- Biete eine ALTERNATIVE an (z.B. "aber ich würde dich gerne noch besser kennenlernen")\n`;
      specificInstructions += `- Orientiere dich STRENG an Training-Daten für ABLEHNUNGEN von direkten Treffen-Anfragen!\n\n`;
    } else if (isCustomerMeetingRequest && !isDirectMeetingRequest && !specificInstructions.includes("TREFFEN-DISKUSSION")) {
      // Allgemeine Diskussion
      specificInstructions += `\n\n🚨🚨🚨🚨🚨 TREFFEN-DISKUSSION (NICHT DIREKTE ANFRAGE)! 🚨🚨🚨🚨🚨\n`;
      specificInstructions += `- Der Kunde spricht ALLGEMEIN über Treffen/Verfügbarkeit (z.B. "wann klappt es bei dir?", "ich habe am WE immer Zeit")\n`;
      specificInstructions += `- 🚨 KRITISCH: Sei NICHT ABWEISEND! Der Kunde muss das Gefühl haben, dass es EVENTUELL möglich ist!\n`;
      specificInstructions += `- Du darfst NICHT sagen "bei mir klappt es nie am Wochenende" oder ähnliches - das würde den Kunden abschrecken!\n`;
      specificInstructions += `- Nutze Training-Daten-Beispiele, die POSITIV aber VAGUE sind (z.B. "ich schaue mal wann es bei mir klappt")\n`;
      specificInstructions += `- Stelle KEINE generischen Fragen - nutze Fragen aus Training-Daten für Treffen-Diskussion!\n`;
      specificInstructions += `- Lenke das Thema auf Chat, Gefühle, Persönlichkeit - aber ohne zu sagen, dass Treffen ausgeschlossen ist!\n`;
      specificInstructions += `- 🚨 WICHTIG: Du darfst KEIN konkretes Treffen vorschlagen/zustimmen, aber auch NICHT sagen, dass es nie klappt!\n\n`;
    }
    
    return {
      detectedSituations,
      specificInstructions,
      isRejection,
      hasSexualContent,
      isCustomerMeetingRequest,
      isDirectMeetingRequest: isDirectMeetingRequest, // 🚨🚨🚨 NEU: Unterscheidung zwischen direkt und allgemein
      hasMeetingContext,
      locationQuestionError, // Fehlerfall für Wohnort-Fragen
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Situation-Detector - Fehler:', err.message);
    return {
      detectedSituations: [],
      specificInstructions: '',
      isRejection: false,
      hasSexualContent: false,
      isCustomerMeetingRequest: false,
      success: false
    };
  }
}

/**
 * Agent 11: Fake-Context-Builder
 * Baut fakeContext mit Fake-Profil-Informationen
 */
async function agentFakeContextBuilder(extractedUserInfo, profileInfo) {
  try {
    const fakeName = extractedUserInfo?.assistant?.Name || profileInfo?.moderatorInfo?.name || null;
    const fakeAge = extractedUserInfo?.assistant?.Age || profileInfo?.moderatorInfo?.birthDate?.age || null;
    const fakeCity = extractedUserInfo?.assistant?.Wohnort || profileInfo?.moderatorInfo?.city || null;
    const fakeWork = extractedUserInfo?.assistant?.Work || profileInfo?.moderatorInfo?.occupation || null;
    const fakeGender = extractedUserInfo?.assistant?.Gender || profileInfo?.moderatorInfo?.gender || null;
    
    let fakeContext = "";
    if (fakeName || fakeAge || fakeCity || fakeWork) {
      fakeContext = "\n🚨🚨🚨 KRITISCH: DEINE FAKE-PROFIL INFORMATIONEN 🚨🚨🚨\n";
      fakeContext += "- Du bist das FAKE-PROFIL - der KUNDE schreibt DIR!\n";
      if (fakeName) fakeContext += `- Dein Name: ${fakeName}\n`;
      if (fakeAge) fakeContext += `- Dein Alter: ${fakeAge} Jahre\n`;
      if (fakeCity) fakeContext += `- Dein Wohnort: ${fakeCity}\n`;
      if (fakeWork) fakeContext += `- Dein Beruf: ${fakeWork}\n`;
      fakeContext += "- 🚨 KRITISCH: Wenn der Kunde nach deinem Alter, Wohnort, Beruf oder Namen fragt, MUSST du diese Informationen verwenden!\n";
      fakeContext += "- 🚨 KRITISCH: Wenn der Kunde über dich redet (z.B. 'du hast große Brüste', 'du bist hübsch'), dann redet er über DICH - die Fake-Person!\n";
      fakeContext += "- 🚨 KRITISCH: Du bist die Person, von der der Kunde redet - verstehe das und reagiere entsprechend!\n";
      
      // 🚨 NEU: Regel für fehlende Details (z.B. Stadtteil bei nur Stadt)
      fakeContext += "\n🚨🚨🚨 KRITISCH: FEHLENDE DETAILS - REALISTISCH HANDELN! 🚨🚨🚨\n";
      fakeContext += "- Wenn im Fake-Profil nur eine Stadt steht (z.B. 'Leipzig'), aber nach Details gefragt wird (z.B. 'welche Ecke', 'welcher Stadtteil'):\n";
      
      // Erkenne Stadt und füge realistische Stadtteile hinzu
      const cityLower = fakeCity ? fakeCity.toLowerCase() : '';
      if (cityLower === 'leipzig') {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil von Leipzig: 'Zentrum', 'Plagwitz', 'Connewitz', 'Grünau', 'Lindenau', 'Gohlis', 'Eutritzsch', 'Reudnitz', 'Schleußig', 'Lößnig'\n";
      } else if (cityLower === 'berlin') {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil von Berlin: 'Mitte', 'Prenzlauer Berg', 'Kreuzberg', 'Friedrichshain', 'Charlottenburg', 'Neukölln', 'Wedding', 'Schöneberg'\n";
      } else if (cityLower === 'hamburg') {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil von Hamburg: 'Altona', 'Eimsbüttel', 'Harburg', 'Bergedorf', 'Wandsbek', 'Eppendorf', 'Ottensen', 'St. Pauli'\n";
      } else if (cityLower === 'münchen') {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil von München: 'Schwabing', 'Maxvorstadt', 'Glockenbachviertel', 'Haidhausen', 'Sendling', 'Neuhausen', 'Bogenhausen'\n";
      } else if (cityLower === 'köln') {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil von Köln: 'Innenstadt', 'Ehrenfeld', 'Nippes', 'Lindenthal', 'Sülz', 'Deutz', 'Kalk', 'Mülheim'\n";
      } else if (cityLower === 'frankfurt') {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil von Frankfurt: 'Innenstadt', 'Sachsenhausen', 'Nordend', 'Bockenheim', 'Bornheim', 'Ostend', 'Höchst'\n";
      } else if (cityLower === 'stuttgart') {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil von Stuttgart: 'Mitte', 'Bad Cannstatt', 'Feuerbach', 'Vaihingen', 'Degerloch', 'Zuffenhausen', 'Möhringen'\n";
      } else {
        fakeContext += "  → Option 1: Nenne einen REALISTISCHEN Stadtteil dieser Stadt (falls bekannt)\n";
      }
      
      fakeContext += "  → Option 2: Weiche höflich aus: 'Das sage ich dir sobald wir uns besser kennen' + gehe auf Rest der Nachricht ein\n";
      fakeContext += "- 🚨 KRITISCH: ERFINDE KEINE unrealistischen Details (z.B. 'kleine Stadt in Leipzig' - Leipzig ist eine Großstadt!)\n";
      fakeContext += "- 🚨 KRITISCH: ERFINDE KEINE Berufe oder andere Details, die nicht im Profil stehen!\n";
      fakeContext += "- 🚨 KRITISCH: Wenn Details fehlen → realistisch handeln, nicht erfinden!\n";
    }
    
    return {
      fakeContext,
      fakeName,
      fakeAge,
      fakeCity,
      fakeWork,
      fakeGender,
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Fake-Context-Builder - Fehler:', err.message);
    return {
      fakeContext: '',
      fakeName: null,
      fakeAge: null,
      fakeCity: null,
      fakeWork: null,
      fakeGender: null,
      success: false
    };
  }
}

/**
 * Agent 12: Conversation-Context-Builder
 * Baut conversationBlock mit kritischen Anweisungen
 */
async function agentConversationContextBuilder(conversationHistory) {
  try {
    if (!conversationHistory || conversationHistory.trim() === '') {
      return {
        conversationBlock: '',
        success: true
      };
    }
    
    const conversationBlock = `\n\n🚨🚨🚨 KRITISCH: CHAT-VERLAUF - BERÜCKSICHTIGE ALLE NACHRICHTEN! 🚨🚨🚨\nLetzte Nachrichten im Chat (Kunde/Fake):\n${conversationHistory}\n\n🚨🚨🚨 ABSOLUT KRITISCH - KONTEXT VERSTEHEN! 🚨🚨🚨
- Du MUSST den GESAMTEN Chat-Verlauf oben LESEN und VERSTEHEN, nicht nur die letzte Nachricht!
- Prüfe ALLE Nachrichten im Chat-Verlauf - was wurde VORHER gesagt?
- 🚨🚨🚨 KRITISCH: Wenn die letzte Kunden-Nachricht KURZ ist (z.B. "Sehr lange", "Ja", "Ok", "Gut", "Aha", "im Krankenhaus ja das wäre so ne idee", "Ja sicher immer erzählen"), dann ist es wahrscheinlich eine ANTWORT auf eine VORHERIGE NACHRICHT von dir!
- 🚨🚨🚨 KRITISCH: Prüfe die VORHERIGE Moderator-Nachricht im Chat-Verlauf - was war das THEMA? Der Kunde antwortet darauf!
- 🚨🚨🚨🚨🚨 KRITISCH: WER ANGEBOTEN HAT vs. WER ZUGESTIMMT HAT! 🚨🚨🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Wenn DU (Moderatorin) etwas ANGEBOTEN hast (z.B. "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??"), und der Kunde ZUSTIMMT (z.B. "Ja sicher immer erzählen"), dann MUSST DU DAS TUN, WAS DU ANGEBOTEN HAST!
- 🚨🚨🚨 KRITISCH: Beispiel: Du schreibst "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??" → Kunde antwortet "Ja sicher immer erzählen" → Du MUSST JETZT VON DEINEM TRAUM ERZÄHLEN, NICHT den Kunden fragen, ob ER erzählen will!
- 🚨🚨🚨 KRITISCH: Wenn DU etwas anbietest und der Kunde zustimmt, dann ist es DEINE Aufgabe, das anzubieten, nicht die des Kunden!
- 🚨🚨🚨 KRITISCH: Beispiel 1: Du fragst "Wie lange bist du schon single?" → Kunde antwortet "Sehr lange" → Du MUSST darauf eingehen (z.B. "Oh, das ist schon eine Weile. Wie geht es dir damit?"), NICHT eine neue Frage stellen, die den Kontext ignoriert!
- 🚨🚨🚨 KRITISCH: Beispiel 2: Du schreibst "Treffen im Pflegeheim" (sexuelle Fantasie) → Kunde antwortet "im Krankenhaus ja das wäre so ne idee" → Der Kunde bezieht sich auf die SEXUELLE Fantasie, NICHT auf Arbeit! Reagiere sexuell darauf, nicht über "im Krankenhaus arbeiten"!
- 🚨🚨🚨 KRITISCH: Beispiel 3: Du schreibst "Ich kann dir gerne nachher erzählen was wir gemacht haben, sofern du willst ??" → Kunde antwortet "Ja sicher immer erzählen" → Du MUSST JETZT VON DEINEM TRAUM ERZÄHLEN (z.B. "Also, in meinem Traum haben wir uns in einer gemütlichen Hütte im Schnee getroffen..."), NICHT den Kunden fragen, ob ER gerne erzählt!
- 🚨🚨🚨 KRITISCH: Wenn deine letzte Moderator-Nachricht sexuell war, dann ist die Kunden-Antwort auch sexuell gemeint - auch wenn sie kurz ist!
- 🚨🚨🚨 KRITISCH: Wenn deine letzte Moderator-Nachricht um ein Treffen ging, dann bezieht sich "im Krankenhaus" auf das Treffen, nicht auf einen Jobwechsel!
- 🚨🚨🚨 KRITISCH: Bei kurzen Antworten des Kunden: Gehe auf die VORHERIGE Moderator-Nachricht ein, stelle KEINE neue Frage, die den Kontext ignoriert!
- Wenn in früheren Nachrichten etwas über dich (Fake) gesagt wurde (z.B. "Ich arbeite in einer Rechtsanwaltskanzlei"), dann MUSST du darauf Bezug nehmen!
- Wenn der Kunde nach etwas fragt, das bereits im Chat-Verlauf erwähnt wurde, gehe darauf ein und sei KONSISTENT!
- Beispiel: Wenn früher gesagt wurde "Ich arbeite in einer Rechtsanwaltskanzlei" und der Kunde fragt "Bist du Rechtsanwalt?", dann antworte entweder "Ja" oder "Nein, ich kümmere mich da einfach nur um den Papierkram" - aber ignoriere die frühere Aussage NICHT!
- Beispiel bei Krankheit: Wenn der Kunde fragt "Bist du noch krank geschrieben?", dann kannst du geschickt ausweichen mit "Mir geht es schon etwas besser" statt direkt "Ja, ich bin noch krank geschrieben" zu sagen
- Verstehe den KONTEXT aus ALLEN Nachrichten - was wurde vorher besprochen?
- Reagiere auf den KONTEXT des gesamten Gesprächs, nicht nur auf die letzte Nachricht isoliert!
- Wenn der Kunde auf etwas Bezug nimmt, das früher im Chat besprochen wurde, gehe darauf ein!
- Stelle sicher, dass deine Antwort zum GESAMTEN Kontext passt und KONSISTENT mit früheren Aussagen ist!
- Bei sensiblen Themen (z.B. Krankheit): Du kannst geschickt ausweichen ohne direkt darauf eingehen zu müssen (z.B. "Mir geht es schon etwas besser" statt "Ja, ich bin noch krank geschrieben")`;
    
    return {
      conversationBlock,
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Conversation-Context-Builder - Fehler:', err.message);
    return {
      conversationBlock: '',
      success: false
    };
  }
}

/**
 * Agent 13.5: Context-Connection-Analyzer
 * Analysiert Chat-Verlauf automatisch und erkennt:
 * - Ankündigungen ("Ich erzähle dir später...")
 * - Offene Fragen (die noch nicht beantwortet wurden)
 * - Versprechen ("Ich sage dir später...")
 * - Kontext-Verbindungen (Kunde fragt nach etwas, das angekündigt wurde)
 */
async function agentContextConnectionAnalyzer(conversationHistory, customerMessage, moderatorMessages = [], customerMessages = [], profileInfo = {}) {
  try {
    const client = getClient();
    if (!client) {
      console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Context-Connection-Analyzer - Fallback');
      return {
        contextInstructions: '',
        openAnnouncements: [],
        openQuestions: [],
        contextConnections: [],
        success: false
      };
    }

    if (!conversationHistory || conversationHistory.trim().length === 0) {
      return {
        contextInstructions: '',
        openAnnouncements: [],
        openQuestions: [],
        contextConnections: [],
        success: true
      };
    }

    // Extrahiere die letzten 5-10 Moderator-Nachrichten für Analyse
    const recentModeratorMessages = moderatorMessages.slice(-10).map(m => m.text || '').filter(t => t.length > 0);
    const recentCustomerMessages = customerMessages.slice(-5).map(m => m.text || '').filter(t => t.length > 0);

    const analysisPrompt = `Analysiere den folgenden Chat-Verlauf und erkenne automatisch:

1. ANKÜNDIGUNGEN: Hat der Moderator/Fake etwas angekündigt, das noch nicht erfüllt wurde?
   - Beispiele: "Ich erzähle dir später...", "Ich verrate dir...", "Ich sage dir, wenn du Zeit hast...", "Ich erzähle dir genaueres..."
   - WICHTIG: Nur wenn es noch NICHT erzählt wurde!

2. OFFENE FRAGEN: Hat der Moderator/Fake Fragen gestellt, die noch nicht beantwortet wurden?

3. VERSprechen: Hat der Moderator/Fake etwas versprochen, das noch nicht erfüllt wurde?

4. MYSTERIÖSE/GEHEIMNISVOLLE NACHRICHTEN: Hat der Moderator/Fake eine mysteriöse/geheimnisvolle Nachricht geschrieben (z.B. "Was verbergen deine Augen?", "Das musst du herausfinden")?
   - Diese Nachrichten sind oft ASA (Animate Subsequent Action) - sie sollen den Kunden animieren zu antworten
   - Erkenne das THEMA dieser Nachricht (z.B. "in die Augen schauen", "Wahrheit erfahren")

5. PROBLEMATISCHE ANFRAGEN: Fragt der Kunde nach problematischen Dingen?
   - WhatsApp/Telegram/Nummer (Kontaktdaten außerhalb der Plattform)
   - Treffen/Date (direkte Treffen-Anfrage)
   - Zeitangaben (morgen, an einem anderen Tag)
   - Wenn ja: Erkenne, dass der Moderator NICHT zustimmen darf, sondern UMLENKEN muss!

6. UMLENKUNGS-BEDARF: Muss der Moderator UMLENKEN?
   - Wenn Kunde nach WhatsApp/Treffen/Zeit fragt → Umlenkung nötig!
   - Wenn letzte Moderator-Nachricht "mehr erfahren will" → Umlenkung mit spezifischer Frage nötig!
   - Erkenne: Welche spezifische Frage sollte der Moderator stellen? (z.B. "was du eigentlich genau hier suchst")

7. KONTEXT-VERBINDUNGEN: Wie bezieht sich die Kunden-Nachricht auf die letzte Moderator-Nachricht?
   - Fragt der Kunde nach etwas, das angekündigt/versprochen wurde?
   - Reagiert der Kunde spielerisch/neugierig auf eine mysteriöse Moderator-Nachricht?
   - Bezieht sich die Kunden-Antwort auf das THEMA der letzten Moderator-Nachricht?
   - Wenn letzte Moderator-Nachricht "mehr erfahren will" und Kunde reagiert verwirrt → PROAKTIV spezifische Frage stellen!

Antworte NUR als JSON im Format:
{
  "openAnnouncements": [
    {
      "text": "Exakter Text der Ankündigung",
      "type": "story" | "promise" | "information",
      "needsFulfillment": true
    }
  ],
  "openQuestions": [
    {
      "text": "Exakter Text der Frage",
      "askedBy": "moderator",
      "needsAnswer": true
    }
  ],
  "lastModeratorMessageTheme": "Was war das THEMA der letzten Moderator-Nachricht? (z.B. 'in die Augen schauen', 'Wahrheit erfahren', 'mysteriös/geheimnisvoll', 'mehr erfahren')",
  "customerResponseType": "Wie reagiert der Kunde? ('spielerisch', 'neugierig', 'referenziert Thema', 'fragt nach Ankündigung', 'verwirrt', 'fragt nach WhatsApp/Treffen/Zeit')",
  "problematicRequest": "Fragt der Kunde nach problematischen Dingen? ('WhatsApp/Nummer', 'Treffen/Date', 'Zeitangaben', 'keine')",
  "needsRedirect": "Muss der Moderator UMLENKEN? (true/false)",
  "redirectStrategy": "Welche UMLENKUNGS-Strategie sollte verwendet werden? ('spezifische Frage stellen', 'Thema wechseln', 'ablehnen + Frage')",
  "specificQuestion": "Welche spezifische Frage sollte gestellt werden? (z.B. 'was du eigentlich genau hier suchst', 'was du vorhast', 'was dich interessiert')",
  "contextConnections": [
    {
      "customerAsksFor": "Was der Kunde fragt/sagt",
      "relatesTo": "Worauf es sich bezieht (Ankündigung/Versprechen/letzte Moderator-Nachricht)",
      "theme": "Was war das THEMA der letzten Moderator-Nachricht? (z.B. 'in die Augen schauen', 'mehr erfahren')",
      "action": "Was der Moderator jetzt tun muss (z.B. 'erzählen', 'beantworten', 'erfüllen', 'spielerisch darauf eingehen', 'Thema aufgreifen', 'umlenken mit Frage')"
    }
  ],
  "criticalInstructions": "Kurze, prägnante Anweisungen für den Moderator (max. 400 Zeichen). BEISPIEL: Wenn letzte Moderator-Nachricht 'Ich will mehr über dich erfahren' war und Kunde fragt verwirrt nach WhatsApp, dann: 'UMLENKEN! NICHT zustimmen! Stattdessen: \"Ich weis aber so schnell gebe ich jetzt auch nicht meine nummer raus, ich würde noch gerne vorher wissen was du eigentlich genau hier suchst?\"'"
}

CHAT-VERLAUF:
${conversationHistory.substring(0, 3000)}

AKTUELLE KUNDEN-NACHRICHT:
"${customerMessage.substring(0, 500)}"

LETZTE MODERATOR-NACHRICHTEN (für Kontext):
${recentModeratorMessages.slice(-3).map((m, i) => `${i + 1}. "${m.substring(0, 200)}"`).join('\n')}

WICHTIG:
- Erkenne nur RELEVANTE Ankündigungen (z.B. "Ich erzähle dir später von X" → relevant)
- Ignoriere allgemeine Aussagen ohne konkrete Ankündigung
- Wenn der Kunde fragt "Dann erzähl mir das mal bitte?" → erkenne die Verbindung zur Ankündigung!
- Wenn eine Ankündigung bereits erfüllt wurde (wurde bereits erzählt), dann nicht mehr als "open" markieren!

🚨🚨🚨 KRITISCH: MYSTERIÖSE/GEHEIMNISVOLLE NACHRICHTEN! 🚨🚨🚨
- Wenn die letzte Moderator-Nachricht mysteriös/geheimnisvoll ist (z.B. "Was verbergen deine Augen?", "Das musst du herausfinden"), dann:
  * Erkenne das THEMA (z.B. "in die Augen schauen", "Wahrheit erfahren")
  * Wenn die Kunden-Antwort spielerisch/neugierig darauf reagiert (z.B. "Das musst du herausfinden"), dann:
    → Erkenne die Kontext-Verbindung: Kunde reagiert spielerisch auf das mysteriöse Thema
    → Gib spezifische Anweisung: "Reagiere spielerisch auf das Thema [THEMA]. Beispiel: 'Da hast du recht, das muss ich machen. Was genau würde mich erwarten, wenn ich [THEMA]?'"
${profileInfo?.moderatorInfo?.rawText || profileInfo?.moderatorInfo?.profileText ? `\nPROFIL-INFORMATION (Moderator "Über mich"):\n"${(profileInfo.moderatorInfo.rawText || profileInfo.moderatorInfo.profileText || '').substring(0, 300)}"\n- Nutze diese Profil-Informationen für das THEMA (z.B. wenn Profil "in die Augen schauen" erwähnt, dann beziehe dich darauf!)\n` : ''}

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const analysis = await client.chat.completions.create({
      model: AGENT_MODEL,
      messages: [
        { role: 'system', content: 'Du analysierst Chat-Verläufe und erkennst automatisch Ankündigungen, offene Fragen und Kontext-Verbindungen. Antworte NUR als JSON.' },
        { role: 'user', content: analysisPrompt }
      ],
      max_tokens: 800,
      temperature: 0.3
    });

    const result = analysis.choices?.[0]?.message?.content?.trim() || '';
    if (!result) {
      return {
        contextInstructions: '',
        openAnnouncements: [],
        openQuestions: [],
        contextConnections: [],
        success: false
      };
    }

    // Parse JSON
    let parsed;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Kein JSON gefunden');
      }
    } catch (e) {
      console.warn('⚠️ Agent: Context-Connection-Analyzer - JSON Parse Fehler:', e.message);
      return {
        contextInstructions: '',
        openAnnouncements: [],
        openQuestions: [],
        contextConnections: [],
        success: false
      };
    }

    // Generiere strukturierte Anweisungen
    let contextInstructions = '';
    const openAnnouncements = parsed.openAnnouncements || [];
    const openQuestions = parsed.openQuestions || [];
    const contextConnections = parsed.contextConnections || [];
    const lastModeratorMessageTheme = parsed.lastModeratorMessageTheme || '';
    const customerResponseType = parsed.customerResponseType || '';
    const problematicRequest = parsed.problematicRequest || 'keine';
    const needsRedirect = parsed.needsRedirect === true || parsed.needsRedirect === 'true';
    const redirectStrategy = parsed.redirectStrategy || '';
    const specificQuestion = parsed.specificQuestion || '';

    // 🆕 NEU: UMLENKUNGS-STRATEGIE (höchste Priorität bei problematischen Anfragen!)
    if (needsRedirect && problematicRequest !== 'keine') {
      contextInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCHE UMLENKUNGS-STRATEGIE! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
      contextInstructions += `🚫 PROBLEMATISCHE ANFRAGE ERKANNT: "${problematicRequest}"\n`;
      contextInstructions += `- Der Kunde fragt nach: ${problematicRequest}\n`;
      contextInstructions += `- 🚨🚨🚨 DU MUSST UMLENKEN - NICHT ZUSTIMMEN! 🚨🚨🚨\n\n`;
      contextInstructions += `📋 UMLENKUNGS-STRATEGIE: "${redirectStrategy}"\n`;
      
      if (specificQuestion) {
        contextInstructions += `- Stelle diese SPEZIFISCHE FRAGE: "${specificQuestion}"\n`;
        contextInstructions += `- 🚨 KRITISCH: Nutze GENAU diese Frage oder eine ähnliche aus Training-Daten!\n`;
      }
      
      if (lastModeratorMessageTheme && lastModeratorMessageTheme.includes('erfahren') || lastModeratorMessageTheme.includes('wissen')) {
        contextInstructions += `- Letzte Moderator-Nachricht wollte: "${lastModeratorMessageTheme}"\n`;
        contextInstructions += `- Kunde reagiert verwirrt/fragt nach ${problematicRequest}\n`;
        contextInstructions += `- 🚨 KRITISCH: Proaktiv mit spezifischer Frage umlenken, NICHT generisch fragen!\n`;
      }
      
      contextInstructions += `\n✅ RICHTIGE STRUKTUR (wie in Training-Daten):\n`;
      contextInstructions += `1. Ablehnen/Verständnis zeigen (z.B. "Ich weis aber so schnell gebe ich jetzt auch nicht meine nummer raus")\n`;
      contextInstructions += `2. Proaktive spezifische Frage stellen (z.B. "${specificQuestion || 'was du eigentlich genau hier suchst'}")\n`;
      contextInstructions += `\n❌ FALSCH: "Was möchtest du denn noch wissen?" (zu generisch!)\n`;
      contextInstructions += `✅ RICHTIG: "${specificQuestion || 'was du eigentlich genau hier suchst'}" (spezifisch!)\n\n`;
    }

    // 🆕 NEU: Mysteriöse/geheimnisvolle ASA-Nachrichten + spielerische Reaktionen
    if ((lastModeratorMessageTheme || customerResponseType === 'spielerisch' || customerResponseType === 'neugierig' || customerResponseType === 'referenziert Thema') && !needsRedirect) {
      contextInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 MYSTERIÖSE/SPIELERISCHE KONTEXT-ERKENNUNG! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
      
      if (lastModeratorMessageTheme) {
        contextInstructions += `📋 THEMA der letzten Moderator-Nachricht: "${lastModeratorMessageTheme}"\n`;
        contextInstructions += `- Der Kunde reagiert darauf: ${customerResponseType}\n`;
        contextInstructions += `- 🚨🚨🚨 REAGIERE SPIELERISCH AUF DAS THEMA "${lastModeratorMessageTheme}"! 🚨🚨🚨\n`;
        contextInstructions += `- Beziehe dich auf das THEMA, nicht nur generisch antworten!\n`;
        contextInstructions += `- Beispiel: Wenn Thema "in die Augen schauen" ist und Kunde sagt "Das musst du herausfinden", dann: "Da hast du recht, das muss ich machen. Was genau würde mich erwarten, wenn ich dir ganz tief in die Augen schauen würde?"\n\n`;
      }
    }

    if (contextConnections.length > 0 || openAnnouncements.length > 0 || openQuestions.length > 0 || (lastModeratorMessageTheme && !contextInstructions.includes('MYSTERIÖSE/SPIELERISCHE'))) {
      if (!contextInstructions.includes('AUTOMATISCHE KONTEXT-ERKENNUNG') && !contextInstructions.includes('MYSTERIÖSE/SPIELERISCHE')) {
        contextInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 AUTOMATISCHE KONTEXT-ERKENNUNG! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
      }
      
      // Kontext-Verbindungen (höchste Priorität)
      if (contextConnections.length > 0) {
        contextInstructions += `🚨🚨🚨 KRITISCH: KONTEKT-VERBINDUNG ERKANNT! 🚨🚨🚨\n`;
        contextConnections.forEach((conn, idx) => {
          contextInstructions += `\nVerbindung ${idx + 1}:\n`;
          contextInstructions += `- Du hast vorher: "${conn.relatesTo}"\n`;
          if (conn.theme) {
            contextInstructions += `- THEMA: "${conn.theme}"\n`;
          }
          contextInstructions += `- Der Kunde sagt: "${conn.customerAsksFor}"\n`;
          contextInstructions += `- 🚨🚨🚨 DU MUSST JETZT: ${conn.action.toUpperCase()}! 🚨🚨🚨\n`;
          
          if (conn.action.includes('spielerisch') || conn.action.includes('Thema aufgreifen')) {
            contextInstructions += `- Reagiere SPIELERISCH auf das Thema "${conn.theme || lastModeratorMessageTheme}"!\n`;
            contextInstructions += `- Beziehe dich KONKRET auf das Thema, nicht generisch!\n`;
            contextInstructions += `- Beispiel: Wenn Thema "in die Augen schauen" ist, dann nutze das in deiner Antwort (z.B. "wenn ich dir ganz tief in die Augen schauen würde")\n`;
          } else if (conn.action.includes('erzählen') || conn.action.includes('erzählen')) {
            contextInstructions += `- Erzähle KONKRET und DETAILLIERT, was du angekündigt hast!\n`;
            contextInstructions += `- Erfinde eine spannende, detaillierte Fantasie/Geschichte, die den Kunden im Chat hält!\n`;
            contextInstructions += `- Sei SPEZIFISCH - nicht generisch! (z.B. "Ich habe mir vorgestellt, wie wir uns in [Ort] treffen und [konkrete Handlung]...")\n`;
            contextInstructions += `- KEINE generischen Antworten wie "Ich finde es spannend, wenn es heiß wird" - das ist zu generisch!\n`;
          }
        });
        contextInstructions += `\n`;
      }
      
      // Offene Ankündigungen
      if (openAnnouncements.length > 0) {
        contextInstructions += `📋 OFFENE ANKÜNDIGUNGEN (noch nicht erfüllt):\n`;
        openAnnouncements.forEach((ann, idx) => {
          contextInstructions += `${idx + 1}. "${ann.text.substring(0, 200)}"\n`;
          contextInstructions += `   → Wenn der Kunde danach fragt, MUSST du es erfüllen!\n`;
        });
        contextInstructions += `\n`;
      }
      
      // Offene Fragen
      if (openQuestions.length > 0) {
        contextInstructions += `❓ OFFENE FRAGEN (noch nicht beantwortet):\n`;
        openQuestions.forEach((q, idx) => {
          contextInstructions += `${idx + 1}. "${q.text.substring(0, 200)}"\n`;
        });
        contextInstructions += `\n`;
      }
      
      // Kritische Anweisungen vom LLM
      if (parsed.criticalInstructions && parsed.criticalInstructions.trim().length > 0) {
        contextInstructions += `🚨 KRITISCHE ANWEISUNGEN:\n${parsed.criticalInstructions}\n\n`;
      }
    }

    // 🆕 NEU: Zusätzliche Anweisungen für Umlenkungen basierend auf Training-Daten-Patterns
    if (needsRedirect && redirectStrategy) {
      contextInstructions += `\n📚 TRAINING-DATEN INTEGRATION: UMLENKUNGS-STRATEGIE! 📚\n`;
      contextInstructions += `🚨🚨🚨 KRITISCH: Training-Daten zeigen bewährte Umlenkungs-Strategien - nutze sie! 🚨🚨🚨\n`;
      contextInstructions += `- Struktur aus Training-Daten: Ablehnung → spezifische Frage\n`;
      contextInstructions += `- Nutze bewährte Fragen aus Training-Daten/Learning-System\n`;
      if (specificQuestion) {
        contextInstructions += `- Beispiel-Frage: "${specificQuestion}"\n`;
      }
      contextInstructions += `- 🚨 KRITISCH: Orientiere dich an Training-Daten-Beispielen für Umlenkungen!\n`;
      contextInstructions += `- 🚨 KRITISCH: Nutze Learning-System-Patterns für bewährte Fragen!\n\n`;
    }

    const redirectInfo = needsRedirect ? `, ${redirectStrategy ? `Umlenkung: ${redirectStrategy}` : 'Umlenkung nötig'}` : '';
    console.log(`✅ Agent: Context-Connection-Analyzer - ${contextConnections.length} Verbindungen, ${openAnnouncements.length} Ankündigungen, ${openQuestions.length} offene Fragen erkannt${redirectInfo}`);

    return {
      contextInstructions: contextInstructions.trim(),
      openAnnouncements,
      openQuestions,
      contextConnections,
      needsRedirect: needsRedirect || false,
      redirectStrategy: redirectStrategy || '',
      specificQuestion: specificQuestion || '',
      problematicRequest: problematicRequest || 'keine',
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Context-Connection-Analyzer - Fehler:', err.message);
    return {
      contextInstructions: '',
      openAnnouncements: [],
      openQuestions: [],
      contextConnections: [],
      success: false
    };
  }
}

/**
 * Agent 14: First-Message-Detector
 * Erkennt, ob dies die erste Nachricht an den Kunden ist
 */
async function agentFirstMessageDetector(conversationHistory, customerMessage, messages) {
  try {
    // Prüfe ob conversationHistory leer ist oder nur Info-Messages enthält
    const hasEmptyHistory = !conversationHistory || conversationHistory.trim().length === 0;
    
    // Prüfe ob es echte Nachrichten gibt (nicht nur Info-Messages)
    let hasRealMessages = false;
    if (Array.isArray(messages) && messages.length > 0) {
      // Zähle echte Nachrichten (nicht Info-Messages)
      const realMessages = messages.filter(m => {
        if (!m || typeof m.text !== 'string' || m.text.trim() === '') return false;
        // Prüfe ob es eine Info-Message ist (vereinfachte Prüfung)
        const text = m.text.toLowerCase();
        const type = (m.type || '').toLowerCase();
        const mtype = (m.messageType || '').toLowerCase();
        
        // Info-Messages haben type="info" oder enthalten bestimmte Keywords
        if (type === 'info' || mtype === 'info') return false;
        if (text.includes('geliked') || text.includes('like erhalten') || 
            text.includes('hat dich gelikt') || text.includes('schreib ihm eine nachricht') ||
            text.includes('ich habe dir einen kuss')) return false;
        
        return true; // Echte Nachricht
      });
      
      hasRealMessages = realMessages.length > 0;
    }
    
    // Prüfe ob customerMessage leer ist (keine Antwort vom Kunden)
    const hasEmptyCustomerMessage = !customerMessage || customerMessage.trim().length === 0;
    
    // Es ist die erste Nachricht, wenn:
    // 1. conversationHistory leer ist UND
    // 2. Keine echten Nachrichten vorhanden sind UND
    // 3. customerMessage leer ist (keine Antwort vom Kunden)
    const isFirstMessage = hasEmptyHistory && !hasRealMessages && hasEmptyCustomerMessage;
    
    if (isFirstMessage) {
      console.log('✅ Agent: First-Message-Detector - ERSTE NACHRICHT erkannt!');
      
      // 🚨 NEU: Prüfe auf System-Nachrichten (Kuss, Like) in messages
      let hasKuss = false;
      let hasLike = false;
      let systemMessageText = '';
      
      if (Array.isArray(messages) && messages.length > 0) {
        for (const msg of messages) {
          if (!msg || typeof msg.text !== 'string') continue;
          const text = msg.text.toLowerCase();
          const type = (msg.type || '').toLowerCase();
          const mtype = (msg.messageType || '').toLowerCase();
          
          // Prüfe ob es eine Info-Message ist
          if (type === 'info' || mtype === 'info' || 
              text.includes('geliked') || text.includes('like erhalten') || 
              text.includes('hat dich gelikt') || text.includes('schreib ihm eine nachricht') ||
              text.includes('ich habe dir einen kuss') || text.includes('der benutzer hat dich geküsst') ||
              text.includes('geküsst') && text.includes('schreib')) {
            systemMessageText = msg.text;
            if (text.includes('kuss') || text.includes('geküsst')) {
              hasKuss = true;
            }
            if (text.includes('like') || text.includes('geliked')) {
              hasLike = true;
            }
          }
        }
      }
      
      // 🚨 NEU: Unterschiedliche Anweisungen je nach System-Nachricht
      let firstMessageInstructions = '';
      
      if (hasKuss) {
        // System-Nachricht: Kuss
        firstMessageInstructions = `
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: DIES IST DIE ERSTE NACHRICHT AN DEN KUNDEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ABSOLUT KRITISCH - DU SCHREIBST DEM KUNDEN ZUM ERSTEN MAL! 🚨🚨🚨
- Der Kunde hat dir einen KUSS geschickt (System-Nachricht: "${systemMessageText.substring(0, 100)}")
- Es gibt KEINE vorherigen Nachrichten zwischen euch
- Dies ist der ERSTE Kontakt - mache einen guten Eindruck!

📋 WICHTIGE ANWEISUNGEN FÜR DIE ERSTE NACHRICHT (MIT KUSS):
1. NORMALE BEGRÜSSUNG MIT ZEITKONTEXT:
   - Begrüße locker und natürlich (z.B. "Hey na", "Hey", "Hallo")
   - Bedanke dich kurz für den Kuss (z.B. "danke für deinen Kuss")
   - Nutze Zeitkontext (Wochentag, Tageszeit) für natürliche Fragen
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)

2. STELLE FRAGEN MIT ZEITKONTEXT:
   - Frage nach Tageszeit/Wochentag (z.B. "Was machst du heute so?", "Was hast du an einem [Wochentag] vor?")
   - Stelle 1-2 natürliche Fragen, die zum Zeitkontext passen
   - Die Fragen sollen den Kunden zum Antworten motivieren

3. SEI NATÜRLICH:
   - Schreibe wie auf einer Dating-App: freundlich, locker, interessiert
   - Verwende den Schreibstil aus den Training-Daten (natürlich, umgangssprachlich)
   - Sei nicht zu aufdringlich oder zu persönlich

4. VERBOTEN BEI ERSTER NACHRICHT:
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)
   - ❌ KEINE persönlichen Infos (Hobbies, Beruf, etc. - das kommt später!)
   - ❌ KEINE sexuellen Themen (es ist die erste Nachricht!)
   - ❌ KEINE zu persönlichen Fragen (z.B. nach Beziehungsstatus, Kindern, etc.)
   - ❌ KEINE Meta-Kommentare über die Nachricht
   - ❌ KEINE zu langen Nachrichten (mindestens 150 Zeichen zum Abschicken, aber natürlich schreiben!)

5. BEISPIEL-STRUKTUR:
   "Hey na alles klar bei dir? Wie geht es dir denn gerade so und was hast heute so an einem Sonntag vor? Bestimmt enstpannen bevor die neue woche los geht?"

🚨🚨🚨 KRITISCH: Dies ist die ERSTE Nachricht - mache einen guten, natürlichen Eindruck! Schreibe natürlich, mindestens 150 Zeichen! 🚨🚨🚨
`;
      } else if (hasLike) {
        // System-Nachricht: Like
        firstMessageInstructions = `
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: DIES IST DIE ERSTE NACHRICHT AN DEN KUNDEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ABSOLUT KRITISCH - DU SCHREIBST DEM KUNDEN ZUM ERSTEN MAL! 🚨🚨🚨
- Der Kunde hat dein Profil geliked (System-Nachricht: "${systemMessageText.substring(0, 100)}")
- Es gibt KEINE vorherigen Nachrichten zwischen euch
- Dies ist der ERSTE Kontakt - mache einen guten Eindruck!

📋 WICHTIGE ANWEISUNGEN FÜR DIE ERSTE NACHRICHT (MIT LIKE):
1. NORMALE BEGRÜSSUNG MIT ZEITKONTEXT:
   - Begrüße locker und natürlich (z.B. "Hey na", "Hey", "Hallo")
   - Bedanke dich kurz für das Like (z.B. "danke für das Like")
   - Nutze Zeitkontext (Wochentag, Tageszeit) für natürliche Fragen
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)

2. STELLE FRAGEN MIT ZEITKONTEXT:
   - Frage nach Tageszeit/Wochentag (z.B. "Was machst du heute so?", "Was hast du an einem [Wochentag] vor?")
   - Stelle 1-2 natürliche Fragen, die zum Zeitkontext passen
   - Die Fragen sollen den Kunden zum Antworten motivieren

3. SEI NATÜRLICH:
   - Schreibe wie auf einer Dating-App: freundlich, locker, interessiert
   - Verwende den Schreibstil aus den Training-Daten (natürlich, umgangssprachlich)
   - Sei nicht zu aufdringlich oder zu persönlich

4. VERBOTEN BEI ERSTER NACHRICHT:
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)
   - ❌ KEINE persönlichen Infos (Hobbies, Beruf, etc. - das kommt später!)
   - ❌ KEINE sexuellen Themen (es ist die erste Nachricht!)
   - ❌ KEINE zu persönlichen Fragen (z.B. nach Beziehungsstatus, Kindern, etc.)
   - ❌ KEINE Meta-Kommentare über die Nachricht
   - ❌ KEINE zu langen Nachrichten (mindestens 150 Zeichen zum Abschicken, aber natürlich schreiben!)

5. BEISPIEL-STRUKTUR:
   "Hey na alles klar bei dir? Wie geht es dir denn gerade so und was hast heute so an einem Sonntag vor? Bestimmt enstpannen bevor die neue woche los geht?"

🚨🚨🚨 KRITISCH: Dies ist die ERSTE Nachricht - mache einen guten, natürlichen Eindruck! Schreibe natürlich, mindestens 150 Zeichen! 🚨🚨🚨
`;
      } else {
        // Keine System-Nachricht (normale erste Nachricht)
        firstMessageInstructions = `
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: DIES IST DIE ERSTE NACHRICHT AN DEN KUNDEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ABSOLUT KRITISCH - DU SCHREIBST DEM KUNDEN ZUM ERSTEN MAL! 🚨🚨🚨
- Der Kunde hat Interesse gezeigt (Match/Like auf Dating-App)
- Es gibt KEINE vorherigen Nachrichten zwischen euch
- Dies ist der ERSTE Kontakt - mache einen guten Eindruck!

📋 WICHTIGE ANWEISUNGEN FÜR DIE ERSTE NACHRICHT:
1. NORMALE BEGRÜSSUNG MIT ZEITKONTEXT:
   - Begrüße locker und natürlich (z.B. "Hey na", "Hey", "Hallo")
   - Nutze Zeitkontext (Wochentag, Tageszeit) für natürliche Fragen
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)

2. STELLE FRAGEN MIT ZEITKONTEXT:
   - Frage nach Tageszeit/Wochentag (z.B. "Was machst du heute so?", "Was hast du an einem [Wochentag] vor?", "Wie geht es dir denn gerade so?")
   - Stelle 1-2 natürliche Fragen, die zum Zeitkontext passen
   - Die Fragen sollen den Kunden zum Antworten motivieren

3. SEI NATÜRLICH:
   - Schreibe wie auf einer Dating-App: freundlich, locker, interessiert
   - Verwende den Schreibstil aus den Training-Daten (natürlich, umgangssprachlich)
   - Sei nicht zu aufdringlich oder zu persönlich

4. VERBOTEN BEI ERSTER NACHRICHT:
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)
   - ❌ KEINE persönlichen Infos (Hobbies, Beruf, etc. - das kommt später!)
   - ❌ KEINE sexuellen Themen (es ist die erste Nachricht!)
   - ❌ KEINE zu persönlichen Fragen (z.B. nach Beziehungsstatus, Kindern, etc.)
   - ❌ KEINE Meta-Kommentare über die Nachricht
   - ❌ KEINE zu langen Nachrichten (mindestens 150 Zeichen zum Abschicken, aber natürlich schreiben!)

5. BEISPIEL-STRUKTUR:
   "Hey na alles klar bei dir? Wie geht es dir denn gerade so und was hast heute so an einem Sonntag vor? Bestimmt enstpannen bevor die neue woche los geht?"

🚨🚨🚨 KRITISCH: Dies ist die ERSTE Nachricht - mache einen guten, natürlichen Eindruck! Schreibe natürlich, mindestens 150 Zeichen! 🚨🚨🚨
`;
      }
      
      return {
        isFirstMessage: true,
        instructions: firstMessageInstructions,
        hasKuss: hasKuss,
        hasLike: hasLike,
        success: true
      };
    }
    
    return {
      isFirstMessage: false,
      instructions: '',
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: First-Message-Detector - Fehler:', err.message);
    return {
      isFirstMessage: false,
      instructions: '',
      success: false
    };
  }
}

/**
 * Agent 13: Learning-Context-Builder
 * Integriert Learning-System (generateLearningContext, getLearningStats)
 */
async function agentLearningContextBuilder(customerMessage, detectedSituations) {
  try {
    let learningContext = '';
    let learningStats = null;
    
    try {
      const { generateLearningContext, getLearningStats } = require('../utils/learning-system');
      learningStats = await getLearningStats();
      
      if (learningStats && Object.keys(learningStats).length > 0) {
        const situationsForLearning = detectedSituations && detectedSituations.length > 0 ? detectedSituations : ['allgemein'];
        const generatedContext = await generateLearningContext(customerMessage || '', situationsForLearning, learningStats);
        
        if (generatedContext && generatedContext.trim().length > 0) {
          learningContext = `\n\n🧠🧠🧠🧠🧠🧠🧠🧠🧠 LEARNING-SYSTEM: BEWÄHRTE MUSTER AUS FEEDBACK (HOHER PRIORITÄT!) 🧠🧠🧠🧠🧠🧠🧠🧠🧠\n`;
          learningContext += `🚨🚨🚨 KRITISCH: Das Learning-System hat aus Feedback gelernt, was GUT und SCHLECHT ist! 🚨🚨🚨\n`;
          learningContext += `🚨🚨🚨 KRITISCH: Diese Muster basieren auf echten Feedback-Daten - nutze sie! 🚨🚨🚨\n\n`;
          learningContext += `${generatedContext}\n`;
          learningContext += `🚨🚨🚨🚨🚨 WICHTIG: Kombiniere Training-Daten + Learning-System Muster + Bevorzugte Wörter für BESTE Qualität! 🚨🚨🚨🚨🚨\n`;
          learningContext += `🚨🚨🚨 KRITISCH: Learning-System zeigt dir, was FUNKTIONIERT - nutze es! 🚨🚨🚨\n\n`;
        }
      }
    } catch (err) {
      console.warn('⚠️ Agent: Learning-Context-Builder - Learning-System Fehler:', err.message);
    }
    
    return {
      learningContext,
      learningStats,
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: Learning-Context-Builder - Fehler:', err.message);
    return {
      learningContext: '',
      learningStats: null,
      success: false
    };
  }
}

/**
 * 🛡️ Fallback-Nachricht Generator
 * Generiert eine minimale, sichere Nachricht wenn alle Retries fehlgeschlagen sind
 */
async function generateFallbackMessage(customerMessage, context, reason = '') {
  const client = getClient();
  if (!client) {
    return null;
  }
  
  try {
    const fallbackPrompt = `Generiere eine kurze, natürliche Antwort auf diese Kundennachricht.
    
Kundennachricht: "${customerMessage.substring(0, 200)}"

WICHTIG:
- Kurz und natürlich (100-150 Zeichen)
- Keine Meta-Kommentare
- Keine Widersprüche
- Reagiere auf den Inhalt, nicht auf die Formulierung
- Stelle eine einfache Frage am Ende

${reason ? `\nGrund: ${reason}` : ''}

Antworte NUR mit der Nachricht, keine Erklärungen.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du generierst kurze, natürliche Chat-Nachrichten.' },
          { role: 'user', content: fallbackPrompt }
        ],
        temperature: 0.7,
        max_tokens: 150
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      // Post-Processing
      let fallbackMessage = result.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
      fallbackMessage = fallbackMessage.replace(/-/g, " ");
      fallbackMessage = fallbackMessage.replace(/ß/g, "ss");
      fallbackMessage = fallbackMessage.replace(/!/g, '.');
      fallbackMessage = fallbackMessage.replace(/\?+/g, '?');
      
      return fallbackMessage;
    }
  } catch (err) {
    console.error('⚠️ Fallback-Nachricht konnte nicht generiert werden:', err.message);
  }
  
  return null;
}

/**
 * Agent 9: Message-Generator
 * Generiert die finale Nachricht basierend auf allen Agent-Ergebnissen
 */
async function agentMessageGenerator(multiAgentResults, {
  conversationHistory,
  customerMessage,
  profileInfo,
  extractedUserInfo,
  allRules,
  isASA = false,
  asaConversationContext = '',
  platformId = 'viluu',
  isMeetingRequestFunc = null // 🚨 WICHTIG: Helper-Funktion für Treffen-Erkennung
}) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Message-Generator - Fallback');
    return {
      message: '',
      success: false,
      error: 'OpenAI Client nicht verfügbar'
    };
  }

  try {
    // Extrahiere Ergebnisse aus Pipeline
    const context = multiAgentResults.context || {};
    const profile = multiAgentResults.profile || {};
    const rules = multiAgentResults.rules || {};
    const training = multiAgentResults.training || {};
    const style = multiAgentResults.style || {};
    const mood = multiAgentResults.mood || {};
    const proactive = multiAgentResults.proactive || {};
    const image = multiAgentResults.image || {};
    const situation = multiAgentResults.situation || {};
    const fakeContext = multiAgentResults.fakeContext || {};
    const conversationContext = multiAgentResults.conversationContext || {};
    const learning = multiAgentResults.learning || {};
    // 🚀 NEUE INTELLIGENTE AGENTS
    const exampleIntelligence = multiAgentResults.exampleIntelligence || {};
    const meetingResponse = multiAgentResults.meetingResponse || {};
    const ruleInterpreter = multiAgentResults.ruleInterpreter || {};
    // 🧠 NEU: Knowledge Ecosystem
    const knowledgeSynthesizer = multiAgentResults.knowledgeSynthesizer || {};
    const sharedKB = multiAgentResults.sharedKnowledgeBase || null;
    const flowAnalysisResult = multiAgentResults.flowAnalysis || {};
    const ambiguityResult = multiAgentResults.ambiguity || {};
    // 🧠🧠🧠 NEU: Deep Learning
    const deepLearning = multiAgentResults.deepLearning || {};
    
    // Prüfe ob Deep Learning erfolgreich war
    if (deepLearning.success && deepLearning.deepContext) {
      console.log('✅ Deep Learning Context verfügbar und wird in Prompt integriert');
    }
    
    // Prüfe ob es ein sexuelles Gespräch ist
    const hasSexualContent = situation.hasSexualContent || 
                            context.topic === 'sexuell' || 
                            (flowAnalysisResult.success && flowAnalysisResult.activeContext && flowAnalysisResult.activeContext.currentTopic === 'sexuell') ||
                            (ambiguityResult.success && ambiguityResult.sexualContext) ||
                            (situation.detectedSituations && situation.detectedSituations.some(s => s.includes('Sexuell'))) ||
                            false;
    
    // 🚨 NEU: Erstelle Kontext-Objekt für kontext-bewusste Validierung (wird später verwendet)
    const validationContext = {
      hasSexualContent: hasSexualContent,
      detectedSituations: situation.detectedSituations || []
    };

    // Generiere dateTimeInfo (wie in alter reply.js)
    const now = new Date();
    const berlinTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const hour = berlinTime.getHours();
    const minute = berlinTime.getMinutes();
    const day = berlinTime.getDate();
    const month = berlinTime.getMonth() + 1;
    const year = berlinTime.getFullYear();
    const weekdayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const weekdayShortNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const weekday = weekdayNames[berlinTime.getDay()];
    const weekdayShort = weekdayShortNames[berlinTime.getDay()];
    const season = month >= 3 && month <= 5 ? 'Frühling' : month >= 6 && month <= 8 ? 'Sommer' : month >= 9 && month <= 11 ? 'Herbst' : 'Winter';
    const dateTimeInfo = `${weekday}, ${day}.${month}.${year}, ${hour}:${minute.toString().padStart(2, '0')} Uhr (${season})`;
    const timePhase = hour >= 22 || hour < 6 ? 'Nacht' : hour >= 18 ? 'Abend' : hour >= 12 ? 'Nachmittag' : hour >= 6 ? 'Vormittag' : 'Nacht';

    // Generiere genderSpecificNote
    const fakeGender = fakeContext.fakeGender || extractedUserInfo?.assistant?.Gender || null;
    let genderSpecificNote = "";
    if (fakeGender) {
      const isFemale = fakeGender === "weiblich" || fakeGender === "w" || fakeGender === "female";
      genderSpecificNote = `\n🚨🚨🚨 KRITISCH: GESCHLECHTER-ROLLENVERSTÄNDNIS 🚨🚨🚨\n- Du bist: ${isFemale ? "eine FRAU" : "ein MANN"}\n- Der Kunde ist: ${isFemale ? "ein MANN (schreibt dir als Frau)" : "eine FRAU (schreibt dir als Mann)"}\n`;
      
      // 🚨 NEU: Spezifische Anweisungen für sexuelle Rollen/Positionen
      if (isFemale) {
        genderSpecificNote += `\n🚨🚨🚨 KRITISCH: SEXUELLE ROLLEN/POSITIONEN (FRAU zu MANN) 🚨🚨🚨\n`;
        genderSpecificNote += `- Du bist die FRAU, der Kunde ist der MANN\n`;
        genderSpecificNote += `- Du nimmst PASSIVE/RECEPTIVE Rollen ein (du wirst "genommen", nicht du "nimmst")\n`;
        genderSpecificNote += `- ✅ RICHTIG: "Ich würde gerne doggy genommen werden", "Ich liebe es, wenn du mich doggy nimmst", "Ich würde gerne von dir genommen werden"\n`;
        genderSpecificNote += `- ❌ FALSCH: "Ich würde dich doggy nehmen", "Ich würde dich nehmen", "Ich würde dich ficken" (das sind aktive Rollen für Männer!)\n`;
        genderSpecificNote += `- 🚨 KRITISCH: Bei sexuellen Positionen/Rollen: Du bist die PASSIVE Partei, der Kunde ist die AKTIVE Partei!\n`;
      } else {
        genderSpecificNote += `\n🚨🚨🚨 KRITISCH: SEXUELLE ROLLEN/POSITIONEN (MANN zu FRAU) 🚨🚨🚨\n`;
        genderSpecificNote += `- Du bist der MANN, der Kunde ist die FRAU\n`;
        genderSpecificNote += `- Du nimmst AKTIVE Rollen ein (du "nimmst", nicht du wirst "genommen")\n`;
        genderSpecificNote += `- ✅ RICHTIG: "Ich würde dich doggy nehmen", "Ich würde dich gerne nehmen", "Ich würde dich ficken"\n`;
        genderSpecificNote += `- ❌ FALSCH: "Ich würde gerne doggy genommen werden", "Ich würde gerne von dir genommen werden" (das sind passive Rollen für Frauen!)\n`;
        genderSpecificNote += `- 🚨 KRITISCH: Bei sexuellen Positionen/Rollen: Du bist die AKTIVE Partei, der Kunde ist die PASSIVE Partei!\n`;
      }
      
      genderSpecificNote += `- Passe deinen Schreibstil entsprechend an (${isFemale ? "Frau" : "Mann"} zu ${isFemale ? "Mann" : "Frau"})\n`;
    }

    // Generiere forbiddenWordsSystemNote (nur Hinweis, Details im User-Prompt)
    const forbiddenWordsSystemNote = allRules?.forbiddenWords && allRules.forbiddenWords.length > 0 
      ? `\n\n🚨🚨🚨 KRITISCH: VERBOTENE WÖRTER 🚨🚨🚨\nEs gibt ${allRules.forbiddenWords.length} absolut verbotene Wörter/Phrasen - siehe User-Prompt für Details!\nDiese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen!\n`
      : "";

    // Generiere allGeneralRules (HARDCODED_GRUNDREGELN)
    const allGeneralRules = `🚨🚨🚨🚨🚨🚨🚨🚨🚨 HARDCODED GRUNDREGELN (ABSOLUTE BASIS - IMMER AKTIV!) 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨 KRITISCH: TRAINING-DATEN HABEN HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Training-Daten haben HÖCHSTE PRIORITÄT - überschreiben ALLE anderen Anweisungen! 🚨🚨🚨
- Training-Daten zeigen dir, WIE du antworten sollst (Stil, Wortwahl, Ton, Formulierungen)
- Training-Daten zeigen dir auch, WAS du antworten sollst (Inhalt, Fragen, Reaktionen)
- 🚨🚨🚨 KRITISCH: Nutze Training-Daten für INHALT UND STIL - nicht nur für Stil! Schaue ZUERST in die Training-Daten! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENG AN DEN TRAINING-DATEN - KOPIERE WORTWAHL, FORMULIERUNGEN UND FRAGEN WÖRTLICH! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: KOPIERE die Wörter und Formulierungen aus den Beispielen - erfinde KEINE neuen! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Wenn Training-Daten etwas zeigen, dann MACH ES SO - nicht anders! 🚨🚨🚨

🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: STRUKTUR-REGELN AUS TRAINING-DATEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

📋 STRUKTUR-REGEL 1: UMLENKUNGEN BEI PROBLEMATISCHEN ANFRAGEN (Treffen, WhatsApp, Zeit)
- Wenn Training-Daten zeigen: "Ablehnen → DANN SPEZIFISCHE Frage stellen", dann MACH ES GENAU SO!
- ✅ RICHTIGE STRUKTUR (Treffen): "Freitag passt leider nicht für mich, da ich schon was vor habe. Was würdest du denn gerne machen?" (Ablehnen → spezifische Frage)
- ✅ RICHTIGE STRUKTUR (WhatsApp): "Ich weis aber so schnell gebe ich jetzt auch nicht meine nummer raus, ich würde noch gerne vorher wissen was du eigentlich genau hier suchst?" (Ablehnen → spezifische Frage)
- ❌ FALSCH: "Freitag ist zwar nicht optimal..." (Nur ablehnen, keine Frage!)
- ❌ FALSCH: "Was möchtest du denn noch wissen?" (zu generisch!)
- 🚨 KRITISCH: Bei Treffen/WhatsApp/Zeit-Anfragen IMMER ZUERST ablehnen, DANN eine SPEZIFISCHE Ablenkungsfrage stellen (wie in Training-Daten)!
- 🚨 KRITISCH: Die Ablenkungsfrage muss SPEZIFISCH sein - nicht generisch! Nutze Fragen aus Training-Daten/Learning-System (z.B. "was du eigentlich genau hier suchst", "was du vorhast", "was dich interessiert")!
- 🚨 KRITISCH: Wenn letzte Moderator-Nachricht "mehr erfahren" wollte und Kunde reagiert verwirrt/fragt nach problematischen Dingen → PROAKTIV mit spezifischer Frage umlenken!

📋 STRUKTUR-REGEL 2: JA/NEIN-FRAGEN (z.B. "Hast du schonmal Outdoor-Sex gehabt?", "Magst du Anal?")
- Wenn der Kunde eine JA/NEIN-Frage stellt, dann BEANTWORTE ZUERST mit JA/NEIN, DANN stelle eine Frage!
- ✅ RICHTIGE STRUKTUR: "Ja, das habe ich schonmal gemacht. Was würdest du denn gerne machen?" (Ja/Nein → Frage)
- ✅ RICHTIGE STRUKTUR: "Nein, das habe ich noch nie gemacht, aber es klingt geil. Wie stellst du dir das vor?" (Nein → Frage)
- ❌ FALSCH: "Das klingt geil. Was magst du denn so?" (Kein ja/nein, direkt Frage!)
- 🚨 KRITISCH: Bei JA/NEIN-Fragen IMMER ZUERST die Frage beantworten, DANN eine Frage stellen!

📋 STRUKTUR-REGEL 3: ALLGEMEINE STRUKTUR AUS TRAINING-DATEN
- Wenn Training-Daten zeigen: "Eigener Satz → Frage", dann verwende diese Struktur!
- Wenn Training-Daten zeigen: "Reaktion → Frage", dann verwende diese Struktur!
- Wenn Training-Daten zeigen: "Antwort → Frage", dann verwende diese Struktur!
- 🚨 KRITISCH: KOPIERE die STRUKTUR aus den Training-Daten - nicht nur die Wörter, sondern auch den ABLAUF!

🚨🚨🚨 KRITISCH: VERBOTENE WÖRTER 🚨🚨🚨
- Es gibt absolut verbotene Wörter/Phrasen - siehe User-Prompt für Details!
- Diese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen!
- Wenn du eine Antwort generierst, die eines dieser Wörter enthält, dann ist die Antwort FALSCH und muss neu geschrieben werden!

🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER 🚨🚨🚨
- Es gibt bevorzugte Wörter, die REGELMÄSSIG verwendet werden sollten - siehe User-Prompt für Details!
- Diese Wörter haben HOHER PRIORITÄT nach Training-Daten!

`;

    // Baue System-Prompt (wie in alter reply.js)
    let systemPrompt = `${allGeneralRules}🚨🚨🚨 DEINE ROLLE & LOGISCHES DENKEN 🚨🚨🚨
Du bist ein Chat-Moderator auf einer Dating-Plattform. Du verwaltest verschiedene Fake-Profile und antwortest als diese Profile auf Kunden-Nachrichten.

WICHTIGES VERSTÄNDNIS:
- Du bist Chat-Moderator: Du bekommst Chats zugeteilt, wenn ein Kunde einem Fake-Profil antwortet
- Andere Moderatoren schreiben auch: Du siehst ihre Nachrichten im Chat-Verlauf - nutze sie für Kontext!
- Du antwortest als FAKE-PROFIL: Der Kunde schreibt DIR (dem Fake-Profil), nicht dir (dem Moderator)!
- Dating-Plattform: Menschen suchen hier Dates, Sex, Beziehungen oder Freundschaften - das ist der KONTEXT!

LOGISCHES DENKEN:
- Wenn der Kunde ablehnt (z.B. "ich will nie Sex", "lass mich in Ruhe"), dann denke LOGISCH:
  * Er ist auf einer Dating-Seite → Was sucht er dann hier? (Freundschaft? Beziehung ohne Sex?)
  * Logische Frage: "Okay, das kann ich verstehen. Aber was suchst du dann hier genau? Suchst du hier nur eine Freundschaft?"
- Wenn der Kunde etwas sagt, das nicht zum Kontext passt → Denke logisch: Was meint er wirklich?
- Nutze den Chat-Verlauf: Wenn andere Moderatoren vorher geschrieben haben, verstehe den Kontext!

🚨🚨🚨 KRITISCH: DU BIST DAS FAKE-PROFIL 🚨🚨🚨
- Du antwortest als FAKE-PROFIL auf Nachrichten vom KUNDEN
- Der KUNDE schreibt DIR (dem Fake-Profil)! Du antwortest auf SEINE Nachricht!
${genderSpecificNote}
- Zeige EIGENINITIATIVE! Nenne IMMER eigene Vorlieben/Interessen/Erfahrungen, BEVOR du fragst!
- Sexuell: "Ich liebe Doggy. Was magst du denn so?" - Allgemein: "Ich gehe gerne ins Kino. Was machst du denn so?" - Hobbies: "Ich koche gerne italienisch. Was kochst du denn am liebsten?"
- Wenn der Kunde sagt, dass er Sex sucht oder Freundschaft+ sucht, dann sage auch, dass DU das suchst! Frage dann nach seinen Vorlieben, Fantasien oder ähnliche fragen!
- Gehe TIEFER auf die Kundennachricht ein! Wenn der Kunde detailliert schreibt, dann schreibe auch detailliert zurück! Sei emotional, menschlich, interessiert!
- Reagiere auf das, was der KUNDE in SEINER Nachricht geschrieben hat, aber zeige auch EIGENINITIATIVE und trage aktiv zum Gespräch bei!
- 🚨🚨🚨 KRITISCH: Wiederhole NICHT die Kundennachricht, paraphrasiere sie NICHT! Gehe auf den INHALT ein, nicht auf die Formulierung!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- KEINE Fotos/Nummern ANFORDERN, keine Off-Plattform-Kontakte!
- NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen! Wenn der Kunde nach Treffen fragt, höflich ausweichen!
- BEI TREFFEN/SILVESTER-ANFRAGEN: Sage ZUERST, dass du an diesem Tag/Termin leider schon was vor hast, DANN frage, wie er es sich vorstellen würde (nur EINE Frage!)
- NIEMALS sagen "Ich wäre gerne bereit" oder "Ich bin bereit" - das klingt wie eine Zusage! Sage stattdessen "Ich könnte es mir vorstellen" oder "Ich würde gerne wissen, wie du es dir vorstellst"!
- 🚨🚨🚨 KRITISCH: NIEMALS Zustimmungs-Phrasen bei Treffen-Anfragen verwenden! ("klingt super", "würde gut passen", "sind schon ganz heiss darauf", "Freitag klingt super" etc. sind VERBOTEN bei Treffen!)
- Keine Bindestriche (-) verwenden! Schreibe alles ohne Bindestriche.
- Verwende KEINE Anführungszeichen (" oder ') am Anfang oder Ende der Nachricht!
- Schreibe NIEMALS das Zeichen "ß" – immer "ss" verwenden.

🚨🚨🚨 KRITISCH: MEHRERE SITUATIONEN IN EINER NACHRICHT 🚨🚨🚨
- Wenn der Kunde MEHRERE Dinge fragt (z.B. Foto + Nummer, Treffen + Kontaktdaten), dann gehe auf ALLE ein!
- 🚨 KRITISCH: Ignoriere KEINE Anfrage - wenn der Kunde nach Foto UND Nummer fragt, beantworte BEIDES!
- Beispiel: Kunde fragt "Kannst du mir ein Foto schicken und deine WhatsApp Nummer geben?"
  → RICHTIG: "Ich schicke nicht so gerne Bilder im Internet, und meine Nummer gebe ich auch nicht weiter. Aber wir können hier schreiben. Was gefällt dir denn besonders an mir?"
  → FALSCH: "Ich schicke nicht so gerne Bilder" (ignoriert die Nummer-Anfrage!)
- Wenn mehrere Situationen erkannt wurden, findest du spezifische Anweisungen im User-Prompt!

🚨🚨🚨 KRITISCH: BEGRÜNDUNGEN & PRINZIPIEN 🚨🚨🚨
- Wenn Training-Daten Begründungen (explanation) enthalten, nutze sie, um zu verstehen, WARUM eine Antwort gut ist!
- Wenn Learning-System Prinzipien aus Begründungen zeigt, nutze sie beim Generieren deiner Antwort!
- Begründungen erklären das "WARUM" - nicht nur das "WAS" - nutze dieses Verständnis für bessere Antworten!

🚨🚨🚨 KRITISCH: STIL & FORMULIERUNGEN 🚨🚨🚨
- 🚨🚨🚨 HÖCHSTE PRIORITÄT: Training-Daten und Learning-System bestimmen den Schreibstil, die Wortwahl, den Ton und die Formulierungen!
- Orientiere dich STRENG an den Training-Daten-Beispielen - sie zeigen dir, wie echte Chat-Replies aussehen!
- Das Learning-System zeigt dir bewährte Muster und statistische Ziele (Länge, Fragen, etc.) - nutze diese!
- 🚨 KRITISCH: JEDE Nachricht muss IMMER eine Frage enthalten - ohne Ausnahme! 🚨🚨🚨
- Stelle ÜBERWIEGEND NUR 1 Frage - nicht 2 Fragen, außer es ist wirklich nötig!
- 🚨 KRITISCH: Die Frage muss KONTEXTUELL sein (bezogen auf das, was der Kunde geschrieben hat), NICHT generisch!
- Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${dateTimeInfo}
- Heute ist ${weekday} (${weekdayShort}), der ${day}.${month}.${year}, ${hour}:${minute.toString().padStart(2, '0')} Uhr. Jahreszeit: ${season}
- NIEMALS falsche Wochentage, Daten oder Zeiten verwenden! Prüfe IMMER das aktuelle Datum/Zeit oben!

🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: KEINE META-KOMMENTARE! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ABSOLUT VERBOTEN - DIESE REGEL HAT HÖCHSTE PRIORITÄT! 🚨🚨🚨

❌ VERBOTEN: Meta-Kommentare, die die NACHRICHT/SITUATION KOMMENTIEREN:
- ❌ "Ich finde es toll/gut/schön/super/schon mal gut, dass du..."
- ❌ "Ich finde es toll/gut/schön/super, wie du..."
- ❌ "Ich finde dass du... toll/super/gut" (in allen Varianten!)
- ❌ "Ich kann mir vorstellen, dass du..." / "Ich kann mir gut vorstellen..." / "Ich kann mir vorstellen wie..."
- ❌ "Ich find die Vorstellung..." / "Ich finde die Vorstellung..."
- ❌ "Es klingt aufregend" / "Es klingt spannend" / "Es klingt interessant"
- ❌ "Das ist toll/gut/schön/super, dass du..."
- ❌ "Wie toll/gut/schön/super, dass du..."
- ❌ Jede Formulierung, die die NACHRICHT oder SITUATION des Kunden kommentiert!
- 🚨 NEU: Statt "Ich kann mir vorstellen wie du mich fickst" → "Ohja das würde mich richtig gefallen"
- 🚨 NEU: Statt "Ich find die Vorstellung geil" → Direkt reagieren: "Das würde mich richtig geil machen"

✅ ERLAUBT: Direkte Reaktionen auf INHALT/VORSCHLAG/FRAGE:
- ✅ "Klingt geil" (Reaktion auf Vorschlag)
- ✅ "Das klingt nach einem geilen Deal" (Reaktion auf Vorschlag)
- ✅ "Ich finde das geil" (Antwort auf Frage "Findest du das geil?")
- ✅ "Anal Sex finde ich richtig geil" (Antwort auf Frage)
- ✅ "Tittenfick finde ich auch geil" (Reaktion auf genannte Vorlieben)
- ✅ "Klingt verlockend" (Reaktion auf Vorschlag)

🚨🚨🚨 UNTERSCHIED: 🚨🚨🚨
- ❌ VERBOTEN: Kommentar über NACHRICHT/SITUATION ("Ich finde es toll, dass du auf der Couch chillst")
- ✅ ERLAUBT: Reaktion auf INHALT ("Klingt geil", "Ich finde das geil" als Antwort auf Frage)

✅ RICHTIG - Direkt reagieren:
- ✅ "Auf der Couch chillen ist entspannt. Was würdest du denn gerne machen?"
- ✅ "Du bist so gehorsam, das gefällt mir" (direkt, auf DICH bezogen)
- ✅ "Klingt nach einem geilen Vorschlag" (Reaktion auf Vorschlag)

🚨 KRITISCH: Wenn der Kunde etwas Sexuelles sagt, antworte SEXUELL zurück - nicht mit Meta-Kommentaren!
🚨 KRITISCH: Verwende "Ich"-Formulierungen nur für DEINE Vorlieben/Fantasien, NICHT um die Nachricht zu kommentieren!
🚨 KRITISCH: Direkt auf das eingehen, was der Kunde sagt - OHNE Meta-Kommentare über die Nachricht/Situation!

🚨🚨🚨 ERWEITERTE KONTEXTANALYSE - ZEITKONTEXT 🚨🚨🚨
- Aktuelle Tageszeit: ${hour}:${minute.toString().padStart(2, '0')} Uhr
- Tagesphase: ${timePhase}
- Wochentag: ${weekday} (${weekdayShort === 'Sa' || weekdayShort === 'So' ? 'Wochenende' : 'Wochentag'})
- Jahreszeit: ${season}
- Nutze diesen Zeitkontext für natürlichere Antworten (z.B. "Guten Morgen" nur morgens, "Gute Nacht" nur abends, Wochenende-Erwähnungen nur am Wochenende)!

🚨🚨🚨 KRITISCH: TAGESZEIT/WOCHENTAG NUR WENN GEFRAGT! 🚨🚨🚨
- 🚨 ABSOLUT VERBOTEN: Von sich aus erzählen, was man heute macht/plant, wenn der Kunde NICHT fragt!
- 🚨 ABSOLUT VERBOTEN: Erzählen, dass man überlegt, was man heute machen will (klingt nach freier Zeit → Treffen-Anfrage!)
- ✅ ERLAUBT: Nur antworten, wenn der Kunde EXPLIZIT fragt (z.B. "was machst du gerade", "was hast du heute noch vor", "was machst du am Wochenende")!

🚨🚨🚨 UNTERSCHIED: "WAS MACHST DU GERADE" vs "WAS HAST DU HEUTE NOCH VOR" 🚨🚨🚨
- "Was machst du gerade?" / "Was machst du jetzt?" → Passend zur Tageszeit antworten:
  * Morgens (6-9 Uhr): "Richte mich für die Arbeit" / "Bin gerade auf dem Weg zur Arbeit"
  * Nachmittags (16-18 Uhr): "Komme gerade von der Arbeit" / "Bin gerade von der Arbeit gekommen"
  * Abends (19-22 Uhr): "Bin zu Hause" / "Chille gerade"
- "Was hast du heute noch vor?" / "Was machst du heute noch?" → Beschäftigt klingen (verhindert Treffen-Anfragen!):
  * "Muss noch Wäsche waschen" / "Habe noch Haushalt zu erledigen" / "Muss noch einkaufen gehen" / "Habe noch ein paar Dinge zu erledigen"
- "Was machst du am Wochenende?" → Beschäftigt klingen:
  * "Treffe mich mit Freunden" / "Besuche meine Eltern" / "Muss einkaufen" / "Habe ein paar Dinge zu erledigen"

🚨🚨🚨 WICHTIG: PROAKTIVITÄT NUR BEI THEMEN! 🚨🚨🚨
- ✅ ERLAUBT: Wenn der Kunde nach einem Thema fragt (z.B. Hobbies, Arbeit, Freizeit) → Eigene Erfahrungen/Vorlieben nennen
- ❌ VERBOTEN: Wenn kein Thema da ist → Nicht von sich aus erzählen, was man heute macht/plant!
- ❌ VERBOTEN: Wenn kein Thema da ist → Keine generischen Standardfragen stellen (z.B. "Was machst du denn so in deiner Freizeit?") - das führt zu repetitiven Fragen!
- ✅ RICHTIG: Wenn kein Thema da ist → Reagiere auf das, was der Kunde geschrieben hat und stelle eine KONTEXTUELLE Frage dazu!
- 🚨🚨🚨 KRITISCH: JEDE Nachricht muss IMMER eine Frage enthalten - aber sie muss KONTEXTUELL sein (bezogen auf das, was der Kunde geschrieben hat), NICHT generisch!

🚨🚨🚨🚨🚨 KRITISCH: KEINE NEUEN THEMEN EINFÜHREN! 🚨🚨🚨🚨🚨
- 🚨 ABSOLUT VERBOTEN: Neue Themen einführen, die der Kunde NICHT erwähnt hat!
- 🚨 ABSOLUT VERBOTEN: Von "Kochen", "Zeit für sich haben", "was man zusammen machen könnte" reden, wenn der Kunde NICHT danach gefragt hat!
- ✅ RICHTIG: Nur auf das aktuelle Thema des Kunden eingehen (z.B. wenn er über "Umzugskisten/Räumen" spricht → darauf eingehen, NICHT über "Kochen" reden!)
- ✅ RICHTIG: Fragen stellen, die sich auf das AKTUELLE Thema beziehen (z.B. "Hast du denn wirklich niemanden der dir da helfen kann?" statt "Was magst du denn sonst noch so?")
- 🚨 KRITISCH: Wenn der Kunde über etwas spricht (z.B. Umzugskisten, Räumen, Arbeit), dann darauf eingehen und passende Fragen dazu stellen - NICHT zu neuen Themen wechseln!
${forbiddenWordsSystemNote}
${hasSexualContent ? `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: SEXUELLES GESPRÄCH ERKANNT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- Du schreibst in einem SEXUELLEN Gespräch - sei RADIKALER, direkter, roher!
- 🚨🚨🚨 PROAKTIV: Nenne IMMER eigene sexuelle Vorlieben/Fantasien, BEVOR du fragst! Beispiel: "Ich liebe Doggy. Was magst du denn so?"
- Verwende sexuelle Wörter aus den bevorzugten Wörtern (siehe User-Prompt)!
- Verwende die WORTWAHL aus den Training-Daten - KOPIERE sie!
- Sei direkt und spontan - KEINE Meta-Kommentare, KEINE bewertenden Phrasen!
- Wenn der Kunde etwas Sexuelles sagt, antworte SEXUELL zurück - nicht mit Meta-Kommentaren!
- Verwende "geil", "heiß", "mega", "richtig", "total" etc. - diese Wörter sind bei Sex-Gesprächen ERLAUBT und GEWÜNSCHT!
- Stelle sexuelle Fragen wie in den Training-Daten (z.B. "was würdest du noch gerne machen", "welche Stellungen", "was magst du")!
- 🚨 KRITISCH: Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich STRENG daran!
- 🚨 KRITISCH: Bevorzugte Wörter haben HOHER PRIORITÄT - verwende sie REGELMÄSSIG!
- 🚨🚨🚨 NEU: Wenn der Kunde SEHR DIREKT und SEXUELL ist (z.B. "sexpuppe", "ficken", "blasen", etc.), dann sei AUCH SEHR DIREKT und SEXUELL zurück!
- 🚨🚨🚨 NEU: Gehe auf ALLE sexuellen Andeutungen ein - ignoriere NICHTS! Wenn er "sexpuppe" sagt, reagiere darauf!
- 🚨🚨🚨 NEU: Bei sehr direkten sexuellen Nachrichten - sei AUCH sehr direkt, nicht zurückhaltend!
\n` : ''}
${isASA ? '\n🚨🚨🚨 KRITISCH: DIES IST EINE REAKTIVIERUNGSNACHRICHT (ASA)! 🚨🚨🚨\n- Der Kunde hat zuletzt nicht geantwortet.\n- Reaktiviere das Gespräch freundlich und interessiert.\n- Frage, was den Kunden beschäftigt.\n- Sei warmherzig, aber nicht aufdringlich.\n' : ''}`;

    // 🚨🚨🚨 NEU: STRUKTURIERTE PROMPT-BAUKASTEN 🚨🚨🚨
    // Baue strukturierten, priorisierten Prompt statt unstrukturiertem Text
    
    // ============================================
    // ABSCHNITT 1: KRITISCHE REGELN (HÖCHSTE PRIORITÄT)
    // ============================================
    let criticalRulesSection = "";
    
    // 1.1 First-Message-Regeln (wenn erste Nachricht) - HÖCHSTE PRIORITÄT!
    const firstMessage = multiAgentResults.firstMessage || {};
    let isFirstMessage = firstMessage.isFirstMessage || false;
    let hasLike = firstMessage.hasLike || false;
    
    if (isFirstMessage && firstMessage.instructions) {
      // 🚨 NEU: Erst-Nachricht + Like hat ABSOLUT HÖCHSTE PRIORITÄT!
      criticalRulesSection += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: ERSTE NACHRICHT ${hasLike ? '+ LIKE' : ''} 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
      criticalRulesSection += `${firstMessage.instructions}\n`;
      criticalRulesSection += `\n🚨🚨🚨 KRITISCH: Diese Anweisungen haben HÖCHSTE PRIORITÄT - überschreiben ALLE anderen Anweisungen! 🚨🚨🚨\n`;
    }
    
    // 1.2 Critical Rules (Hardcode-Regeln)
    if (rules.criticalRulesContext) {
      criticalRulesSection += `\n[KRITISCHE REGELN]\n${rules.criticalRulesContext}\n`;
    }

    // 1.3 Forbidden Words
    if (rules.forbiddenWordsContext) {
      criticalRulesSection += `\n[VERBOTENE WÖRTER]\n${rules.forbiddenWordsContext}\n`;
    }
    
    // ============================================
    // ABSCHNITT 2: TRAINING-DATEN (HÖCHSTE PRIORITÄT FÜR INHALT/STIL)
    // ============================================
    let trainingSection = "";
    
    // 🚨 NEU: Prüfe ob Fallback-Modus aktiviert werden soll (schlechte Training-Daten)
    const vectorSearchResults = training?.vectorSearchResults || [];
    const bestVectorSimilarity = vectorSearchResults.length > 0 ? (vectorSearchResults[0]?.similarity || 0) : 0;
    
    // Prüfe auch Example Intelligence Similarity
    let exampleIntelligenceSimilarity = 0;
    if (exampleIntelligence.bestExamples && exampleIntelligence.bestExamples.length > 0) {
      const bestExample = exampleIntelligence.bestExamples[0];
      exampleIntelligenceSimilarity = bestExample.similarity || bestExample.combinedScore || 0;
    }
    
    // Fallback-Modus: Wenn Training-Daten zu schlecht sind
    let shouldUseFallbackMode = !isFirstMessage && // Erst-Nachricht hat eigene Instructions
                                (bestVectorSimilarity < 0.6 || exampleIntelligenceSimilarity < 0.5) &&
                                (!training.trainingExamplesContext || training.trainingExamplesContext.length < 500); // Weniger als 500 Zeichen Training-Daten
    
    if (shouldUseFallbackMode) {
      console.log(`⚠️ Fallback-Modus aktiviert: Vector-Similarity=${(bestVectorSimilarity * 100).toFixed(1)}%, Example-Intelligence=${(exampleIntelligenceSimilarity * 100).toFixed(1)}%`);
      console.log(`📝 Verwende vereinfachte Antwort-Generierung ohne Training-Daten`);
      
      // Fallback-Modus: Vereinfachter Prompt ohne Training-Daten
      trainingSection += `\n[FALLBACK-MODUS: KEINE GUTEN TRAINING-DATEN GEFUNDEN]\n`;
      trainingSection += `⚠️ WICHTIG: Es wurden keine guten Training-Daten-Beispiele gefunden (Ähnlichkeit zu niedrig).\n`;
      trainingSection += `Antworte NATÜRLICH und KONTEXTBEZOGEN basierend auf:\n`;
      trainingSection += `- Der Kundennachricht (gehe direkt darauf ein)\n`;
      trainingSection += `- Dem Chat-Verlauf (was wurde vorher besprochen?)\n`;
      trainingSection += `- Der Situation (${(situation.detectedSituations || []).join(', ') || 'allgemein'})\n`;
      trainingSection += `- Dem Kontext (${context.topic || 'allgemein'})\n\n`;
      trainingSection += `🚨 KRITISCH: Antworte EINFACH und NATÜRLICH - keine komplexen Strukturen, keine Meta-Kommentare!\n`;
      trainingSection += `Beispiel für einfache, gute Antwort: "Das denke ich, ich bin mir ziemlich sicher das wir uns gefunden haben ist schicksal, meinst du nicht auch?"\n`;
    } else if (training.trainingExamplesContext) {
      // Normal-Modus: Training-Daten verwenden
      trainingSection += `\n[TRAINING-DATEN - HAUPTQUELLE FÜR STIL/FORMULIERUNGEN]\n${training.trainingExamplesContext}\n`;
    } else if (isFirstMessage && hasLike) {
      // Erst-Nachricht + Like: Training-Daten sind optional, Instructions haben Vorrang
      trainingSection += `\n[ERSTE NACHRICHT + LIKE: Training-Daten sind OPTIONAL]\n`;
      trainingSection += `⚠️ WICHTIG: Bei Erst-Nachricht + Like haben die Instructions oben HÖCHSTE PRIORITÄT!\n`;
      trainingSection += `Training-Daten können verwendet werden, aber die Instructions sind wichtiger.\n`;
      if (training.trainingExamplesContext) {
        trainingSection += `\n${training.trainingExamplesContext}\n`;
      }
    }
    
    // 🚀 NEU: Example Intelligence Guidance (wenn verfügbar)
    if (exampleIntelligence.success && exampleIntelligence.bestExamples && exampleIntelligence.bestExamples.length > 0) {
      trainingSection += `\n\n🚀🚀🚀 INTELLIGENTE BEISPIEL-ANALYSE (KI-GENERIERT) 🚀🚀🚀\n`;
      trainingSection += `Eine KI hat die besten Beispiele analysiert und folgende Muster extrahiert:\n\n`;
      
      if (exampleIntelligence.structureGuidance) {
        trainingSection += `${exampleIntelligence.structureGuidance}\n`;
      }
      if (exampleIntelligence.wordChoiceGuidance) {
        trainingSection += `${exampleIntelligence.wordChoiceGuidance}\n`;
      }
      if (exampleIntelligence.questionGuidance) {
        trainingSection += `${exampleIntelligence.questionGuidance}\n`;
      }
      if (exampleIntelligence.toneGuidance) {
        trainingSection += `${exampleIntelligence.toneGuidance}\n`;
      }
      if (exampleIntelligence.keyPhrasesGuidance) {
        trainingSection += `${exampleIntelligence.keyPhrasesGuidance}\n`;
      }
      
      // 🚨 NEU: Context Guidance (WANN welche Fragen) - HÖCHSTE PRIORITÄT!
      if (exampleIntelligence.contextGuidance) {
        trainingSection += `${exampleIntelligence.contextGuidance}\n`;
      }
      
      trainingSection += `\n🚨 KRITISCH: Nutze diese Struktur, Wortwahl, Fragen UND Kontext-Muster aus der Analyse oben!\n`;
    }
    
    // 🚀 NEU: Meeting Response Guidance (nur bei Treffen-Anfragen)
    if (meetingResponse.success && meetingResponse.isMeetingRequest) {
      trainingSection += `\n\n🚫🚫🚫 TREFFEN-ANFRAGE: SPEZIELLE ANWEISUNGEN (KI-GENERIERT) 🚫🚫🚫\n`;
      trainingSection += `Eine KI hat spezifische Beispiele für Treffen-Anfragen analysiert:\n\n`;
      
      if (meetingResponse.responseGuidance) {
        trainingSection += `${meetingResponse.responseGuidance}\n`;
      }
      
      if (meetingResponse.allowedPhrases && meetingResponse.allowedPhrases.length > 0) {
        trainingSection += `\n✅ ERLAUBTE PHRASEN (diese kannst du verwenden):\n`;
        meetingResponse.allowedPhrases.forEach(phrase => {
          trainingSection += `- "${phrase}"\n`;
        });
      }
      
      if (meetingResponse.blockedPhrases && meetingResponse.blockedPhrases.length > 0) {
        trainingSection += `\n❌ BLOCKIERTE PHRASEN (diese darfst du NICHT verwenden):\n`;
        meetingResponse.blockedPhrases.forEach(phrase => {
          trainingSection += `- "${phrase}"\n`;
        });
      }
      
      trainingSection += `\n🚨 KRITISCH: Reagiere auf die Treffen-Anfrage, aber mache KEIN Treffen aus!\n`;
    }
    
    // 🚀 NEU: Rule Interpreter Guidance (wenn Widersprüche erkannt)
    if (ruleInterpreter.success && ruleInterpreter.hasConflict) {
      trainingSection += `\n\n⚖️⚖️⚖️ REGEL-INTERPRETATION (KI-GENERIERT) ⚖️⚖️⚖️\n`;
      trainingSection += `Eine KI hat Widersprüche zwischen Regeln und Training-Daten erkannt:\n\n`;
      trainingSection += `Widerspruch: ${ruleInterpreter.conflictDescription}\n\n`;
      trainingSection += `Priorität: ${ruleInterpreter.priority === 'examples' ? 'Training-Daten haben Vorrang' : 'Regeln haben Vorrang'}\n\n`;
      
      if (ruleInterpreter.guidance) {
        trainingSection += `Anleitung: ${ruleInterpreter.guidance}\n\n`;
      }
      
      trainingSection += `🚨 KRITISCH: Folge dieser Anleitung, um Widersprüche zu lösen!\n`;
    }
    
    // 🧠 NEU: Knowledge Synthesizer - Intelligente Synthese ALLER Erkenntnisse
    if (knowledgeSynthesizer.success && knowledgeSynthesizer.synthesizedKnowledge) {
      trainingSection += `\n\n🧠🧠🧠🧠🧠 INTELLIGENTE WISSENS-SYNTHESE (KI-GENERIERT) 🧠🧠🧠🧠🧠\n`;
      trainingSection += `Eine KI hat ALLE Erkenntnisse aus Agents und Learning-System synthetisiert:\n\n`;
      
      if (knowledgeSynthesizer.synthesizedKnowledge) {
        trainingSection += `📊 SYNTHESISIERTES WISSEN:\n${knowledgeSynthesizer.synthesizedKnowledge}\n\n`;
      }
      
      if (knowledgeSynthesizer.keyInsights && knowledgeSynthesizer.keyInsights.length > 0) {
        trainingSection += `🔑 WICHTIGSTE ERKENNTNISSE:\n`;
        knowledgeSynthesizer.keyInsights.forEach((insight, idx) => {
          trainingSection += `${idx + 1}. ${insight}\n`;
        });
        trainingSection += `\n`;
      }
      
      if (knowledgeSynthesizer.actionableGuidance) {
        trainingSection += `✅ UMSETZBARE ANLEITUNG:\n${knowledgeSynthesizer.actionableGuidance}\n\n`;
      }
      
      if (knowledgeSynthesizer.priorityInsights && knowledgeSynthesizer.priorityInsights.length > 0) {
        trainingSection += `🚨🚨🚨 HÖCHSTE PRIORITÄT:\n`;
        knowledgeSynthesizer.priorityInsights.forEach((insight, idx) => {
          trainingSection += `${idx + 1}. ${insight}\n`;
        });
        trainingSection += `\n`;
      }
      
      // 🧠 NEU: Ambiguity Resolver Erkenntnisse (HÖCHSTE PRIORITÄT!)
      if (ambiguityResult.success && ambiguityResult.resolvedMeaning) {
        trainingSection += `\n\n🧠🧠🧠🧠🧠 MEHRDEUTIGKEITS-INTERPRETATION (ABSOLUT KRITISCH!) 🧠🧠🧠🧠🧠\n`;
        trainingSection += `Eine KI hat eine mehrdeutige Phrase im Kontext des Kundenprofils interpretiert:\n\n`;
        trainingSection += `🚨🚨🚨 INTERPRETIERTE BEDEUTUNG: "${ambiguityResult.resolvedMeaning}"\n\n`;
        
        if (ambiguityResult.profileConnections && ambiguityResult.profileConnections.length > 0) {
          trainingSection += `🔗 PROFIL-VERBINDUNGEN:\n`;
          ambiguityResult.profileConnections.forEach((conn, idx) => {
            trainingSection += `${idx + 1}. ${conn}\n`;
          });
          trainingSection += `\n`;
        }
        
        if (ambiguityResult.interpretation) {
          trainingSection += `💡 DETAILLIERTE INTERPRETATION:\n${ambiguityResult.interpretation}\n\n`;
        }
        
        if (ambiguityResult.sexualContext) {
          trainingSection += `🚨🚨🚨 SEXUELLER KONTEXT ERKANNT!\n`;
          trainingSection += `- Die mehrdeutige Phrase bezieht sich auf SEXUELLE Aktivität, nicht auf Entrümpelung!\n`;
          trainingSection += `- Direkte sexuelle Antwort ist ERWÜNSCHT und ERLAUBT!\n`;
          trainingSection += `- Gehe auf die sexuelle Bedeutung ein, nicht auf die wörtliche!\n\n`;
        }
        
        if (ambiguityResult.recommendations && ambiguityResult.recommendations.length > 0) {
          trainingSection += `✅ EMPFEHLUNGEN FÜR DIE ANTWORT:\n`;
          ambiguityResult.recommendations.forEach((rec, idx) => {
            trainingSection += `${idx + 1}. ${rec}\n`;
          });
          trainingSection += `\n`;
        }
        
        trainingSection += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Nutze diese Interpretation für deine Antwort! 🚨🚨🚨🚨🚨\n`;
        trainingSection += `- Die Kundennachricht bedeutet: "${ambiguityResult.resolvedMeaning}"\n`;
        trainingSection += `- Gehe auf diese Bedeutung ein, nicht auf die wörtliche Interpretation!\n`;
        trainingSection += `- ${ambiguityResult.sexualContext ? 'SEXUELLER Kontext - sei direkt und sexuell!' : 'Verwende die Profil-Verbindungen in deiner Antwort!'}\n\n`;
      }
      
      // 🧠 NEU: Priority Guidance aus Shared Knowledge Base
      if (sharedKB) {
        const priorityGuidance = sharedKB.getPriorityGuidance('high');
        if (priorityGuidance && priorityGuidance.length > 0) {
          trainingSection += `\n🚨🚨🚨 PRIORITY GUIDANCE (AUS SHARED KNOWLEDGE BASE):\n`;
          priorityGuidance.slice(0, 5).forEach((g, idx) => {
            trainingSection += `${idx + 1}. [${g.source}] ${g.guidance}\n`;
          });
          trainingSection += `\n`;
        }
      }
      
      trainingSection += `🚨 KRITISCH: Nutze diese Synthese für die BESTE Antwort!\n`;
    }
    
    // 🧠🧠🧠 NEU: Conversation Flow Analyzer - Verhindert Rückgriff auf alte Themen!
    if (flowAnalysisResult.success) {
      trainingSection += `\n\n🧠🧠🧠🧠🧠 CONVERSATION FLOW ANALYZER (ABSOLUT KRITISCH!) 🧠🧠🧠🧠🧠\n`;
      trainingSection += `Eine KI hat den Chat-Verlauf analysiert und erkannt, was AKTUELL und was VERALTET ist:\n\n`;
      
      if (flowAnalysisResult.activeContext) {
        if (flowAnalysisResult.activeContext.currentTopic) {
          trainingSection += `🚨🚨🚨 AKTUELLES THEMA: "${flowAnalysisResult.activeContext.currentTopic}"\n`;
          trainingSection += `- Reagiere NUR auf dieses aktuelle Thema!\n`;
          trainingSection += `- Gehe VORWÄRTS mit diesem Thema, nicht zurück!\n\n`;
        }
        if (flowAnalysisResult.activeContext.isResponseToLastModeratorMessage) {
          trainingSection += `✅ Der Kunde antwortet auf deine letzte Moderator-Nachricht!\n`;
          trainingSection += `- Reagiere auf seine Antwort, nicht auf alte Themen!\n\n`;
        }
        if (flowAnalysisResult.activeContext.referenceMessage) {
          trainingSection += `📎 Referenz: ${flowAnalysisResult.activeContext.referenceMessage}\n\n`;
        }
      }
      
      if (flowAnalysisResult.outdatedContext && flowAnalysisResult.outdatedContext.oldTopics && flowAnalysisResult.outdatedContext.oldTopics.length > 0) {
        trainingSection += `🚫🚫🚫 VERALTETE THEMEN (ABSOLUT IGNORIEREN!):\n`;
        flowAnalysisResult.outdatedContext.oldTopics.forEach((topic, idx) => {
          trainingSection += `${idx + 1}. ${topic}\n`;
        });
        trainingSection += `\n⚠️ Grund: ${flowAnalysisResult.outdatedContext.reason || 'Nicht mehr in letzten 5 Nachrichten erwähnt'}\n\n`;
        trainingSection += `🚨🚨🚨 KRITISCH: Komme NICHT auf diese alten Themen zurück!\n`;
        trainingSection += `- Diese Themen sind VERALTET und nicht mehr relevant!\n`;
        trainingSection += `- Gehe VORWÄRTS, nicht zurück!\n\n`;
      }
      
      if (flowAnalysisResult.forwardMovement) {
        trainingSection += `➡️➡️➡️ VORWÄRTS-BEWEGUNG: ➡️➡️➡️\n`;
        if (flowAnalysisResult.forwardMovement.shouldStartNewTopic) {
          trainingSection += `- Starte ein NEUES Thema, gehe vorwärts!\n`;
        }
        if (flowAnalysisResult.forwardMovement.shouldContinueCurrentTopic) {
          trainingSection += `- Setze das AKTUELLE Thema fort, aber gehe vorwärts!\n`;
        }
        if (flowAnalysisResult.forwardMovement.topicsToIgnore && flowAnalysisResult.forwardMovement.topicsToIgnore.length > 0) {
          trainingSection += `- IGNORIERE diese Themen: ${flowAnalysisResult.forwardMovement.topicsToIgnore.join(', ')}\n`;
        }
        trainingSection += `\n`;
      }
      
      if (flowAnalysisResult.recommendations && flowAnalysisResult.recommendations.length > 0) {
        trainingSection += `✅ EMPFEHLUNGEN:\n`;
        flowAnalysisResult.recommendations.forEach((rec, idx) => {
          trainingSection += `${idx + 1}. ${rec}\n`;
        });
        trainingSection += `\n`;
      }
      
      trainingSection += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Gehe VORWÄRTS, nicht zurück! 🚨🚨🚨🚨🚨\n`;
      trainingSection += `- Reagiere NUR auf aktuelle Nachricht und aktuelles Thema!\n`;
      trainingSection += `- IGNORIERE veraltete Themen komplett!\n`;
      trainingSection += `- Starte neue Themen oder setze aktuelle fort, aber gehe VORWÄRTS!\n\n`;
    }
    
    // ============================================
    // ABSCHNITT 3: LEARNING-SYSTEM (BEWÄHRTE MUSTER) - SELEKTIV
    // ============================================
    let learningSection = "";
    
    // 🚨🚨🚨 NEU: Selektive Learning-Daten für Prompt (nur Top 3-5 relevante)
    try {
      const { selectRelevantLearningForPrompt, getLearningStats } = require('../utils/learning-system');
      const learningStats = await getLearningStats();
      
      if (learningStats && Object.keys(learningStats).length > 0) {
        const detectedSituations = situation?.detectedSituations || [];
        const relevantLearning = selectRelevantLearningForPrompt(customerMessage, detectedSituations, learningStats);
        
        if (relevantLearning && (relevantLearning.topWords.length > 0 || relevantLearning.topPatterns.length > 0)) {
          learningSection += `\n🧠🧠🧠 LEARNING-SYSTEM: TOP-RELEVANTE MUSTER 🧠🧠🧠\n\n`;
          learningSection += `🚨🚨🚨 KRITISCH: Diese Muster basieren auf Feedback-Daten - nutze sie! 🚨🚨🚨\n\n`;
          
          if (relevantLearning.topWords.length > 0) {
            learningSection += `✅ TOP-${relevantLearning.topWords.length} WÖRTER für "${relevantLearning.situation}" (VERWENDEN):\n`;
            relevantLearning.topWords.forEach((word, idx) => {
              learningSection += `${idx + 1}. "${word}"\n`;
            });
            learningSection += `\n🚨 KRITISCH: Nutze diese Wörter in deiner Antwort!\n\n`;
          }
          
          if (relevantLearning.topPatterns.length > 0) {
            learningSection += `✅ TOP-${relevantLearning.topPatterns.length} MUSTER für "${relevantLearning.situation}" (VERWENDEN):\n`;
            relevantLearning.topPatterns.forEach((pattern, idx) => {
              learningSection += `${idx + 1}. "${pattern}"\n`;
            });
            learningSection += `\n🚨 KRITISCH: Orientiere dich an diesen Mustern!\n\n`;
          }
          
          if (relevantLearning.badWords.length > 0) {
            learningSection += `❌ TOP-${relevantLearning.badWords.length} WÖRTER für "${relevantLearning.situation}" (VERMEIDEN):\n`;
            relevantLearning.badWords.forEach((word, idx) => {
              learningSection += `${idx + 1}. "${word}"\n`;
            });
            learningSection += `\n🚨 KRITISCH: Vermeide diese Wörter!\n\n`;
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler bei selektiver Learning-Daten-Extraktion:', err.message);
      // Fallback: Verwende vollständigen Learning-Context
      if (learning.learningContext && learning.learningContext.trim().length > 0) {
        learningSection += `\n[LEARNING-SYSTEM - BEWÄHRTE MUSTER AUS FEEDBACK]\n${learning.learningContext}\n`;
      }
    }
    
    // Fallback: Wenn keine selektiven Daten, verwende vollständigen Context
    if (learningSection.trim().length === 0 && learning.learningContext && learning.learningContext.trim().length > 0) {
      learningSection += `\n[LEARNING-SYSTEM - BEWÄHRTE MUSTER AUS FEEDBACK]\n${learning.learningContext}\n`;
    }
    
    // 🧠 NEU: Learning Integrator Erkenntnisse (konkrete Wörter/Muster aus Feedback)
    const learningIntegrator = multiAgentResults.learningIntegrator || {};
    if (learningIntegrator.success && learningIntegrator.enriched) {
      learningSection += `\n\n🧠🧠🧠 LEARNING INTEGRATOR - KONKRETE ERKENNTNISSE AUS FEEDBACK 🧠🧠🧠\n`;
      learningSection += `Der Learning Integrator hat aus Feedback-Daten gelernt, was GUT und SCHLECHT funktioniert:\n\n`;
      
      if (learningIntegrator.insights && learningIntegrator.insights.length > 0) {
        learningSection += `📊 ERKENNTNISSE:\n`;
        learningIntegrator.insights.forEach((insight, idx) => {
          learningSection += `${idx + 1}. ${insight}\n`;
        });
        learningSection += `\n`;
      }
      
      if (learningIntegrator.recommendations && learningIntegrator.recommendations.length > 0) {
        learningSection += `✅ EMPFEHLUNGEN:\n`;
        learningIntegrator.recommendations.forEach((rec, idx) => {
          learningSection += `${idx + 1}. ${rec}\n`;
        });
        learningSection += `\n`;
      }
      
      if (learningIntegrator.relevantWords && learningIntegrator.relevantWords.length > 0) {
        const topWords = learningIntegrator.relevantWords.slice(0, 5);
        learningSection += `✅ WÖRTER DIE GUT FUNKTIONIEREN (aus Feedback gelernt):\n`;
        topWords.forEach(w => {
          learningSection += `- "${w.word}" (Score: ${(w.score * 100).toFixed(0)}%, ${w.count}x als gut markiert)\n`;
        });
        learningSection += `\n🚨 KRITISCH: Nutze diese Wörter in deiner Antwort!\n\n`;
      }
      
      if (learningIntegrator.avoidPatterns && learningIntegrator.avoidPatterns.length > 0) {
        const topAvoid = learningIntegrator.avoidPatterns.slice(0, 5);
        learningSection += `❌ WÖRTER/MUSTER DIE VERMIEDEN WERDEN SOLLTEN (aus Feedback gelernt):\n`;
        topAvoid.forEach(a => {
          learningSection += `- "${a.word}" (${a.reason})\n`;
        });
        learningSection += `\n🚨 KRITISCH: Vermeide diese Wörter/Muster in deiner Antwort!\n\n`;
      }
      
      if (learningIntegrator.relevantPatterns && learningIntegrator.relevantPatterns.length > 0) {
        const topPatterns = learningIntegrator.relevantPatterns.slice(0, 3);
        learningSection += `✅ BEWÄHRTE ANTWORT-MUSTER (aus Feedback gelernt):\n`;
        topPatterns.forEach(p => {
          learningSection += `- "${p.pattern.substring(0, 80)}..." (Erfolgsrate: ${(p.successRate * 100).toFixed(0)}%, ${p.count}x erfolgreich)\n`;
        });
        learningSection += `\n🚨 KRITISCH: Orientiere dich an diesen Mustern!\n\n`;
      }
    }
    
    // ============================================
    // ABSCHNITT 4: SITUATIONEN & ANWEISUNGEN
    // ============================================
    let situationSection = "";
    
    // 4.1 Multi-Situation Instructions
    if (multiAgentResults.multiSituation && multiAgentResults.multiSituation.combinedInstructions) {
      situationSection += `\n[MEHRERE SITUATIONEN ERKANNT]\n${multiAgentResults.multiSituation.combinedInstructions}\n`;
    }

    // 4.2 Specific Situation Instructions
    if (situation.specificInstructions) {
      situationSection += `\n[SITUATION-SPEZIFISCHE ANWEISUNGEN]\n${situation.specificInstructions}\n`;
    }
    
    // ============================================
    // ABSCHNITT 5: KONTEXT & PROFIL
    // ============================================
    let contextSection = "";
    
    // 5.1 Fake-Context
    if (fakeContext.fakeContext) {
      contextSection += `\n[FAKE-PROFIL]\n${fakeContext.fakeContext}\n`;
    }
    
    // 5.2 Customer-Context
    if (profile.customerContext && profile.customerContext.length > 0) {
      contextSection += `\n[KUNDEN-INFOS]\n${profile.customerContext.join('\n')}\n`;
    }
    
    // 5.3 Customer Type
    if (profile.customerTypeContext) {
      contextSection += `\n[KUNDEN-TYP]\n${profile.customerTypeContext}\n`;
    }
    
    // 5.4 Topic & Summary
    if (context.topic) {
      contextSection += `\n[GESPRÄCHS-THEMA]\n${context.topic}\n`;
    }
    if (context.summary) {
      contextSection += `[ZUSAMMENFASSUNG]\n${context.summary}\n`;
    }
    
    // 5.5 Style
    if (style.styleContext) {
      contextSection += `\n[KOMMUNIKATIONS-STIL]\n${style.styleContext}\n`;
    }
    
    // 5.6 Preferred Words (gefiltert)
    if (rules.preferredWordsContext) {
      let filteredPreferredWordsContext = rules.preferredWordsContext;
      
      const hasSexualSituation = situation?.detectedSituations?.includes("Sexuelle Themen") || false;
      if (!hasSexualContent && !hasSexualSituation) {
        const sexualKeywords = ['geil', 'heiß', 'mega', 'fick', 'sex', 'lust', 'titten', 'arsch', 'pussy', 
                               'schwanz', 'richtig', 'total', 'muschi', 'blasen', 'lutschen', 'sperma', 
                               'lecken', 'kitzler', 'vagina', 'penis', 'oral', 'anal', 'doggy', 'horny', 
                               'feucht', 'vorlieben', 'maulfotze', 'fotze', 'ficksahne', 'muschisaft',
                               'arschfotze', 'schwanz', 'maulfotze', 'blasen', 'lutschen', 'vorlieben',
                               'muschi', 'lecken', 'kitzler', 'arschloch', 'ficksahne', 'sperma',
                               'muschisaft', 'vagina', 'penis', 'oralsex', 'fickschwanz', 'anal'];
        
        const lines = filteredPreferredWordsContext.split('\n');
        const filteredLines = lines.filter(line => {
          const lowerLine = line.toLowerCase();
          return !sexualKeywords.some(keyword => lowerLine.includes(keyword));
        });
        
        filteredPreferredWordsContext = filteredLines.join('\n');
        filteredPreferredWordsContext += '\n\n⚠️ KEIN sexuelles Gespräch - KEINE sexuellen bevorzugten Wörter verwenden!\n';
      }
      
      contextSection += `\n[BEVORZUGTE WÖRTER]\n${filteredPreferredWordsContext}\n`;
    }
    
    // 5.7 Image Context
    if (image.imageContext) {
      contextSection += `\n[BILD-KONTEXT]\n${image.imageContext}\n`;
    }
    
    // 5.8 Profile Pic Context
    if (profile.profilePicContext) {
      contextSection += `\n[PROFILBILD-KONTEXT]\n${profile.profilePicContext}\n`;
    }
    
    // 5.9 Proactive Context
    if (proactive.isStagnant && proactive.suggestions && proactive.suggestions.length > 0) {
      contextSection += `\n[PROAKTIVE GESPRÄCHSFÜHRUNG]\nStagnation erkannt - sei proaktiv!\nMögliche Themen: ${proactive.suggestions.join(', ')}\n`;
    }

    // 5.10 Conversation History
    if (conversationContext.conversationBlock) {
      contextSection += `\n[GESPRÄCHS-VERLAUF]\n${conversationContext.conversationBlock}\n`;
      
      // 🚨🚨🚨 NEU: Automatische Kontext-Verbindungen (höchste Priorität!)
      const contextConnection = multiAgentResults.contextConnection || {};
      if (contextConnection.contextInstructions && contextConnection.contextInstructions.trim().length > 0) {
        contextSection += `\n${contextConnection.contextInstructions}\n`;
      }
      
      // 🚨🚨🚨 KRITISCH: Extrahiere die LETZTEN 2-3 Nachrichten von beiden Seiten!
      // Manchmal reicht nur die letzte Nachricht nicht - brauche mehr Kontext!
      const conversationText = conversationContext.conversationBlock || '';
      
      // Extrahiere alle Nachrichten (Fake und Kunde) mit Reihenfolge
      const allMessages = [];
      const linePattern = /(Fake|Kunde):\s*([^\n]+)/g;
      
      let match;
      while ((match = linePattern.exec(conversationText)) !== null) {
        const sender = match[1]; // "Fake" oder "Kunde"
        let msg = match[2].trim();
        // Entferne Anführungszeichen am Anfang/Ende falls vorhanden
        msg = msg.replace(/^["']+|["']+$/g, '').trim();
        if (msg.length > 0) {
          allMessages.push({ sender, message: msg });
        }
      }
      
      // Extrahiere die LETZTEN 3-4 Nachrichten (ca. 2 von jeder Seite für Kontext)
      const recentMessages = allMessages.slice(-4); // Letzte 4 Nachrichten
      
      if (recentMessages.length > 0) {
        contextSection += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: LETZTE NACHRICHTEN (HÖCHSTE PRIORITÄT!) 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
        contextSection += `Die letzten ${recentMessages.length} Nachrichten im Chat:\n\n`;
        
        recentMessages.forEach((msg, idx) => {
          const position = idx === recentMessages.length - 1 ? "NEUESTE" : 
                          idx === recentMessages.length - 2 ? "VORLETZTE" :
                          idx === recentMessages.length - 3 ? "DRITTLETZTE" : "VIERTLETZTE";
          contextSection += `${position} ${msg.sender === "Fake" ? "MODERATOR" : "KUNDE"}-Nachricht:\n`;
          contextSection += `"${msg.message.substring(0, 300)}${msg.message.length > 300 ? '...' : ''}"\n\n`;
        });
        
        // Extrahiere spezifisch die letzten 2-3 Moderator-Nachrichten
        const recentFakeMessages = allMessages.filter(m => m.sender === "Fake").slice(-3);
        const recentCustomerMessages = allMessages.filter(m => m.sender === "Kunde").slice(-2);
        
        contextSection += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: ANALYSIERE DIESE NACHRICHTEN FÜR KONTEXT! 🚨🚨🚨🚨🚨\n`;
        contextSection += `- Du bist MITTEN IM GESPRÄCH - nicht am Anfang!\n`;
        contextSection += `- Die letzten ${recentFakeMessages.length} Moderator-Nachricht(en):\n`;
        recentFakeMessages.forEach((msg, idx) => {
          const num = recentFakeMessages.length - idx;
          contextSection += `  ${num}. "${msg.message.substring(0, 200)}${msg.message.length > 200 ? '...' : ''}"\n`;
        });
        contextSection += `- Die letzten ${recentCustomerMessages.length} Kunden-Nachricht(en):\n`;
        recentCustomerMessages.forEach((msg, idx) => {
          const num = recentCustomerMessages.length - idx;
          contextSection += `  ${num}. "${msg.message.substring(0, 200)}${msg.message.length > 200 ? '...' : ''}"\n`;
        });
        
        // Extrahiere die NEUESTE Moderator-Nachricht speziell
        const lastFakeMessage = recentFakeMessages.length > 0 ? recentFakeMessages[recentFakeMessages.length - 1].message : null;
        
        if (lastFakeMessage) {
          contextSection += `\n🚨🚨🚨🚨🚨 NEUESTE MODERATOR-NACHRICHT (DIESE IST AM WICHTIGSTEN!): 🚨🚨🚨🚨🚨\n`;
          contextSection += `"${lastFakeMessage.substring(0, 400)}${lastFakeMessage.length > 400 ? '...' : ''}"\n\n`;
        }
        
        contextSection += `🚨🚨🚨 ANALYSIERE DIESEN KONTEXT: 🚨🚨🚨\n`;
        contextSection += `- Was war das THEMA der letzten Moderator-Nachricht(en)?\n`;
        contextSection += `- Auf was hat der Kunde geantwortet?\n`;
        contextSection += `- Welcher Kontext wurde in den letzten 2-3 Nachrichten aufgebaut?\n`;
        
        // 🚨🚨🚨 FIX: Spezielle Hinweise für Treffen-Kontext
        const hasMeetingContextFromSituation = situation.hasMeetingContext || 
                                              (situation.detectedSituations && situation.detectedSituations.includes("Treffen/Termine"));
        if (hasMeetingContextFromSituation) {
          // 🚨🚨🚨 NEU: Unterscheide zwischen direkter Anfrage und allgemeiner Diskussion!
          const isDirectMeeting = situation.isDirectMeetingRequest || false;
          
          if (isDirectMeeting) {
            contextSection += `\n🚨🚨🚨 KRITISCH: DIREKTE TREFFEN-ANFRAGE ERKANNT! 🚨🚨🚨\n`;
            contextSection += `- Der Kunde fragt DIREKT nach einem Treffen (z.B. "was machst du morgen?", "hast du heute Zeit?")\n`;
            contextSection += `- Nutze NUR Training-Daten-Beispiele, die ABLEHNEN - diese zeigen, wie man höflich aber klar ablehnt!\n`;
            contextSection += `- Stelle KEINE generischen Fragen!\n\n`;
          } else {
            contextSection += `\n🚨🚨🚨 KRITISCH: TREFFEN-DISKUSSION (NICHT DIREKT)! 🚨🚨🚨\n`;
            contextSection += `- Der Kunde spricht ALLGEMEIN über Treffen/Verfügbarkeit (z.B. "wann klappt es bei dir?", "ich habe am WE immer Zeit")\n`;
            contextSection += `- Sei NICHT ABWEISEND - der Kunde muss das Gefühl haben, dass es eventuell möglich ist!\n`;
            contextSection += `- Nutze Training-Daten für Treffen-Diskussion - diese zeigen, wie man positiv aber vague reagiert!\n`;
            contextSection += `- Stelle KEINE generischen Fragen wie "was machst du am Wochenende?" - nutze Fragen aus Training-Daten!\n\n`;
          }
        }
        
        contextSection += `- Reagiere SPEZIFISCH auf diesen Kontext, nicht generisch!\n`;
        contextSection += `- KEINE generischen Nachrichten wie "Habe oft Gedanken über die kleinen Dinge im Leben" - das ist zu generisch und klingt wie eine erste Nachricht!\n`;
        contextSection += `- KEINE euphorischen Nachrichten wie "Das ist so toll!" - du bist mitten im Gespräch, nicht am Anfang!\n`;
        contextSection += `- Reagiere NATÜRLICH auf das, was der Kunde gesagt hat, basierend auf DEINEN letzten Nachrichten!\n`;
        contextSection += `- Beispiel: Wenn du gefragt hast "welche Gedanken hast du denn?" und der Kunde antwortet "welche Gedanken hast du denn? erzähl mir davon", dann hat er auf DEINE Frage geantwortet - gehe darauf ein!\n`;
        contextSection += `- Wenn in den letzten 2-3 Nachrichten ein bestimmtes Thema angesprochen wurde, bleibe bei diesem Thema!\n\n`;
      }
    }
    
    // ============================================
    // ABSCHNITT 6: KUNDEN-NACHRICHT
    // ============================================
    let customerMessageSection = "";
    
    if (isASA) {
      customerMessageSection += `\n[ASA-REAKTIVIERUNG]\nDer Kunde hat zuletzt nicht geantwortet. Reaktiviere freundlich.\n`;
      if (asaConversationContext && asaConversationContext.trim() !== "") {
        const systemMsgLower = asaConversationContext.toLowerCase();
        const hasKuss = systemMsgLower.includes("kuss") || systemMsgLower.includes("geküsst");
        const hasLike = systemMsgLower.includes("like") || systemMsgLower.includes("geliked");
        
        if (hasKuss || hasLike) {
          customerMessageSection += `System-Nachricht: "${asaConversationContext.substring(0, 200)}"\n`;
          if (hasKuss) customerMessageSection += `- Kunde hat Kuss geschickt - darauf eingehen!\n`;
          if (hasLike) customerMessageSection += `- Kunde hat Like gegeben - darauf eingehen!\n`;
        }
      }
    } else {
      customerMessageSection += `\n[KUNDEN-NACHRICHT]\n"${customerMessage.substring(0, 500)}"\n\n`;
      customerMessageSection += `🚨🚨🚨 KRITISCH: Der Kunde antwortet auf die LETZTE MODERATOR-NACHRICHT! 🚨🚨🚨\n`;
      customerMessageSection += `- Schaue in den GESPRÄCHS-VERLAUF oben - was war die letzte Moderator-Nachricht?\n`;
      customerMessageSection += `- Der Kunde reagiert auf DIESE Nachricht - gehe DIREKT darauf ein!\n`;
      customerMessageSection += `- Wenn die letzte Moderator-Nachricht eine FRAGE gestellt hat (z.B. "welche Gedanken hast du denn?"), dann hat der Kunde darauf geantwortet!\n`;
      customerMessageSection += `- Reagiere SPEZIFISCH auf die Kunden-Antwort, nicht generisch!\n`;
      customerMessageSection += `- KEINE generischen Nachrichten wie "Habe oft Gedanken über die kleinen Dinge im Leben" - das ist zu generisch und klingt wie eine erste Nachricht!\n`;
      customerMessageSection += `- Wenn der Kunde FRAGT, BEANTWORTE die Frage DIREKT - NICHT wiederholen!\n`;
      customerMessageSection += `- Wenn der Kunde auf eine Frage ANTWORTET, dann reagiere auf diese Antwort!\n\n`;
    }
    
    // ============================================
    // ABSCHNITT 7: FINALE ANWEISUNGEN (STRUKTURIERT)
    // ============================================
    let finalInstructionsSection = "";
    
    // 🚨 NEU: isFirstMessage, hasLike und shouldUseFallbackMode wurden bereits oben deklariert - verwende diese!
    // (Variablen wurden in Zeile 4272-4273 und 4309 deklariert)
    
    if (isASA) {
      finalInstructionsSection += `\n[FINALE ANWEISUNG - ASA]\n`;
      finalInstructionsSection += `- Orientiere dich AUSSCHLIESSLICH an ASA-Training-Daten\n`;
      finalInstructionsSection += `- Kopiere Stil, Wortwahl, Struktur aus Training-Daten\n`;
      finalInstructionsSection += `- Mindestens 150 Zeichen\n`;
      finalInstructionsSection += `- Stelle animierende Frage\n`;
    } else if (isFirstMessage && hasLike) {
      // 🚨 NEU: Erst-Nachricht + Like: Instructions haben höchste Priorität
      finalInstructionsSection += `\n[FINALE ANWEISUNG - ERSTE NACHRICHT + LIKE]\n`;
      finalInstructionsSection += `🚨🚨🚨 KRITISCH: Die Instructions oben (ERSTE NACHRICHT) haben HÖCHSTE PRIORITÄT! 🚨🚨🚨\n\n`;
      finalInstructionsSection += `PRIORITÄTEN (in dieser Reihenfolge):\n`;
      finalInstructionsSection += `1. ERSTE NACHRICHT INSTRUCTIONS (HÖCHSTE PRIORITÄT - siehe oben!)\n`;
      finalInstructionsSection += `2. Training-Daten (Stil, Formulierungen, Fragen) - OPTIONAL\n`;
      finalInstructionsSection += `3. Learning-System (bewährte Muster)\n`;
      finalInstructionsSection += `4. Situationen (gehe auf ALLE ein)\n`;
      finalInstructionsSection += `5. Regeln (verbotene/bevorzugte Wörter)\n`;
      finalInstructionsSection += `6. Kontext (Stimmung, Profil, Verlauf)\n\n`;
    } else if (shouldUseFallbackMode) {
      // 🚨 NEU: Fallback-Modus: Vereinfachte Anweisungen
      finalInstructionsSection += `\n[FINALE ANWEISUNG - FALLBACK-MODUS (KEINE GUTEN TRAINING-DATEN)]\n`;
      finalInstructionsSection += `⚠️ WICHTIG: Es wurden keine guten Training-Daten gefunden. Antworte EINFACH und NATÜRLICH!\n\n`;
      finalInstructionsSection += `PRIORITÄTEN (in dieser Reihenfolge):\n`;
      finalInstructionsSection += `1. KONTEXT (Kundennachricht, Chat-Verlauf, Situation)\n`;
      finalInstructionsSection += `2. NATÜRLICHE ANTWORT (einfach, direkt, passend)\n`;
      finalInstructionsSection += `3. Regeln (verbotene/bevorzugte Wörter)\n`;
      finalInstructionsSection += `4. Learning-System (bewährte Muster)\n\n`;
      finalInstructionsSection += `🚨 KRITISCH: Antworte EINFACH und NATÜRLICH - keine komplexen Strukturen!\n`;
      finalInstructionsSection += `- Gehe direkt auf die Kundennachricht ein\n`;
      finalInstructionsSection += `- Reagiere auf den Chat-Verlauf (was wurde vorher besprochen?)\n`;
      finalInstructionsSection += `- Stelle 1 passende Frage (wenn angebracht)\n`;
      finalInstructionsSection += `- KEINE Meta-Kommentare, KEINE komplexen Strukturen\n`;
      finalInstructionsSection += `- Beispiel: "Das denke ich, ich bin mir ziemlich sicher das wir uns gefunden haben ist schicksal, meinst du nicht auch?"\n\n`;
    } else {
      finalInstructionsSection += `\n[FINALE ANWEISUNG]\n`;
      finalInstructionsSection += `PRIORITÄTEN (in dieser Reihenfolge):\n`;
      finalInstructionsSection += `1. Training-Daten (Stil, Formulierungen, Fragen)\n`;
      finalInstructionsSection += `2. Learning-System (bewährte Muster)\n`;
      finalInstructionsSection += `3. Situationen (gehe auf ALLE ein)\n`;
      finalInstructionsSection += `4. Regeln (verbotene/bevorzugte Wörter)\n`;
      finalInstructionsSection += `5. Kontext (Stimmung, Profil, Verlauf)\n\n`;
      
      finalInstructionsSection += `TECHNISCHE ANFORDERUNGEN:\n`;
      finalInstructionsSection += `- Länge: Mindestens 150 Zeichen (vollständig zu Ende schreiben!)\n`;
      finalInstructionsSection += `- Fragen: Überwiegend nur 1 Frage\n`;
      finalInstructionsSection += `- Ausrufezeichen: KEINE (!) verwenden\n`;
      finalInstructionsSection += `- Natürlich und authentisch\n\n`;
      
      finalInstructionsSection += `🚨🚨🚨 KRITISCH: VERBOTENE PHRASEN 🚨🚨🚨\n`;
      finalInstructionsSection += `- KEINE Meta-Kommentare wie "Ich bin gespannt" oder "ich bin schon ganz neugierig"!\n`;
      finalInstructionsSection += `- Stelle einfach die Frage, ohne vorher zu kommentieren!\n`;
      finalInstructionsSection += `- Beispiel FALSCH: "Ich bin schon ganz neugierig. Was magst du denn?"\n`;
      finalInstructionsSection += `- Beispiel RICHTIG: "Was magst du denn?" (direkt, ohne Meta-Kommentar!)\n\n`;
      
      if (isFirstMessage) {
        finalInstructionsSection += `⚠️ ERSTE NACHRICHT: KEINE persönlichen Infos auf einmal!\n`;
      }
      
      if (hasSexualContent) {
        finalInstructionsSection += `⚠️ SEXUELLES GESPRÄCH:\n`;
        finalInstructionsSection += `- Sei sehr direkt und sexuell\n`;
        finalInstructionsSection += `- Nenne eigene Vorlieben BEVOR du fragst\n`;
        finalInstructionsSection += `- Verwende 2-3 sexuelle Wörter aus bevorzugten Wörtern\n`;
        finalInstructionsSection += `- Stelle sexuelle Fragen wie in Training-Daten\n`;
      } else if (!isFirstMessage) {
        finalInstructionsSection += `⚠️ PROAKTIV: Nenne eigene Interessen BEVOR du fragst\n`;
      }
      
      finalInstructionsSection += `\n🚨🚨🚨🚨🚨 KRITISCH: CHAT-VERLAUF BEACHTEN! 🚨🚨🚨🚨🚨\n`;
      finalInstructionsSection += `- Du bist MITTEN IM GESPRÄCH - nicht am Anfang!\n`;
      finalInstructionsSection += `- Schaue in den GESPRÄCHS-VERLAUF oben - was war die letzte Moderator-Nachricht?\n`;
      finalInstructionsSection += `- Der Kunde reagiert auf DIESE Nachricht - gehe DIREKT darauf ein!\n`;
      finalInstructionsSection += `- Wenn die letzte Moderator-Nachricht eine FRAGE gestellt hat, dann hat der Kunde darauf geantwortet!\n`;
      finalInstructionsSection += `- Reagiere SPEZIFISCH auf die Kunden-Antwort, nicht generisch!\n`;
      finalInstructionsSection += `- KEINE generischen Nachrichten wie "Habe oft Gedanken über die kleinen Dinge im Leben" - das ist zu generisch und klingt wie eine erste Nachricht!\n`;
      finalInstructionsSection += `- KEINE euphorischen Nachrichten wie "Das ist so toll!" - du bist mitten im Gespräch, nicht am Anfang!\n`;
      finalInstructionsSection += `- Reagiere NATÜRLICH auf das, was der Kunde gesagt hat, basierend auf dem Chat-Verlauf!\n\n`;
      finalInstructionsSection += `\n⚠️ KEINE Meta-Kommentare wie "Das klingt" - direkt antworten!\n`;
      finalInstructionsSection += `⚠️ Wenn mehrere Situationen: Gehe auf ALLE ein!\n`;
    }
    
    // ============================================
    // KOMBINIERE ALLE ABSCHNITTE (STRUKTURIERT)
    // ============================================
    let userPrompt = "";
    
    // Priorität 1: Kritische Regeln (verbotene Wörter haben höchste Priorität)
    if (criticalRulesSection) {
      userPrompt += criticalRulesSection;
    }
    
    // 🚨🚨🚨 NEU: Priorität 1.5: Chat-Verlauf (FÜR KONTEXT - sehr wichtig!)
    // Chat-Verlauf SO FRÜH wie möglich für besseres Kontext-Verständnis
    if (contextSection) {
      // Extrahiere nur Chat-Verlauf-Abschnitt (nicht alles)
      const chatHistoryMatch = contextSection.match(/(🚨🚨🚨.*LETZTE NACHRICHTEN.*?🚨🚨🚨[\s\S]*?)(?=\n\[|$)/);
      if (chatHistoryMatch) {
        userPrompt += chatHistoryMatch[1] + '\n\n';
      }
    }
    
    // Priorität 2: Training-Daten (HÖCHSTE PRIORITÄT FÜR STIL/FORMULIERUNGEN)
    if (trainingSection) {
      userPrompt += trainingSection;
    }
    
    // Priorität 3: Learning-System
    if (learningSection) {
      userPrompt += learningSection;
    }
    
    // 🧠🧠🧠 Priorität 3.5: Deep Learning (intelligente Muster & Prinzipien)
    if (deepLearning.deepContext) {
      userPrompt += `\n${deepLearning.deepContext}\n`;
    }
    
    // Priorität 4: Situationen
    if (situationSection) {
      userPrompt += situationSection;
    }
    
    // Priorität 5: Kontext (Rest - ohne Chat-Verlauf, der ist schon oben)
    if (contextSection) {
      // Entferne Chat-Verlauf-Abschnitt (bereits oben eingefügt)
      const contextWithoutChatHistory = contextSection.replace(/(🚨🚨🚨.*LETZTE NACHRICHTEN.*?🚨🚨🚨[\s\S]*?)(?=\n\[|$)/, '');
      if (contextWithoutChatHistory.trim().length > 0) {
        userPrompt += contextWithoutChatHistory;
      }
    }
    
    // Priorität 6: Kunden-Nachricht
    if (customerMessageSection) {
      userPrompt += customerMessageSection;
    }
    
    // Priorität 7: Finale Anweisungen
    if (finalInstructionsSection) {
      userPrompt += finalInstructionsSection;
    }

    // Generiere Nachricht (wird später für Rejection Sampling wiederverwendet)
    const generateMessage = async (promptVariation = '', customTemperature = null) => {
      const finalUserPrompt = promptVariation ? userPrompt + `\n\n${promptVariation}` : userPrompt;
      const temperature = customTemperature !== null ? customTemperature : (isASA ? 0.8 : 0.7);
      
      const response = await Promise.race([
        client.chat.completions.create({
          model: AGENT_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: finalUserPrompt }
          ],
          temperature: temperature,
          max_tokens: 350 // 🚨 ERHÖHT: Mehr Tokens, damit die KI nicht zu früh aufhört (wird später intelligent gekürzt)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);

      return response.choices?.[0]?.message?.content?.trim() || '';
    };

    // 🚨🚨🚨 NEU: Multi-Generator mit Learning-basiertem Scoring
    // Generiere 3 Varianten mit unterschiedlichen Temperatures und wähle die beste basierend auf Learning-Daten
    const hasLearningData = learning && learning.learningStats && Object.keys(learning.learningStats).length > 0;
    const detectedSituations = situation?.detectedSituations || [];
    
    // 🚨 DEBUG: Log warum Multi-Generator läuft oder nicht
    console.log(`🔍 Multi-Generator Check: hasLearningData=${hasLearningData}, shouldUseFallbackMode=${shouldUseFallbackMode}`);
    if (hasLearningData) {
      console.log(`📊 Learning-Stats Keys: ${Object.keys(learning.learningStats || {}).join(', ')}`);
    }
    
    let message = null;
    let qualityResult = null;
    
    if (hasLearningData && !shouldUseFallbackMode) {
      // Multi-Generator: Generiere 3 Varianten
      console.log('🚀 Multi-Generator: Generiere 3 Varianten mit unterschiedlichen Temperatures...');
      
      try {
        const { selectRelevantLearningForScoring, scoreMessageByLearning } = require('../utils/learning-system');
        const learningDataForScoring = await selectRelevantLearningForScoring(customerMessage, detectedSituations, learning.learningStats);
        
        if (learningDataForScoring) {
          // Generiere 3 Varianten parallel
          const variants = await Promise.all([
            generateMessage('', 0.3), // Konservativ
            generateMessage('', 0.5), // Balanciert
            generateMessage('', 0.7)  // Kreativ
          ]);
          
          // Post-Processing für alle Varianten
          const processedVariants = variants
            .filter(v => v && v.trim().length > 0)
            .map(v => {
              // 🚨🚨🚨 FIX: Entferne ALLE Arten von Anführungszeichen (einfach, doppelt, typografisch)
              let processed = v
                .replace(/^["'„""]+/, '') // Anfang: einfache, doppelte, typografische
                .replace(/["'"""]+$/, '') // Ende: einfache, doppelte, typografische
                .replace(/^""+/, '') // Zusätzlich: doppelte Anführungszeichen am Anfang
                .replace(/""+$/, '') // Zusätzlich: doppelte Anführungszeichen am Ende
                .trim();
              processed = processed.replace(/-/g, " ");
              processed = processed.replace(/ß/g, "ss");
              processed = processed.replace(/!/g, '.');
              processed = processed.replace(/\?+/g, '?');
              return processed;
            })
            .filter(v => v.length >= 100); // Mindestlänge
          
          if (processedVariants.length > 0) {
            // Bewerte alle Varianten basierend auf Learning-Daten und Stil
            const scoredVariants = await Promise.all(
              processedVariants.map(async (variant) => {
                const learningScore = await scoreMessageByLearning(variant, learningDataForScoring, training);
                const qualityResultVariant = await validateMessageQuality(variant, {
                  multiAgentResults,
                  training,
                  context,
                  conversationHistory,
                  customerMessage,
                  allRules,
                  situation
                });
                
                // 🎨🎨🎨 NEU: Stil-Score (0-100) in 0-100 Skala
                const styleScore = qualityResultVariant.styleScore || 50;
                
                // 🎨 Kombinierter Score: Stil (40%) + Learning (40%) + Quality (20%)
                // Stil und Learning sind wichtiger, Quality ist Backup-Validierung
                const combinedScore = (styleScore * 0.4) + (learningScore * 0.4) + (qualityResultVariant.overallScore * 0.2);
                
                return {
                  message: variant,
                  learningScore,
                  styleScore, // 🎨 NEU: Stil-Score explizit zurückgeben
                  qualityScore: qualityResultVariant.overallScore,
                  combinedScore,
                  qualityResult: qualityResultVariant
                };
              })
            );
            
            // Sortiere nach kombiniertem Score und wähle beste Variante
            scoredVariants.sort((a, b) => b.combinedScore - a.combinedScore);
            const bestVariant = scoredVariants[0];
            
            console.log(`✅ Multi-Generator: Beste Variante ausgewählt (Stil: ${bestVariant.styleScore.toFixed(1)}%, Learning: ${bestVariant.learningScore.toFixed(1)}%, Quality: ${bestVariant.qualityScore.toFixed(1)}%, Combined: ${bestVariant.combinedScore.toFixed(1)}%)`);
            console.log(`   Varianten: ${scoredVariants.map(v => `${v.combinedScore.toFixed(1)}%`).join(', ')}`);
            
            message = bestVariant.message;
            qualityResult = bestVariant.qualityResult;
          } else {
            // Fallback: Verwende normale Generation
            console.warn('⚠️ Multi-Generator: Keine gültigen Varianten generiert - verwende normale Generation');
            message = await generateMessage();
          }
        } else {
          // Fallback: Keine Learning-Daten für Scoring
          console.warn('⚠️ Multi-Generator: Keine Learning-Daten für Scoring - verwende normale Generation');
          message = await generateMessage();
        }
      } catch (err) {
        console.warn('⚠️ Multi-Generator Fehler:', err.message);
        // Fallback: Normale Generation
        message = await generateMessage();
      }
    } else {
      // Fallback: Normale Generation (keine Learning-Daten oder Fallback-Modus)
      if (!hasLearningData) {
        console.log('ℹ️ Multi-Generator: Keine Learning-Daten vorhanden - verwende normale Generation');
      }
      if (shouldUseFallbackMode) {
        console.log('ℹ️ Multi-Generator: Fallback-Modus aktiv - verwende normale Generation');
      }
      message = await generateMessage();
    }
    
    // 🚨 NEU: Definiere statistische Ziele VOR dem if (message) Block (für gesamten Scope verfügbar)
    // 🚨 NEU: Prüfe ob First Message - dann GENAU 150 Zeichen! (firstMessage bereits bei Zeile 2910 deklariert)
    const isFirstMessageForLength = firstMessage.isFirstMessage || false;
    
    let targetMinLength = 150; // 🚨 GEÄNDERT: Mindestlänge jetzt 150 Zeichen (statt 120)
    let targetMaxLength = 200; // Fallback
    
    // 🚨 NEU: Für First Messages: Mindestens 150 Zeichen (zum Abschicken), aber natürlich schreiben!
    if (isFirstMessageForLength) {
      targetMinLength = 150;
      targetMaxLength = 250; // Natürlich schreiben, nicht künstlich kürzen!
    }
    
    let targetAvgExclamationMarks = 0; // Fallback
    let targetAvgQuestions = 1; // Fallback
    
    // Hole Statistiken für die aktuelle Situation (wenn message vorhanden und KEINE First Message)
    if (message && !isFirstMessageForLength) {
      try {
        const { getLearningStats } = require('../utils/learning-system');
        const learningStats = await getLearningStats();
        const primarySituation = situation?.detectedSituations?.[0] || situation?.detectedSituations || 'allgemein';
        const situationName = Array.isArray(primarySituation) ? primarySituation[0] : primarySituation;
        const situationStats = learningStats?.messageStats?.[situationName];
        
        if (situationStats && situationStats.positive && situationStats.positive.count > 0) {
          const posStats = situationStats.positive;
          // Nutze Median als Ziel (robuster als Durchschnitt)
          targetMinLength = Math.max(150, posStats.medianLength - 20 || 150); // 🚨 GEÄNDERT: Mindestens 150, aber Median - 20
          targetMaxLength = Math.min(250, posStats.medianLength + 30 || 200); // Maximal 250, aber Median + 30
          targetAvgExclamationMarks = posStats.medianExclamationMarks || 0;
          targetAvgQuestions = Math.round(posStats.medianQuestions || 1);
          
          console.log(`📊 Nutze statistische Ziele für "${situationName}": Länge ${targetMinLength}-${targetMaxLength}, Fragen: ${targetAvgQuestions}, Ausrufezeichen: ${targetAvgExclamationMarks}`);
        }
      } catch (err) {
        console.warn('⚠️ Konnte statistische Ziele nicht laden, verwende Fallback:', err.message);
      }
    }

    // Post-Processing: Bereinige Nachricht
    if (message) {
      // 🚨🚨🚨 FIX: Entferne ALLE Arten von Anführungszeichen (einfach, doppelt, typografisch)
      // Wichtig: Doppelte Anführungszeichen "" müssen separat entfernt werden
      message = message
        .replace(/^["'„""]+/, '') // Anfang: einfache, doppelte, typografische
        .replace(/["'"""]+$/, '') // Ende: einfache, doppelte, typografische
        .replace(/^""+/, '') // Zusätzlich: doppelte Anführungszeichen am Anfang (falls noch vorhanden)
        .replace(/""+$/, '') // Zusätzlich: doppelte Anführungszeichen am Ende (falls noch vorhanden)
        .trim();
      // Entferne Bindestriche
      message = message.replace(/-/g, " ");
      // Ersetze ß durch ss
      message = message.replace(/ß/g, "ss");
      // Bereinige Ausrufezeichen (max 0, nur in sehr seltenen Fällen 1)
      // Ersetze alle Ausrufezeichen durch Punkte für natürlichere Nachrichten
      message = message.replace(/!/g, '.');
      // Bereinige doppelte Fragezeichen
      message = message.replace(/\?+/g, '?');
      
      // 🚨 NEU: Reduziere mehrere Fragen auf 1 Frage (überwiegend nur 1 Frage)
      // 🚨🚨🚨 KRITISCH: Bei ASA KEINE Frage-Reduzierung - Training-Daten zeigen, wie viele Fragen verwendet werden sollen!
      // 🚨🚨🚨 KRITISCH: Prüfe Training-Daten - wenn sie mehrere Fragen zeigen, dann mehrere Fragen erlauben!
      const questionMatches = message.match(/\?/g);
      const questionCount = questionMatches ? questionMatches.length : 0;
      
      // 🚨 NEU: Prüfe Training-Daten - wie viele Fragen werden dort verwendet?
      let trainingDataQuestionCount = 0;
      if (training && training.selectedExamples && Array.isArray(training.selectedExamples) && training.selectedExamples.length > 0) {
        training.selectedExamples.forEach(example => {
          const responseText = example.moderatorResponse || '';
          const questions = responseText.match(/\?/g) || [];
          trainingDataQuestionCount = Math.max(trainingDataQuestionCount, questions.length);
        });
      }
      
      // 🚨 KRITISCH: Wenn Training-Daten mehrere Fragen zeigen, dann mehrere Fragen erlauben!
      const maxAllowedQuestions = trainingDataQuestionCount > 1 ? trainingDataQuestionCount : 1;
      
      if (!isASA && questionCount > maxAllowedQuestions) {
        console.warn(`⚠️ Nachricht enthält ${questionCount} Fragen (Training-Daten zeigen max. ${maxAllowedQuestions}) - reduziere auf ${maxAllowedQuestions} Frage(n)...`);
        // Teile die Nachricht in Sätze auf
        const sentences = message.split(/(?<=[.!?])\s+/);
        const questionSentences = sentences.filter(s => s.trim().endsWith('?'));
        const nonQuestionSentences = sentences.filter(s => !s.trim().endsWith('?'));
        
        if (questionSentences.length > 1) {
          // Behalte nur die erste Frage (meist die wichtigste)
          const firstQuestion = questionSentences[0];
          // Kombiniere non-question sentences + erste Frage
          message = [...nonQuestionSentences, firstQuestion].join(' ').trim();
          console.log(`✅ Reduziert auf 1 Frage: ${message.substring(0, 100)}...`);
        }
      }
      
      // 🚨 NEU: Prüfe auf proaktive Muster (eigene Vorlieben/Interessen + Frage)
      const { detectProactivePattern } = require('./learning-system');
      const proactiveCheck = detectProactivePattern(message);
      
      // 🚨 NEU: Bei ersten Nachrichten KEINE proaktiven Ergänzungen (zu viele Infos auf einmal!)
      // isFirstMessage wurde bereits oben deklariert
      
      // 🚨 NEU: Proaktive Ergänzungen NUR bei sexuellen Themen (vereinfacht, weniger fehleranfällig)
      // 🚨🚨🚨 KRITISCH: Bei ASA KEINE proaktiven Ergänzungen - Training-Daten sind die EINZIGE Quelle!
      // Bei nicht-sexuellen Themen: KI soll selbst proaktiv sein (aus Training-Daten lernen)
      if (!isFirstMessage && !isASA && hasSexualContent && (!proactiveCheck || !proactiveCheck.hasOwnExperience)) {
        console.warn(`⚠️ Nachricht enthält keine eigenen Erfahrungen/Interessen - ergänze proaktive Elemente (nur bei sexuellen Themen)...`);
        
        // Nur sexuelle proaktive Ergänzungen (keine komplexe semantische Erkennung mehr)
        const sexualAdditions = [
          "Ich liebe Doggy. ",
          "Ich finde es richtig geil, wenn du mich von hinten nimmst. ",
          "Ich mag es, wenn du mir an den Brüsten saugst. ",
          "Ich liebe es, wenn du mich richtig hart nimmst. ",
          "Ich finde es heiß, wenn du mich leckst. "
        ];
        
        const proactiveAddition = sexualAdditions[Math.floor(Math.random() * sexualAdditions.length)];
        
        // Füge proaktive Ergänzung hinzu (vor der Frage, falls vorhanden)
        if (message.includes('?')) {
          // Wenn Frage vorhanden, füge vor der Frage ein
          const questionIndex = message.indexOf('?');
          const beforeQuestion = message.substring(0, questionIndex);
          const afterQuestion = message.substring(questionIndex);
          message = beforeQuestion + (beforeQuestion.trim().endsWith('.') ? ' ' : '. ') + proactiveAddition.trim() + afterQuestion;
        } else {
          // Wenn keine Frage, füge am Anfang hinzu
          message = proactiveAddition + message;
        }
        
        console.log(`✅ Proaktive Ergänzung hinzugefügt (sexuelles Thema): "${proactiveAddition.trim()}"`);
      }
      
      // 🚨 KRITISCH: ALLE Nachrichten müssen mindestens targetMinLength Zeichen lang sein!
      // 🚨🚨🚨 KRITISCH: Bei ASA KEINE künstliche Erweiterung - Training-Daten sind die EINZIGE Quelle!
      // 🚨 REDUZIERT: Nur erweitern wenn WIRKLICH zu kurz (< targetMinLength - 30), sonst nicht proaktiv erweitern
      if (!isASA && message.length < targetMinLength - 30) {
        console.warn(`⚠️ Nachricht zu kurz (${message.length} Zeichen, benötigt >=${targetMinLength}) - erweitere minimal...`);
        // Versuche die Nachricht natürlich zu erweitern
        if (!message.endsWith('?') && !message.endsWith('.')) {
          message += '.';
        }
        // Wenn immer noch zu kurz, füge einen kurzen, kontextuellen Satz hinzu (NICHT generisch!)
        if (message.length < targetMinLength - 30) {
          // 🚨 REDUZIERT: Nur kurze, kontextuelle Ergänzungen (keine generischen Fragen!)
          const extensions = hasSexualContent ? [
            " Was magst du denn so?",
            " Was würdest du noch gerne machen?"
          ] : [
            " Wie siehst du das?",
            " Wie geht es dir damit?"
          ];
          const randomExtension = extensions[Math.floor(Math.random() * extensions.length)];
          message += randomExtension;
        }
        console.log(`✅ Nachricht minimal erweitert auf ${message.length} Zeichen`);
      }
      
      // 🚨 NEU: Kürze Nachrichten, die >targetMaxLength Zeichen sind (außer wirklich nötig)
      if (message.length > targetMaxLength) {
        console.warn(`⚠️ Nachricht zu lang (${message.length} Zeichen, IDEAL: <=${targetMaxLength}) - kürze...`);
        // Versuche die Nachricht intelligent zu kürzen
        // 🚨 KRITISCH: Nur bei Satzenden kürzen, niemals mitten im Satz!
        // 🚨 KRITISCH: Fragen haben Priorität - müssen erhalten bleiben!
        let shortened = message;
        
        // Entferne redundante Phrasen und neue Themen/Proaktivitäten (NUR in Sätzen ohne Frage!)
        const redundantPhrases = [
          /\s+und\s+deshalb\s+/gi,
          /\s+und\s+deswegen\s+/gi,
          /\s+und\s+darum\s+/gi,
          /\s+und\s+aus\s+diesem\s+Grund\s+/gi,
          /\s+ich\s+würde\s+gerne\s+mehr\s+daruber\s+erfahren\s*\./gi,
          /\s+das\s+würde\s+mich\s+interessieren\s*\./gi,
          /\s+erzähl\s+mir\s+doch\s+mehr\s+davon\s*\./gi
        ];
        
        // 🚨 NEU: Entferne Sätze mit neuen Themen/Proaktivitäten (z.B. "kochen", "Zeit für sich", "was man zusammen machen könnte")
        // 🚨 WICHTIG: NUR Sätze OHNE Fragezeichen entfernen!
        const newTopicPhrases = [
          /\s*[^.!?]*(?:kochen|kocht|kochte|kochte|kochend|kochen\s+möchte|kochen\s+könnte|kochen\s+würde|kochst|kochtest|kochtet)[^.!?]*[.!?]/gi,
          /\s*[^.!?]*(?:mag\s+es\s+zeit\s+für\s+sich\s+zu\s+haben|zeit\s+für\s+sich\s+haben|mag\s+es\s+wenn\s+man\s+zeit)[^.!?]*[.!?]/gi,
          /\s*[^.!?]*(?:was\s+man\s+zusammen\s+machen\s+könnte|was\s+man\s+zusammen\s+macht|was\s+wir\s+zusammen)[^.!?]*[.!?]/gi,
          /\s*[^.!?]*(?:wenn\s+du\s+nicht\s+gerade\s+am\s+räumen\s+bist|wenn\s+du\s+nicht\s+am\s+räumen)[^.!?]*[.!?]/gi
        ];
        
        for (const phrase of redundantPhrases) {
          shortened = shortened.replace(phrase, ' ');
        }
        
        // 🚨 NEU: Entferne Sätze mit neuen Themen/Proaktivitäten - NUR Sätze OHNE Fragezeichen!
        const sentencesForFiltering = shortened.split(/(?<=[.!?])\s+/);
        const filteredSentences = sentencesForFiltering.filter(sentence => {
          const trimmed = sentence.trim();
          // 🚨 KRITISCH: Wenn Satz mit Fragezeichen endet, IMMER behalten (Fragen haben Priorität!)
          if (trimmed.endsWith('?')) return true;
          // Sonst prüfe, ob ein Pattern matched - wenn ja, entfernen
          return !newTopicPhrases.some(phrase => phrase.test(sentence));
        });
        shortened = filteredSentences.join(' ').trim();
        
        // Entferne doppelte Leerzeichen nach dem Entfernen
        shortened = shortened.replace(/\s+/g, ' ').trim();
        
        // 🚨 NEU: Intelligente Kürzung mit Fragen-Priorisierung
        // 🚨 KRITISCH: Nur bei Satzenden kürzen, niemals mitten im Satz!
        if (shortened.length > targetMaxLength) {
          const tolerance = 5; // Kleine Toleranz für Satzenden
          const maxAllowedLength = targetMaxLength + tolerance;
          const sentences = shortened.split(/(?<=[.!?])\s+/);
          
          // Trenne Fragen und Nicht-Fragen
          const questionSentences = sentences.filter(s => s.trim().endsWith('?'));
          const nonQuestionSentences = sentences.filter(s => !s.trim().endsWith('?'));
          
          // 🚨 KRITISCH: Fragen MÜSSEN erhalten bleiben!
          let bestCut = shortened;
          
          // Versuche 1: Entferne Nicht-Fragen von hinten, bis Länge passt
          for (let i = nonQuestionSentences.length - 1; i >= 0; i--) {
            const remainingNonQuestions = nonQuestionSentences.slice(0, i);
            const candidate = [...remainingNonQuestions, ...questionSentences].join(' ').trim();
            if (candidate.length <= maxAllowedLength && candidate.length >= 150) {
              bestCut = candidate;
              break;
            }
          }
          
          // Versuche 2: Wenn immer noch zu lang, entferne auch Fragen (aber nur wenn absolut nötig)
          if (bestCut.length > maxAllowedLength && questionSentences.length > 0) {
            // Behalte nur die erste Frage (wichtigste)
            const firstQuestion = questionSentences[0];
            const remainingNonQuestions = nonQuestionSentences.slice(0, -1); // Entferne letzte Nicht-Frage
            const candidate = [...remainingNonQuestions, firstQuestion].join(' ').trim();
            if (candidate.length <= maxAllowedLength && candidate.length >= 150) {
              bestCut = candidate;
            }
          }
          
          // Versuche 3: Wenn immer noch zu lang, kürze bei Satzende (rückwärts, Fragen zuletzt)
          if (bestCut.length > maxAllowedLength) {
            const sentencesForCut = bestCut.split(/(?<=[.!?])\s+/);
            for (let i = sentencesForCut.length - 1; i >= 0; i--) {
              const candidate = sentencesForCut.slice(0, i).join(' ').trim();
              // Prüfe, ob Kandidat eine Frage enthält oder keine Fragen vorhanden sind
              const hasQuestion = candidate.includes('?');
              if (candidate.length <= maxAllowedLength && candidate.length >= 150) {
                // Wenn Kandidat eine Frage hat oder keine Fragen in Original vorhanden sind, verwenden
                if (hasQuestion || questionSentences.length === 0) {
              bestCut = candidate;
              break;
                }
              } else if (candidate.length < 150) {
                // Zu kurz - nimm nächsten längeren
                if (i < sentencesForCut.length - 1) {
                  const longerCandidate = sentencesForCut.slice(0, i + 1).join(' ').trim();
                if (longerCandidate.length <= maxAllowedLength) {
                  bestCut = longerCandidate;
                }
              }
              break;
              }
            }
          }
          
          // Stelle sicher, dass die Nachricht korrekt endet
          bestCut = bestCut.trim();
              if (!bestCut.endsWith('.') && !bestCut.endsWith('?') && !bestCut.endsWith('!')) {
                  bestCut += '.';
                }
          
          shortened = bestCut;
        }
        
        message = shortened;
        console.log(`✅ Nachricht gekürzt auf ${message.length} Zeichen (Ziel: <=${targetMaxLength})`);
      }
      
      // 🚨 KRITISCH: Finale Prüfung - ALLE Nachrichten müssen >=150 Zeichen sein (laut Memories)
      // 🚨🚨🚨 KRITISCH: Bei ASA KEINE künstliche Erweiterung - Training-Daten sind die EINZIGE Quelle!
      // 🚨 FIX: Prüfe NUR wenn wirklich < 150 (nicht <=), und respektiere targetMaxLength
      if (!isASA && message.length < 150) {
        console.warn(`⚠️ Nachricht zu kurz (${message.length} Zeichen, benötigt >=150) - erweitere...`);
        
        // Erweiterungen basierend auf Kontext
        let extensions = [];
        
        // 🚨🚨🚨 KRITISCH: Bei ASA KEINE Erweiterungen - Training-Daten sind die EINZIGE Quelle!
        if (hasSexualContent) {
          // Sexuelle Erweiterungen (verwende bevorzugte Wörter)
          extensions = [
            " Was würdest du denn noch gerne machen?",
            " Erzähl mir mehr über deine Vorlieben.",
            " Was macht dich denn so geil?",
            " Was würdest du mit mir machen?",
            " Wie stellst du dir das vor?",
            " Was magst du denn so?",
            " Erzähl mir, was dich antörnt."
          ];
            } else {
          // Allgemeine Erweiterungen
          extensions = [
            " Was denkst du denn dazu?",
            " Wie siehst du das?",
            " Was meinst du dazu?",
            " Erzähl mir doch mehr davon.",
            " Das würde mich interessieren.",
            " Wie geht es dir damit?"
          ];
        }
        
        // 🚨 FIX: Füge NUR EINE Erweiterung hinzu, wenn sie nicht über targetMaxLength hinausgeht
        // 🚨 WICHTIG: Erweitere vorsichtig, um nicht zu lange Nachrichten zu erzeugen
        const maxAllowed = Math.min(targetMaxLength + 20, 200); // Maximal 200 Zeichen für alle Situationen
        
        if (extensions.length > 0) {
          // Wähle kürzeste Erweiterung, die die Nachricht auf mindestens 150 bringt, aber nicht über targetMaxLength
          // 🚨 FIX: Bei Erstnachrichten: GENAU 150 Zeichen (nicht mehr, nicht weniger!)
          const suitableExtensions = extensions
            .map(ext => ({ ext, newLength: message.length + ext.length }))
            .filter(({ newLength }) => newLength <= maxAllowed)
            .sort((a, b) => a.newLength - b.newLength); // Sortiere nach Länge (kürzeste zuerst)
          
          if (suitableExtensions.length > 0) {
            // Wähle Erweiterung, die die Nachricht auf mindestens 150 Zeichen bringt, aber natürlich schreibt
            const bestExtension = suitableExtensions.find(({ newLength }) => newLength >= 150) || suitableExtensions[0];
            
            if (bestExtension) {
              message += bestExtension.ext;
              console.log(`✅ Nachricht erweitert auf ${message.length} Zeichen (Ziel: >=${targetMinLength}, Max: ${targetMaxLength})`);
            }
          } else {
            console.warn(`⚠️ Keine passende Erweiterung gefunden (alle würden über ${maxAllowed} Zeichen) - behalte ${message.length} Zeichen`);
          }
        }
        
        // Falls immer noch zu kurz UND unter targetMaxLength, füge kürzeste Erweiterung hinzu
        if (message.length < 150) {
          const shortExtension = hasSexualContent 
            ? " Was magst du denn so?"
            : " Was denkst du dazu?";
          const newLength = message.length + shortExtension.length;
          
          if (newLength <= maxAllowed) {
            message += shortExtension;
            console.log(`✅ Nachricht mit kurzer Erweiterung auf ${message.length} Zeichen erweitert`);
          } else {
            console.warn(`⚠️ Auch kurze Erweiterung würde über Maximum bringen - behalte ${message.length} Zeichen (unter 150, aber respektiert Max-Länge)`);
          }
        }
        
        console.log(`✅ Nachricht erweitert auf ${message.length} Zeichen (Ziel: >=150, Max: ${targetMaxLength})`);
      }
      
      // 🚨 FIX: Finale Prüfung - wenn Nachricht nach Erweiterung zu lang ist, kürze nochmal
      // 🚨🚨🚨 KRITISCH: NUR bei Satzenden kürzen, niemals mitten im Satz abschneiden!
      // 🚨 NEU: Bei Erstnachrichten kürzen wir nicht so aggressiv - lassen sie natürlich schreiben
      const maxLengthThreshold = isFirstMessageForLength ? targetMaxLength + 50 : targetMaxLength + 20;
      if (message.length > maxLengthThreshold) {
        console.warn(`⚠️ Nachricht nach Erweiterung zu lang (${message.length} Zeichen, IDEAL: <=${targetMaxLength}) - kürze nochmal...`);
        // Kürze auf targetMaxLength (nutze bestehende Kürzungs-Logik)
        const sentences = message.split(/(?<=[.!?])\s+/);
        let shortened = message;
        
        // 🚨 KRITISCH: Finde beste Kürzung bei Satzende - stelle sicher, dass Nachricht vollständig bleibt!
        for (let i = sentences.length - 1; i >= 0; i--) {
          const candidate = sentences.slice(0, i).join(' ').trim();
          // Stelle sicher, dass Kandidat eine vollständige Nachricht ist (endet mit Satzzeichen)
          // 🚨 NEU: Bei Erstnachrichten mehr Spielraum lassen (natürlich schreiben)
          const candidateMaxLength = isFirstMessageForLength ? targetMaxLength + 50 : targetMaxLength + 20;
          if (candidate.length <= candidateMaxLength && candidate.length >= targetMinLength) {
            // Prüfe, ob Kandidat korrekt endet
            if (candidate.match(/[.!?]$/)) {
              shortened = candidate;
              break;
            } else if (i > 0) {
              // Wenn kein Satzzeichen, füge eines hinzu (aber nur wenn es Sinn macht)
              const candidateWithPeriod = candidate + '.';
              if (candidateWithPeriod.length <= candidateMaxLength) {
                shortened = candidateWithPeriod;
                break;
              }
            }
          }
        }
        
        // 🚨 KRITISCH: Stelle sicher, dass die gekürzte Nachricht vollständig ist!
        if (shortened && !shortened.match(/[.!?]$/)) {
          shortened = shortened.trim() + '.';
        }
        
        // 🚨 KRITISCH: Wenn gekürzte Nachricht zu kurz ist (<150), behalte Original (besser zu lang als zu kurz und unvollständig)
        if (shortened.length < 150) {
          console.warn(`⚠️ Gekürzte Nachricht wäre zu kurz (${shortened.length} Zeichen < 150) - behalte Original (${message.length} Zeichen)`);
          shortened = message; // Behalte Original, wenn Kürzung zu kurz wäre
        }
        
        message = shortened;
        console.log(`✅ Nachricht final gekürzt auf ${message.length} Zeichen (Ziel: 150-${targetMaxLength})`);
      }
      
      // 🚨🚨🚨 KRITISCH: Finale Validierung - stelle sicher, dass Nachricht nicht abgeschnitten ist!
      // Prüfe, ob die Nachricht korrekt endet (mit Satzzeichen) und nicht mitten im Wort/Satz abgeschnitten ist
      if (message && message.trim().length > 0) {
        // Prüfe, ob Nachricht mit Satzzeichen endet
        if (!message.match(/[.!?]$/)) {
          console.warn(`⚠️ Nachricht endet nicht mit Satzzeichen - füge Punkt hinzu...`);
          message = message.trim() + '.';
        }
        
        // 🚨 KRITISCH: Prüfe, ob Nachricht abgeschnitten aussieht (z.B. endet mit "hilf" statt "hilfreich")
        // Wenn die letzte Nachricht sehr kurz ist (< 10 Zeichen) und kein Satzzeichen hat, könnte sie abgeschnitten sein
        const sentences = message.split(/(?<=[.!?])\s+/);
        const lastSentence = sentences[sentences.length - 1] || '';
        if (lastSentence.length < 10 && !lastSentence.match(/[.!?]$/)) {
          console.warn(`⚠️ Verdacht auf abgeschnittene Nachricht (letzter Satz sehr kurz: "${lastSentence}") - entferne letzten unvollständigen Satz...`);
          if (sentences.length > 1) {
            // Entferne letzten Satz, behalte Rest
            const withoutLast = sentences.slice(0, -1).join(' ').trim();
            // Stelle sicher, dass Nachricht noch >= 150 Zeichen hat
            if (withoutLast.length >= 150) {
              message = withoutLast;
              console.log(`✅ Unvollständigen letzten Satz entfernt - Nachricht hat jetzt ${message.length} Zeichen`);
            } else {
              console.warn(`⚠️ Nach Entfernen des letzten Satzes wäre Nachricht zu kurz (${withoutLast.length} < 150) - behalte Original`);
            }
          }
        }
      }
      
      // 🚨 NEU: Prüfe nochmal auf mehrere Fragen nach Kürzung/Erweiterung
      // 🚨🚨🚨 KRITISCH: Bei ASA KEINE Frage-Reduzierung - Training-Daten zeigen, wie viele Fragen verwendet werden sollen!
      // 🚨🚨🚨 KRITISCH: Prüfe Training-Daten - wenn sie mehrere Fragen zeigen, dann mehrere Fragen erlauben!
      // 🚨 WICHTIG: Berücksichtige Mindestlänge - wenn Reduzierung zu kurz macht, behalte beide Fragen
      const finalQuestionMatches = message.match(/\?/g);
      const finalQuestionCount = finalQuestionMatches ? finalQuestionMatches.length : 0;
      
      // 🚨 NEU: Prüfe Training-Daten - wie viele Fragen werden dort verwendet?
      let trainingDataQuestionCountFinal = 0;
      if (training && training.selectedExamples && Array.isArray(training.selectedExamples) && training.selectedExamples.length > 0) {
        training.selectedExamples.forEach(example => {
          const responseText = example.moderatorResponse || '';
          const questions = responseText.match(/\?/g) || [];
          trainingDataQuestionCountFinal = Math.max(trainingDataQuestionCountFinal, questions.length);
        });
      }
      
      // 🚨 KRITISCH: Wenn Training-Daten mehrere Fragen zeigen, dann mehrere Fragen erlauben!
      const maxAllowedQuestionsFinal = trainingDataQuestionCountFinal > 1 ? trainingDataQuestionCountFinal : 1;
      
      if (!isASA && finalQuestionCount > maxAllowedQuestionsFinal) {
        console.warn(`⚠️ Nachricht enthält immer noch ${finalQuestionCount} Fragen nach Kürzung (Training-Daten zeigen max. ${maxAllowedQuestionsFinal}) - reduziere auf ${maxAllowedQuestionsFinal}...`);
        const sentences = message.split(/(?<=[.!?])\s+/);
        const questionSentences = sentences.filter(s => s.trim().endsWith('?'));
        const nonQuestionSentences = sentences.filter(s => !s.trim().endsWith('?'));
        
        if (questionSentences.length > 1) {
          const firstQuestion = questionSentences[0];
          const reducedMessage = [...nonQuestionSentences, firstQuestion].join(' ').trim();
          
          // 🚨 WICHTIG: Prüfe, ob die reduzierte Nachricht noch >= targetMinLength ist
          // Wenn nicht, behalte beide Fragen (besser 2 Fragen als zu kurz)
          if (reducedMessage.length >= targetMinLength) {
            message = reducedMessage;
            console.log(`✅ Final reduziert auf 1 Frage: ${message.substring(0, 100)}...`);
          } else {
            console.warn(`⚠️ Reduzierung würde Nachricht zu kurz machen (${reducedMessage.length} < ${targetMinLength}) - behalte beide Fragen`);
            // Behalte die ursprüngliche Nachricht mit beiden Fragen
          }
        }
      }
    }
    
    // 🚨 ENTFERNT: Template-Fragen entfernt - Fragen werden jetzt aus Training-Daten/Feedback gelernt!
    // 🚨 KRITISCH: Wenn keine Frage vorhanden, sollte die KI selbst eine generieren basierend auf Training-Daten
    // Die KI hat Zugriff auf Training-Daten mit Fragen - sie soll diese verwenden!

    if (!message || message.trim() === '') {
      console.warn('⚠️ Agent: Message-Generator - Leere Nachricht generiert');
      return {
        message: '',
        success: false,
        error: 'Leere Nachricht generiert'
      };
    }

    // 🚨 NEU: QUALITY SCORING & VALIDATION SYSTEM
    // Prüfe, ob alle Informationen genutzt wurden und Nachricht qualitativ hochwertig ist
    // 🚨 WICHTIG: Nur wenn Training-Daten vorhanden sind (nicht im Fallback-Modus)
    // 🚨🚨🚨 NEU: qualityResult wurde bereits im Multi-Generator erstellt (wenn verwendet)
    if (!qualityResult && message) {
      qualityResult = await validateMessageQuality(message, {
        multiAgentResults,
        training,
        context,
        conversationHistory,
        customerMessage,
        allRules,
        situation
      });
    }

    // 🚨🚨🚨 NEU: Training-Daten-Validierung mit Retry (nur wenn Training-Daten vorhanden)
    // Prüfe ob Training-Daten vorhanden sind UND ob wir im Fallback-Modus sind
    const hasTrainingData = training?.selectedExamples && training.selectedExamples.length > 0;
    // shouldUseFallbackMode wurde bereits oben definiert (Zeile ~4492)
    
    // Nur validieren wenn Training-Daten vorhanden UND nicht im Fallback-Modus
    if (hasTrainingData && !shouldUseFallbackMode && qualityResult.trainingDataUsage < 15) {
      // Embedding-Similarity zu niedrig (< 0.55) → Warnung + optionaler Retry
      const lowSimilarity = qualityResult.trainingDataUsage < 15; // < 0.60 Similarity
      
      if (lowSimilarity && retryCounters.total < MAX_TOTAL_RETRIES - 1) {
        console.warn(`⚠️ Niedrige Training-Daten-Ähnlichkeit (${qualityResult.trainingDataUsage.toFixed(1)}%) - versuche Retry mit stärkerem Prompt...`);
        
        // Retry mit stärkerem Prompt (aber nicht blockierend!)
        const strongerPrompt = `\n\n🚨🚨🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENGER AN DEN TRAINING-DATEN! 🚨🚨🚨🚨🚨\n\nDie vorherige Nachricht war zu wenig an Training-Daten orientiert.\n\n🚨🚨🚨 ABSOLUT KRITISCH: KOPIERE WORTWAHL UND FORMULIERUNGEN AUS DEN TRAINING-DATEN! 🚨🚨🚨\n- Verwende GENAU die gleichen Wörter wie in den Beispielen\n- Verwende GENAU die gleichen Formulierungen wie in den Beispielen\n- Verwende GENAU die gleichen Fragen wie in den Beispielen\n- KEINE eigenen Formulierungen erfinden - NUR aus Training-Daten!\n\nGeneriere JETZT eine neue Nachricht, die sich STRENGER an den Training-Daten orientiert!`;
        
        try {
          const retryMessage = await generateMessage(strongerPrompt);
          if (retryMessage) {
            const processedRetryMessage = retryMessage.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
            const retryQualityResult = await validateMessageQuality(processedRetryMessage, {
              multiAgentResults,
              training,
              context,
              conversationHistory,
              customerMessage,
              allRules,
              situation
            });
            
            // Nur übernehmen wenn besser ODER ähnlich (nicht verschlechtert)
            if (retryQualityResult.trainingDataUsage >= qualityResult.trainingDataUsage - 2) {
              message = processedRetryMessage;
              qualityResult = retryQualityResult;
              retryCounters.total++;
              console.log(`✅ Retry erfolgreich - bessere Training-Daten-Orientierung (Similarity: ${retryQualityResult.trainingDataUsage.toFixed(1)}%)`);
            } else {
              console.warn(`⚠️ Retry nicht besser - verwende Original-Nachricht`);
            }
          }
        } catch (err) {
          console.warn(`⚠️ Training-Daten-Retry fehlgeschlagen:`, err.message);
          // Nachricht wird trotzdem akzeptiert (nicht blockieren!)
        }
      }
    }

    // 🚨 NEU: Quality Score Threshold auf 60% reduziert (vorher 85% war zu hoch)
    // Rejection Sampling nur bei sehr niedrigen Scores (<50%) oder ganz entfernen
    if (qualityResult.overallScore < 60) {
      console.warn(`⚠️ Quality Score zu niedrig (${qualityResult.overallScore}%) - versuche Rejection Sampling...`);
      
      // Generiere 2 weitere Nachrichten mit leicht variierten Prompts
      const alternativeMessages = await generateAlternativeMessages(
        multiAgentResults,
        {
          conversationHistory,
          customerMessage,
          profileInfo,
          extractedUserInfo,
          allRules,
          isASA,
          asaConversationContext,
          platformId
        },
        systemPrompt,
        userPrompt,
        2 // 2 weitere Versuche
      );

      // Bewerte alle Nachrichten
      const allMessages = [
        { message, qualityScore: qualityResult.overallScore, qualityResult },
        ...alternativeMessages
      ];

      // Wähle beste Nachricht
      allMessages.sort((a, b) => b.qualityScore - a.qualityScore);
      const bestMessage = allMessages[0];

      if (bestMessage.qualityScore >= 60) {
        console.log(`✅ Beste Nachricht ausgewählt (Score: ${bestMessage.qualityScore}%)`);
        message = bestMessage.message;
        qualityResult = bestMessage.qualityResult;
      } else {
        console.warn(`⚠️ Auch nach Rejection Sampling Score <60% (${bestMessage.qualityScore}%) - verwende beste verfügbare`);
        message = bestMessage.message;
        qualityResult = bestMessage.qualityResult;
      }
    }

    // 🚨 NEU: Semantische Paraphrasieren-Erkennung (vor validateCriticalRules)
    let hasParaphrasing = false;
    if (customerMessage && customerMessage.trim().length > 0) {
      try {
        const similarity = await calculateMessageSimilarity(message, customerMessage);
        // 🚨 NEU: Schwellwert erhöht auf 0.85 (85%) für weniger False Positives
        // Vorher: 0.65 war zu niedrig → normale Antworten wurden als Paraphrasieren erkannt
        if (similarity > 0.85) {
          hasParaphrasing = true;
          console.warn(`⚠️ Paraphrasieren erkannt (semantische Ähnlichkeit: ${(similarity * 100).toFixed(1)}%)`);
        }
      } catch (err) {
        console.warn('⚠️ Fehler bei semantischer Paraphrasieren-Erkennung:', err.message);
      }
    }

    // 🚨 KRITISCH: Finale Validierung - Prüfe auf kritische Verstöße
    // 🚨 WICHTIG: Übergebe isMeetingRequestFunc, damit "treffen" nur blockiert wird, wenn es wirklich eine Treffen-Anfrage ist
    // 🚨 NEU: Übergebe auch customerMessage und conversationHistory für Treffen-Zustimmung
    // 🚨 NEU: validationContext wurde bereits oben erstellt (mit hasSexualContent und detectedSituations)
    const criticalViolations = validateCriticalRules(message, allRules, situation, isMeetingRequestFunc, customerMessage, conversationHistory, validationContext);
    
    // 🚨 NEU: Füge Paraphrasieren-Violation hinzu (wenn erkannt)
    if (hasParaphrasing) {
      criticalViolations.push('Paraphrasieren erkannt (semantische Ähnlichkeit zur Kundennachricht) - blockiert');
    }
    
    // 🛡️ NEU: Retry-Limits zentral definiert (verhindert Endlosschleifen)
    const RETRY_LIMITS = {
      contradiction: 2,      // Widersprüche: Max 2 Retries
      metaComment: 2,        // Meta-Kommentare: Max 2 Retries
      forbiddenWords: 1,     // Verbotene Wörter: Max 1 Retry (kritisch!)
      meetingRequest: 1,     // Treffen-Anfrage: Max 1 Retry (kritisch!)
      meetingAgreement: 1,   // Treffen-Zustimmung: Max 1 Retry (kritisch!)
      paraphrasing: 2,       // Paraphrasieren: Max 2 Retries
      general: 3             // Allgemeine Fehler: Max 3 Retries
    };
    
    // 🛡️ NEU: Retry-Counter pro Fehlertyp (verhindert zu viele Retries insgesamt)
    const retryCounters = {
      contradiction: 0,
      metaComment: 0,
      forbiddenWords: 0,
      meetingRequest: 0,
      meetingAgreement: 0,
      paraphrasing: 0,
      total: 0
    };
    const MAX_TOTAL_RETRIES = 5; // Maximal 5 Retries insgesamt (verhindert Endlosschleifen)
    
    // 🚨 NEU: Retry-Mechanismus für Widersprüche (statt komplett zu blockieren)
    const hasContradictionViolation = criticalViolations.some(v => v.includes('Widerspruch erkannt'));
    
    if (hasContradictionViolation && retryCounters.total < MAX_TOTAL_RETRIES) {
      console.warn(`⚠️ Widerspruch erkannt - versuche automatisch neu zu generieren...`);
      
      // Versuche bis zu maxRetries weitere Male, eine Nachricht OHNE Widerspruch zu generieren
      let retryCount = 0;
      const maxRetries = RETRY_LIMITS.contradiction;
      let retryMessage = message;
      let retrySuccess = false;
      
      while (retryCount < maxRetries && !retrySuccess && retryCounters.total < MAX_TOTAL_RETRIES) {
        retryCount++;
        retryCounters.contradiction++;
        retryCounters.total++;
        console.log(`🔄 Retry ${retryCount}/${maxRetries} (Total: ${retryCounters.total}/${MAX_TOTAL_RETRIES}): Generiere Nachricht ohne Widerspruch...`);
        
        // Generiere mit explizitem Hinweis, Widersprüche zu vermeiden
        const antiContradictionPrompt = `\n\n🚨🚨🚨🚨🚨 KRITISCH: KEINE WIDERSPRÜCHE! 🚨🚨🚨🚨🚨\n\nDie vorherige Nachricht wurde abgelehnt, weil sie widersprüchliche Phrasen enthielt (z.B. positiv/sexuell + negativ/ablehnend).\n\n❌ ABSOLUT VERBOTEN:\n- Positive/sexuelle Phrasen (z.B. "geil", "liebe es", "macht mich") KOMBINIERT MIT negativen/ablehnenden Phrasen (z.B. "tut mir leid", "kann nicht helfen", "kein Interesse")\n- Beispiel FALSCH: "Ich liebe es, wenn du mich richtig hart nimmst. Es tut mir leid, aber ich kann dir dabei nicht helfen."\n\n✅ RICHTIG:\n- Entweder POSITIV und begeistert (z.B. "Macht mich richtig geil, wenn du mich richtig hart nimmst. Würde gerne mehr davon sehen.")\n- Oder HÖFLICH ABLEHNEND (z.B. "Tut mir leid, aber darauf kann ich nicht eingehen.")\n- NIEMALS BEIDES in einer Nachricht!\n\nGeneriere JETZT eine neue Nachricht OHNE Widerspruch!`;
        
        try {
          retryMessage = await generateMessage(antiContradictionPrompt);
          
          // Post-Processing für Retry-Nachricht
          if (retryMessage) {
            retryMessage = retryMessage.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
            retryMessage = retryMessage.replace(/-/g, " ");
            retryMessage = retryMessage.replace(/ß/g, "ss");
            retryMessage = retryMessage.replace(/!/g, '.');
            retryMessage = retryMessage.replace(/\?+/g, '?');
          }
          
          // Prüfe erneut auf Widerspruch
          const retryViolations = validateCriticalRules(retryMessage, allRules, situation, isMeetingRequestFunc, customerMessage, conversationHistory, validationContext);
          const stillHasContradiction = retryViolations.some(v => v.includes('Widerspruch erkannt'));
          
          if (!stillHasContradiction) {
            retrySuccess = true;
            message = retryMessage;
            console.log(`✅ Retry erfolgreich: Nachricht ohne Widerspruch generiert`);
            
            // Bewerte die neue Nachricht erneut
            qualityResult = await validateMessageQuality(message, {
              multiAgentResults,
              training,
              context,
              conversationHistory,
              customerMessage,
              allRules,
              situation
            });
          } else {
            console.warn(`⚠️ Retry ${retryCount}: Immer noch Widerspruch erkannt`);
          }
        } catch (err) {
          console.warn(`⚠️ Retry ${retryCount} fehlgeschlagen:`, err.message);
        }
      }
      
      // Wenn alle Retries fehlgeschlagen sind, generiere Fallback-Nachricht
      if (!retrySuccess) {
        console.error(`🚨 KRITISCH: Nachricht enthält Widerspruch und konnte nicht korrigiert werden (${retryCount} Retries)`);
        
        // 🛡️ NEU: Generiere minimale Fallback-Nachricht
        try {
          const fallbackMessage = await generateFallbackMessage(customerMessage, context, 'Widerspruch erkannt');
          if (fallbackMessage) {
            console.log(`🔄 Fallback-Nachricht generiert (wegen Widerspruch)`);
            return {
              message: fallbackMessage,
              success: true,
              isFallback: true,
              error: 'Widerspruch erkannt - Fallback-Nachricht verwendet',
              violations: criticalViolations,
              qualityResult: null
            };
          }
        } catch (err) {
          console.error(`⚠️ Fallback-Nachricht konnte nicht generiert werden:`, err.message);
        }
        
        return {
          message: '',
          success: false,
          error: 'Widerspruch erkannt und konnte nicht korrigiert werden',
          violations: criticalViolations,
          qualityResult: null
        };
      }
    }
    
    // 🚨 NEU: Retry-Mechanismus für Meta-Kommentare (statt komplett zu blockieren)
    // 🚨🚨🚨 KRITISCH: "Das klingt..." ist auch ein Meta-Kommentar! 🚨🚨🚨
    const hasMetaCommentViolation = criticalViolations.some(v => 
      v.includes('Meta-Kommentar') || 
      v.includes('Das klingt') || 
      v.includes('Es klingt') ||
      v.includes('klingt') && v.includes('ABSOLUT VERBOTEN')
    );
    
    if (hasMetaCommentViolation && retryCounters.total < MAX_TOTAL_RETRIES) {
      console.warn(`⚠️ Meta-Kommentar oder "Das klingt..." erkannt - versuche automatisch neu zu generieren...`);
      
      // Versuche bis zu maxRetries weitere Male, eine Nachricht OHNE Meta-Kommentare zu generieren
      let retryCount = 0;
      const maxRetries = RETRY_LIMITS.metaComment;
      let retryMessage = message;
      let retrySuccess = false;
      
      while (retryCount < maxRetries && !retrySuccess && retryCounters.total < MAX_TOTAL_RETRIES) {
        retryCount++;
        retryCounters.metaComment++;
        retryCounters.total++;
        console.log(`🔄 Retry ${retryCount}/${maxRetries} (Total: ${retryCounters.total}/${MAX_TOTAL_RETRIES}): Generiere Nachricht ohne Meta-Kommentare/"Das klingt..."...`);
        
        // Generiere mit explizitem Hinweis, Meta-Kommentare und "Das klingt..." zu vermeiden
        const antiMetaPrompt = `\n\n🚨🚨🚨🚨🚨 KRITISCH: KEINE META-KOMMENTARE UND KEIN "DAS KLINGT..."! 🚨🚨🚨🚨🚨\n\nDie vorherige Nachricht wurde abgelehnt, weil sie Meta-Kommentare oder "Das klingt..." enthielt.\n\n❌ ABSOLUT VERBOTEN (Kommentar über NACHRICHT/SITUATION):\n- "Das klingt..." / "Es klingt..." / "Klingt..." in ALLEN Varianten!\n- "Das klingt nach..." / "Es klingt nach..." / "Klingt nach..." in ALLEN Varianten!\n- "Das klingt geil" / "Das klingt gut" / "Das klingt nach einem Plan" etc. - ALLES VERBOTEN!\n- "Ich finde es toll/gut/schön/super/schon mal gut, dass du..."\n- "Ich finde es toll/gut/schön/super, wie du..."\n- "Ich finde dass du... toll/super/gut" (in ALLEN Varianten!)\n- "Ich kann mir vorstellen, dass du..."\n- Jede Formulierung, die die NACHRICHT oder SITUATION des Kunden kommentiert!\n\n✅ ERLAUBT STATTDESSEN (DIREKTE Reaktion auf INHALT):\n- "Das finde ich geil" / "Das ist geil" / "Mega!" (DIREKT auf Vorschlag reagieren)\n- "Das würde mir gefallen" / "Das würde mich richtig geil machen" (DIREKT auf Inhalt reagieren)\n- "Ich finde das geil" (Antwort auf Frage "Findest du das geil?")\n- "Anal Sex finde ich richtig geil" (Antwort auf Frage)\n\n✅ RICHTIG - Direkt reagieren:\n- Statt "Das klingt geil" → "Das finde ich geil" / "Das ist geil" / "Mega, das würde mir gefallen!"\n- Statt "Das klingt nach einem guten Plan" → "Das finde ich gut" / "Das würde mir gefallen" / "Mega!"\n- Statt "Ich finde es toll, dass du auf der Couch chillst" → "Auf der Couch chillen ist entspannt. Was würdest du denn gerne machen?"\n- Direkt auf INHALT reagieren, nicht NACHRICHT kommentieren!\n\n🚨🚨🚨 KRITISCH: "Das klingt..." ist IMMER ein META-KOMMENTAR, auch wenn es auf einen Vorschlag reagiert! 🚨🚨🚨\nVerwende STATTDESSEN direkte Formulierungen wie "Das finde ich geil", "Das ist geil", "Mega!", "Das würde mir gefallen"!\n\nGeneriere JETZT eine neue Nachricht OHNE Meta-Kommentare UND OHNE "Das klingt..."!`;
        
        try {
          retryMessage = await generateMessage(antiMetaPrompt);
          
          // Post-Processing für Retry-Nachricht
          if (retryMessage) {
            retryMessage = retryMessage.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
            retryMessage = retryMessage.replace(/-/g, " ");
            retryMessage = retryMessage.replace(/ß/g, "ss");
            retryMessage = retryMessage.replace(/!/g, '.');
            retryMessage = retryMessage.replace(/\?+/g, '?');
          }
          
          // Prüfe erneut auf Meta-Kommentare und "Das klingt..."
          const retryViolations = validateCriticalRules(retryMessage, allRules, situation, isMeetingRequestFunc, customerMessage, conversationHistory, validationContext);
          const stillHasMetaComment = retryViolations.some(v => 
            v.includes('Meta-Kommentar') || 
            v.includes('Das klingt') || 
            v.includes('Es klingt') ||
            (v.includes('klingt') && v.includes('ABSOLUT VERBOTEN'))
          );
          
          if (!stillHasMetaComment) {
            retrySuccess = true;
            message = retryMessage;
            console.log(`✅ Retry erfolgreich: Nachricht ohne Meta-Kommentare generiert`);
            
            // Bewerte die neue Nachricht erneut
            qualityResult = await validateMessageQuality(message, {
              multiAgentResults,
              training,
              context,
              conversationHistory,
              customerMessage,
              allRules,
              situation
            });
          } else {
            console.warn(`⚠️ Retry ${retryCount}: Immer noch Meta-Kommentare erkannt`);
          }
        } catch (err) {
          console.warn(`⚠️ Retry ${retryCount} fehlgeschlagen:`, err.message);
        }
      }
      
      // Wenn alle Retries fehlgeschlagen sind, aber es NUR Meta-Kommentare waren (keine anderen kritischen Verstöße)
      if (!retrySuccess) {
        const otherViolations = criticalViolations.filter(v => !v.includes('Meta-Kommentar'));
        if (otherViolations.length === 0) {
          // Nur Meta-Kommentare - verwende die beste verfügbare Nachricht (auch wenn sie Meta-Kommentare hat)
          // Besser als gar keine Nachricht
          console.warn(`⚠️ Alle Retries fehlgeschlagen - verwende beste verfügbare Nachricht (könnte noch Meta-Kommentare enthalten)`);
          // message bleibt die letzte generierte Nachricht
        } else {
          // Andere kritische Verstöße - blockiere komplett
      console.error(`🚨 KRITISCH: Nachricht enthält kritische Verstöße: ${criticalViolations.join(', ')}`);
      return {
        message: '',
        success: false,
        error: `Kritische Regelverstöße: ${criticalViolations.join(', ')}`
      };
        }
      }
    } else if (criticalViolations.length > 0) {
      // 🚨 NEU: Retry-Mechanismus für verbotene Wörter (statt komplett zu blockieren)
      const hasForbiddenWordViolation = criticalViolations.some(v => v.includes('Verbotene Wörter'));
      
      if (hasForbiddenWordViolation && retryCounters.total < MAX_TOTAL_RETRIES && retryCounters.forbiddenWords < RETRY_LIMITS.forbiddenWords) {
        console.warn(`⚠️ Verbotene Wörter erkannt, versuche Retry mit explizitem Hinweis...`);
        const forbiddenWords = criticalViolations
          .find(v => v.includes('Verbotene Wörter'))
          ?.replace('Verbotene Wörter: ', '')
          .split(', ')
          .map(w => w.trim()) || [];
        
        const antiForbiddenPrompt = `\n\n🚨🚨🚨🚨🚨 KRITISCH: VERBOTENE WÖRTER ERKANNT! 🚨🚨🚨🚨🚨\n\nDie vorherige Nachricht wurde abgelehnt, weil sie verbotene Wörter enthielt: ${forbiddenWords.join(', ')}\n\n🚨 ABSOLUT VERBOTEN:\n${forbiddenWords.map(w => `- "${w}"`).join('\n')}\n\n✅ RICHTIG:\n- Verwende SYNONYME oder UMSCHREIBUNGEN statt dieser Wörter!\n- Beispiel: Statt "Vorstellung" → "Fantasie", "Ideen", "Gedanken", "was du dir vorstellst"\n- Beispiel: Statt "kann mir vorstellen" → "kann mir gut denken", "kann mir gut vorstellen wie", "kann mir gut ausmalen"\n\nGeneriere JETZT eine neue Nachricht OHNE diese verbotenen Wörter!`;
        
        let retryCount = 0;
        const maxRetries = RETRY_LIMITS.forbiddenWords;
        let retrySuccess = false;
        
        while (retryCount < maxRetries && !retrySuccess && retryCounters.total < MAX_TOTAL_RETRIES) {
          retryCount++;
          retryCounters.forbiddenWords++;
          retryCounters.total++;
          console.warn(`⚠️ Retry ${retryCount}/${maxRetries} (Total: ${retryCounters.total}/${MAX_TOTAL_RETRIES}) für verbotene Wörter...`);
          
          const retryMessage = await generateMessage(antiForbiddenPrompt);
          if (retryMessage) {
            // Post-processing
            let processedRetryMessage = retryMessage.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
            processedRetryMessage = processedRetryMessage.replace(/-/g, " ");
            processedRetryMessage = processedRetryMessage.replace(/ß/g, "ss");
            processedRetryMessage = processedRetryMessage.replace(/!/g, '.');
            processedRetryMessage = processedRetryMessage.replace(/\?+/g, '?');
            
            const retryViolations = validateCriticalRules(processedRetryMessage, allRules, situation, isMeetingRequestFunc, customerMessage, conversationHistory, validationContext);
            const stillHasForbidden = retryViolations.some(v => v.includes('Verbotene Wörter'));
            
            if (!stillHasForbidden) {
              retrySuccess = true;
              message = processedRetryMessage;
              qualityResult = await validateMessageQuality(message, {
                multiAgentResults,
                training,
                context,
                conversationHistory,
                customerMessage,
                allRules,
                situation
              });
              console.log(`✅ Retry erfolgreich - verbotene Wörter entfernt (Quality Score: ${qualityResult.overallScore}%)`);
            } else {
              console.warn(`⚠️ Retry ${retryCount} enthält immer noch verbotene Wörter`);
            }
          }
        }
        
        if (!retrySuccess) {
          console.warn(`⚠️ Alle Retries fehlgeschlagen - verwende beste verfügbare Nachricht (könnte noch verbotene Wörter enthalten)`);
          // message bleibt die letzte generierte Nachricht
        }
      } else {
        // 🚨 NEU: Retry-Mechanismus für Treffen-Zustimmung
        const hasMeetingAgreement = criticalViolations.some(v => v.includes('Treffen-Zustimmung'));
        
        if (hasMeetingAgreement && retryCounters.total < MAX_TOTAL_RETRIES && retryCounters.meetingAgreement < RETRY_LIMITS.meetingAgreement) {
          console.warn(`⚠️ Treffen-Zustimmung erkannt - versuche Retry mit explizitem Hinweis...`);
          
          const antiMeetingAgreementPrompt = `\n\n🚨🚨🚨🚨🚨 KRITISCH: KEINE TREFFEN-ZUSTIMMUNG! 🚨🚨🚨🚨🚨\n\nDie vorherige Nachricht wurde abgelehnt, weil sie einem Treffen zugestimmt hat.\n\n❌ ABSOLUT VERBOTEN (Zustimmung zu Treffen):\n- "klingt super" (bei Treffen-Anfrage)\n- "würde gut passen" (bei Treffen-Anfrage)\n- "sind schon ganz heiss darauf" (bei Treffen-Anfrage)\n- "Freitag klingt super" (bei Treffen-Anfrage)\n- Jede Formulierung, die einem Treffen zustimmt!\n\n✅ RICHTIG (höflich ausweichen):\n- "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen"\n- "Ich würde gerne wissen, wie du es dir vorstellst, aber ich möchte dich erst noch besser kennenlernen"\n- "Das könnte ich mir vorstellen, aber ich möchte dich erst noch besser kennenlernen"\n- Sage ZUERST, dass du an diesem Tag/Termin leider schon was vor hast, DANN frage, wie er es sich vorstellen würde\n\nGeneriere JETZT eine neue Nachricht, die HÖFLICH AUSWEICHT, nicht zustimmt!`;
          
          let retryCount = 0;
          const maxRetries = RETRY_LIMITS.meetingAgreement;
          let retrySuccess = false;
          
          while (retryCount < maxRetries && !retrySuccess && retryCounters.total < MAX_TOTAL_RETRIES) {
            retryCount++;
            retryCounters.meetingAgreement++;
            retryCounters.total++;
            console.warn(`⚠️ Retry ${retryCount}/${maxRetries} (Total: ${retryCounters.total}/${MAX_TOTAL_RETRIES}) für Treffen-Zustimmung...`);
            
            try {
              const retryMessage = await generateMessage(antiMeetingAgreementPrompt);
              if (retryMessage) {
                // Post-processing
                let processedRetryMessage = retryMessage.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
                processedRetryMessage = processedRetryMessage.replace(/-/g, " ");
                processedRetryMessage = processedRetryMessage.replace(/ß/g, "ss");
                processedRetryMessage = processedRetryMessage.replace(/!/g, '.');
                processedRetryMessage = processedRetryMessage.replace(/\?+/g, '?');
                
                const retryViolations = validateCriticalRules(processedRetryMessage, allRules, situation, isMeetingRequestFunc, customerMessage, conversationHistory, validationContext);
                const stillHasAgreement = retryViolations.some(v => v.includes('Treffen-Zustimmung'));
                
                if (!stillHasAgreement) {
                  retrySuccess = true;
                  message = processedRetryMessage;
                  qualityResult = await validateMessageQuality(message, {
                    multiAgentResults,
                    training,
                    context,
                    conversationHistory,
                    customerMessage,
                    allRules,
                    situation
                  });
                  console.log(`✅ Retry erfolgreich - Treffen-Zustimmung entfernt (Quality Score: ${qualityResult.overallScore}%)`);
                } else {
                  console.warn(`⚠️ Retry ${retryCount} enthält immer noch Treffen-Zustimmung`);
                }
              }
            } catch (err) {
              console.warn(`⚠️ Retry ${retryCount} fehlgeschlagen:`, err.message);
            }
          }
          
          if (!retrySuccess) {
            console.warn(`⚠️ Alle Retries fehlgeschlagen - verwende beste verfügbare Nachricht (könnte noch Treffen-Zustimmung enthalten)`);
            // message bleibt die letzte generierte Nachricht
          }
        } else {
          // 🚨 NEU: Retry-Mechanismus für Paraphrasieren
          const hasParaphrasing = criticalViolations.some(v => v.includes('Paraphrasieren'));
          
          if (hasParaphrasing && retryCounters.total < MAX_TOTAL_RETRIES && retryCounters.paraphrasing < RETRY_LIMITS.paraphrasing) {
            console.warn(`⚠️ Paraphrasieren erkannt - versuche Retry mit explizitem Hinweis...`);
            
            const antiParaphrasingPrompt = `\n\n🚨🚨🚨🚨🚨 KRITISCH: KEINE WIEDERHOLUNG/PARAPHRASIERUNG! 🚨🚨🚨🚨🚨\n\nDie vorherige Nachricht wurde abgelehnt, weil sie die Kundennachricht wiederholt/paraphrasiert hat.\n\n❌ ABSOLUT VERBOTEN:\n- Wiederhole NICHT die Kundennachricht!\n- Paraphrasiere NICHT die Kundennachricht!\n- Verwende NICHT die gleichen Wörter/Phrasen wie der Kunde!\n\n✅ RICHTIG:\n- Gehe auf den INHALT ein, nicht auf die Formulierung!\n- Reagiere auf das, was der Kunde MEINT, nicht auf die Wörter, die er verwendet!\n- Zeige eigene Gedanken/Vorlieben/Interessen, dann frage!\n- Beispiel: Kunde sagt "Es liegt nur an uns das es klappt" → NICHT "Es liegt an uns, das alles so hinzubekommen" (Wiederholung!)\n- Beispiel: Kunde sagt "Es liegt nur an uns das es klappt" → RICHTIG: "Ich finde es schön, dass du so positiv denkst. Was würdest du denn gerne machen?"\n\nGeneriere JETZT eine neue Nachricht, die auf den INHALT eingeht, nicht die Formulierung wiederholt!`;
            
            let retryCount = 0;
            const maxRetries = RETRY_LIMITS.paraphrasing;
            let retrySuccess = false;
            
            while (retryCount < maxRetries && !retrySuccess && retryCounters.total < MAX_TOTAL_RETRIES) {
              retryCount++;
              retryCounters.paraphrasing++;
              retryCounters.total++;
              console.warn(`⚠️ Retry ${retryCount}/${maxRetries} (Total: ${retryCounters.total}/${MAX_TOTAL_RETRIES}) für Paraphrasieren...`);
              
              try {
                const retryMessage = await generateMessage(antiParaphrasingPrompt);
                if (retryMessage) {
                  // Post-processing
                  let processedRetryMessage = retryMessage.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
                  processedRetryMessage = processedRetryMessage.replace(/-/g, " ");
                  processedRetryMessage = processedRetryMessage.replace(/ß/g, "ss");
                  processedRetryMessage = processedRetryMessage.replace(/!/g, '.');
                  processedRetryMessage = processedRetryMessage.replace(/\?+/g, '?');
                  
                  const retryViolations = validateCriticalRules(processedRetryMessage, allRules, situation, isMeetingRequestFunc, customerMessage, conversationHistory, validationContext);
                  const stillHasParaphrasing = retryViolations.some(v => v.includes('Paraphrasieren'));
                  
                  if (!stillHasParaphrasing) {
                    retrySuccess = true;
                    message = processedRetryMessage;
                    qualityResult = await validateMessageQuality(message, {
                      multiAgentResults,
                      training,
                      context,
                      conversationHistory,
                      customerMessage,
                      allRules,
                      situation
                    });
                    console.log(`✅ Retry erfolgreich - Paraphrasieren entfernt (Quality Score: ${qualityResult.overallScore}%)`);
                  } else {
                    console.warn(`⚠️ Retry ${retryCount} enthält immer noch Paraphrasieren`);
                  }
                }
              } catch (err) {
                console.warn(`⚠️ Retry ${retryCount} fehlgeschlagen:`, err.message);
              }
            }
            
            if (!retrySuccess) {
              console.warn(`⚠️ Alle Retries fehlgeschlagen - verwende beste verfügbare Nachricht (könnte noch Paraphrasieren enthalten)`);
              // message bleibt die letzte generierte Nachricht
            }
          } else {
            // Andere kritische Verstöße (nicht Meta-Kommentare, nicht verbotene Wörter, nicht Treffen-Zustimmung, nicht Paraphrasieren) - blockiere komplett
            console.error(`🚨 KRITISCH: Nachricht enthält kritische Verstöße: ${criticalViolations.join(', ')}`);
            return {
              message: '',
              success: false,
              error: `Kritische Regelverstöße: ${criticalViolations.join(', ')}`
            };
          }
        }
      }
    }

    console.log(`✅ Agent: Message-Generator - Nachricht generiert (${message.length} Zeichen, Quality Score: ${qualityResult.overallScore}%)`);
    return {
      message,
      success: true,
      qualityScore: qualityResult.overallScore,
      qualityDetails: qualityResult
    };
  } catch (err) {
    console.warn('⚠️ Agent: Message-Generator - Fehler:', err.message);
    return {
      message: '',
      success: false,
      error: err.message
    };
  }
}

/**
 * Orchestrator: Führt alle Agenten aus (parallel wo möglich)
 */
async function runMultiAgentPipeline({
  conversationHistory,
  customerMessage,
  profileInfo,
  extractedUserInfo,
  allRules,
  trainingData = null, // 📚 Training Data für Training-Selector-Agent
  situations = [],
  imageUrl,
  moderatorMessages,
  customerMessages,
  allMessages,
  feedbackData = null, // 📊 Feedback-Daten für Learning-System
  vectorDbFunc,
  imageAnalysisFunc,
  proactiveAnalysisFunc,
  analyzeWritingStyleFunc,
  isInfoMessageFunc,
  isASA = false, // 🤖 ASA-UNTERSTÜTZUNG: Flag für ASA-Fall
  asaConversationContext = '', // 🤖 ASA-UNTERSTÜTZUNG: Kontext für ASA-Filterung
  isLocationQuestionFunc = null, // Helper-Funktion für Wohnort-Fragen
  findNearbyCityFunc = null, // Helper-Funktion für nahegelegene Städte
  isMeetingRequestFunc = null // Helper-Funktion für Treffen-Erkennung
}) {
  console.log(`🤖 Multi-Agent Pipeline gestartet${isASA ? ' (ASA-Modus)' : ''}...`);

  // 🧠 NEU: Initialisiere Shared Knowledge Base
  const sharedKB = resetSharedKnowledgeBase();
  console.log('🧠 Shared Knowledge Base initialisiert');

  // 🛡️ SCHRITT 0: Safety-Check (HÖCHSTE PRIORITÄT - blockiert sofort bei Problemen)
  const safetyCheck = runSafetyCheck(customerMessage);
  if (safetyCheck.isBlocked) {
    console.error(`🛡️ Safety-Agent: BLOCKIERT - ${safetyCheck.reason}`);
    return {
      safety: safetyCheck,
      blocked: true,
      error: safetyCheck.errorMessage
    };
  }
  console.log('🛡️ Safety-Agent: Keine Sicherheitsprobleme erkannt');

  // Schritt 1: Kontext-Analyse (sequenziell - benötigt von anderen)
  // 🛡️ NEU: Mit Fallback für Robustheit
  const contextResult = await runAgentWithFallback(
    agentContextAnalyst,
    'Context Analyst',
    { topic: 'unknown', summary: '', contextFlow: 'neutral', keyPoints: [], success: false },
    10000,
    conversationHistory,
    customerMessage
  );
  
  // 🧠 Schreibe Erkenntnisse in Shared Knowledge Base
  sharedKB.writeAgentInsights('contextAnalyst', 
    [`Thema: ${contextResult.topic || 'allgemein'}`, `Kontext-Flow: ${contextResult.contextFlow || 'neutral'}`],
    contextResult.keyPoints || [],
    contextResult
  );

  // Schritt 2: Profile-Filter (parallel, keine Abhängigkeiten)
  const profileResult = await agentProfileFilter(profileInfo, contextResult, extractedUserInfo);
  
  // 🧠 Schreibe Erkenntnisse in Shared Knowledge Base
  if (profileResult.customerContext && profileResult.customerContext.length > 0) {
    sharedKB.writeAgentInsights('profileFilter',
      [`${profileResult.customerContext.length} Kunden-Infos extrahiert`],
      profileResult.customerContext.slice(0, 3),
      profileResult
    );
  }
  
  // 🧠 NEU: Schritt 2.5: Conversation Flow Analyzer - analysiert Chat-Verlauf und erkennt aktuelle vs. veraltete Kontexte
  // Filtere Nachrichten (falls isInfoMessageFunc verfügbar)
  const moderatorMessagesForFlow = (moderatorMessages || []).filter(m => {
    if (!m || typeof m !== 'object') return false;
    if (isInfoMessageFunc && typeof isInfoMessageFunc === 'function') {
      return !isInfoMessageFunc(m);
    }
    return (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "";
  }).slice(-10); // Letzte 10 für bessere Analyse
  
  const customerMessagesForFlow = (customerMessages || []).filter(m => {
    if (!m || typeof m !== 'object') return false;
    if (isInfoMessageFunc && typeof isInfoMessageFunc === 'function') {
      return !isInfoMessageFunc(m);
    }
    return (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "";
  }).slice(-10); // Letzte 10 für bessere Analyse
  
  const flowAnalysisResult = await agentConversationFlowAnalyzer(
    customerMessage,
    conversationHistory,
    moderatorMessagesForFlow,
    customerMessagesForFlow,
    sharedKB
  );
  
  // 🧠 Schreibe Flow-Analyse-Erkenntnisse in Shared Knowledge Base (wurde bereits in agentConversationFlowAnalyzer gemacht)
  if (flowAnalysisResult.success) {
    console.log(`🧠 Conversation Flow Analyzer: Aktuelles Thema: "${flowAnalysisResult.activeContext?.currentTopic || 'keines'}", Veraltete Themen: ${flowAnalysisResult.outdatedContext?.oldTopics?.length || 0}`);
  }
  
  // 🧠 NEU: Schritt 2.6: Ambiguity Resolver - interpretiert mehrdeutige Phrasen im Profil-Kontext
  const customerProfile = extractedUserInfo?.user || {};
  const moderatorProfile = extractedUserInfo?.assistant || {};
  const ambiguityResult = await agentAmbiguityResolver(
    customerMessage,
    customerProfile,
    moderatorProfile,
    conversationHistory,
    sharedKB
  );
  
  // 🧠 Schreibe Ambiguity-Erkenntnisse in Shared Knowledge Base (wurde bereits in agentAmbiguityResolver gemacht, aber für Rückgabe)
  if (ambiguityResult.success && ambiguityResult.resolvedMeaning) {
    console.log(`🧠 Ambiguity Resolver: "${ambiguityResult.resolvedMeaning}"`);
  }

  // Schritt 3: Situation-Detector & Fake-Context-Builder (können parallel)
  // 🚨 KRITISCH: Übergebe auch conversationHistory und Nachrichten für Kontext-Analyse!
  // 🚨 NEU: Übergebe contextResult an Situation-Detector für LLM-basierte Erkennung!
  // 🛡️ NEU: Situation-Detector mit Fallback (kritisch!)
  const [situationResult, fakeContextResult] = await Promise.all([
    runAgentWithFallback(
      agentSituationDetector,
      'Situation Detector',
      { detectedSituations: [], hasExplicitSexualInMessage: false, success: false },
      15000,
      customerMessage, allRules, isLocationQuestionFunc, findNearbyCityFunc, isMeetingRequestFunc, profileInfo, extractedUserInfo, conversationHistory, moderatorMessages, customerMessages, contextResult, false, null // ⚠️ FIX: Kein learningContextResult mehr - Situation-Detector benötigt es nicht
    ),
    agentFakeContextBuilder(extractedUserInfo, profileInfo)
  ]);
  
  // 🛡️ NEU: Prüfe, ob Situation-Detector erfolgreich war
  if (!situationResult.success && situationResult.detectedSituations.length === 0) {
    console.warn('⚠️ Situation Detector fehlgeschlagen - verwende minimale Situationen');
  }

  // 🚨 FIX: Learning-Context-Builder NUR EINMAL mit korrekten Situationen (für Training-Selector)
  const learningContextResultFinal = await agentLearningContextBuilder(customerMessage, situationResult.detectedSituations || []);

    // 🧠 NEU: Learning Integrator - reichert während Pipeline mit Learning-Wissen an
    const learningIntegratorResult = await agentLearningIntegrator(
      situationResult.detectedSituations || [],
      customerMessage,
      sharedKB
    );
    
    // 🧠🧠🧠 NEU: Deep Learning Agent - extrahiert intelligente Muster und Prinzipien
    // 🤖 WICHTIG: Nur bei Nicht-ASA-Fällen (ASA-Flow darf nicht beschädigt werden!)
    // Non-blocking: Deep Learning sollte Pipeline nicht blockieren
    let deepLearningResult = null;
    if (!isASA) {
      // Lade Feedback-Daten, falls nicht vorhanden
      let feedbackDataForDeepLearning = feedbackData;
      if (!feedbackDataForDeepLearning) {
        try {
          const { getFeedbackDataForLearning } = require('./learning-system');
          feedbackDataForDeepLearning = await getFeedbackDataForLearning();
        } catch (err) {
          console.warn('⚠️ Konnte Feedback-Daten für Deep Learning nicht laden:', err.message);
        }
      }
      
      if (trainingData && feedbackDataForDeepLearning) {
        deepLearningResult = await Promise.race([
          agentDeepLearning(
            customerMessage,
            situationResult.detectedSituations || [],
            trainingData,
            feedbackDataForDeepLearning
          ),
          new Promise((resolve) => setTimeout(() => {
            console.warn('⚠️ Deep Learning Agent - Timeout erreicht (nicht kritisch)');
            resolve({ deepContext: '', success: false });
          }, 12000)) // 12 Sekunden Timeout
        ]);
        
        // Schreibe Deep Learning Erkenntnisse in Shared Knowledge Base
        if (deepLearningResult && deepLearningResult.success && deepLearningResult.deepContext) {
          sharedKB.writeAgentInsights('deepLearning',
            ['Intelligente Muster und Prinzipien extrahiert'],
            ['Nutze diese Deep Learning Prinzipien für bessere Antworten'],
            deepLearningResult
          );
          console.log('✅ Deep Learning Agent: Intelligente Muster extrahiert');
        }
      } else {
        console.log('ℹ️ Deep Learning Agent übersprungen (keine Training/Feedback-Daten)');
      }
    } else {
      console.log('ℹ️ Deep Learning Agent übersprungen (ASA-Modus)');
    }

  // Schritt 5: Multi-Situation-Handler (analysiert mehrere Situationen)
  const multiSituationResult = await agentMultiSituationHandler(
    situationResult.detectedSituations || [],
    customerMessage,
    allRules,
    conversationHistory
  );

  // Schritt 6: Conversation-Context-Builder, Context-Connection-Analyzer & First-Message-Detector (können parallel)
  // 🛡️ NEU: First-Message-Detector mit Fallback (wichtig für erste Nachrichten)
  const [conversationContextResult, contextConnectionResult, firstMessageResult] = await Promise.all([
    agentConversationContextBuilder(conversationHistory),
    agentContextConnectionAnalyzer(conversationHistory, customerMessage, moderatorMessages || [], customerMessages || [], profileInfo),
    runAgentWithFallback(
      agentFirstMessageDetector,
      'First Message Detector',
      { isFirstMessage: false, hasLike: false, success: false },
      8000,
      conversationHistory, customerMessage, allMessages || []
    )
  ]);

  // Schritt 7: Training & Style (benötigen Kontext, aber können parallel)
  // 🤖 ASA-UNTERSTÜTZUNG: Übergebe isASA und asaConversationContext an Training-Selector
  // Training-Selector benötigt jetzt auch Learning-Context (mit korrekten Situationen)
  // 🛡️ NEU: Training-Selector mit Fallback (kritisch!)
  const [trainingResult, styleResult] = await Promise.all([
    runAgentWithFallback(
      agentTrainingSelector,
      'Training Selector',
      { selectedExamples: [], bestVectorSimilarity: 0, success: false },
      20000,
      contextResult, customerMessage, situationResult.detectedSituations || [], vectorDbFunc, isASA, asaConversationContext, trainingData, learningContextResultFinal
    ),
    agentStyleAnalyst(moderatorMessages, customerMessages, contextResult, analyzeWritingStyleFunc, isInfoMessageFunc)
  ]);
  
  // 🛡️ NEU: Prüfe, ob Training-Selector erfolgreich war
  if (!trainingResult.success || !trainingResult.selectedExamples || trainingResult.selectedExamples.length === 0) {
    console.warn('⚠️ Training Selector fehlgeschlagen oder keine Beispiele gefunden - verwende Fallback-Mode');
  }

  // 🧠 Schreibe Training-Erkenntnisse in Shared Knowledge Base
  if (trainingResult.selectedExamples && trainingResult.selectedExamples.length > 0) {
    sharedKB.writeAgentInsights('trainingSelector',
      [`${trainingResult.selectedExamples.length} relevante Training-Beispiele gefunden`],
      [`Nutze diese ${trainingResult.selectedExamples.length} Beispiele als Inspiration`],
      { selectedExamples: trainingResult.selectedExamples.slice(0, 5) }
    );
  }

  // 🧠 Schreibe Style-Erkenntnisse in Shared Knowledge Base
  if (styleResult.styleContext) {
    sharedKB.writeAgentInsights('styleAnalyst',
      ['Schreibstil analysiert'],
      ['Orientiere dich am erkannten Schreibstil'],
      styleResult
    );
  }

  // Schritt 7.5: 🚀 NEUE INTELLIGENTE AGENTS
  // Prüfe, ob es eine Treffen-Anfrage ist (für neue Agents)
  const isCustomerMeetingRequestForAgents = isMeetingRequestFunc && typeof isMeetingRequestFunc === 'function' ? isMeetingRequestFunc(customerMessage, '') : false;
  
  // Example Intelligence Agent (allgemein) - findet beste Beispiele und erstellt Guidance
  // 🚨 NEU: Übergebe auch extractedUserInfo für Kontext-Muster-Analyse (Vorlieben, Hobbies, etc.)
  const exampleIntelligenceResult = await agentExampleIntelligence(
    customerMessage,
    conversationHistory,
    trainingData,
    situationResult.detectedSituations || [],
    vectorDbFunc,
    learningContextResultFinal,
    extractedUserInfo // 🚨 NEU: Profil-Info für Kontext-Muster-Analyse
  );

  // Meeting Response Agent (spezialisiert) - nur bei Treffen-Anfragen
  const meetingResponseResult = isCustomerMeetingRequestForAgents ? await agentMeetingResponse(
    customerMessage,
    conversationHistory,
    trainingData,
    isMeetingRequestFunc,
    vectorDbFunc
  ) : {
    meetingExamples: [],
    responseGuidance: '',
    allowedPhrases: [],
    blockedPhrases: [],
    isMeetingRequest: false,
    success: false
  };

  // Rule Interpreter Agent - löst Widersprüche zwischen Regeln und Beispielen
  // 🚨 OPTIMIERUNG: Non-blocking mit Promise.race - Timeout nicht kritisch, Pipeline soll nicht blockieren
  const ruleInterpreterPromise = agentRuleInterpreter(
    allRules,
    exampleIntelligenceResult.bestExamples || trainingResult.selectedExamples || [],
    situationResult.detectedSituations || []
  );
  
  // Max 6 Sekunden warten (5s Agent-Timeout + 1s Buffer), dann Fallback
  const ruleInterpreterResult = await Promise.race([
    ruleInterpreterPromise,
    new Promise((resolve) => setTimeout(() => {
      console.warn('⚠️ Rule Interpreter - Pipeline-Time-Limit erreicht, verwende Fallback');
      resolve({
        hasConflict: false,
        conflictDescription: '',
        priority: 'examples',
        guidance: 'Training-Daten haben höchste Priorität. Orientiere dich an den Beispielen.',
        resolvedRules: allRules,
        success: false
      });
    }, 6000))
  ]);

  // 🧠 Schreibe Rule Interpreter Erkenntnisse in Shared Knowledge Base
  if (ruleInterpreterResult.hasConflict) {
    sharedKB.addPriorityGuidance(
      ruleInterpreterResult.guidance || ruleInterpreterResult.conflictDescription,
      'high',
      'ruleInterpreter'
    );
  }

  // 🧠 Schreibe Example Intelligence Erkenntnisse in Shared Knowledge Base
  if (exampleIntelligenceResult.success && exampleIntelligenceResult.bestExamples) {
    sharedKB.writeAgentInsights('exampleIntelligence',
      exampleIntelligenceResult.structureGuidance ? ['Struktur-Guidance erstellt'] : [],
      [
        exampleIntelligenceResult.structureGuidance || '',
        exampleIntelligenceResult.wordChoiceGuidance || '',
        exampleIntelligenceResult.questionGuidance || ''
      ].filter(g => g.length > 0),
      exampleIntelligenceResult
    );
  }

  // 🧠 Schreibe Meeting Response Erkenntnisse in Shared Knowledge Base
  if (meetingResponseResult.success && meetingResponseResult.isMeetingRequest) {
    sharedKB.addPriorityGuidance(
      meetingResponseResult.responseGuidance || 'Treffen-Anfrage erkannt - keine Treffen ausmachen!',
      'high',
      'meetingResponse'
    );
    if (meetingResponseResult.allowedPhrases && meetingResponseResult.allowedPhrases.length > 0) {
      sharedKB.writeAgentInsights('meetingResponse',
        ['Treffen-Anfrage erkannt'],
        [`Erlaubte Phrasen: ${meetingResponseResult.allowedPhrases.join(', ')}`],
        meetingResponseResult
      );
    }
  }

  // Schritt 6: Proactive-Analyst entfernt (nicht kritisch, verursachte mehr Probleme als Nutzen)
  // Fallback für Kompatibilität
  const proactiveResult = {
    isStagnant: false,
    suggestions: [],
    success: false
  };
  
  // Mood-Analyst entfernt - Fallback für Kompatibilität
  const moodResult = {
    mood: 'neutral',
    confidence: 0,
    instructions: '',
    success: false
  };

  // Schritt 7: Image (optional, kann parallel zu Schritt 6)
  const imageResult = await agentImageAnalyst(imageUrl, contextResult, imageAnalysisFunc);

  // Schritt 8: Rules-Applicator (NACH Situation-Detector, damit alle Situationen bekannt sind)
  // Prüfe auf Wissensfragen (wird im Situation-Detector erkannt, aber hier nochmal geprüft)
  const lowerMessage = (customerMessage || "").toLowerCase();
  const knowledgeQuestionPatterns = [
    /erzähl.*(mir|du).*(was|etwas).*(über|von)/i,
    /was.*(ist|sind|bedeutet).*(die|der|das|die menschheit|amerika|flugzeug|waschmaschine|ameisen)/i,
    /wie.*(funktioniert|denken|arbeiten).*(flugzeug|waschmaschine|motor|computer|ameisen|gehirn|tiere)/i
  ];
  const isKnowledgeQuestion = knowledgeQuestionPatterns.some(pattern => pattern.test(lowerMessage));
  
  // 🚨 KRITISCH: Prüfe auch direkt auf Treffen-Anfragen (nicht nur über Situation-Detector)
  // Die Kunden-Nachricht könnte eine Treffen-Anfrage sein, auch wenn sie nicht direkt "treffen" enthält
  // ABER: Situation-Detector hat bereits Kontext aus letzten Nachrichten geprüft!
  let isCustomerMeetingRequest = situationResult.isCustomerMeetingRequest || situationResult.hasMeetingContext || false;
  if (isMeetingRequestFunc && typeof isMeetingRequestFunc === 'function') {
    const directCheck = isMeetingRequestFunc(customerMessage, "");
    if (directCheck) {
      if (!isCustomerMeetingRequest) {
        isCustomerMeetingRequest = true;
        console.log('🚨 KRITISCH: Treffen-Anfrage direkt erkannt in Kunden-Nachricht!');
      }
    }
  }
  
  // 🚨 KRITISCH: Wenn hasMeetingContext true ist, logge es für Debugging
  if (situationResult.hasMeetingContext) {
    console.log('🚨 KRITISCH: Treffen-Kontext aus letzten Nachrichten erkannt!');
  }
  
  // 🚨 WICHTIG: Rules-Applicator wird NACH Situation-Detector aufgerufen, damit alle Situationen bekannt sind
  const rulesResult = await agentRulesApplicator(
    allRules, 
    contextResult, 
    situationResult.detectedSituations || [],
    isCustomerMeetingRequest,
    isKnowledgeQuestion
  );

  // 🧠 NEU: Knowledge Synthesizer - synthetisiert ALLES nach der Pipeline
  const knowledgeSynthesizerResult = await agentKnowledgeSynthesizer(
    {
      context: contextResult,
      profile: profileResult,
      rules: rulesResult,
      training: trainingResult,
      flowAnalysis: flowAnalysisResult,
      ambiguity: ambiguityResult,
      style: styleResult,
      situation: situationResult,
      exampleIntelligence: exampleIntelligenceResult,
      meetingResponse: meetingResponseResult,
      ruleInterpreter: ruleInterpreterResult,
      deepLearning: deepLearningResult // 🧠🧠🧠 NEU: Deep Learning für Synthese
    },
    customerMessage,
    sharedKB
  );

  const results = {
    safety: { isBlocked: false, reason: null, errorMessage: null },
    context: contextResult,
    profile: profileResult,
    rules: rulesResult, // 🚨 FIX: Verwende rulesResult statt rulesResultExtended
    training: trainingResult,
    style: styleResult,
    mood: moodResult,
    proactive: proactiveResult,
    image: imageResult,
    situation: situationResult,
    multiSituation: multiSituationResult,
    fakeContext: fakeContextResult,
    conversationContext: conversationContextResult,
    learning: learningContextResultFinal,
    firstMessage: firstMessageResult, // 🚨 NEU: First-Message-Detector Ergebnis
    // 🚀 NEUE INTELLIGENTE AGENTS
    exampleIntelligence: exampleIntelligenceResult,
    meetingResponse: meetingResponseResult,
    ruleInterpreter: ruleInterpreterResult,
    // 🧠 NEU: Knowledge Ecosystem
    learningIntegrator: learningIntegratorResult,
    flowAnalysis: flowAnalysisResult,
    knowledgeSynthesizer: knowledgeSynthesizerResult,
    deepLearning: deepLearningResult, // 🧠🧠🧠 NEU: Deep Learning Ergebnisse
    sharedKnowledgeBase: sharedKB, // Zugriff auf die komplette Knowledge Base
    blocked: false
  };

  console.log('✅ Multi-Agent Pipeline abgeschlossen');
  return results;
}

/**
 * 🚨 NEU: QUALITY SCORING & VALIDATION SYSTEM
 * Prüft, ob alle Informationen genutzt wurden und Nachricht qualitativ hochwertig ist
 */
/**
 * 🎨 Stil-Merkmale aus Training-Daten extrahieren
 * Analysiert Satzbau, Interpunktion, Ton, Wortwahl-Level
 */
function extractStyleFeatures(examples) {
  if (!examples || examples.length === 0) return null;
  
  const features = {
    avgSentenceLength: [],
    sentenceCounts: [],
    punctuationPatterns: {
      commas: 0,
      questionMarks: 0,
      periods: 0,
      exclamationMarks: 0
    },
    sentenceStarts: [],
    transitions: [],
    formalityLevel: [],
    directnessLevel: []
  };
  
  examples.slice(0, 5).forEach(ex => {
    const text = (ex.moderatorResponse || ex.assistant || '').trim();
    if (text.length < 10) return;
    
    // Satzlängen (in Wörtern)
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    sentences.forEach(s => {
      const words = s.trim().split(/\s+/).length;
      features.avgSentenceLength.push(words);
    });
    
    // Satz-Anzahl
    features.sentenceCounts.push(sentences.length);
    
    // Interpunktion
    features.punctuationPatterns.commas += (text.match(/,/g) || []).length;
    features.punctuationPatterns.questionMarks += (text.match(/\?/g) || []).length;
    features.punctuationPatterns.periods += (text.match(/\./g) || []).length;
    features.punctuationPatterns.exclamationMarks += (text.match(/!/g) || []).length;
    
    // Satz-Anfänge (erste 2-3 Wörter jedes Satzes)
    sentences.forEach(s => {
      const words = s.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ');
      if (words.length > 3) {
        features.sentenceStarts.push(words);
      }
    });
    
    // Übergänge/Wende-Wörter
    const transitionWords = ['aber', 'aber', 'und', 'oder', 'dann', 'wenn', 'weil', 'obwohl', 'jedoch', 'dennoch', 'also', 'deshalb', 'trotzdem'];
    transitionWords.forEach(word => {
      if (text.toLowerCase().includes(word)) {
        features.transitions.push(word);
      }
    });
    
    // Formality-Level (Einschätzung basierend auf Wortwahl)
    const formalIndicators = ['gerne', 'möchte', 'würde', 'könnte', 'dürfte', 'wäre'];
    const informalIndicators = ['mag', 'will', 'kann', 'ist', 'bin', 'hab', 'geil', 'super', 'cool'];
    const formalCount = formalIndicators.filter(word => text.toLowerCase().includes(word)).length;
    const informalCount = informalIndicators.filter(word => text.toLowerCase().includes(word)).length;
    features.formalityLevel.push(formalCount > informalCount ? 'formal' : 'informal');
    
    // Directness-Level (Einschätzung basierend auf Direktheit)
    const directIndicators = ['ich', 'du', 'wir', 'mag', 'will', 'geil', 'hab', 'bin'];
    const indirectIndicators = ['könnte', 'würde', 'dürfte', 'vielleicht', 'eventuell', 'möglich'];
    const directCount = directIndicators.filter(word => text.toLowerCase().includes(word)).length;
    const indirectCount = indirectIndicators.filter(word => text.toLowerCase().includes(word)).length;
    features.directnessLevel.push(directCount > indirectCount ? 'direct' : 'indirect');
  });
  
  // Berechne Durchschnitte/Patterns
  return {
    avgSentenceLength: features.avgSentenceLength.length > 0 
      ? features.avgSentenceLength.reduce((a, b) => a + b, 0) / features.avgSentenceLength.length 
      : 15,
    avgSentenceCount: features.sentenceCounts.length > 0
      ? features.sentenceCounts.reduce((a, b) => a + b, 0) / features.sentenceCounts.length
      : 3,
    punctuationPerChar: {
      commas: features.punctuationPatterns.commas / Math.max(1, features.avgSentenceLength.reduce((a, b) => a + b, 0)),
      questions: features.punctuationPatterns.questionMarks / Math.max(1, features.sentenceCounts.length),
      periods: features.punctuationPatterns.periods / Math.max(1, features.sentenceCounts.length),
      exclamations: features.punctuationPatterns.exclamationMarks / Math.max(1, features.sentenceCounts.length)
    },
    commonSentenceStarts: features.sentenceStarts.slice(0, 10), // Top 10
    commonTransitions: features.transitions.slice(0, 5), // Top 5
    dominantFormality: features.formalityLevel.filter(f => f === 'informal').length > features.formalityLevel.filter(f => f === 'formal').length ? 'informal' : 'formal',
    dominantDirectness: features.directnessLevel.filter(d => d === 'direct').length > features.directnessLevel.filter(d => d === 'indirect').length ? 'direct' : 'indirect'
  };
}

/**
 * 🎨 Stil einer Nachricht mit Training-Daten vergleichen
 * Gibt Score 0-100 zurück
 */
function compareStyleWithTraining(message, styleFeatures) {
  if (!styleFeatures || !message || message.trim().length < 10) return 50; // Neutral bei fehlenden Daten
  
  const messageText = message.trim();
  let score = 0;
  let checks = 0;
  
  // 1. Satzlängen-Vergleich (0-25 Punkte)
  const messageSentences = messageText.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const messageAvgLength = messageSentences.length > 0
    ? messageSentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / messageSentences.length
    : 15;
  
  const lengthDiff = Math.abs(messageAvgLength - styleFeatures.avgSentenceLength);
  const lengthScore = Math.max(0, 25 - (lengthDiff * 2)); // -2 Punkte pro Wort Unterschied
  score += lengthScore;
  checks++;
  
  // 2. Satz-Anzahl-Vergleich (0-20 Punkte)
  const messageSentenceCount = messageSentences.length;
  const sentenceCountDiff = Math.abs(messageSentenceCount - styleFeatures.avgSentenceCount);
  const sentenceCountScore = Math.max(0, 20 - (sentenceCountDiff * 5)); // -5 Punkte pro Satz Unterschied
  score += sentenceCountScore;
  checks++;
  
  // 3. Interpunktion-Vergleich (0-25 Punkte)
  const messageLength = messageText.length;
  const messagePunctuation = {
    commas: (messageText.match(/,/g) || []).length / Math.max(1, messageLength),
    questions: (messageText.match(/\?/g) || []).length / Math.max(1, messageSentenceCount),
    periods: (messageText.match(/\./g) || []).length / Math.max(1, messageSentenceCount),
    exclamations: (messageText.match(/!/g) || []).length / Math.max(1, messageSentenceCount)
  };
  
  const punctDiff = 
    Math.abs(messagePunctuation.commas - styleFeatures.punctuationPerChar.commas) * 100 +
    Math.abs(messagePunctuation.questions - styleFeatures.punctuationPerChar.questions) * 50 +
    Math.abs(messagePunctuation.periods - styleFeatures.punctuationPerChar.periods) * 50;
  
  const punctScore = Math.max(0, 25 - punctDiff);
  score += punctScore;
  checks++;
  
  // 4. Satz-Anfänge-Vergleich (0-15 Punkte)
  const messageStarts = messageSentences.map(s => 
    s.trim().toLowerCase().split(/\s+/).slice(0, 3).join(' ')
  ).filter(s => s.length > 3);
  
  const matchingStarts = messageStarts.filter(start => 
    styleFeatures.commonSentenceStarts.some(commonStart => 
      start.includes(commonStart) || commonStart.includes(start)
    )
  ).length;
  
  const startsScore = messageStarts.length > 0 
    ? (matchingStarts / messageStarts.length) * 15 
    : 7.5; // Neutral wenn keine Starts
  score += startsScore;
  checks++;
  
  // 5. Formality-Level-Vergleich (0-10 Punkte)
  const formalIndicators = ['gerne', 'möchte', 'würde', 'könnte', 'dürfte', 'wäre'];
  const informalIndicators = ['mag', 'will', 'kann', 'ist', 'bin', 'hab', 'geil', 'super', 'cool'];
  const messageLower = messageText.toLowerCase();
  const messageFormalCount = formalIndicators.filter(word => messageLower.includes(word)).length;
  const messageInformalCount = informalIndicators.filter(word => messageLower.includes(word)).length;
  const messageFormality = messageFormalCount > messageInformalCount ? 'formal' : 'informal';
  
  const formalityScore = messageFormality === styleFeatures.dominantFormality ? 10 : 5;
  score += formalityScore;
  checks++;
  
  // 6. Directness-Level-Vergleich (0-5 Punkte)
  const directIndicators = ['ich', 'du', 'wir', 'mag', 'will', 'geil', 'hab', 'bin'];
  const indirectIndicators = ['könnte', 'würde', 'dürfte', 'vielleicht', 'eventuell', 'möglich'];
  const messageDirectCount = directIndicators.filter(word => messageLower.includes(word)).length;
  const messageIndirectCount = indirectIndicators.filter(word => messageLower.includes(word)).length;
  const messageDirectness = messageDirectCount > messageIndirectCount ? 'direct' : 'indirect';
  
  const directnessScore = messageDirectness === styleFeatures.dominantDirectness ? 5 : 2.5;
  score += directnessScore;
  checks++;
  
  return Math.round(Math.max(0, Math.min(100, score)));
}

async function validateMessageQuality(message, {
  multiAgentResults,
  training,
  context,
  conversationHistory,
  customerMessage,
  allRules,
  situation
}) {
  const scores = {
    trainingDataUsage: 0,
    contextUsage: 0,
    rulesCompliance: 0,
    learningSystemUsage: 0,
    semanticValidation: 0,
    styleScore: 0 // 🎨 NEU: Stil-Score
  };

  // 🚨🚨🚨 NEU: Training-Daten-Nutzung prüfen (0-25%) + Formulierungs-Check
  // WICHTIG: Nur wenn Training-Daten vorhanden sind UND nicht im Fallback-Modus
  const shouldUseFallbackMode = multiAgentResults?.shouldUseFallbackMode || false;
  const hasTrainingData = training?.selectedExamples && training.selectedExamples.length > 0;
  
  if (hasTrainingData && !shouldUseFallbackMode) {
    try {
      const messageEmbedding = await getEmbedding(message);
      if (messageEmbedding) {
        // Vergleiche mit Training-Daten-Beispielen (Embedding-Similarity)
        const trainingEmbeddings = await Promise.all(
          training.selectedExamples.slice(0, 5).map(ex => 
            getEmbedding(ex.moderatorResponse || ex.assistant || '')
          )
        );

        const similarities = trainingEmbeddings
          .filter(e => e !== null)
          .map(e => cosineSimilarity(messageEmbedding, e));

        if (similarities.length > 0) {
          const maxSimilarity = Math.max(...similarities);
          const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
          // Score: 0-25% basierend auf Ähnlichkeit (70% = 25 Punkte, 50% = 15 Punkte, etc.)
          scores.trainingDataUsage = Math.min(25, Math.max(0, (maxSimilarity * 25) + (avgSimilarity * 10)));
          
          // 🚨🚨🚨 NEU: Formulierungs-Check - prüfe ob Training-Daten-Phrasen verwendet wurden
          // Extrahiere häufige Phrasen aus Top-3 Training-Daten-Beispielen
          const topExamples = training.selectedExamples.slice(0, 3);
          const commonPhrases = [];
          
          topExamples.forEach(ex => {
            const response = (ex.moderatorResponse || ex.assistant || '').toLowerCase();
            // Extrahiere Fragen (wichtig für Formulierungen)
            const questions = response.match(/[^.!?]*\?/g) || [];
            questions.forEach(q => {
              const cleanQ = q.trim().toLowerCase();
              if (cleanQ.length > 10 && cleanQ.length < 100) {
                commonPhrases.push(cleanQ);
              }
            });
            
            // Extrahiere häufige Formulierungen (Phrasen mit 3+ Wörtern)
            const words = response.split(/\s+/);
            for (let i = 0; i < words.length - 2; i++) {
              const phrase = words.slice(i, i + 3).join(' ').toLowerCase();
              if (phrase.length > 10 && phrase.length < 80) {
                commonPhrases.push(phrase);
              }
            }
          });
          
          // Prüfe ob generierte Nachricht diese Phrasen verwendet
          const messageLower = message.toLowerCase();
          const usedPhrases = commonPhrases.filter(phrase => messageLower.includes(phrase));
          const phraseUsageRatio = commonPhrases.length > 0 ? usedPhrases.length / Math.min(commonPhrases.length, 10) : 0;
          
          // Bonus für Training-Daten-Phrasen-Nutzung (max +5 Punkte)
          if (phraseUsageRatio > 0.3) {
            scores.trainingDataUsage = Math.min(25, scores.trainingDataUsage + 5);
            console.log(`✅ Training-Daten-Formulierungen verwendet: ${usedPhrases.length}/${commonPhrases.length} Phrasen`);
          } else if (maxSimilarity < 0.55) {
            // Warnung: Niedrige Similarity UND keine Training-Daten-Phrasen
            console.warn(`⚠️ Niedrige Training-Daten-Ähnlichkeit (${(maxSimilarity * 100).toFixed(1)}%) und keine Training-Daten-Formulierungen verwendet`);
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler bei Training-Daten-Validierung:', err.message);
    }
  } else {
    // Keine Training-Daten vorhanden ODER Fallback-Modus → KEINE Validierung
    scores.trainingDataUsage = 25; // Volle Punkte, da nichts zu prüfen
    if (shouldUseFallbackMode) {
      console.log('ℹ️ Training-Daten-Validierung übersprungen (Fallback-Modus aktiv)');
    } else if (!hasTrainingData) {
      console.log('ℹ️ Training-Daten-Validierung übersprungen (keine Training-Daten vorhanden)');
    }
  }

  // 🎨🎨🎨 NEU: Stil-Validierung (0-100%)
  // Prüft Satzbau, Interpunktion, Ton gegen Training-Daten
  if (hasTrainingData && !shouldUseFallbackMode) {
    try {
      const styleFeatures = extractStyleFeatures(training.selectedExamples);
      if (styleFeatures) {
        const styleScore = compareStyleWithTraining(message, styleFeatures);
        scores.styleScore = styleScore;
        console.log(`🎨 Stil-Score: ${styleScore}% (Satzlänge: ${styleFeatures.avgSentenceLength.toFixed(1)}, Formality: ${styleFeatures.dominantFormality}, Directness: ${styleFeatures.dominantDirectness})`);
      } else {
        scores.styleScore = 50; // Neutral wenn keine Features extrahiert werden können
      }
    } catch (err) {
      console.warn('⚠️ Fehler bei Stil-Validierung:', err.message);
      scores.styleScore = 50; // Fallback: Neutral
    }
  } else {
    scores.styleScore = 50; // Neutral wenn keine Training-Daten vorhanden oder Fallback-Modus
  }

  // 2. Kontext-Nutzung prüfen (0-25%)
  if (conversationHistory && conversationHistory.length > 50) {
    // Prüfe, ob Nachricht Referenzen zum Gesprächsverlauf enthält
    const contextKeywords = extractKeywords(conversationHistory.toLowerCase());
    const messageLower = message.toLowerCase();
    
    // Zähle, wie viele Kontext-Keywords in der Nachricht vorkommen
    const contextMatches = contextKeywords.filter(keyword => 
      messageLower.includes(keyword)
    ).length;

    // Score: 0-25% basierend auf Kontext-Referenzen
    const contextMatchRatio = contextMatches / Math.max(1, contextKeywords.length);
    scores.contextUsage = Math.min(25, contextMatchRatio * 25);
  } else {
    // Wenn kein Kontext vorhanden, gibt es keine Referenzen zu prüfen
    scores.contextUsage = 25; // Volle Punkte, da nichts zu prüfen
  }

  // 3. Regeln-Befolgung prüfen (0-25%)
  let rulesScore = 25; // Start mit vollem Score, reduziere bei Verstößen
  
  // Prüfe verbotene Wörter
  if (allRules?.forbiddenWords && allRules.forbiddenWords.length > 0) {
    const messageLower = message.toLowerCase();
    const violations = allRules.forbiddenWords.filter(word => 
      messageLower.includes(word.toLowerCase())
    );
    if (violations.length > 0) {
      rulesScore -= violations.length * 5; // -5 Punkte pro Verstoß
    }
  }

  // 🚨 KRITISCH: Prüfe auf Meta-Kommentare (stark bestrafen)
  // ✅ ERLAUBT: "Klingt geil", "Das klingt nach...", "Ich finde das geil" - Reaktion auf INHALT
  // ❌ VERBOTEN: "Ich finde es toll, dass...", "Ich finde es schon mal gut, dass..." - Kommentar über NACHRICHT
  const metaCommentPatterns = [
    /ich finde es (toll|gut|schön|schon mal gut|interessant|spannend),?\s+(dass|wie|wenn)/i,
    /ich finde es (toll|gut|schön|schon mal gut|interessant|spannend)\s+(du|ihr|der|die|das)/i,
    /ich kann mir vorstellen,?\s+(dass|wie|wenn)/i,
    /das ist (toll|gut|schön|interessant|spannend),?\s+(dass|wie|wenn)/i,
    /wie (toll|gut|schön|interessant|spannend),?\s+(dass|wie|wenn)/i
  ];
  const hasMetaComment = metaCommentPatterns.some(pattern => pattern.test(message));
  if (hasMetaComment) {
    rulesScore -= 15; // -15 Punkte für Meta-Kommentare (stark bestrafen)
    console.warn('⚠️ Meta-Kommentar in Quality Score erkannt - stark bestraft');
  }

  // Prüfe bevorzugte Wörter (Bonus, aber nicht kritisch)
  if (allRules?.preferredWords && allRules.preferredWords.length > 0) {
    const messageLower = message.toLowerCase();
    const usedPreferred = allRules.preferredWords.filter(word =>
      messageLower.includes(word.toLowerCase())
    ).length;
    // Bonus: +1 Punkt pro bevorzugtem Wort (max +5)
    rulesScore += Math.min(5, usedPreferred);
  }

  scores.rulesCompliance = Math.max(0, Math.min(25, rulesScore));

  // 4. Learning-System-Nutzung prüfen (0-25%)
  try {
    const { getLearningStats } = require('../utils/learning-system');
    const learningStats = await getLearningStats();
    
    if (learningStats?.responsePatterns && learningStats.responsePatterns.length > 0) {
      const messageEmbedding = await getEmbedding(message);
      if (messageEmbedding) {
        // Vergleiche mit bewährten Mustern
        const patternEmbeddings = await Promise.all(
          learningStats.responsePatterns.slice(0, 5).map(p => 
            getEmbedding(p.goodResponse || '')
          )
        );

        const similarities = patternEmbeddings
          .filter(e => e !== null)
          .map(e => cosineSimilarity(messageEmbedding, e));

        if (similarities.length > 0) {
          const maxSimilarity = Math.max(...similarities);
          // Score: 0-25% basierend auf Ähnlichkeit zu bewährten Mustern
          scores.learningSystemUsage = Math.min(25, Math.max(0, maxSimilarity * 25));
        }
      }
    } else {
      // Keine Learning-System-Daten vorhanden
      scores.learningSystemUsage = 25; // Volle Punkte, da nichts zu prüfen
    }
  } catch (err) {
    console.warn('⚠️ Fehler bei Learning-System-Validierung:', err.message);
    scores.learningSystemUsage = 25; // Fallback: Volle Punkte
  }

  // 🚨 NEU: Semantische Validierung (0-25%)
  // 🚨 FIX: Zusätzlicher Timeout-Wrapper, damit es die Antwort nicht blockiert
  // 🚨 NEU: Prüfe, ob es ein sexuelles Gespräch ist
  const hasSexualContent = situation?.hasSexualContent || 
    context?.topic === 'sexuell' || 
    (situation?.detectedSituations && situation.detectedSituations.some(s => s.includes('Sexuell'))) ||
    false;
  
  let semanticScore = 25; // Start mit vollem Score, reduziere bei Problemen
  try {
    semanticScore = await Promise.race([
      validateSemanticQuality(message, customerMessage, conversationHistory, hasSexualContent),
      new Promise((resolve) => setTimeout(() => {
        console.warn('⚠️ Semantische Validierung: Timeout nach 3 Sekunden - verwende Fallback');
        resolve(25); // Fallback: Volle Punkte
      }, 3000))
    ]);
    scores.semanticValidation = semanticScore;
  } catch (err) {
    console.warn('⚠️ Fehler bei semantischer Validierung:', err.message || err);
    scores.semanticValidation = 25; // Fallback: Volle Punkte
  }

  // Gesamt-Score berechnen (altes System)
  const oldOverallScore = Math.round(
    scores.trainingDataUsage +
    scores.contextUsage +
    scores.rulesCompliance +
    scores.learningSystemUsage +
    scores.semanticValidation
  );

  // 🚨 NEU: ML-Quality-Score (parallel, als zusätzliche Metrik)
  let mlScore = null;
  let finalScore = oldOverallScore;
  
  try {
    const { predictQualityWithML, combineScores } = require('./ml-quality-predictor');
    
    // ML-Score berechnen (parallel, blockiert nicht)
    const mlContext = {
      situation: situation || 'allgemein',
      trainingExamplesCount: training?.selectedExamples?.length || 0,
      learningPatternsCount: (await require('../utils/learning-system').getLearningStats())?.responsePatterns?.length || 0
    };
    
    mlScore = await predictQualityWithML(message, mlContext);
    
    // Kombiniere beide Scores (ML-Weight: 0.5 = 50% ML, 50% Alt)
    // 🚨 WICHTIG: ML wird nur verwendet, wenn Confidence >= 0.5
    const ML_WEIGHT = parseFloat(process.env.ML_QUALITY_WEIGHT || '0.5'); // Standard: 50% ML
    finalScore = combineScores(oldOverallScore, mlScore, ML_WEIGHT);
    
    console.log(`📊 Quality-Score: Alt=${oldOverallScore}%, ML=${mlScore.score}% (Confidence: ${(mlScore.confidence * 100).toFixed(0)}%), Final=${finalScore}%`);
  } catch (err) {
    console.warn('⚠️ ML-Quality-Score fehlgeschlagen, nutze altes System:', err.message);
    // Fallback: Nutze alten Score
    finalScore = oldOverallScore;
  }

  return {
    overallScore: finalScore,
    oldScore: oldOverallScore, // 🚨 NEU: Alte Score für Vergleich
    mlScore: mlScore ? {
      score: mlScore.score,
      confidence: mlScore.confidence,
      reasoning: mlScore.reasoning
    } : null, // 🚨 NEU: ML-Score für Vergleich
    scores,
    details: {
      trainingDataUsage: `${scores.trainingDataUsage.toFixed(1)}%`,
      contextUsage: `${scores.contextUsage.toFixed(1)}%`,
      rulesCompliance: `${scores.rulesCompliance.toFixed(1)}%`,
      learningSystemUsage: `${scores.learningSystemUsage.toFixed(1)}%`,
      semanticValidation: `${scores.semanticValidation.toFixed(1)}%`,
      mlScore: mlScore ? `${mlScore.score}% (Confidence: ${(mlScore.confidence * 100).toFixed(0)}%)` : 'N/A'
    }
  };
}

/**
 * 🚨 NEU: Semantische Validierung
 * Prüft, ob die Antwort logisch/semantisch korrekt ist
 */
async function validateSemanticQuality(message, customerMessage, conversationHistory, hasSexualContent = false) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Semantische Validierung: Fallback');
    return 25; // Fallback: Volle Punkte
  }

  try {
      // 🚨 NEU: Prüfe, ob es ein sexuelles Gespräch ist
      const isSexualConversation = hasSexualContent || 
        (customerMessage && (
          customerMessage.toLowerCase().includes('sex') || 
          customerMessage.toLowerCase().includes('geil') || 
          customerMessage.toLowerCase().includes('ficken') ||
          customerMessage.toLowerCase().includes('sperma') ||
          customerMessage.toLowerCase().includes('muschi') ||
          customerMessage.toLowerCase().includes('höhepunkt')
        ));
      
      // 🚨 NEU: Prüfe, ob es wirklich eine Treffen-Anfrage ist (nicht nur "woher bist du")
      const isRealMeetingRequest = customerMessage && (
        customerMessage.toLowerCase().includes('treffen') ||
        customerMessage.toLowerCase().includes('kennenlernen') ||
        customerMessage.toLowerCase().includes('sehen') ||
        customerMessage.toLowerCase().includes('wann können wir') ||
        customerMessage.toLowerCase().includes('kannst du vorbeikommen') ||
        customerMessage.toLowerCase().includes('kann ich zu dir kommen')
      ) && !/^(woher|wo kommst|wo wohnst)/i.test(customerMessage.trim());

    const validationPrompt = `Prüfe diese Chat-Antwort auf semantische/logische Korrektheit und ANGEMESSENHEIT.

Kundennachricht: "${customerMessage.substring(0, 500)}"
${isSexualConversation ? '\n🚨 WICHTIG: Dies ist ein SEXUELLES Gespräch - direkte sexuelle Antworten sind ERLAUBT und ERWÜNSCHT!' : ''}
${isRealMeetingRequest ? '\n🚨 WICHTIG: Dies ist eine TREFFEN-ANFRAGE - die Antwort sollte höflich ausweichen, NICHT zustimmen!' : ''}
${!isRealMeetingRequest && (customerMessage && /^(woher|wo kommst|wo wohnst)/i.test(customerMessage.trim())) ? '\n🚨 WICHTIG: Dies ist KEINE Treffen-Anfrage! Der Kunde fragt nur nach dem Wohnort ("woher bist du"). Erwarte KEINE Treffen-Einladung in der Antwort!' : ''}

KI-Antwort: "${message}"

Prüfe folgendes:
1. **Logische Konsistenz**: Macht die Antwort Sinn? Gibt es widersprüchliche oder unsinnige Kombinationen?
   - Beispiel FALSCH: "Lieblingsbelag für einen Salat" (Salat hat keinen Belag, das passt nicht zusammen)
   - Beispiel RICHTIG: "Lieblingsdressing für einen Salat" (passt zusammen)
   
2. **Semantische Relevanz**: Passt die Antwort zum Kontext der Kundennachricht?
   - Antwort sollte auf das eingehen, was der Kunde geschrieben hat
   - Antwort sollte thematisch passen
   ${!isRealMeetingRequest && (customerMessage && /^(woher|wo kommst|wo wohnst)/i.test(customerMessage.trim())) ? 
     '- 🚨 WICHTIG: Bei "woher bist du" Frage sollte die Antwort NICHT eine Treffen-Einladung enthalten! Antworte einfach auf die Wohnort-Frage!' : ''}

3. **Sinnvolle Fragen**: Wenn Fragen gestellt werden, sind sie logisch und passen zum Kontext?
   - Beispiel FALSCH: Kunde schreibt über Essen → Frage über "Lieblingsbelag für Salat" (passt nicht, Salat hat keinen Belag)
   - Beispiel RICHTIG: Kunde schreibt über Essen → Frage über "Lieblingsgericht" oder "Lieblingsrestaurant" (passt)

4. **🚨 ANGEMESSENHEIT (SEHR WICHTIG!)**: Ist die Antwort angemessen?
   ${isSexualConversation ? 
     `- **BEI SEXUELLEN GESPRÄCHEN**: Direkte sexuelle Antworten sind ERLAUBT und ERWÜNSCHT!
     * ✅ RICHTIG: Direkte, sexuelle Antworten (z.B. "Oh Mann, das ist schon eine sehr intensive Vorstellung", "Das würde mich richtig geil machen")
     * ✅ RICHTIG: Reagiert auf sexuelle Inhalte der Kundennachricht
     * ❌ FALSCH: Zu zurückhaltend oder generisch bei sexuellen Themen
     * 🚨 WICHTIG: Bei sexuellen Gesprächen sind direkte Antworten GUT, nicht schlecht!` :
     `- **ZU DIREKT/AGGRESSIV (STARK BESTRAFEN - Score 0-30%)**:
     * ${isRealMeetingRequest ? 'Bei Treffen-Anfragen: Sehr direkte sexuelle Antworten (z.B. "richtig geil", "Wie würdest du mich anheizen", "Ich finde die Vorstellung richtig geil")' : 'Sehr direkte, aggressive Formulierungen'}
     * Aggressive, aufdringliche Formulierungen
   - **ANGEMESSEN SUBTIL (BELOHNEN - Score 70-100%)**:
     * ${isRealMeetingRequest ? 'Bei Treffen-Anfragen: Subtile, höfliche Antworten (z.B. "Wir schauen einfach mal wie das dann bei uns passt", "Hast du schon eine Idee was kochen würdest?")' : 'Freundliche, natürliche Antworten'}
     * Freundliche, respektvolle Formulierungen
     * Nebenthemen aufgreifen (z.B. Kunde erwähnt "kochen" → Antwort greift "kochen" auf)`}

Antworte NUR als JSON:
{
  "isValid": true/false,
  "score": 0-100 (0 = sehr schlecht, 100 = perfekt),
  "issues": ["Problem 1", "Problem 2"] (leer wenn keine Probleme),
  "reasoning": "Kurze Begründung (max 100 Zeichen)",
  "isTooDirect": true/false (wenn Antwort zu direkt/aggressiv ist),
  "isAppropriatelySubtle": true/false (wenn Antwort angemessen subtil ist)
}

WICHTIG:
${isSexualConversation ? 
  `- Bei SEXUELLEN Gesprächen: Direkte sexuelle Antworten sind GUT, nicht schlecht!
- BELOHNE direkte, sexuelle Antworten bei sexuellen Gesprächen - Score 70-100%
- Bestrafe NUR wenn Antwort zu generisch oder zurückhaltend ist bei sexuellen Themen` :
  `- Sei SEHR STRENG bei zu direkten/aggressiven Antworten (besonders bei Treffen-Anfragen) - Score 0-30%
- BELOHNE angemessen subtile Antworten (besonders wenn Nebenthemen aufgegriffen werden) - Score 70-100%`}
- Sei streng bei logischen Inkonsistenzen (z.B. "Salat" + "Belag" = falsch) - Score 0-40%
- Sei fair bei semantischer Relevanz (nicht zu streng, aber auch nicht zu lasch)
- Nur echte Probleme melden, nicht Kleinigkeiten`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du bist ein Validator für Chat-Antworten. Antworte IMMER nur als JSON.' },
          { role: 'user', content: validationPrompt }
        ],
        temperature: 0.2,
        max_tokens: 200
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Semantic validation timeout')), 3000))
    ]);

    const result = response.choices[0].message.content.trim();
    
    // Parse JSON (kann in Code-Blöcken sein)
    let jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('⚠️ Semantische Validierung: Kein JSON gefunden');
      return 25; // Fallback: Volle Punkte
    }

    const validation = JSON.parse(jsonMatch[0]);
    
    // 🚨 NEU: Verschärfte Bestrafung für zu direkte/aggressive Antworten (NUR bei NICHT-sexuellen Gesprächen)
    let adjustedScore = validation.score;
    if (validation.isTooDirect && !isSexualConversation) {
      // Zusätzliche Bestrafung: Score um 50% reduzieren (max. Score wird 30%)
      // ABER: Nur bei NICHT-sexuellen Gesprächen!
      adjustedScore = Math.max(0, validation.score - 50);
      console.warn(`⚠️ Semantische Validierung: Zu direkte/aggressive Antwort erkannt - Score von ${validation.score}% auf ${adjustedScore}% reduziert`);
    } else if (validation.isTooDirect && isSexualConversation) {
      // 🚨 NEU: Bei sexuellen Gesprächen ist "zu direkt" GUT, nicht schlecht!
      // Belohne direkte Antworten bei sexuellen Gesprächen
      adjustedScore = Math.min(100, validation.score + 20);
      console.log(`✅ Semantische Validierung: Direkte sexuelle Antwort bei sexuellem Gespräch erkannt - Score von ${validation.score}% auf ${adjustedScore}% erhöht (ist GUT bei sexuellen Gesprächen!)`);
    } else if (validation.isAppropriatelySubtle) {
      // Belohnung: Score um 10% erhöhen (max. Score wird 100%)
      adjustedScore = Math.min(100, validation.score + 10);
      console.log(`✅ Semantische Validierung: Angemessen subtile Antwort erkannt - Score von ${validation.score}% auf ${adjustedScore}% erhöht`);
    }
    
    if (!validation.isValid || adjustedScore < 50) {
      console.warn(`⚠️ Semantische Validierung: Probleme erkannt (Score: ${adjustedScore}%): ${validation.issues?.join(', ') || validation.reasoning || 'Unbekannt'}`);
    }
    
    // Score: 0-25% (adjustedScore ist 0-100, also /4)
    const semanticScore = Math.max(0, Math.min(25, (adjustedScore / 4)));
    
    return semanticScore;
  } catch (err) {
    // 🚨 FIX: Timeout oder andere Fehler - nicht blockieren, einfach Fallback verwenden
    if (err.message && (err.message.includes('timeout') || err.message.includes('Timeout') || err.message.includes('Semantic validation'))) {
      console.warn('⚠️ Semantische Validierung: Timeout (nicht kritisch) - verwende Fallback');
    } else {
      console.warn('⚠️ Fehler bei semantischer Validierung:', err.message || err);
    }
    return 25; // Fallback: Volle Punkte
  }
}

/**
 * 🚨 NEU: Extrahiere Nebenthemen aus Kundennachricht
 * Erkennt Nebenthemen wie "kochen", "essen", "filme", etc.
 */
function extractSecondaryTopics(message) {
  if (!message || typeof message !== 'string') return [];
  
  const lower = message.toLowerCase();
  const topics = [];
  
  // Liste von häufigen Nebenthemen
  const topicKeywords = {
    'kochen': ['kochen', 'kocht', 'kochend', 'küche', 'koche', 'kochst', 'kocht', 'gerichte', 'rezept'],
    'essen': ['essen', 'isst', 'isst du', 'restaurant', 'essen gehen', 'essen gehen'],
    'filme': ['filme', 'film', 'kino', 'netflix', 'serien', 'schauen'],
    'musik': ['musik', 'lieder', 'lied', 'hören', 'konzert'],
    'sport': ['sport', 'trainieren', 'fitness', 'gym', 'laufen', 'joggen'],
    'reisen': ['reisen', 'urlaub', 'reise', 'verreisen', 'reiseziel'],
    'hobby': ['hobby', 'hobbies', 'interesse', 'interessen']
  };
  
  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(keyword => lower.includes(keyword))) {
      topics.push(topic);
    }
  }
  
  return topics;
}

/**
 * Extrahiere Keywords aus Text (für Kontext-Validierung)
 */
function extractKeywords(text, maxKeywords = 10) {
  if (!text || typeof text !== 'string') return [];
  
  // Entferne Stopwords
  const stopwords = ['der', 'die', 'das', 'und', 'oder', 'aber', 'dass', 'ist', 'sind', 'war', 'wurde', 'haben', 'hat', 'sein', 'wird', 'kann', 'muss', 'soll', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mir', 'dir', 'ihm', 'ihr', 'uns', 'euch', 'ihnen'];
  
  // Extrahiere Wörter (min 4 Zeichen)
  const words = text.match(/\b[a-zäöü]{4,}\b/g) || [];
  
  // Filtere Stopwords
  const keywords = words.filter(w => !stopwords.includes(w));
  
  // Zähle Häufigkeit
  const wordCount = {};
  keywords.forEach(w => {
    wordCount[w] = (wordCount[w] || 0) + 1;
  });
  
  // Sortiere nach Häufigkeit und nimm Top N
  return Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([word]) => word);
}

/**
 * Generiere alternative Nachrichten (Rejection Sampling)
 */
async function generateAlternativeMessages(multiAgentResults, params, systemPrompt, userPrompt, count = 2) {
  const alternatives = [];
  
  const variations = [
    '🚨 WICHTIG: Orientiere dich noch stärker an den Training-Daten-Beispielen!',
    '🚨 WICHTIG: Nutze den Gesprächsverlauf noch stärker für Kontext-Referenzen!',
    '🚨 WICHTIG: Stelle sicher, dass alle erkannten Situationen berücksichtigt werden!'
  ];

  const client = getClient();
  if (!client) return alternatives;

  for (let i = 0; i < count && i < variations.length; i++) {
    try {
      const finalUserPrompt = userPrompt + `\n\n${variations[i]}`;
      
      const response = await Promise.race([
        client.chat.completions.create({
          model: AGENT_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: finalUserPrompt }
          ],
          temperature: 0.7,
          max_tokens: 250
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);

      let altMessage = response.choices?.[0]?.message?.content?.trim() || '';
      
      // Post-Processing (vereinfacht, gleiche Logik wie oben)
      if (altMessage) {
        altMessage = altMessage.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
        altMessage = altMessage.replace(/-/g, " ");
        altMessage = altMessage.replace(/ß/g, "ss");
        altMessage = altMessage.replace(/!/g, '.');
        altMessage = altMessage.replace(/\?+/g, '?');
      }

      if (altMessage && altMessage.trim() !== '') {
        // Validiere auch alternative Nachrichten
        const qualityResult = await validateMessageQuality(altMessage, {
          multiAgentResults,
          training: multiAgentResults.training || {},
          context: multiAgentResults.context || {},
          conversationHistory: params.conversationHistory || '',
          customerMessage: params.customerMessage || '',
          allRules: params.allRules || {},
          situation: multiAgentResults.situation || {}
        });
        
        alternatives.push({
          message: altMessage,
          qualityScore: qualityResult.overallScore,
          qualityResult
        });
      }
    } catch (err) {
      console.warn(`⚠️ Fehler bei alternativer Nachricht ${i + 1}:`, err.message);
    }
  }

  return alternatives;
}

/**
 * Validiere kritische Regeln (blockiert bei Verstößen)
 */
function validateCriticalRules(message, allRules, situation, isMeetingRequestFunc = null, customerMessage = "", conversationHistory = "", context = {}) {
  const violations = [];
  const messageLower = message.toLowerCase();
  const customerMessageLower = (customerMessage || "").toLowerCase();
  const conversationHistoryLower = (conversationHistory || "").toLowerCase();
  const combinedContext = (customerMessageLower + " " + conversationHistoryLower).toLowerCase();

  // 🚨 NEU: Kontext-bewusste Validierung - extrahiere Kontext-Informationen
  const hasSexualContent = context.hasSexualContent || false;
  const detectedSituations = context.detectedSituations || [];
  const isSexualConversation = hasSexualContent || detectedSituations.some(s => s.toLowerCase().includes('sexuell'));

  // 🚨 WICHTIG: Prüfe zuerst, ob es eine Treffen-Anfrage ist
  // Verwende isMeetingRequestFunc, wenn verfügbar (genauer), sonst Fallback auf Keyword-Matching
  // 🚨 NEU: Übergebe Kontext an isMeetingRequestFunc
  let isMeetingRequest = false;
  if (isMeetingRequestFunc && typeof isMeetingRequestFunc === 'function') {
    isMeetingRequest = isMeetingRequestFunc(message, customerMessage, context);
  } else {
    // Fallback: Keyword-Matching
    const meetingKeywords = ['treffen', 'sehen', 'kennenlernen', 'termin', 'wann können wir', 'würde gerne treffen'];
    isMeetingRequest = meetingKeywords.some(keyword => messageLower.includes(keyword)) &&
      !messageLower.includes('bevor wir uns treffen') && // Höfliche Ablehnung ist OK
      !messageLower.includes('kennenzulernen, bevor wir uns treffen');
  }
  
  // 🚨 NEU: Prüfe, ob der Kunde ein Treffen vorgeschlagen hat
  const customerHasMeetingRequest = combinedContext.includes('treffen') || 
                                     combinedContext.includes('sehen') || 
                                     combinedContext.includes('kennenlernen') ||
                                     combinedContext.includes('freitag') && (combinedContext.includes('passt') || combinedContext.includes('klappt')) ||
                                     combinedContext.includes('samstag') && (combinedContext.includes('passt') || combinedContext.includes('klappt')) ||
                                     combinedContext.includes('wann') && (combinedContext.includes('können') || combinedContext.includes('treffen'));
  
  // 🚨 NEU: Prüfe auf Zustimmung zu Treffen-Anfrage des Kunden
  if (customerHasMeetingRequest) {
    const agreementPhrases = [
      /klingt super/i,
      /klingt gut/i,
      /würde gut passen/i,
      /passt (gut|super|perfekt)/i,
      /sind schon (ganz )?heiss darauf/i,
      /freuen uns schon/i,
      /kannst du versprechen/i, // "Ich kann dir versprechen" bei Treffen = Zustimmung!
      /freitag klingt/i,
      /samstag klingt/i,
      /klingt.*super.*freitag/i,
      /klingt.*super.*samstag/i
    ];
    
    const hasAgreement = agreementPhrases.some(pattern => pattern.test(message));
    if (hasAgreement) {
      violations.push('Treffen-Zustimmung erkannt (z.B. "klingt super", "würde gut passen", "sind schon ganz heiss darauf") - blockiert');
    }
  }
  
  // 1. Verbotene Wörter (absolut kritisch)
  // 🚨 WICHTIG: Filtere "treffen" aus verbotenen Wörtern heraus, wenn es KEINE Treffen-Anfrage ist
  // "treffen" sollte nur blockiert werden, wenn es um ein Treffen/Date geht, nicht generell
  if (allRules?.forbiddenWords && allRules.forbiddenWords.length > 0) {
    // Filtere "treffen" aus verbotenen Wörtern heraus, wenn es keine Treffen-Anfrage ist
    const forbiddenWordsToCheck = isMeetingRequest 
      ? allRules.forbiddenWords // Wenn Treffen-Anfrage, prüfe alle (inkl. "treffen")
      : allRules.forbiddenWords.filter(word => word.toLowerCase() !== 'treffen'); // Sonst filtere "treffen" raus
    
    const forbiddenFound = forbiddenWordsToCheck.filter(word =>
      messageLower.includes(word.toLowerCase())
    );
    if (forbiddenFound.length > 0) {
      violations.push(`Verbotene Wörter: ${forbiddenFound.join(', ')}`);
    }
  }

  // 2. Treffen-Anfrage (absolut kritisch)
  if (isMeetingRequest) {
    violations.push('Treffen-Anfrage erkannt');
  }

  // 🚨 NEU: 2.5. Widerspruchs-Erkennung (absolut kritisch - blockiert)
  // Prüfe, ob die Nachricht widersprüchliche Phrasen enthält (z.B. positiv/sexuell + negativ/ablehnend)
  // Beispiel: "Ich liebe es, wenn du mich richtig hart nimmst. Es tut mir leid, aber ich kann dir dabei nicht helfen."
  const positiveKeywords = [
    "geil", "liebe es", "macht mich", "begeistert", "finde es geil", "heiß", "leidenschaftlich",
    "würde gerne", "möchte", "will", "mag", "gefällt", "super", "toll", "wunderbar"
  ];
  const negativeKeywords = [
    "tut mir leid", "es tut mir leid", "kann dir dabei nicht", "kann ich nicht helfen", "kann nicht helfen",
    "möchte ich nicht", "will ich nicht", "kein interesse", "nicht interessiert", "ablehnen", "verweigern",
    "nein", "sorry", "entschuldigung", "kann ich nicht", "kann dir nicht", "darauf nicht eingehen",
    "nicht darauf eingehen", "kann darauf nicht", "darauf nicht antworten", "nicht antworten"
  ];
  
  const hasPositiveKeyword = positiveKeywords.some(keyword => messageLower.includes(keyword));
  const hasNegativeKeyword = negativeKeywords.some(keyword => messageLower.includes(keyword));
  
  if (hasPositiveKeyword && hasNegativeKeyword) {
    violations.push('Widerspruch erkannt: Nachricht enthält sowohl positive/sexuelle als auch negative/ablehnende Phrasen (z.B. "geil" + "tut mir leid, kann nicht helfen") - blockiert');
  }

  // 3. Meta-Kommentare (absolut kritisch - blockiert)
  // 🚨🚨🚨 KRITISCH: "Das klingt..." ist ABSOLUT VERBOTEN in ALLEN Varianten! 🚨🚨🚨
  // ❌ ABSOLUT VERBOTEN: "Das klingt..." / "Es klingt..." / "Klingt..." in ALLEN Varianten!
  // ❌ ABSOLUT VERBOTEN: "Das klingt nach..." / "Es klingt nach..." / "Klingt nach..." in ALLEN Varianten!
  // ❌ ABSOLUT VERBOTEN: "Das klingt geil" / "Das klingt gut" / "Das klingt nach einem Plan" / "Das klingt nach einem guten Plan" etc.
  // 🚨 KRITISCH: "Das klingt..." ist IMMER ein META-KOMMENTAR, auch wenn es auf einen Vorschlag reagiert!
  const klingtPatterns = [
    /^(das|es|das ist|es ist)\s+klingt\s+/i, // "Das klingt..." / "Es klingt..."
    /\bklingt\s+(nach|wie|gut|geil|super|toll|schön|interessant|spannend|verlockend|aufregend|heiss|mega|richtig)/i, // "klingt nach..." / "klingt gut" etc.
    /(das|es|das ist|es ist)\s+klingt\s+(nach|wie|gut|geil|super|toll|schön|interessant|spannend|verlockend|aufregend|heiss|mega|richtig)/i, // "Das klingt nach..." / "Das klingt gut" etc.
    /\bklingt\s+nach\s+(einem|einer|einen)/i, // "klingt nach einem/einer..."
    /\bklingt\s+nach(\s|$)/i // 🚨 SYSTEM-FIX: "klingt nach" auch ohne folgendes Wort (z.B. abgeschnittene Nachrichten)
  ];
  const hasKlingt = klingtPatterns.some(pattern => pattern.test(message));
  if (hasKlingt) {
    violations.push('"Das klingt..." / "Es klingt..." erkannt - ABSOLUT VERBOTEN! Verwende stattdessen: "Das finde ich geil", "Das ist geil", "Mega!", "Das würde mir gefallen" - blockiert');
  }
  
  // 🚨 KRITISCH: Meta-Kommentare sind verboten - sie kommentieren die NACHRICHT/SITUATION, anstatt auf den INHALT zu reagieren
  // ❌ VERBOTEN: "Ich finde es toll, dass du...", "Ich finde es schon mal gut, dass..." - Kommentar über NACHRICHT/SITUATION
  // 🚨🚨🚨 NEU: Auch "Ich bin gespannt", "ich bin schon ganz neugierig" sind Meta-Kommentare - VERBOTEN!
  const metaCommentPatterns = [
    /ich finde es (toll|gut|schön|super|schon mal gut|interessant|spannend|großartig|wunderbar|genial|fantastisch|klasse|spitze),?\s+(dass|wie|wenn)/i, // "Ich finde es toll/super, dass..."
    /ich finde es (toll|gut|schön|super|schon mal gut|interessant|spannend|großartig|wunderbar|genial|fantastisch|klasse|spitze)\s+(du|ihr|der|die|das)/i, // "Ich finde es toll/super du..."
    /ich finde (dass|wie|wenn)\s+(du|ihr|der|die|das).*\s+(toll|gut|schön|super|interessant|spannend|großartig)/i, // "Ich finde dass du... toll"
    /ich finde\s+(du|ihr|der|die|das).*\s+(toll|gut|schön|super|interessant|spannend|großartig)/i, // "Ich finde du... super"
    /das würde mir gefallen/i,
    /wir können uns vorstellen/i,
    /ich kann mir vorstellen,?\s+(dass|wie|wenn)/i, // "Ich kann mir vorstellen, dass..."
    /das ist (toll|gut|schön|super|interessant|spannend|großartig),?\s+(dass|wie|wenn)/i, // "Das ist toll/super, dass..."
    /wie (toll|gut|schön|super|interessant|spannend|großartig),?\s+(dass|wie|wenn)/i, // "Wie toll/super, dass..."
    // 🚨🚨🚨 NEU: "Ich bin gespannt" / "ich bin schon ganz neugierig" etc. - VERBOTEN!
    /\bich bin (schon|sehr|total|richtig|ganz)?\s*(gespannt|neugierig)\b/i, // "Ich bin gespannt" / "ich bin schon ganz neugierig"
    /\bich bin schon (ganz|sehr|total|richtig)?\s*(gespannt|neugierig)\b/i, // "ich bin schon ganz neugierig" / "ich bin schon gespannt"
    /\bich bin (schon|sehr|total|richtig|ganz)?\s*neugierig\b/i // "ich bin neugierig" / "ich bin schon ganz neugierig"
  ];
  
  // Prüfe, ob es ein Meta-Kommentar ist
  const hasMetaComment = metaCommentPatterns.some(pattern => pattern.test(message));
  if (hasMetaComment) {
    violations.push('Meta-Kommentar erkannt (z.B. "Ich finde es toll, dass...", "Ich bin gespannt", "ich bin schon ganz neugierig") - blockiert');
  }

  // 4. Ausrufezeichen (technisch, aber kritisch)
  if (message.includes('!')) {
    violations.push('Ausrufezeichen gefunden (sollten durch Post-Processing entfernt worden sein)');
  }

  // 🚨 NEU: Prüfe auf Paraphrasieren/Wiederholen der Kundennachricht (semantisch)
  // WICHTIG: Diese Funktion ist jetzt async, muss aber synchron bleiben für validateCriticalRules
  // Daher: Prüfung wird in agentMessageGenerator durchgeführt, nicht hier
  // Diese Prüfung bleibt als Fallback (wird aber nicht mehr verwendet)

  return violations;
}

// 🚨 NEU: Berechne Ähnlichkeit zwischen zwei Nachrichten (für Paraphrasieren-Erkennung)
// Nutzt jetzt Embeddings für semantische Ähnlichkeit statt nur Wort-Ähnlichkeit
async function calculateMessageSimilarity(message1, message2) {
  if (!message1 || !message2) return 0;
  
  try {
    // 🚨 NEU: Nutze Embeddings für semantische Ähnlichkeit
    const { getEmbedding, cosineSimilarity } = require('./embeddings');
    const embedding1 = await getEmbedding(message1);
    const embedding2 = await getEmbedding(message2);
    
    if (embedding1 && embedding2) {
      const semanticSimilarity = cosineSimilarity(embedding1, embedding2);
      // Semantische Ähnlichkeit ist zwischen -1 und 1, normalisiere auf 0-1
      const normalizedSimilarity = (semanticSimilarity + 1) / 2;
      return normalizedSimilarity;
    }
  } catch (err) {
    console.warn('⚠️ Fehler bei semantischer Ähnlichkeitsberechnung, verwende Fallback:', err.message);
  }
  
  // Fallback: Wort-basierte Ähnlichkeit (falls Embeddings fehlschlagen)
  const words1 = message1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const words2 = message2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // Zähle gemeinsame Wörter
  const commonWords = words1.filter(w => words2.includes(w)).length;
  
  // Berechne Ähnlichkeit: gemeinsame Wörter / durchschnittliche Länge
  const avgLength = (words1.length + words2.length) / 2;
  const similarity = commonWords / avgLength;
  
  // Prüfe auch auf gemeinsame Phrasen (3+ Wörter)
  const phrases1 = [];
  const phrases2 = [];
  for (let i = 0; i < words1.length - 2; i++) {
    phrases1.push(words1.slice(i, i + 3).join(' '));
  }
  for (let i = 0; i < words2.length - 2; i++) {
    phrases2.push(words2.slice(i, i + 3).join(' '));
  }
  
  const commonPhrases = phrases1.filter(p => phrases2.includes(p)).length;
  const phraseSimilarity = commonPhrases > 0 ? Math.min(1, commonPhrases / Math.min(phrases1.length, phrases2.length)) : 0;
  
  // Kombiniere Wort- und Phrasen-Ähnlichkeit
  return Math.max(similarity, phraseSimilarity * 0.5);
}

/**
 * Agent: Example Intelligence
 * Findet die besten Beispiele aus Training-Daten und erstellt eine intelligente Zusammenfassung
 * für die Haupt-KI, wie sie diese Beispiele nutzen soll
 */
async function agentExampleIntelligence(customerMessage, conversationHistory, trainingData, situations = [], vectorDbFunc = null, learningContextResult = null, extractedUserInfo = null) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Example Intelligence - Fallback');
    return {
      bestExamples: [],
      structureGuidance: '',
      wordChoiceGuidance: '',
      questionGuidance: '',
      contextGuidance: '', // 🚨 NEU: Context Guidance für WANN welche Fragen
      success: false
    };
  }

  try {
    // Nutze smart-example-selector für intelligente Beispiel-Auswahl
    const { selectSmartExamples } = require('./smart-example-selector');
    
    // Finde die besten Beispiele
    const bestExamples = await selectSmartExamples(customerMessage, {
      topK: 5,
      situation: situations.length > 0 ? situations[0] : null,
      conversationHistory: conversationHistory,
      includeSexual: true,
      minSimilarity: 0.3
    });

    if (bestExamples.length === 0) {
      console.log('⚠️ Agent: Example Intelligence - Keine Beispiele gefunden');
      return {
        bestExamples: [],
        structureGuidance: '',
        wordChoiceGuidance: '',
        questionGuidance: '',
        success: false
      };
    }

    // 🚨 NEU: Extrahiere Profil-Info für Kontext-Muster-Analyse
    const customerProfile = extractedUserInfo?.user || {};
    
    // Extrahiere Vorlieben aus verschiedenen möglichen Feldern
    let sexualPreferencesText = customerProfile['Sexual Preferences'] || customerProfile['Vorlieben'] || null;
    
    // Prüfe auch im "Other"-Feld (kann "Vorlieben: anal lecken..." enthalten)
    if (!sexualPreferencesText && customerProfile.Other) {
      const otherText = customerProfile.Other;
      // Suche nach "Vorlieben:" im Other-Feld
      if (otherText.includes('Vorlieben:')) {
        const vorliebenMatch = otherText.match(/Vorlieben:\s*([^\n]*?)(?:\n|Tabus:|$)/i);
        if (vorliebenMatch && vorliebenMatch[1]) {
          sexualPreferencesText = vorliebenMatch[1].trim();
        }
      }
      // Fallback: Prüfe ob sexuelle Begriffe vorhanden sind
      if (!sexualPreferencesText && (otherText.toLowerCase().includes('anal') || 
                                     otherText.toLowerCase().includes('fingern') ||
                                     otherText.toLowerCase().includes('fisten') ||
                                     otherText.toLowerCase().includes('nylons'))) {
        // Extrahiere relevante Teile
        const lines = otherText.split('\n');
        const vorliebenLine = lines.find(line => line.toLowerCase().includes('vorlieben'));
        if (vorliebenLine) {
          sexualPreferencesText = vorliebenLine.split(':')[1]?.trim() || null;
        }
      }
    }
    
    const hasSexualPreferences = !!sexualPreferencesText;
    const hasHobbies = customerProfile['Sport and Hobbies'] || customerProfile['Hobbies'] || 
                      (customerProfile.Other && customerProfile.Other.toLowerCase().includes('hobbies'));
    
    // Analysiere die Beispiele mit KI, um Struktur, Wortwahl und Fragen zu extrahieren
    const examplesText = bestExamples.map((ex, idx) => 
      `${idx + 1}. Kunde: "${ex.customerMessage}"\n   Antwort: "${ex.moderatorResponse}"${ex.situation ? `\n   Situation: ${ex.situation}` : ''}`
    ).join('\n\n');

    // 🚨 NEU: Kontext-Info für aktuelle Situation
    const currentContext = {
      customerMessage: customerMessage.substring(0, 200),
      situations: situations.join(', '),
      hasSexualPreferences: !!hasSexualPreferences,
      sexualPreferences: sexualPreferencesText ? sexualPreferencesText.substring(0, 100) : null,
      hasHobbies: !!hasHobbies
    };

    const analysisPrompt = `Analysiere diese Chat-Beispiele und extrahiere Muster für Struktur, Wortwahl, Fragen UND KONTEXT-MUSTER (WANN welche Fragen gestellt werden).

Beispiele:
${examplesText}

🚨 NEU: KONTEXT-MUSTER-ANALYSE (WANN welche Fragen):
Analysiere WANN in diesen Beispielen welche Fragen gestellt werden:
- Nach sexuellen Nachrichten → Welche Fragen werden gestellt? (z.B. nach Vorlieben?)
- Nach allgemeinen Nachrichten → Welche Fragen werden gestellt? (z.B. nach Hobbies?)
- Nach Treffen-Anfragen → Welche Fragen werden gestellt?
- Wenn Vorlieben im Profil vorhanden → Werden nach Vorlieben gefragt?
- Wenn Hobbies im Profil vorhanden → Werden nach Hobbies gefragt?

Aktueller Kontext:
- Kundennachricht: "${currentContext.customerMessage}"
- Situationen: ${currentContext.situations || 'keine'}
- Vorlieben im Profil: ${currentContext.hasSexualPreferences ? `JA (${currentContext.sexualPreferences || 'vorhanden'})` : 'NEIN'}
- Hobbies im Profil: ${currentContext.hasHobbies ? 'JA' : 'NEIN'}

Antworte NUR als JSON:
{
  "structure": "Beschreibe die Antwort-Struktur (z.B. 'Reaktion auf Nachricht + Ausweichen + Frage stellen' oder 'Emotionale Reaktion + Persönliche Info + Frage')",
  "wordChoice": "Liste typische Wörter/Formulierungen die verwendet werden (z.B. 'schauen wir mal', 'könnte ich mir vorstellen', 'was hast du heute noch so vor')",
  "questions": "Liste typische Fragen die gestellt werden (z.B. 'was machst du heute noch?', 'wie stellst du dir das vor?')",
  "tone": "Beschreibe den Ton (z.B. 'locker, natürlich, emotional, direkt')",
  "keyPhrases": ["wichtige Phrase 1", "wichtige Phrase 2"],
  "contextPatterns": "🚨 NEU: Beschreibe KONTEXT-MUSTER - WANN werden welche Fragen gestellt? (z.B. 'Nach sexueller Nachricht + Vorlieben im Profil → Frage nach Vorlieben' oder 'Nach allgemeiner Nachricht + Hobbies im Profil → Frage nach Hobbies')",
  "shouldAskAboutPreferences": ${currentContext.hasSexualPreferences && situations.some(s => s.toLowerCase().includes('sexuell')) ? 'true' : 'false'},
  "preferencesToAskAbout": ${currentContext.hasSexualPreferences && currentContext.sexualPreferences ? `"${currentContext.sexualPreferences.substring(0, 150)}"` : 'null'}
}

WICHTIG:
- Extrahiere die STRUKTUR: Wie sind die Antworten aufgebaut?
- Extrahiere WORTWAHL: Welche Wörter/Formulierungen werden häufig verwendet?
- Extrahiere FRAGEN: Welche Art von Fragen wird gestellt?
- 🚨 NEU: Extrahiere KONTEXT-MUSTER: WANN werden welche Fragen gestellt? (z.B. "Nach sexueller Nachricht + Vorlieben im Profil → Frage nach Vorlieben")
- 🚨 NEU: Prüfe ob in ähnlichen Situationen (sexuelle Nachricht + Vorlieben im Profil) nach Vorlieben gefragt wird!
- Sei spezifisch und konkret!`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du analysierst Chat-Beispiele und extrahierst Muster. Antworte IMMER nur als JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 800 // 🚨 ERHÖHT: Mehr Tokens für Kontext-Muster-Analyse
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          // Erstelle strukturierte Guidance
          const structureGuidance = parsed.structure ? `\n📐 ANTWORT-STRUKTUR (aus Training-Daten):\n${parsed.structure}\n\nNutze diese Struktur für deine Antwort!` : '';
          const wordChoiceGuidance = parsed.wordChoice ? `\n💬 WORTWAHL (aus Training-Daten):\n${parsed.wordChoice}\n\nVerwende diese Wörter/Formulierungen in deiner Antwort!` : '';
          const questionGuidance = parsed.questions ? `\n❓ FRAGEN (aus Training-Daten):\n${parsed.questions}\n\nStelle ähnliche Fragen in deiner Antwort!` : '';
          const toneGuidance = parsed.tone ? `\n🎭 TON (aus Training-Daten):\n${parsed.tone}\n\nAntworte in diesem Ton!` : '';
          const keyPhrasesGuidance = parsed.keyPhrases && parsed.keyPhrases.length > 0 ? `\n🔑 WICHTIGE PHRASEN (aus Training-Daten):\n${parsed.keyPhrases.join(', ')}\n\nNutze diese Phrasen in deiner Antwort!` : '';
          
          // 🚨 NEU: Context Guidance - WANN welche Fragen angebracht sind
          let contextGuidance = '';
          if (parsed.contextPatterns) {
            contextGuidance += `\n🚨🚨🚨 KONTEXT-MUSTER (aus Training-Daten - WANN welche Fragen): 🚨🚨🚨\n${parsed.contextPatterns}\n\n`;
          }
          
          // 🚨 NEU: Explizite Anweisung wenn nach Vorlieben gefragt werden soll
          if (parsed.shouldAskAboutPreferences && parsed.preferencesToAskAbout) {
            contextGuidance += `\n🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: FRAGE NACH VORLIEBEN! 🚨🚨🚨🚨🚨\n`;
            contextGuidance += `- Der Kunde hat Vorlieben im Profil: ${parsed.preferencesToAskAbout}\n`;
            contextGuidance += `- Die Training-Daten zeigen: Nach sexueller Nachricht + Vorlieben im Profil → Frage nach Vorlieben!\n`;
            contextGuidance += `- Nutze Fragen aus Training-Daten wie "was magst du denn so?" oder "was würdest du noch gerne machen?"\n`;
            contextGuidance += `- Gehe auf die Vorlieben ein: ${parsed.preferencesToAskAbout}\n\n`;
          } else if (currentContext.hasSexualPreferences && situations.some(s => s.toLowerCase().includes('sexuell'))) {
            // Fallback: Wenn Kontext-Muster nicht erkannt wurde, aber Situation passt
            const prefsText = currentContext.sexualPreferences || 'vorhanden';
            contextGuidance += `\n🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: FRAGE NACH VORLIEBEN! 🚨🚨🚨🚨🚨\n`;
            contextGuidance += `- Sexuelle Nachricht erkannt: "${currentContext.customerMessage.substring(0, 100)}"\n`;
            contextGuidance += `- Vorlieben im Profil vorhanden: ${prefsText}\n`;
            contextGuidance += `- 🚨 KRITISCH: In ähnlichen Situationen (sexuelle Nachricht + Vorlieben im Profil) wird nach Vorlieben gefragt!\n`;
            contextGuidance += `- Nutze Fragen aus Training-Daten wie "was magst du denn so?" oder "was würdest du noch gerne machen?"\n`;
            contextGuidance += `- Gehe auf die Vorlieben ein: ${prefsText}\n\n`;
          }

          console.log(`✅ Agent: Example Intelligence - ${bestExamples.length} Beispiele analysiert, Struktur/Wortwahl/Fragen/Kontext-Muster extrahiert`);
          
          return {
            bestExamples: bestExamples,
            structureGuidance: structureGuidance,
            wordChoiceGuidance: wordChoiceGuidance,
            questionGuidance: questionGuidance,
            toneGuidance: toneGuidance,
            keyPhrasesGuidance: keyPhrasesGuidance,
            contextGuidance: contextGuidance, // 🚨 NEU: Context Guidance
            analysis: parsed,
            success: true
          };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Example Intelligence - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Example Intelligence - Fehler:', err.message);
  }

  // Fallback
  return {
    bestExamples: [],
    structureGuidance: '',
    wordChoiceGuidance: '',
    questionGuidance: '',
    contextGuidance: '', // 🚨 NEU: Context Guidance
    success: false
  };
}

/**
 * Agent: Meeting Response (spezialisiert für Treffen-Anfragen)
 * Findet spezifische Beispiele für Treffen-Anfragen und prüft, ob Antworten ein Treffen ausmachen
 */
async function agentMeetingResponse(customerMessage, conversationHistory, trainingData, isMeetingRequestFunc = null, vectorDbFunc = null) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Meeting Response - Fallback');
    return {
      meetingExamples: [],
      responseGuidance: '',
      allowedPhrases: [],
      blockedPhrases: [],
      success: false
    };
  }

  // Prüfe, ob es eine Treffen-Anfrage ist
  if (!isMeetingRequestFunc || typeof isMeetingRequestFunc !== 'function') {
    return {
      meetingExamples: [],
      responseGuidance: '',
      allowedPhrases: [],
      blockedPhrases: [],
      success: false
    };
  }

  const isMeetingRequest = isMeetingRequestFunc(customerMessage, '');
  if (!isMeetingRequest) {
    return {
      meetingExamples: [],
      responseGuidance: '',
      allowedPhrases: [],
      blockedPhrases: [],
      success: false,
      isMeetingRequest: false
    };
  }

  try {
    console.log('🤖 Agent: Meeting Response - Treffen-Anfrage erkannt, suche spezifische Beispiele...');

    // Nutze smart-example-selector für Treffen-spezifische Beispiele
    const { selectSmartExamples } = require('./smart-example-selector');
    
    // Suche speziell nach Treffen-Beispielen
    const meetingExamples = await selectSmartExamples(customerMessage, {
      topK: 5,
      situation: 'Treffen/Termine',
      conversationHistory: conversationHistory,
      includeSexual: true,
      minSimilarity: 0.25
    });

    // Analysiere die Beispiele, um erlaubte vs. blockierte Phrasen zu identifizieren
    const examplesText = meetingExamples.map((ex, idx) => 
      `${idx + 1}. Kunde: "${ex.customerMessage}"\n   Antwort: "${ex.moderatorResponse}"`
    ).join('\n\n');

    const analysisPrompt = `Analysiere diese Beispiele für Treffen-Anfragen. Diese Antworten reagieren auf Treffen-Anfragen, machen aber KEIN Treffen aus.

Beispiele:
${examplesText}

Antworte NUR als JSON:
{
  "allowedPhrases": ["erlaubte Phrase 1", "erlaubte Phrase 2"],
  "blockedPhrases": ["blockierte Phrase 1", "blockierte Phrase 2"],
  "responsePattern": "Beschreibe das Muster (z.B. 'Ausweichen + Grund nennen + Frage stellen')",
  "keyWords": ["wichtiges Wort 1", "wichtiges Wort 2"]
}

WICHTIG:
- "allowedPhrases": Phrasen die ERLAUBT sind (z.B. "schauen wir mal wann es klappt", "könnte ich mir vorstellen")
- "blockedPhrases": Phrasen die BLOCKIERT werden sollten (z.B. "wann können wir uns treffen", "lass uns treffen")
- Diese Antworten reagieren auf Treffen-Anfragen, machen aber KEIN Treffen aus!`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du analysierst Treffen-Antworten. Antworte IMMER nur als JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 400
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          const responseGuidance = parsed.responsePattern ? `\n🚫 TREFFEN-ANFRAGE: Nutze dieses Muster: ${parsed.responsePattern}\n\nERLAUBTE PHRASEN: ${parsed.allowedPhrases?.join(', ') || 'keine'}\nBLOCKIERTE PHRASEN: ${parsed.blockedPhrases?.join(', ') || 'keine'}` : '';

          console.log(`✅ Agent: Meeting Response - ${meetingExamples.length} Treffen-Beispiele gefunden, ${parsed.allowedPhrases?.length || 0} erlaubte Phrasen identifiziert`);
          
          return {
            meetingExamples: meetingExamples,
            responseGuidance: responseGuidance,
            allowedPhrases: parsed.allowedPhrases || [],
            blockedPhrases: parsed.blockedPhrases || [],
            responsePattern: parsed.responsePattern || '',
            keyWords: parsed.keyWords || [],
            isMeetingRequest: true,
            success: true
          };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Meeting Response - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Meeting Response - Fehler:', err.message);
  }

  // Fallback
  return {
    meetingExamples: [],
    responseGuidance: '',
    allowedPhrases: [],
    blockedPhrases: [],
    isMeetingRequest: true,
    success: false
  };
}

/**
 * Agent: Response Validator
 * Prüft Antwort-Struktur VOR der Generierung, um Blockierungen zu vermeiden
 */
async function agentResponseValidator(plannedStructure, customerMessage, isMeetingRequest = false, meetingResponseResult = null, context = {}) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Response Validator - Fallback');
    return {
      isValid: true,
      feedback: '',
      suggestions: [],
      success: false
    };
  }

  try {
    // 🚨 NEU: Kontext-bewusste Validierung - extrahiere Kontext-Informationen
    const hasSexualContent = context.hasSexualContent || false;
    const detectedSituations = context.detectedSituations || [];
    const isSexualConversation = hasSexualContent || detectedSituations.some(s => s.toLowerCase().includes('sexuell'));
    
    let validationPrompt = `Prüfe diese geplante Antwort-Struktur auf Probleme.

Geplante Struktur: "${plannedStructure}"
Kunden-Nachricht: "${customerMessage.substring(0, 200)}"`;

    // 🚨 NEU: Kontext-Informationen zum Prompt hinzufügen
    if (isSexualConversation) {
      validationPrompt += `\n\n📊 KONTEXT: Sexuelles Gespräch erkannt (hasSexualContent: ${hasSexualContent}, detectedSituations: ${detectedSituations.join(', ')})`;
      validationPrompt += `\n🚨 WICHTIG: Bei sexuellen Gesprächen sind sexuelle Inhalte ERLAUBT und ERWÜNSCHT!`;
      validationPrompt += `\n🚨 WICHTIG: Blockiere NICHT wegen "anstößiger Inhalte" - das ist in diesem Kontext normal!`;
    }

    if (isMeetingRequest && meetingResponseResult) {
      validationPrompt += `\n\n🚫 TREFFEN-ANFRAGE ERKANNT!\nErlaubte Phrasen: ${meetingResponseResult.allowedPhrases?.join(', ') || 'keine'}\nBlockierte Phrasen: ${meetingResponseResult.blockedPhrases?.join(', ') || 'keine'}`;
    }

    validationPrompt += `\n\nAntworte NUR als JSON:
{
  "isValid": true/false,
  "feedback": "Kurze Begründung",
  "suggestions": ["Vorschlag 1", "Vorschlag 2"],
  "issues": ["Problem 1", "Problem 2"]
}

WICHTIG:
${isMeetingRequest ? '- Prüfe, ob die Struktur ein Treffen ausmacht (wenn Treffen-Anfrage)' : '- 🚨 KRITISCH: KEINE Treffen-Anfrage erkannt - erwarte KEINE Treffen-Einladung in der Antwort!'}
${isSexualConversation ? '- 🚨 KONTEXT: Sexuelles Gespräch - sexuelle Inhalte sind ERLAUBT! Blockiere NICHT wegen "anstößiger Inhalte"!' : '- Prüfe, ob verbotene Wörter verwendet werden (außer bei sexuellen Gesprächen)'}
- Prüfe, ob die Struktur zu den Training-Daten passt
- ${isMeetingRequest ? '' : '🚨 WICHTIG: Die Nachricht ist KEINE Treffen-Anfrage - die Antwort sollte auch KEINE Treffen-Einladung enthalten!'}`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du prüfst Antwort-Strukturen. Antworte IMMER nur als JSON.' },
          { role: 'user', content: validationPrompt }
        ],
        temperature: 0.2,
        max_tokens: 300
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          console.log(`✅ Agent: Response Validator - Struktur geprüft: ${parsed.isValid ? 'GÜLTIG' : 'UNGÜLTIG'}`);
          if (!parsed.isValid && parsed.issues) {
            console.log(`⚠️ Probleme: ${parsed.issues.join(', ')}`);
          }
          
          return {
            isValid: parsed.isValid !== false,
            feedback: parsed.feedback || '',
            suggestions: parsed.suggestions || [],
            issues: parsed.issues || [],
            success: true
          };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Response Validator - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Response Validator - Fehler:', err.message);
  }

  // Fallback: Im Zweifel als gültig annehmen
  return {
    isValid: true,
    feedback: '',
    suggestions: [],
    success: false
  };
}

/**
 * 🧠 Agent: Learning Integrator
 * Reichert Agent-Ergebnisse während der Pipeline mit Learning-Wissen an
 */
async function agentLearningIntegrator(situation, customerMessage, sharedKB) {
  try {
    const { getLearningStats } = require('./learning-system');
    const learningStats = await getLearningStats();
    
    if (!learningStats || !sharedKB) {
      return { success: false, enriched: false };
    }

    // Setze Learning-Stats in Shared Knowledge Base
    sharedKB.setLearningStats(learningStats);

    const situationsArray = Array.isArray(situation) ? situation : (situation ? [situation] : ['allgemein']);
    const primarySituation = situationsArray[0] || 'allgemein';
    // 🧠 NEU: Prüfe ALLE Situationen, nicht nur die erste
    const allSituationsToCheck = situationsArray.length > 0 ? situationsArray : ['allgemein'];

    // Finde relevante Muster aus Learning-Stats
    const relevantPatterns = [];
    const relevantWords = [];
    const avoidPatterns = [];

    // 🧠 NEU: Prüfe ALLE Situationen
    allSituationsToCheck.forEach(sit => {
      // 1. Word Frequencies (welche Wörter funktionieren gut/schlecht)
      if (learningStats.wordFrequency && learningStats.wordFrequency[sit]) {
        const wordFreq = learningStats.wordFrequency[sit];
        for (const [word, freq] of Object.entries(wordFreq)) {
          // Prüfe, ob Wort bereits vorhanden (vermeide Duplikate)
          const existingWord = relevantWords.find(w => w.word === word);
          const existingAvoid = avoidPatterns.find(a => a.word === word);
          
          if (freq.good > freq.bad && freq.good >= 2) {
            if (existingWord) {
              // Erhöhe Score wenn bereits vorhanden
              existingWord.score = Math.max(existingWord.score, freq.good / (freq.good + freq.bad));
              existingWord.count = Math.max(existingWord.count, freq.good);
            } else {
              relevantWords.push({ word, score: freq.good / (freq.good + freq.bad), count: freq.good, situation: sit });
            }
          } else if (freq.bad > freq.good && freq.bad >= 2 && !existingAvoid) {
            avoidPatterns.push({ word, reason: `Wurde ${freq.bad}x als schlecht markiert (${sit})`, situation: sit });
          }
        }
      }

      // 2. Response Patterns (bewährte Antwort-Muster)
      if (learningStats.responsePatterns && Array.isArray(learningStats.responsePatterns)) {
        learningStats.responsePatterns
          .filter(p => p.situation === sit && p.successCount >= 2)
          .slice(0, 3) // Weniger pro Situation, da wir mehrere prüfen
          .forEach(pattern => {
            // Prüfe auf Duplikate
            const existingPattern = relevantPatterns.find(p => 
              p.pattern.substring(0, 50) === (pattern.goodResponse?.substring(0, 50) || pattern.pattern.substring(0, 50))
            );
            if (!existingPattern) {
              relevantPatterns.push({
                pattern: pattern.goodResponse?.substring(0, 100) || pattern.pattern,
                successRate: pattern.successCount / (pattern.successCount + (pattern.failCount || 0)),
                count: pattern.successCount,
                situation: sit
              });
            }
          });
      }

      // 3. Reasoning Principles (Prinzipien aus Begründungen)
      if (learningStats.reasoningPrinciples && Array.isArray(learningStats.reasoningPrinciples)) {
        learningStats.reasoningPrinciples
          .filter(p => p.situation === sit && p.count >= 2)
          .slice(0, 2) // Weniger pro Situation
          .forEach(principle => {
            // Wird später gesammelt
          });
      }

      // 4. Diff Patterns (was wurde entfernt/hinzugefügt)
      if (learningStats.diffPatterns && learningStats.diffPatterns[sit]) {
        const diffPatterns = learningStats.diffPatterns[sit];
        if (diffPatterns.removed && Array.isArray(diffPatterns.removed)) {
          diffPatterns.removed.slice(0, 3).forEach(removed => {
            const existingAvoid = avoidPatterns.find(a => a.word === removed);
            if (!existingAvoid) {
              avoidPatterns.push({ word: removed, reason: `Wird häufig in editierten Antworten entfernt (${sit})`, situation: sit });
            }
          });
        }
        if (diffPatterns.added && Array.isArray(diffPatterns.added)) {
          diffPatterns.added.slice(0, 3).forEach(added => {
            const existingWord = relevantWords.find(w => w.word === added);
            if (!existingWord) {
              relevantWords.push({ word: added, score: 0.8, count: 1, reason: `Wird häufig in editierten Antworten hinzugefügt (${sit})`, situation: sit });
            }
          });
        }
      }
    });

    // 3. Reasoning Principles (Prinzipien aus Begründungen) - Sammle für alle Situationen
    const relevantPrinciples = [];
    if (learningStats.reasoningPrinciples && Array.isArray(learningStats.reasoningPrinciples)) {
      allSituationsToCheck.forEach(sit => {
        learningStats.reasoningPrinciples
          .filter(p => p.situation === sit && p.count >= 2)
          .slice(0, 2)
          .forEach(principle => {
            if (!relevantPrinciples.find(p => p.substring(0, 50) === principle.principle.substring(0, 50))) {
              relevantPrinciples.push(principle.principle);
            }
          });
      });
    }

    // Schreibe Erkenntnisse in Shared Knowledge Base
    const insights = [];
    const recommendations = [];

    if (relevantWords.length > 0) {
      const topWords = relevantWords.sort((a, b) => b.score - a.score).slice(0, 5);
      insights.push(`Diese Wörter funktionieren gut in "${primarySituation}": ${topWords.map(w => w.word).join(', ')}`);
      recommendations.push(`Nutze diese Wörter: ${topWords.map(w => w.word).join(', ')}`);
      
      // Füge zu kontextuellen Mustern hinzu
      topWords.forEach(w => {
        sharedKB.addContextualPattern(primarySituation, w.word, 'word');
      });
    }

    if (avoidPatterns.length > 0) {
      const topAvoid = avoidPatterns.slice(0, 5);
      insights.push(`Diese Wörter/Muster sollten vermieden werden: ${topAvoid.map(a => a.word).join(', ')}`);
      recommendations.push(`Vermeide: ${topAvoid.map(a => a.word).join(', ')}`);
      
      topAvoid.forEach(a => {
        sharedKB.addFeedbackKnowledge(primarySituation, a.word, 'avoid');
      });
    }

    if (relevantPatterns.length > 0) {
      insights.push(`${relevantPatterns.length} bewährte Antwort-Muster gefunden`);
      recommendations.push(`Orientiere dich an diesen Mustern: ${relevantPatterns[0].pattern.substring(0, 50)}...`);
    }

    if (relevantPrinciples.length > 0) {
      insights.push(`${relevantPrinciples.length} Prinzipien aus Feedback gefunden`);
      recommendations.push(`Befolge diese Prinzipien: ${relevantPrinciples[0].substring(0, 100)}...`);
    }

    // Schreibe in Shared Knowledge Base
    sharedKB.writeAgentInsights('learningIntegrator', insights, recommendations, {
      relevantWords: relevantWords.slice(0, 10),
      relevantPatterns: relevantPatterns.slice(0, 5),
      avoidPatterns: avoidPatterns.slice(0, 10),
      relevantPrinciples: relevantPrinciples
    });

    // Füge Priority Guidance hinzu
    if (recommendations.length > 0) {
      recommendations.forEach(rec => {
        sharedKB.addPriorityGuidance(rec, 'high', 'learningIntegrator');
      });
    }

    console.log(`✅ Agent: Learning Integrator - ${insights.length} Erkenntnisse, ${recommendations.length} Empfehlungen für "${primarySituation}"`);

    return {
      success: true,
      enriched: true,
      insights,
      recommendations,
      relevantWords: relevantWords.slice(0, 10),
      relevantPatterns: relevantPatterns.slice(0, 5),
      avoidPatterns: avoidPatterns.slice(0, 10)
    };
  } catch (err) {
    console.warn('⚠️ Agent: Learning Integrator - Fehler:', err.message);
    return { success: false, enriched: false };
  }
}

/**
 * 🧠 Agent: Knowledge Synthesizer
 * Synthetisiert alle Agent-Ergebnisse und Learning-Wissen zu einer intelligenten Zusammenfassung
 */
async function agentKnowledgeSynthesizer(allAgentResults, customerMessage, sharedKB) {
  const client = getClient();
  if (!client || !sharedKB) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Knowledge Synthesizer - Fallback');
    return {
      synthesizedKnowledge: '',
      keyInsights: [],
      actionableGuidance: '',
      priorityInsights: [],
      success: false
    };
  }

  try {
    // Sammle alle Erkenntnisse aus Shared Knowledge Base
    const allInsights = sharedKB.readAllInsights();
    const priorityGuidance = sharedKB.getPriorityGuidance();
    const learningStats = sharedKB.getLearningStats();

    // Baue Zusammenfassung aller Agent-Ergebnisse
    const agentSummary = [];
    if (allAgentResults.context) {
      agentSummary.push(`Kontext: ${allAgentResults.context.topic || 'allgemein'}`);
    }
    if (allAgentResults.situation && allAgentResults.situation.detectedSituations) {
      agentSummary.push(`Situationen: ${allAgentResults.situation.detectedSituations.join(', ')}`);
    }
    if (allAgentResults.training && allAgentResults.training.selectedExamples) {
      agentSummary.push(`${allAgentResults.training.selectedExamples.length} Training-Beispiele gefunden`);
    }
    if (allAgentResults.exampleIntelligence && allAgentResults.exampleIntelligence.bestExamples) {
      agentSummary.push(`${allAgentResults.exampleIntelligence.bestExamples.length} intelligente Beispiele analysiert`);
    }
    // 🧠 NEU: Conversation Flow Analyzer Erkenntnisse
    if (allAgentResults.flowAnalysis && allAgentResults.flowAnalysis.success) {
      if (allAgentResults.flowAnalysis.activeContext && allAgentResults.flowAnalysis.activeContext.currentTopic) {
        agentSummary.push(`Aktuelles Thema: ${allAgentResults.flowAnalysis.activeContext.currentTopic}`);
      }
      if (allAgentResults.flowAnalysis.outdatedContext && allAgentResults.flowAnalysis.outdatedContext.oldTopics && allAgentResults.flowAnalysis.outdatedContext.oldTopics.length > 0) {
        agentSummary.push(`${allAgentResults.flowAnalysis.outdatedContext.oldTopics.length} veraltete Themen (ignorieren)`);
      }
    }
    
    // 🧠 NEU: Ambiguity Resolver Erkenntnisse
    if (allAgentResults.ambiguity && allAgentResults.ambiguity.success && allAgentResults.ambiguity.resolvedMeaning) {
      agentSummary.push(`Mehrdeutige Phrase interpretiert: "${allAgentResults.ambiguity.resolvedMeaning}"`);
    }

    // Sammle alle Insights und Recommendations
    const allAgentInsights = [];
    const allAgentRecommendations = [];
    
    Object.entries(allInsights).forEach(([agentName, data]) => {
      if (data.insights && data.insights.length > 0) {
        allAgentInsights.push(...data.insights.map(i => `[${agentName}] ${i}`));
      }
      if (data.recommendations && data.recommendations.length > 0) {
        allAgentRecommendations.push(...data.recommendations.map(r => `[${agentName}] ${r}`));
      }
    });

    // 🧠 NEU: Extrahiere Learning-Erkenntnisse aus Learning Integrator
    const learningIntegratorInsights = allInsights['learningIntegrator'] || {};
    const learningData = learningIntegratorInsights.data || {};
    const learningWords = learningData.relevantWords || [];
    const learningPatterns = learningData.relevantPatterns || [];
    const learningAvoid = learningData.avoidPatterns || [];

    // Erstelle Learning-Wissen-Sektion für Synthese-Prompt
    let learningKnowledgeSection = '';
    if (learningStats && (learningWords.length > 0 || learningPatterns.length > 0 || learningAvoid.length > 0)) {
      learningKnowledgeSection = '\n\n🧠 LEARNING-WISSEN (AUS FEEDBACK GELERNT):\n';
      
      if (learningWords.length > 0) {
        const topWords = learningWords.slice(0, 5).map(w => `${w.word} (Score: ${(w.score * 100).toFixed(0)}%, ${w.count}x gut)`);
        learningKnowledgeSection += `✅ Wörter die GUT funktionieren: ${topWords.join(', ')}\n`;
      }
      
      if (learningPatterns.length > 0) {
        const topPatterns = learningPatterns.slice(0, 3).map(p => `${p.pattern.substring(0, 50)}... (${(p.successRate * 100).toFixed(0)}% Erfolgsrate)`);
        learningKnowledgeSection += `✅ Bewährte Antwort-Muster: ${topPatterns.join(' | ')}\n`;
      }
      
      if (learningAvoid.length > 0) {
        const topAvoid = learningAvoid.slice(0, 5).map(a => `${a.word} (${a.reason})`);
        learningKnowledgeSection += `❌ Wörter/Muster die VERMIEDEN werden sollten: ${topAvoid.join(', ')}\n`;
      }
    }

    // 🧠 NEU: Conversation Flow Analyzer Erkenntnisse (HÖCHSTE PRIORITÄT für Vorwärts-Bewegung!)
    const flowAnalysisInsights = [];
    if (allAgentResults.flowAnalysis && allAgentResults.flowAnalysis.success) {
      if (allAgentResults.flowAnalysis.activeContext) {
        if (allAgentResults.flowAnalysis.activeContext.currentTopic) {
          flowAnalysisInsights.push(`🚨 AKTUELLES THEMA: "${allAgentResults.flowAnalysis.activeContext.currentTopic}" - Reagiere NUR darauf!`);
        }
        if (allAgentResults.flowAnalysis.activeContext.isResponseToLastModeratorMessage) {
          flowAnalysisInsights.push(`✅ Kunde antwortet auf letzte Moderator-Nachricht`);
        }
        if (allAgentResults.flowAnalysis.activeContext.referenceMessage) {
          flowAnalysisInsights.push(`📎 Referenz: ${allAgentResults.flowAnalysis.activeContext.referenceMessage}`);
        }
      }
      if (allAgentResults.flowAnalysis.outdatedContext && allAgentResults.flowAnalysis.outdatedContext.oldTopics && allAgentResults.flowAnalysis.outdatedContext.oldTopics.length > 0) {
        flowAnalysisInsights.push(`🚫 VERALTETE THEMEN (ABSOLUT IGNORIEREN!): ${allAgentResults.flowAnalysis.outdatedContext.oldTopics.join(', ')}`);
        flowAnalysisInsights.push(`⚠️ Grund: ${allAgentResults.flowAnalysis.outdatedContext.reason || 'Nicht mehr in letzten 5 Nachrichten erwähnt'}`);
      }
      if (allAgentResults.flowAnalysis.forwardMovement) {
        if (allAgentResults.flowAnalysis.forwardMovement.shouldStartNewTopic) {
          flowAnalysisInsights.push(`➡️ VORWÄRTS-BEWEGUNG: Starte neues Thema, gehe vorwärts!`);
        }
        if (allAgentResults.flowAnalysis.forwardMovement.shouldContinueCurrentTopic) {
          flowAnalysisInsights.push(`➡️ VORWÄRTS-BEWEGUNG: Setze aktuelles Thema fort, aber gehe vorwärts!`);
        }
        if (allAgentResults.flowAnalysis.forwardMovement.topicsToIgnore && allAgentResults.flowAnalysis.forwardMovement.topicsToIgnore.length > 0) {
          flowAnalysisInsights.push(`🚫 IGNORIERE diese Themen: ${allAgentResults.flowAnalysis.forwardMovement.topicsToIgnore.join(', ')}`);
        }
      }
    }
    
    // 🧠 NEU: Ambiguity-Erkenntnisse extrahieren
    const ambiguityInsights = [];
    if (allAgentResults.ambiguity && allAgentResults.ambiguity.success) {
      if (allAgentResults.ambiguity.resolvedMeaning) {
        ambiguityInsights.push(`🚨 MEHRDEUTIGE PHRASE INTERPRETIERT: "${allAgentResults.ambiguity.resolvedMeaning}"`);
      }
      if (allAgentResults.ambiguity.profileConnections && allAgentResults.ambiguity.profileConnections.length > 0) {
        ambiguityInsights.push(`🔗 Profil-Verbindungen: ${allAgentResults.ambiguity.profileConnections.join(', ')}`);
      }
      if (allAgentResults.ambiguity.sexualContext) {
        ambiguityInsights.push(`🚨 SEXUELLER KONTEXT ERKANNT - direkte sexuelle Antwort ist ERWÜNSCHT!`);
      }
      if (allAgentResults.ambiguity.interpretation) {
        ambiguityInsights.push(`💡 Interpretation: ${allAgentResults.ambiguity.interpretation}`);
      }
    }
    
    // Erstelle Synthese-Prompt
    const synthesisPrompt = `Synthetisiere alle Erkenntnisse und erstelle eine intelligente Zusammenfassung für die Nachrichtengenerierung.

Kundennachricht: "${customerMessage.substring(0, 200)}"

Agent-Ergebnisse:
${agentSummary.join('\n')}

Agent-Insights:
${allAgentInsights.slice(0, 10).join('\n')}

${flowAnalysisInsights.length > 0 ? `\n🧠🧠🧠🧠🧠 CONVERSATION FLOW ANALYZER (ABSOLUT KRITISCH - VORWÄRTS-BEWEGUNG!): 🧠🧠🧠🧠🧠\n${flowAnalysisInsights.join('\n')}\n\n🚨🚨🚨 KRITISCH: Gehe VORWÄRTS, nicht zurück! IGNORIERE veraltete Themen! 🚨🚨🚨\n` : ''}

${ambiguityInsights.length > 0 ? `\n🧠🧠🧠 MEHRDEUTIGKEITS-ERKENNTNISSE (HÖCHSTE PRIORITÄT!): 🧠🧠🧠\n${ambiguityInsights.join('\n')}\n` : ''}

Agent-Empfehlungen:
${allAgentRecommendations.slice(0, 10).join('\n')}
${learningKnowledgeSection}
Priority Guidance (höchste Priorität):
${priorityGuidance.slice(0, 5).map(g => `[${g.priority}] ${g.guidance}`).join('\n')}

Antworte NUR als JSON:
{
  "synthesizedKnowledge": "Intelligente Zusammenfassung aller Erkenntnisse (max 500 Zeichen)",
  "keyInsights": ["wichtigste Erkenntnis 1", "wichtigste Erkenntnis 2"],
  "actionableGuidance": "Konkrete Anleitung was die KI tun soll (max 300 Zeichen)",
  "priorityInsights": ["höchste Priorität 1", "höchste Priorität 2"]
}

WICHTIG:
- Synthetisiere alle Erkenntnisse zu einer kohärenten Zusammenfassung
- Identifiziere die wichtigsten Erkenntnisse
- Erstelle konkrete, umsetzbare Anleitungen
- Priorisiere nach Wichtigkeit`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du synthetisierst Erkenntnisse und erstellst intelligente Zusammenfassungen. Antworte IMMER nur als JSON.' },
          { role: 'user', content: synthesisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 800
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          const synthesizedKnowledge = {
            synthesizedKnowledge: parsed.synthesizedKnowledge || '',
            keyInsights: parsed.keyInsights || [],
            actionableGuidance: parsed.actionableGuidance || '',
            priorityInsights: parsed.priorityInsights || [],
            allAgentInsights: allAgentInsights,
            allAgentRecommendations: allAgentRecommendations,
            priorityGuidance: priorityGuidance.slice(0, 10)
          };

          // Speichere in Shared Knowledge Base
          sharedKB.setSynthesizedKnowledge(synthesizedKnowledge);

          console.log(`✅ Agent: Knowledge Synthesizer - Synthese abgeschlossen: ${synthesizedKnowledge.keyInsights.length} Key Insights, ${synthesizedKnowledge.priorityInsights.length} Priority Insights`);

          return {
            ...synthesizedKnowledge,
            success: true
          };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Knowledge Synthesizer - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Agent: Knowledge Synthesizer - Fehler:', err.message);
  }

  // Fallback
  return {
    synthesizedKnowledge: '',
    keyInsights: [],
    actionableGuidance: '',
    priorityInsights: [],
    success: false
  };
}

/**
 * Agent: Rule Interpreter
 * Löst Widersprüche zwischen Regeln und Training-Daten
 */
async function agentRuleInterpreter(allRules, trainingExamples, situations = []) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Rule Interpreter - Fallback');
    return {
      resolvedRules: allRules,
      priority: 'examples', // Default: Training-Daten haben Vorrang (wie in Grundregeln)
      guidance: 'Training-Daten haben höchste Priorität. Orientiere dich an den Beispielen.',
      success: false
    };
  }

  // 🚨 OPTIMIERUNG: Kürzerer, fokussierterer Prompt + kürzerer Timeout
  // Wenn kein Training-Daten vorhanden, sofort Fallback (Agent nicht kritisch)
  if (!trainingExamples || trainingExamples.length === 0) {
    return {
      hasConflict: false,
      conflictDescription: '',
      priority: 'rules',
      guidance: 'Keine Training-Beispiele verfügbar - folge den Regeln.',
      resolvedRules: allRules,
      success: false
    };
  }

  try {
    // Vereinfachter Prompt - nur Top 2 Beispiele statt 3
    const rulesText = allRules ? JSON.stringify(allRules, null, 2).substring(0, 800) : 'Keine Regeln';
    const examplesText = trainingExamples.slice(0, 2).map((ex, idx) => 
      `${idx + 1}. Kunde: "${(ex.customerMessage || '').substring(0, 100)}"\n   Antwort: "${(ex.moderatorResponse || '').substring(0, 150)}"`
    ).join('\n\n');

    const analysisPrompt = `Analysiere Widersprüche zwischen Regeln und Training-Daten.

Regeln (Kurz): ${rulesText.substring(0, 400)}

Top 2 Training-Beispiele:
${examplesText}

Situationen: ${situations.slice(0, 3).join(', ') || 'keine'}

Antworte NUR als JSON:
{"hasConflict": true/false, "priority": "rules"|"examples", "guidance": "kurze Anleitung (max 100 Zeichen)"}`;

    // 🚨 OPTIMIERUNG: Kürzerer Timeout (5s statt 10s) - Agent nicht kritisch
    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du löst Widersprüche. Antworte NUR als JSON, max 100 Zeichen für guidance.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 200 // Reduziert von 400
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)) // Reduziert von 10s
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          
          if (parsed.hasConflict) {
            console.log(`⚠️ Agent: Rule Interpreter - Widerspruch erkannt`);
            console.log(`📊 Priorität: ${parsed.priority === 'examples' ? 'Training-Daten' : 'Regeln'}`);
          } else {
            console.log(`✅ Agent: Rule Interpreter - Keine Widersprüche erkannt`);
          }
          
          return {
            hasConflict: parsed.hasConflict || false,
            conflictDescription: parsed.conflictDescription || '',
            priority: parsed.priority || 'examples', // Default: Training-Daten (wie in Grundregeln)
            guidance: parsed.guidance || 'Training-Daten haben höchste Priorität. Orientiere dich an den Beispielen.',
            resolvedRules: parsed.resolvedRules || allRules,
            success: true
          };
        }
      } catch (e) {
        console.warn('⚠️ Agent: Rule Interpreter - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    // 🚨 OPTIMIERUNG: Bei Timeout oder Fehler, sinnvollen Fallback geben
    if (err.message && err.message.includes('Timeout')) {
      console.warn('⚠️ Agent: Rule Interpreter - Timeout (nicht kritisch, verwende Fallback)');
    } else {
      console.warn('⚠️ Agent: Rule Interpreter - Fehler:', err.message);
    }
  }

  // 🚨 VERBESSERTER FALLBACK: Sinnvolle Default-Guidance statt leer
  // Default: Training-Daten haben Vorrang (wie in Grundregeln definiert)
  return {
    hasConflict: false,
    conflictDescription: '',
    priority: 'examples', // Default: Training-Daten (konsistent mit Grundregeln)
    guidance: 'Training-Daten haben höchste Priorität. Orientiere dich an den Beispielen. Regeln sind als Sicherheitsnetz vorhanden.',
    resolvedRules: allRules,
    success: false
  };
}

/**
 * 🧠🧠🧠 Agent: Deep Learning
 * Extrahiert intelligente Muster aus Training-Daten und Feedbacks:
 * - Kausale Zusammenhänge (Ursache → Wirkung)
 * - Emotionale Wirkung
 * - Temporale Muster
 * - Kunden-Typ-Erkennung
 * - Erfolgs-Pfade (Sequenzen)
 * - Meta-Prinzipien
 */
async function agentDeepLearning(customerMessage, situations = [], trainingData = null, feedbackData = null) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Deep Learning - Fallback');
    return {
      deepContext: '',
      success: false
    };
  }

  try {
    const { getLearningStats, extractDeepPatterns, generateDeepLearningContext } = require('./learning-system');
    
    // Lade Learning Stats
    let learningStats = await getLearningStats();
    
    // Prüfe, ob Deep Patterns bereits extrahiert wurden
    let deepPatterns = learningStats?.deepPatterns || null;
    
    // Wenn keine Deep Patterns vorhanden ODER älter als 7 Tage, extrahiere neu
    if (!deepPatterns || !deepPatterns.lastUpdated) {
      console.log('🧠🧠🧠 Deep Patterns nicht vorhanden - starte Extraktion aus bestehenden Daten...');
      
      // Extrahiere Deep Patterns aus bestehenden Daten
      deepPatterns = await extractDeepPatterns(trainingData, feedbackData, learningStats);
      
      if (!deepPatterns) {
        console.warn('⚠️ Deep Pattern Extraction fehlgeschlagen - verwende leeren Context');
        return {
          deepContext: '',
          success: false
        };
      }
    } else {
      // Prüfe, ob Patterns zu alt sind (> 7 Tage)
      const lastUpdated = new Date(deepPatterns.lastUpdated);
      const daysSinceUpdate = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSinceUpdate > 7) {
        console.log(`🧠🧠🧠 Deep Patterns sind ${daysSinceUpdate.toFixed(1)} Tage alt - aktualisiere...`);
        // Aktualisiere im Hintergrund (non-blocking)
        extractDeepPatterns(trainingData, feedbackData, learningStats).catch(err => {
          console.warn('⚠️ Background Deep Pattern Update fehlgeschlagen:', err.message);
        });
      }
    }
    
    // Generiere Deep Learning Context für Prompt
    const deepContext = generateDeepLearningContext(situations, deepPatterns, customerMessage);
    
    console.log('✅ Agent: Deep Learning - Intelligente Muster extrahiert und Context generiert');
    
    return {
      deepContext,
      deepPatterns,
      success: true
    };
    
  } catch (err) {
    console.warn('⚠️ Agent: Deep Learning - Fehler:', err.message);
    return {
      deepContext: '',
      success: false
    };
  }
}

module.exports = {
  agentContextAnalyst,
  agentProfileFilter,
  agentTrainingSelector,
  agentRulesApplicator,
  agentImageAnalyst,
  agentStyleAnalyst,
  agentMoodAnalyst,
  agentProactiveAnalyst,
  agentMessageGenerator,
  agentExampleIntelligence,
  agentMeetingResponse,
  agentAmbiguityResolver,
  agentConversationFlowAnalyzer,
  agentResponseValidator,
  agentRuleInterpreter,
  agentLearningIntegrator,
  agentDeepLearning, // 🧠🧠🧠 NEU: Deep Learning Agent
  agentKnowledgeSynthesizer,
  agentFirstMessageDetector, // 🆕 NEU: Export für First-Message-Pfad
  runMultiAgentPipeline,
  validateMessageQuality,
  validateCriticalRules,
  getSharedKnowledgeBase,
  resetSharedKnowledgeBase,
  SharedKnowledgeBase
};
