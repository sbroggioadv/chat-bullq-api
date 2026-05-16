import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * AES-256-GCM authenticated encryption for AI provider API keys.
 *
 * Layout do blob (base64-encoded):
 *   12B IV ‖ N bytes ciphertext ‖ 16B authTag
 *
 * Master key (32 bytes / 256 bits) vem de `ENCRYPTION_KEY` env como hex
 * (64 chars). Em produção, ausência = boot fail. Em dev/test, gera key
 * efêmera com warning pra não travar onboarding local (não persiste —
 * cada restart re-gera, então credentials criadas em sessão anterior
 * ficam unreadable. Aceitável em dev.).
 *
 * Geração de key (run uma vez, salva no 1Password + Coolify env):
 *   openssl rand -hex 32
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly masterKey: Buffer;
  private static readonly IV_LENGTH = 12; // GCM standard
  private static readonly AUTH_TAG_LENGTH = 16;
  private static readonly ALGORITHM = 'aes-256-gcm';

  constructor(config: ConfigService) {
    const hex = config.get<string>('ENCRYPTION_KEY');
    const isProd = config.get<string>('NODE_ENV') === 'production';

    if (!hex) {
      if (isProd) {
        // Fail-fast em prod: melhor não bootar do que rodar com key
        // efêmera (perderíamos credentials em cada restart).
        throw new Error(
          'FATAL: ENCRYPTION_KEY env var required in production. ' +
          'Generate with: openssl rand -hex 32',
        );
      }
      // Dev: gera efêmera, avisa muito.
      this.logger.warn(
        '⚠️  ENCRYPTION_KEY not set — generating ephemeral key for DEV. ' +
        'Credentials saved this session WILL NOT survive restart. ' +
        'For persistence, set ENCRYPTION_KEY env var (openssl rand -hex 32).',
      );
      this.masterKey = crypto.randomBytes(32);
      return;
    }

    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        'FATAL: ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
        'Generate with: openssl rand -hex 32',
      );
    }
    this.masterKey = Buffer.from(hex, 'hex');
    this.logger.log('Crypto service initialized with persistent master key');
  }

  /**
   * Encrypts a plaintext string and returns base64(IV ‖ ct ‖ authTag).
   * Each call uses a fresh random IV — same plaintext encrypts differently
   * every time (semantic security).
   */
  encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new InternalServerErrorException('Cannot encrypt empty plaintext');
    }
    const iv = crypto.randomBytes(CryptoService.IV_LENGTH);
    const cipher = crypto.createCipheriv(
      CryptoService.ALGORITHM,
      this.masterKey,
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
  }

  /**
   * Reverses encrypt(). Throws if blob is malformed or authTag fails
   * (tamper detection). Caller should treat any throw as "credential
   * corrupted, delete + ask user to re-enter".
   */
  decrypt(blob: string): string {
    let buf: Buffer;
    try {
      buf = Buffer.from(blob, 'base64');
    } catch {
      throw new InternalServerErrorException('Corrupted credential blob (base64)');
    }
    if (buf.length < CryptoService.IV_LENGTH + CryptoService.AUTH_TAG_LENGTH + 1) {
      throw new InternalServerErrorException('Corrupted credential blob (length)');
    }
    const iv = buf.subarray(0, CryptoService.IV_LENGTH);
    const authTag = buf.subarray(buf.length - CryptoService.AUTH_TAG_LENGTH);
    const ciphertext = buf.subarray(
      CryptoService.IV_LENGTH,
      buf.length - CryptoService.AUTH_TAG_LENGTH,
    );
    const decipher = crypto.createDecipheriv(
      CryptoService.ALGORITHM,
      this.masterKey,
      iv,
    );
    decipher.setAuthTag(authTag);
    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch (err) {
      // GCM tampering ou key wrong — não logar plaintext nem error.message
      // detalhado (pode vazar contexto). Log abstrato suficiente.
      this.logger.error('Decrypt failed (authTag mismatch or wrong master key)');
      throw new InternalServerErrorException('Credential decryption failed');
    }
  }

  /**
   * Extracts last 4 chars of a plaintext key for display ("****1234").
   * Defensive: short keys collapse to fewer chars (won't break UI).
   */
  static hint(plaintext: string): string {
    if (!plaintext) return '****';
    return plaintext.slice(-4);
  }
}
