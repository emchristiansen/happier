package android.media;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

// Only the external media boundary. The actual module owns admission, threads and cleanup.
public final class AudioRecord {
  public static final int ERROR = -1, ERROR_BAD_VALUE = -2, STATE_INITIALIZED = 1;
  public static final List<AudioRecord> instances = new CopyOnWriteArrayList<>();
  public static volatile boolean holdStart = false;
  public static volatile String failure = "";
  public static final CountDownLatch startEntered = new CountDownLatch(1);
  public static final CountDownLatch startReleased = new CountDownLatch(1);
  public final CountDownLatch readEntered = new CountDownLatch(1);
  public final CountDownLatch stopEntered = new CountDownLatch(1);
  public final CountDownLatch releaseEntered = new CountDownLatch(1);
  public volatile Thread reader;
  public volatile boolean recording, released;
  public volatile int stops, releases;
  private byte[] nextData;
  private Integer nextError;
  public static int getMinBufferSize(int rate, int channels, int encoding) {
    if (rate != 16000 || channels != AudioFormat.CHANNEL_IN_MONO || encoding != AudioFormat.ENCODING_PCM_16BIT)
      throw new AssertionError("Unexpected media format");
    return 640;
  }
  public AudioRecord(int source, int rate, int channels, int encoding, int size) {
    if (source != MediaRecorder.AudioSource.VOICE_RECOGNITION || rate != 16000 ||
        channels != AudioFormat.CHANNEL_IN_MONO || encoding != AudioFormat.ENCODING_PCM_16BIT || size < 640)
      throw new AssertionError("Unexpected recorder constructor");
    if (failure.equals("constructor")) throw new IllegalStateException("fixture constructor refusal");
    instances.add(this);
  }
  public int getState() { return failure.equals("state") ? 0 : STATE_INITIALIZED; }
  public void startRecording() {
    startEntered.countDown();
    if (holdStart) await(startReleased, "start release");
    if (failure.equals("start")) throw new IllegalStateException("fixture start refusal");
    if (released) throw new AssertionError("start after release");
    recording = true;
  }
  public synchronized int read(byte[] buffer, int offset, int length) {
    reader = Thread.currentThread(); readEntered.countDown();
    while (recording && nextData == null && nextError == null) {
      try { wait(); } catch (InterruptedException e) { throw new AssertionError(e); }
    }
    if (nextError != null) { int error = nextError; nextError = null; return error; }
    if (!recording) return -3;
    if (released) throw new AssertionError("read after release");
    byte[] bytes = nextData; nextData = null;
    if (bytes.length > length) throw new AssertionError("fixture frame too large");
    System.arraycopy(bytes, 0, buffer, offset, bytes.length); return bytes.length;
  }
  public synchronized void stop() {
    stops++; stopEntered.countDown();
    if (failure.equals("stop")) throw new IllegalStateException("fixture stop refusal");
    recording = false; notifyAll();
  }
  public synchronized void release() {
    releases++; releaseEntered.countDown();
    if (failure.equals("release")) throw new IllegalStateException("fixture release refusal");
    if (released) throw new AssertionError("double release");
    released = true; recording = false; notifyAll();
  }
  public synchronized void frame() { nextData = new byte[640]; notifyAll(); }
  public synchronized void readError() { nextError = -3; notifyAll(); }
  public static int live() { return (int) instances.stream().filter(r -> !r.released).count(); }
  public static void await(CountDownLatch latch, String phase) {
    try { if (!latch.await(10, TimeUnit.SECONDS)) throw new AssertionError("fixture latch timeout: " + phase); }
    catch (InterruptedException e) { throw new AssertionError(e); }
  }
}
