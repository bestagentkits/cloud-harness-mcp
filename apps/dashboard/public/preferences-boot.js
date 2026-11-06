// Applies the saved Dashboard display preferences before first paint, so a dark-theme
// reload never flashes light. It must stay a tiny classic script: the CSP forbids inline
// script, and module scripts run too late. Mirrors `src/lib/preferences.ts`; the unit test
// there executes this file against the same inputs to keep the two in step.
// The theme's authority is the HTTP-only `ch-dashboard-theme` cookie, which the API renders
// as `data-server-theme` on <html>; localStorage only mirrors it.
(function () {
  var allowed = {
    theme: ['system', 'light', 'dark'],
    fontScale: ['sm', 'md', 'lg', 'xl'],
    density: ['comfortable', 'compact'],
    contrast: ['standard', 'high'],
    sidebar: ['expanded', 'collapsed']
  };
  var defaults = { theme: 'system', fontScale: 'md', density: 'comfortable', contrast: 'standard', sidebar: 'expanded' };
  var stored = {};
  try {
    var parsed = JSON.parse(window.localStorage.getItem('ch-dashboard-preferences') || '{}');
    if (parsed && typeof parsed === 'object') stored = parsed;
  } catch { stored = {}; }
  function pick(name) {
    var value = stored[name];
    return allowed[name].indexOf(value) === -1 ? defaults[name] : value;
  }
  var root = document.documentElement;
  var serverTheme = root.getAttribute('data-server-theme');
  var fromServer = allowed.theme.indexOf(serverTheme) !== -1;
  var theme = fromServer ? serverTheme : pick('theme');
  if (fromServer && theme !== stored.theme) {
    // Rewrite only the known fields, as writePreferences does.
    var mirrored = { theme: theme };
    for (var name in defaults) if (name !== 'theme') mirrored[name] = pick(name);
    try { window.localStorage.setItem('ch-dashboard-preferences', JSON.stringify(mirrored)); } catch { /* storage unavailable */ }
  }
  var dark = false;
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { dark = false; }
  var resolved = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-preference', theme);
  root.setAttribute('data-font-scale', pick('fontScale'));
  root.setAttribute('data-density', pick('density'));
  root.setAttribute('data-contrast', pick('contrast'));
  root.setAttribute('data-sidebar', pick('sidebar'));
  root.style.colorScheme = resolved;
})();
