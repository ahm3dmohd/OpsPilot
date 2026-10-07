// Small progressive enhancements. Every page works without this file.
(function () {
  // Theme toggle (light/dark), remembered per browser.
  var toggle = document.getElementById('themeToggle');
  function syncLabel() {
    if (!toggle) return;
    var dark = document.documentElement.classList.contains('dark');
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  if (toggle) {
    syncLabel();
    toggle.addEventListener('click', function () {
      var dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('opspilot-theme', dark ? 'dark' : 'light'); } catch (e) {}
      syncLabel();
    });
  }

  // Mobile sidebar.
  var sidebar = document.getElementById('sidebar');
  var scrim = document.getElementById('sidebarScrim');
  var menu = document.getElementById('menuButton');
  function setMenu(open) {
    if (!sidebar) return;
    sidebar.dataset.open = String(open);
    scrim.classList.toggle('hidden', !open);
    menu.setAttribute('aria-expanded', String(open));
  }
  if (menu) menu.addEventListener('click', function () { setMenu(sidebar.dataset.open !== 'true'); });
  if (scrim) scrim.addEventListener('click', function () { setMenu(false); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setMenu(false);
    // "/" focuses search, unless you're already typing somewhere.
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
      var search = document.getElementById('globalSearch');
      if (search) { e.preventDefault(); search.focus(); }
    }
  });

  // Make whole strip rows/linked rows keyboard-free clickable without
  // nesting links: rows with data-href navigate on click.
  document.addEventListener('click', function (e) {
    var row = e.target.closest('[data-href]');
    if (row && !e.target.closest('a, button, input, select, textarea, form')) window.location = row.dataset.href;
  });
})();
