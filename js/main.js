// Home shell. Phase 8 builds the signal browser, item detail pages, event calendar and profile
// pages against docs/CONTRACTS.md and docs/BRAND.md – see docs/PLAN.md. This file only wires the
// theme toggle for now; there is no signal data to render on this page yet, and fabricating a
// number here to demo the design system would violate docs/BRAND.md's copy register (declarative,
// never decorative).
function syncToggleLabel(button) {
  const theme = window.LucrumTheme.current();
  button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}

const toggle = document.getElementById('theme-toggle');
if (toggle) {
  syncToggleLabel(toggle);
  toggle.addEventListener('click', () => {
    window.LucrumTheme.toggle();
    syncToggleLabel(toggle);
  });
}
