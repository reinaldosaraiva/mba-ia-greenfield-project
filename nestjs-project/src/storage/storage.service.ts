import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface ObjectStream {
  body: Readable;
  contentLength: number;
  contentType?: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      // MinIO serves buckets on the path, not as a subdomain of the endpoint.
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  get bucket(): string {
    return this.config.bucket;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      this.logger.log(`Bucket "${this.bucket}" not found — creating it`);
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      // A concurrent bootstrap may have won the race; anything else is fatal.
      const name = (error as { name?: string }).name;
      if (
        name !== 'BucketAlreadyOwnedByYou' &&
        name !== 'BucketAlreadyExists'
      ) {
        throw error;
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error(`Storage did not return an UploadId for key "${key}"`);
    }

    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType,
    };
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.headObject(key);
      return true;
    } catch {
      return false;
    }
  }

  async getObjectRange(key: string, range?: ByteRange): Promise<ObjectStream> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range && { Range: `bytes=${range.start}-${range.end}` }),
      }),
    );

    return {
      // On the Node runtime the SDK always returns a Readable here; the union in
      // the type definition also covers the browser and React Native runtimes.
      body: result.Body as Readable,
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType,
    };
  }

  async presignGetObject(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    const listed = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );

    const keys = (listed.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key));

    if (keys.length === 0) {
      return;
    }

    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );
  }
}
