import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CDP } from './cdp.js';

/** Launch an isolated Chrome profile, or create an owned tab on a supplied CDP endpoint. */
export async function openBrowser(options: { endpoint?: string; executable?: string; headless?: boolean } = {}) {
  let profile: string | undefined;
  let process: ReturnType<typeof spawn> | undefined;
  let endpoint = options.endpoint;
  let launchError: Error | undefined;
  let cdp: CDP | undefined;
  let targetId: string | undefined;
  const cleanup = async () => {
    cdp?.close();
    if (endpoint && targetId) await fetch(`${endpoint}/json/close/${targetId}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    if (process && process.exitCode === null) {
      const exited = new Promise<void>(resolve => process!.once('exit', () => resolve()));
      process.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (process.exitCode === null) { process.kill('SIGKILL'); await Promise.race([exited, delay(2000)]); }
    }
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    if (!endpoint) {
      profile = await mkdtemp(join(tmpdir(), 'brocon-'));
      const executable = options.executable ?? (globalThis.process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
      process = spawn(executable, [
        `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
        ...(options.headless === false ? [] : ['--headless=new']), 'about:blank',
      ], { stdio: 'ignore' });
      process.once('error', error => { launchError = error; });
      for (let i = 0; i < 100; i++) {
        if (launchError) throw launchError;
        if (process.exitCode !== null) throw new Error('Chrome exited during startup');
        const port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
        if (port) { endpoint = `http://127.0.0.1:${port.split('\n')[0]}`; break; }
        await delay(100);
      }
      if (!endpoint) throw new Error('Chrome startup timed out; set CHROME_PATH');
    }
    endpoint = endpoint.replace(/\/$/, '');
    const response = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
    const target = await response.json() as { id: string; webSocketDebuggerUrl: string };
    targetId = target.id;
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    return { cdp, close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}
