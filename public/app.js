const $ = id => document.getElementById(id);
let config, currentRun, source, events = [], follow = true, selectedAttempt = 0;
const attempts = new Map();
const activeStatuses = new Set(['starting', 'running', 'stopping']);
const titles = {
  'run.started': 'Run created', 'browser.ready': 'Browser connected', snapshot: 'DOM observed',
  'decision.request': 'Decision space sent', 'decision.response': 'Scores received', decision: 'Action selected',
  'text.request': 'Text model called', 'text.ready': 'Field value ready', 'action.started': 'Validating action',
  'action.executed': 'Action executed', step: 'Page checked', stale: 'Snapshot became stale',
  'run.stopping': 'Stop requested', 'run.finished': 'Run finished',
};
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': config.token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function setBusy(busy) {
  $('start').disabled = busy || !config?.configured;
  $('demo').disabled = busy;
  $('stop').disabled = !busy;
}
async function refreshRuns() {
  const runs = await api('/api/runs');
  $('runs').replaceChildren();
  if (!runs.length) $('runs').append(node('p', 'Your runs will appear here.', 'empty-small'));
  for (const run of runs) {
    const button = node('button', run.demo ? 'Local form demo' : run.goal.slice(0, 70));
    button.append(node('span', `${run.status.replaceAll('_', ' ')} · ${new Date(run.createdAt).toLocaleTimeString()}`));
    button.addEventListener('click', () => selectRun(run));
    $('runs').append(button);
  }
  // An older selected trace must not unlock the start button while another run is active.
  const active = runs.find(run => activeStatuses.has(run.status));
  $('start').disabled = !!active || !config?.configured;
  $('demo').disabled = !!active;
  $('stop').disabled = !currentRun || !activeStatuses.has(currentRun.status);
  return runs;
}
function selectRun(run) {
  source?.close(); currentRun = run; events = []; attempts.clear(); follow = true; selectedAttempt = 0;
  $('timeline').replaceChildren(); $('event-count').textContent = '0 EVENTS';
  $('attempt-select').replaceChildren(node('option', 'No attempts yet'));
  $('run-goal').textContent = run.goal; $('run-status').textContent = run.status.replaceAll('_', ' ');
  $('demo-notice').hidden = !run.demo; $('download').hidden = false;
  $('download').href = `/api/runs/${run.id}/trace`;
  for (const id of ['stat-attempt', 'stat-controls', 'stat-latency', 'stat-action']) $(id).textContent = '—';
  renderInspector(); setBusy(activeStatuses.has(run.status));
  source = new EventSource(`/api/runs/${run.id}/events`);
  source.addEventListener('progress', event => {
    const entry = JSON.parse(event.data);
    if (events.some(existing => existing.id === entry.id)) return;
    events.push(entry); receive(entry);
  });
  source.onopen = () => { $('connection').textContent = 'Local service connected'; };
  source.onerror = () => { if (events.at(-1)?.type !== 'run.finished') $('connection').textContent = 'Reconnecting to event stream…'; };
  void refreshRuns().catch(e => error(e.message));
}
function receive(entry) {
  const data = entry.data || {};
  if (entry.attempt) {
    let attempt = attempts.get(entry.attempt);
    if (!attempt) {
      attempt = { events: [] }; attempts.set(entry.attempt, attempt);
      if (attempts.size === 1) $('attempt-select').replaceChildren();
      const option = node('option', `Attempt ${entry.attempt}`); option.value = String(entry.attempt); $('attempt-select').append(option);
    }
    attempt.events.push(entry);
    attempt[entry.type] = data;
    if (follow) selectedAttempt = entry.attempt;
    $('attempt-select').value = String(selectedAttempt);
    $('stat-attempt').textContent = String(entry.attempt).padStart(2, '0');
  }
  if (entry.type === 'snapshot') $('stat-controls').textContent = data.targets.length;
  if (entry.type === 'decision.response') $('stat-latency').textContent = `${Math.round(data.latencyMs)} ms`;
  if (entry.type === 'decision') $('stat-action').textContent = `${data.operation}${data.target ? ' [' + data.target + ']' : ''}`;
  if (entry.type === 'browser.ready') { currentRun.status = 'running'; $('run-status').textContent = 'Browser is working'; }
  if (entry.type === 'run.stopping') { currentRun.status = 'stopping'; $('run-status').textContent = 'Stopping…'; $('stop').disabled = true; }
  if (entry.type === 'run.finished') {
    source.close(); currentRun.status = data.status;
    $('run-status').textContent = data.status === 'done' ? data.verified ? 'Goal verified' : 'Done · outcome unverified' : data.status.replaceAll('_', ' ');
    setBusy(false); $('connection').textContent = 'Local service connected';
    if (data.message) error(data.message);
    if (data.traceError) error(data.traceError);
    void refreshRuns().catch(e => error(e.message));
  }
  const timeline = $('timeline');
  const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
  const item = node('div', undefined, 'event'); item.dataset.kind = entry.type;
  const top = node('div', undefined, 'event-top');
  top.append(node('span', titles[entry.type] || entry.type, 'event-title'), node('span', new Date(entry.time).toLocaleTimeString(), 'event-time'));
  item.append(top, node('p', detail(entry), 'event-detail')); timeline.append(item);
  if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  $('event-count').textContent = `${events.length} EVENTS`;
  renderInspector();
}
function detail(entry) {
  const d = entry.data || {};
  switch (entry.type) {
    case 'run.started': return d.demo ? 'Local fixture · no model API calls' : d.url;
    case 'browser.ready': return `CDP → ${d.url}`;
    case 'snapshot': return `${d.targets.length} visible controls · ${d.title}`;
    case 'decision.request': return `${Object.keys(d.questions).length} question heads · ${d.model}`;
    case 'decision.response': return `${Math.round(d.latencyMs)} ms · ${d.model}`;
    case 'decision': return `${d.operation}${d.target ? ' [' + d.target + ']' : ''} · confidence ${(d.confidence * 100).toFixed(1)}%`;
    case 'text.request': return `Field [${d.target}] ${d.label}`;
    case 'text.ready': return `${d.characters} characters prepared · value redacted`;
    case 'action.started': return `Checking freshness and target for ${d.operation}`;
    case 'action.executed': return `${d.operation}${d.target ? ' [' + d.target + ']' : ''} · ${Math.round(d.latencyMs)} ms`;
    case 'step': return d.changed ? 'Page state changed after action' : 'No observed page change';
    case 'run.finished': return d.message || `${d.status} · ${d.steps ?? 0} steps · ${d.verified ? 'independently verified' : 'not independently verified'}`;
    default: return d.message || '';
  }
}
function scoreRows(answer, criteria, isExecutedHead) {
  const container = node('div');
  if (!answer?.probabilities) { container.append(node('p', 'No scores for this head.', 'empty-small')); return container; }
  for (const [id, probability] of Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])) {
    const row = node('div', undefined, `score${id === answer.choice ? ' selected' : ''}`);
    const label = criteria?.[id];
    const description = typeof label === 'object' ? label.label || `${label.field} → ${label.option}` : '';
    const name = node('div', `${id}${description ? ' · ' + description : ''}`, 'name');
    const bar = node('div', undefined, 'bar'); const fill = node('div', undefined, 'fill');
    // A finite clamped number only; model output never becomes markup or executable content.
    const percentage = Number.isFinite(probability) ? Math.max(0, Math.min(100, probability * 100)) : 0;
    fill.style.setProperty('--score', `${percentage}%`); bar.append(fill); name.append(bar);
    row.append(name, node('span', `${percentage.toFixed(1)}%`, 'number')); container.append(row);
  }
  container.append(node('p', `${isExecutedHead ? 'Selected head' : 'Speculative head — does not execute'} · reported confidence ${(Number(answer.confidence) * 100).toFixed(1)}%`, 'score-note'));
  return container;
}
function renderInspector() {
  const attempt = attempts.get(selectedAttempt), scores = $('scores'), snapshot = $('snapshot');
  scores.replaceChildren(); snapshot.replaceChildren();
  if (!attempt) {
    scores.append(node('p', 'Jev’s operation and target probabilities will appear after a decision.', 'empty-small'));
    snapshot.append(node('p', 'Waiting for the first observation.', 'empty-small'));
    $('raw').replaceChildren(node('pre', JSON.stringify(events, null, 2))); return;
  }
  const request = attempt['decision.request'], response = attempt['decision.response'];
  if (!response) scores.append(node('p', request ? 'Waiting for model scores…' : 'Preparing the decision space…', 'empty-small'));
  else {
    scores.append(node('div', response.model, 'model-tag'), node('h3', 'Operation probabilities'));
    scores.append(scoreRows(response.answers.operation, request?.questions.operation.criteria, true));
    const heads = Object.keys(response.answers).filter(head => head !== 'operation');
    if (heads.length) {
      scores.append(node('h3', 'Target probabilities'));
      const select = node('select', undefined, 'head-select'); select.setAttribute('aria-label', 'Target question head');
      for (const head of heads) { const option = node('option', head + (head === response.selectedHead ? ' · selected' : ' · speculative')); option.value = head; select.append(option); }
      select.value = heads.includes(response.selectedHead) ? response.selectedHead : heads[0];
      const targets = node('div');
      const update = () => targets.replaceChildren(scoreRows(response.answers[select.value], request?.questions[select.value]?.criteria, select.value === response.selectedHead));
      select.addEventListener('change', update); update(); scores.append(select, targets);
    }
    scores.append(node('p', 'Probabilities rank candidates within one question. Confidence is the provider’s separate score, not a guarantee of success.', 'score-note'));
  }
  const page = attempt.snapshot;
  if (page) {
    snapshot.append(node('h3', page.title || 'Untitled page'), node('p', page.url, 'page-url'));
    for (const target of page.targets) {
      const control = node('div', undefined, 'control');
      control.append(node('strong', `[${target.id}] ${target.label}`), node('small', `${target.role} · ${target.operations.join(' / ')}`), node('small', `Value: ${target.value || '(empty)'}`));
      if (target.options.length) control.append(node('small', target.options.map(option => `[${option.id}] ${option.label}`).join(' · ')));
      snapshot.append(control);
    }
    const text = node('details'); text.append(node('summary', 'Observed page text'), node('pre', page.text)); snapshot.append(text);
  }
  $('raw').replaceChildren(node('pre', JSON.stringify(attempt.events, null, 2)));
}
$('attempt-select').addEventListener('change', event => { selectedAttempt = Number(event.target.value); follow = selectedAttempt === Math.max(...attempts.keys()); renderInspector(); });
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); });
  for (const id of ['scores', 'snapshot', 'raw']) $(id).hidden = id !== button.dataset.tab;
}));
async function start(demo) {
  error(); setBusy(true);
  try { selectRun(await api('/api/runs', { demo, url: $('url').value, goal: $('goal').value, maxSteps: Number($('maxSteps').value) })); }
  catch (e) { error(e.message); setBusy(false); await refreshRuns().catch(() => {}); }
}
$('run-form').addEventListener('submit', event => { event.preventDefault(); void start(false); });
$('demo').addEventListener('click', () => void start(true));
$('stop').addEventListener('click', async () => { $('stop').disabled = true; try { await api(`/api/runs/${currentRun.id}/stop`, {}); } catch (e) { error(e.message); $('stop').disabled = false; } });
(async () => {
  try {
    config = await api('/api/config');
    $('connection').textContent = 'Local service connected';
    $('provider-status').textContent = config.configured ? 'Models configured. Ready for a live browser run.' : 'Add model credentials to .env for live runs. The local demo works without API keys.';
    setBusy(false);
    const runs = await refreshRuns(); if (runs[0]) selectRun(runs[0]);
  } catch (e) { error(e.message); $('connection').textContent = 'Service unavailable'; $('start').disabled = true; $('demo').disabled = true; }
})();
