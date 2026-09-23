import assert from 'node:assert/strict';
import { openBrowser, getDOMSnapshot, StaleSnapshotError } from '../src/index.js';
import { execute } from '../src/browser/execute.js';
import { serveFixture } from '../examples/fixture.js';

const fixture = await serveFixture();
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
try {
  browser = await openBrowser({ ...(process.env.CHROME_PATH ? { executable: process.env.CHROME_PATH } : {}) });
  const cdp = browser.cdp;
  await cdp.navigate(fixture.url);
  const observed = await getDOMSnapshot(cdp);
  try {
    const name = observed.snapshot.targets.find(t => t.label === 'Name')!;
    assert.ok(name);
    await cdp.evaluate('document.querySelector("input").value = "Changed"');
    await assert.rejects(() => execute(cdp, observed, { operation: 'TYPE_TEXT', target: name.id, confidence: 1 }, 'Wrong'), StaleSnapshotError);
    assert.equal(await cdp.evaluate('document.querySelector("input").value'), 'Changed');
  } finally { await observed.dispose(); }
  const current = await getDOMSnapshot(cdp);
  try {
    const name = current.snapshot.targets.find(t => t.label === 'Name')!;
    await execute(cdp, current, { operation: 'TYPE_TEXT', target: name.id, confidence: 1 }, '');
    assert.equal(await cdp.evaluate('document.querySelector("input").value'), '');
  } finally { await current.dispose(); }
  const replaced = await getDOMSnapshot(cdp);
  try {
    await cdp.evaluate('document.querySelector("input").replaceWith(document.querySelector("input").cloneNode(true))');
    await assert.rejects(() => execute(cdp, replaced, { operation: 'DONE', confidence: 1 }), StaleSnapshotError);
  } finally { await replaced.dispose(); }
  console.log('Passed: stale value rejection, replacement-node rejection, empty-field clearing.');
} finally { await browser?.close(); await fixture.close(); }
