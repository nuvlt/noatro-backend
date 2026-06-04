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
      best_win BIGINT NOT NULL DEFAULT 0,
      runs INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // mevcut tabloya best_win kolonu yoksa ekle (geriye dönük uyum)
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS best_win BIGINT NOT NULL DEFAULT 0;`);
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
    const bestWinCandidate = win > 0 ? win : 0; // sadece pozitif kazançlar "en iyi" sayılır

    // upsert: total topla, best_layer ve best_win en iyiyi tut
    const result = await pool.query(
      `INSERT INTO players (name, total_winnings, best_layer, best_win, runs)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (name) DO UPDATE SET
         total_winnings = players.total_winnings + EXCLUDED.total_winnings,
         best_layer = GREATEST(players.best_layer, EXCLUDED.best_layer),
         best_win = GREATEST(players.best_win, EXCLUDED.best_win),
         runs = players.runs + 1,
         updated_at = now()
       RETURNING name, total_winnings, best_layer, best_win, runs;`,
      [name, win, layersCleared, bestWinCandidate]
    );
    res.json({ ok: true, player: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ---- liderlik tablosu (performansa göre: en yüksek katman, eşitlikte en iyi kazanç) ----
app.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, best_layer, best_win, runs
       FROM players
       WHERE best_layer > 0
       ORDER BY best_layer DESC, best_win DESC
       LIMIT 50;`
    );
    res.json({ leaderboard: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Sunucu hatası." });
  }
});

// ============================================================
//   DÜELLO ODA SİSTEMİ (bellekte, 1 dk geçerli)
//   Oda: { seed, host, guest, results:{name:{score,layer,...}}, createdAt }
// ============================================================
const rooms = new Map();
const ROOM_TTL = 60 * 1000;        // oda kurulduktan sonra katılma süresi: 1 dk
const RESULT_TTL = 30 * 60 * 1000; // sonuçlar 30 dk saklanır

// süresi geçen odaları temizle
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    const age = now - r.createdAt;
    // hiç kimse katılmadan 1 dk geçtiyse VEYA 30 dk dolduysa sil
    if ((!r.guest && age > ROOM_TTL) || age > RESULT_TTL) rooms.delete(id);
  }
}, 15000);

function genRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // karışması zor karakterler
  let id;
  do { id = Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join(""); }
  while (rooms.has(id));
  return id;
}

// oda kur → room id + seed döner
app.post("/duel/create", rateLimit, (req, res) => {
  let { name } = req.body || {};
  name = (name||"").trim().slice(0,16);
  if (name.length < 2) return res.status(400).json({ error: "İsim gerekli." });
  const id = genRoomId();
  const seed = Math.floor(Math.random() * 1e9);
  rooms.set(id, { seed, host: name, guest: null, results: {}, createdAt: Date.now() });
  res.json({ roomId: id, seed, host: name });
});

// odaya katıl → aynı seed döner
app.post("/duel/join", rateLimit, (req, res) => {
  let { name, roomId } = req.body || {};
  name = (name||"").trim().slice(0,16);
  roomId = (roomId||"").trim().toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Oda bulunamadı ya da süresi doldu." });
  if (Date.now() - room.createdAt > ROOM_TTL && !room.guest)
    return res.status(410).json({ error: "Oda süresi doldu." });
  if (room.guest && room.guest !== name)
    return res.status(409).json({ error: "Oda dolu." });
  if (name === room.host) return res.status(409).json({ error: "Bu isim oda sahibi." });
  room.guest = name;
  res.json({ roomId, seed: room.seed, host: room.host, guest: name });
});

// sonuç gönder
app.post("/duel/result", rateLimit, (req, res) => {
  let { name, roomId, score, layer, won } = req.body || {};
  name = (name||"").trim().slice(0,16);
  roomId = (roomId||"").trim().toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Oda bulunamadı." });
  score = Math.max(0, Math.min(99999, parseInt(score)||0));
  layer = Math.max(0, Math.min(3, parseInt(layer)||0));
  room.results[name] = { score, layer, won: !!won, at: Date.now() };
  res.json({ ok: true });
});

// oda durumu / sonuçları çek (polling)
app.get("/duel/status/:roomId", (req, res) => {
  const room = rooms.get((req.params.roomId||"").toUpperCase());
  if (!room) return res.status(404).json({ error: "Oda bulunamadı." });
  res.json({
    host: room.host, guest: room.guest,
    results: room.results,
    bothDone: room.host && room.guest && room.results[room.host] && room.results[room.guest],
  });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Noatro backend ${PORT} portunda.`)))
  .catch((e) => {
    console.error("DB başlatılamadı:", e);
    process.exit(1);
  });
