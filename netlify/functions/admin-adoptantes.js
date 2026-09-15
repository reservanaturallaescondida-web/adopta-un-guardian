// netlify/functions/admin-adoptantes.js
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

const SUPABASE_URL = 'https://rbryttidysmkkjmmsezj.supabase.co';

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
      const { cc } = body;
      if (!cc) return { statusCode: 400, body: JSON.stringify({ error: 'Falta la cédula (cc) del adoptante a borrar.' }) };
      const resp = await supabaseFetch(`adoptantes?cc=eq.${encodeURIComponent(cc)}`, { method: 'DELETE' });
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

    return { statusCode: 400, body: JSON.stringify({ error: `Acción desconocida: ${accion}` }) };
  } catch (e) {
    console.error('Error inesperado en admin-adoptantes:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Error interno del servidor.' }) };
  }
};
