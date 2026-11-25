#include <napi.h>
#include <windows.h>
#include <dwmapi.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <atomic>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <map>
#include <set>
#include <string>
#include <cmath>

#ifdef __MINGW32__
#include <delayimp.h>
static FARPROC WINAPI PawTalkDelayLoad(unsigned event, PDelayLoadInfo info) {
  if(event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0)
    return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
  return nullptr;
}
extern "C" PfnDliHook __pfnDliNotifyHook2 = PawTalkDelayLoad;
#endif

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
static std::atomic<DWORD> hookThreadId{0};
static std::atomic<int> pttKey{VK_XBUTTON1};
static std::atomic<bool> keyDown{false};
static std::thread hookThread;
static Napi::ThreadSafeFunction callback;
static std::mutex hookMutex;
static std::condition_variable hookReady;
static bool hookStarted = false, hookOK = false;

static void Emit(bool down) {
  if (keyDown.exchange(down) == down) return;
  bool* value = new bool(down);
  auto status = callback.NonBlockingCall(value, [](Napi::Env env, Napi::Function fn, bool* value) {
    fn.Call({Napi::Boolean::New(env, *value)}); delete value;
  });
  if (status != napi_ok) delete value;
}
static LRESULT CALLBACK Keyboard(int code, WPARAM message, LPARAM raw) {
  if (code == HC_ACTION) {
    auto* data = reinterpret_cast<KBDLLHOOKSTRUCT*>(raw);
    int vk = static_cast<int>(data->vkCode);
    if (vk == VK_SHIFT) vk = MapVirtualKeyW(data->scanCode, MAPVK_VSC_TO_VK_EX);
    if (vk == VK_CONTROL) vk = (data->flags & LLKHF_EXTENDED) ? VK_RCONTROL : VK_LCONTROL;
    if (vk == VK_MENU) vk = (data->flags & LLKHF_EXTENDED) ? VK_RMENU : VK_LMENU;
    if (vk == pttKey.load()) {
      if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) Emit(true);
      if (message == WM_KEYUP || message == WM_SYSKEYUP) Emit(false);
    }
  }
  return CallNextHookEx(nullptr, code, message, raw);
}
static LRESULT CALLBACK Mouse(int code, WPARAM message, LPARAM raw) {
  if (code == HC_ACTION && (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP)) {
    auto* data = reinterpret_cast<MSLLHOOKSTRUCT*>(raw);
    int vk = HIWORD(data->mouseData) == XBUTTON1 ? VK_XBUTTON1 : VK_XBUTTON2;
    if (pttKey.load() == vk) Emit(message == WM_XBUTTONDOWN);
  }
  return CallNextHookEx(nullptr, code, message, raw);
}
static void StopHook() {
  DWORD id = hookThreadId.load();
  if (id) PostThreadMessageW(id, WM_QUIT, 0, 0);
  if (hookThread.joinable()) hookThread.join();
  hookThreadId = 0;
}

struct SavedSession {
  ComPtr<ISimpleAudioVolume> volume;
  float original = 1;
  float applied = 1;
};
class Ducking {
  std::thread worker;
  std::mutex mutex;
  std::condition_variable wake;
  float requested = 1;
  Clock::time_point renewed = Clock::now();
  bool stopping = false;
  std::map<std::wstring, SavedSession> saved;
  static std::set<DWORD> OurProcesses() {
    std::map<DWORD,DWORD> parents;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot != INVALID_HANDLE_VALUE) {
      PROCESSENTRY32W item{}; item.dwSize = sizeof(item);
      if (Process32FirstW(snapshot, &item)) do { parents[item.th32ProcessID] = item.th32ParentProcessID; } while(Process32NextW(snapshot, &item));
      CloseHandle(snapshot);
    }
    std::set<DWORD> ours{GetCurrentProcessId()};
    bool added = true;
    while (added) { added = false; for (auto& entry : parents) if (ours.count(entry.second) && ours.insert(entry.first).second) added = true; }
    return ours;
  }
  void Restore() {
    for (auto& entry : saved) {
      float current = 0;
      if (SUCCEEDED(entry.second.volume->GetMasterVolume(&current)) && std::fabs(current - entry.second.applied) < 0.005f)
        entry.second.volume->SetMasterVolume(entry.second.original, nullptr);
    }
    saved.clear();
  }
  void Apply(IMMDeviceEnumerator* enumerator, float factor) {
    auto ours = OurProcesses();
    ComPtr<IMMDeviceCollection> devices;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) return;
    UINT count = 0; devices->GetCount(&count);
    for (UINT d = 0; d < count; ++d) {
      ComPtr<IMMDevice> device; if (FAILED(devices->Item(d, &device))) continue;
      ComPtr<IAudioSessionManager2> manager;
      if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(manager.GetAddressOf())))) continue;
      ComPtr<IAudioSessionEnumerator> sessions; if (FAILED(manager->GetSessionEnumerator(&sessions))) continue;
      int size = 0; sessions->GetCount(&size);
      for (int i = 0; i < size; ++i) {
        ComPtr<IAudioSessionControl> control; if (FAILED(sessions->GetSession(i, &control))) continue;
        ComPtr<IAudioSessionControl2> details; if (FAILED(control.As(&details))) continue;
        DWORD pid = 0; if (FAILED(details->GetProcessId(&pid)) || !pid || ours.count(pid)) continue;
        AudioSessionState state; if (FAILED(details->GetState(&state)) || state == AudioSessionStateExpired) continue;
        LPWSTR identifier = nullptr; if (FAILED(details->GetSessionInstanceIdentifier(&identifier))) continue;
        std::wstring key(identifier); CoTaskMemFree(identifier);
        ComPtr<ISimpleAudioVolume> volume; if (FAILED(control.As(&volume))) continue;
        float current = 0; if (FAILED(volume->GetMasterVolume(&current))) continue;
        auto found = saved.find(key);
        if (found == saved.end()) {
          SavedSession entry; entry.volume = volume; entry.original = current; entry.applied = current;
          found = saved.emplace(key, std::move(entry)).first;
        } else if (std::fabs(current - found->second.applied) > 0.005f) {
          // A manual mixer change becomes the new baseline; never undo the user's adjustment.
          found->second.original = current;
        }
        float target = found->second.original * factor;
        if (SUCCEEDED(volume->SetMasterVolume(target, nullptr))) found->second.applied = target;
      }
    }
  }
  void Run() {
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) return;
    ComPtr<IMMDeviceEnumerator> enumerator;
    CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    std::unique_lock<std::mutex> lock(mutex);
    while (!stopping) {
      float factor = Clock::now() - renewed > std::chrono::seconds(2) ? 1 : requested;
      lock.unlock();
      if (factor >= 0.999f) Restore(); else if (enumerator) Apply(enumerator.Get(), factor);
      lock.lock(); wake.wait_for(lock, std::chrono::milliseconds(250));
    }
    lock.unlock(); Restore(); enumerator.Reset(); CoUninitialize();
  }
public:
  Ducking() { worker = std::thread([this] { Run(); }); }
  void Set(float factor) { std::lock_guard<std::mutex> lock(mutex); requested = factor; renewed = Clock::now(); wake.notify_one(); }
  ~Ducking() { { std::lock_guard<std::mutex> lock(mutex); stopping = true; wake.notify_one(); } if(worker.joinable()) worker.join(); }
};
static Ducking* ducking = nullptr;

struct CaptureWindowList {
  Napi::Env env;
  Napi::Array windows;
  uint32_t count = 0;
};

static BOOL CALLBACK ListCaptureWindow(HWND window, LPARAM context) {
  auto& list = *reinterpret_cast<CaptureWindowList*>(context);
  const auto style = GetWindowLongPtrW(window, GWL_EXSTYLE);
  if (!IsWindowVisible(window) || (style & WS_EX_TOOLWINDOW) ||
      (GetWindow(window, GW_OWNER) && !(style & WS_EX_APPWINDOW))) return TRUE;
  DWORD cloaked = 0, affinity = 0;
  if ((SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) ||
      (GetWindowDisplayAffinity(window, &affinity) && affinity)) return TRUE;
  wchar_t title[512];
  const int length = GetWindowTextW(window, title, 512);
  if (!length) return TRUE;
  DWORD process = 0;
  GetWindowThreadProcessId(window, &process);
  RECT bounds{};
  DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds));
  MONITORINFO monitor{sizeof(MONITORINFO)};
  GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor);
  auto entry = Napi::Object::New(list.env);
  entry.Set("handle", std::to_string(reinterpret_cast<uintptr_t>(window)));
  entry.Set("process", process);
  entry.Set("title", Napi::String::New(list.env, reinterpret_cast<const char16_t*>(title), length));
  entry.Set("minimized", IsIconic(window) != FALSE);
  entry.Set("height", bounds.bottom - bounds.top);
  entry.Set("monitorHeight", monitor.rcMonitor.bottom - monitor.rcMonitor.top);
  list.windows.Set(list.count++, entry);
  return list.count < 256;
}

void RegisterApplicationAudio(Napi::Env env, Napi::Object exports);

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  RegisterApplicationAudio(env, exports);
  exports.Set("listCaptureWindows", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    CaptureWindowList list{info.Env(), Napi::Array::New(info.Env())};
    EnumWindows(ListCaptureWindow, reinterpret_cast<LPARAM>(&list));
    return list.windows;
  }));
  exports.Set("captureWindowMinimized", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    auto env = info.Env();
    if (info.Length() != 2 || !info[0].IsNumber() || !info[1].IsNumber()) return env.Undefined();
    const HWND window = reinterpret_cast<HWND>(static_cast<intptr_t>(info[0].As<Napi::Number>().Int64Value()));
    DWORD process = 0;
    if (!GetWindowThreadProcessId(window, &process) || process != info[1].As<Napi::Number>().Uint32Value()) return env.Undefined();
    return Napi::Boolean::New(env, IsIconic(window) != FALSE);
  }));
  exports.Set("startPtt", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() != 1 || !info[0].IsFunction()) { Napi::TypeError::New(env,"Expected callback").ThrowAsJavaScriptException(); return; }
    if (hookThread.joinable()) return;
    callback = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "ptt", 0, 1);
    callback.Unref(env);
    { std::lock_guard<std::mutex> lock(hookMutex); hookStarted = false; hookOK = false; }
    hookThread = std::thread([] {
      MSG message; PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
      hookThreadId = GetCurrentThreadId();
      HHOOK keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Keyboard, GetModuleHandleW(nullptr), 0);
      HHOOK mouse = SetWindowsHookExW(WH_MOUSE_LL, Mouse, GetModuleHandleW(nullptr), 0);
      { std::lock_guard<std::mutex> lock(hookMutex); hookOK = keyboard && mouse; hookStarted = true; hookReady.notify_one(); }
      if (keyboard && mouse) {
        SetTimer(nullptr, 1, 100, nullptr);
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
          if (message.message == WM_TIMER && keyDown.load() && !(GetAsyncKeyState(pttKey.load()) & 0x8000)) Emit(false);
          if (message.message == WM_APP + 1) Emit(false);
          TranslateMessage(&message); DispatchMessageW(&message);
        }
        KillTimer(nullptr,1);
      }
      Emit(false);
      if (keyboard) UnhookWindowsHookEx(keyboard); if(mouse) UnhookWindowsHookEx(mouse);
      callback.Release();
    });
    std::unique_lock<std::mutex> lock(hookMutex); hookReady.wait(lock, [] { return hookStarted; });
    if (!hookOK) { lock.unlock(); StopHook(); Napi::Error::New(env,"Cannot register Windows input hooks").ThrowAsJavaScriptException(); }
  }));
  exports.Set("setPttKey", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    if (info.Length()!=1 || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(),"Expected virtual key").ThrowAsJavaScriptException();return; }
    int key=info[0].As<Napi::Number>().Int32Value();
    if (key < 1 || key > 254) { Napi::RangeError::New(info.Env(),"Invalid virtual key").ThrowAsJavaScriptException();return; }
    pttKey = key; if(hookThreadId.load()) PostThreadMessageW(hookThreadId.load(), WM_APP+1, 0, 0);
  }));
  exports.Set("stopPtt", Napi::Function::New(env, [](const Napi::CallbackInfo&) { StopHook(); }));
  exports.Set("shutdown", Napi::Function::New(env, [](const Napi::CallbackInfo&) { StopHook(); delete ducking; ducking=nullptr; }));
  exports.Set("setDucking", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    if(info.Length()!=1 || !info[0].IsNumber()) { Napi::TypeError::New(info.Env(),"Expected volume factor").ThrowAsJavaScriptException();return; }
    double value = info[0].As<Napi::Number>().DoubleValue();
    if(!std::isfinite(value) || value<0 || value>1) { Napi::RangeError::New(info.Env(),"Invalid volume factor").ThrowAsJavaScriptException();return; }
    if(!ducking) ducking = new Ducking(); ducking->Set(static_cast<float>(value));
  }));
  env.AddCleanupHook([] { StopHook(); delete ducking; ducking=nullptr; });
  return exports;
}
NODE_API_MODULE(pawtalk, Init)
