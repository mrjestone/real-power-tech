#!/usr/bin/env node

/**
 * Test MikroTik API Connection
 * 
 * This script:
 * 1. Connects to MongoDB Atlas
 * 2. Fetches router credentials
 * 3. Tests if it can reach the router API
 * 4. Attempts to create a test hotspot user
 * 
 * Run: node test-mikrotik-api-connection.js
 */

import mongoose from "mongoose";
import { decryptPassword } from "./lib/encryption.js";
import { RouterOSAPI } from "node-routeros";
import crypto from "crypto";

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI || 
  "mongodb+srv://jestone002:CpQaNvoPeYt0rYvV@cluster0.oqfo3zc.mongodb.net/real-power-tech?appName=Cluster0";

const TEST_MAC = process.env.TEST_MAC || "AA:BB:CC:DD:EE:FF";
const TEST_DURATION = process.env.TEST_DURATION || "00:05:00"; // 5 minutes

console.log("🔍 MikroTik API Connection Test\n");
console.log("Configuration:");
console.log("  MongoDB URI:", MONGODB_URI.substring(0, 50) + "...");
console.log("  Test MAC:", TEST_MAC);
console.log("  Test Duration:", TEST_DURATION);
console.log("");

// Import models
let HotspotLocation;

async function connectMongoDB() {
  console.log("📡 Connecting to MongoDB Atlas...");
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ MongoDB connected\n");

    // Define schema inline
    const HotspotLocationSchema = new mongoose.Schema({
      name: String,
      routerModel: String,
      routerIdentifier: { type: String, unique: true, required: true },
      partnerId: String,
      status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
      routerApiUrl: String,
      routerApiUsername: String,
      routerApiPassword: String,
      activationMethod: String,
    });

    HotspotLocation = mongoose.models.HotspotLocation || 
      mongoose.model("HotspotLocation", HotspotLocationSchema);

  } catch (error) {
    console.error("❌ MongoDB connection failed:", error.message);
    process.exit(1);
  }
}

async function fetchRouterCredentials() {
  console.log("🔐 Fetching router credentials from MongoDB...");
  try {
    const location = await HotspotLocation.findOne({}).lean();

    if (!location) {
      console.error("❌ No HotspotLocation found in database");
      process.exit(1);
    }

    console.log("✅ Found router location:", location.name);
    console.log("   Router Identifier:", location.routerIdentifier);
    console.log("   API URL:", location.routerApiUrl);
    console.log("   API Username:", location.routerApiUsername);
    console.log("");

    return location;
  } catch (error) {
    console.error("❌ Failed to fetch credentials:", error.message);
    process.exit(1);
  }
}

async function testRouterConnection(location) {
  console.log("🔌 Testing connection to router API...");

  try {
    // Parse the API URL
    const url = new URL(location.routerApiUrl);
    const host = url.hostname;
    const port = parseInt(url.port) || 8729;

    console.log("   Host:", host);
    console.log("   Port:", port);

    // Decrypt password
    console.log("   Decrypting password...");
    const password = decryptPassword(location.routerApiPassword);

    if (!password) {
      console.error("❌ Failed to decrypt router password");
      process.exit(1);
    }

    console.log("   ✓ Password decrypted");
    console.log("");

    // Connect to router
    console.log("🔗 Connecting to RouterOS API...");
    const api = new RouterOSAPI({
      host,
      user: location.routerApiUsername,
      password,
      port,
      timeout: 15,
      tls: {
        rejectUnauthorized: false,
      },
    });

    await api.connect();
    console.log("✅ Connected to RouterOS API\n");

    return { api, host, port };
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
    console.error("   This could mean:");
    console.error("   - Router API is not reachable at", location.routerApiUrl);
    console.error("   - Credentials are incorrect");
    console.error("   - API-SSL service is disabled on router");
    process.exit(1);
  }
}

async function createTestUser(api, testMac, testDuration) {
  console.log("👤 Attempting to create test hotspot user...");
  console.log("   MAC:", testMac);
  console.log("   Duration:", testDuration);
  console.log("");

  try {
    // Try to delete existing user first
    console.log("   Checking for existing user...");
    let allUsers = [];
    try {
      allUsers = await api.write("/ip/hotspot/user/print", [
        `=.proplist=.id,name`,
      ]);
    } catch (e) {
      console.log("   (Could not list users - continuing)");
    }

    const existingUser = allUsers.find((u) => u.name === testMac);
    if (existingUser) {
      console.log("   Found existing user, deleting...");
      await api.write("/ip/hotspot/user/remove", [
        `=.id=${existingUser[".id"]}`,
      ]);
      console.log("   ✓ Old user deleted");
    }

    // Create new user
    console.log("   Creating new user...");
    const result = await api.write("/ip/hotspot/user/add", [
      `=name=${testMac}`,
      `=password=${testMac}`,
      `=mac-address=${testMac}`,
      `=limit-uptime=${testDuration}`,
      `=profile=default`,
      `=comment=Test user - API connection verification`,
      `=disabled=false`,
    ]);

    let userId = "created";
    if (Array.isArray(result) && result.length > 0 && result[0].ret) {
      userId = result[0].ret;
    }

    console.log("✅ User created successfully!");
    console.log("   User ID:", userId);
    console.log("");

    return { success: true, userId };
  } catch (error) {
    console.error("❌ User creation failed:", error.message);
    console.error("   Stack:", error.stack);
    return { success: false, error: error.message };
  }
}

async function verifyUserCreated(api, testMac) {
  console.log("🔍 Verifying user exists...");
  try {
    const users = await api.write("/ip/hotspot/user/print", [
      `=.proplist=.id,name,profile,limit-uptime`,
    ]);

    const found = users.find((u) => u.name === testMac);
    if (found) {
      console.log("✅ User verified in /ip/hotspot/user:");
      console.log("   ID:", found[".id"]);
      console.log("   Name:", found.name);
      console.log("   Profile:", found.profile);
      console.log("   Limit-Uptime:", found["limit-uptime"]);
      return true;
    } else {
      console.error("❌ User not found after creation!");
      return false;
    }
  } catch (error) {
    console.error("❌ Verification failed:", error.message);
    return false;
  }
}

async function cleanup(api, testMac) {
  console.log("\n🧹 Cleaning up test user...");
  try {
    const users = await api.write("/ip/hotspot/user/print", [
      `=.proplist=.id,name`,
    ]);
    const found = users.find((u) => u.name === testMac);
    if (found) {
      await api.write("/ip/hotspot/user/remove", [`=.id=${found[".id"]}`]);
      console.log("✅ Test user deleted");
    }
    await api.close();
  } catch (error) {
    console.error("⚠️ Cleanup error:", error.message);
  }
}

async function main() {
  try {
    await connectMongoDB();
    const location = await fetchRouterCredentials();
    const { api } = await testRouterConnection(location);

    const result = await createTestUser(api, TEST_MAC, TEST_DURATION);

    if (result.success) {
      await verifyUserCreated(api, TEST_MAC);
    }

    await cleanup(api, TEST_MAC);

    console.log("\n" + "=".repeat(60));
    if (result.success) {
      console.log("🎉 SUCCESS! Router API is working correctly!");
      console.log("   The webhook should be able to create users.");
      console.log("   Ready for production payment testing.");
    } else {
      console.log("❌ FAILURE! There was an issue with user creation.");
      console.log("   Error:", result.error);
      console.log("   Check the error messages above.");
    }
    console.log("=".repeat(60));

    await mongoose.disconnect();
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error("❌ Unexpected error:", error.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

main();
