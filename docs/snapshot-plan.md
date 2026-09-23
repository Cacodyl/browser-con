# Snapshot coverage redesign

Status: proposed design; current snapshot implementation is unchanged.

## Findings in the current code

`src/browser/snapshot.ts` evaluates `readDOM()` in the top document. A document-wide selector already finds supported light-DOM controls at arbitrary nesting depth, including React/Vue components that render normal DOM. Framework component nesting is not itself the problem.

The real gaps are:

- Open, nested, and closed shadow trees are not visited.
- Iframe documents are not visited, even when same-origin.
- The fixed selector misses some custom controls and delegated interactions.
- The text walker has the same tree-boundary limitations as target discovery.
- `document.getElementById` cannot resolve shadow-scoped labels correctly.
- Viewport checks ignore clipping by nested scrollers and some ancestor state.
- The 150-control and 100-option limits silently drop candidates; text truncation is also unreported.
- The executor's `document.elementFromPoint`, `node.contains`, and `document.activeElement` checks assume the top document. A shadow target may be hit-tested/focused as its host. Adding discovery alone would not make these targets executable.
- The CDP transport discards unsolicited events and has no session routing, so it cannot yet track out-of-process frames or document lifetimes.

A local Chrome probe on 2026-09-23 created one ordinary nested button, one open-shadow button, one nested-shadow button, and one closed-shadow button. The current reader returned only the ordinary button. `DOMSnapshot.captureSnapshot` included all four text markers. This establishes discovery potential in the installed Chrome; it does not yet prove action correctness, slot ordering, cross-process frames, or coverage in other Chrome versions.

## Recommended design

Separate **discovery**, **candidate selection**, and **execution**. Broad discovery must not mean dumping an entire DOM into Jev. Every known omission should be recorded, and candidates excluded by context budgets should remain reachable through expansion or scrolling.

### 1. Frame and session registry

Extend `CDP` to route flattened-session commands and dispatch protocol events to subscribers. Track the owned page's frame tree, execution contexts, attached child targets, and a document-generation counter. Use auto-attachment for related out-of-process frame targets, applying it recursively where necessary. Do not attach unrelated user tabs or treat worker targets as documents.

Track same-process frames as frame/context entries in their owning session; cross-origin is not synonymous with out-of-process. Track out-of-process frame sessions separately. Handle navigation, target replacement, detach, and context destruction before considering any node reference valid. Report unavailable/detached frames in coverage rather than pretending the page was fully scanned.

### 2. CDP discovery baseline

Use `DOMSnapshot.captureSnapshot` per relevant renderer session as the correctness baseline. Decode its string/node/layout tables into an internal graph, associate documents with frames, and deduplicate documents already represented in the parent capture. Its flattened shadow representation and layout data avoid relying solely on page JavaScript to enter shadow roots.

Use `DOM.getDocument({depth: -1, pierce: true})` selectively to enrich host/root/slot relationships when the flattened capture lacks required structure. Avoid deprecated `DOM.getFlattenedDocument`. Benchmark extra captures before making both calls unconditional. Native browser internals should not become duplicated user-facing controls.

CDP documents flattened shadow information and backend node identity in its [DOMSnapshot protocol schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/DOMSnapshot.pdl). The [DOM schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/DOM.pdl) describes piercing document traversal and resolving backend nodes. The [Target schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl) covers flattened session attachment.

### 3. Internal node identity and model-facing IDs

Proposed execution reference:

```ts
type NodeRef = {
  sessionId: string;
  frameId: string;
  documentGeneration: number;
  backendNodeId: number;
};
```

Keep backend references server-side. Give Jev short observation-local IDs mapped to these references. Never reuse a mapping across document generations. For SELECT, associate the selected option with its observed node/value/index and validate that relationship again before changing the field.

Do not resolve every discovered node into a remote JavaScript object. Resolve shortlisted nodes only when metadata requires it, or resolve the chosen target immediately before execution. Release remote object groups after each observation/action.

### 4. Composed content, semantics, and visibility

Build control labels and text from the rendered/composed content, not a naive concatenation of light DOM plus shadow DOM. Handle assigned slots, fallback slot content, and nested roots without duplicates. Distinguish discovered nodes from rendered nodes; hidden templates and unassigned content should not appear as visible controls.

Join accessibility metadata by backend node identity where useful for computed names, roles, checked/expanded/disabled state, and relationships. Treat this as enrichment, not the only discovery source: accessibility trees can omit custom interactive content. Prioritize native controls, supported ARIA widgets, and observed clickability; do not indiscriminately offer every DIV as clickable. Mark unresolved custom interactions as unsupported.

Use layout and frame geometry to shortlist visible candidates, accounting for ancestor clipping and scroll containers. Recompute actionable geometry and hit-test immediately before input. A bounding box or opacity flag alone is not proof of clickability. Text extraction and candidate selection must share the same coverage model.

### 5. Execution across boundaries

Resolve the chosen backend node in its owning session/context. Recheck document generation, attachment, semantic identity, value/state, supported operation, and current geometry. Use protocol-backed focus and shadow-aware focus verification. Hit testing must account for shadow hosts and slot assignment rather than relying on light-DOM `contains` alone.

For frame clicks, convert coordinates through the frame-owner chain and dispatch through the appropriate page/session path, verified with nested-frame fixtures. Include clipping and transformed frames. Add targeted scroll actions for an element's actual scroll container, then reobserve before clicking. An offscreen control should be discoverable without being immediately clickable.

Retain the no-blind-retry rule after input dispatch. No multi-process capture is perfectly atomic; mark generation changes during collection as stale, and revalidate chosen targets immediately before mutation.

### 6. Coverage and bounded model context

Proposed observation metadata:

```ts
type Coverage = {
  framesDiscovered: number;
  framesCaptured: number;
  rootsDiscovered: number;
  nodesDiscovered: number;
  candidatesEligible: number;
  candidatesOffered: number;
  complete: boolean;
  omissions: { scope: string; reason: string; count?: number }[];
};
```

Replace first-N truncation with deterministic grouping by frame/region/form, preserving focused fields, active dialogs, and their related controls. Make overflow explicit and offer bounded region expansion/pagination. Keep exploration candidates distinct from executable visible targets. Log coverage and exclusion reasons in the control panel.

Do not allow an unqualified DONE when relevant document scopes are uninspected or candidates were silently dropped. Model completion remains separate from independent task verification. Virtualized rows, unopened menus, and not-yet-loaded content do not exist in the current DOM: reveal them through deliberate scroll/expand/wait actions and take another snapshot. Canvas-only UI needs a separately designed visual fallback or an explicit unsupported result.

## Implementation sequence and acceptance gates

1. **Coverage fixtures and baseline measurements.** Add nested light DOM, nested open/closed roots, slotted controls, dynamic roots, and shadow-scoped labels. Assert the exact expected controls and demonstrate current omissions. Record payload size, protocol calls, and snapshot latency.
2. **Typed graph and CDP snapshot adapter.** Implement the decoder and node-reference mapping behind the current observation interface. Prove every expected shadow control is found once, including text and labels; compare with the old reader during migration.
3. **Shadow-aware action execution.** Click, fill, clear, press Enter, and select through retained backend identity. Test overlays, disabled/inert controls, slot reassignment, replaced hosts, and document navigation; stale references must never act on a replacement.
4. **Frame/session coverage.** Add event routing and registry, then same-origin, cross-origin, and explicitly verified out-of-process nested-frame fixtures. Assert discovery, coordinate mapping, input delivery, detach behavior, and honest partial-coverage reporting.
5. **Exploration and context budgets.** Add nested scroll containers, >150 controls, >100 select options, virtualized content, and large pages. Prove an initially omitted goal target can be deliberately reached rather than disappearing from the action space. Display coverage in the panel.
6. **Optimize after correctness.** Measure median/p95 observation and action latency, browser calls, payload bytes, model usage, and independent task success. Consider incremental subtree refreshes with periodic full reconciliation only after baseline coverage is stable. Avoid claiming a speedup before these measurements.

First implementation slice: fixture suite + CDP graph adapter + working actions inside nested open/closed roots, retaining the existing agent/provider interfaces. Frame support is the next required slice before calling the new snapshot generally complete.
