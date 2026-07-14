import Foundation
import Capacitor
import HealthKit

/// Local Capacitor plugin (registered in BridgeViewController, called from
/// frontend/src/native.ts as "Health"). Write-only HealthKit access: saves a
/// finished pet walk as a Walking workout so Apple's own models credit the
/// HUMAN's calories/activity rings — deliberately chosen over a hand-rolled
/// weight×distance estimate (see TODO.md, 2026-07-12).
///
/// Never rejects for expected situations (no HealthKit, permission denied):
/// resolves { saved: false, reason } instead, so the walk-save flow in the
/// web layer stays quiet. The walk itself is already saved to our API before
/// this is called; HealthKit is a best-effort mirror.
@objc(HealthPlugin)
public class HealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthPlugin"
    public let jsName = "Health"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveWalkWorkout", returnType: CAPPluginReturnPromise)
    ]

    private let store = HKHealthStore()

    @objc func saveWalkWorkout(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["saved": false, "reason": "unavailable"])
            return
        }
        guard let startedAtMs = call.getDouble("startedAtMs"),
              let endedAtMs = call.getDouble("endedAtMs"),
              endedAtMs > startedAtMs else {
            call.reject("startedAtMs/endedAtMs required, end must be after start")
            return
        }
        let distanceMeters = call.getDouble("distanceMeters") ?? 0
        let start = Date(timeIntervalSince1970: startedAtMs / 1000)
        let end = Date(timeIntervalSince1970: endedAtMs / 1000)

        let workoutType = HKObjectType.workoutType()
        let distanceType = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning)!

        // First call shows Apple's Health permission sheet; after that it
        // completes immediately with whatever the user chose.
        store.requestAuthorization(toShare: [workoutType, distanceType], read: nil) { [weak self] _, error in
            guard let self = self else { return }
            if error != nil || self.store.authorizationStatus(for: workoutType) != .sharingAuthorized {
                call.resolve(["saved": false, "reason": "denied"])
                return
            }
            self.writeWorkout(call: call, start: start, end: end, distanceMeters: distanceMeters)
        }
    }

    private func writeWorkout(call: CAPPluginCall, start: Date, end: Date, distanceMeters: Double) {
        let config = HKWorkoutConfiguration()
        config.activityType = .walking
        config.locationType = .outdoor

        let builder = HKWorkoutBuilder(healthStore: store, configuration: config, device: .local())
        let fail = { (why: String) in call.resolve(["saved": false, "reason": why]) }

        builder.beginCollection(withStart: start) { [weak self] ok, _ in
            guard let self = self, ok else { return fail("begin-failed") }

            let finish = {
                builder.endCollection(withEnd: end) { ok, _ in
                    guard ok else { return fail("end-failed") }
                    builder.finishWorkout { workout, _ in
                        call.resolve(["saved": workout != nil])
                    }
                }
            }

            // Distance sample is optional — a treadmill-style zero-distance
            // walk still gets duration credit. Writing it only if authorized
            // avoids an add() error when the user granted workouts but not
            // distance on the permission sheet.
            let distanceType = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning)!
            if distanceMeters > 0, self.store.authorizationStatus(for: distanceType) == .sharingAuthorized {
                let sample = HKQuantitySample(
                    type: distanceType,
                    quantity: HKQuantity(unit: .meter(), doubleValue: distanceMeters),
                    start: start,
                    end: end
                )
                builder.add([sample]) { ok, _ in
                    guard ok else { return fail("add-failed") }
                    finish()
                }
            } else {
                finish()
            }
        }
    }
}
