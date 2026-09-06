# Adopta un Guardián — v47 — Aviso claro de modo de prueba local
**Fecha:** 2026-08-07
**Base:** v46 (todas sus funcionalidades se mantienen) + aviso de contexto

---

## 1. Sobre lo que reportaste — auditado, no es un bug de sobreescritura

Revisé línea por línea `restaurarDesdeLocalStorage()` (la función que carga los adoptantes guardados). Su lógica es correcta: si hay datos guardados en el navegador, los usa; si no encuentra nada, el código simplemente se queda con los 5 adoptantes de prueba con los que arranca por defecto. **No hay ningún punto donde el código sobreescriba datos reales con datos de prueba.**

La explicación real tiene dos partes, y quiero ser preciso porque no es exactamente lo mismo que expliqué en v40:

### Parte 1 — Local y Netlify son cajones de almacenamiento distintos
El navegador guarda los datos de cada sitio según su dirección exacta (protocolo + dominio). Los adoptantes reales viven en el almacenamiento de `adopta-un-guardian.netlify.app`. Al abrir el archivo en tu computador (`file://...`) o en un servidor local (`localhost`), el navegador lo trata como un sitio **completamente distinto**, con su propio almacenamiento — vacío por defecto. Por eso ves los 5 de prueba: no es que se "traigan" datos de otro lado, es que ese cajón nunca ha tenido nada.

**Esto nunca puede dañar tus datos reales.** Son almacenamientos completamente aislados — probar en local jamás toca ni sobreescribe lo que está en producción.

### Parte 2 — cada versión que te entrego es, técnicamente, "otro sitio" para el navegador
Cada archivo que te envío tiene un nombre distinto (`v46-...html`, `v47-...html`, etc.). Si abres cada descarga sin renombrarla, para el navegador **cada archivo es también un origen distinto entre sí** — por eso además parecía que "no había continuidad" entre tus propias pruebas locales de una versión a otra: cada una arranca desde cero, no es que se pierdan datos, es que nunca compartieron el mismo cajón para empezar.

---

## 2. La mejora que agregué — un aviso claro, no otro parche silencioso

Como esta confusión es entendible y probablemente le pase a cualquiera que pruebe en local, agregué un **aviso visible automático**: si el sitio detecta que se está viendo desde `file://` o desde `localhost`, aparece un mensaje claro debajo del pie de página:

> 🧪 **Modo de prueba local** (archivo abierto directamente / servidor local). Los adoptantes que ves aquí son independientes del sitio en producción — cada dirección web tiene su propio almacenamiento en el navegador. Esto nunca afecta ni sobreescribe los datos reales de tu sitio ya desplegado.

En producción (Netlify o cualquier dominio real), este aviso **no aparece** — se activa solo en los dos escenarios de prueba local.

### Verificación
Probé la función real extraída del archivo en los 3 escenarios posibles:

```
Caso 1 (file://):        Aviso mostrado: true — menciona "archivo abierto directamente": true
Caso 2 (localhost):      Aviso mostrado: true — menciona "servidor local": true
Caso 3 (Netlify, real):  Aviso NO se muestra: true
```

---

## 3. Si necesitas ver tus datos reales mientras pruebas en local

Ya existe una herramienta para esto desde v40, en `⚙️ Admin → Config → 💾 Respaldo de Datos`:

1. En tu sitio real (Netlify), haz clic en **"📤 Exportar respaldo (JSON)"** — descarga un archivo con tus adoptantes reales.
2. Abre tu copia local (donde sea que la estés probando).
3. En esa misma sección, haz clic en **"📥 Importar respaldo (JSON)"** y selecciona el archivo que acabas de descargar.
4. Tus adoptantes reales aparecerán en esa sesión local — sin tocar ni modificar nada de tu sitio en producción.

**Para que tus pruebas locales tengan continuidad entre sí** (que no se reinicien cada vez que descargas una versión nueva), la forma más simple es: guarda siempre el archivo con el mismo nombre en la misma carpeta (por ejemplo, `index.html` siempre en la misma ubicación), en vez de mantener cada descarga con su nombre de versión distinto.

---

## 4. Verificación realizada antes de esta entrega

| Prueba | Resultado |
|---|---|
| Auditoría línea por línea de `restaurarDesdeLocalStorage` | ✅ Sin puntos de sobreescritura indebida |
| `verificarModoLocal()` — detecta `file://` correctamente | ✅ Confirmado |
| `verificarModoLocal()` — detecta `localhost` correctamente | ✅ Confirmado |
| `verificarModoLocal()` — NO se activa en producción | ✅ Confirmado |
| Sintaxis JavaScript completa (`node --check`) | ✅ Válida |
| Sin conflicto de nombres con el bundle real de Supabase | ✅ Confirmado |
| Balance de etiquetas `<div>`/`</div>` | ✅ 1173 apertura / 1173 cierre |
| MD5 idéntico entre HTML suelto e `index.html` del ZIP | ✅ Confirmado |
| Fixes de v34 a v46 siguen intactos | ✅ Confirmado |

---

## 5. Contenido de este paquete

```
adopta-un-guardian-v47/
├── index.html                    ← archivo principal para Netlify
├── video1-llamado-bosque.html
├── video2-mes-a-mes.html
├── video3-bosque-paga.html
├── netlify.toml
└── README-v47.md                 ← este documento
```
