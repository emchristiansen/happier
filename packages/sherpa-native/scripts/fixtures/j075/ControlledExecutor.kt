package dev.happier.sherpa.fixture

import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

// A finite scheduling boundary. It knows nothing about modules, jobs or native ownership.
class ControlledExecutor : AbstractExecutorService() {
  private val queue = ArrayDeque<Runnable>()
  private var closed = false
  var rejectNext = false
  var submissions = 0; private set
  var completed = 0; private set
  @Synchronized override fun execute(command: Runnable) {
    if (closed || rejectNext) { rejectNext = false; throw RejectedExecutionException("fixture enqueue refusal") }
    submissions++; queue.addLast(command)
  }
  fun runNext() {
    val task = synchronized(this) { check(queue.isNotEmpty()); queue.removeFirst() }
    try { task.run() } finally { synchronized(this) { completed++ } }
  }
  fun drain() { while (pending() != 0) runNext() }
  @Synchronized fun pending() = queue.size
  @Synchronized override fun shutdown() { closed = true }
  @Synchronized override fun shutdownNow(): MutableList<Runnable> =
    throw AssertionError("shutdownNow is outside the selected module contract")
  @Synchronized override fun isShutdown() = closed
  @Synchronized override fun isTerminated() = closed && queue.isEmpty() && completed == submissions
  override fun awaitTermination(timeout: Long, unit: TimeUnit) = isTerminated
}
