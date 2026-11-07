package android.util;

public final class Log {
  public static final java.util.List<Throwable> errors = new java.util.concurrent.CopyOnWriteArrayList<>();
  public static int e(String tag, String message, Throwable error) {
    errors.add(error); System.err.println(tag + ": " + message); error.printStackTrace(System.err); return 0;
  }
}
