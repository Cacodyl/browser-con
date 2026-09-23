import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { RunService, parseRunInput, RequestError, type RunEvent } from './runs.js';

export function createControlServer(tls: ServerOptions, service = new RunService()) {
  const token = randomBytes(32).toString('hex');
  const publicDir = fileURLToPath(new URL('../../../public/', import.meta.url));
  const clients = new Set<ServerResponse>();
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
  };
  const server = createServer(tls, (req, res) => { void handle(req, res).catch(error => {
    if (!res.headersSent) json(res, error instanceof RequestError ? error.status : 500, { error: error instanceof RequestError ? error.message : 'Local server error' });
    else res.end();
  }); });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const address = server.address();
    if (!address || typeof address === 'string') throw new RequestError(503, 'Server is not listening');
    const hosts = [`localhost:${address.port}`, `127.0.0.1:${address.port}`];
    if (!hosts.includes(req.headers.host ?? '')) throw new RequestError(403, 'Invalid local host');
    if (req.headers.origin && req.headers.origin !== `https://${req.headers.host}`) throw new RequestError(403, 'Cross-origin requests are not allowed');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Cross-site requests are not allowed');
    const url = new URL(req.url ?? '/', `https://${req.headers.host}`);
    if (req.method === 'POST') {
      if (req.headers['x-control-token'] !== token) throw new RequestError(403, 'Missing control token; reload the panel');
      if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(415, 'Use application/json');
    }
    if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const mime = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'content-type': `${mime}; charset=utf-8` });
      res.end(await readFile(`${publicDir}/${filename}`)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') { json(res, 200, { token, configured: service.configured }); return; }
    if (req.method === 'GET' && url.pathname === '/api/runs') { json(res, 200, service.list()); return; }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const input = parseRunInput(await readJSON(req));
      json(res, 202, service.start(input)); return;
    }
    const match = /^\/api\/runs\/([a-f0-9-]+)(?:\/(events|stop|trace))?$/.exec(url.pathname);
    if (!match) throw new RequestError(404, 'Route not found');
    const run = service.get(match[1]!);
    if (req.method === 'POST' && match[2] === 'stop') { service.stop(run.summary.id); json(res, 202, run.summary); return; }
    if (req.method !== 'GET') throw new RequestError(405, 'Method not allowed');
    if (!match[2]) { json(res, 200, run.summary); return; }
    if (match[2] === 'trace') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="brocon-${run.summary.id}.jsonl"` });
      res.end(run.events.map(event => JSON.stringify(event)).join('\n') + '\n'); return;
    }
    if (match[2] !== 'events') throw new RequestError(404, 'Route not found');
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new RequestError(400, 'Invalid event cursor');
    if (clients.size >= 20) throw new RequestError(429, 'Too many event streams');
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const queue: RunEvent[] = [];
    let draining = false;
    let terminal = false;
    const pump = () => {
      if (draining || res.destroyed || res.writableEnded) return;
      while (queue.length) {
        const event = queue.shift()!;
        const writable = res.write(`id: ${event.id}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'run.finished') terminal = true;
        if (!writable) {
          draining = true;
          res.once('drain', () => { draining = false; pump(); });
          return;
        }
      }
      if (terminal) res.end();
    };
    const send = (event: RunEvent) => { queue.push(event); pump(); };
    clients.add(res);
    service.updates.on(run.summary.id, send);
    for (const event of run.events) if (event.id > after) send(event);
    if (run.events.at(-1)?.type === 'run.finished') { terminal = true; pump(); }
    const heartbeat = setInterval(() => { if (!draining && !res.writableEnded) res.write(': heartbeat\n\n'); }, 15000);
    res.once('close', () => { clearInterval(heartbeat); clients.delete(res); service.updates.off(run.summary.id, send); });
  }
  return { server, service, async close() {
    await service.close();
    for (const client of clients) client.end();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
async function readJSON(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16384) throw new RequestError(413, 'Request too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RequestError(400, 'Invalid JSON'); }
}
