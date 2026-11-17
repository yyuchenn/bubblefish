import type { PluginMutationProposal, PluginOperation } from '../generated/plugins';

export class MutationRejected extends Error {
  constructor(
    message: string,
    readonly code = 'rejected',
  ) {
    super(message);
    this.name = 'MutationRejected';
  }
}

/** Per-project preparation is serialized without holding the core transport queue. */
export class MutationCoordinator {
  private tails = new Map<string, Promise<unknown>>();
  private stopped = false;
  private pending = 0;
  constructor(private changed: (pending: number) => void = () => {}) {}
  intercept: (proposal: PluginMutationProposal) => Promise<PluginOperation[]> = async (proposal) =>
    proposal.operations;
  run<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('会话已经关闭'));
    this.changed(++this.pending);
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(() => {
        if (this.stopped) throw new Error('会话已经关闭');
        return operation();
      });
    this.tails.set(projectId, result);
    void result
      .finally(() => {
        if (this.tails.get(projectId) === result) this.tails.delete(projectId);
        this.changed(--this.pending);
      })
      .catch(() => {});
    return result;
  }
  async drain(projectId?: string | null) {
    const tails = projectId ? [this.tails.get(projectId)] : [...this.tails.values()];
    await Promise.all(tails.filter((tail) => !!tail).map((tail) => tail!.catch(() => {})));
  }
  dispose() {
    this.stopped = true;
  }
}
