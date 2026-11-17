/** One in-flight request. A failed request stays at the head until explicitly retried. */
export class CommandQueue {
  private jobs: {
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  private running = false;
  private failed = false;
  constructor(
    private readonly onState: (pending: number, error: unknown | null) => void = () => {},
  ) {}

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) =>
      this.jobs.push({ run, resolve: resolve as (v: unknown) => void, reject }),
    );
    this.onState(this.jobs.length, null);
    void this.pump();
    return result;
  }

  private async pump() {
    if (this.running || this.failed) return;
    this.running = true;
    while (this.jobs.length) {
      const job = this.jobs[0];
      try {
        const value = await job.run();
        this.jobs.shift();
        job.resolve(value);
        this.onState(this.jobs.length, null);
      } catch (error) {
        this.failed = true;
        this.onState(this.jobs.length, error);
        break;
      }
    }
    this.running = false;
  }

  retry() {
    this.failed = false;
    void this.pump();
  }
  get blocked() {
    return this.failed;
  }
  drain(): Promise<void> {
    return this.enqueue(async () => undefined);
  }
  dispose() {
    for (const job of this.jobs.splice(0)) job.reject(new Error('会话已经关闭'));
  }
}
