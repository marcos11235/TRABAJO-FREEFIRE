# Vértice · venta de PINES Free Fire

Portal web de compra de PINES de diamantes. Los códigos se compran previamente al proveedor y se importan al inventario. Latin GM se consulta únicamente para el catálogo/precio del paquete; no se solicita al proveedor un PIN ni se realiza una recarga directa al ID del jugador.

El catálogo y el flujo de compra están enfocados exclusivamente en paquetes de diamantes Free Fire; no se incluyen categorías ni productos de demostración.

## Estructura

```text
index.html              Página HTML de entrada
assets/                 JavaScript del navegador y estilos
api/                    Función serverless catch-all de Vercel
app/                    API, Supabase, inventario, precios y proveedor
config/                 Plantilla de variables de entorno
package.json            Dependencias y comandos de Node.js
package-lock.json       Versiones bloqueadas de dependencias
.gitignore              Exclusión de secretos y dependencias instaladas
database/schema.sql     Esquema PostgreSQL y funciones RPC de Supabase
docs/README.md          Esta guía
tests/                  Pruebas de precios, scraper e inventario
```

## Ejecución

Requiere Node.js 22.x.

1. Crea un proyecto en Supabase y ejecuta `database/schema.sql` desde el SQL Editor del proyecto.
2. Copia `config/.env.example` a `config/.env` y configura `SUPABASE_URL` junto con la clave `service_role` en `SUPABASE_SERVICE_ROLE_KEY`. Esa clave solo se usa en el servidor: nunca la publiques ni la agregues al frontend.
3. Genera una clave de cifrado y un token administrativo:

   ```powershell
   node -p "require('node:crypto').randomBytes(32).toString('base64')"
   node -p "require('node:crypto').randomBytes(32).toString('base64url')"
   ```

   Guarda los resultados en `PIN_ENCRYPTION_KEY` e `INVENTORY_ADMIN_TOKEN`. **Conserva una copia segura de `PIN_ENCRYPTION_KEY`**: sin ella no se podrán recuperar los códigos cifrados.
4. Configura las credenciales de Mercado Pago, la URL pública HTTPS y Resend.
5. Para instalar dependencias localmente, ejecuta `npm install`; inicia el servidor con `npm start` y ejecuta las pruebas con `npm test`.

### Despliegue en Vercel

La página `index.html` permanece en la raíz y el código está agrupado en carpetas. Los manifiestos de Node (`package.json` y `package-lock.json`) y `.gitignore` también deben permanecer en la raíz: Vercel los necesita para instalar y empaquetar la función API. `.gitignore` excluye `config/.env` y `node_modules/`. No subas secretos ni dependencias instaladas.

En Vercel, importa el repositorio con la raíz del proyecto como directorio raíz y selecciona **Other** como framework. Deja el comando de instalación predeterminado basado en `package-lock.json` (no uses `npm --prefix config install`); deja el comando de build y el directorio de salida vacíos. Selecciona Node.js 22.x en la configuración de runtime. Vercel sirve `index.html` desde la raíz, los recursos desde `/assets/` y detecta `api/[...path].js` como función serverless para las rutas `/api/*`. No configures reglas de rutas personalizadas.

Agrega en **Project Settings → Environment Variables** las mismas variables de `config/.env.example` que necesita el servidor, incluidas `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PIN_ENCRYPTION_KEY`, `INVENTORY_ADMIN_TOKEN`, las credenciales de Mercado Pago y Resend, y `PUBLIC_BASE_URL` con la URL HTTPS final del proyecto. La clave `service_role` debe permanecer únicamente en el entorno del servidor y no debe añadirse al frontend. Configura el webhook de Mercado Pago en `https://<tu-dominio>/api/webhooks/mercadopago`.

Vercel mantiene Supabase como almacenamiento persistente; no depende de archivos locales del servidor. El esquema de [`database/schema.sql`](../database/schema.sql) es el paso de preparación del proyecto Supabase, no una base SQLite ni una conexión SQL local. Las cuentas de acceso del prototipo todavía se guardan en el navegador y no son autenticación de Supabase.

La aplicación convierte los precios del catálogo de Latin GM a ARS usando la cotización oficial de venta y suma $100 ARS. Los precios y la fecha de actualización se guardan en Supabase y se actualizan cada hora. La venta requiere stock disponible del PIN correspondiente, pago confirmado y configuración válida de los servicios.

## Carga y consulta del inventario

El panel de administración incluye **Inventario de PINES**: selecciona el paquete, ingresa el token administrativo y pega los códigos en el cuadro de texto, uno por línea. Pulsa **Agregar PINES al inventario**; el stock se actualiza al terminar. También puedes actualizar el stock con el botón de la sección.

El selector consulta `GET /api/packages`, que devuelve los paquetes guardados en Supabase junto con su identificador y stock. `GET /api/freefire/packages` continúa disponible para compatibilidad. Una instalación nueva incluye paquetes base Free Fire en `database/schema.sql`; si Latin GM o la cotización no responden, el servidor entrega esos datos o la caché de Supabase y pausa las ventas hasta recuperar precios actualizados, pero el selector sigue disponible para cargar PINES.

El endpoint acepta códigos por lote y el token administrativo, por ejemplo:

```powershell
$headers = @{ Authorization = "Bearer $env:INVENTORY_ADMIN_TOKEN"; "Content-Type" = "application/json" }
$body = @{
  packageId = "latin-gm-305106"
  codes = "PIN-ABC-123456`nPIN-DEF-789012"
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://tu-dominio.example/api/admin/pines/import" -Method Post -Headers $headers -Body $body
Invoke-RestMethod -Uri "https://tu-dominio.example/api/admin/pines/stock" -Headers @{ Authorization = "Bearer $env:INVENTORY_ADMIN_TOKEN" }
```

La importación admite entre 1 y 1000 códigos; rechaza duplicados y la inserción por lote de PostgreSQL se confirma completa o no se confirma. `codigo_pin` se cifra con AES-256-GCM y el IV/tag se guardan aparte; un HMAC evita volver a importar el mismo PIN sin almacenar su valor original. La tabla `pines` incluye estados `disponible`, `reservado` y `vendido`. La asignación se ejecuta en una función PostgreSQL transaccional con bloqueo de filas y asocia un solo PIN por orden, incluso ante webhooks concurrentes o repetidos.

Las pruebas automatizadas usan un cliente Supabase simulado para verificar la importación cifrada, la asignación idempotente y el manejo de inventario agotado; se ejecutan con `npm test`. No hay un endpoint de simulación expuesto en producción que pueda alterar inventario real.

## Pago, entrega y agotamiento

Configura el webhook `POST /api/webhooks/mercadopago` en Mercado Pago. El backend valida la firma, consulta el pago con la API oficial y comprueba importe, moneda y referencia de orden. Solo entonces asigna un PIN. Los webhooks repetidos devuelven el mismo PIN asignado y no consumen códigos adicionales.

El webhook es una llamada servidor-a-servidor, por eso no puede devolver el PIN a la pestaña del comprador. Al volver del checkout, el frontend consulta `GET /api/freefire/orders/:id?token=...` con un token aleatorio de la orden; el PIN solo se devuelve si el pago está aprobado y el código ya está asignado. Se muestra la opción de copiar el PIN y los pasos de canje; el mismo PIN se envía por correo.

Si Mercado Pago aprueba el pago sin que quede stock, el pedido pasa a `out_of_stock_pending_refund` y se escribe una alerta en el log del servidor. No se asigna ni revela un PIN; el reembolso/gestión requiere intervención administrativa y debe resolverse con Mercado Pago.

Las compras anteriores al cambio que ya estuvieran pagadas se migran como `manual_required`, no reciben PIN retroactivamente. La sección de inventario solo se muestra a la cuenta admin del prototipo, y el endpoint además exige el token secreto del servidor. La autenticación de cuenta existente todavía se valida en el navegador; reemplázala por autenticación del servidor antes de publicar el panel administrativo.
