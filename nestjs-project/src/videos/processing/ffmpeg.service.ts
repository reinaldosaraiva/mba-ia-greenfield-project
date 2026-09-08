import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { VideoMetadata } from '../entities/video.entity';

const execFileAsync = promisify(execFile);

const PROBE_MAX_BUFFER = 8 * 1024 * 1024;
const THUMBNAIL_MAX_BUFFER = 32 * 1024 * 1024;
const THUMBNAIL_WIDTH = 640;

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

@Injectable()
export class FfmpegService {
  // The input is a presigned URL, not a local path: ffprobe and ffmpeg read the
  // container header and one keyframe region over HTTP range requests, so a
  // 10GiB source costs a few MB of transfer and no worker disk.
  async probe(input: string): Promise<ProbeResult> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      { maxBuffer: PROBE_MAX_BUFFER },
    );

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    if (!video) {
      throw new Error('Input has no video stream');
    }

    const duration = Number(parsed.format?.duration ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Input has no readable duration');
    }

    return {
      durationSeconds: Math.round(duration),
      metadata: {
        format_name: parsed.format?.format_name,
        bit_rate: parsed.format?.bit_rate
          ? Number(parsed.format.bit_rate)
          : undefined,
        width: video.width,
        height: video.height,
        video_codec: video.codec_name,
        audio_codec: audio?.codec_name,
        frame_rate: video.r_frame_rate,
      },
    };
  }

  async extractThumbnail(input: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        // Seeking before -i is an input seek: ffmpeg jumps straight to the
        // keyframe instead of decoding everything before it.
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMBNAIL_WIDTH}:-2`,
        '-q:v',
        '2',
        '-f',
        'image2',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: THUMBNAIL_MAX_BUFFER },
    );

    if (stdout.length === 0) {
      throw new Error(`ffmpeg produced no frame at ${atSeconds}s`);
    }

    return stdout;
  }
}
