// Theme resolution – runs synchronously, before css/main.css paints, so there is never a flash
// of the wrong theme. Not a module (loaded plain, in <head>) on purpose: module scripts defer,
// and this needs to run before first paint. See docs/BRAND.md's "Theme toggle" section.
//
// Rule: prefers-color-scheme is the initial guess; an explicit user choice (persisted in
// localStorage) then wins over the OS preference on every later visit. Until the user makes an
// explicit choice, the page keeps following the OS preference live (a listener below), since
// "initial guess" implies it can keep guessing until overridden.
(function () {
  var STORAGE_KEY = 'lucrum-theme';

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function storedTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null; // localStorage unavailable (private mode, etc.) – fall back to system guess
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
    return document.documentElement.getAttribute('data-theme') || systemTheme();
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    setExplicitTheme(next);
    return next;
  }

  applyTheme(storedTheme() || systemTheme());

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (storedTheme()) return; // explicit choice already made – it wins, per docs/BRAND.md
      applyTheme(e.matches ? 'dark' : 'light');
    });
  }

  window.LucrumTheme = { current: currentTheme, toggle: toggleTheme, set: setExplicitTheme };
})();
