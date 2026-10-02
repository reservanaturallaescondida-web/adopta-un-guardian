// netlify/lib/finanzas.js  (v57, v58: acceso al portal del adoptante)
//
// Lógica compartida del SERVIDOR para adopciones, cuotas y contabilidad.
// La usan tres funciones de Netlify:
//   - netlify/functions/registrar-intencion.js  (público: registra el intento de pago)
//   - netlify/functions/wompi-webhook.js        (Wompi: aprueba el pago real)
//   - netlify/functions/admin-adoptantes.js     (admin: verificar, rechazar, registrar pagos)
//
// Este archivo NO es una función (no está dentro de netlify/functions/), así
// que no tiene URL pública: solo se incluye dentro de las funciones que lo
// requieren. Todas las escrituras usan la Service Role Key (variable de
// entorno de Netlify), nunca la anon key pública del sitio.
//
// Tablas (ver GUIA_SUPABASE_v5_v57.sql): intenciones_pago, cuotas,
// libro_contable, adoptantes, guardianes, config_sitio.

const SUPABASE_URL = process.env.SUPABASE_URL_OVERRIDE || 'https://rbryttidysmkkjmmsezj.supabase.co';

// ── Acceso a Supabase (REST) con la Service Role Key ──────────────────────
async function sb(path, opciones = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no configurado en Netlify.');
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(opciones.headers || {}),
    },
  });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => '');
    const err = new Error(`Supabase ${opciones.method || 'GET'} ${path.split('?')[0]} → ${resp.status} ${texto.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  const txt = await resp.text();
  return txt ? JSON.parse(txt) : null;
}
const q = encodeURIComponent;
const leer = (path) => sb(path, { method: 'GET' });
const upsert = (tabla, filas, ignorar = false) => sb(tabla, {
  method: 'POST',
  headers: { Prefer: `resolution=${ignorar ? 'ignore' : 'merge'}-duplicates,return=minimal` },
  body: JSON.stringify(filas),
});
const actualizar = (pathConFiltro, cambios) => sb(pathConFiltro, {
  method: 'PATCH',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify(cambios),
});
const borrar = (pathConFiltro) => sb(pathConFiltro, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

// ── Modelo financiero (misma fórmula que calcular() en index.html) ────────
const DEF = { lechon: 300000, bulto: 110000, admin: 20000, meses: 5, peso: 180, perd: 36, plb: 10000, pct: 65 };

async function leerConfig() {
  let fila = null;
  try { fila = (await leer('config_sitio?id=eq.1&select=*'))?.[0] || null; } catch (e) { console.warn('config_sitio no disponible, se usan valores por defecto:', e.message); }
  const n = (k) => { const v = parseFloat(fila?.[k]); return Number.isFinite(v) && v > 0 ? v : DEF[k]; };
  return { lechon: n('lechon'), bulto: n('bulto'), admin: n('admin'), meses: Math.round(n('meses')), peso: n('peso'), perd: n('perd'), plb: n('plb'), pct: n('pct') };
}

function calcular(c) {
  const primerPago = c.lechon + c.bulto + c.admin;
  const cuotaMes = c.bulto + c.admin;
  const totalInv = primerPago + (c.meses - 1) * cuotaMes;
  const ingreso = (c.peso - c.perd) * c.plb;
  const adoptante = (ingreso - totalInv) * (c.pct / 100);
  return { primerPago, cuotaMes, totalInv, retorno: Math.round(totalInv + adoptante), meses: c.meses };
}

const hoyISO = () => new Date().toISOString().slice(0, 10);
const hoyCO = () => new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
const idCuota = (cc, mes) => `${cc}-${mes}`;

// ── Lecturas ──────────────────────────────────────────────────────────────
const leerIntencion = async (ref) => (await leer(`intenciones_pago?reference=eq.${q(ref)}&select=*`))?.[0] || null;
const leerAdoptante = async (cc) => (await leer(`adoptantes?cc=eq.${q(cc)}&select=*`))?.[0] || null;
const leerGuardian = async (id) => (await leer(`guardianes?id=eq.${q(id)}&select=id,estado,cedula`))?.[0] || null;
const leerCuotas = async (cc) => (await leer(`cuotas?cc=eq.${q(cc)}&select=*&order=mes.asc`)) || [];

// ¿Puede esta cédula adoptar este guardián? (libre, o ya es suyo)
async function guardianLibrePara(gid, cc) {
  const g = await leerGuardian(gid);
  if (!g) return true;
  if (g.estado === 'disponible') return true;
  return !!g.cedula && String(g.cedula) === String(cc);
}

// Monto que corresponde a una cuota: el saldo real si ya existe, si no el estándar
async function montoDeCuota(cc, mes, C) {
  if (cc) {
    const c = (await leer(`cuotas?id=eq.${q(idCuota(cc, mes))}&select=saldo`))?.[0];
    if (c && c.saldo > 0) return c.saldo;
  }
  return mes === 1 ? C.primerPago : C.cuotaMes;
}

// Crea el calendario de N cuotas (sin pagar) si la cédula aún no tiene uno
// mesActual > 1 sin calendario previo = adoptante de antes de v57: las cuotas
// anteriores se marcan pagadas como "histórico" (sin asiento contable nuevo).
async function asegurarCalendario(cc, C, fechaBase, mesActual = 1) {
  const existentes = await leerCuotas(cc);
  if (existentes.length) return existentes;
  const base = new Date(fechaBase || Date.now());
  if (mesActual > 1) base.setDate(base.getDate() - (mesActual - 1) * 30);
  const filas = [];
  for (let m = 1; m <= C.meses; m++) {
    const vence = new Date(base); vence.setDate(vence.getDate() + (m - 1) * 30);
    const monto = m === 1 ? C.primerPago : C.cuotaMes;
    const hist = m < mesActual;
    filas.push({
      id: idCuota(cc, m), cc, mes: m,
      concepto: m === 1 ? 'Lechón + Concentrado + Admin' : 'Concentrado + Admin',
      monto, pagado: hist ? monto : 0, saldo: hist ? 0 : monto, fecha_vence: vence.toISOString().slice(0, 10),
      fecha_pago: null, estado: hist ? 'al-dia' : 'pendiente',
      historial: hist ? [{ tipo: 'historico', nota: 'Pagada antes de v57 (sin detalle en el servidor)' }] : [],
      actualizado_en: new Date().toISOString(),
    });
  }
  await upsert('cuotas', filas, true);
  return leerCuotas(cc);
}

// Aplica un pago a una cuota y lo anota UNA sola vez en el libro contable
// (libroId es la llave: si Wompi reintenta el aviso, no se duplica).
async function aplicarPagoCuota({ cc, mes, monto, metodo, reference, libroId, adoptanteNom, gdn }) {
  const c = (await leer(`cuotas?id=eq.${q(idCuota(cc, mes))}&select=*`))?.[0];
  if (!c) throw new Error(`No existe la cuota ${mes} de la cédula ${cc}.`);
  const yaAnotado = (await leer(`libro_contable?id=eq.${q(libroId)}&select=id`))?.length > 0;
  if (yaAnotado) return c;
  const abono = Math.min(Math.max(0, Math.round(monto)), Math.max(0, c.saldo)) || 0;
  const pagado = c.pagado + abono;
  const saldo = Math.max(0, c.monto - pagado);
  const historial = [...(Array.isArray(c.historial) ? c.historial : []), { fecha: hoyISO(), monto: abono, tipo: saldo <= 0 ? 'pago-completo' : 'pago-parcial', metodo, reference }];
  await upsert('libro_contable', [{
    id: libroId, fecha: hoyISO(), cc, adoptante: adoptanteNom || null,
    concepto: `Pago Mes ${mes}${saldo > 0 ? ' (parcial)' : ''} — ${gdn || ''}`.trim(),
    ingreso: abono, egreso: 0, tipo: `💳 ${metodo || 'Pago'}`, reference: reference || null,
  }], true);
  const [act] = await actualizar(`cuotas?id=eq.${q(c.id)}`, {
    pagado, saldo, historial, fecha_pago: hoyISO(), estado: saldo <= 0 ? 'al-dia' : 'pendiente',
    metodo: metodo || null, reference: reference || null, actualizado_en: new Date().toISOString(),
  });
  return act || c;
}

// "Mes X/N" = la cuota más alta ya pagada completa
async function resumenProgreso(cc, meses) {
  const cuotas = await leerCuotas(cc);
  const pagadas = cuotas.filter((x) => x.saldo <= 0).map((x) => x.mes);
  const x = pagadas.length ? Math.max(...pagadas) : 1;
  return { mes: `Mes ${x}/${meses}`, completo: pagadas.length >= meses };
}

async function reservarGuardian(i, extra = {}) {
  await upsert('guardianes', [{
    id: i.guardian_id, nombre: i.guardian_nombre || null, estado: 'adoptado',
    nombre_adoptante: i.nom, email_adoptante: i.email || null, telefono: i.tel || null,
    direccion: i.ciu || null, cedula: i.cc, clave: String(i.cc).slice(-4),
    monto_pagado: extra.monto_pagado ?? null, mes_pagado: extra.mes_pagado ?? null,
    tx_id: i.reference, actualizado_en: new Date().toISOString(),
  }]);
}

async function guardarAdoptanteDesdeIntencion(i, C, est) {
  const previo = await leerAdoptante(i.cc);
  const prog = await resumenProgreso(i.cc, C.meses);
  const fila = {
    cc: i.cc,
    nom: previo?.nom || i.nom,
    email: i.email || previo?.email || null,
    tel: i.tel || previo?.tel || null,
    ciu: i.ciu || previo?.ciu || null,
    gdn: previo?.gdn || `${i.guardian_nombre || ''} ${i.guardian_id}`.trim(),
    inv: previo?.inv ?? C.totalInv,
    ret: previo?.ret ?? C.retorno,
    mes: prog.mes,
    est: est || (prog.completo ? 'compl' : 'ok'),
    fecha: previo?.fecha || hoyCO(),
    pin: previo?.pin || String(i.cc).slice(-4),
    tx_id: i.reference,
    actualizado_en: new Date().toISOString(),
  };
  await upsert('adoptantes', [fila]);
  return fila;
}

// Reclama una intención de forma atómica (evita procesarla dos veces si
// llegan dos avisos de Wompi al mismo tiempo).
async function reclamar(ref, desde, hacia) {
  const filas = await actualizar(`intenciones_pago?reference=eq.${q(ref)}&estado=eq.${q(desde)}`, { estado: hacia, procesado_en: new Date().toISOString() });
  return Array.isArray(filas) && filas.length > 0 ? filas[0] : null;
}

// ── Aprobar un pago (Wompi APPROVED, o verificación manual del admin) ─────
async function aprobarIntencion(ref, { metodoLabel, via } = {}) {
  const i = await reclamar(ref, 'pendiente', 'procesando');
  if (!i) return { ok: false, motivo: 'ya_procesada_o_inexistente' };
  try {
    const cfg = await leerConfig(); const C = calcular(cfg);
    let conflicto = false;
    if (i.mes === 1) {
      conflicto = !(await guardianLibrePara(i.guardian_id, i.cc));
      if (!conflicto) await reservarGuardian(i, { monto_pagado: i.monto, mes_pagado: 1 });
    }
    await asegurarCalendario(i.cc, C, null, i.mes);
    await aplicarPagoCuota({
      cc: i.cc, mes: i.mes, monto: i.monto, metodo: metodoLabel || i.metodo, reference: i.reference,
      libroId: `${via === 'admin' ? 'V' : 'W'}-${i.reference}`, adoptanteNom: i.nom,
      gdn: `${i.guardian_nombre || ''} ${i.guardian_id}`.trim(),
    });
    await guardarAdoptanteDesdeIntencion(i, C, conflicto ? 'alerta' : undefined);
    await actualizar(`intenciones_pago?reference=eq.${q(ref)}`, { estado: conflicto ? 'aprobado_conflicto' : 'aprobado', procesado_en: new Date().toISOString() });
    return { ok: true, conflicto };
  } catch (e) {
    // Devolver a pendiente para poder reintentar (Wompi reintenta el aviso)
    await actualizar(`intenciones_pago?reference=eq.${q(ref)}`, { estado: 'pendiente' }).catch(() => {});
    throw e;
  }
}

// ── Rechazar (Wompi DECLINED/ERROR/VOIDED, o "No llegó" del admin) ────────
async function rechazarIntencion(ref) {
  const i = await reclamar(ref, 'pendiente', 'rechazado');
  if (!i) return { ok: false, motivo: 'ya_procesada_o_inexistente' };
  if (i.metodo !== 'wom') {
    if (i.mes === 1) {
      // La reserva manual se deshace: guardián libre y adoptante sin pagos fuera
      const cuotas = await leerCuotas(i.cc);
      const tienePagos = cuotas.some((c) => c.pagado > 0);
      await borrar(`guardianes?id=eq.${q(i.guardian_id)}&cedula=eq.${q(i.cc)}`);
      if (!tienePagos) {
        await borrar(`cuotas?cc=eq.${q(i.cc)}`);
        await borrar(`adoptantes?cc=eq.${q(i.cc)}`);
      }
    } else {
      await actualizar(`adoptantes?cc=eq.${q(i.cc)}`, { est: 'pend' });
    }
  }
  return { ok: true, intencion: i };
}

// ── v58: acceso del adoptante a su portal (email + PIN de 4 dígitos) ──────
// Freno contra adivinar el PIN: 5 intentos fallidos bloquean ese email 15 min.
const MAX_FALLOS = 5, BLOQUEO_MIN = 15;
async function verificarAccesoPortal(emailIn, pinIn) {
  const email = String(emailIn || '').trim().toLowerCase();
  const pin = String(pinIn || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{4}$/.test(pin)) {
    const e = new Error('Escribe tu correo y los 4 dígitos de tu clave.'); e.status = 400; throw e;
  }
  const acceso = (await leer(`accesos_portal?email=eq.${q(email)}&select=*`))?.[0];
  if (acceso?.bloqueado_hasta && new Date(acceso.bloqueado_hasta) > new Date()) {
    const e = new Error(`Demasiados intentos. Intenta de nuevo en ${BLOQUEO_MIN} minutos o escríbenos por WhatsApp.`); e.status = 429; throw e;
  }
  const candidatos = (await leer(`adoptantes?email=ilike.${q(email.replace(/[%_\\]/g, '\\$&'))}&select=*`)) || [];
  const a = candidatos.find((x) => String(x.email || '').trim().toLowerCase() === email &&
    pin === String(x.pin || String(x.cc || '').replace(/\D/g, '').slice(-4)));
  if (!a) {
    const fallos = (acceso?.fallos || 0) + 1;
    const bloquear = fallos >= MAX_FALLOS;
    await upsert('accesos_portal', [{ email, fallos: bloquear ? 0 : fallos,
      bloqueado_hasta: bloquear ? new Date(Date.now() + BLOQUEO_MIN * 60000).toISOString() : null,
      actualizado_en: new Date().toISOString() }]);
    const e = new Error('Correo o clave incorrectos. Tu clave son los últimos 4 dígitos de tu cédula.'); e.status = 401; throw e;
  }
  if (acceso && acceso.fallos) await upsert('accesos_portal', [{ email, fallos: 0, bloqueado_hasta: null, actualizado_en: new Date().toISOString() }]);
  return a;
}

module.exports = {
  sb, leer, upsert, actualizar, borrar, q,
  leerConfig, calcular, hoyISO, hoyCO, idCuota,
  leerIntencion, leerAdoptante, leerCuotas, guardianLibrePara, montoDeCuota,
  asegurarCalendario, aplicarPagoCuota, resumenProgreso, reservarGuardian,
  guardarAdoptanteDesdeIntencion, aprobarIntencion, rechazarIntencion,
  verificarAccesoPortal,
};
