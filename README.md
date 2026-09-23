# Brocon

Node.js + TypeScript scaffold for a DOM-first browser agent using **direct Chrome DevTools Protocol (CDP)**. No Playwright or Puppeteer, and no runtime npm dependencies.

```text
Goal → getDOMSnapshot() → Jev operation + target
                              ↓ TYPE_TEXT only
                         Separate text LLM
                              ↓
                      Validate → CDP action → repeat
```

Jev selects from observed actions. The text model generates field values only. Model output never becomes executable JavaScript or CSS selectors.

## Control panel

```sh
npm run panel
```

Open **https://localhost:3443**. The command generates a local development certificate; trust `.certs/localhost.pem` or accept the browser's local certificate exception. No system trust settings are changed. To use your own certificate, set `TLS_KEY` and `TLS_CERT` in `.env`.

Enter a starting website and natural language goal, then start a run. Inspect the live timeline, observed controls, Jev operation/target scores, and raw events for any attempt. Stop a run or export its JSONL trace. **Try the local form demo** exercises the full control-panel → HTTPS → CDP path without credentials; its displayed scores are explicitly synthetic.

Live runs require the model settings described below. Traces persist under `artifacts/runs/`; the recent-run list holds the last ten runs from the current server process. Generated field values can appear in later DOM snapshots, so traces contain page data. See [architecture and API](docs/architecture.md) for the decision-space design, action execution, and why direct CDP is sufficient without Browser Harness.

## Setup

Requires Node.js 22+ and an installed Chrome/Chromium browser.

```sh
npm install
cp .env.example .env
npm run check
npm test
npm run test:browser
npm run test:panel
npm run demo
```

The demo launches headless Chrome with a temporary profile, serves a local contact form, fills it, chooses a dropdown option, submits it, and independently checks the result. Its deterministic providers need no API keys. On macOS the default executable is Google Chrome; elsewhere set `CHROME_PATH` (defaults to `google-chrome`). For the demo, export `CHROME_PATH` in your shell if needed.

For real model calls, configure `TYPESAFE_API_KEY`, `TEXT_MODEL_API_KEY`, `TEXT_MODEL_BASE_URL`, and `TEXT_MODEL` in `.env`:

```sh
npm start -- --url https://www.google.com --goal "Search for the official Node.js documentation and open it."
npm start -- --url https://your-test-site.example/form --goal "Fill the name with Ada and choose Demo as the topic."
```

Set `HEADLESS=false` to see Chrome. Each run uses an isolated temporary browser profile and closes it on normal completion. Set `CDP_ENDPOINT=http://127.0.0.1:9222` to use an existing debugging endpoint; Brocon creates and closes its own tab without terminating that browser. Chrome must already have remote debugging enabled with a non-default profile.

## Modules

| File | Responsibility |
| --- | --- |
| `src/browser/cdp.ts` | WebSocket request IDs, CDP calls, timeouts, disconnect cleanup |
| `src/browser/chrome.ts` | Chrome launch, endpoint discovery, owned tab lifecycle |
| `src/browser/snapshot.ts` | Single DOM evaluation collecting visible controls/text and retaining node references |
| `src/browser/execute.ts` | Freshness checks, target validation, hit testing, CDP mouse/keyboard/text events |
| `src/server/` | HTTPS API, browser-run service, SSE events, trace persistence |
| `public/` | Control panel and decision inspector |
| `src/providers/action-space.ts` | Dynamic compatible operation/target questions |
| `src/providers/jev.ts` | TypeSafe operation and target questions in one request; response validation |
| `src/providers/text.ts` | Configurable chat-completions text model, strict field-value JSON |
| `src/agent.ts` | Bounded observe/decide/act loop, timing callbacks, optional outcome verification |
| `examples/local-demo.ts` | API-free end-to-end example |

Import `openBrowser`, `getDOMSnapshot`, `runAgent`, `JevProvider`, and `TextModelProvider` from `src/index.ts` in TypeScript or `dist/src/index.js` after building. Provider interfaces are injectable for experiments. `getDOMSnapshot(cdp)` returns `{ snapshot, objectId, dispose }`; always dispose observations after use. Node references stay in Chrome; only serializable snapshots reach providers.

`runAgent(goal, { browser: cdp, decisions, text, maxSteps, onStep, verify })` returns status, final snapshot, steps, and `verified`. A model-selected `done` is a completion claim; `verified` is true only when your supplied verifier passes. The CLI and live panel runs do not supply a verifier; the local demo does. CLI step logs include timing and action IDs. Panel traces additionally record snapshots, decision criteria, and model scores. Page text and ordinary field values are still sent to the configured model providers.

## Current scope

Supports visible main-document links, buttons, text inputs, textareas, contenteditable fields, native selects, Enter, viewport scrolling, and waits. Password/file fields are excluded. Snapshots are capped at 150 controls and 12,000 text characters. Freshness checks reject changed snapshots and detached nodes before execution. Covered targets are rejected; stale retries count toward the run budget. Five consecutive unchanged steps stop the loop. Ambiguous input errors terminate instead of repeating actions.

This is an initial base, not a performance improvement claim. It does not yet handle frames, shadow roots, popups, downloads, uploads, nested scrolling, complex keyboard widgets, or complete accessible-name semantics. Native selection dispatches DOM input/change events; mouse/typing/Enter use CDP Input. Geometry/freshness checks and input dispatch are separate protocol calls, so rapidly changing pages can still race. Page instructions are treated as untrusted in prompts, but that is not a complete prompt-injection defense.

Next useful work: task-specific verifiers and a repeatable benchmark suite recording success rate, step count, per-stage latency, and model usage before optimizing snapshots or provider calls.

## References

Architecture inspiration: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast). This scaffold is an independent TypeScript/CDP implementation, not a claim of parity. The Jev adapter follows the request shape observed in that project's model adapter; live API compatibility requires your credentials and has not been verified here.

Protocol: [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/). Decision batching: [TypeSafe speculative fan-out](https://docs.typesafe.ai/patterns/fan-out).
