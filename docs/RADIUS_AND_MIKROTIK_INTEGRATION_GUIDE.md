# RADIUS Server & MikroTik Router Integration Guide

## Document Purpose

This comprehensive guide provides all the necessary information about the **Real Power Tech WiFi Monetization Platform** application to enable seamless integration with:

1. **FreeRADIUS Server** (Vultr Droplet at 139.84.241.180)
2. **MikroTik hAP ax² Router** (at customer location)

This document is intended for engineers/systems working on the RADIUS and router configuration to ensure everything works together seamlessly with the Next.js application.

---

## 🌐 Application Overview

### Deployed Application

- **Production URL:** `https://rpt-phi.vercel.app`
- **Platform:** Next.js 15 on Vercel (serverless)
- **Database:** MongoDB Atlas (fully configured and operational)
- **Payment Gateway:** ClickPesa (tested and working)

### Application Status

✅ **COMPLETE & TESTED:**

- Admin authentication and dashboard
- Partner management
- Location (router) management
- Service package management
- Customer captive portal (`/portal`)
- Payment flow via ClickPesa Hosted Checkout
- Payment webhook processing
- Success page with polling
- Transaction status tracking

🔄 **READY FOR INTEGRATION:**

- RADIUS authorization endpoint (fully implemented)
- Session management via MongoDB

⏳ **PENDING EXTERNAL CONFIGURATION:**

- FreeRADIUS server setup on Vultr
- MikroTik router configuration

---

## 📊 System Architecture

```
┌─────────────────┐
│   Customer      │
│   Device        │
└────────┬────────┘
         │ (1) Connects to WiFi
         ↓
┌─────────────────────────────────┐
│  MikroTik hAP ax² Router        │
│  (Customer Location)            │
│  - Captures connection          │
│  - Redirects to Portal          │
│  - Checks RADIUS for auth       │
└────────┬────────────────┬───────┘
         │                │
         │ (2) Redirect   │ (5) Auth Request
         │                │
         ↓                ↓
┌─────────────────┐  ┌──────────────────────┐
│  Next.js App    │  │  FreeRADIUS Server   │
│  (Vercel)       │  │  (Vultr Droplet)     │
│  rpt-phi.       │  │  139.84.241.180      │
│  vercel.app     │  │                      │
└────────┬────────┘  └──────────┬───────────┘
         │                      │
         │ (3) Payment Flow     │ (6) REST API Call
         │                      │
         ↓                      ↓
┌─────────────────┐  ┌──────────────────────┐
│   ClickPesa     │  │   MongoDB Atlas      │
│   (Payment)     │  │   (Database)         │
└─────────┬───────┘  └──────────────────────┘
          │
          │ (4) Webhook
          ↓
    [Next.js Webhook Handler]
    [Creates RADIUS Session]
```

---

## 🔑 Critical Application Endpoints

### 1. **RADIUS Authorization Endpoint**

**URL:** `https://rpt-phi.vercel.app/api/v1/radius/authorize`

**Purpose:** FreeRADIUS calls this endpoint to check if a MAC address should be granted internet access.

**Method:** `POST`

**Request Headers:**

```json
{
  "Content-Type": "application/json",
  "x-radius-secret": "YOUR_SECRET_HERE" // Optional, if RADIUS_REST_SECRET is set
}
```

**Request Body:**

```json
{
  "User-Name": "AA:BB:CC:DD:EE:FF"
}
```

**Alternative Field Names Supported:**

- `User-Name` (primary, RADIUS standard)
- `username`
- `UserName`
- `mac`
- `callingStationId`
- `Calling-Station-Id`

**Success Response (200 OK) - Access Granted:**

```json
{
  "reply": [
    {
      "attribute": "Session-Timeout",
      "value": 3600,
      "op": ":="
    },
    {
      "attribute": "Mikrotik-Rate-Limit",
      "value": "1M/5M",
      "op": ":="
    }
  ]
}
```

**Failure Response (200 OK) - Access Denied:**

```json
{
  "reply": [
    {
      "attribute": "Auth-Type",
      "value": "Reject",
      "op": ":="
    }
  ]
}
```

**Endpoint Logic:**

1. Normalizes MAC address to uppercase with colons (AA:BB:CC:DD:EE:FF)
2. Queries MongoDB `radreply` collection
3. Checks for active `Session-Timeout` attribute where `expiresAt > now`
4. Calculates remaining seconds dynamically
5. Returns available reply attributes (Session-Timeout, Mikrotik-Rate-Limit)

**Rate Limiting:** 30 requests per second per IP

---

### 2. **Customer Portal (Captive Portal)**

**URL:** `https://rpt-phi.vercel.app/portal`

**Query Parameters Required:**

- `mac` - Customer device MAC address (sent by MikroTik)
- `router` or `routerIdentifier` - Router MAC address

**Example:**

```
https://rpt-phi.vercel.app/portal?mac=AA:BB:CC:DD:EE:FF
```

**Flow:**

1. Customer connects to WiFi (without entering any password)
2. MikroTik redirects browser to this URL with MAC addresses
3. Portal displays available packages
4. Customer selects package
5. Redirected to ClickPesa for payment
6. After payment, redirected to success page
7. Access automatically granted

---

### 3. **ClickPesa Webhook Endpoint**

**URL:** `https://rpt-phi.vercel.app/api/v1/webhooks/clickpesa`

**Purpose:** Receives payment confirmation from ClickPesa and creates RADIUS session.

**What It Does:**

1. Verifies webhook signature (security)
2. Updates Transaction status to "Completed"
3. **Creates RADIUS session** in MongoDB (if `RADIUS_WRITE_ENABLED=true`)
4. Returns 200 OK acknowledgment

**RADIUS Session Creation:**
When payment completes, two documents are created in MongoDB:

**Collection: `radcheck`**

```javascript
{
  username: "AA:BB:CC:DD:EE:FF",        // Normalized MAC
  attribute: "Auth-Type",
  op: ":=",
  value: "Accept",
  hotspotLocationId: ObjectId("..."),   // Traceability
  expiresAt: ISODate("2025-10-28T..."), // Session end time
  orderReference: "RPT1730..."          // Transaction reference
}
```

**Collection: `radreply`**

```javascript
{
  username: "AA:BB:CC:DD:EE:FF",        // Normalized MAC
  attribute: "Session-Timeout",
  op: ":=",
  value: "3600",                         // Seconds (1 hour)
  hotspotLocationId: ObjectId("..."),
  expiresAt: ISODate("2025-10-28T..."), // TTL for auto-cleanup
  orderReference: "RPT1730..."
}
```

**Optional: Rate Limiting (if configured in package)**

```javascript
{
  username: "AA:BB:CC:DD:EE:FF",
  attribute: "Mikrotik-Rate-Limit",
  op: ":=",
  value: "1M/5M",                        // Upload/Download (Mbps)
  hotspotLocationId: ObjectId("..."),
  expiresAt: ISODate("2025-10-28T..."),
  orderReference: "RPT1730..."
}
```

---

## 🗄️ MongoDB Database Structure

### Connection Details

The RADIUS server will need to connect to the same MongoDB Atlas instance as the application.

**Required Environment Variables:**

```bash
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
MONGODB_DB=real-power-tech  # or your database name
```

### Key Collections

#### 1. `radcheck` Collection

Stores authentication acceptance records.

**Schema:**

```javascript
{
  _id: ObjectId,
  username: String,              // Normalized MAC (AA:BB:CC:DD:EE:FF)
  attribute: String,             // "Auth-Type"
  op: String,                    // ":="
  value: String,                 // "Accept"
  orderReference: String,        // Transaction reference
  hotspotLocationId: ObjectId,   // Location tracking
  expiresAt: Date,               // When session expires
  createdAt: Date,
  updatedAt: Date
}
```

**Indexes:**

- `username` (indexed)
- `attribute` (indexed)
- `orderReference` (indexed)

#### 2. `radreply` Collection

Stores RADIUS reply attributes returned on successful authentication.

**Schema:**

```javascript
{
  _id: ObjectId,
  username: String,              // Normalized MAC (AA:BB:CC:DD:EE:FF)
  attribute: String,             // "Session-Timeout" or "Mikrotik-Rate-Limit"
  op: String,                    // ":="
  value: String,                 // "3600" or "1M/5M"
  orderReference: String,
  hotspotLocationId: ObjectId,
  expiresAt: Date,               // TTL index - document auto-deletes
  createdAt: Date,
  updatedAt: Date
}
```

**Indexes:**

- `username` (indexed)
- `attribute` (indexed)
- `orderReference` (indexed)
- `expiresAt` (TTL index with `expires: 0` - MongoDB auto-deletes expired documents)

#### 3. `hotspotlocations` Collection

Router registration and partner assignment.

**Schema:**

```javascript
{
  _id: ObjectId,
  name: String,                  // "Maria's Cafe Main Street"
  routerModel: String,           // "MikroTik hAP ax²"
  routerIdentifier: String,      // Router MAC (UNIQUE) "11:22:33:44:55:66"
  partnerId: ObjectId,           // Reference to partner
  status: String,                // "Active" or "Inactive"
  createdAt: Date,
  updatedAt: Date
}
```

**Critical:** The `routerIdentifier` field must match the MAC address sent by MikroTik in the portal URL.

#### 4. `servicepackages` Collection

Available WiFi packages.

**Schema:**

```javascript
{
  _id: ObjectId,
  name: String,                  // "1-Hour Access"
  price: Number,                 // 1000 (Tsh)
  durationMinutes: Number,       // 60
  isActive: Boolean,             // true
  rateLimit: String,             // "1M/5M" (optional bandwidth limit)
  createdAt: Date,
  updatedAt: Date
}
```

#### 5. `transactions` Collection

Payment and session records.

**Schema:**

```javascript
{
  _id: ObjectId,
  customerMacAddress: String,    // Customer device MAC
  hotspotLocationId: ObjectId,   // Which router/location
  servicePackageId: ObjectId,    // Which package purchased
  amount: Number,                // Price paid
  currency: String,              // "TZS"
  status: String,                // "Pending", "Completed", "Failed"
  orderReference: String,        // Unique transaction ID
  paymentReference: String,      // ClickPesa payment ID
  clickPesaTransactionId: String,
  webhookPayload: Mixed,         // Full webhook data
  createdAt: Date,
  updatedAt: Date
}
```

---

## 🔧 FreeRADIUS Configuration on Vultr

### Server Information

- **IP Address:** 139.84.241.180
- **OS:** Ubuntu 22.04 LTS
- **User:** jestone
- **Access:** `ssh jestone@139.84.241.180`

### Firewall Configuration (Already Set)

```bash
# Already configured via ufw:
# - Port 22/tcp (SSH) ✓
# - Port 1812/udp (RADIUS Auth) ✓
# - Port 1813/udp (RADIUS Accounting) ✓
```

### Installation Steps

#### 1. Install FreeRADIUS

```bash
sudo apt update
sudo apt install -y freeradius freeradius-rest
```

#### 2. Configure REST Module

**File:** `/etc/freeradius/3.0/mods-available/rest`

```conf
rest {
    # Connection pooling
    connect_uri = "https://rpt-phi.vercel.app"

    # Authorization endpoint
    authorize {
        uri = "${..connect_uri}/api/v1/radius/authorize"
        method = 'post'
        body = 'json'

        # Request format
        data = '{"User-Name": "%{User-Name}"}'

        # Optional: Add shared secret header
        # header = 'x-radius-secret = YOUR_SECRET_HERE'

        tls = ${..tls}
    }

    # TLS settings for HTTPS
    tls {
        check_cert = yes
        check_cert_cn = no
    }

    # Connection settings
    timeout = 4.0

    # Response handling
    xlat {
        # No special xlat needed, we handle JSON response
    }
}
```

#### 3. Enable REST Module

```bash
sudo ln -sf /etc/freeradius/3.0/mods-available/rest /etc/freeradius/3.0/mods-enabled/
```

#### 4. Configure Authorization Site

**File:** `/etc/freeradius/3.0/sites-available/default`

Edit the `authorize` section:

```conf
authorize {
    # Use REST module for authorization
    rest

    # If REST returns Session-Timeout in reply array, process it
    if (ok) {
        update reply {
            Session-Timeout := "%{reply:Session-Timeout}"
        }

        # If Mikrotik-Rate-Limit exists, add it
        if ("%{reply:Mikrotik-Rate-Limit}") {
            update reply {
                Mikrotik-Rate-Limit := "%{reply:Mikrotik-Rate-Limit}"
            }
        }
    }
}
```

#### 5. Configure RADIUS Clients

**File:** `/etc/freeradius/3.0/clients.conf`

Add MikroTik router(s):

```conf
client mikrotik_main {
    ipaddr = <MIKROTIK_PUBLIC_IP_OR_PRIVATE_IP>
    secret = <STRONG_SHARED_SECRET>
    shortname = mikrotik-main
    nas_type = mikrotik
}

# For testing from local machine
client localhost {
    ipaddr = 127.0.0.1
    secret = testing123
    shortname = localhost
}
```

**Generate strong secret:**

```bash
openssl rand -base64 32
```

#### 6. Configure Accounting (Optional)

**File:** `/etc/freeradius/3.0/sites-available/default`

In `accounting` section:

```conf
accounting {
    # Log to file
    detail

    # Or implement REST accounting endpoint if needed
    # rest
}
```

#### 7. Test Configuration

```bash
sudo freeradius -X
```

Look for:

- REST module loaded successfully
- No configuration errors
- Listening on ports 1812 and 1813

#### 8. Start FreeRADIUS Service

```bash
sudo systemctl restart freeradius
sudo systemctl enable freeradius
sudo systemctl status freeradius
```

#### 9. Test Authentication

From the RADIUS server:

```bash
echo "User-Name = AA:BB:CC:DD:EE:FF" | radclient localhost:1812 auth testing123
```

Expected (if session exists):

```
Access-Accept
    Session-Timeout = 3600
    Mikrotik-Rate-Limit = "1M/5M"
```

Expected (if no session):

```
Access-Reject
```

---

## 🌐 MikroTik Router Configuration

### Router Information

- **Model:** MikroTik hAP ax² (C52iG-5HaxD2HaxD-TC)
- **Status:** Factory reset complete, ready for configuration
- **Access:** WinBox or SSH

### Configuration Steps

#### 1. Basic Hotspot Setup (Already Completed)

Reference: `docs/deviceSetuReport.md` - Initial hotspot setup has been completed with test user.

#### 2. Configure RADIUS

**In WinBox:** IP → Hotspot → Server Profiles → [Your Profile] → RADIUS

**Or via CLI:**

```routeros
/radius
add service=hotspot address=139.84.241.180 secret=<SAME_SECRET_AS_FREERADIUS> timeout=3s

/ip hotspot profile
set [find name=default] use-radius=yes
```

**Critical:** The `secret` must exactly match what's configured in FreeRADIUS `clients.conf`.

#### 3. Configure MAC Authentication (Passwordless)

```routeros
/ip hotspot profile
set [find name=default] login-by=mac,http-chap

/ip hotspot
set [find] addresses-per-mac=2
```

This enables seamless connection without password prompts.

#### 4. Configure Walled Garden (Pre-Auth Access)

Allow access to specific domains before authentication:

```routeros
/ip hotspot walled-garden
add dst-host=rpt-phi.vercel.app comment="Portal Access"
add dst-host=*.vercel.app comment="Vercel CDN"
add dst-host=checkout.clickpesa.com comment="Payment Gateway"
add dst-host=*.clickpesa.com comment="Payment Assets"
```

**Test thoroughly:** Ensure customers can reach portal and payment pages but nothing else.

#### 5. Configure Login Page Redirect

**Default Method:** Modify the hotspot login.html

**File Location on Router:** `/flash/hotspot/login.html`

**Simple Redirect (Recommended):**

```html
<html>
  <head>
    <meta
      http-equiv="refresh"
      content="0; url=https://rpt-phi.vercel.app/portal?mac=$(mac)"
    />
  </head>
  <body>
    <p>Redirecting to portal...</p>
  </body>
</html>
```

**Via CLI (Alternative):**

```routeros
/ip hotspot profile
set [find name=default] html-directory=hotspot
```

Then edit the file via FTP or Files menu in WinBox.

#### 6. Critical Query Parameters

The redirect URL MUST include:

- `mac=$(mac)` - Customer device MAC address
- `router=$(mac)` - Router's own MAC address

**Example URL:**

```
https://rpt-phi.vercel.app/portal?mac=AA:BB:CC:DD:EE:FF&router=11:22:33:44:55:66
```

**Important:** The `router` parameter value must match the `routerIdentifier` field in the `hotspotlocations` collection in MongoDB.

#### 7. Configure Session Timeout Handling

```routeros
/ip hotspot profile
set [find name=default] idle-timeout=none session-timeout=none
```

This ensures the MikroTik honors the `Session-Timeout` attribute from RADIUS instead of using local timeouts.

#### 8. Test Captive Portal Flow

1. Connect a test device to WiFi
2. Browser should auto-redirect to: `https://rpt-phi.vercel.app/portal?mac=...&router=...`
3. Verify you can:
   - See the portal
   - Click a package
   - Reach ClickPesa payment page
   - Cannot access google.com or other sites yet

---

## 🔄 Complete User Journey (Technical Flow)

### Step 1: Connection

- Customer opens WiFi settings
- Connects to "Real Power Tech - Pay & Surf" (open network)
- Device obtains IP via DHCP from MikroTik

### Step 2: Capture & Redirect

- Customer opens browser
- MikroTik Hotspot intercepts HTTP request
- Redirects to: `https://rpt-phi.vercel.app/portal?mac=AA:BB:CC:DD:EE:FF&router=11:22:33:44:55:66`

### Step 3: Portal Display

- Next.js app receives request
- Queries `servicepackages` collection for active packages
- Displays packages to customer

### Step 4: Package Selection

- Customer selects "1-Hour Access"
- Frontend calls: `POST /api/v1/portal/checkout`
- Request body:
  ```json
  {
    "packageId": "671e...",
    "customerMacAddress": "AA:BB:CC:DD:EE:FF",
    "routerIdentifier": "11:22:33:44:55:66"
  }
  ```

### Step 5: Transaction Creation

- Backend:
  1. Validates package exists and is active
  2. Looks up `hotspotlocations` by `routerIdentifier`
  3. Creates `Transaction` document with status "Pending"
  4. Calls ClickPesa API to generate checkout link
  5. Returns: `{ orderReference: "RPT...", paymentUrl: "https://..." }`

### Step 6: Payment Redirect

- Frontend redirects customer to ClickPesa URL
- Customer completes mobile money payment

### Step 7: Payment Webhook

- ClickPesa sends webhook to: `POST /api/v1/webhooks/clickpesa`
- Webhook handler:
  1. Verifies signature (security)
  2. Finds transaction by `orderReference`
  3. Updates status to "Completed"
  4. **Creates RADIUS session** in MongoDB:
     - `radcheck`: Auth-Type = Accept
     - `radreply`: Session-Timeout = 3600
     - `radreply`: Mikrotik-Rate-Limit (if configured)

### Step 8: Success Page

- ClickPesa redirects customer to: `https://rpt-phi.vercel.app/portal/success?orderReference=RPT...`
- Success page polls: `GET /api/v1/portal/transactions/{orderReference}`
- Shows "You are connected!" when status = "Completed"

### Step 9: RADIUS Authorization

- Customer tries to browse internet
- MikroTik sends RADIUS request to 139.84.241.180:1812
- FreeRADIUS calls: `POST https://rpt-phi.vercel.app/api/v1/radius/authorize`
- Request: `{"User-Name": "AA:BB:CC:DD:EE:FF"}`
- Response (if session exists):
  ```json
  {
    "reply": [
      { "attribute": "Session-Timeout", "value": 3600, "op": ":=" },
      { "attribute": "Mikrotik-Rate-Limit", "value": "1M/5M", "op": ":=" }
    ]
  }
  ```
- MikroTik grants internet access for 3600 seconds (1 hour)

### Step 10: Session Expiration

- After 1 hour, MikroTik automatically disconnects customer
- Next access attempt triggers new RADIUS check
- No valid session found → Access Denied
- Customer redirected back to portal to purchase again

---

## 🧪 Testing Checklist

### Application Tests (Already Completed ✓)

- [x] Admin login works
- [x] Can create partners, locations, packages
- [x] Portal displays packages
- [x] Payment flow redirects to ClickPesa
- [x] Webhook updates transaction status
- [x] Success page shows completion

### RADIUS Server Tests

- [ ] FreeRADIUS service starts without errors
- [ ] REST module loads successfully
- [ ] Can reach Next.js endpoint from RADIUS server
- [ ] Test auth request returns correct JSON response
- [ ] RADIUS accepts valid sessions
- [ ] RADIUS rejects invalid/expired sessions

### MikroTik Router Tests

- [ ] Hotspot captures unauthenticated devices
- [ ] Browser redirects to portal with correct MAC parameters
- [ ] Walled garden allows portal and payment domains
- [ ] Walled garden blocks all other domains
- [ ] Router sends RADIUS requests to correct IP
- [ ] Router honors Session-Timeout from RADIUS
- [ ] Session expires after specified duration

### End-to-End Test

1. [ ] Create test package (10 minutes, 500 Tsh)
2. [ ] Register router in admin panel
3. [ ] Connect test device to WiFi
4. [ ] Verify redirect to portal
5. [ ] Select package
6. [ ] Complete payment (sandbox/test)
7. [ ] Verify webhook receives confirmation
8. [ ] Check MongoDB for RADIUS session documents
9. [ ] Verify device can access internet
10. [ ] Wait 10 minutes
11. [ ] Verify device loses access
12. [ ] Verify redirect back to portal

---

## 🔐 Security Considerations

### Application (Already Implemented)

- ✅ NextAuth.js for admin authentication
- ✅ Session-based auth with HTTP-only cookies
- ✅ HTTPS enforced by Vercel
- ✅ Webhook signature verification
- ✅ Rate limiting on critical endpoints
- ✅ Input validation with Zod schemas
- ✅ MongoDB connection string in environment variables

### RADIUS Server (Required)

- [ ] Strong shared secret (32+ random characters)
- [ ] Firewall restricts RADIUS ports to MikroTik IPs only
- [ ] SSH key authentication (password auth disabled)
- [ ] Optional: RADIUS_REST_SECRET for endpoint authentication
- [ ] Regular system updates via `apt update && apt upgrade`

### MikroTik Router (Required)

- [ ] Strong admin password (not default)
- [ ] Disable unnecessary services
- [ ] Firewall rules to block unauthorized access
- [ ] Walled garden strictly limited to required domains
- [ ] RADIUS shared secret matches server exactly

---

## 📋 Environment Variables Reference

### Next.js Application (Vercel)

```bash
# Database
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/
MONGODB_DB=real-power-tech

# Authentication
NEXTAUTH_SECRET=<64-char-random-string>
NEXTAUTH_URL=https://rpt-phi.vercel.app

# ClickPesa
CLICKPESA_CLIENT_ID=<from-clickpesa-dashboard>
CLICKPESA_API_KEY=<from-clickpesa-dashboard>
CLICKPESA_CHECKSUM_KEY=<from-clickpesa-dashboard>
CLICKPESA_BASE_URL=https://api.clickpesa.com/third-parties
CLICKPESA_CURRENCY=TZS

# RADIUS Integration
RADIUS_WRITE_ENABLED=true  # MUST be true for session creation
RADIUS_REST_SECRET=<optional-shared-secret>  # For endpoint authentication
```

### FreeRADIUS Server

```bash
# Not needed - REST module uses direct HTTPS connection
# Connection string in rest module config only
```

---

## 🚨 Troubleshooting Guide

### Problem: Portal doesn't load

**Symptoms:** Customer sees error or blank page after WiFi connection

**Solutions:**

1. Check walled garden includes `rpt-phi.vercel.app`
2. Verify MikroTik can resolve DNS
3. Check redirect URL in login.html is correct
4. Test portal URL manually in browser

### Problem: Payment page doesn't load

**Symptoms:** Customer redirected but sees connection error

**Solutions:**

1. Add all ClickPesa domains to walled garden
2. Check ClickPesa webhook configuration
3. Verify CLICKPESA\_\* environment variables
4. Test checkout endpoint manually

### Problem: Internet access not granted after payment

**Symptoms:** Payment succeeds but no internet

**Solutions:**

1. Check `RADIUS_WRITE_ENABLED=true` in Vercel
2. Verify webhook received (check Transaction status in MongoDB)
3. Check `radreply` collection for Session-Timeout document
4. Test RADIUS endpoint manually:
   ```bash
   curl -X POST https://rpt-phi.vercel.app/api/v1/radius/authorize \
     -H "Content-Type: application/json" \
     -d '{"User-Name": "AA:BB:CC:DD:EE:FF"}'
   ```
5. Check FreeRADIUS logs: `sudo tail -f /var/log/freeradius/radius.log`
6. Verify MikroTik can reach RADIUS server on port 1812

### Problem: Session doesn't expire

**Symptoms:** Customer has internet longer than purchased duration

**Solutions:**

1. Check MikroTik profile: `session-timeout=none` (should honor RADIUS)
2. Verify Session-Timeout attribute in RADIUS response
3. Check MikroTik logs for session management events

### Problem: RADIUS rejects valid sessions

**Symptoms:** Recent payment but access denied

**Solutions:**

1. Check MAC address format consistency
2. Verify `expiresAt` timestamp is in future
3. Check MongoDB connection from RADIUS server
4. Test endpoint authentication (if using RADIUS_REST_SECRET)
5. Review application logs in Vercel dashboard

### Problem: Router not found error

**Symptoms:** Checkout fails with "Hotspot location not registered"

**Solutions:**

1. Verify `routerIdentifier` in portal URL matches database exactly
2. Check MAC address format (should be colon-separated uppercase)
3. Ensure location is registered in admin panel
4. Verify `$(mac)` variable in MikroTik redirect is correct MAC

---

## 📞 Integration Contacts & Resources

### Application URLs

- **Production App:** https://rpt-phi.vercel.app
- **Admin Portal:** https://rpt-phi.vercel.app/admin/dashboard
- **Customer Portal:** https://rpt-phi.vercel.app/portal
- **RADIUS Endpoint:** https://rpt-phi.vercel.app/api/v1/radius/authorize

### Server Information

- **RADIUS Server IP:** 139.84.241.180
- **RADIUS Port:** 1812 (auth), 1813 (accounting)
- **Access:** ssh jestone@139.84.241.180

### Documentation References

- Project Charter: `docs/projectCharter.md`
- API Contract: `docs/apiContract.md`
- System Architecture: `docs/SAD.md`
- Deployment Guide: `DEPLOYMENT.md`
- Go-Live Checklist: `docs/final-go-live-checklist.md`
- Device Setup: `docs/deviceSetuReport.md`

### Database Schema

- All collections documented in Section "MongoDB Database Structure"
- Live database: MongoDB Atlas (same credentials as application)

---

## ✅ Integration Readiness Checklist

### Application Side (Complete)

- [x] RADIUS endpoint implemented and tested
- [x] Session creation in webhook handler
- [x] MongoDB collections properly indexed
- [x] MAC address normalization working
- [x] Dynamic session timeout calculation
- [x] Rate limiting configured
- [x] Environment variables set
- [x] Payment flow tested end-to-end

### RADIUS Server Side (Pending)

- [ ] FreeRADIUS installed on Vultr
- [ ] REST module configured
- [ ] Clients.conf configured with MikroTik
- [ ] Service started and enabled
- [ ] Test authentication successful
- [ ] Firewall rules verified
- [ ] MongoDB connectivity confirmed

### MikroTik Router Side (Partially Complete)

- [x] Basic hotspot setup complete
- [ ] RADIUS server configured
- [ ] Walled garden configured
- [ ] Login page redirect configured
- [ ] MAC authentication enabled
- [ ] Session timeout handling configured
- [ ] End-to-end test successful

---

## 🎯 Next Actions for Integration Team

### Immediate Tasks

1. **Install and configure FreeRADIUS** on 139.84.241.180
2. **Configure REST module** to point to application endpoint
3. **Set up RADIUS clients** with MikroTik router IP and shared secret
4. **Configure MikroTik router** to use RADIUS server
5. **Set up walled garden** on MikroTik
6. **Test end-to-end flow** with small payment

### Verification Steps

1. Test RADIUS endpoint responds correctly
2. Verify webhook creates RADIUS sessions
3. Confirm MikroTik can authenticate against RADIUS
4. Complete full customer journey test
5. Monitor system for 24 hours
6. Document any issues and resolutions

### Go-Live Readiness

Once all tests pass:

1. Deploy router to customer location
2. Configure with production settings
3. Monitor first real customer session
4. Have rollback plan ready
5. Provide support documentation to operator

---

## 📝 Notes for Integration Engineers

### MAC Address Format

The application normalizes all MAC addresses to: `AA:BB:CC:DD:EE:FF` (uppercase, colon-separated)

MikroTik sends MAC in various formats. The normalization handles:

- `AA-BB-CC-DD-EE-FF`
- `aa:bb:cc:dd:ee:ff`
- `AABBCCDDEEFF`
- Any combination

**Ensure consistency** in how MikroTik sends MAC in the portal redirect URL.

### Session Timing

- Package duration → stored in minutes (e.g., 60)
- Converted to seconds → Session-Timeout value (3600)
- Expires at → calculated from payment timestamp + duration
- Remaining time → recalculated on each RADIUS request

### Database Cleanup

MongoDB TTL index automatically deletes expired documents from `radreply` collection.
No manual cleanup needed.

### Development vs Production

Current deployment is production-ready. If you need a staging environment:

1. Deploy separate Next.js instance on Vercel
2. Use separate MongoDB database
3. Configure ClickPesa sandbox credentials
4. Point test router to staging environment

---

**Document Version:** 1.0  
**Last Updated:** October 28, 2025  
**Author:** Jestone  
**Status:** Ready for Integration

---

## 🎉 Final Note

This application is **complete and production-ready** from the software perspective. All that remains is the infrastructure configuration of the RADIUS server and MikroTik router.

The "60-Second Connection" user experience described in the project requirements is fully implemented and ready to go live as soon as the RADIUS and router configuration is complete.

Good luck with the integration! 🚀
