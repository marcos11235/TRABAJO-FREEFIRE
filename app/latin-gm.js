const DEFAULT_PRODUCT_URL = "https://latingm.com/p/recarga-free-fire-chilez/";

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getDiamondCount(label) {
  const quantities = String(label).match(/\d[\d.]*/g);
  if (!quantities?.length) return 0;
  return quantities.reduce((sum, quantity) => sum + Number(quantity.replace(/\./g, "")), 0);
}

function parseLatinGmPackages(html, productUrl = DEFAULT_PRODUCT_URL) {
  const url = new URL(productUrl || DEFAULT_PRODUCT_URL);
  if (!["latingm.com", "www.latingm.com"].includes(url.hostname) || url.protocol !== "https:") {
    throw new Error("La URL de Latin GM debe usar HTTPS y pertenecer a latingm.com.");
  }
  if (html.length > 8 * 1024 * 1024) throw new Error("La página de Latin GM supera el tamaño esperado.");

  const variationAttribute = /\bdata-product_variations\s*=\s*"([^"]*)"/i.exec(html)?.[1];
  if (!variationAttribute) throw new Error("No se encontró la lista de variaciones en la ficha de Latin GM.");
  let variations;
  try {
    variations = JSON.parse(decodeHtmlAttribute(variationAttribute));
  } catch (error) {
    throw new Error(`No se pudieron interpretar las variaciones de Latin GM: ${error.message}`);
  }
  if (!Array.isArray(variations)) throw new Error("Latin GM devolvió un formato de variaciones inesperado.");

  const packages = variations.map(variation => {
    const label = Object.values(variation.attributes || {}).find(Boolean);
    const priceUsd = Number(variation.display_price);
    const variationId = Number(variation.variation_id);
    const diamonds = getDiamondCount(label);
    if (!label || variation.is_in_stock === false || variation.is_purchasable === false ||
      !Number.isInteger(variationId) || variationId <= 0 ||
      !Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isSafeInteger(diamonds) || diamonds <= 0) {
      return null;
    }
    return { variationId, label: String(label), diamonds, priceUsd, productUrl: url.href };
  }).filter(Boolean);

  return packages;
}

async function scrapeLatinGmPackages(productUrl = DEFAULT_PRODUCT_URL) {
  const url = new URL(productUrl || DEFAULT_PRODUCT_URL);
  if (!["latingm.com", "www.latingm.com"].includes(url.hostname) || url.protocol !== "https:") {
    throw new Error("La URL de Latin GM debe usar HTTPS y pertenecer a latingm.com.");
  }
  const response = await fetch(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": "VerticeFreeFirePriceBot/1.0 (+price refresh)"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Latin GM respondió HTTP ${response.status}.`);
  return parseLatinGmPackages(await response.text(), url.href);
}

module.exports = { parseLatinGmPackages, scrapeLatinGmPackages };
