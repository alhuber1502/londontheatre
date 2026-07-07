/* Shared topbar behaviour: hamburger nav toggle. */
(function () {
  var toggle = document.getElementById('nav-toggle');
  var topbar = document.querySelector('.topbar');
  if (!toggle || !topbar) return;

  toggle.addEventListener('click', function () {
    var open = topbar.classList.toggle('is-nav-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });

  // Close when clicking outside the topbar
  document.addEventListener('click', function (e) {
    if (!topbar.contains(e.target) && topbar.classList.contains('is-nav-open')) {
      topbar.classList.remove('is-nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
    }
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && topbar.classList.contains('is-nav-open')) {
      topbar.classList.remove('is-nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
      toggle.focus();
    }
  });
})();
