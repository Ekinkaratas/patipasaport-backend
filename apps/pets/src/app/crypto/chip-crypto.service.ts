import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const FORMAT_VERSION = 'v1';

@Injectable()
export class ChipCryptoService {
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(config: ConfigService) {
    this.encryptionKey = ChipCryptoService.loadKey(
      config,
      'PETS_CHIP_ENCRYPTION_KEY',
    );
    this.indexKey = ChipCryptoService.loadKey(config, 'PETS_CHIP_INDEX_KEY');
    if (this.encryptionKey.equals(this.indexKey)) {
      throw new Error(
        'PETS_CHIP_ENCRYPTION_KEY ve PETS_CHIP_INDEX_KEY farklı olmalı',
      );
    }
  }

  private static loadKey(config: ConfigService, name: string): Buffer {
    const key = Buffer.from(config.getOrThrow<string>(name), 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `${name} base64 kodlu ${KEY_LENGTH} bayt olmalı (gelen: ${key.length} bayt)`,
      );
    }
    return key;
  }

  encrypt(chipNumber: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const ciphertext = Buffer.concat([
      cipher.update(chipNumber, 'utf8'),
      cipher.final(),
    ]);
    return [
      FORMAT_VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decryptChip(stored: string): string {
    const parts = stored.split('.');
    if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
      throw new Error('chip_no_encrypted beklenen biçimde değil');
    }
    const iv = Buffer.from(parts[1], 'base64url');
    const authTag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('chip_no_encrypted IV veya doğrulama etiketi bozuk');
    }
    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  blindIndex(chipNumber: string): string {
    return createHmac('sha256', this.indexKey)
      .update(chipNumber, 'utf8')
      .digest('hex');
  }

  static last4(chipNumber: string): string {
    return chipNumber.slice(-4);
  }
}
