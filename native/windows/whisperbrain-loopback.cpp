// whisperbrain-loopback: captures audio for WhisperBrain and writes it to stdout as raw PCM (s16le, 16 kHz, mono).
//
//   whisperbrain-loopback system [--pid N | --exe NAME]
//                         the audio of that process and its children (WASAPI process loopback, Windows build 20348+;
//                         --exe picks the main process of that program), without either: everything the default output plays
//   whisperbrain-loopback probe       one line of JSON: what this PC can do
//   whisperbrain-loopback selftest    converts a synthetic tone and checks the result; needs no audio hardware
//
// Exit codes: 0 stopped normally, 1 failed, 2 could not start (nothing to follow, not supported), 3 the followed process
// ended. The text on stderr says why. WhisperBrain reads this as it reads pw-record on Linux, and when this program ends on
// its own while following a process it carries on with the whole output.
//
// NOTE: written without access to Windows. CI builds it and runs `selftest`; capturing needs a real machine and a call.
//
// Build (x64 Native Tools prompt):  cl /EHsc /O2 whisperbrain-loopback.cpp ole32.lib mmdevapi.lib /Fe:whisperbrain-loopback.exe

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <io.h>
#include <fcntl.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static const double kOutRate = 16000.0;

[[noreturn]] static void Fail(const std::string& message, int code = 1) {
    fprintf(stderr, "%s\n", message.c_str());
    exit(code);
}

// ---- conversion: whatever the device gives (any rate, any channel count, 16-bit or float) -> 16 kHz mono s16le ----

class Converter {
public:
    Converter(int rate, int channels, bool isFloat, int bits) : rate_(rate), channels_(channels), isFloat_(isFloat), bits_(bits) {}

    // One packet of interleaved frames in, samples appended to `out`. Linear interpolation between mono frames.
    void Convert(const uint8_t* data, size_t frames, std::vector<int16_t>& out) {
        for (size_t i = 0; i < frames; i++) {
            float mono = 0;
            for (int c = 0; c < channels_; c++) mono += Sample(data, i * channels_ + c);
            mono /= (float)channels_;
            // output samples whose position falls between the previous mono frame and this one
            while (pos_ < 1.0) {
                float v = prev_ + (mono - prev_) * (float)pos_;
                if (v > 1.0f) v = 1.0f; else if (v < -1.0f) v = -1.0f;
                out.push_back((int16_t)lrintf(v * 32767.0f));
                pos_ += (double)rate_ / kOutRate;
            }
            pos_ -= 1.0;
            prev_ = mono;
        }
    }

private:
    float Sample(const uint8_t* data, size_t index) const {
        if (isFloat_) return reinterpret_cast<const float*>(data)[index];
        if (bits_ == 16) return reinterpret_cast<const int16_t*>(data)[index] / 32768.0f;
        if (bits_ == 32) return reinterpret_cast<const int32_t*>(data)[index] / 2147483648.0f;
        if (bits_ == 24) { const uint8_t* p = data + index * 3; int32_t v = (p[0] << 8) | (p[1] << 16) | ((int32_t)p[2] << 24); return v / 2147483648.0f; }
        return 0;
    }
    int rate_, channels_; bool isFloat_; int bits_;
    double pos_ = 0;
    float prev_ = 0;
};

static void Write(const std::vector<int16_t>& samples) {
    if (samples.empty()) return;
    size_t bytes = samples.size() * sizeof(int16_t);
    if (fwrite(samples.data(), 1, bytes, stdout) != bytes) exit(0);   // the reader is gone
    fflush(stdout);
}

// ---- process lookup ----

static DWORD FindMainProcess(const std::string& exe) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32 e; e.dwSize = sizeof(e);
    std::vector<PROCESSENTRY32> same;
    if (Process32First(snap, &e)) do { if (_stricmp(e.szExeFile, exe.c_str()) == 0) same.push_back(e); } while (Process32Next(snap, &e));
    CloseHandle(snap);
    // the main process is the one whose parent is not another process of the same program (the rest are its helpers)
    for (const auto& p : same) {
        bool childOfSame = false;
        for (const auto& q : same) if (q.th32ProcessID == p.th32ParentProcessID) childOfSame = true;
        if (!childOfSame) return p.th32ProcessID;
    }
    return 0;
}

static DWORD BuildNumber() {
    typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto fn = ntdll ? reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion")) : nullptr;
    RTL_OSVERSIONINFOW v = {}; v.dwOSVersionInfoSize = sizeof(v);
    return fn && fn(&v) == 0 ? v.dwBuildNumber : 0;
}

// ---- activating the process loopback client (asynchronous COM call) ----

class ActivateHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    ActivateHandler() { done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
    ~ActivateHandler() { CloseHandle(done_); if (client) client->Release(); }
    STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        else if (riid == __uuidof(IAgileObject)) *out = static_cast<IAgileObject*>(this);
        else { *out = nullptr; return E_NOINTERFACE; }
        AddRef(); return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
    STDMETHODIMP_(ULONG) Release() override { ULONG n = InterlockedDecrement(&refs_); if (!n) delete this; return n; }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT activation = E_FAIL; IUnknown* unknown = nullptr;
        HRESULT hr = op->GetActivateResult(&activation, &unknown);
        if (SUCCEEDED(hr) && SUCCEEDED(activation) && unknown) { unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client)); result = S_OK; }
        else result = FAILED(hr) ? hr : activation;
        if (unknown) unknown->Release();
        SetEvent(done_); return S_OK;
    }
    bool Wait(DWORD ms) { return WaitForSingleObject(done_, ms) == WAIT_OBJECT_0; }
    IAudioClient* client = nullptr;
    HRESULT result = E_FAIL;
private:
    LONG refs_ = 1;
    HANDLE done_;
};

// ---- capture loop shared by both routes ----

static void Capture(IAudioClient* client, const WAVEFORMATEX* wf, DWORD followedPid) {
    bool isFloat = wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) isFloat = IsEqualGUID(reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf)->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    Converter converter((int)wf->nSamplesPerSec, wf->nChannels, isFloat, wf->wBitsPerSample);
    IAudioCaptureClient* capture = nullptr;
    if (FAILED(client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture)))) Fail("could not get the capture service", 2);
    if (FAILED(client->Start())) Fail("could not start capturing", 2);

    HANDLE followed = followedPid ? OpenProcess(SYNCHRONIZE, FALSE, followedPid) : nullptr;
    LARGE_INTEGER freq, t0; QueryPerformanceFrequency(&freq); QueryPerformanceCounter(&t0);
    uint64_t emitted = 0;
    std::vector<int16_t> out;
    for (;;) {
        if (followed && WaitForSingleObject(followed, 0) == WAIT_OBJECT_0) Fail("the followed process ended", 3);
        UINT32 packet = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
            out.clear();
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) out.assign((size_t)((double)frames * kOutRate / wf->nSamplesPerSec), 0);
            else converter.Convert(data, frames, out);
            capture->ReleaseBuffer(frames);
            emitted += out.size();
            Write(out);
        }
        // Windows delivers nothing while nothing plays; the recording's clock counts samples, so the quiet is sent as zeros
        LARGE_INTEGER now; QueryPerformanceCounter(&now);
        uint64_t due = (uint64_t)((double)(now.QuadPart - t0.QuadPart) / freq.QuadPart * kOutRate);
        if (due > emitted + 320) { out.assign((size_t)(due - emitted), 0); emitted += out.size(); Write(out); }
        Sleep(10);
    }
}

// ---- the two routes ----

static void CaptureProcess(DWORD pid) {
    if (BuildNumber() < 20348) Fail("per-process capture needs Windows build 20348 or later", 2);
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT variant = {}; variant.vt = VT_BLOB; variant.blob.cbSize = sizeof(params); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    ActivateHandler* handler = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, handler, &op);
    if (FAILED(hr) || !handler->Wait(5000) || FAILED(handler->result) || !handler->client) Fail("could not capture process " + std::to_string(pid) + " (is it playing audio?)", 2);
    if (op) op->Release();
    // a process loopback client has no mix format of its own: ask for the one we want and let Windows convert
    WAVEFORMATEX wf = {};
    wf.wFormatTag = WAVE_FORMAT_PCM; wf.nChannels = 1; wf.nSamplesPerSec = 16000; wf.wBitsPerSample = 16;
    wf.nBlockAlign = wf.nChannels * wf.wBitsPerSample / 8; wf.nAvgBytesPerSec = wf.nSamplesPerSec * wf.nBlockAlign;
    hr = handler->client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 2000000, 0, &wf, nullptr);
    if (FAILED(hr)) Fail("could not start the process capture (0x" + std::to_string((unsigned)hr) + ")", 2);
    Capture(handler->client, &wf, pid);
}

static void CaptureEndpoint() {
    IMMDeviceEnumerator* enumerator = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator)))) Fail("no audio system", 2);
    IMMDevice* device = nullptr;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) Fail("no default output device", 2);
    IAudioClient* client = nullptr;
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client)))) Fail("could not open the output device", 2);
    WAVEFORMATEX* mix = nullptr;
    if (FAILED(client->GetMixFormat(&mix))) Fail("could not read the output format", 2);
    if (FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, mix, nullptr))) Fail("could not capture the output device", 2);
    Capture(client, mix, 0);
}

// ---- self test: a 48 kHz stereo float tone must come out as 16 kHz mono s16 with the same pitch ----

[[noreturn]] static void SelfTest() {
    const int rate = 48000; const double hz = 440.0;
    std::vector<float> tone((size_t)rate * 2);
    for (int i = 0; i < rate; i++) tone[2 * i] = tone[2 * i + 1] = (float)(0.4 * std::sin(2 * 3.14159265358979 * hz * i / rate));
    Converter converter(rate, 2, true, 32);
    std::vector<int16_t> out;
    // in packets of 480 frames, as the device delivers them
    for (size_t at = 0; at < (size_t)rate; at += 480) converter.Convert(reinterpret_cast<const uint8_t*>(&tone[at * 2]), 480, out);
    if (std::abs((long)out.size() - 16000) > 40) Fail("selftest: " + std::to_string(out.size()) + " samples for one second of tone");
    auto power = [&](double f) { double re = 0, im = 0; for (size_t i = 0; i < out.size(); i++) { double x = out[i] / 32768.0; re += x * std::cos(2 * 3.14159265358979 * f * i / kOutRate); im += x * std::sin(2 * 3.14159265358979 * f * i / kOutRate); } return re * re + im * im; };
    double share = power(hz) / (power(hz) + power(1000) + power(250) + 1e-9);
    if (share < 0.9) Fail("selftest: the tone came out at the wrong pitch (" + std::to_string(share) + ")");
    printf("selftest ok: %zu samples, 440 Hz share %.2f\n", out.size(), share);
    exit(0);
}

int main(int argc, char** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    std::string mode = argc > 1 ? argv[1] : "";
    auto value = [&](const char* flag) -> const char* { for (int i = 2; i + 1 < argc; i++) if (!strcmp(argv[i], flag)) return argv[i + 1]; return nullptr; };

    if (mode == "selftest") SelfTest();
    if (mode == "probe") { printf("{\"processLoopback\":%s,\"endpoint\":true,\"build\":%lu}\n", BuildNumber() >= 20348 ? "true" : "false", BuildNumber()); return 0; }
    if (mode != "system") Fail("usage: whisperbrain-loopback system [--pid N | --exe NAME] | probe | selftest", 64);

    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) Fail("could not start COM", 1);
    DWORD pid = 0;
    if (const char* p = value("--pid")) { pid = (DWORD)strtoul(p, nullptr, 10); if (!pid) Fail("bad --pid", 2); }
    else if (const char* e = value("--exe")) { pid = FindMainProcess(e); if (!pid) Fail(std::string(e) + " is not running", 2); }
    if (pid) CaptureProcess(pid); else CaptureEndpoint();
    return 0;
}
