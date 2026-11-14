import { connectPanel } from '../../../src/plugin-sdk';

window.addEventListener('message', function connect(event) {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'bubblefish:connect' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', connect);
  const sdk = connectPanel(event.ports[0]);
  const output = document.querySelector('#output')!;
  output.textContent = '面板已连接';
  document.querySelector('#run')!.addEventListener('click', () => {
    void sdk.commands.execute('status').then(
      (result) => (output.textContent = JSON.stringify(result)),
      (error) => (output.textContent = String(error)),
    );
  });
  window.addEventListener('unload', () => sdk.dispose(), { once: true });
});
