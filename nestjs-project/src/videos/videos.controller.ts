import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import { VideosService } from './videos.service';
import type { CreatedVideo, PresignedPart } from './videos.types';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and opens a multipart upload, returning the envelope the client needs to send the parts directly to object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        upload: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            part_size: { type: 'integer' },
            part_count: { type: 'integer' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or the declared size exceeds the limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Declared content type is not a supported video type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreatedVideo> {
    return this.videosService.createDraft(user.sub, dto);
  }

  // A 10GiB upload needs more part-URL batches than the global auth throttle
  // allows, so this route carries its own allowance.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post(':id/uploads/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Presign upload parts',
    description:
      'Returns one presigned URL per requested part number so the client can PUT each chunk straight to object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
              expires_in: { type: 'integer' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload is no longer pending',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignPartsDto,
  ): Promise<{ parts: PresignedPart[] }> {
    const parts = await this.videosService.presignParts(
      user.sub,
      id,
      dto.part_numbers,
    );
    return { parts };
  }

  @Delete(':id/uploads')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the multipart upload in object storage and discards the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found for the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The upload is no longer pending',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, id);
  }
}
