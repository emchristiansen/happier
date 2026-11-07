package android.util;

public final class Log {
  public static final java.util.List<Throwable> errors = new java.util.ArrayList<>();
  public static synchronized int e(String tag, String message, Throwable cause) {
    errors.add(cause);
    System.err.println(tag + ": " + message);
    cause.printStackTrace(System.err);
    return 0;
  }
}
