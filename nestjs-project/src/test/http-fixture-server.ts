import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  urlFor: (name: string) => string;
  close: () => Promise<void>;
}

// FFmpeg reads its input over HTTP in production (a presigned storage URL), and
// the protocol whitelist blocks file://, so tests serve their fixtures the same
// way instead of passing a local path.
export async function startFixtureServer(
  files: Record<string, Buffer>,
  contentType = 'application/octet-stream',
): Promise<FixtureServer> {
  const server: Server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').slice(1));
    const body = files[name];

    if (!body) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
    });
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    urlFor: (name) => `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
