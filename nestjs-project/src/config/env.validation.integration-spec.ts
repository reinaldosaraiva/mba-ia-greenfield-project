import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY_ID: 'storage-key',
  STORAGE_SECRET_ACCESS_KEY: 'storage-secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video', () => {
  it('should reject bootstrap when STORAGE_ACCESS_KEY_ID is missing', () => {
    const withoutKey: Record<string, string> = { ...requiredEnv };
    delete withoutKey.STORAGE_ACCESS_KEY_ID;
    const { error } = envValidationSchema.validate(withoutKey, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ACCESS_KEY_ID');
  });

  it('should reject bootstrap when STORAGE_SECRET_ACCESS_KEY is missing', () => {
    const withoutSecret: Record<string, string> = { ...requiredEnv };
    delete withoutSecret.STORAGE_SECRET_ACCESS_KEY;
    const { error } = envValidationSchema.validate(withoutSecret, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_SECRET_ACCESS_KEY');
  });

  it('should apply the documented defaults when the optional variables are absent', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_BUCKET).toBe('streamtube');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_MAX_UPLOAD_BYTES).toBe(10737418240);
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(10485760);
    expect(value.VIDEO_PROCESSING_ATTEMPTS).toBe(3);
    expect(value.VIDEO_THUMBNAIL_POSITION_RATIO).toBe(0.1);
  });

  it('should coerce the numeric limits supplied as strings', () => {
    const { value, error } = validate({
      VIDEO_MAX_UPLOAD_BYTES: '5368709120',
      VIDEO_UPLOAD_PART_SIZE_BYTES: '8388608',
    });
    expect(error).toBeUndefined();
    expect(value.VIDEO_MAX_UPLOAD_BYTES).toBe(5368709120);
    expect(value.VIDEO_UPLOAD_PART_SIZE_BYTES).toBe(8388608);
  });

  it('should reject a part size below the 5MiB S3 minimum', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1024' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should reject a thumbnail position ratio outside 0..1', () => {
    const { error } = validate({ VIDEO_THUMBNAIL_POSITION_RATIO: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_THUMBNAIL_POSITION_RATIO');
  });
});
