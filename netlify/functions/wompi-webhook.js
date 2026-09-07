// netlify/functions/wompi-webhook.js
const crypto = require('crypto');

const SUPABASE_URL = 'https://rbryttidysmkkjmmsezj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicnl0dGlkeXNta2tqbW1zZXpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1OTc5OTMsImV4cCI6MjA4NzE3Mzk5M30.X4zw2X7cULBp4JlpBHT4MIxbmZ_JZG1sP9caiSFD4Ks';

function resolverRuta(obj, ruta){
  return ruta.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
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

  const tx = data.transaction || {};
  const { id: wompiTxId, reference, status, amount_in_cents } = tx;

  if (!reference) {
    return { statusCode: 400, body: JSON.stringify({ error: 'La transacción no incluye referencia.' }) };
  }

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
