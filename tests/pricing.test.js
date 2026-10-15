const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateFinalPriceArs } = require("../app/pricing");

test("converts supplier USD price and adds exactly ARS 100", () => {
  assert.equal(calculateFinalPriceArs(0.73, 1535), 1221);
  assert.equal(calculateFinalPriceArs(2.17, 1535), 3431);
});

test("rejects invalid prices and exchange rates", () => {
  assert.throws(() => calculateFinalPriceArs(0, 1535));
  assert.throws(() => calculateFinalPriceArs(1, NaN));
});
