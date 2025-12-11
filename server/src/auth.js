const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("./db");

function ensureDb() {
  if (!pool) {
    throw new Error("Keine Datenbank konfiguriert (DATABASE_URL fehlt)");
  }
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

async function findUserByEmail(email) {
  ensureDb();
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}

async function createUser(email, password) {
  ensureDb();
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING *",
    [email, hash]
  );
  return rows[0];
}

async function ensureAdminSeed() {
  if (!pool) {
    console.warn("Admin-Seed übersprungen, keine Datenbank konfiguriert.");
    return;
  }
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn("ADMIN_EMAIL oder ADMIN_PASSWORD fehlt – Admin-Seed wird uebersprungen.");
    return;
  }
  await createUser(email, password);
  console.log("Admin-User bereitgestellt (per Seed).");
}

module.exports = {
  signToken,
  verifyToken,
  findUserByEmail,
  createUser,
  ensureAdminSeed
};

