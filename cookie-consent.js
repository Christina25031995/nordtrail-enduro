/* Enduro Energy: cookie-баннер и загрузка Яндекс Метрики только после согласия.
   Выбор хранится в localStorage (ключ ee_cookie_consent): "all" или "necessary". */
(function () {
  'use strict';
  var KEY = 'ee_cookie_consent';
  var METRIKA_ID = 111744225;
  var metrikaLoaded = false;

  function getChoice() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function setChoice(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  function loadMetrika() {
    if (metrikaLoaded) return;
    metrikaLoaded = true;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (var j = 0; j < document.scripts.length; j++) {
        if (document.scripts[j].src === r) { return; }
      }
      k = e.createElement(t), a = e.getElementsByTagName(t)[0], k.async = 1, k.src = r, a.parentNode.insertBefore(k, a);
    })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=' + METRIKA_ID, 'ym');
    window.ym(METRIKA_ID, 'init', { ssr: true, webvisor: true, clickmap: true, ecommerce: 'dataLayer', accurateTrackBounce: true, trackLinks: true });
  }

  function clearMetrikaCookies() {
    var host = location.hostname;
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (/^_ym|^yandexuid$|^yabs-sid$/.test(name)) {
        ['', host, '.' + host].forEach(function (d) {
          document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
        });
      }
    });
  }

  var STYLE = '' +
    '#ee-cookie{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1000;' +
    'width:min(560px,calc(100vw - 32px));box-sizing:border-box;padding:16px 18px;border-radius:12px;' +
    'background:rgba(16,20,17,0.96);border:1px solid rgba(255,255,255,0.12);box-shadow:0 16px 40px rgba(0,0,0,0.45);' +
    '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#f5f2ea;' +
    "font-family:'DM Sans',system-ui,sans-serif;font-size:0.88rem;line-height:1.5;}" +
    '#ee-cookie[hidden]{display:none}' +
    '#ee-cookie p{margin:0 0 12px;color:rgba(245,242,234,0.8);}' +
    '#ee-cookie a{color:#ffab7a;text-decoration:underline;text-underline-offset:2px;}' +
    '#ee-cookie .ee-cookie-btns{display:flex;flex-wrap:wrap;gap:8px;}' +
    '#ee-cookie button{flex:1 1 150px;min-height:40px;padding:0.55rem 1rem;border-radius:8px;cursor:pointer;' +
    "font:700 0.85rem 'DM Sans',system-ui,sans-serif;transition:background 0.2s,border-color 0.2s;}" +
    '#ee-cookie .ee-accept{background:#ff6b2c;color:#0c0f0d;border:1px solid #ff6b2c;}' +
    '#ee-cookie .ee-accept:hover{background:#ff8347;}' +
    '#ee-cookie .ee-necessary{background:transparent;color:#f5f2ea;border:1px solid rgba(255,255,255,0.25);}' +
    '#ee-cookie .ee-necessary:hover{border-color:#ff6b2c;background:rgba(255,107,44,0.12);}' +
    '#ee-cookie button:focus-visible{outline:2px solid #ffab7a;outline-offset:2px;}';

  var banner = null;

  function buildBanner() {
    if (banner) return banner;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    banner = document.createElement('div');
    banner.id = 'ee-cookie';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Настройки cookie');
    banner.hidden = true;
    banner.innerHTML =
      '<p>Сайт использует cookie и Яндекс Метрику для аналитики. Подробнее — в <a href="privacy.html">Политике</a>.</p>' +
      '<div class="ee-cookie-btns">' +
      '<button type="button" class="ee-accept">Принять</button>' +
      '<button type="button" class="ee-necessary">Только необходимые</button>' +
      '</div>';
    banner.querySelector('.ee-accept').addEventListener('click', function () {
      setChoice('all');
      hideBanner();
      loadMetrika();
    });
    banner.querySelector('.ee-necessary').addEventListener('click', function () {
      setChoice('necessary');
      hideBanner();
      clearMetrikaCookies();
      // Если Метрика уже работала на этой странице — перезагружаем, чтобы она остановилась.
      if (metrikaLoaded) location.reload();
    });
    document.body.appendChild(banner);
    return banner;
  }

  function showBanner() { buildBanner().hidden = false; }
  function hideBanner() { if (banner) banner.hidden = true; }

  // Ссылка «Настройки cookie» (href="#cookie-settings") снова открывает баннер.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href="#cookie-settings"]');
    if (!a) return;
    e.preventDefault();
    showBanner();
  }, true);

  window.eeCookieSettings = showBanner;

  var choice = getChoice();
  if (choice === 'all') loadMetrika();

  function onReady() { if (choice !== 'all' && choice !== 'necessary') showBanner(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
