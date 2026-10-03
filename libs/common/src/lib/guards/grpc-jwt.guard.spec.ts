import { createHmac, generateKeyPairSync, randomUUID } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Metadata } from '@grpc/grpc-js';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { access } from '@libs/proto';
import { CurrentUser, Public, Roles } from '../decorator';
import { ResponseMessages } from '../enums';
import { getAuthUser } from './auth-user';
import { GrpcJwtGuard } from './grpc-jwt.guard';

const keyPair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

const accessKeys = keyPair();
const attackerKeys = keyPair();

const USER_ID = randomUUID();
const CLINIC_ID = randomUUID();
const validClaims = {
  sub: USER_ID,
  role: 'PET_OWNER',
  clinicId: '',
  clientType: access.ClientType.WEB,
};

// access.module.ts'teki imzalama ayarlarının aynısı
const signer = (privateKey: string, issuer = 'access') =>
  new JwtService({
    privateKey,
    signOptions: { algorithm: 'RS256', expiresIn: 60, issuer },
  });

const base64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

class TestController {
  @Public()
  open() {
    return 'open';
  }

  protected() {
    return 'protected';
  }

  @Roles(['VETERINARIAN'])
  vetOnly() {
    return 'vetOnly';
  }
}

@Public()
class PublicController {
  anything() {
    return 'anything';
  }
}

const contextFor = (
  metadata: Metadata,
  handler: () => void = TestController.prototype.protected,
  cls: new () => object = TestController,
) => {
  const ctx = new ExecutionContextHost(
    [{}, metadata, {}],
    cls as never,
    handler,
  );
  ctx.setType('rpc');
  return ctx;
};

const metadataWith = (authorization?: string) => {
  const metadata = new Metadata();
  if (authorization) metadata.set('authorization', authorization);
  return metadata;
};

const rejectionOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RpcException);
    return (e as RpcException).getError() as string;
  }
  throw new Error('guard reddetmedi');
};

describe('GrpcJwtGuard', () => {
  let keyPath: string;
  let guard: GrpcJwtGuard;

  beforeAll(() => {
    keyPath = join(mkdtempSync(join(tmpdir(), 'jwt-guard-')), 'public.pem');
    writeFileSync(keyPath, accessKeys.publicKey);
  });

  beforeEach(() => {
    const config = { getOrThrow: () => keyPath } as unknown as ConfigService;
    guard = new GrpcJwtGuard(config, new Reflector());
  });

  describe('gecerli token', () => {
    it('kabul eder ve dogrulanmis kullaniciyi cagriya baglar', () => {
      const token = signer(accessKeys.privateKey).sign(validClaims);
      const metadata = metadataWith(`Bearer ${token}`);

      expect(guard.canActivate(contextFor(metadata))).toBe(true);
      expect(getAuthUser(metadata)).toEqual({
        userId: USER_ID,
        role: 'PET_OWNER',
        clinicId: '',
        clientType: access.ClientType.WEB,
      });
    });

    it('Bearer semasi buyuk/kucuk harf duyarsizdir', () => {
      const token = signer(accessKeys.privateKey).sign(validClaims);

      expect(
        guard.canActivate(contextFor(metadataWith(`bearer ${token}`))),
      ).toBe(true);
    });

    it('klinik personelinin rolu ve klinigi tasinir', () => {
      const token = signer(accessKeys.privateKey).sign({
        ...validClaims,
        role: 'VETERINARIAN',
        clinicId: CLINIC_ID,
        clientType: access.ClientType.MOBILE,
      });
      const metadata = metadataWith(`Bearer ${token}`);

      guard.canActivate(contextFor(metadata));

      expect(getAuthUser(metadata)).toMatchObject({
        role: 'VETERINARIAN',
        clinicId: CLINIC_ID,
        clientType: access.ClientType.MOBILE,
      });
    });
  });

  describe('token yok veya bicimi yanlis', () => {
    it.each([
      ['authorization yok', undefined],
      ['Bearer olmayan sema', 'Basic abc'],
      ['token bos', 'Bearer '],
    ])('%s ise UNAUTH', (_label, header) => {
      expect(
        rejectionOf(() => guard.canActivate(contextFor(metadataWith(header)))),
      ).toBe(ResponseMessages.UNAUTH);
    });
  });

  describe('sahte veya gecersiz token', () => {
    it('suresi dolmussa TOKEN_EXPIRED', () => {
      const expired = new JwtService({
        privateKey: accessKeys.privateKey,
        signOptions: { algorithm: 'RS256', issuer: 'access' },
      }).sign({ ...validClaims, exp: Math.floor(Date.now() / 1000) - 10 });

      expect(
        rejectionOf(() =>
          guard.canActivate(contextFor(metadataWith(`Bearer ${expired}`))),
        ),
      ).toBe(ResponseMessages.TOKEN_EXPIRED);
    });

    it('baska bir anahtarla imzalanmissa INVALID_TOKEN', () => {
      const forged = signer(attackerKeys.privateKey).sign(validClaims);

      expect(
        rejectionOf(() =>
          guard.canActivate(contextFor(metadataWith(`Bearer ${forged}`))),
        ),
      ).toBe(ResponseMessages.INVALID_TOKEN);
    });

    it('issuer access degilse INVALID_TOKEN', () => {
      const token = signer(accessKeys.privateKey, 'baska-servis').sign(
        validClaims,
      );

      expect(
        rejectionOf(() =>
          guard.canActivate(contextFor(metadataWith(`Bearer ${token}`))),
        ),
      ).toBe(ResponseMessages.INVALID_TOKEN);
    });

    it('icerigi degistirilmisse (rol yukseltme) INVALID_TOKEN', () => {
      const [header, , signature] = signer(accessKeys.privateKey)
        .sign(validClaims)
        .split('.');
      const tampered = `${header}.${base64url({ ...validClaims, role: 'VETERINARIAN', iss: 'access' })}.${signature}`;

      expect(
        rejectionOf(() =>
          guard.canActivate(contextFor(metadataWith(`Bearer ${tampered}`))),
        ),
      ).toBe(ResponseMessages.INVALID_TOKEN);
    });

    it('alg: none ile imzasiz token INVALID_TOKEN', () => {
      const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ ...validClaims, iss: 'access' })}.`;

      expect(
        rejectionOf(() =>
          guard.canActivate(contextFor(metadataWith(`Bearer ${unsigned}`))),
        ),
      ).toBe(ResponseMessages.INVALID_TOKEN);
    });

    it('public key ile HS256 imzalanmis token (algoritma karistirma) INVALID_TOKEN', () => {
      const unsigned = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ ...validClaims, iss: 'access', exp: Math.floor(Date.now() / 1000) + 60 })}`;
      const signature = createHmac('sha256', accessKeys.publicKey)
        .update(unsigned)
        .digest('base64url');

      expect(
        rejectionOf(() =>
          guard.canActivate(
            contextFor(metadataWith(`Bearer ${unsigned}.${signature}`)),
          ),
        ),
      ).toBe(ResponseMessages.INVALID_TOKEN);
    });

    it.each([
      ['rol listede yok', { role: 'ADMIN' }],
      ['userId UUID degil', { sub: 'admin' }],
      [
        'clientType belirsiz',
        { clientType: access.ClientType.CLIENT_TYPE_UNSPECIFIED },
      ],
      ['clinicId metin degil', { clinicId: 5 }],
    ])('imza dogru ama %s ise INVALID_TOKEN', (_label, override) => {
      const token = signer(accessKeys.privateKey).sign({
        ...validClaims,
        ...override,
      });
      const metadata = metadataWith(`Bearer ${token}`);

      expect(rejectionOf(() => guard.canActivate(contextFor(metadata)))).toBe(
        ResponseMessages.INVALID_TOKEN,
      );
      expect(getAuthUser(metadata)).toBeUndefined();
    });
  });

  describe('@Public ve @Roles', () => {
    it('@Public uc token istemez', () => {
      const metadata = metadataWith();

      expect(
        guard.canActivate(contextFor(metadata, TestController.prototype.open)),
      ).toBe(true);
      expect(getAuthUser(metadata)).toBeUndefined();
    });

    it('controller seviyesindeki @Public tum uclara uygulanir', () => {
      expect(
        guard.canActivate(
          contextFor(
            metadataWith(),
            PublicController.prototype.anything,
            PublicController,
          ),
        ),
      ).toBe(true);
    });

    it('@Roles disindaki rol FORBIDDEN alir', () => {
      const token = signer(accessKeys.privateKey).sign(validClaims);

      expect(
        rejectionOf(() =>
          guard.canActivate(
            contextFor(
              metadataWith(`Bearer ${token}`),
              TestController.prototype.vetOnly,
            ),
          ),
        ),
      ).toBe(ResponseMessages.FORBIDDEN);
    });

    it('@Roles icindeki rol gecer', () => {
      const token = signer(accessKeys.privateKey).sign({
        ...validClaims,
        role: 'VETERINARIAN',
        clinicId: CLINIC_ID,
      });

      expect(
        guard.canActivate(
          contextFor(
            metadataWith(`Bearer ${token}`),
            TestController.prototype.vetOnly,
          ),
        ),
      ).toBe(true);
    });
  });

  describe('acilis', () => {
    it('public key dosyasi yoksa servis baslamaz', () => {
      const config = {
        getOrThrow: () => join(tmpdir(), 'olmayan-anahtar.pem'),
      } as unknown as ConfigService;

      expect(() => new GrpcJwtGuard(config, new Reflector())).toThrow();
    });
  });

  describe('@CurrentUser', () => {
    const factory = (() => {
      class Probe {
        handler(@CurrentUser() user: unknown) {
          return user;
        }
      }
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler');
      return args[Object.keys(args)[0]].factory as (
        data: unknown,
        ctx: ExecutionContextHost,
      ) => unknown;
    })();

    it('guardin dogruladigi kullaniciyi verir', () => {
      const token = signer(accessKeys.privateKey).sign(validClaims);
      const metadata = metadataWith(`Bearer ${token}`);
      guard.canActivate(contextFor(metadata));

      expect(factory(undefined, contextFor(metadata))).toEqual(
        getAuthUser(metadata),
      );
    });

    it('dogrulanmis kullanici yoksa hata firlatir', () => {
      expect(() => factory(undefined, contextFor(metadataWith()))).toThrow(
        /doğrulanmış kullanıcı yok/,
      );
    });
  });
});
