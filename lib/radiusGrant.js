import RadiusAuth from "@/models/RadiusAuth";
import RadiusReply from "@/models/RadiusReply";

export async function grantRadiusAccess({
  username,
  hotspotLocationId,
  orderReference,
  sessionSeconds,
  rateLimit,
}) {
  const expiresAt = new Date(Date.now() + sessionSeconds * 1000);

  await RadiusAuth.updateOne(
    { orderReference, attribute: "Auth-Type" },
    {
      username,
      attribute: "Auth-Type",
      op: ":=",
      value: "Accept",
      hotspotLocationId: hotspotLocationId || null,
      expiresAt,
      orderReference,
    },
    { upsert: true }
  );

  await RadiusReply.updateOne(
    { orderReference, attribute: "Session-Timeout" },
    {
      username,
      attribute: "Session-Timeout",
      op: ":=",
      value: String(sessionSeconds),
      hotspotLocationId: hotspotLocationId || null,
      expiresAt,
      orderReference,
    },
    { upsert: true }
  );

  if (rateLimit) {
    await RadiusReply.updateOne(
      { orderReference, attribute: "Mikrotik-Rate-Limit" },
      {
        username,
        attribute: "Mikrotik-Rate-Limit",
        op: ":=",
        value: rateLimit,
        hotspotLocationId: hotspotLocationId || null,
        expiresAt,
        orderReference,
      },
      { upsert: true }
    );
  }

  return { success: true, expiresAt };
}