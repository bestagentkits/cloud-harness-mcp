// Applies the saved Dashboard display preferences before first paint, so a dark-theme
// reload never flashes light. It must stay a tiny classic script: the CSP forbids inline
// script, and module scripts run too late. Mirrors `src/lib/preferences.ts`; the unit test
// there executes this file against the same inputs to keep the two in step.
(function () {
  var allowed = {
    theme: ['system', 'light', 'dark'],
    fontScale: ['sm', 'md', 'lg', 'xl'],
    density: ['comfortable', 'compact'],
    contrast: ['standard', 'high']
  };
  var defaults = { theme: 'system', fontScale: 'md', density: 'comfortable', contrast: 'standard' };
  var stored = {};
  try {
    var parsed = JSON.parse(window.localStorage.getItem('ch-dashboard-preferences') || '{}');
    if (parsed && typeof parsed === 'object') stored = parsed;
  } catch { stored = {}; }
  function pick(name) {
    var value = stored[name];
    return allowed[name].indexOf(value) === -1 ? defaults[name] : value;
  }
  var theme = pick('theme');
  var dark = false;
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { dark = false; }
  var resolved = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
  var root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-preference', theme);
  root.setAttribute('data-font-scale', pick('fontScale'));
  root.setAttribute('data-density', pick('density'));
  root.setAttribute('data-contrast', pick('contrast'));
  root.style.colorScheme = resolved;
})();
