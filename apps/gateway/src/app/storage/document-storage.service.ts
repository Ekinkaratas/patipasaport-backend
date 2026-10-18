import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { requiredEnv } from '@libs/common';

const S3_REGION = 'us-east-1';

export class DocumentIntegrityError extends Error {}

@Injectable()
export class DocumentStorageService implements OnModuleDestroy {
  private readonly bucket = requiredEnv('S3_BUCKET');
  private readonly client = new S3Client({
    endpoint: requiredEnv('S3_ENDPOINT'),
    region: S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv('S3_ACCESS_KEY'),
      secretAccessKey: requiredEnv('S3_SECRET_KEY'),
    },
  });

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async get(key: string, expectedSize: number): Promise<Buffer> {
    const { Body, ContentLength } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!Body || ContentLength !== expectedSize) {
      if (Body instanceof Readable) Body.destroy();
      throw new DocumentIntegrityError(
        `depodaki boyut kayıttakinden farklı (key=${key} kayıt=${expectedSize} depo=${String(ContentLength)})`,
      );
    }
    return Buffer.from(await Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
