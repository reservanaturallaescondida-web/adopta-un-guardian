// netlify/functions/portal-adoptante.js  (v58, v60: varias adopciones por persona)
//
// Portal del adoptante desde CUALQUIER dispositivo. El adoptante entra con su
// correo y su clave (últimos 4 dígitos de la cédula). Esta función verifica
// la clave en el servidor y devuelve SOLO sus propios datos: su adopción, su
// calendario de cuotas y los pagos que tiene por verificar. Nunca devuelve la
// cédula completa ni datos de otras personas.
//
// Seguridad: 5 intentos fallidos bloquean ese correo 15 minutos (tabla
// accesos_portal). Variables de entorno: SUPABASE_SERVICE_ROLE_KEY (ya existe).

const F = require('../lib/finanzas');
const resp = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método no permitido.' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'JSON inválido.' }); }
  try {
    const a = await F.verificarAccesoPortal(b.email, b.pin);
    const cc = String(a.cc || '');
    // v60: una persona puede tener varios guardianes → se devuelven TODAS sus adopciones
    const [lista, pendientes] = await Promise.all([
      F.leerAdopcionesDe(cc),
      F.leer(`intenciones_pago?cc=eq.${F.q(cc)}&estado=eq.pendiente&metodo=neq.wom&select=mes,metodo,creado_en,guardian_id,adopcion_id`),
    ]);
    const adopciones = await Promise.all((lista.length ? lista : [a]).map(async (x) => {
      const aid = x.id || F.idAdopcion(cc, F.gidDe(x.gdn));
      const gid = F.gidDe(x.gdn);
      const cuotas = await F.leerCuotas(aid);
      return {
        adopcion: {
          nom: x.nom, email: x.email, tel: x.tel, ciu: x.ciu, gdn: x.gdn, gid, inv: x.inv, ret: x.ret,
          mes: x.mes, est: x.est, fecha: x.fecha, tx_id: x.tx_id, cc_mask: cc ? '••••' + cc.slice(-4) : '',
        },
        cuotas: (cuotas || []).map((c) => ({
          mes: c.mes, concepto: c.concepto, monto: c.monto, pagado: c.pagado, saldo: c.saldo,
          fecha_vence: c.fecha_vence, fecha_pago: c.fecha_pago, estado: c.estado, reference: c.reference,
        })),
        por_verificar: (pendientes || []).filter((p) => (p.adopcion_id || F.idAdopcion(cc, p.guardian_id)) === aid)
          .map((p) => ({ mes: p.mes, metodo: p.metodo, creado_en: p.creado_en })),
      };
    }));
    const primera = adopciones[0];
    return resp(200, {
      ok: true,
      adoptante: primera.adopcion,          // compatibilidad con v58/v59
      cuotas: primera.cuotas,
      por_verificar: primera.por_verificar,
      adopciones,
    });
  } catch (e) {
    if (e.status && e.status < 500) return resp(e.status, { error: e.message });
    console.error('portal-adoptante:', e);
    return resp(500, { error: 'No pudimos cargar tu panel en este momento. Intenta de nuevo en un minuto.' });
  }
};
