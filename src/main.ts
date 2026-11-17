import { mount } from 'svelte';
import App from './App.svelte';
import { platform } from './runtime/platform';
import './styles.css';

const target = document.getElementById('app')!;
try {
  // Resolve the native platform before the first render, rather than guessing
  // from the browser UA or briefly displaying the web header in a native window.
  const initialChrome = await platform.windowInfo();
  mount(App, { target, props: { initialChrome } });
} catch (error) {
  const message = document.createElement('p');
  message.textContent = `窗口初始化失败：${error instanceof Error ? error.message : String(error)}`;
  const retry = document.createElement('button');
  retry.textContent = '重新加载';
  retry.addEventListener('click', () => location.reload());
  // App has not mounted, so no project or input has been opened yet.
  const close = document.createElement('button');
  close.textContent = '关闭应用';
  close.addEventListener('click', () => {
    void platform.closeWindow().catch((error) => {
      message.textContent = `关闭失败：${error instanceof Error ? error.message : String(error)}`;
    });
  });
  target.replaceChildren(message, retry, close);
}
