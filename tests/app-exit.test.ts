import { describe, expect, it, vi } from 'vitest';
import { AppExitCoordinator } from '../src/runtime/app-exit';

function setup() {
  const calls: string[] = [];
  const workbench = {
    prepareExitInput: vi.fn(async () => {
      calls.push('barrier');
    }),
    freezeForExit: vi.fn(() => {
      calls.push('freeze');
    }),
    resumeAfterExitFailure: vi.fn(() => {
      calls.push('resume-workbench');
    }),
    prepareAppExit: vi.fn(async () => {
      calls.push('prepare-projects');
      return true;
    }),
  };
  const plugins = {
    pauseForExit: vi.fn(async () => {
      calls.push('pause-plugins');
    }),
    resumeAfterExitFailure: vi.fn(async (nativeStopped?: boolean) => {
      calls.push(`resume-plugins:${nativeStopped}`);
    }),
  };
  const assistance = {
    cancelAll: vi.fn(() => {
      calls.push('cancel-assistance');
    }),
  };
  const updater = {
    finishExit: vi.fn(async () => {
      calls.push('native-exit');
    }),
  };
  const exit = new AppExitCoordinator({ workbench, plugins, assistance, updater });
  return { calls, workbench, plugins, updater, exit };
}
describe('application exit and installation barrier', () => {
  it('lets IME flushing finish before freezing and invokes native installation only after every project agrees', async () => {
    const { calls, workbench, updater, exit } = setup();
    let finishComposition!: () => void;
    workbench.prepareExitInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishComposition = resolve;
        }),
    );
    const requested = exit.request('install-restart');
    expect(exit.value.phase).toBe('flushing');
    expect(workbench.freezeForExit).not.toHaveBeenCalled();
    expect(updater.finishExit).not.toHaveBeenCalled();
    expect(exit.request('quit')).toBe(requested);
    finishComposition();
    expect(await requested).toBe(true);
    expect(calls).toEqual([
      'freeze',
      'cancel-assistance',
      'pause-plugins',
      'prepare-projects',
      'native-exit',
    ]);
    expect(updater.finishExit).toHaveBeenCalledWith('install-restart', false);
    expect(exit.value.phase).toBe('committed');
  });

  it('restores the current plugin instances and documents when a project cancels', async () => {
    const { workbench, plugins, updater, exit } = setup();
    workbench.prepareAppExit.mockResolvedValue(false);
    expect(await exit.request('quit')).toBe(false);
    expect(updater.finishExit).not.toHaveBeenCalled();
    expect(workbench.resumeAfterExitFailure).toHaveBeenCalledTimes(1);
    expect(plugins.resumeAfterExitFailure).toHaveBeenCalledWith(false);
    expect(exit.value).toMatchObject({ phase: 'idle', error: '' });
  });

  it('never invokes the installer after a save or preflight failure', async () => {
    const { workbench, plugins, updater, exit } = setup();
    workbench.prepareAppExit.mockRejectedValue(new Error('save failed'));
    expect(await exit.request('install-restart')).toBe(false);
    expect(updater.finishExit).not.toHaveBeenCalled();
    expect(plugins.resumeAfterExitFailure).toHaveBeenCalledWith(false);
    expect(exit.value).toMatchObject({ phase: 'idle', error: 'save failed' });
  });

  it('reports a blocked input queue before freezing or invoking native exit', async () => {
    const { workbench, plugins, updater, exit } = setup();
    workbench.prepareExitInput.mockRejectedValue(new Error('editing queue is blocked'));
    expect(await exit.request('quit')).toBe(false);
    expect(workbench.freezeForExit).not.toHaveBeenCalled();
    expect(plugins.pauseForExit).not.toHaveBeenCalled();
    expect(workbench.resumeAfterExitFailure).not.toHaveBeenCalled();
    expect(plugins.resumeAfterExitFailure).not.toHaveBeenCalled();
    expect(updater.finishExit).not.toHaveBeenCalled();
    expect(exit.value).toMatchObject({ phase: 'idle', error: 'editing queue is blocked' });
  });

  it('recovers a plugin pause that fails after partially pausing its runtimes', async () => {
    const { workbench, plugins, updater, exit } = setup();
    plugins.pauseForExit.mockRejectedValue(new Error('plugin config write failed'));
    expect(await exit.request('quit')).toBe(false);
    expect(workbench.resumeAfterExitFailure).toHaveBeenCalledTimes(1);
    expect(plugins.resumeAfterExitFailure).toHaveBeenCalledExactlyOnceWith(false);
    expect(updater.finishExit).not.toHaveBeenCalled();
    expect(exit.value.error).toBe('plugin config write failed');
  });

  it('restores stale native instances after installer failure and permits retry or an explicit skip-update quit', async () => {
    const { plugins, updater, exit } = setup();
    updater.finishExit.mockRejectedValueOnce(new Error('installer denied'));
    expect(await exit.request('install-restart')).toBe(false);
    expect(plugins.resumeAfterExitFailure).toHaveBeenCalledWith(true);
    expect(exit.value).toMatchObject({
      phase: 'idle',
      mode: 'install-restart',
      error: 'installer denied',
    });
    expect(await exit.request('quit', true)).toBe(true);
    expect(updater.finishExit).toHaveBeenLastCalledWith('quit', true);
  });
});
