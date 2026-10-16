const DATA_KEY = "vertice-demo-data-v1";
const SESSION_KEY = "vertice-demo-session-v1";

const statusLabels = {
  payment_pending: "Pago pendiente",
  payment_error: "Error de pago",
  paid: "Aprobado",
  out_of_stock_pending_refund: "Pendiente de reembolso"
};

const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const authForm = document.querySelector("#auth-form");
const authMessage = document.querySelector("#auth-message");
let authMode = "login";
let store = readStore();
let currentUser = null;
let navigationHistory = [];
let freefireCatalog = null;
let freefireCatalogPromise = null;
let inventoryPackageOptions = [];

function readStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(DATA_KEY));
    if (saved && Array.isArray(saved.users) && Array.isArray(saved.orders)) return saved;
  } catch (error) {
    console.warn("No se pudieron leer los datos guardados del prototipo.", error);
  }
  return { users: [], orders: [] };
}

function saveStore() {
  localStorage.setItem(DATA_KEY, JSON.stringify(store));
}

function initializeStore() {
  store.orders = store.orders.filter(order =>
    order && typeof order === "object" && /^latin-gm-\d+$/.test(order.packageId || "")
  );
  const latestOrderNumber = store.orders.reduce((latest, order) => {
    const match = /^VT-(\d+)$/.exec(order.id);
    return match ? Math.max(latest, Number(match[1])) : latest;
  }, 0);
  if (!Number.isSafeInteger(store.nextOrderNumber) || store.nextOrderNumber <= latestOrderNumber) {
    store.nextOrderNumber = latestOrderNumber + 1;
  }
  store.users.forEach(user => {
    delete user.notifications;
  });

  let admin = store.users.find(user => user.username === "admin" || user.email === "admin");
  if (!admin) {
    admin = {
      id: "USR-ADMIN",
      name: "Administrador",
      username: "admin",
      email: "admin",
      password: "admin123",
      role: "admin",
      createdAt: new Date().toISOString(),
      loginCount: 0
    };
    store.users.push(admin);
  } else {
    admin.username = "admin";
    admin.role = "admin";
    admin.password = "admin123";
  }
  saveStore();
}

initializeStore();

function isAdmin() {
  return currentUser?.role === "admin";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function getOrdersFor(userId) {
  return store.orders.filter(order => order.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  document.querySelector("#login-tab").classList.toggle("is-active", !registering);
  document.querySelector("#register-tab").classList.toggle("is-active", registering);
  document.querySelector("#login-tab").setAttribute("aria-selected", String(!registering));
  document.querySelector("#register-tab").setAttribute("aria-selected", String(registering));
  document.querySelector("#name-field").classList.toggle("hidden", !registering);
  document.querySelector("#email-label").childNodes[0].textContent = registering ? "Correo electrónico" : "Correo electrónico o usuario";
  document.querySelector("#email-input").placeholder = registering ? "nombre@empresa.com" : "nombre@empresa.com o admin";
  document.querySelector("#name-input").required = registering;
  document.querySelector("#password-input").autocomplete = registering ? "new-password" : "current-password";
  document.querySelector("#auth-title").textContent = registering ? "Crea tu cuenta." : "Qué bueno verte.";
  document.querySelector("#auth-description").textContent = registering
    ? "Regístrate para entrar al portal de revendedores."
    : "Inicia sesión para continuar con tu operación.";
  document.querySelector("#auth-submit").innerHTML = registering
    ? 'Crear cuenta <span aria-hidden="true">&#8594;</span>'
    : 'Entrar al panel <span aria-hidden="true">&#8594;</span>';
  authMessage.textContent = "";
}

function getCurrentView() {
  return document.querySelector(".view-section.is-visible")?.id.replace("view-", "") || "";
}

function enterApp(user) {
  currentUser = user;
  localStorage.setItem(SESSION_KEY, user.id);
  authScreen.classList.add("hidden");
  document.querySelectorAll(".admin-only").forEach(element => element.classList.toggle("hidden", !isAdmin()));
  document.querySelectorAll(".customer-only").forEach(element => element.classList.toggle("hidden", isAdmin()));
  document.querySelector("#user-name-label").textContent = user.name;
  document.querySelector("#user-avatar").textContent = user.name.trim().charAt(0).toUpperCase();
  document.querySelector("#welcome-name").textContent = user.name.split(/\s+/)[0];
  document.querySelector("#account-user-name").textContent = user.name;
  document.querySelector("#account-user-role").textContent = isAdmin() ? "Administrador" : "Usuario";
  document.querySelector("#selected-catalog-label").textContent = "Free Fire";
  document.querySelector("#selected-catalog-label").classList.remove("hidden");
  renderAll();
  appShell.classList.remove("hidden");
  setView(isAdmin() ? "pins" : "purchase", false);
}

function leaveApp() {
  currentUser = null;
  document.querySelector("#pins-admin-token").value = "";
  document.querySelector("#pins-codes").value = "";
  localStorage.removeItem(SESSION_KEY);
  appShell.classList.add("hidden");
  navigationHistory = [];
  authScreen.classList.remove("hidden");
  authForm.reset();
  setAuthMode("login");
}

function setView(view, recordHistory = true) {
  const adminViews = ["users", "pins"];
  const customerViews = ["overview", "purchase", "history"];
  if ((isAdmin() && !adminViews.includes(view)) || (!isAdmin() && !customerViews.includes(view))) return;
  const previousView = getCurrentView();
  if (recordHistory && previousView && previousView !== view) navigationHistory.push(previousView);
  document.querySelectorAll(".view-section").forEach(section => {
    section.classList.toggle("is-visible", section.id === `view-${view}`);
  });
  document.querySelectorAll(".nav-link").forEach(button => {
    button.classList.toggle("is-current", button.dataset.view === view);
  });
  const activeButton = Array.from(document.querySelectorAll(`.nav-link[data-view="${view}"]`))
    .find(button => !button.classList.contains("hidden"));
  if (activeButton) activeButton.setAttribute("aria-current", "page");
  document.querySelectorAll(".nav-link:not([data-view='" + view + "'])").forEach(button => button.removeAttribute("aria-current"));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "pins" && isAdmin()) loadInventoryPackages();
}

function goBack() {
  const previousView = navigationHistory.pop() || (isAdmin() ? "users" : "purchase");
  setView(previousView, false);
}

function statusCell(status) {
  return `<span class="status-pill status-${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>`;
}

function renderAll() {
  if (!currentUser) return;
  renderOverview();
  renderPlans();
  renderHistory();
  renderUsers();
}

function renderOverview() {
  const orders = getOrdersFor(currentUser.id);
  const paidOrders = orders.filter(order => order.status === "paid");
  const deliveredPins = paidOrders.length;
  const pending = orders.filter(order => order.status === "payment_pending").length;
  document.querySelector("#metric-accounts").textContent = deliveredPins;
  document.querySelector("#metric-purchases").textContent = orders.length;
  document.querySelector("#metric-pending").textContent = pending;
  document.querySelector("#metric-spent").innerHTML = `${formatArs(paidOrders.reduce((sum, order) => sum + (Number(order.amountArs) || 0), 0))}`;

  const recentBody = document.querySelector("#recent-orders-body");
  const latest = orders.slice(0, 5);
  recentBody.innerHTML = latest.map(order => `
    <tr><td><span class="order-reference">${escapeHtml(order.id)}</span></td>
    <td>${formatDate(order.createdAt)}</td><td>${escapeHtml(order.packageLabel || "")}</td>
    <td><strong>${formatArs(Number(order.amountArs) || 0)}</strong></td><td>${statusCell(order.status)}</td></tr>`).join("");
  document.querySelector("#recent-empty").classList.toggle("hidden", latest.length > 0);
}

function renderPlans() {
  document.querySelector("#purchase-catalog-label").textContent = "FREE FIRE";
  renderFreeFirePlans();
}

function formatArs(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(value);
}

function renderFreeFirePlans() {
  const status = document.querySelector("#freefire-catalog-status");
  const statusMessage = document.querySelector("#freefire-catalog-message");
  const grid = document.querySelector("#plans-grid");
  document.querySelector("#freefire-checkout").classList.remove("hidden");
  document.querySelector("#freefire-package-id").value = "";
  document.querySelector("#freefire-checkout-submit").disabled = true;
  document.querySelector("#freefire-selected-package").textContent = "Selecciona un paquete para continuar.";
  if (!freefireCatalog) {
    grid.innerHTML = '<article class="plan-card freefire-loading"><h2>Cargando precios de Latin GM...</h2><p>Consultando el catálogo y la cotización oficial USD/ARS.</p></article>';
    status.classList.add("hidden");
    loadFreeFireCatalog();
    return;
  }

  const packages = freefireCatalog.packages || [];
  const checkoutReady = freefireCatalog.saleEnabled && freefireCatalog.paymentConfigured;
  grid.innerHTML = packages.map((item, index) => `
    <article class="plan-card freefire-plan-card ${index === 1 ? "is-featured" : ""}">
      <span class="freefire-diamond" aria-hidden="true">&#9670;</span>
      <span class="plan-tag">PIN CANJEABLE</span>
      <h2>${escapeHtml(item.label)} diamantes</h2>
      <p class="plan-description">${Number(item.diamonds).toLocaleString("es-AR")} diamantes en total</p>
      <div class="plan-price">${formatArs(item.final_price_ars)}</div>
      <span class="plan-unit">Precio final · incluye $100 ARS de margen</span>
      <div class="plan-detail"><span>PINES disponibles</span><strong>${Number(item.stock_available) || 0}</strong></div>
      <div class="plan-detail"><span>Precio actualizado</span><strong>${formatDate(item.updated_at)}</strong></div>
      <button class="button ${index === 1 ? "button-lime" : "button-dark"}" type="button"
        data-freefire-buy="${escapeHtml(item.id)}" ${checkoutReady && Number(item.stock_available) > 0 ? "" : "disabled"}>
        ${freefireCatalog.stale ? "Precio desactualizado" :
    Number(item.stock_available) < 1 ? "Sin stock" :
      !freefireCatalog.paymentConfigured ? "Pago no configurado" :
        "Elegir paquete"}
        <span aria-hidden="true">&#8594;</span>
      </button>
    </article>`).join("");

  const blockers = [];
  if (!freefireCatalog.saleEnabled) {
    blockers.push(freefireCatalog.warning || "No se puede vender con precios desactualizados.");
  }
  if (!freefireCatalog.paymentConfigured) {
    blockers.push("Mercado Pago aún no está configurado en este servidor. Completar el nombre y el correo no inicia un pago.");
  }
  if (packages.length && packages.every(item => Number(item.stock_available) < 1)) {
    blockers.push("No hay PINES cargados para ninguno de estos paquetes. El administrador debe agregarlos desde Menú → Inventario de PINES.");
  }
  if (!packages.length) blockers.push("No hay paquetes disponibles en Latin GM.");
  const message = blockers.join(" ");
  statusMessage.textContent = message;
  status.classList.toggle("hidden", !message);
}

async function loadFreeFireCatalog() {
  if (freefireCatalogPromise) return freefireCatalogPromise;
  freefireCatalogPromise = fetch("/api/freefire/packages")
    .then(async response => {
      const data = await readApiResponse(response, "No se pudo consultar el catálogo.");
      freefireCatalog = data;
      renderFreeFirePlans();
    })
    .catch(error => {
      document.querySelector("#plans-grid").innerHTML = "";
      document.querySelector("#freefire-catalog-message").textContent =
        `No se pudo cargar el catálogo de Latin GM: ${error.message}`;
      document.querySelector("#freefire-catalog-status").classList.remove("hidden");
      console.error("No se pudo cargar el catálogo de Free Fire.", {
        endpoint: "/api/freefire/packages",
        error
      });
    })
    .finally(() => {
      freefireCatalogPromise = null;
    });
  return freefireCatalogPromise;
}

function setInventoryMessage(text, isSuccess = false) {
  const message = document.querySelector("#pins-import-message");
  message.textContent = text;
  message.classList.toggle("is-success", isSuccess);
}

async function readApiResponse(response, fallbackMessage) {
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    const detail = body.trim().slice(0, 200);
    throw new Error(
      `El servidor respondió HTTP ${response.status} con una respuesta no válida${detail ? `: ${detail}` : "."}`
    );
  }
  if (!response.ok) throw new Error(data.error || fallbackMessage);
  return data;
}

function renderInventoryStock(stockRows = []) {
  const stockByPackage = new Map(stockRows.map(row => [row.paquete_id, Number(row.disponible) || 0]));
  const list = document.querySelector("#pins-stock-list");
  if (!inventoryPackageOptions.length) {
    list.textContent = "No hay paquetes en el catálogo.";
    return;
  }
  list.innerHTML = inventoryPackageOptions.map(item => `
    <div class="pins-stock-row">
      <span>${escapeHtml(item.label)} diamantes</span>
      <strong>${stockByPackage.get(item.id) || 0} disponibles</strong>
    </div>`).join("");
}

async function loadInventoryPackages() {
  if (!isAdmin()) return;
  const select = document.querySelector("#pins-package-id");
  const retryButton = document.querySelector("#pins-retry-packages");
  const selectedPackageId = select.value;
  const token = document.querySelector("#pins-admin-token").value.trim();
  select.innerHTML = '<option value="">Cargando paquetes...</option>';
  retryButton.classList.add("hidden");
  try {
    const catalogResponse = await fetch("/api/packages");
    const catalog = await readApiResponse(catalogResponse, "No se pudo cargar el catálogo.");
    if (!Array.isArray(catalog.packages) || catalog.packages.some(item =>
      !item || typeof item.id !== "string" || !item.id ||
      typeof item.label !== "string" || !item.label.trim()
    )) {
      throw new Error("La respuesta del catálogo no contiene una lista válida de paquetes.");
    }
    inventoryPackageOptions = catalog.packages;
    select.innerHTML = '<option value="">Selecciona un paquete</option>' +
      inventoryPackageOptions.map(item => `
        <option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} diamantes · ${Number(item.stock_available) || 0} disponibles</option>`
      ).join("");
    if (inventoryPackageOptions.some(item => item.id === selectedPackageId)) {
      select.value = selectedPackageId;
    }
    if (!inventoryPackageOptions.length) setInventoryMessage("El catálogo no contiene paquetes para importar.");

    if (token) await refreshInventoryStock(token);
    else renderInventoryStock(inventoryPackageOptions.map(item => ({
      paquete_id: item.id,
      disponible: item.stock_available
    })));
  } catch (error) {
    select.innerHTML = '<option value="">No se pudieron cargar los paquetes</option>';
    retryButton.classList.remove("hidden");
    console.error("No se pudieron cargar los paquetes de diamantes para el inventario.", {
      endpoint: "/api/packages",
      error
    });
    setInventoryMessage(error.message);
  }
}

async function refreshInventoryStock(token = document.querySelector("#pins-admin-token").value.trim()) {
  if (!isAdmin()) return;
  const list = document.querySelector("#pins-stock-list");
  list.textContent = "Consultando inventario...";
  try {
    const response = await fetch("/api/admin/pines/stock", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await readApiResponse(response, "No se pudo consultar el inventario.");
    renderInventoryStock(result.stock);
    setInventoryMessage("Stock actualizado.", true);
  } catch (error) {
    list.textContent = "";
    setInventoryMessage(error.message);
  }
}

function renderHistory() {
  const orders = getOrdersFor(currentUser.id);
  const rows = orders.map(order => `
    <tr><td><span class="order-reference">${escapeHtml(order.id)}</span></td>
    <td>${formatDate(order.createdAt)}</td><td>${escapeHtml(order.packageLabel || "")}</td>
    <td>${Number(order.diamonds) || 0}</td><td><strong>${formatArs(Number(order.amountArs) || 0)}</strong></td>
    <td>${statusCell(order.status)}</td></tr>`).join("");
  document.querySelector("#history-body").innerHTML = rows;
  document.querySelector("#history-empty").classList.toggle("hidden", orders.length > 0);
}

function renderUsers() {
  if (!isAdmin()) return;
  const users = store.users.filter(user => user.role !== "admin").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const rows = users.map(user => `<tr><td><strong>${escapeHtml(user.name)}</strong></td>
    <td>${escapeHtml(user.email)}</td><td>${formatDate(user.createdAt)}</td>
    <td>${formatDate(user.lastLoginAt)}</td><td>${Number(user.loginCount) || 0}</td></tr>`).join("");
  document.querySelector("#users-body").innerHTML = rows;
  document.querySelector("#users-total-chip").textContent = `${users.length} usuarios`;
  document.querySelector("#users-empty").classList.toggle("hidden", users.length > 0);
}

document.querySelector("#login-tab").addEventListener("click", () => setAuthMode("login"));
document.querySelector("#register-tab").addEventListener("click", () => setAuthMode("register"));

function recordLogin(user) {
  user.lastLoginAt = new Date().toISOString();
  user.loginCount = (Number(user.loginCount) || 0) + 1;
}

authForm.addEventListener("submit", event => {
  event.preventDefault();
  authMessage.textContent = "";
  const name = document.querySelector("#name-input").value.trim();
  const email = document.querySelector("#email-input").value.trim().toLowerCase();
  const password = document.querySelector("#password-input").value;

  if (authMode === "register") {
    if (name.length < 2) {
      authMessage.textContent = "Escribe tu nombre completo.";
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      authMessage.textContent = "Escribe un correo electrónico válido.";
      return;
    }
    if (password.length < 6) {
      authMessage.textContent = "La contraseña debe tener al menos 6 caracteres.";
      return;
    }
    if (store.users.some(user => user.email === email)) {
      authMessage.textContent = "Ya existe una cuenta con ese correo.";
      return;
    }
    const user = { id: makeId("USR"), name, username: email, email, password, role: "customer", createdAt: new Date().toISOString() };
    recordLogin(user);
    store.users.push(user);
    saveStore();
    enterApp(user);
    return;
  }

  const user = store.users.find(item => (item.email === email || item.username === email) && item.password === password);
  if (!user) {
    authMessage.textContent = "Correo o contraseña incorrectos.";
    return;
  }
  recordLogin(user);
  saveStore();
  enterApp(user);
});

document.querySelector("#logout-button").addEventListener("click", leaveApp);
document.querySelector("#back-button").addEventListener("click", goBack);
document.querySelector("#topbar-brand").addEventListener("click", event => {
  event.preventDefault();
  setView(isAdmin() ? "pins" : "overview");
});
document.querySelector("#nav-toggle").addEventListener("click", () => {
  const nav = document.querySelector("#main-nav");
  const expanded = document.querySelector("#nav-toggle").getAttribute("aria-expanded") === "true";
  document.querySelector("#nav-toggle").setAttribute("aria-expanded", String(!expanded));
  nav.classList.toggle("hidden", expanded);
});

document.querySelector("#main-nav").addEventListener("click", event => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  document.querySelector("#main-nav").classList.add("hidden");
  document.querySelector("#nav-toggle").setAttribute("aria-expanded", "false");
  setView(button.dataset.view);
});

document.addEventListener("click", event => {
  const accountMenu = document.querySelector(".account-menu");
  const nav = document.querySelector("#main-nav");
  const navToggle = document.querySelector("#nav-toggle");
  if (!accountMenu.contains(event.target)) accountMenu.open = false;
  if (!nav.contains(event.target) && !navToggle.contains(event.target)) {
    nav.classList.add("hidden");
    navToggle.setAttribute("aria-expanded", "false");
  }
});

document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => {
    setView(button.dataset.go);
  });
});

document.querySelector("#plans-grid").addEventListener("click", event => {
  const freefireButton = event.target.closest("[data-freefire-buy]");
  if (freefireButton) {
    const selectedPackage = freefireCatalog?.packages.find(item => item.id === freefireButton.dataset.freefireBuy);
    if (!selectedPackage || Number(selectedPackage.stock_available) < 1 ||
      !freefireCatalog.saleEnabled || !freefireCatalog.paymentConfigured) return;
    document.querySelector("#freefire-package-id").value = selectedPackage.id;
    document.querySelector("#freefire-selected-package").textContent =
      `${selectedPackage.label} diamantes · ${formatArs(selectedPackage.final_price_ars)}`;
    document.querySelector("#freefire-checkout-message").textContent = "";
    document.querySelector("#freefire-checkout-submit").disabled = false;
    document.querySelector("#freefire-checkout").scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

document.querySelector("#freefire-checkout").addEventListener("submit", async event => {
  event.preventDefault();
  const message = document.querySelector("#freefire-checkout-message");
  const submitButton = document.querySelector("#freefire-checkout-submit");
  message.classList.remove("is-success");
  message.textContent = "";
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/freefire/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packageId: document.querySelector("#freefire-package-id").value,
        name: document.querySelector("#freefire-customer-name").value.trim(),
        email: document.querySelector("#freefire-customer-email").value.trim()
      })
    });
    const result = await readApiResponse(response, "No se pudo iniciar el pago.");
    if (!result.checkoutUrl) throw new Error("Mercado Pago no devolvió un enlace de pago.");
    window.location.assign(result.checkoutUrl);
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
  }
});

let activeFreeFireReturn = null;

async function refreshFreeFireOrder(showInitialLoading = false) {
  if (!activeFreeFireReturn) return null;
  const { orderId, token } = activeFreeFireReturn;
  const title = document.querySelector("#freefire-result-title");
  const message = document.querySelector("#freefire-result-message");
  const reference = document.querySelector("#freefire-result-reference");
  const delivery = document.querySelector("#freefire-pin-delivery");
  const refreshButton = document.querySelector("#freefire-refresh-order");
  if (showInitialLoading) title.textContent = "Consultando tu compra...";
  try {
    const response = await fetch(`/api/freefire/orders/${encodeURIComponent(orderId)}?token=${encodeURIComponent(token)}`);
    const order = await readApiResponse(response, "No pudimos consultar la compra.");
    reference.textContent = `Compra ${order.orderId} · ${order.packageLabel}`;
    delivery.classList.add("hidden");
    refreshButton.classList.add("hidden");
    if (order.status === "paid" && order.fulfillmentStatus === "assigned" && order.pinCode) {
      title.textContent = "Pago aprobado: tu PIN está listo";
      message.textContent = "El pago fue confirmado y el PIN ya está asignado a esta compra. También enviamos el código y las instrucciones a tu correo.";
      document.querySelector("#freefire-pin-code").textContent = order.pinCode;
      const instructions = document.querySelector("#freefire-redemption-instructions");
      const redemptionLink = document.createElement("a");
      redemptionLink.href = order.redemptionUrl;
      redemptionLink.target = "_blank";
      redemptionLink.rel = "noopener noreferrer";
      redemptionLink.textContent = "PagoStore de Garena";
      instructions.replaceChildren();
      [
        ["Entra a ", redemptionLink],
        ["Inicia sesión con el método asociado a tu cuenta de Free Fire."],
        ["Elige la opción de canje o recarga con PIN y el paquete comprado."],
        ["Ingresa el código PIN, confirma el canje y revisa tu cuenta."]
      ].forEach(parts => {
        const item = document.createElement("li");
        parts.forEach(part => item.append(part instanceof Node ? part : document.createTextNode(part)));
        instructions.append(item);
      });
      delivery.classList.remove("hidden");
      return order;
    }
    if (order.status === "out_of_stock_pending_refund") {
      title.textContent = "Pago aprobado · stock agotado";
      message.textContent = "No quedaban PIN disponibles para este paquete. No se asignó ningún código; la compra quedó pendiente de reembolso o gestión por soporte.";
      return order;
    }
    if (order.status === "paid") {
      title.textContent = "Pago aprobado";
      message.textContent = "No se pudo recuperar el PIN de esta compra. Contacta con soporte e indica la referencia.";
      return order;
    }
    title.textContent = "Pago pendiente de confirmación";
    message.textContent = "Todavía no recibimos una confirmación aprobada de Mercado Pago. No se asignó ni se mostrará ningún PIN.";
    refreshButton.classList.remove("hidden");
    return order;
  } catch (error) {
    title.textContent = "No se pudo consultar la compra";
    message.textContent = error.message;
    refreshButton.classList.remove("hidden");
    return null;
  }
}

async function showFreeFirePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("freefire") !== "return") return;
  document.querySelector("#auth-screen").classList.add("hidden");
  document.querySelector("#app-shell").classList.add("hidden");
  const resultScreen = document.querySelector("#freefire-result");
  resultScreen.classList.remove("hidden");
  const orderId = params.get("order") || "";
  const token = params.get("token") || "";
  activeFreeFireReturn = { orderId, token };
  let order = await refreshFreeFireOrder(true);
  for (let attempt = 0; attempt < 30 && order &&
    order.status === "payment_pending"; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    order = await refreshFreeFireOrder();
  }
}

document.querySelector("#freefire-refresh-order").addEventListener("click", () => {
  refreshFreeFireOrder(true);
});

document.querySelector("#freefire-copy-pin").addEventListener("click", async () => {
  const pin = document.querySelector("#freefire-pin-code").textContent;
  const message = document.querySelector("#freefire-copy-message");
  try {
    await navigator.clipboard.writeText(pin);
    message.textContent = "Código PIN copiado.";
    message.classList.add("is-success");
  } catch (error) {
    message.classList.remove("is-success");
    message.textContent = "No se pudo copiar automáticamente. Selecciona y copia el código PIN.";
    console.error("No se pudo copiar el PIN al portapapeles.", error);
  }
});

document.querySelector("#freefire-result-back").addEventListener("click", () => {
  window.location.assign("/");
});

document.querySelector("#pins-import-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  const token = document.querySelector("#pins-admin-token").value.trim();
  const packageId = document.querySelector("#pins-package-id").value;
  const codes = document.querySelector("#pins-codes").value;
  const submitButton = document.querySelector("#pins-import-submit");
  if (!token || !packageId || !codes.trim()) {
    setInventoryMessage("Completa el token, el paquete y al menos un PIN.");
    return;
  }

  submitButton.disabled = true;
  setInventoryMessage("Agregando PINES...");
  try {
    const response = await fetch("/api/admin/pines/import", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ packageId, codes })
    });
    const result = await readApiResponse(response, "No se pudo cargar el inventario.");
    document.querySelector("#pins-codes").value = "";
    await loadInventoryPackages();
    setInventoryMessage(`Se agregaron ${result.imported} PINES al paquete seleccionado.`, true);
  } catch (error) {
    setInventoryMessage(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#pins-refresh-stock").addEventListener("click", async () => {
  if (!isAdmin()) return;
  const token = document.querySelector("#pins-admin-token").value.trim();
  if (!token) {
    setInventoryMessage("Ingresa el token de administrador para consultar el inventario.");
    return;
  }
  await refreshInventoryStock(token);
});

document.querySelector("#pins-admin-token").addEventListener("change", () => {
  if (isAdmin() && getCurrentView() === "pins") loadInventoryPackages();
});

document.querySelector("#pins-retry-packages").addEventListener("click", () => {
  if (isAdmin()) loadInventoryPackages();
});

const savedSession = localStorage.getItem(SESSION_KEY);
const sessionUser = store.users.find(user => user.id === savedSession);
if (sessionUser) enterApp(sessionUser);
else setAuthMode("login");
showFreeFirePaymentReturn();