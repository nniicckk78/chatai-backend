/**
 * Grok-Post-Processor: Korrektor-/Verbesserer-LoRA (Together.ai)
 *
 * Nach der Grok-Generierung wird die Nachricht optional an ein fein-getuntes
 * LoRA-Modell geschickt, das sie korrigiert (Regelverstöße) und verbessert
 * (Stil/Klarheit wie in Trainingsdaten und Feedback).
 *
 * Env: USE_GROK_CORRECTOR_LORA=true, CORRECTOR_LORA_MODEL_ID=<together-model-id>
 */

const { getTogetherClient } = require('../openaiClient');

const CORRECTOR_TIMEOUT_MS = 15000;
const CORRECTOR_MAX_TOKENS = 300;

/**
 * Ruft das Korrektor-LoRA auf (Together.ai). Gibt bei Fehler/Deaktivierung den Originaltext zurück.
 *
 * @param {Object} opts
 * @param {string} opts.customerMessage - letzte Kundennachricht
 * @param {Object} opts.context - Kontext-Flags für die LoRA
 * @param {boolean} [opts.context.isEmotional] - Kunde wirkt traurig/emotional
 * @param {boolean} [opts.context.noSexHint] - Kunde möchte nicht über Sex schreiben
 * @param {boolean} [opts.context.isMeetingSituation] - Treffen/Bar/Zeit-Thema
 * @param {boolean} [opts.context.hasProfilePic] - Kunde hat Profilbild (false = Aussehen nicht erwähnen)
 * @param {boolean} [opts.context.allowSexualContent] - true = sexuelle Inhalte NICHT entfernen (Kunde will Sex-Thema)
 * @param {boolean} [opts.context.contactRequest] - Kunde fragt nach Kontaktdaten (freundlich ablehnen, nicht sexualisieren)
 * @param {boolean} [opts.context.customerIrritated] - Kunde wirkt gereizt (deeskalierend, thematisch, keine Sexualisierung)
 * @param {boolean} [opts.context.customerTalkingAboutSexWithFake] - Kunde spricht direkt über Sex mit Fake (eigene Erregung ist passend)
 * @param {string} opts.grokText - von Grok generierter Text (wird korrigiert/verbessert)
 * @returns {Promise<string>} korrigierter/verbesserter Text oder grokText bei Fehler
 */
async function correctAndImproveMessage({ customerMessage = '', context = {}, grokText = '' }) {
  const useCorrector = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
  const modelId = (process.env.CORRECTOR_LORA_MODEL_ID || '').trim();

  if (!grokText || !grokText.trim()) {
    return grokText;
  }
  if (!useCorrector) {
    console.log('ℹ️ Grok-Korrektor: übersprungen (USE_GROK_CORRECTOR_LORA nicht true/1)');
    return grokText;
  }
  if (!modelId) {
    console.log('ℹ️ Grok-Korrektor: übersprungen (CORRECTOR_LORA_MODEL_ID fehlt)');
    return grokText;
  }

  const client = getTogetherClient();
  if (!client) {
    console.warn('⚠️ Grok-Korrektor: Together-Client nicht verfügbar (TOGETHER_API_KEY fehlt oder ungültig) – überspringe Korrektur');
    return grokText;
  }

  console.log(`🔧 Grok-Korrektor: rufe LoRA auf (Modell: ${modelId})`);

  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push('Thema Treffen/Bar/Zeit');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';

  const userContent = `${contextLine}Kundennachricht: "${(customerMessage || '').trim().slice(0, 400)}"\n\nZu korrigieren und verbessern (Regelverstöße entfernen, Stil wie in Trainingsdaten/Feedback verbessern – gib nur den fertigen Text zurück, keine Erklärungen):\n\n${grokText.trim()}`;

  const sexualRule = context.allowSexualContent === true
    ? (context.customerTalkingAboutSexWithFake === true
      ? 'WICHTIG: Kunde spricht direkt über Sex mit Fake – sexuelle Inhalte und eigene Erregung sind passend. Entferne oder entschärfe sie NICHT. Nur echte Regelverstöße (z.B. Aussehen ohne Profilbild, Bar/Ort bei Treffen) korrigieren.'
      : 'WICHTIG: Kunde erzählt Story/Erlebnis (ohne direkten Sex-Bezug zum Fake) – eigene Erregungs-Beschreibungen der Moderatoren-Persona (z.B. "macht mich feucht", "stell ich mir geil vor") entschärfen oder entfernen. Auf Inhalt reagieren (lustig, wild, interessant), nicht mit eigener körperlicher Reaktion. Flirty/spielerisch bleiben, aber ohne selbstbezogene Erregung.')
    : 'Entferne sexuelle Formulierungen nur, wenn im Kontext steht "Kunde möchte nicht über Sex schreiben". Sonst lasse den Text inhaltlich wie er ist.';
  const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
    ? 'Bei Kontaktdaten-Anfrage oder gereiztem Kunden: Antwort sachlich und deeskalierend halten, keine sexuellen Anspielungen einbauen oder verstärken. Thematisch passende Frage am Ende.'
    : '';
  const contextRule = 'Entscheide immer anhand des gesamten Kontexts und der Kundennachricht – nie anhand einzelner Wörter (z.B. Kuss/Lust können nicht-sexuell sein; Kontext kann Bilder + Treffen + sexuelles Thema sein, dann nichts rausstreichen). Lies und verstehe den Kontext.';
  const questionRule = 'PFLICHT: Jede Nachricht braucht eine Frage am Ende. Wenn die Nachricht noch KEINE Frage enthaelt, fuege am Ende UNBEDINGT eine kurze, thematisch passende Frage hinzu (z.B. zu dem was der Kunde geschrieben hat, zu Vorlieben, zum Thema).';
  const completenessRule = 'Wenn die Antwort Teile der Kundennachricht ignoriert (z.B. genannte Vorlieben wie "nicht für ONS", "langfristig"), ergaenze einen kurzen Satz oder eine Frage die darauf eingeht – ohne den Rest zu streichen.';
  const systemContent = `Du bist ein Korrektor für Chat-Moderator-Antworten. ${contextRule} ${sexualRule} ${contactIrritatedRule} Korrigiere nur echte Verstöße. Verbessere Stil und Klarheit. ${questionRule} ${completenessRule} Was bereits gut ist, unverändert lassen. Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. Antworte NUR mit der korrigierten/verbesserten Nachricht. Keine Anführungszeichen. Keine Bindestriche.`;

  try {
    const response = await Promise.race([
      client.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ],
        max_tokens: CORRECTOR_MAX_TOKENS,
        temperature: 0.3
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Korrektor Timeout')), CORRECTOR_TIMEOUT_MS))
    ]);

    const text = response?.choices?.[0]?.message?.content?.trim() || '';
    if (text) {
      console.log('✅ Grok-Korrektor: Nachricht korrigiert/verbessert (' + grokText.length + ' → ' + text.length + ' Zeichen)');
      return text;
    }
    console.warn('⚠️ Grok-Korrektor: leere Antwort von LoRA, behalte Original');
  } catch (err) {
    console.warn('⚠️ Grok-Korrektor fehlgeschlagen:', err.message);
  }
  return grokText;
}

module.exports = {
  correctAndImproveMessage
};
