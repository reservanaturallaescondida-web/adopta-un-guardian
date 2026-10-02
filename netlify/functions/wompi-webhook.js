// netlify/functions/wompi-webhook.js
//
// Recibe las notificaciones (eventos) que Wompi envía automáticamente cuando
// una transacción cambia de estado. Verifica la firma con el "Secreto de
// eventos" (distinto al de integridad) y, si es válida y la transacción fue
// aprobada, la registra en la tabla wompi_transacciones de Supabase.
//
// Esto es lo que permite distinguir un pago REALMENTE confirmado por Wompi
// de uno que el navegador simplemente reportó como exitoso sin verificación.
//
// v57: además, cuando el pago queda APPROVED y el MONTO coincide con la
// intención registrada por registrar-intencion.js, esta función registra la
// adopción completa en Supabase (guardián, adoptante, cuota pagada y asiento
// contable) — aunque el adoptante haya cerrado la página antes de tiempo.
// Si Wompi rechaza el pago, la intención queda como "rechazado".
//
// Configuración requerida en el panel de Wompi:
//   Developers → Webhooks/Eventos → URL:
//   https://adopta-un-guardian.netlify.app/.netlify/functions/wompi-webhook
//
// Configuración requerida en Netlify:
//   Environment variables → WOMPI_EVENTS_SECRET (el "Secreto de eventos",
//   distinto al "Secreto de integridad" que ya configuraste para wompi-sign.js)
//
// Tabla requerida en Supabase — ver GUIA_SEGURIDAD_SUPABASE.sql para el SQL
// completo (crea la tabla, activa RLS y dice exactamente qué política usar).
// IMPORTANTE (endurecimiento de seguridad): esta función YA NO usa la anon
// key pública para escribir. Antes lo hacía, y como la anon key está
// embebida en el HTML del sitio (es pública por diseño), CUALQUIERA podía
// llamar directamente a la REST API de Supabase con esa misma llave e
// insertar una fila falsa en wompi_transacciones con status "APPROVED" para
// cualquier referencia — sin haber pagado nada — porque las políticas RLS
// (using(true) / with check(true)) no distinguían este webhook de un
// atacante cualquiera. Usando la Service Role Key (que NUNCA se expone al
// navegador, solo vive aquí como variable de entorno de Netlify) esta
// función pasa por encima de RLS de forma legítima, y las políticas de la
// tabla pueden cerrarse para que el rol "anon" ya no pueda escribir en
// absoluto — solo leer. Configurar en Netlify:
//   Environment variables → SUPABASE_SERVICE_ROLE_KEY
//   (Supabase → Project Settings → API → "service_role" secret key — NUNCA
//   la publiques ni la pongas en el HTML del sitio).
const crypto = require('crypto');
const F = require('../lib/finanzas'); // v57: registra la adopción en el servidor

const SUPABASE_URL = process.env.SUPABASE_URL_OVERRIDE || 'https://rbryttidysmkkjmmsezj.supabase.co';

// Resuelve una ruta tipo "transaction.id" dentro del objeto data del webhook
function resolverRuta(obj, ruta){
  return ruta.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let payload;
  try {
    const cuerpoTexto = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '{}');
    payload = JSON.parse(cuerpoTexto);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { data, signature, timestamp } = payload;
  if (!data || !signature || !signature.checksum || !Array.isArray(signature.properties) || !timestamp) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Payload de webhook incompleto o con formato inesperado.' }) };
  }

  const secret = process.env.WOMPI_EVENTS_SECRET;
  if (!secret) {
    console.error('WOMPI_EVENTS_SECRET no está configurado en las variables de entorno de Netlify.');
    return { statusCode: 500, body: JSON.stringify({ error: 'Configuración de servidor incompleta.' }) };
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY no está configurado en las variables de entorno de Netlify. Ver GUIA_SEGURIDAD_SUPABASE.sql.');
    return { statusCode: 500, body: JSON.stringify({ error: 'Configuración de servidor incompleta.' }) };
  }

  // Construir la cadena a partir de los campos exactos que Wompi indica en
  // signature.properties (normalmente: transaction.id, transaction.status,
  // transaction.amount_in_cents), en ese orden, más el timestamp y el secreto.
  let cadena = '';
  for (const prop of signature.properties) {
    const valor = resolverRuta(data, prop);
    if (valor == null) {
      return { statusCode: 400, body: JSON.stringify({ error: `Falta el campo requerido para la firma: ${prop}` }) };
    }
    cadena += String(valor);
  }
  cadena += String(timestamp) + secret;

  const calculada = crypto.createHash('sha256').update(cadena).digest('hex');

  if (calculada !== signature.checksum) {
    console.warn('Webhook de Wompi con firma inválida — posible notificación falsificada.', {
      reference: data?.transaction?.reference,
    });
    return { statusCode: 400, body: JSON.stringify({ error: 'Firma inválida.' }) };
  }

  // Firma válida — la notificación es genuina de Wompi.
  const tx = data.transaction || {};
  const { id: wompiTxId, reference, status, amount_in_cents } = tx;

  if (!reference) {
    return { statusCode: 400, body: JSON.stringify({ error: 'La transacción no incluye referencia.' }) };
  }

  // Registrar SIEMPRE (aprobado, rechazado, pendiente, etc.) — el registro
  // en sí mismo es la prueba de que Wompi notificó sobre esta referencia;
  // el campo "status" indica si terminó aprobada o no.
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/wompi_transacciones`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        reference,
        wompi_transaction_id: wompiTxId || null,
        status: status || null,
        amount_in_cents: amount_in_cents ?? null,
        confirmado_en: new Date().toISOString(),
      }),
    });

    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      console.error('Error al guardar en Supabase:', resp.status, texto);
      // Igual respondemos 200 a Wompi — el problema es nuestro, no de la
      // notificación en sí, y Wompi no debe reintentar indefinidamente.
    }
  } catch (e) {
    console.error('Error de red al guardar en Supabase:', e);
  }

  // ── v57: procesar la intención de pago asociada a esta referencia ──
  try {
    const intencion = await F.leerIntencion(reference);
    if (intencion && intencion.estado === 'pendiente') {
      if (status === 'APPROVED') {
        const esperado = Number(intencion.monto) * 100;
        if (Number(amount_in_cents) !== esperado) {
          console.error('Monto pagado distinto al esperado — NO se registra la adopción.', { reference, amount_in_cents, esperado });
          await F.actualizar(`intenciones_pago?reference=eq.${F.q(reference)}&estado=eq.pendiente`, { estado: 'monto_incorrecto', procesado_en: new Date().toISOString() });
        } else {
          const r = await F.aprobarIntencion(reference, { metodoLabel: 'Wompi', via: 'wompi' });
          if (r.conflicto) console.warn('Pago aprobado, pero el guardián ya tenía otro adoptante:', reference);
        }
      } else if (['DECLINED', 'ERROR', 'VOIDED'].includes(status)) {
        await F.rechazarIntencion(reference);
      }
    }
  } catch (e) {
    console.error('Error procesando la intención de pago:', reference, e);
    // 500 → Wompi reintentará el aviso más tarde (la transacción ya quedó
    // guardada arriba y el procesamiento es seguro de repetir).
    return { statusCode: 500, body: JSON.stringify({ error: 'Error procesando el pago; se reintentará.' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recibido: true }),
  };
};
