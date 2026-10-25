// POST /api/checkout  { items: [{ id, size, qty }] }  ->  { url }
// Creates a Stripe Checkout Session. Prices come from products.json on the
// server, never from the browser, so a customer can't edit what they pay.
import PRODUCTS from "../public/products.json";

const FREE_SHIPPING_FROM = 800; // kr, Sweden
const MAX_QTY = 10;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function buildSessionParams(items, origin) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("Your cart is empty");
  if (items.length > 30) throw new Error("Too many items in the cart");

  const p = new URLSearchParams();
  let subtotal = 0;
  items.forEach((item, i) => {
    const product = PRODUCTS.find(x => x.id === item?.id);
    if (!product) throw new Error("A product in your cart is no longer available");
    if (!product.sizes.includes(item.size)) throw new Error(`Size ${item.size} isn't available for ${product.name}`);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error("Invalid quantity");
    subtotal += product.price * qty;
    const k = `line_items[${i}]`;
    p.append(`${k}[quantity]`, String(qty));
    p.append(`${k}[price_data][currency]`, "sek");
    p.append(`${k}[price_data][unit_amount]`, String(product.price * 100)); // öre
    p.append(`${k}[price_data][tax_behavior]`, "inclusive");
    p.append(`${k}[price_data][product_data][name]`, `${product.name} · ${product.color} · ${item.size}`);
    p.append(`${k}[price_data][product_data][metadata][product_id]`, product.id);
    p.append(`${k}[price_data][product_data][metadata][size]`, item.size);
  });

  p.append("mode", "payment");
  p.append("locale", "auto");
  p.append("success_url", `${origin}/tack?session_id={CHECKOUT_SESSION_ID}`);
  p.append("cancel_url", `${origin}/#shop`);
  p.append("billing_address_collection", "auto");
  p.append("phone_number_collection[enabled]", "true");
  ["SE", "DK", "FI", "DE", "NL", "BE", "FR", "AT", "IE", "ES", "IT", "PL", "PT", "EE", "LV", "LT"]
    .forEach(c => p.append("shipping_address_collection[allowed_countries][]", c));

  const shipping = [
    subtotal >= FREE_SHIPPING_FROM
      ? ["Sweden · PostNord · free over 800 kr", 0, 1, 3]
      : ["Sweden · PostNord", 59, 1, 3],
    ["Rest of EU · PostNord", 99, 3, 6],
  ];
  shipping.forEach(([name, kr, min, max], i) => {
    const k = `shipping_options[${i}][shipping_rate_data]`;
    p.append(`${k}[type]`, "fixed_amount");
    p.append(`${k}[display_name]`, name);
    p.append(`${k}[fixed_amount][amount]`, String(kr * 100));
    p.append(`${k}[fixed_amount][currency]`, "sek");
    p.append(`${k}[tax_behavior]`, "inclusive");
    p.append(`${k}[delivery_estimate][minimum][unit]`, "business_day");
    p.append(`${k}[delivery_estimate][minimum][value]`, String(min));
    p.append(`${k}[delivery_estimate][maximum][unit]`, "business_day");
    p.append(`${k}[delivery_estimate][maximum][value]`, String(max));
  });
  return p;
}

export async function handleCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Checkout isn't set up yet" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  let params;
  try { params = buildSessionParams(body.items, new URL(request.url).origin); }
  catch (e) { return json({ error: e.message }, 400); }

  const res = await fetch(`${env.STRIPE_API_BASE || "https://api.stripe.com"}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Stripe error", data?.error?.message);
    return json({ error: "Checkout couldn't start" }, 502);
  }
  return json({ url: data.url });
}
