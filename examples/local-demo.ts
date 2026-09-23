import { openBrowser, runAgent, type DecisionProvider } from '../src/index.js';
import { serveFixture } from './fixture.js';

// Deterministic fixture-only providers exercise the entire CDP loop without paid APIs.
export const demoDecisions: DecisionProvider = {
  async decide({ snapshot }) {
    if (snapshot.text.includes('Submitted: Ada / demo')) return { operation: 'DONE', confidence: 1 };
    const name = snapshot.targets.find(t => t.label === 'Name');
    if (name && name.value !== 'Ada') return { operation: 'TYPE_TEXT', target: name.id, confidence: 1 };
    const topic = snapshot.targets.find(t => t.label === 'Topic');
    if (topic && topic.value !== 'demo') return { operation: 'SELECT', target: topic.options.find(o => o.value === 'demo')!.id, confidence: 1 };
    return { operation: 'CLICK', target: snapshot.targets.find(t => t.label === 'Send')!.id, confidence: 1 };
  },
};
async function main() {
  const fixture = await serveFixture();
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    browser = await openBrowser({ ...(process.env.CHROME_PATH ? { executable: process.env.CHROME_PATH } : {}) });
    await browser.cdp.navigate(fixture.url);
    const result = await runAgent('Submit the contact form for Ada with topic Demo.', {
      browser: browser.cdp, decisions: demoDecisions, text: { fill: async () => 'Ada' },
      verify: snapshot => snapshot.text.includes('Submitted: Ada / demo'),
      onStep: step => console.log(JSON.stringify(step)),
    });
    if (!result.verified) throw new Error(`Demo failed: ${result.status}`);
    console.log('Verified: local form filled, dropdown selected, form submitted via CDP.');
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
