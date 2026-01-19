/**
 * FINE-TUNING UTILITY
 * 
 * Diese Datei enthält alle Funktionen für Fine-Tuning von OpenAI-Modellen.
 * - Sammelt perfekte Beispiele aus Feedback und Training-Daten
 * - Konvertiert zu JSONL-Format für OpenAI
 * - Lädt Daten hoch und startet Fine-Tuning
 * - Prüft Status und verwaltet Modelle
 */

const fs = require('fs');
const path = require('path');
const { getClient } = require('../openaiClient');
const { getGitHubClient, getRepoInfo } = require('./github');

// Lade Feedback-Daten
async function getFeedbackData() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/feedback.json',
        'src/config/feedback.json',
        'config/feedback.json',
        'server/config/feedback.json'
      ];
      
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          if (response.data && response.data.content) {
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            return JSON.parse(content);
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('⚠️ Fehler beim Laden der Feedback-Daten von GitHub:', err.message);
      }
    }
  }
  
  // Fallback: Lade von lokaler Datei
  const feedbackPath = path.join(__dirname, '../../config/feedback.json');
  try {
    if (fs.existsSync(feedbackPath)) {
      const data = fs.readFileSync(feedbackPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Feedback-Daten:', err);
  }
  return { feedbacks: [] };
}

// Lade Training-Daten
async function getTrainingData() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/training-data.json',
        'src/config/training-data.json',
        'config/training-data.json',
        'server/config/training-data.json'
      ];
      
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          if (response.data && response.data.content) {
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            return JSON.parse(content);
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('⚠️ Fehler beim Laden der Training-Daten von GitHub:', err.message);
      }
    }
  }
  
  // Fallback: Lade von lokaler Datei
  const trainingPath = path.join(__dirname, '../../config/training-data.json');
  try {
    if (fs.existsSync(trainingPath)) {
      const data = fs.readFileSync(trainingPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Training-Daten:', err);
  }
  return { conversations: [], asaExamples: [] };
}

// Lade Fine-Tuning-Config
async function getFineTuningConfig() {
  const configPath = path.join(__dirname, '../../config/fine-tuning-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Fine-Tuning-Config:', err);
  }
  
  // Standard-Config
  return {
    modelId: null,
    lastTrained: null,
    trainingExamplesCount: 0,
    nextRetrainAt: 50,
    currentJobId: null,
    status: 'idle',
    systemPrompt: `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du verwaltest verschiedene Fake-Profile und antwortest als diese Profile auf Kunden-Nachrichten.

HARTE REGELN (NIEMALS verletzen):
1. KEINE Treffen zustimmen (immer ablehnen, höflich ausweichen)
2. KEINE verbotenen Wörter verwenden (siehe Liste im User-Prompt)
3. Mindestens 120 Zeichen (bei Erstnachrichten 150 Zeichen, vollständig zu Ende schreiben)
4. Natürlich und authentisch (nicht nach KI klingen)

STIL:
- Sei warmherzig, interessiert, menschlich
- Stelle Fragen, um Gespräch am Laufen zu halten
- Gehe auf alle Anfragen/Themen ein
- Zeige Eigeninitiative (nenne eigene Vorlieben/Interessen, dann frage)`
  };
}

// Speichere Fine-Tuning-Config
async function saveFineTuningConfig(config) {
  const configPath = path.join(__dirname, '../../config/fine-tuning-config.json');
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Sammle alle perfekten Beispiele aus Feedback und Training-Daten
// Gibt auch ausgeschlossene Beispiele zurück für Debugging/Bearbeitung
async function collectPerfectExamples(includeExcluded = false) {
  const examples = [];
  const seen = new Set(); // Für Deduplizierung
  
  // Debug-Zähler und ausgeschlossene Beispiele
  let skippedTooShort = { feedback_good: 0, feedback_edited: 0, training: 0, asa: 0 };
  let skippedDuplicate = { feedback_good: 0, feedback_edited: 0, training: 0, asa: 0 };
  let skippedNoMessage = { feedback_good: 0, feedback_edited: 0, training: 0, asa: 0 };
  const excludedExamples = {
    tooShort: [],
    duplicate: [],
    noMessage: []
  };
  
  // 1. Sammle aus Feedback-Daten
  const feedbackData = await getFeedbackData();
  if (feedbackData && feedbackData.feedbacks) {
    console.log(`📊 Prüfe ${feedbackData.feedbacks.length} Feedbacks...`);
    feedbackData.feedbacks.forEach(feedback => {
      // "good" Feedbacks: aiResponse ist gut
      if (feedback.status === 'good' && feedback.aiResponse) {
        const key = `${feedback.customerMessage || ''}|${feedback.aiResponse}`;
        if (seen.has(key)) {
          skippedDuplicate.feedback_good++;
          if (includeExcluded) {
            excludedExamples.duplicate.push({
              source: 'feedback_good',
              customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
              moderatorResponse: feedback.aiResponse,
              reason: 'duplicate',
              length: feedback.aiResponse.length,
              feedbackId: feedback.id
            });
          }
          return;
        }
        if (feedback.aiResponse.length < 120) {
          skippedTooShort.feedback_good++;
          if (includeExcluded) {
            excludedExamples.tooShort.push({
              source: 'feedback_good',
              customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
              moderatorResponse: feedback.aiResponse,
              reason: 'too_short',
              length: feedback.aiResponse.length,
              feedbackId: feedback.id
            });
          }
          return;
        }
        seen.add(key);
        examples.push({
          customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
          moderatorResponse: feedback.aiResponse,
          situation: feedback.situation || feedback.context?.detectedSituations?.[0] || 'allgemein',
          source: 'feedback_good',
          feedbackId: feedback.id
        });
      } else if (feedback.status === 'good') {
        skippedNoMessage.feedback_good++;
        if (includeExcluded) {
          excludedExamples.noMessage.push({
            source: 'feedback_good',
            customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
            moderatorResponse: null,
            reason: 'no_message',
            feedbackId: feedback.id
          });
        }
      }
      
      // "edited" Feedbacks: editedResponse ist gut (bearbeitete Version)
      if (feedback.status === 'edited' && feedback.editedResponse) {
        const key = `${feedback.customerMessage || ''}|${feedback.editedResponse}`;
        if (seen.has(key)) {
          skippedDuplicate.feedback_edited++;
          if (includeExcluded) {
            excludedExamples.duplicate.push({
              source: 'feedback_edited',
              customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
              moderatorResponse: feedback.editedResponse,
              reason: 'duplicate',
              length: feedback.editedResponse.length,
              feedbackId: feedback.id
            });
          }
          return;
        }
        if (feedback.editedResponse.length < 120) {
          skippedTooShort.feedback_edited++;
          if (includeExcluded) {
            excludedExamples.tooShort.push({
              source: 'feedback_edited',
              customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
              moderatorResponse: feedback.editedResponse,
              reason: 'too_short',
              length: feedback.editedResponse.length,
              feedbackId: feedback.id
            });
          }
          return;
        }
        seen.add(key);
        examples.push({
          customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
          moderatorResponse: feedback.editedResponse,
          situation: feedback.situation || feedback.context?.detectedSituations?.[0] || 'allgemein',
          source: 'feedback_edited',
          feedbackId: feedback.id
        });
      } else if (feedback.status === 'edited') {
        skippedNoMessage.feedback_edited++;
        if (includeExcluded) {
          excludedExamples.noMessage.push({
            source: 'feedback_edited',
            customerMessage: feedback.customerMessage || (feedback.isASA ? "ASA Reaktivierung" : ""),
            moderatorResponse: null,
            reason: 'no_message',
            feedbackId: feedback.id
          });
        }
      }
    });
  }
  
  // 2. Sammle aus Training-Daten (nur positive Beispiele)
  const trainingData = await getTrainingData();
  
  // 2.1 Aus conversations
  if (trainingData && trainingData.conversations) {
    console.log(`📊 Prüfe ${trainingData.conversations.length} Training-Gespräche...`);
    trainingData.conversations.forEach((conv, index) => {
      // Nur positive Beispiele (nicht isNegativeExample)
      if (conv.isNegativeExample) return;
      if (!conv.moderatorResponse) {
        skippedNoMessage.training++;
        if (includeExcluded) {
          excludedExamples.noMessage.push({
            source: 'training_data',
            customerMessage: conv.customerMessage || "",
            moderatorResponse: null,
            reason: 'no_message',
            index: index
          });
        }
        return;
      }
      if (conv.moderatorResponse.length < 120) {
        skippedTooShort.training++;
        if (includeExcluded) {
          excludedExamples.tooShort.push({
            source: 'training_data',
            customerMessage: conv.customerMessage || "",
            moderatorResponse: conv.moderatorResponse,
            reason: 'too_short',
            length: conv.moderatorResponse.length,
            index: index
          });
        }
        return;
      }
      const key = `${conv.customerMessage || ''}|${conv.moderatorResponse}`;
      if (seen.has(key)) {
        skippedDuplicate.training++;
        if (includeExcluded) {
          excludedExamples.duplicate.push({
            source: 'training_data',
            customerMessage: conv.customerMessage || "",
            moderatorResponse: conv.moderatorResponse,
            reason: 'duplicate',
            length: conv.moderatorResponse.length,
            index: index
          });
        }
        return;
      }
      seen.add(key);
      examples.push({
        customerMessage: conv.customerMessage || "",
        moderatorResponse: conv.moderatorResponse,
        situation: conv.situation || 'allgemein',
        source: 'training_data'
      });
    });
  }
  
  // 2.2 Aus asaExamples
  if (trainingData && trainingData.asaExamples) {
    console.log(`📊 Prüfe ${trainingData.asaExamples.length} ASA-Beispiele...`);
    trainingData.asaExamples.forEach((asa, index) => {
      const asaMessage = asa.asaMessage || asa.moderatorResponse;
      if (!asaMessage) {
        skippedNoMessage.asa++;
        if (includeExcluded) {
          excludedExamples.noMessage.push({
            source: 'asa_training_data',
            customerMessage: "ASA Reaktivierung",
            moderatorResponse: null,
            reason: 'no_message',
            index: index,
            asaData: asa
          });
        }
        console.log(`⚠️ ASA-Beispiel ohne Nachricht:`, asa);
        return;
      }
      if (asaMessage.length < 120) {
        skippedTooShort.asa++;
        if (includeExcluded) {
          excludedExamples.tooShort.push({
            source: 'asa_training_data',
            customerMessage: "ASA Reaktivierung",
            moderatorResponse: asaMessage,
            reason: 'too_short',
            length: asaMessage.length,
            index: index
          });
        }
        console.log(`⚠️ ASA-Beispiel zu kurz (${asaMessage.length} Zeichen):`, asaMessage.substring(0, 100));
        return;
      }
      const key = `ASA Reaktivierung|${asaMessage}`;
      if (seen.has(key)) {
        skippedDuplicate.asa++;
        if (includeExcluded) {
          excludedExamples.duplicate.push({
            source: 'asa_training_data',
            customerMessage: "ASA Reaktivierung",
            moderatorResponse: asaMessage,
            reason: 'duplicate',
            length: asaMessage.length,
            index: index
          });
        }
        return;
      }
      seen.add(key);
      examples.push({
        customerMessage: "ASA Reaktivierung",
        moderatorResponse: asaMessage,
        situation: asa.situation || 'ASA Reaktivierung',
        source: 'asa_training_data'
      });
    });
  }
  
  console.log(`✅ ${examples.length} perfekte Beispiele gesammelt:`);
  console.log(`   - Feedback (good): ${examples.filter(e => e.source === 'feedback_good').length} (übersprungen: ${skippedTooShort.feedback_good} zu kurz, ${skippedDuplicate.feedback_good} dupliziert, ${skippedNoMessage.feedback_good} ohne Nachricht)`);
  console.log(`   - Feedback (edited): ${examples.filter(e => e.source === 'feedback_edited').length} (übersprungen: ${skippedTooShort.feedback_edited} zu kurz, ${skippedDuplicate.feedback_edited} dupliziert, ${skippedNoMessage.feedback_edited} ohne Nachricht)`);
  console.log(`   - Training-Daten: ${examples.filter(e => e.source === 'training_data').length} (übersprungen: ${skippedTooShort.training} zu kurz, ${skippedDuplicate.training} dupliziert, ${skippedNoMessage.training} ohne Nachricht)`);
  console.log(`   - ASA-Beispiele: ${examples.filter(e => e.source === 'asa_training_data').length} (übersprungen: ${skippedTooShort.asa} zu kurz, ${skippedDuplicate.asa} dupliziert, ${skippedNoMessage.asa} ohne Nachricht)`);
  
  if (includeExcluded) {
    return {
      examples,
      excluded: excludedExamples,
      stats: {
        total: examples.length,
        excluded: {
          tooShort: excludedExamples.tooShort.length,
          duplicate: excludedExamples.duplicate.length,
          noMessage: excludedExamples.noMessage.length,
          total: excludedExamples.tooShort.length + excludedExamples.duplicate.length + excludedExamples.noMessage.length
        }
      }
    };
  }
  
  return examples;
}

// Prüfe Beispiel mit OpenAI Moderation API
async function checkModeration(text) {
  const client = getClient();
  if (!client) {
    return { flagged: false, categories: {} };
  }
  
  try {
    const moderation = await client.moderations.create({
      input: text
    });
    
    const result = moderation.results[0];
    return {
      flagged: result.flagged,
      categories: result.categories,
      categoryScores: result.category_scores
    };
  } catch (err) {
    console.error('⚠️ Fehler bei Moderation-Check:', err.message);
    // Bei Fehler: erlaube das Beispiel (besser als alles zu blockieren)
    return { flagged: false, categories: {} };
  }
}

// Filtere Beispiele mit Moderation API
// WICHTIG: Filtert nur sehr problematische Kategorien (Gewalt, Selbstverletzung, etc.)
// "Sexual" wird NICHT gefiltert, da das für Chat-Moderation normal ist
async function filterWithModeration(examples) {
  console.log(`🔍 Prüfe ${examples.length} Beispiele mit OpenAI Moderation API...`);
  
  // Nur diese Kategorien werden wirklich gefiltert (sehr problematisch):
  const CRITICAL_CATEGORIES = [
    'violence',           // Gewalt
    'violence/graphic',   // Grafische Gewalt
    'self-harm',          // Selbstverletzung
    'self-harm/intent',   // Selbstverletzungsabsicht
    'self-harm/instructions', // Anleitungen zu Selbstverletzung
    'illegal',            // Illegale Aktivitäten
    'hate',               // Hassrede
    'hate/threatening',   // Bedrohende Hassrede
    'harassment/threatening' // Bedrohende Belästigung
  ];
  
  // Diese Kategorien werden NUR gewarnt, aber nicht gefiltert:
  const WARNING_CATEGORIES = [
    'harassment'          // Belästigung (wird nur gewarnt)
  ];
  
  // 🚨 NEU: Für Fine-Tuning filtern wir "sexual" heraus (für Prompt verwenden wir sie trotzdem)
  // Diese Kategorien werden für Fine-Tuning gefiltert, aber für Prompt verwendet:
  const SEXUAL_CATEGORIES = [
    'sexual',             // Sexueller Inhalt (wird für Fine-Tuning gefiltert, aber für Prompt verwendet)
    'sexual/minors'       // Sexueller Inhalt mit Minderjährigen (wird trotzdem gefiltert!)
  ];
  
  const safeExamples = [];
  const flaggedExamples = [];
  const warningExamples = [];
  
  for (let i = 0; i < examples.length; i++) {
    const example = examples[i];
    
    // Prüfe sowohl Kunden-Nachricht als auch Moderator-Antwort
    const customerText = example.customerMessage || '';
    const moderatorText = example.moderatorResponse || '';
    const combinedText = `${customerText} ${moderatorText}`.trim();
    
    if (!combinedText) {
      // Leere Beispiele überspringen
      flaggedExamples.push({
        ...example,
        reason: 'empty',
        flaggedCategories: []
      });
      continue;
    }
    
    // Prüfe mit Moderation API
    const moderation = await checkModeration(combinedText);
    
    if (moderation.flagged) {
      // Finde welche Kategorien geflaggt wurden
      const flaggedCategories = Object.keys(moderation.categories || {}).filter(
        cat => moderation.categories[cat] === true
      );
      
      // Prüfe ob kritische Kategorien dabei sind
      const hasCritical = flaggedCategories.some(cat => CRITICAL_CATEGORIES.includes(cat));
      const hasSexualMinors = flaggedCategories.includes('sexual/minors');
      const hasSexual = flaggedCategories.includes('sexual'); // 🚨 NEU: Für Fine-Tuning filtern
      
      if (hasCritical || hasSexualMinors) {
        // KRITISCH: Filtere diese Beispiele heraus
        flaggedExamples.push({
          ...example,
          reason: 'moderation_critical',
          flaggedCategories,
          categoryScores: moderation.categoryScores
        });
        
        console.log(`❌ Beispiel ${i + 1}/${examples.length} GEFILTERT (kritisch): ${flaggedCategories.join(', ')}`);
      } else if (hasSexual) {
        // 🚨 NEU: Sexuelle Inhalte für Fine-Tuning filtern (aber für Prompt verwenden)
        flaggedExamples.push({
          ...example,
          reason: 'moderation_sexual', // Spezieller Grund für sexuelle Inhalte
          flaggedCategories,
          categoryScores: moderation.categoryScores
        });
        
        console.log(`⚠️ Beispiel ${i + 1}/${examples.length} GEFILTERT (sexuell, für Fine-Tuning): ${flaggedCategories.join(', ')}`);
      } else {
        // NUR WARNUNG: Behalte diese Beispiele, aber warne
        warningExamples.push({
          ...example,
          reason: 'moderation_warning',
          flaggedCategories,
          categoryScores: moderation.categoryScores
        });
        
        safeExamples.push(example); // Trotzdem verwenden
        console.log(`⚠️ Beispiel ${i + 1}/${examples.length} WARNUNG (aber verwendet): ${flaggedCategories.join(', ')}`);
      }
    } else {
      safeExamples.push(example);
    }
    
    // Zeige Fortschritt alle 50 Beispiele
    if ((i + 1) % 50 === 0) {
      console.log(`✅ ${i + 1}/${examples.length} Beispiele geprüft, ${safeExamples.length} sicher, ${flaggedExamples.length} gefiltert, ${warningExamples.length} Warnungen`);
    }
  }
  
  console.log(`✅ Moderation-Check abgeschlossen: ${safeExamples.length} sicher, ${flaggedExamples.length} gefiltert (kritisch), ${warningExamples.length} Warnungen`);
  
  return {
    safe: safeExamples,
    flagged: flaggedExamples,
    warnings: warningExamples
  };
}

// Konvertiere Beispiele zu JSONL-Format für OpenAI
function convertToJSONL(examples, systemPrompt, rules = null) {
  const jsonlLines = [];
  
  examples.forEach(example => {
    // Erstelle User-Prompt mit Situation und Kunden-Nachricht
    let userContent = '';
    if (example.situation && example.situation !== 'allgemein') {
      userContent += `Situation: ${example.situation}\n`;
    }
    userContent += `Kunde: "${example.customerMessage}"\n\n`;
    userContent += `Antworte als Chat-Moderator.`;
    
    // Füge verbotene Wörter hinzu, falls vorhanden
    if (rules && rules.forbiddenWords && rules.forbiddenWords.length > 0) {
      userContent += `\n\nWICHTIG: Diese Wörter NIEMALS verwenden: ${rules.forbiddenWords.slice(0, 20).join(', ')}`;
    }
    
    // Erstelle messages-Array
    const messages = [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: userContent
      },
      {
        role: "assistant",
        content: example.moderatorResponse
      }
    ];
    
    // Konvertiere zu JSONL (eine Zeile pro Beispiel)
    jsonlLines.push(JSON.stringify({ messages }));
  });
  
  return jsonlLines.join('\n');
}

// Lade Daten zu OpenAI hoch
async function uploadToOpenAI(jsonlData) {
  const client = getClient();
  if (!client) {
    throw new Error('OpenAI Client nicht verfügbar');
  }
  
  // Erstelle temporäre Datei
  const tempPath = path.join(__dirname, '../../config/temp-training-data.jsonl');
  fs.writeFileSync(tempPath, jsonlData);
  
  try {
    // Lade Datei zu OpenAI hoch
    console.log('📤 Lade JSONL-Datei zu OpenAI hoch...');
    const file = await client.files.create({
      file: fs.createReadStream(tempPath),
      purpose: 'fine-tune'
    });
    
    console.log(`✅ Daten zu OpenAI hochgeladen: File-ID ${file.id}`);
    
    // 🚨 NEU: Warte kurz und prüfe ob die Datei validiert wurde
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      const fileStatus = await client.files.retrieve(file.id);
      console.log(`📋 File-Status: ${fileStatus.status || 'unknown'}`);
      if (fileStatus.status === 'error') {
        throw new Error(`Datei-Validierung fehlgeschlagen: ${fileStatus.error || 'Unbekannter Fehler'}`);
      }
    } catch (err) {
      console.warn('⚠️ Konnte File-Status nicht prüfen:', err.message);
    }
    
    return file.id;
  } catch (err) {
    console.error('❌ Fehler beim Hochladen zu OpenAI:', {
      error: err.message,
      errorType: err.type || 'unknown',
      statusCode: err.status || 'N/A'
    });
    
    // 🚨 NEU: Spezifische Fehlermeldungen für häufige Probleme
    if (err.message && err.message.includes('unsafe')) {
      throw new Error('OpenAI hat die Datei als unsicher eingestuft (Moderation API). Bitte überprüfe die Training-Daten auf problematische Inhalte.');
    }
    if (err.message && err.message.includes('invalid')) {
      throw new Error('OpenAI hat die Datei als ungültig eingestuft. Bitte überprüfe das JSONL-Format.');
    }
    
    throw err;
  } finally {
    // Lösche temporäre Datei
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

// Starte Fine-Tuning-Job
// WICHTIG: gpt-4o-mini ist NICHT für Fine-Tuning verfügbar!
// Verfügbare Models: gpt-3.5-turbo, babbage-002, davinci-002
async function startFineTuning(fileId, baseModel = 'gpt-3.5-turbo') {
  const client = getClient();
  if (!client) {
    throw new Error('OpenAI Client nicht verfügbar');
  }
  
  try {
    console.log(`🎯 Starte Fine-Tuning-Job mit Model: ${baseModel}, File-ID: ${fileId}...`);
    
    // Erstelle Fine-Tuning-Job
    const fineTune = await client.fineTuning.jobs.create({
      training_file: fileId,
      model: baseModel,
      hyperparameters: {
        n_epochs: 3 // 3 Epochen für gutes Lernen
      }
    });
    
    console.log(`✅ Fine-Tuning-Job erfolgreich gestartet!`);
    console.log(`   Job-ID: ${fineTune.id}`);
    console.log(`   Status: ${fineTune.status}`);
    console.log(`   Model: ${baseModel}`);
    console.log(`   🔗 Siehe Details: https://platform.openai.com/finetune`);
    
    return fineTune.id;
  } catch (err) {
    console.error('❌ Fehler beim Starten des Fine-Tuning-Jobs:', {
      error: err.message,
      errorType: err.type || 'unknown',
      statusCode: err.status || 'N/A',
      fileId
    });
    
    // 🚨 NEU: Spezifische Fehlermeldungen für häufige Probleme
    if (err.message && err.message.includes('unsafe')) {
      throw new Error('OpenAI hat die Training-Datei als unsicher eingestuft (Moderation API). Die Datei enthält zu viele problematische Inhalte. Bitte überprüfe die gefilterten Beispiele im Dashboard.');
    }
    if (err.message && err.message.includes('invalid')) {
      throw new Error('OpenAI hat die Training-Datei als ungültig eingestuft. Bitte überprüfe das JSONL-Format und die Datenstruktur.');
    }
    if (err.message && err.message.includes('not available')) {
      throw new Error(`Das Model "${baseModel}" ist nicht für Fine-Tuning verfügbar. Verfügbare Models: gpt-3.5-turbo, babbage-002, davinci-002`);
    }
    
    throw err;
  }
}

// Prüfe Fine-Tuning-Status
async function checkFineTuningStatus(jobId) {
  const client = getClient();
  if (!client) {
    throw new Error('OpenAI Client nicht verfügbar');
  }
  
  try {
    const job = await client.fineTuning.jobs.retrieve(jobId);
    
    // 🚨 NEU: Detaillierte Fehler-Logging
    if (job.error) {
      console.error('❌ Fine-Tuning-Job Fehler:', {
        jobId: job.id,
        status: job.status,
        error: job.error,
        errorMessage: job.error.message || 'Unbekannter Fehler',
        errorCode: job.error.code || 'N/A'
      });
    }
    
    return {
      status: job.status, // 'validating_files', 'queued', 'running', 'succeeded', 'failed', 'cancelled'
      modelId: job.fine_tuned_model || null, // null bis succeeded
      error: job.error ? (job.error.message || JSON.stringify(job.error)) : null,
      errorDetails: job.error || null
    };
  } catch (err) {
    console.error('❌ Fehler beim Prüfen des Fine-Tuning-Status:', {
      jobId,
      error: err.message,
      stack: err.stack
    });
    return {
      status: 'error',
      modelId: null,
      error: err.message
    };
  }
}

// 🚨 NEU: Liste alle Fine-Tuning-Jobs von OpenAI
async function listFineTuningJobs(limit = 10) {
  const client = getClient();
  if (!client) {
    throw new Error('OpenAI Client nicht verfügbar');
  }
  
  try {
    const jobs = await client.fineTuning.jobs.list({ limit });
    return jobs.data.map(job => ({
      id: job.id,
      status: job.status,
      model: job.model,
      fineTunedModel: job.fine_tuned_model,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
      error: job.error ? {
        message: job.error.message,
        code: job.error.code,
        param: job.error.param
      } : null
    }));
  } catch (err) {
    console.error('❌ Fehler beim Abrufen der Fine-Tuning-Jobs:', err.message);
    throw err;
  }
}

// Erstelle System-Prompt mit Regeln
async function buildSystemPrompt() {
  const rules = await getRules();
  const config = await getFineTuningConfig();
  
  let systemPrompt = config.systemPrompt;
  
  // Füge verbotene Wörter hinzu, falls vorhanden
  if (rules && rules.forbiddenWords && rules.forbiddenWords.length > 0) {
    systemPrompt += `\n\nVERBOTENE WÖRTER (NIEMALS verwenden):\n${rules.forbiddenWords.slice(0, 30).join(', ')}`;
  }
  
  // Füge bevorzugte Wörter hinzu, falls vorhanden
  if (rules && rules.preferredWords && rules.preferredWords.length > 0) {
    systemPrompt += `\n\nBEVORZUGTE WÖRTER (verwende regelmäßig):\n${rules.preferredWords.slice(0, 30).join(', ')}`;
  }
  
  return systemPrompt;
}

// Helper: Lade Regeln (kopiert aus dashboard.js)
async function getRules() {
  const githubClient = getGitHubClient();
  if (githubClient) {
    try {
      const repo = getRepoInfo();
      const possiblePaths = [
        'server/src/config/rules.json',
        'src/config/rules.json',
        'config/rules.json',
        'server/config/rules.json'
      ];
      
      for (const filePath of possiblePaths) {
        try {
          const response = await githubClient.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: filePath,
            ref: repo.branch
          });
          if (response.data && response.data.content) {
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            return JSON.parse(content);
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('⚠️ Fehler beim Laden von GitHub:', err.message);
      }
    }
  }
  
  // Fallback: Lade von lokaler Datei
  const rulesPath = path.join(__dirname, '../../config/rules.json');
  try {
    if (fs.existsSync(rulesPath)) {
      const data = fs.readFileSync(rulesPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Fehler beim Laden der Regeln:', err);
  }
  
  return {
    forbiddenWords: [],
    preferredWords: [],
    generalRules: "",
    situationalResponses: {}
  };
}

module.exports = {
  collectPerfectExamples,
  convertToJSONL,
  uploadToOpenAI,
  startFineTuning,
  checkFineTuningStatus,
  listFineTuningJobs,
  getFineTuningConfig,
  saveFineTuningConfig,
  buildSystemPrompt,
  filterWithModeration: filterWithModeration, // Explizit zugewiesen, um sicherzustellen dass es exportiert wird
  checkModeration: checkModeration
};
