import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const packageDir = path.dirname(require.resolve('react-native-worklets/package.json'));

// Model the native SDK's shared ownership only: native composites retain child
// native values even after the children's JS wrappers are collected. No cache or
// serialization decision is mocked here.
const nativeBoundary = `
const values = new Map();
const ids = new WeakMap();
let nextId = 0;
function release(id) {
    const value = values.get(id);
    if (--value.refs !== 0) return;
    values.delete(id);
    for (const child of value.children) release(child);
}
const releases = new FinalizationRegistry(release);
function decode(id) {
    const value = values.get(id);
    if (value.kind === 'object') return Object.fromEntries(value.keys.map((key, i) => [key, decode(value.children[i])]));
    if (value.kind === 'array') return value.children.map(decode);
    if (value.kind === 'map') return new Map(value.keys.map((key, i) => [decode(key), decode(value.children[i])]));
    if (value.kind === 'set') return new Set(value.children.map(decode));
    return value.data;
}
function create(kind, data, children = [], keys = []) {
    const id = ++nextId;
    for (const child of children) values.get(child).refs++;
    values.set(id, { kind, data, children, keys, refs: 1 });
    const wrapper = { invoke: (...args) => decode(id)(...args), read: () => decode(id) };
    ids.set(wrapper, id);
    releases.register(wrapper, id);
    return wrapper;
}
export const WorkletsModule = {
    createSerializableFunction: fn => create('function', fn),
    createSerializableNumber: value => create('number', value),
    createSerializableString: value => create('string', value),
    createSerializableObject: props => create('object', null, Object.values(props).map(value => ids.get(value)), Object.keys(props)),
    createSerializableArray: items => create('array', null, items.map(value => ids.get(value))),
    createSerializableSet: items => create('set', null, items.map(value => ids.get(value))),
    createSerializableMap(keys, items) {
        const keyIds = keys.map(value => ids.get(value));
        const valueIds = items.map(value => ids.get(value));
        // Keys are native children too; map decode uses only the value prefix.
        return create('map', null, [...valueIds, ...keyIds], keyIds);
    },
};
`;

for (const entry of ['src/memory/serializable.native.ts', 'lib/module/memory/serializable.native.js']) {
    for (const weakRefsAvailable of [true, false]) {
        test(`${entry}: remote callback mapping is correct (WeakRef=${weakRefsAvailable})`, async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklets-lifetime-'));
            try {
                const bundle = path.join(dir, 'serializer.cjs');
                await build({
                    stdin: {
                        contents: `export * from ${JSON.stringify(path.join(packageDir, entry))}; export { serializableMappingCache } from ${JSON.stringify(path.join(packageDir, entry.replace('serializable.native', 'serializableMappingCache.native')))};`,
                        resolveDir: packageDir,
                        loader: 'ts',
                    },
                    outfile: bundle,
                    bundle: true,
                    platform: 'node',
                    format: 'cjs',
                    resolveExtensions: ['.native.ts', '.ts', '.native.js', '.js'],
                    plugins: [{
                        name: 'native-sdk-boundary',
                        setup(builder) {
                            builder.onResolve({ filter: /\/WorkletsModule\/NativeWorklets(?:\.js)?$/ }, () => ({ path: 'native', namespace: 'sdk' }));
                            builder.onLoad({ filter: /.*/, namespace: 'sdk' }, () => ({ contents: nativeBoundary, loader: 'js' }));
                            // Compiled package imports spell out .js; resolve the
                            // same native variant Metro selects for source imports.
                            builder.onResolve({ filter: /\.js$/ }, args => {
                                if (!args.path.startsWith('.')) return;
                                const native = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.native.js'));
                                if (fs.existsSync(native)) return { path: native };
                            });
                        },
                    }],
                });
                const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=commonjs'], {
                    encoding: 'utf8',
                    timeout: 30_000,
                    input: `
const assert = require('node:assert/strict');
globalThis.__DEV__ = true;
globalThis.__RUNTIME_KIND = 1;
const NativeWeakRef = WeakRef;
if (!${weakRefsAvailable}) globalThis.WeakRef = undefined;
const { createSerializable, serializableMappingCache } = require(${JSON.stringify(bundle)});
const turn = () => new Promise(resolve => setImmediate(resolve));
async function collect() {
    // A deref keeps its target alive until the job ends. Always collect in a
    // different job, and allow the native-boundary finalizer to run afterwards.
    await turn();
    global.gc();
    await turn();
}
function createTrackedHandles(shape) {
    const refs = [];
    const handles = [];
    for (let i = 0; i < 32; i++) {
        let value;
        if (shape === 'function') value = () => i;
        if (shape === 'object') {
            value = { number: i };
            value.callback = () => value.number;
        }
        if (shape === 'array') {
            value = [i];
            value.push(() => value[0]);
        }
        if (shape === 'map') {
            value = new Map([['number', i]]);
            value.set('callback', () => value.get('number'));
        }
        if (shape === 'set') {
            value = new Set([i]);
            value.add(() => [...value].find(item => typeof item === 'number'));
        }
        refs.push(new NativeWeakRef(value));
        const handle = createSerializable(value);
        handles.push(handle);
        assert.equal(createSerializable(value), handle, shape + ': repeated serialization must preserve identity');
        assert.equal(createSerializable(handle), handle);
    }
    return { refs, handles };
}
function invokeHandles(shape, handles) {
    return handles.map(handle => {
        const value = handle.read();
        if (shape === 'function') return value();
        if (shape === 'object') return value.callback();
        if (shape === 'array') return value[1]();
        if (shape === 'map') return value.get('callback')();
        return [...value].find(item => typeof item === 'function')();
    });
}
(async () => {
    // Explicit mappings override the source function and own stateful bindings.
    const mapped = () => 1;
    serializableMappingCache.set(mapped, createSerializable(() => 2));
    const persistent = { number: 3 };
    const persistentHandle = new NativeWeakRef(createSerializable(persistent, true));
    const persistentArray = [3];
    const persistentArrayHandle = new NativeWeakRef(createSerializable(persistentArray, true));
    await collect();
    await collect();
    assert.equal(createSerializable(mapped).invoke(), 2, 'explicit native binding must survive collection');
    assert.ok(persistentHandle.deref(), 'persistent remote identity must remain owned by its source');
    assert.equal(createSerializable(persistent, true), persistentHandle.deref());
    assert.ok(persistentArrayHandle.deref(), 'persistent array identity must remain owned by its source');
    assert.equal(createSerializable(persistentArray, true), persistentArrayHandle.deref());

    // Recreating an expired native clone must not wrap the source's mutation
    // guards again. Hermes retains the previous descriptor in each wrapper's
    // environment, so repeated wrapping keeps every older getter alive.
    const guarded = { number: 42 };
    const guardedHandle = new NativeWeakRef(createSerializable(guarded));
    const firstGuard = Object.getOwnPropertyDescriptor(guarded, 'number');
    if (${weakRefsAvailable}) {
        for (let i = 0; i < 30; i++) {
            await collect();
            if (!guardedHandle.deref()) break;
        }
        assert.equal(guardedHandle.deref(), undefined, 'the reconstructible clone must expire');
    }
    assert.equal(createSerializable(guarded).read().number, 42);
    const nextGuard = Object.getOwnPropertyDescriptor(guarded, 'number');
    assert.equal(nextGuard.get, firstGuard.get, 'reserialization must reuse the existing mutation getter');
    assert.equal(nextGuard.set, firstGuard.set, 'reserialization must reuse the existing mutation warning');

    for (const shape of ['function', 'object', 'array', 'map', 'set']) {
        const tracked = createTrackedHandles(shape);
        const refs = tracked.refs;
        let handles = tracked.handles;
        tracked.handles = null;
        await collect();
        assert.equal(refs.filter(ref => ref.deref()).length, 32, shape + ': live native handles must retain callback owners');
        assert.deepEqual(invokeHandles(shape, handles), Array.from({ length: 32 }, (_, i) => i));
        if (!${weakRefsAvailable}) continue;
        handles = null;
        for (let i = 0; i < 30; i++) {
            await collect();
            if (refs.every(ref => !ref.deref())) break;
        }
        assert.equal(refs.filter(ref => ref.deref()).length, 0, shape + ': discarded native handles must release callback owners');
    }

    // A still-owned JS function can be serialized again after its old weakly
    // cached handle expires; dead cache entries must not be returned as handles.
    const fn = value => value + 1;
    let previous = new NativeWeakRef(createSerializable(fn));
    if (!${weakRefsAvailable}) {
        await collect();
        assert.equal(createSerializable(fn), previous.deref(), 'the strong fallback must preserve identity');
        assert.equal(previous.deref().invoke(41), 42);
        return;
    }
    for (let i = 0; i < 30; i++) {
        await collect();
        if (!previous.deref()) break;
    }
    assert.equal(previous.deref(), undefined, 'the cache must not own the native handle');
    assert.equal(createSerializable(fn).invoke(41), 42);
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
                });
                assert.equal(result.error, undefined, result.error?.message);
                assert.equal(result.status, 0, result.stderr || result.stdout);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
}
