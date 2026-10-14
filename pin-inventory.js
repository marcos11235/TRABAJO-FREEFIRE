const crypto = require("node:crypto");

function decodeEncryptionKey(encodedKey) {
  if (typeof encodedKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
    throw new Error("PIN_ENCRYPTION_KEY debe ser una clave Base64 de 32 bytes.");
  }
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("PIN_ENCRYPTION_KEY debe ser una clave Base64 de 32 bytes.");
  }
  return key;
}

function encryptPin(pin, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    hash: crypto.createHmac("sha256", key).update(`pin:${pin}`).digest("hex")
  };
}

function decryptPin(pin, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(pin.pin_iv, "base64"));
  decipher.setAuthTag(Buffer.from(pin.pin_auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(pin.codigo_pin, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function importPins(database, encryptionKey, packageId, codes, createdAt = new Date().toISOString()) {
  if (typeof packageId !== "string" || !/^latin-gm-\d+$/.test(packageId)) {
    throw Object.assign(new Error("El paquete indicado no es válido."), { statusCode: 400 });
  }
  if (!Array.isArray(codes) || codes.length < 1 || codes.length > 1000) {
    throw Object.assign(new Error("Importá entre 1 y 1000 códigos por solicitud."), { statusCode: 400 });
  }
  const normalized = codes.map(code => typeof code === "string" ? code.trim() : "");
  if (normalized.some(code => !/^[A-Za-z0-9-]{6,100}$/.test(code))) {
    throw Object.assign(new Error("Cada PIN debe tener entre 6 y 100 caracteres alfanuméricos o guiones."), { statusCode: 400 });
  }
  if (new Set(normalized).size !== normalized.length) {
    throw Object.assign(new Error("La lista contiene códigos duplicados."), { statusCode: 409 });
  }

  const insert = database.prepare(`
    INSERT INTO pines
      (paquete_id, codigo_pin, codigo_pin_hash, pin_iv, pin_auth_tag, estado, created_at)
    VALUES (?, ?, ?, ?, ?, 'disponible', ?)
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    normalized.forEach(code => {
      const encrypted = encryptPin(code, encryptionKey);
      insert.run(packageId, encrypted.ciphertext, encrypted.hash, encrypted.iv, encrypted.authTag, createdAt);
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE constraint failed")) {
      throw Object.assign(new Error("Uno o más PIN ya fueron importados; no se agregó ningún código."), { statusCode: 409 });
    }
    throw error;
  }
  return { imported: normalized.length, packageId };
}

function assignPinToOrder(database, encryptionKey, orderId, paymentId, paidAt = new Date().toISOString()) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const order = database.prepare("SELECT * FROM freefire_orders WHERE id = ?").get(orderId);
    if (!order) throw Object.assign(new Error("No existe la compra asociada al pago."), { statusCode: 404 });
    if (order.payment_id && order.payment_id !== String(paymentId)) {
      throw Object.assign(new Error("La compra ya está asociada a otro pago."), { statusCode: 409 });
    }

    if (order.fulfillment_status === "assigned") {
      const existingPin = database.prepare(
        "SELECT * FROM pines WHERE order_id = ? AND estado = 'vendido'"
      ).get(order.id);
      if (!existingPin) throw new Error(`La orden ${order.id} indica PIN asignado pero no tiene un PIN vendido asociado.`);
      if (!order.payment_id) {
        database.prepare("UPDATE freefire_orders SET payment_id = ? WHERE id = ?")
          .run(String(paymentId), order.id);
      }
      const updatedOrder = database.prepare("SELECT * FROM freefire_orders WHERE id = ?").get(order.id);
      const pin = decryptPin(existingPin, encryptionKey);
      database.exec("COMMIT");
      return {
        status: "assigned",
        order: updatedOrder,
        pin
      };
    }
    if (order.fulfillment_status === "out_of_stock_pending_refund") {
      database.exec("COMMIT");
      return { status: "out_of_stock_pending_refund", order, pin: null };
    }
    if (order.status !== "payment_pending") {
      throw Object.assign(new Error("La compra no está pendiente de pago."), { statusCode: 409 });
    }

    const availablePin = database.prepare(`
      SELECT * FROM pines
      WHERE paquete_id = ? AND estado = 'disponible'
      ORDER BY id
      LIMIT 1
    `).get(order.package_id);
    if (!availablePin) {
      database.prepare(`
        UPDATE freefire_orders
        SET status = 'out_of_stock_pending_refund',
            fulfillment_status = 'out_of_stock_pending_refund',
            payment_id = ?,
            paid_at = ?
        WHERE id = ?
      `).run(String(paymentId), paidAt, order.id);
      const updatedOrder = database.prepare("SELECT * FROM freefire_orders WHERE id = ?").get(order.id);
      database.exec("COMMIT");
      return {
        status: "out_of_stock_pending_refund",
        order: updatedOrder,
        pin: null
      };
    }

    const updatePin = database.prepare(`
      UPDATE pines
      SET estado = 'vendido', order_id = ?, fecha_venta = ?
      WHERE id = ? AND estado = 'disponible'
    `).run(order.id, paidAt, availablePin.id);
    if (Number(updatePin.changes) !== 1) {
      throw new Error("No se pudo reservar exclusivamente el PIN disponible.");
    }
    database.prepare(`
      UPDATE freefire_orders
      SET status = 'paid', fulfillment_status = 'assigned',
          payment_id = ?, paid_at = ?
      WHERE id = ?
    `).run(String(paymentId), paidAt, order.id);
    const updatedOrder = database.prepare("SELECT * FROM freefire_orders WHERE id = ?").get(order.id);
    const pin = decryptPin(availablePin, encryptionKey);
    database.exec("COMMIT");
    return {
      status: "assigned",
      order: updatedOrder,
      pin
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function claimOrderEmail(database, orderId, now = new Date().toISOString()) {
  const staleBefore = new Date(Date.parse(now) - 5 * 60 * 1000).toISOString();
  const result = database.prepare(`
    UPDATE freefire_orders
    SET email_sending_at = ?
    WHERE id = ? AND email_sent_at IS NULL
      AND (email_sending_at IS NULL OR email_sending_at < ?)
  `).run(now, orderId, staleBefore);
  return Number(result.changes) === 1;
}

function markOrderEmailSent(database, orderId, sentAt = new Date().toISOString()) {
  database.prepare(`
    UPDATE freefire_orders
    SET email_sent_at = ?, email_sending_at = NULL
    WHERE id = ?
  `).run(sentAt, orderId);
}

function releaseOrderEmailClaim(database, orderId) {
  database.prepare("UPDATE freefire_orders SET email_sending_at = NULL WHERE id = ?")
    .run(orderId);
}

module.exports = {
  assignPinToOrder,
  claimOrderEmail,
  decodeEncryptionKey,
  decryptPin,
  importPins,
  markOrderEmailSent,
  releaseOrderEmailClaim
};
