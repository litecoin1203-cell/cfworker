/* Servers: one unified list with search, country/protocol filters (only from what the subscription carries),
 * sort by latency, favorites and "fastest server automatically". Rows are keyed by server and reused: a ping
 * result rewrites one latency label, a connection change touches the two rows involved, and the order only
 * changes when the person asks for it (sort, filter, search), so the list never jumps under a finger.
 * Nothing about where a server comes from (address, panel, source) is shown or kept here. */
(function () {
  'use strict';
  const CG = window.CG;
  const { t, esc, S, on, screens, hasActivePlan, syncVpn } = CG;
  const I18 = CG.i18n;

  const recall = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  // favorites are stored by the server's stable key (the same on every sync), on this phone only
  let favs = new Set((() => { try { return JSON.parse(recall('cg_favs', '[]')); } catch (e) { return []; } })());
  const saveFavs = () => keep('cg_favs', JSON.stringify(Array.from(favs)));

  const norm = (s) => String(s || '').toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').trim();
  const PROTO = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', ss: 'Shadowsocks', hysteria2: 'Hysteria2', tuic: 'TUIC', wireguard: 'WireGuard', socks: 'SOCKS', http: 'HTTP' };
  const proto = (s) => PROTO[(s.type || '').toLowerCase()] || (s.type || '').toUpperCase();
  const ms = (s) => (S.serverPings || {})[s.guid] || 0;

  function latencyText(s) {
    const v = ms(s);
    return v > 0 ? t('conn.ms.short', { n: I18.n(v) }) : v < 0 ? t('sv.lat.fail') : '';
  }
  function latencyA11y(s) {
    const v = ms(s);
    return v > 0 ? t('sv.lat.value', { n: I18.n(v) }) : v < 0 ? t('sv.lat.fail') : t('sv.lat.unknown');
  }
  const bars = (s) => { const v = ms(s); return v <= 0 ? 0 : v < 150 ? 4 : v < 300 ? 3 : v < 600 ? 2 : 1; };

  screens.servers = {
    flow: true,
    html: () => `
      <div class="fl-scroll js-scroll"><div class="fl-col">
        ${CG.ui.appBar(t('sv.title'), { trailing: `<button type="button" class="iconbtn js-sync" aria-label="${esc(t('sv.refresh'))}">${CG.ui.ic('refresh')}</button>` })}
        <div class="js-gate"></div>
        <div class="js-body">
          <button type="button" class="smartcard js-smart" aria-pressed="false">
            ${CG.ui.ic('bolt')}
            <span class="rb"><b>${esc(t('sv.smart.title'))}</b><span>${esc(t('sv.smart.sub'))}</span><em class="smartcard-tag js-smart-tag"></em></span>
          </button>
          <label class="search">${CG.ui.ic('search')}<input type="search" name="q" class="js-q" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="${esc(t('sv.search'))}" aria-label="${esc(t('sv.search.a11y'))}"></label>
          <div class="chips js-scope" role="radiogroup" aria-label="${esc(t('sv.filters.a11y'))}"></div>
          <div class="chips js-facets" aria-label="${esc(t('sv.filters.a11y'))}"></div>
          <div class="sv-tools">
            <button type="button" class="chip js-sort" aria-pressed="false">${CG.ui.ic('sort')}<span></span></button>
            <button type="button" class="chip js-test">${CG.ui.ic('signal')}<span>${esc(t('sv.test'))}</span></button>
          </div>
          <p class="sr-only js-count" aria-live="polite"></p>
          <div class="js-list"></div>
        </div>
      </div></div>
      ${CG.ui.tabs('servers')}`,
    mount(root) {
      const $ = (c) => root.querySelector(c);
      const ui = CG.ui;
      ui.bindTabs(root);
      const st = { q: '', scope: recall('cg_sv_scope', 'all'), cc: '', proto: '', sort: recall('cg_sv_sort', 'latency'), testing: false };
      const rows = new Map(); // guid -> row element (reused across renders)

      // ---- one row ----
      function makeRow(s) {
        const el = document.createElement('div');
        el.className = 'srow';
        el.dataset.guid = s.guid;
        el.innerHTML = `<button type="button" class="srow-main">
            <span class="rb"><b class="js-n" translate="no"></b><span class="js-sub"></span></span>
            <span class="lat js-lat" aria-hidden="true"><i class="bars"><i></i><i></i><i></i><i></i></i><span></span></span>
          </button>
          <button type="button" class="star js-star">${ui.ic('star')}</button>`;
        el.querySelector('.srow-main').onclick = () => pick(s.guid);
        el.querySelector('.js-star').onclick = () => toggleFav(s);
        fillRow(el, s);
        return el;
      }
      function fillRow(el, s) {
        // the name exactly as the API sends it; the line under it is only the protocol, never an address
        const name = CG.serverName(s);
        const sub = proto(s);
        el.querySelector('.js-n').textContent = name;
        el.querySelector('.js-sub').textContent = sub;
        paintLatency(el, s);
        paintCurrent(el, s);
        paintStar(el, s);
      }
      function paintLatency(el, s) {
        const lat = el.querySelector('.js-lat');
        lat.dataset.lv = String(bars(s));
        lat.classList.toggle('fail', ms(s) < 0);
        lat.querySelector('span').textContent = latencyText(s);
        a11y(el, s);
      }
      function paintCurrent(el, s) {
        const isCur = !S.auto && s.guid === S.selected;
        el.classList.toggle('cur', isCur);
        el.querySelector('.srow-main').setAttribute('aria-current', isCur ? 'true' : 'false');
        a11y(el, s);
      }
      function paintStar(el, s) {
        const on_ = favs.has(s.k);
        const b = el.querySelector('.js-star');
        b.setAttribute('aria-pressed', on_ ? 'true' : 'false');
        b.setAttribute('aria-label', t(on_ ? 'sv.fav.remove' : 'sv.fav.add', { name: CG.serverName(s) }));
      }
      function a11y(el, s) {
        const isCur = !S.auto && s.guid === S.selected;
        const ph = CG.phase();
        const state = isCur ? t('sv.row.current') + (ph === 'connected' || ph === 'connecting' ? t('common.sep') + t(ui.PHASE[ph].word) : '') : '';
        el.querySelector('.srow-main').setAttribute('aria-label', t('sv.row.a11y', { name: CG.serverName(s), proto: proto(s), latency: latencyA11y(s), state }));
      }

      // ---- what to show ----
      function visible() {
        let list = S.servers.slice();
        if (st.scope === 'fav') list = list.filter((s) => favs.has(s.k));
        if (st.scope === 'google') list = list.filter((s) => CG.googleOk(s) === true);
        if (st.cc) list = list.filter((s) => s.cc === st.cc);
        if (st.proto) list = list.filter((s) => proto(s) === st.proto);
        if (st.q) {
          const q = norm(st.q);
          list = list.filter((s) => norm(CG.serverName(s)).includes(q) || norm(s.cc) === q || norm(I18.country(s.cc)).includes(q));
        }
        if (st.sort === 'latency') {
          const key = (s) => { const v = ms(s); return v > 0 ? v : v < 0 ? 1e9 : 1e8; };
          list.sort((a, b) => key(a) - key(b));
        }
        return list;
      }

      function renderList() {
        const box = $('.js-list');
        const list = visible();
        const favList = st.scope === 'all' && !st.q ? list.filter((s) => favs.has(s.k)) : [];
        const rest = favList.length ? list.filter((s) => !favs.has(s.k)) : list;
        // keyed: reuse each server's row, only move it
        const frag = document.createDocumentFragment();
        const head = (txt) => { const h = document.createElement('h2'); h.className = 'section'; h.textContent = txt; return h; };
        const group = (items) => {
          const g = document.createElement('div'); g.className = 'list';
          items.forEach((s) => { let el = rows.get(s.guid); if (!el) { el = makeRow(s); rows.set(s.guid, el); } g.appendChild(el); });
          return g;
        };
        if (favList.length) { frag.appendChild(head(t('sv.favs'))); frag.appendChild(group(favList)); frag.appendChild(head(t('sv.all'))); }
        if (rest.length) frag.appendChild(group(rest));
        box.replaceChildren(frag);
        if (!list.length) {
          const msg = st.q ? 'sv.empty.search' : st.scope === 'fav' ? 'sv.empty.fav' : st.scope === 'google' ? 'sv.empty.google' : 'sv.empty.none';
          box.innerHTML = `<p class="empty t-body c-2">${esc(t(msg))}</p>`;
        }
        $('.js-count').textContent = t('sv.count', { n: I18.n(list.length) });
      }

      function renderChips() {
        const hasGoogle = S.servers.some((s) => CG.googleOk(s) !== null);
        if (st.scope === 'google' && !hasGoogle) st.scope = 'all';
        const scopes = [['all', 'sv.filter.all'], ['fav', 'sv.filter.fav']].concat(hasGoogle ? [['google', 'sv.filter.google']] : []);
        $('.js-scope').innerHTML = scopes.map(([id, label]) => `<button type="button" class="chip" role="radio" data-scope="${id}" aria-checked="${st.scope === id}">${id === 'fav' ? ui.ic('star') : ''}<span>${esc(t(label))}</span></button>`).join('');
        // country / protocol filters only when the subscription itself has more than one
        const ccs = Array.from(new Set(S.servers.map((s) => s.cc).filter(Boolean)));
        const protos = Array.from(new Set(S.servers.map(proto).filter(Boolean)));
        const facets = (ccs.length > 1 ? ccs.map((cc) => `<button type="button" class="chip" data-cc="${esc(cc)}" aria-pressed="${st.cc === cc}"><span>${esc(I18.country(cc))}</span></button>`) : [])
          .concat(protos.length > 1 ? protos.map((p) => `<button type="button" class="chip" data-proto="${esc(p)}" aria-pressed="${st.proto === p}"><span>${esc(p)}</span></button>`) : []);
        $('.js-facets').innerHTML = facets.join('');
        $('.js-facets').hidden = !facets.length;
        root.querySelectorAll('[data-scope]').forEach((b) => { b.onclick = () => { st.scope = b.dataset.scope; keep('cg_sv_scope', st.scope); renderChips(); renderList(); }; });
        root.querySelectorAll('[data-cc]').forEach((b) => { b.onclick = () => { st.cc = st.cc === b.dataset.cc ? '' : b.dataset.cc; renderChips(); renderList(); }; });
        root.querySelectorAll('[data-proto]').forEach((b) => { b.onclick = () => { st.proto = st.proto === b.dataset.proto ? '' : b.dataset.proto; renderChips(); renderList(); }; });
        const sort = $('.js-sort');
        sort.setAttribute('aria-pressed', st.sort === 'latency' ? 'true' : 'false');
        sort.querySelector('span').textContent = t(st.sort === 'latency' ? 'sv.sort.latency' : 'sv.sort.default');
      }

      function paintSmart() {
        const b = $('.js-smart');
        b.setAttribute('aria-pressed', S.auto ? 'true' : 'false');
        $('.js-smart-tag').textContent = S.auto ? t('sv.smart.active') : '';
        let best = '';
        if (S.rank && S.rank.isp && S.rank.asn) best = t('sv.best', { isp: S.rank.isp });
        b.querySelector('.rb span').textContent = t('sv.smart.sub') + (best ? ' ' + best + '.' : '');
      }

      function gate() {
        const g = $('.js-gate'), body = $('.js-body');
        if (!hasActivePlan()) {
          body.hidden = true;
          g.innerHTML = ui.notice('info', t('sv.nosub'), '', `<button type="button" class="btn primary js-buy">${esc(t(S.me && S.me.subscription ? 'conn.btn.renew' : 'conn.btn.buy'))}</button>`);
          g.querySelector('.js-buy').onclick = () => CG.go('premium', { from: 'servers' });
          return false;
        }
        body.hidden = false;
        if (S.syncError && !S.servers.length) {
          g.innerHTML = ui.notice('bad', ui.errText(S.syncError), '', `<button type="button" class="btn quiet js-retry">${esc(t('common.retry'))}</button>`);
          g.querySelector('.js-retry').onclick = () => resync(false);
        } else if (!S.servers.length) {
          g.innerHTML = `<div role="status" aria-label="${esc(t('sv.loading'))}">${'<span class="skel h-row"></span>'.repeat(4)}</div>`;
        } else g.innerHTML = '';
        return true;
      }

      // ---- actions ----
      function pick(guid) {
        if (!S.auto && guid === S.selected && (S.vpn.running || S.vpn.busy === 'connecting')) { CG.tab('home'); return; }
        CG.setAuto(false);
        CG.connect(guid);
        CG.tab('home');
      }
      function toggleFav(s) {
        if (favs.has(s.k)) favs.delete(s.k); else favs.add(s.k);
        saveFavs();
        const el = rows.get(s.guid);
        if (el) paintStar(el, s);
        // the favorites group changes shape only in the "all" view; keep the tapped star under the finger elsewhere
        if (st.scope === 'fav' || (st.scope === 'all' && !st.q)) renderList();
        const b = rows.get(s.guid) && rows.get(s.guid).querySelector('.js-star');
        if (b) b.focus();
      }
      async function resync(toastIt) {
        const btn = $('.js-sync');
        btn.setAttribute('aria-busy', 'true');
        try {
          const r = await syncVpn();
          rows.clear();
          if (toastIt) CG.toast(t(r && r.stale ? 'sv.stale' : 'sv.updated'));
        } catch (e) { S.syncError = e; if (toastIt) CG.toast(ui.errText(e), true); }
        btn.removeAttribute('aria-busy');
        gate(); renderChips(); renderList();
      }
      $('.js-sync').onclick = () => resync(true);
      $('.js-smart').onclick = () => {
        CG.setAuto(true);
        rows.forEach((el, guid) => { const s = S.servers.find((x) => x.guid === guid); if (s) paintCurrent(el, s); });
        if (!S.vpn.busy) CG.connect(); // connected: switches to the best server, like before
        CG.tab('home');
      };
      const q = $('.js-q');
      let qt = 0;
      q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { st.q = q.value; renderList(); }, 150); };
      $('.js-sort').onclick = () => { st.sort = st.sort === 'latency' ? 'default' : 'latency'; keep('cg_sv_sort', st.sort); renderChips(); renderList(); };
      $('.js-test').onclick = async () => {
        if (st.testing) return;
        st.testing = true;
        const b = $('.js-test');
        b.setAttribute('aria-busy', 'true'); b.querySelector('span').textContent = t('sv.testing');
        await CG.testAll(9000);
        st.testing = false;
        b.removeAttribute('aria-busy'); b.querySelector('span').textContent = t('sv.test');
        if (st.sort === 'latency') renderList(); // reorder once, when the test the person asked for is done
        ui.announce(t('sv.tested'));
      };

      // ---- live updates without re-rendering the list ----
      const offPing = on('serverPing', (v) => {
        if (!v || !v.guid) return;
        // this listener can run before the one in vpn.js that stores the number, so store it here too
        if (typeof v.ms === 'number') (S.serverPings = S.serverPings || {})[v.guid] = v.ms;
        const el = rows.get(v.guid), s = S.servers.find((x) => x.guid === v.guid);
        if (el && s) paintLatency(el, s);
      });
      let lastSel = S.selected;
      const offConn = on('conn', (w) => {
        if (w.phase || w.server || w.auto) {
          [lastSel, S.selected].forEach((guid) => { const el = rows.get(guid), s = S.servers.find((x) => x.guid === guid); if (el && s) paintCurrent(el, s); });
          lastSel = S.selected;
          paintSmart();
        }
        if (w.rank) { paintSmart(); renderChips(); }
        if (w.me && gate()) { renderChips(); renderList(); }
      });

      CG.startLive();
      paintSmart();
      if (gate()) { renderChips(); renderList(); }
      CG.ispRank().catch(() => {});
      if (hasActivePlan() && !S.servers.length) resync(false);
      return () => { offPing(); offConn(); clearTimeout(qt); CG.stopLive(); };
    },
  };
})();
