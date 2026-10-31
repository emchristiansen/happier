import ExpoModulesCore

import AVFoundation
import Foundation

private final class AudioStreamSession {
  private let queue: DispatchQueue
  private let emitFrame: (_ event: [String: Any]) -> Void
  private let emitError: (_ event: [String: Any]) -> Void

  let streamId: String
  let sampleRate: Double
  let channels: Int
  let frameBytes: Int

  private var engine: AVAudioEngine?
  private var accumulated = Data()
  private var reportedError = false
  private var stopped = false
  private var tapInstalled = false

  init(
    queue: DispatchQueue,
    emitFrame: @escaping (_ event: [String: Any]) -> Void,
    emitError: @escaping (_ event: [String: Any]) -> Void,
    streamId: String,
    sampleRate: Double,
    channels: Int,
    frameBytes: Int
  ) {
    self.queue = queue
    self.emitFrame = emitFrame
    self.emitError = emitError
    self.streamId = streamId
    self.sampleRate = sampleRate
    self.channels = channels
    self.frameBytes = frameBytes
  }

  func start(frameMs: Int) throws {
    do {
      try startEngine(frameMs: frameMs)
    } catch {
      stop(deactivateAudioSession: false)
      // Leave no active session behind a failed start: it would keep other apps' audio interrupted.
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      throw error
    }
  }

  // AVAudioConverter can emit a few frames more than the exact rate ratio while its resampler drains.
  private static let convertedFrameSlack: AVAudioFrameCount = 32

  private func startEngine(frameMs: Int) throws {
    let session = AVAudioSession.sharedInstance()
    // Voice turns alternate listening with spoken replies played by other players while this category is
    // still set, so output must default to the speaker rather than the receiver (earpiece).
    // `.default` mode: `.measurement` lowers loudspeaker output, and `.voiceChat` only adds echo cancellation
    // for audio rendered through this engine's voice-processing unit, which spoken replies are not.
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
    try session.setPreferredSampleRate(sampleRate)
    try session.setActive(true, options: [])

    let engine = AVAudioEngine()
    self.engine = engine
    let input = engine.inputNode

    // An input-node tap must use the hardware format (AVAudioEngine raises an exception otherwise), so
    // capture in that format and convert to the requested PCM16 rate and channel count.
    let hardwareFormat = input.outputFormat(forBus: 0)
    guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
      throw NSError(domain: "HappierAudioStreamNative", code: 101, userInfo: [NSLocalizedDescriptionKey: "no_audio_input"])
    }
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: AVAudioChannelCount(channels),
        interleaved: true
      ),
      let converter = AVAudioConverter(from: hardwareFormat, to: format)
    else {
      throw NSError(domain: "HappierAudioStreamNative", code: 100, userInfo: [NSLocalizedDescriptionKey: "invalid_audio_format"])
    }

    let framesPerBuffer = max(256, Int(hardwareFormat.sampleRate * Double(frameMs) / 1000.0))
    let rateRatio = sampleRate / hardwareFormat.sampleRate
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(framesPerBuffer), format: hardwareFormat) { [weak self] buffer, _ in
      guard let self else { return }
      let capacity = AVAudioFrameCount((Double(buffer.frameLength) * rateRatio).rounded(.up)) + Self.convertedFrameSlack
      guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }

      // Taps arrive serially, so one converter keeps its resampler state across buffers.
      var supplied = false
      var conversionError: NSError?
      let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
        if supplied {
          inputStatus.pointee = .noDataNow
          return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return buffer
      }
      if status == .error {
        self.emitErrorOnce(code: "conversion_failed", message: conversionError?.localizedDescription ?? "audio conversion failed")
        return
      }

      guard let mData = converted.audioBufferList.pointee.mBuffers.mData else { return }
      let byteSize = Int(converted.audioBufferList.pointee.mBuffers.mDataByteSize)
      if byteSize <= 0 { return }

      let bytes = Data(bytes: mData, count: byteSize)
      self.queue.async {
        guard !self.stopped else { return }
        self.accumulated.append(bytes)

        while self.accumulated.count >= self.frameBytes {
          let chunk = self.accumulated.prefix(self.frameBytes)
          self.accumulated.removeFirst(self.frameBytes)
          self.emitFrame([
            "streamId": self.streamId,
            "pcm16leBase64": Data(chunk).base64EncodedString(),
            "sampleRate": Int(self.sampleRate),
            "channels": self.channels,
          ])
        }
      }
    }

    tapInstalled = true
    try engine.start()
  }

  private func emitErrorOnce(code: String, message: String) {
    queue.async {
      if self.stopped || self.reportedError { return }
      self.reportedError = true
      self.emitError([
        "streamId": self.streamId,
        "code": code,
        "message": message,
      ])
    }
  }

  func stop(deactivateAudioSession: Bool = true) {
    stopped = true
    accumulated.removeAll(keepingCapacity: false)
    guard let engine else { return }
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    engine.stop()
    self.engine = nil

    // Explicit stop keeps its existing shared-session behavior. Module teardown owns only this engine.
    if deactivateAudioSession {
      do {
        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      } catch {
        // Existing explicit-stop compatibility; this is not an exclusive shared-session capability.
      }
    }
  }
}

public final class HappierAudioStreamNativeModule: Module {
  private let queue = DispatchQueue(label: "dev.happier.audioStream", qos: .userInitiated)
  private var active: AudioStreamSession? = nil
  private let queueIdentity = DispatchSpecificKey<Bool>()
  private let admissionLock = NSLock()
  private var closed = false

  private func isOpen() -> Bool {
    admissionLock.lock()
    defer { admissionLock.unlock() }
    return !closed
  }

  private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
    queue.setSpecific(key: queueIdentity, value: true)
    if DispatchQueue.getSpecific(key: queueIdentity) == true { return try body() }
    return try queue.sync(execute: body)
  }

  private func close() {
    admissionLock.lock()
    closed = true
    admissionLock.unlock()
    onQueue {
      active?.stop(deactivateAudioSession: false)
      active = nil
    }
  }

  private func requireOpen() throws {
    guard isOpen() else {
      throw NSError(domain: "HappierAudioStreamNative", code: 4, userInfo: [NSLocalizedDescriptionKey: "audio_capture_closed"])
    }
  }

  public func definition() -> ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events("audioFrame", "audioError")

    OnDestroy { [weak self] in self?.close() }
    OnAppContextDestroys { [weak self] in self?.close() }

    AsyncFunction("start") { (params: [String: Any]) -> [String: String] in
      let sampleRate = (params["sampleRate"] as? Double) ?? 16000
      let channels = (params["channels"] as? Int) ?? 1
      let frameMs = (params["frameMs"] as? Int) ?? 50

      if sampleRate <= 0 { throw NSError(domain: "HappierAudioStreamNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "sampleRate must be > 0"]) }
      if channels != 1 && channels != 2 { throw NSError(domain: "HappierAudioStreamNative", code: 2, userInfo: [NSLocalizedDescriptionKey: "channels must be 1 or 2"]) }
      if frameMs <= 0 { throw NSError(domain: "HappierAudioStreamNative", code: 3, userInfo: [NSLocalizedDescriptionKey: "frameMs must be > 0"]) }

      return try self.onQueue {
        try self.requireOpen()
        self.active?.stop()
        self.active = nil

        let streamId = UUID().uuidString
        let bytesPerFrame = channels * 2
        let frameBytes = Int(sampleRate * Double(frameMs) / 1000.0) * bytesPerFrame

        let session = AudioStreamSession(
          queue: self.queue,
          emitFrame: { [weak self] event in
            guard let self, self.isOpen(), self.active?.streamId == streamId else { return }
            self.sendEvent("audioFrame", event)
          },
          emitError: { [weak self] event in
            guard let self, self.isOpen(), self.active?.streamId == streamId else { return }
            self.sendEvent("audioError", event)
          },
          streamId: streamId,
          sampleRate: sampleRate,
          channels: channels,
          frameBytes: max(1, frameBytes)
        )

        try session.start(frameMs: frameMs)
        do { try self.requireOpen() } catch {
          session.stop(deactivateAudioSession: false)
          throw error
        }
        self.active = session
        return ["streamId": streamId]
      }
    }

    AsyncFunction("stop") { (params: [String: Any]) -> Void in
      let streamId = (params["streamId"] as? String) ?? ""
      if streamId.isEmpty { return }

      self.onQueue {
        guard let current = self.active, current.streamId == streamId else { return }
        current.stop()
        self.active = nil
      }
    }
  }
}
