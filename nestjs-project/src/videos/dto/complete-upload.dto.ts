import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { VIDEO_MAX_PARTS } from '../videos.constants';

export class UploadedPartDto {
  /** Part number reported by the client, matching the presigned URL used. */
  @IsInt()
  @Min(1)
  @Max(VIDEO_MAX_PARTS)
  part_number: number;

  /** ETag returned by object storage for that part. */
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  /** Every part uploaded, in any order. */
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
