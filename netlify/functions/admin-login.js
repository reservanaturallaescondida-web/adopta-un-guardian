// netlify/functions/admin-login.js  (v61)
//
// Puerta de entrada del administrador. Acciones (POST, JSON):
//   estado   → qué necesita el formulario (¿hay captcha?)
//   login    → clave + código de la app (+ captcha si está activo) → cookie de sesión
//   sesion   → ¿sigue vigente mi sesión?
//   stepup   → confirmar con un código nuevo (para acciones delicadas)
//   registro → últimos accesos (necesita sesión)
//   salir    → cerrar sesión
//
// Reglas de seguridad: ver netlify/lib/admin-sesion.js.

const S = require('../lib/admin-sesion');
const F = require('../lib/finanzas');

const BASE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const resp = (code, obj, cookie) => ({ statusCode: code, headers: cookie ? { ...BASE, 'Set-Cookie': cookie } : BASE, body: JSON.stringify(obj) });

// Límites: por dirección IP, y un freno general de emergencia
const POR_IP = { max: 5, ventanaMin: 15, bloqueoMin: 15 };
const GENERAL = { max: 200, ventanaMin: 60, bloqueoMin: 15 };

const GENERICO = 'Clave o código incorrectos.';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido.' });
  if (!S.origenValido(event)) return resp(403, { error: 'Origen no permitido.' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'JSON inválido.' }); }
  if (!b || typeof b !== 'object') return resp(400, { error: 'Solicitud inválida.' });
  const ip = S.ipDe(event);
  const kIp = 'ip:' + S.claveIp(ip);

  try {
    // ── estado ──
    if (b.accion === 'estado') {
      return resp(200, { ok: true, captcha_sitekey: S.captchaActivo() ? process.env.TURNSTILE_SITE_KEY : null });
    }

    // ── salir ──
    if (b.accion === 'salir') return resp(200, { ok: true }, S.cookieBorrar());

    // ── sesión vigente ──
    if (b.accion === 'sesion') {
      const s = S.leerSesion(event);
      if (!s) return resp(401, { error: 'Sin sesión.', codigo: 'sesion' });
      return resp(200, { ok: true, confirmado_seg: S.confirmacionRestante(s) }, S.cookieSesion(S.nuevaSesion(s, false)));
    }

    // ── registro de accesos ──
    if (b.accion === 'registro') {
      const s = S.leerSesion(event);
      if (!s) return resp(401, { error: 'Sin sesión.', codigo: 'sesion' });
      const filas = (await F.leer('accesos_admin_log?select=ts,ip,evento,detalle&order=ts.desc&limit=25')) || [];
      return resp(200, { ok: true, registro: filas }, S.cookieSesion(S.nuevaSesion(s, false)));
    }

    // ── a partir de aquí: acciones que verifican clave o código ──
    const falta = S.configFaltante();
    if (falta.length) {
      console.error('Acceso admin sin configurar. Falta:', falta.join(', '));
      return resp(500, { error: 'El acceso de administrador aún no está configurado en el servidor.' });
    }

    if (b.accion !== 'login' && b.accion !== 'stepup') return resp(400, { error: 'Acción desconocida.' });

    let sesionPrev = null;
    if (b.accion === 'stepup') {
      sesionPrev = S.leerSesion(event);
      if (!sesionPrev) return resp(401, { error: 'Tu sesión venció. Entra de nuevo.', codigo: 'sesion' });
    }

    // Cada intento se cuenta ANTES de revisarlo (así las ráfagas en paralelo tampoco pasan)
    const a = await S.intento(kIp, POR_IP.max, POR_IP.ventanaMin, POR_IP.bloqueoMin);
    if (a.bloqueado) {
      return resp(429, { error: `Demasiados intentos. Intenta de nuevo en ${Math.max(1, Math.ceil(a.espera / 60))} minuto(s).`, espera_seg: a.espera });
    }
    const g = await S.intento('general', GENERAL.max, GENERAL.ventanaMin, GENERAL.bloqueoMin);
    if (g.bloqueado) {
      return resp(429, { error: 'Acceso en pausa por actividad inusual. Intenta de nuevo en unos minutos.', espera_seg: g.espera });
    }

    // ── confirmar con código (acciones delicadas) ──
    if (b.accion === 'stepup') {
      const paso = S.pasoTotp(process.env.ADMIN_TOTP_SECRET, b.codigo);
      if (paso === null) { await S.esperar(900); await S.registrar(ip, 'confirmar_fallo'); return resp(401, { error: 'Código incorrecto.' }); }
      if (!(await S.usarPasoTotp(paso))) { return resp(401, { error: 'Ese código ya se usó. Espera a que cambie (30 segundos) y escribe el nuevo.', codigo: 'totp_usado' }); }
      await S.limpiarIntentos(kIp);
      await S.registrar(ip, 'confirmar_ok');
      return resp(200, { ok: true, confirmado_seg: S.STEPUP_SEG }, S.cookieSesion(S.nuevaSesion(sesionPrev, true)));
    }

    // ── login ──
    if (S.captchaActivo()) {
      if (!(await S.verificarCaptcha(b.captcha, ip))) {
        await S.esperar(500); await S.registrar(ip, 'login_captcha_fallo');
        return resp(400, { error: 'No pudimos verificar el captcha. Inténtalo de nuevo.', codigo: 'captcha' });
      }
    }
    const claveOk = await S.verificarClave(b.clave, process.env.ADMIN_PASS_PBKDF2);
    const paso = S.pasoTotp(process.env.ADMIN_TOTP_SECRET, b.codigo);
    if (!claveOk || paso === null) {
      await S.esperar(900); await S.registrar(ip, 'login_fallo');
      return resp(401, { error: GENERICO });
    }
    if (!(await S.usarPasoTotp(paso))) {
      await S.registrar(ip, 'login_codigo_repetido');
      return resp(401, { error: 'Ese código ya se usó. Espera a que cambie (30 segundos) y escribe el nuevo.', codigo: 'totp_usado' });
    }
    await S.limpiarIntentos(kIp);
    await S.registrar(ip, 'login_ok');
    return resp(200, { ok: true }, S.cookieSesion(S.nuevaSesion(null, true)));
  } catch (e) {
    console.error('admin-login:', e);
    return resp(503, { error: 'No pudimos verificar el acceso en este momento. Intenta de nuevo en un minuto.' });
  }
};
