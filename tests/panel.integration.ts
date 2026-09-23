import assert from 'node:assert/strict';
import { request } from 'node:https';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createControlServer } from '../src/server/app.js';
import { RunService, type RunEvent } from '../src/server/runs.js';
import { openBrowser } from '../src/browser/chrome.js';

const cert = await readFile('.certs/localhost.pem');
const traceDir = await mkdtemp(join(tmpdir(), 'brocon-panel-test-'));
const env = { ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}) };
const app = createControlServer({ key: await readFile('.certs/localhost-key.pem'), cert }, new RunService(env, traceDir));
await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
const address = app.server.address();
assert.ok(address && typeof address !== 'string');
const origin = `https://127.0.0.1:${address.port}`;
let token = '';
function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(origin + path, { ca: cert, servername: 'localhost', method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-control-token': token }), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('Test request timeout')));
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const parseEvents = (text: string): RunEvent[] => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
let ui: Awaited<ReturnType<typeof openBrowser>> | undefined;
try {
  const config = JSON.parse((await call('/api/config')).text); token = config.token;
  assert.equal(config.configured, false);
  assert.equal((await call('/api/runs', { demo: true }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call('/api/runs', { demo: true }, { 'x-control-token': 'wrong' })).status, 403);
  assert.equal((await call('/api/config', undefined, { host: 'attacker.example' })).status, 403);
  assert.equal((await call('/api/runs', { url: 'javascript:alert(1)', goal: 'go' })).status, 400);
  assert.equal((await call('/api/runs', { url: 'https://example.com', goal: 'go' })).status, 400);
  const started = await call('/api/runs', { demo: true }); assert.equal(started.status, 202);
  const run = JSON.parse(started.text);
  assert.equal((await call('/api/runs', { demo: true })).status, 409);
  const stream = await call(`/api/runs/${run.id}/events`);
  const events = parseEvents(stream.text);
  assert.equal(events.at(-1)?.type, 'run.finished');
  assert.equal((events.at(-1)?.data as { verified: boolean }).verified, true);
  for (const type of ['snapshot', 'decision.request', 'decision.response', 'decision', 'text.request', 'text.ready', 'action.started', 'action.executed', 'step']) assert.ok(events.some(event => event.type === type), type);
  assert.ok(events.findIndex(event => event.type === 'action.executed') < events.findIndex(event => event.type === 'step'));
  const resume = await call(`/api/runs/${run.id}/events`, undefined, { 'last-event-id': String(events[5]!.id) });
  assert.deepEqual(parseEvents(resume.text).map(event => event.id), events.slice(6).map(event => event.id));
  const trace = await call(`/api/runs/${run.id}/trace`);
  assert.equal(trace.text, await readFile(join(traceDir, `${run.id}.jsonl`), 'utf8'));
  assert.ok(!trace.text.includes(token));
  const next = JSON.parse((await call('/api/runs', { demo: true })).text);
  await call(`/api/runs/${next.id}/stop`, {});
  const stopped = parseEvents((await call(`/api/runs/${next.id}/events`)).text);
  assert.equal((stopped.at(-1)?.data as { status: string }).status, 'cancelled');
  assert.ok(!stopped.some(event => event.type === 'action.executed'));

  // Exercise the actual panel in an isolated Chrome, including its fetch and EventSource paths.
  ui = await openBrowser({ ...(env.CHROME_PATH ? { executable: env.CHROME_PATH } : {}) });
  await ui.cdp.send('Security.setIgnoreCertificateErrors', { ignore: true }); // Only this test browser trusts the test certificate.
  await ui.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await ui.cdp.navigate(origin);
  for (let i = 0; i < 100; i++) {
    if (await ui.cdp.evaluate<boolean>('document.querySelector("#connection")?.textContent === "Local service connected" && !document.querySelector("#demo")?.disabled')) break;
    await delay(100);
  }
  assert.equal(await ui.cdp.evaluate('document.querySelector("#demo").disabled'), false);
  await ui.cdp.evaluate('document.querySelector("#demo").click()');
  for (let i = 0; i < 200; i++) {
    if (await ui.cdp.evaluate<boolean>('document.querySelector("#run-status")?.textContent === "Goal verified"')) break;
    await delay(100);
  }
  assert.equal(await ui.cdp.evaluate('document.querySelector("#run-status").textContent'), 'Goal verified');
  assert.equal(await ui.cdp.evaluate('document.querySelector("#error").hidden'), true);
  await ui.cdp.evaluate('document.querySelector("#attempt-select").value = "1"; document.querySelector("#attempt-select").dispatchEvent(new Event("change"))');
  assert.ok(await ui.cdp.evaluate<boolean>('document.querySelector("#scores").textContent.includes("TYPE_TEXT")'));
  assert.ok(await ui.cdp.evaluate<boolean>('document.querySelector("#scores").textContent.includes("synthetic")'));
  await mkdir('artifacts', { recursive: true });
  const screenshot = await ui.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/control-panel.png', Buffer.from(screenshot.data, 'base64'));
  await ui.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await ui.cdp.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth'));
  console.log('Passed: HTTPS validation, auth/origin guards, run exclusivity, live/replayed SSE, persisted traces, cancellation, and panel UI demo.');
} finally { await ui?.close(); await app.close(); await rm(traceDir, { recursive: true, force: true }); }
