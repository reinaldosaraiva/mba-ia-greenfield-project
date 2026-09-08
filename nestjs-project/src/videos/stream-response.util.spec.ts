import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Readable, Writable } from 'node:stream';
import { pipeToResponse } from './stream-response.util';

class FakeResponse extends Writable {
  headersSent = false;
  readonly chunks: Buffer[] = [];

  constructor(private readonly onWrite?: (chunk: Buffer) => void) {
    super();
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.headersSent = true;
    this.chunks.push(chunk);
    this.onWrite?.(chunk);
    callback();
  }
}

function failingSource(error: Error, chunksBeforeFailure: number): Readable {
  let emitted = 0;
  return new Readable({
    read() {
      if (emitted < chunksBeforeFailure) {
        emitted += 1;
        this.push(Buffer.from('x'));
        return;
      }
      this.destroy(error);
    },
  });
}

function stubLogger(): Logger & { debug: jest.Mock; error: jest.Mock } {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger & { debug: jest.Mock; error: jest.Mock };
}

describe('pipeToResponse', () => {
  it('copies every byte of the source into the response', async () => {
    const source = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    const response = new FakeResponse();
    const logger = stubLogger();

    await pipeToResponse(
      source,
      response as unknown as Response,
      logger,
      'clip',
    );

    expect(Buffer.concat(response.chunks).toString()).toBe('abcd');
    expect(response.writableFinished).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rethrows a storage failure that happens before any header is sent', async () => {
    const failure = new Error('storage unavailable');
    const source = failingSource(failure, 0);
    const response = new FakeResponse();
    const logger = stubLogger();

    await expect(
      pipeToResponse(source, response as unknown as Response, logger, 'clip'),
    ).rejects.toBe(failure);

    expect(source.destroyed).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a storage failure after headers are sent and truncates the response', async () => {
    const failure = new Error('connection reset by storage');
    const source = failingSource(failure, 2);
    const response = new FakeResponse();
    const logger = stubLogger();

    await expect(
      pipeToResponse(source, response as unknown as Response, logger, 'clip'),
    ).resolves.toBeUndefined();

    expect(response.headersSent).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(response.writableFinished).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('connection reset by storage'),
    );
  });

  it('destroys the storage stream when the client disconnects mid-stream', async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(1024, 'x'));
      },
    });
    const response = new FakeResponse((chunk) => {
      if (response.chunks.length === 3) {
        response.destroy();
      }
      return chunk;
    });
    const logger = stubLogger();

    await expect(
      pipeToResponse(source, response as unknown as Response, logger, 'clip'),
    ).resolves.toBeUndefined();

    expect(source.destroyed).toBe(true);
    expect(source.readableEnded).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Client disconnected'),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats a reset socket as a client disconnect rather than a failure', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    const source = Readable.from([Buffer.from('x')]);
    const response = new FakeResponse();
    const logger = stubLogger();
    const pending = pipeToResponse(
      source,
      response as unknown as Response,
      logger,
      'clip',
    );
    response.destroy(reset);

    await expect(pending).resolves.toBeUndefined();

    expect(source.destroyed).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Client disconnected'),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
