package expo.modules.kotlin.modules

abstract class Module {
  abstract fun definition(): ModuleDefinitionData
  fun sendEvent(name: String, payload: Map<String, Any?>) { BoundaryEvents.emit(name, payload) }
}

object BoundaryEvents {
  @Volatile var handler: (String, Map<String, Any?>) -> Unit = { _, _ -> }
  fun emit(name: String, payload: Map<String, Any?>) = handler(name, payload)
}

class ModuleDefinitionData {
  var name: String? = null
  var destroy: (() -> Unit)? = null
  val events = mutableSetOf<String>()
  val functions = linkedMapOf<String, (Map<String, Any>) -> Any?>()
}

class ModuleDefinitionBuilder {
  val data = ModuleDefinitionData()
  fun Name(value: String) { check(data.name == null); data.name = value }
  fun Events(vararg names: String) { data.events.addAll(names) }
  fun OnDestroy(callback: () -> Unit) { check(data.destroy == null); data.destroy = callback }
  fun <T> AsyncFunction(name: String, callback: (Map<String, Any>) -> T) {
    check(data.functions.put(name, callback) == null)
  }
}

fun Module.ModuleDefinition(block: ModuleDefinitionBuilder.() -> Unit): ModuleDefinitionData =
  ModuleDefinitionBuilder().apply(block).data
