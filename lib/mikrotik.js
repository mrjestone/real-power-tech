import HotspotLocation from "@/models/HotspotLocation";
import { decryptPassword } from "./encryption";
import { RouterOSAPI } from "node-routeros";

/**
 * Format duration for MikroTik uptime limit
 * @param {number} seconds - Duration in seconds
 * @returns {string} - Formatted as "HH:MM:SS"
 */
function formatMikrotikDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(secs).padStart(2, "0")}`;
}

/**
 * Create and connect to MikroTik router using Binary API
 */
async function connectToRouter(location) {
  const { routerApiUrl, routerApiUsername, routerApiPassword } = location;

  if (!routerApiUrl || !routerApiUsername || !routerApiPassword) {
    throw new Error("Router API credentials not configured");
  }

  // Decrypt password
  const password = decryptPassword(routerApiPassword);
  if (!password) {
    throw new Error("Failed to decrypt router password");
  }

  // Extract host and port from URL (e.g., "https://192.168.0.181:8729")
  const url = new URL(routerApiUrl);
  const host = url.hostname;
  const port = parseInt(url.port) || 8729; // Default to 8729 for api-ssl

  console.log(`🔌 Connecting to MikroTik: ${host}:${port}`);

  const api = new RouterOSAPI({
    host,
    user: routerApiUsername,
    password,
    port,
    timeout: 15, // Increased from 10 to 15 seconds for better reliability
    tls: {
      rejectUnauthorized: false, // Accept self-signed certificates
    },
  });

  await api.connect();
  console.log(`✅ Connected to MikroTik router`);

  return api;
}

/**
 * Activate user on MikroTik router
 * @param {Object} params - Activation parameters
 * @param {string} params.locationId - Location MongoDB ID
 * @param {string} params.mac - User MAC address
 * @param {number} params.sessionSeconds - Session duration in seconds
 * @param {string} params.rateLimit - Rate limit (e.g., "512k/512k")
 * @param {string} params.orderReference - Order reference for tracking
 * @returns {Promise<{success: boolean, mikrotikUserId?: string, error?: string}>}
 */
export async function activateHotspotUser({
  locationId,
  mac,
  sessionSeconds,
  rateLimit,
  orderReference,
}) {
  let api;
  try {
    const location = await HotspotLocation.findById(locationId);

    if (!location) {
      throw new Error("Location not found");
    }

    const duration = formatMikrotikDuration(sessionSeconds);

    console.log(`✨ Creating MikroTik user:`, {
      mac,
      duration,
      orderReference,
    });

    api = await connectToRouter(location);

    let userId = "created";

    // Try to create the user directly - simpler and avoids the !empty query issue
    const params = [
      `=name=${mac}`,
      `=password=${mac}`, // CRITICAL: Password must match username for MAC auth
      `=mac-address=${mac}`,
      `=limit-uptime=${duration}`,
      `=profile=default`,
      `=comment=Order: ${orderReference}`,
    ];

    if (rateLimit) {
      params.push(`=limit-bytes-total=${rateLimit}`);
    }

    try {
      // Try to add the user
      const result = await api.write("/ip/hotspot/user/add", params);

      // Extract the MikroTik internal ID from the response
      // Response format: [{ ret: '*6' }] where '*6' is the internal ID
      if (Array.isArray(result) && result.length > 0 && result[0].ret) {
        userId = result[0].ret;
      } else if (typeof result === "string") {
        userId = result;
      }

      console.log(`✅ MikroTik user created successfully:`, userId);
    } catch (addError) {
      // If user already exists, update it in-place to avoid auth race windows.
      if (addError.message && addError.message.includes("already have user")) {
        console.log(`ℹ️ User already exists, updating existing user session...`);

        let allUsers = [];
        try {
          allUsers = await api.write("/ip/hotspot/user/print", [
            `=.proplist=.id,name`,
          ]);
        } catch (e) {
          console.error(`⚠️ Could not list users:`, e.message);
        }

        const existingUser = allUsers.find((u) => u.name === mac);

        if (!existingUser) {
          throw addError;
        }

        await api.write("/ip/hotspot/user/set", [
          `=.id=${existingUser[".id"]}`,
          `=name=${mac}`,
          `=password=${mac}`,
          `=mac-address=${mac}`,
          `=limit-uptime=${duration}`,
          `=profile=default`,
          `=comment=Order: ${orderReference}`,
        ]);

        userId = existingUser[".id"];
        console.log(`✅ Updated existing MikroTik user:`, userId);
      } else {
        // Some other error - rethrow it
        throw addError;
      }
    }

    // Add IP binding to auto-authenticate this MAC address
    // Using type=regular so user shows in active sessions and is properly tracked
    console.log(`🔐 Adding IP binding for auto-authentication: ${mac}`);

    try {
      // CRITICAL FIX: Try to add directly first - avoids !empty query issues
      // If binding exists, handle the error and update instead
      try {
        await api.write("/ip/hotspot/ip-binding/add", [
          `=mac-address=${mac}`,
          `=type=regular`,
          `=to-address=0.0.0.0`,
          `=server=hotspot1`,
          `=comment=Auto-auth: ${orderReference}`,
        ]);
        console.log(`✅ Created new IP binding for auto-authentication`);
      } catch (addBindingError) {
        // If binding already exists, find and update it
        if (
          addBindingError.message &&
          (addBindingError.message.includes("already") ||
            addBindingError.message.includes("such client already exists"))
        ) {
          console.log(`ℹ️ IP binding already exists, updating...`);

          // Get all bindings WITHOUT filtering to avoid !empty
          let allBindings = [];
          try {
            allBindings = await api.write("/ip/hotspot/ip-binding/print", [
              `=.proplist=.id,mac-address`,
            ]);
          } catch (printError) {
            // If print fails, binding might still work - just log and continue
            console.log(
              `⚠️ Could not list bindings after 'already exists' error - continuing anyway`
            );
            throw addBindingError; // Re-throw to outer catch
          }

          // Find our binding in the list
          const existingBinding = allBindings.find(
            (b) => b["mac-address"] === mac
          );

          if (existingBinding) {
            await api.write("/ip/hotspot/ip-binding/set", [
              `=.id=${existingBinding[".id"]}`,
              `=type=regular`,
              `=to-address=0.0.0.0`,
              `=server=hotspot1`,
              `=comment=Auto-auth: ${orderReference}`,
            ]);
            console.log(
              `✅ Updated existing IP binding: ${existingBinding[".id"]}`
            );
          } else {
            console.log(
              `⚠️ Binding exists but couldn't find it - continuing anyway`
            );
          }
        } else {
          // Some other error - re-throw to outer catch
          throw addBindingError;
        }
      }
    } catch (bindingError) {
      console.error(
        `⚠️ IP binding failed (non-critical):`,
        bindingError.message
      );
      console.error(`   Stack:`, bindingError.stack);
      // Don't fail the whole activation if binding fails
      // IP binding is optional - user can still login manually via the portal
    }

    await api.close();

    return {
      success: true,
      mikrotikUserId: userId,
      message: "User activated successfully with auto-authentication",
    };
  } catch (error) {
    console.error("❌ MikroTik activation error:", error);
    if (api) {
      try {
        await api.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Disconnect user from MikroTik router
 * @param {string} locationId - Location MongoDB ID
 * @param {string} mac - User MAC address
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function disconnectHotspotUser(locationId, mac) {
  let api;
  try {
    const location = await HotspotLocation.findById(locationId);

    if (!location) {
      throw new Error("Location not found");
    }

    console.log(`🔌 Disconnecting user from MikroTik:`, mac);

    api = await connectToRouter(location);

    // Find and remove active sessions
    const activeSessions = await api.write("/ip/hotspot/active/print", [
      "=.proplist=.id,mac-address",
    ]);

    if (activeSessions && activeSessions.length > 0) {
      for (const session of activeSessions) {
        if (session["mac-address"] === mac) {
          await api.write("/ip/hotspot/active/remove", [
            `=.id=${session[".id"]}`,
          ]);
          console.log(`✅ Removed active session:`, session[".id"]);
        }
      }
    }

    // Find and remove user entries
    const users = await api.write("/ip/hotspot/user/print", [
      "=.proplist=.id,name",
    ]);

    if (users && users.length > 0) {
      for (const user of users) {
        if (user.name === mac) {
          await api.write("/ip/hotspot/user/remove", [`=.id=${user[".id"]}`]);
          console.log(`✅ Removed user entry:`, user[".id"]);
        }
      }
    }

    await api.close();

    return { success: true };
  } catch (error) {
    console.error("❌ MikroTik disconnect error:", error);
    if (api) {
      try {
        await api.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    return { success: false, error: error.message };
  }
}

/**
 * Check if user is currently active
 * @param {string} locationId - Location MongoDB ID
 * @param {string} mac - User MAC address
 * @returns {Promise<{isActive: boolean, session?: object, error?: string}>}
 */
export async function getActiveSession(locationId, mac) {
  let api;
  try {
    const location = await HotspotLocation.findById(locationId);

    if (!location) {
      throw new Error("Location not found");
    }

    api = await connectToRouter(location);

    const active = await api.write("/ip/hotspot/active/print", [
      "=.proplist=.id,mac-address,uptime,bytes-in,bytes-out",
    ]);

    await api.close();

    if (active && active.length > 0) {
      for (const session of active) {
        if (session["mac-address"] === mac) {
          return {
            isActive: true,
            session,
          };
        }
      }
    }

    return { isActive: false };
  } catch (error) {
    console.error("❌ MikroTik session check error:", error);
    if (api) {
      try {
        await api.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    return { isActive: false, error: error.message };
  }
}
