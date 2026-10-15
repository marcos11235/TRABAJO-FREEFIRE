const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assignPinToOrder,
  claimOrderEmail,
  decodeEncryptionKey,
  importPins,
  markOrderEmailSent,
  releaseOrderEmailClaim
} = require("../pin-inventory");

const key = decodeEncryptionKey(Buffer.alloc(32, 7).toString("base64"));
const packageId = "latin-gm-305106";

function createSupabaseStub() {
  const pins = [];
  const orders = new Map();
  const emailClaims = new Set();
  let nextPinId = 1;

  return {
    pins,
    orders,
    from(table) {
      return {
        insert(rows) {
          if (table !== "pines") throw new Error(`Unexpected insert table: ${table}`);
          if (rows.some(row => pins.some(pin => pin.codigo_pin_hash === row.codigo_pin_hash))) {
            return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
          }
          pins.push(...rows.map(row => ({ ...row, id: nextPinId++ })));
          return Promise.resolve({ data: null, error: null });
        },
        update(values) {
          return {
            eq(_column, value) {
              if (table === "freefire_orders" && orders.has(value)) {
                Object.assign(orders.get(value), values);
                if (values.email_sending_at === null) emailClaims.delete(value);
              }
              return Promise.resolve({ data: null, error: null });
            }
          };
        }
      };
    },
    rpc(name, args) {
      if (name === "claim_order_email") {
        if (emailClaims.has(args.p_order_id)) return Promise.resolve({ data: false, error: null });
        emailClaims.add(args.p_order_id);
        return Promise.resolve({ data: true, error: null });
      }
      if (name !== "assign_pin_to_order") throw new Error(`Unexpected RPC: ${name}`);
      const order = orders.get(args.p_order_id);
      if (!order) return Promise.resolve({ data: null, error: { code: "P0002", message: "order not found" } });
      const assigned = pins.find(pin => pin.order_id === order.id && pin.estado === "vendido");
      if (assigned) {
        return Promise.resolve({ data: { status: "assigned", order, pin: assigned }, error: null });
      }
      const available = pins.find(pin => pin.paquete_id === order.package_id && pin.estado === "disponible");
      if (!available) {
        Object.assign(order, {
          status: "out_of_stock_pending_refund",
          fulfillment_status: "out_of_stock_pending_refund",
          payment_id: args.p_payment_id
        });
        return Promise.resolve({
          data: { status: "out_of_stock_pending_refund", order, pin: null },
          error: null
        });
      }
      Object.assign(available, {
        estado: "vendido",
        order_id: order.id,
        fecha_venta: args.p_paid_at
      });
      Object.assign(order, {
        status: "paid",
        fulfillment_status: "assigned",
        payment_id: args.p_payment_id,
        paid_at: args.p_paid_at
      });
      return Promise.resolve({ data: { status: "assigned", order, pin: available }, error: null });
    }
  };
}

function makeOrder(id) {
  return {
    id,
    package_id: packageId,
    status: "payment_pending",
    fulfillment_status: "not_started"
  };
}

test("imports encrypted PINs to Supabase and assigns one to an approved order once", async () => {
  const client = createSupabaseStub();
  assert.deepEqual(await importPins(client, key, packageId, ["ABCDEF-123456"]), {
    imported: 1,
    packageId
  });
  assert.equal(client.pins.length, 1);
  assert.equal(client.pins[0].estado, "disponible");
  assert.notEqual(client.pins[0].codigo_pin, "ABCDEF-123456");

  client.orders.set("order-1", makeOrder("order-1"));
  const first = await assignPinToOrder(client, key, "order-1", "payment-1");
  assert.equal(first.status, "assigned");
  assert.equal(first.pin, "ABCDEF-123456");
  assert.equal(first.order.status, "paid");
  assert.equal(client.pins[0].estado, "vendido");

  const retry = await assignPinToOrder(client, key, "order-1", "payment-1");
  assert.equal(retry.status, "assigned");
  assert.equal(retry.pin, "ABCDEF-123456");
  assert.equal(client.pins.filter(pin => pin.estado === "vendido").length, 1);

  client.orders.set("order-2", makeOrder("order-2"));
  const noStock = await assignPinToOrder(client, key, "order-2", "payment-2");
  assert.equal(noStock.status, "out_of_stock_pending_refund");
  assert.equal(noStock.pin, null);
});

test("duplicate PIN imports fail without adding any rows", async () => {
  const client = createSupabaseStub();
  await importPins(client, key, packageId, ["ABCDEF-123456"]);
  await assert.rejects(
    importPins(client, key, packageId, ["NEWPIN-123456", "ABCDEF-123456"]),
    { statusCode: 409 }
  );
  assert.equal(client.pins.length, 1);
});

test("email claims are conditional and can be released or completed", async () => {
  const client = createSupabaseStub();
  client.orders.set("order-email", makeOrder("order-email"));
  assert.equal(await claimOrderEmail(client, "order-email", "2026-10-12T12:00:00.000Z"), true);
  assert.equal(await claimOrderEmail(client, "order-email", "2026-10-12T12:00:01.000Z"), false);
  await releaseOrderEmailClaim(client, "order-email");
  assert.equal(await claimOrderEmail(client, "order-email", "2026-10-12T12:00:02.000Z"), true);
  await markOrderEmailSent(client, "order-email", "2026-10-12T12:00:03.000Z");
  assert.equal(client.orders.get("order-email").email_sent_at, "2026-10-12T12:00:03.000Z");
});

test("rejects malformed encryption keys", () => {
  assert.throws(() => decodeEncryptionKey("not-a-valid-key"));
});
