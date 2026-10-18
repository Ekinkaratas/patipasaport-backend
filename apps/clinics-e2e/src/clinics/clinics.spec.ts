import { Client } from '@grpc/grpc-js';
import {
  callGrpc,
  DOCKER_GRPC_PORTS,
  expectOk,
  grpcClient,
  GrpcResult,
  istanbulToday,
  JwtIssuer,
  RunningService,
  SeededClinic,
  SeededUser,
  shiftDays,
  startService,
  TestData,
  uniqueEmail,
  uniqueLandlinePhone,
  validVkn,
} from '@libs/e2e-utils';
import { access, auth, clinics, pets } from '@libs/proto';
import { randomUUID } from 'crypto';

const outcome = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : `${result.code}/${result.details}`;

const code = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : result.code;

const PASSWORD = 'Klinik1!sifre';

describe('clinics servisi (e2e)', () => {
  const data = new TestData({ medicalRecord: true });
  const tokens = new JwtIssuer();
  const clinicUserIds = new Map<string, string>();

  let service: RunningService;
  let clinicsClient: Client;
  let accessClient: Client;
  let authClient: Client;
  let petsClient: Client;
  let active: SeededClinic;
  let passive: SeededClinic;
  let owner: SeededUser;
  const unknownClinicId = randomUUID();

  const clinicUserId = (clinicId: string): string => {
    let userId = clinicUserIds.get(clinicId);
    if (!userId) {
      userId = randomUUID();
      clinicUserIds.set(clinicId, userId);
    }
    return userId;
  };

  const clinicToken = (clinicId: string) =>
    tokens.jwtFor({
      role: 'CLINIC',
      userId: clinicUserId(clinicId),
      clinicId,
    });

  const ownerToken = () => tokens.jwtFor({ role: 'PET_OWNER', userId: owner.id });

  const callClinics = <T>(method: string, request: object, token?: string) =>
    callGrpc<T>(clinicsClient, method, request, token);

  const newClinicRequest = (override: object = {}) => ({
    name: 'Pati&Can 2 Veteriner',
    taxNumber: validVkn(),
    phone: uniqueLandlinePhone(),
    email: uniqueEmail('yeniklinik'),
    password: PASSWORD,
    ...override,
  });

  const createClinic = async (override: object = {}) => {
    const request = newClinicRequest(override);
    const result = await callClinics<clinics.ClinicResponse>(
      'CreateClinic',
      request,
    );
    if (result.ok && result.value.clinic) {
      data.trackClinic(result.value.clinic.id);
    }
    return { request, result };
  };

  const loginAsClinic = async (email: string, password: string) => {
    const login = await callGrpc<auth.TokenResponse>(authClient, 'Login', {
      email,
      password,
      clientType: auth.ClientType.WEB,
      rememberMe: false,
    });
    if (!login.ok) {
      return { login, jwt: undefined };
    }
    const exchanged = expectOk(
      await callGrpc<access.ExchangeTokenResponse>(
        accessClient,
        'ExchangeToken',
        {
          opaqueToken: login.value.accessToken,
          clientType: access.ClientType.WEB,
        },
      ),
      'access.ExchangeToken',
    );
    return { login, jwt: exchanged.jwt };
  };

  const clinicRowCount = async (taxNumber: string): Promise<number> => {
    const db = await data.db('clinics');
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM clinics WHERE tax_number = $1',
      [taxNumber],
    );
    return rows[0].n;
  };

  beforeAll(async () => {
    service = await startService('clinics');
    clinicsClient = grpcClient('clinics', service.port);
    accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
    authClient = grpcClient('auth', DOCKER_GRPC_PORTS.auth);
    petsClient = grpcClient('pets', DOCKER_GRPC_PORTS.pets);

    active = await data.insertClinic({ name: 'Pati Test Klinik' });
    passive = await data.insertClinic({
      name: 'Pasif Test Klinik',
      isActive: false,
    });
    owner = await data.insertUser({ fullName: 'Ayşe Yılmaz' });
  }, 120_000);

  afterAll(async () => {
    try {
      await data.cleanup();
    } finally {
      await data.close();
      [clinicsClient, accessClient, authClient, petsClient].forEach((client) =>
        client?.close(),
      );
      tokens.close();
      await service?.stop();
    }
  });

  // ---Amaç: klinik profilinin alanlarını ve vergi numarasının yalnızca kliniğin kendisine tam gösterildiğini doğrulamak ---
  describe('GetClinic', () => {
    it('kendi kliniği tam vergi numarasıyla döner', async () => {
      const result = expectOk(
        await callClinics<clinics.ClinicResponse>(
          'GetClinic',
          { id: active.id },
          await clinicToken(active.id),
        ),
        'GetClinic',
      );
      expect(result.clinic).toMatchObject({
        id: active.id,
        name: active.name,
        taxNumber: active.taxNumber,
        phone: active.phone,
        email: active.email,
        isActive: true,
      });
    });

    it('başka klinik ve hasta sahibi vergi numarasının yalnızca son 4 hanesini görür', async () => {
      for (const token of [await clinicToken(passive.id), await ownerToken()]) {
        const result = expectOk(
          await callClinics<clinics.ClinicResponse>(
            'GetClinic',
            { id: active.id },
            token,
          ),
          'GetClinic',
        );
        expect(result.clinic?.taxNumber).toBe(active.taxNumber.slice(-4));
      }
    });

    it('olmayan klinikte NOT_FOUND, pasif klinik isActive=false döner', async () => {
      const token = await clinicToken(active.id);
      expect(
        code(await callClinics('GetClinic', { id: randomUUID() }, token)),
      ).toBe('NOT_FOUND');
      const result = expectOk(
        await callClinics<clinics.ClinicResponse>(
          'GetClinic',
          { id: passive.id },
          token,
        ),
        'GetClinic',
      );
      expect(result.clinic?.isActive).toBe(false);
    });
  });

  // ---Amaç: stok ekleme kurallarını (sahiplik, aktiflik, kritik seviye, SKT, fiyatlar) ve created_by'ın JWT'den geldiğini doğrulamak ---
  describe('AddStockItem', () => {
    const add = async (override: object = {}, token?: string) =>
      callClinics<clinics.StockItemResponse>(
        'AddStockItem',
        {
          clinicId: active.id,
          name: 'Amoksisilin',
          category: 'MEDICINE',
          unit: 'BOX',
          quantity: 10,
          criticalLevel: 2,
          expiresAt: '2027-03-01',
          purchasePrice: 8_000,
          salePrice: 12_000,
          ...override,
        },
        token ?? (await clinicToken(active.id)),
      );

    it('kalemi fiyatlarıyla ekler; created_by JWT kullanıcısıdır', async () => {
      const item = expectOk(await add(), 'AddStockItem').item;
      expect(item).toMatchObject({
        clinicId: active.id,
        expiresAt: '2027-03-01',
        isBelowCritical: false,
        purchasePrice: 8_000,
        salePrice: 12_000,
      });
      const db = await data.db('clinics');
      const { rows } = await db.query(
        'SELECT created_by, expires_at::text AS expires_at, purchase_price, sale_price FROM stock_items WHERE id = $1',
        [item?.id],
      );
      expect(rows[0]).toEqual({
        created_by: clinicUserId(active.id),
        expires_at: '2027-03-01',
        purchase_price: 8_000,
        sale_price: 12_000,
      });
    });

    it('kritik seviye altı hesaplanır, boş SKT veritabanında null olur', async () => {
      const below = expectOk(
        await add({ expiresAt: '2027-01-01', quantity: 1, criticalLevel: 5 }),
        'AddStockItem',
      ).item;
      expect(below?.isBelowCritical).toBe(true);

      const noExpiry = expectOk(
        await add({ expiresAt: '', quantity: 3, criticalLevel: 1 }),
        'AddStockItem',
      ).item;
      expect(noExpiry?.expiresAt).toBe('');
      const db = await data.db('clinics');
      const { rows } = await db.query(
        'SELECT expires_at FROM stock_items WHERE id = $1',
        [noExpiry?.id],
      );
      expect(rows[0].expires_at).toBeNull();

      expectOk(
        await add({
          name: 'Bandaj',
          category: 'SUPPLY',
          unit: 'PIECE',
          quantity: 0,
          criticalLevel: 0,
          expiresAt: '',
        }),
        'AddStockItem',
      );
      expectOk(
        await add({
          name: 'Kuduz Aşısı',
          category: 'VACCINE',
          unit: 'DOSE',
          quantity: 2,
          criticalLevel: 3,
          expiresAt: shiftDays(istanbulToday(), 60),
        }),
        'AddStockItem',
      );
    });

    it('sahiplik, aktiflik, kayıt ve rol kuralları', async () => {
      expect(code(await add({ clinicId: passive.id }))).toBe(
        'PERMISSION_DENIED',
      );
      expect(
        outcome(
          await add({ clinicId: passive.id }, await clinicToken(passive.id)),
        ),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
      expect(
        code(
          await add(
            { clinicId: unknownClinicId },
            await clinicToken(unknownClinicId),
          ),
        ),
      ).toBe('NOT_FOUND');
      expect(code(await add({}, await ownerToken()))).toBe('PERMISSION_DENIED');
    });

    it('geçersiz kategori ve geçmiş SKT DTO’da reddedilir', async () => {
      expect(outcome(await add({ category: 'DRUG' }))).toBe(
        'INVALID_ARGUMENT/CATEGORY_NOT_VALID',
      );
      expect(
        outcome(await add({ expiresAt: shiftDays(istanbulToday(), -1) })),
      ).toBe('INVALID_ARGUMENT/EXPIRES_AT_CANNOT_BE_PAST');
    });
  });

  // ---Amaç: stok listesinin sıralama, filtre, sayfalama ve erişim kurallarını doğrulamak ---
  describe('ListStockItems', () => {
    const list = async (override: object = {}, token?: string) =>
      callClinics<clinics.ListStockItemsResponse>(
        'ListStockItems',
        { clinicId: active.id, page: 1, pageSize: 8, ...override },
        token ?? (await clinicToken(active.id)),
      );

    it('ad A→Z, aynı adda SKT yakın olan önce, SKT’siz sonda sıralanır', async () => {
      const result = expectOk(await list(), 'ListStockItems');
      expect(
        result.items.map((item) => `${item.name}|${item.expiresAt || '-'}`),
      ).toEqual([
        'Amoksisilin|2027-01-01',
        'Amoksisilin|2027-03-01',
        'Amoksisilin|-',
        'Bandaj|-',
        `Kuduz Aşısı|${shiftDays(istanbulToday(), 60)}`,
      ]);
      expect(result.total).toBe(5);
    });

    it('kategori ve kritik seviye filtreleri çalışır', async () => {
      const medicine = expectOk(
        await list({ category: 'MEDICINE' }),
        'ListStockItems',
      );
      expect(medicine.total).toBe(3);
      expect(medicine.items.every((item) => item.category === 'MEDICINE')).toBe(
        true,
      );

      const below = expectOk(
        await list({ onlyBelowCritical: true }),
        'ListStockItems',
      );
      expect(below.items.map((item) => item.name)).toEqual([
        'Amoksisilin',
        'Kuduz Aşısı',
      ]);
    });

    it('ikinci sayfa boş döner, toplam korunur', async () => {
      const page2 = expectOk(await list({ page: 2 }), 'ListStockItems');
      expect(page2.items).toEqual([]);
      expect(page2.total).toBe(5);
    });

    it('başka kliniğin stoku ve pasif klinik reddedilir', async () => {
      expect(code(await list({ clinicId: passive.id }))).toBe(
        'PERMISSION_DENIED',
      );
      expect(
        code(
          await list({ clinicId: passive.id }, await clinicToken(passive.id)),
        ),
      ).toBe('PERMISSION_DENIED');
    });
  });

  // ---Amaç: rıza akışının gerçek clinics.GetClinic ile çalıştığını ve hayvan özetinin kısmi başarı kurallarını doğrulamak ---
  describe('GrantConsent ve GetClinicPetOverview', () => {
    let petId: string;
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const grant = async (clinicId: string, scopes: string[]) =>
      callGrpc<access.ConsentResponse>(
        accessClient,
        'GrantConsent',
        { clinicId, petId, scopes, expiresAt },
        await ownerToken(),
      );

    const overview = async (override: object = {}, token?: string) =>
      callClinics<clinics.GetClinicPetOverviewResponse>(
        'GetClinicPetOverview',
        { clinicId: active.id, petId, ...override },
        token ?? (await clinicToken(active.id)),
      );

    beforeAll(async () => {
      const created = expectOk(
        await callGrpc<pets.PetResponse>(
          petsClient,
          'CreatePet',
          {
            name: 'Boncuk',
            species: 'DOG',
            breed: 'KANGAL',
            sex: pets.PetSex.MALE,
            birthDate: '2022-05-10',
            isBirthDateEstimated: false,
            isNeutered: true,
            chipNumber: '',
            ownerUserId: owner.id,
          },
          await ownerToken(),
        ),
        'pets.CreatePet',
      );
      petId = created.pet?.id ?? '';
      data.trackPet(petId);
    });

    it('aktif kliniğe rıza verilir; pasif ve kayıtsız klinikte NOT_FOUND', async () => {
      const granted = expectOk(
        await grant(active.id, ['medical_read']),
        'GrantConsent',
      );
      expect(granted.status).toBe(access.ConsentStatus.ACTIVE);
      expect(code(await grant(passive.id, ['medical_read']))).toBe('NOT_FOUND');
      expect(code(await grant(unknownClinicId, ['medical_read']))).toBe(
        'NOT_FOUND',
      );
    });

    it('owner_contact_read yokken sahip bloğu boş; kayıt ve bekleyen taslak yok', async () => {
      const result = expectOk(await overview(), 'GetClinicPetOverview');
      expect(result.pet).toMatchObject({
        petId,
        name: 'Boncuk',
        ownerUserId: owner.id,
      });
      expect(result.owner).toBeNull();
      expect(result.recentRecords).toEqual([]);
      expect(result.pendingDraftReviewCount).toBe(0);
      expect(result.unavailableSources).toEqual([]);
    });

    it('owner_contact_read verilince sahibin adı ve telefonu gelir', async () => {
      expectOk(
        await grant(active.id, ['medical_read', 'owner_contact_read']),
        'GrantConsent',
      );
      const result = expectOk(await overview(), 'GetClinicPetOverview');
      expect(result.owner).toEqual({
        userId: owner.id,
        fullName: owner.fullName,
        phone: owner.phone,
      });
      expect(result.unavailableSources).toEqual([]);
    });

    it('rızası olmayan klinik, başka klinik adına istek ve olmayan hayvan reddedilir', async () => {
      expect(
        code(
          await overview(
            { clinicId: passive.id },
            await clinicToken(passive.id),
          ),
        ),
      ).toBe('NOT_FOUND');
      expect(code(await overview({ clinicId: passive.id }))).toBe(
        'PERMISSION_DENIED',
      );
      expect(code(await overview({ petId: randomUUID() }))).toBe('NOT_FOUND');
    });

    it('UploadPetResult medical_write rızası olmadan reddedilir, rızayla belgeyi kaydeder; sahiplik ve yol kuralları korunur', async () => {
      const upload = async (override: object = {}) =>
        callClinics<clinics.UploadPetResultResponse>(
          'UploadPetResult',
          {
            clinicId: active.id,
            petId,
            storagePath: `${randomUUID()}.pdf`,
            originalName: 'Kan Tahlili.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 2048,
            note: '',
            sha256: 'a'.repeat(64),
            ...override,
          },
          await clinicToken(active.id),
        );

      expect(outcome(await upload())).toBe('PERMISSION_DENIED/FORBIDDEN');
      expect(code(await upload({ clinicId: passive.id }))).toBe(
        'PERMISSION_DENIED',
      );
      expect(outcome(await upload({ storagePath: '../etc/passwd' }))).toBe(
        'INVALID_ARGUMENT/STORAGE_PATH_WRONG DATA FORMAT',
      );

      expectOk(
        await grant(active.id, [
          'medical_read',
          'owner_contact_read',
          'medical_write',
        ]),
        'GrantConsent',
      );
      const storagePath = `${randomUUID()}.pdf`;
      const uploaded = expectOk(
        await upload({ storagePath }),
        'UploadPetResult',
      );
      expect(uploaded.status).toBe('QUEUED');
      expect(Number.isNaN(Date.parse(uploaded.uploadedAt))).toBe(false);

      const { rows } = await (
        await data.db('medical_record')
      ).query(
        'SELECT clinic_id, pet_id, storage_path, status::text FROM documents WHERE id = $1',
        [uploaded.documentId],
      );
      expect(rows).toEqual([
        {
          clinic_id: active.id,
          pet_id: petId,
          storage_path: storagePath,
          status: 'QUEUED',
        },
      ]);
      expect(outcome(await upload({ storagePath }))).toBe(
        'ALREADY_EXISTS/CONFLICT',
      );
    });
  });

  // ---Amaç: klinik oluşturmanın klinik satırını ve giriş yapabilen ortak CLINIC hesabını birlikte açtığını, hatada geri aldığını doğrulamak ---
  describe('CreateClinic (iç RPC)', () => {
    it('klinik ve ortak hesap açılır; hesapla giriş yapan klinik kendi kaydını tam görür', async () => {
      const phone = uniqueLandlinePhone();
      const { request, result } = await createClinic({
        phone: `0${phone.slice(3)}`,
      });
      const clinic = expectOk(result, 'CreateClinic').clinic;
      expect(clinic).toMatchObject({
        name: request.name,
        taxNumber: request.taxNumber,
        phone,
        email: request.email,
        isActive: true,
      });

      const usersDb = await data.db('users');
      const { rows: accounts } = await usersDb.query(
        'SELECT id, role, email, full_name, tel_no, is_active FROM users WHERE clinic_id = $1',
        [clinic?.id],
      );
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        role: 'CLINIC',
        email: request.email,
        full_name: request.name,
        tel_no: phone,
        is_active: true,
      });

      const { login, jwt } = await loginAsClinic(request.email, PASSWORD);
      expect(outcome(login)).toBe('ok');
      const own = expectOk(
        await callClinics<clinics.ClinicResponse>(
          'GetClinic',
          { id: clinic?.id },
          jwt,
        ),
        'GetClinic (klinik hesabıyla)',
      );
      expect(own.clinic?.taxNumber).toBe(request.taxNumber);
    });

    it('klinik tablosundaki çakışmalar alan bazında bildirilir', async () => {
      const { request } = await createClinic();
      expect(
        outcome((await createClinic({ taxNumber: request.taxNumber })).result),
      ).toBe('ALREADY_EXISTS/TAX_NUMBER_ALREADY_EXISTS');
      expect(outcome((await createClinic({ email: request.email })).result)).toBe(
        'ALREADY_EXISTS/EMAIL_ALREADY_EXISTS',
      );
      expect(outcome((await createClinic({ phone: request.phone })).result)).toBe(
        'ALREADY_EXISTS/PHONE_ALREADY_EXISTS',
      );
    });

    it('e-posta veya telefon bir kullanıcıda kayıtlıysa hesap açılamaz ve klinik satırı geri alınır', async () => {
      const taken = await data.insertUser({ fullName: 'Kayıtlı Kişi' });

      const byEmail = await createClinic({ email: taken.email });
      expect(outcome(byEmail.result)).toBe(
        'ALREADY_EXISTS/EMAIL_ALREADY_EXISTS',
      );
      expect(await clinicRowCount(byEmail.request.taxNumber)).toBe(0);

      const byPhone = await createClinic({ phone: taken.phone });
      expect(outcome(byPhone.result)).toBe(
        'ALREADY_EXISTS/PHONE_ALREADY_EXISTS',
      );
      expect(await clinicRowCount(byPhone.request.taxNumber)).toBe(0);
    });

    it('kontrol hanesi tutmayan vergi numarası ve zayıf şifre DTO’da reddedilir', async () => {
      expect(
        outcome((await createClinic({ taxNumber: '4540536921' })).result),
      ).toBe('INVALID_ARGUMENT/TAX_NUMBER_NOT_VALID');
      expect(outcome((await createClinic({ password: 'abcdefgh' })).result)).toBe(
        'INVALID_ARGUMENT/PASSWORD_WEAK PASSWORD',
      );
    });
  });

  // ---Amaç: kliniğin kendini pasifleştirmesinde vergi numarasının anonimleştiğini, hesabın kapandığını, diğer verilerin korunduğunu doğrulamak ---
  describe('DeactivateClinic', () => {
    it('başka klinik, hasta sahibi ve kayıtsız klinik reddedilir', async () => {
      expect(
        outcome(
          await callClinics(
            'DeactivateClinic',
            { clinicId: active.id },
            await clinicToken(passive.id),
          ),
        ),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
      expect(
        code(
          await callClinics(
            'DeactivateClinic',
            { clinicId: active.id },
            await ownerToken(),
          ),
        ),
      ).toBe('PERMISSION_DENIED');
      expect(
        outcome(
          await callClinics(
            'DeactivateClinic',
            { clinicId: unknownClinicId },
            await clinicToken(unknownClinicId),
          ),
        ),
      ).toBe('NOT_FOUND/NOT_FOUND');
    });

    it('pasifleştirir: vergi no X+10 rakam olur, ad/e-posta/telefon ve stok korunur, hesap girişte ACCOUNT_DISABLED alır', async () => {
      const { request, result } = await createClinic();
      const clinicId = expectOk(result, 'CreateClinic').clinic?.id ?? '';
      const { jwt } = await loginAsClinic(request.email, PASSWORD);

      expectOk(
        await callClinics(
          'AddStockItem',
          {
            clinicId,
            name: 'Bandaj',
            category: 'SUPPLY',
            unit: 'PIECE',
            quantity: 4,
            criticalLevel: 1,
            expiresAt: '',
            purchasePrice: 1_250,
            salePrice: 2_000,
          },
          jwt,
        ),
        'AddStockItem',
      );

      const first = expectOk(
        await callClinics<clinics.ClinicResponse>(
          'DeactivateClinic',
          { clinicId },
          jwt,
        ),
        'DeactivateClinic',
      ).clinic;
      expect(first).toMatchObject({
        id: clinicId,
        name: request.name,
        email: request.email,
        isActive: false,
      });
      expect(first?.taxNumber).toMatch(/^X\d{10}$/);

      const clinicsDb = await data.db('clinics');
      const { rows: stock } = await clinicsDb.query(
        'SELECT count(*)::int AS n FROM stock_items WHERE clinic_id = $1',
        [clinicId],
      );
      expect(stock[0].n).toBe(1);

      const usersDb = await data.db('users');
      const { rows: accounts } = await usersDb.query(
        'SELECT is_active FROM users WHERE clinic_id = $1',
        [clinicId],
      );
      expect(accounts).toEqual([{ is_active: false }]);

      expect(outcome((await loginAsClinic(request.email, PASSWORD)).login)).toBe(
        'PERMISSION_DENIED/ACCOUNT_DISABLED',
      );

      const second = expectOk(
        await callClinics<clinics.ClinicResponse>(
          'DeactivateClinic',
          { clinicId },
          jwt,
        ),
        'DeactivateClinic (tekrar)',
      ).clinic;
      expect(second?.taxNumber).toBe(first?.taxNumber);

      expect(
        outcome(
          await callClinics(
            'AddStockItem',
            {
              clinicId,
              name: 'Bandaj',
              category: 'SUPPLY',
              unit: 'PIECE',
              quantity: 1,
              criticalLevel: 0,
              expiresAt: '',
              purchasePrice: 1_250,
              salePrice: 2_000,
            },
            jwt,
          ),
        ),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');

      const reopened = await createClinic({ taxNumber: request.taxNumber });
      expect(outcome(reopened.result)).toBe('ok');
    });
  });
});
