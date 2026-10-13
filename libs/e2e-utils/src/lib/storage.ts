import {
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { DOCKER_S3_PORT } from './ports';
import { requireEnv, rootEnv } from './workspace';

export class ObjectStore {
  private readonly bucket = rootEnv()['S3_BUCKET'] || 'medical-documents';
  private readonly client = new S3Client({
    endpoint: `http://127.0.0.1:${DOCKER_S3_PORT}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: requireEnv('S3_GATEWAY_ACCESS_KEY'),
      secretAccessKey: requireEnv('S3_GATEWAY_SECRET_KEY'),
    },
  });

  async head(key: string): Promise<HeadObjectCommandOutput | undefined> {
    try {
      return await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (e) {
      if (
        (e as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw e;
    }
  }

  async keyCount(): Promise<number> {
    const result = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket }),
    );
    return result.KeyCount ?? 0;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}
