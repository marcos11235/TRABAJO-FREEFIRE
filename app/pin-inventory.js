const crypto = require("node:crypto");
const { execute } = require("./supabase-store");

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

async function importPins(client, encryptionKey, packageId, codes, createdAt = new Date().toISOString()) {
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

  const rows = normalized.map(code => {
    const encrypted = encryptPin(code, encryptionKey);
    return {
      paquete_id: packageId,
      codigo_pin: encrypted.ciphertext,
      codigo_pin_hash: encrypted.hash,
      pin_iv: encrypted.iv,
      pin_auth_tag: encrypted.authTag,
      estado: "disponible",
      created_at: createdAt
    };
  });
  try {
    await execute(client.from("pines").insert(rows));
  } catch (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("Uno o más PIN ya fueron importados; no se agregó ningún código."), { statusCode: 409 });
    }
    throw error;
  }
  return { imported: normalized.length, packageId };
}

async function assignPinToOrder(client, encryptionKey, orderId, paymentId, paidAt = new Date().toISOString()) {
  const result = await execute(client.rpc("assign_pin_to_order", {
    p_order_id: orderId,
    p_payment_id: String(paymentId),
    p_paid_at: paidAt
  }));
  if (result.status === "assigned") {
    return { ...result, pin: decryptPin(result.pin, encryptionKey) };
  }
  return { ...result, pin: null };
}

async function claimOrderEmail(client, orderId, now = new Date().toISOString()) {
  return execute(client.rpc("claim_order_email", {
    p_order_id: orderId,
    p_now: now
  }));
}

async function markOrderEmailSent(client, orderId, sentAt = new Date().toISOString()) {
  await execute(client.from("freefire_orders")
    .update({ email_sent_at: sentAt, email_sending_at: null })
    .eq("id", orderId));
}

async function releaseOrderEmailClaim(client, orderId) {
  await execute(client.from("freefire_orders")
    .update({ email_sending_at: null })
    .eq("id", orderId));
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
