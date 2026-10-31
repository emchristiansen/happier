import Foundation

// Finite registration/event boundary. The supplied callbacks remain the real production code.
public enum BoundaryEvents {
  public static var emit: (String, [String: Any?]) -> Void = { _, _ in }
}
open class BaseModule {
  public init() {}
  public func sendEvent(_ name: String, _ payload: [String: Any?]) { BoundaryEvents.emit(name, payload) }
}
public protocol AnyModule {
  @ModuleDefinitionBuilder func definition() -> ModuleDefinition
}
public typealias Module = BaseModule & AnyModule

public struct ModuleDefinition {
  public var name = ""
  public var events: [String] = []
  public var functions: [String: ([String: Any]) throws -> Any] = [:]
  public var destroy: (() -> Void)?
  public var contextDestroy: (() -> Void)?
}
public struct AnyDefinition {
  let apply: (inout ModuleDefinition) -> Void
}
@resultBuilder public enum ModuleDefinitionBuilder {
  public static func buildBlock(_ parts: AnyDefinition...) -> ModuleDefinition {
    var result = ModuleDefinition()
    for part in parts { part.apply(&result) }
    return result
  }
}
public func Name(_ name: String) -> AnyDefinition { AnyDefinition { $0.name = name } }
public func Events(_ names: String...) -> AnyDefinition { AnyDefinition { $0.events = names } }
public func OnDestroy(_ body: @escaping () -> Void) -> AnyDefinition { AnyDefinition { $0.destroy = body } }
public func OnAppContextDestroys(_ body: @escaping () -> Void) -> AnyDefinition {
  AnyDefinition { $0.contextDestroy = body }
}
public func AsyncFunction<T>(_ name: String, _ body: @escaping ([String: Any]) throws -> T) -> AnyDefinition {
  AnyDefinition { $0.functions[name] = { try body($0) } }
}
