import Accelerate
import AVFoundation
import MediaToolbox
import os

/// BRG-4 spectrum source. The player is an `AVQueuePlayer` (gapless streaming, AUD-7), not an `AVAudioEngine`,
/// so the tap is an `MTAudioProcessingTap` on each `AVPlayerItem`'s audio mix, post effects. The tap's process
/// callback (a real-time audio thread) only copies a mono mix of the samples into a ring buffer under an
/// unfair lock; `SpectrumAnalyzer` reads the newest 2048 samples from the main thread at up to 60 Hz and does
/// the FFT there. Nothing touches the web view from the audio thread (CONTRACT.md §2).
final class AudioTap {
    static let shared = AudioTap()

    static let capacity = 4096
    private var ring = [Float](repeating: 0, count: AudioTap.capacity)
    private var writeIndex = 0
    private var written = 0
    private(set) var sampleRate: Double = 44_100
    private var lastWrite: UInt64 = 0
    private let lock: UnsafeMutablePointer<os_unfair_lock> = {
        let pointer = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        pointer.initialize(to: os_unfair_lock())
        return pointer
    }()

    /// Adds a tap to `item`'s first audio track. Safe to call after the item started playing.
    func attach(to item: AVPlayerItem) {
        let asset = item.asset
        Task {
            guard let track = try? await asset.loadTracks(withMediaType: .audio).first,
                  let tap = Self.makeTap(for: self) else { return }
            let parameters = AVMutableAudioMixInputParameters(track: track)
            parameters.audioTapProcessor = tap
            let mix = AVMutableAudioMix()
            mix.inputParameters = [parameters]
            await MainActor.run { item.audioMix = mix }
        }
    }

    /// The newest `count` samples (oldest first), and whether any arrived in the last 250 ms.
    func latest(_ count: Int, into out: inout [Float]) -> Bool {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        if out.count != count { out = [Float](repeating: 0, count: count) }
        var index = (writeIndex - count + Self.capacity * 2) % Self.capacity
        for i in 0..<count {
            out[i] = ring[index]
            index = (index + 1) % Self.capacity
        }
        let fresh = written > 0 && DispatchTime.now().uptimeNanoseconds - lastWrite < 250_000_000
        return fresh
    }

    /// Called on the audio thread.
    fileprivate func write(_ buffers: UnsafeMutableAudioBufferListPointer, frames: Int, format: AudioStreamBasicDescription) {
        guard frames > 0, format.mFormatID == kAudioFormatLinearPCM,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32 else { return }
        let nonInterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let channels = max(1, Int(format.mChannelsPerFrame))
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        sampleRate = format.mSampleRate > 0 ? format.mSampleRate : sampleRate
        for frame in 0..<frames {
            var sum: Float = 0
            if nonInterleaved {
                var used = 0
                for buffer in buffers where used < channels {
                    guard let data = buffer.mData?.assumingMemoryBound(to: Float.self),
                          Int(buffer.mDataByteSize) >= (frame + 1) * 4 else { continue }
                    sum += data[frame]
                    used += 1
                }
                sum /= Float(max(1, used))
            } else if let data = buffers.first?.mData?.assumingMemoryBound(to: Float.self),
                      Int(buffers[0].mDataByteSize) >= (frame + 1) * channels * 4 {
                for c in 0..<channels { sum += data[frame * channels + c] }
                sum /= Float(channels)
            }
            ring[writeIndex] = sum
            writeIndex = (writeIndex + 1) % Self.capacity
        }
        written += frames
        lastWrite = DispatchTime.now().uptimeNanoseconds
    }

    // MARK: MTAudioProcessingTap

    /// Per tap state: the format from `prepare`, and the shared sink.
    private final class TapContext {
        let sink: AudioTap
        var format = AudioStreamBasicDescription()
        init(sink: AudioTap) { self.sink = sink }
    }

    private static func makeTap(for sink: AudioTap) -> MTAudioProcessingTap? {
        let context = Unmanaged.passRetained(TapContext(sink: sink)).toOpaque()
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: context,
            init: { _, clientInfo, storageOut in
                storageOut.pointee = clientInfo
            },
            finalize: { tap in
                Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
            },
            prepare: { tap, _, format in
                Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().format = format.pointee
            },
            unprepare: nil,
            process: { tap, frames, _, bufferList, framesOut, flagsOut in
                let status = MTAudioProcessingTapGetSourceAudio(tap, frames, bufferList, flagsOut, nil, framesOut)
                guard status == noErr else { return }
                let context = Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                context.sink.write(UnsafeMutableAudioBufferListPointer(bufferList), frames: Int(framesOut.pointee), format: context.format)
            }
        )
        var tap: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap)
        guard status == noErr else {
            Unmanaged<TapContext>.fromOpaque(context).release()
            return nil
        }
        return tap
    }
}

/// The web analyser, natively: Blackman window, FFT 2048, time smoothing 0.78, -100...-30 dB mapped to 0...255,
/// then `logBins` (64 bands, 40 Hz to 16 kHz), `bandLevel(40, 160)` for bass and the RMS level, exactly as
/// `src/player3d/audio-math.ts` and `audio-engine.ts` compute them, so the deck moves the same in the app.
final class SpectrumAnalyzer {
    static let fftSize = 2048
    static let smoothing: Float = 0.78
    static let minDecibels: Float = -100
    static let maxDecibels: Float = -30

    struct Frame: Equatable {
        var bands: [Int]
        var waveform: [Int]
        var level: Int
        var bass: Int

        static let silent = Frame(
            bands: Array(repeating: 0, count: BridgeContract.spectrumBands),
            waveform: Array(repeating: 0, count: BridgeContract.waveformSamples),
            level: 0, bass: 0
        )
    }

    private let log2n = vDSP_Length(11)
    private let setup: FFTSetup
    private var window = [Float](repeating: 0, count: fftSize)
    private var samples = [Float](repeating: 0, count: fftSize)
    private var smoothed = [Float](repeating: 0, count: fftSize / 2)
    private var real = [Float](repeating: 0, count: fftSize / 2)
    private var imag = [Float](repeating: 0, count: fftSize / 2)
    private(set) var bytes = [UInt8](repeating: 0, count: fftSize / 2)

    init() {
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        vDSP_blkman_window(&window, vDSP_Length(Self.fftSize), 0)
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func reset() {
        for i in smoothed.indices { smoothed[i] = 0 }
    }

    /// One frame from the tap's newest samples, or nil when the tap has gone quiet.
    func analyze(_ tap: AudioTap) -> Frame? {
        guard tap.latest(Self.fftSize, into: &samples) else { return nil }
        return analyze(samples, sampleRate: tap.sampleRate)
    }

    func analyze(_ input: [Float], sampleRate: Double) -> Frame {
        let n = Self.fftSize
        precondition(input.count == n)
        // Time domain: 128 evenly spaced samples and the RMS.
        let stride = n / BridgeContract.waveformSamples
        let waveform = (0..<BridgeContract.waveformSamples).map { i -> Int in
            Int((max(-1, min(1, input[i * stride])) * 127).rounded())
        }
        var meanSquare: Float = 0
        vDSP_measqv(input, 1, &meanSquare, vDSP_Length(n))
        let level = Int((min(1, sqrt(meanSquare)) * 255).rounded())

        // Frequency domain, as AnalyserNode.getByteFrequencyData.
        var windowed = [Float](repeating: 0, count: n)
        vDSP_vmul(input, 1, window, 1, &windowed, 1, vDSP_Length(n))
        real.withUnsafeMutableBufferPointer { realPointer in
            imag.withUnsafeMutableBufferPointer { imagPointer in
                var split = DSPSplitComplex(realp: realPointer.baseAddress!, imagp: imagPointer.baseAddress!)
                windowed.withUnsafeBufferPointer { source in
                    source.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) {
                        vDSP_ctoz($0, 2, &split, 1, vDSP_Length(n / 2))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
            }
        }
        let half = n / 2
        let rangeDb = Self.maxDecibels - Self.minDecibels
        for k in 0..<half {
            // zrip packs Nyquist into imag[0]; its forward output is 2x the DFT; the analyser divides by N.
            let re = k == 0 ? real[0] : real[k]
            let im = k == 0 ? 0 : imag[k]
            let magnitude = sqrt(re * re + im * im) / 2 / Float(n)
            smoothed[k] = Self.smoothing * smoothed[k] + (1 - Self.smoothing) * magnitude
            let db = smoothed[k] > 0 ? 20 * log10(smoothed[k]) : -1000
            let scaled = (db - Self.minDecibels) / rangeDb * 255
            bytes[k] = UInt8(max(0, min(255, scaled)))
        }
        let bands = Self.logBins(bytes, bins: BridgeContract.spectrumBands, sampleRate: sampleRate)
        let bass = Self.bandLevel(bytes, sampleRate: sampleRate, from: 40, to: 160)
        return Frame(
            bands: bands.map { Int((max(0, min(1, $0)) * 255).rounded()) },
            waveform: waveform,
            level: level,
            bass: Int((max(0, min(1, bass)) * 255).rounded())
        )
    }

    // audio-math.ts, line for line.
    static func hzToIndex(_ hz: Double, sampleRate: Double, binCount: Int) -> Int {
        let nyquist = sampleRate / 2
        return min(binCount - 1, max(0, Int((hz / nyquist * Double(binCount)).rounded())))
    }

    static func bandLevel(_ data: [UInt8], sampleRate: Double, from: Double, to: Double) -> Double {
        let start = hzToIndex(from, sampleRate: sampleRate, binCount: data.count)
        let end = max(start, hzToIndex(to, sampleRate: sampleRate, binCount: data.count))
        var sum = 0
        for i in start...end { sum += Int(data[i]) }
        return Double(sum) / Double((end - start + 1) * 255)
    }

    static func logBins(_ data: [UInt8], bins: Int, sampleRate: Double, minHz: Double = 40, maxHz: Double = 16_000) -> [Double] {
        let ratio = pow(maxHz / minHz, 1 / Double(bins))
        return (0..<bins).map { b in
            let from = minHz * pow(ratio, Double(b))
            return bandLevel(data, sampleRate: sampleRate, from: from, to: from * ratio)
        }
    }
}
