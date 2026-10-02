// netlify/functions/portal-adoptante.js  (v58)
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
    const [cuotas, pendientes] = await Promise.all([
      F.leerCuotas(a.cc),
      F.leer(`intenciones_pago?cc=eq.${F.q(a.cc)}&estado=eq.pendiente&metodo=neq.wom&select=mes,metodo,creado_en`),
    ]);
    const cc = String(a.cc || '');
    return resp(200, {
      ok: true,
      adoptante: {
        nom: a.nom, email: a.email, tel: a.tel, ciu: a.ciu, gdn: a.gdn, inv: a.inv, ret: a.ret,
        mes: a.mes, est: a.est, fecha: a.fecha, tx_id: a.tx_id,
        cc_mask: cc ? '••••' + cc.slice(-4) : '',
      },
      cuotas: (cuotas || []).map((c) => ({
        mes: c.mes, concepto: c.concepto, monto: c.monto, pagado: c.pagado, saldo: c.saldo,
        fecha_vence: c.fecha_vence, fecha_pago: c.fecha_pago, estado: c.estado, reference: c.reference,
      })),
      por_verificar: pendientes || [],
    });
  } catch (e) {
    if (e.status && e.status < 500) return resp(e.status, { error: e.message });
    console.error('portal-adoptante:', e);
    return resp(500, { error: 'No pudimos cargar tu panel en este momento. Intenta de nuevo en un minuto.' });
  }
};
