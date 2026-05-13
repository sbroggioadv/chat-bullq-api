import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';

/**
 * Owns the singleton MinIO client and guarantees the configured bucket
 * exists on boot — once. This unblocks future migrations of media uploads
 * from local filesystem (UploadsService) to S3-compatible storage without
 * requiring a manual "go create the bucket in the console" step in every
 * fresh environment.
 *
 * S17/C4 (2026-05-13): introduced as bootstrap-only. UploadsService still
 * writes to local FS today; when we migrate, this module already provides
 * a ready-to-use client + bucket.
 *
 * Behaviour:
 *  - If MinIO env vars are missing/incomplete → module logs a warning and
 *    becomes a no-op. API continues to boot (intentionally non-blocking
 *    for dev environments without MinIO running).
 *  - If MinIO is reachable + bucket exists → silent.
 *  - If MinIO is reachable + bucket missing → bucket is created.
 *  - If MinIO is unreachable → warning logged, no exception thrown.
 *    Caller code that depends on storage will fail with a clear error
 *    when it tries to use the client (we don't want a transient MinIO
 *    outage to kill the entire API boot).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client: MinioClient | null = null;
  private bucket: string | null = null;
  private ready = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const endPoint = this.config.get<string>('MINIO_ENDPOINT');
    const port = parseInt(
      this.config.get<string>('MINIO_PORT') ?? '9000',
      10,
    );
    const accessKey = this.config.get<string>('MINIO_ACCESS_KEY');
    const secretKey = this.config.get<string>('MINIO_SECRET_KEY');
    const bucket = this.config.get<string>('MINIO_BUCKET');
    const useSSL = (this.config.get<string>('MINIO_USE_SSL') ?? 'false') === 'true';
    const region = this.config.get<string>('MINIO_REGION') ?? 'us-east-1';

    if (!endPoint || !accessKey || !secretKey || !bucket) {
      this.logger.warn(
        'MinIO config incomplete (need MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET) — storage disabled',
      );
      return;
    }

    this.bucket = bucket;
    this.client = new MinioClient({
      endPoint,
      port: Number.isFinite(port) ? port : 9000,
      useSSL,
      accessKey,
      secretKey,
      region,
    });

    try {
      const exists = await this.client.bucketExists(bucket);
      if (!exists) {
        this.logger.log(
          `MinIO bucket "${bucket}" not found at ${endPoint}:${port} — creating (region=${region})`,
        );
        await this.client.makeBucket(bucket, region);
        this.logger.log(`MinIO bucket "${bucket}" created`);
      } else {
        this.logger.log(
          `MinIO bucket "${bucket}" present at ${endPoint}:${port} (region=${region})`,
        );
      }
      this.ready = true;
    } catch (err: unknown) {
      // Never throw on boot — we don't want a transient MinIO outage to
      // crash the entire API. Downstream consumers (when they show up)
      // will fail with a clear error via getClient().
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `MinIO bootstrap failed at ${endPoint}:${port} — storage will be unavailable: ${message}`,
      );
    }
  }

  /**
   * Returns the live MinIO client. Throws if the module never finished
   * bootstrapping (misconfigured env or MinIO unreachable on boot).
   */
  getClient(): MinioClient {
    if (!this.client || !this.ready) {
      throw new Error(
        'StorageService not ready — check MinIO env vars and connectivity',
      );
    }
    return this.client;
  }

  getBucket(): string {
    if (!this.bucket) {
      throw new Error('StorageService not configured (no bucket)');
    }
    return this.bucket;
  }

  isReady(): boolean {
    return this.ready;
  }
}
