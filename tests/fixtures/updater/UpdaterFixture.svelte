<script lang="ts">
  import { onMount } from 'svelte';
  import SoftwareUpdateSection from '../../../src/components/SoftwareUpdateSection.svelte';
  import {
    SoftwareUpdater,
    type UpdaterSnapshot,
    type UpdaterTransport,
  } from '../../../src/runtime/updater';
  import { AppExitCoordinator } from '../../../src/runtime/app-exit';

  const params = new URL(location.href).searchParams;
  const supported = !params.has('unsupported');
  const desktop = !params.has('browser');
  if (!localStorage.getItem('bubblefish.updater'))
    localStorage.setItem(
      'bubblefish.updater',
      JSON.stringify({
        autoCheck: false,
        autoDownload: false,
        installOnExit: true,
        source: 'gitee',
      }),
    );
  const release = {
    id: params.has('newer') ? '042' : '041',
    version: params.has('newer') ? '0.4.2' : '0.4.1',
    source: 'github' as const,
    notes: '<b>Plain release notes</b>',
    date: '2026-11-12T12:00:00Z',
  };
  let native: UpdaterSnapshot = {
    revision: 0,
    phase: 'idle',
    currentVersion: '0.4.0',
    supported,
    ...(supported ? {} : { unsupportedReason: '开发构建仅支持检查更新，请使用正式安装版。' }),
  };
  const cached = localStorage.getItem('fixture.staged-update');
  if (cached && supported) native = { ...native, phase: 'ready', ready: JSON.parse(cached) };
  let receive: ((snapshot: UpdaterSnapshot) => void) | undefined;
  let checked: ((snapshot: UpdaterSnapshot) => void) | undefined;
  let failedCheck: ((error: Error) => void) | undefined;
  let downloaded: ((snapshot: UpdaterSnapshot) => void) | undefined;
  let calls = $state<string[]>([]);
  let draft = $state('未保存的译文');
  let choice = $state('save');
  let installerFails = $state(false);
  const log = (entry: string) => {
    calls = [...calls, entry];
  };
  function emit(patch: Partial<UpdaterSnapshot>) {
    native = { ...native, ...patch, revision: native.revision + 1 };
    receive?.(native);
    return native;
  }
  const transport: UpdaterTransport = {
    async state() {
      return native;
    },
    async listen(handler) {
      receive = handler;
      return () => {
        receive = undefined;
      };
    },
    check(source) {
      log(`check:${source}`);
      return new Promise((resolve, reject) => {
        checked = resolve;
        failedCheck = reject;
      });
    },
    download(id) {
      log(`download:${id}`);
      return new Promise((resolve) => {
        downloaded = resolve;
      });
    },
    async finishExit(options) {
      log(`native:${options.mode}:${options.skipUpdate}`);
      if (installerFails && !options.skipUpdate) throw new Error('安装程序启动失败');
    },
  };
  const updater = new SoftwareUpdater({ desktop, transport });
  const exit = new AppExitCoordinator({
    workbench: {
      async prepareExitInput() {
        log('editor-barrier');
      },
      freezeForExit() {
        log('freeze');
      },
      resumeAfterExitFailure() {
        log('resume-documents');
      },
      async prepareAppExit() {
        log(`prepare:${choice}`);
        if (choice === 'error') throw new Error('保存失败');
        return choice !== 'cancel';
      },
    },
    assistance: {
      cancelAll() {
        log('cancel-assistance');
      },
    },
    plugins: {
      async pauseForExit() {
        log('pause-plugins');
      },
      async resumeAfterExitFailure(stopped) {
        log(`resume-plugins:${stopped}`);
      },
    },
    updater,
  });
  const frozen = $derived($exit.phase === 'preparing' || $exit.phase === 'committed');
  onMount(() => {
    void updater.initialize();
    return () => updater.dispose();
  });
</script>

<main>
  <div inert={frozen}>
    <label>未保存译文<textarea aria-label="未保存译文" bind:value={draft}></textarea></label>
    <SoftwareUpdateSection {updater} oninstall={() => void exit.request('install-restart')} />
    <button onclick={() => void exit.request('quit')}>普通退出</button>
  </div>
  {#if $exit.error}
    <p role="alert">{$exit.error}</p>
    <button onclick={() => void exit.request($exit.mode)}>重试安装</button>
    <button onclick={() => void exit.request('quit', true)}>跳过更新并退出</button>
  {/if}
  <p role="status">{$exit.phase === 'committed' ? '退出已提交' : '编辑会话保留'}</p>
  <section aria-label="原生适配器测试控制">
    <button onclick={() => checked?.(emit({ phase: 'available', release, error: undefined }))}
      >返回新版本</button
    >
    <button
      onclick={() =>
        checked?.(emit({ phase: 'idle', release: undefined, ready: undefined, error: undefined }))}
      >返回无更新</button
    >
    <button onclick={() => failedCheck?.(new Error('检查网络离线'))}>检查失败</button>
    <button onclick={() => emit({ phase: 'downloading', release, progress: { downloaded: 8192 } })}
      >未知大小进度</button
    >
    <button
      onclick={() =>
        emit({ phase: 'downloading', release, progress: { downloaded: 8192, total: 16384 } })}
      >已知大小进度</button
    >
    <button onclick={() => emit({ phase: 'verifying', progress: undefined })}>验证下载</button>
    <button
      onclick={() => {
        localStorage.setItem('fixture.staged-update', JSON.stringify(release));
        downloaded?.(emit({ phase: 'ready', release, ready: release, progress: undefined }));
      }}>完成下载</button
    >
    <label
      >项目退出选择<select aria-label="项目退出选择" bind:value={choice}
        ><option value="save">保存</option><option value="discard">放弃</option><option
          value="cancel">取消</option
        ><option value="error">保存失败</option></select
      ></label
    >
    <label><input type="checkbox" bind:checked={installerFails} />模拟安装失败</label>
  </section>
  <ol aria-label="原生调用记录">
    {#each calls as call}<li>{call}</li>{/each}
  </ol>
</main>

<style>
  main {
    max-width: 660px;
    margin: 24px auto;
    padding: 20px;
    background: var(--surface);
  }
  textarea {
    display: block;
    width: 100%;
    border: 1px solid var(--line);
  }
  section[aria-label='原生适配器测试控制'] {
    margin-top: 24px;
    border-top: 1px solid var(--line);
    padding-top: 15px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  ol {
    font-size: 11px;
  }
</style>
