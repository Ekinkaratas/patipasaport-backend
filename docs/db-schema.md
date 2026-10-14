# PatiPasaport — Veritabanı Şeması

Servis bazlı (database-per-service) yapı. Servisler arası ilişkiler SQL foreign key ile değil, **uygulama seviyesinde** (gRPC çağrısı ile doğrulanarak) tutulur — çünkü her servisin veritabanı ayrı bir sunucudadır ve veritabanları birbirine native referans veremez. Aynı servisin kendi tabloları arasında foreign key kullanılabilir.

| Servis | Durum |
|---|---|
| Auth | ✅ Kesinleşti — Prisma schema + migration uygulandı; servis metotları yazıldı (`Register`, `RegisterClinicAccount`, `Login`, `RefreshToken`, `Logout`) |
| Users | ✅ Kesinleşti — Prisma schema + migration uygulandı; servis metotları yazıldı (`CreateUser`, `CreateClinicUser`, `DeleteUser`, `GetMe`, `UpdateMe`, `DeactivateMe`, `DeactivateClinicUsers`, `GetUserRole`, `GetUserAuthInfo`, `GetUserDisplayNames`, `GetUserContact`). `ListUsersByClinic` proto'dan kaldırıldı — `STAFF` rolü kaldırıldığı için işlevsiz kalmıştı |
| Clinics | ✅ Kesinleşti — Prisma schema + migration uygulandı (`clinics`, `stock_items`); servis metotları yazıldı (`GetClinic`, `CreateClinic`, `DeactivateClinic`, `AddStockItem`, `ListStockItems`, `GetClinicPetOverview`). `UploadPetResult` Medical Record tasarımını bekliyor (şimdilik `UNIMPLEMENTED` döner) |
| Pets | ✅ Kesinleşti — Prisma schema + migration uygulandı (MongoDB'den PostgreSQL'e geçildi); servis metotları yazıldı (`GetPet`, `SearchClinicPets`, `ListMyPets`, `GetPetOwner`, `CreatePet`, `UpdatePet`) |
| Access | ✅ Rıza tabloları kesinleşti — Prisma schema + migration + trigger'lar uygulandı; token RPC'leri (`CreateOpaqueToken`, `RevokeToken`, `ExchangeToken`) ve rıza RPC'leri (`GrantConsent`, `RevokeConsent`, `GetConsentStatus`, `ListMyConsents`, `CheckAccess`) yazıldı; Pets `GetPetOwner` ve Clinics `GetClinic` uçlarıyla uçtan uca çalışıyor |
| Medical Record | ✅ Uygulandı — proto, DTO'lar, CloudEvents, Prisma schema + migration (trigger'larla), 9 gRPC metodu, outbox + RabbitMQ, clinics.UploadPetResult ve gateway uçları (yükleme dahil); unit testler (medical_record 172, gateway 15) ve e2e testler (medical_record-e2e 11, gateway-e2e yükleme ve kayıt uçları) yazıldı. AI sözleşme dokümanı henüz yok |

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

## Medical Record Service — PostgreSQL (`medical_db`) + SeaweedFS (S3) + RabbitMQ

> Uygulanıyor. Proto: `libs/proto/src/lib/medical_record/medical_record.proto`, olay şemaları: `libs/proto/src/lib/events/events.proto`.

### Dosya deposu — SeaweedFS (S3 uyumlu, on-premise)

Dosyalar bulut sağlayıcıya değil, kendi Docker ortamımızda çalışan SeaweedFS'e yazılır; veri sunucudan çıkmaz (KVKK yurt dışı aktarım riski yok). Uygulamalar S3 API'siyle konuşur; bu yüzden depo değişirse servis kodu ve `S3_*` ortam değişkenleri aynı kalır.

> **Neden MinIO değil:** MinIO Ekim 2025'te topluluk sürümünün Docker imajlarını yayınlamayı bıraktı, topluluk deposu bakım moduna alınıp arşivlendi; güvenlik yamaları imaj olarak gelmiyor. SeaweedFS aktif geliştirilen, Apache-2.0 lisanslı bir alternatif (imaj: `chrislusf/seaweedfs:4.48`).

- Compose servisi: `seaweedfs` (`weed server -s3`, S3 portu 8333; master 9333, filer 8888 yalnızca iç ağda). Veri `seaweedfs_data` volume'unda.
- Node servisleri `@aws-sdk/client-s3` ile bağlanır (`endpoint: S3_ENDPOINT`, `forcePathStyle: true`, `region: us-east-1`); SeaweedFS ile yazma/okuma/silme ve salt okunur sınır doğrulandı.
- `seaweedfs-init` tek seferlik container'ı (`tools/seaweedfs/init.sh`) bucket'ı ve kullanıcıları oluşturur; tekrar çalıştırıldığında var olana dokunmaz. `.env`'deki anahtarlardan biri boşsa hiçbir şey oluşturmadan durur.
- Bucket **özeldir**; anonim erişim kapalıdır.
- Erişim en az yetkiyle (bucket'a özel politika): `gateway` kullanıcısı `readwrite` (yazma/okuma/silme), `ai` kullanıcısı `readonly`. Uygulamalar admin kimliği kullanmaz.
- Diskte şifreleme: `-filer.encryptVolumeData` ile volume verisi şifrelenir; anahtarlar filer meta verisinde tutulur. Aynı makinede durdukları için ek koruma olarak sunucu diski de şifrelenmelidir (LUKS/BitLocker).
- S3 portu yalnızca dev ortamında `127.0.0.1:8333`'e açılır (`docker-compose.dev.yml`); dışarıya açık tek kapı gateway'dir.
- Periyodik saklama/imha görevi ve hesap silme işlemi yoktur (proje kararı). Dosya yalnızca yükleme geri alındığında silinir (Yükleme akışı, 5. madde).
- Erişim denetim logu: SeaweedFS her S3 isteğini `-s3.auditLogConfig` (`tools/seaweedfs/audit.json`) ile Fluent protokolüyle `fluent-bit` container'ına gönderir (`fluent/fluent-bit:5.1.3`, `tools/fluent-bit/audit.yaml`, yalnızca iç ağ). Kayıtlar `seaweedfs_audit` volume'ünde günlük dosyalara (`s3-access-YYYY-AA-GG.log`, satır başına bir JSON) yazılır; saklama/imha kararı gereği eski dosyalar silinmez.
  - Alanlar: `time` (unix sn), `requester` (S3 kullanıcısı: `gateway` / `ai`), `operation` (örn. `REST.PUT.OBJECT`), `bucket`, `key` (`<uuid>.<uzantı>`), `status`, `error_code`, `remote_ip`, `user_agent`, `request_id`, `signature_version`. Kişisel veri yoktur.
  - `audit.json`'a `timeout` / `write_timeout` yazılmaz: Fluent istemcisi bunları nanosaniye okur (SeaweedFS wiki'sindeki `3000` = 3 µs) ve bağlantı hiç kurulmaz; boş bırakılınca varsayılan 3 sn kullanılır.
  - Gönderim SeaweedFS tarafından zorunlu olarak asenkrondur: S3 istekleri hiç beklemez, ancak Fluent Bit kapalıyken yapılan isteklerin kaydı kaybolabilir (en iyi çaba).
  - Okumak için: `docker run --rm -v patipasaport_seaweedfs_audit:/a alpine cat /a/s3-access-<tarih>.log`.
- Anahtar değiştirme: `.env`'deki bir anahtar sonradan değiştirilirse init betiği var olan kullanıcıyı güncellemez; değişiklik `weed shell` içinde `s3.accesskey.rotate` ile yapılır.

### Yükleme akışı

1. Klinik `POST /clinics/:clinicId/pets/:petId/documents` ile dosyayı gateway'e yükler (multipart: `file` alanı ve isteğe bağlı `note`). Dosya en fazla 10 MB (10 MB dahil); pdf, jpg/jpeg veya png (`PET_RESULT_*` sabitleri). Bellekte tutulur, diske yazılmaz; Türkçe dosya adları için multer `defParamCharset: utf8` kullanılır, dosya adındaki klasör kısmı atılır.
2. Gateway gerçek türü dosya imzasından doğrular: NestJS'in yerleşik `FileTypeValidator`'ı (`@nestjs/common` ile gelen `file-type`, ESM yüklemesi `load-esm` ile) istemcinin bildirdiği türün yerine tespit edilen türü yazar. Ayrı bir `file-type` paketi kurulmadı.
3. Gateway sha256'yı hesaplar, nesne anahtarını `<uuid>.<uzantı>` olarak üretir (uzantı tespit edilen türden) ve isteğin tamamını `UploadPetResultRequestDto` ile doğrular. Doğrulama hatasında depoya hiçbir şey yazılmaz.
4. Dosya `@aws-sdk/client-s3` ile SeaweedFS'e yazılır (`gateway` kullanıcısı). Ardından `clinics.UploadPetResult` ile yalnızca referans iletilir; clinics klinik aktif ve kendisi mi diye bakar, isteği JWT ile `medical_record.RegisterDocument`'a aktarır.
5. medical-record `CheckAccess` ile `medical_write` rızasını kontrol eder. Aynı transaction içinde `documents` satırını (`QUEUED`) ve `outbox` satırını (`document.uploaded.v1`) yazar. Yanıt `201` ve `{ documentId, uploadedAt, status }`.
6. **Geri alma:** kayıt başarısız olursa (rıza yok vb.) gateway **yalnızca bu istekte yüklediği dosyayı** SeaweedFS'ten siler. Daha önce yüklenmiş bir dosyaya ilişkin istek erişim engeline takılırsa o dosya silinmez. clinics çağrısı zaman aşımına uğrarsa (`DEADLINE_EXCEEDED`) belge kaydı oluşmuş olabileceği için dosya silinmez, hata log'u yazılır.

**Hata yanıtları:** dosya yok → `FILE_NOT_EMPTY`; tür desteklenmiyor → `MIME_TYPE_NOT_VALID`; 10 MB'tan büyük → `SIZE_BYTES_MAX|10485760` (hepsi `400`); rıza yok / başka klinik / pasif klinik → `403 FORBIDDEN`; depoya yazılamazsa → `503 SERVICE_UNAVAILABLE`.

**Gateway'deki medical-record uçları:** `GET /pets/:petId/records|vaccinations|prescriptions|lab-results` (hasta sahibi ve klinik); `POST /pets/:petId/records` (201), `GET /documents/:id`, `GET /draft-reviews`, `POST /draft-reviews/:id/review` (yalnızca klinik). `RegisterDocument` dışarıya açık değildir.


### Olaylar — CloudEvents + RabbitMQ

- Zarf: CNCF **CloudEvents**, JSON yapılı biçim (`application/cloudevents+json`). Zorunlu alanlar: `id`, `source`, `type`, `specversion`, `subject`, `time`, `datacontenttype`, `dataschema`.
  - `specversion`: `1.0`; `datacontenttype`: `application/json`; `subject`: `document_id`.
  - `source`: medical-record için `/patipasaport/medical-record`, AI servisi için `/patipasaport/ai-service`.
  - `dataschema`: URN (örn. `urn:patipasaport:events:DocumentUploaded:v1`). Bir adres değil, şema adıdır; indirilmez, sunucu gerektirmez.
- `data`: `events.proto`'daki mesajın protobuf resmi JSON eşlemesi; Node (ts-proto) ve FastAPI (`grpcio-tools`) aynı şemadan tip üretir.
- Correlation id mesaj başlığında taşınır; mesajlarda kişisel veri (ad, telefon, e-posta) bulunmaz, yalnızca kimlik ve dosya referansı.

| `type` | Yayınlayan → Dinleyen | `data` |
|---|---|---|
| `com.patipasaport.document.uploaded.v1` | medical-record → AI | `DocumentUploaded` |
| `com.patipasaport.document.processing_started.v1` | AI → medical-record | `DocumentProcessingStarted` |
| `com.patipasaport.document.analyzed.v1` | AI → medical-record | `DocumentAnalyzed` |
| `com.patipasaport.document.analysis_failed.v1` | AI → medical-record | `DocumentAnalysisFailed` |

**Güvenilirlik:** kalıcı quorum kuyruk, kalıcı mesaj, yayıncı onayı (publisher confirm), tüketicide iş bittikten sonra elle onay (manual ack), gecikmeli tekrar deneme ve dead-letter kuyruğu. Teslim en az bir kez (at-least-once) olduğundan tüketiciler idempotenttir: aynı `document_id` için ikinci sonuç yok sayılır.

**RabbitMQ:** `rabbitmq:4.3-management-alpine` (3.13'ün topluluk desteği 30 Eylül 2024'te bitti). medical-record bağlantıyı ayrı değişkenlerle kurar (`RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`); şifre URL'ye girmediği için özel karakter sorunu olmaz. İstemci: `amqplib` + `amqp-connection-manager` (bağlantı koparsa yeniden bağlanır, topolojiyi ve tüketiciyi yeniden kurar).

**Topoloji** (tamamını medical-record açılışta tanımlar; AI'ın iş kuyruğu dahil, böylece AI çalışmıyorken gelen olaylar kaybolmaz):

| Ad | Tür | Not |
|---|---|---|
| `patipasaport.events` | topic exchange | Routing key = CloudEvents `type` |
| `patipasaport.events.dlx` | direct exchange | Routing key = hedef kuyruğun adı |
| `ai-service.document-uploaded` | quorum kuyruk | ← `com.patipasaport.document.uploaded.v1` |
| `medical-record.document-events` | quorum kuyruk | ← `processing_started.v1`, `analyzed.v1`, `analysis_failed.v1` |
| `<kuyruk>.retry` | quorum kuyruk | `x-message-ttl` 30 sn; süre dolunca ana kuyruğa döner |
| `<kuyruk>.dlq` | quorum kuyruk | Son durak; elle incelenir |

Ana ve retry kuyruklarının argümanları: `x-queue-type: quorum`, `x-dead-letter-exchange: patipasaport.events.dlx`, `x-dead-letter-routing-key` (ana → `.dlq`, retry → ana kuyruk), `x-dead-letter-strategy: at-least-once`, `x-overflow: reject-publish`; retry'da ayrıca `x-message-ttl: 30000`. AI kuyruğu aynı argümanlarla tanımlamalıdır (farklı argümanla tanımlama RabbitMQ'da hata verir).

**Mesaj özellikleri:** kalıcı (`delivery_mode` 2), `content_type: application/cloudevents+json`, `message_id` = CloudEvents `id`, `type` = CloudEvents `type`, başlık `x-correlation-id`. Gövde CloudEvents zarfıdır.

**Tüketici kuralları** (`medical-record.document-events`, prefetch 10):

- Geçici hata (örn. veritabanı hatası) → mesajın kopyası `x-retry-count` başlığı artırılarak `.retry`'ye yazılır, asıl mesaj onaylanır; 30 sn sonra tekrar işlenir. 5. denemede de işlenemezse `.dlq`'ya gider.
- Geçersiz mesaj (JSON değil, zarf/şema geçersiz, bilinmeyen tür, `subject` ≠ `document_id`, olmayan belge, öneri yok ya da türü geçersiz, `confidence` 0-1 dışında, `model_version`/`error_code` boş ya da 64 karakterden uzun) → tekrar denenmeden `.dlq`'ya gider.
- Durum geçişleri: `processing_started` → `QUEUED` ise `PROCESSING`; `analyzed` → `QUEUED`/`PROCESSING` ise taslak açılır ve belge `DRAFT_READY` olur (tek transaction); `analysis_failed` → `QUEUED`/`PROCESSING` ise `FAILED`, `failure_reason` = `error_code`. Belge zaten son durumdaysa olay tekrar sayılır: onaylanır, yok sayılır.
- AI önerisi olduğu gibi (`RecordContent`, sayısal enum'larla) saklanır; doğrulama klinik onayında yapılır.

**Outbox:** medical-record RabbitMQ'ya doğrudan yazmaz. Olay, iş verisiyle aynı transaction'da `outbox` tablosuna yazılır. Gönderim döngüsü:

- Saniyede bir, zamanı gelmiş en fazla 50 satırı `FOR UPDATE SKIP LOCKED` ile alır ve 60 sn'lik kira için `next_attempt_at`'i ileri atar. Böylece birden çok kopya aynı satırı göndermez ve gönderim sırasında transaction açık kalmaz.
- Yayıncı onayı gelince `published_at` doldurulur.
- Hata olursa (10 sn yayın zaman aşımı dahil) `attempts` artar, `last_error` yazılır ve sonraki deneme 2^deneme sn sonraya (en fazla 5 dk) ertelenir. Döngü vazgeçmez: RabbitMQ kapalıysa olay tabloda bekler, kaybolmaz.

**AI servisi (Python/FastAPI):** `document.uploaded.v1` ile tetiklenir; dosyayı mesajdaki `storage_path` ile, salt okunur S3 anahtarıyla (`ai` kullanıcısı) okur; sonucu yayınlamadan gelen mesajı onaylamaz. Kendi veritabanı olmadığından outbox gerekmez. Gateway ve medical-record AI servisini HTTP/gRPC ile çağırmaz.

### Durum makineleri

- Belge: `QUEUED → PROCESSING → DRAFT_READY | FAILED`
- Taslak: `PENDING → APPROVED | REJECTED`. Onaylanan kayıt değiştirilemez; düzeltme yeni kayıt olarak eklenir.

### Veri modeli — karışık

AI önerisi doğrulanmamış ve biçimi değişken olduğu için **taslakta jsonb** olarak durur; klinik onaylayınca **tipli tablolara** dönüştürülür. Klinik elle kayıt girdiğinde (`CreateRecord`) taslak aşaması atlanır.

> Şema: `apps/medical_record/prisma/schema.prisma`, migration: `apps/medical_record/prisma/migrations/*_init`. Metin uzunlukları DTO sınırlarıyla aynıdır. Kullanıcının girdiği tarihler `date` (YYYY-MM-DD), sistem zamanları `timestamp`.

#### documents

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| pet_id | UUID | |
| clinic_id | UUID | Yükleyen klinik (JWT) |
| storage_path | varchar(64), unique | Bucket içindeki nesne anahtarı |
| original_name | varchar(255) | |
| mime_type | varchar(32) | Dosya imzasından doğrulanmış tür |
| size_bytes | integer | En fazla 10 MB |
| sha256 | char(64) | Bütünlük kontrolü |
| note | varchar(500), nullable | |
| status | enum `DocumentStatus`, default `QUEUED` | `QUEUED` / `PROCESSING` / `DRAFT_READY` / `FAILED` |
| failure_reason | varchar(64), nullable | AI hata kodu |
| created_at / updated_at | timestamp | |

#### draft_reviews

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| document_id | UUID, FK → `documents.id`, unique | Aynı belgeye ikinci taslak açılmaz (idempotent tüketici) |
| pet_id / clinic_id | UUID | |
| record_type | enum `RecordType` | |
| proposed_payload | jsonb | AI'ın ham önerisi (`RecordContent`) |
| approved_payload | jsonb, nullable | Klinik düzelterek onayladıysa son hali |
| model_version | varchar(64) | |
| confidence | double precision | Proto'daki `double` ile birebir |
| status | enum `DraftReviewStatus`, default `PENDING` | `PENDING` / `APPROVED` / `REJECTED` |
| review_note | varchar(500), nullable | Red sebebi (redde zorunlu) |
| reviewed_by_clinic_id | UUID, nullable | Onaylayan/reddeden **klinik** (ortak hesap modeli; ayrıca user id tutulmaz) |
| reviewed_at | timestamp, nullable | |
| created_record_id | UUID, FK → `medical_records.id`, unique, nullable | Onayla oluşan kayıt |
| created_at | timestamp | |

#### medical_records (onaylı kaydın ortak başlığı — değiştirilemez)

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| pet_id | UUID | |
| clinic_id | UUID | Kaydı oluşturan / onaylayan klinik |
| type | enum `RecordType` | `EXAMINATION` / `VACCINATION` / `PRESCRIPTION` / `LAB_RESULT` / `SURGERY` |
| title | varchar(128) | |
| notes | text, nullable | En fazla 2000 karakter (DTO) |
| recorded_at | date | Muayene/uygulama tarihi |
| source_document_id | UUID, FK → `documents.id`, nullable | AI taslağının kaynak belgesi |
| source_draft_review_id | UUID, FK → `draft_reviews.id`, nullable | AI taslağından geldiyse |
| created_at | timestamp | |

#### record_attachments (kayda eklenen belgeler)

| Kolon | Tip | Not |
|---|---|---|
| record_id | UUID, FK → `medical_records.id` | Birleşik PK |
| document_id | UUID, FK → `documents.id` | Birleşik PK; bir belge birden çok kayda eklenebilir |

İstemci `CreateRecord`'da yalnızca `document_id` gönderir; servis belgenin aynı hayvana ve kliniğe ait olduğunu kontrol eder, dosya bilgilerini `documents`'tan doldurur.

#### Tipli ayrıntı tabloları

Her tablonun kendi `id`'si (UUID, PK) vardır. `pet_id` / `clinic_id` tekrar yazılmaz; listeler `medical_records` ile birleştirilerek okunur.

| Tablo | Kolonlar |
|---|---|
| `vaccinations` | id, record_id (FK, unique), vaccine_name varchar(128), batch_number varchar(64) nullable, administered_at date, next_due_at date nullable |
| `prescriptions` | id, record_id (FK, unique), medication_name varchar(128), dosage varchar(64), frequency varchar(64), duration_days integer, instructions varchar(1000) nullable, prescribed_at date |
| `lab_results` | id, record_id (FK, bir kayıtta birden çok satır), test_name varchar(128), value varchar(64), unit varchar(32) nullable, reference_range varchar(64) nullable, flag enum nullable (`NORMAL` / `LOW` / `HIGH`; belirtilmemişse null), sampled_at date |

**Değişmezlik (trigger, migration SQL'inde):** `forbid_medical_record_change()` fonksiyonu `medical_records`, `record_attachments`, `vaccinations`, `prescriptions` ve `lab_results` tablolarında `UPDATE` ve `DELETE`'i reddeder. Düzeltme yeni kayıt olarak eklenir. Tüm yabancı anahtarlar `ON DELETE RESTRICT`'tir.

#### outbox

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | CloudEvents `id` |
| type | varchar(128) | CloudEvents `type` |
| payload | jsonb | CloudEvents zarfı |
| correlation_id | varchar(128) | |
| attempts | integer, default 0 | |
| next_attempt_at | timestamp, default now | Hatada artan bekleme; döngü yalnızca zamanı gelenleri alır |
| last_error | varchar(500), nullable | Son gönderim hatası |
| created_at | timestamp | |
| published_at | timestamp, nullable | Doluysa gönderildi |

**İndeksler:** `documents (clinic_id, status)`, `draft_reviews (clinic_id, status)`, `medical_records (pet_id, recorded_at)`, `record_attachments (document_id)`, `vaccinations (next_due_at)`, `lab_results (record_id)`, `outbox (published_at, next_attempt_at)` — gönderilmemiş ve zamanı gelmiş olayları hızlı bulmak için.

### Erişim kuralları (zero trust)

Her okuma ve yazmada erişim yeniden kontrol edilir. Klinik için `access.CheckAccess` ile ilgili scope'a bakılır; hasta sahibi için `pets.GetPetOwner` ile sahiplik doğrulanır (rıza gerekmez).

| RPC | Kim | Kontrol |
|---|---|---|
| `ListRecordsByPet`, `ListLabResults` | hasta sahibi, klinik | sahiplik / `medical_read` |
| `ListVaccinations` | hasta sahibi, klinik | sahiplik / `vaccination_read` |
| `ListPrescriptions` | hasta sahibi, klinik | sahiplik / `prescription_read` |
| `RegisterDocument` (yalnızca clinics çağırır), `CreateRecord` | klinik | `medical_write` |
| `GetDocument` | klinik | belgeyi yükleyen klinik + `medical_write` |
| `ReviewDraft` | klinik | taslağın kliniği + `medical_write` |
| `ListDraftReviews` | klinik | yalnızca kendi taslakları; `pet_id` verilirse o hayvanda `medical_write`, verilmezse `medical_write` rızası aktif olan hayvanlar (`ListMyConsents`) |

- Rızası olan klinik hayvanın **tüm** kayıtlarını görür (diğer kliniklerin kayıtları dahil); hasta sahibi kendi hayvanının tüm kayıtlarını görür.
- Rıza yoksa ya da eksikse `FORBIDDEN`; hayvan kullanıcıya ait değilse ya da belge/taslak başka kliniğinse `NOT_FOUND` döner.
- Listeler en yeni önce sıralanır. `only_upcoming` → `next_due_at ≥ bugün`, en yakın önce; `only_active` → `prescribed_at + duration_days - 1 ≥ bugün`; `test_name` → içerir, büyük/küçük harf duyarsız. "Bugün" İstanbul saatine göredir.
- `CreateRecord` ekleri aynı hayvana ve kliniğe ait belgeler olmalıdır; değilse `NOT_FOUND`.
- `ReviewDraft` onayında son içerik (düzeltilmiş ya da AI önerisi) `RecordContent` kurallarıyla doğrulanır; düzeltmede kayıt türü değişebilir; kaynak belge kaydın eklerine de eklenir. Taslak `PENDING` değilse `CONFLICT`.
