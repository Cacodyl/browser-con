import { setTimeout as delay } from 'node:timers/promises';
import type { CDP } from './cdp.js';
import type { Decision } from '../types.js';
import { assertFresh, StaleSnapshotError, type Observation } from './snapshot.js';

export async function execute(cdp: CDP, observed: Observation, decision: Decision, text?: string, signal?: AbortSignal): Promise<void> {
  const { operation, target } = decision;
  const field = observed.snapshot.targets.find(t => t.id === target?.split(':')[0]);
  if (['CLICK', 'TYPE_TEXT', 'SELECT', 'ENTER'].includes(operation)) {
    if (!field || !field.operations.includes(operation)) throw new Error('Unsupported target/operation');
    if (operation !== 'SELECT' && target !== field.id) throw new Error('Invalid target');
    if (operation === 'SELECT' && !field.options.some(o => o.id === target)) throw new Error('Unknown option');
    if (operation === 'TYPE_TEXT' && (typeof text !== 'string' || text.length > 2000)) throw new Error('Invalid field value');
  }
  signal?.throwIfAborted();
  await assertFresh(cdp, observed);
  signal?.throwIfAborted();
  if (operation === 'WAIT') { await delay(250, undefined, { signal }); return; }
  if (operation === 'SCROLL_UP' || operation === 'SCROLL_DOWN') {
    await cdp.evaluate(`window.scrollBy(0, ${operation === 'SCROLL_UP' ? -1 : 1} * innerHeight * 0.8)`);
    return;
  }
  if (operation === 'DONE' || operation === 'BLOCKED') return;
  if (!field) throw new Error('Missing target');
  // Resolve current geometry from the original node, rejecting detached/covered controls.
  const point = await cdp.call<{ x: number; y: number } | null>(observed.objectId, `function(id) {
    const node = this.nodes[id];
    if (!node?.isConnected || node.matches(':disabled,[aria-disabled="true"]')) return null;
    const r = node.getBoundingClientRect();
    const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
    const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
    const top = document.elementFromPoint(x, y);
    return r.width && r.height && top && (top === node || node.contains(top)) ? { x, y } : null;
  }`, [field.id]);
  if (!point) throw new StaleSnapshotError('Target is detached or covered');
  signal?.throwIfAborted();
  if (operation === 'CLICK') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  } else if (operation === 'SELECT') {
    await cdp.call(observed.objectId, `function(id, index) {
      const node = this.nodes[id]; node.selectedIndex = index;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }`, [field.id, Number(target!.split(':')[1])]);
  } else {
    await cdp.call(observed.objectId, `function(id, select) {
      const node = this.nodes[id]; node.focus();
      if (document.activeElement !== node) throw new Error('Target could not receive focus');
      if (select) {
        if (node.isContentEditable) { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
        else if (typeof node.select === 'function') node.select();
      }
    }`, [field.id, operation === 'TYPE_TEXT']);
    if (operation === 'TYPE_TEXT') {
      if (text === '') {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      } else await cdp.send('Input.insertText', { text });
    }
    else {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
  }
}
