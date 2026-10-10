# PatiPasaport — Veritabanı Şeması

Servis bazlı (database-per-service) yapı. Servisler arası ilişkiler SQL foreign key ile değil, **uygulama seviyesinde** (gRPC çağrısı ile doğrulanarak) tutulur — çünkü her servisin veritabanı ayrı bir sunucudadır ve veritabanları birbirine native referans veremez. Aynı servisin kendi tabloları arasında foreign key kullanılabilir.

| Servis | Durum |
|---|---|
| Auth | ✅ Kesinleşti — Prisma schema + migration uygulandı; servis metotları yazıldı (`Register`, `RegisterClinicAccount`, `Login`, `RefreshToken`, `Logout`) |
| Users | ✅ Kesinleşti — Prisma schema + migration uygulandı; servis metotları yazıldı (`CreateUser`, `CreateClinicUser`, `DeleteUser`, `GetMe`, `UpdateMe`, `DeactivateMe`, `DeactivateClinicUsers`, `GetUserRole`, `GetUserAuthInfo`, `GetUserDisplayNames`, `GetUserContact`). `ListUsersByClinic` proto'dan kaldırıldı — `STAFF` rolü kaldırıldığı için işlevsiz kalmıştı |
| Clinics | ✅ Kesinleşti — Prisma schema + migration uygulandı (`clinics`, `stock_items`); servis metotları yazıldı (`GetClinic`, `CreateClinic`, `DeactivateClinic`, `AddStockItem`, `ListStockItems`, `GetClinicPetOverview`). `UploadPetResult` Medical Record tasarımını bekliyor (şimdilik `UNIMPLEMENTED` döner) |
| Pets | ✅ Kesinleşti — Prisma schema + migration uygulandı (MongoDB'den PostgreSQL'e geçildi); servis metotları yazıldı (`GetPet`, `SearchClinicPets`, `ListMyPets`, `GetPetOwner`, `CreatePet`, `UpdatePet`) |
| Access | ✅ Rıza tabloları kesinleşti — Prisma schema + migration + trigger'lar uygulandı; token RPC'leri (`CreateOpaqueToken`, `RevokeToken`, `ExchangeToken`) ve rıza RPC'leri (`GrantConsent`, `RevokeConsent`, `GetConsentStatus`, `ListMyConsents`, `CheckAccess`) yazıldı; Pets `GetPetOwner` ve Clinics `GetClinic` uçlarıyla uçtan uca çalışıyor |
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
| full_name | varchar(64) | Hasta sahibinde ad soyad (`FullName` kuralı); klinik hesabında kliniğin adı (klinik adı kuralı, 2–64) |
| tel_no | varchar(16), unique | E.164 formatında; hasta sahibinde mobil (`+905XXXXXXXXX`), klinik hesabında sabit hat, 0850 ya da mobil (`+90[2-58]XXXXXXXXX`); 16 = E.164 üst sınırı |
| role | enum, default `PET_OWNER` | `PET_OWNER` / `CLINIC` — `users.proto` `UserRole` ile aynı; `CLINIC` kliniğin ortak hesabıdır (`STAFF` kaldırıldı, proto numarası `reserved`); `CreateUser` yalnızca `PET_OWNER` üretir, `CLINIC` hesabı yalnızca klinik oluşturma akışında `CreateClinicUser` ile açılır |
| clinic_id | UUID, nullable | Klinik hesabıysa (`CLINIC`) dolu, hasta sahibiyse null (proto'ya boş string olarak döner) |
| is_active | boolean, default `true` | Hesap durumu (silmeden devre dışı bırakma) — çevrim içi bilgisi **değil**. `false` ise login ve refresh `ACCOUNT_DISABLED` alır. Hasta sahibi `DeactivateMe` ile, klinik hesabı klinik pasifleştirilirken `DeactivateClinicUsers` ile `false` yapılır; eldeki access token en fazla 15 dk daha geçerli kalır |
| created_at | timestamp | |
| updated_at | timestamp | |

**Index:** `(clinic_id, role)` — `DeactivateClinicUsers` için (kliniğin ortak hesabını `clinic_id` ile bulur).

> Kullanıcı adres alanları kaldırıldı (proto'da `reserved`).

**Kayıt akışı sırası:** önce `users` kaydı oluşturulur (email + tel_no çakışmaları burada yakalanır), ardından `credentials` ve ilk oturum aynı transaction içinde yazılır. Auth yazımı ya da access token üretimi başarısız olursa kullanıcı kaydı `DeleteUser` RPC'si ile geri alınır (idempotent: kayıt yoksa `deleted = false`).

---

## Clinics Service — PostgreSQL (`clinics_db`)

Prisma: `apps/clinics/prisma/schema.prisma`

### clinics

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| full_name | varchar(128) | Proto `Clinic.name`. DTO 2–64 karakterle sınırlar (harf, rakam, boşluk, `. ' & -`) çünkü aynı değer kliniğin ortak hesabında `users.full_name`'e (varchar(64)) yazılır |
| tax_number | varchar(11), unique | VKN (10 hane) veya şahıs işletmesi için TCKN (11 hane); resmi kontrol hanesi algoritmalarıyla doğrulanır. Pasif klinikte `X` + 10 rastgele rakam |
| contact_email | varchar(254), unique | Kurumsal iletişim adresi. Klinik oluşturulurken aynı değer ortak hesabın giriş e-postası olarak da yazılır (`users.email`, `auth_db.credentials.email`); giriş yine auth_db üzerinden yapılır ve sütunlar sonradan birbirini izlemez. Proto `Clinic.email` |
| tel_no | varchar(16), unique | E.164 formatında; Türkiye sabit hat, 0850 ya da mobil (`+90[2-58]XXXXXXXXX`). Proto `Clinic.phone` |
| is_active | boolean, default `true` | `false` ise klinik pasif; Access Service `GrantConsent`'te pasif kliniği `NOT_FOUND` sayar, stok işlemleri `FORBIDDEN` alır |
| created_at | timestamp | |
| updated_at | timestamp | |

**Oluşturma akışı:** `CreateClinic` iç RPC'dir (gateway'e açılmaz, yönetici çağırır). Önce klinik satırı yazılır (`TAX_NUMBER_` / `EMAIL_` / `PHONE_ALREADY_EXISTS` burada yakalanır), ardından `auth.RegisterClinicAccount` kliniğin ortak hesabını açar (users `CreateClinicUser` → credentials; credential yazılamazsa `DeleteUser` ile geri alınır). Auth hata verirse klinik satırı silinir. Bilinen sınır: auth kaydı yazdıktan sonra clinics→auth çağrısı zaman aşımına uğrarsa klinik satırı silinir ve hesap sahipsiz kalır (error loguna yazılır).

**Silme yok, pasifleştirme var:** klinik kaydı fiziksel olarak silinmez. `DeactivateClinic`'i yalnızca kliniğin kendisi (`CLINIC` rolü, JWT'deki `clinicId`) çağırabilir: `is_active = false` yapılır ve `tax_number` `X` + 10 rastgele rakamla değiştirilir (gerçek VKN/TCKN yalnızca rakamdan oluştuğu için çakışmaz; nadir çakışmada bir kez yeniden üretilir). Ad, e-posta, telefon ve stok kayıtları korunur. Ardından kliniğin ortak hesabı `DeactivateClinicUsers` ile pasifleşir. Kliniğe verilmiş rızalar iptal edilmez. Hesap pasifleştirme adımı yarım kalırsa işlem tekrar çağrılabilir; klinik zaten pasifse vergi numarasına dokunulmaz.

### stock_items

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| clinic_id | UUID, FK → `clinics.id`, index | `ON DELETE RESTRICT` — stoku olan klinik silinemez (zaten silinmez, pasifleştirilir) |
| name | varchar(64) | Kural: `AddStockItemRequestDto` |
| category | enum `StockCategory` | `VACCINE` / `MEDICINE` / `SUPPLY` / `FOOD` / `OTHER` — `STOCK_CATEGORIES` (`libs/common`) ile birebir aynı |
| unit | enum `StockUnit` | `PIECE` / `BOX` / `BOTTLE` / `AMPOULE` / `TABLET` / `DOSE` / `ML` / `MG` / `G` — `STOCK_UNITS` ile birebir aynı |
| quantity | integer | 0–100.000 (DTO) |
| critical_level | integer | 0–100.000 (DTO); `0` = uyarı yok |
| expires_at | date, nullable | Son kullanma tarihi; boşsa yok |
| created_by | UUID | Kaydı giren kullanıcının `users.id`'si — JWT'den alınır, istemciden değil |
| created_at | timestamp | |
| updated_at | timestamp | |

**Index:** `(clinic_id, category)` — `ListStockItems` kategori filtresi için.

`is_below_critical` saklanmaz; okurken `quantity < critical_level` olarak hesaplanır.

> Kategori veya birim listesine yeni kod eklemek hem `libs/common` listesini hem enum migration'ını gerektirir.

---

## Pets Service — PostgreSQL (`pets_db`)

Prisma: `apps/pets/prisma/schema.prisma`

> İlk tasarım MongoDB'ydi; Prisma 7'nin MongoDB sürücü adaptörü olmadığı ve veri tamamen sabit yapılı olduğu için PostgreSQL'e geçildi (diğer servislerle aynı araç zinciri).

### pets

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | Pets Service üretir (UUID v4) |
| name | varchar(32), collation `tr-TR-x-icu` | 1–32 karakter; yalnızca harf (Türkçe dahil) ve kelimeler arasında tek boşluk — rakam, emoji ve `' _ + -` kabul edilmez. `SearchClinicPets`'teki büyük/küçük harf duyarsız ad araması Türkçe kurala göre çalışır (`I`↔`ı`, `İ`↔`i`); Prisma sütun collation'ını tanımadığı için ayar migration'da tutulur |
| species | enum `PetSpecies` | `PET_SPECIES` kodlarından biri — aşağıdaki "Tür ve cins listesi" |
| breed | varchar(32), zorunlu | Kaydın türüne ait `PET_BREEDS` listesinden biri; melez veya cinsi bilinmeyen hayvan için `MIXED`. Tür–cins uyumu uygulamada doğrulanır (liste değişince migration gerekmesin diye enum değil) |
| sex | enum `PetSex` | `MALE` / `FEMALE` — proto `PetSex` |
| birth_date | date, nullable | `YYYY-AA-GG`. Kesin tarih veya tahmini yaştan hesaplanan tarih — yaş saklanmaz, her okumada bu tarihten hesaplanır. Türkiye saatine (`Europe/Istanbul`) göre bugünden sonraki tarih kabul edilmez |
| is_birth_date_estimated | boolean, default `false` | `true`: tarih kullanıcının girdiği yaştan türetildi ("~3 yaş" gösterimi); `true` ise `birth_date` zorunlu. Proto: `Pet` 13, `CreatePetRequest` 9, `UpdatePetRequest` 7 |
| is_neutered | boolean, default `false` | |
| owner_user_id | UUID, index | `users.id` — uygulama seviyesinde referans |
| chip_no_encrypted | text, nullable | AES-256-GCM, random IV — semantically secure, **aranamaz**. Düz metin ISO 11784/11785 biçiminde tam 15 rakam |
| chip_no_index | varchar(64), nullable, unique | HMAC-SHA256 blind index — arama bu alan üzerinden. PostgreSQL unique kısıtında NULL'lar birbirinden farklı sayıldığı için çipsiz kayıtlar kısıta takılmaz |
| chip_no_last4 | char(4), nullable | `chip_number_masked` ("****1234") için — her okumada şifre çözmemek adına |
| created_at | timestamp | |
| updated_at | timestamp | |

> Çip numarası neden ikiye ayrıldı: Deterministic encryption (aynı girdi → aynı çıktı) aranabilirlik sağlar ama frekans analizine açıktır. Blind index yaklaşımı ile asıl veri semantically secure şekilde şifreli kalır, arama ayrı bir HMAC sütunu üzerinden yapılır.

### Tür ve cins listesi

Tanım: `libs/common/src/lib/enums/messages/pet-species.ts` (`PET_SPECIES`) ve `pet-breeds.ts` (`PET_BREEDS`, anahtar = tür, değer = cins listesi). Değerler İngilizce koddur; arayüz Türkçe adını gösterir. Listede yalnızca küçük hayvan kliniklerine uygun evcil türler vardır (vahşi ve egzotik türler yok). Her türde en fazla 8 cins tutulur, melez ve cinsi bilinmeyenler için her türe ayrıca `MIXED` eklenir.

| Tür | Cinsler |
|---|---|
| `DOG` | `GOLDEN_RETRIEVER`, `LABRADOR_RETRIEVER`, `GERMAN_SHEPHERD`, `KANGAL`, `SIBERIAN_HUSKY`, `POODLE`, `POMERANIAN`, `YORKSHIRE_TERRIER`, `MIXED` |
| `CAT` | `BRITISH_SHORTHAIR`, `SCOTTISH_FOLD`, `PERSIAN`, `TURKISH_VAN`, `TURKISH_ANGORA`, `SIAMESE`, `MAINE_COON`, `RAGDOLL`, `MIXED` |
| `BIRD` | `BUDGERIGAR`, `CANARY`, `COCKATIEL`, `LOVEBIRD`, `AFRICAN_GREY`, `MIXED` |
| `RABBIT` | `HOLLAND_LOP`, `NETHERLAND_DWARF`, `LIONHEAD`, `ANGORA`, `REX`, `MIXED` |
| `HAMSTER` | `SYRIAN`, `CAMPBELL_DWARF`, `WINTER_WHITE_DWARF`, `ROBOROVSKI`, `MIXED` |
| `GUINEA_PIG` | `AMERICAN`, `ABYSSINIAN`, `PERUVIAN`, `TEDDY`, `MIXED` |
| `FERRET` | `MIXED` — gelinciğin cinsi yoktur, yalnızca renk varyantı vardır |
| `TURTLE` | `RED_EARED_SLIDER`, `YELLOW_BELLIED_SLIDER`, `RUSSIAN_TORTOISE`, `MIXED` — yerli mahmuzlu tosbağa koruma altında olduğu için listede yok |

**Kurallar:**
- `PET_BREEDS`'in anahtarları `PET_SPECIES` ile birebir aynı olmak zorundadır (`satisfies Record<PetSpecies, …>`); yeni bir tür eklenip cinsleri yazılmazsa kod derlenmez.
- `CreatePet`: cins, istekteki türün listesinden olmalıdır (ör. `DOG` + `CANARY` reddedilir).
- `UpdatePet`'te `species` alanı yoktur; DTO yalnızca cinsin herhangi bir listede olduğunu doğrular, kayıtlı türle uyumu Pets Service kontrol eder.

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
| chip_number_read | boolean, default `false` | Scope — çip numarasını açık görme. Klinik çip düzeltmesi (`UpdatePet`) de bu scope'u ister: göremediği veriyi değiştiremez |
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
