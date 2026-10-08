// Small progressive enhancements. Every page works without this file.
(function () {
  // Theme toggle (light/dark), remembered per browser.
  var toggle = document.getElementById('themeToggle');
  function syncLabel() {
    if (!toggle) return;
    var dark = document.documentElement.classList.contains('dark');
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  // Crossfade colour changes where the browser supports View Transitions.
  function smoothly(change) {
    var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !still) document.startViewTransition(change);
    else change();
  }
  if (toggle) {
    syncLabel();
    toggle.addEventListener('click', function () {
      smoothly(function () {
        var dark = document.documentElement.classList.toggle('dark');
        try { localStorage.setItem('opspilot-theme', dark ? 'dark' : 'light'); } catch (e) {}
        syncLabel();
      });
    });
  }

  // Palette preview picker (the choice is remembered per browser).
  var palette = document.getElementById('paletteSelect');
  if (palette) {
    palette.value = document.documentElement.getAttribute('data-palette') || 'approach';
    palette.addEventListener('change', function () {
      var value = palette.value;
      smoothly(function () {
        if (value === 'approach') document.documentElement.removeAttribute('data-palette');
        else document.documentElement.setAttribute('data-palette', value);
      });
      try { localStorage.setItem('opspilot-palette', value); } catch (e) {}
    });
  }

  // Unread / waiting badges pop only when the number went UP since the
  // last page, so they draw the eye when there's something new.
  document.querySelectorAll('[data-badge]').forEach(function (badge) {
    var key = 'opspilot-badge-' + badge.dataset.badge;
    var now = parseInt(badge.dataset.value, 10) || 0;
    var before = 0;
    try { before = parseInt(localStorage.getItem(key), 10) || 0; localStorage.setItem(key, String(now)); } catch (e) {}
    if (now > before) badge.classList.add('count-badge');
  });

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

  // Forms with data-confirm ask first (e.g. merging tickets). Without
  // JavaScript they simply submit.
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-confirm]');
    if (form && !window.confirm(form.dataset.confirm)) e.preventDefault();
  });

  // Canned responses: picking one inserts its text into the comment box at
  // the cursor (replacing any selection), then resets the dropdown so the
  // same reply can be inserted again. The agent can still edit before posting.
  var canned = document.querySelector('[data-canned]');
  if (canned) {
    canned.classList.remove('hidden');
    var select = canned.querySelector('[data-canned-select]');
    var box = document.getElementById(select.getAttribute('aria-controls'));
    select.addEventListener('change', function () {
      var text = select.value;
      if (!text || !box) return;
      var start = box.selectionStart, end = box.selectionEnd;
      box.value = box.value.slice(0, start) + text + box.value.slice(end);
      box.focus();
      box.selectionStart = box.selectionEnd = start + text.length;
      select.value = '';
    });
  }

  // Make whole strip rows/linked rows keyboard-free clickable without
  // nesting links: rows with data-href navigate on click.
  document.addEventListener('click', function (e) {
    var row = e.target.closest('[data-href]');
    if (row && !e.target.closest('a, button, input, select, textarea, form')) window.location = row.dataset.href;
  });
})();
