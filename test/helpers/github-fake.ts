/**
 * github-fake.ts
 *
 * Minimal in-process HTTP server mimicking GitHub Releases v3 API.
 *
 * Supports:
 *   GET /repos/:org/:repo/releases/latest
 *   GET /repos/:org/:repo/releases/tags/:tag
 *   GET /repos/:org/:repo/releases/assets/:id
 *   GET /:org/:repo/releases/download/:tag/:asset  (CDN download)
 *
 * PAT authentication: if `requireAuth` is true, returns 401 without Authorization.
 * Rate-limit simulation: `injectRateLimit()` makes next call return 403 + rate-limit headers.
 */
import * as http from 'node:http';

export interface FakeAsset {
  id: number;
  name: string;
  content: Buffer;
}

export interface FakeRelease {
  tag_name: string;
  assets: FakeAsset[];
}

export interface RateLimitSpec {
  resetAtSec?: number;
  useDocumentationUrl?: boolean; // put rate-limit in documentation_url instead of headers
}

export interface GitHubFakeServer {
  baseUrl: string;
  close(): Promise<void>;
  addRelease(release: FakeRelease): void;
  injectRateLimit(spec?: RateLimitSpec): void;
  clearRateLimit(): void;
  requestLog: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
}

export function createGitHubFake(opts?: {
  requireAuth?: boolean;
  privateRepo?: boolean;
}): Promise<GitHubFakeServer> {
  return new Promise((resolve, reject) => {
    const releases: FakeRelease[] = [];
    const requestLog: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
    let rateLimitSpec: RateLimitSpec | null = null;
    const requireAuth = opts?.requireAuth ?? false;

    const server = http.createServer((req, res) => {
      const method = req.method ?? 'GET';
      const urlStr = req.url ?? '/';
      requestLog.push({ method, url: urlStr, headers: req.headers });

      // Check auth
      const authHeader = req.headers['authorization'];
      if (requireAuth && !authHeader?.startsWith('Bearer ') && !authHeader?.startsWith('token ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' }));
        return;
      }

      // Check rate limit
      if (rateLimitSpec !== null) {
        const spec = rateLimitSpec;
        rateLimitSpec = null; // consume
        const resetAt = spec.resetAtSec ?? Math.floor(Date.now() / 1000) + 3600;

        if (spec.useDocumentationUrl) {
          // GitHub returns 403 with documentation_url containing "rate-limit"
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetAt),
          });
          res.end(JSON.stringify({
            message: 'API rate limit exceeded',
            documentation_url: 'https://docs.github.com/en/rest/overview/rate-limit',
          }));
        } else {
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetAt),
          });
          res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
        }
        return;
      }

      const json = (statusCode: number, data: unknown) => {
        const body = JSON.stringify(data);
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      };

      // Route: GET /repos/:org/:repo/releases/tags/:tag
      let m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/([^/]+)$/.exec(urlStr);
      if (m) {
        const tag = decodeURIComponent(m[3]!);
        const release = releases.find((r) => r.tag_name === tag);
        if (!release) {
          json(404, { message: 'Not Found' });
          return;
        }
        json(200, serializeRelease(release));
        return;
      }

      // Route: GET /repos/:org/:repo/releases/latest
      m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/latest$/.exec(urlStr);
      if (m) {
        const latest = releases[0];
        if (!latest) {
          json(404, { message: 'Not Found' });
          return;
        }
        json(200, serializeRelease(latest));
        return;
      }

      // Route: GET /repos/:org/:repo/releases  (list)
      m = /^\/repos\/([^/]+)\/([^/]+)\/releases(\?.*)?$/.exec(urlStr);
      if (m) {
        json(200, releases.map(serializeRelease));
        return;
      }

      // Route: CDN download /:org/:repo/releases/download/:tag/:asset
      m = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(urlStr);
      if (m) {
        const tag = decodeURIComponent(m[3]!);
        const assetName = decodeURIComponent(m[4]!);
        const release = releases.find((r) => r.tag_name === tag);
        const asset = release?.assets.find((a) => a.name === assetName);
        if (!asset) {
          json(404, { message: 'Not Found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': asset.content.length,
        });
        res.end(asset.content);
        return;
      }

      json(404, { message: 'Not Found' });
    });

    function serializeRelease(r: FakeRelease) {
      return {
        tag_name: r.tag_name,
        assets: r.assets.map((a) => ({
          id: a.id,
          name: a.name,
          browser_download_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/${a.name.replace(/^.*\//, '')}.../${r.tag_name}/${a.name}`,
        })),
      };
    }

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;

      // Rebuild download URLs now that we have a port
      function buildDownloadUrl(relTag: string, assetName: string): string {
        return `http://127.0.0.1:${port}/org/repo/releases/download/${relTag}/${assetName}`;
      }

      // Override serializeRelease to use port
      function serializeReleaseFinal(r: FakeRelease) {
        return {
          tag_name: r.tag_name,
          assets: r.assets.map((a) => ({
            id: a.id,
            name: a.name,
            browser_download_url: buildDownloadUrl(r.tag_name, a.name),
          })),
        };
      }

      // Patch the server handler to use the correct port
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        const method = req.method ?? 'GET';
        const urlStr = req.url ?? '/';
        requestLog.push({ method, url: urlStr, headers: req.headers });

        const authHeader = req.headers['authorization'];
        if (requireAuth && !authHeader?.startsWith('Bearer ') && !authHeader?.startsWith('token ')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' }));
          return;
        }

        if (rateLimitSpec !== null) {
          const spec = rateLimitSpec;
          rateLimitSpec = null;
          const resetAt = spec.resetAtSec ?? Math.floor(Date.now() / 1000) + 3600;

          res.writeHead(403, {
            'Content-Type': 'application/json',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetAt),
          });
          if (spec.useDocumentationUrl) {
            res.end(JSON.stringify({
              message: 'API rate limit exceeded',
              documentation_url: 'https://docs.github.com/en/rest/overview/rate-limit',
            }));
          } else {
            res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
          }
          return;
        }

        const json = (statusCode: number, data: unknown) => {
          const body = JSON.stringify(data);
          res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          });
          res.end(body);
        };

        let m: RegExpExecArray | null;

        m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/([^/?]+)/.exec(urlStr);
        if (m) {
          const tag = decodeURIComponent(m[3]!);
          const release = releases.find((r) => r.tag_name === tag);
          if (!release) { json(404, { message: 'Not Found' }); return; }
          json(200, serializeReleaseFinal(release));
          return;
        }

        m = /^\/repos\/([^/]+)\/([^/]+)\/releases\/latest/.exec(urlStr);
        if (m) {
          const latest = releases[0];
          if (!latest) { json(404, { message: 'Not Found' }); return; }
          json(200, serializeReleaseFinal(latest));
          return;
        }

        m = /^\/repos\/([^/]+)\/([^/]+)\/releases(\?.*)?$/.exec(urlStr);
        if (m) {
          json(200, releases.map(serializeReleaseFinal));
          return;
        }

        // CDN download
        m = /^\/org\/repo\/releases\/download\/([^/]+)\/(.+)$/.exec(urlStr);
        if (m) {
          const tag = decodeURIComponent(m[1]!);
          const assetName = decodeURIComponent(m[2]!);
          const release = releases.find((r) => r.tag_name === tag);
          const asset = release?.assets.find((a) => a.name === assetName);
          if (!asset) { json(404, { message: 'Not Found' }); return; }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': asset.content.length });
          res.end(asset.content);
          return;
        }

        json(404, { message: 'Not Found' });
      });

      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close(): Promise<void> {
          return new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
        },
        addRelease(release: FakeRelease): void {
          releases.unshift(release); // newest first
        },
        injectRateLimit(spec?: RateLimitSpec): void {
          rateLimitSpec = spec ?? {};
        },
        clearRateLimit(): void {
          rateLimitSpec = null;
        },
        requestLog,
      });
    });

    server.on('error', reject);
  });
}
