import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import crypto from "crypto";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * Generate checksum for ClickPesa webhook verification
 * Implementation matches ClickPesa official docs exactly
 * @param {string} secret - CLICKPESA_CHECKSUM_KEY
 * @param {object} payload - The payload object to sign
 * @returns {string} - HMAC-SHA256 hex digest
 */
export function clickpesaChecksum(secret, payload) {
  const payloadForChecksum = { ...payload };
  delete payloadForChecksum.checksum;
  delete payloadForChecksum.checksumMethod;

  function canonicalize(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }

    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }

  // Step 1: Canonicalize the payload recursively so nested keys are stable
  const canonicalPayload = canonicalize(payloadForChecksum);

  // Step 2: Serialize to JSON (ClickPesa checksum spec)
  const str = JSON.stringify(canonicalPayload);

  // Step 3: Generate HMAC-SHA256 hash
  const hmac = crypto.createHmac("sha256", secret || "");
  hmac.update(str);

  // Step 4: Return hex digest
  const checksum = hmac.digest("hex");
  
  console.log('[Checksum] Generated:', {
    keys: Object.keys(canonicalPayload),
    concatenated: str.substring(0, 100) + (str.length > 100 ? '...' : ''),
    checksum: checksum.substring(0, 16) + '...',
  });
  
  return checksum;
}

// Normalize MAC to uppercase colon-separated (AA:BB:CC:DD:EE:FF)
export function normalizeMac(mac) {
  if (!mac) return mac;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 12) return mac.toUpperCase();
  return hex.match(/.{1,2}/g).join(":");
}
