const { getClient } = require('../openaiClient');
const { runSafetyCheck } = require('./safety-agent');
const { getEmbedding, cosineSimilarity } = require('./embeddings');

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
  
  // Profilbild-Kontext (wird später vom Image-Analyst geliefert, hier nur Platzhalter)
  let profilePicContext = "";
  
  // Customer Type Context (Neukunde vs. Langzeitkunde)
  let customerTypeContext = "";
  const customerMessageCount = profileInfo?.messageCount || 0;
  const isNewCustomer = profileInfo?.isNewCustomer || false;
  
  if (customerMessageCount >= 10) {
    customerTypeContext = "\n\nWICHTIG: Dies ist ein Langzeitkunde (bereits viele Nachrichten ausgetauscht). Sei persönlicher und emotionaler in deiner Antwort.";
  } else if (isNewCustomer) {
    customerTypeContext = "\n\n🆕🆕🆕 KRITISCH: DIES IST EIN NEUKUNDE (ERSTE NACHRICHT, NOCH KEINE FAKE-ANTWORT IM CHAT)! 🆕🆕🆕\n- Du MUSST mindestens 150 Zeichen schreiben, damit der Kunde Lust hat zu antworten!\n- 🚨 KRITISCH: Stelle MEHR Fragen zum Kunden! Zeige Interesse an IHM - was macht er beruflich? Was sind seine Hobbies? Was mag er? Was sucht er?\n- 🚨 KRITISCH: KEINE generischen Phrasen wie 'Lass uns schauen was sich ergibt' oder 'Lass uns einfach schauen' - stelle konkrete Fragen!\n- 🚨 KRITISCH: Zeige Eigeninitiative - sage etwas über dich, aber stelle auch Fragen zum Kunden!";
  } else if (customerMessageCount > 0) {
    customerTypeContext = "\n\nWICHTIG: Dies ist ein Neukunde (erst wenige Nachrichten). Sei freundlich und hoffnungsvoll. Stelle Fragen zum Kunden, um ihn besser kennenzulernen.";
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
    
    // 🤖 ASA-UNTERSTÜTZUNG: Wenn ASA-Fall, suche speziell nach ASA-Beispielen
    if (isASA) {
      queryText = `ASA reaktivierung: ${conversationContext.substring(0, 500)}`;
      console.log('🤖 Agent: Training-Selector - ASA-Modus aktiviert');
    }

    // Use existing vector search if available
    if (vectorDbFunc && typeof vectorDbFunc === 'function') {
      try {
        // 🚨 KRITISCH: Intelligente Situation-Erkennung für bessere Filterung
        // Wenn mehrere Situationen erkannt wurden, verwende die wichtigste
        let primarySituation = null;
        if (situations && situations.length > 0) {
          // Priorisiere spezifische Situationen über "allgemein"
          const specificSituations = situations.filter(s => s && s.toLowerCase() !== 'allgemein');
          primarySituation = specificSituations.length > 0 ? specificSituations[0] : situations[0];
        }
        
        // Erhöhe topK für bessere Filterung (mehr Beispiele = bessere Auswahl)
        const topK = isASA ? 40 : 30;
        const vectorResults = await vectorDbFunc(queryText, {
          topK: topK,
          minSimilarity: 0.25, // Niedrigere Schwelle für mehr Kandidaten
          situation: isASA ? 'ASA' : primarySituation // Bei ASA explizit nach ASA-Beispielen suchen
        });

        if (vectorResults && vectorResults.length > 0) {
          let filteredResults = vectorResults;
          
          // 🚨 KRITISCH: Intelligente Filterung basierend auf erkannten Situationen
          // Filtere Beispiele, die zu den erkannten Situationen passen
          if (situations && situations.length > 0 && !isASA) {
            const situationKeywords = {
              "Treffen/Termine": ["treffen", "zeit", "wann", "sehen", "kennenlernen", "hoffe", "will", "würde gerne", "habe zeit", "jeden nachmittag", "heute noch", "diese woche", "wochenende", "samstag", "sonntag"],
              "Bot-Vorwurf": ["bot", "ki", "fake", "moderator", "roboter", "nicht echt", "künstlich"],
              "Geld/Coins": ["coins", "geld", "aufladen", "kostenlos", "nummer", "telegram", "whatsapp", "instagram"],
              "Kontaktdaten außerhalb der Plattform": ["nummer", "telegram", "whatsapp", "instagram", "email", "kontakt", "außerhalb"],
              "Sexuelle Themen": ["sex", "ficken", "geil", "lust", "vorlieben", "titten", "arsch", "pussy", "schwanz"],
              "Berufsfrage": ["beruf", "arbeit", "job", "was arbeitest", "wo arbeitest", "was machst du beruflich"],
              "Bilder Anfrage": ["bild", "foto", "zeig", "schick", "photo"],
              "Wonach suchst du?": ["suchen", "suchst", "beziehung", "freundschaft", "was suchst"]
            };
            
            // Sammle alle Keywords für erkannte Situationen
            const allKeywords = new Set();
            situations.forEach(sit => {
              const sitLower = sit.toLowerCase();
              if (situationKeywords[sit]) {
                situationKeywords[sit].forEach(kw => allKeywords.add(kw));
              }
              // Füge auch den Situationsnamen selbst hinzu
              allKeywords.add(sitLower);
            });
            
            // Filtere Beispiele: Bevorzuge solche, die zu erkannten Situationen passen
            filteredResults = vectorResults.filter(example => {
              const exampleText = `${example.customerMessage || ''} ${example.moderatorResponse || ''}`.toLowerCase();
              const exampleSituation = (example.situation || '').toLowerCase();
              
              // Prüfe ob Beispiel-Situation zu erkannten Situationen passt
              const situationMatches = situations.some(sit => {
                const sitLower = sit.toLowerCase();
                return exampleSituation.includes(sitLower) || sitLower.includes(exampleSituation);
              });
              
              // Prüfe ob Beispiel-Text Keywords enthält
              const keywordMatches = Array.from(allKeywords).some(kw => exampleText.includes(kw));
              
              // Bevorzuge Beispiele, die zu Situationen passen ODER Keywords enthalten
              return situationMatches || keywordMatches;
            });
            
            // Wenn nach Filterung zu wenige Beispiele, füge die besten zurück
            if (filteredResults.length < 5 && vectorResults.length > filteredResults.length) {
              const remaining = vectorResults.filter(r => !filteredResults.includes(r));
              filteredResults = [...filteredResults, ...remaining.slice(0, 10 - filteredResults.length)];
            }
            
            console.log(`📊 Agent: Training-Selector - ${filteredResults.length} Beispiele nach Situation-Filterung (von ${vectorResults.length}, Situationen: ${situations.join(', ')})`);
          }
          
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
          
          console.log(`✅ Agent: Training-Selector - ${filteredResults.length} Beispiele via Vector-DB${isASA ? ' (ASA-Modus)' : ''}${situations && situations.length > 0 ? ` (Situationen: ${situations.join(', ')})` : ''}`);
          
          // 🚨 KRITISCH: Sortiere Beispiele nach Relevanz (Situation-Match hat Priorität)
          if (situations && situations.length > 0 && !isASA) {
            filteredResults.sort((a, b) => {
              const aSituation = (a.situation || '').toLowerCase();
              const bSituation = (b.situation || '').toLowerCase();
              
              // Prüfe Situation-Match
              const aMatches = situations.some(sit => {
                const sitLower = sit.toLowerCase();
                return aSituation.includes(sitLower) || sitLower.includes(aSituation);
              });
              const bMatches = situations.some(sit => {
                const sitLower = sit.toLowerCase();
                return bSituation.includes(sitLower) || sitLower.includes(bSituation);
              });
              
              // 🚨 NEU: Bevorzuge Beispiele mit MEHREREN Situationen (Multi-Situation-Beispiele)
              const aHasMultipleSituations = aSituation.includes(',') || (a.situations && Array.isArray(a.situations) && a.situations.length > 1);
              const bHasMultipleSituations = bSituation.includes(',') || (b.situations && Array.isArray(b.situations) && b.situations.length > 1);
              
              // Wenn mehrere Situationen erkannt wurden, bevorzuge Multi-Situation-Beispiele
              if (situations.length > 1) {
                if (aHasMultipleSituations && !bHasMultipleSituations) return -1;
                if (!aHasMultipleSituations && bHasMultipleSituations) return 1;
              }
              
              // Beispiele mit Situation-Match haben Priorität
              if (aMatches && !bMatches) return -1;
              if (!aMatches && bMatches) return 1;
              
              // Ansonsten nach Similarity (höher = besser)
              return (b.similarity || 0) - (a.similarity || 0);
            });
          }
          
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
    trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT BEI ASA! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Du schreibst eine REAKTIVIERUNGSNACHRICHT (ASA)! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte ASA-Nachrichten aussehen! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ANALYSIERE JEDES BEISPIEL GENAU - welche Wörter werden verwendet? Welcher Ton? Welche Formulierungen? Welche FRAGEN werden gestellt? 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Verwende die GLEICHEN Wörter und Formulierungen wie in den Beispielen! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT VERBOTEN: KEINE generischen Fragen wie 'Was denkst du?' - verwende passende Fragen basierend auf den ASA-Beispielen! 🚨🚨🚨🚨🚨\n\n`;
  } else if (hasSexualContent) {
    trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT BEI SEX-GESPRÄCHEN! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: Du schreibst in einem SEXUELLEN Gespräch! 🚨🚨🚨🚨🚨\n\n`;
    if (lastModeratorMessage) {
      trainingExamplesContext += `🚨🚨🚨🚨🚨 WICHTIG: Kombiniere BEIDES! 🚨🚨🚨🚨🚨\n`;
      trainingExamplesContext += `- Training-Daten zeigen dir QUALITÄT und geile Formulierungen für Sex-Gespräche\n`;
      trainingExamplesContext += `- Die letzte Moderator-Nachricht (siehe unten) zeigt dir den STIL für DIESEN Chat (persönlich, emotional, vertraut, etc.)\n`;
      trainingExamplesContext += `- Verwende die QUALITÄT aus Training-Daten + den STIL aus der letzten Moderator-Nachricht!\n\n`;
    }
    trainingExamplesContext += `🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte Chat-Replies bei SEX-Gesprächen aussehen! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 WICHTIG: Bei Sex-Gesprächen musst du RADIKALER sein - direkt, roh, spontan, ohne bewertende Phrasen! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨🚨🚨 KRITISCH: ÜBERNEHME DIE WORTWAHL AUS DEN TRAINING-DATEN! Verwende die GLEICHEN Wörter und Formulierungen wie in den Beispielen! 🚨🚨🚨🚨🚨\n\n`;
  } else {
    trainingExamplesContext = `\n\n🚨🚨🚨🚨🚨 TRAINING-DATEN - ABSOLUT HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨\n\n`;
    trainingExamplesContext += `🚨🚨🚨 KRITISCH: Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich STRENG daran! 🚨🚨🚨\n\n`;
    if (lastModeratorMessage) {
      trainingExamplesContext += `🚨🚨🚨 WICHTIG: Kombiniere BEIDES! 🚨🚨🚨\n`;
      trainingExamplesContext += `- Training-Daten zeigen dir QUALITÄT und gute Formulierungen\n`;
      trainingExamplesContext += `- Die letzte Moderator-Nachricht (siehe unten) zeigt dir den STIL für DIESEN Chat\n`;
      trainingExamplesContext += `- Verwende die QUALITÄT aus Training-Daten + den STIL aus der letzten Moderator-Nachricht!\n\n`;
    }
    trainingExamplesContext += `Diese ${relevantExamples.length} Beispiele zeigen dir, wie echte Chat-Replies aussehen:\n\n`;
  }
  
  // Zeige positive Beispiele (RICHTIG)
  if (positiveExamples.length > 0) {
    trainingExamplesContext += `\n✅✅✅ RICHTIGE BEISPIELE (SO SOLLST DU ES MACHEN): ✅✅✅\n\n`;
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
          trainingExamplesContext += `🚨🚨🚨 FRAGEN IN DIESEM BEISPIEL: ${questions.map(q => `"${q.trim()}"`).join(', ')} - VERWENDE ÄHNLICHE FRAGEN! 🚨🚨🚨\n`;
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
  
  // Füge Learning-Context hinzu (falls vorhanden)
  if (learningContextResult && learningContextResult.learningContext) {
    trainingExamplesContext += learningContextResult.learningContext;
  }
  
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
- Direkt auf das eingehen, was der Kunde sagt - ohne Meta-Kommentare!
- Training-Daten haben HÖCHSTE PRIORITÄT - orientiere dich daran, nicht an generischen Formulierungen!
- 🚨🚨🚨 WORTWAHL AUS TRAINING-DATEN ÜBERNEHMEN - NICHT EIGENE FORMULIERUNGEN ERFINDEN! 🚨🚨🚨

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - RADIKAL, direkt, roh, spontan, ohne bewertende Phrasen, MIT DER GLEICHEN WORTWAHL WIE IN DEN BEISPIELEN!`;
  } else {
    trainingExamplesContext += `\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH: TRAINING-DATEN HABEN HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨🚨🚨 KRITISCH: TRAINING-DATEN SIND FÜR INHALT, STIL, WORTWAHL, FRAGEN - ALLES! 🚨🚨🚨🚨🚨
- Training-Daten zeigen dir, WIE du antworten sollst (Stil, Wortwahl, Ton, Formulierungen)
- Training-Daten zeigen dir auch, WAS du antworten sollst (Inhalt, Fragen, Reaktionen)
- 🚨 KRITISCH: Nutze Training-Daten für INHALT UND STIL - nicht nur für Stil! 🚨

🚨🚨🚨 KRITISCH: ORIENTIERE DICH STRENG AN DIESEN BEISPIELEN! 🚨🚨🚨
- Training-Daten haben HÖCHSTE PRIORITÄT - überschreiben ALLE anderen Stil-Anweisungen!
- Analysiere: Wie sind die Antworten strukturiert? (kurz, natürlich, locker)
- Analysiere: Welche FRAGEN werden gestellt? (z.B. "was würdest du noch gerne machen", "welche Stellungen", etc.)
- Übernehme: Welche Formulierungen, Wortwahl, Ton und FRAGEN werden verwendet?
- Wende an: Schreibe im GLEICHEN Stil wie diese Beispiele und verwende ÄHNLICHE Fragen!

🚨🚨🚨🚨🚨 KRITISCH: FRAGEN AUS TRAINING-DATEN ÜBERNEHMEN! 🚨🚨🚨🚨🚨
- Wenn du eine Frage stellen willst, SCHAUE IN DIE TRAINING-DATEN - welche Fragen werden dort gestellt?
- Verwende ÄHNLICHE Fragen wie in den Training-Daten (z.B. "was würdest du noch gerne machen", "welche Stellungen", "was magst du", etc.)
- 🚨 KRITISCH: KEINE generischen/schlechten Fragen erfinden (z.B. "Was magst du besonders beim Lecken?")!
- 🚨 KRITISCH: Wenn der Kunde schon gesagt hat, was er machen will, dann GEHE DARAUF EIN (sage, wie sehr es dir gefallen würde), statt generische Fragen zu stellen!

🚨🚨🚨 WICHTIG: Wenn Training-Daten etwas zeigen, dann MACH ES SO - nicht anders! 🚨🚨🚨

ZIEL: Deine Antwort soll sich anfühlen wie eine echte Chat-Reply aus den Training-Daten - nicht generisch oder "KI-mäßig"!`;
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
- Weiche HÖFLICH aus, aber gehe DARAUF EIN
- Sage etwas wie: "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen" oder "Ich würde gerne wissen, wie du es dir vorstellst, aber ich möchte dich erst noch besser kennenlernen"
- Lenke das Thema zurück auf Chat, Gefühle, Persönlichkeit oder Fantasie
- Stelle eine Frage, die zum aktuellen Gespräch passt

VERBOTENE WÖRTER & FORMULIERUNGEN (dürfen NIEMALS vorkommen):
- treffen / Treffen, Date, Café / Cafe, Park, Spaziergang
- abholen / abhole, vorbeikommen / besuchen
- bei dir / bei mir, sehen wir uns
- echtes Leben / real life / im echten Leben

WICHTIG: Diese Regel ist ABSOLUT und hat höchste Priorität! Gehe IMMER auf die Treffen-Anfrage ein, auch wenn du ausweichst!`;
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
      preferredWordsContext = `\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER - HÖCHSTE PRIORITÄT! 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\nDie folgenden ${allRules.preferredWords.length} Wörter sind BEVORZUGT und sollten REGELMÄSSIG verwendet werden:\n${allRules.preferredWords.map(w => `- "${w}"`).join('\n')}\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨 ABSOLUT KRITISCH - VERWENDE DIESE WÖRTER! 🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n🚨🚨🚨🚨🚨 KRITISCH: BEVORZUGTE WÖRTER HABEN HÖCHSTE PRIORITÄT NACH TRAINING-DATEN! 🚨🚨🚨🚨🚨\n⭐⭐⭐ WICHTIG: Diese Wörter sind NICHT ohne Grund da - sie wurden basierend auf Feedback und Qualität ausgewählt! ⭐⭐⭐\n⭐ WICHTIG: Integriere diese Wörter NATÜRLICH in deine Antworten, wo sie thematisch passen!\n⭐ Verwende sie REGELMÄSSIG - nicht nur bei Neukunden, sondern IMMER wenn es passt!\n⭐ Diese Wörter helfen dir, natürlicher und passender zu klingen!\n⭐ Orientiere dich an den Training-Daten - dort siehst du, wie diese Wörter verwendet werden!\n⭐ Kombiniere bevorzugte Wörter MIT Training-Daten - beide zusammen = BESTE Qualität!\n\n🚨 KRITISCH: KEIN "random" reinwerfen! NUR wenn es zur Message passt und nicht unnatürlich wirkt!\n🚨 ABER: Wenn ein Preferred Word thematisch passt, dann VERWENDE ES - nicht weglassen!\n🚨🚨🚨 WICHTIG: Bevorzugte Wörter + Training-Daten + Learning-System = BESTE Kombination! 🚨🚨🚨\n\n`;
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
async function agentSituationDetector(customerMessage, allRules, isLocationQuestionFunc, findNearbyCityFunc, isMeetingRequestFunc, profileInfo, extractedUserInfo, conversationHistory = "", moderatorMessages = [], customerMessages = []) {
  try {
    const lowerMessage = (customerMessage || "").toLowerCase();
    let detectedSituations = [];
    let specificInstructions = "";
    
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
    if (conversationContextText && conversationContextText.includes("treffen")) {
      const hasMeetingKeywords = conversationContextText.match(/\b(treffen|sehen|kennenlernen|wann|zeit|passt|mittwoch|donnerstag|freitag|montag|dienstag|samstag|sonntag|uhr|mittagszeit|abend|vormittag|nachmittag)\b/i);
      const hasFantasieKeywords = conversationContextText.match(/\b(würde|könnte|hätte|wenn|falls|wäre|gerne|würde gerne)\s+.*(treffen|sehen|kennenlernen)/i);
      if (hasMeetingKeywords && !hasFantasieKeywords) {
        hasMeetingContext = true;
        console.log('🚨 KRITISCH: Chat-Verlauf enthält Treffen-Kontext!');
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
    
    // Prüfe benutzerdefinierte situations-spezifische Antworten aus den Regeln
    // 🚨 KRITISCH: Analysiere sowohl aktuelle Nachricht als auch conversationHistory!
    if (allRules && allRules.situationalResponses && typeof allRules.situationalResponses === 'object') {
      for (const [situationName, situationResponse] of Object.entries(allRules.situationalResponses)) {
        let matchesSituation = false;
        const situationLower = situationName.toLowerCase();
        
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
          const sexualKeywords = ["titten", "brüste", "arsch", "po", "pussy", "schwanz", "sex", "ficken", "vorlieben", 
                                  "sexuell", "geil", "lust", "wichsen", "lecken", "blasen", "squiten", "verwöhnen", 
                                  "kuss", "muschi", "zunge", "schamlippen", "kitzler", "clitoris", "penis", "dick", 
                                  "sperma", "orgasmus", "komm", "nass", "feucht", "erregt", "horny", "hard"];
          const hasSexualInMessage = sexualKeywords.some(keyword => lowerMessage.includes(keyword));
          const hasSexualInHistory = conversationContextText ? sexualKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
          
          if ((situationLower.includes("sexuell") || situationLower.includes("sexuelle")) &&
              (hasSexualInMessage || hasSexualInHistory)) {
            matchesSituation = true;
            if (hasSexualInHistory && !hasSexualInMessage) {
              console.log(`📋 Sexuelle Themen in conversationHistory erkannt!`);
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
          
          if ((situationLower.includes("treffen") || situationLower.includes("termin")) &&
              (hasMeetingInContext || hasMeetingPattern)) {
            matchesSituation = true;
            if (hasMeetingPattern && !hasMeetingInContext) {
              console.log(`📋 Treffen-Situation via erweiterte Muster erkannt!`);
            }
          }
          
          // Geld/Coins (in aktueller Nachricht UND conversationHistory)
          const moneyKeywords = ["coin", "coins", "geld", "aufladen", "kredit", "bezahlen", "kostenlos", "kostenfrei", "gratis", "credit"];
          const hasMoneyInMessage = moneyKeywords.some(keyword => lowerMessage.includes(keyword));
          const hasMoneyInHistory = conversationContextText ? moneyKeywords.some(keyword => conversationContextText.includes(keyword)) : false;
          
          if ((situationLower.includes("geld") || situationLower.includes("coin")) &&
              (hasMoneyInMessage || hasMoneyInHistory)) {
            matchesSituation = true;
            if (hasMoneyInHistory && !hasMoneyInMessage) {
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
        
        if (matchesSituation && situationResponse) {
          if (!detectedSituations.includes(situationName)) {
            detectedSituations.push(situationName);
          }
          specificInstructions += `\n\n📋 BENUTZERDEFINIERTE SITUATION: ${situationName}\n${situationResponse}`;
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
      "sexuell", "geil", "lust", "wichsen", "lecken", "blasen", "squiten", "verwöhnen", "kuss",
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
      const moderatorInfo = extractedUserInfo?.assistant || profileInfo?.moderatorInfo || {};
      const customerCity = customerInfo.city || customerInfo.wohnort || null;
      const fakeCity = moderatorInfo.Wohnort || moderatorInfo.city || null;
      
      console.log("📍 Kunden-Wohnort:", customerCity || "(nicht gefunden)");
      console.log("📍 Fake-Wohnort:", fakeCity || "(nicht gefunden)");
      
      // Wenn im Fake-Profil bereits ein Wohnort steht, verwende diesen
      if (fakeCity && fakeCity.trim() !== "" && fakeCity.toLowerCase() !== "sag ich später") {
        console.log("✅ Verwende Wohnort aus Fake-Profil:", fakeCity);
        specificInstructions += `\n\n📍 WOHNORT-FRAGE ERKANNT!\n- Der Kunde fragt, woher du kommst.\n- Im Fake-Profil steht bereits: "${fakeCity}"\n- Verwende DIESEN Wohnort in deiner Antwort!`;
      } else if (customerCity && customerCity.trim() !== "" && customerCity.toLowerCase() !== "sag ich später") {
        // Wenn kein Fake-Wohnort, aber Kunden-Wohnort vorhanden: Finde eine Stadt im 50km Umkreis
        const nearbyCity = findNearbyCityFunc && typeof findNearbyCityFunc === 'function' 
          ? findNearbyCityFunc(customerCity) 
          : null;
        if (nearbyCity) {
          console.log(`✅ Wohnort im 50km Umkreis gefunden: ${nearbyCity} (nahe ${customerCity})`);
          specificInstructions += `\n\n📍 WOHNORT-FRAGE ERKANNT!\n- Der Kunde fragt, woher du kommst.\n- Der Kunde kommt aus: "${customerCity}"\n- Nenne eine Stadt/Dorf im 50km Umkreis: "${nearbyCity}"\n- Verwende DIESEN Wohnort in deiner Antwort!`;
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
    
    // Wenn Kontext aus letzten Nachrichten Treffen zeigt, dann ist es auch eine Treffen-Anfrage!
    if (hasMeetingContext && !isCustomerMeetingRequest) {
      isCustomerMeetingRequest = true;
      console.log('🚨 KRITISCH: Treffen-Anfrage aus Kontext erkannt (nicht direkt in aktueller Nachricht)!');
      
      // Füge spezifische Anweisungen hinzu
      if (!specificInstructions.includes("TREFFEN") && !specificInstructions.includes("treffen")) {
        specificInstructions += `\n\n🚨🚨🚨🚨🚨 KRITISCH: TREFFEN-ANFRAGE AUS KONTEXT ERKANNT! 🚨🚨🚨🚨🚨\n`;
        specificInstructions += `- In den letzten Nachrichten wurde ein Treffen besprochen!\n`;
        specificInstructions += `- Die aktuelle Kunden-Nachricht bezieht sich auf dieses Treffen!\n`;
        specificInstructions += `- 🚨🚨🚨 ABSOLUT KRITISCH: Du darfst KEIN Treffen vorschlagen oder zustimmen! 🚨🚨🚨\n`;
        specificInstructions += `- Weiche HÖFLICH aus, aber gehe DARAUF EIN (z.B. "Ich möchte dich noch besser kennenlernen, bevor wir uns treffen")\n`;
        specificInstructions += `- Lenke das Thema zurück auf Chat, Gefühle, Persönlichkeit oder Fantasie\n`;
        specificInstructions += `- Stelle eine Frage, die zum aktuellen Gespräch passt\n`;
        specificInstructions += `- VERBOTENE WÖRTER: treffen, Date, Café, Park, Spaziergang, abholen, vorbeikommen, besuchen, bei dir, bei mir, sehen wir uns, echtes Leben\n`;
      }
    }
    
    return {
      detectedSituations,
      specificInstructions,
      isRejection,
      hasSexualContent,
      isCustomerMeetingRequest,
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
    const situation = multiAgentResults.situation || {};
    const fakeContext = multiAgentResults.fakeContext || {};
    const conversationContext = multiAgentResults.conversationContext || {};
    const learning = multiAgentResults.learning || {};

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
      genderSpecificNote = `\n🚨🚨🚨 KRITISCH: GESCHLECHTER-ROLLENVERSTÄNDNIS 🚨🚨🚨\n- Du bist: ${isFemale ? "eine FRAU" : "ein MANN"}\n- Der Kunde ist: ${isFemale ? "ein MANN (schreibt dir als Frau)" : "eine FRAU (schreibt dir als Mann)"}\n- Passe deinen Schreibstil entsprechend an (${isFemale ? "Frau" : "Mann"} zu ${isFemale ? "Mann" : "Frau"})\n`;
    }

    // Generiere forbiddenWordsSystemNote (nur Hinweis, Details im User-Prompt)
    const forbiddenWordsSystemNote = allRules?.forbiddenWords && allRules.forbiddenWords.length > 0 
      ? `\n\n🚨🚨🚨 KRITISCH: VERBOTENE WÖRTER 🚨🚨🚨\nEs gibt ${allRules.forbiddenWords.length} absolut verbotene Wörter/Phrasen - siehe User-Prompt für Details!\nDiese Regel hat HÖCHSTE PRIORITÄT und überschreibt ALLE anderen Anweisungen!\n`
      : "";

    // Generiere allGeneralRules (HARDCODED_GRUNDREGELN)
    const allGeneralRules = `🚨🚨🚨🚨🚨🚨🚨🚨🚨 HARDCODED GRUNDREGELN (ABSOLUTE BASIS - IMMER AKTIV!) 🚨🚨🚨🚨🚨🚨🚨🚨🚨

🚨🚨🚨 KRITISCH: TRAINING-DATEN HABEN HÖCHSTE PRIORITÄT! 🚨🚨🚨
- Training-Daten zeigen dir, WIE du antworten sollst (Stil, Wortwahl, Ton, Formulierungen)
- Training-Daten zeigen dir auch, WAS du antworten sollst (Inhalt, Fragen, Reaktionen)
- 🚨 KRITISCH: Nutze Training-Daten für INHALT UND STIL - nicht nur für Stil! 🚨
- 🚨 KRITISCH: Training-Daten haben HÖCHSTE PRIORITÄT - überschreiben ALLE anderen Stil-Anweisungen! 🚨

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
- Zeige EIGENINITIATIVE! Wenn der Kunde sagt, dass er Sex sucht oder Freundschaft+ sucht, dann sage auch, dass DU das suchst! Frage dann nach seinen Vorlieben, Fantasien oder ähnliche fragen!
- Gehe TIEFER auf die Kundennachricht ein! Wenn der Kunde detailliert schreibt, dann schreibe auch detailliert zurück! Sei emotional, menschlich, interessiert!
- Reagiere auf das, was der KUNDE in SEINER Nachricht geschrieben hat, aber zeige auch EIGENINITIATIVE und trage aktiv zum Gespräch bei!
- ERFINDE KEINE Informationen, Daten, Termine oder andere Dinge, die nicht in der Nachricht stehen!
- Verwende NIEMALS deinen eigenen Namen in der Antwort
- KEINE Fotos/Nummern ANFORDERN, keine Off-Plattform-Kontakte!
- NIEMALS einem Treffen zustimmen oder Orte/Aktivitäten für Treffen nennen! Wenn der Kunde nach Treffen fragt, höflich ausweichen!
- BEI TREFFEN/SILVESTER-ANFRAGEN: Sage ZUERST, dass du an diesem Tag/Termin leider schon was vor hast, DANN frage, wie er es sich vorstellen würde (nur EINE Frage!)
- NIEMALS sagen "Ich wäre gerne bereit" oder "Ich bin bereit" - das klingt wie eine Zusage! Sage stattdessen "Ich könnte es mir vorstellen" oder "Ich würde gerne wissen, wie du es dir vorstellst"!
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

🚨🚨🚨 KRITISCH: NATÜRLICHKEIT & TON 🚨🚨🚨
- Sei NATÜRLICH und AUTHENTISCH - nicht zu euphorisch oder aufgeregt!
- Vermeide übertriebene Euphorie wie "mega", "geil", "wow", "richtig geil", "total geil" - sei zurückhaltender!
- Stelle NATÜRLICHE Fragen - nicht zu komisch oder übertrieben!
- Fragen sollten zum Gespräch passen und nicht zu aufdringlich sein!
- Sei interessiert, aber nicht übertrieben begeistert!
- Verwende KEINE Ausrufezeichen (!) - sie wirken zu euphorisch und unnatürlich!
- Schreibe in einem lockeren, aber nicht übertriebenen Ton!
- LÄNGE: 120-200 Zeichen (IDEAL: 120-200 Zeichen) - nicht länger, außer der Inhalt benötigt es wirklich!
- Stelle ÜBERWIEGEND NUR 1 Frage - nicht 2 Fragen, außer es ist wirklich nötig!
- Nutze aktuelles Datum/Zeit für DACH (Europe/Berlin): ${dateTimeInfo}
- Heute ist ${weekday} (${weekdayShort}), der ${day}.${month}.${year}, ${hour}:${minute.toString().padStart(2, '0')} Uhr. Jahreszeit: ${season}
- NIEMALS falsche Wochentage, Daten oder Zeiten verwenden! Prüfe IMMER das aktuelle Datum/Zeit oben!

🚨🚨🚨 ERWEITERTE KONTEXTANALYSE - ZEITKONTEXT 🚨🚨🚨
- Aktuelle Tageszeit: ${hour}:${minute.toString().padStart(2, '0')} Uhr
- Tagesphase: ${timePhase}
- Wochentag: ${weekday} (${weekdayShort === 'Sa' || weekdayShort === 'So' ? 'Wochenende' : 'Wochentag'})
- Jahreszeit: ${season}
- Nutze diesen Zeitkontext für natürlichere Antworten (z.B. "Guten Morgen" nur morgens, "Gute Nacht" nur abends, Wochenende-Erwähnungen nur am Wochenende)!
${forbiddenWordsSystemNote}
${isASA ? '\n🚨🚨🚨 KRITISCH: DIES IST EINE REAKTIVIERUNGSNACHRICHT (ASA)! 🚨🚨🚨\n- Der Kunde hat zuletzt nicht geantwortet.\n- Reaktiviere das Gespräch freundlich und interessiert.\n- Frage, was den Kunden beschäftigt.\n- Sei warmherzig, aber nicht aufdringlich.\n' : ''}`;

    // Baue User-Prompt (mit ALLEN Context-Strings)
    let userPrompt = "";

    // 1. Fake-Context (HÖCHSTE PRIORITÄT - zuerst!)
    if (fakeContext.fakeContext) {
      userPrompt += fakeContext.fakeContext + "\n";
    }

    // 2. Customer-Context
    if (profile.customerContext && profile.customerContext.length > 0) {
      userPrompt += `\n📊 BEKANNTE INFOS ÜBER DEN KUNDEN:\n${profile.customerContext.join('\n')}\n`;
    }

    // 3. Critical Rules Context
    if (rules.criticalRulesContext) {
      userPrompt += rules.criticalRulesContext + "\n";
    }

    // 4. Forbidden Words Context
    if (rules.forbiddenWordsContext) {
      userPrompt += rules.forbiddenWordsContext + "\n";
    }

    // 5. Multi-Situation Instructions (HÖCHSTE PRIORITÄT - wenn mehrere Situationen erkannt wurden!)
    if (multiAgentResults.multiSituation && multiAgentResults.multiSituation.combinedInstructions) {
      userPrompt += multiAgentResults.multiSituation.combinedInstructions + "\n";
    }

    // 6. Specific Instructions (Situation-Detector)
    if (situation.specificInstructions) {
      userPrompt += situation.specificInstructions + "\n";
    }

    // 7. Profile Pic Context
    if (profile.profilePicContext) {
      userPrompt += profile.profilePicContext + "\n";
    }

    // 8. Training Examples Context (HÖCHSTE PRIORITÄT!)
    if (training.trainingExamplesContext) {
      userPrompt += training.trainingExamplesContext + "\n";
    }

    // 9. Preferred Words Context
    if (rules.preferredWordsContext) {
      userPrompt += rules.preferredWordsContext + "\n";
    }

    // 10. Image Context
    if (image.imageContext) {
      userPrompt += image.imageContext + "\n";
    }

    // 11. Mood Context
    if (mood.instructions) {
      userPrompt += mood.instructions + "\n";
    }

    // 12. Proactive Context
    if (proactive.isStagnant && proactive.suggestions && proactive.suggestions.length > 0) {
      userPrompt += `\n🎯 PROAKTIVE GESPRÄCHSFÜHRUNG: Stagnation erkannt!\n\nDas Gespräch wirkt etwas langweilig/uninteressant (kurze, generische Antworten).\n\n🚨🚨🚨 WICHTIG: Sei PROAKTIV und BELEBE das Gespräch! 🚨🚨🚨\n- Stelle INTERESSANTE Fragen, die zum aktuellen Gespräch passen!\n- Wechsle NICHT abrupt das Thema - es muss zum Kontext passen!\n\nMögliche Themenvorschläge (NUR wenn sie zum Gespräch passen!):\n${proactive.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n`;
    }

    // 13. Conversation Block (Chat-Verlauf)
    if (conversationContext.conversationBlock) {
      userPrompt += conversationContext.conversationBlock + "\n";
    }

    // 14. Style Context
    if (style.styleContext) {
      userPrompt += style.styleContext + "\n";
    }

    // 15. Customer Type Context
    if (profile.customerTypeContext) {
      userPrompt += profile.customerTypeContext + "\n";
    }

    // 16. Learning Context (wird bereits in trainingExamplesContext integriert, aber hier als Backup)
    if (learning.learningContext && !training.trainingExamplesContext?.includes(learning.learningContext)) {
      userPrompt += learning.learningContext + "\n";
    }

    // 17. Kontext-Informationen (als Backup)
    if (context.topic) {
      userPrompt += `\n📋 THEMA: ${context.topic}\n`;
    }
    if (context.summary) {
      userPrompt += `📋 ZUSAMMENFASSUNG: ${context.summary}\n`;
    }

    // 18. Kunden-Nachricht
    userPrompt += `\n📥 KUNDEN-NACHRICHT:\n"${customerMessage.substring(0, 500)}"\n\n`;

    // 19. ASA-spezifische Anweisungen (falls noch nicht in specificInstructions)
    if (isASA && asaConversationContext && !situation.specificInstructions?.includes('ASA')) {
      userPrompt += `\n🚨🚨🚨 ASA-KONTEXT:\n${asaConversationContext.substring(0, 500)}\n\n`;
    }

    // 20. Finale Anweisung - Kombiniere ALLES von oben!
    userPrompt += `\n🚨🚨🚨 FINALE ANWEISUNG: 🚨🚨🚨\n\nGeneriere eine natürliche Antwort (120-200 Zeichen, IDEAL: 120-200 Zeichen). Antworte NUR mit der Nachricht, kein zusätzlicher Text.\n\n🚨🚨🚨 KRITISCH: BERÜCKSICHTIGE ALLES VON OBEN! 🚨🚨🚨\n- ALLE Situationen (wenn mehrere erkannt wurden, gehe auf ALLE ein!)\n- ALLE Regeln (verbotene Wörter, bevorzugte Wörter, kritische Regeln)\n- Training-Daten (Stil, Wortwahl, Inhalt, Fragen)\n- Learning-System (bewährte Muster aus Feedback)\n- Kontext (Stimmung, Stil, Profil, Gesprächsverlauf)\n- Begründungen (wenn vorhanden, nutze sie für besseres Verständnis)\n\nWICHTIG:\n- LÄNGE: 120-200 Zeichen (IDEAL: 120-200 Zeichen) - nicht länger, außer der Inhalt benötigt es wirklich!\n- FRAGEN: ÜBERWIEGEND NUR 1 Frage - nicht 2 Fragen, außer es ist wirklich nötig!\n- KEINE Ausrufezeichen (!) verwenden - sie wirken zu euphorisch!\n- Sei natürlich und authentisch - nicht zu euphorisch oder aufgeregt!\n- Stelle natürliche Fragen - nicht zu komisch oder übertrieben!\n- Vermeide übertriebene Euphorie wie "mega", "geil", "wow", "richtig geil"!\n- Vermeide unnötiges Gelaber oder unnötig lange Sätze - sei präzise!\n- 🚨 KRITISCH: Wenn mehrere Situationen erkannt wurden, gehe auf ALLE ein - ignoriere KEINE!`;

    // Generiere Nachricht (wird später für Rejection Sampling wiederverwendet)
    const generateMessage = async (promptVariation = '') => {
      const finalUserPrompt = promptVariation ? userPrompt + `\n\n${promptVariation}` : userPrompt;
      
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

    let message = response.choices?.[0]?.message?.content?.trim() || '';

    // Post-Processing: Bereinige Nachricht
    if (message) {
      // Entferne Anführungszeichen am Anfang/Ende
      message = message.replace(/^["'„""]+/, '').replace(/["'"""]+$/, '').trim();
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
      const questionMatches = message.match(/\?/g);
      const questionCount = questionMatches ? questionMatches.length : 0;
      if (questionCount > 1) {
        console.warn(`⚠️ Nachricht enthält ${questionCount} Fragen - reduziere auf 1 Frage...`);
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
      
      // 🚨 NEU: Nutze statistische Ziele aus Learning-System (statt fester Regeln)
      let targetMinLength = 120; // Fallback
      let targetMaxLength = 200; // Fallback
      let targetAvgExclamationMarks = 0; // Fallback
      let targetAvgQuestions = 1; // Fallback
      
      // Hole Statistiken für die aktuelle Situation
      try {
        const { getLearningStats } = require('../utils/learning-system');
        const learningStats = await getLearningStats();
        const primarySituation = situation?.detectedSituations?.[0] || situation?.detectedSituations || 'allgemein';
        const situationName = Array.isArray(primarySituation) ? primarySituation[0] : primarySituation;
        const situationStats = learningStats?.messageStats?.[situationName];
        
        if (situationStats && situationStats.positive && situationStats.positive.count > 0) {
          const posStats = situationStats.positive;
          // Nutze Median als Ziel (robuster als Durchschnitt)
          targetMinLength = Math.max(120, posStats.medianLength - 20 || 120); // Mindestens 120, aber Median - 20
          targetMaxLength = Math.min(250, posStats.medianLength + 30 || 200); // Maximal 250, aber Median + 30
          targetAvgExclamationMarks = posStats.medianExclamationMarks || 0;
          targetAvgQuestions = Math.round(posStats.medianQuestions || 1);
          
          console.log(`📊 Nutze statistische Ziele für "${situationName}": Länge ${targetMinLength}-${targetMaxLength}, Fragen: ${targetAvgQuestions}, Ausrufezeichen: ${targetAvgExclamationMarks}`);
        }
      } catch (err) {
        console.warn('⚠️ Konnte statistische Ziele nicht laden, verwende Fallback:', err.message);
      }
      
      // 🚨 KRITISCH: ALLE Nachrichten müssen mindestens targetMinLength Zeichen lang sein!
      if (message.length < targetMinLength) {
        console.warn(`⚠️ Nachricht zu kurz (${message.length} Zeichen, benötigt >=${targetMinLength}) - erweitere...`);
        // Versuche die Nachricht natürlich zu erweitern
        if (!message.endsWith('?') && !message.endsWith('.')) {
          message += '.';
        }
        // Wenn immer noch zu kurz, füge einen natürlichen Satz hinzu
        if (message.length < targetMinLength) {
          // Verschiedene natürliche Erweiterungen je nach Kontext
          const extensions = [
            " Was denkst du denn dazu?",
            " Wie siehst du das?",
            " Was meinst du dazu?",
            " Erzähl mir doch mehr davon.",
            " Das würde mich interessieren.",
            " Wie geht es dir damit?",
            " Was beschäftigt dich denn gerade so?"
          ];
          const randomExtension = extensions[Math.floor(Math.random() * extensions.length)];
          message += randomExtension;
        }
        // Falls immer noch zu kurz, füge weitere Details hinzu
        if (message.length < targetMinLength) {
          message += " Ich würde gerne mehr darüber erfahren.";
        }
        console.log(`✅ Nachricht erweitert auf ${message.length} Zeichen`);
      }
      
      // 🚨 NEU: Kürze Nachrichten, die >targetMaxLength Zeichen sind (außer wirklich nötig)
      if (message.length > targetMaxLength) {
        console.warn(`⚠️ Nachricht zu lang (${message.length} Zeichen, IDEAL: <=${targetMaxLength}) - kürze...`);
        // Versuche die Nachricht intelligent zu kürzen
        // Entferne redundante Phrasen oder unnötige Wiederholungen
        let shortened = message;
        
        // Entferne redundante Phrasen
        const redundantPhrases = [
          /\s+und\s+deshalb\s+/gi,
          /\s+und\s+deswegen\s+/gi,
          /\s+und\s+darum\s+/gi,
          /\s+und\s+aus\s+diesem\s+Grund\s+/gi,
          /\s+ich\s+würde\s+gerne\s+mehr\s+daruber\s+erfahren\s*\./gi,
          /\s+das\s+würde\s+mich\s+interessieren\s*\./gi,
          /\s+erzähl\s+mir\s+doch\s+mehr\s+davon\s*\./gi
        ];
        
        for (const phrase of redundantPhrases) {
          shortened = shortened.replace(phrase, ' ');
        }
        
        // Wenn immer noch zu lang, kürze am Ende (vor letztem Satz)
        if (shortened.length > targetMaxLength) {
          const sentences = shortened.split(/(?<=[.!?])\s+/);
          if (sentences.length > 1) {
            // Entferne den letzten Satz, wenn er nicht essentiell ist
            const lastSentence = sentences[sentences.length - 1];
            // Prüfe, ob der letzte Satz eine Frage ist (dann behalten)
            if (!lastSentence.trim().endsWith('?')) {
              shortened = sentences.slice(0, -1).join(' ').trim();
              // Stelle sicher, dass die Nachricht mit Punkt oder Fragezeichen endet
              if (!shortened.endsWith('.') && !shortened.endsWith('?')) {
                shortened += '.';
              }
            }
          }
        }
        
        // Falls immer noch zu lang, kürze am Ende (brutal, aber nötig)
        if (shortened.length > targetMaxLength) {
          shortened = shortened.substring(0, targetMaxLength - 3).trim();
          // Stelle sicher, dass die Nachricht mit Punkt oder Fragezeichen endet
          if (!shortened.endsWith('.') && !shortened.endsWith('?')) {
            shortened += '...';
          }
        }
        
        message = shortened;
        console.log(`✅ Nachricht gekürzt auf ${message.length} Zeichen`);
      }
      
      // 🚨 KRITISCH: ASA-Nachrichten müssen zusätzlich >=150 Zeichen sein (laut Memories)
      if (isASA && message.length < 150) {
        console.warn(`⚠️ ASA-Nachricht zu kurz (${message.length} Zeichen, benötigt >=150) - erweitere weiter...`);
        if (message.length < 150) {
          const additionalText = " Was beschäftigt dich denn gerade so?";
          message += additionalText;
        }
        console.log(`✅ ASA-Nachricht erweitert auf ${message.length} Zeichen`);
      }
      
      // 🚨 NEU: Prüfe nochmal auf mehrere Fragen nach Kürzung
      const finalQuestionMatches = message.match(/\?/g);
      const finalQuestionCount = finalQuestionMatches ? finalQuestionMatches.length : 0;
      if (finalQuestionCount > 1) {
        console.warn(`⚠️ Nachricht enthält immer noch ${finalQuestionCount} Fragen nach Kürzung - reduziere auf 1...`);
        const sentences = message.split(/(?<=[.!?])\s+/);
        const questionSentences = sentences.filter(s => s.trim().endsWith('?'));
        const nonQuestionSentences = sentences.filter(s => !s.trim().endsWith('?'));
        
        if (questionSentences.length > 1) {
          const firstQuestion = questionSentences[0];
          message = [...nonQuestionSentences, firstQuestion].join(' ').trim();
          console.log(`✅ Final reduziert auf 1 Frage: ${message.substring(0, 100)}...`);
        }
      }
    }

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
    let qualityResult = await validateMessageQuality(message, {
      multiAgentResults,
      training,
      context,
      conversationHistory,
      customerMessage,
      allRules,
      situation
    });

    // Wenn Quality Score <85%, versuche Rejection Sampling
    if (qualityResult.overallScore < 85) {
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

      if (bestMessage.qualityScore >= 85) {
        console.log(`✅ Beste Nachricht ausgewählt (Score: ${bestMessage.qualityScore}%)`);
        message = bestMessage.message;
        qualityResult = bestMessage.qualityResult;
      } else {
        console.warn(`⚠️ Auch nach Rejection Sampling Score <85% (${bestMessage.qualityScore}%) - verwende beste verfügbare`);
        message = bestMessage.message;
        qualityResult = bestMessage.qualityResult;
      }
    }

    // 🚨 KRITISCH: Finale Validierung - Blockiere bei kritischen Verstößen
    const criticalViolations = validateCriticalRules(message, allRules, situation);
    if (criticalViolations.length > 0) {
      console.error(`🚨 KRITISCH: Nachricht enthält kritische Verstöße: ${criticalViolations.join(', ')}`);
      return {
        message: '',
        success: false,
        error: `Kritische Regelverstöße: ${criticalViolations.join(', ')}`
      };
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

  // Schritt 2: Profile-Filter (parallel, keine Abhängigkeiten)
  const profileResult = await agentProfileFilter(profileInfo, contextResult, extractedUserInfo);

  // Schritt 3: Situation-Detector & Fake-Context-Builder (können parallel)
  // 🚨 KRITISCH: Übergebe auch conversationHistory und Nachrichten für Kontext-Analyse!
  const [situationResult, fakeContextResult] = await Promise.all([
    agentSituationDetector(customerMessage, allRules, isLocationQuestionFunc, findNearbyCityFunc, isMeetingRequestFunc, profileInfo, extractedUserInfo, conversationHistory, moderatorMessages, customerMessages),
    agentFakeContextBuilder(extractedUserInfo, profileInfo)
  ]);

  // Schritt 3a: Multi-Situation-Handler (analysiert mehrere Situationen)
  const multiSituationResult = await agentMultiSituationHandler(
    situationResult.detectedSituations || [],
    customerMessage,
    allRules,
    conversationHistory
  );

  // Schritt 4: Conversation-Context-Builder & Learning-Context-Builder (können parallel)
  const [conversationContextResult, learningContextResult] = await Promise.all([
    agentConversationContextBuilder(conversationHistory),
    agentLearningContextBuilder(customerMessage, situationResult.detectedSituations || [])
  ]);

  // Schritt 5: Training & Style (benötigen Kontext, aber können parallel)
  // 🤖 ASA-UNTERSTÜTZUNG: Übergebe isASA und asaConversationContext an Training-Selector
  // Training-Selector benötigt jetzt auch Learning-Context
  const [trainingResult, styleResult] = await Promise.all([
    agentTrainingSelector(contextResult, customerMessage, situationResult.detectedSituations || [], vectorDbFunc, isASA, asaConversationContext, trainingData, learningContextResult),
    agentStyleAnalyst(moderatorMessages, customerMessages, contextResult, analyzeWritingStyleFunc, isInfoMessageFunc)
  ]);

  // Schritt 6: Mood & Proactive (benötigen Kontext, aber können parallel)
  const [moodResult, proactiveResult] = await Promise.all([
    agentMoodAnalyst(customerMessage, conversationHistory),
    agentProactiveAnalyst(allMessages || [], customerMessage, proactiveAnalysisFunc)
  ]);

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
    learning: learningContextResult,
    blocked: false
  };

  console.log('✅ Multi-Agent Pipeline abgeschlossen');
  return results;
}

/**
 * 🚨 NEU: QUALITY SCORING & VALIDATION SYSTEM
 * Prüft, ob alle Informationen genutzt wurden und Nachricht qualitativ hochwertig ist
 */
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
    learningSystemUsage: 0
  };

  // 1. Training-Daten-Nutzung prüfen (0-25%)
  if (training?.selectedExamples && training.selectedExamples.length > 0) {
    try {
      const messageEmbedding = await getEmbedding(message);
      if (messageEmbedding) {
        // Vergleiche mit Training-Daten-Beispielen
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
        }
      }
    } catch (err) {
      console.warn('⚠️ Fehler bei Training-Daten-Validierung:', err.message);
    }
  } else {
    // Keine Training-Daten vorhanden
    scores.trainingDataUsage = 25; // Volle Punkte, da nichts zu prüfen
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

  // Gesamt-Score berechnen
  const overallScore = Math.round(
    scores.trainingDataUsage +
    scores.contextUsage +
    scores.rulesCompliance +
    scores.learningSystemUsage
  );

  return {
    overallScore,
    scores,
    details: {
      trainingDataUsage: `${scores.trainingDataUsage.toFixed(1)}%`,
      contextUsage: `${scores.contextUsage.toFixed(1)}%`,
      rulesCompliance: `${scores.rulesCompliance.toFixed(1)}%`,
      learningSystemUsage: `${scores.learningSystemUsage.toFixed(1)}%`
    }
  };
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
function validateCriticalRules(message, allRules, situation) {
  const violations = [];
  const messageLower = message.toLowerCase();

  // 1. Verbotene Wörter (absolut kritisch)
  if (allRules?.forbiddenWords && allRules.forbiddenWords.length > 0) {
    const forbiddenFound = allRules.forbiddenWords.filter(word =>
      messageLower.includes(word.toLowerCase())
    );
    if (forbiddenFound.length > 0) {
      violations.push(`Verbotene Wörter: ${forbiddenFound.join(', ')}`);
    }
  }

  // 2. Treffen-Anfrage (absolut kritisch)
  const meetingKeywords = ['treffen', 'sehen', 'kennenlernen', 'termin', 'wann können wir', 'würde gerne treffen'];
  const isMeetingRequest = meetingKeywords.some(keyword => messageLower.includes(keyword)) &&
    !messageLower.includes('bevor wir uns treffen') && // Höfliche Ablehnung ist OK
    !messageLower.includes('kennenzulernen, bevor wir uns treffen');
  
  if (isMeetingRequest) {
    violations.push('Treffen-Anfrage erkannt');
  }

  // 3. Ausrufezeichen (technisch, aber kritisch)
  if (message.includes('!')) {
    violations.push('Ausrufezeichen gefunden (sollten durch Post-Processing entfernt worden sein)');
  }

  return violations;
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
  runMultiAgentPipeline,
  validateMessageQuality,
  validateCriticalRules
};
