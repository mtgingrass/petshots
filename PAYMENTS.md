# Payments

Petshots has one purchase path: Apple In-App Purchase in the native iOS app,
implemented directly with StoreKit 2. The web app can display plan status, but
it cannot start or manage a purchase. There is no third-party billing service
and no payment credential stored in the app or AWS.

## Plan file

An active App Store subscription is stored independently from the temporary
owner/tester override:

```json
{
  "plan": "paid",
  "billingSource": "apple",
  "billingSources": ["apple"],
  "manualPaid": false,
  "billing": {
    "apple": {
      "active": true,
      "status": "active",
      "productId": "petshots_paid_monthly",
      "transactionId": "...",
      "originalTransactionId": "...",
      "environment": "Sandbox",
      "expiresAt": "2026-08-15T00:00:00.000Z",
      "signedAt": "2026-07-15T00:00:00.000Z",
      "updatedAt": "2026-07-15T00:00:00.000Z"
    }
  }
}
```

`plan` is paid when the Apple transaction is active and unexpired, or when
`manualPaid` is explicitly active. Expiration is checked against the server
clock every time limits are read, so a stale plan file cannot keep paid access.

The owner's QA control stores `testerPlan: "free" | "paid"`. Only
`BILLING_TESTER_SUB` may call `POST /billing/test-plan`; authorization uses the
verified Cognito sub, not the email shown by the client. A real purchase or
restore clears preview mode. S3 conditional writes retry on ETag conflicts and
older Apple notifications cannot overwrite newer signed transaction state.

## Direct StoreKit flow

1. `StoreKitBillingPlugin.swift` asks StoreKit for the two App Store Connect
   products and returns Apple's localized prices.
2. A purchase uses `Product.purchase` with the Cognito sub as StoreKit's
   `appAccountToken`. StoreKit presents Apple's purchase sheet.
3. After local StoreKit verification succeeds, the plugin returns the
   transaction's Apple-signed JWS to the web layer and finishes the transaction.
4. `POST /billing/apple/sync` verifies Apple's certificate chain and JWS with
   Apple's official Node library. It also requires bundle
   `app.petshots.ios`, an allowed product ID, and an `appAccountToken` equal to
   the authenticated Cognito sub before updating `plan.json`.
5. Restore is an explicit button. It calls `AppStore.sync()`, reads
   `Transaction.currentEntitlements`, and sends the current signed transactions
   through the same server verification.
6. Normal app launch also reads `Transaction.currentEntitlements` without
   calling `AppStore.sync()`. This refreshes renewals without UI and does not
   clear the owner's forced tester mode. An empty background result preserves
   unexpired server state; only explicit Restore can clear a missing purchase.
7. App Store Server Notifications V2 may be pointed at
   `https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com/billing/apple-webhook`
   for renewals, refunds, revocations, and expirations. The route verifies
   Apple's signed notification and inner transaction; it has no shared secret.

Product identifiers are `petshots_paid_monthly` and
`petshots_paid_yearly`. Their App Store Connect product metadata, pricing, and
Paid Apps agreement still need to be valid for StoreKit to return them.

Apple's public root certificates are embedded in
`infra/lambda/api/appleRoots.ts`. They are trust anchors, not secrets. No App
Store Connect `.p8` key is required for product loading, purchases, restoring,
transaction verification, or signed server notifications.

## Verification

```bash
cd infra && npm run build && npm test -- --runInBand
cd frontend && npm run build && npm run lint
cd frontend && npx cap sync ios
cd frontend/ios/App && xcodebuild -project App.xcodeproj -scheme App \
  -sdk iphonesimulator -derivedDataPath /tmp/petshots-derived \
  CODE_SIGNING_ALLOWED=NO build
```

Real sandbox purchases require a signed physical-device/TestFlight build and a
sandbox Apple account. If products are empty, check the App Store Connect
subscription state, localization, pricing, Paid Apps agreement, tax, and banking.
