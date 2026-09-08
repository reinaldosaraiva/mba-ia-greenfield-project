import { ArrayMaxSize, ArrayMinSize, IsInt, Max, Min } from 'class-validator';
import {
  VIDEO_MAX_PARTS,
  VIDEO_MAX_PARTS_PER_REQUEST,
} from '../videos.constants';

export class PresignPartsDto {
  /** Part numbers to presign, in a single batch. */
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_MAX_PARTS_PER_REQUEST)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(VIDEO_MAX_PARTS, { each: true })
  part_numbers: number[];
}
