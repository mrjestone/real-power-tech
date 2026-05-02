"use client";

import useSWR from "swr";
import { useState, useEffect, Suspense } from "react";
import AlertModal from "@/components/admin/AlertModal";
import { useSearchParams } from "next/navigation";

const fetcher = (url) =>
  fetch(url).then((r) => (r.ok ? r.json() : Promise.reject()));

// THE FIX: We pass the mac and router as props now.
function PortalContent({ mac, router }) {
  const { data, error, isLoading } = useSWR("/api/v1/portal/packages", fetcher);
  const packages = data || [];
  const [loading, setLoading] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertMsg, setAlertMsg] = useState("");
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payPhone, setPayPhone] = useState("");
  const [payProvider, setPayProvider] = useState("AIRTEL");
  const [selectedPkg, setSelectedPkg] = useState(null);
  const [paySubmitting, setPaySubmitting] = useState(false);

  async function startHosted(pkg) {
    try {
      setLoading(true);
      const useApi =
        process.env.NEXT_PUBLIC_PAYMENT_API_ENABLED === "true" ||
        process.env.PAYMENT_API_ENABLED === "true";
      if (useApi) {
        setSelectedPkg(pkg);
        setPayModalOpen(true);
        setLoading(false);
        return;
      }
      const res = await fetch("/api/v1/portal/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: pkg.id,
          // THE FIX: We now use the props, which are guaranteed to be correct.
          customerMacAddress: mac || undefined,
          routerIdentifier: router || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || "Checkout failed");
      }
      const j = await res.json();
      try {
        if (j.orderReference && typeof window !== "undefined") {
          window.sessionStorage.setItem("lastOrderReference", j.orderReference);
        }
      } catch (_) {}
      window.location.href = j.paymentUrl; // redirect to hosted checkout
    } catch (e) {
      setAlertMsg(e.message || "Payment start failed");
      setAlertOpen(true);
      setLoading(false);
    }
  }

  async function submitDirectPayment() {
    try {
      setPaySubmitting(true);
      if (!payPhone) throw new Error("Phone number is required");
      if (!/^255\d{9}$/.test(String(payPhone)))
        throw new Error("Enter E.164 phone e.g., 255712345678");
      const res = await fetch("/api/v1/portal/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packageId: selectedPkg?.id,
          customerMacAddress: mac || undefined,
          routerIdentifier: router || undefined,
          phoneNumber: payPhone,
          provider: payProvider.toUpperCase(),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j.message || "Payment start failed");
      }
      try {
        if (j.orderReference && typeof window !== "undefined") {
          window.sessionStorage.setItem("lastOrderReference", j.orderReference);
          window.location.href = `/portal/success?orderReference=${encodeURIComponent(
            j.orderReference
          )}`;
        }
      } catch (_) {}
      setPayModalOpen(false);
      setSelectedPkg(null);
      setPayPhone("");
      setLoading(false);
    } catch (e) {
      setAlertMsg(e.message || "Payment start failed");
      setAlertOpen(true);
      setLoading(false);
    } finally {
      setPaySubmitting(false);
    }
  }

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 relative">
      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 flex flex-col items-center gap-4 shadow-xl">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
            <div className="text-lg font-semibold">Processing...</div>
            <div className="text-sm text-muted-foreground text-center max-w-xs">
              Please wait
            </div>
          </div>
        </div>
      )}

      <div className="text-2xl font-bold mb-2">REAL POWERTECH LTD</div>
      <p className="text-muted-foreground mb-6 text-center">
        Select a package. You will be redirected to ClickPesa to complete
        payment.
      </p>

      <div className="w-full max-w-md grid gap-3">
        {isLoading ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-24 bg-muted rounded animate-pulse" />
          ))
        ) : error ? (
          <div className="text-red-600 text-center">
            Failed to load packages.
          </div>
        ) : (
          packages.map((p) => (
            <button
              key={p.id}
              className="text-left border rounded-md p-4 bg-card hover:scale-[1.02] transition transform disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={() => startHosted(p)}
              disabled={loading}
            >
              <div className="text-lg font-semibold">{p.name}</div>
              <div className="text-2xl font-bold">
                {p.price.toLocaleString()} Tsh
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {loading ? "Processing..." : "Tap to purchase"}
              </div>
            </button>
          ))
        )}
      </div>

      {payModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md shadow-xl">
            <div className="text-xl font-semibold mb-4">Complete Payment</div>
            <div className="grid gap-3">
              <label className="grid gap-1">
                <span className="text-sm text-muted-foreground">
                  Mobile Money Provider
                </span>
                <select
                  value={payProvider}
                  onChange={(e) => setPayProvider(e.target.value)}
                  className="border rounded px-3 py-2"
                  disabled={paySubmitting}
                >
                  <option value="AIRTEL">Airtel Money</option>
                  <option value="MIX_BY_YASS">Mix by Yass</option>
                  <option value="HALOPESA">Halo Pesa</option>
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-sm text-muted-foreground">
                  Phone Number (E.164 without +)
                </span>
                <input
                  type="tel"
                  value={payPhone}
                  onChange={(e) => setPayPhone(e.target.value)}
                  placeholder="255712345678"
                  className="border rounded px-3 py-2"
                  disabled={paySubmitting}
                />
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                className="px-4 py-2 border rounded"
                onClick={() => {
                  if (paySubmitting) return;
                  setPayModalOpen(false);
                  setSelectedPkg(null);
                }}
                disabled={paySubmitting}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-primary text-white rounded disabled:opacity-60"
                onClick={submitDirectPayment}
                disabled={loading || !selectedPkg || paySubmitting}
              >
                {paySubmitting ? "Sending USSD…" : "Pay"}
              </button>
            </div>
          </div>
        </div>
      )}

      <AlertModal
        open={alertOpen}
        title="Error"
        description={alertMsg}
        variant="danger"
        onClose={() => setAlertOpen(false)}
      />
    </div>
  );
}

// THE FIX: We create a new parent component.
function PortalPageWrapper() {
  const sp = useSearchParams();
  const mac = sp.get("mac");
  const router = sp.get("router") || sp.get("routerIdentifier");

  // Store MAC in localStorage for redundancy (in case ClickPesa redirect loses params)
  useEffect(() => {
    if (mac) {
      try {
        window.localStorage.setItem("customerMacAddress", mac);
        console.log("Stored MAC in localStorage:", mac);
      } catch (e) {
        console.warn("Could not save MAC to localStorage:", e);
      }
    }
  }, [mac]);

  // We pass the mac and router as props into the PortalContent component.
  return <PortalContent mac={mac} router={router} />;
}

export default function PortalPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[70vh] flex flex-col items-center justify-center p-6">
          <div className="text-2xl font-bold mb-2">REAL POWERTECH LTD</div>
          <div className="w-full max-w-md grid gap-3 mt-6">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-24 bg-muted rounded animate-pulse" />
            ))}
          </div>
        </div>
      }
    >
      {/* THE FIX: We render the new wrapper component here. */}
      <PortalPageWrapper />
    </Suspense>
  );
}
