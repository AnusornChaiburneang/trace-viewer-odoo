// A tiny fake Odoo for API tests: login form, session info with a per-user
// language, version_info, res.lang/res.users RPC, and one page whose greeting
// follows the user's language. Not a real Odoo — just the surface the kit uses.
const http = require('http');

function createFixtureOdoo({ version = '17.0', password = 'test-pass' } = {}) {
  const users = { alice: { uid: 7, lang: 'en_US' } };
  const langs = { en_US: '%d/%m/%Y', th_TH: '%d/%m/%Y' };
  const page = (lang) => `<html><head><title>Fixture</title></head><body>
<div class="o_action_manager"><input id="amount" value="10"><input id="search">
<div id="hello">${lang === 'th_TH' ? 'สวัสดี' : 'Hello'}</div>
<div class="o_form_view"><div class="o_statusbar_status"><button class="o_arrow_button_current" data-value="sale">${lang === 'th_TH' ? 'ใบสั่งขาย' : 'Sales Order'}</button></div>
<div class="o_field_widget" name="name"><span>S00042</span></div></div>
<form method="POST"><input id="login" name="login"><input id="password" name="password"><button>Log in</button></form>
</div></body></html>`;
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split('; ').filter(Boolean).map(s => s.split('=')));
  const json = (res, result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result })); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = ''; for await (const c of req) raw += c;
    const c = cookies(req), user = c.user && users[c.user];
    if (url.pathname === '/web/webclient/version_info') return json(res, { server_version: version, server_version_info: [Number(version), 0, 0, 'final', 0, ''] });
    if (url.pathname === '/web/session/get_session_info')
      return json(res, user ? { uid: user.uid, username: c.user, db: c.db, server_version: version, user_context: { lang: user.lang } } : {});
    if (url.pathname.startsWith('/web/dataset/')) {
      const { model, method, args } = JSON.parse(raw).params;
      if (model === 'res.lang') {
        const code = JSON.stringify(args).match(/"code","=","([^"]+)"/);
        const rows = Object.entries(langs).filter(([k]) => !code || k === code[1]).map(([k, f]) => ({ code: k, date_format: f, time_format: '%H:%M:%S' }));
        return json(res, rows);
      }
      if (model === 'res.users' && method === 'write' && user) { user.lang = args[1].lang; return json(res, true); }
      return json(res, []);
    }
    if (req.method === 'POST') {
      const form = new URLSearchParams(raw);
      if (form.get('password') !== password || !users[form.get('login')]) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(page('en_US')); }
      res.writeHead(302, { Location: '/web', 'Set-Cookie': [`user=${form.get('login')}; Path=/`, `db=${url.searchParams.get('db') || 'fixture'}; Path=/`] });
      return res.end();
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const html = page(user ? user.lang : 'en_US');
    res.end(url.pathname === '/web' ? html.replace(/<form.*?<\/form>/s, '') : html);
  });
  return { server, users };
}

module.exports = { createFixtureOdoo };
