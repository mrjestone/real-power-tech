import { dbConnect } from "@/lib/dbConnect";
import Transaction from "@/models/Transaction";
import { clickpesaChecksum } from "@/lib/utils";
import ServicePackage from "@/models/ServicePackage";
import RadiusReply from "@/models/RadiusReply";
import RadiusAuth from "@/models/RadiusAuth";
import HotspotLocation from "@/models/HotspotLocation";
import HotspotSession from "@/models/HotspotSession";
import { normalizeMac } from "@/lib/utils";
import { rateLimit } from "@/lib/rateLimit";
import { grantRadiusAccess } from "@/lib/radiusGrant";

const limit = rateLimit({ windowMs: 10_000, max: 8 }); // 8 events per 10s per key

export async function POST(req) {
  // Parse payload
  const payload = await req.json().catch(() => null);
  if (!payload) {
    console.error("❌ Webhook: Invalid JSON payload");
    return new Response("Invalid JSON", { status: 400 });
  }

  // Log incoming webhook for debugging
  console.log(
    "📥 ClickPesa Webhook received:",
    JSON.stringify(payload, null, 2)
  );

  const event = payload.event || payload.eventType || "";
  const data = payload.data || {};
  const orderReference = data.orderReference || payload.orderReference;

  console.log("📋 Webhook details:", {
    event,
    orderReference,
    status: data.status,
  });

  // Basic rate limiting (per orderRef or IP)
  const ipHeader = req.headers.get("x-forwarded-for") || "";
  const ip =
    ipHeader.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const key = `webhook:${orderReference || ip}`;
  const { limited } = limit(key);
  if (limited) {
    console.warn("⚠️ Webhook rate limited:", key);
    return new Response("Too Many Requests", { status: 429 });
  }

  // Verify checksum if provided (ClickPesa may provide in header or body depending on config)
  const secret = process.env.CLICKPESA_CHECKSUM_KEY || "";
  if (secret) {
    // ClickPesa nests checksum inside `data.checksum` for webhooks
    const provided =
      data?.checksum ||
      payload.checksum ||
      req.headers.get("x-clickpesa-checksum") ||
      "";

    // Build the object to sign from payload.data, excluding checksum
    const { checksum: _ignored, ...toSign } = data || {};

    // clickpesaChecksum() already handles String() conversion per ClickPesa docs
    const computed = clickpesaChecksum(secret, toSign);

    console.log("🔐 Checksum verification:", {
      provided: provided ? provided.substring(0, 16) + "..." : "",
      computed: computed.substring(0, 16) + "...",
      match: provided && provided === computed,
      signKeys: Object.keys(toSign).sort(),
    });

    if (!provided || provided !== computed) {
      console.error("❌ CHECKSUM MISMATCH - Webhook rejected");
      console.error("   Provided:", provided);
      console.error("   Computed:", computed);
      return new Response("Invalid checksum", { status: 401 });
    }

    console.log("✅ Checksum verified");
  }

  if (!orderReference) {
    console.error("❌ Webhook: Missing orderReference");
    return new Response("Missing orderReference", { status: 400 });
  }

  await dbConnect();
  console.log("🔍 Looking up transaction:", orderReference);

  const tx = await Transaction.findOne({ orderReference });
  if (!tx) {
    console.warn("⚠️ Transaction not found:", orderReference);
    return new Response("ok", { status: 200 }); // no-op
  }

  console.log("📦 Transaction found:", {
    id: tx._id,
    currentStatus: tx.status,
    amount: tx.amount,
    packageId: tx.servicePackageId,
  });

  // Idempotency: if already finalized, acknowledge
  const incomingSuccess =
    event.includes("PAYMENT RECEIVED") ||
    data.status === "SUCCESS" ||
    data.status === "SETTLED";
  const incomingFailed =
    event.includes("PAYMENT FAILED") || data.status === "FAILED";

  if (
    (tx.status === "Completed" && incomingSuccess) ||
    (tx.status === "Failed" && incomingFailed)
  ) {
    console.log("✅ Transaction already finalized - idempotent ACK");
    return new Response("ok", { status: 200 });
  }

  let transitionedToCompleted = false;

  if (incomingSuccess) {
    if (tx.status !== "Completed") transitionedToCompleted = true;
    tx.status = "Completed";
    tx.paymentReference =
      data.paymentReference || data.id || tx.paymentReference;
    tx.clickPesaTransactionId =
      data.paymentId || data.id || tx.clickPesaTransactionId;

    console.log("💰 Payment successful - updating transaction to Completed");

    // Radius-based activation (matches the router's live configuration)
    if (transitionedToCompleted) {
      console.log("🚀 Granting user access via RADIUS session write");
      try {
        const pkg = await ServicePackage.findById(tx.servicePackageId).lean();
        const location = await HotspotLocation.findById(
          tx.hotspotLocationId
        ).lean();

        if (!pkg) {
          console.error("❌ ServicePackage not found:", tx.servicePackageId);
          tx.activationStatus = "Failed";
          tx.activationError = "Package not found";
        } else if (!pkg.durationMinutes) {
          console.error("❌ Package missing durationMinutes:", pkg);
          tx.activationStatus = "Failed";
          tx.activationError = "Package missing duration";
        } else if (!tx.customerMacAddress) {
          console.error("❌ Transaction missing customerMacAddress");
          tx.activationStatus = "Failed";
          tx.activationError = "MAC address missing";
        } else if (!location) {
          console.error("❌ Hotspot location not found:", tx.hotspotLocationId);
          tx.activationStatus = "Failed";
          tx.activationError = "Location not found";
        } else {
          const sessionSeconds = Math.max(1, Number(pkg.durationMinutes) * 60);
          const username = normalizeMac(tx.customerMacAddress);
          const expiresAt = new Date(Date.now() + sessionSeconds * 1000);

          console.log("📝 Creating RADIUS session grant:", {
            username,
            sessionSeconds,
            packageName: pkg.name,
            expiresAt: expiresAt.toISOString(),
          });

          await grantRadiusAccess({
            username,
            hotspotLocationId: tx.hotspotLocationId,
            orderReference: tx.orderReference,
            sessionSeconds,
            rateLimit: pkg.rateLimit || null,
          });

          tx.activationStatus = "Activated";
          tx.activationMethod = "radius";
          tx.activatedAt = new Date();
          tx.activationError = null;

          await HotspotSession.create({
            username,
            transactionId: tx._id,
            hotspotLocationId: tx.hotspotLocationId,
            startedAt: new Date(),
            expiresAt,
            activationMethod: "radius",
            status: "Active",
          });
          console.log("✅ Session tracking record created for RADIUS flow");

          console.log("🎉 RADIUS access grant completed successfully");
        }
      } catch (e) {
        console.error("❌ RADIUS grant exception:", e.message);
        console.error("   Stack:", e.stack);
        tx.activationStatus = "Failed";
        tx.activationError = e.message;
        // Swallow errors to not break webhook ACK; user can retry via success page
      }
    }

    /* ========================================
     * RADIUS FALLBACK - COMMENTED FOR NOW
     * Uncomment this section for non-MikroTik routers
     * ========================================
    if (
      transitionedToCompleted &&
      process.env.RADIUS_WRITE_ENABLED === "true"
    ) {
      console.log("🔐 RADIUS writes enabled - granting access");
      try {
        const pkg = await ServicePackage.findById(tx.servicePackageId).lean();

        if (!pkg) {
          console.error("❌ ServicePackage not found:", tx.servicePackageId);
        } else if (!pkg.durationMinutes) {
          console.error("❌ Package missing durationMinutes:", pkg);
        } else if (!tx.customerMacAddress) {
          console.error("❌ Transaction missing customerMacAddress");
        } else {
          const sessionSeconds = Math.max(1, Number(pkg.durationMinutes) * 60);
          const username = normalizeMac(tx.customerMacAddress);
          const expiresAt = new Date(Date.now() + sessionSeconds * 1000);

          console.log("📝 Creating RADIUS session:", {
            username,
            sessionSeconds,
            packageName: pkg.name,
            expiresAt: expiresAt.toISOString(),
          });

          // 1) radcheck: ensure Auth-Type := Accept exists for this MAC
          await RadiusAuth.updateOne(
            {
              username,
              attribute: { $in: ["Auth-Type", "Cleartext-Password"] },
            },
            {
              username,
              attribute: "Auth-Type",
              op: ":=",
              value: "Accept",
              hotspotLocationId: tx.hotspotLocationId || null,
              expiresAt,
              orderReference,
            },
            { upsert: true }
          );
          console.log("✅ Created radcheck record (Auth-Type)");

          // 2) radreply: set Session-Timeout
          await RadiusReply.updateOne(
            { orderReference, attribute: "Session-Timeout" },
            {
              username,
              attribute: "Session-Timeout",
              op: ":=",
              value: String(sessionSeconds),
              hotspotLocationId: tx.hotspotLocationId || null,
              expiresAt,
              orderReference,
            },
            { upsert: true }
          );
          console.log("✅ Created radreply record (Session-Timeout)");

          // 3) radreply: optionally set Mikrotik-Rate-Limit if configured in package
          if (pkg.rateLimit) {
            await RadiusReply.updateOne(
              { orderReference, attribute: "Mikrotik-Rate-Limit" },
              {
                username,
                attribute: "Mikrotik-Rate-Limit",
                op: ":=",
                value: pkg.rateLimit,
                hotspotLocationId: tx.hotspotLocationId || null,
                expiresAt,
                orderReference,
              },
              { upsert: true }
            );
            console.log("✅ Created radreply record (Rate-Limit)");
          }

          console.log("🎉 RADIUS grant completed successfully");
        }
      } catch (e) {
        console.error("❌ RADIUS grant failed:", e.message);
        console.error("   Stack:", e.stack);
        // Swallow errors to not break webhook ACK; rely on logs/monitoring later
      }
    } else if (transitionedToCompleted) {
      console.log("⚠️ RADIUS writes disabled (RADIUS_WRITE_ENABLED not true)");
    }
    */
  } else if (incomingFailed) {
    console.log("❌ Payment failed - updating transaction to Failed");
    tx.status = "Failed";
  }

  tx.webhookPayload = payload;
  await tx.save();
  console.log("✅ Transaction saved with status:", tx.status);

  return new Response("ok", { status: 200 });
}
