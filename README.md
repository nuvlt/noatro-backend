# NOATRO Backend — Leaderboard

Express + PostgreSQL. Railway'de çalışır. Toplam kümülatif kazanca göre liderlik tablosu.

## Railway'e Kurulum

1. **Yeni proje:** Railway → New Project → Deploy from GitHub repo (bu backend reposunu seç).
   Alternatif: "Empty Project" açıp sonra GitHub bağla.

2. **PostgreSQL ekle:** Proje içinde → "New" → "Database" → "Add PostgreSQL".
   Railway otomatik olarak `DATABASE_URL` ortam değişkenini servise bağlar.

3. **Deploy:** Railway `npm start` ile otomatik başlatır. İlk açılışta tablo kendi kurulur.

4. **Public URL al:** Servisin "Settings" → "Networking" → "Generate Domain".
   Örnek: `https://noatro-backend-production.up.railway.app`
   Bu URL'yi frontend'e (Noatro.jsx içindeki API_URL) yapıştıracaksın.

## Endpointler

- `GET /` → sağlık kontrolü
- `POST /scores` → body: `{ name, win, layersCleared }` — skoru ekler (oyuncu varsa toplar)
- `GET /leaderboard` → en yüksek 50 oyuncu (toplam kazanca göre)

## Notlar

- CORS şu an tüm originlere açık (hobi). Güvenlik için Vercel domainine kısıtlayabilirsin:
  `app.use(cors({ origin: "https://senin-oyunun.vercel.app" }))`
- Skor istemciden geliyor; arkadaş çevresi için yeterli ama teknik olarak sahte skor gönderilebilir.
  Basit doğrulama var (kazanç sınırı, isim uzunluğu, rate limit).
- Tablo: `players(name, total_winnings, best_layer, runs)`. İsim benzersiz, kazançlar toplanır.
