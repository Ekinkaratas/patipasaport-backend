# PatiPasaport — Veritabanı Şeması

Servis bazlı (database-per-service) yapı. Servisler arası ilişkiler SQL foreign key ile değil, **uygulama seviyesinde** (gRPC çağrısı ile doğrulanarak) tutulur — çünkü farklı veritabanı teknolojileri (PostgreSQL / MongoDB) birbirine native referans veremez. Aynı servisin kendi tabloları arasında foreign key kullanılabilir.

| Servis | Durum |
|---|---|
| Auth | ✅ Kesinleşti — Prisma schema + migration uygulandı |
| Users | ✅ Kesinleşti — Prisma schema + migration uygulandı |
| Clinics | 🟡 Yüzeysel — ileride genişletilecek |
| Pets | 🟡 Taslak — açık soru: `species` |
| Access | ✅ Rıza tabloları kesinleşti — Prisma schema + migration + trigger'lar uygulandı; rıza RPC'leri (`GrantConsent`, `RevokeConsent`, `GetConsentStatus`, `CheckAccess`) henüz yazılmadı |
| Medical Record | ⏸ Tartışılacak — aşağıdaki içerik ilk taslaktır |

---

## Auth Service — PostgreSQL (`auth_db`)

Prisma: `apps/auth/prisma/schema.prisma`

### credentials

| Kolon | Tip | Not |
|---|---|---|
| user_id | UUID (PK) | `users.id` ile aynı değer |
| email | varchar(254), unique | Giriş kimliği — **source of truth burası** |
| password_hash | text | argon2id |
| created_at | timestamp | |
| updated_at | timestamp | |

### sessions

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| user_id | UUID, FK → `credentials.user_id` | `ON DELETE CASCADE` — kimlik silinince oturumları da silinir |
| family_id | UUID, index | **Oturum ailesi** — her login yeni bir aile açar, refresh (rotation) aynı aileyi devralır. Her aile bir cihaz oturumuna karşılık gelir |
| refresh_token_hash | text, unique | **Hash'lenmiş** (SHA-256) — düz metin saklanmaz; refresh/logout aramaları bu alan üzerinden (unique index) |
| client_type | enum | `WEB` / `MOBILE` — token bu türe bağlanır; refresh'te istekteki `client_type` bununla karşılaştırılır, uyuşmazsa 401 |
| remember_me | boolean, default `false` | "Oturumu hatırla" seçimi — refresh'te yeni oturumun süresi buna göre hesaplanır |
| issued_at | timestamp | |
| expires_at | timestamp | `remember_me = false` → 12 saat, `true` → 30 gün (`auth.constants.ts`) |
| revoked_at | timestamp, nullable | Dolu ise oturum geçersiz |
| updated_at | timestamp | |

**Refresh token rotation:**

- Her yenilemede eski oturum **tek sorguyla atomik** olarak iptal edilir (`revoked_at` yalnızca hâlâ boşsa yazılır), yeni oturum aynı transaction içinde açılır. Eşzamanlı iki yenilemeden yalnızca biri kazanır.
- **Aile başına en fazla 2 satır** tutulur: az önce iptal edilen (eski) ve aktif (yeni). Daha eski iptal edilmiş satırlar rotation sırasında silinir.
- **Tekrar kullanım tespiti:** iptal edilmiş token iptalden **10 saniye sonra** tekrar gelirse çalınmış sayılır ve ailenin tamamı iptal edilir. 10 saniye içinde gelirse eşzamanlı yenileme yarışı sayılır, yalnızca 401 döner.
- **Logout:** oturumun ailesi silinir; istemci gönderdiyse access token da iptal edilir.
- Refresh token'ın içinde veri yoktur (32 bayt rastgele değer); kullanıcı bilgisi oturum satırından, rol ve klinik bilgisi her yenilemede users servisinden taze alınır.

> `user_id` üzerinde index yok (ayrı migration ile kaldırıldı). "Tüm cihazlardan çıkış" eklenirse geri eklenmeli.

> Süresi dolmuş ailelerin periyodik temizliği sonraki güncellemeye bırakıldı.

### Redis (`redis-auth`) — hatalı giriş kilidi

| Anahtar | TTL | Anlamı |
|---|---|---|
| `auth:login-fail:<email>` | 15 dk (ilk denemede başlar, uzamaz) | Penceredeki deneme sayacı — deneme **şifre kontrolünden önce** sayılır, başarılı giriş siler |
| `auth:login-lock:<email>` | Kilit süresi | Varsa hesap kilitli (`TOO_MANY_REQUESTS`) |
| `auth:login-lock-level:<email>` | 24 saat (her hatalı denemede yenilenir) | Art arda kilit sayısı (kademe) |

15 dakikada 5 hatalı deneme hesabı kilitler; art arda kilitler **5 → 15 → 30 → 60 dk** (sonra 60 dk sabit). 24 saat hatasız geçerse kademe sıfırlanır. Kilit yalnızca email bazlıdır; kayıtsız email için de uygulanır (email sızıntısını önlemek için).

---

## Users Service — PostgreSQL (`users_db`)

Prisma: `apps/users/prisma/schema.prisma`

### users

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | Auth Service'in ürettiği id — default yok |
| email | varchar(254), unique | **Kopya** — source of truth `auth_db.credentials`; değişiklik önce auth'ta yapılır |
| full_name | varchar(64) | |
| tel_no | varchar(16), unique | E.164 formatında (`+905XXXXXXXXX`); 16 = E.164 üst sınırı |
| role | enum, default `PET_OWNER` | `PET_OWNER` / `CLINIC` — `users.proto` `UserRole` ile aynı; `CLINIC` kliniğin ortak hesabıdır (`STAFF` kaldırıldı, proto numarası `reserved`); `CreateUser` yalnızca `PET_OWNER` üretir |
| clinic_id | UUID, nullable | Klinik hesabıysa (`CLINIC`) dolu, hasta sahibiyse null (proto'ya boş string olarak döner) |
| is_active | boolean, default `true` | Hesap durumu (silmeden devre dışı bırakma) — çevrim içi bilgisi **değil**. `false` ise login ve refresh `ACCOUNT_DISABLED` alır |
| created_at | timestamp | |
| updated_at | timestamp | |

**Index:** `(clinic_id, role)` — `ListUsersByClinic` için.

> Kullanıcı adres alanları kaldırıldı (proto'da `reserved`).

**Kayıt akışı sırası:** önce `users` kaydı oluşturulur (email + tel_no çakışmaları burada yakalanır), ardından `credentials` ve ilk oturum aynı transaction içinde yazılır. Auth yazımı ya da access token üretimi başarısız olursa kullanıcı kaydı `DeleteUser` RPC'si ile geri alınır (idempotent: kayıt yoksa `deleted = false`).

---

## Clinics Service — PostgreSQL

### clinics

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| full_name | varchar | |
| tax_number | varchar(11), unique | VKN (10 hane) veya şahıs işletmesi için TCKN (11 hane) |
| contact_email | varchar, unique | Kurumsal iletişim adresi — **giriş kimliği değil** (girişler auth_db üzerinden) |
| tel_no | varchar, unique | E.164 formatında |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## Pets Service — MongoDB (taslak)

### pets

| Alan | Tip | Not |
|---|---|---|
| _id | UUID | |
| name | string | Proto `name` ile aynı |
| species | string | Enum mu serbest metin mi — **açık soru** |
| breed | string, opsiyonel | Melez / bilinmeyen cins için boş bırakılabilir |
| sex | enum | `MALE` / `FEMALE` — proto `PetSex` |
| birth_date | date, opsiyonel | Kesin tarih veya tahmini yaştan hesaplanan tarih — yaş saklanmaz, her okumada bu tarihten hesaplanır |
| is_birth_date_estimated | boolean, default `false` | `true`: tarih kullanıcının girdiği yaştan türetildi ("~3 yaş" gösterimi) |
| is_neutered | boolean, default `false` | |
| owner_user_id | string, index | `users.id` — uygulama seviyesinde referans |
| chip_no_encrypted | string, opsiyonel | AES-256-GCM, random IV — semantically secure, **aranamaz** |
| chip_no_index | string, opsiyonel, **partial unique** | HMAC-SHA256 blind index — arama bu alan üzerinden; çipsiz kayıtlar unique kısıtına takılmasın diye partial |
| chip_no_last4 | string, opsiyonel | `chip_number_masked` ("****1234") için — her okumada şifre çözmemek adına |
| created_at | datetime | |
| updated_at | datetime | |

> Çip numarası neden ikiye ayrıldı: Deterministic encryption (aynı girdi → aynı çıktı) aranabilirlik sağlar ama frekans analizine açıktır. Blind index yaklaşımı ile asıl veri semantically secure şekilde şifreli kalır, arama ayrı bir HMAC sütunu üzerinden yapılır.

---

## Access Service — PostgreSQL (`access_db`) + Redis

Prisma: `apps/access/prisma/schema.prisma`

### consents (güncel rıza durumu)

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| clinic_id | UUID | Clinics Service referansı — izin hangi kliniğe verildi |
| pet_id | UUID | Pets Service referansı — izin hangi hayvan için verildi |
| pet_owner_id | UUID, index | Users Service referansı — rızayı veren hasta sahibi; "verdiğim izinler" listesi için |
| medical_read | boolean, default `false` | Scope |
| medical_write | boolean, default `false` | Scope |
| vaccination_read | boolean, default `false` | Scope |
| prescription_read | boolean, default `false` | Scope |
| chip_number_read | boolean, default `false` | Scope |
| owner_contact_read | boolean, default `false` | Scope |
| status | enum, default `ACTIVE` | `ACTIVE` / `REVOKED` |
| expires_at | timestamp | Rıza penceresinin üst sınırı (`GrantConsentRequest.expires_at`) |
| revoked_at | timestamp, nullable | Son iptal zamanı |
| created_at | timestamp | |
| updated_at | timestamp | |

**Composite unique:** `(clinic_id, pet_id)` — bir klinik ile bir hayvan arasında tek rıza satırı. İptal edilen rıza yeniden verilirse **aynı satır** güncellenir (`upsert`), yeni satır açılmaz; geçmiş `consent_events`'te korunur.

Geçerli rıza = `status = ACTIVE` **ve** `expires_at > şimdi` **ve** istenen scope sütunu `true`.

6 scope sütunu `CONSENT_SCOPES` (`libs/common`) ile birebir aynıdır.

### consent_events (değiştirilemez denetim izi)

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | Trigger üretir (`gen_random_uuid()`) |
| consent_id | UUID, FK → `consents.id` | `ON DELETE RESTRICT` — geçmişi olan rıza silinemez |
| action | enum | `GRANTED` / `UPDATED` / `REVOKED` |
| medical_read … owner_contact_read | boolean (6 sütun) | İşlem anındaki scope'ların kopyası |
| expires_at | timestamp | İşlem anındaki rıza penceresi |
| actor_id | UUID | İşlemi yapan kullanıcı (`users.id`) |
| created_at | timestamp | |

**Index:** `(consent_id, created_at)` — bir rızanın geçmişini sırayla okumak için.

**Trigger'lar** (migration SQL'inde; Prisma şemada ifade edemez):

- `consents_audit` — `consents` tablosuna her `INSERT`/`UPDATE`'te `consent_events`'e bir satır ekler. Uygulama bu tabloya **kendisi yazmaz**.
  - İlk rıza ve iptal sonrası yeniden rıza → `GRANTED`, iptal → `REVOKED`, scope ya da süre değişikliği → `UPDATED`.
  - Fiilen hiçbir şey değişmeyen güncellemeler (yalnızca `updated_at`) kayda geçmez.
  - İşlemi yapan kişi, uygulamanın aynı transaction içinde ayarladığı `app.actor_id`'den okunur. Ayarlanmamışsa yazma **reddedilir**:
    ```ts
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.actor_id', ${user.userId}, true)`;
      await tx.consent.upsert({ ... });
    });
    ```
- `consent_events_append_only` — `consent_events` satırlarını değiştirmeyi ve silmeyi engeller.

> **Sıfırlama:** Silme yasağı satır bazındadır; `prisma migrate reset` ya da veritabanı volume'ünün silinmesi engellenmez. Trigger'lar migration içinde olduğu için sıfırlamadan sonra kendiliğinden yeniden kurulur.

### Redis (`redis-access`) — opaque access token kaydı

```
key:   access:opaque-token:<sha256(opaque_token)>
value: { userId, role, clinicId, clientType, issuedAt, expiresAt }
TTL:   auth'un istediği süre (15 dk), en fazla OPAQUE_TOKEN_TTL (.env, varsayılan 3600 sn)
```

- Açık token hiçbir yerde saklanmaz; anahtar token'ın SHA-256'sıdır.
- `ExchangeToken`'da kayıttaki `clientType` istekteki ile karşılaştırılır (web'den çalınan token mobilde çalışmaz) ve 60 saniyelik RS256 JWT üretilir.
- Logout ve hatalı token üretiminde `RevokeToken` kaydı siler.

> **Giriş token'ı ≠ rıza:** Redis'teki kayıt kullanıcının **kimliğini** taşır, rıza bilgisi taşımaz. Rıza token'a gömülmez — iptalin anında etkili olması gerekir ve bir token'da hangi hayvan için izin olduğu bilgisi taşınamaz. Rıza kararı her istekte `consents` tablosundan verilir (`CheckAccess`).

---

## Medical Record Service — PostgreSQL + Local File System (tartışılacak)

> Bu bölüm ilk taslaktır, henüz uygulanmadı. Proto'daki aşı / reçete listeleri ve `ReviewDraft` akışının tablolarla eşleşmesi netleştirilecek.

### medical_records

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| pet_id | UUID | **Tekil** — bir tıbbi kayıt tek bir hayvana ait |
| raw_file_path | varchar | Local file system yolu, örn. `/var/medical-files/xxx.pdf` |
| result_json | jsonb | AI'ın ürettiği / hekimin onayladığı yapılandırılmış veri |
| status | enum | `ai_draft` / `physician_approved` / `physician_rejected` |
| reviewed_by | UUID, nullable | Onaylayan / reddeden hekimin `users.id`'si |
| created_at | timestamp | |
| updated_at | timestamp | |

> **Physician-in-the-Loop:** AI çıktısı doğrudan veritabanına yazılmaz; `ai_draft` statüsüyle hekimin önüne taslak olarak düşer, hekim onaylarsa `physician_approved` olur.

> **Bulut kullanılmıyor:** Fiziksel dosyalar local file system'da tutulur, DB'de sadece yol referansı saklanır (on-premise ve KVKK kısıtları).
