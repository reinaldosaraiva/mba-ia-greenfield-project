import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const CLIENT_DISCONNECT_CODES = new Set([
  'ERR_STREAM_PREMATURE_CLOSE',
  'ECONNRESET',
  'EPIPE',
]);

function isClientDisconnect(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code !== undefined && CLIENT_DISCONNECT_CODES.has(code);
}

// `readable.pipe(writable)` does not tear down the source when the destination
// closes, and an unhandled 'error' on the source becomes an uncaughtException
// that takes the process down. `pipeline` destroys both ends on either failure,
// which is what a storage stream piped to an HTTP response needs: the client can
// disconnect at any moment while seeking through a video.
export async function pipeToResponse(
  source: Readable,
  response: Response,
  logger: Logger,
  context: string,
): Promise<void> {
  try {
    await pipeline(source, response);
  } catch (error) {
    source.destroy();

    if (isClientDisconnect(error)) {
      logger.debug(`Client disconnected while streaming ${context}`);
      return;
    }

    if (!response.headersSent) {
      throw error;
    }

    // The response is already on the wire; destroying it is the only way left
    // to tell the client the body is truncated.
    logger.error(
      `Streaming ${context} failed after headers were sent: ${(error as Error).message}`,
    );
    response.destroy();
  }
}
