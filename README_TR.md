[EN](README.md) | **TR**

# PatiPasaport

Evcil hayvan sağlık pasaportu platformu: hayvan sahipleri hayvanlarının tıbbi geçmişini tek yerde tutar ve hangi klinik görebilir ya da ekleme yapabilir, klinik bazında kendisi karar verir. Klinikler tahlil sonuçlarını ve görüntüleri yükler, bir AI servisi bunlardan yapılandırılmış kayıt taslakları hazırlar ve klinik her taslağı onaylamadan kalıcı kayda dönüşmez. Onaylanan ya da elle girilen her tahlil sonucu için AI servisi ayrıca, yalnızca hayvan sahibinin görebildiği sade dilde bir açıklama yazar.

Bu bir bitirme projesidir. AI servisi dahil backend tamamlanmıştır ve Docker Compose ile çalışır; frontend ayrı bir depodadır. Geriye kalanlar sağlamlaştırma ve yayına alma işleridir ([Yol haritası](#yol-haritası)).

## Mimari

```
   Tarayıcı / mobil ──HTTPS──► nginx (TLS, tek genel giriş; frontend deposu)
                               │  /api → http://gateway:3000 (iç ağ)
                          ┌────▼────┐
                          │ gateway │  helmet · CORS · hız sınırlama · doğrulama
                          └────┬────┘
        gRPC (yalnızca iç ağ, servisler arası zero-trust JWT)
   ┌────────┬───────┬─────────┼──────────┬────────┬───────┐
   ▼        ▼       ▼         ▼          ▼        ▼       ▼
 access    auth   users    clinics     pets   medical-record
 (Redis)  (Redis)                                   │
                                          outbox ──► RabbitMQ ──► ai-service (Python)
                                          dosyalar ──► SeaweedFS (S3)
```

| Servis | Sorumluluk | Depolama |
|---|---|---|
| `gateway` | Tek genel giriş noktası. HTTP/JSON API, istek doğrulama, token değişimi, dosya yükleme | SeaweedFS (yazma) |
| `access` | Opak token ⇄ kısa ömürlü JWT değişimi, onaylar (hangi hayvana kim erişebilir), erişim kontrolleri | PostgreSQL, Redis |
| `auth` | Kayıt, giriş, refresh token döndürme, giriş kilidi | PostgreSQL, Redis |
| `users` | Kullanıcı profilleri | PostgreSQL |
| `clinics` | Klinikler, alış ve satış fiyatlı stok, satışlar ve aylık satış raporları, kliniğin hayvan görünümü, sonuç yükleme orkestrasyonu | PostgreSQL |
| `pets` | Hayvanlar, sahip sorgusu, şifreli çip numaraları | PostgreSQL |
| `medical-record` | Kayıtlar, aşılar, reçeteler, tahlil sonuçları, belgeler, AI taslak incelemeleri, AI tahlil açıklamaları | PostgreSQL, RabbitMQ, SeaweedFS |
| `ai-service` | Python işçisi, port açmaz. Yüklenen belgeleri taslak kayıtlara çevirir ve harici bir AI API'siyle sade dilde tahlil açıklamaları yazar | RabbitMQ, SeaweedFS (salt okunur) |

Bilinmesi gereken tasarım kararları:

- **Servis başına veritabanı.** Servisler arası ilişkiler gRPC ile kontrol edilir, asla foreign key ile değil.
- **Zero trust.** Her okuma ve yazma erişimi yeniden kontrol eder: hayvan sahipleri sahiplik üzerinden, klinikler doğru kapsamlı aktif bir onay üzerinden.
- **Phantom token.** İstemciler opak token taşır; gateway bunları iç servislerin doğruladığı kısa ömürlü JWT'lerle değiştirir. Özel anahtar yalnızca `access` serviste bulunur.
- **Outbox + CloudEvents.** Belge yükleme, belgeyi ve bir outbox satırını tek transaction'da yazar; bir relay CloudEvents olaylarını yeniden deneme ve dead-letter kuyruğuyla RabbitMQ'ya yayınlar. Yeni bir tahlil sonucu kaydı (onaylanmış taslak ya da elle giriş) da kaydı, bekleyen bir açıklama satırını ve bir açıklama isteğini aynı şekilde tek transaction'da yazar.
- **Döngüde insan.** AI çıktısı taslak olarak saklanır ve yalnızca bir klinik onayladıktan sonra tıbbi kayda dönüşür.
- **İzole AI servisi.** Veritabanı yoktur ve başka bir servisi çağırmaz: olaylar RabbitMQ üzerinden girer ve çıkar, dosyalar salt okunur kimlik bilgileriyle SeaweedFS'ten okunur ve her AI cevabı yayınlanmadan önce katı bir JSON şemasına ve servislerin kullandığı aynı doğrulama kurallarına karşı kontrol edilir.
- **Erişim denetim günlüğü.** Her S3 isteği Fluent Bit ile günlüğe yazılır.

Tam veritabanı, mesajlaşma ve depolama tasarımı: [docs/db-schema.md](docs/db-schema.md).

## Teknoloji yığını

Nx monorepo · Node.js 24 · NestJS 11 (gRPC mikroservisleri + Express 5 gateway) · TypeScript · Prisma 7 · PostgreSQL 16 · Redis · RabbitMQ 4.3 · SeaweedFS (S3) · Fluent Bit · Protocol Buffers (buf + ts-proto) · Jest · Python 3.14 + FastAPI (AI servisi) · Docker Compose.

## Başlarken

Gereksinimler: Node.js 24.22.1 veya daha yenisi, Compose'lu Docker ve OpenSSL.

```sh
npm ci

cp .env.example .env
# her "change-me" değerini doldurun, örn: openssl rand -base64 18
# ve her "bu alan doldurulacak" değerini (AI sağlayıcısı ve AI RabbitMQ kullanıcısı)

openssl genrsa -out access_jwt_private.pem 2048
openssl rsa -in access_jwt_private.pem -pubout -out access_jwt_public.pem

docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
npx nx run-many -t prisma-migrate-deploy   # veritabanı migration'larını uygula
curl http://localhost:3000/health
```

### Yerel geliştirme

`docker-compose.dev.yml`, gateway'i 3000 portunda, altyapı ve gRPC portlarını ise `127.0.0.1` üzerinde yayınlar. Frontend geliştirme sunucusu, migration'lar, Prisma Studio, e2e testleri ve grpcurl gibi araçlar için kullanın. Üretimde asla kullanmayın.

### Üretim

Varsayılan compose dosyası (`docker compose up -d --build`) **hiçbir port yayınlamaz**. Tek genel giriş bir reverse proxy'dir:

- nginx'i (frontend deposunda bulunur) `patipasaport_backend` Compose ağında çalıştırın ve `/api/` isteklerini `http://gateway:3000/` adresine yönlendirin.
- TLS'i nginx'te sonlandırın ve hız sınırlamanın gerçek istemci IP'sini görmesi için `TRUST_PROXY=1` ayarlayın.
- Gateway'i yayınlamayın; ona doğrudan ulaşabilen bir istemci `X-Forwarded-For` değerini taklit edebilir.

### Yapılandırma

Tüm gizli değerler `.env` içindedir (git'e eklenmez); `.env.example` her değişkeni açıklar. Servisler hızlı hata verir: eksik bir servis adresi (`*_GRPC_URL`, veritabanı, Redis ya da RabbitMQ sunucusu) servisi başlangıçta, değişkenin adını söyleyen bir hatayla durdurur.

Gateway ayarları:

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `CORS_ORIGINS` | boş | API'yi çağırmasına izin verilen, virgülle ayrılmış tarayıcı originleri, örn. `https://app.example.com`. Boş olursa hiçbirine izin verilmez. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Hız sınırı penceresi |
| `RATE_LIMIT_GLOBAL` | `100` | Tüm rotalarda pencere başına IP başına istek sayısı |
| `RATE_LIMIT_AUTH` | `10` | Giriş, kayıt ve yenileme için ortak sınır |
| `RATE_LIMIT_UPLOAD` | `20` | Belge yükleme sınırı |
| `TRUST_PROXY` | boş | Gateway'in önündeki reverse proxy sayısı. Yerel geliştirmede boş, nginx arkasında `1`, nginx'in önünde başka bir katman (örn. Cloudflare ya da yük dengeleyici) varsa `2`. `true` reddedilir, çünkü istemcilerin IP'lerini taklit etmesine izin verirdi. |
| `REFRESH_COOKIE_PATH` | `/api/auth` | Refresh token çerezinin tarayıcıda görünen yolu. Reverse proxy'nin `/auth` önünde kullandığı önekle eşleşmelidir. |

AI servisi ayarları (eksik zorunlu bir değer yalnızca `ai-service`'i durdurur; yığının geri kalanı çalışmaya devam eder):

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `AI_API_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | zorunlu | OpenAI uyumlu AI sağlayıcısı |
| `AI_RABBITMQ_USER`, `AI_RABBITMQ_PASSWORD` | zorunlu | `rabbitmq-init` tarafından oluşturulan sınırlı RabbitMQ kullanıcısı; `RABBITMQ_USER`'dan farklı olmalıdır |
| `S3_AI_ACCESS_KEY`, `S3_AI_SECRET_KEY` | zorunlu | `seaweedfs-init` tarafından oluşturulan salt okunur SeaweedFS kullanıcısı |
| `AI_REQUEST_TIMEOUT_SECONDS` | `120` | Tek bir AI API isteğinin zaman aşımı |
| `AI_ENABLE_THINKING` | `true` | Modelin cevap vermeden önce akıl yürütmesine izin verir |
| `AI_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` ya da `ERROR` |

## API genel bakış

`/health` ve `/auth/logout` dışındaki her rota `X-Client-Type: 1` (web) ya da `2` (mobil) ister. `/health` ve `/auth/*` dışındaki her rota ayrıca `Authorization: Bearer <access token>` ister. Cevaplar tek bir zarf kullanır: `{ data, message, success, correlationId }`; hatalar `message` içinde sabit bir kod taşır.

| Alan | Rotalar |
|---|---|
| Health | `GET /health` |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` (web: refresh token yalnızca httpOnly çerezde; mobil: JSON gövdesinde) |
| Onaylar | `POST /consents`, `POST /consents/:consentId/revoke`, `GET /consents`, `GET /consents/status` |
| Kullanıcılar | `GET` / `PATCH /users/me`, `POST /users/me/deactivate`, `POST /users/display-names` |
| Hayvanlar | `POST /pets`, `GET /pets`, `GET /pets/search`, `GET` / `PATCH /pets/:id` |
| Klinikler | `GET /clinics/:id`, `POST /clinics/:clinicId/deactivate`, `GET /clinics/:clinicId/pets/:petId/overview` |
| Stok | `POST` / `GET /clinics/:clinicId/stock-items`, `PATCH` / `DELETE /clinics/:clinicId/stock-items/:itemId`, `POST /clinics/:clinicId/stock-items/:itemId/adjust` (atomik `{ delta }`) |
| Stok satışları | `POST /clinics/:clinicId/stock-items/:itemId/sales` (`{ quantity, unitPrice? }`), `GET /clinics/:clinicId/stock-sales` (`fromDate`, `toDate`, sayfalama), `POST /clinics/:clinicId/stock-sales/:saleId/cancel` (yalnızca aynı ay), `GET /clinics/:clinicId/stock-sales/summary?month=YYYY-MM` (toplamlar, günlük, haftalık, ürün bazında) |
| Belgeler | `POST /clinics/:clinicId/pets/:petId/documents` (multipart: `file` PDF/JPEG/PNG en fazla 10 MB, isteğe bağlı `note`), `GET /pets/:petId/documents` (isteğe bağlı `status`, sayfalama), `GET /documents/:id`, `GET /documents/:id/file` (tarayıcıda açılır; `?download=1` indirir; içerik saklanan SHA-256 ile kontrol edilir) |
| Tıbbi kayıtlar | `GET /pets/:petId/records`, `/vaccinations`, `/prescriptions`, `/lab-results`, `POST /pets/:petId/records` |
| AI taslak incelemesi | `GET /draft-reviews`, `POST /draft-reviews/:id/review` |
| Tahlil sonucu açıklaması | `GET /records/:recordId/explanation` (yalnızca hayvan sahibi; `status` 1 beklemede, 2 özet, maddeler, güven skoru ve `generatedAt` ile hazır, 3 başarısız) |

Para, kuruş cinsinden tam sayıdır (`14990` = 149,90 TL). Bir satış, ürünün adını ve alış ile satış fiyatlarını satış anındaki haliyle saklar; böylece sonraki fiyat değişiklikleri geçmiş kârı etkilemez. Satış raporlarındaki günler, haftalar (Pazartesi–Pazar, ayın kenarlarında kesilir) ve aylar İstanbul saatine göre hesaplanır.

## Güvenlik

- **Aktarım başlıkları:** helmet (katı CSP, `X-Frame-Options: DENY`, HSTS, `nosniff`, `X-Powered-By` yok) ve her cevapta `Cache-Control: no-store`.
- **CORS:** açık origin izin listesi, joker karakter yok, kimlik bilgisi yok.
- **Hız sınırlama:** IP başına; kimlik doğrulama ve yüklemeler için daha sıkı sınırlar; `Retry-After` ile `429`.
- **Girdi işleme:** beyaz liste doğrulaması, metin kırpma, JSON derinlik sınırı (50), prototype pollution anahtarlarının kaldırılması, magic-byte ile dosya türü tespiti.
- **Enjeksiyon:** tüm SQL Prisma üzerinden geçer; ham sorgular parametrelidir ve `$queryRawUnsafe` / `$executeRawUnsafe` ESLint ile yasaklanmıştır. API yalnızca JSON döndürür ve girdiyi hata mesajlarına asla yansıtmaz.
- **Kimlik doğrulama:** argon2 parola hash'leme, giriş kilidi, döndürülen refresh token'lar, opak access token'lar.
- **Web'de refresh token:** JavaScript'e asla açılmaz. `pp_refresh` çerezinde (`HttpOnly`, `Secure`, `SameSite=Strict`, `/api/auth` yoluyla sınırlı) yaşar; çerez ömrü token ömrüyle aynıdır (12 saat, "beni hatırla" ile 30 gün). CSRF, `SameSite=Strict` ve zorunlu `X-Client-Type` başlığıyla engellenir; başka bir site bu başlığı CORS onayı olmadan gönderemez. Mobil istemciler token'ı gövdede alır ve güvenli cihaz depolamasında saklar.
- **Ağ:** üretimde hiçbir servis yayınlanmaz; nginx tek genel girişttir ve gateway dahil her servise yalnızca iç Docker ağından ulaşılır.
- **Bağımlılıklar:** üretim imajları bilinen güvenlik açığı içermez (`npm audit --omit=dev --omit=optional`).

TLS, bu yığında değil reverse proxy'de (nginx) sonlandırılır. Onun arkasında `TRUST_PROXY=1`, gateway'in istemci IP'sini `X-Forwarded-For` içindeki son girişten, yani nginx'in eklediğinden almasını sağlar; böylece her istemci kendi hız sınırı kotasını alır ve taklit edilmiş girişler yok sayılır.

## Test

```sh
npx nx run-many -t lint build                    # statik kontroller ve build'ler
npx nx run-many -t test --output-style=static    # birim testleri

# uçtan uca testler, build edilmiş servisi ana makinede Docker yığınına karşı çalıştırır
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose stop ai-service      # e2e testleri AI rolünü kendileri oynar
npx nx run-many -t e2e --parallel=1 --output-style=static
docker compose start ai-service
```

AI servisinin kendi lint ve testleri vardır; bkz. [apps/ai-service/README.md](apps/ai-service/README.md). CI bunları ayrı bir işte çalıştırır: ruff, kapsama raporlu birim testleri ve Docker imajı build'i.

## Proje yapısı

```
apps/        gateway ve altı mikroservis, her biri bir *-e2e projesiyle
apps/ai-service  Python AI işçisi (Nx projesi değil)
libs/common  ortak guard'lar, pipe'lar, filtreler, loglama, CloudEvents yardımcıları
libs/dto     gateway ve servislerin paylaştığı istek DTO'ları ve doğrulama kuralları
libs/proto   .proto sözleşmeleri ve üretilmiş TypeScript
libs/e2e-utils  uçtan uca testler için yardımcılar
tools/       SeaweedFS bucket kurulumu ve denetim günlüğü, Fluent Bit yapılandırması
docs/        veritabanı, mesajlaşma ve depolama tasarımı
```

## Yol haritası

1. **AI servisi sağlamlaştırma (sürüyor):** CI'da Python kontrolleri, zaman aşımı ve eşzamanlılık incelemesi, kullanım ve maliyet incelemesi ve gerçek bir tahlil raporuyla uçtan uca test.
2. **Yayına alma:** TLS reverse proxy ve üretim yapılandırması.

## Lisans

[MIT](LICENSE)
