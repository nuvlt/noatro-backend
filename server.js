import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

// Railway PostgreSQL bağlantısı (DATABASE_URL otomatik sağlanır)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(cors());            // tüm originlere izin (hobi projesi). İstersen Vercel domainine kısıtla.
app.use(express.json());

// ---- basit rate limit (spam engeli) ----
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x";
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000); // son 1 dk
  if (arr.length >= 30) return res.status(429).json({ error: "Çok fazla istek, biraz bekle." });
  arr.push(now);
  hits.set(ip, arr);
  next();
}

// ---- tablo kurulumu (ilk açılışta) ----
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      total_winnings BIGINT NOT NULL DEFAULT 0,
      best_layer INT NOT NULL DEFAULT 0,
      runs INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("DB hazır.");
}

// ---- sağlık kontrolü ----
app.get("/", (req, res) => res.json({ ok: true, service: "noatro-leaderboard" }));

// ---- skor kaydet ----
// body: { name, win (bu run'ın net kazancı, negatif olabilir), layersCleared }
app.post("/scores", rateLimit, async (req, res) => {
  try {
    let { name, win, layersCleared } = req.body || {};

    // doğrulama
    if (typeof name !== "string") return res.status(400).json({ error: "İsim gerekli." });
    name = name.trim().slice(0, 16);
    if (name.length < 2) return res.status(400).json({ error: "İsim çok kısa." });

    win = Math.round(Number(win));
    if (!Number.isFinite(win) || Math.abs(win) > 1_000_000)
      return res.status(400).json({ error: "Geçersiz kazanç." });

    layersCleared = Math.max(0, Math.min(3, parseInt(layersCleared) || 0));

    // upsert: oyuncu varsa topla, yoksa oluştur
    const result = await pool.query(
      `INSERT INTO players (name, total_winnings, best_layer, runs)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (name) DO UPDATE SET
         total_winnings = players.total_winnings + EXCLUDED.total_winnings,
         best_layer = GREATEST(players.best_layer, EXCLUDED.best_layer),
         runs = players.runs + 1,
         updated_at = now()
       RETURNING name, total_winnings, best_layer, runs;`,
      [name, win, layersCleared]
    );
    res.json({ ok: true, player: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---- liderlik tablosu ----
app.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, total_winnings, best_layer, runs
       FROM players
       ORDER BY total_winnings DESC
       LIMIT 50;`
    );
    res.json({ leaderboard: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Sunucu hatası." });
  }
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Noatro backend ${PORT} portunda.`)))
  .catch((e) => {
    console.error("DB başlatılamadı:", e);
    process.exit(1);
  });
