import { IncomingHttpHeaders, request } from 'http';

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function httpRequest(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResponse> {
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }

  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers, agent: false },
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
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return httpRequest(port, 'GET', path, { headers });
}
