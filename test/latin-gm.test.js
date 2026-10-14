const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLatinGmPackages } = require("../latin-gm");

test("parses available Latin GM variations and diamond counts", () => {
  const html = `
    <form data-product_variations="[
      {&quot;attributes&quot;:{&quot;attribute_diamantes&quot;:&quot;100 + 10&quot;},&quot;variation_id&quot;:305106,&quot;display_price&quot;:0.73,&quot;is_in_stock&quot;:true},
      {&quot;attributes&quot;:{&quot;attribute_diamantes&quot;:&quot;2.180 + 218&quot;},&quot;variation_id&quot;:305110,&quot;display_price&quot;:13.53,&quot;is_in_stock&quot;:true},
      {&quot;attributes&quot;:{&quot;attribute_diamantes&quot;:&quot;520 + 52&quot;},&quot;variation_id&quot;:305108,&quot;display_price&quot;:3.68,&quot;is_in_stock&quot;:false}
    ]"></form>`;

  assert.deepEqual(parseLatinGmPackages(html), [
    {
      variationId: 305106,
      label: "100 + 10",
      diamonds: 110,
      priceUsd: 0.73,
      productUrl: "https://latingm.com/p/recarga-free-fire-chilez/"
    },
    {
      variationId: 305110,
      label: "2.180 + 218",
      diamonds: 2398,
      priceUsd: 13.53,
      productUrl: "https://latingm.com/p/recarga-free-fire-chilez/"
    }
  ]);
});

test("does not fetch product URLs outside Latin GM", () => {
  assert.throws(() => parseLatinGmPackages("", "https://attacker.example/product"));
});
