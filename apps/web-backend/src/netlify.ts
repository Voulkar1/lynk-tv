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
            return send(gzipSync(body as string));
        }
        return send(body as never);
    }) as typeof res.send;
    next();
}

// Requests arrive as /api/<route> (redirect) or /.netlify/functions/api/<route>.
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

export const handler = serverless(app as never, {
    binary: (headers: Record<string, unknown>) =>
        String(headers['content-encoding'] ?? '') === 'gzip',
});
