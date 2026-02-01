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

const CORRECTOR_TIMEOUT_MS = 30000;
const CORRECTOR_MAX_TOKENS = 400;

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
 * @returns {Promise<string|null>} korrigierter Text, oder null wenn Korrektor übersprungen/leer/Fehler (Pipeline behält Original)
 */
async function correctAndImproveMessage({ customerMessage = '', context = {}, grokText = '' }) {
  const useCorrector = process.env.USE_GROK_CORRECTOR_LORA === 'true' || process.env.USE_GROK_CORRECTOR_LORA === '1';
  const modelId = (process.env.CORRECTOR_LORA_MODEL_ID || '').trim();

  if (!grokText || !grokText.trim()) {
    return null;
  }
  if (!useCorrector) {
    console.log('ℹ️ Grok-Korrektor: übersprungen (USE_GROK_CORRECTOR_LORA nicht true/1)');
    return null;
  }
  if (!modelId) {
    console.log('ℹ️ Grok-Korrektor: übersprungen (CORRECTOR_LORA_MODEL_ID fehlt)');
    return null;
  }

  const client = getTogetherClient();
  if (!client) {
    console.warn('⚠️ Grok-Korrektor: Together-Client nicht verfügbar (TOGETHER_API_KEY fehlt oder ungültig) – überspringe Korrektur');
    return null;
  }

  console.log(`🔧 Grok-Korrektor: rufe LoRA auf (Modell: ${modelId})`);

  const ctx = [];
  if (context.isEmotional) ctx.push('Kunde wirkt traurig/emotional');
  if (context.noSexHint) ctx.push('Kunde möchte nicht über Sex schreiben');
  if (context.isMeetingSituation) ctx.push('Thema Treffen/Bar/Zeit');
  if (context.hasProfilePic === false) ctx.push('Kunde hat kein Profilbild');
  if (context.allowSexualContent === true) ctx.push('Sexuelle Inhalte sind erlaubt – NICHT entfernen oder abschwächen');
  const contextLine = ctx.length > 0 ? `Kontext: ${ctx.join(', ')}\n\n` : '';

  // Volle Kundennachricht (bis 800 Zeichen), damit LoRA Kontext hat und "ignorierte Kundeninhalte" korrigieren kann
  const fullCustomerMsg = (customerMessage || '').trim();
  const customerForCorrector = fullCustomerMsg.length > 800 ? fullCustomerMsg.slice(0, 800) + '…' : fullCustomerMsg;
  const userContent = `${contextLine}Kundennachricht: "${customerForCorrector}"\n\nPrüfe die folgende Moderatoren-Antwort und korrigiere/verbessere sie:\n(1) Geht die Antwort auf die Kundennachricht ein? Wenn nein → umschreiben.\n(2) Steht am Ende eine Frage? Wenn nein → Frage hinzufügen.\n(3) Umlaute (ä,ö,ü) und ss statt ß? Stil/Bindestriche?\nGib NUR den fertigen korrigierten Text zurück, keine Erklärungen.\n\nZu korrigierende Antwort:\n\n${grokText.trim()}`;

  const sexualRule = context.allowSexualContent === true
    ? (context.customerTalkingAboutSexWithFake === true
      ? 'WICHTIG: Kunde spricht direkt über Sex mit Fake – sexuelle Inhalte und eigene Erregung sind passend. Entferne oder entschärfe sie NICHT. Nur echte Regelverstöße (z.B. Aussehen ohne Profilbild, Bar/Ort bei Treffen) korrigieren.'
      : 'WICHTIG: Kunde erzählt Story/Erlebnis (ohne direkten Sex-Bezug zum Fake) – eigene Erregungs-Beschreibungen der Moderatoren-Persona (z.B. "macht mich feucht", "stell ich mir geil vor") entschärfen oder entfernen. Auf Inhalt reagieren (lustig, wild, interessant), nicht mit eigener körperlicher Reaktion. Flirty/spielerisch bleiben, aber ohne selbstbezogene Erregung.')
    : 'Entferne sexuelle Formulierungen nur, wenn im Kontext steht "Kunde möchte nicht über Sex schreiben". Sonst lasse den Text inhaltlich wie er ist.';
  const contactIrritatedRule = (context.contactRequest === true || context.customerIrritated === true)
    ? 'Bei Kontaktdaten-Anfrage oder gereiztem Kunden: Antwort sachlich und deeskalierend halten, keine sexuellen Anspielungen einbauen oder verstärken. Thematisch passende Frage am Ende.'
    : '';
  const contextRule = 'Entscheide immer anhand des gesamten Kontexts und der Kundennachricht – nie anhand einzelner Wörter. Lies und verstehe den Kontext.';
  const questionRule = 'PFLICHT: Jede Nachricht braucht eine Frage am Ende. Fehlt eine Frage, fuege am Ende UNBEDINGT eine kurze, thematisch passende Frage hinzu (zu dem was der Kunde geschrieben hat, zu Vorlieben, zum Thema).';
  const completenessRule = 'Wenn die Antwort Teile der Kundennachricht ignoriert (z.B. Vorlieben wie "nicht für ONS", "langfristig"), ergaenze einen kurzen Satz oder eine Frage die darauf eingeht.';
  const mustAddressRule = 'PFLICHT: Die Antwort MUSS auf die Kundennachricht eingehen. Reagiert die vorliegende Antwort nicht auf das, was der Kunde geschrieben hat, schreibe sie so um, dass sie UNBEDINGT darauf eingeht – sonst ist die Korrektur ungueltig.';
  const mustChangeRule = 'WICHTIG: Du bist ein Korrektor – deine Ausgabe muss eine tatsaechlich korrigierte/verbesserte Nachricht sein. Wenn etwas zu korrigieren ist (fehlende Frage, kein Bezug zur Kundennachricht, Umlaute/ss, Stil), aendere es. Gib NIEMALS einfach den unveraenderten Eingabetext zurueck, wenn eine Korrektur noetig war. Nur wenn die Nachricht bereits vollstaendig korrekt ist, darf die Ausgabe sehr aehnlich sein (z.B. nur Umlaute angepasst).';
  const systemContent = `Du bist ein Korrektor für Chat-Moderator-Antworten. ${contextRule} ${sexualRule} ${contactIrritatedRule} ${questionRule} ${completenessRule} ${mustAddressRule} ${mustChangeRule} Schreibe mit ä, ö, ü (Umlaute), z.B. wäre, möchte, für. Immer ss, nie ß. Keine Anführungszeichen. Keine Bindestriche. Antworte NUR mit der fertigen korrigierten Nachricht – kein anderer Text.`;

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
    if (text && text.length >= 20) {
      console.log('✅ Grok-Korrektor: Nachricht korrigiert/verbessert (' + grokText.length + ' → ' + text.length + ' Zeichen)');
      return text;
    }
    console.warn('⚠️ Grok-Korrektor: leere oder zu kurze Antwort von LoRA – Pipeline behält Original');
  } catch (err) {
    console.warn('⚠️ Grok-Korrektor fehlgeschlagen:', err.message);
  }
  return null;
}

module.exports = {
  correctAndImproveMessage
};
