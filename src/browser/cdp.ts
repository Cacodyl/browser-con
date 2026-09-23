import { setTimeout as delay } from 'node:timers/promises';

type Remote = { objectId?: string; value?: unknown };
type Evaluation = { result: Remote; exceptionDetails?: unknown };
/** Minimal direct CDP transport. No browser automation framework. */
export class CDP {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending(new Error('CDP connection closed')));
    socket.addEventListener('error', () => this.rejectPending(new Error('CDP transport failed')));
  }
  static async connect(webSocketUrl: string): Promise<CDP> {
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Chrome')); }, { once: true });
    });
    const cdp = new CDP(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    return cdp;
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluateRemote(expression: string): Promise<Remote> {
    const response = await this.send<Evaluation>('Runtime.evaluate', { expression, returnByValue: false, awaitPromise: true });
    if (response.exceptionDetails) throw new Error('Browser evaluation failed');
    return response.result;
  }
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<Evaluation>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error('Browser evaluation failed');
    return response.result.value as T;
  }
  async call<T>(objectId: string, functionDeclaration: string, values: unknown[] = []): Promise<T> {
    const response = await this.send<Evaluation>('Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: values.map(value => ({ value })), returnByValue: true, awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error('Browser target evaluation failed');
    return response.result.value as T;
  }
  async navigate(url: string): Promise<void> {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Use an HTTP(S) start URL');
    const result = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    for (let i = 0; i < 100; i++) {
      if (await this.evaluate<boolean>('document.readyState !== "loading"').catch(() => false)) return;
      await delay(100);
    }
    throw new Error('Navigation did not settle');
  }
  close(): void { this.rejectPending(new Error('CDP client closed')); this.socket.close(); }
  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
}
