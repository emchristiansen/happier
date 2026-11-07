package expo.modules.kotlin

class Promise {
  var completions = 0; private set
  var value: Any? = null; private set
  var error: Throwable? = null; private set
  var code: String? = null; private set
  var message: String? = null; private set
  @Synchronized fun resolve(value: Any?) { check(completions++ == 0); this.value = value }
  @Synchronized fun reject(code: String, message: String?, cause: Throwable?) {
    check(completions++ == 0); this.code = code; this.message = message; error = cause
  }
  @Synchronized fun succeeded() { check(completions == 1 && code == null) { "Promise failed: $code $message $error" } }
  @Synchronized fun rejected() { check(completions == 1 && code != null) { "Promise was not rejected: $value" } }
}
