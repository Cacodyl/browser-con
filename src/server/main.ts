import { readFile } from 'node:fs/promises';
import { createControlServer } from './app.js';

async function main() {
  const app = createControlServer({
    key: await readFile(process.env.TLS_KEY ?? '.certs/localhost-key.pem'),
    cert: await readFile(process.env.TLS_CERT ?? '.certs/localhost.pem'),
  });
  const port = Number(process.env.PORT ?? 3443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
  console.log(`Brocon control panel: https://localhost:${port}`);
  console.log('Local TLS certificate: trust .certs/localhost.pem or use TLS_KEY/TLS_CERT for your own certificate.');
  let closing = false;
  const stop = () => { if (closing) return; closing = true; void app.close().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
