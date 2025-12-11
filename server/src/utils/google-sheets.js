 const { google } = require('googleapis');
const fetch = require('node-fetch');

// Google Sheets Integration
// Zwei Methoden:
// 1. Google Sheets API (benötigt: GOOGLE_SHEETS_CREDENTIALS + GOOGLE_SHEETS_SPREADSHEET_ID)
// 2. Google Apps Script Webhook (benötigt: GOOGLE_SHEETS_WEBHOOK_URL)

/**
 * Schreibt eine Nachricht in Google Sheets (via API)
 * @param {Object} messageData - Die Nachrichtendaten
 */
async function writeToGoogleSheets(messageData) {
  try {
    // Methode 1: Google Apps Script Webhook (einfacher)
    const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    if (webhookUrl) {
      await writeViaWebhook(messageData, webhookUrl);
      return;
    }

    // Methode 2: Google Sheets API (robuster)
    const credentialsJson = process.env.GOOGLE_SHEETS_CREDENTIALS;
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || 'Nachrichten';

    if (!credentialsJson || !spreadsheetId) {
      // Google Sheets nicht konfiguriert - überspringe
      return;
    }

    // Parse Credentials
    let credentials;
    try {
      credentials = JSON.parse(credentialsJson);
    } catch (e) {
      console.error('❌ Fehler beim Parsen der Google Sheets Credentials:', e.message);
      return;
    }

    // Authentifiziere mit Service Account
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Formatiere Datum für bessere Lesbarkeit
    const date = new Date(messageData.timestamp);
    const dateStr = date.toLocaleString('de-DE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // Werte für die Zeile
    const values = [[
      dateStr,                                    // A: Datum/Zeit
      messageData.platform || 'unknown',          // B: Plattform
      messageData.chatId || '',                   // C: Chat ID
      messageData.isASA ? 'Ja' : 'Nein',         // D: ASA
      messageData.customerMessage || '',          // E: Kunden-Nachricht
      messageData.aiResponse || ''                // F: KI-Antwort
    ]];

    // Füge Zeile hinzu
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: values
      }
    });

    console.log('✅ Nachricht in Google Sheets geschrieben (API)');
  } catch (err) {
    // Fehler beim Schreiben in Google Sheets - nicht kritisch, nur loggen
    console.error('⚠️ Fehler beim Schreiben in Google Sheets:', err.message);
    // Nicht werfen - Google Sheets ist optional
  }
}

/**
 * Schreibt eine Nachricht via Google Apps Script Webhook (einfacher)
 */
async function writeViaWebhook(messageData, webhookUrl) {
  try {
    // Verwende node-fetch oder native fetch (je nach Node.js Version)
    const fetch = globalThis.fetch || require('node-fetch');
    
    const date = new Date(messageData.timestamp);
    const dateStr = date.toLocaleString('de-DE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const payload = {
      timestamp: dateStr,
      platform: messageData.platform || 'unknown',
      chatId: messageData.chatId || '',
      isASA: messageData.isASA ? 'Ja' : 'Nein',
      customerMessage: messageData.customerMessage || '',
      aiResponse: messageData.aiResponse || ''
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log('✅ Nachricht in Google Sheets geschrieben (Webhook)');
    } else {
      console.error('⚠️ Google Sheets Webhook Fehler:', response.status, response.statusText);
    }
  } catch (err) {
    console.error('⚠️ Fehler beim Google Sheets Webhook:', err.message);
  }
}

/**
 * Erstellt Header-Zeile in Google Sheets (wird einmalig beim ersten Schreiben erstellt)
 */
async function ensureHeaders() {
  try {
    const credentialsJson = process.env.GOOGLE_SHEETS_CREDENTIALS;
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || 'Nachrichten';

    if (!credentialsJson || !spreadsheetId) {
      return;
    }

    let credentials;
    try {
      credentials = JSON.parse(credentialsJson);
    } catch (e) {
      return;
    }

    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Prüfe ob Sheet existiert, sonst erstelle es
    try {
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetExists = spreadsheet.data.sheets.some(s => s.properties.title === sheetName);
      
      if (!sheetExists) {
        // Erstelle Sheet
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          requestBody: {
            requests: [{
              addSheet: {
                properties: {
                  title: sheetName
                }
              }
            }]
          }
        });
      }

      // Prüfe ob Header-Zeile leer ist
      const headerRange = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A1:F1`
      });

      if (!headerRange.data.values || headerRange.data.values.length === 0) {
        // Füge Header hinzu
        await sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: `${sheetName}!A1:F1`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              'Datum/Zeit',
              'Plattform',
              'Chat ID',
              'ASA',
              'Kunden-Nachricht',
              'KI-Antwort'
            ]]
          }
        });
        console.log('✅ Google Sheets Header erstellt');
      }
    } catch (err) {
      console.error('⚠️ Fehler beim Erstellen der Google Sheets Header:', err.message);
    }
  } catch (err) {
    // Nicht kritisch
    console.error('⚠️ Fehler beim Google Sheets Setup:', err.message);
  }
}

module.exports = {
  writeToGoogleSheets,
  ensureHeaders
};

