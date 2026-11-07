package android.util;

public final class Base64 {
  public static final int DEFAULT = 0;
  public static byte[] decode(String value, int flags) {
    if (flags != DEFAULT || !value.equals("AAAAAA==")) {
      throw new AssertionError("Unexpected fixture Base64 input or flags");
    }
    return java.util.Base64.getDecoder().decode(value);
  }
}
