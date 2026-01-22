const { Pool } = require("pg");

// Optionales DB-Setup: Falls keine DATABASE_URL gesetzt ist, überspringen wir DB
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000, // 30 Sekunden Timeout (für Render DB Startup)
    idleTimeoutMillis: 30000,
    max: 5 // Reduziert von 10 auf 5 für bessere Stabilität bei kleineren DB-Plänen
  });
  
  // 🚨 KRITISCH: Error-Event-Handler für Pool, um unhandled errors zu verhindern
  pool.on('error', (err, client) => {
    console.warn('⚠️ PostgreSQL Pool Error (nicht kritisch, wird behandelt):', err.message);
    // Verhindere, dass der Fehler den Prozess crasht
  });
} else {
  console.warn("DATABASE_URL fehlt – starte ohne Datenbank. Auth/Seed werden übersprungen.");
}

// Teste Datenbankverbindung mit Retry
async function testConnection(retries = 3, delay = 2000) {
  if (!pool) {
    throw new Error("Kein Datenbank-Pool vorhanden");
  }

  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      return true;
    } catch (err) {
      if (i < retries - 1) {
        console.warn(`⚠️ Datenbankverbindung fehlgeschlagen (Versuch ${i + 1}/${retries}), versuche erneut in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
  return false;
}

async function runMigrations() {
  if (!pool) {
    console.warn("runMigrations übersprungen, keine Datenbank konfiguriert.");
    return;
  }

  try {
    // Teste Verbindung zuerst
    console.log("🔍 Teste Datenbankverbindung...");
    await testConnection();
    console.log("✅ Datenbankverbindung erfolgreich!");

  // Einfacher Init: Users-Tabelle und Seed-Admin
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  
  // Vektor-DB Tabelle für persistente Speicherung zwischen Deploys
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vector_db (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
      version INTEGER DEFAULT 1
    );
  `);
    
    console.log("✅ Datenbank-Migrationen erfolgreich ausgeführt.");
  } catch (err) {
    console.error("❌ Fehler bei Datenbank-Migrationen:", err.message);
    
    // Detaillierte Fehlerdiagnose
    if (err.code === 'ENOTFOUND' || err.message.includes('getaddrinfo')) {
      console.error("❌ DNS-Auflösungsfehler: Die Datenbank-URL kann nicht aufgelöst werden!");
      console.error("❌ Mögliche Ursachen:");
      console.error("   1. Datenbank ist pausiert (in Render Dashboard prüfen)");
      console.error("   2. DATABASE_URL ist falsch oder wurde geändert");
      console.error("   3. Datenbank wurde gelöscht/neu erstellt");
      console.error("   4. Netzwerkproblem (temporär)");
    } else if (err.code === 'ECONNREFUSED') {
      console.error("❌ Verbindung abgelehnt: Die Datenbank antwortet nicht!");
      console.error("❌ Mögliche Ursachen:");
      console.error("   1. Datenbank ist nicht gestartet");
      console.error("   2. Falscher Port in DATABASE_URL");
    } else if (err.code === 'ETIMEDOUT') {
      console.error("❌ Timeout: Die Datenbank antwortet nicht rechtzeitig!");
      console.error("❌ Mögliche Ursachen:");
      console.error("   1. Datenbank ist überlastet");
      console.error("   2. Netzwerkproblem");
    }
    
    throw err; // Wirf den Fehler, damit der Startprozess ihn abfängt
  }
}

module.exports = {
  pool,
  runMigrations,
};

