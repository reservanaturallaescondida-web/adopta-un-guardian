# Adopta un Guardián — v48 — Importar respaldo ahora también sincroniza con Supabase
**Fecha:** 2026-09-08
**Base:** v47 (todas sus funcionalidades se mantienen) + corrección de sincronización

---

## 1. El problema que encontramos juntos

Reconstruiste a Fernando Santos, Juan Angel Muñoz y oamo usando la herramienta de **Importar respaldo (JSON)**, y aparecieron correctamente en la tabla de Adoptantes del sitio en vivo. Pero al revisar Supabase, la tabla `guardianes` seguía mostrando solo 2 filas, no 5.

**La causa:** la función de importar respaldo, tal como estaba desde que se creó en v40, **solo guardaba en el navegador (localStorage)** — nunca estuvo conectada a Supabase. El guardado en la nube solo ocurría en el flujo normal de pago (`procesarPago`), no en el de importar un archivo de respaldo.

Esto significaba que, aunque los 3 adoptantes reconstruidos se veían bien en el sitio, seguían siendo frágiles: si alguna vez se borraba el navegador o probabas desde otro dispositivo, hubieran vuelto a desaparecer — el mismo problema de raíz, sin resolver del todo.

---

## 2. La corrección

`confirmarImportarJSON()` ahora, después de guardar localmente, recorre cada adoptante importado y llama a `guardarAdopcionEnSupabase()` para cada uno — exactamente la misma función que ya usa el flujo normal de pago. Si Supabase no está configurado, este paso simplemente no hace nada (como siempre), sin romper la importación local.

### Verificación con datos reales
Probé la función real extraída del archivo, simulando la importación de Fernando Santos, Juan Angel Muñoz y oamo:

```
✅ Respaldo importado: 3 adoptante(s) restaurado(s).
☁️ 3 adoptante(s) también sincronizado(s) con Supabase.

Llamadas a Supabase realizadas: 3 (esperado: 3)
  Fernando Santos → guardián G-002 → mes pagado: 2
  Juan Angel Muñoz → guardián G-003 → mes pagado: 1
  oamo → guardián G-005 → mes pagado: 1
```

---

## 3. Qué hacer con esta versión

1. Sube este `index.html` a tu repositorio de GitHub (reemplazando el actual) — Netlify lo desplegará automáticamente, ya que quedó conectado por despliegue continuo.
2. **Vuelve a importar el mismo archivo de respaldo** (`respaldo_adoptantes_reales.json`, el que ya tienes) una vez más desde `⚙️ Admin → Config → 📥 Importar respaldo (JSON)`. No hay ningún problema en hacerlo dos veces — es una operación de "actualizar si existe", no crea duplicados.
3. Esta vez, además del mensaje de "Respaldo importado", deberías ver un segundo aviso: **"☁️ 3 adoptante(s) también sincronizado(s) con Supabase"**.
4. Recarga la pestaña de Supabase (tabla `guardianes`) — ahora debería mostrar 5 filas en vez de 2.

---

## 4. Verificación realizada antes de esta entrega

| Prueba | Resultado |
|---|---|
| `confirmarImportarJSON` llama a Supabase por cada adoptante importado | ✅ Confirmado (3/3) |
| ID de guardián extraído correctamente del campo `gdn` | ✅ Confirmado |
| Cálculo de mes pagado a partir del historial de `registroPagos` | ✅ Confirmado |
| Sin ruptura si Supabase no está configurado | ✅ Hereda el comportamiento seguro ya existente |
| Sintaxis JavaScript completa (`node --check`) | ✅ Válida |
| Sin conflicto de nombres con el bundle real de Supabase | ✅ Confirmado |
| Balance de etiquetas `<div>`/`</div>` | ✅ 1173 apertura / 1173 cierre |
| MD5 idéntico entre HTML suelto e `index.html` del ZIP | ✅ Confirmado |
| Fixes de v34 a v47 siguen intactos | ✅ Confirmado |

---

## 5. Contenido de este paquete

```
adopta-un-guardian-v48/
├── index.html                    ← archivo principal para Netlify
├── video1-llamado-bosque.html
├── video2-mes-a-mes.html
├── video3-bosque-paga.html
├── netlify.toml
└── README.md                     ← este documento (nombre fijo, sin número de versión)
```

**Nota:** de aquí en adelante, el README siempre se llamará `README.md` — así, al subirlo a GitHub, reemplaza al anterior en vez de acumularse como archivos separados (`README-v45.md`, `README-v47.md`, etc.).
