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
  SeededUser,
  startService,
  TestData,
  uniqueEmail,
  uniqueLandlinePhone,
  uniqueMobilePhone,
} from '@libs/e2e-utils';
import { access, pets, users } from '@libs/proto';
import { randomUUID } from 'crypto';

const outcome = (result: GrpcResult<unknown>): string =>
  result.ok ? 'ok' : `${result.code}/${result.details}`;

describe('users servisi (e2e)', () => {
  const data = new TestData();
  const tokens = new JwtIssuer();
  const clinicUserIds = new Map<string, string>();

  let service: RunningService;
  let usersClient: Client;
  let petsClient: Client;
  let accessClient: Client;
  let clinic: SeededClinic;
  let otherClinic: SeededClinic;
  let owner: SeededUser;
  let otherUser: SeededUser;
  let petId: string;

  const ownerToken = (user: SeededUser = owner) =>
    tokens.jwtFor({ role: 'PET_OWNER', userId: user.id });

  const clinicToken = (clinicId: string) => {
    let userId = clinicUserIds.get(clinicId);
    if (!userId) {
      userId = randomUUID();
      clinicUserIds.set(clinicId, userId);
    }
    return tokens.jwtFor({ role: 'CLINIC', userId, clinicId });
  };

  const callUsers = <T>(method: string, request: object, token?: string) =>
    callGrpc<T>(usersClient, method, request, token);

  beforeAll(async () => {
    service = await startService('users');
    usersClient = grpcClient('users', service.port);
    petsClient = grpcClient('pets', DOCKER_GRPC_PORTS.pets);
    accessClient = grpcClient('access', DOCKER_GRPC_PORTS.access);

    clinic = await data.insertClinic();
    otherClinic = await data.insertClinic();
    owner = await data.insertUser({ fullName: 'Ayşe Yılmaz' });
    otherUser = await data.insertUser({ fullName: 'Mehmet Demir' });

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
  }, 120_000);

  afterAll(async () => {
    try {
      await data.cleanup();
    } finally {
      await data.close();
      [usersClient, petsClient, accessClient].forEach((client) =>
        client?.close(),
      );
      tokens.close();
      await service?.stop();
    }
  });

  // ---Amaç: kullanıcının kendi profilini okuyup güncelleyebildiğini ve rol/kimlik kurallarını doğrulamak ---
  describe('GetMe / UpdateMe', () => {
    it('PET_OWNER kendi profilini alır', async () => {
      const me = expectOk(
        await callUsers<users.GetMeResponse>('GetMe', {}, await ownerToken()),
        'GetMe',
      );
      expect(me).toMatchObject({
        userId: owner.id,
        email: owner.email,
        fullName: owner.fullName,
        phone: owner.phone,
        role: users.UserRole.PET_OWNER,
        clinicId: '',
        isActive: true,
      });
    });

    it('CLINIC rolü GetMe çağıramaz', async () => {
      const result = await callUsers('GetMe', {}, await clinicToken(clinic.id));
      expect(result.ok ? 'ok' : result.code).toBe('PERMISSION_DENIED');
    });

    it('token olmadan UNAUTHENTICATED', async () => {
      const result = await callUsers('GetMe', {});
      expect(result.ok ? 'ok' : result.code).toBe('UNAUTHENTICATED');
    });

    it('UpdateMe adı tek boşluğa indirip günceller, telefonu E.164 biçimine çevirir', async () => {
      const phone = uniqueMobilePhone();
      const updated = expectOk(
        await callUsers<users.UserResponse>(
          'UpdateMe',
          { fullName: '  Ayşe   Kaya ', phone: `0${phone.slice(3)}` },
          await ownerToken(),
        ),
        'UpdateMe',
      );
      expect(updated.user).toMatchObject({ fullName: 'Ayşe Kaya', phone });
      owner = { ...owner, fullName: 'Ayşe Kaya', phone };
    });

    it('UpdateMe başka kullanıcının telefonuyla ALREADY_EXISTS/CONFLICT', async () => {
      const result = await callUsers(
        'UpdateMe',
        { phone: otherUser.phone },
        await ownerToken(),
      );
      expect(outcome(result)).toBe('ALREADY_EXISTS/CONFLICT');
    });

    it('UpdateMe boş gövdeyle INVALID_ARGUMENT/BAD_REQUEST', async () => {
      const result = await callUsers('UpdateMe', {}, await ownerToken());
      expect(outcome(result)).toBe('INVALID_ARGUMENT/BAD_REQUEST');
    });
  });

  // ---Amaç: diğer servislerin kullandığı rol, görünen ad ve giriş bilgisi uçlarını doğrulamak ---
  describe('GetUserRole / GetUserDisplayNames / GetUserAuthInfo', () => {
    it('GetUserRole kullanıcının rolünü döner, olmayan kullanıcıda NOT_FOUND', async () => {
      const token = await clinicToken(clinic.id);
      const role = expectOk(
        await callUsers<users.GetUserRoleResponse>(
          'GetUserRole',
          { userId: owner.id },
          token,
        ),
        'GetUserRole',
      );
      expect(role).toEqual({
        userId: owner.id,
        role: users.UserRole.PET_OWNER,
        clinicId: '',
      });
      expect(
        outcome(await callUsers('GetUserRole', { userId: randomUUID() }, token)),
      ).toBe('NOT_FOUND/NOT_FOUND');
    });

    it('GetUserDisplayNames bulunanların adını, bulunamayanların id’sini döner', async () => {
      const missing = randomUUID();
      const names = expectOk(
        await callUsers<users.GetUserDisplayNamesResponse>(
          'GetUserDisplayNames',
          { userIds: [otherUser.id, missing] },
          await clinicToken(clinic.id),
        ),
        'GetUserDisplayNames',
      );
      expect(names.users).toEqual([
        {
          userId: otherUser.id,
          fullName: otherUser.fullName,
          role: users.UserRole.PET_OWNER,
        },
      ]);
      expect(names.notFoundIds).toEqual([missing]);
    });

    it('GetUserAuthInfo aktif kullanıcıyı döner, olmayan kullanıcıda NOT_FOUND', async () => {
      const info = expectOk(
        await callUsers<users.GetUserAuthInfoResponse>('GetUserAuthInfo', {
          userId: otherUser.id,
        }),
        'GetUserAuthInfo',
      );
      expect(info).toEqual({
        userId: otherUser.id,
        role: users.UserRole.PET_OWNER,
        clinicId: '',
        isActive: true,
      });
      expect(
        outcome(await callUsers('GetUserAuthInfo', { userId: randomUUID() })),
      ).toBe('NOT_FOUND/NOT_FOUND');
    });
  });

  // ---Amaç: yalnızca auth'un çağırdığı kayıt ve geri alma RPC'lerinin çakışma ve idempotent silme davranışını doğrulamak ---
  describe('CreateUser / DeleteUser (iç RPC)', () => {
    it('CreateUser PET_OWNER üretir; e-posta ve telefon çakışmalarını ayrı bildirir', async () => {
      const id = randomUUID();
      data.trackUser(id);
      const email = uniqueEmail('createuser');
      const phone = uniqueMobilePhone();
      const created = expectOk(
        await callUsers<users.UserResponse>('CreateUser', {
          id,
          email,
          fullName: 'Can Öztürk',
          phone,
        }),
        'CreateUser',
      );
      expect(created.user).toMatchObject({
        userId: id,
        role: users.UserRole.PET_OWNER,
        clinicId: '',
      });

      expect(
        outcome(
          await callUsers('CreateUser', {
            id: randomUUID(),
            email,
            fullName: 'Can Öztürk',
            phone: uniqueMobilePhone(),
          }),
        ),
      ).toBe('ALREADY_EXISTS/EMAIL_ALREADY_EXISTS');
      expect(
        outcome(
          await callUsers('CreateUser', {
            id: randomUUID(),
            email: uniqueEmail('createuser'),
            fullName: 'Can Öztürk',
            phone,
          }),
        ),
      ).toBe('ALREADY_EXISTS/PHONE_ALREADY_EXISTS');
    });

    it('DeleteUser kaydı siler, ikinci çağrıda deleted=false döner', async () => {
      const id = randomUUID();
      data.trackUser(id);
      expectOk(
        await callUsers('CreateUser', {
          id,
          email: uniqueEmail('deleteuser'),
          fullName: 'Deniz Akın',
          phone: uniqueMobilePhone(),
        }),
        'CreateUser',
      );
      expect(
        expectOk(
          await callUsers<users.DeleteUserResponse>('DeleteUser', { userId: id }),
          'DeleteUser',
        ),
      ).toEqual({ deleted: true });
      expect(
        expectOk(
          await callUsers<users.DeleteUserResponse>('DeleteUser', { userId: id }),
          'DeleteUser',
        ),
      ).toEqual({ deleted: false });
    });
  });

  // ---Amaç: üçüncü taraf iletişim bilgisinin yalnızca owner_contact_read rızası ve rızayı veren sahip için verildiğini doğrulamak ---
  describe('GetUserContact', () => {
    const grant = async (scopes: string[]) =>
      expectOk(
        await callGrpc<access.ConsentResponse>(
          accessClient,
          'GrantConsent',
          {
            clinicId: clinic.id,
            petId,
            scopes,
            expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          },
          await ownerToken(),
        ),
        'access.GrantConsent',
      );

    const contact = async (override: object = {}, token?: string) =>
      callUsers<users.GetUserContactResponse>(
        'GetUserContact',
        { userId: owner.id, petId, ...override },
        token ?? (await clinicToken(clinic.id)),
      );

    it('owner_contact_read yoksa PERMISSION_DENIED/FORBIDDEN', async () => {
      await grant(['medical_read']);
      expect(outcome(await contact())).toBe('PERMISSION_DENIED/FORBIDDEN');
    });

    it('rıza varsa sahibin adı, telefonu ve e-postası döner', async () => {
      await grant(['medical_read', 'owner_contact_read']);
      expect(expectOk(await contact(), 'GetUserContact')).toEqual({
        userId: owner.id,
        fullName: owner.fullName,
        phone: owner.phone,
        email: owner.email,
      });
    });

    it('izinli hayvan için başka kullanıcının id’si istenirse NOT_FOUND (IDOR)', async () => {
      expect(outcome(await contact({ userId: otherUser.id }))).toBe(
        'NOT_FOUND/NOT_FOUND',
      );
    });

    it('rızası olmayan klinik PERMISSION_DENIED/FORBIDDEN alır', async () => {
      expect(
        outcome(await contact({}, await clinicToken(otherClinic.id))),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
    });

    it('PET_OWNER rolü çağıramaz', async () => {
      const result = await contact({}, await ownerToken());
      expect(result.ok ? 'ok' : result.code).toBe('PERMISSION_DENIED');
    });

    it('bozuk petId DTO’da INVALID_ARGUMENT/PET_ID_WRONG DATA FORMAT', async () => {
      expect(outcome(await contact({ petId: 'abc' }))).toBe(
        'INVALID_ARGUMENT/PET_ID_WRONG DATA FORMAT',
      );
    });

    it('pasif sahip hesabında NOT_FOUND', async () => {
      const db = await data.db('users');
      await db.query('UPDATE users SET is_active = false WHERE id = $1', [
        owner.id,
      ]);
      try {
        expect(outcome(await contact())).toBe('NOT_FOUND/NOT_FOUND');
      } finally {
        await db.query('UPDATE users SET is_active = true WHERE id = $1', [
          owner.id,
        ]);
      }
    });

    it('iptal edilmiş rızada PERMISSION_DENIED/FORBIDDEN', async () => {
      const consent = await grant(['medical_read', 'owner_contact_read']);
      expectOk(
        await callGrpc(
          accessClient,
          'RevokeConsent',
          { consentId: consent.consentId },
          await ownerToken(),
        ),
        'access.RevokeConsent',
      );
      expect(outcome(await contact())).toBe('PERMISSION_DENIED/FORBIDDEN');
    });
  });

  // ---Amaç: klinik oluşturma akışında açılan ortak CLINIC hesabının rol, klinik ve telefon kurallarını doğrulamak ---
  describe('CreateClinicUser (iç RPC)', () => {
    it('CLINIC rolünde, kliniğe bağlı hesap açar; sabit hattı E.164 biçimine çevirir', async () => {
      const id = randomUUID();
      data.trackUser(id);
      const phone = uniqueLandlinePhone();
      const created = expectOk(
        await callUsers<users.UserResponse>('CreateClinicUser', {
          id,
          email: uniqueEmail('klinikhesap'),
          fullName: 'Pati&Can 2 Veteriner',
          phone: `0${phone.slice(3)}`,
          clinicId: clinic.id,
        }),
        'CreateClinicUser',
      );
      expect(created.user).toMatchObject({
        userId: id,
        fullName: 'Pati&Can 2 Veteriner',
        phone,
        role: users.UserRole.CLINIC,
        clinicId: clinic.id,
        isActive: true,
      });

      const info = expectOk(
        await callUsers<users.GetUserAuthInfoResponse>('GetUserAuthInfo', {
          userId: id,
        }),
        'GetUserAuthInfo',
      );
      expect(info).toMatchObject({
        role: users.UserRole.CLINIC,
        clinicId: clinic.id,
      });
    });

    it('kayıtlı e-postayla ALREADY_EXISTS/EMAIL_ALREADY_EXISTS', async () => {
      expect(
        outcome(
          await callUsers('CreateClinicUser', {
            id: randomUUID(),
            email: otherUser.email,
            fullName: 'Pati Klinik',
            phone: uniqueLandlinePhone(),
            clinicId: clinic.id,
          }),
        ),
      ).toBe('ALREADY_EXISTS/EMAIL_ALREADY_EXISTS');
    });

    it('izinsiz karakterli klinik adı DTO’da reddedilir', async () => {
      expect(
        outcome(
          await callUsers('CreateClinicUser', {
            id: randomUUID(),
            email: uniqueEmail('klinikhesap'),
            fullName: 'Pati@Klinik',
            phone: uniqueLandlinePhone(),
            clinicId: clinic.id,
          }),
        ),
      ).toBe('INVALID_ARGUMENT/CLINIC_NAME_WRONG DATA FORMAT');
    });
  });

  // ---Amaç: hasta sahibinin kendi hesabını kapatabildiğini ve kapalı hesabın girişte ACCOUNT_DISABLED aldığını doğrulamak ---
  describe('DeactivateMe', () => {
    it('hesabı pasifleştirir, giriş bilgisi ACCOUNT_DISABLED olur, tekrar çağrı da başarılıdır', async () => {
      const user = await data.insertUser({ fullName: 'Kapanacak Hesap' });
      const token = await ownerToken(user);

      const first = expectOk(
        await callUsers<users.UserResponse>('DeactivateMe', {}, token),
        'DeactivateMe',
      );
      expect(first.user).toMatchObject({ userId: user.id, isActive: false });
      expect(
        outcome(await callUsers('GetUserAuthInfo', { userId: user.id })),
      ).toBe('PERMISSION_DENIED/ACCOUNT_DISABLED');

      const second = expectOk(
        await callUsers<users.UserResponse>('DeactivateMe', {}, token),
        'DeactivateMe (tekrar)',
      );
      expect(second.user?.isActive).toBe(false);
    });

    it('CLINIC rolü DeactivateMe çağıramaz', async () => {
      const result = await callUsers(
        'DeactivateMe',
        {},
        await clinicToken(clinic.id),
      );
      expect(result.ok ? 'ok' : result.code).toBe('PERMISSION_DENIED');
    });
  });

  // ---Amaç: klinik pasifleştirmesinde kliniğin ortak hesabının yalnızca kendi token'ıyla kapatılabildiğini doğrulamak ---
  describe('DeactivateClinicUsers', () => {
    it('başka kliniğin token’ıyla PERMISSION_DENIED/FORBIDDEN', async () => {
      expect(
        outcome(
          await callUsers(
            'DeactivateClinicUsers',
            { clinicId: clinic.id },
            await clinicToken(otherClinic.id),
          ),
        ),
      ).toBe('PERMISSION_DENIED/FORBIDDEN');
    });

    it('PET_OWNER rolü çağıramaz', async () => {
      const result = await callUsers(
        'DeactivateClinicUsers',
        { clinicId: clinic.id },
        await ownerToken(),
      );
      expect(result.ok ? 'ok' : result.code).toBe('PERMISSION_DENIED');
    });

    it('bozuk clinicId DTO’da INVALID_ARGUMENT/CLINIC_ID_WRONG DATA FORMAT', async () => {
      expect(
        outcome(
          await callUsers(
            'DeactivateClinicUsers',
            { clinicId: 'abc' },
            await clinicToken(clinic.id),
          ),
        ),
      ).toBe('INVALID_ARGUMENT/CLINIC_ID_WRONG DATA FORMAT');
    });

    it('kendi kliniğinin hesabını pasifleştirir ve sayısını döner', async () => {
      const closingClinic = await data.insertClinic();
      const clinicAccount = await data.insertUser({
        fullName: 'Kapanan Klinik',
        role: 'CLINIC',
        clinicId: closingClinic.id,
      });

      const result = expectOk(
        await callUsers<users.DeactivateClinicUsersResponse>(
          'DeactivateClinicUsers',
          { clinicId: closingClinic.id },
          await clinicToken(closingClinic.id),
        ),
        'DeactivateClinicUsers',
      );
      expect(result).toEqual({ deactivatedCount: 1 });
      expect(
        outcome(
          await callUsers('GetUserAuthInfo', { userId: clinicAccount.id }),
        ),
      ).toBe('PERMISSION_DENIED/ACCOUNT_DISABLED');
    });
  });
});
