// Theme resolution – runs synchronously, before css/main.css paints, so there is never a flash
// of the wrong theme. Not a module (loaded plain, in <head>) on purpose: module scripts defer,
// and this needs to run before first paint. See docs/BRAND.md's "Theme toggle" section.
//
// Rule: dark is the product's default, regardless of prefers-color-scheme – the terminal look and
// the data glow only work on a dark ground. An explicit user choice (persisted in localStorage)
// then wins on every later visit. The OS preference is deliberately not consulted; a light theme
// exists and is complete, but it is the alternate rather than the default.
(function () {
  var STORAGE_KEY = 'lucrum-theme';

  function storedTheme() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (err) {
      return null; // localStorage unavailable (private mode, etc.) – fall back to the default
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function setExplicitTheme(theme) {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (err) {
      // Nothing to do – the choice just won't persist across visits.
    }
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    setExplicitTheme(next);
    return next;
  }

  applyTheme(storedTheme() || 'dark');

  window.LucrumTheme = {
    current: currentTheme,
    toggle: toggleTheme,
    set: setExplicitTheme,
    /** Registered by pages that must repaint on theme change – a canvas reads CSS variables at
     * draw time, so it cannot re-theme by itself the way the DOM does. */
    onChange: function (fn) {
      (window.LucrumTheme._subs = window.LucrumTheme._subs || []).push(fn);
    },
    _notify: function (theme) {
      (window.LucrumTheme._subs || []).forEach(function (fn) { fn(theme); });
    },
  };
})();
