/* Page-to-page travel, shared by the home page, the lobby and the game.
   Leaving: a link with data-nav="in" goes one level deeper (the page zooms in and fades), data-nav="out" goes back up
   (the page shrinks away). While that plays, the next page is fetched together with its styles, scripts and images,
   and we only go once it is in hand; the loading ring takes over as soon as the zoom has finished.
   Arriving: the page stays behind its loading ring until fonts and content are ready, then settles in from the
   matching direction. Browser back/forward and "reduce motion" skip the zoom but still get the ready-wait. */
(function () {
  var KEY = 'navdir';
  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var css = document.createElement('style');
  // The zoom is applied to the content (.frame on the home page and lobby, #app in the game), not to <body>: a body
  // scaled past the window makes phones widen the layout, which pushed the loading ring off centre.
  var T = '.frame, #app';
  css.textContent =
    'html.leave-in :is(' + T + ') { animation: nav-leave-in .26s cubic-bezier(.5, 0, 1, .6) forwards; }' +
    'html.leave-out :is(' + T + ') { animation: nav-leave-out .26s cubic-bezier(.5, 0, 1, .6) forwards; }' +
    'html.arrive-in :is(' + T + ') { animation: nav-arrive-in .4s cubic-bezier(.2, .7, .2, 1) both; }' +
    'html.arrive-out :is(' + T + ') { animation: nav-arrive-out .4s cubic-bezier(.2, .7, .2, 1) both; }' +
    '@keyframes nav-leave-in { to { transform: scale(1.45); opacity: 0; } }' +
    '@keyframes nav-leave-out { to { transform: scale(.72); opacity: 0; } }' +
    '@keyframes nav-arrive-in { from { transform: scale(.74); opacity: 0; } }' +
    '@keyframes nav-arrive-out { from { transform: scale(1.4); opacity: 0; } }' +
    'html.leave-in :is(' + T + '), html.leave-out :is(' + T + '), html.arrive-in :is(' + T + '), html.arrive-out :is(' + T + ') { transform-origin: 50% 42%; }';
  document.head.appendChild(css);

  var dir = null;
  try { dir = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch (e) { /* storage blocked: no zoom */ }

  // ---- arriving: show the page once it is ready (never wait forever)
  function whenReady() {
    var waits = [];
    waits.push(new Promise(function (r) { if (document.readyState === 'complete') r(); else window.addEventListener('load', r, { once: true }); }));
    if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready);
    if (document.getElementById('app')) waits.push(new Promise(function (r) { // the game: wait for the server's first word
      if (window.__firstState) r(); else document.addEventListener('app-ready', r, { once: true });
    }));
    var cap = new Promise(function (r) { setTimeout(r, 4500); });
    return Promise.race([Promise.all(waits), cap]);
  }
  whenReady().then(function () {
    root.classList.remove('loading');
    if (!reduced && (dir === 'in' || dir === 'out')) {
      root.classList.add('arrive-' + dir);
      setTimeout(function () { root.classList.remove('arrive-' + dir); }, 600);
    }
  });

  // ---- leaving: fetch the next page and what it needs, so it opens in one go
  function warm(url) {
    var job = fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var jobs = [];
      doc.querySelectorAll('link[rel="stylesheet"][href], script[src], img[src]').forEach(function (el) {
        var u = new URL(el.getAttribute('href') || el.getAttribute('src'), url).href;
        jobs.push(fetch(u, { mode: 'no-cors' }).catch(function () {}));
      });
      return Promise.all(jobs);
    }).catch(function () {});
    return Promise.race([job, new Promise(function (r) { setTimeout(r, 4000); })]);
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-nav]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
    e.preventDefault();
    var d = a.getAttribute('data-nav') === 'out' ? 'out' : 'in';
    try { sessionStorage.setItem(KEY, d); } catch (err) { /* ignore */ }
    var url = a.href;
    var minimum = reduced ? 0 : 250;
    if (!reduced) root.classList.add('leave-' + d);
    // the moment the zoom has finished the loading ring takes over: no bare coloured screen in between
    setTimeout(function () { root.classList.add('loading'); }, reduced ? 0 : 255);
    Promise.all([new Promise(function (r) { setTimeout(r, minimum); }), warm(url)]).then(function () { location.href = url; });
  });

  // coming back from the bfcache must not show a half-finished leave
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) root.classList.remove('leave-in', 'leave-out', 'arrive-in', 'arrive-out', 'loading');
  });
})();
