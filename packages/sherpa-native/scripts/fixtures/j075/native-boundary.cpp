#include <jni.h>
#include <dlfcn.h>
#include <android/log.h>
#include "sherpa-onnx/c-api/c-api.h"
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <vector>

struct SherpaOnnxOnlineRecognizer { int id; };
struct SherpaOnnxOnlineStream {
  const SherpaOnnxOnlineRecognizer *recognizer;
  int id;
  mutable bool ready = false;
};

namespace {
// Probe bookkeeping remains available while the real translation unit's static caches are destroyed.
// These sets observe external allocations; they never retire production owners or streams.
std::mutex &mutex = *new std::mutex;
std::condition_variable &condition = *new std::condition_variable;
std::set<const SherpaOnnxOnlineRecognizer *> &recognizers = *new std::set<const SherpaOnnxOnlineRecognizer *>;
std::set<const SherpaOnnxOnlineStream *> &streams = *new std::set<const SherpaOnnxOnlineStream *>;
std::vector<std::string> &events = *new std::vector<std::string>;
int sequence = 0, destroyed = 0, creates = 0, disposals = 0;
bool failCreate = false, failDisposal = false, held = false, entered = false;
using CreateOwner = jlong (*)(JNIEnv *, jclass);
using DisposeOwner = void (*)(JNIEnv *, jclass, jlong);
CreateOwner realCreate = nullptr;
DisposeOwner realDispose = nullptr;

[[noreturn]] void unexpected(const char *operation) {
  std::fprintf(stderr, "J075 unexpected external boundary: %s\n", operation);
  std::abort();
}
void requireStream(const SherpaOnnxOnlineStream *stream) {
  if (!streams.count(stream) || !recognizers.count(stream->recognizer)) unexpected("dead stream/recognizer");
}
jlong createOwner(JNIEnv *env, jclass cls) {
  jlong value = realCreate(env, cls);
  std::lock_guard<std::mutex> lock(mutex);
  ++creates; events.push_back("owner_create:" + std::to_string(value));
  return value;
}
void disposeOwner(JNIEnv *env, jclass cls, jlong owner) {
  {
    std::lock_guard<std::mutex> lock(mutex);
    events.push_back("owner_dispose_entry:" + std::to_string(owner));
    if (failDisposal) {
      failDisposal = false;
      env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "fixture pre-entry disposal refusal");
      return;
    }
  }
  realDispose(env, cls, owner);
  std::lock_guard<std::mutex> lock(mutex);
  ++disposals; events.push_back("owner_dispose_return:" + std::to_string(owner));
}
}  // namespace

extern "C" {
int __android_log_print(int priority, const char *tag, const char *format, ...) {
  if (priority != ANDROID_LOG_ERROR) unexpected("Android log priority");
  std::fprintf(stderr, "%s: ", tag);
  va_list args; va_start(args, format); int result = std::vfprintf(stderr, format, args); va_end(args);
  std::fputc('\n', stderr); return result;
}
int32_t SherpaOnnxFileExists(const char *filename) {
  const std::string name(filename);
  const std::set<std::string> allowed = {"/fixture/model/tokens.txt", "/fixture/model/encoder.onnx",
    "/fixture/model/decoder.onnx", "/fixture/model/joiner.onnx"};
  if (!allowed.count(name)) unexpected("FileExists outside declared inert ASR assets");
  return 1;
}
const SherpaOnnxOnlineRecognizer *SherpaOnnxCreateOnlineRecognizer(const SherpaOnnxOnlineRecognizerConfig *config) {
  if (std::string(config->model_config.transducer.encoder) != "/fixture/model/encoder.onnx") unexpected("model config");
  std::lock_guard<std::mutex> lock(mutex);
  auto *value = new SherpaOnnxOnlineRecognizer{++sequence}; recognizers.insert(value);
  events.push_back("recognizer_create:" + std::to_string(value->id)); return value;
}
void SherpaOnnxDestroyOnlineRecognizer(const SherpaOnnxOnlineRecognizer *value) {
  std::lock_guard<std::mutex> lock(mutex);
  if (!recognizers.count(value)) unexpected("recognizer double free");
  for (auto *stream : streams) if (stream->recognizer == value) {
    events.push_back("invalid_recognizer_destroy_with_live_stream:" + std::to_string(stream->id));
    std::fprintf(stderr, "J075 recognizer destroyed with live stream %d\n", stream->id);
  }
  events.push_back("recognizer_destroy:" + std::to_string(value->id)); recognizers.erase(value); delete value;
}
const SherpaOnnxOnlineStream *SherpaOnnxCreateOnlineStream(const SherpaOnnxOnlineRecognizer *recognizer) {
  std::lock_guard<std::mutex> lock(mutex);
  if (!recognizers.count(recognizer)) unexpected("stream create with dead recognizer");
  if (failCreate) { failCreate = false; events.push_back("stream_create_refused"); return nullptr; }
  auto *value = new SherpaOnnxOnlineStream{recognizer, ++sequence}; streams.insert(value);
  events.push_back("stream_create:" + std::to_string(value->id)); return value;
}
void SherpaOnnxDestroyOnlineStream(const SherpaOnnxOnlineStream *value) {
  std::lock_guard<std::mutex> lock(mutex); requireStream(value);
  events.push_back("stream_destroy:" + std::to_string(value->id)); streams.erase(value); ++destroyed; delete value;
}
void SherpaOnnxOnlineStreamAcceptWaveform(const SherpaOnnxOnlineStream *stream, int32_t rate, const float *, int32_t n) {
  std::lock_guard<std::mutex> lock(mutex); requireStream(stream);
  if (rate <= 0 || n <= 0) unexpected("invalid waveform");
  stream->ready = true;
  events.push_back("accept:" + std::to_string(stream->id));
}
int32_t SherpaOnnxIsOnlineStreamReady(const SherpaOnnxOnlineRecognizer *recognizer, const SherpaOnnxOnlineStream *stream) {
  std::lock_guard<std::mutex> lock(mutex); requireStream(stream);
  if (stream->recognizer != recognizer) unexpected("wrong recognizer");
  return stream->ready;
}
void SherpaOnnxDecodeOnlineStream(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *stream) {
  std::unique_lock<std::mutex> lock(mutex); requireStream(stream);
  events.push_back("decode_entry:" + std::to_string(stream->id)); entered = true; condition.notify_all();
  if (!condition.wait_for(lock, std::chrono::seconds(10), [] { return !held; })) unexpected("decode barrier timeout");
  requireStream(stream); stream->ready = false; events.push_back("decode_return:" + std::to_string(stream->id));
}
const SherpaOnnxOnlineRecognizerResult *SherpaOnnxGetOnlineStreamResult(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *stream) {
  std::lock_guard<std::mutex> lock(mutex); requireStream(stream);
  auto *result = new SherpaOnnxOnlineRecognizerResult{}; result->text = "fixture transcript"; return result;
}
void SherpaOnnxDestroyOnlineRecognizerResult(const SherpaOnnxOnlineRecognizerResult *result) { delete result; }
int32_t SherpaOnnxOnlineStreamIsEndpoint(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *stream) {
  std::lock_guard<std::mutex> lock(mutex); requireStream(stream); return 0;
}
void SherpaOnnxOnlineStreamReset(const SherpaOnnxOnlineRecognizer *, const SherpaOnnxOnlineStream *) { unexpected("endpoint reset"); }
void SherpaOnnxOnlineStreamInputFinished(const SherpaOnnxOnlineStream *stream) {
  std::lock_guard<std::mutex> lock(mutex); requireStream(stream); events.push_back("input_finished:" + std::to_string(stream->id));
}

// These symbols link the full production translation unit. No selected schedule may do TTS or write audio.
const SherpaOnnxOfflineTts *SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig *) { unexpected("TTS create"); }
void SherpaOnnxDestroyOfflineTts(const SherpaOnnxOfflineTts *) { unexpected("TTS destroy"); }
int32_t SherpaOnnxOfflineTtsSampleRate(const SherpaOnnxOfflineTts *) { unexpected("TTS sample rate"); }
int32_t SherpaOnnxOfflineTtsNumSpeakers(const SherpaOnnxOfflineTts *) { unexpected("TTS voices"); }
const SherpaOnnxGeneratedAudio *SherpaOnnxOfflineTtsGenerateWithConfig(const SherpaOnnxOfflineTts *, const char *, const SherpaOnnxGenerationConfig *, SherpaOnnxGeneratedAudioProgressCallbackWithArg, void *) { unexpected("TTS generation"); }
void SherpaOnnxDestroyOfflineTtsGeneratedAudio(const SherpaOnnxGeneratedAudio *) { unexpected("TTS audio free"); }
int32_t SherpaOnnxWriteWave(const float *, int32_t, int32_t, const char *) { unexpected("wave write"); }

JNIEXPORT jboolean JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_bind(JNIEnv *env, jobject) {
  // The optional entries do not exist in the old source. All public callbacks are still tested unchanged.
  jclass cls = env->FindClass("dev/happier/sherpa/HappierSherpaNativeJni");
  if (!cls) return JNI_FALSE;
  Dl_info identity{};
  if (!dladdr(reinterpret_cast<void *>(unexpected), &identity) || !identity.dli_fname) unexpected("fixture library path");
  void *library = dlopen(identity.dli_fname, RTLD_NOW | RTLD_NOLOAD);
  if (!library) unexpected("loaded fixture library identity");
  realCreate = reinterpret_cast<CreateOwner>(dlsym(library, "Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeCreateAsrOwner"));
  realDispose = reinterpret_cast<DisposeOwner>(dlsym(library, "Java_dev_happier_sherpa_HappierSherpaNativeJni_nativeDestroyAsrOwner"));
  if (!realCreate && !realDispose) return JNI_FALSE;
  if (!realCreate || !realDispose) unexpected("partial owner symbols");
  if (!env->GetMethodID(cls, "nativeCreateAsrOwner", "()J") || !env->GetMethodID(cls, "nativeDestroyAsrOwner", "(J)V")) return JNI_FALSE;
  JNINativeMethod methods[] = {
    {const_cast<char *>("nativeCreateAsrOwner"), const_cast<char *>("()J"), reinterpret_cast<void *>(createOwner)},
    {const_cast<char *>("nativeDestroyAsrOwner"), const_cast<char *>("(J)V"), reinterpret_cast<void *>(disposeOwner)}
  };
  if (env->RegisterNatives(cls, methods, 2) != 0) return JNI_FALSE;
  return JNI_TRUE;
}
JNIEXPORT jstring JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_snapshot(JNIEnv *env, jobject) {
  std::lock_guard<std::mutex> lock(mutex); std::ostringstream out;
  out << "{\"boundary\":\"j075-inert-sherpa-v1\",\"liveStreams\":" << streams.size()
      << ",\"destroyedStreams\":" << destroyed << ",\"liveRecognizers\":" << recognizers.size() << ",\"events\":[";
  for (size_t i = 0; i < events.size(); ++i) { if (i) out << ','; out << '"' << events[i] << '"'; }
  out << "]}"; return env->NewStringUTF(out.str().c_str());
}
#define COUNT_METHOD(name, expression) JNIEXPORT jint JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_##name(JNIEnv *, jobject) { std::lock_guard<std::mutex> lock(mutex); return static_cast<jint>(expression); }
COUNT_METHOD(liveStreams, streams.size())
COUNT_METHOD(destroyedStreams, destroyed)
COUNT_METHOD(liveRecognizers, recognizers.size())
COUNT_METHOD(ownerCreates, creates)
COUNT_METHOD(ownerDisposals, disposals)
JNIEXPORT void JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_failNextCreate(JNIEnv *, jobject) { std::lock_guard<std::mutex> lock(mutex); failCreate = true; }
JNIEXPORT void JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_failNextDisposal(JNIEnv *, jobject) { std::lock_guard<std::mutex> lock(mutex); failDisposal = true; }
JNIEXPORT void JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_holdDecode(JNIEnv *, jobject) { std::lock_guard<std::mutex> lock(mutex); held = true; entered = false; }
JNIEXPORT jboolean JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_awaitDecode(JNIEnv *, jobject) {
  std::unique_lock<std::mutex> lock(mutex); return condition.wait_for(lock, std::chrono::seconds(10), [] { return entered; }) ? JNI_TRUE : JNI_FALSE;
}
JNIEXPORT void JNICALL Java_dev_happier_sherpa_fixture_NativeProbe_releaseDecode(JNIEnv *, jobject) { std::lock_guard<std::mutex> lock(mutex); held = false; condition.notify_all(); }
}  // extern "C"
