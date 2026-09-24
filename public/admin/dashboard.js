// Admin hand-off: the public login gate can live on a different origin (e.g. the
// marketing site on http://127.0.0.1:5500), where localStorage is not shared with
// this dashboard. It therefore redirects here with ?token=<jwt>. Consume it once,
// store it like a normal admin session, then strip it from the address bar.
(function () {
  try {
    var m = (location.search || '').match(/[?&]token=([^&]+)/);
    if (!m) return;
    localStorage.setItem('km_admin_token', decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname);
  } catch (e) {}
})();

var API = location.origin;
function tok() { try { return localStorage.getItem('km_admin_token') || ''; } catch (e) { return ''; } }
function authH() { var t = tok(); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
function fail(msg) { var e = document.getElementById('err'); e.style.display = 'block'; e.textContent = msg; }
function clearFail() { var e = document.getElementById('err'); e.style.display = 'none'; e.textContent = ''; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch (e) { return s || ''; } }
// Empty optional fields are shown as "Not provided" — never undefined/null/blank.
function np(v) { var t = String(v == null ? '' : v).trim(); return t ? esc(t) : '<span class="np">Not provided</span>'; }
function statusPill(s) {
  var v = String(s || 'New').trim() || 'New';
  var cls = 'st-' + v.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return '<span class="pill ' + cls + '">' + esc(v) + '</span>';
}

fetch(API + '/api/admin/me', { credentials: 'include', headers: authH() })
  .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
  .then(function (x) {
    if (!(x.ok && x.d.success)) { location.replace('/admin/login'); return; }
    document.getElementById('who').textContent = x.d.user.name + ' (' + x.d.user.email + ')';
    loadServices(); loadStatuses(); loadStats(); load();
  })
  .catch(function () { location.replace('/admin/login'); });

function loadStats() {
  fetch(API + '/api/admin/stats', { credentials: 'include', headers: authH() })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.success) return;
      document.getElementById('c-total').textContent = d.total;
      var nw = (d.byStatus || []).filter(function (x) { return String(x.status).toLowerCase() === 'new'; });
      var newEl = document.getElementById('c-new');
      if (newEl) newEl.textContent = nw.length ? nw[0].n : 0;
      if (document.getElementById('c-clients')) document.getElementById('c-clients').textContent = (d.clients != null ? d.clients : '—');
      document.getElementById('c-latest').textContent = 'Latest: ' + (d.latest ? fmtDate(d.latest) : '-');
      var n = (d.byService || []).length;
      document.getElementById('c-svc').textContent = n;
      document.getElementById('c-top').textContent = 'Top: ' + ((d.byService[0] && d.byService[0].service) || '-');
    }).catch(function () {});
}
function loadServices() {
  fetch(API + '/api/admin/services', { credentials: 'include', headers: authH() })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.success || !d.data) return;
      var s = document.getElementById('service');
      d.data.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; s.appendChild(o); });
    }).catch(function () {});
}
function loadStatuses() {
  fetch(API + '/api/admin/statuses', { credentials: 'include', headers: authH() })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.success || !d.data) return;
      var s = document.getElementById('statusF');
      if (!s) return;
      d.data.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; s.appendChild(o); });
    }).catch(function () {});
}
var debT = null;
function debReload() { clearTimeout(debT); debT = setTimeout(load, 350); }
function resetF() {
  document.getElementById('q').value = '';
  document.getElementById('service').value = '';
  var sf = document.getElementById('statusF'); if (sf) sf.value = '';
  document.getElementById('sort').value = 'latest';
  load();
}
function load() {
  clearFail();
  var q = document.getElementById('q').value.trim();
  var service = document.getElementById('service').value;
  var status = (document.getElementById('statusF') || {}).value || '';
  var sort = document.getElementById('sort').value;
  var url = API + '/api/admin/submissions?q=' + encodeURIComponent(q)
    + '&service=' + encodeURIComponent(service)
    + '&status=' + encodeURIComponent(status)
    + '&sort=' + encodeURIComponent(sort);
  fetch(url, { credentials: 'include', headers: authH() })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
    .then(function (x) {
      if (x.status === 401 || x.status === 403) { location.replace('/admin/login'); return; }
      if (!x.ok || !x.d.success) { fail((x.d && x.d.error) || 'Could not load submissions.'); return; }
      render(x.d.data || []);
    }).catch(function () { fail('Cannot reach the server. Is the backend running?'); });
}
function render(rows) {
  document.getElementById('c-shown').textContent = rows.length;
  var tb = document.getElementById('rows');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="8"><div class="msg">No submissions found.</div></td></tr>'; return; }
  tb.innerHTML = rows.map(function (r) {
    return '<tr><td><b>#' + r.id + '</b></td><td>' + esc(r.name) + '</td><td>' + esc(r.email) + '</td><td>' +
      esc(r.phone || '—') + '</td><td><span class="pill">' + esc(r.service || 'General Service') + '</span></td><td>' +
      statusPill(r.status) + '</td><td>' + esc(fmtDate(r.created_at)) + '</td>' +
      '<td><button class="btn pri" onclick="viewDetail(' + r.id + ')">View Details</button></td></tr>';
  }).join('');
}
function viewDetail(id) {
  clearFail();
  fetch(API + '/api/admin/submissions/' + id, { credentials: 'include', headers: authH() })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
    .then(function (x) {
      if (x.status === 401 || x.status === 403) { location.replace('/admin/login'); return; }
      if (!x.ok || !x.d.success) { fail((x.d && x.d.error) || 'Could not load submission.'); return; }
      var s = x.d.data;
      document.getElementById('m-title').textContent = 'Client Inquiry Details — #' + s.id;
      document.getElementById('m-sub').innerHTML = statusPill(s.status) + ' &nbsp;•&nbsp; Submitted ' + esc(fmtDate(s.created_at));
      function kv(label, valueHtml) { return '<dt>' + label + '</dt><dd>' + valueHtml + '</dd>'; }
      function sec(title) { return '<div class="sec">' + esc(title) + '</div>'; }
      var owner = s.owner_email ? (esc(s.owner_name || s.owner_email) + ' &lt;' + esc(s.owner_email) + '&gt;') : '';
      document.getElementById('m-kv').innerHTML =
        sec('Client Information') +
        kv('Name', np(s.name)) +
        kv('Email', np(s.email)) +
        kv('Phone', np(s.phone)) +
        kv('Company', np(s.company)) +
        kv('Client Account', owner || '<span class="np">Not provided</span>') +
        sec('Project Information') +
        kv('Service (Project Domain)', np(s.service)) +
        kv('Budget', np(s.budget)) +
        kv('NDA Requested', s.nda_requested ? 'Yes' : 'No') +
        kv('Requirements / Message', np(s.details)) +
        sec('Submission Information') +
        kv('Submitted Date', esc(fmtDate(s.created_at))) +
        kv('Status', statusPill(s.status));
      document.getElementById('mbg').classList.add('open');
    }).catch(function () { fail('Could not load submission details.'); });
}
function closeModal() { document.getElementById('mbg').classList.remove('open'); }
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
function doLogout() {
  fetch(API + '/api/admin/logout', { method: 'POST', credentials: 'include', headers: authH() }).finally(function () {
    try { localStorage.removeItem('km_admin_token'); localStorage.removeItem('km_token'); localStorage.removeItem('km_user'); } catch (e) {}
    location.replace('/admin/login');
  });
}

