"use client";

import { useEffect, useMemo, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";

function PortalSuccessContent() {
  const sp = useSearchParams();
  const orderReference = sp.get("orderReference");
  const fallbackDuration = sp.get("duration");

  const [status, setStatus] = useState("Pending");
  const [durationMinutes, setDurationMinutes] = useState(null);
  const [error, setError] = useState("");
  const [loginAttempted, setLoginAttempted] = useState(false);
  const [manualLoginClicked, setManualLoginClicked] = useState(false);
  const [mac, setMac] = useState(null); // MAC from transaction API (most reliable source)
  const [activationStatus, setActivationStatus] = useState("Pending"); // Track activation status
  const [activationError, setActivationError] = useState(null); // Track activation error
  const [retrying, setRetrying] = useState(false); // Track retry state
  const [activationRetryAttempted, setActivationRetryAttempted] = useState(false);

  // Try to get MAC from localStorage as additional fallback
  useEffect(() => {
    try {
      const storedMac = window.localStorage.getItem("customerMacAddress");
      if (storedMac && !mac) {
        console.log("Found MAC in localStorage:", storedMac);
        setMac(storedMac);
      }
    } catch (e) {
      console.warn("Could not access localStorage:", e);
    }
  }, [mac]);

  // Auto-login function - redirects to MikroTik login page which auto-submits
  const triggerHotspotLogin = useCallback(() => {
    if (!mac) {
      console.warn("No MAC address available for login");
      return;
    }

    console.log("Redirecting to MikroTik auto-login page for MAC:", mac);

    // Redirect to MikroTik's login page
    // The custom login.html will redirect to portal (already done)
    // But we need to access the login-auth.html page for auto-submit
    const hotspotIP = "192.168.88.1";
    const authUrl = `http://${hotspotIP}/hotspot/login-auth.html`;

    // Redirect to the auto-submit login page
    window.location.href = authUrl;
  }, [mac]);

  // Handle manual login button click
  const handleManualLogin = () => {
    setManualLoginClicked(true);
    triggerHotspotLogin();
  };

  // Handle retry activation
  const handleRetryActivation = async () => {
    if (!orderReference) return;

    setRetrying(true);
    setError("");

    try {
      const res = await fetch("/api/v1/portal/activate-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderReference }),
      });

      const data = await res.json();

      if (res.ok) {
        setActivationStatus("Retried");
        setActivationError(null);
        console.log("✅ Activation retry successful");
      } else {
        setError(data.message || "Activation failed");
        console.error("❌ Activation retry failed:", data.message);
      }
    } catch (e) {
      setError(e.message || "Failed to retry activation");
      console.error("❌ Activation retry exception:", e);
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    let timer;
    let attempts = 0;

    async function fetchStatus() {
      if (!orderReference) return;
      try {
        const res = await fetch(
          `/api/v1/portal/transactions/${orderReference}`
        );
        if (!res.ok) throw new Error("Unable to verify payment");
        const j = await res.json();
        setStatus(j.status);
        if (j.package?.durationMinutes)
          setDurationMinutes(j.package.durationMinutes);

        // Track activation status from API
        if (j.activationStatus) {
          setActivationStatus(j.activationStatus);
        }
        if (j.activationError) {
          setActivationError(j.activationError);
        }

        const activationReady =
          j.activationStatus === "Activated" || j.activationStatus === "Retried";

        if (
          j.status === "Completed" &&
          !activationReady &&
          mac &&
          !retrying &&
          !activationRetryAttempted
        ) {
          setActivationRetryAttempted(true);
          void handleRetryActivation();
        }

        // Extract MAC address from transaction (MOST RELIABLE SOURCE - from database)
        if (j.customerMacAddress) {
          console.log(
            "MAC address from transaction API:",
            j.customerMacAddress
          );
          setMac(j.customerMacAddress);

          // Also store in localStorage for additional redundancy
          try {
            window.localStorage.setItem(
              "customerMacAddress",
              j.customerMacAddress
            );
          } catch (e) {
            console.warn("Could not save to localStorage:", e);
          }
        }

        // Auto-redirect to login when:
        // 1. Payment is completed
        // 2. User is activated in MikroTik
        // 3. We haven't tried login yet
        // 4. MAC address is available
        if (
          j.status === "Completed" &&
          activationReady &&
          !loginAttempted &&
          mac
        ) {
          setLoginAttempted(true);
          console.log(
            "Payment completed and user activated, redirecting to auto-login in 2 seconds..."
          );
          // Wait 2 seconds to show success message, then redirect
          setTimeout(() => {
            triggerHotspotLogin();
          }, 2000);
        }

        if (j.status === "Completed" || j.status === "Failed") {
          // Continue polling activation status even if payment is complete
          // Stop only when activated or failed
          if (
            j.activationStatus === "Activated" ||
            j.activationStatus === "Failed"
          ) {
            return; // stop polling
          }
        }
      } catch (e) {
        setError((e && e.message) || "Verification failed");
      }
      attempts += 1;
      if (attempts < 30) {
        // Increased from 15 to 30 (60 seconds total)
        timer = setTimeout(fetchStatus, 2000);
      }
    }

    if (orderReference) fetchStatus();
    return () => clearTimeout(timer);
  }, [orderReference, loginAttempted, mac, triggerHotspotLogin]);

  const durationLabel = useMemo(() => {
    const mins =
      durationMinutes ?? (fallbackDuration ? Number(fallbackDuration) : NaN);
    if (!Number.isFinite(mins)) return undefined;
    if (mins >= 1440) return `${Math.round(mins / 1440)} Day(s)`;
    if (mins >= 60) return `${Math.round(mins / 60)} Hour(s)`;
    return `${Math.max(1, Math.round(mins))} Minutes`;
  }, [durationMinutes, fallbackDuration]);

  return (
    <div className="min-h-screen grid place-items-center bg-white p-6">
      <div className="text-center max-w-md">
        <div className="mx-auto w-20 h-20 rounded-full bg-green-100 grid place-items-center mb-4">
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke={status === "Completed" ? "#28A745" : "#6C757D"}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h1 className="text-3xl font-semibold mb-2">
          {status === "Completed" && activationStatus === "Activated"
            ? "You are connected!"
            : status === "Completed" && activationStatus === "Failed"
            ? "Activation failed"
            : status === "Completed"
            ? "Activating your session..."
            : status === "Failed"
            ? "Payment failed"
            : "Finalizing your payment..."}
        </h1>
        {error && <div className="text-red-600 text-sm mb-2">{error}</div>}
        {activationError && activationStatus === "Failed" && (
          <div className="text-red-600 text-sm mb-2 bg-red-50 p-3 rounded-lg border border-red-200">
            ⚠️ {activationError}
          </div>
        )}
        <p className="text-muted-foreground">
          {status === "Completed" && activationStatus === "Activated"
            ? `Your internet access is now active for ${
                durationLabel || "the purchased duration"
              }. You can start browsing!`
            : status === "Completed" && activationStatus === "Failed"
            ? "We couldn't activate your session automatically. Please try again using the button below."
            : status === "Completed"
            ? "Your payment was successful. We're activating your internet access now..."
            : status === "Failed"
            ? "Your payment could not be completed. Please go back and try again."
            : "Please wait while we confirm your payment. This may take a few seconds."}
        </p>

        {/* Retry Activation Button - shown when activation failed */}
        {status === "Completed" && activationStatus === "Failed" && (
          <div className="mt-6">
            <button
              onClick={handleRetryActivation}
              disabled={retrying}
              className="px-6 py-3 bg-orange-600 hover:bg-orange-700 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {retrying ? "Retrying..." : "Retry Activation"}
            </button>
            <p className="text-xs text-muted-foreground mt-2">
              Click to retry activating your internet session
            </p>
          </div>
        )}

        {/* Success indicator - shown when activated */}
        {status === "Completed" && activationStatus === "Activated" && (
          <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-sm text-green-800">
              ✅ Your internet session is active. You can now browse the web!
            </p>
          </div>
        )}

        {/* Manual Connect Button - REMOVED (no longer needed with MikroTik API) */}

        {orderReference && (
          <p className="text-xs text-muted-foreground mt-3">
            Reference: {orderReference}
          </p>
        )}
      </div>
    </div>
  );
}

export default function PortalSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen grid place-items-center bg-white p-6">
          <div className="text-center max-w-md">
            <div className="mx-auto w-20 h-20 rounded-full bg-green-100 grid place-items-center mb-4 animate-pulse" />
            <div className="h-8 bg-muted rounded mb-2 animate-pulse" />
            <div className="h-4 bg-muted rounded animate-pulse" />
          </div>
        </div>
      }
    >
      <PortalSuccessContent />
    </Suspense>
  );
}
