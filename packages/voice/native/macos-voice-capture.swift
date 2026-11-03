/// macOS microphone capture with Voice Processing I/O.
/// stdout is 16 kHz mono Float32. stderr is one JSON event per line.
/// stdin EOF stops the unit and exits 0.
import AudioToolbox
import AVFoundation
import CoreAudio
import Darwin
import Foundation

private let sampleRate: Float64 = 16_000
private let ringCapacity = 65_536

private let streamFormat = AudioStreamBasicDescription(
  mSampleRate: sampleRate,
  mFormatID: kAudioFormatLinearPCM,
  mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
  mBytesPerPacket: 4,
  mFramesPerPacket: 1,
  mBytesPerFrame: 4,
  mChannelsPerFrame: 1,
  mBitsPerChannel: 32,
  mReserved: 0
)

private typealias DuckFunction = @convention(c) (AudioDeviceID, Float32, UnsafePointer<Float32>?, Float32) -> OSStatus

@main
enum VoiceCapture {
  static func main() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .denied, .restricted:
      fail(code: "mic-denied", message: "microphone access is off", status: 3)
    case .notDetermined:
      let wait = DispatchSemaphore(value: 0)
      var granted = false
      AVCaptureDevice.requestAccess(for: .audio) { allowed in
        granted = allowed
        wait.signal()
      }
      wait.wait()
      if !granted { fail(code: "mic-denied", message: "microphone access was denied", status: 3) }
    case .authorized:
      break
    @unknown default:
      break
    }

    let engine = Engine()
    if !engine.start() { fail(code: "unavailable", message: "voice processing could not start", status: 4) }
    while !FileHandle.standardInput.readData(ofLength: 4096).isEmpty {}
    engine.stop()
    exit(0)
  }
}

private func fail(code: String, message: String, status: Int32) -> Never {
  emitError(code: code, message: message)
  exit(status)
}

private func emitError(code: String, message: String) {
  fputs("{\"event\":\"error\",\"code\":\(jsonString(code)),\"message\":\(jsonString(message))}\n", stderr)
  fflush(stderr)
}

private func emitReady(input: String, output: String) {
  fputs("{\"event\":\"ready\",\"aec\":true,\"input\":\(jsonString(input)),\"output\":\(jsonString(output))}\n", stderr)
  fflush(stderr)
}

private func jsonString(_ text: String) -> String {
  var out = "\""
  for scalar in text.unicodeScalars {
    switch scalar {
    case "\\": out += "\\\\"
    case "\"": out += "\\\""
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if scalar.value < 0x20 {
        out += String(format: "\\u%04x", scalar.value)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  out += "\""
  return out
}

/// One producer, one consumer. The audio callback only copies samples in.
private final class Ring: @unchecked Sendable {
  private let samples = UnsafeMutablePointer<Float>.allocate(capacity: ringCapacity)
  private let writeIndex = AtomicInt64()
  private let readIndex = AtomicInt64()

  init() { samples.initialize(repeating: 0, count: ringCapacity) }

  func push(_ source: UnsafePointer<Float>, count: Int) {
    let write = writeIndex.load()
    let read = readIndex.load()
    let space = ringCapacity - Int(write - read) - 1
    let amount = min(count, max(0, space))
    if amount == 0 { return }
    let mask = Int64(ringCapacity - 1)
    for offset in 0..<amount {
      samples[Int((write + Int64(offset)) & mask)] = source[offset]
    }
    writeIndex.store(write + Int64(amount))
  }

  func pop(into destination: UnsafeMutablePointer<Float>, capacity: Int) -> Int {
    let write = writeIndex.load()
    let read = readIndex.load()
    let amount = min(capacity, Int(write - read))
    if amount <= 0 { return 0 }
    let mask = Int64(ringCapacity - 1)
    for offset in 0..<amount {
      destination[offset] = samples[Int((read + Int64(offset)) & mask)]
    }
    readIndex.store(read + Int64(amount))
    return amount
  }
}

private final class AtomicInt64: @unchecked Sendable {
  private var value: Int64 = 0

  func load() -> Int64 { OSAtomicAdd64Barrier(0, &value) }

  func store(_ next: Int64) {
    while true {
      let current = load()
      if OSAtomicCompareAndSwap64Barrier(current, next, &value) { return }
    }
  }
}

/// Held by the render callbacks. The audio thread reads `unit` only while it is running.
private final class CallbackState: @unchecked Sendable {
  var unit: AudioUnit?
  let ring: Ring
  let scratch: UnsafeMutablePointer<Float>
  let scratchFrames: Int

  init(ring: Ring, scratch: UnsafeMutablePointer<Float>, scratchFrames: Int) {
    self.ring = ring
    self.scratch = scratch
    self.scratchFrames = scratchFrames
  }
}

private let renderCallback: AURenderCallback = { _, _, _, _, frames, data in
  // Do not set the output-is-silence flag. VPIO then stops pulling the input,
  // so the capture callback never runs.
  guard let data else { return noErr }
  let buffers = UnsafeMutableAudioBufferListPointer(data)
  if buffers.count > 0, let bytes = buffers[0].mData {
    memset(bytes, 0, Int(frames) * 4)
  }
  return noErr
}

private let captureCallback: AURenderCallback = { ref, flags, time, _, frames, _ in
  let state = Unmanaged<CallbackState>.fromOpaque(ref).takeUnretainedValue()
  guard let unit = state.unit else { return noErr }
  let count = Int(frames)
  if count <= 0 || count > state.scratchFrames { return noErr }
  var list = AudioBufferList(
    mNumberBuffers: 1,
    mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: frames * 4, mData: state.scratch)
  )
  let status = AudioUnitRender(unit, flags, time, 1, frames, &list)
  if status == noErr { state.ring.push(state.scratch, count: count) }
  return status
}

private final class Engine {
  private let ring = Ring()
  private let scratch: UnsafeMutablePointer<Float>
  private let scratchFrames = 8192
  private let state: CallbackState
  private let devices = DispatchQueue(label: "dsh-agi-voice-capture.devices")
  private var inputListener: AudioObjectPropertyListenerBlock?
  private var outputListener: AudioObjectPropertyListenerBlock?
  private var alive = true
  private let writerStopped = DispatchSemaphore(value: 0)
  private let stopFlag = AtomicInt64()

  init() {
    scratch = .allocate(capacity: scratchFrames)
    scratch.initialize(repeating: 0, count: scratchFrames)
    state = CallbackState(ring: ring, scratch: scratch, scratchFrames: scratchFrames)
  }

  func start() -> Bool {
    var ok = false
    devices.sync {
      guard defaultDevice(kAudioHardwarePropertyDefaultInputDevice) != nil else {
        emitError(code: "no-device", message: "no default input device")
        exit(5)
      }
      ok = openUnit()
      if ok { watchDevices() }
    }
    guard ok else { return false }
    let thread = Thread { [self] in self.writeLoop() }
    thread.name = "dsh-agi-voice-capture.stdout"
    thread.start()
    return true
  }

  func stop() {
    devices.sync {
      alive = false
      unwatch()
      closeUnit()
    }
    stopFlag.store(1)
    writerStopped.wait()
  }

  private func openUnit() -> Bool {
    guard let input = defaultDevice(kAudioHardwarePropertyDefaultInputDevice),
          let output = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) else {
      return false
    }
    guard let unit = createUnit(input: input, output: output) else { return false }
    state.unit = unit
    guard AudioOutputUnitStart(unit) == noErr else {
      state.unit = nil
      AudioComponentInstanceDispose(unit)
      return false
    }
    if #unavailable(macOS 14.0) { unduck(output) }
    emitReady(input: deviceName(input), output: deviceName(output))
    return true
  }

  private func rebuild() {
    guard alive else { return }
    closeUnit()
    if !openUnit() {
      emitError(code: "unavailable", message: "voice processing could not restart")
      exit(4)
    }
  }

  private func closeUnit() {
    guard let unit = state.unit else { return }
    AudioOutputUnitStop(unit)
    state.unit = nil
    AudioUnitUninitialize(unit)
    AudioComponentInstanceDispose(unit)
  }

  private func watchDevices() {
    let restart: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
      self?.devices.async { self?.rebuild() }
    }
    inputListener = restart
    outputListener = restart
    var inputAddress = propertyAddress(kAudioHardwarePropertyDefaultInputDevice)
    var outputAddress = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &inputAddress, devices, restart)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &outputAddress, devices, restart)
  }

  private func unwatch() {
    var inputAddress = propertyAddress(kAudioHardwarePropertyDefaultInputDevice)
    var outputAddress = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
    if let inputListener {
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &inputAddress, devices, inputListener)
    }
    if let outputListener {
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &outputAddress, devices, outputListener)
    }
    inputListener = nil
    outputListener = nil
  }

  private func createUnit(input: AudioDeviceID, output: AudioDeviceID) -> AudioUnit? {
    var description = AudioComponentDescription(
      componentType: kAudioUnitType_Output,
      componentSubType: kAudioUnitSubType_VoiceProcessingIO,
      componentManufacturer: kAudioUnitManufacturer_Apple,
      componentFlags: 0,
      componentFlagsMask: 0
    )
    guard let component = AudioComponentFindNext(nil, &description) else { return nil }
    var created: AudioUnit?
    guard AudioComponentInstanceNew(component, &created) == noErr, let unit = created else { return nil }

    var enable: UInt32 = 1
    guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enable, 4) == noErr else {
      AudioComponentInstanceDispose(unit)
      return nil
    }
    var inputDevice = input
    var outputDevice = output
    guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 1, &inputDevice, 4) == noErr,
          AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &outputDevice, 4) == noErr else {
      AudioComponentInstanceDispose(unit)
      return nil
    }

    var format = streamFormat
    let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, formatSize) == noErr,
          AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format, formatSize) == noErr else {
      AudioComponentInstanceDispose(unit)
      return nil
    }

    var bypass: UInt32 = 0
    AudioUnitSetProperty(unit, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0, &bypass, 4)
    if #available(macOS 14.0, *) {
      var ducking = AUVoiceIOOtherAudioDuckingConfiguration(mEnableAdvancedDucking: false, mDuckingLevel: .min)
      AudioUnitSetProperty(
        unit,
        kAUVoiceIOProperty_OtherAudioDuckingConfiguration,
        kAudioUnitScope_Global,
        0,
        &ducking,
        UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size)
      )
    }

    let ref = Unmanaged.passUnretained(state).toOpaque()
    var render = AURenderCallbackStruct(inputProc: renderCallback, inputProcRefCon: ref)
    var capture = AURenderCallbackStruct(inputProc: captureCallback, inputProcRefCon: ref)
    guard AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &render, UInt32(MemoryLayout<AURenderCallbackStruct>.size)) == noErr,
          AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 1, &capture, UInt32(MemoryLayout<AURenderCallbackStruct>.size)) == noErr,
          AudioUnitInitialize(unit) == noErr else {
      AudioComponentInstanceDispose(unit)
      return nil
    }
    return unit
  }

  private func writeLoop() {
    defer { writerStopped.signal() }
    let chunk = UnsafeMutablePointer<Float>.allocate(capacity: 4096)
    defer { chunk.deallocate() }
    while true {
      let amount = ring.pop(into: chunk, capacity: 4096)
      if amount == 0 {
        if stopFlag.load() != 0 { break }
        usleep(2_000)
        continue
      }
      var offset = 0
      let total = amount * 4
      let base = UnsafeRawPointer(chunk)
      var broken = false
      while offset < total {
        let wrote = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), total - offset)
        if wrote > 0 {
          offset += wrote
          continue
        }
        if wrote < 0 && errno == EINTR { continue }
        broken = true
        break
      }
      if broken || stopFlag.load() != 0 { break }
    }
  }
}

private func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
}

private func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
  var address = propertyAddress(selector)
  var device = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
  if status != noErr || device == 0 { return nil }
  return device
}

private func deviceName(_ device: AudioDeviceID) -> String {
  var address = propertyAddress(kAudioObjectPropertyName)
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name)
  if status != noErr { return "unknown" }
  return (name?.takeRetainedValue() as String?) ?? "unknown"
}

private func unduck(_ device: AudioDeviceID) {
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "AudioDeviceDuck") else { return }
  let duck = unsafeBitCast(symbol, to: DuckFunction.self)
  _ = duck(device, 1.0, nil, 0.5)
}
