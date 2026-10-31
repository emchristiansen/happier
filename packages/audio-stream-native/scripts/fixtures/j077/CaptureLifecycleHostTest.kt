package dev.happier.audio.fixture

import android.media.AudioRecord
import android.util.Log
import dev.happier.audio.HappierAudioStreamNativeModule
import expo.modules.kotlin.modules.BoundaryEvents
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference

private class Subject {
  val definition = HappierAudioStreamNativeModule().definition().also {
    check(it.name == "HappierAudioStreamNative")
    check(it.events == setOf("audioFrame", "audioError"))
    check(it.functions.keys == setOf("start", "stop"))
  }
  var id: String? = null
  fun start(): String {
    val result = definition.functions.getValue("start")(mapOf("sampleRate" to 16000, "channels" to 1, "frameMs" to 20))
    return ((result as Map<*, *>)["streamId"] as String).also { check(it.isNotBlank()); id = it }
  }
  fun stop(value: String = id!!): Any? = definition.functions.getValue("stop")(mapOf("streamId" to value))
  fun destroy() { definition.destroy?.invoke() }
}

private val subjects = mutableListOf<Subject>()
private fun subject() = Subject().also { subjects.add(it) }
private fun recorder(index: Int = AudioRecord.instances.size - 1) = AudioRecord.instances[index]
private fun readStarted(record: AudioRecord) = AudioRecord.await(record.readEntered, "actual read entered")
private fun joined(thread: Thread?) {
  check(thread != null); thread.join(10000); check(!thread.isAlive) { "Owned finite thread did not finish" }
}
private fun live(expected: Int, phase: String) {
  val actual = AudioRecord.live()
  println("ALLOCATION phase=$phase expected=$expected actual=$actual")
  check(actual == expected) { "$phase expected liveRecorder=$expected actual liveRecorder=$actual" }
}
private fun refused(block: () -> Unit): Throwable {
  var failure: Throwable? = null
  try { block() } catch (error: Throwable) { failure = error }
  return checkNotNull(failure) { "Operation unexpectedly succeeded" }
}

private fun runCase(id: String) {
  when (id) {
    "A01" -> {
      val a = subject(); a.start(); val record = recorder(); readStarted(record); live(1, "before_actual_destroy")
      println("ACTUAL_DESTROY_REGISTERED ${a.definition.destroy != null}")
      a.destroy(); live(0, "after_actual_destroy")
      joined(record.reader); check(record.stops == 1 && record.releases == 1)
      refused { a.start() }; check(AudioRecord.instances.size == 1)
    }
    "A02" -> {
      AudioRecord.holdStart = true
      val a = subject(); val error = AtomicReference<Throwable?>(); val returned = CountDownLatch(1)
      val start = Thread { try { a.start() } catch (e: Throwable) { error.set(e) } finally { returned.countDown() } }
      start.start(); AudioRecord.await(AudioRecord.startEntered, "start held")
      val close = Thread { a.destroy() }; close.start()
      try { joined(close) } finally { AudioRecord.startReleased.countDown() }
      AudioRecord.await(returned, "accepted start settles"); joined(start)
      check(error.get() != null) { "Closed accepted start published a late stream" }
      live(0, "closed_during_external_start"); check(recorder().releases == 1)
    }
    "A03" -> {
      val a = subject(); a.start(); val record = recorder(); readStarted(record)
      a.destroy(); check(record.stops == 1) { "Destroy did not request owned read unblock" }
      joined(record.reader); live(0, "held_read_destroyed"); check(record.releases == 1)
    }
    "A04-read", "A04-event" -> {
      val a = subject(); a.start(); val record = recorder(); readStarted(record)
      if (id == "A04-event") {
        BoundaryEvents.handler = { _, _ -> throw IllegalStateException("fixture event transport refusal") }
        record.frame()
      } else record.readError()
      joined(record.reader); live(0, "worker_failure_finally")
      check(record.stops == 1 && record.releases == 1)
    }
    "A05" -> {
      val a = subject(); val firstId = a.start(); val first = recorder(); readStarted(first)
      val secondId = a.start(); val second = recorder(); readStarted(second)
      check(firstId != secondId); joined(first.reader)
      a.stop(firstId); live(1, "stale_stop_preserves_replacement")
      check(!second.released); a.stop(secondId); joined(second.reader); live(0, "matching_stop")
    }
    "A06" -> {
      val a = subject(); val aid = a.start(); val ar = recorder(); readStarted(ar)
      val entered = CountDownLatch(1); val release = CountDownLatch(1)
      BoundaryEvents.handler = { name, payload ->
        if (name == "audioFrame" && payload["streamId"] == aid) {
          entered.countDown(); AudioRecord.await(release, "held event return")
        }
      }
      ar.frame(); AudioRecord.await(entered, "actual old event admitted")
      val b = subject(); val bid = b.start(); val br = recorder(); readStarted(br)
      try {
        a.destroy(); a.destroy(); live(2, "held_old_event_not_falsely_retired")
        check(!br.released && bid != aid)
      } finally { release.countDown() }
      ar.readError() // Settle an old implementation that has no destruction stop flag, without releasing it.
      joined(ar.reader); live(1, "old_event_return_disposes_only_A")
      check(!br.released); b.stop(); joined(br.reader); live(0, "B_matching_stop")
    }
    "A07-constructor", "A07-state", "A07-start" -> {
      val a = subject(); AudioRecord.failure = id.removePrefix("A07-")
      refused { a.start() }; live(0, "partial_acquisition_failure")
      if (AudioRecord.instances.isNotEmpty()) check(recorder().releases == 1)
    }
    "A07-stop", "A07-release" -> {
      val a = subject(); a.start(); val record = recorder(); readStarted(record)
      AudioRecord.failure = id.removePrefix("A07-")
      val result = AtomicReference<Throwable?>()
      val stop = Thread { try { a.stop() } catch (e: Throwable) { result.set(e) } }
      stop.start(); AudioRecord.await(record.stopEntered, "owned stop attempted")
      // A refused stop cannot unblock the external read; let that actual read fail independently.
      if (id == "A07-stop") record.readError()
      joined(stop); joined(record.reader)
      check(result.get() != null) { "Incomplete stop was reported as successful" }
      check(Log.errors.isNotEmpty()) { "Cleanup failure was hidden" }
      val before = AudioRecord.instances.size; refused { a.start() }
      check(AudioRecord.instances.size == before) { "Incomplete owner was overwritten" }
      check(record.stops == 1 && record.releases == 1) { "Cleanup was retried" }
    }
    else -> error("Unknown capture schedule: $id")
  }
}

fun main(args: Array<String>) {
  check(args.size == 2)
  check(AudioRecord.instances.isEmpty() && AudioRecord.live() == 0)
  println("SETUP_READY schedule=${args[0]} metadata=${args[1]}")
  try { runCase(args[0]); println("SCHEDULE_PASS ${args[0]}") }
  finally {
    println("FINAL_ALLOCATION live=${AudioRecord.live()} instances=${AudioRecord.instances.size}")
    // After the pre-exit oracle, settle only this fixture's positively observed finite work.
    AudioRecord.startReleased.countDown()
    AudioRecord.instances.forEach { it.readError() }
    subjects.forEach { a -> a.id?.let { try { a.stop(it) } catch (e: Throwable) { e.printStackTrace(System.err) } } }
    AudioRecord.instances.forEach { r -> r.reader?.let { joined(it) } }
    AudioRecord.instances.forEachIndexed { index, r ->
      println("RECORDER index=$index released=${r.released} stops=${r.stops} releases=${r.releases} readerAlive=${r.reader?.isAlive}")
    }
  }
}
