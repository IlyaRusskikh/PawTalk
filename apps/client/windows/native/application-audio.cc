#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
// The portable MinGW SDK lacks these declarations from the process-loopback ABI.
constexpr auto VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = L"VAD\\Process_Loopback";
constexpr DWORD AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
constexpr DWORD PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
struct AUDIOCLIENT_ACTIVATION_PARAMS {
  DWORD ActivationType;
  struct { DWORD TargetProcessId; DWORD ProcessLoopbackMode; } ProcessLoopbackParams;
};
#endif
#include <wrl/client.h>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>

namespace {
using Microsoft::WRL::ComPtr;
constexpr DWORD sampleRate = 44100;
constexpr size_t channels = 2;
constexpr size_t maxSamples = (sampleRate / 8) * channels;

class Event {
public:
  const HANDLE handle;
  explicit Event(bool manualReset = true) : handle(CreateEventW(nullptr, manualReset, FALSE, nullptr)) {}
  ~Event() { if (handle) CloseHandle(handle); }
};

class Activation final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  std::atomic<ULONG> refs{1};
public:
  Event done;
  ComPtr<IAudioClient> client;
  AUDIOCLIENT_ACTIVATION_PARAMS options{};
  PROPVARIANT params{};

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid == IID_IUnknown || iid == __uuidof(IActivateAudioInterfaceCompletionHandler))
      *value = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (iid == __uuidof(IAgileObject)) *value = static_cast<IAgileObject*>(this);
    else return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --refs;
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT status = E_FAIL;
    ComPtr<IUnknown> result;
    if (SUCCEEDED(operation->GetActivateResult(&status, &result)) && SUCCEEDED(status) && result)
      result.As(&client);
    SetEvent(done.handle);
    return S_OK;
  }
};

class ApplicationAudio {
  Event stopped;
  std::thread worker;
  std::mutex queueLock;
  std::deque<int16_t> queue;
  enum class State { Starting, Running, Ended };
  std::atomic<State> state{State::Starting};

  bool ReadPackets(IAudioCaptureClient& capture) {
    UINT32 frames = 0;
    while (WaitForSingleObject(stopped.handle, 0) == WAIT_TIMEOUT) {
      if (FAILED(capture.GetNextPacketSize(&frames))) return false;
      if (!frames) return true;
      BYTE* buffer = nullptr;
      DWORD flags = 0;
      if (FAILED(capture.GetBuffer(&buffer, &frames, &flags, nullptr, nullptr))) return false;
      {
        std::lock_guard<std::mutex> lock(queueLock);
        const size_t count = std::min<size_t>(frames * channels, maxSamples);
        if (queue.size() + count > maxSamples)
          queue.erase(queue.begin(), queue.begin() + (queue.size() + count - maxSamples));
        if (!buffer || (flags & AUDCLNT_BUFFERFLAGS_SILENT)) queue.insert(queue.end(), count, 0);
        else {
          auto end = reinterpret_cast<const int16_t*>(buffer) + frames * channels;
          queue.insert(queue.end(), end - count, end);
        }
      }
      if (FAILED(capture.ReleaseBuffer(frames))) return false;
    }
    return false;
  }

  void Capture(DWORD process) {
    const auto target = OpenProcess(SYNCHRONIZE, FALSE, process);
    if (!target) return;
    const auto close = [](void* handle) { CloseHandle(handle); };
    const std::unique_ptr<void, decltype(close)> processHandle(target, close);
    if (WaitForSingleObject(target, 0) != WAIT_TIMEOUT) return;

    ComPtr<Activation> activation;
    activation.Attach(new Activation());
    if (!activation->done.handle) return;
    activation->options.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation->options.ProcessLoopbackParams.TargetProcessId = process;
    activation->options.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    activation->params.vt = VT_BLOB;
    activation->params.blob.cbSize = sizeof(activation->options);
    activation->params.blob.pBlobData = reinterpret_cast<BYTE*>(&activation->options);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    if (FAILED(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activation->params,
                                           activation.Get(), &operation))) return;
    const HANDLE startEvents[]{stopped.handle, target, activation->done.handle};
    if (WaitForMultipleObjects(3, startEvents, FALSE, 4000) != WAIT_OBJECT_0 + 2 || !activation->client) return;

    Event samplesReady(false);
    auto& client = *activation->client.Get();
    WAVEFORMATEX format{WAVE_FORMAT_PCM, channels, sampleRate, sampleRate * channels * sizeof(int16_t),
                       channels * sizeof(int16_t), 16, 0};
    ComPtr<IAudioCaptureClient> capture;
    if (!samplesReady.handle || FAILED(client.Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        0, 0, &format, nullptr)) || FAILED(client.GetService(IID_PPV_ARGS(&capture))) ||
        FAILED(client.SetEventHandle(samplesReady.handle)) || FAILED(client.Start())) return;
    state = State::Running;
    const HANDLE captureEvents[]{stopped.handle, target, samplesReady.handle};
    while (WaitForMultipleObjects(3, captureEvents, FALSE, INFINITE) == WAIT_OBJECT_0 + 2) {
      if (!ReadPackets(*capture.Get())) break;
    }
    client.Stop();
  }

public:
  bool Start(DWORD process) {
    if (!stopped.handle) return false;
    worker = std::thread([this, process] {
      if (SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
        Capture(process);
        CoUninitialize();
      }
      state = State::Ended;
    });
    return true;
  }
  ~ApplicationAudio() {
    if (worker.joinable()) { SetEvent(stopped.handle); worker.join(); }
  }
  Napi::Value Read(Napi::Env env) {
    const auto current = state.load();
    if (current == State::Ended) return env.Null();
    if (current == State::Starting) return env.Undefined();
    std::lock_guard<std::mutex> lock(queueLock);
    auto pcm = Napi::Buffer<int16_t>::New(env, queue.size());
    std::copy(queue.begin(), queue.end(), pcm.Data());
    queue.clear();
    return pcm;
  }
};

std::unique_ptr<ApplicationAudio> capture;
}

void RegisterApplicationAudio(Napi::Env env, Napi::Object exports) {
  exports.Set("startApplicationAudio", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    auto env = info.Env();
    const DWORD process = info.Length() == 1 && info[0].IsNumber() ? info[0].As<Napi::Number>().Uint32Value() : 0;
    if (!process || process == GetCurrentProcessId() || capture) return Napi::Boolean::New(env, false);
    auto next = std::make_unique<ApplicationAudio>();
    if (!next->Start(process)) return Napi::Boolean::New(env, false);
    capture = std::move(next);
    return Napi::Boolean::New(env, true);
  }));
  exports.Set("readApplicationAudio", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    return capture ? capture->Read(info.Env()) : info.Env().Null();
  }));
  exports.Set("stopApplicationAudio", Napi::Function::New(env, [](const Napi::CallbackInfo&) { capture.reset(); }));
  env.AddCleanupHook([] { capture.reset(); });
}
