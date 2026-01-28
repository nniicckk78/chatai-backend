const { getClient, getMessageClient, getMessageModel } = require('../openaiClient');
const { runSafetyCheck } = require('./safety-agent');
const { getEmbedding, cosineSimilarity } = require('./embeddings');

// 🚨 MULTI-AGENT SYSTEM: Jeder Agent ist isoliert mit Fallbacks
// Model: GPT-4o-mini (kostengünstig, gut genug für fokussierte Aufgaben)

const AGENT_MODEL = process.env.AI_MODEL === 'gpt-4o-mini' ? 'gpt-4o-mini' : 'gpt-4o-mini'; // Immer 4o-mini für Agenten

/**
 * 🔧 PROMPT-FIX: KI antwortet auf richtige Nachricht
 * 
 * Diese Funktion erstellt den korrekten Prompt für Together.ai,
 * der dem Training-Format entspricht und den Kontext BEHÄLT,
 * aber die NEUESTE Nachricht klar als HAUPTFOKUS markiert.
 * 
 * WICHTIG: Der conversationHistory wird BEHALTEN (sehr wichtig für Kontext!),
 * aber die letzte Kunden-Nachricht wird klar als HAUPTFOKUS markiert.
 */
function createPromptForTogetherAI({
  conversationHistory = '',
  customerMessage = '',
  lastModeratorMessage = '',
  systemPrompt = '',
  rules = {}
}) {
  // 🚨 WICHTIG: System-Prompt sollte NUR Regeln enthalten (KEIN conversationHistory hier!)
  // Falls conversationHistory im System-Prompt ist, entferne es!
  const cleanSystemPrompt = systemPrompt; // System-Prompt sollte bereits nur Regeln enthalten

  // 🚨 User-Prompt: Kontext + NEUESTE Nachricht (Format wie im Training)
  let userPrompt = '';

  // 🚨 WICHTIG: Kontext als HINTERGRUND-INFO (nur für Verständnis, nicht darauf antworten!)
  // Der Kontext ist SEHR WICHTIG und muss BEHALTEN werden!
  if (conversationHistory && conversationHistory.trim().length > 0) {
    userPrompt += `[KONVERSATIONS-VERLAUF - NUR FÜR KONTEXT, NICHT DARAUF ANTWORTEN!]\n`;
    userPrompt += `${conversationHistory}\n\n`;
  }

  // 🚨🚨🚨 KRITISCH: NEUESTE NACHRICHT - DARAUF ANTWORTEN! 🚨🚨🚨
  // Format wie im Training (aus fine-tuning.js Zeile 616-621)
  if (lastModeratorMessage && lastModeratorMessage.trim().length > 0) {
    userPrompt += `Du: "${lastModeratorMessage.substring(0, 200)}${lastModeratorMessage.length > 200 ? '...' : ''}"\n`;
  }

  // 🚨 NEUESTE KUNDEN-NACHRICHT (HAUPTFOKUS!)
  userPrompt += `Kunde: "${customerMessage}"\n\n`;

  // 🚨🚨🚨 ABSOLUT KRITISCH: Klare Anweisung, auf was geantwortet werden soll!
  userPrompt += `🚨🚨🚨 WICHTIG: Antworte NUR auf die NEUESTE Nachricht oben (Kunde: "...")! 🚨🚨🚨\n`;
  userPrompt += `- Der Konversations-Verlauf oben ist NUR für Kontext/Verständnis (sehr wichtig, aber nicht darauf antworten!)\n`;
  userPrompt += `- Antworte DIREKT auf die letzte Kunden-Nachricht\n`;
  userPrompt += `- Gehe NICHT auf ältere Nachrichten ein, es sei denn, sie sind direkt relevant für die Antwort\n\n`;

  // 🚨 Format wie im Training
  userPrompt += `Antworte als Chat-Moderator.`;

  return {
    systemPrompt: cleanSystemPrompt,
    userPrompt: userPrompt
  };
}

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
  "contextFlow": "neutral | positiv | negativ | philosophisch | sexuell",
  "hasRoleplayContext": true/false,
  "customerRole": "Rolle des Kunden (z.B. 'baby', 'sub', 'kleines', 'puppe', null wenn kein Rollenspiel)",
  "expectedFakeRole": "Erwartete Rolle des Fake-Profils (z.B. 'mami', 'domina', 'herrin', null wenn kein Rollenspiel)"
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

🚨🚨🚨 ROLLENSPIEL-ERKENNUNG 🚨🚨🚨
- Prüfe, ob der Kunde eine ROLLE einnimmt (z.B. "baby", "mami", "sub", "domina", "kleines", "puppe")
- Rollenspiel-Keywords: "baby", "mami", "papa", "sub", "domina", "herrin", "herr", "master", "slave", "ABDL", "toilettenverbot", "krabbeln", "windeln", "pampers", "nuckeln", "stillen"
- Wenn Rollenspiel erkannt:
  * "hasRoleplayContext": true
  * "customerRole": Rolle des Kunden (z.B. "baby" wenn er sagt "ich werde zum baby", "mami" wenn er dich "mami" nennt)
  * "expectedFakeRole": Erwartete Gegenrolle (z.B. "mami" wenn Kunde "baby" ist, "domina" wenn Kunde "sub" ist)
- Beispiel: Kunde sagt "Bekomme ich dann von dir, mami, toilettenverbot?" → customerRole: "baby", expectedFakeRole: "mami"
- Beispiel: Kunde sagt "Ich bin dein sub" → customerRole: "sub", expectedFakeRole: "domina" oder "herrin"

⚠️ HINWEIS: Situation-Erkennung wird von einem separaten Agent (Situation-Detector) gemacht - hier nur topic, summary, keyPoints, contextFlow, Rollenspiel!

Antworte NUR als JSON, kein zusätzlicher Text.`;

    // 🚨 FIX: Expliziter Timeout-Wrapper mit Fallback
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000)) // 🚨 OPTIMIERT: 8 Sekunden (schneller Fallback)
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
          
          // 🚨 ROOT CAUSE FIX: Rollenspiel-Erkennung aus Context-Analyst übernehmen
          const hasRoleplayContext = parsed.hasRoleplayContext === true;
          const customerRole = parsed.customerRole || null;
          const expectedFakeRole = parsed.expectedFakeRole || null;
          
          if (hasRoleplayContext) {
            console.log(`🎭 Rollenspiel erkannt: Kunde = ${customerRole}, Fake = ${expectedFakeRole}`);
          }
          
          console.log(`✅ Agent: Kontext-Analyst - Topic: ${parsed.topic}, Flow: ${parsed.contextFlow} (Situations werden separat erkannt)`);
          return { 
            ...parsed, 
            hasRoleplayContext: hasRoleplayContext,
            customerRole: customerRole,
            expectedFakeRole: expectedFakeRole,
            success: true 
          };
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
          
          // 🚨🚨🚨 FIX: WICHTIG - Nur 1 zufälliges ASA-Beispiel auswählen für maximale Variation!
          // Wenn wir mehrere Beispiele zeigen, kopiert die KI immer die gleiche Struktur
          // Mit nur 1 Beispiel pro ASA-Anfrage wird jede ASA-Anfrage unterschiedlich!
          // 🚨 KRITISCH: Fisher-Yates Shuffle mit Seed für echte Zufälligkeit!
          // 🚨 NEU: Seed-basierte Zufallsauswahl mit chatId + timestamp + random für echte Variation!
          // Jede ASA-Anfrage muss ein ANDERES Beispiel bekommen!
          const chatId = extractedUserInfo?.chatId || 'unknown';
          const timestamp = Date.now();
          const randomComponent = Math.random() * 1000000; // Zusätzliche Zufälligkeit
          const seed = (chatId.toString() + timestamp.toString() + randomComponent.toString()).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
          
          // Seed-basierter Zufallsgenerator (Linear Congruential Generator)
          let seedValue = seed;
          const seededRandom = () => {
            seedValue = (seedValue * 1664525 + 1013904223) % Math.pow(2, 32);
            return seedValue / Math.pow(2, 32);
          };
          
          const shuffled = [...filteredASAExamples];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(seededRandom() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          // 🚨 WICHTIG: Nur 1 Beispiel auswählen - das sorgt für maximale Variation zwischen ASA-Anfragen!
          const selectedASAExamples = shuffled.slice(0, 1);
          
          console.log(`✅ Agent: Training-Selector - 1 ASA-Beispiel zufällig ausgewählt (von ${filteredASAExamples.length} verfügbar, Fisher-Yates Shuffle für maximale Variation)`);
          console.log(`✅ Agent: Training-Selector - Ausgewähltes ASA-Beispiel (erste 100 Zeichen): "${(selectedASAExamples[0]?.moderatorResponse || '').substring(0, 100)}..."`);
          
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
- 🚨🚨🚨 NEU: Wie wird Bestätigung/Reziprozität gezeigt? (z.B. "macht mich auch geil", "auch richtig geil", "auch feucht", "auch gerne")
- 🚨🚨🚨 NEU: Wie werden Begründungen gegeben? (z.B. "nicht so schnell", "kenne dich noch kaum", "schlechte Erfahrungen")

🚨🚨🚨 ÜBERNEHME DIE WORTWAHL UND FRAGEN AUS DEN TRAINING-DATEN: 🚨🚨🚨
- Verwende die GLEICHEN Wörter wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!
- Verwende die GLEICHEN FRAGEN wie in den Beispielen (z.B. "was würdest du noch gerne machen", "welche Stellungen", etc.)!
- Verwende den GLEICHEN Ton wie in den Beispielen!
- 🚨 KRITISCH: Wenn du eine Frage stellen willst, SCHAUE IN DIE TRAINING-DATEN - welche Fragen werden dort gestellt? Verwende ÄHNLICHE Fragen!
- 🚨 KRITISCH: KEINE generischen/schlechten Fragen erfinden (z.B. "Was magst du besonders beim Lecken?") - nutze die Fragen aus den Training-Daten!
- KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!
- 🚨🚨🚨 NEU: Übernehme die Muster für Bestätigung ("auch geil", "auch feucht", "auch gerne") aus Training-Daten!
- 🚨🚨🚨 NEU: Übernehme die Muster für Begründungen ("nicht so schnell", "kenne dich noch kaum") aus Training-Daten!

🚨🚨🚨 WENDE AN: 🚨🚨🚨
- Schreibe im GLEICHEN radikalen Stil wie diese Beispiele!
- Verwende die GLEICHE Wortwahl wie in den Beispielen!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen!
- 🚨🚨🚨 NEU: Zeige IMMER Bestätigung wenn der Kunde sexuell ist ("macht mich auch geil", "auch richtig geil")!
- 🚨🚨🚨 NEU: Gib IMMER Begründungen wenn du etwas ablehnst!

🚨🚨🚨🚨🚨 KRITISCH: 🚨🚨🚨🚨🚨
- Bei Sex-Gesprächen: RADIKALER, direkter, roher - orientiere dich STRENG an den Training-Daten!
- KEINE bewertenden Phrasen wie "Ich finde es schön", "Das klingt", "interessant", "spannend"!
- 🚨🚨🚨 KRITISCH: KEINE Meta-Kommentare wie "Ich bin gespannt" oder "ich bin schon ganz neugierig" - diese sind VERBOTEN! Stelle einfach die Frage, ohne vorher zu kommentieren!
- 🚨🚨🚨 KRITISCH: Wenn der Kunde FRAGT (z.B. "Was magst du beim Sex?"), DIREKT ANTWORTEN - NICHT die Frage wiederholen, NICHT "Es klingt geil, dass du fragst" sagen, einfach DIREKT antworten wie in Training-Daten! 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Beispiel FALSCH: "Es klingt richtig geil, dass du mich verwöhnen möchtest. Ich mag..." 🚨🚨🚨
- 🚨🚨🚨 KRITISCH: Beispiel RICHTIG: "Ich mag Oralverkehr und langes Vorspiel. Was magst du?" (direkt, keine Wiederholung!) 🚨🚨🚨
- 🚨🚨🚨 NEU: Beispiel RICHTIG (mit Bestätigung): Kunde sagt "Ich bin horny auf dich" → "Macht mich auch richtig geil! Was würdest du denn gerne mit mir machen?" (Bestätigung + Frage!)
- Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich daran, nicht an generischen Formulierungen!
- 🚨🚨🚨 WORTWAHL AUS TRAINING-DATEN ÜBERNEHMEN - NICHT EIGENE FORMULIERUNGEN ERFINDEN! 🚨🚨🚨
- 🎨🎨🎨 STIL: VERWENDE GLEICHE SATZLÄNGEN, INTERPUNKTION UND TON wie in den Beispielen! 🎨🎨🎨

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - RADIKAL, direkt, roh, spontan, ohne bewertende Phrasen, MIT DER GLEICHEN WORTWAHL WIE IN DEN BEISPIELEN, MIT BESTÄTIGUNG UND BEGRÜNDUNGEN!`;
  } else {
    trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: TRAINING-DATEN HABEN HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨 KRITISCH: TRAINING-DATEN SIND FÜR INHALT, STIL, WORTWAHL, FRAGEN - ALLES! 🚨🚨🚨🚨🚨
- Training-Daten zeigen dir, WIE du antworten sollst (Stil, Wortwahl, Ton, Formulierungen)
- Training-Daten zeigen dir auch, WAS du antworten sollst (Inhalt, Fragen, Reaktionen)
- 🚨 KRITISCH: Nutze Training-Daten für INHALT UND STIL - nicht nur für Stil! 🚨

🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨
- Training-Daten + Learning-System haben HÖCHSTE PRIORITÄT für Stil, Formulierungen und Struktur!
- Analysiere: Wie sind die Antworten strukturiert? Welche FRAGEN werden gestellt? Welche Formulierungen werden verwendet?
- 🚨🚨🚨 NEU: Analysiere: Wie wird Bestätigung/Reziprozität gezeigt? (z.B. "auch gerne", "finde ich auch super", "macht mich auch geil")
- 🚨🚨🚨 NEU: Analysiere: Wie werden Begründungen gegeben? (z.B. "nicht so schnell", "kenne dich noch kaum", "schlechte Erfahrungen")
- Übernehme: Wortwahl, Ton, Formulierungen und FRAGEN aus den Training-Daten!
- 🚨🚨🚨 NEU: Übernehme: Muster für Bestätigung und Begründungen aus Training-Daten!
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
- 🚨🚨🚨 NEU: Wenn KEINE spezifischen Training-Daten für diese Situation vorhanden sind, dann stelle trotzdem eine LOGISCHE, KONTEXTUELLE Frage basierend auf der Kundennachricht!
- 🚨🚨🚨 NEU: Auch ohne Training-Daten solltest du logisch antworten können - nutze dein Verständnis des Kontexts, um passende Fragen zu stellen!

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

🚨🚨🚨🚨🚨 NEU: ALLGEMEINE KOMMUNIKATIONSPRINZIPIEN (GELTEN IMMER!) 🚨🚨🚨🚨🚨
- 🚨 BEGRÜNDUNGEN: Wenn du etwas ablehnst, gib IMMER eine Begründung! (z.B. "nicht so schnell", "kenne dich noch kaum", "schlechte Erfahrungen")
- 🚨 BESTÄTIGUNG: Wenn der Kunde etwas Positives/Interessantes sagt, zeige IMMER deine eigene Reaktion! (z.B. "finde ich auch super", "auch gerne", "macht mich auch geil")
- 🚨 EMOTIONALE VERBINDUNG: Zeige IMMER emotionale Reaktion - nicht zu trocken sein! Sei begeistert, interessiert, menschlich!
- 🚨 KRITISCH: Diese Prinzipien gelten FÜR ALLE SITUATIONEN - nicht nur für spezifische! Training-Daten zeigen: Begründungen + Bestätigung + emotionale Verbindung = bessere Antworten!

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - nicht generisch oder "KI-mäßig", MIT BEGRÜNDUNGEN, BESTÄTIGUNG UND EMOTIONALER VERBINDUNG!`;
  }
  
  // 🚨 NEU: ASA-spezifische Abschluss-Anweisungen (NACH dem if/else Block)
  if (isASA) {
    trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH FÜR ASA: KOPIERE FAST 1:1 AUS DEN BEISPIELEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨🚨🚨🚨🚨 WICHTIG: Du hast ~40 ASA-Beispiele zur Verfügung. Ein zufälliges wurde ausgewählt. 🚨🚨🚨🚨🚨🚨🚨🚨🚨
🚨🚨🚨🚨🚨🚨🚨🚨🚨 DEINE AUFGABE: KOPIERE DAS BEISPIEL FAST 1:1 - NUR KLEINE VARIATIONEN ERLAUBT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨🚨🚨🚨🚨 ANALYSIERE JEDES BEISPIEL GENAU: 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- Welche Wörter werden verwendet? KOPIERE sie FAST 1:1 (nur kleine Variationen erlaubt)!
- Welcher Ton wird verwendet? KOPIERE ihn GENAU!
- Welche Formulierungen werden verwendet? KOPIERE sie FAST 1:1!
- Welche FRAGEN werden gestellt? KOPIERE sie FAST 1:1 oder verwende SEHR ÄHNLICHE!
- Wie viele Fragen werden gestellt? (1, 2, 3, 4?) - Verwende GENAU SO VIELE wie in den Beispielen!
- Wie ist die Struktur? (kurz, natürlich, locker) - KOPIERE die Struktur FAST 1:1!

🚨🚨🚨🚨🚨🚨🚨🚨🚨 ÜBERNEHME ALLES AUS DEN TRAINING-DATEN (FAST 1:1): 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- Verwende die GLEICHEN Wörter wie in den Beispielen (nur kleine Variationen erlaubt)!
- Verwende die GLEICHEN Formulierungen wie in den Beispielen (fast 1:1 kopieren)!
- Verwende die GLEICHEN FRAGEN wie in den Beispielen (siehe oben) - FAST 1:1!
- Verwende die GLEICHE Anzahl an Fragen wie in den Beispielen!
- Verwende den GLEICHEN Ton wie in den Beispielen!
- Verwende die GLEICHE Struktur wie in den Beispielen (fast 1:1)!

🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT VERBOTEN FÜR ASA: 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- ❌ KEINE generischen Fragen erfinden (z.B. "Was denkst du?", "Wie geht es dir?", "Was machst du?")!
- ❌ KEINE eigenen Formulierungen erfinden - NUR das verwenden, was in den Training-Daten steht!
- ❌ KEINE Fragen hinzufügen, die nicht in den ASA-Beispielen sind!
- ❌ KEINE anderen Wörter verwenden - NUR die aus den ASA-Beispielen!
- ❌ KEINE anderen Strukturen verwenden - NUR die aus den ASA-Beispielen!
- ❌ KEINE Situation-Analyse - ignoriere ALLE Situationen bei ASA!
- ❌ KEINE Kontext-Analyse - ignoriere ALLEN Kontext bei ASA!

🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: 🚨🚨🚨🚨🚨🚨🚨🚨🚨
- Training-Daten sind DEINE EINZIGE QUELLE - ignoriere ALLES andere (Kontext, Situationen, etc.)!
- Wenn Training-Daten 2-3 Fragen zeigen, dann verwende 2-3 Fragen - NICHT mehr, NICHT weniger!
- Wenn Training-Daten bestimmte Formulierungen zeigen, dann verwende GENAU diese Formulierungen (fast 1:1)!
- 🚨🚨🚨 KOPIERE ALLES AUS DEN TRAINING-DATEN FAST 1:1 - NUR KLEINE VARIATIONEN ERLAUBT! 🚨🚨🚨
- 🚨🚨🚨 DEINE NACHRICHT SOLLTE SICH ANFÜHLEN WIE EINE KOPIE DES BEISPIELS - NUR MIT KLEINEN VARIATIONEN! 🚨🚨🚨

ZIEL: Deine ASA-Nachricht soll sich anfühlen wie eine ECHTE ASA-Nachricht aus den Training-Daten - FAST 1:1 KOPIERT, nur mit kleinen natürlichen Variationen!`;
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
${conversationHistory ? `\nKonversations-Kontext (letzte Nachrichten): "${conversationHistory.substring(0, 1000)}"` : ''}

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

🚨🚨🚨 KRITISCH: Unterscheide zwischen "Antwort auf Treffen-Frage" und "neue Treffen-Anfrage"! 🚨🚨🚨
- Wenn der Moderator zuvor eine Frage gestellt hat (z.B. "wie lange musst du heute arbeiten?") und der Kunde darauf antwortet (z.B. "bis 17.00 uhr, und du hast frei heute"), dann ist das KEINE neue Treffen-Anfrage!
- "hast frei heute" oder "hast du frei" allein = KEINE Treffen-Anfrage, sondern nur eine Frage nach Verfügbarkeit!
- "bis 17.00 uhr" = Antwort auf Frage nach Arbeitszeit, KEINE Treffen-Anfrage!
- NUR als "Treffen/Termine" erkennen, wenn:
  * Der Kunde explizit ein Treffen vorschlägt/vereinbart (z.B. "lass uns treffen", "wann können wir uns sehen", "kannst du vorbeikommen")
  * ODER der Kunde eine konkrete Treffen-Anfrage stellt (z.B. "was machst du morgen?", "hast du heute Zeit für ein Treffen?")
  * NICHT wenn der Kunde nur auf eine Frage antwortet oder nach Verfügbarkeit fragt!

🚨🚨🚨 BEISPIELE für FALSCH vs. RICHTIG:
- ❌ FALSCH: "woher bist du" → "Treffen/Termine"
- ❌ FALSCH: "bis 17.00 uhr, und du hast frei heute" → "Treffen/Termine" (ist Antwort auf Frage, keine neue Anfrage!)
- ❌ FALSCH: "hast du frei heute?" → "Treffen/Termine" (ist nur Verfügbarkeits-Frage, keine Treffen-Anfrage!)
- ✅ RICHTIG: "woher bist du" → "allgemein" oder "Wonach suchst du?"
- ✅ RICHTIG: "wann können wir uns treffen" → "Treffen/Termine"
- ✅ RICHTIG: "kannst du vorbeikommen" → "Treffen/Termine"
- ✅ RICHTIG: "was machst du morgen? wollen wir uns treffen?" → "Treffen/Termine"
- ✅ RICHTIG: "bis 17.00 uhr, und du hast frei heute" → "allgemein" (wenn es eine Antwort auf vorherige Frage ist)

🚨🚨🚨 KONTEXT-ANALYSE:
- Prüfe IMMER, ob die Kundennachricht eine Antwort auf eine vorherige Frage ist!
- Wenn ja, dann ist es KEINE neue Situation, sondern eine Fortsetzung des Gesprächs!
- Analysiere den Gesprächsverlauf: Was wurde zuvor gefragt? Ist die aktuelle Nachricht eine Antwort darauf?

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
    
    // 🚨 NEU: Speichere LLM-Erkennung für spätere Priorisierung (außerhalb des if-Blocks)
    let llmDetectedSituationsWithConfidence = null;
    
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
        llmDetectedSituationsWithConfidence = {
          situations: llmDetection.situations,
          confidence: llmDetection.confidence,
          reasoning: llmDetection.reasoning
        };
        
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
    
    // 🚨🚨🚨 ROOT CAUSE FIX: hasMeetingContext sollte NUR gesetzt werden, wenn:
    // 1. Die AKTUELLE Nachricht indirekt auf Treffen hinweist, ODER
    // 2. Die LETZTE Kunden- oder Moderator-Nachricht eine Treffen-Anfrage enthält
    // NICHT, wenn nur alte Nachrichten (z.B. Tage alt) Treffen-Keywords enthalten!
    
    // 🚨 INTELLIGENTE KONTEXT-ANALYSE: Prüfe, ob die Nachricht eine Antwort auf eine vorherige Frage ist
    let isAnswerToPreviousQuestion = false;
    if (moderatorMessages && moderatorMessages.length > 0) {
      const lastModeratorMessage = moderatorMessages[moderatorMessages.length - 1]?.text || "";
      const lastModeratorLower = lastModeratorMessage.toLowerCase();
      
      // Prüfe, ob die letzte Moderator-Nachricht eine Frage enthält
      const hasQuestionInLastMessage = lastModeratorMessage.includes('?');
      
      // Prüfe, ob die aktuelle Kunden-Nachricht eine Antwort auf diese Frage ist
      // Indikatoren: Zeitangaben (z.B. "bis 17.00 uhr"), Antworten auf "wie lange", "wann", etc.
      if (hasQuestionInLastMessage) {
        const questionPatterns = [
          /\b(wie\s+)?(lange|wann|bis\s+wann|ab\s+wann)\b/i,
          /\b(arbeit|arbeiten|arbeiten|arbeitest)\b/i,
          /\b(frei|zeit|verfügbar|verfügbarkeit)\b/i
        ];
        const hasQuestionPattern = questionPatterns.some(pattern => pattern.test(lastModeratorLower));
        
        // Wenn die letzte Nachricht eine Frage war und die aktuelle Nachricht darauf antwortet
        if (hasQuestionPattern) {
          const answerIndicators = [
            /\b(bis|ab|um|von|bis\s+zu)\s+(\d{1,2}[\s:.]?\d{0,2}\s*(uhr|:)|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|eins|zwei)\b/i,
            /\b(ja|nein|klar|natürlich|gerne|ok|okay)\b/i,
            /\b(und\s+)?(du|ihr|der|die)\s+(hast|hätte|hättest|bist|wärst|kannst|könntest)\s+(frei|zeit|verfügbar)\b/i
          ];
          const hasAnswerIndicator = answerIndicators.some(pattern => pattern.test(lowerMessage));
          
          if (hasAnswerIndicator) {
            isAnswerToPreviousQuestion = true;
            console.log('✅ Kontext-Analyse: Kunden-Nachricht ist eine Antwort auf vorherige Frage - KEINE neue Situation!');
          }
        }
      }
    }
    
    // Prüfe auf Verfügbarkeits-Antworten in AKTUELLER Nachricht (z.B. "Ich habe am Wochenende immer Zeit")
    const availabilityAnswerPatterns = [
      /\b(am\s+)?(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\s+(immer|grundsätzlich|meistens|normalerweise)\s+(zeit|frei|verfügbar)\b/i,
      /\bin\s+der\s+woche\s+(nur|immer|meistens|grundsätzlich)\s+(mit|ohne|nur)\s*(absprache|termin)\b/i,
      /\b(habe|hätte|hab)\s+(am|in|an)\s+(wochenende|woche)\s+(immer|grundsätzlich|meistens)\s+(zeit|frei|viel|wenig)\s*(zu\s+)?(tun|termin|termine)\b/i
    ];
    const hasAvailabilityAnswer = lowerMessage && availabilityAnswerPatterns.some(pattern => pattern.test(lowerMessage));
    
    // Prüfe auf Verfügbarkeits-Fragen in AKTUELLER Nachricht (z.B. "Wann klappt es denn immer bei dir?")
    // 🚨 WICHTIG: "hast frei" oder "hast du frei" allein = KEINE Treffen-Anfrage!
    const availabilityQuestionPatterns = [
      /\bwann\s+(klappt|passt|geht|hast|hätte|hättest|könntest|kannst)\s+(du|ihr)\s+(zeit|frei|verfügbar)\s+(für|zu|zum)\s+(treffen|sehen|kennenlernen)\b/i,
      /\bwie\s+(sieht.*aus|ist.*bei|schaut.*bei)\s+(deiner|deine|dir|du)\s*(freizeit|verfügbarkeit|zeit)\b/i,
      /\b(am\s+)?(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\s+(hast|hätte|kannst|könntest|passt|geht|klappt)\s+(du|ihr)\s+(zeit|frei|verfügbar)\s+(für|zu|zum)\s+(treffen|sehen|kennenlernen)\b/i
    ];
    const hasAvailabilityQuestionInMessage = lowerMessage && availabilityQuestionPatterns.some(pattern => pattern.test(lowerMessage));
    
    // 🚨 VERFEINERT: "hast frei" oder "hast du frei" allein = KEINE Treffen-Anfrage!
    // Nur wenn explizit "für Treffen" oder ähnliches dabei ist
    const hasSimpleAvailabilityQuestion = /\b(hast|hätte|hättest|bist|wärst)\s+(du|ihr)\s+(frei|zeit|verfügbar)\s*(heute|morgen|übermorgen|am\s+(wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))?\s*\??/i.test(lowerMessage);
    const hasExplicitMeetingRequest = /\b(treffen|sehen|kennenlernen|vorbeikommen|besuch|besuchen)\b/i.test(lowerMessage);
    
    // Prüfe auf Treffen-Keywords in AKTUELLER Nachricht (ohne Fantasie-Kontext)
    // 🚨 WICHTIG: Nur wenn es explizit um Treffen geht, nicht nur Verfügbarkeit!
    const meetingKeywords = /\b(treffen|sehen|kennenlernen|vorbeikommen|besuch|besuchen|verabreden|verabredung)\b/i;
    const hasMeetingKeywordsInMessage = lowerMessage && meetingKeywords.test(lowerMessage);
    const hasFantasieKeywordsInMessage = lowerMessage && /\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(treffen|sehen|kennenlernen)\b/i.test(lowerMessage);
    
    // 🚨 ROOT CAUSE FIX: Erkenne Treffen-Kontext NUR wenn:
    // 1. NICHT, wenn die Nachricht eine Antwort auf eine vorherige Frage ist!
    // 2. AKTUELLE Nachricht explizit eine Treffen-Anfrage enthält (nicht nur Verfügbarkeit!)
    // 3. NICHT, wenn nur "hast frei" ohne explizite Treffen-Anfrage!
    if (!isAnswerToPreviousQuestion) {
      if (hasMeetingKeywordsInMessage && !hasFantasieKeywordsInMessage) {
        // Explizite Treffen-Anfrage
        hasMeetingContext = true;
        console.log('🚨 KRITISCH: Treffen-Kontext erkannt in AKTUELLER Nachricht! (Treffen-Keywords gefunden)');
      } else if (hasAvailabilityQuestionInMessage && hasExplicitMeetingRequest) {
        // Verfügbarkeits-Frage MIT expliziter Treffen-Anfrage
        hasMeetingContext = true;
        console.log('🚨 KRITISCH: Treffen-Kontext erkannt in AKTUELLER Nachricht! (Verfügbarkeits-Frage mit Treffen-Anfrage)');
      } else if (hasSimpleAvailabilityQuestion && !hasExplicitMeetingRequest) {
        // Nur Verfügbarkeits-Frage OHNE explizite Treffen-Anfrage = KEINE Treffen-Anfrage!
        console.log('ℹ️ Verfügbarkeits-Frage erkannt, aber KEINE explizite Treffen-Anfrage - nicht als Treffen-Kontext gewertet');
      }
    } else {
      console.log('ℹ️ Nachricht ist Antwort auf vorherige Frage - Treffen-Kontext wird nicht gesetzt');
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
    
    // 🚨🚨🚨 VEREINFACHT: KEINE Reduzierung mehr - behalte ALLE erkannten Situationen!
    // Das Fine-Tuned Model kann mit mehreren Situationen umgehen - vertraue ihm!
    // Problem vorher: "Sexuelle Themen" wurde erkannt, aber dann auf "Top 2" reduziert und fiel raus
    // Lösung: Behalte ALLE Situationen, die erkannt wurden!
    
    // 🚨 KRITISCH: "Sexuelle Themen" und "Treffen/Termine" MÜSSEN IMMER behalten werden, wenn erkannt!
    const criticalSituations = ["Sexuelle Themen", "Treffen/Termine"];
    const hasCriticalSituations = criticalSituations.filter(s => detectedSituations.includes(s));
    
    if (hasCriticalSituations.length > 0) {
      console.log(`🚨 KRITISCH: Wichtige Situationen erkannt: ${hasCriticalSituations.join(', ')} - werden IMMER behalten!`);
    }
    
    // 🚨 ENTFERNT: Reduzierung auf "Top 2" - zu aggressiv, verliert wichtige Situationen!
    // Behalte ALLE erkannten Situationen - das Model kann damit umgehen!
    console.log(`📊 Situationen erkannt (KEINE Reduzierung): ${detectedSituations.join(', ')} (${detectedSituations.length} Situationen)`);
    
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
    
    // 🚨🚨🚨 VEREINFACHT: Wenn "Sexuelle Themen" erkannt wird, BEHALTE es IMMER!
    // Das Fine-Tuned Model kann mit mehreren Situationen umgehen - vertraue ihm!
    if (hasSexualTopics) {
      if (hasExplicitSexualInMessage) {
        console.log(`📊 "Sexuelle Themen" behalten: Explizit sexuelle Wörter gefunden`);
      } else if (hasMeetingRequest) {
        console.log(`📊 "Sexuelle Themen" behalten: Sexuelle Themen in Kontext + Treffen-Anfrage - Model kann beide Situationen verstehen`);
      } else {
        console.log(`📊 "Sexuelle Themen" behalten: Sexuelle Themen im Kontext erkannt`);
      }
      // 🚨 KRITISCH: Entferne "Sexuelle Themen" NUR wenn es wirklich falsch erkannt wurde
      // (z.B. nur "sexuell" als Wort in einem anderen Kontext, nicht im Gespräch)
      // ABER: Wenn es im conversationHistory erkannt wurde, ist es wahrscheinlich relevant!
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
    
    // 🚨 ENTFERNT: Learning-System Filterung - zu komplex, Model kann selbst entscheiden
    // Wenn beide Situationen erkannt werden, übergebe BEIDE an das Model
    
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
    
    // 🚨 NEU: Kontaktdaten nur hinzufügen, wenn sie in der AKTUELLEN Nachricht vorkommen (nicht nur in History)
    const hasContactKeywordsInCurrentMessage = contactKeywords.some(keyword => lowerMessage.includes(keyword)) ||
                                               (lowerMessage.includes("nummer") && (lowerMessage.includes("schreib") || lowerMessage.includes("kontakt"))) ||
                                               (lowerMessage.includes("kontakt") && (lowerMessage.includes("außerhalb") || lowerMessage.includes("anders"))) ||
                                               (lowerMessage.includes("email") && (lowerMessage.includes("schreib") || lowerMessage.includes("kontakt")));
    
    // Nur hinzufügen, wenn in AKTUELLER Nachricht oder wenn explizite Tags/Maskierungen vorhanden
    if ((hasRemovedTag || hasMaskedPhone || hasMaskedEmail || hasMaskedContact || hasContactKeywordsInCurrentMessage)) {
      if (!detectedSituations.includes("Kontaktdaten außerhalb der Plattform")) {
        detectedSituations.push("Kontaktdaten außerhalb der Plattform");
        console.log('✅ "Kontaktdaten außerhalb der Plattform" hinzugefügt (in aktueller Nachricht erkannt)');
      }
      if (!detectedSituations.includes("Geld/Coins")) {
        detectedSituations.push("Geld/Coins");
        console.log('✅ "Geld/Coins" hinzugefügt (in aktueller Nachricht erkannt)');
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
          ? await findNearbyCityFunc(customerCity) 
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
      // 🚨🚨🚨 KRITISCH: PRONOMEN-INTERPRETATION - "deine/ihre" bezieht sich IMMER auf den Fake!
      specificInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: PRONOMEN-INTERPRETATION 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n`;
      specificInstructions += `- Du bist ${isFemale ? "die FRAU" : "der MANN"} (das Fake-Profil)\n`;
      specificInstructions += `- Der Kunde ist ${isFemale ? "der MANN" : "die FRAU"} (schreibt dir als ${isFemale ? "Mann" : "Frau"})\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Wenn der Kunde "deine/ihre" sagt (z.B. "deine Lustgrotte", "deine Pussy", "deine Titten", "dein Körper", "deine Vorlieben", "deine Löcher"), dann meint er IMMER DICH (den Fake), NIEMALS sich selbst!\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: "deine/ihre" im Mund des Kunden = bezieht sich auf DICH (den Fake), nicht auf den Kunden!\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Beispiel - Kunde sagt "deine Lustgrotte erkunden" → Er meint DEINE (vom Fake) Lustgrotte, NICHT seine eigene!\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Du antwortest NICHT "deine Lustgrotte erkunden" zurück - das wäre falsch! Du antwortest: "Ich kann es kaum erwarten, dass du MICH erkundest" oder "Ich freue mich darauf, dass du MICH erkundest" oder "Ich würde gerne, dass du MICH erkundest"\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Wenn der Kunde sagt "deine Lustgrotte", dann ist das SEIN Wunsch, DICH zu erkunden - nicht dein Wunsch, ihn zu erkunden!\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Verstehe die PERSPEKTIVE: Der Kunde spricht über DICH (den Fake) - "deine" = deine (vom Fake), nicht seine!\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Bei sexuellen Themen: Der Kunde fragt DICH nach DEINEN Körperteilen/Vorlieben - nicht umgekehrt!\n`;
      specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Wenn der Kunde "deine Lustgrotte", "deine Pussy", "dein Körper" sagt, dann ist das SEIN Interesse an DIR - du antwortest darauf, dass DU auch Interesse hast, dass ER DICH erkundet!\n\n`;
      
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
    
    // 🚨🚨🚨 ROOT CAUSE FIX: hasMeetingContext wird jetzt NUR gesetzt, wenn die AKTUELLE Nachricht relevant ist
    // Daher können wir hier sicher sein, dass es eine Treffen-Anfrage ist
    if (hasMeetingContext && !isCustomerMeetingRequest) {
      isCustomerMeetingRequest = true;
      console.log('🚨 KRITISCH: Treffen-Anfrage aus AKTUELLER Nachricht erkannt (indirekt, nicht direkt)!');
      
      // 🚨🚨🚨 FIX: Füge "Treffen/Termine" zu detectedSituations hinzu, wenn es noch nicht vorhanden ist!
      // Das ist KRITISCH, damit die richtigen Training-Daten geladen werden!
      if (!detectedSituations.includes("Treffen/Termine")) {
        detectedSituations.push("Treffen/Termine");
        console.log('✅ Situation "Treffen/Termine" hinzugefügt (aus aktueller Nachricht erkannt)');
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
 * Agent 13.4: Language-Detector
 * Erkennt, ob eine Nachricht auf Deutsch ist
 * Wenn nicht → gibt spezifische Antwort zurück
 */
async function agentLanguageDetector(customerMessage) {
  try {
    // Wenn keine Nachricht vorhanden (z.B. bei ASA), überspringe
    if (!customerMessage || customerMessage.trim().length === 0) {
      return {
        isGerman: true,
        detectedLanguage: 'de',
        needsGermanResponse: false,
        response: null,
        success: true
      };
    }

    const client = getClient();
    if (!client) {
      console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Language-Detector - Fallback (nehme an, dass Deutsch)');
      return {
        isGerman: true,
        detectedLanguage: 'de',
        needsGermanResponse: false,
        response: null,
        success: true
      };
    }

    // 🚨 KRITISCH: Prüfe ob Nachricht auf Deutsch ist
    const languageDetectionPrompt = `Prüfe, ob die folgende Nachricht auf Deutsch geschrieben ist.

Nachricht: "${customerMessage.substring(0, 500)}"

Aufgabe:
- Erkenne die Sprache der Nachricht
- Wenn die Nachricht NICHT auf Deutsch ist → markiere als "nicht deutsch"
- Wenn die Nachricht auf Deutsch ist (auch mit Rechtschreibfehlern oder Umgangssprache) → markiere als "deutsch"

WICHTIG:
- Deutsch mit Rechtschreibfehlern = DEUTSCH
- Deutsch in Umgangssprache = DEUTSCH
- Deutsch mit Emojis = DEUTSCH
- Nur wenn die Nachricht hauptsächlich in einer anderen Sprache ist (z.B. Serbisch, Kroatisch, Englisch, Türkisch) = NICHT DEUTSCH

Antworte NUR als JSON:
{
  "isGerman": true/false,
  "detectedLanguage": "Sprachcode (z.B. 'de', 'sr', 'hr', 'en', 'tr')",
  "confidence": 0.0-1.0
}

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const detection = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du erkennst die Sprache von Nachrichten. Antworte NUR als JSON.' },
          { role: 'user', content: languageDetectionPrompt }
        ],
        max_tokens: 100,
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);

    const result = detection.choices?.[0]?.message?.content?.trim() || '';
    if (!result) {
      // Fallback: Nehme an, dass Deutsch
      return {
        isGerman: true,
        detectedLanguage: 'de',
        needsGermanResponse: false,
        response: null,
        success: true
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch (e) {
      console.warn('⚠️ Agent: Language-Detector - JSON Parse Fehler:', e.message);
      // Fallback: Nehme an, dass Deutsch
      return {
        isGerman: true,
        detectedLanguage: 'de',
        needsGermanResponse: false,
        response: null,
        success: true
      };
    }

    const isGerman = parsed.isGerman === true || parsed.detectedLanguage === 'de';
    const detectedLanguage = parsed.detectedLanguage || 'unknown';
    const confidence = parsed.confidence || 0.5;

    if (!isGerman && confidence > 0.7) {
      // 🚨 KRITISCH: Nachricht ist NICHT auf Deutsch → generiere spezifische Antwort
      console.log(`🚨 Agent: Language-Detector - NICHT-DEUTSCHE Sprache erkannt: ${detectedLanguage} (Confidence: ${(confidence * 100).toFixed(0)}%)`);
      
      const germanResponse = "Ich verstehe deine Nachricht leider nicht. Könntest du bitte auf Deutsch schreiben?";
      
      return {
        isGerman: false,
        detectedLanguage: detectedLanguage,
        needsGermanResponse: true,
        response: germanResponse,
        success: true
      };
    }

    // Nachricht ist auf Deutsch → normal weiter
    return {
      isGerman: true,
      detectedLanguage: detectedLanguage,
      needsGermanResponse: false,
      response: null,
      success: true
    };
  } catch (err) {
    if (err.message === 'Timeout') {
      console.warn('⚠️ Agent: Language-Detector - Timeout (nehme an, dass Deutsch)');
    } else {
      console.warn('⚠️ Agent: Language-Detector - Fehler:', err.message);
    }
    // Fallback: Nehme an, dass Deutsch
    return {
      isGerman: true,
      detectedLanguage: 'de',
      needsGermanResponse: false,
      response: null,
      success: true
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
        answeredQuestions: [], // 🆕 NEU: Bereits beantwortete Fragen
        closedTopics: [], // 🆕 NEU: Abgeschlossene Themen
        newInformation: {}, // 🆕 NEU: Neue Informationen
        contextConnections: [],
        success: false
      };
    }

    if (!conversationHistory || conversationHistory.trim().length === 0) {
      return {
        contextInstructions: '',
        openAnnouncements: [],
        openQuestions: [],
        answeredQuestions: [], // 🆕 NEU: Bereits beantwortete Fragen
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
   - WICHTIG: Prüfe auch, ob Fragen BEREITS BEANTWORTET wurden!
   - Wenn der Kunde positiv auf eine Frage reagiert (z.B. "super", "gerne", "ja", "klingt gut"), dann wurde die Frage BEANTWORTET!
   - Wenn der Kunde auf ein Thema eingeht (z.B. Moderator: "trinken gehen", Kunde: "super"), dann wurde das Thema BEANTWORTET!
   - Nur Fragen, die IGNORIERT wurden oder auf die NICHT reagiert wurde, sind "offen"!

3. VERSprechen: Hat der Moderator/Fake etwas versprochen, das noch nicht erfüllt wurde?

4. MYSTERIÖSE/GEHEIMNISVOLLE NACHRICHTEN: Hat der Moderator/Fake eine mysteriöse/geheimnisvolle Nachricht geschrieben (z.B. "Was verbergen deine Augen?", "Das musst du herausfinden")?
   - Diese Nachrichten sind oft ASA (Animate Subsequent Action) - sie sollen den Kunden animieren zu antworten
   - Erkenne das THEMA dieser Nachricht (z.B. "in die Augen schauen", "Wahrheit erfahren")

5. PROBLEMATISCHE ANFRAGEN: Fragt der Kunde nach problematischen Dingen?
   - WhatsApp/Telegram/Nummer (Kontaktdaten außerhalb der Plattform)
   - Treffen/Date (direkte Treffen-Anfrage)
   - Zeitangaben (morgen, an einem anderen Tag)
   - Wenn ja: Erkenne, dass der Moderator NICHT zustimmen darf, sondern UMLENKEN muss!

10. BEREITS GEMACHTE VORSCHLÄGE: Hat der Moderator bereits einen Vorschlag gemacht (z.B. "Wein trinken", "spazieren gehen", "kochen")?
   - Wenn der Moderator bereits einen Vorschlag gemacht hat (z.B. "ein Glas Wein zusammen trinken") und der Kunde zugestimmt hat → NICHT erneut fragen "was würdest du gerne machen?"
   - Stattdessen: Stelle SPEZIFISCHE Fragen zum bereits gemachten Vorschlag:
     * Wenn Vorschlag "Wein trinken" → frage: "Welchen Wein trinkst du gerne?", "Was magst du beim Wein trinken?", "Hast du ein Auto?" (für Treffen)
     * Wenn Vorschlag "spazieren gehen" → frage: "Wo gehst du gerne spazieren?", "Was magst du beim Spazieren?"
     * Wenn Vorschlag "kochen" → frage: "Was kochst du gerne?", "Welche Küche magst du?"
   - 🚨🚨🚨 KRITISCH: Wenn bereits ein Vorschlag gemacht wurde, dann NICHT generisch fragen "was würdest du gerne machen?" - das wurde bereits beantwortet!

6. UMLENKUNGS-BEDARF: Muss der Moderator UMLENKEN?
   - Wenn Kunde nach WhatsApp/Treffen/Zeit fragt → Umlenkung nötig!
   - Wenn letzte Moderator-Nachricht "mehr erfahren will" → Umlenkung mit spezifischer Frage nötig!
   - Erkenne: Welche spezifische Frage sollte der Moderator stellen? (z.B. "was du eigentlich genau hier suchst")

7. KONTEXT-VERBINDUNGEN: Wie bezieht sich die Kunden-Nachricht auf die letzte Moderator-Nachricht?
   - Fragt der Kunde nach etwas, das angekündigt/versprochen wurde?
   - Reagiert der Kunde spielerisch/neugierig auf eine mysteriöse Moderator-Nachricht?
   - Bezieht sich die Kunden-Antwort auf das THEMA der letzten Moderator-Nachricht?
   - Wenn letzte Moderator-Nachricht "mehr erfahren will" und Kunde reagiert verwirrt → PROAKTIV spezifische Frage stellen!
   - 🚨🚨🚨 KRITISCH: Wenn der Kunde POSITIV auf ein Thema reagiert (z.B. "super", "gerne", "ja"), dann wurde das Thema BEANTWORTET - NICHT erneut fragen, sondern das Thema VERTIEFEN!
   - 🚨🚨🚨 KRITISCH: Wenn Moderator "trinken gehen" vorschlägt und Kunde sagt "super", dann NICHT erneut fragen "was möchtest du machen" - stattdessen: Spezifische Fragen zum Thema stellen (z.B. "Wo gehst du gerne trinken?", "Was trinkst du am liebsten?")

8. ABGESCHLOSSENE THEMEN: Hat der Kunde sich mit einem Thema abgefunden oder es abgeschlossen?
   - Wenn der Kunde sagt "Schade kein Bild" oder "okay kein Bild" → Thema ist ABGESCHLOSSEN!
   - Wenn der Kunde sagt "schade" oder "okay" zu etwas, das nicht funktioniert hat → Thema ist ABGESCHLOSSEN!
   - Wenn ein Thema abgeschlossen ist → NICHT darauf zurückkommen, sondern auf NEUE Informationen eingehen!

9. NEUE INFORMATIONEN: Welche NEUEN Informationen enthält die Kunden-Nachricht?
   - Arbeit/Arbeitszeiten (z.B. "arbeit ruft", "gehe zur Arbeit", "bis heute Abend")
   - Zeitangaben (z.B. "bis heute Abend", "heute Abend", "morgen", "später")
   - Weggang/Rückkehr (z.B. "gehe jetzt", "komme später", "melde mich wieder")
   - 🚨🚨🚨 KRITISCH: Wenn der Kunde NEUE Informationen gibt (z.B. "arbeit ruft bis heute Abend"), dann GEHE DARAUF EIN - nicht auf alte Themen zurückkommen!
   - 🚨🚨🚨 KRITISCH: Wenn der Kunde sagt, dass er zur Arbeit geht und wann er zurückkommt, dann reagiere auf ARBEIT und ZEIT, nicht auf alte Themen!

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
  "answeredQuestions": [
    {
      "text": "Exakter Text der bereits beantworteten Frage",
      "askedBy": "moderator",
      "customerResponse": "Wie hat der Kunde geantwortet? (z.B. 'super', 'gerne', 'ja')",
      "topic": "Was war das Thema der Frage? (z.B. 'trinken gehen', 'treffen', 'spazieren')"
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
  "criticalInstructions": "Kurze, prägnante Anweisungen für den Moderator (max. 400 Zeichen). BEISPIEL: Wenn letzte Moderator-Nachricht 'Ich will mehr über dich erfahren' war und Kunde fragt verwirrt nach WhatsApp, dann: 'UMLENKEN! NICHT zustimmen! Stattdessen: \"Ich weis aber so schnell gebe ich jetzt auch nicht meine nummer raus, ich würde noch gerne vorher wissen was du eigentlich genau hier suchst?\"'",
  "closedTopics": [
    {
      "topic": "Thema, das abgeschlossen ist (z.B. 'Bild', 'Treffen', 'WhatsApp')",
      "reason": "Warum ist es abgeschlossen? (z.B. 'Kunde hat sich damit abgefunden', 'Kunde sagt schade/okay')"
    }
  ],
  "newInformation": {
    "hasNewInfo": true/false,
    "workMentioned": "Wird Arbeit erwähnt? (z.B. 'arbeit ruft', 'gehe zur Arbeit')",
    "timeMentioned": "Werden Zeitangaben erwähnt? (z.B. 'bis heute Abend', 'heute Abend', 'morgen')",
    "leavingMentioned": "Geht der Kunde weg? (z.B. 'gehe jetzt', 'arbeit ruft', 'bis heute Abend')",
    "returnTime": "Wann kommt der Kunde zurück? (z.B. 'heute Abend', 'morgen', 'später')",
    "summary": "Zusammenfassung der neuen Informationen (z.B. 'Kunde geht zur Arbeit, kommt heute Abend zurück')"
  },
  "madeSuggestions": [
    {
      "suggestion": "Was wurde vorgeschlagen? (z.B. 'Wein trinken', 'spazieren gehen', 'kochen')",
      "customerResponse": "Wie hat der Kunde reagiert? (z.B. 'super', 'gerne', 'ja', 'wäre schön')",
      "specificQuestions": ["Welche spezifischen Fragen sollten gestellt werden? (z.B. 'Welchen Wein trinkst du gerne?', 'Hast du ein Auto?', 'Was suchst du hier?')"]
    }
  ]
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
        answeredQuestions: [], // 🆕 NEU: Bereits beantwortete Fragen
        closedTopics: [], // 🆕 NEU: Abgeschlossene Themen
        newInformation: {}, // 🆕 NEU: Neue Informationen
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
        answeredQuestions: [], // 🆕 NEU: Bereits beantwortete Fragen
        closedTopics: [], // 🆕 NEU: Abgeschlossene Themen
        newInformation: {}, // 🆕 NEU: Neue Informationen
        contextConnections: [],
        success: false
      };
    }

    // Generiere strukturierte Anweisungen
    let contextInstructions = '';
    const openAnnouncements = parsed.openAnnouncements || [];
    const openQuestions = parsed.openQuestions || [];
    const answeredQuestions = parsed.answeredQuestions || []; // 🆕 NEU: Bereits beantwortete Fragen
    const closedTopics = parsed.closedTopics || []; // 🆕 NEU: Abgeschlossene Themen
    const newInformation = parsed.newInformation || {}; // 🆕 NEU: Neue Informationen
    const madeSuggestions = parsed.madeSuggestions || []; // 🆕 NEU: Bereits gemachte Vorschläge
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
      
      // 🆕 NEU: Bereits beantwortete Fragen (KRITISCH - NICHT wiederholen!)
      if (answeredQuestions.length > 0) {
        contextInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 BEREITS BEANTWORTETE FRAGEN - NICHT WIEDERHOLEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
        answeredQuestions.forEach((aq, idx) => {
          contextInstructions += `${idx + 1}. Frage: "${aq.text.substring(0, 200)}"\n`;
          contextInstructions += `   Kunden-Antwort: "${aq.customerResponse || 'positiv'}"\n`;
          if (aq.topic) {
            contextInstructions += `   Thema: "${aq.topic}"\n`;
            contextInstructions += `   🚨🚨🚨 KRITISCH: Diese Frage wurde BEREITS BEANTWORTET - NICHT erneut fragen! 🚨🚨🚨\n`;
            contextInstructions += `   🚨🚨🚨 STATTDESSEN: Gehe SPEZIFISCH auf das Thema "${aq.topic}" ein und VERTIEFE es! 🚨🚨🚨\n`;
            contextInstructions += `   ✅ RICHTIG: Stelle spezifische Fragen zum Thema "${aq.topic}" (z.B. "Wo gehst du gerne ${aq.topic}?", "Was magst du bei ${aq.topic}?", "Wie stellst du dir ${aq.topic} vor?")\n`;
            contextInstructions += `   ❌ FALSCH: Erneut fragen "was möchtest du machen?" oder "was hast du im Sinn?" - das wurde bereits beantwortet!\n`;
          } else {
            contextInstructions += `   🚨🚨🚨 KRITISCH: Diese Frage wurde BEREITS BEANTWORTET - NICHT erneut fragen! 🚨🚨🚨\n`;
            contextInstructions += `   🚨🚨🚨 STATTDESSEN: Gehe auf die Antwort ein und stelle eine NEUE, SPEZIFISCHE Frage! 🚨🚨🚨\n`;
          }
          contextInstructions += `\n`;
        });
        contextInstructions += `🚨🚨🚨 ABSOLUT KRITISCH: Wenn eine Frage bereits beantwortet wurde, dann:\n`;
        contextInstructions += `1. NICHT die Frage wiederholen!\n`;
        contextInstructions += `2. Auf die Antwort eingehen (z.B. "Das freut mich, dass du ${answeredQuestions[0].topic || 'das'} super findest")\n`;
        contextInstructions += `3. Das Thema VERTIEFEN mit spezifischen Fragen (z.B. "Wo gehst du gerne ${answeredQuestions[0].topic || 'hin'}?", "Was magst du bei ${answeredQuestions[0].topic || 'dabei'}?")\n`;
        contextInstructions += `4. Auch ohne passende Training-Daten kontextuell reagieren - nutze dein Verständnis des Themas!\n\n`;
      }
      
      // 🆕 NEU: Abgeschlossene Themen (KRITISCH - NICHT darauf zurückkommen!)
      if (closedTopics.length > 0) {
        contextInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABGESCHLOSSENE THEMEN - NICHT DARAUF ZURÜCKKOMMEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
        closedTopics.forEach((ct, idx) => {
          contextInstructions += `${idx + 1}. Thema: "${ct.topic}"\n`;
          contextInstructions += `   Grund: "${ct.reason}"\n`;
          contextInstructions += `   🚨🚨🚨 KRITISCH: Dieses Thema ist ABGESCHLOSSEN - NICHT darauf zurückkommen! 🚨🚨🚨\n`;
          contextInstructions += `   🚨🚨🚨 STATTDESSEN: Gehe auf NEUE Informationen in der Nachricht ein! 🚨🚨🚨\n\n`;
        });
        contextInstructions += `🚨🚨🚨 ABSOLUT KRITISCH: Wenn ein Thema abgeschlossen ist, dann:\n`;
        contextInstructions += `1. NICHT auf das alte Thema zurückkommen!\n`;
        contextInstructions += `2. Auf NEUE Informationen in der Nachricht eingehen (siehe unten)!\n`;
        contextInstructions += `3. Logisch reagieren - auch ohne passende Training-Daten!\n\n`;
      }
      
      // 🆕 NEU: Neue Informationen (HÖCHSTE PRIORITÄT - darauf eingehen!)
      if (newInformation.hasNewInfo) {
        contextInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 NEUE INFORMATIONEN - HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
        
        if (newInformation.workMentioned) {
          contextInstructions += `💼 ARBEIT ERWÄHNT: "${newInformation.workMentioned}"\n`;
          contextInstructions += `- Der Kunde geht zur Arbeit oder ist bei der Arbeit\n`;
          contextInstructions += `- 🚨🚨🚨 GEHE DARAUF EIN - wünsche einen guten Arbeitstag!\n`;
        }
        
        if (newInformation.timeMentioned) {
          contextInstructions += `⏰ ZEIT ERWÄHNT: "${newInformation.timeMentioned}"\n`;
          contextInstructions += `- Der Kunde gibt eine Zeitangabe (z.B. "bis heute Abend", "heute Abend", "morgen")\n`;
          contextInstructions += `- 🚨🚨🚨 GEHE DARAUF EIN - frage nach der Zeit oder reagiere darauf!\n`;
        }
        
        if (newInformation.leavingMentioned) {
          contextInstructions += `🚪 WEGGANG ERWÄHNT: Der Kunde geht weg\n`;
          contextInstructions += `- Der Kunde sagt, dass er weggeht (z.B. "arbeit ruft", "gehe jetzt", "bis heute Abend")\n`;
          contextInstructions += `- 🚨🚨🚨 GEHE DARAUF EIN - wünsche einen guten Tag und frage nach Rückkehr!\n`;
        }
        
        if (newInformation.returnTime) {
          contextInstructions += `🔄 RÜCKKEHR-ZEIT: "${newInformation.returnTime}"\n`;
          contextInstructions += `- Der Kunde sagt, wann er zurückkommt (z.B. "heute Abend", "morgen", "später")\n`;
          contextInstructions += `- 🚨🚨🚨 GEHE DARAUF EIN - frage nach der genauen Zeit oder reagiere darauf!\n`;
          contextInstructions += `- ✅ BEISPIEL: "Ich wünsch dir dann einen guten Arbeitstag mein Liebster, weißt du schon wann du dich heute Abend wieder melden kannst?"\n`;
        }
        
        if (newInformation.summary) {
          contextInstructions += `\n📋 ZUSAMMENFASSUNG: "${newInformation.summary}"\n`;
        }
        
        contextInstructions += `\n🚨🚨🚨 ABSOLUT KRITISCH: Neue Informationen haben HÖCHSTE PRIORITÄT!\n`;
        contextInstructions += `1. Gehe auf die NEUEN Informationen ein (Arbeit, Zeit, Weggang)!\n`;
        contextInstructions += `2. NICHT auf alte/abgeschlossene Themen zurückkommen!\n`;
        contextInstructions += `3. Reagiere LOGISCH - auch ohne passende Training-Daten!\n`;
        contextInstructions += `4. Beispiel: Wenn Kunde sagt "arbeit ruft bis heute Abend" → "Ich wünsch dir einen guten Arbeitstag, weißt du schon wann du dich heute Abend wieder melden kannst?"\n`;
        contextInstructions += `5. Beispiel: Wenn Kunde sagt "gehe jetzt zur Arbeit" → "Viel Erfolg bei der Arbeit, melde dich gerne wenn du wieder da bist!"\n\n`;
      }
      
      // 🆕 NEU: Bereits gemachte Vorschläge (KRITISCH - NICHT generisch fragen!)
      if (madeSuggestions.length > 0) {
        contextInstructions += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 BEREITS GEMACHTE VORSCHLÄGE - SPEZIFISCHE FRAGEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
        madeSuggestions.forEach((suggestion, idx) => {
          contextInstructions += `${idx + 1}. Vorschlag: "${suggestion.suggestion}"\n`;
          contextInstructions += `   Kunden-Reaktion: "${suggestion.customerResponse || 'positiv'}"\n`;
          contextInstructions += `   🚨🚨🚨 KRITISCH: Dieser Vorschlag wurde bereits gemacht und der Kunde hat zugestimmt! 🚨🚨🚨\n`;
          contextInstructions += `   🚨🚨🚨 NICHT erneut fragen "was würdest du gerne machen?" - das wurde bereits beantwortet! 🚨🚨🚨\n`;
          if (suggestion.specificQuestions && suggestion.specificQuestions.length > 0) {
            contextInstructions += `   ✅ STELLE STATTDESSEN DIESE SPEZIFISCHEN FRAGEN:\n`;
            suggestion.specificQuestions.forEach((q, qIdx) => {
              contextInstructions += `      ${qIdx + 1}. "${q}"\n`;
            });
          } else {
            // Fallback: Generiere spezifische Fragen basierend auf Vorschlag
            const suggestionLower = suggestion.suggestion.toLowerCase();
            if (suggestionLower.includes('wein') || suggestionLower.includes('trinken')) {
              contextInstructions += `   ✅ STELLE STATTDESSEN SPEZIFISCHE FRAGEN ZUM THEMA:\n`;
              contextInstructions += `      - "Welchen Wein trinkst du gerne?"\n`;
              contextInstructions += `      - "Was magst du beim Wein trinken?"\n`;
              contextInstructions += `      - "Hast du eigentlich ein Auto?" (für Treffen)\n`;
              contextInstructions += `      - "Was suchst du denn hier?"\n`;
            } else if (suggestionLower.includes('spazieren') || suggestionLower.includes('gehen')) {
              contextInstructions += `   ✅ STELLE STATTDESSEN SPEZIFISCHE FRAGEN ZUM THEMA:\n`;
              contextInstructions += `      - "Wo gehst du gerne spazieren?"\n`;
              contextInstructions += `      - "Was magst du beim Spazieren?"\n`;
            } else if (suggestionLower.includes('kochen')) {
              contextInstructions += `   ✅ STELLE STATTDESSEN SPEZIFISCHE FRAGEN ZUM THEMA:\n`;
              contextInstructions += `      - "Was kochst du gerne?"\n`;
              contextInstructions += `      - "Welche Küche magst du?"\n`;
            } else {
              contextInstructions += `   ✅ STELLE STATTDESSEN SPEZIFISCHE FRAGEN ZUM THEMA "${suggestion.suggestion}":\n`;
              contextInstructions += `      - "Was magst du bei ${suggestion.suggestion}?"\n`;
              contextInstructions += `      - "Wie stellst du dir ${suggestion.suggestion} vor?"\n`;
            }
          }
          contextInstructions += `\n`;
        });
        contextInstructions += `🚨🚨🚨 ABSOLUT KRITISCH: Wenn bereits ein Vorschlag gemacht wurde, dann:\n`;
        contextInstructions += `1. NICHT generisch fragen "was würdest du gerne machen?" - das wurde bereits beantwortet!\n`;
        contextInstructions += `2. Stelle SPEZIFISCHE Fragen zum bereits gemachten Vorschlag!\n`;
        contextInstructions += `3. Beispiele: "Welchen Wein trinkst du gerne?", "Hast du ein Auto?", "Was suchst du hier?"\n`;
        contextInstructions += `4. Auch ohne passende Training-Daten kontextuell reagieren - nutze dein Verständnis des Themas!\n\n`;
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
    const answeredInfo = answeredQuestions.length > 0 ? `, ${answeredQuestions.length} bereits beantwortete Frage(n)` : '';
    const closedInfo = closedTopics.length > 0 ? `, ${closedTopics.length} abgeschlossene Thema(e)` : '';
    const newInfo = newInformation.hasNewInfo ? `, neue Infos erkannt` : '';
    console.log(`✅ Agent: Context-Connection-Analyzer - ${contextConnections.length} Verbindungen, ${openAnnouncements.length} Ankündigungen, ${openQuestions.length} offene Fragen erkannt${answeredInfo}${closedInfo}${newInfo}${redirectInfo}`);

    return {
      contextInstructions: contextInstructions.trim(),
      openAnnouncements,
      openQuestions,
      answeredQuestions, // 🆕 NEU: Bereits beantwortete Fragen
      closedTopics, // 🆕 NEU: Abgeschlossene Themen
      newInformation, // 🆕 NEU: Neue Informationen
      madeSuggestions, // 🆕 NEU: Bereits gemachte Vorschläge
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
      answeredQuestions: [], // 🆕 NEU: Bereits beantwortete Fragen
      contextConnections: [],
      success: false
    };
  }
}

/**
 * 🚨🚨🚨 NEU: Agent 13.75: Agreement/Consensus-Detector
 * Erkennt, was in den letzten Nachrichten vereinbart/abgelehnt wurde
 * Verhindert Widersprüche zu vorherigen Aussagen
 */
async function agentAgreementConsensusDetector(customerMessage, moderatorMessages = [], customerMessages = [], conversationHistory = '') {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Agreement/Consensus-Detector - Fallback');
    return {
      agreements: [],
      disagreements: [],
      consensusMap: {},
      contradictions: [],
      contextInstructions: '',
      success: false
    };
  }

  try {
    // Extrahiere die letzten 5 Moderator- und Kunden-Nachrichten
    const recentModeratorMessages = (moderatorMessages || []).slice(-5).map(m => m?.text || '').filter(t => t.length > 0);
    const recentCustomerMessages = (customerMessages || []).slice(-5).map(m => m?.text || '').filter(t => t.length > 0);
    
    // Erstelle strukturierte Verlauf-Darstellung
    let structuredHistory = 'Letzte Nachrichten im Chat-Verlauf (neueste zuerst):\n\n';
    const allRecentMessages = [];
    
    recentModeratorMessages.forEach((msg, idx) => {
      allRecentMessages.push({
        type: 'Moderator',
        text: msg,
        index: recentModeratorMessages.length - idx
      });
    });
    
    recentCustomerMessages.forEach((msg, idx) => {
      allRecentMessages.push({
        type: 'Kunde',
        text: msg,
        index: recentCustomerMessages.length - idx
      });
    });
    
    allRecentMessages.sort((a, b) => b.index - a.index);
    
    allRecentMessages.slice(0, 10).forEach((msg, idx) => {
      structuredHistory += `${idx + 1}. [${msg.type}]: "${msg.text.substring(0, 200)}${msg.text.length > 200 ? '...' : ''}"\n`;
    });

    const analysisPrompt = `Analysiere den folgenden Chat-Verlauf und erkenne, was VEREINBART oder ABGELEHNT wurde.

${structuredHistory}

Aktuelle Kundennachricht: "${customerMessage}"

🚨🚨🚨 KRITISCH: KONSENS-ERKENNUNG 🚨🚨🚨

1. **VEREINBARUNGEN (Agreements)**: Was wurde als "gut", "einfach", "möglich", "nicht schwer", "klar", "verstanden" vereinbart?
   - Beispiel: Moderator sagt "das kann ja auch nicht so schwer sein oder?" → Kunde sagt "Nein eigentlich nicht" → KONSENS: "Es ist NICHT schwer"
   - Beispiel: Moderator sagt "Das klingt gut" → Kunde sagt "Ja, finde ich auch" → KONSENS: "Es ist gut"
   - Beispiel: Moderator sagt "Das sollte funktionieren" → Kunde sagt "Ja, denke ich auch" → KONSENS: "Es sollte funktionieren"

2. **ABLEHNUNGEN (Disagreements)**: Was wurde als "schlecht", "schwer", "nicht möglich", "kompliziert" abgelehnt?
   - Beispiel: Moderator sagt "Das ist schwierig" → Kunde sagt "Ja, leider" → KONSENS: "Es ist schwierig"

3. **KONSENS-MAP**: Erstelle eine Map von Aussagen, die beide Parteien geteilt haben:
   - "nicht schwer" / "einfach" / "kann funktionieren" → POSITIV
   - "schwer" / "kompliziert" / "nicht möglich" → NEGATIV
   - "gut" / "super" / "geil" → POSITIV
   - "schlecht" / "blöd" / "nicht gut" → NEGATIV

4. **WIDERSPRÜCHE ERKENNEN**: Wenn eine neue Nachricht im WIDERSPRUCH zu einem Konsens steht:
   - Konsens: "Es ist NICHT schwer" → Neue Nachricht sagt "Ich verstehe, dass es nicht so einfach ist" → WIDERSPRUCH!
   - Konsens: "Es ist gut" → Neue Nachricht sagt "Das ist schlecht" → WIDERSPRUCH!

5. **KONTEXT-INSTRUKTIONEN**: Generiere explizite Anweisungen für die KI:
   - Wenn Konsens "nicht schwer" → KI darf NICHT sagen "es ist schwer" oder "es ist nicht einfach"
   - Wenn Konsens "gut" → KI darf NICHT sagen "es ist schlecht" oder "es ist nicht gut"
   - KI muss den KONSENS respektieren und darauf aufbauen, nicht widersprechen!

Antworte NUR als JSON:
{
  "agreements": [
    {
      "statement": "Exakte Aussage, die vereinbart wurde (z.B. 'Es ist nicht schwer')",
      "context": "Kontext der Vereinbarung (z.B. 'Moderator: das kann ja auch nicht so schwer sein oder? Kunde: Nein eigentlich nicht')",
      "type": "positive" | "negative" | "neutral"
    }
  ],
  "disagreements": [
    {
      "statement": "Exakte Aussage, die abgelehnt wurde",
      "context": "Kontext der Ablehnung",
      "type": "positive" | "negative" | "neutral"
    }
  ],
  "consensusMap": {
    "nicht schwer": "positive",
    "einfach": "positive",
    "gut": "positive",
    "schwer": "negative",
    "kompliziert": "negative"
  },
  "contradictions": [
    {
      "detected": "Welche Widersprüche wurden in der aktuellen Nachricht erkannt?",
      "consensus": "Was war der ursprüngliche Konsens?",
      "severity": "high" | "medium" | "low"
    }
  ],
  "contextInstructions": "Explizite Anweisungen für die KI (z.B. 'WICHTIG: Der Konsens ist, dass es NICHT schwer ist. Du darfst NICHT sagen, dass es schwer oder nicht einfach ist. Baue auf dem Konsens auf und sage z.B. \"Ja, das stimmt, es sollte nicht schwer sein. Wie würdest du es denn angehen?\"')"
}

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du bist ein Experte für Konsens-Erkennung in Gesprächen. Du erkennst Vereinbarungen und Widersprüche. Antworte IMMER nur als JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const parsed = JSON.parse(result);
        
        console.log(`✅ Agent: Agreement/Consensus-Detector - ${parsed.agreements?.length || 0} Vereinbarungen, ${parsed.disagreements?.length || 0} Ablehnungen, ${parsed.contradictions?.length || 0} Widersprüche erkannt`);
        
        if (parsed.contradictions && parsed.contradictions.length > 0) {
          console.warn(`🚨 KRITISCH: ${parsed.contradictions.length} Widerspruch(e) zu Konsens erkannt!`);
          parsed.contradictions.forEach((c, idx) => {
            console.warn(`   Widerspruch ${idx + 1}: ${c.detected} (Konsens: ${c.consensus}, Severity: ${c.severity})`);
          });
        }
        
        return {
          agreements: parsed.agreements || [],
          disagreements: parsed.disagreements || [],
          consensusMap: parsed.consensusMap || {},
          contradictions: parsed.contradictions || [],
          contextInstructions: parsed.contextInstructions || '',
          success: true
        };
      } catch (e) {
        console.warn('⚠️ Agent: Agreement/Consensus-Detector - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    if (err.message === 'Timeout') {
      console.warn('⚠️ Agent: Agreement/Consensus-Detector - Timeout (nicht kritisch)');
    } else {
      console.warn('⚠️ Agent: Agreement/Consensus-Detector - Fehler:', err.message);
    }
  }

  // Fallback
  return {
    agreements: [],
    disagreements: [],
    consensusMap: {},
    contradictions: [],
    contextInstructions: '',
    success: false
  };
}

/**
 * 🚨🚨🚨 NEU: Agent 13.9: Meta-Validator
 * Validiert ALLE Agent-Ergebnisse, erkennt Widersprüche und entscheidet konservativ
 * HÖCHSTE PRIORITÄT - verhindert False Positives durch Cross-Validation
 */
async function agentMetaValidator({
  contextAnalysis,
  situationDetection,
  firstMessageResult,
  customerMessage,
  conversationHistory
}) {
  try {
    const client = getClient();
    if (!client) {
      console.warn('⚠️ OpenAI Client nicht verfügbar - Agent: Meta-Validator - Fallback');
      return {
        validatedSituations: [],
        hasContradiction: false,
        contradictionDetails: null,
        conservativeDecision: null,
        shouldBlockSexualContent: false,
        confidence: 0,
        success: false
      };
    }

    // Extrahiere Informationen
    const contextTopic = contextAnalysis?.topic || 'allgemein';
    const contextFlow = contextAnalysis?.contextFlow || 'neutral';
    const detectedSituations = situationDetection?.detectedSituations || [];
    const situationConfidence = situationDetection?.confidence || 0;
    const isFirstMessageFromUs = firstMessageResult?.isFirstMessage === true;
    
    // 🚨 KRITISCH: False-Positive-Detector für harmlose Phrasen
    const customerMessageLower = (customerMessage || '').toLowerCase();
    const harmlessPhrases = [
      'evtl ziehen wir uns ja an',
      'vielleicht ziehen wir uns an',
      'passen wir zusammen',
      'können wir uns kennenlernen',
      'wollen wir uns kennenlernen',
      'könnten wir uns kennenlernen',
      'würden wir zusammen passen',
      'könnten wir zusammen passen',
      'vielleicht passen wir zusammen',
      'evtl passen wir zusammen',
      'könnten wir uns verstehen',
      'würden wir uns verstehen'
    ];
    
    const hasHarmlessPhrase = harmlessPhrases.some(phrase => customerMessageLower.includes(phrase));
    
    // Prüfe auf Widerspruch
    const hasSexualSituation = detectedSituations.some(s => s.includes('Sexuell'));
    const contextIsSexual = contextTopic === 'sexuell' || contextFlow === 'sexuell';
    const hasContradiction = hasSexualSituation && !contextIsSexual;
    
    // Meta-Validation mit LLM
    const validationPrompt = `Analysiere diese Agent-Ergebnisse und erkenne Widersprüche. Antworte NUR als JSON:

{
  "hasContradiction": true/false,
  "contradictionType": "context_vs_situation" | "false_positive" | "none",
  "contradictionDetails": "Beschreibung des Widerspruchs",
  "validatedSituations": ["validierte Situation 1", "validierte Situation 2"],
  "shouldBlockSexualContent": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Begründung für die Validierung"
}

Kundennachricht: "${customerMessage.substring(0, 300)}"
${conversationHistory ? `\nKonversations-Kontext: "${conversationHistory.substring(0, 500)}"` : ''}

Agent-Ergebnisse:
- Context-Analyst: Topic="${contextTopic}", Flow="${contextFlow}"
- Situation-Detector: Situationen=[${detectedSituations.join(', ')}], Confidence=${(situationConfidence * 100).toFixed(0)}%
- Erstnachricht (von uns): ${isFirstMessageFromUs ? 'JA' : 'NEIN'}
- Harmlose Phrase erkannt: ${hasHarmlessPhrase ? 'JA' : 'NEIN'}

🚨🚨🚨 KRITISCH: META-VALIDIERUNG 🚨🚨🚨

1. **WIDERSPRUCH-ERKENNUNG**:
   - Wenn Context-Analyst "allgemein/neutral" sagt UND Situation-Detector "Sexuelle Themen" sagt → WIDERSPRUCH!
   - Wenn harmlose Phrase erkannt wurde (z.B. "evtl ziehen wir uns ja an") → FALSE POSITIVE!
   - Bei Widerspruch → IMMER konservativ entscheiden (allgemein statt sexuell)!

2. **KONSERVATIVE STRATEGIE**:
   - Bei Unsicherheit → IMMER konservativ (allgemein statt sexuell)
   - Bei Widerspruch → Context-Analyst hat Vorrang (konservativer)
   - Bei False Positive → Blockiere sexuellen Inhalt

3. **ERSTNACHRICHT-SCHUTZ**:
   - Wenn WIR die erste Nachricht schreiben → NIEMALS sexuell, egal was erkannt wird
   - Überschreibt Situation-Detector bei Erstnachricht

4. **HARMLOSE PHRASEN**:
   - "evtl ziehen wir uns ja an" = harmlos ("vielleicht passen wir zusammen"), NICHT sexuell!
   - "passen wir zusammen" = harmlos, NICHT sexuell!
   - "können wir uns kennenlernen" = harmlos, NICHT sexuell!
   - Diese Phrasen sollen als "allgemein" erkannt werden, NICHT als "Sexuelle Themen"!

5. **VALIDIERUNG**:
   - Nur als "Sexuelle Themen" validieren, wenn:
     * Context-Analyst UND Situation-Detector beide "sexuell" sagen
     * UND Confidence > 90%
     * UND KEINE harmlose Phrase erkannt
     * UND KEINE Erstnachricht von uns
     * UND explizit sexuelle Wörter vorhanden (z.B. "ficken", "sex", "pussy")

Antworte NUR als JSON, kein zusätzlicher Text.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: 'Du bist ein Meta-Validator für Agent-Ergebnisse. Du erkennst Widersprüche und entscheidest konservativ. Antworte IMMER nur als JSON.' },
          { role: 'user', content: validationPrompt }
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
    ]);

    const result = response.choices?.[0]?.message?.content?.trim();
    if (result) {
      try {
        const parsed = JSON.parse(result);
        
        // 🚨 HARD-CODED RULES (überschreiben LLM bei kritischen Fällen)
        let finalValidatedSituations = parsed.validatedSituations || [];
        let finalShouldBlock = parsed.shouldBlockSexualContent || false;
        
        // Regel 1: Erstnachricht-Schutz (wenn WIR die erste Nachricht schreiben)
        if (isFirstMessageFromUs) {
          finalValidatedSituations = finalValidatedSituations.filter(s => !s.includes('Sexuell'));
          finalShouldBlock = true;
          console.log('🚨 Meta-Validator: Erstnachricht-Schutz aktiviert - sexuelle Inhalte blockiert');
        }
        
        // Regel 2: Harmlose Phrase erkannt → Blockiere sexuellen Inhalt
        if (hasHarmlessPhrase && hasSexualSituation) {
          finalValidatedSituations = finalValidatedSituations.filter(s => !s.includes('Sexuell'));
          finalShouldBlock = true;
          console.log('🚨 Meta-Validator: Harmlose Phrase erkannt - sexuelle Inhalte blockiert');
        }
        
        // Regel 3: Widerspruch erkannt → Konservativ entscheiden
        if (hasContradiction && hasSexualSituation && !contextIsSexual) {
          finalValidatedSituations = finalValidatedSituations.filter(s => !s.includes('Sexuell'));
          finalShouldBlock = true;
          console.log('🚨 Meta-Validator: Widerspruch erkannt (Context vs. Situation) - konservativ entschieden');
        }
        
        console.log(`✅ Agent: Meta-Validator - ${finalValidatedSituations.length} validierte Situation(en), Blockierung: ${finalShouldBlock ? 'JA' : 'NEIN'}, Confidence: ${(parsed.confidence * 100).toFixed(0)}%`);
        
        if (parsed.hasContradiction) {
          console.warn(`🚨 Meta-Validator: Widerspruch erkannt - ${parsed.contradictionType}: ${parsed.contradictionDetails}`);
        }
        
        return {
          validatedSituations: finalValidatedSituations,
          hasContradiction: parsed.hasContradiction || hasContradiction,
          contradictionDetails: parsed.contradictionDetails || (hasContradiction ? 'Context-Analyst sagt "allgemein", Situation-Detector sagt "sexuell"' : null),
          contradictionType: parsed.contradictionType || (hasContradiction ? 'context_vs_situation' : 'none'),
          conservativeDecision: finalValidatedSituations.length < detectedSituations.length ? 'situations_filtered' : null,
          shouldBlockSexualContent: finalShouldBlock,
          confidence: parsed.confidence || 0.5,
          reasoning: parsed.reasoning || '',
          success: true
        };
      } catch (e) {
        console.warn('⚠️ Agent: Meta-Validator - JSON Parse Fehler:', e.message);
      }
    }
  } catch (err) {
    if (err.message === 'Timeout') {
      console.warn('⚠️ Agent: Meta-Validator - Timeout (nicht kritisch)');
    } else {
      console.warn('⚠️ Agent: Meta-Validator - Fehler:', err.message);
    }
  }

  // Fallback: Konservativ entscheiden
  const hasSexualSituation = (situationDetection?.detectedSituations || []).some(s => s.includes('Sexuell'));
  const contextIsSexual = contextAnalysis?.topic === 'sexuell' || contextAnalysis?.contextFlow === 'sexuell';
  const hasContradiction = hasSexualSituation && !contextIsSexual;
  
  return {
    validatedSituations: hasContradiction ? [] : (situationDetection?.detectedSituations || []),
    hasContradiction: hasContradiction,
    contradictionDetails: hasContradiction ? 'Context-Analyst sagt "allgemein", Situation-Detector sagt "sexuell" (Fallback)' : null,
    contradictionType: hasContradiction ? 'context_vs_situation' : 'none',
    conservativeDecision: hasContradiction ? 'situations_filtered' : null,
    shouldBlockSexualContent: hasContradiction || (firstMessageResult?.isFirstMessage === true),
    confidence: 0.5,
    reasoning: 'Fallback: Konservativ entschieden',
    success: false
  };
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
`;
      } else if (hasLike) {
        // System-Nachricht: Like
        firstMessageInstructions = `
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: DIES IST DIE ERSTE NACHRICHT AN DEN KUNDEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ABSOLUT KRITISCH - DU SCHREIBST DEM KUNDEN ZUM ERSTEN MAL! 🚨🚨🚨
- Der Kunde hat dir ein LIKE geschickt (System-Nachricht: "${systemMessageText.substring(0, 100)}")
- Es gibt KEINE vorherigen Nachrichten zwischen euch
- Dies ist der ERSTE Kontakt - mache einen guten Eindruck!

📋 WICHTIGE ANWEISUNGEN FÜR DIE ERSTE NACHRICHT (MIT LIKE):
1. NORMALE BEGRÜSSUNG MIT ZEITKONTEXT:
   - Begrüße locker und natürlich (z.B. "Hey na", "Hey", "Hallo")
   - Nutze Zeitkontext (Wochentag, Tageszeit) für natürliche Fragen
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)
`;
      } else {
        // Standard erste Nachricht
        firstMessageInstructions = `
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: DIES IST DIE ERSTE NACHRICHT AN DEN KUNDEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 ABSOLUT KRITISCH - DU SCHREIBST DEM KUNDEN ZUM ERSTEN MAL! 🚨🚨🚨
- Es gibt KEINE vorherigen Nachrichten zwischen euch
- Dies ist der ERSTE Kontakt - mache einen guten Eindruck!

📋 WICHTIGE ANWEISUNGEN FÜR DIE ERSTE NACHRICHT:
1. NORMALE BEGRÜSSUNG MIT ZEITKONTEXT:
   - Begrüße locker und natürlich (z.B. "Hey na", "Hey", "Hallo")
   - Nutze Zeitkontext (Wochentag, Tageszeit) für natürliche Fragen
   - ❌ KEINE Vorstellung (kein Name, kein Alter, kein Wohnort - das kommt später!)
`;
      }
      
      return {
        isFirstMessage: true,
        firstMessageInstructions: firstMessageInstructions,
        success: true
      };
    }
    
    return {
      isFirstMessage: false,
      firstMessageInstructions: '',
      success: true
    };
  } catch (err) {
    console.warn('⚠️ Agent: First-Message-Detector - Fehler:', err.message);
    return {
      isFirstMessage: false,
      firstMessageInstructions: '',
      success: false
    };
  }
}

// 🔧 PROMPT-FIX: Exportiere createPromptForTogetherAI für Verwendung in runMultiStagePipeline
// Diese Funktion sollte verwendet werden, um den Together.ai-Prompt zu erstellen,
// der den Kontext BEHÄLT, aber die NEUESTE Nachricht klar als HAUPTFOKUS markiert.
// 
// Verwendung:
// const { systemPrompt, userPrompt } = createPromptForTogetherAI({
//   conversationHistory: conversationHistory, // Wird BEHALTEN als Kontext
//   customerMessage: customerMessage, // NEUESTE Nachricht (HAUPTFOKUS!)
//   lastModeratorMessage: lastModeratorMessage, // Letzte Moderator-Nachricht (optional)
//   systemPrompt: systemPrompt, // Regeln (ohne conversationHistory!)
//   rules: rules
// });
//
// Dann verwende systemPrompt und userPrompt in messageClient.chat.completions.create()

module.exports = {
  createPromptForTogetherAI,
  // ... andere Exports hier ...
};

