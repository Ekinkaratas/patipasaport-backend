import { Client } from '@grpc/grpc-js';
import {
  callGrpc,
  DOCKER_GRPC_PORTS,
  expectOk,
  grpcClient,
  GrpcResult,
  JwtIssuer,
  randomDigits,
  RunningService,
  startService,
  TestData,
} from '@libs/e2e-utils';
import { access, pets } from '@libs/proto';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

const outcome = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : `${result.code}/${result.details}`;

const code = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : result.code;

const newChip = (): string => `900${randomDigits(12)}`;

interface PetRow {
  name: string;
  breed: string;
  birth_date: string | null;
  is_neutered: boolean;
  chip_no_encrypted: string | null;
  chip_no_index: string | null;
  chip_no_last4: string | null;
}

describe('pets servisi (e2e)', () => {
  const data = new TestData();
  const tokens = new JwtIssuer();
  const OWNER_A = randomUUID();
  const OWNER_B = randomUUID();
  const CLINIC_X = randomUUID();
  const CLINIC_Y = randomUUID();
  const CLINIC_Z = randomUUID();
  const CHIP1 = newChip();
  const CHIP2 = newChip();
  const CHIP3 = newChip();
  const CHIP4 = newChip();
  const CHIP5 = newChip();

  let service: RunningService;
  let petsClient: Client;
  let accessClient: Client;
  let p1: pets.Pet;
  let p2: pets.Pet;
  let p3: pets.Pet;
  let p4: pets.Pet;

  const ownerToken = (ownerId: string) =>
    tokens.jwtFor({ role: 'PET_OWNER', userId: ownerId });

  const clinicUserIds = new Map<string, string>();

  const clinicToken = (clinicId: string) => {
    let userId = clinicUserIds.get(clinicId);
    if (!userId) {
      userId = randomUUID();
      clinicUserIds.set(clinicId, userId);
    }
    return tokens.jwtFor({ role: 'CLINIC', userId, clinicId });
  };

  const callPets = <T>(method: string, request: object, token?: string) =>
    callGrpc<T>(petsClient, method, request, token);

  const basePet = {
    name: 'Boncuk',
    species: 'DOG',
    breed: 'KANGAL',
    sex: pets.PetSex.MALE,
    birthDate: '2022-05-10',
    isBirthDateEstimated: false,
    isNeutered: true,
    chipNumber: CHIP1,
    ownerUserId: OWNER_A,
  };

  const createPet = async (override: object = {}, token?: string) => {
    const result = await callPets<pets.PetResponse>(
      'CreatePet',
      { ...basePet, ...override },
      token ?? (await ownerToken(OWNER_A)),
    );
    if (result.ok && result.value.pet) {
      data.trackPet(result.value.pet.id);
    }
    return result;
  };

  const updatePet = (request: object, token: string) =>
    callPets<pets.PetResponse>('UpdatePet', request, token);

  const petRow = async (id: string): Promise<PetRow> => {
    const db = await data.db('pets');
    const { rows } = await db.query<PetRow>(
      'SELECT name, breed, birth_date::text AS birth_date, is_neutered, chip_no_encrypted, chip_no_index, chip_no_last4 FROM pets WHERE id = $1',
      [id],
    );
    return rows[0];
  };

  const seedConsent = async (
    clinicId: string,
    petId: string,
    scopes: { medical_read?: boolean; chip_number_read?: boolean },
  ) => {
    const db = await data.db('access');
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('app.actor_id', $1, true)`, [
        randomUUID(),
      ]);
      await db.query(
        `INSERT INTO consents (id, clinic_id, pet_id, pet_owner_id, medical_read, chip_number_read, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, (now() AT TIME ZONE 'UTC') + interval '1 day', now() AT TIME ZONE 'UTC')`,
        [
          randomUUID(),
          clinicId,
          petId,
          OWNER_A,
          scopes.medical_read ?? false,
          scopes.chip_number_read ?? false,
        ],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  };

  beforeAll(async () => {
    data.trackUser(OWNER_A);
    data.trackUser(OWNER_B);
    service = await startService('pets');
    petsClient = grpcClient('pets', service.port);
    accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);
  }, 120_000);

  afterAll(async () => {
    try {
      await data.cleanup();
    } finally {
      await data.close();
      [petsClient, accessClient].forEach((client) => client?.close());
      tokens.close();
      await service?.stop();
    }
  });

  // ---Amaç: hayvan kaydının çipi şifreleyerek sakladığını ve sahiplik/rol kurallarını doğrulamak ---
  describe('CreatePet', () => {
    it('kaydı oluşturur; çip şifreli, indeks 64 hex, son 4 hane saklanır, sahibe tam çip döner', async () => {
      p1 = expectOk(await createPet(), 'CreatePet').pet as pets.Pet;
      expect(p1).toMatchObject({
        ownerUserId: OWNER_A,
        birthDate: '2022-05-10',
        chipNumber: CHIP1,
      });
      const row = await petRow(p1.id);
      expect(row.chip_no_encrypted?.startsWith('v1.')).toBe(true);
      expect(row.chip_no_encrypted).not.toContain(CHIP1);
      expect(row.chip_no_index).toMatch(/^[0-9a-f]{64}$/);
      expect(row.chip_no_last4).toBe(CHIP1.slice(-4));
    });

    it('aynı çip ikinci kez ALREADY_EXISTS/CONFLICT alır', async () => {
      expect(outcome(await createPet({ name: 'Kopya' }))).toBe(
        'ALREADY_EXISTS/CONFLICT',
      );
    });

    it('başka sahip adına kayıt ve CLINIC rolü reddedilir', async () => {
      expect(
        code(
          await createPet({
            name: 'Baskasi',
            chipNumber: newChip(),
            ownerUserId: OWNER_B,
          }),
        ),
      ).toBe('PERMISSION_DENIED');
      expect(
        code(
          await createPet({ chipNumber: '' }, await clinicToken(CLINIC_X)),
        ),
      ).toBe('PERMISSION_DENIED');
    });

    it('çipsiz ve doğum tarihsiz kayıt yapılır', async () => {
      p2 = expectOk(
        await createPet({
          name: 'Işık',
          species: 'CAT',
          breed: 'MIXED',
          sex: pets.PetSex.FEMALE,
          chipNumber: '',
          birthDate: '',
        }),
        'CreatePet',
      ).pet as pets.Pet;
      expect(p2.chipNumberMasked).toBe('');
      expect(p2.birthDate).toBe('');

      p3 = expectOk(
        await createPet(
          {
            name: 'İnci',
            species: 'BIRD',
            breed: 'CANARY',
            sex: pets.PetSex.FEMALE,
            chipNumber: CHIP2,
            ownerUserId: OWNER_B,
          },
          await ownerToken(OWNER_B),
        ),
        'CreatePet',
      ).pet as pets.Pet;
      p4 = expectOk(
        await createPet({
          name: 'Pamuk',
          species: 'CAT',
          breed: 'TURKISH_VAN',
          sex: pets.PetSex.FEMALE,
          chipNumber: '',
        }),
        'CreatePet',
      ).pet as pets.Pet;

      await seedConsent(CLINIC_X, p1.id, { chip_number_read: true });
      await seedConsent(CLINIC_X, p2.id, { medical_read: true });
      await seedConsent(CLINIC_X, p3.id, { medical_read: true });
      await seedConsent(CLINIC_Y, p3.id, { medical_read: true });
    });
  });

  // ---Amaç: hayvan detayının sahibe ve rıza kapsamına göre kliniğe nasıl gösterildiğini doğrulamak ---
  describe('GetPet', () => {
    it('sahip kendi hayvanını tam çiple görür, başka sahip NOT_FOUND alır', async () => {
      const own = expectOk(
        await callPets<pets.PetResponse>(
          'GetPet',
          { id: p1.id },
          await ownerToken(OWNER_A),
        ),
        'GetPet',
      );
      expect(own.pet?.chipNumber).toBe(CHIP1);
      expect(
        code(
          await callPets('GetPet', { id: p1.id }, await ownerToken(OWNER_B)),
        ),
      ).toBe('NOT_FOUND');
    });

    it('chip_number_read rızalı klinik tam çipi, yalnız medical_read rızalı klinik maskeyi görür', async () => {
      const token = await clinicToken(CLINIC_X);
      const full = expectOk(
        await callPets<pets.PetResponse>('GetPet', { id: p1.id }, token),
        'GetPet',
      );
      expect(full.pet?.chipNumber).toBe(CHIP1);
      const masked = expectOk(
        await callPets<pets.PetResponse>('GetPet', { id: p3.id }, token),
        'GetPet',
      );
      expect(masked.pet?.chipNumber).toBe('');
      expect(masked.pet?.chipNumberMasked).toBe(`****${CHIP2.slice(-4)}`);
    });

    it('rızasız klinik NOT_FOUND alır', async () => {
      expect(
        code(
          await callPets('GetPet', { id: p1.id }, await clinicToken(CLINIC_Y)),
        ),
      ).toBe('NOT_FOUND');
    });
  });

  // ---Amaç: klinik aramasının yalnızca rızalı hayvanları döndürdüğünü, filtre, Türkçe arama, sıralama ve sayfalamayı doğrulamak ---
  describe('SearchClinicPets', () => {
    const search = async (override: object = {}, clinicId = CLINIC_X) =>
      callPets<pets.SearchClinicPetsResponse>(
        'SearchClinicPets',
        { page: 1, pageSize: 8, ...override },
        await clinicToken(clinicId),
      );

    it('boş arama yalnızca rızalı 3 hayvanı döner; özet kartta sahip ve çip yoktur', async () => {
      const result = expectOk(await search(), 'SearchClinicPets');
      expect(result.total).toBe(3);
      expect(result.pets.map((pet) => pet.id).sort()).toEqual(
        [p1.id, p2.id, p3.id].sort(),
      );
      for (const pet of result.pets) {
        expect(pet).not.toHaveProperty('ownerUserId');
        expect(pet).not.toHaveProperty('chipNumber');
      }
    });

    it('çip ile arama yalnızca rızası olan klinikte sonuç verir', async () => {
      const found = expectOk(
        await search({ chipNumber: CHIP1 }),
        'SearchClinicPets',
      );
      expect(found.total).toBe(1);
      expect(found.pets[0].id).toBe(p1.id);
      expect(
        expectOk(await search({ chipNumber: CHIP1 }, CLINIC_Y), 'Search').total,
      ).toBe(0);
      expect(expectOk(await search({}, CLINIC_Z), 'Search').total).toBe(0);
    });

    it('ad araması kısmi, harf duyarsız ve Türkçe karakterlere uygundur', async () => {
      expect(expectOk(await search({ name: 'bon' }), 'Search').total).toBe(1);
      for (const name of ['ışık', 'IŞIK', 'Işık', 'inci', 'İNCİ', 'İnci']) {
        expect(expectOk(await search({ name }), `Search ${name}`).total).toBe(1);
      }
    });

    it('tür filtresi, sıralama yönü ve sayfalama çalışır', async () => {
      const cats = expectOk(await search({ species: 'CAT' }), 'Search');
      expect(cats.total).toBe(1);
      expect(cats.pets[0].id).toBe(p2.id);

      const asc = expectOk(await search({ orderFilter: 'asc' }), 'Search');
      const desc = expectOk(await search({ orderFilter: 'desc' }), 'Search');
      expect(asc.pets.map((pet) => pet.id)).toEqual(
        [...desc.pets.map((pet) => pet.id)].reverse(),
      );

      const page2 = expectOk(await search({ page: 2 }), 'Search');
      expect(page2.pets).toEqual([]);
      expect(page2.total).toBe(3);
    });

    it('PET_OWNER rolü arama yapamaz', async () => {
      expect(
        code(
          await callPets(
            'SearchClinicPets',
            { page: 1, pageSize: 8 },
            await ownerToken(OWNER_A),
          ),
        ),
      ).toBe('PERMISSION_DENIED');
    });
  });

  // ---Amaç: sahibin hayvan listesini, sahiplik sorgusunu ve access'in pets'e bağlanan uçlarını doğrulamak ---
  describe('ListMyPets / GetPetOwner', () => {
    it('sahip yalnızca kendi hayvanlarını en yeniden eskiye görür; CLINIC çağıramaz', async () => {
      const mine = expectOk(
        await callPets<pets.ListMyPetsResponse>(
          'ListMyPets',
          {},
          await ownerToken(OWNER_A),
        ),
        'ListMyPets',
      );
      expect(mine.pets.map((pet) => pet.name)).toEqual([
        'Pamuk',
        'Işık',
        'Boncuk',
      ]);
      expect(mine.pets.every((pet) => pet.ownerUserId === OWNER_A)).toBe(true);
      expect(
        code(await callPets('ListMyPets', {}, await clinicToken(CLINIC_X))),
      ).toBe('PERMISSION_DENIED');
    });

    it('GetPetOwner sahibe döner, başkasına NOT_FOUND', async () => {
      const owner = expectOk(
        await callPets<pets.GetPetOwnerResponse>(
          'GetPetOwner',
          { petId: p1.id },
          await ownerToken(OWNER_A),
        ),
        'GetPetOwner',
      );
      expect(owner.ownerUserId).toBe(OWNER_A);
      expect(
        code(
          await callPets(
            'GetPetOwner',
            { petId: p1.id },
            await ownerToken(OWNER_B),
          ),
        ),
      ).toBe('NOT_FOUND');
    });

    it('access, pets üzerinden rıza durumunu okur', async () => {
      const consent = expectOk(
        await callGrpc<access.ConsentResponse>(
          accessClient,
          'GetConsentStatus',
          { clinicId: CLINIC_X, petId: p1.id },
          await ownerToken(OWNER_A),
        ),
        'access.GetConsentStatus',
      );
      expect(consent.status).toBe(access.ConsentStatus.ACTIVE);
    });
  });

  // ---Amaç: sahibin güncelleme yolunu (ad, tarih, çip, cins-tür uyumu, tahmini tarih) ve yetki sınırlarını doğrulamak ---
  describe('UpdatePet — sahip', () => {
    it('ad ve doğum tarihi güncellenir', async () => {
      const token = await ownerToken(OWNER_A);
      expectOk(await updatePet({ id: p1.id, name: 'Boncuk Yeni' }, token), 'Update');
      expect((await petRow(p1.id)).name).toBe('Boncuk Yeni');
      expectOk(await updatePet({ id: p1.id, birthDate: '2021-03-04' }, token), 'Update');
      expect((await petRow(p1.id)).birth_date).toBe('2021-03-04');
    });

    it('sahip çip ekler; çip şifreli saklanır, cevapta tam döner', async () => {
      const updated = expectOk(
        await updatePet({ id: p4.id, chipNumber: CHIP3 }, await ownerToken(OWNER_A)),
        'Update',
      );
      expect(updated.pet?.chipNumber).toBe(CHIP3);
      const row = await petRow(p4.id);
      expect(row.chip_no_encrypted?.startsWith('v1.')).toBe(true);
      expect(row.chip_no_encrypted).not.toContain(CHIP3);
      expect(row.chip_no_last4).toBe(CHIP3.slice(-4));
    });

    it('başkasının hayvanı ve olmayan hayvan NOT_FOUND; veri değişmez', async () => {
      const token = await ownerToken(OWNER_A);
      expect(code(await updatePet({ id: p3.id, name: 'Calindi' }, token))).toBe(
        'NOT_FOUND',
      );
      expect((await petRow(p3.id)).name).toBe('İnci');
      expect(
        code(await updatePet({ id: randomUUID(), name: 'Yok' }, token)),
      ).toBe('NOT_FOUND');
    });

    it('başka hayvanın çipi ALREADY_EXISTS/CONFLICT alır, kayıt değişmez', async () => {
      const before = (await petRow(p4.id)).chip_no_index;
      expect(
        outcome(
          await updatePet({ id: p4.id, chipNumber: CHIP2 }, await ownerToken(OWNER_A)),
        ),
      ).toBe('ALREADY_EXISTS/CONFLICT');
      expect((await petRow(p4.id)).chip_no_index).toBe(before);
    });

    it('cins türe uymalı; tahmini tarih için tarih gerekir; isNeutered=false uygulanır', async () => {
      const token = await ownerToken(OWNER_A);
      expect(outcome(await updatePet({ id: p1.id, breed: 'SIAMESE' }, token))).toBe(
        'INVALID_ARGUMENT/BREED_NOT_VALID',
      );
      expect((await petRow(p1.id)).breed).toBe('KANGAL');
      expect(
        expectOk(
          await updatePet({ id: p1.id, breed: 'GERMAN_SHEPHERD' }, token),
          'Update',
        ).pet?.breed,
      ).toBe('GERMAN_SHEPHERD');
      expect(
        outcome(await updatePet({ id: p2.id, isBirthDateEstimated: true }, token)),
      ).toBe('INVALID_ARGUMENT/BIRTH_DATE_NOT_EMPTY');
      expect(
        expectOk(
          await updatePet(
            { id: p2.id, isBirthDateEstimated: true, birthDate: '2023-01-01' },
            token,
          ),
          'Update',
        ).pet?.isBirthDateEstimated,
      ).toBe(true);
      expectOk(await updatePet({ id: p1.id, isNeutered: false }, token), 'Update');
      expect((await petRow(p1.id)).is_neutered).toBe(false);
    });
  });

  // ---Amaç: kliniğin yalnızca chip_number_read rızasıyla ve yalnızca çipi değiştirebildiğini doğrulamak ---
  describe('UpdatePet — klinik', () => {
    it('chip_number_read rızalı klinik çipi düzeltir', async () => {
      const updated = expectOk(
        await updatePet({ id: p1.id, chipNumber: CHIP4 }, await clinicToken(CLINIC_X)),
        'Update',
      );
      expect(updated.pet?.chipNumber).toBe(CHIP4);
      expect((await petRow(p1.id)).chip_no_last4).toBe(CHIP4.slice(-4));
    });

    it('yetersiz rıza, rızasız klinik ve olmayan hayvan PERMISSION_DENIED alır; veri değişmez', async () => {
      const before3 = (await petRow(p3.id)).chip_no_index;
      expect(
        code(
          await updatePet({ id: p3.id, chipNumber: CHIP5 }, await clinicToken(CLINIC_X)),
        ),
      ).toBe('PERMISSION_DENIED');
      expect((await petRow(p3.id)).chip_no_index).toBe(before3);

      const before4 = (await petRow(p4.id)).chip_no_index;
      for (const clinicId of [CLINIC_Y, CLINIC_Z]) {
        expect(
          code(
            await updatePet({ id: p4.id, chipNumber: CHIP5 }, await clinicToken(clinicId)),
          ),
        ).toBe('PERMISSION_DENIED');
      }
      expect((await petRow(p4.id)).chip_no_index).toBe(before4);
      expect(
        code(
          await updatePet(
            { id: randomUUID(), chipNumber: CHIP5 },
            await clinicToken(CLINIC_X),
          ),
        ),
      ).toBe('PERMISSION_DENIED');
    });

    it('klinik ad değiştiremez; başka hayvanın çipi ALREADY_EXISTS/CONFLICT alır', async () => {
      const token = await clinicToken(CLINIC_X);
      expect(code(await updatePet({ id: p1.id, name: 'Klinik' }, token))).toBe(
        'PERMISSION_DENIED',
      );
      expect(outcome(await updatePet({ id: p1.id, chipNumber: CHIP2 }, token))).toBe(
        'ALREADY_EXISTS/CONFLICT',
      );
      expect((await petRow(p1.id)).chip_no_last4).toBe(CHIP4.slice(-4));
    });
  });

  // ---Amaç: tek bir bozuk çip kaydının listeyi düşürmediğini ve loga çip değeri yazılmadığını doğrulamak ---
  describe('bozuk çip kaydı', () => {
    it('ListMyPets ve GetPet düşmez; bozuk kayıtta çip boş, maske korunur; log çip değeri içermez', async () => {
      const db = await data.db('pets');
      await db.query(
        `UPDATE pets SET chip_no_encrypted = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = $1`,
        [p1.id],
      );
      const token = await ownerToken(OWNER_A);
      const list = expectOk(
        await callPets<pets.ListMyPetsResponse>('ListMyPets', {}, token),
        'ListMyPets',
      );
      const broken = list.pets.find((pet) => pet.id === p1.id);
      const healthy = list.pets.find((pet) => pet.id === p4.id);
      expect(broken?.chipNumber).toBe('');
      expect(broken?.chipNumberMasked).toBe(`****${CHIP4.slice(-4)}`);
      expect(healthy?.chipNumber).toBe(CHIP3);

      const single = expectOk(
        await callPets<pets.PetResponse>('GetPet', { id: p1.id }, token),
        'GetPet',
      );
      expect(single.pet?.chipNumber).toBe('');

      const log = readFileSync(service.logFile, 'utf8');
      expect(log).toContain(`çip numarası çözülemedi (petId=${p1.id})`);
      expect(log).not.toContain(CHIP1);
      expect(log).not.toContain(CHIP4);
    });
  });
});
