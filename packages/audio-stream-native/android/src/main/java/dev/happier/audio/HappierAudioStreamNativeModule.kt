package dev.happier.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HappierAudioStreamNativeModule : Module() {
  private class Capture(val streamId: String) {
    val stopRequested = AtomicBoolean(false)
    val cleanupGate = Any()
    @Volatile var setupComplete = false
    @Volatile var readerComplete = false
    @Volatile var recorder: AudioRecord? = null
    @Volatile var worker: Thread? = null
    var startAttempted = false
    var stopAttempted = false
    var releaseAttempted = false
    var releaseSucceeded = false
    var cleanupFailure: Throwable? = null
  }

  private val admissionGate = Any()
  private var closed = false
  // Includes an accepted start and incomplete cleanup, not just a published stream.
  private var active: Capture? = null

  private fun requireAdmitted(capture: Capture) {
    synchronized(admissionGate) {
      check(!closed && active === capture && !capture.stopRequested.get() && !capture.readerComplete) {
        "audio_capture_closed"
      }
    }
  }

  private fun cleanupFailure(capture: Capture, operation: String, error: Throwable) {
    val prior = capture.cleanupFailure
    if (prior == null) capture.cleanupFailure = error else if (prior !== error) prior.addSuppressed(error)
    Log.e("HappierAudioStreamNative", "Owned capture $operation failed; cleanup is incomplete", error)
  }

  private fun cleanup(capture: Capture) {
    // Never stop or release an AudioRecord while its external setup call is still using it.
    if (!capture.setupComplete) return
    var retired = false
    synchronized(capture.cleanupGate) {
      val recorder = capture.recorder
      if (recorder != null && capture.startAttempted && !capture.stopAttempted) {
        capture.stopAttempted = true
        try { recorder.stop() } catch (error: Throwable) { cleanupFailure(capture, "stop", error) }
      }
      // stop() unblocks a read; release waits for that reader and any admitted event callback to return.
      if (capture.readerComplete) {
        if (recorder != null && !capture.releaseAttempted) {
          capture.releaseAttempted = true
          try {
            recorder.release()
            capture.releaseSucceeded = true
          } catch (error: Throwable) { cleanupFailure(capture, "release", error) }
        }
        retired = capture.cleanupFailure == null && (recorder == null || capture.releaseSucceeded)
      }
    }
    if (retired) synchronized(admissionGate) { if (active === capture) active = null }
  }

  private fun stopCapture(capture: Capture) {
    capture.stopRequested.set(true)
    cleanup(capture)
    val worker = capture.worker
    var waitFailure: InterruptedException? = null
    try {
      if (capture.setupComplete && worker != null && worker !== Thread.currentThread()) worker.join(400)
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      waitFailure = error
    } finally { cleanup(capture) }
    val complete = synchronized(capture.cleanupGate) {
      capture.setupComplete && capture.readerComplete && capture.cleanupFailure == null &&
        (capture.recorder == null || capture.releaseSucceeded)
    }
    // The existing join budget is not proof of death. Keep the owner until its worker actually finishes.
    if (!complete || waitFailure != null) {
      throw IllegalStateException("audio_capture_cleanup_incomplete", waitFailure ?: capture.cleanupFailure)
    }
  }

  private fun close() {
    val capture = synchronized(admissionGate) {
      closed = true
      active?.also { it.stopRequested.set(true) }
    } ?: return
    try { stopCapture(capture) } catch (error: Throwable) {
      Log.e("HappierAudioStreamNative", "Module closed with owned capture cleanup incomplete", error)
    }
  }

  private fun emit(capture: Capture, name: String, payload: Map<String, Any?>) {
    val admitted = synchronized(admissionGate) {
      !closed && active === capture && !capture.stopRequested.get()
    }
    // A callback admitted before close still belongs to this worker; retirement waits for its return.
    if (admitted) sendEvent(name, payload)
  }

  override fun definition() = ModuleDefinition {
    Name("HappierAudioStreamNative")

    Events("audioFrame", "audioError")

    OnDestroy { close() }

    AsyncFunction("start") { params: Map<String, Any> ->
      val sampleRate = (params["sampleRate"] as? Number)?.toInt() ?: 16000
      val channels = (params["channels"] as? Number)?.toInt() ?: 1
      val frameMs = (params["frameMs"] as? Number)?.toInt() ?: 50

      if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
      if (channels != 1 && channels != 2) throw IllegalArgumentException("channels must be 1 or 2")
      if (frameMs <= 0) throw IllegalArgumentException("frameMs must be > 0")

      val previous = synchronized(admissionGate) {
        check(!closed) { "audio_capture_closed" }
        active?.also { it.stopRequested.set(true) }
      }
      if (previous != null) stopCapture(previous)
      val capture = Capture(UUID.randomUUID().toString())
      synchronized(admissionGate) {
        check(!closed) { "audio_capture_closed" }
        check(active == null) { "audio_capture_cleanup_incomplete" }
        active = capture
      }
      val streamId = capture.streamId
      var workerStarted = false
      var primaryFailure: Throwable? = null
      try {
        requireAdmitted(capture)
        val channelConfig = if (channels == 1) AudioFormat.CHANNEL_IN_MONO else AudioFormat.CHANNEL_IN_STEREO
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelConfig, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuffer == AudioRecord.ERROR || minBuffer == AudioRecord.ERROR_BAD_VALUE) {
          throw IllegalStateException("failed_to_get_min_buffer_size")
        }

        val bytesPerFrame = channels * 2
        val frameBytes = ((sampleRate * frameMs) / 1000) * bytesPerFrame
        val bufferSize = maxOf(minBuffer, frameBytes * 2)

        val audioRecord = AudioRecord(
          MediaRecorder.AudioSource.VOICE_RECOGNITION,
          sampleRate,
          channelConfig,
          AudioFormat.ENCODING_PCM_16BIT,
          bufferSize
        )

        capture.recorder = audioRecord
        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
          throw IllegalStateException("audio_record_not_initialized")
        }

        requireAdmitted(capture)
        capture.startAttempted = true
        audioRecord.startRecording()
        requireAdmitted(capture)

        val readBuffer = ByteArray(bufferSize)
        val accumulator = ByteArrayOutputStream()

        val t = Thread {
          try {
            while (!capture.stopRequested.get()) {
              val read = audioRecord.read(readBuffer, 0, readBuffer.size)
              if (read == 0) continue
              if (read < 0) {
                // ERROR_DEAD_OBJECT / ERROR_INVALID_OPERATION / ERROR_BAD_VALUE never recover on this
                // AudioRecord, so retrying would spin a core forever while the session hears silence.
                if (!capture.stopRequested.get()) {
                  emit(capture,
                    "audioError",
                    mapOf("streamId" to streamId, "code" to "read_failed", "message" to "AudioRecord.read returned $read")
                  )
                }
                break
              }
              accumulator.write(readBuffer, 0, read)

              while (accumulator.size() >= frameBytes && frameBytes > 0) {
                val all = accumulator.toByteArray()
                val chunk = all.copyOfRange(0, frameBytes)
                val rest = if (all.size > frameBytes) all.copyOfRange(frameBytes, all.size) else ByteArray(0)
                accumulator.reset()
                if (rest.isNotEmpty()) accumulator.write(rest)

                val base64 = Base64.encodeToString(chunk, Base64.NO_WRAP)
                emit(capture,
                  "audioFrame",
                  mapOf(
                    "streamId" to streamId,
                    "pcm16leBase64" to base64,
                    "sampleRate" to sampleRate,
                    "channels" to channels
                  )
                )
              }
            }
          } catch (e: Throwable) {
            // Stop can unblock a read; only unexpected failures are reported.
            if (!capture.stopRequested.get()) emit(capture,
              "audioError",
              mapOf("streamId" to streamId, "code" to "capture_failed", "message" to (e.message ?: e.toString()))
            )
          } finally {
            capture.stopRequested.set(true)
            capture.readerComplete = true
            cleanup(capture)
          }
        }
        t.name = "HappierAudioStreamNative"
        t.isDaemon = true
        capture.worker = t
        requireAdmitted(capture)
        t.start()
        workerStarted = true
        requireAdmitted(capture)
        return@AsyncFunction mapOf("streamId" to streamId)
      } catch (error: Throwable) {
        primaryFailure = error
        capture.stopRequested.set(true)
        throw error
      } finally {
        if (!workerStarted) capture.readerComplete = true
        capture.setupComplete = true
        if (capture.stopRequested.get() || capture.readerComplete) cleanup(capture)
        val failure = capture.cleanupFailure
        if (primaryFailure != null && failure != null && primaryFailure !== failure) primaryFailure.addSuppressed(failure)
      }
    }

    AsyncFunction("stop") { params: Map<String, Any> ->
      val streamId = params["streamId"] as? String
      if (streamId == null || streamId.isBlank()) return@AsyncFunction
      val capture = synchronized(admissionGate) {
        active?.takeIf { it.streamId == streamId }?.also { it.stopRequested.set(true) }
      } ?: return@AsyncFunction
      stopCapture(capture)
    }
  }
}
