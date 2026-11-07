import Foundation
import Dispatch
import ExpoModulesCore
import AVFoundation
#if os(Linux)
import Glibc
#else
import Darwin
#endif

private struct Failure: Error { let message: String }
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw Failure(message: message) }
}
private final class Subject {
  let module = HappierAudioStreamNativeModule()
  lazy var definition = module.definition()
  var id: String?
  func start() throws {
    let value = try definition.functions["start"]!(["sampleRate": 16000.0, "channels": 1, "frameMs": 20])
    id = (value as? [String: String])?["streamId"]
    try require(id != nil, "Actual start did not return a stream identity")
  }
  func stop(_ stream: String? = nil) throws {
    _ = try definition.functions["stop"]!(["streamId": stream ?? id ?? ""])
  }
  func destroy() { definition.destroy?() }
  func contextDestroy() { definition.contextDestroy?() }
}
private func empty(_ phase: String) throws {
  let value = MediaProbe.snapshot(); print("ALLOCATION phase=\(phase) \(value)")
  try require(value["running"] == 0 && value["taps"] == 0, "Owned engine/tap remains live: \(value)")
}
private func run(_ name: String) throws {
  switch name {
  case "I01":
    var subject: Subject? = Subject(); try subject!.start()
    weak var observed = subject?.module
    print("BEFORE_DESTROY \(MediaProbe.snapshot())")
    subject!.destroy(); subject!.contextDestroy(); try empty("actual_module_and_context_destroy")
    subject = nil
    try require(observed == nil, "Module retained by an active session callback cycle")
    try require(MediaProbe.snapshot()["deactivations"] == 0, "Teardown deactivated the shared audio session")
  case "I02":
    let subject = Subject(); try subject.start(); let old = MediaProbe.latestEngine()!
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), returned = DispatchSemaphore(value: 0)
    MediaProbe.onConvert = { entered.signal(); _ = release.wait(timeout: .now() + 10) }
    let worker = Thread { old.inputNode.emit(); returned.signal() }; worker.start()
    try require(entered.wait(timeout: .now() + 10) == .success, "Converter did not reach external boundary")
    var frames = 0; BoundaryEvents.emit = { name, _ in if name == "audioFrame" { frames += 1 } }
    try subject.stop(); try subject.start()
    release.signal(); try require(returned.wait(timeout: .now() + 10) == .success, "Tap did not return")
    try subject.stop("stale-id") // A real owner-queue barrier, without a production test hook.
    try require(frames == 0, "Old converted data emitted after stop/replacement")
    subject.destroy(); try empty("replacement_destroy")
  case "I03":
    let subject = Subject()
    MediaProbe.onStart = { subject.destroy() } // Reentrant real teardown from the external start boundary.
    var error: Error?
    do { try subject.start() } catch let failure { error = failure }
    try require(error != nil, "Accepted start published after teardown")
    try empty("reentrant_accepted_start_disposed")
    try require(MediaProbe.snapshot()["deactivations"] == 0, "New teardown deactivated global session")
  case "I04":
    let a = Subject(), b = Subject(); try a.start(); try b.start()
    a.destroy(); a.contextDestroy()
    let state = MediaProbe.snapshot()
    try require(state["running"] == 1 && state["taps"] == 1, "A teardown changed B capture")
    try require(state["deactivations"] == 0, "A teardown deactivated B shared session")
    b.destroy(); try empty("both_owned_instances_destroyed")
  case "I05":
    let subject = Subject(); try subject.start(); let oldID = subject.id!
    try subject.start(); try subject.stop(oldID)
    try require(MediaProbe.snapshot()["running"] == 1, "Stale stop retired replacement")
    try subject.stop(); try empty("explicit_stop")
    try require(MediaProbe.snapshot()["deactivations"] == 2, "Existing replacement/explicit-stop behavior changed")
  default: throw Failure(message: "Unknown finite Swift schedule")
  }
}

@main enum CaptureLifecycleHostTest {
  static func main() {
    let args = CommandLine.arguments
    guard args.count == 3 else { print("SETUP_FAILURE expected schedule and source metadata"); exit(2) }
    print("SETUP_READY schedule=\(args[1]) metadata=\(args[2])")
    do { try run(args[1]); print("SCHEDULE_PASS \(args[1])") }
    catch { print("ASSERTION_FAILURE \(error) FINAL_ALLOCATION \(MediaProbe.snapshot())"); exit(1) }
    print("FINAL_ALLOCATION \(MediaProbe.snapshot())")
  }
}
