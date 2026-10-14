# Vértice · venta de PINES Free Fire

Portal web de compra de PINES de diamantes. Los códigos se compran previamente al proveedor y se importan al inventario. Latin GM se consulta únicamente para el catálogo/precio del paquete; no se solicita al proveedor un PIN ni se realiza una recarga directa al ID del jugador.

El catálogo y el flujo de compra están enfocados exclusivamente en paquetes de diamantes Free Fire; no se incluyen categorías ni productos de demostración.

## Estructura

```text
index.html              Catálogo, checkout y pantalla de entrega del PIN
styles.css              Interfaz responsive
app.js                  Flujo frontend y consulta autenticada del pedido
server.js               API HTTP, SQLite, Mercado Pago y webhook
pin-inventory.js        Cifrado, importación, asignación atómica e idempotencia
latin-gm.js             Lectura de variantes y precios de Latin GM
pricing.js              Conversión USD/ARS y margen fijo
database.sql             Tablas de precios, pedidos e inventario de PINES
test/                    Pruebas de precios, scraper e inventario
.env.example             Configuración de integraciones y secretos
```

## Ejecución

Requiere Node.js 22.5 o posterior; SQLite usa el módulo integrado `node:sqlite`.

1. Copia `.env.example` a `.env`.
2. Genera una clave de cifrado y un token administrativo:

   ```powershell
   node -p "require('node:crypto').randomBytes(32).toString('base64')"
   node -p "require('node:crypto').randomBytes(32).toString('base64url')"
   ```

   Guarda los resultados en `PIN_ENCRYPTION_KEY` e `INVENTORY_ADMIN_TOKEN`. **Conserva una copia segura de `PIN_ENCRYPTION_KEY`**: sin ella no se podrán recuperar los códigos cifrados.
3. Configura las credenciales de Mercado Pago, la URL pública HTTPS y Resend.
4. Ejecuta `npm start`; para las pruebas, `npm test`.

La aplicación convierte los precios del catálogo de Latin GM a ARS usando la cotización oficial de venta y suma $100 ARS. El precio queda guardado en SQLite y se actualiza cada hora. La venta requiere stock disponible del PIN correspondiente, pago confirmado y configuración válida de los servicios.

## Carga y consulta del inventario

El panel de administración incluye **Inventario de PINES**: selecciona el paquete, ingresa el token administrativo y pega los códigos en el cuadro de texto, uno por línea. Pulsa **Agregar PINES al inventario**; el stock se actualiza al terminar. También puedes actualizar el stock con el botón de la sección.

El selector consulta `GET /api/packages`, que devuelve los paquetes guardados en SQLite junto con su identificador y stock. `GET /api/freefire/packages` continúa disponible para compatibilidad. Una instalación nueva incluye paquetes base Free Fire en `database.sql`; si Latin GM o la cotización no responden, el servidor entrega esos datos o la caché de SQLite y pausa las ventas hasta recuperar precios actualizados, pero el selector sigue disponible para cargar PINES.

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

La importación admite entre 1 y 1000 códigos; rechaza duplicados y revierte el lote completo si alguno ya existe. `codigo_pin` se cifra con AES-256-GCM y el IV/tag se guardan aparte; un HMAC evita volver a importar el mismo PIN sin almacenar su valor original. La tabla `pines` incluye estados `disponible`, `reservado` y `vendido`. La asignación pasa atómicamente de disponible a vendido y asocia una sola orden.

La prueba `simulates an approved package purchase and marks its PIN sold exactly once` usa SQLite en memoria para importar un PIN, asociarlo a una orden de pago aprobada y verificar que cambia de `disponible` a `vendido` sin permitir una segunda asignación. Se ejecuta con `npm test`; no hay un endpoint de simulación expuesto en producción que pueda alterar inventario real.

## Pago, entrega y agotamiento

Configura el webhook `POST /api/webhooks/mercadopago` en Mercado Pago. El backend valida la firma, consulta el pago con la API oficial y comprueba importe, moneda y referencia de orden. Solo entonces asigna un PIN. Los webhooks repetidos devuelven el mismo PIN asignado y no consumen códigos adicionales.

El webhook es una llamada servidor-a-servidor, por eso no puede devolver el PIN a la pestaña del comprador. Al volver del checkout, el frontend consulta `GET /api/freefire/orders/:id?token=...` con un token aleatorio de la orden; el PIN solo se devuelve si el pago está aprobado y el código ya está asignado. Se muestra la opción de copiar el PIN y los pasos de canje; el mismo PIN se envía por correo.

Si Mercado Pago aprueba el pago sin que quede stock, el pedido pasa a `out_of_stock_pending_refund` y se escribe una alerta en el log del servidor. No se asigna ni revela un PIN; el reembolso/gestión requiere intervención administrativa y debe resolverse con Mercado Pago.

Las compras anteriores al cambio que ya estuvieran pagadas se migran como `manual_required`, no reciben PIN retroactivamente. La sección de inventario solo se muestra a la cuenta admin del prototipo, y el endpoint además exige el token secreto del servidor. La autenticación de cuenta existente todavía se valida en el navegador; reemplázala por autenticación del servidor antes de publicar el panel administrativo.
