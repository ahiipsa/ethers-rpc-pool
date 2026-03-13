import http from 'node:http';

export type TimeoutTestServer = {
  server: http.Server;
  port: number;
  baseUrl: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createTestServer(): TimeoutTestServer {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    const match = url.match(/^\/timeout\/(\d+)$/);

    if (match) {
      const delay = Number(match[1]);

      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, delay }));
      }, delay);

      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: 'Not found' }));
  });

  let port = 0;

  return {
    server,
    get port() {
      return port;
    },
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    start() {
      return new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();

          if (!address || typeof address === 'string') {
            reject(new Error('Failed to get server address'));
            return;
          }

          port = address.port;
          resolve();
        });

        server.once('error', reject);
      });
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });
    },
  };
}
