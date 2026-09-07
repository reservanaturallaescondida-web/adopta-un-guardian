// netlify/functions/wompi-sign.js
const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Método no permitido. Usa POST.' }),
    };
  }

  let datos;
  try {
    datos = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido en el cuerpo de la solicitud.' }) };
  }

  const { reference, amount, currency } = datos;

  if (!reference || !amount || !currency) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Faltan parámetros. Se requieren: reference, amount, currency.' }),
    };
  }

  if (typeof reference !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(reference)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Referencia inválida.' }) };
  }
  const montoNum = Number(amount);
  if (!Number.isFinite(montoNum) || montoNum <= 0 || !Number.isInteger(montoNum)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Monto inválido — debe ser un entero positivo en centavos.' }) };
  }
  if (currency !== 'COP') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Moneda no soportada.' }) };
  }

  const secret = process.env.WOMPI_INTEGRITY_SECRET;
  if (!secret) {
    console.error('WOMPI_INTEGRITY_SECRET no está configurado en las variables de entorno de Netlify.');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Configuración de servidor incompleta. Contacta al administrador.' }),
    };
  }

  const textoPlano = `${reference}${montoNum}${currency}${secret}`;
  const signature = crypto.createHash('sha256').update(textoPlano).digest('hex');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ signature }),
  };
};
