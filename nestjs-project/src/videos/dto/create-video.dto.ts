import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVideoDto {
  /** Title shown for the video. */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  /** Original file name; only its extension reaches the storage key. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /** Declared size of the file about to be uploaded, in bytes. */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  size_bytes: number;

  /** Declared content type; must be one of the configured video types. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  mime_type: string;
}
