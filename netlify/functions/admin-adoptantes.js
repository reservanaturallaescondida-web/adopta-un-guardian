// netlify/functions/admin-adoptantes.js  (v60: varias adopciones por persona)
//
// Función protegida para administrar la planilla de Adoptantes y la
// configuración del sitio en Supabase — el único camino que puede LEER la
// planilla completa (con cédula/email/teléfono de cada adoptante), BORRAR
// una fila, o ESCRIBIR la configuración (precios, cuenta bancaria).
//
// POR QUÉ ESTA FUNCIÓN EXISTE (contexto de seguridad):
// La tabla `adoptantes` en Supabase SÍ contiene datos personales reales
// (cédula, email, teléfono, ciudad). A diferencia de `guardianes` (que no
// tiene datos personales y por eso puede tener lectura pública), la
// planilla de Adoptantes NO puede ser de lectura pública con la anon key:
// esa key está embebida en el código fuente público del sitio (en GitHub),
// así que "lectura pública" equivaldría a publicar la cédula y el teléfono
// de cada adoptante para cualquiera que la busque.
//
// Por eso, leer la planilla completa y borrar una fila requieren la
// contraseña REAL de administrador, verificada aquí en el servidor (nunca
// solo en el navegador) contra un hash guardado como variable de entorno de
// Netlify — no contra el hash que viene embebido en el HTML, porque ese
// también es público. Si un atacante solo tiene acceso al código fuente del
// sitio, no puede obtener ni la contraseña ni los datos de los adoptantes.
//
// (Guardar/actualizar una fila SIGUE siendo público con la anon key, igual
// que `guardianes` — lo necesita el navegador del adoptante justo después
// de pagar, antes de haber iniciado sesión como nada. Ver
// GUIA_SEGURIDAD_SUPABASE_v2.sql para las políticas RLS con CHECK que
// acotan esa escritura pública.)
//
// Configuración requerida en Netlify (variables de entorno):
//   ADMIN_PASS_HASH             → el mismo hash SHA-256 que usa el panel
//                                  admin para verificar la contraseña
//                                  (Admin → Config → 🔑 Seguridad de acceso
//                                  muestra los primeros caracteres del hash
//                                  actual). IMPORTANTE: si cambias la
//                                  contraseña de administrador desde el
//                                  panel, debes actualizar también esta
//                                  variable en Netlify con el nuevo hash —
//                                  si no lo haces, esta función seguirá
//                                  aceptando la contraseña VIEJA.
//   SUPABASE_SERVICE_ROLE_KEY   → la misma que ya configuraste para
//                                  wompi-webhook.js (Supabase → Project
//                                  Settings → API → "service_role" secret).

const crypto = require('crypto');
const F = require('../lib/finanzas'); // v57: cuotas, contabilidad e intenciones de pago

const SUPABASE_URL = process.env.SUPABASE_URL_OVERRIDE || 'https://rbryttidysmkkjmmsezj.supabase.co';

function sha256Hex(texto){
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

async function supabaseFetch(path, opciones){
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY no configurado en Netlify.');
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      ...(opciones.headers || {}),
    },
  });
  return resp;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) }; }

  const { clave, accion } = body;

  const hashEsperado = process.env.ADMIN_PASS_HASH;
  if (!hashEsperado) {
    console.error('ADMIN_PASS_HASH no está configurado en las variables de entorno de Netlify.');
    return { statusCode: 500, body: JSON.stringify({ error: 'Configuración de servidor incompleta.' }) };
  }
  if (!clave || sha256Hex(String(clave)) !== hashEsperado) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Contraseña de administrador incorrecta.' }) };
  }

  const ok = (obj) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...(obj || {}) }) });
  const mal = (code, msg) => ({ statusCode: code, body: JSON.stringify({ error: msg }) });
  const ccValida = (v) => /^\d{4,20}$/.test(String(v || ''));
  const idValido = (v) => /^\d{4,20}(-G-\d{3})?$/.test(String(v || ''));
  // v60: identifica UNA adopción. Usa body.id; si solo viene la cédula, sirve
  // únicamente cuando esa persona tiene una sola adopción.
  async function resolverId(b) {
    if (b.id != null && b.id !== '') {
      return idValido(b.id) ? { id: String(b.id) } : { code: 400, error: 'Identificador de adopción inválido.' };
    }
    if (!ccValida(b.cc)) return { code: 400, error: 'Falta el identificador de la adopción.' };
    const lista = await F.leerAdopcionesDe(String(b.cc));
    if (lista.length === 1) return { id: lista[0].id };
    if (!lista.length) return { code: 404, error: 'Ese adoptante no está en Supabase (revise su cédula).' };
    return { code: 409, error: 'Esta persona tiene varios guardianes: recargue el panel e intente de nuevo.' };
  }

  try {
    if (accion === 'leer_adoptantes') {
      const resp = await supabaseFetch('adoptantes?select=*', { method: 'GET' });
      if (!resp.ok) {
        const texto = await resp.text().catch(() => '');
        console.error('Error al leer adoptantes:', resp.status, texto);
        return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer la planilla desde Supabase.' }) };
      }
      const adoptantes = await resp.json();
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ adoptantes }) };
    }

    if (accion === 'borrar_adoptante') {
      // v60: se borra UNA adopción (id = cédula-guardián); las otras adopciones
      // de la misma persona no se tocan. Compatibilidad: si solo llega la cédula
      // y esa persona tiene una sola adopción, se usa esa.
      const r = await resolverId(body);
      if (r.error) return mal(r.code, r.error);
      const aid = r.id;
      // v57: también sus cuotas y asientos contables (quedan las intenciones como registro)
      await F.borrar(`cuotas?adopcion_id=eq.${F.q(aid)}`).catch(e => console.warn('borrar cuotas:', e.message));
      await F.borrar(`libro_contable?adopcion_id=eq.${F.q(aid)}`).catch(e => console.warn('borrar libro:', e.message));
      const resp = await supabaseFetch(`adoptantes?id=eq.${encodeURIComponent(aid)}`, { method: 'DELETE' });
      if (!resp.ok) {
        const texto = await resp.text().catch(() => '');
        console.error('Error al borrar adoptante:', resp.status, texto);
        return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo borrar el adoptante en Supabase.' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (accion === 'guardar_config') {
      const { config } = body;
      if (!config || typeof config !== 'object') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Falta el objeto de configuración.' }) };
      }
      const resp = await supabaseFetch('config_sitio', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: 1, ...config, actualizado_en: new Date().toISOString() }),
      });
      if (!resp.ok) {
        const texto = await resp.text().catch(() => '');
        console.error('Error al guardar configuración:', resp.status, texto);
        return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo guardar la configuración en Supabase.' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // v56: disponibilidad pública de un guardián (lo que ve la galería del sitio).
    //  disponible=false → fila en `guardianes` con estado 'adoptado' (conserva
    //                     los demás datos si la fila ya existía).
    //  disponible=true  → borra la fila: el guardián vuelve a estar libre.
    if (accion === 'estado_guardian') {
      const { id, nombre, disponible } = body;
      if (!id || !/^[A-Z]{1,6}-\d{2,4}$/.test(String(id))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'ID de guardián inválido.' }) };
      }
      if (String(id).startsWith('TEST')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'El guardián de prueba no se guarda en Supabase.' }) };
      }
      let resp;
      if (disponible === true) {
        resp = await supabaseFetch(`guardianes?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      } else {
        resp = await supabaseFetch('guardianes', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            id: String(id),
            nombre: String(nombre || '').slice(0, 60) || null,
            estado: 'adoptado',
            actualizado_en: new Date().toISOString(),
          }),
        });
      }
      if (!resp.ok) {
        const texto = await resp.text().catch(() => '');
        console.error('Error al cambiar disponibilidad del guardián:', resp.status, texto);
        return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo actualizar el guardián en Supabase.' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ═══════════ v57: finanzas en el servidor ═══════════

    // Todo lo que el panel necesita: cuotas, libro contable, pagos por verificar y alertas
    if (accion === 'leer_finanzas') {
      const [cuotas, libro, intenciones] = await Promise.all([
        F.leer('cuotas?select=*&order=adopcion_id.asc,mes.asc'),
        F.leer('libro_contable?select=*&order=fecha.asc,creado_en.asc'),
        F.leer('intenciones_pago?select=reference,metodo,mes,monto,cc,adopcion_id,nom,guardian_id,comprobante,estado,creado_en&estado=in.(pendiente,aprobado_conflicto,monto_incorrecto)&order=creado_en.desc&limit=500'),
      ]);
      return ok({ cuotas: cuotas || [], libro: libro || [], intenciones: intenciones || [] });
    }

    // Migración única (y segura de repetir) de lo que el navegador del admin tenía guardado
    if (accion === 'importar_finanzas') {
      const cuotas = Array.isArray(body.cuotas) ? body.cuotas.slice(0, 3000) : [];
      const libro = Array.isArray(body.libro) ? body.libro.slice(0, 5000) : [];
      const n = (v) => Math.max(0, Math.min(20000000, Math.round(Number(v) || 0)));
      // v60: cada cuota/asiento va a UNA adopción. Si el navegador no manda
      // adopcion_id, se usa la única adopción de esa cédula (si tiene varias, se omite).
      const todas = (await F.leer('adoptantes?select=id,cc')) || [];
      const porCc = {};
      todas.forEach(a => { (porCc[String(a.cc)] = porCc[String(a.cc)] || []).push(String(a.id)); });
      const aidDe = (x) => {
        if (x.adopcion_id && idValido(x.adopcion_id) && todas.some(a => String(a.id) === String(x.adopcion_id))) return String(x.adopcion_id);
        const l = porCc[String(x.cc)] || [];
        return l.length === 1 ? l[0] : null;
      };
      const filasC = cuotas.filter(c => ccValida(c.cc) && c.mes >= 1 && c.mes <= 24 && aidDe(c)).map(c => ({
        id: F.idCuota(aidDe(c), Number(c.mes)), adopcion_id: aidDe(c), cc: String(c.cc), mes: Number(c.mes),
        concepto: String(c.concepto || '').slice(0, 120), monto: n(c.monto), pagado: n(c.pagado), saldo: n(c.saldo),
        fecha_vence: /^\d{4}-\d{2}-\d{2}$/.test(c.fecha_vence || '') ? c.fecha_vence : null,
        fecha_pago: /^\d{4}-\d{2}-\d{2}$/.test(c.fecha_pago || '') ? c.fecha_pago : null,
        estado: String(c.estado || 'pendiente').slice(0, 20), historial: Array.isArray(c.historial) ? c.historial.slice(0, 50) : [],
        reference: c.reference ? String(c.reference).slice(0, 64) : null, actualizado_en: new Date().toISOString(),
      }));
      const filasL = libro.filter(l => l.id && /^[A-Za-z0-9_-]{3,80}$/.test(l.id)).map(l => ({
        id: l.id, fecha: /^\d{4}-\d{2}-\d{2}$/.test(l.fecha || '') ? l.fecha : F.hoyISO(),
        cc: ccValida(l.cc) ? String(l.cc) : null, adopcion_id: ccValida(l.cc) ? aidDe(l) : null, adoptante: String(l.adoptante || '').slice(0, 120) || null,
        concepto: String(l.concepto || '').slice(0, 200), ingreso: n(l.ingreso), egreso: n(l.egreso),
        tipo: String(l.tipo || '').slice(0, 40), reference: l.reference ? String(l.reference).slice(0, 64) : null,
      }));
      if (filasC.length) await F.upsert('cuotas', filasC, true);
      if (filasL.length) await F.upsert('libro_contable', filasL, true);
      return ok({ cuotas: filasC.length, libro: filasL.length });
    }

    // El dinero de un pago manual llegó → aprobar
    if (accion === 'verificar_intencion') {
      const ref = String(body.reference || '');
      const i = await F.leerIntencion(ref);
      if (!i) return mal(404, 'No se encontró ese pago pendiente.');
      const metodos = { neq: 'Nequi', pse: 'PSE / Transferencia', pal: 'PayPal', efe: 'Efectivo', wom: 'Wompi' };
      const r = await F.aprobarIntencion(ref, { metodoLabel: metodos[i.metodo] || i.metodo, via: 'admin' });
      if (!r.ok) return mal(409, 'Este pago ya había sido procesado.');
      return ok({ conflicto: r.conflicto });
    }

    // El dinero no llegó → rechazar (libera el guardián si era la primera cuota)
    if (accion === 'rechazar_intencion') {
      const r = await F.rechazarIntencion(String(body.reference || ''));
      if (!r.ok) return mal(409, 'Este pago ya había sido procesado.');
      return ok();
    }

    // Pago registrado a mano por el admin (pestaña Pagos → Registrar pago)
    if (accion === 'registrar_pago') {
      const mes = parseInt(body.mes, 10); const monto = Math.round(Number(body.monto) || 0);
      if (!(mes >= 1 && mes <= 24) || !(monto >= 1000 && monto <= 20000000)) return mal(400, 'Datos de pago inválidos.');
      const r = await resolverId(body);
      if (r.error) return mal(r.code, r.error);
      const ad = await F.leerAdopcion(r.id);
      if (!ad) return mal(404, 'Esa adopción no está en Supabase (recargue el panel).');
      const aid = String(ad.id); const cc = String(ad.cc);
      const C = F.calcular(await F.leerConfig());
      await F.asegurarCalendario(aid, cc, C, null, mes);
      const libroId = `P-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      await F.aplicarPagoCuota({ aid, cc, mes, monto, metodo: String(body.metodo || 'Efectivo').slice(0, 30), reference: libroId, libroId, adoptanteNom: ad.nom, gdn: ad.gdn });
      const prog = await F.resumenProgreso(aid, C.meses);
      await F.actualizar(`adoptantes?id=eq.${F.q(aid)}`, { mes: prog.mes, est: prog.completo ? 'compl' : (ad.est === 'verif' ? 'verif' : 'ok'), actualizado_en: new Date().toISOString() });
      return ok();
    }

    // Guardar filas de la planilla editadas por el admin (reemplaza la escritura pública de v55/v56)
    if (accion === 'guardar_adoptantes') {
      // v60: cada fila es UNA adopción; su llave es id = cédula-guardián
      const idDeFila = (f) => {
        if (f.id && idValido(f.id) && String(f.id).split('-')[0] === String(f.cc)) return String(f.id);
        const gid = F.gidDe(f.gdn);
        return gid ? F.idAdopcion(String(f.cc), gid) : String(f.cc);
      };
      const filas = (Array.isArray(body.filas) ? body.filas : []).slice(0, 2000).filter(f => ccValida(f.cc)).map(f => ({
        id: idDeFila(f), cc: String(f.cc), nom: f.nom ?? null, email: f.email ?? null, tel: f.tel ?? null, ciu: f.ciu ?? null, gdn: f.gdn ?? null,
        inv: f.inv ?? null, ret: f.ret ?? null, mes: f.mes ?? null, est: f.est ?? null, fecha: f.fecha ?? null, pin: f.pin ?? null,
        tx_id: f.tx_id ?? null, actualizado_en: new Date().toISOString(),
      }));
      // v60: el progreso (mes) y "Ciclo completado" salen de las cuotas del SERVIDOR,
      // no de la copia del navegador (una copia vieja ya no puede retroceder a nadie).
      if (filas.length) {
        const ids = [...new Set(filas.map(f => f.id))];
        const cuotasSrv = [];
        for (let k = 0; k < ids.length; k += 100) {
          const lote = ids.slice(k, k + 100).map(x => `"${String(x).replace(/"/g, '')}"`).join(',');
          cuotasSrv.push(...((await F.leer(`cuotas?adopcion_id=in.(${encodeURIComponent(lote)})&select=adopcion_id,mes,saldo`)) || []));
        }
        filas.forEach(f => {
          const cs = cuotasSrv.filter(c => c.adopcion_id === f.id);
          if (!cs.length) return;
          const pagadas = cs.filter(c => c.saldo <= 0).map(c => c.mes);
          const total = Math.max(cs.length, ...cs.map(c => c.mes));
          f.mes = `Mes ${pagadas.length ? Math.max(...pagadas) : 1}/${total}`;
          if (pagadas.length >= total) f.est = f.est === 'verif' ? 'verif' : 'compl';
          else if (f.est === 'compl') f.est = 'ok';
        });
      }
      if (filas.length) await F.upsert('adoptantes', filas);
      return ok({ guardadas: filas.length });
    }

    // Corrección de cédula: mueve adoptante, cuotas, asientos e intenciones a la nueva
    if (accion === 'cambiar_cc') {
      const ant = String(body.anterior || ''); const nue = String(body.nueva || '');
      if (!ccValida(ant) || !ccValida(nue) || ant === nue) return mal(400, 'Cédulas inválidas.');
      // v60: se mueven TODAS las adopciones de esa persona (id = cédula-guardián)
      const nuevoId = (id) => String(id) === ant ? nue : (String(id).startsWith(ant + '-') ? nue + String(id).slice(ant.length) : String(id));
      const adopciones = await F.leerAdopcionesDe(ant);
      for (const a of adopciones) {
        const aidV = String(a.id); const aidN = nuevoId(aidV);
        if (!(await F.leerAdopcion(aidN))) await F.upsert('adoptantes', [{ ...a, id: aidN, cc: nue, actualizado_en: new Date().toISOString() }]);
        const cuotas = await F.leerCuotas(aidV);
        if (cuotas.length) {
          await F.upsert('cuotas', cuotas.map(c => ({ ...c, id: F.idCuota(aidN, c.mes), adopcion_id: aidN, cc: nue })), true);
          await F.borrar(`cuotas?adopcion_id=eq.${F.q(aidV)}`);
        }
        await F.actualizar(`libro_contable?adopcion_id=eq.${F.q(aidV)}`, { adopcion_id: aidN });
        await F.actualizar(`intenciones_pago?adopcion_id=eq.${F.q(aidV)}`, { adopcion_id: aidN });
        await F.borrar(`adoptantes?id=eq.${F.q(aidV)}`);
      }
      await F.actualizar(`libro_contable?cc=eq.${F.q(ant)}`, { cc: nue });
      await F.actualizar(`intenciones_pago?cc=eq.${F.q(ant)}`, { cc: nue });
      await F.actualizar(`guardianes?cedula=eq.${F.q(ant)}`, { cedula: nue, clave: nue.slice(-4) });
      return ok();
    }

    // Datos de guardián (importar respaldo JSON desde el panel)
    if (accion === 'guardar_guardian') {
      const d = body.datos || {};
      if (!/^G-\d{3}$/.test(String(d.id || ''))) return mal(400, 'Guardián inválido.');
      await F.upsert('guardianes', [{
        id: d.id, nombre: d.nombre ?? null, estado: 'adoptado', nombre_adoptante: d.nombreAdoptante ?? null,
        email_adoptante: d.emailAdoptante ?? null, telefono: d.telefono ?? null, direccion: d.direccion ?? null,
        cedula: d.cedula ?? null, clave: d.clave ?? null, monto_pagado: d.montoPagado ?? null,
        mes_pagado: d.mesPagado ?? null, tx_id: d.txId ?? null, actualizado_en: new Date().toISOString(),
      }]);
      return ok();
    }

    return { statusCode: 400, body: JSON.stringify({ error: `Acción desconocida: ${accion}` }) };
  } catch (e) {
    console.error('Error inesperado en admin-adoptantes:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Error interno del servidor.' }) };
  }
};
