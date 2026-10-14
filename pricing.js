const PROFIT_MARGIN_ARS = 100;

function calculateFinalPriceArs(supplierPriceUsd, usdArsSaleRate) {
  const supplierPrice = Number(supplierPriceUsd);
  const exchangeRate = Number(usdArsSaleRate);
  if (!Number.isFinite(supplierPrice) || supplierPrice <= 0 ||
    !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw new Error("El precio del proveedor y la cotización USD/ARS deben ser mayores que cero.");
  }
  return Math.round(supplierPrice * exchangeRate) + PROFIT_MARGIN_ARS;
}

module.exports = { PROFIT_MARGIN_ARS, calculateFinalPriceArs };
