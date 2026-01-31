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
 * @param {string} opts.grokText - von Grok generierter Text (wird korrigiert/verbessert)
 * @returns {Promise<string>} korrigierter/verbesserter Text oder grokText bei Fehler
 */
async function correctAndImproveMessage({ customerMessage = '', context = {}, grokText = '' }) {
  const useCorrector = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
  const modelId = process.env.CORRECTOR_LORA_MODEL_ID || '';

  if (!useCorrector || !modelId || !grokText || !grokText.trim()) {
    return grokText;
  }

  const client = getTogetherClient();
  if (!client) {
    console.warn('⚠️ Grok-Korrektor: Together-Client nicht verfügbar (TOGETHER_API_KEY?) – überspringe Korrektur');
    return grokText;
  }

  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push('Thema Treffen/Bar/Zeit');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';

  const userContent = `${contextLine}Kundennachricht: "${(customerMessage || '').trim().slice(0, 400)}"\n\nZu korrigieren und verbessern (Regelverstöße entfernen, Stil wie in Trainingsdaten/Feedback verbessern – gib nur den fertigen Text zurück, keine Erklärungen):\n\n${grokText.trim()}`;

  const sexualRule = context.allowSexualContent === true
    ? 'WICHTIG: Sexuelle Inhalte sind hier erlaubt. Entferne oder entschärfe sie NICHT. Nur echte Regelverstöße (z.B. Aussehen ohne Profilbild, Bar/Ort bei Treffen) korrigieren.'
    : 'Entferne sexuelle Formulierungen nur, wenn im Kontext steht "Kunde möchte nicht über Sex schreiben". Sonst lasse den Text inhaltlich wie er ist.';
  const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
    ? 'Bei Kontaktdaten-Anfrage oder gereiztem Kunden: Antwort sachlich und deeskalierend halten, keine sexuellen Anspielungen einbauen oder verstärken. Thematisch passende Frage am Ende.'
    : '';
  const contextRule = 'Entscheide immer anhand des gesamten Kontexts und der Kundennachricht – nie anhand einzelner Wörter (z.B. Kuss/Lust können nicht-sexuell sein; Kontext kann Bilder + Treffen + sexuelles Thema sein, dann nichts rausstreichen). Lies und verstehe den Kontext.';
  const systemContent = `Du bist ein Korrektor für Chat-Moderator-Antworten. ${contextRule} ${sexualRule} ${contactIrritatedRule} Korrigiere nur echte Verstöße. Verbessere Stil und Klarheit. WICHTIG: Jede Nachricht braucht eine Frage am Ende – zum Kontext passend, zum Thema oder das Thema erweiternd/vertiefend (keine Treffen-Einladung). Wenn die Nachricht noch keine Frage enthaelt, fuege am Ende eine kurze, thematisch passende Frage hinzu. Was bereits gut ist, unverändert lassen. Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. Antworte NUR mit der korrigierten/verbesserten Nachricht. Keine Anführungszeichen. Keine Bindestriche.`;

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
      console.log('✅ Grok-Korrektor: Nachricht korrigiert/verbessert');
      return text;
    }
  } catch (err) {
    console.warn('⚠️ Grok-Korrektor fehlgeschlagen:', err.message);
  }
  return grokText;
}

module.exports = {
  correctAndImproveMessage
};
