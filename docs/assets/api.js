(function () {
  'use strict';
  const config = window.LIMS_CONFIG || {};
  // sessionStorage is scoped by repository path because GitHub projects share an origin.
  const base = new URL('.', location.href);
  const key = 'lims.session:' + base.pathname;
  const publicMethods = new Set(['login', 'register', 'publicClients', 'health']);
  function endpoint() {
    const value = String(config.apiUrl || '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value)) {
      throw new Error('The laboratory API is not configured. Contact your administrator.');
    }
    return value;
  }
  function isConfigured() { try { endpoint(); return true; } catch (_) { return false; } }
  function session() {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
  function clearSession() { try { sessionStorage.removeItem(key); } catch (_) {} }
  function signOutLocal() {
    clearSession();
    location.replace(new URL('index.html', base).href);
  }
  function saveSession(result) {
    if (!result || !/^[a-f0-9]{64}$/.test(result.token) || !['Client','Staff','Admin'].includes(result.portal)) {
      throw new Error('The API returned an invalid session.');
    }
    try { sessionStorage.setItem(key, JSON.stringify({token:result.token, portal:result.portal})); }
    catch (_) { throw new Error('Browser session storage is unavailable. Enable site storage and sign in again.'); }
  }
  function openPortal(portal) { location.assign(new URL(portal === 'Client' ? 'client.html' : 'staff.html', base).href); }
  function checkPortal(portal) {
    const expected = portal === 'Client' ? 'client.html' : 'staff.html';
    if (location.pathname.split('/').pop() !== expected) { openPortal(portal); return false; }
    return true;
  }
  async function request(method, args, token) {
    const url = endpoint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs) || 90000);
    try {
      // A text/plain POST is CORS-safelisted. JSON and credentials stay in the body.
      // Do not use application/json, Authorization headers, no-cors, JSONP or GET mutations.
      const response = await fetch(url, {
        method:'POST', mode:'cors', credentials:'omit', redirect:'follow',
        headers:{'Content-Type':'text/plain;charset=UTF-8'},
        body:JSON.stringify({version:1, method, args, token:token || ''}),
        signal:controller.signal
      });
      if (!response.ok) throw new Error('The API is unavailable (HTTP ' + response.status + ').');
      let envelope;
      try { envelope = await response.json(); }
      catch (_) { throw new Error('The API did not return JSON. Ask the administrator to check its deployment and access settings.'); }
      if (!envelope || typeof envelope.ok !== 'boolean') throw new Error('The API response format is invalid.');
      if (!envelope.ok) {
        const error = new Error(envelope.error?.message || 'The request failed.');
        error.code = envelope.error?.code || 'API_ERROR';
        if (error.code === 'SESSION_EXPIRED' && token) signOutLocal();
        throw error;
      }
      return envelope.data;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) {
        throw new Error('The server response could not be confirmed. Check your connection and refresh the record before repeating a save; the first request may have completed.');
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function call(method, ...args) {
    const current = session();
    if (!current?.token) { signOutLocal(); throw new Error('SESSION_EXPIRED'); }
    const result = await request(method, args, current.token);
    if (method === 'logout') clearSession();
    if (method === 'changePassword') { clearSession(); setTimeout(signOutLocal, 1200); }
    return result;
  }
  function publicCall(method, ...args) {
    if (!publicMethods.has(method)) return Promise.reject(new Error('Unknown public operation.'));
    return request(method, args, '');
  }
  window.LimsAPI = Object.freeze({endpoint,isConfigured,call,publicCall,saveSession,openPortal,checkPortal,signOutLocal});
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-lab-name]').forEach(el => { el.textContent = config.labName || 'Laboratory'; });
    // Old links cannot import a bearer token into this frontend.
    const url = new URL(location.href);
    if (url.searchParams.has('t')) { url.searchParams.delete('t'); history.replaceState(null, '', url.href); }
    if (url.searchParams.has('verify') && isConfigured()) {
      const verify = new URL(endpoint()); verify.searchParams.set('verify', url.searchParams.get('verify'));
      location.replace(verify.href);
    }
  });
})();
