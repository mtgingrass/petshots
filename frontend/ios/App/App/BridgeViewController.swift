import UIKit
import Capacitor

/// Main.storyboard points here instead of at CAPBridgeViewController so we
/// can register app-local plugins — Capacitor only auto-discovers plugins
/// that ship as packages (the CapApp-SPM list), not classes in the app
/// target itself.
class BridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthPlugin())
        bridge?.registerPluginInstance(BackgroundWalkPlugin())
        bridge?.registerPluginInstance(StoreKitBillingPlugin())
    }
}
