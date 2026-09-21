/**
 * URL of the ONNX wasm runtime — THE SAME one the worker will resolve for itself.
 *
 * That is the only reason this file exists. The bundler hashes the name
 * (`ort-wasm-simd-threaded.asyncify-CsxMlmQ8.wasm`), and it cannot be guessed as a string; and
 * if the file is preloaded from a different URL, the cache gets a copy the worker will not use,
 * and 24 MB are downloaded twice.
 *
 * `new URL(..., import.meta.url)` makes the bundler emit exactly the same asset it gave to
 * onnxruntime's internals — one file, one hash, one download.
 */
export const WASM_URL = new URL(
  'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm',
  import.meta.url,
).href
