import { IncomingHttpHeaders, request } from 'http';

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}
