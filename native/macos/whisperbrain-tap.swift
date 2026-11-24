// whisperbrain-tap: captures audio for WhisperBrain and writes it to stdout as raw PCM (s16le, 16 kHz, mono).
//
//   whisperbrain-tap system [--pid N]   the audio of process N and its children (a Core Audio process tap, macOS 14.2+);
//                                       without --pid, everything that plays except this program
//   whisperbrain-tap mic                the microphone through the system's voice processing (echo cancellation)
//   whisperbrain-tap probe              one line of JSON: what this Mac can do
//   whisperbrain-tap selftest           converts a synthetic tone and checks the result; needs no audio hardware
//
// Exit codes: 0 stopped normally, 1 failed, 2 could not start (nothing to follow, no permission), 3 the followed process
// ended. The text on stderr says why. WhisperBrain reads this as it reads pw-record on Linux, and when this program ends
// on its own while following a process it carries on with the whole output.
//
// NOTE: written without access to a Mac. CI builds it and runs `selftest`; the tap itself needs a real machine, the
// "System Audio Recording" permission and a call to be tried for real.
import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

let outRate = 16000.0

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

// MARK: - conversion: whatever the device gives -> 16 kHz mono s16le

final class Converter {
    private let converter: AVAudioConverter
    private let outFormat: AVAudioFormat
    private let inRate: Double

    init?(from format: AVAudioFormat) {
        guard let out = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: outRate, channels: 1, interleaved: true),
              let c = AVAudioConverter(from: format, to: out) else { return nil }
        converter = c
        outFormat = out
        inRate = format.sampleRate
    }

    // The bytes (s16le) for one buffer of input.
    func convert(_ input: AVAudioPCMBuffer) -> Data {
        let capacity = AVAudioFrameCount(Double(input.frameLength) * outRate / inRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return Data() }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if supplied { inputStatus.pointee = .noDataNow; return nil }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        if status == .error || out.frameLength == 0 { return Data() }
        guard let samples = out.int16ChannelData else { return Data() }
        return Data(bytes: samples[0], count: Int(out.frameLength) * 2)
    }
}

func emit(_ data: Data) {
    if data.isEmpty { return }
    data.withUnsafeBytes { raw in _ = fwrite(raw.baseAddress, 1, data.count, stdout) }
    fflush(stdout)
}

// MARK: - Core Audio helpers

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, as type: T.Type, default value: T) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var result = value
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &result)
    return status == noErr ? result : nil
}

func audioProcesses() -> [(object: AudioObjectID, pid: pid_t)] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &objects) == noErr else { return [] }
    return objects.compactMap { object in
        guard let pid = property(object, kAudioProcessPropertyPID, as: pid_t.self, default: 0), pid > 0 else { return nil }
        return (object, pid)
    }
}

// The process and everything it started (an app's helper processes play audio too: Chrome's audio service, Teams' renderers).
func processTree(of root: pid_t) -> Set<pid_t> {
    var seen: Set<pid_t> = [root]
    var queue = [root]
    while let next = queue.popLast() {
        var buffer = [pid_t](repeating: 0, count: 1024)
        _ = proc_listchildpids(next, &buffer, Int32(buffer.count * MemoryLayout<pid_t>.size))
        for child in buffer where child > 0 && !seen.contains(child) { seen.insert(child); queue.append(child) }
    }
    return seen
}

func defaultOutputUID() -> String? {
    guard let device = property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, as: AudioObjectID.self, default: 0), device != 0 else { return nil }
    var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid) == noErr, let value = uid else { return nil }
    return value.takeRetainedValue() as String
}

func osVersionAtLeast(_ major: Int, _ minor: Int) -> Bool {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return v.majorVersion > major || (v.majorVersion == major && v.minorVersion >= minor)
}

// MARK: - system audio: a process tap inside a private aggregate device

final class Tap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "whisperbrain.tap")

    // pid nil: every process except this one.
    func start(pid: pid_t?) {
        guard osVersionAtLeast(14, 2) else { fail("the process tap needs macOS 14.2 or later", code: 2) }
        let description: CATapDescription
        if let pid = pid {
            let tree = processTree(of: pid)
            let objects = audioProcesses().filter { tree.contains($0.pid) }.map { $0.object }
            guard !objects.isEmpty else { fail("process \(pid) is not playing audio (yet)", code: 2) }
            description = CATapDescription(stereoMixdownOfProcesses: objects)
        } else {
            let mine = audioProcesses().filter { $0.pid == getpid() }.map { $0.object }
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: mine)
        }
        description.uuid = UUID()
        description.muteBehavior = .unmuted   // listen, never change what the person hears
        description.isPrivate = true

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { fail("could not create the audio tap (status \(status)): allow WhisperBrain under System Settings > Privacy & Security > Screen & System Audio Recording", code: 2) }
        guard let outputUID = defaultOutputUID() else { fail("no output device", code: 2) }

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "WhisperBrain tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else { fail("could not create the capture device (status \(status))", code: 2) }

        guard var asbd = property(tapID, kAudioTapPropertyFormat, as: AudioStreamBasicDescription.self, default: AudioStreamBasicDescription()),
              let format = AVAudioFormat(streamDescription: &asbd),
              let converter = Converter(from: format) else { fail("the tap has a format that cannot be read", code: 2) }

        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
            emit(converter.convert(buffer))
        }
        guard status == noErr else { fail("could not read from the capture device (status \(status))", code: 2) }
        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else { fail("could not start capturing (status \(status))", code: 2) }
    }

    func stop() {
        if let p = procID { AudioDeviceStop(aggregateID, p); AudioDeviceDestroyIOProcID(aggregateID, p) }
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    }
}

// MARK: - microphone with voice processing (echo cancellation)

final class Microphone {
    private let engine = AVAudioEngine()

    func start() {
        let input = engine.inputNode
        do {
            try input.setVoiceProcessingEnabled(true)
            if #available(macOS 14.0, *) {
                // the call's audio must not be turned down while it is being listened to
                input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            }
            let format = input.outputFormat(forBus: 0)
            guard let converter = Converter(from: format) else { fail("the microphone has a format that cannot be read", code: 2) }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in emit(converter.convert(buffer)) }
            try engine.start()
        } catch { fail("could not start the microphone: \(error.localizedDescription)", code: 2) }
    }

    func stop() { engine.inputNode.removeTap(onBus: 0); engine.stop() }
}

// MARK: - self test: a 48 kHz stereo float tone must come out as 16 kHz mono s16 with the same pitch

func selftest() -> Never {
    let rate = 48000.0, seconds = 1.0, hz = 440.0
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(rate * seconds)),
          let converter = Converter(from: format) else { fail("selftest: could not build the formats") }
    buffer.frameLength = AVAudioFrameCount(rate * seconds)
    for channel in 0..<2 {
        let data = buffer.floatChannelData![channel]
        for i in 0..<Int(buffer.frameLength) { data[i] = Float(0.4 * sin(2 * Double.pi * hz * Double(i) / rate)) }
    }
    let bytes = converter.convert(buffer)
    let count = bytes.count / 2
    // the converter may hold back a few frames until it has more input: a second of tone gives about a second of output
    guard abs(count - Int(outRate)) < 800 else { fail("selftest: \(count) samples for one second of tone") }
    let samples: [Int16] = bytes.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    // pitch by Goertzel: the energy at 440 Hz must be nearly all of it
    func power(_ f: Double) -> Double {
        var re = 0.0, im = 0.0
        for (i, s) in samples.enumerated() { let x = Double(s) / 32768; re += x * cos(2 * Double.pi * f * Double(i) / outRate); im += x * sin(2 * Double.pi * f * Double(i) / outRate) }
        return re * re + im * im
    }
    let share = power(hz) / (power(hz) + power(1000) + power(250) + 1e-9)
    guard share > 0.9 else { fail("selftest: the tone came out at the wrong pitch (\(share))") }
    print("selftest ok: \(count) samples, 440 Hz share \(String(format: "%.2f", share))")
    exit(0)
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
let mode = args.first ?? ""
func value(of flag: String) -> String? { if let i = args.firstIndex(of: flag), i + 1 < args.count { return args[i + 1] }; return nil }

switch mode {
case "probe":
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let tap = osVersionAtLeast(14, 2)
    print("{\"processTap\":\(tap),\"perProcess\":\(tap),\"voiceProcessing\":true,\"os\":\"\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)\"}")
    exit(0)
case "selftest":
    selftest()
case "system", "mic":
    let tap = Tap(), microphone = Microphone()
    var keepAlive: [Any] = []   // dispatch sources only run while something holds them
    func shutdown(_ code: Int32) -> Never { if mode == "system" { tap.stop() } else { microphone.stop() }; exit(code) }
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { shutdown(0) }
        source.resume()
        keepAlive.append(source)
    }
    if mode == "system" {
        var followed: pid_t?
        if let text = value(of: "--pid") { guard let p = pid_t(text), p > 0 else { fail("bad --pid", code: 2) }; followed = p }
        tap.start(pid: followed)
        if let p = followed {
            // when the followed process ends, so do we: WhisperBrain then carries on with the whole output
            let exitWatch = DispatchSource.makeProcessSource(identifier: p, eventMask: .exit, queue: .main)
            exitWatch.setEventHandler { FileHandle.standardError.write("process \(p) ended\n".data(using: .utf8)!); shutdown(3) }
            exitWatch.resume()
            keepAlive.append(exitWatch)
        }
    } else {
        microphone.start()
    }
    dispatchMain()
default:
    fail("usage: whisperbrain-tap system [--pid N] | mic | probe | selftest", code: 64)
}
