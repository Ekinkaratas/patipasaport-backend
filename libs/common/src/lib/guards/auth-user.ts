import { Metadata } from '@grpc/grpc-js';
import { access } from '@libs/proto';
import { TokenRole } from '../enums';

export interface AuthUser {
  userId: string;
  role: TokenRole;
  clinicId: string;
  clientType: access.ClientType;
}

// Çağrının Metadata nesnesine bağlı; çağrı bitince kendiliğinden silinir.
const verifiedUsers = new WeakMap<Metadata, AuthUser>();

export const setAuthUser = (metadata: Metadata, user: AuthUser) =>
  verifiedUsers.set(metadata, user);

export const getAuthUser = (metadata: Metadata) => verifiedUsers.get(metadata);
