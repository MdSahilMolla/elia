// Bhawanipur Global Campus — homepage recreation scripts
// - Mobile nav toggle
// - Metrics count-up on intersection
// - Programme category filtering with empty state
// - Current year in footer

(function(){
  const qs = (s, el=document) => el.querySelector(s);
  const qsa = (s, el=document) => Array.from(el.querySelectorAll(s));

  // Mobile nav
  const toggle = qs('.nav-toggle');
  const menu = qs('#nav-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      menu.style.display = expanded ? 'none' : 'block';
    });
  }

  // Count-up metrics (start once when metrics section enters viewport; keeps readable static text without JS)
  const metricEls = qsa('.metric-number');
  if (metricEls.length) {
    let started = false;
    const fmt = (n) => {
      if (n >= 1000) return Math.round(n).toLocaleString('en-IN');
      return Math.round(n).toString();
    };

    const animateEl = (el) => {
      const target = Number(el.getAttribute('data-count') || '0');
      const suffix = el.getAttribute('data-suffix') || '';
      const duration = 1200; // ms
      const start = performance.now();

      const step = (now) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        const val = target * eased;
        el.textContent = fmt(val) + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    const startAll = () => {
      if (started) return;
      started = true;
      metricEls.forEach(animateEl);
    };

    const section = qs('#metrics');
    if (section && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            startAll();
            observer.disconnect();
          }
        });
      }, { threshold: 0.3 });
      io.observe(section);
    } else {
      // Fallback for older browsers: start immediately
      startAll();
    }
  }

  // Programme filtering
  const buttons = qsa('.filter-btn');
  const cards = qsa('.programme-card');
  const empty = qs('#programme-empty');

  function applyFilter(category) {
    let visible = 0;
    cards.forEach(card => {
      const match = category === 'all' || card.getAttribute('data-category') === category;
      card.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    if (empty) empty.hidden = visible !== 0;
  }

  if (buttons.length && cards.length) {
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => { b.classList.remove('is-active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('is-active');
        btn.setAttribute('aria-pressed', 'true');
        applyFilter(btn.getAttribute('data-filter'));
      });
    });
  }

  // Footer year
  const y = qs('#year');
  if (y) y.textContent = String(new Date().getFullYear());
})();
