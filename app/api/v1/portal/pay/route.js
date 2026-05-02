import { dbConnect } from "@/lib/dbConnect";
import { badRequest, json, notFound } from "@/lib/apiResponse";
import ServicePackage from "@/models/ServicePackage";
import Transaction from "@/models/Transaction";
import HotspotLocation from "@/models/HotspotLocation";
import { macRegex } from "@/lib/validators/admin";
import { normalizeMac } from "@/lib/utils";
import { previewUssdPush, initiateUssdPush } from "@/lib/clickpesa";

const SUPPORTED_PROVIDERS = new Set(["AIRTEL", "MIX_BY_YASS", "HALOPESA"]);

function newOrderReference() {
  const ts = Date.now().toString();
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RPT${ts}${rnd}`; // strictly alphanumeric
}

export async function POST(req) {
  if (process.env.PAYMENT_API_ENABLED !== "true") {
    return badRequest(
      "Direct Payment API is disabled. Enable PAYMENT_API_ENABLED=true to use this endpoint."
    );
  }

  await dbConnect();
  const body = await req.json().catch(() => ({}));
  const {
    packageId,
    locationId,
    customerMacAddress,
    routerIdentifier,
    phoneNumber,
    provider, // "AIRTEL" | "MIX_BY_YASS" | "HALOPESA"
    fetchSenderDetails = false,
  } = body || {};

  if (!packageId) return badRequest("packageId is required");
  if (!phoneNumber)
    return badRequest("phoneNumber is required (E.164 e.g., 2557XXXXXXXX)");
  if (!provider || !SUPPORTED_PROVIDERS.has(provider)) {
    return badRequest(
      "provider is required and must be one of: AIRTEL, MIX_BY_YASS, HALOPESA"
    );
  }

  // Normalize MACs
  const normalizedCustomerMac = customerMacAddress
    ? normalizeMac(customerMacAddress)
    : null;
  const normalizedRouterMac = routerIdentifier
    ? normalizeMac(routerIdentifier)
    : null;

  // Validate normalized MACs
  if (normalizedCustomerMac && !macRegex.test(normalizedCustomerMac)) {
    return badRequest("Invalid customerMacAddress (MAC) format");
  }
  if (normalizedRouterMac && !macRegex.test(normalizedRouterMac)) {
    return badRequest("Invalid routerIdentifier (MAC) format");
  }

  // Basic phone validation (Tanzania E.164: starts with 2557/2556 etc.)
  if (!/^255\d{9}$/.test(String(phoneNumber))) {
    return badRequest(
      "Invalid phoneNumber format. Use E.164 without '+' e.g., 255712345678"
    );
  }

  const pkg = await ServicePackage.findById(packageId);
  if (!pkg || !pkg.isActive) return badRequest("Invalid or inactive packageId");

  // Resolve location
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
    hotspotLocationId = locationId;
  }

  if (!hotspotLocationId) {
    const activeLocations = await HotspotLocation.find({ status: "Active" })
      .select("_id")
      .lean();

    if (activeLocations.length === 1) {
      hotspotLocationId = activeLocations[0]._id;
      console.warn("[Pay API] Falling back to the only active hotspot location", {
        normalizedRouterMac,
        normalizedCustomerMac,
      });
    }
  }

  if (!hotspotLocationId) {
    return notFound("Hotspot location not registered");
  }

  const orderReference = newOrderReference();
  const currency = process.env.CLICKPESA_CURRENCY || "TZS";

  console.log('[Pay API] Creating transaction:', {
    orderReference,
    packageId: pkg._id,
    amount: pkg.price,
    currency,
    phoneNumber,
    provider,
  });

  await Transaction.create({
    servicePackageId: pkg._id,
    hotspotLocationId: hotspotLocationId || null,
    customerMacAddress: normalizedCustomerMac || null,
    amount: pkg.price,
    currency,
    orderReference,
    status: "Pending",
    provider,
    phoneNumber,
  });

  // Step 1: Preview USSD-PUSH (validate availability)
  console.log('[Pay API] Step 1: Preview USSD push...');
  try {
    await previewUssdPush({
      amount: String(pkg.price),
      currency,
      orderReference,
      phoneNumber: String(phoneNumber),
      fetchSenderDetails,
    });
    console.log('[Pay API] Preview successful');
  } catch (e) {
    console.error('[Pay API] Preview failed:', e.message);
    return badRequest(`Preview failed: ${e.message}`);
  }

  // Step 2: Initiate USSD-PUSH
  console.log('[Pay API] Step 2: Initiate USSD push...');
  try {
    const initResp = await initiateUssdPush({
      amount: String(pkg.price),
      currency,
      orderReference,
      phoneNumber: String(phoneNumber),
    });

    console.log('[Pay API] Initiate successful:', initResp);

    return json({
      orderReference,
      status: "PENDING",
      message: "USSD push sent. Please complete payment on your phone.",
      provider,
      initResp,
    });
  } catch (e) {
    console.error('[Pay API] Initiate failed:', e.message);
    return badRequest(`Initiate failed: ${e.message}`);
  }
}
