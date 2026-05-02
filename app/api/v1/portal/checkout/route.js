import { dbConnect } from "@/lib/dbConnect";
import { badRequest, json, notFound } from "@/lib/apiResponse";
import ServicePackage from "@/models/ServicePackage";
import Transaction from "@/models/Transaction";
import { createCheckoutLink } from "@/lib/clickpesa";
import HotspotLocation from "@/models/HotspotLocation";
import { macRegex } from "@/lib/validators/admin";
import { normalizeMac } from "@/lib/utils";

function newOrderReference() {
  const ts = Date.now().toString();
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RPT${ts}${rnd}`; // strictly alphanumeric
}

export async function POST(req) {
  await dbConnect();
  const body = await req.json().catch(() => ({}));
  const {
    packageId,
    locationId,
    customerMacAddress,
    routerIdentifier,
    customerName,
    customerEmail,
    customerPhone,
  } = body || {};
  if (!packageId) return badRequest("packageId is required");

  // Normalize MAC addresses before validation
  const normalizedCustomerMac = customerMacAddress
    ? normalizeMac(customerMacAddress)
    : null;
  const normalizedRouterMac = routerIdentifier
    ? normalizeMac(routerIdentifier)
    : null;

  // Validate normalized MACs if provided
  if (normalizedCustomerMac && !macRegex.test(normalizedCustomerMac)) {
    return badRequest("Invalid customerMacAddress (MAC) format");
  }
  if (normalizedRouterMac && !macRegex.test(normalizedRouterMac)) {
    return badRequest("Invalid routerIdentifier (MAC) format");
  }

  const pkg = await ServicePackage.findById(packageId);
  if (!pkg || !pkg.isActive) return badRequest("Invalid or inactive packageId");

  // Resolve hotspot location by routerIdentifier if provided (use normalized MAC)
  let hotspotLocationId = null;
  const routerLooksLikeCustomerMac =
    normalizedRouterMac &&
    normalizedCustomerMac &&
    normalizedRouterMac === normalizedCustomerMac;

  if (normalizedRouterMac && !routerLooksLikeCustomerMac) {
    const loc = await HotspotLocation.findOne({
      routerIdentifier: normalizedRouterMac,
    }).select("_id");
    if (loc) {
      hotspotLocationId = loc._id;
    }
  }

  if (!hotspotLocationId && locationId) {
    hotspotLocationId = locationId; // fallback path if portal passes locationId
  }

  if (!hotspotLocationId) {
    const activeLocations = await HotspotLocation.find({ status: "Active" })
      .select("_id")
      .lean();

    if (activeLocations.length === 1) {
      hotspotLocationId = activeLocations[0]._id;
      console.warn("[Checkout API] Falling back to the only active hotspot location", {
        normalizedRouterMac,
        normalizedCustomerMac,
      });
    }
  }

  if (!hotspotLocationId) {
    return notFound("Hotspot location not registered");
  }

  const orderReference = newOrderReference();
  await Transaction.create({
    servicePackageId: pkg._id,
    hotspotLocationId: hotspotLocationId || null,
    customerMacAddress: normalizedCustomerMac || null,
    amount: pkg.price,
    currency: process.env.CLICKPESA_CURRENCY || "TZS",
    orderReference,
    status: "Pending",
  });

  const description = `WiFi package: ${pkg.name}`;
  try {
    const { checkoutLink } = await createCheckoutLink({
      totalPrice: String(pkg.price),
      orderReference,
      orderCurrency: process.env.CLICKPESA_CURRENCY || "TZS",
      customerName,
      customerEmail,
      customerPhone,
      description,
    });
    return json({ orderReference, paymentUrl: checkoutLink });
  } catch (e) {
    return badRequest(
      "Hosted Checkout not enabled for this application. Enable Hosted Checkout in ClickPesa Dashboard (Settings → Developers → Hosted Application) or use a Hosted Application's Client ID/API Key."
    );
  }
}
