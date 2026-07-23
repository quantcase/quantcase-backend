[Docs](../README.md) · [Frontend](../README.md#existing-reference-material) · Razorpay Checkout — Next.js Frontend Integration

# Razorpay Checkout — Next.js Frontend Integration

This is the complete reference for wiring the QuantCase subscription checkout into the
Next.js frontend. The backend is already live and does all the sensitive work
(order creation, signature verification, subscription activation). **Your job on the
frontend is: load the checkout script → ask the backend for an order → open Razorpay →
send the result back for verification.**

> **The test/live switch is fully backend-driven.** You never hardcode a Razorpay key.
> The backend runs one key set at a time and tells you which via a `mode` field
> (`"test"` or `"live"`) and the publishable `razorpay_key_id`. When the backend flips
> from the test key to the live key, the whole app follows automatically — no frontend
> deploy needed.

---

## 1. Prerequisites

- **Base URL** of the backend API, e.g. `process.env.NEXT_PUBLIC_API_BASE_URL` → `https://api.quantcase.in` (locally `http://localhost:8000`).
- The logged-in user's **JWT access token**. Every billing call except `GET /config` and `GET /products` requires `Authorization: Bearer <token>`.
- The Razorpay Checkout script, loaded from Razorpay's CDN at runtime (it is **not** bundled — it attaches a global `window.Razorpay`).

---

## 2. Backend endpoints you'll call

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/api/billing/config` | none | Read `{ mode, razorpay_key_id }` — show a test banner, know the environment. |
| `GET`  | `/api/billing/products` | none | List products + their prices (plans). |
| `POST` | `/api/billing/coupons/validate` | Bearer | (optional) Validate a coupon before checkout. |
| `POST` | `/api/billing/subscribe` | Bearer | Create a Razorpay **order**. Returns the order + key + prefill. |
| `POST` | `/api/billing/verify` | Bearer | **Mandatory.** Verify the payment result server-side and activate the subscription. |
| `GET`  | `/api/billing/subscription` | Bearer | Current subscription status/access state. |

All success responses are `{ success: true, data: ... }`. Errors are `{ success: false, error: "..." }` (or `{ error: "..." }` for validation) with an appropriate HTTP status.

### Response shapes

```ts
// GET /api/billing/config
type BillingConfig = { mode: 'test' | 'live'; razorpay_key_id: string };

// GET /api/billing/products
type Price = {
  id: string;                 // e.g. "quantcase-pro-monthly" — pass this as price_id
  plan_type: 'monthly' | 'annual' | 'trial';
  amount: number;             // in PAISE (e.g. 249900 = ₹2,499). Display as amount / 100.
  currency: string;           // "INR"
  interval_months: number;
  razorpay_plan_id: string | null;
};
type Product = {
  id: string;
  name: string;
  description: string;
  is_active: boolean;
  prices: Price[];
};

// POST /api/billing/subscribe  body: { price_id: string; coupon_code?: string }
type SubscribeResponse = {
  razorpay_order_id: string;  // "order_..."
  razorpay_key_id: string;    // publishable key — pass to checkout as `key`
  mode: 'test' | 'live';
  amount: number;             // final amount in paise (after any coupon)
  currency: string;
  subscription_id: string;
  prefill: { name: string; email: string; contact: string };
};

// POST /api/billing/verify  body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
type VerifyResponse = {
  status: string;                    // "active"
  subscription_id: string;
  current_period_end: string | null; // ISO date
};
```

---

## 3. Load the checkout script

Use `next/script` with `afterInteractive`. Drop this once, high in the tree (e.g. in the
layout or the subscribe page). It sets `window.Razorpay`.

```tsx
// Anywhere that renders before the user can click "Subscribe"
import Script from 'next/script';

<Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" />
```

If you prefer to load it lazily and know exactly when it's ready, use this hook instead:

```ts
// hooks/useRazorpayScript.ts
'use client';
import { useEffect, useState } from 'react';

export function useRazorpayScript(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if ((window as any).Razorpay) { setReady(true); return; }

    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]'
    );
    if (existing) {
      existing.addEventListener('load', () => setReady(true));
      return;
    }

    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => setReady(true);
    document.body.appendChild(s);
  }, []);

  return ready;
}
```

---

## 4. Minimal API client

```ts
// lib/billing.ts
const API = process.env.NEXT_PUBLIC_API_BASE_URL!; // e.g. http://localhost:8000

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function getBillingConfig(): Promise<BillingConfig> {
  const r = await fetch(`${API}/api/billing/config`);
  return (await r.json()).data;
}

export async function getProducts(): Promise<Product[]> {
  const r = await fetch(`${API}/api/billing/products`);
  return (await r.json()).data;
}

export async function createSubscribeOrder(
  token: string,
  priceId: string,
  couponCode?: string
): Promise<SubscribeResponse> {
  const r = await fetch(`${API}/api/billing/subscribe`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ price_id: priceId, coupon_code: couponCode }),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || 'Failed to create order');
  return json.data;
}

export async function verifyPayment(
  token: string,
  payload: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
): Promise<VerifyResponse> {
  const r = await fetch(`${API}/api/billing/verify`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || 'Payment verification failed');
  return json.data;
}
```

---

## 5. The full checkout flow — `SubscribeButton`

This component does the whole dance: ensure the script is loaded → create the order →
open Razorpay with the **handler function** → on success POST to `/verify` → show result.

> **Why the handler function (not `callback_url`)?** For standard web integrations
> Razorpay recommends the handler-function flow: the payment result comes back to your
> JS, you verify it via `/verify`, and the webhook confirms it server-side as a backstop.
> `callback_url` is only for WebView/redirect flows. **Do not set `callback_url`.**

```tsx
'use client';

import { useState } from 'react';
import { useRazorpayScript } from '@/hooks/useRazorpayScript';
import { createSubscribeOrder, verifyPayment } from '@/lib/billing';

declare global {
  interface Window { Razorpay: any }
}

type Props = {
  priceId: string;        // e.g. "quantcase-pro-monthly"
  token: string;          // the user's JWT access token
  couponCode?: string;
  onSuccess?: (r: VerifyResponse) => void;
};

export function SubscribeButton({ priceId, token, couponCode, onSuccess }: Props) {
  const scriptReady = useRazorpayScript();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setLoading(true);
    try {
      // 1) Ask the backend to create the order. This returns the key + mode too.
      const order = await createSubscribeOrder(token, priceId, couponCode);

      // 2) Configure Razorpay Checkout with the backend-provided values.
      const options = {
        key: order.razorpay_key_id,          // always from the backend — never hardcoded
        order_id: order.razorpay_order_id,
        amount: order.amount,                // paise
        currency: order.currency,
        name: 'QuantCase',
        description: 'QuantCase Pro subscription',
        prefill: order.prefill,
        theme: { color: '#3399cc' },

        // 3) On success, Razorpay calls this handler with the payment result.
        //    Send it to the backend for verification + activation.
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const result = await verifyPayment(token, response);
            onSuccess?.(result);               // e.g. redirect to /dashboard
          } catch (e: any) {
            // Verification failed on the server — do NOT treat as paid.
            setError(e.message || 'Payment could not be verified. Please contact support.');
          } finally {
            setLoading(false);
          }
        },

        modal: {
          // If the user closes the popup without paying.
          ondismiss: () => setLoading(false),
        },
      };

      const rzp = new window.Razorpay(options);

      // 4) Handle explicit payment failures (wrong OTP, insufficient funds, etc.)
      rzp.on('payment.failed', (resp: any) => {
        setError(resp?.error?.description || 'Payment failed. Please try again.');
        setLoading(false);
      });

      rzp.open();
      // Note: loading stays true until handler / ondismiss / payment.failed fires.
    } catch (e: any) {
      setError(e.message || 'Something went wrong');
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={handleClick} disabled={!scriptReady || loading}>
        {loading ? 'Processing…' : 'Subscribe'}
      </button>
      {error && <p role="alert" style={{ color: 'crimson' }}>{error}</p>}
    </div>
  );
}
```

### Wiring it up (example page)

```tsx
'use client';
import Script from 'next/script';
import { useEffect, useState } from 'react';
import { getBillingConfig, getProducts } from '@/lib/billing';
import { SubscribeButton } from '@/components/SubscribeButton';

export default function PricingPage({ token }: { token: string }) {
  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    getBillingConfig().then(setConfig);
    getProducts().then(setProducts);
  }, []);

  return (
    <>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" />

      {config?.mode === 'test' && (
        <div style={{ background: '#fff3cd', padding: 8, textAlign: 'center' }}>
          ⚠️ Test Mode — no real money is charged. Use the test cards / UPI below.
        </div>
      )}

      {products.map((p) => (
        <div key={p.id}>
          <h3>{p.name}</h3>
          <p>{p.description}</p>
          {p.prices.map((price) => (
            <div key={price.id}>
              {/* amount is in paise → divide by 100 for display */}
              <span>₹{(price.amount / 100).toLocaleString('en-IN')} / {price.plan_type}</span>
              <SubscribeButton
                priceId={price.id}
                token={token}
                onSuccess={() => { window.location.href = '/dashboard'; }}
              />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
```

---

## 6. Testing (when `mode === "test"`)

No real money moves. Use Razorpay's mock instruments in the checkout popup:

**UPI**
- `success@razorpay` → payment succeeds
- `failure@razorpay` → payment fails

**Domestic test cards** (any future expiry, any random CVV)

| Network | Card number |
|---------|-------------|
| Visa | `4111 1111 1111 1111` |
| Mastercard | `5267 3181 8797 5449` |
| RuPay | `6521 5757 4152 0961` |

**Netbanking / Wallet** — pick any bank/wallet, then click **Success** or **Failure** on the mock page.

Expected end-to-end: click Subscribe → checkout opens → pay with `success@razorpay` →
handler fires → `/verify` returns `{ status: "active" }` → your `onSuccess` runs →
`GET /api/billing/subscription` now shows `active`.

---

## 7. Rules & gotchas

- **Never hardcode the Razorpay key.** Always use `razorpay_key_id` from `/config` or the
  `/subscribe` response. This is what makes test↔live a backend-only switch.
- **Always call `/verify`.** Treating the handler callback as "paid" without server
  verification is the #1 cause of fraud. If `/verify` throws, show an error — do **not**
  unlock the product. (The backend also confirms every payment via webhook independently,
  so even if the browser closes mid-verify, the subscription still activates server-side.)
- **Amounts are in paise** (integer). The backend computes the final amount (incl. coupons);
  the frontend only displays `amount / 100`.
- **`price_id`** is the `id` of a `Price` (e.g. `quantcase-pro-monthly`), not the product id.
- The checkout script must be loaded before `new window.Razorpay(...)`. The `SubscribeButton`
  guards this with `useRazorpayScript()`.
- Going live is a backend change only: the backend swaps its `RAZORPAY_KEY_ID` to the
  `rzp_live_…` key + live secret, and `/config` starts returning `mode: "live"`. The
  frontend needs no changes.
