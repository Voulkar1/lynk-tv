/**
 * LYNK TV: the web backend as a Netlify Function.
 *
 * Serverless instances share no memory, so the in-memory provider target
 * registry is replaced by a sealed one: the target id IS the validated URL,
 * encrypted and authenticated with LYNK_TARGET_KEY (AES-256-GCM), plus the
 * time it was registered. Any instance can open it; nobody can forge one.
 *
 * Server storage and TV phone pairing need a long-running process and stay
 * off here; the desktop app or the Docker image provides those.
 */
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from 'node:crypto';
import { gzipSync } from 'node:zlib';
import serverless from 'serverless-http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ProviderTargetRegistry } from './app/provider-target-registry';
import { createWebBackendApp } from './app/web-backend-app';

const TTL_MS = 30 * 60_000;

function targetKey(): Buffer {
    const secret = process.env['LYNK_TARGET_KEY'];
    if (!secret || secret.length < 32) {
        throw new Error('LYNK_TARGET_KEY is not set (32+ characters).');
    }
    return createHash('sha256').update(secret).digest();
}

class SealedProviderTargets extends ProviderTargetRegistry {
    override register(url: URL): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', targetKey(), iv);
        const body = Buffer.concat([
            cipher.update(JSON.stringify({ u: url.href, t: Date.now() })),
            cipher.final(),
        ]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString(
            'base64url'
        );
    }

    override get(id: string): URL | undefined {
        try {
            const raw = Buffer.from(id, 'base64url');
            if (raw.length < 29) return undefined;
            const decipher = createDecipheriv(
                'aes-256-gcm',
                targetKey(),
                raw.subarray(0, 12)
            );
            decipher.setAuthTag(raw.subarray(12, 28));
            const plain = Buffer.concat([
                decipher.update(raw.subarray(28)),
                decipher.final(),
            ]).toString('utf8');
            const { u, t } = JSON.parse(plain) as { u: string; t: number };
            if (Date.now() - t >= TTL_MS) return undefined;
            return new URL(u);
        } catch {
            return undefined;
        }
    }
}

const backend = createWebBackendApp({
    storage: null,
    runtimeBackendUrl: '/api',
    providerTargets: new SealedProviderTargets(),
});

/**
 * Netlify caps a function response at 6 MB, so JSON (large parsed
 * playlists) is gzipped when the browser accepts it.
 */
function gzipJson(req: Request, res: Response, next: NextFunction): void {
    if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
        next();
        return;
    }
    const send = res.send.bind(res);
    res.send = ((body?: unknown) => {
        const type = String(res.getHeader('content-type') ?? '');
        if (
            (typeof body === 'string' || Buffer.isBuffer(body)) &&
            /json/.test(type) &&
            Buffer.byteLength(body as string) > 1024
        ) {
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            return send(gzipSync(body as string, { level: 9 }));
        }
        return send(body as never);
    }) as typeof res.send;
    next();
}

// Requests arrive as /api/<route>.
const strip = (req: Request, _res: Response, next: NextFunction) => {
    req.url =
        req.url.replace(/^\/(?:\.netlify\/functions\/api|api)(?=\/|\?|$)/, '') ||
        '/';
    if (!req.url.startsWith('/')) req.url = '/' + req.url;
    // serverless-http pre-fills req.body with the raw Buffer, which makes the
    // routes' JSON parsers skip the request: parse it here instead.
    const raw = (req as { body?: unknown }).body;
    if (Buffer.isBuffer(raw)) {
        const type = String(req.headers['content-type'] ?? '');
        try {
            (req as { body?: unknown }).body =
                /json/.test(type) && raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
        } catch {
            (req as { body?: unknown }).body = undefined;
        }
    }
    next();
};

const app = express();
app.disable('x-powered-by');
app.use(strip, gzipJson, backend);

const lambda = serverless(app as never, {
    binary: (headers: Record<string, unknown>) =>
        String(headers['content-encoding'] ?? '') === 'gzip',
});

interface LambdaResult {
    statusCode: number;
    headers?: Record<string, string | number | boolean>;
    multiValueHeaders?: Record<string, (string | number | boolean)[]>;
    body?: string;
    isBase64Encoded?: boolean;
}

/**
 * Netlify Functions v2 entry. The body goes back as a stream: a buffered
 * function response is capped at 6 MB, a streamed one at 20 MB, and large
 * Xtream catalogs (get_vod_streams, get_series) exceed the first.
 */
export default async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    const multi: Record<string, string[]> = {};
    url.searchParams.forEach((value, key) => {
        query[key] = value;
        (multi[key] ??= []).push(value);
    });
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    const raw =
        request.method === 'GET' || request.method === 'HEAD'
            ? null
            : Buffer.from(await request.arrayBuffer());

    const result = (await lambda(
        {
            httpMethod: request.method,
            path: url.pathname,
            headers,
            queryStringParameters: Object.keys(query).length ? query : null,
            multiValueQueryStringParameters: Object.keys(multi).length ? multi : null,
            body: raw && raw.length ? raw.toString('base64') : null,
            isBase64Encoded: Boolean(raw && raw.length),
        },
        {}
    )) as LambdaResult;

    const out = new Headers();
    for (const [k, v] of Object.entries(result.headers ?? {})) out.set(k, String(v));
    for (const [k, vs] of Object.entries(result.multiValueHeaders ?? {}))
        for (const v of vs) out.append(k, String(v));
    out.delete('content-length');

    const bytes = Buffer.from(
        result.body ?? '',
        result.isBase64Encoded ? 'base64' : 'utf8'
    );
    const body =
        request.method === 'HEAD' || result.statusCode === 204 || result.statusCode === 304
            ? null
            : new ReadableStream<Uint8Array>({
                  start(controller) {
                      const chunk = 256 * 1024;
                      for (let i = 0; i < bytes.length; i += chunk)
                          controller.enqueue(new Uint8Array(bytes.subarray(i, i + chunk)));
                      controller.close();
                  },
              });
    return new Response(body, { status: result.statusCode, headers: out });
}

export const config = { path: ['/api', '/api/*'] };
