/**
 * 🤖 MULTI-AGENT HANDLER
 * Hauptpfad für Nachrichtengenerierung mit Multi-Agent-Pipeline
 * Unterstützt sowohl ASA (Automated Send-Again) als auch normale Nachrichten
 */

const { runMultiAgentPipeline } = require('../../utils/multi-agent');
const { getClient } = require('../../openaiClient');
const { compressConversation } = require('../../utils/conversation');
const { extractImageUrls } = require('../reply');
const { isInfoMessage, countCustomerMessages, validateAssets } = require('../reply-helpers');

/**
 * Generiert eine Nachricht mit Multi-Agent-Pipeline
 * @param {Object} params - Parameter für die Nachrichtengenerierung
 * @returns {Promise<Object>} - Generierte Nachricht und Metadaten
 */
async function generateMessageWithMultiAgent({
  req,
  client,
  foundMessageText,
  rules,
  trainingData,
  detectedSituations,
  extractedInfo,
  isLastMessageFromFake,
  chatId,
  finalChatId,
  platform,
  platformId,
  customerInfo,
  moderatorInfo,
  metaData,
  assetsToSend
}) {
  console.log('🤖 Multi-Agent Handler: Starte Nachrichtengenerierung...');
  
  try {
    // Erstelle conversationContext für die Pipeline
    let conversationContextForPipeline = "";
    try {
      conversationContextForPipeline = compressConversation(req.body?.siteInfos?.messages || [], 50);
    } catch (err) {
      console.warn('⚠️ Fehler beim Komprimieren der Konversation:', err.message);
    }
    
    // Sammle alle notwendigen Variablen für die Pipeline
    const conversationHistory = conversationContextForPipeline || "";
    const customerMessage = foundMessageText || "";
    const profileInfo = req.body?.siteInfos?.metaData?.customerInfo || {};
    const allRules = rules || { forbiddenWords: [], preferredWords: [], situationalResponses: {} };
    const situations = detectedSituations || [];
    
    // Extrahiere erste Bild-URL (falls vorhanden)
    let imageUrlForPipeline = null;
    try {
      const imageUrlsTemp = extractImageUrls(foundMessageText || "");
      if (imageUrlsTemp && imageUrlsTemp.length > 0) {
        imageUrlForPipeline = imageUrlsTemp[0];
      }
    } catch (err) {
      console.warn('⚠️ Fehler bei Bild-Extraktion:', err.message);
    }
    
    // Sammle Moderator-Nachrichten für Style-Analyse
    const messages = req.body?.siteInfos?.messages || [];
    const moderatorMessagesForPipeline = messages
      .filter(m => !isInfoMessage(m) && (m.type === "sent" || m.messageType === "sent") && typeof m?.text === "string" && m.text.trim() !== "")
      .slice(-20)
      .map(m => ({ text: m.text.trim() }));
    
    // Sammle Kunden-Nachrichten für Style-Analyse
    const customerMessagesForPipeline = messages
      .filter(m => !isInfoMessage(m) && (m.type === "received" || m.messageType === "received") && typeof m?.text === "string" && m.text.trim() !== "")
      .slice(-20)
      .map(m => ({ text: m.text.trim() }));
    
    // Wrapper-Funktion für Vector-DB
    const vectorDbFunc = async (queryText, options) => {
      try {
        const { findSimilarExamples } = require('../../utils/vector-db');
        const situation = options?.situation || (situations.length > 0 ? situations[0] : null);
        const topK = options?.topK || 20;
        const minSimilarity = options?.minSimilarity || 0.3;
        return await findSimilarExamples(queryText, { situation, topK, minSimilarity });
      } catch (err) {
        console.warn('⚠️ Vector-DB Fehler:', err.message);
        return [];
      }
    };
    
    // Wrapper-Funktion für Bild-Analyse
    const imageAnalysisFunc = async (imageUrl, contextAnalysis) => {
      try {
        if (!imageUrl || !client) return { imageType: null, reactionNeeded: null };
        const { fetchImageAsBase64 } = require('../reply');
        const dataUrl = await fetchImageAsBase64(imageUrl);
        if (!dataUrl) return { imageType: null, reactionNeeded: null };
        
        const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
        const typeAnalysis = await client.chat.completions.create({
          model: AI_MODEL,
          messages: [
            {
              role: "system",
              content: "Du analysierst Bilder und kategorisierst sie. Antworte NUR als JSON im Format: {\"type\": \"penis\" | \"nude\" | \"face\" | \"body\" | \"other\", \"confidence\": 0.0-1.0}"
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Analysiere dieses Bild und kategorisiere es. Antworte NUR als JSON." },
                { type: "image_url", image_url: { url: dataUrl } }
              ]
            }
          ],
          max_tokens: 100,
          temperature: 0.1
        });
        
        const typeResult = typeAnalysis.choices?.[0]?.message?.content?.trim();
        if (typeResult) {
          const jsonMatch = typeResult.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return { imageType: parsed.type || null, reactionNeeded: parsed.type || null };
          }
        }
      } catch (err) {
        console.warn('⚠️ Bild-Analyse Fehler:', err.message);
      }
      return { imageType: null, reactionNeeded: null };
    };
    
    // Wrapper-Funktion für Proactive-Analyse
    const proactiveAnalysisFunc = async (allMessages, customerMessage) => {
      try {
        const { detectStagnantConversation } = require('../reply');
        return detectStagnantConversation(allMessages, customerMessage);
      } catch (err) {
        console.warn('⚠️ Proactive-Analyse Fehler:', err.message);
        return { isStagnant: false, suggestions: [] };
      }
    };
    
    // Wrapper-Funktion für analyzeWritingStyle
    const analyzeWritingStyleFunc = (allMessages) => {
      try {
        const { analyzeWritingStyle } = require('../reply');
        return analyzeWritingStyle(allMessages);
      } catch (err) {
        console.warn('⚠️ analyzeWritingStyle Fehler:', err.message);
        return null;
      }
    };
    
    // Wrapper-Funktion für isInfoMessage
    const isInfoMessageFunc = (msg) => {
      try {
        return isInfoMessage(msg);
      } catch (err) {
        console.warn('⚠️ isInfoMessage Fehler:', err.message);
        return false;
      }
    };
    
    // 🤖 ASA-UNTERSTÜTZUNG: Bereite ASA-Parameter vor
    const isASA = isLastMessageFromFake || false;
    const asaConversationContext = isASA ? (compressConversation(req.body?.siteInfos?.messages || [], 10) || "").toLowerCase() : '';
    
    // Rufe Multi-Agent Pipeline auf
    const multiAgentResults = await runMultiAgentPipeline({
      conversationHistory,
      customerMessage,
      profileInfo,
      extractedUserInfo: extractedInfo,
      allRules,
      situations,
      imageUrl: imageUrlForPipeline,
      moderatorMessages: moderatorMessagesForPipeline,
      customerMessages: customerMessagesForPipeline,
      allMessages: messages,
      vectorDbFunc,
      imageAnalysisFunc,
      proactiveAnalysisFunc,
      analyzeWritingStyleFunc,
      isInfoMessageFunc,
      isASA: isASA,
      asaConversationContext: asaConversationContext
    });
    
    console.log('🤖 Multi-Agent Pipeline abgeschlossen:', {
      context: multiAgentResults?.context?.topic || 'unknown',
      training: multiAgentResults?.training?.selectedExamples?.length || 0,
      style: multiAgentResults?.style?.style || 'neutral',
      mood: multiAgentResults?.mood?.mood || 'neutral',
      proactive: multiAgentResults?.proactive?.isStagnant || false,
      image: multiAgentResults?.image?.imageType || null,
      profile: multiAgentResults?.profile?.relevantInfo?.length || 0
    });
    
    // Generiere Nachricht basierend auf Multi-Agent-Ergebnissen
    if (isASA) {
      return await generateASAMessage({
        req,
        client,
        multiAgentResults,
        trainingData,
        rules,
        chatId,
        finalChatId,
        platform,
        platformId,
        customerInfo,
        moderatorInfo,
        metaData,
        assetsToSend,
        asaConversationContext
      });
    } else {
      return await generateNormalMessage({
        req,
        client,
        multiAgentResults,
        trainingData,
        rules,
        foundMessageText,
        detectedSituations,
        extractedInfo,
        chatId,
        finalChatId,
        platform,
        platformId,
        customerInfo,
        moderatorInfo,
        metaData,
        assetsToSend,
        messages
      });
    }
  } catch (err) {
    console.error('❌ Multi-Agent Handler Fehler:', err.message);
    console.error('❌ Stack:', err.stack);
    throw err; // Wirf Fehler weiter, damit Fallback-Handler verwendet wird
  }
}

/**
 * Generiert eine ASA (Automated Send-Again) Nachricht
 */
async function generateASAMessage({
  req,
  client,
  multiAgentResults,
  trainingData,
  rules,
  chatId,
  finalChatId,
  platform,
  platformId,
  customerInfo,
  moderatorInfo,
  metaData,
  assetsToSend,
  asaConversationContext
}) {
  console.log("🔄 Multi-Agent Handler: Generiere ASA-Nachricht...");
  
  // TODO: Implementiere ASA-Generierung mit Multi-Agent-Ergebnissen
  // Für jetzt: Fallback auf alte Logik (wird später implementiert)
  throw new Error('ASA-Generierung noch nicht implementiert - verwende Fallback');
}

/**
 * Generiert eine normale Nachricht
 */
async function generateNormalMessage({
  req,
  client,
  multiAgentResults,
  trainingData,
  rules,
  foundMessageText,
  detectedSituations,
  extractedInfo,
  chatId,
  finalChatId,
  platform,
  platformId,
  customerInfo,
  moderatorInfo,
  metaData,
  assetsToSend,
  messages
}) {
  console.log("💬 Multi-Agent Handler: Generiere normale Nachricht...");
  
  // TODO: Implementiere normale Nachrichtengenerierung mit Multi-Agent-Ergebnissen
  // Für jetzt: Fallback auf alte Logik (wird später implementiert)
  throw new Error('Normale Nachrichtengenerierung noch nicht implementiert - verwende Fallback');
}

module.exports = {
  generateMessageWithMultiAgent
};


