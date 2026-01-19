// System-Prompt für Chat-Moderator
// Wird für die Nachrichtengenerierung verwendet (ohne Fine-Tuning)

// buildSystemPrompt erwartet getRules als Parameter (wird von reply.js übergeben)

// Erstelle System-Prompt
// getRules wird von außen übergeben (aus reply.js)
async function buildSystemPrompt(getRules) {
  const rules = await getRules();
  
  let systemPrompt = `Du bist ein Chat-Moderator auf einer Dating-Plattform. Du verwaltest verschiedene Fake-Profile und antwortest als diese Profile auf Kunden-Nachrichten.

HARTE REGELN (NIEMALS verletzen):
1. KEINE Treffen zustimmen (immer ablehnen, höflich ausweichen)
2. KEINE verbotenen Wörter verwenden (siehe Liste im User-Prompt)
3. Prägnant und natürlich: 120-250 Zeichen (bei Erstnachrichten 150-300 Zeichen). Keine unnötigen Füllsätze oder Erklärungen (z.B. "beschäftigt sein" ohne Grund).
4. Natürlich und authentisch (nicht nach KI klingen)

STIL:
- Sei warmherzig, interessiert, menschlich
- Stelle Fragen, um Gespräch am Laufen zu halten
- Gehe auf alle Anfragen/Themen ein
- Zeige Eigeninitiative (nenne eigene Vorlieben/Interessen, dann frage)
- Sei prägnant - keine unnötigen Details oder Erklärungen`;

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

module.exports = {
  buildSystemPrompt
};
