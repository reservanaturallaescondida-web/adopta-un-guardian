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
// Configuración requerida en el panel de Wompi:
//   Developers → Webhooks/Eventos → URL:
//   https://adopta-un-guardian.netlify.app/.netlify/functions/wompi-webhook
//
// Configuración requerida en Netlify:
//   Environment variables → WOMPI_EVENTS_SECRET (el "Secreto de eventos",
//   distinto al "Secreto de integridad" que ya configuraste para wompi-sign.js)
//
// Tabla requerida en Supabase (ejecutar una sola vez en el SQL Editor):
//
//   create table wompi_transacciones (
//     id                uuid primary key default gen_random_uuid(),
//     reference         text unique not null,
//     wompi_transaction_id text,
//     status            text,
//     amount_in_cents   numeric,
//     confirmado_en     timestamptz default now()
//   );
//   alter table wompi_transacciones enable row level security;
//   create policy "lectura publica" on wompi_transacciones for select using (true);
//   create policy "escritura publica" on wompi_transacciones for insert with check (true);
//   create policy "actualizacion publica" on wompi_transacciones for update using (true);

const crypto = require('crypto');

// Mismas credenciales públicas de Supabase que ya usa el sitio (la anon key
// no es secreta — depende de las políticas RLS de la tabla, no de ocultarla).
const SUPABASE_URL = 'https://rbryttidysmkkjmmsezj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicnl0dGlkeXNta2tqbW1zZXpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1OTc5OTMsImV4cCI6MjA4NzE3Mzk5M30.X4zw2X7cULBp4JlpBHT4MIxbmZ_JZG1sP9caiSFD4Ks';

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
    console.log('DIAGNÓSTICO — ¿el cuerpo llegó en base64?', !!event.isBase64Encoded);
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

  // ── DIAGNÓSTICO TEMPORAL (no expone el secreto, solo su longitud y si
  //    tiene espacios al inicio/final — eso basta para detectar un error
  //    de copiado sin necesidad de ver el valor real) ──
  console.log('DIAGNÓSTICO webhook:', {
    properties_recibidas: signature.properties,
    longitud_secreto: secret.length,
    secreto_tiene_espacios_extremos: secret !== secret.trim(),
    timestamp_recibido: timestamp,
    checksum_recibido: signature.checksum,
  });

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
    console.log(`DIAGNÓSTICO — propiedad "${prop}" resuelta a:`, valor, '(tipo:', typeof valor, ')');
  }
  cadena += String(timestamp) + secret;

  const calculada = crypto.createHash('sha256').update(cadena).digest('hex');
  console.log('DIAGNÓSTICO — cadena SIN secreto (para comparar manualmente):',
    cadena.slice(0, cadena.length - secret.length));
  console.log('DIAGNÓSTICO — checksum calculado:', calculada, '| checksum recibido:', signature.checksum);

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
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
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

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recibido: true }),
  };
};
