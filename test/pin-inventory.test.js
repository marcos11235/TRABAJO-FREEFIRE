const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
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

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(fs.readFileSync(path.join(__dirname, "..", "database.sql"), "utf8"));
  assert.equal(database.prepare("SELECT id FROM freefire_packages WHERE id = ?").get(packageId).id, packageId);
  return database;
}

function insertOrder(database, id) {
  database.prepare(`
    INSERT INTO freefire_orders
      (id, package_id, package_label, diamonds, customer_name, email, amount_ars,
       status, fulfillment_status, access_token_hash, created_at)
    VALUES (?, ?, '100 + 10', 110, 'Test User', 'test@example.com', 830,
       'payment_pending', 'not_started', 'test-token-hash', ?)
  `).run(id, packageId, new Date().toISOString());
}

test("initializes a Free Fire-only fallback catalog for an empty database", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(fs.readFileSync(path.join(__dirname, "..", "database.sql"), "utf8"));
    const packages = database.prepare("SELECT id, label, diamonds FROM freefire_packages ORDER BY diamonds").all();
    assert.equal(packages.length, 6);
    assert.deepEqual({ ...packages[0] }, {
      id: "latin-gm-305106",
      label: "100 + 10",
      diamonds: 110
    });
    assert.ok(packages.every(item => /^latin-gm-\d+$/.test(item.id)));
  } finally {
    database.close();
  }
});

test("simulates an approved package purchase and marks its PIN sold exactly once", () => {
  const database = createDatabase();
  try {
    assert.deepEqual(importPins(database, key, packageId, ["ABCDEF-123456"]), {
      imported: 1,
      packageId
    });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM pines WHERE paquete_id = ? AND estado = 'disponible'")
        .get(packageId).count,
      1
    );
    insertOrder(database, "order-1");
    const firstAssignment = assignPinToOrder(database, key, "order-1", "payment-1");
    assert.equal(firstAssignment.status, "assigned");
    assert.equal(firstAssignment.pin, "ABCDEF-123456");
    assert.equal(firstAssignment.order.fulfillment_status, "assigned");
    assert.equal(firstAssignment.order.status, "paid");
    assert.equal(
      database.prepare("SELECT estado FROM pines WHERE order_id = ?").get("order-1").estado,
      "vendido"
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM pines WHERE paquete_id = ? AND estado = 'disponible'")
        .get(packageId).count,
      0
    );

    const retry = assignPinToOrder(database, key, "order-1", "payment-1");
    assert.equal(retry.status, "assigned");
    assert.equal(retry.pin, "ABCDEF-123456");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pines WHERE estado = 'vendido'").get().count, 1);
    assert.notEqual(
      database.prepare("SELECT codigo_pin FROM pines").get().codigo_pin,
      "ABCDEF-123456"
    );
    insertOrder(database, "order-2");
    const nextAssignment = assignPinToOrder(database, key, "order-2", "payment-2");
    assert.equal(nextAssignment.status, "out_of_stock_pending_refund");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pines WHERE estado = 'vendido'").get().count, 1);
  } finally {
    database.close();
  }
});

test("an approved payment without matching inventory enters refund-pending state", () => {
  const database = createDatabase();
  try {
    insertOrder(database, "order-no-stock");
    const assignment = assignPinToOrder(database, key, "order-no-stock", "payment-2");
    assert.equal(assignment.status, "out_of_stock_pending_refund");
    assert.equal(assignment.pin, null);
    const order = database.prepare("SELECT status, fulfillment_status FROM freefire_orders WHERE id = ?")
      .get("order-no-stock");
    assert.deepEqual({ ...order }, {
      status: "out_of_stock_pending_refund",
      fulfillment_status: "out_of_stock_pending_refund"
    });
  } finally {
    database.close();
  }
});

test("duplicate PIN imports fail atomically", () => {
  const database = createDatabase();
  try {
    importPins(database, key, packageId, ["ABCDEF-123456"]);
    assert.throws(() => importPins(database, key, packageId, ["NEWPIN-123456", "ABCDEF-123456"]), {
      statusCode: 409
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pines").get().count, 1);
  } finally {
    database.close();
  }
});

test("only one webhook retry at a time can send the same order email", () => {
  const database = createDatabase();
  try {
    insertOrder(database, "order-email");
    assert.equal(claimOrderEmail(database, "order-email", "2026-10-12T12:00:00.000Z"), true);
    assert.equal(claimOrderEmail(database, "order-email", "2026-10-12T12:00:01.000Z"), false);
    releaseOrderEmailClaim(database, "order-email");
    assert.equal(claimOrderEmail(database, "order-email", "2026-10-12T12:00:02.000Z"), true);
    markOrderEmailSent(database, "order-email", "2026-10-12T12:00:03.000Z");
    assert.equal(claimOrderEmail(database, "order-email", "2026-10-12T12:00:04.000Z"), false);
  } finally {
    database.close();
  }
});

test("rejects malformed encryption keys", () => {
  assert.throws(() => decodeEncryptionKey("not-a-valid-key"));
});
