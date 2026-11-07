package expo.modules.kotlin.modules

import expo.modules.kotlin.Promise

// Only registration is replaced. Every captured callback is supplied by the real module.
abstract class Module { abstract fun definition(): ModuleDefinitionData }

class ModuleDefinitionData {
  var name: String? = null
  var destroy: (() -> Unit)? = null
  val functions = linkedMapOf<String, (Map<String, Any?>, Promise) -> Unit>()
}

class ModuleDefinitionBuilder {
  val data = ModuleDefinitionData()
  fun Name(name: String) { check(data.name == null); data.name = name }
  fun OnDestroy(callback: () -> Unit) { check(data.destroy == null); data.destroy = callback }
  fun AsyncFunction(name: String, callback: (Map<String, Any?>, Promise) -> Unit) {
    check(data.functions.put(name, callback) == null)
  }
  fun AsyncFunction(name: String, callback: (Map<String, Any?>) -> Unit) {
    check(data.functions.put(name) { params, promise -> callback(params); promise.resolve(null) } == null)
  }
}

fun Module.ModuleDefinition(block: ModuleDefinitionBuilder.() -> Unit): ModuleDefinitionData =
  ModuleDefinitionBuilder().apply(block).data
