export function getVitestNodeBuiltin<T>(id: string): T {
    const hostProcess = process as typeof process & {
        getBuiltinModule?: (builtinId: string) => unknown;
    };
    if (!hostProcess.getBuiltinModule) {
        throw new Error(`[vitest] Node runtime cannot load builtin module "${id}"`);
    }
    return hostProcess.getBuiltinModule(id) as T;
}
