import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  STORAGE_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: Joi.string().required(),
  STORAGE_SECRET_ACCESS_KEY: Joi.string().required(),
  STORAGE_BUCKET: Joi.string().default('streamtube'),
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  VIDEO_MAX_UPLOAD_BYTES: Joi.number()
    .integer()
    .positive()
    .default(10737418240),
  VIDEO_UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5242880)
    .default(10485760),
  VIDEO_UPLOAD_URL_EXPIRATION_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(3600),
  VIDEO_PROCESSING_URL_EXPIRATION_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(900),
  VIDEO_PROCESSING_ATTEMPTS: Joi.number().integer().min(1).default(3),
  VIDEO_THUMBNAIL_POSITION_RATIO: Joi.number().min(0).max(1).default(0.1),
  VIDEO_ALLOWED_MIME_TYPES: Joi.string().default(
    'video/mp4,video/quicktime,video/webm,video/x-matroska',
  ),
});
