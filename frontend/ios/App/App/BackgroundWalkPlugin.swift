import Foundation
import Capacitor
import CoreLocation

/// Local Capacitor plugin (registered in BridgeViewController, called from
/// frontend/src/native.ts as "BackgroundWalk"). Replaces @capacitor/geolocation
/// for native walk tracking — that plugin has no way to set
/// CLLocationManager.allowsBackgroundLocationUpdates, so iOS stops delivering
/// fixes the moment the app is backgrounded/locked regardless of permission
/// (the bug that prompted this: a real 32-min walk logged 0.05mi because the
/// phone was in a pocket). Web keeps using @capacitor/geolocation unchanged —
/// browsers have no background-location capability at all.
///
/// Scope is deliberately "survive backgrounding/locking", not "survive a
/// force-quit" (Mark, 2026-07-15) — no persisted state, no relaunch-on-
/// location-event handling. If the app is actually killed mid-walk, the walk
/// is lost, same as before.
@objc(BackgroundWalkPlugin)
public class BackgroundWalkPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "BackgroundWalkPlugin"
    public let jsName = "BackgroundWalk"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAlways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
    ]

    private lazy var locationManager: CLLocationManager = {
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyBest
        m.activityType = .fitness
        // We start/stop updates explicitly (pause/resume/end below) — don't
        // let iOS pause them on its own heuristics.
        m.pausesLocationUpdatesAutomatically = false
        return m
    }()

    private var lastLocation: CLLocation?
    private var distanceMeters: Double = 0

    // requestAlways() needs two possible round-trips through the system
    // permission UI (When-In-Use, then the Always upgrade) — both land in
    // the same delegate callback, so track the in-flight call + whether
    // we've already tried the upgrade to know when to finally resolve.
    private var pendingAuthCall: CAPPluginCall?
    private var awaitingAlwaysUpgrade = false

    // Capacitor runs plugin methods on a background queue by default, but
    // CLLocationManager needs an active run loop to reliably start updates
    // and deliver delegate callbacks — in practice, the main thread. Every
    // method below dispatches onto it explicitly (2026-07-15: without this,
    // startUpdatingLocation() silently never delivered a single fix — the
    // bug behind "walk pace and distance did not change").
    @objc func requestAlways(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pendingAuthCall = call
            switch self.locationManager.authorizationStatus {
            case .notDetermined:
                self.awaitingAlwaysUpgrade = false
                self.locationManager.requestWhenInUseAuthorization()
            case .authorizedWhenInUse:
                self.awaitingAlwaysUpgrade = true
                self.locationManager.requestAlwaysAuthorization()
            default:
                self.finishAuthCall()
            }
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard pendingAuthCall != nil else { return }
        let status = manager.authorizationStatus
        if status == .notDetermined { return } // still mid-flow
        if status == .authorizedWhenInUse && !awaitingAlwaysUpgrade {
            // First-time grant just landed — immediately ask for the upgrade
            // rather than making the caller invoke requestAlways() twice.
            awaitingAlwaysUpgrade = true
            manager.requestAlwaysAuthorization()
            return
        }
        finishAuthCall()
    }

    private func finishAuthCall() {
        guard let call = pendingAuthCall else { return }
        pendingAuthCall = nil
        let status: String
        switch locationManager.authorizationStatus {
        case .authorizedAlways: status = "always"
        case .authorizedWhenInUse: status = "whenInUse"
        default: status = "denied"
        }
        call.resolve(["status": status])
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.distanceMeters = 0
            self.lastLocation = nil
            // Only actually enables background delivery when Always was
            // granted — harmless to set otherwise, but explicit is clearer
            // than relying on iOS to silently ignore it.
            self.locationManager.allowsBackgroundLocationUpdates = self.locationManager.authorizationStatus == .authorizedAlways
            self.locationManager.startUpdatingLocation()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.locationManager.stopUpdatingLocation()
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.lastLocation = nil // don't count the distance jumped while paused — mirrors the JS handleResume()
            self.locationManager.startUpdatingLocation()
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.locationManager.stopUpdatingLocation()
            self.locationManager.allowsBackgroundLocationUpdates = false
            call.resolve(["distanceMeters": self.distanceMeters])
            self.distanceMeters = 0
            self.lastLocation = nil
        }
    }

    @objc func snapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["distanceMeters": self.distanceMeters])
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let newest = locations.last else { return }
        if let last = lastLocation {
            // CLLocation.distance(from:) is already great-circle distance.
            // >3m jitter filter MUST MATCH the JS haversineMeters filter in
            // frontend/src/pages/Dashboard.tsx's useWalkTracker (watchPosition
            // callback: `if (d > 3)`) — web and native should agree on what
            // counts as movement vs. GPS noise.
            let d = newest.distance(from: last)
            if d > 3 {
                distanceMeters += d
            }
        }
        lastLocation = newest
    }
}
