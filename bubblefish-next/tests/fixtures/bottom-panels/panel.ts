import { connectPanel } from '../../../src/plugin-sdk';

document.querySelector('#instance')!.textContent = String(Math.random());
window.addEventListener('message', function connect(event) {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'bubblefish:connect' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', connect);
  const sdk = connectPanel(event.ports[0]);
  const status = document.querySelector('#status')!;
  void sdk.commands.execute('identity').then((id) => {
    status.textContent = `${id} / ${event.data.panelId} 已连接`;
  });
  document.querySelector('#open')!.addEventListener('click', () => {
    void sdk.call('panels.open', { panelId: 'notes' }).catch((error) => {
      status.textContent = String(error);
    });
  });
  window.addEventListener('unload', () => sdk.dispose(), { once: true });
});
