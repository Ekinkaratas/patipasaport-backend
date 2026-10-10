import { Client } from '@grpc/grpc-js';
import {
  callGrpc,
  DOCKER_GRPC_PORTS,
  expectOk,
  grpcClient,
  GrpcResult,
  JwtIssuer,
  RunningService,
  SeededClinic,
  startService,
  TestData,
} from '@libs/e2e-utils';
import { access, pets } from '@libs/proto';
import { randomUUID } from 'crypto';

const outcome = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : `${result.code}/${result.details}`;

const code = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : result.code;

const NOW = `(now() AT TIME ZONE 'UTC')`;
const SCOPE_COLUMNS = [
  'medical_read',
  'medical_write',
  'vaccination_read',
  'prescription_read',
  'chip_number_read',
  'owner_contact_read',
] as const;

const sleep = (ms: number) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const decodeJwtPayload = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

describe('access servisi (e2e)', () => {
  const data = new TestData();
  const OWNER = randomUUID();
  const NEW_OWNER = randomUUID();
  const OTHER_OWNER = randomUUID();
  const LIST_OWNER = randomUUID();
  const LONELY = randomUUID();
  const LIST_CLINIC = randomUUID();
  const CHECK_CLINIC = randomUUID();
  const UNKNOWN_CLINIC = randomUUID();
  const clinicUserIds = new Map<string, string>();

  let tokens: JwtIssuer;
  let service: RunningService;
  let accessClient: Client;
  let petsClient: Client;
  let activeClinic: SeededClinic;
  let passiveClinic: SeededClinic;
  let petA: pets.Pet;
  let petA2: pets.Pet;
  let petOther: pets.Pet;

  const ownerToken = (userId: string) =>
    tokens.jwtFor({ role: 'PET_OWNER', userId });

  const clinicToken = (clinicId: string) => {
    let userId = clinicUserIds.get(clinicId);
    if (!userId) {
      userId = randomUUID();
      clinicUserIds.set(clinicId, userId);
    }
    return tokens.jwtFor({ role: 'CLINIC', userId, clinicId });
  };

  const callAccess = <T>(method: string, request: object, token?: string) =>
    callGrpc<T>(accessClient, method, request, token);

  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  const createPet = async (ownerId: string, name: string) => {
    const created = expectOk(
      await callGrpc<pets.PetResponse>(
        petsClient,
        'CreatePet',
        {
          name,
          species: 'DOG',
          breed: 'KANGAL',
          sex: pets.PetSex.MALE,
          birthDate: '2022-05-10',
          isBirthDateEstimated: false,
          isNeutered: true,
          chipNumber: '',
          ownerUserId: ownerId,
        },
        await ownerToken(ownerId),
      ),
      'pets.CreatePet',
    ).pet as pets.Pet;
    data.trackPet(created.id);
    return created;
  };

  const consentEvents = async (consentId: string) => {
    const db = await data.db('access');
    const { rows } = await db.query<{ action: string; actor_id: string }>(
      'SELECT action::text, actor_id::text FROM consent_events WHERE consent_id = $1 ORDER BY created_at, id',
      [consentId],
    );
    return rows;
  };

  const seedConsent = async (row: {
    clinicId: string;
    petId?: string;
    ownerId: string;
    status: 'ACTIVE' | 'REVOKED';
    scopes: string[];
    expiresInHours: number;
    ageSeconds?: number;
  }): Promise<string> => {
    const id = randomUUID();
    const db = await data.db('access');
    const revokedAt = row.status === 'REVOKED' ? NOW : 'NULL';
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('app.actor_id', $1, true)`, [
        randomUUID(),
      ]);
      await db.query(
        `INSERT INTO consents (id, clinic_id, pet_id, pet_owner_id, ${SCOPE_COLUMNS.join(', ')}, status, expires_at, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 ${NOW} + ($12 || ' hours')::interval, ${revokedAt},
                 ${NOW} - ($13 || ' seconds')::interval)`,
        [
          id,
          row.clinicId,
          row.petId ?? randomUUID(),
          row.ownerId,
          ...SCOPE_COLUMNS.map((column) => row.scopes.includes(column)),
          row.status,
          String(row.expiresInHours),
          String(row.ageSeconds ?? 0),
        ],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
    return id;
  };

  beforeAll(async () => {
    [OWNER, NEW_OWNER, OTHER_OWNER, LIST_OWNER].forEach((id) =>
      data.trackUser(id),
    );
    [LIST_CLINIC, CHECK_CLINIC].forEach((id) => data.trackClinic(id));

    service = await startService('access');
    tokens = new JwtIssuer(service.port);
    accessClient = grpcClient('access', service.port);
    petsClient = grpcClient('pets', DOCKER_GRPC_PORTS.pets);

    activeClinic = await data.insertClinic();
    passiveClinic = await data.insertClinic({ isActive: false });
    petA = await createPet(OWNER, 'Boncuk');
    petA2 = await createPet(OWNER, 'Karabaş');
    petOther = await createPet(OTHER_OWNER, 'Pamuk');
  }, 120_000);

  afterAll(async () => {
    try {
      await data.cleanup();
    } finally {
      await data.close();
      [accessClient, petsClient].forEach((client) => client?.close());
      tokens?.close();
      await service?.stop();
    }
  });

  // ---Amaç: opaque token üretim, değişim, istemci tipi bağı, iptal ve süre dolumu davranışını doğrulamak ---
  describe('token yaşam döngüsü', () => {
    const createToken = (override: object = {}) =>
      callAccess<access.CreateTokenResponse>('CreateOpaqueToken', {
        userId: randomUUID(),
        role: 'CLINIC',
        clinicId: activeClinic.id,
        clientType: access.ClientType.WEB,
        ttlSeconds: 0,
        ...override,
      });

    it('CLINIC token’ı RS256 imzalı, 60 sn ömürlü, access tarafından verilmiş JWT’ye değişir', async () => {
      const userId = randomUUID();
      const created = expectOk(await createToken({ userId }), 'CreateOpaqueToken');
      expect(created.opaqueToken).not.toBe('');
      expect(created.expiresIn).toBeGreaterThan(0);

      const exchanged = expectOk(
        await callAccess<access.ExchangeTokenResponse>('ExchangeToken', {
          opaqueToken: created.opaqueToken,
          clientType: access.ClientType.WEB,
        }),
        'ExchangeToken',
      );
      expect(exchanged).toMatchObject({
        userId,
        role: 'CLINIC',
        clinicId: activeClinic.id,
        expiresIn: 60,
      });
      const header = JSON.parse(
        Buffer.from(exchanged.jwt.split('.')[0], 'base64url').toString('utf8'),
      );
      const payload = decodeJwtPayload(exchanged.jwt);
      expect(header.alg).toBe('RS256');
      expect(payload['iss']).toBe('access');
      expect(Number(payload['exp']) - Number(payload['iat'])).toBe(60);
      await callAccess('RevokeToken', { opaqueToken: created.opaqueToken });
    });

    it('kaldırılan VETERINARIAN rolüyle token üretilemez', async () => {
      expect(code(await createToken({ role: 'VETERINARIAN' }))).toBe(
        'INVALID_ARGUMENT',
      );
    });

    it('WEB token’ı MOBILE ile ve bilinmeyen token UNAUTHENTICATED/INVALID_TOKEN alır', async () => {
      const created = expectOk(await createToken(), 'CreateOpaqueToken');
      expect(
        outcome(
          await callAccess('ExchangeToken', {
            opaqueToken: created.opaqueToken,
            clientType: access.ClientType.MOBILE,
          }),
        ),
      ).toBe('UNAUTHENTICATED/INVALID_TOKEN');
      expect(
        outcome(
          await callAccess('ExchangeToken', {
            opaqueToken: 'uydurma-token',
            clientType: access.ClientType.WEB,
          }),
        ),
      ).toBe('UNAUTHENTICATED/INVALID_TOKEN');
      await callAccess('RevokeToken', { opaqueToken: created.opaqueToken });
    });

    it('iptal edilen token değiştirilemez; ikinci iptal revoked=false döner', async () => {
      const created = expectOk(await createToken(), 'CreateOpaqueToken');
      expect(
        expectOk(
          await callAccess<access.RevokeTokenResponse>('RevokeToken', {
            opaqueToken: created.opaqueToken,
          }),
          'RevokeToken',
        ),
      ).toEqual({ revoked: true });
      expect(
        outcome(
          await callAccess('ExchangeToken', {
            opaqueToken: created.opaqueToken,
            clientType: access.ClientType.WEB,
          }),
        ),
      ).toBe('UNAUTHENTICATED/INVALID_TOKEN');
      expect(
        expectOk(
          await callAccess<access.RevokeTokenResponse>('RevokeToken', {
            opaqueToken: created.opaqueToken,
          }),
          'RevokeToken',
        ),
      ).toEqual({ revoked: false });
    });

    it('süresi dolan token (ttl 1 sn) UNAUTHENTICATED alır', async () => {
      const created = expectOk(
        await createToken({ ttlSeconds: 1 }),
        'CreateOpaqueToken',
      );
      await sleep(1_500);
      expect(
        code(
          await callAccess('ExchangeToken', {
            opaqueToken: created.opaqueToken,
            clientType: access.ClientType.WEB,
          }),
        ),
      ).toBe('UNAUTHENTICATED');
    });
  });

  // ---Amaç: rıza vermenin klinik, hayvan sahipliği ve tarih kurallarını, veritabanı ve denetim izi kayıtlarını doğrulamak ---
  describe('GrantConsent', () => {
    let consentId: string;

    const grant = async (
      override: object = {},
      ownerId: string = OWNER,
    ) =>
      callAccess<access.ConsentResponse>(
        'GrantConsent',
        {
          clinicId: activeClinic.id,
          petId: petA.id,
          scopes: ['medical_read'],
          expiresAt: inDays(30),
          ...override,
        },
        await ownerToken(ownerId),
      );

    it('kayıtsız ve pasif klinik birebir aynı NOT_FOUND yanıtını alır', async () => {
      const unknown = await grant({ clinicId: UNKNOWN_CLINIC });
      const passive = await grant({ clinicId: passiveClinic.id });
      expect(code(unknown)).toBe('NOT_FOUND');
      expect(outcome(passive)).toBe(outcome(unknown));
    });

    it('olmayan hayvan ve başkasının hayvanı birebir aynı NOT_FOUND yanıtını alır (IDOR)', async () => {
      const missing = await grant({ petId: randomUUID() });
      const foreign = await grant({ petId: petOther.id });
      expect(code(missing)).toBe('NOT_FOUND');
      expect(outcome(foreign)).toBe(outcome(missing));
    });

    it('1 yıldan uzun, saat dilimsiz ve geçmiş bitiş tarihi reddedilir; reddedilenler veritabanına yazmaz', async () => {
      const tooFar = new Date();
      tooFar.setUTCFullYear(tooFar.getUTCFullYear() + 1);
      tooFar.setUTCDate(tooFar.getUTCDate() + 1);
      expect(code(await grant({ expiresAt: tooFar.toISOString() }))).toBe(
        'INVALID_ARGUMENT',
      );
      expect(code(await grant({ expiresAt: inDays(30).replace('Z', '') }))).toBe(
        'INVALID_ARGUMENT',
      );
      expect(code(await grant({ expiresAt: inDays(-1) }))).toBe(
        'INVALID_ARGUMENT',
      );
      const db = await data.db('access');
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM consents WHERE pet_id = $1',
        [petA.id],
      );
      expect(rows[0].n).toBe(0);
    });

    it('1 yıl − 1 gün, +00:00 ofsetli tarih kabul edilir ve UTC olarak döner', async () => {
      const almostYear = new Date();
      almostYear.setUTCFullYear(almostYear.getUTCFullYear() + 1);
      almostYear.setUTCDate(almostYear.getUTCDate() - 1);
      const granted = expectOk(
        await grant({
          petId: petA2.id,
          expiresAt: almostYear.toISOString().replace('Z', '+00:00'),
        }),
        'GrantConsent',
      );
      expect(granted.expiresAt).toBe(almostYear.toISOString());
    });

    it('rıza verilir; yalnızca istenen scope sütunları true olur, trigger GRANTED kaydını sahiple yazar', async () => {
      const granted = expectOk(
        await grant({ scopes: ['medical_read', 'vaccination_read'] }),
        'GrantConsent',
      );
      consentId = granted.consentId;
      expect(granted).toMatchObject({
        status: access.ConsentStatus.ACTIVE,
        scopes: ['medical_read', 'vaccination_read'],
        ownerUserId: OWNER,
        clinicId: activeClinic.id,
        petId: petA.id,
        revokedAt: '',
      });
      expect(Number.isNaN(Date.parse(granted.grantedAt))).toBe(false);

      const db = await data.db('access');
      const { rows } = await db.query(
        `SELECT ${SCOPE_COLUMNS.join(', ')}, pet_owner_id::text FROM consents WHERE id = $1`,
        [consentId],
      );
      expect(rows[0]).toEqual({
        medical_read: true,
        medical_write: false,
        vaccination_read: true,
        prescription_read: false,
        chip_number_read: false,
        owner_contact_read: false,
        pet_owner_id: OWNER,
      });
      expect(await consentEvents(consentId)).toEqual([
        { action: 'GRANTED', actor_id: OWNER },
      ]);
    });

    it('CLINIC rolü rıza veremez', async () => {
      const result = await callAccess(
        'GrantConsent',
        {
          clinicId: activeClinic.id,
          petId: petA.id,
          scopes: ['medical_read'],
          expiresAt: inDays(30),
        },
        await clinicToken(activeClinic.id),
      );
      expect(code(result)).toBe('PERMISSION_DENIED');
    });

    it('aynı klinik + hayvan için tekrar verme aynı satırı günceller, olay UPDATED', async () => {
      const again = expectOk(await grant(), 'GrantConsent');
      expect(again.consentId).toBe(consentId);
      expect(again.scopes).toEqual(['medical_read']);
      expect((await consentEvents(consentId)).map((event) => event.action)).toEqual(
        ['GRANTED', 'UPDATED'],
      );
    });

    it('hayvan el değiştirince yeni sahip satırı devralır, eski sahip rıza veremez ve listesinden çıkar', async () => {
      const petsDb = await data.db('pets');
      await petsDb.query('UPDATE pets SET owner_user_id = $1 WHERE id = $2', [
        NEW_OWNER,
        petA.id,
      ]);

      const takenOver = expectOk(await grant({}, NEW_OWNER), 'GrantConsent');
      expect(takenOver.consentId).toBe(consentId);
      expect(takenOver.ownerUserId).toBe(NEW_OWNER);
      expect(code(await grant({}, OWNER))).toBe('NOT_FOUND');

      const oldList = expectOk(
        await callAccess<access.ListMyConsentsResponse>(
          'ListMyConsents',
          { page: 1, pageSize: 8 },
          await ownerToken(OWNER),
        ),
        'ListMyConsents',
      );
      const newList = expectOk(
        await callAccess<access.ListMyConsentsResponse>(
          'ListMyConsents',
          { page: 1, pageSize: 8 },
          await ownerToken(NEW_OWNER),
        ),
        'ListMyConsents',
      );
      expect(oldList.consents.map((consent) => consent.consentId)).not.toContain(
        consentId,
      );
      expect(newList.total).toBe(1);
      expect(newList.consents[0].consentId).toBe(consentId);
    });

    it('GetConsentStatus yalnızca sahibe döner', async () => {
      const status = expectOk(
        await callAccess<access.ConsentResponse>(
          'GetConsentStatus',
          { clinicId: activeClinic.id, petId: petA.id },
          await ownerToken(NEW_OWNER),
        ),
        'GetConsentStatus',
      );
      expect(status).toMatchObject({
        consentId,
        status: access.ConsentStatus.ACTIVE,
      });
      expect(
        code(
          await callAccess(
            'GetConsentStatus',
            { clinicId: activeClinic.id, petId: petA.id },
            await ownerToken(OTHER_OWNER),
          ),
        ),
      ).toBe('NOT_FOUND');
    });

    it('RevokeConsent: eski sahip ve olmayan rıza NOT_FOUND; sahip iptal eder, CheckAccess REVOKED ile reddeder', async () => {
      expect(
        code(
          await callAccess(
            'RevokeConsent',
            { consentId },
            await ownerToken(OWNER),
          ),
        ),
      ).toBe('NOT_FOUND');
      expect(
        code(
          await callAccess(
            'RevokeConsent',
            { consentId: randomUUID() },
            await ownerToken(NEW_OWNER),
          ),
        ),
      ).toBe('NOT_FOUND');

      const revoked = expectOk(
        await callAccess<access.ConsentResponse>(
          'RevokeConsent',
          { consentId },
          await ownerToken(NEW_OWNER),
        ),
        'RevokeConsent',
      );
      expect(revoked.status).toBe(access.ConsentStatus.REVOKED);
      expect(Number.isNaN(Date.parse(revoked.revokedAt))).toBe(false);
      expect((await consentEvents(consentId)).pop()?.action).toBe('REVOKED');

      const check = expectOk(
        await callAccess<access.CheckAccessResponse>(
          'CheckAccess',
          {
            clinicId: activeClinic.id,
            petId: petA.id,
            requiredScopes: ['medical_read'],
          },
          await clinicToken(activeClinic.id),
        ),
        'CheckAccess',
      );
      expect(check.allowed).toBe(false);
      expect(check.deniedReason).toBe(access.DeniedReason.DENIED_REASON_REVOKED);
    });
  });

  // ---Amaç: rıza listesinin sayfalama, sıralama ve sahip/klinik görünürlük kurallarını doğrulamak ---
  describe('ListMyConsents', () => {
    let ownerConsentIds: string[];
    let clinicActiveIds: string[];

    beforeAll(async () => {
      ownerConsentIds = [];
      for (let i = 0; i < 20; i++) {
        ownerConsentIds.push(
          await seedConsent({
            clinicId: randomUUID(),
            ownerId: LIST_OWNER,
            status: 'ACTIVE',
            scopes: ['medical_read'],
            expiresInHours: 48,
            ageSeconds: i * 10,
          }),
        );
      }
      clinicActiveIds = [];
      for (let i = 0; i < 10; i++) {
        clinicActiveIds.push(
          await seedConsent({
            clinicId: LIST_CLINIC,
            ownerId: randomUUID(),
            status: 'ACTIVE',
            scopes: ['medical_read'],
            expiresInHours: 48,
            ageSeconds: i * 10,
          }),
        );
      }
      for (const [status, hours] of [
        ['REVOKED', 48],
        ['REVOKED', 48],
        ['ACTIVE', -1],
        ['ACTIVE', -1],
      ] as const) {
        await seedConsent({
          clinicId: LIST_CLINIC,
          ownerId: randomUUID(),
          status,
          scopes: ['medical_read'],
          expiresInHours: hours,
          ageSeconds: 5,
        });
      }
    });

    it('sahip: sayfalar 8/8/4/0, toplam 20, tekrar yok, en son güncellenen önde', async () => {
      const token = await ownerToken(LIST_OWNER);
      const pages: access.ListMyConsentsResponse[] = [];
      for (const page of [1, 2, 3, 4]) {
        pages.push(
          expectOk(
            await callAccess<access.ListMyConsentsResponse>(
              'ListMyConsents',
              { page, pageSize: 8 },
              token,
            ),
            'ListMyConsents',
          ),
        );
      }
      expect(pages.map((page) => page.consents.length)).toEqual([8, 8, 4, 0]);
      pages.forEach((page, index) => {
        expect(page).toMatchObject({ total: 20, page: index + 1, pageSize: 8 });
      });
      const ids = pages.flatMap((page) =>
        page.consents.map((consent) => consent.consentId),
      );
      expect(ids).toEqual(ownerConsentIds);
      expect(
        pages
          .flatMap((page) => page.consents)
          .every((consent) => consent.ownerUserId === LIST_OWNER),
      ).toBe(true);
    });

    it('klinik: yalnızca kendi aktif rızaları (10/14) ve ownerUserId boş', async () => {
      const list = expectOk(
        await callAccess<access.ListMyConsentsResponse>(
          'ListMyConsents',
          { page: 1, pageSize: 16 },
          await clinicToken(LIST_CLINIC),
        ),
        'ListMyConsents',
      );
      expect(list.total).toBe(10);
      expect(list.consents.map((consent) => consent.consentId).sort()).toEqual(
        [...clinicActiveIds].sort(),
      );
      for (const consent of list.consents) {
        expect(consent).toMatchObject({
          clinicId: LIST_CLINIC,
          status: access.ConsentStatus.ACTIVE,
          ownerUserId: '',
        });
      }
    });

    it('rızası olmayan kullanıcı boş liste alır', async () => {
      const list = expectOk(
        await callAccess<access.ListMyConsentsResponse>(
          'ListMyConsents',
          { page: 1, pageSize: 8 },
          await ownerToken(LONELY),
        ),
        'ListMyConsents',
      );
      expect(list.total).toBe(0);
      expect(list.consents).toEqual([]);
    });
  });

  // ---Amaç: alt servislerin kullandığı rıza kontrolünün tüm red nedenlerini, varlık sızdırmamayı ve salt okunur olduğunu doğrulamak ---
  describe('CheckAccess', () => {
    const PET_ACTIVE = randomUUID();
    const PET_REVOKED = randomUUID();
    const PET_EXPIRED = randomUUID();
    const seeded: Record<string, string> = {};

    const checkAccess = async (
      petId: string,
      requiredScopes: string[],
      override: { clinicId?: string; token?: string } = {},
    ) =>
      callAccess<access.CheckAccessResponse>(
        'CheckAccess',
        {
          clinicId: override.clinicId ?? CHECK_CLINIC,
          petId,
          requiredScopes,
        },
        override.token ?? (await clinicToken(CHECK_CLINIC)),
      );

    const eventCount = async () => {
      const db = await data.db('access');
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM consent_events WHERE consent_id = ANY($1::uuid[])',
        [Object.values(seeded)],
      );
      return rows[0].n;
    };

    beforeAll(async () => {
      seeded['active'] = await seedConsent({
        clinicId: CHECK_CLINIC,
        petId: PET_ACTIVE,
        ownerId: OWNER,
        status: 'ACTIVE',
        scopes: ['medical_read', 'vaccination_read'],
        expiresInHours: 24,
      });
      seeded['revoked'] = await seedConsent({
        clinicId: CHECK_CLINIC,
        petId: PET_REVOKED,
        ownerId: OWNER,
        status: 'REVOKED',
        scopes: ['medical_read'],
        expiresInHours: 24,
      });
      seeded['expired'] = await seedConsent({
        clinicId: CHECK_CLINIC,
        petId: PET_EXPIRED,
        ownerId: OWNER,
        status: 'ACTIVE',
        scopes: ['medical_read'],
        expiresInHours: -1,
      });
    });

    it('aktif rıza ve tüm scope’lar: izin, rızayı veren sahip döner', async () => {
      const result = expectOk(
        await checkAccess(PET_ACTIVE, ['medical_read', 'vaccination_read']),
        'CheckAccess',
      );
      expect(result).toMatchObject({
        allowed: true,
        status: access.ConsentStatus.ACTIVE,
        grantedScopes: ['medical_read', 'vaccination_read'],
        missingScopes: [],
        deniedReason: access.DeniedReason.DENIED_REASON_UNSPECIFIED,
        consentId: seeded['active'],
        petOwnerId: OWNER,
      });
    });

    it('bir scope eksikse INSUFFICIENT_SCOPE', async () => {
      const result = expectOk(
        await checkAccess(PET_ACTIVE, ['medical_read', 'medical_write']),
        'CheckAccess',
      );
      expect(result).toMatchObject({
        allowed: false,
        grantedScopes: ['medical_read'],
        missingScopes: ['medical_write'],
        deniedReason: access.DeniedReason.DENIED_REASON_INSUFFICIENT_SCOPE,
      });
    });

    it('iptal edilmiş rıza REVOKED, süresi dolmuş rıza EXPIRED', async () => {
      expect(
        expectOk(await checkAccess(PET_REVOKED, ['medical_read']), 'CheckAccess'),
      ).toMatchObject({
        allowed: false,
        status: access.ConsentStatus.REVOKED,
        deniedReason: access.DeniedReason.DENIED_REASON_REVOKED,
      });
      expect(
        expectOk(await checkAccess(PET_EXPIRED, ['medical_read']), 'CheckAccess'),
      ).toMatchObject({
        allowed: false,
        status: access.ConsentStatus.EXPIRED,
        deniedReason: access.DeniedReason.DENIED_REASON_EXPIRED,
      });
    });

    it('rıza yoksa NO_CONSENT, sahip boş', async () => {
      expect(
        expectOk(await checkAccess(randomUUID(), ['medical_read']), 'CheckAccess'),
      ).toMatchObject({
        allowed: false,
        status: access.ConsentStatus.NOT_FOUND,
        consentId: '',
        petOwnerId: '',
        deniedReason: access.DeniedReason.DENIED_REASON_NO_CONSENT,
      });
    });

    it('başka kliniğin var olan ve olmayan rızası birebir aynı PERMISSION_DENIED yanıtını alır', async () => {
      const otherClinic = randomUUID();
      const existing = await checkAccess(PET_ACTIVE, ['medical_read'], {
        clinicId: otherClinic,
      });
      const missing = await checkAccess(randomUUID(), ['medical_read'], {
        clinicId: otherClinic,
      });
      expect(code(existing)).toBe('PERMISSION_DENIED');
      expect(outcome(missing)).toBe(outcome(existing));
    });

    it('rol, token ve istek doğrulaması', async () => {
      expect(
        code(
          await checkAccess(PET_ACTIVE, ['medical_read'], {
            token: await ownerToken(OWNER),
          }),
        ),
      ).toBe('PERMISSION_DENIED');
      expect(
        code(
          await callAccess('CheckAccess', {
            clinicId: CHECK_CLINIC,
            petId: PET_ACTIVE,
            requiredScopes: ['medical_read'],
          }),
        ),
      ).toBe('UNAUTHENTICATED');
      expect(code(await checkAccess(PET_ACTIVE, ['bilinmeyen_scope']))).toBe(
        'INVALID_ARGUMENT',
      );
      expect(code(await checkAccess(PET_ACTIVE, []))).toBe('INVALID_ARGUMENT');
      expect(
        code(
          await checkAccess(PET_ACTIVE, ['medical_read'], { clinicId: 'abc' }),
        ),
      ).toBe('INVALID_ARGUMENT');
    });

    it('CheckAccess denetim izine hiç kayıt yazmaz', async () => {
      const before = await eventCount();
      await checkAccess(PET_ACTIVE, ['medical_read']);
      await checkAccess(PET_REVOKED, ['medical_read']);
      expect(await eventCount()).toBe(before);
    });
  });
});
