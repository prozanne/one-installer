/**
 * http-fake.ts
 *
 * In-process HTTP server that serves a directory tree.
 * Supports: HTTP Range, ETag (sha256 of content), If-None-Match (304),
 * optional fault injection (reset-mid-stream).
 */
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

export type FaultSpec =
  | {
      on: string; // e.g. 'GET /apps/com.samsung.vdx.exampleapp/1.0.0/payload.zip'
      kind: 'reset-mid-stream';
      atByte: number;
    }
  | {
      on: string;
      /**
       * Server receives a Range request but ignores it and returns the full file
       * with status 200. Used to verify HttpMirrorSource refuses such responses
       * rather than silently corrupting a resume.
       */
      kind: 'ignore-range-return-200';
    };

export interface RequestLogEntry {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  statusCode: number;
}

export interface HttpFakeServer {
  baseUrl: string;
  close(): Promise<void>;
  injectFault(spec: FaultSpec): void;
  clearFaults(): void;
  requestLog: RequestLogEntry[];
}

function computeEtag(buf: Buffer): string {
  return '"' + createHash('sha256').update(buf).digest('hex').slice(0, 32) + '"';
}

function parseRange(rangeHeader: string, totalSize: number): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!m) return null;
  const start = parseInt(m[1]!, 10);
  const end = m[2] ? parseInt(m[2]!, 10) + 1 : totalSize;
  if (start >= totalSize || start > end) return null;
  return { start, end: Math.min(end, totalSize) };
}

export function createHttpFake(rootDir: string): Promise<HttpFakeServer> {
  return new Promise((resolve, reject) => {
    const faults: FaultSpec[] = [];
    const requestLog: RequestLogEntry[] = [];

    const server = http.createServer((req, res) => {
      const method = req.method ?? 'GET';
      const urlPath = (req.url ?? '/').split('?')[0]!;

      // Check for fault injection
      const faultKey = `${method} ${urlPath}`;
      const fault = faults.find((f) => f.on === faultKey);

      // Map URL to file system path
      const filePath = path.join(rootDir, urlPath);

      let fileContent: Buffer;
      try {
        fileContent = fs.readFileSync(filePath);
      } catch {
        const entry: RequestLogEntry = { method, url: urlPath, headers: req.headers, statusCode: 404 };
        requestLog.push(entry);
        res.writeHead(404);
        res.end();
        return;
      }

      const etag = computeEtag(fileContent);
      const ifNoneMatch = req.headers['if-none-match'];

      // Handle ETag conditional
      if (ifNoneMatch && ifNoneMatch === etag) {
        const entry: RequestLogEntry = { method, url: urlPath, headers: req.headers, statusCode: 304 };
        requestLog.push(entry);
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }

      const rangeHeader = req.headers['range'];
      let statusCode = 200;
      let responseBody = fileContent;
      const headers: Record<string, string | number> = {
        ETag: etag,
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
      };

      if (rangeHeader && fault?.kind === 'ignore-range-return-200') {
        // Misbehaving server: ignore Range, serve full file with status 200.
        statusCode = 200;
        responseBody = fileContent;
        headers['Content-Length'] = fileContent.length;
      } else if (rangeHeader) {
        const range = parseRange(rangeHeader, fileContent.length);
        if (!range) {
          const entry: RequestLogEntry = { method, url: urlPath, headers: req.headers, statusCode: 416 };
          requestLog.push(entry);
          res.writeHead(416);
          res.end();
          return;
        }
        statusCode = 206;
        responseBody = fileContent.slice(range.start, range.end);
        headers['Content-Range'] = `bytes ${range.start}-${range.end - 1}/${fileContent.length}`;
        headers['Content-Length'] = responseBody.length;
      } else {
        headers['Content-Length'] = fileContent.length;
      }

      const entry: RequestLogEntry = { method, url: urlPath, headers: req.headers, statusCode };
      requestLog.push(entry);

      if (fault && fault.kind === 'reset-mid-stream') {
        // Write headers then destroy the socket mid-stream
        res.writeHead(statusCode, headers);
        const atByte = Math.min(fault.atByte, responseBody.length);
        res.write(responseBody.slice(0, atByte), () => {
          req.socket?.destroy();
        });
        return;
      }

      res.writeHead(statusCode, headers);
      res.end(responseBody);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close(): Promise<void> {
          return new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
        },
        injectFault(spec: FaultSpec): void {
          faults.push(spec);
        },
        clearFaults(): void {
          faults.length = 0;
        },
        requestLog,
      });
    });

    server.on('error', reject);
  });
}
