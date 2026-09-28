# PatiPasaport — Veritabanı Şeması

Servis bazlı (database-per-service) yapı. Servisler arası ilişkiler SQL foreign key ile değil, **uygulama seviyesinde** (gRPC çağrısı ile doğrulanarak) tutulur — çünkü farklı veritabanı teknolojileri (PostgreSQL / MongoDB) birbirine native referans veremez. Aynı servisin kendi tabloları arasında foreign key kullanılabilir.

| Servis | Durum |
|---|---|
| Auth | ✅ Kesinleşti — Prisma schema + migration uygulandı |
| Users | ✅ Kesinleşti — Prisma schema + migration uygulandı |
| Clinics | 🟡 Yüzeysel — ileride genişletilecek |
| Pets | 🟡 Taslak — açık soru: `species` |
| Access | ⏸ Tartışılacak — aşağıdaki içerik ilk taslaktır |
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
| refresh_token_hash | text, unique | **Hash'lenmiş** (SHA-256) — düz metin saklanmaz; refresh/logout aramaları bu alan üzerinden |
| client_type | enum | `WEB` / `MOBILE` — refresh sırasında `access.CreateToken`'a gönderilir (`RefreshTokenRequest` bu bilgiyi taşımaz) |
| issued_at | timestamp | |
| expires_at | timestamp | |
| revoked_at | timestamp, nullable | Dolu ise oturum geçersiz |
| updated_at | timestamp | |

> "Tüm cihazlardan çıkış" şu an kapsam dışı.

> **Redis'te tutulacaklar:** Hatalı giriş sayacı ve kilitlenme zamanı (TTL ile). Auth servisi için ayrı bir Redis kurulumu gerekiyor — sonraki adım.

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
| role | enum | `PET_OWNER` / `VETERINARIAN` / `STAFF` — `users.proto` `UserRole` ile aynı |
| clinic_id | UUID, nullable | Veteriner / klinik personeli ise dolu, hasta sahibiyse null |
| is_active | boolean, default `true` | Hesap durumu (silmeden devre dışı bırakma) — çevrim içi bilgisi **değil** |
| created_at | timestamp | |
| updated_at | timestamp | |

**Index:** `(clinic_id, role)` — `ListUsersByClinic` için.

> Kullanıcı adres alanları kaldırıldı (proto'da `reserved`).

**Kayıt akışı sırası:** önce `users` kaydı oluşturulur (email + tel_no çakışmaları burada yakalanır), ardından `credentials` yazılır. Auth yazımı başarısız olursa kullanıcı kaydı `DeleteUser` RPC'si ile geri alınır (Register ile birlikte yazılacak).

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

## Access Service — PostgreSQL + Redis (tartışılacak)

> Bu bölüm ilk taslaktır, henüz uygulanmadı. Bilinen uyumsuzluklar: tablo iki boolean scope tutuyor, kod 6 scope kullanıyor (`CONSENT_SCOPES`); Redis tasarımı koddaki token kaydından farklı; composite unique, iptal sonrası yeniden rıza ve geçmiş kaydını engelliyor.

### access_permissions (PostgreSQL — kalıcı rıza kaydı + audit trail)

| Kolon | Tip | Not |
|---|---|---|
| id | UUID (PK) | |
| clinic_id | UUID | Clinics Service referansı |
| pet_owner_id | UUID | Users Service referansı |
| pet_id | UUID | Pets Service referansı — izin hangi hayvan için verildi |
| medical_access | boolean | Scope: tıbbi verilere erişim |
| personal_access | boolean | Scope: kişisel verilere erişim |
| consent_expires_at | timestamp | Rıza penceresinin üst sınırı — **refresh ile değişmez** |
| status | enum | `active` / `revoked` (hasta sahibi manuel iptal ederse `revoked`) |
| created_at | timestamp | |
| updated_at | timestamp | |

**Composite unique:** `(clinic_id, pet_owner_id, pet_id)`

### Redis (aktif oturum token'ı)

```
key:   access_token:<opaque_random_string>
value: {
  access_permission_id: "<Postgres UUID>",
  clinic_id,
  pet_id,
  medical_access,
  personal_access
}
TTL:   consent_expires_at'e kalan saniye
```

> **İki farklı süre kavramı:** `consent_expires_at` = hasta sahibinin belirlediği rıza penceresi (sabit, iptal edilebilir). Redis TTL = teknik oturum süresi (yenilenebilir, ama rıza penceresinin kalan süresini asla aşamaz).

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
