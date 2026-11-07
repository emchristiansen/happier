import Foundation
import Dispatch

// Only the named external media surface, not a module/session lifecycle implementation.
// This source is unqualified until a compatible Swift/Foundation/Dispatch and interface route is bound.
public typealias AVAudioFrameCount = UInt32
public typealias AVAudioChannelCount = UInt32
public typealias AVAudioPacketCount = UInt32
public enum AVAudioCommonFormat { case pcmFormatInt16 }
public enum AVAudioConverterInputStatus { case haveData, noDataNow }
public enum AVAudioConverterOutputStatus { case haveData, error }
public struct AudioBuffer {
  public var mDataByteSize: UInt32
  public var mData: UnsafeMutableRawPointer?
}
public struct AudioBufferList { public var mBuffers: AudioBuffer }
public final class AVAudioTime {}

public final class AVAudioFormat {
  public let sampleRate: Double
  public let channelCount: UInt32
  public init?(commonFormat: AVAudioCommonFormat, sampleRate: Double, channels: UInt32, interleaved: Bool) {
    guard sampleRate > 0 && channels > 0 && interleaved else { return nil }
    self.sampleRate = sampleRate; self.channelCount = channels
  }
}
open class AVAudioBuffer {}
public final class AVAudioPCMBuffer: AVAudioBuffer {
  public var frameLength: UInt32 = 0
  private let storage: UnsafeMutableRawPointer
  private let list: UnsafeMutablePointer<AudioBufferList>
  public var audioBufferList: UnsafePointer<AudioBufferList> { UnsafePointer(list) }
  public init?(pcmFormat: AVAudioFormat, frameCapacity: UInt32) {
    guard frameCapacity > 0 else { return nil }
    let size = Int(frameCapacity * pcmFormat.channelCount * 2)
    storage = .allocate(byteCount: size, alignment: 2)
    storage.initializeMemory(as: UInt8.self, repeating: 0, count: size)
    list = .allocate(capacity: 1)
    list.initialize(to: AudioBufferList(mBuffers: AudioBuffer(mDataByteSize: UInt32(size), mData: storage)))
    super.init()
  }
  public func fillFrom(_ other: AVAudioPCMBuffer) {
    let n = min(list.pointee.mBuffers.mDataByteSize, other.audioBufferList.pointee.mBuffers.mDataByteSize)
    storage.copyMemory(from: other.storage, byteCount: Int(n))
    list.pointee.mBuffers.mDataByteSize = n; frameLength = other.frameLength
  }
  deinit { list.deinitialize(count: 1); list.deallocate(); storage.deallocate() }
}

private final class WeakEngine { weak var value: AVAudioEngine?; init(_ value: AVAudioEngine) { self.value = value } }
public enum MediaProbe {
  private static let lock = NSLock()
  private static var sequence = 0
  private static var engines: [WeakEngine] = []
  private static var running: Set<Int> = []
  private static var taps: Set<Int> = []
  private static var stops = 0
  private static var removals = 0
  private static var deactivations = 0
  public static var onStart: (() throws -> Void)?
  public static var onConvert: (() -> Void)?
  fileprivate static func register(_ engine: AVAudioEngine) -> Int {
    lock.lock(); defer { lock.unlock() }; sequence += 1; engines.append(WeakEngine(engine)); return sequence
  }
  fileprivate static func start(_ id: Int) { lock.lock(); running.insert(id); lock.unlock() }
  fileprivate static func stop(_ id: Int) { lock.lock(); running.remove(id); stops += 1; lock.unlock() }
  fileprivate static func install(_ id: Int) { lock.lock(); taps.insert(id); lock.unlock() }
  fileprivate static func remove(_ id: Int) { lock.lock(); taps.remove(id); removals += 1; lock.unlock() }
  fileprivate static func deactivate() { lock.lock(); deactivations += 1; lock.unlock() }
  public static func snapshot() -> [String: Int] {
    lock.lock(); defer { lock.unlock() }
    return ["running": running.count, "taps": taps.count, "stops": stops, "removals": removals, "deactivations": deactivations]
  }
  public static func latestEngine() -> AVAudioEngine? { lock.lock(); defer { lock.unlock() }; return engines.last?.value }
}
public final class AVAudioInputNode {
  fileprivate var id = 0
  private let lock = NSLock()
  private var tap: ((AVAudioPCMBuffer, AVAudioTime) -> Void)?
  public func outputFormat(forBus: Int) -> AVAudioFormat {
    AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
  }
  public func installTap(onBus: Int, bufferSize: UInt32, format: AVAudioFormat?, block: @escaping (AVAudioPCMBuffer, AVAudioTime) -> Void) {
    lock.lock(); precondition(tap == nil); tap = block; lock.unlock(); MediaProbe.install(id)
  }
  public func removeTap(onBus: Int) {
    lock.lock(); precondition(tap != nil); tap = nil; lock.unlock(); MediaProbe.remove(id)
  }
  public func emit() {
    lock.lock(); let callback = tap; lock.unlock()
    let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat(forBus: 0), frameCapacity: 320)!
    buffer.frameLength = 320; callback?(buffer, AVAudioTime())
  }
}
public final class AVAudioEngine {
  public let inputNode = AVAudioInputNode()
  private var id = 0
  public init() { id = MediaProbe.register(self); inputNode.id = id }
  public func start() throws { try MediaProbe.onStart?(); MediaProbe.start(id) }
  public func stop() { MediaProbe.stop(id) }
}
public final class AVAudioConverter {
  public init?(from: AVAudioFormat, to: AVAudioFormat) {}
  public func convert(to: AVAudioBuffer, error: UnsafeMutablePointer<NSError?>?, withInputFrom body: (UInt32, UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer?) -> AVAudioConverterOutputStatus {
    MediaProbe.onConvert?()
    var status = AVAudioConverterInputStatus.noDataNow
    guard let input = body(1, &status) as? AVAudioPCMBuffer, let output = to as? AVAudioPCMBuffer else { return .error }
    output.fillFrom(input); return .haveData
  }
}
public final class AVAudioSession {
  public enum Category { case playAndRecord }
  public enum Mode { case `default` }
  public struct CategoryOptions: OptionSet {
    public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }
    public static let defaultToSpeaker = Self(rawValue: 1)
    public static let allowBluetooth = Self(rawValue: 2)
    public static let allowBluetoothA2DP = Self(rawValue: 4)
  }
  public struct SetActiveOptions: OptionSet {
    public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }
    public static let notifyOthersOnDeactivation = Self(rawValue: 1)
  }
  private static let singleton = AVAudioSession()
  public static func sharedInstance() -> AVAudioSession { singleton }
  public func setCategory(_ category: Category, mode: Mode, options: CategoryOptions) throws {}
  public func setPreferredSampleRate(_ rate: Double) throws { precondition(rate == 16000) }
  public func setActive(_ active: Bool, options: SetActiveOptions) throws { if !active { MediaProbe.deactivate() } }
}
