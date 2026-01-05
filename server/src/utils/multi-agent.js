const { getClient } = require('../openaiClient');
const { runSafetyCheck } = require('./safety-agent');

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
- "contextFlow": Wie verläuft das Gespräch? Neutral, positiv | negativ | philosophisch | sexuell

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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
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
  
  return {
    customerContext: relevantInfo, // Vollständiges customerContext-Array (gefiltert nach Relevanz)
    relevantInfo: relevantInfo,
    irrelevantInfo: irrelevantInfo,
    reason: irrelevantInfo.length > 0 ? 'Gefiltert nach Kontext-Relevanz' : 'Alle Infos relevant',
    success: true
  };
}

/**
 * Agent 3: Training-Data-Selector
 * Findet relevante Training-Daten basierend auf Kontext
 * HINWEIS: Nutzt auch Vector-DB für bessere Ergebnisse
 */
async function agentTrainingSelector(contextAnalysis, customerMessage, situations, vectorDbFunc, isASA = false, conversationContext = '', trainingData = null) {
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
    
    // 🤖 ASA-UNTERSTÜTZUNG: Wenn ASA-Fall, suche speziell nach ASA-Beispielen
    if (isASA) {
      queryText = `ASA reaktivierung: ${conversationContext.substring(0, 500)}`;
      console.log('🤖 Agent: Training-Selector - ASA-Modus aktiviert');
    }

    // Use existing vector search if available
    if (vectorDbFunc && typeof vectorDbFunc === 'function') {
      try {
        // WICHTIG: findSimilarExamples nimmt situation (singular) und topK (nicht limit)
        const situation = situations && situations.length > 0 ? situations[0] : null;
        const vectorResults = await vectorDbFunc(queryText, {
          topK: isASA ? 30 : 20, // Mehr Beispiele für ASA, um bessere Filterung zu ermöglichen
          minSimilarity: 0.3,
          situation: isASA ? 'ASA' : situation // Bei ASA explizit nach ASA-Beispielen suchen
        });

        if (vectorResults && vectorResults.length > 0) {
          let filteredResults = vectorResults;
          
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
            
            console.log(`🤖 Agent: Training-Selector - ${filteredResults.length} ASA-Beispiele nach Kontext-Filterung (von ${vectorResults.length})`);
          }
          
          console.log(`✅ Agent: Training-Selector - ${filteredResults.length} Beispiele via Vector-DB${isASA ? ' (ASA-Modus)' : ''}`);
          return {
            selectedExamples: filteredResults.slice(0, isASA ? 20 : 10), // Mehr für ASA
            reason: `Vector-DB: ${filteredResults.length} ähnliche Beispiele gefunden${isASA ? ' (ASA)' : ''}`,
            method: 'vector-db',
            success: true,
            isASA: isASA
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
    success: false,
    isASA: isASA
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
      styleContext += `🚨🚨🚨 ABSOLUT KRITISCH - STIL BEIBEHALTEN! 🚨🚨🚨\n`;
      styleContext += `- Du MUSST den STIL der letzten Moderator-Nachrichten BEIBEHALTEN!\n`;
      styleContext += `- Wenn die letzten Nachrichten persönlich/emotional waren, dann schreibe auch persönlich/emotional!\n`;
      styleContext += `- Wenn die letzten Nachrichten spielerisch/vertraut waren, dann schreibe auch spielerisch/vertraut!\n`;
      styleContext += `- Wenn die letzten Nachrichten direkt/roh waren, dann schreibe auch direkt/roh!\n`;
      styleContext += `- Übernehme die WORTWAHL, den TON und die FORMULIERUNGEN aus den letzten Nachrichten!\n`;
      styleContext += `- Passe dich dem KUNDEN an (wie in den letzten Nachrichten), aber behalte den STIL bei!\n`;
      styleContext += `- Training-Daten zeigen dir QUALITÄT, aber die letzten Moderator-Nachrichten zeigen dir den STIL und KONTEXT für DIESEN Chat!\n`;
      styleContext += `- Kombiniere BEIDES: Qualität aus Training-Daten + Stil/Kontext aus letzten Moderator-Nachrichten!\n\n`;
      
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
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
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
          
          // Generiere Anweisungen basierend auf Stimmung
          let instructions = '';
          switch (mood) {
            case 'frustriert':
              instructions = '\n\n😔 EMOTIONALE STIMMUNG: Der Kunde ist FRUSTRIERT/ENTTÄUSCHT!\n- Reagiere VERSTÄNDNISVOLL und TRÖSTEND\n- Zeige, dass du seine Gefühle verstehst\n- Sei einfühlsam, nicht defensiv\n- Versuche, die Situation zu entspannen\n';
              break;
            case 'glücklich':
              instructions = '\n\n😊 EMOTIONALE STIMMUNG: Der Kunde ist GLÜCKLICH/POSITIV!\n- Reagiere ENTHUSIASTISCH und FREUDIG\n- Teile seine positive Stimmung\n- Sei warmherzig und aufgeschlossen\n';
              break;
            case 'traurig':
              instructions = '\n\n😢 EMOTIONALE STIMMUNG: Der Kunde ist TRAURIG/NIEDERGESCHLAGEN!\n- Reagiere MITGEFÜHLEND und TRÖSTEND\n- Zeige Verständnis für seine Gefühle\n- Sei einfühlsam und unterstützend\n';
              break;
            case 'aufgeregt':
              instructions = '\n\n🤩 EMOTIONALE STIMMUNG: Der Kunde ist AUFGEREGT/BEGEISTERT!\n- Reagiere ENTHUSIASTISCH und ENERGISCH\n- Teile seine Begeisterung\n- Sei lebendig und mitreißend\n';
              break;
            case 'gelangweilt':
              instructions = '\n\n😐 EMOTIONALE STIMMUNG: Der Kunde wirkt GELANGWEILT/UNINTERESSIERT!\n- Reagiere INTERESSIERT und AKTIVIEREND\n- Stelle interessante Fragen\n- Versuche, das Gespräch zu beleben\n- Sei proaktiv, aber nicht aufdringlich\n';
              break;
            case 'verliebt':
              instructions = '\n\n💕 EMOTIONALE STIMMUNG: Der Kunde zeigt ROMANTISCHE GEFÜHLE!\n- Reagiere WARMHERZIG und ZUGEHÖRIG\n- Zeige Interesse an einer tieferen Verbindung\n- Sei emotional und persönlich\n';
              break;
            case 'wütend':
              instructions = '\n\n😠 EMOTIONALE STIMMUNG: Der Kunde ist WÜTEND/VERÄRGERT!\n- Reagiere RUHIG und DEESKALIEREND\n- Zeige Verständnis, aber sei nicht defensiv\n- Versuche, die Situation zu beruhigen\n- Sei professionell, aber einfühlsam\n';
              break;
            default:
              // neutral - keine speziellen Anweisungen
              break;
          }
          
          console.log(`✅ Agent: Mood-Analyst - Mood: ${mood}, Confidence: ${(confidence * 100).toFixed(0)}%`);
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
  platformId = 'viluu'
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

    // Baue System-Prompt
    let systemPrompt = `Du bist ein Chat-Assistent, der als Fake-Profil antwortet. 
- Schreibe natürlich, locker, direkt und emotional
- Keine erklärenden/beschreibenden Formulierungen
- Reagiere auf den Kontext, nicht mechanisch
- ${isASA ? 'Dies ist eine Reaktivierungsnachricht (ASA) - der Kunde hat zuletzt nicht geantwortet.' : ''}`;

    // Baue User-Prompt
    let userPrompt = isASA 
      ? `Generiere eine Reaktivierungsnachricht (ASA), da der Kunde zuletzt nicht geantwortet hat.\n\n`
      : `Antworte auf diese Kundennachricht: "${customerMessage.substring(0, 500)}"\n\n`;

    // Kontext-Informationen
    if (context.topic) {
      userPrompt += `Thema: ${context.topic}\n`;
    }
    if (context.summary) {
      userPrompt += `Zusammenfassung: ${context.summary}\n`;
    }

    // Profil-Informationen
    if (profile.customerContext && profile.customerContext.length > 0) {
      userPrompt += `\nBekannte Infos über den Kunden:\n${profile.customerContext.slice(0, 5).join('\n')}\n`;
    }

    // Training-Beispiele
    if (training.examples && training.examples.length > 0) {
      userPrompt += `\n📚 Training-Beispiele (orientiere dich daran):\n`;
      training.examples.slice(0, 5).forEach((ex, idx) => {
        userPrompt += `${idx + 1}. Kunde: "${ex.customerMessage || ''}" → Antwort: "${ex.moderatorResponse || ''}"\n`;
      });
      userPrompt += `\nWICHTIG: Verwende ähnliche Formulierungen und Fragen wie in den Beispielen!\n`;
    }

    // Regeln
    if (rules.instructions) {
      userPrompt += `\n${rules.instructions}\n`;
    }

    // Mood-Anweisungen
    if (mood.instructions) {
      userPrompt += `\n${mood.instructions}\n`;
    }

    // Proactive-Vorschläge
    if (proactive.isStagnant && proactive.suggestions && proactive.suggestions.length > 0) {
      userPrompt += `\n⚠️ Gespräch stagniert - nutze diese Themenvorschläge:\n${proactive.suggestions.slice(0, 2).join('\n')}\n`;
    }

    // Bild-Kontext
    if (image.description) {
      userPrompt += `\nBild-Beschreibung: ${image.description}\n`;
    }

    // Chat-Verlauf
    if (conversationHistory) {
      userPrompt += `\nChat-Verlauf (letzte Nachrichten):\n${conversationHistory.substring(0, 1000)}\n`;
    }

    // ASA-spezifische Anweisungen
    if (isASA) {
      userPrompt += `\n🚨 ASA-ANWEISUNGEN:\n`;
      userPrompt += `- Reaktiviere das Gespräch freundlich und interessiert\n`;
      userPrompt += `- Frage, was den Kunden beschäftigt\n`;
      userPrompt += `- Sei warmherzig, aber nicht aufdringlich\n`;
      if (asaConversationContext) {
        userPrompt += `- Kontext: ${asaConversationContext.substring(0, 300)}\n`;
      }
    }

    userPrompt += `\nGeneriere eine natürliche, kurze Antwort (max. 250 Zeichen). Antworte NUR mit der Nachricht, kein zusätzlicher Text.`;

    // Generiere Nachricht
    const response = await Promise.race([
      client.chat.completions.create({
        model: AGENT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 250
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    let message = response.choices?.[0]?.message?.content?.trim() || '';

    // Post-Processing: Bereinige Nachricht
    if (message) {
      // Entferne Anführungszeichen am Anfang/Ende
      message = message.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
      // Entferne Bindestriche
      message = message.replace(/-/g, " ");
      // Ersetze ß durch ss
      message = message.replace(/ß/g, "ss");
      // Bereinige zu viele Ausrufezeichen (max 1)
      const exclamationMatches = message.match(/!/g);
      if (exclamationMatches && exclamationMatches.length > 1) {
        let exclamationCount = 0;
        message = message.replace(/!/g, (match) => {
          exclamationCount++;
          return exclamationCount === 1 ? '!' : '.';
        });
      }
      // Bereinige doppelte Fragezeichen
      message = message.replace(/\?+/g, '?');
    }

    if (!message || message.trim() === '') {
      console.warn('⚠️ Agent: Message-Generator - Leere Nachricht generiert');
      return {
        message: '',
        success: false,
        error: 'Leere Nachricht generiert'
      };
    }

    console.log(`✅ Agent: Message-Generator - Nachricht generiert (${message.length} Zeichen)`);
    return {
      message,
      success: true
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
  asaConversationContext = '' // 🤖 ASA-UNTERSTÜTZUNG: Kontext für ASA-Filterung
}) {
  console.log(`🤖 Multi-Agent Pipeline gestartet${isASA ? ' (ASA-Modus)' : ''}...`);

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
  const contextResult = await agentContextAnalyst(conversationHistory, customerMessage);

  // Schritt 2: Parallel (keine Abhängigkeiten)
  const [profileResult, rulesResult] = await Promise.all([
    agentProfileFilter(profileInfo, contextResult, extractedUserInfo),
    agentRulesApplicator(allRules, contextResult, situations)
  ]);

  // Schritt 3: Training & Style (benötigen Kontext, aber können parallel)
  // 🤖 ASA-UNTERSTÜTZUNG: Übergebe isASA und asaConversationContext an Training-Selector
  const [trainingResult, styleResult] = await Promise.all([
    agentTrainingSelector(contextResult, customerMessage, situations, vectorDbFunc, isASA, asaConversationContext, trainingData),
    agentStyleAnalyst(moderatorMessages, customerMessages, contextResult, analyzeWritingStyleFunc, isInfoMessageFunc)
  ]);

  // Schritt 4: Mood & Proactive (benötigen Kontext, aber können parallel)
  const [moodResult, proactiveResult] = await Promise.all([
    agentMoodAnalyst(customerMessage, conversationHistory),
    agentProactiveAnalyst(allMessages || [], customerMessage, proactiveAnalysisFunc)
  ]);

  // Schritt 5: Image (optional, kann parallel zu Schritt 4)
  const imageResult = await agentImageAnalyst(imageUrl, contextResult, imageAnalysisFunc);

  const results = {
    safety: { isBlocked: false, reason: null, errorMessage: null },
    context: contextResult,
    profile: profileResult,
    rules: rulesResult,
    training: trainingResult,
    style: styleResult,
    mood: moodResult,
    proactive: proactiveResult,
    image: imageResult,
    blocked: false
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
  agentMoodAnalyst,
  agentProactiveAnalyst,
  agentMessageGenerator,
  runMultiAgentPipeline
};
