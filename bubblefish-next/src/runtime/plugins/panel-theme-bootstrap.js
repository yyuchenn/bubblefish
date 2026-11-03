// SDK-independent presentation bridge. API traffic remains on transferred port 0.
(() => {
  const names = {
    background: '--bf-panel-background',
    surface: '--bf-panel-surface',
    surfaceHover: '--bf-panel-surface-hover',
    text: '--bf-panel-text',
    strong: '--bf-panel-strong',
    muted: '--bf-panel-muted',
    border: '--bf-panel-border',
    accent: '--bf-panel-accent',
    accentSoft: '--bf-panel-accent-soft',
    danger: '--bf-panel-danger',
    fontFamily: '--bf-panel-font-family',
    fontSize: '--bf-panel-font-size',
    radius: '--bf-panel-radius',
  };
  let connection;
  let revision = -1;
  function valid(value) {
    return (
      value &&
      typeof value === 'object' &&
      Number.isInteger(value.revision) &&
      value.revision >= 0 &&
      value.revision <= 4294967295 &&
      typeof value.theme === 'string' &&
      value.theme.length <= 128 &&
      (value.colorScheme === 'light' || value.colorScheme === 'dark') &&
      value.tokens &&
      typeof value.tokens === 'object' &&
      Object.keys(names).every(
        (name) =>
          typeof value.tokens[name] === 'string' &&
          value.tokens[name].length > 0 &&
          value.tokens[name].length <= 1024 &&
          !value.tokens[name].includes('\0'),
      )
    );
  }
  function apply(value) {
    if (!valid(value)) return;
    if (value.revision >= revision) {
      const root = document.documentElement;
      for (const [name, property] of Object.entries(names))
        root.style.setProperty(property, value.tokens[name]);
      root.style.setProperty('color-scheme', value.colorScheme, 'important');
      root.dataset.bfTheme = value.theme;
      revision = value.revision;
    }
    connection?.postMessage({ type: 'appearance-ready', revision });
  }
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.data?.type !== 'bubblefish:connect' ||
      event.data.apiVersion !== 1 ||
      !event.ports[1] ||
      !valid(event.data.appearance)
    )
      return;
    connection?.close();
    connection = event.ports[1];
    revision = -1;
    connection.onmessage = (message) => {
      if (message.data?.type === 'appearance') apply(message.data.appearance);
    };
    connection.start();
    apply(event.data.appearance);
  });
  window.addEventListener('pagehide', () => connection?.close(), { once: true });
})();
