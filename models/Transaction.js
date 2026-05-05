import mongoose from "mongoose";

const TransactionSchema = new mongoose.Schema(
  {
    customerMacAddress: String,
    hotspotLocationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotspotLocation",
    },
    servicePackageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServicePackage",
    },
    amount: Number,
    currency: { type: String, default: "TZS" },
    status: {
      type: String,
      enum: ["Pending", "Completed", "Failed"],
      default: "Pending",
    },
    clickPesaTransactionId: String,
    // New fields for payment reconciliation
    orderReference: { type: String, index: true },
    paymentReference: String,
    webhookPayload: mongoose.Schema.Types.Mixed,

    // Activation tracking
    activationStatus: {
      type: String,
      enum: ["Pending", "Activating", "Activated", "Failed", "Retried"],
      default: "Pending",
    },
    activationMethod: {
      type: String,
      enum: ["mikrotik-api", "radius", "manual"],
      default: "mikrotik-api",
    },
    activationError: String,
    activatedAt: Date,
    mikrotikUserId: String, // User ID returned by MikroTik (e.g., "*1A")
  },
  { timestamps: true }
);

// Helpful indexes for dashboards and reports
TransactionSchema.index({ status: 1, createdAt: -1 });
TransactionSchema.index({ hotspotLocationId: 1, createdAt: -1 });

export default mongoose.models.Transaction ||
  mongoose.model("Transaction", TransactionSchema);
