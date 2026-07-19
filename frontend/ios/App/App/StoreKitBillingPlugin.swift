import Foundation
import Capacitor
import StoreKit

/// Tiny StoreKit 2 bridge used by the web UI. Apple owns the product catalog
/// and purchase sheet; the signed JWS returned here is verified again by our
/// API before paid access is granted.
@objc(StoreKitBillingPlugin)
public class StoreKitBillingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "StoreKitBillingPlugin"
    public let jsName = "StoreKitBilling"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise)
    ]

    private let allowedProductIDs: Set<String> = [
        "petshots_paid_monthly",
        "petshots_paid_yearly"
    ]

    @objc func getProducts(_ call: CAPPluginCall) {
        Task {
            do {
                let products = try await Product.products(for: Array(allowedProductIDs))
                let values: [[String: Any]] = products.map { product in
                    [
                        "identifier": product.id,
                        "displayName": product.displayName,
                        "description": product.description,
                        "displayPrice": product.displayPrice
                    ]
                }
                call.resolve(["products": values])
            } catch {
                call.reject("App Store plans could not be loaded. \(error.localizedDescription)")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productID = call.getString("productId"), allowedProductIDs.contains(productID) else {
            call.reject("Unknown App Store product")
            return
        }
        guard let tokenValue = call.getString("appAccountToken"), let token = UUID(uuidString: tokenValue) else {
            call.reject("A valid account token is required")
            return
        }

        Task {
            do {
                guard let product = try await Product.products(for: [productID]).first else {
                    call.reject("This App Store plan is not available in the current storefront.")
                    return
                }

                switch try await product.purchase(options: [.appAccountToken(token)]) {
                case .success(let verification):
                    switch verification {
                    case .verified(let transaction):
                        let signedTransaction = verification.jwsRepresentation
                        await transaction.finish()
                        call.resolve(["signedTransaction": signedTransaction])
                    case .unverified:
                        call.reject("Apple could not verify this purchase.")
                    }
                case .pending:
                    call.resolve(["pending": true])
                case .userCancelled:
                    call.resolve(["cancelled": true])
                @unknown default:
                    call.reject("The App Store returned an unknown purchase result.")
                }
            } catch {
                call.reject("The purchase could not be completed. \(error.localizedDescription)")
            }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task {
            do {
                // Apple asks apps to call sync only after an explicit user
                // action, which is exactly what the Restore button does.
                try await AppStore.sync()
                call.resolve(["signedTransactions": await collectCurrentEntitlements()])
            } catch {
                call.reject("Purchases could not be restored. \(error.localizedDescription)")
            }
        }
    }

    @objc func currentEntitlements(_ call: CAPPluginCall) {
        Task {
            call.resolve(["signedTransactions": await collectCurrentEntitlements()])
        }
    }

    private func collectCurrentEntitlements() async -> [String] {
        var signedTransactions: [String] = []
        for await verification in Transaction.currentEntitlements {
            if case .verified(let transaction) = verification,
               allowedProductIDs.contains(transaction.productID) {
                signedTransactions.append(verification.jwsRepresentation)
            }
        }
        return signedTransactions
    }
}
