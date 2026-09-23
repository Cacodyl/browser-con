import type { CDP } from './cdp.js';
import type { Snapshot } from '../types.js';

// Runs inside the page in a single browser round trip. Nodes never go to a model.
function readDOM() {
  const nodes: Record<string, HTMLElement> = {};
  const visible = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight &&
      r.right > 0 && r.left < innerWidth && s.visibility === 'visible' && s.display !== 'none';
  };
  const targets: Snapshot['targets'] = [];
  const candidates = document.querySelectorAll<HTMLElement>(
    'a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="option"],[role="textbox"],[role="combobox"]',
  );
  for (const el of candidates) {
    if (targets.length >= 150) break;
    if (!visible(el) || el.matches(':disabled,[aria-disabled="true"],input[type="hidden"],input[type="file"],input[type="password"]')) continue;
    const input = el instanceof HTMLInputElement;
    const editable = (input && ['text', 'search', 'email', 'url', 'tel'].includes(el.type)) || el instanceof HTMLTextAreaElement || el.isContentEditable;
    const select = el instanceof HTMLSelectElement;
    const readonly = el.matches('[readonly],[aria-readonly="true"]');
    const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const labels = 'labels' in el ? Array.from((el as HTMLInputElement).labels ?? []).map(l => { const copy = l.cloneNode(true) as HTMLElement; copy.querySelectorAll('input,textarea,select,button').forEach(control => control.remove()); return copy.textContent ?? ''; }).join(' ') : '';
    const label = (el.getAttribute('aria-label') || labelled || labels || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('name') || el.tagName).trim().slice(0, 300);
    const id = String(targets.length + 1);
    nodes[id] = el;
    targets.push({
      id, label, role: el.getAttribute('role') || (input ? el.type : el.tagName.toLowerCase()),
      value: 'value' in el ? String(el.value).slice(0, 2000) : editable ? el.innerText.slice(0, 2000) : '',
      operations: select ? ['SELECT'] : editable && !readonly ? ['TYPE_TEXT', 'ENTER', 'CLICK'] : ['CLICK'],
      options: select ? Array.from(el.options).filter(o => !o.disabled && !(o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled)).slice(0, 100).map(o => ({ id: `${id}:${o.index}`, label: o.label, value: o.value })) : [],
      checked: input && ['checkbox', 'radio'].includes(el.type) ? el.checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : null,
    });
  }
  const text: string[] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let length = 0;
  while (walker.nextNode() && length < 12000) {
    const parent = walker.currentNode.parentElement;
    if (!parent || parent.closest('script,style,noscript,[hidden]') || !visible(parent)) continue;
    const value = walker.currentNode.textContent?.replace(/\s+/g, ' ').trim();
    if (value) { text.push(value); length += value.length; }
  }
  const snapshot: Snapshot = {
    url: location.href, title: document.title, text: text.join('\n').slice(0, 12000), targets,
    scrollY, canScrollDown: scrollY + innerHeight < document.documentElement.scrollHeight - 2,
  };
  return { snapshot, nodes };
}

export interface Observation {
  snapshot: Snapshot;
  objectId: string;
  dispose(): Promise<void>;
}
export async function getDOMSnapshot(cdp: CDP): Promise<Observation> {
  const remote = await cdp.evaluateRemote(`(${readDOM.toString()})()`);
  if (!remote.objectId) throw new Error('Snapshot did not return an object');
  const objectId = remote.objectId;
  try {
    const snapshot = await cdp.call<Snapshot>(objectId, 'function() { return this.snapshot; }');
    return { snapshot, objectId, dispose: async () => { await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {}); } };
  } catch (error) { await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {}); throw error; }
}
export class StaleSnapshotError extends Error {}
export async function assertFresh(cdp: CDP, observed: Observation): Promise<void> {
  const fresh = await getDOMSnapshot(cdp);
  try {
    if (JSON.stringify(fresh.snapshot) !== JSON.stringify(observed.snapshot)) {
      throw new StaleSnapshotError('Page changed; observe and decide again.');
    }
    const connected = await cdp.call<boolean>(observed.objectId, 'function() { return Object.values(this.nodes).every(node => node.isConnected); }');
    if (!connected) throw new StaleSnapshotError('Observed nodes were replaced.');
  } finally { await fresh.dispose(); }
}
