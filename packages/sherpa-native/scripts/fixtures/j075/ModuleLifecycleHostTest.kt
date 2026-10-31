package dev.happier.sherpa.fixture

import android.util.Log
import dev.happier.sherpa.HappierSherpaNativeModule
import expo.modules.kotlin.Promise
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicReference

private class Subject {
  val module = HappierSherpaNativeModule()
  val asr = ControlledExecutor()
  val tts = ControlledExecutor()
  init {
    for ((name, replacement) in listOf("asrExecutor" to asr, "ttsExecutor" to tts)) {
      val field = module.javaClass.getDeclaredField(name).apply { isAccessible = true }
      check(ExecutorService::class.java.isAssignableFrom(field.type))
      val original = field.get(module) as ExecutorService
      field.set(module, replacement)
      check(field.get(module) === replacement) { "Executor reflection binding failed" }
      original.shutdown()
      check(original.isTerminated) { "Replaced executor was not unused" }
    }
  }
  val definition = module.definition().also {
    check(it.name == "HappierSherpaNative" && it.destroy != null)
    check(it.functions.keys == setOf("initialize", "listVoices", "synthesizeToWavFile", "cancel", "release",
      "excludeFromBackup", "createStreamingRecognizer", "pushAudioFrame", "finishStreaming"))
  }
  fun call(name: String, job: String = "same-job", extra: Map<String, Any?> = emptyMap()): Promise {
    val promise = Promise()
    definition.functions.getValue(name)(mapOf("jobId" to job, "assetsDir" to "/fixture/model",
      "sampleRate" to 16000, "channels" to 1, "pcm16leBase64" to "AAAAAA==") + extra, promise)
    return promise
  }
  fun create(job: String = "same-job") { val p = call("createStreamingRecognizer", job); asr.drain(); p.succeeded() }
  fun destroy() { definition.destroy!!() }
  fun drain() { tts.drain(); asr.drain() }
  fun state(name: String): Any? = module.javaClass.declaredFields.find { it.name == name }?.let {
    it.isAccessible = true; it.get(module)
  }
}

private fun live(expected: Int, phase: String) {
  val actual = NativeProbe.liveStreams()
  println("ALLOCATION phase=$phase expected=$expected actual=$actual ${NativeProbe.snapshot()}")
  check(actual == expected) { "$phase expected liveStream=$expected actual liveStream=$actual" }
}
private fun retired(subject: Subject) {
  subject.destroy(); subject.drain(); live(0, "after_actual_OnDestroy_and_drain")
}
private fun throwsRejected(block: () -> Unit) {
  var caught: Throwable? = null
  try { block() } catch (error: Throwable) { caught = error }
  check(caught is RejectedExecutionException) { "Expected actual enqueue refusal, got $caught" }
}
private fun failed(subject: Subject) {
  check(subject.state("asrAdmission").toString() == "FAILED")
  check(subject.state("asrCleanupFailure") is Throwable)
  check(Log.errors.isNotEmpty())
  check(subject.asr.isShutdown)
}

private fun schedule(id: String) {
  when (id) {
    "S01" -> { val a = Subject(); a.create(); live(1, "before_destroy"); retired(a); check(NativeProbe.destroyedStreams() == 1) }
    "S02" -> {
      val a = Subject(); val p = a.call("createStreamingRecognizer"); live(0, "accepted_held"); a.destroy()
      val late = a.call("createStreamingRecognizer", "late"); late.rejected()
      a.asr.runNext(); p.succeeded(); live(1, "accepted_create_ran")
      a.drain(); live(0, "terminal_barrier_ran"); check(NativeProbe.destroyedStreams() == 1)
    }
    "S03" -> {
      val a = Subject(); a.create(); val p = a.call("pushAudioFrame"); NativeProbe.holdDecode()
      val error = AtomicReference<Throwable?>()
      val worker = Thread { try { a.asr.runNext() } catch (e: Throwable) { error.set(e) } }
      worker.start()
      try {
        check(NativeProbe.awaitDecode()) { "Decode did not reach inert boundary" }
        a.destroy(); live(1, "decode_held_after_destroy"); check(NativeProbe.destroyedStreams() == 0)
      } finally { NativeProbe.releaseDecode(); worker.join(15000) }
      check(!worker.isAlive) { "Finite decode worker did not settle" }; error.get()?.let { throw it }
      p.succeeded(); a.drain(); live(0, "after_decode_return_and_barrier")
      val events = NativeProbe.snapshot(); check(events.indexOf("decode_return") < events.indexOf("stream_destroy"))
    }
    "S04" -> {
      val a = Subject(); a.create(); val p = a.call("finishStreaming"); a.destroy(); a.drain(); p.succeeded()
      check((p.value as Map<*, *>)["text"] == "fixture transcript"); live(0, "finish_then_destroy")
      check(NativeProbe.destroyedStreams() == 1)
    }
    "S05" -> { val a = Subject(); a.create(); a.call("cancel").succeeded(); retired(a); check(NativeProbe.destroyedStreams() == 1) }
    "S06" -> {
      val a = Subject(); a.create(); a.destroy(); val submissions = a.asr.submissions
      a.call("cancel").succeeded(); check(a.asr.submissions == submissions)
      a.drain(); live(0, "cancel_after_close"); check(NativeProbe.ownerCreates() == 1)
    }
    "S07" -> {
      val a = Subject()
      val emptyPush = a.call("pushAudioFrame"); val emptyFinish = a.call("finishStreaming")
      a.asr.drain(); emptyPush.succeeded(); emptyFinish.succeeded(); check(NativeProbe.ownerCreates() == 0)
      a.destroy()
      for (name in listOf("createStreamingRecognizer", "pushAudioFrame", "finishStreaming")) a.call(name).rejected()
      a.drain(); live(0, "all_after_close_refused"); check(NativeProbe.ownerCreates() == 0)
    }
    "S08" -> {
      val a = Subject(); a.create(); a.destroy(); val accepted = a.asr.submissions
      throwsRejected { a.destroy() }; a.drain(); throwsRejected { a.destroy() }
      check(a.asr.submissions == accepted); check(NativeProbe.ownerDisposals() == 1)
      live(0, "repeated_destroy"); println("Existing repeated TTS shutdown refusal retained")
    }
    "S09" -> {
      val a = Subject(); val b = Subject(); a.create(); b.create(); live(2, "two_owners_same_job")
      a.destroy(); a.drain(); live(1, "A_retired_B_owned")
      val p = b.call("pushAudioFrame"); b.asr.drain(); p.succeeded()
      check((p.value as Map<*, *>)["text"] == "fixture transcript"); retired(b)
    }
    "S10" -> {
      val a = Subject(); a.create(); val held = a.call("pushAudioFrame"); a.destroy()
      val b = Subject(); b.create(); a.call("cancel").succeeded()
      a.call("createStreamingRecognizer").rejected(); a.drain(); held.succeeded(); live(1, "late_A_cannot_retire_B")
      val p = b.call("finishStreaming"); b.asr.drain(); p.succeeded()
      check((p.value as Map<*, *>)["text"] == "fixture transcript"); retired(b)
      println("Raw native address reuse was not forced; distinct live-instance isolation only")
    }
    "S11" -> {
      val a = Subject(); a.create(); a.create(); live(1, "same_owner_replacement")
      check(NativeProbe.destroyedStreams() == 1)
      val p = a.call("release"); a.tts.drain(); p.succeeded()
      check(NativeProbe.liveRecognizers() == 1); live(1, "cache_released_stream_owns_engine")
      retired(a); check(NativeProbe.destroyedStreams() == 2); check(NativeProbe.liveRecognizers() == 0)
      val events = NativeProbe.snapshot(); check(events.lastIndexOf("stream_destroy") < events.indexOf("recognizer_destroy"))
    }
    "S12-create" -> {
      val a = Subject(); NativeProbe.failNextCreate(); val p = a.call("createStreamingRecognizer")
      a.asr.drain(); p.rejected(); live(0, "native_create_failed"); retired(a)
    }
    "S12-enqueue" -> {
      val a = Subject(); a.create(); a.asr.rejectNext = true
      val p = a.call("pushAudioFrame"); p.rejected(); check(p.error is RejectedExecutionException)
      a.destroy(); a.drain(); failed(a); live(1, "submission_failure_visibly_incomplete")
      check(a.state("asrOwner") != null); a.call("finishStreaming").rejected()
    }
    "S12-terminal" -> {
      val a = Subject(); a.create(); a.asr.rejectNext = true; a.destroy(); a.drain()
      failed(a); live(1, "terminal_enqueue_failure_visibly_incomplete"); check(a.state("asrOwner") != null)
      val accepted = a.asr.submissions; throwsRejected { a.destroy() }; check(a.asr.submissions == accepted)
    }
    "S12-cancel" -> {
      val a = Subject(); a.create(); a.asr.rejectNext = true; throwsRejected { a.call("cancel") }
      a.destroy(); a.drain(); failed(a); live(1, "cancel_enqueue_failure_visibly_incomplete")
      var error: Throwable? = null; try { a.call("cancel") } catch (e: Throwable) { error = e }
      check(error is IllegalStateException); check(a.state("asrOwner") != null)
    }
    "S12-tts" -> {
      val a = Subject(); a.create(); a.tts.rejectNext = true; throwsRejected { a.destroy() }
      check(a.asr.isShutdown); a.drain(); live(0, "ASR_finally_despite_TTS_refusal")
      // The pre-existing TTS path did not reach its shutdown after the injected enqueue refusal.
      a.tts.shutdown()
    }
    "S12-dispose" -> {
      val a = Subject(); a.create(); NativeProbe.failNextDisposal(); a.destroy(); a.drain()
      failed(a); live(1, "pre_entry_disposal_refusal_visibly_incomplete")
      check(a.state("asrOwner") != null); check(NativeProbe.ownerDisposals() == 0)
      a.call("pushAudioFrame").rejected(); val accepted = a.asr.submissions
      throwsRejected { a.destroy() }; check(a.asr.submissions == accepted)
    }
    else -> error("Unknown finite schedule: $id")
  }
}

fun main(args: Array<String>) {
  check(args.size == 2) { "Expected schedule and exact variant metadata" }
  val ownedEntries = NativeProbe.bind()
  check(NativeProbe.snapshot().contains("j075-inert-sherpa-v1"))
  println("SETUP_READY schedule=${args[0]} ownedEntries=$ownedEntries metadata=${args[1]}")
  try {
    schedule(args[0]); println("SCHEDULE_PASS ${args[0]}")
  } finally {
    val snapshot = NativeProbe.snapshot()
    println("FINAL_NATIVE $snapshot")
    check(!snapshot.contains("invalid_recognizer_destroy_with_live_stream")) { "Recognizer retired before its stream: $snapshot" }
  }
}
