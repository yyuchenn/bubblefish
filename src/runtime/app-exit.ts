import { get, writable } from 'svelte/store';
import type { FinishExitOptions } from './updater';

interface ExitDependencies {
  workbench: {
    prepareExitInput(): Promise<void>;
    freezeForExit(): void;
    resumeAfterExitFailure(): void;
    prepareAppExit(): Promise<boolean>;
  };
  plugins: {
    pauseForExit(): Promise<void>;
    resumeAfterExitFailure(nativeStopped?: boolean): Promise<void>;
  };
  assistance: { cancelAll(): void };
  updater: { finishExit(mode: FinishExitOptions['mode'], skipUpdate?: boolean): Promise<void> };
}
export interface AppExitView {
  phase: 'idle' | 'flushing' | 'preparing' | 'committed';
  mode: FinishExitOptions['mode'];
  error: string;
}

/** Share the document/IME barrier for ordinary quit and updater installation. */
export class AppExitCoordinator {
  private store = writable<AppExitView>({ phase: 'idle', mode: 'quit', error: '' });
  readonly subscribe = this.store.subscribe;
  private running?: Promise<boolean>;
  constructor(private dependencies: ExitDependencies) {}
  get value() {
    return get(this.store);
  }
  clearError() {
    this.store.update((value) => ({ ...value, error: '' }));
  }
  request(mode: FinishExitOptions['mode'], skipUpdate = false): Promise<boolean> {
    if (this.running) return this.running;
    if (this.value.phase === 'committed') return Promise.resolve(true);
    this.store.set({ phase: 'flushing', mode, error: '' });
    return (this.running = this.perform(mode, skipUpdate).finally(() => {
      this.running = undefined;
    }));
  }
  private async perform(mode: FinishExitOptions['mode'], skipUpdate: boolean) {
    const { workbench, plugins, assistance, updater } = this.dependencies;
    let nativeAttempted = false;
    let workbenchFrozen = false;
    let pluginPauseAttempted = false;
    const recover = async () => {
      if (workbenchFrozen) {
        workbench.resumeAfterExitFailure();
        workbenchFrozen = false;
      }
      if (pluginPauseAttempted) {
        pluginPauseAttempted = false;
        await plugins.resumeAfterExitFailure(nativeAttempted);
      }
    };
    try {
      // Keep the editor interactive until an ongoing composition has ended.
      await workbench.prepareExitInput();
      workbench.freezeForExit();
      workbenchFrozen = true;
      this.store.update((value) => ({ ...value, phase: 'preparing' }));
      assistance.cancelAll();
      pluginPauseAttempted = true;
      await plugins.pauseForExit();
      if (!(await workbench.prepareAppExit())) {
        await recover();
        this.store.update((value) => ({ ...value, phase: 'idle' }));
        return false;
      }
      this.store.update((value) => ({ ...value, phase: 'committed' }));
      nativeAttempted = true;
      await updater.finishExit(mode, skipUpdate);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Restore the unload guard before restarting plugins or allowing edits.
      this.store.update((value) => ({ ...value, phase: 'preparing' }));
      let recovery = '';
      try {
        await recover();
      } catch (resumeError) {
        recovery = `；插件恢复失败：${resumeError instanceof Error ? resumeError.message : String(resumeError)}`;
      }
      this.store.update((value) => ({ ...value, phase: 'idle', error: message + recovery }));
      return false;
    }
  }
}
