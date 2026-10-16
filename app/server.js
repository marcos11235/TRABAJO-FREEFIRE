const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execute, getSupabase } = require("./supabase-store");
const {
  clearAdminSessionCookie,
  createAdminSessionCookie,
  hasValidAdminSession,
  isAdminAuthConfigured,
  verifyAdminCredentials
} = require("./admin-auth");
const { scrapeLatinGmPackages } = require("./latin-gm");
const { PROFIT_MARGIN_ARS, calculateFinalPriceArs } = require("./pricing");
const {
  assignPinToOrder,
  claimOrderEmail,
  decodeEncryptionKey,
  decryptPin,
  importPins,
  markOrderEmailSent,
  releaseOrderEmailClaim
} = require("./pin-inventory");

const root = path.resolve(__dirname, "..");

loadEnvFile();

const PRICE_CACHE_MS = 60 * 60 * 1000;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function loadEnvFile() {
  const envPath = path.join(root, "config", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[2].startsWith("#") || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function json(response, statusCode, data, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(data));
}

async function readJson(request, allowEmpty = false) {
  if (request.body !== undefined) {
    const body = request.body;
    const serialized = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    if (serialized.length > 256 * 1024) {
      throw Object.assign(new Error("El cuerpo supera el límite permitido."), { statusCode: 413 });
    }
    if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
    if (allowEmpty && serialized.length === 0) return {};
    try {
      return JSON.parse(serialized.toString("utf8"));
    } catch {
      throw Object.assign(new Error("El cuerpo de la solicitud no es JSON válido."), { statusCode: 400 });
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error("El cuerpo supera el límite permitido."), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (allowEmpty && size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("El cuerpo de la solicitud no es JSON válido."), { statusCode: 400 });
  }
}

async function getCachedPackages() {
  return execute(getSupabase().rpc("get_freefire_packages"));
}

async function getOfficialUsdArsRate() {
  const response = await fetch("https://dolarapi.com/v1/dolares/oficial", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`No se pudo consultar la cotización oficial (HTTP ${response.status}).`);
  const quote = await response.json();
  const rate = Number(quote.venta);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("La cotización oficial recibida no es válida.");
  return rate;
}

async function refreshCatalog() {
  const supabase = getSupabase();
  const [previous, setting] = await Promise.all([
    execute(supabase.rpc("get_freefire_packages")),
    execute(supabase.from("app_settings").select("value").eq("key", "catalog_updated_at").maybeSingle())
  ]);
  const lastRefresh = setting?.value || null;
  const cacheAge = lastRefresh ? Date.now() - Date.parse(lastRefresh) : Infinity;
  if (previous.length && cacheAge < PRICE_CACHE_MS) {
    return { packages: previous, updatedAt: lastRefresh, stale: false, saleEnabled: true };
  }

  try {
    const [supplierPackages, usdArsRate] = await Promise.all([
      scrapeLatinGmPackages(process.env.LATIN_GM_PRODUCT_URL),
      getOfficialUsdArsRate()
    ]);
    if (!supplierPackages.length) throw new Error("Latin GM no devolvió paquetes de diamantes disponibles.");

    const now = new Date().toISOString();
    const packages = supplierPackages.map(item => {
      const supplierUsd = Number(item.priceUsd);
      return {
        id: `latin-gm-${item.variationId}`,
        label: item.label,
        diamonds: item.diamonds,
        supplier_usd: supplierUsd,
        usd_ars_rate: usdArsRate,
        final_price_ars: calculateFinalPriceArs(supplierUsd, usdArsRate),
        supplier_url: item.productUrl
      };
    });
    await execute(getSupabase().rpc("refresh_freefire_packages", {
      p_packages: packages,
      p_updated_at: now
    }));
    return { packages: await getCachedPackages(), updatedAt: now, stale: false, saleEnabled: true };
  } catch (error) {
    console.error("No se pudo actualizar el catálogo de Latin GM; se conserva la caché de Supabase.", error);
    return {
      packages: previous,
      updatedAt: lastRefresh,
      stale: true,
      saleEnabled: false,
      warning: `No se pudo actualizar el catálogo; se muestran los paquetes guardados y la compra está pausada. ${error.message}`
    };
  }
}

function checkoutConfigured() {
  const hasPublicHttpsUrl = URL.canParse(process.env.PUBLIC_BASE_URL || "") &&
    new URL(process.env.PUBLIC_BASE_URL).protocol === "https:";
  const hasSupabaseConfig = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  let hasEncryptionKey = false;
  try {
    decodeEncryptionKey(process.env.PIN_ENCRYPTION_KEY);
    hasEncryptionKey = true;
  } catch {}
  return Boolean(
    process.env.MP_ACCESS_TOKEN &&
    process.env.MP_WEBHOOK_SECRET &&
    process.env.RESEND_API_KEY &&
    process.env.EMAIL_FROM &&
    hasPublicHttpsUrl &&
    hasSupabaseConfig &&
    hasEncryptionKey &&
    inventoryConfigured()
  );
}

function inventoryConfigured() {
  return Boolean(
    isAdminAuthConfigured() &&
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    (() => {
      try {
        decodeEncryptionKey(process.env.PIN_ENCRYPTION_KEY);
        return true;
      } catch {
        return false;
      }
    })()
  );
}

function createPaymentPreference(order, accessToken) {
  const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": order.id
    },
    body: JSON.stringify({
      items: [{
        id: order.package_id,
        title: `${order.package_label} diamantes Free Fire`,
        quantity: 1,
        unit_price: order.amount_ars,
        currency_id: "ARS"
      }],
      payer: { name: order.customer_name, email: order.email },
      external_reference: order.id,
      notification_url: `${baseUrl}/api/webhooks/mercadopago`,
      back_urls: {
        success: `${baseUrl}/?freefire=return&order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(accessToken)}`,
        pending: `${baseUrl}/?freefire=return&order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(accessToken)}`,
        failure: `${baseUrl}/?freefire=return&order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(accessToken)}`
      },
      auto_return: "approved"
    }),
    signal: AbortSignal.timeout(15000)
  });
}

function verifyMercadoPagoSignature(request, paymentId) {
  const signature = request.headers["x-signature"];
  const requestId = request.headers["x-request-id"];
  if (typeof signature !== "string" || typeof requestId !== "string" || !process.env.MP_WEBHOOK_SECRET) {
    return false;
  }
  const timestamp = signature.match(/(?:^|,)ts=(\d+)/)?.[1];
  const received = signature.match(/(?:^|,)v1=([a-f0-9]+)/i)?.[1];
  if (!timestamp || !received) return false;
  const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
  const expected = crypto.createHmac("sha256", process.env.MP_WEBHOOK_SECRET).update(manifest).digest();
  let actual;
  try {
    actual = Buffer.from(received, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

const REDEEM_URL = "https://pagostore.garena.com/";

function redemptionInstructions() {
  return [
    "1. Abre el portal de PagoStore: https://pagostore.garena.com/",
    "2. Inicia sesión con el método asociado a tu cuenta de Free Fire.",
    "3. Busca la opción de canje o recarga con PIN.",
    "4. Selecciona el paquete correspondiente e ingresa el código PIN.",
    "5. Confirma el canje y verifica los diamantes en tu cuenta."
  ];
}

async function sendPaymentEmail(order, pinCode) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error("Falta configurar RESEND_API_KEY y EMAIL_FROM para enviar el correo de confirmación.");
  }
  const instructions = redemptionInstructions();
  const htmlInstructions = instructions.map(instruction => `<li>${escapeHtml(instruction)}</li>`).join("");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [order.email],
      subject: "Tu PIN de diamantes Free Fire",
      text: [
        `Hola ${order.customer_name},`,
        "",
        `Mercado Pago confirmó el pago de ${order.package_label} diamantes.`,
        `Tu código PIN: ${pinCode}`,
        "",
        "Instrucciones para canjearlo:",
        ...instructions,
        "",
        `Compra: ${order.id}`,
        "No compartas tu PIN. Es de un solo uso."
      ].join("\n"),
      html: `
        <div style="font-family:Arial,sans-serif;color:#202c28;line-height:1.6">
          <h1>Tu PIN de diamantes Free Fire</h1>
          <p>Hola ${escapeHtml(order.customer_name)}, Mercado Pago confirmó tu pago de
            <strong>${escapeHtml(order.package_label)} diamantes</strong>.</p>
          <p>Este es tu código PIN:</p>
          <p style="padding:16px;background:#f0f4e7;font-size:22px;font-weight:bold;letter-spacing:2px">
            ${escapeHtml(pinCode)}
          </p>
          <h2>Cómo canjearlo</h2>
          <ol>${htmlInstructions}</ol>
          <p><a href="${REDEEM_URL}">Abrir PagoStore</a></p>
          <p>Compra ${escapeHtml(order.id)}. No compartas tu PIN; es de un solo uso.</p>
        </div>`
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`El servicio de correo respondió HTTP ${response.status}.`);
}

async function handleWebhook(request, url, response) {
  const body = await readJson(request, true);
  const paymentId = String(url.searchParams.get("data.id") || url.searchParams.get("id") || body?.data?.id || "");
  if (!paymentId) return json(response, 400, { error: "La notificación no incluye un ID de pago." });
  if (!verifyMercadoPagoSignature(request, paymentId)) {
    return json(response, 401, { error: "Firma de webhook inválida." });
  }

  const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!paymentResponse.ok) throw new Error(`No se pudo verificar el pago en Mercado Pago (HTTP ${paymentResponse.status}).`);
  const payment = await paymentResponse.json();
  if (String(payment.id) !== paymentId) {
    return json(response, 409, { error: "El ID del pago consultado no coincide con el webhook." });
  }
  if (payment.status !== "approved") return json(response, 200, { received: true, status: payment.status });

  const orderId = String(payment.external_reference || "");
  const order = await execute(getSupabase().from("freefire_orders").select("*").eq("id", orderId).maybeSingle());
  if (!order) return json(response, 404, { error: "No existe la compra asociada al pago." });
  if (Number(payment.transaction_amount) !== order.amount_ars || payment.currency_id !== "ARS") {
    return json(response, 409, { error: "El importe o la moneda del pago no coincide con la compra." });
  }
  const fulfillment = await assignPinToOrder(
    getSupabase(),
    decodeEncryptionKey(process.env.PIN_ENCRYPTION_KEY),
    order.id,
    String(payment.id)
  );
  if (fulfillment.status === "out_of_stock_pending_refund") {
    console.error(`ALERTA DE INVENTARIO: pago ${payment.id} aprobado, pero no hay PIN disponible para ${order.package_id}. Orden ${order.id} requiere reembolso o gestión manual.`);
    return json(response, 200, { received: true, status: "out_of_stock_pending_refund" });
  }

  const ownsEmailClaim = await claimOrderEmail(getSupabase(), order.id);
  if (!ownsEmailClaim) return json(response, 200, { received: true, status: "approved" });
  try {
    const paidOrder = await execute(getSupabase().from("freefire_orders").select("*").eq("id", order.id).single());
    await sendPaymentEmail(paidOrder, fulfillment.pin);
    await markOrderEmailSent(getSupabase(), order.id);
  } catch (error) {
    await releaseOrderEmailClaim(getSupabase(), order.id);
    console.error(`Pago ${payment.id} aprobado; error al enviar confirmación:`, error);
    return json(response, 503, { error: "Pago aprobado y PIN asignado, pero no se pudo enviar el correo; Mercado Pago puede reintentar el webhook." });
  }
  return json(response, 200, { received: true, status: "approved" });
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/admin/session" && request.method === "GET") {
    return json(response, 200, { authenticated: hasValidAdminSession(request) });
  }
  if (url.pathname === "/api/admin/session" && request.method === "POST") {
    if (!isAdminAuthConfigured()) {
      return json(response, 503, {
        error: "El acceso de administrador no está configurado. Define ADMIN_PASSWORD y ADMIN_SESSION_SECRET en el servidor."
      });
    }
    try {
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input) ||
        !verifyAdminCredentials(input.username, input.password)) {
        return json(response, 401, { error: "Usuario o contraseña de administrador incorrectos." });
      }
      return json(response, 200, { authenticated: true }, {
        "Set-Cookie": createAdminSessionCookie(request)
      });
    } catch (error) {
      if (error.statusCode) return json(response, error.statusCode, { error: error.message });
      throw error;
    }
  }
  if (url.pathname === "/api/admin/session" && request.method === "DELETE") {
    return json(response, 200, { authenticated: false }, {
      "Set-Cookie": clearAdminSessionCookie(request)
    });
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, {
      ok: true,
      paymentConfigured: checkoutConfigured(),
      inventoryConfigured: inventoryConfigured()
    });
  }
  if (request.method === "GET" && url.pathname === "/api/packages") {
    try {
      const packages = await getCachedPackages();
      return json(response, 200, {
        packages,
        marginArs: PROFIT_MARGIN_ARS,
        currency: "ARS",
        exchangeRate: packages[0]?.usd_ars_rate || null,
        paymentConfigured: checkoutConfigured()
      });
    } catch (error) {
      console.error("No se pudo leer el catálogo guardado para el inventario de PINES:", error);
      return json(response, 503, {
        error: `No se pudieron cargar los paquetes guardados en Supabase. Verifica SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y que database/schema.sql esté aplicado. Detalle: ${error.message}`
      });
    }
  }
  if (request.method === "GET" && url.pathname === "/api/freefire/packages") {
    try {
      const catalog = await refreshCatalog();
      return json(response, 200, {
        ...catalog,
        marginArs: PROFIT_MARGIN_ARS,
        currency: "ARS",
        exchangeRate: catalog.packages[0]?.usd_ars_rate || null,
        paymentConfigured: checkoutConfigured()
      });
    } catch (error) {
      console.error("No se pudo obtener el catálogo de Free Fire:", error);
      return json(response, 503, { error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/admin/pines/import") {
    if (!hasValidAdminSession(request)) {
      return json(response, 401, { error: "Inicia sesión como administrador para cargar PINES." });
    }
    try {
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return json(response, 400, { error: "Envía un objeto JSON con el paquete y los códigos." });
      }
      const packageId = typeof input.packageId === "string" ? input.packageId : "";
      const packageExists = await execute(getSupabase().from("freefire_packages")
        .select("id").eq("id", packageId).maybeSingle());
      if (!packageExists) {
        return json(response, 400, { error: "El paquete no existe en el catálogo actualizado." });
      }
      let codes = input.codes;
      if (typeof codes === "string") codes = codes.split(/\r?\n/).map(code => code.trim()).filter(Boolean);
      if (!Array.isArray(codes)) {
        return json(response, 400, { error: "Envía `codes` como texto separado por líneas o como lista de códigos." });
      }
      const result = await importPins(
        getSupabase(),
        decodeEncryptionKey(process.env.PIN_ENCRYPTION_KEY),
        packageId,
        codes
      );
      return json(response, 201, result);
    } catch (error) {
      if (error.statusCode) return json(response, error.statusCode, { error: error.message });
      console.error("No se pudo importar el inventario de PINES:", error);
      return json(response, 500, { error: "No se pudo guardar el inventario de PINES." });
    }
  }
  if (request.method === "GET" && url.pathname === "/api/admin/pines/stock") {
    if (!hasValidAdminSession(request)) {
      return json(response, 401, { error: "Inicia sesión como administrador para consultar el inventario." });
    }
    const stock = await execute(getSupabase().rpc("get_pin_stock"));
    return json(response, 200, { stock });
  }
  if (request.method === "POST" && url.pathname === "/api/freefire/orders") {
    if (!checkoutConfigured()) {
      return json(response, 503, {
        error: "Checkout deshabilitado. Configurá Mercado Pago, webhook, URL pública HTTPS, envío de correo y cifrado de PIN en el servidor."
      });
    }
    try {
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return json(response, 400, { error: "Envía un objeto JSON válido para iniciar la compra." });
      }
      const packageId = typeof input.packageId === "string" ? input.packageId : "";
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      if (name.length < 2 || name.length > 100) throw Object.assign(new Error("Ingresá un nombre válido."), { statusCode: 400 });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw Object.assign(new Error("Ingresá un correo válido."), { statusCode: 400 });

      const catalog = await refreshCatalog();
      if (!catalog.saleEnabled) throw Object.assign(new Error("El catálogo está desactualizado; no se aceptan compras hasta actualizar los precios."), { statusCode: 503 });
      const selectedPackage = catalog.packages.find(item => item.id === packageId);
      if (!selectedPackage) throw Object.assign(new Error("El paquete seleccionado ya no está disponible."), { statusCode: 400 });
      if (selectedPackage.stock_available < 1) {
        throw Object.assign(new Error("No hay PIN disponible para este paquete. Elegí otro paquete o volvé más tarde."), { statusCode: 409 });
      }

      const id = crypto.randomUUID();
      const accessToken = crypto.randomBytes(32).toString("hex");
      const order = await execute(getSupabase().from("freefire_orders").insert({
        id,
        package_id: selectedPackage.id,
        package_label: selectedPackage.label,
        diamonds: selectedPackage.diamonds,
        customer_name: name,
        email,
        amount_ars: selectedPackage.final_price_ars,
        status: "payment_pending",
        fulfillment_status: "not_started",
        access_token_hash: crypto.createHash("sha256").update(accessToken).digest("hex"),
        created_at: new Date().toISOString()
      }).select("*").single());
      const preferenceResponse = await createPaymentPreference(order, accessToken);
      if (!preferenceResponse.ok) {
        const details = await preferenceResponse.text();
        await execute(getSupabase().from("freefire_orders").update({ status: "payment_error" }).eq("id", id));
        throw new Error(`Mercado Pago no pudo crear el checkout (HTTP ${preferenceResponse.status}): ${details.slice(0, 300)}`);
      }
      const preference = await preferenceResponse.json();
      await execute(getSupabase().from("freefire_orders").update({ preference_id: preference.id }).eq("id", id));
      return json(response, 201, {
        orderId: id,
        checkoutUrl: preference.init_point,
        accessToken
      });
    } catch (error) {
      return json(response, error.statusCode || 502, { error: error.message });
    }
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/freefire/orders/")) {
    const id = url.pathname.slice("/api/freefire/orders/".length);
    const token = url.searchParams.get("token") || "";
    if (!/^[0-9a-f-]{36}$/i.test(id) || token.length !== 64) {
      return json(response, 404, { error: "Compra no encontrada." });
    }
    const order = await execute(getSupabase().from("freefire_orders").select("*").eq("id", id).maybeSingle());
    if (!order || !crypto.timingSafeEqual(
      Buffer.from(order.access_token_hash, "hex"),
      crypto.createHash("sha256").update(token).digest()
    )) return json(response, 404, { error: "Compra no encontrada." });
    let pinCode = null;
    if (order.status === "paid" && order.fulfillment_status === "assigned") {
      const pin = await execute(getSupabase().from("pines")
        .select("codigo_pin,pin_iv,pin_auth_tag")
        .eq("order_id", order.id).eq("estado", "vendido").maybeSingle());
      if (!pin) {
        return json(response, 500, { error: "No se encontró el PIN asociado. Contacta con soporte." });
      }
      pinCode = decryptPin(pin, decodeEncryptionKey(process.env.PIN_ENCRYPTION_KEY));
    }
    return json(response, 200, {
      orderId: order.id,
      packageLabel: order.package_label,
      amountArs: order.amount_ars,
      status: order.status,
      fulfillmentStatus: order.fulfillment_status,
      paidAt: order.paid_at,
      pinCode,
      redemptionUrl: REDEEM_URL
    });
  }
  if (request.method === "POST" && url.pathname === "/api/webhooks/mercadopago") {
    try {
      return await handleWebhook(request, url, response);
    } catch (error) {
      console.error("Error procesando webhook de Mercado Pago:", error);
      return json(response, error.statusCode || 502, { error: error.message });
    }
  }
  return json(response, 404, { error: "Ruta API no encontrada." });
}

async function handleRequest(request, response) {
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    try {
      return await handleApi(request, response, url);
    } catch (error) {
      console.error(`Error en ${request.method} ${url.pathname}:`, error);
      return json(response, 500, { error: "Error interno del servidor." });
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
  const requestedFile = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (requestedFile !== root && !requestedFile.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(requestedFile, (error, contents) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(requestedFile)] || "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : contents);
  });
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  setInterval(() => {
    refreshCatalog().catch(error => {
      console.error("No se pudo actualizar el catálogo en la revisión programada:", error);
    });
  }, PRICE_CACHE_MS).unref();

  const port = Number(process.env.PORT) || 4173;
  server.listen(port, "0.0.0.0", () => {
    console.log(`Vértice disponible en http://localhost:${port}`);
  });
}

module.exports = handleRequest;
