const { Pool } = require("pg");

// Optionales DB-Setup: Falls keine DATABASE_URL gesetzt ist, überspringen wir DB
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.warn("DATABASE_URL fehlt – starte ohne Datenbank. Auth/Seed werden übersprungen.");
}

async function runMigrations() {
  if (!pool) {
    console.warn("runMigrations übersprungen, keine Datenbank konfiguriert.");
    return;
  }

  // Einfacher Init: Users-Tabelle und Seed-Admin
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = {
  pool,
  runMigrations
};

