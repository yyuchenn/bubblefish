<script lang="ts">
  import { APP_VERSION } from '../runtime/app-identity';
  import { RELEASES_URL, type SoftwareUpdater } from '../runtime/updater';
  import './software-update.css';

  let { updater, oninstall }: { updater: SoftwareUpdater; oninstall(): void } = $props();
  const busy = $derived(
    !$updater.initialized ||
      ['checking', 'downloading', 'verifying', 'installing'].includes($updater.phase),
  );
  const candidate = $derived(
    $updater.release?.id !== $updater.ready?.id ? $updater.release : undefined,
  );
  const release = $derived(candidate ?? $updater.ready ?? $updater.release);
  const total = $derived($updater.progress?.total);
  const percentage = $derived(
    total && total > 0
      ? Math.min(100, Math.floor((($updater.progress?.downloaded ?? 0) / total) * 100))
      : undefined,
  );
  const sourceName = (source: string) => (source === 'gitee' ? 'Gitee' : 'GitHub');
</script>

<section class="software-update" aria-label="软件更新" id="software-update">
  <h3>软件更新</h3>
  <p class="update-version">当前版本 {$updater.currentVersion || APP_VERSION}</p>
  {#if !updater.desktop}
    <p>网页版会在下次打开时使用已部署的版本。</p>
    <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">查看发布记录</a>
  {:else}
    <p class="update-state" role="status" aria-live="polite">
      {#if $updater.phase === 'checking'}正在检查更新…
      {:else if $updater.phase === 'downloading'}正在下载更新…
      {:else if $updater.phase === 'verifying'}正在验证更新签名…
      {:else if $updater.phase === 'installing'}正在启动安装程序…
      {:else if $updater.ready && candidate}发现新版本 {candidate.version}；已下载 {$updater.ready
          .version}
      {:else if $updater.ready}更新 {$updater.ready.version} 已下载并验证
      {:else if $updater.release}发现新版本 {$updater.release.version}
      {:else if $updater.phase === 'error'}更新检查尚未完成
      {:else if $updater.lastChecked}当前已是最新版本
      {:else}尚未检查更新{/if}
    </p>
    {#if $updater.unsupportedReason}<p class="update-note">{$updater.unsupportedReason}</p>{/if}
    {#if $updater.error}<p class="update-error" role="alert">更新失败：{$updater.error}</p>{/if}
    {#if release}
      <p class="update-note">来源：{sourceName(release.source)}</p>
      {#if release.date && Number.isFinite(Date.parse(release.date))}
        <p class="update-note">发布时间：{new Date(release.date).toLocaleString('zh-CN')}</p>
      {/if}
      {#if release.notes}<p class="update-notes">{release.notes}</p>{/if}
    {/if}
    {#if $updater.phase === 'downloading'}
      <div class="update-progress">
        {#if percentage !== undefined}
          <progress aria-label="更新下载进度" value={percentage} max="100"></progress>
          <span>{percentage}%</span>
        {:else}
          <progress aria-label="更新下载进度"></progress>
          <span>已下载 {Math.ceil(($updater.progress?.downloaded ?? 0) / 1024)} KiB</span>
        {/if}
      </div>
    {/if}
    <div class="update-actions">
      <button class="secondary-button" disabled={busy} onclick={() => void updater.check()}
        >检查更新</button
      >
      {#if $updater.ready}
        <button class="primary-button" disabled={busy || !$updater.supported} onclick={oninstall}
          >{candidate ? `安装 ${$updater.ready.version} 并重启` : '安装并重启'}</button
        >
      {/if}
      {#if candidate}
        <button
          class="primary-button"
          disabled={busy || !$updater.supported}
          onclick={() => void updater.download()}>下载更新</button
        >
      {/if}
      <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">发布记录</a>
    </div>
    <fieldset class="update-preferences">
      <legend>更新设置</legend>
      <label
        >优先更新源
        <select
          aria-label="优先更新源"
          disabled={busy}
          value={$updater.settings.source}
          onchange={(event) =>
            updater.updateSettings({
              source: event.currentTarget.value === 'github' ? 'github' : 'gitee',
            })}
        >
          <option value="gitee">Gitee</option><option value="github">GitHub</option>
        </select>
      </label>
      <p class="update-note">优先源不可用时会尝试另一更新源。</p>
      <label
        ><input
          type="checkbox"
          checked={$updater.settings.autoCheck}
          onchange={(event) => updater.updateSettings({ autoCheck: event.currentTarget.checked })}
        /><span>自动检查更新<small>每24小时检查一次；启动时会检查是否到期。</small></span></label
      >
      <label
        ><input
          type="checkbox"
          checked={$updater.settings.autoDownload}
          onchange={(event) =>
            updater.updateSettings({ autoDownload: event.currentTarget.checked })}
        /><span>自动下载更新<small>发现更新后在后台下载，编辑时不会安装。</small></span></label
      >
      <label
        ><input
          type="checkbox"
          checked={$updater.settings.installOnExit}
          onchange={(event) =>
            updater.updateSettings({ installOnExit: event.currentTarget.checked })}
        /><span>退出时安装已下载的更新<small>先确认未保存的项目，再启动安装。</small></span></label
      >
    </fieldset>
    {#if $updater.lastChecked}<p class="update-note">
        上次检查：{new Date($updater.lastChecked).toLocaleString('zh-CN')}
      </p>{/if}
  {/if}
</section>
