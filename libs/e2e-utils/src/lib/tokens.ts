import { Client } from '@grpc/grpc-js';
import { access } from '@libs/proto';
import { callGrpc, expectOk, grpcClient } from './grpc';
import { DOCKER_GRPC_PORTS } from './ports';

export interface TokenSubject {
  role: 'PET_OWNER' | 'CLINIC';
  userId: string;
  clinicId?: string;
}

const JWT_REUSE_MS = 40_000;

export class JwtIssuer {
  private readonly client: Client;
  private readonly cache = new Map<string, { jwt: string; issuedAt: number }>();

  constructor(accessPort: number = DOCKER_GRPC_PORTS.access) {
    this.client = grpcClient('access', accessPort);
  }

  async jwtFor(subject: TokenSubject): Promise<string> {
    const key = `${subject.role}:${subject.userId}:${subject.clinicId ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.issuedAt < JWT_REUSE_MS) {
      return cached.jwt;
    }
    const jwt = await this.issue(subject);
    this.cache.set(key, { jwt, issuedAt: Date.now() });
    return jwt;
  }

  async issue(subject: TokenSubject): Promise<string> {
    const created = expectOk(
      await callGrpc<access.CreateTokenResponse>(
        this.client,
        'CreateOpaqueToken',
        {
          userId: subject.userId,
          role: subject.role,
          clinicId: subject.clinicId ?? '',
          clientType: access.ClientType.WEB,
          ttlSeconds: 0,
        },
      ),
      'access.CreateOpaqueToken',
    );
    const exchanged = expectOk(
      await callGrpc<access.ExchangeTokenResponse>(
        this.client,
        'ExchangeToken',
        { opaqueToken: created.opaqueToken, clientType: access.ClientType.WEB },
      ),
      'access.ExchangeToken',
    );
    await callGrpc(this.client, 'RevokeToken', {
      opaqueToken: created.opaqueToken,
    });
    return exchanged.jwt;
  }

  close(): void {
    this.client.close();
  }
}
