// netlify/lib/admin-sesion.js  (v61)
//
// Seguridad del acceso de administrador. Lo usan dos funciones:
//   - netlify/functions/admin-login.js       (entrar, salir, confirmar con código)
//   - netlify/functions/admin-adoptantes.js  (todo lo que hace el panel)
//
// Qué resuelve (y por qué):
//   • La clave se guarda con PBKDF2-SHA256 + sal (600.000 vueltas), no con SHA-256
//     simple. Aunque alguien viera la variable de Netlify, probar claves es carísimo.
//   • Segundo factor real: código de 6 dígitos de una app (TOTP, RFC 6238). El
//     secreto vive SOLO en variables de entorno de Netlify, nunca en el navegador.
//   • Tras entrar, el navegador recibe una cookie HttpOnly firmada (30 min de
//     inactividad, 8 h máximo). El JavaScript de la página NO puede leerla ni
//     la clave viaja de nuevo: por eso una inyección de código ya no roba nada.
//   • Freno real a los intentos, contado en el servidor (Supabase), no en el navegador.
//
// Variables de entorno (Netlify):
//   ADMIN_PASS_PBKDF2     'pbkdf2$600000$<sal hex>$<hash hex>'  (lo genera generador-credenciales.html)
//   ADMIN_TOTP_SECRET     secreto TOTP en Base32 (lo genera el mismo generador)
//   ADMIN_SESSION_SECRET  texto aleatorio de 32+ caracteres (firma de la cookie)
//   TURNSTILE_SECRET_KEY / TURNSTILE_SITE_KEY   (opcionales) captcha de Cloudflare

const crypto = require('crypto');
const F = require('./finanzas');

const IDLE_SEG = 30 * 60;      // la sesión caduca tras 30 min sin actividad
const MAX_SEG = 8 * 3600;      // y nunca dura más de 8 horas
const STEPUP_SEG = 5 * 60;     // una confirmación con código vale 5 min
const COOKIE = '__Host-adm';
const ITER_MIN = 210000;       // por debajo de esto se rechaza la configuración
const MAX_CLAVE = 256;

const ahoraSeg = () => Math.floor(Date.now() / 1000);
const b64u = (x) => Buffer.from(x).toString('base64url');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function igual(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ── Configuración ─────────────────────────────────────────────────────────
function configFaltante() {
  const falta = [];
  if (!process.env.ADMIN_PASS_PBKDF2) falta.push('ADMIN_PASS_PBKDF2');
  if (!process.env.ADMIN_TOTP_SECRET) falta.push('ADMIN_TOTP_SECRET');
  if (!process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET.length < 32) falta.push('ADMIN_SESSION_SECRET (mínimo 32 caracteres)');
  return falta;
}

// ── Clave (PBKDF2) ────────────────────────────────────────────────────────
function pbkdf2(clave, sal, iter) {
  return new Promise((res, rej) => crypto.pbkdf2(clave, sal, iter, 32, 'sha256', (e, k) => (e ? rej(e) : res(k))));
}
async function verificarClave(clave, almacenado) {
  const p = String(almacenado || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') throw new Error('ADMIN_PASS_PBKDF2 tiene un formato inválido.');
  const iter = parseInt(p[1], 10);
  if (!(iter >= ITER_MIN)) throw new Error('ADMIN_PASS_PBKDF2 usa muy pocas vueltas.');
  const sal = Buffer.from(p[2], 'hex'); const esperado = Buffer.from(p[3], 'hex');
  if (!sal.length || esperado.length !== 32) throw new Error('ADMIN_PASS_PBKDF2 está incompleto.');
  // NFC: una misma clave con tildes escrita en otro teclado/sistema produce el mismo texto
  const c = String(clave || '').normalize('NFC');
  // Se calcula SIEMPRE (aunque la clave sea absurda) para no revelar nada por el tiempo de respuesta
  const dado = await pbkdf2(c.length > MAX_CLAVE ? c.slice(0, MAX_CLAVE) : c, sal, iter);
  return c.length <= MAX_CLAVE && c.length > 0 && crypto.timingSafeEqual(dado, esperado);
}
async function hashClave(clave, iter = 600000) {
  const sal = crypto.randomBytes(16);
  const h = await pbkdf2(String(clave).normalize('NFC'), sal, iter);
  return `pbkdf2$${iter}$${sal.toString('hex')}$${h.toString('hex')}`;
}

// ── TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 dígitos) ───────────────────────────
function base32Decode(txt) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = String(txt || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let val = 0; const out = [];
  for (const ch of s) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error('ADMIN_TOTP_SECRET no es Base32 válido.');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secreto, contador) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', secreto).update(buf).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
// Devuelve el "paso" de 30 s al que corresponde el código (acepta ±1 paso por desfase
// del reloj del teléfono), o null si no coincide. Se recorren siempre los 3 pasos.
function pasoTotp(secretoB32, codigo, ahoraMs = Date.now()) {
  const c = String(codigo || '').replace(/\s/g, '');
  const secreto = base32Decode(secretoB32);
  const paso = Math.floor(ahoraMs / 30000);
  let hallado = null;
  for (const d of [0, -1, 1]) {
    if (/^\d{6}$/.test(c) && igual(hotp(secreto, paso + d), c) && hallado === null) hallado = paso + d;
  }
  return hallado;
}

// ── Sesión (cookie HttpOnly firmada) ──────────────────────────────────────
function secretoSesion() { return process.env.ADMIN_SESSION_SECRET; }
function firmar(payload) {
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secretoSesion()).update(p).digest());
  return `${p}.${sig}`;
}
function leerCookie(event, nombre) {
  const h = (event && event.headers) || {};
  const raw = h.cookie || h.Cookie || '';
  for (const parte of String(raw).split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}
function leerSesion(event) {
  try {
    if (!secretoSesion() || secretoSesion().length < 32) return null;
    const v = leerCookie(event, COOKIE);
    if (!v) return null;
    const [p, sig] = v.split('.');
    if (!p || !sig) return null;
    const esperada = b64u(crypto.createHmac('sha256', secretoSesion()).update(p).digest());
    if (!igual(sig, esperada)) return null;
    const s = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    const ya = ahoraSeg();
    if (s.v !== 1 || !(s.exp > ya) || !(s.iat + MAX_SEG > ya)) return null;
    return s;
  } catch (e) { return null; }
}
function nuevaSesion(prev, confirmar) {
  const ya = ahoraSeg();
  const iat = prev ? prev.iat : ya;
  return {
    v: 1, iat, exp: Math.min(ya + IDLE_SEG, iat + MAX_SEG),
    su: confirmar ? ya : (prev ? prev.su : 0), n: prev ? prev.n : crypto.randomBytes(8).toString('hex'),
  };
}
const cookieSesion = (s) => `${COOKIE}=${firmar(s)}; Path=/; Max-Age=${Math.max(1, s.exp - ahoraSeg())}; HttpOnly; Secure; SameSite=Strict`;
const cookieBorrar = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
const confirmacionVigente = (s) => !!s && s.su > 0 && ahoraSeg() - s.su <= STEPUP_SEG;
const confirmacionRestante = (s) => (s && s.su ? Math.max(0, STEPUP_SEG - (ahoraSeg() - s.su)) : 0);

// ── Entorno de la petición ────────────────────────────────────────────────
function ipDe(event) {
  const h = (event && event.headers) || {};
  const ip = h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || 'desconocida';
  return ip.slice(0, 64);
}
// Para IPv6 se agrupa por /64 (cualquier dirección del mismo bloque cuenta como la misma)
function claveIp(ip) {
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}
// Defensa contra peticiones enviadas desde otra página (CSRF): si el navegador
// indica de qué sitio viene, tiene que ser este mismo sitio.
function origenValido(event) {
  const h = (event && event.headers) || {};
  const o = h.origin || h.Origin;
  if (!o) return true;
  try {
    const host = h['x-forwarded-host'] || h.host || h.Host;
    return !!host && new URL(o).host === String(host).split(',')[0].trim();
  } catch (e) { return false; }
}

// ── Freno de intentos y registro (Supabase) ───────────────────────────────
async function intento(clave, max, ventanaMin, bloqueoMin) {
  const r = await F.sb('rpc/intento_admin', {
    method: 'POST',
    body: JSON.stringify({ p_clave: clave, p_max: max, p_ventana_min: ventanaMin, p_bloqueo_min: bloqueoMin }),
  });
  const f = Array.isArray(r) ? r[0] : r;
  return { bloqueado: !!(f && f.bloqueado), espera: Number((f && f.restante_seg) || 0) };
}
const limpiarIntentos = (clave) => F.actualizar(`accesos_admin?clave=eq.${F.q(clave)}`, { fallos: 0, ventana_inicio: null, bloqueado_hasta: null });
async function usarPasoTotp(paso) {
  const r = await F.sb('rpc/usar_totp_admin', { method: 'POST', body: JSON.stringify({ p_paso: paso }) });
  return r === true || (Array.isArray(r) && r[0] === true);
}
function registrar(ip, evento, detalle) {
  return F.sb('accesos_admin_log', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ ip, evento, detalle: detalle ? String(detalle).slice(0, 200) : null }]),
  }).catch((e) => console.warn('registro de acceso admin:', e.message));
}

// ── Captcha (Cloudflare Turnstile), opcional ──────────────────────────────
const captchaActivo = () => !!(process.env.TURNSTILE_SECRET_KEY && process.env.TURNSTILE_SITE_KEY);
async function verificarCaptcha(token, ip) {
  if (!token || String(token).length > 2048) return false;
  try {
    const cuerpo = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: String(token) });
    if (ip && ip !== 'desconocida') cuerpo.set('remoteip', ip);
    const r = await fetch(process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: cuerpo });
    const j = await r.json();
    return j && j.success === true;
  } catch (e) { console.error('Turnstile:', e.message); return false; }
}

module.exports = {
  IDLE_SEG, MAX_SEG, STEPUP_SEG, COOKIE,
  esperar, igual, configFaltante,
  verificarClave, hashClave, base32Decode, hotp, pasoTotp,
  firmar, leerSesion, nuevaSesion, cookieSesion, cookieBorrar, confirmacionVigente, confirmacionRestante,
  ipDe, claveIp, origenValido,
  intento, limpiarIntentos, usarPasoTotp, registrar,
  captchaActivo, verificarCaptcha,
};
