import { parseArgs } from 'node:util';
import { openBrowser } from './browser/chrome.js';
import { runAgent } from './agent.js';
import { JevProvider } from './providers/jev.js';
import { TextModelProvider } from './providers/text.js';

async function main() {
  const { values } = parseArgs({ options: { url: { type: 'string' }, goal: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('npm start -- --url https://example.com --goal "Your browser goal"'); return; }
  if (!values.url || !values.goal) throw new Error('Provide --url and --goal (see --help)');
  const env = process.env;
  const decisions = new JevProvider({ apiKey: env.TYPESAFE_API_KEY ?? '', model: env.TYPESAFE_MODEL ?? 'jev-latest', url: env.TYPESAFE_URL ?? 'https://api.typesafe.ai/v1/systemone' });
  const text = new TextModelProvider({ apiKey: env.TEXT_MODEL_API_KEY ?? '', model: env.TEXT_MODEL ?? '', baseUrl: env.TEXT_MODEL_BASE_URL ?? 'https://openrouter.ai/api/v1' });
  const browser = await openBrowser({ ...(env.CDP_ENDPOINT ? { endpoint: env.CDP_ENDPOINT } : {}), ...(env.CHROME_PATH ? { executable: env.CHROME_PATH } : {}), headless: env.HEADLESS !== 'false' });
  try {
    await browser.cdp.navigate(values.url);
    const result = await runAgent(values.goal, { browser: browser.cdp, decisions, text, maxSteps: Number(env.MAX_STEPS ?? 30), onStep: step => console.log(JSON.stringify(step)) });
    console.log(JSON.stringify({ status: result.status, verified: result.verified, url: result.snapshot.url, steps: result.steps.length }));
    if (result.status !== 'done') process.exitCode = 1;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Run failed'); process.exitCode = 1; });
