export type Operation = 'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'ENTER' | 'SCROLL_UP' | 'SCROLL_DOWN' | 'WAIT' | 'DONE' | 'BLOCKED';
export interface Target {
  id: string;
  label: string;
  role: string;
  value: string;
  operations: Operation[];
  options: { id: string; label: string; value: string }[];
  checked: boolean | null;
}
export interface Snapshot {
  url: string;
  title: string;
  text: string;
  targets: Target[];
  scrollY: number;
  canScrollDown: boolean;
}
export interface Decision { operation: Operation; target?: string; confidence: number }
export interface Step {
  index: number;
  decision: Decision;
  url: string;
  changed: boolean;
  timing: { snapshotMs: number; decisionMs: number; textMs: number; actionMs: number };
}
export interface DecisionContext { goal: string; snapshot: Snapshot; history: readonly Step[]; signal?: AbortSignal }
export interface DecisionProvider { decide(context: DecisionContext): Promise<Decision> }
export interface TextProvider {
  fill(context: DecisionContext & { target: Target }): Promise<string>;
}
export interface RunResult {
  status: 'done' | 'blocked' | 'budget_exhausted' | 'stalled';
  verified: boolean;
  snapshot: Snapshot;
  steps: Step[];
}

export type ProgressEvent = {
  type: 'snapshot' | 'decision.request' | 'decision.response' | 'decision' | 'text.request' | 'text.ready' | 'action.started' | 'action.executed' | 'step' | 'stale';
  attempt?: number;
  data: unknown;
};
export type ProgressSink = (event: ProgressEvent) => void;
