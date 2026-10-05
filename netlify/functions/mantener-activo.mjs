// netlify/functions/mantener-activo.mjs
//
// Función PROGRAMADA de Netlify: una vez al día hace una consulta mínima a
// Supabase para que el proyecto del plan gratuito NO se pause por inactividad.
// No modifica ningún dato (solo lee 1 fila de config_sitio).
//
// Usa la misma variable de entorno que ya tienes en Netlify
// (SUPABASE_SERVICE_ROLE_KEY). No hay que crear variables nuevas.

const SUPABASE_URL = process.env.SUPABASE_URL_OVERRIDE || 'https://rbryttidysmkkjmmsezj.supabase.co';

export default async () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('mantener-activo: falta SUPABASE_SERVICE_ROLE_KEY en Netlify.');
    return new Response('Falta SUPABASE_SERVICE_ROLE_KEY', { status: 500 });
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/config_sitio?id=eq.1&select=id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    console.log('mantener-activo: Supabase respondió', resp.status);
    return new Response(`OK ${resp.status}`, { status: resp.ok ? 200 : 502 });
  } catch (e) {
    console.error('mantener-activo: error de red', e);
    return new Response('Error de red', { status: 502 });
  }
};

// Todos los días a las 12:00 UTC (7:00 a. m. hora de Colombia).
export const config = { schedule: '0 12 * * *' };
