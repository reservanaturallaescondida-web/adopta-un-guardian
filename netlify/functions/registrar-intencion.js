// netlify/functions/registrar-intencion.js  (v57, v58: pago de cuotas desde el portal)
//
// Primer paso de TODO pago real (Wompi, Nequi, PSE, PayPal, Efectivo).
// El navegador del adoptante llama aquí ANTES de pagar. Esta función:
//   1. Valida los datos y que el guardián siga libre (evita dobles adopciones).
//   2. Calcula el MONTO en el servidor (desde config_sitio y las cuotas reales);
//      el monto que mande el navegador se ignora.
//   3. Guarda la "intención de pago" en Supabase (tabla intenciones_pago, sin
//      lectura pública).
//   4. Wompi: devuelve la firma de integridad para ESE monto. Cuando Wompi
//      aprueba, wompi-webhook.js registra la adopción completa en el servidor,
//      aunque el adoptante haya cerrado la página.
//   5. Nequi / PSE / PayPal / Efectivo: reserva el guardián y deja al
//      adoptante "Por verificar" hasta que el administrador confirme el dinero.
//
// Variables de entorno (ya existentes): SUPABASE_SERVICE_ROLE_KEY,
// WOMPI_INTEGRITY_SECRET.

const crypto = require('crypto');
const F = require('../lib/finanzas');

const METODOS = { wom: 'Wompi', neq: 'Nequi', pse: 'PSE / Transferencia', pal: 'PayPal', efe: 'Efectivo' };
const resp = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido.' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'JSON inválido.' }); }

  // ── Validación ──
  const reference = txt(b.reference, 64);
  const metodo = txt(b.metodo, 3);
  let cc = txt(b.cc, 20).replace(/\D/g, '');
  const nom = txt(b.nom, 120);
  const email = txt(b.email, 160).toLowerCase();
  const tel = txt(b.tel, 40);
  const ciu = txt(b.ciu, 120);
  const gid = txt(b.guardian_id, 12).toUpperCase();
  const gnom = txt(b.guardian_nombre, 60);
  const mes = parseInt(b.mes, 10);
  const comprobante = txt(b.comprobante, 200);

  if (!/^[A-Za-z0-9_-]{6,64}$/.test(reference)) return resp(400, { error: 'Referencia inválida.' });

  // v58: pago de cuotas desde el portal en otro dispositivo — el adoptante se
  // identifica con correo + clave y el servidor pone su cédula (el navegador no la tiene).
  if (b.portal_email && b.portal_pin) {
    try { const a = await F.verificarAccesoPortal(b.portal_email, b.portal_pin); cc = String(a.cc); }
    catch (e) { return resp(e.status && e.status < 500 ? e.status : 500, { error: e.message || 'No pudimos verificar tu acceso.' }); }
  }
  if (!METODOS[metodo]) return resp(400, { error: 'Método de pago inválido.' });
  if (!/^\d{6,12}$/.test(cc)) return resp(400, { error: 'La cédula debe tener entre 6 y 12 dígitos.' });
  if (nom.length < 3) return resp(400, { error: 'Escribe tu nombre completo.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return resp(400, { error: 'Correo inválido.' });
  if (!/^G-\d{3}$/.test(gid)) return resp(400, { error: 'Guardián inválido.' });

  try {
    const cfg = await F.leerConfig(); const C = F.calcular(cfg);
    if (!(mes >= 1 && mes <= C.meses)) return resp(400, { error: 'Cuota inválida.' });

    // Referencia ya usada → no se repite (cada intento de pago tiene la suya)
    if (await F.leerIntencion(reference)) return resp(409, { error: 'Esta referencia de pago ya fue usada. Recarga la página e intenta de nuevo.' });

    // Freno anti-abuso: máximo 3 intentos pendientes por cédula en 24 horas
    const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recientes = await F.leer(`intenciones_pago?cc=eq.${F.q(cc)}&estado=eq.pendiente&creado_en=gte.${F.q(desde)}&select=reference`);
    if ((recientes || []).length >= 3) return resp(429, { error: 'Ya tienes pagos pendientes de verificación. Escríbenos por WhatsApp para completarlos.' });

    if (mes === 1) {
      if (!(await F.guardianLibrePara(gid, cc))) return resp(409, { error: 'Este guardián acaba de ser adoptado por otra persona. Por favor elige otro.' });
    } else {
      const ad = await F.leerAdoptante(cc);
      if (!ad) return resp(404, { error: 'No encontramos tu adopción con esa cédula. Contáctanos por WhatsApp.' });
    }

    const monto = Math.round(await F.montoDeCuota(cc, mes, C));
    const intencion = {
      reference, metodo, mes, monto, cc, nom, email: email || null, tel: tel || null, ciu: ciu || null,
      guardian_id: gid, guardian_nombre: gnom || null, comprobante: comprobante || null,
      estado: 'pendiente', creado_en: new Date().toISOString(),
    };
    await F.upsert('intenciones_pago', [intencion], true);

    if (metodo === 'wom') {
      const secret = process.env.WOMPI_INTEGRITY_SECRET;
      if (!secret) return resp(500, { error: 'Configuración de pagos incompleta. Contacta al administrador.' });
      const cents = monto * 100;
      const signature = crypto.createHash('sha256').update(`${reference}${cents}COP${secret}`).digest('hex');
      return resp(200, { ok: true, reference, monto, amount_in_cents: cents, signature });
    }

    // Pago manual: reservar guardián + calendario + adoptante "Por verificar"
    if (mes === 1) await F.reservarGuardian(intencion, { monto_pagado: 0, mes_pagado: null });
    await F.asegurarCalendario(cc, C, null, mes);
    await F.guardarAdoptanteDesdeIntencion(intencion, C, 'verif');
    return resp(200, { ok: true, reference, monto, estado: 'por_verificar' });
  } catch (e) {
    console.error('registrar-intencion:', e);
    return resp(500, { error: 'No pudimos registrar tu pago en este momento. Intenta de nuevo en un minuto.' });
  }
};
