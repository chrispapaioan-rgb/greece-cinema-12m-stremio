#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1] / "_subrima" / "SubtitlesAppSubrimaProject"
APP = ROOT / "app"

def replace(path, old, new):
    p = Path(path)
    s = p.read_text(encoding="utf-8")
    if old not in s:
        raise RuntimeError(f"Expected text not found in {p}: {old[:80]!r}")
    p.write_text(s.replace(old, new), encoding="utf-8")

# ---------- Product identity ----------
gradle = APP / "build.gradle"
s = gradle.read_text(encoding="utf-8")
s = s.replace('applicationId "com.example.subtitles"', 'applicationId "gr.openai.livesubtitles"')
s = s.replace('versionCode 1', 'versionCode 10')
s = s.replace('versionName "1.0"', 'versionName "0.1.0-alpha"')

# Disable optional native Whisper/SentencePiece build for the stable baseline.
# Vosk + ML Kit are sufficient for the requested live-subtitle path and this
# avoids bundling experimental native code that is not used when smart correction is off.
native_default = '''        // NDK configuration for cross-compiling native libraries
        ndk {
            abiFilters 'armeabi-v7a', 'arm64-v8a' // Target architectures
            version "26.1.10909125" // NDK version
        }
        // Configure external native builds using CMake
        externalNativeBuild {
            cmake {
                abiFilters 'armeabi-v7a', 'arm64-v8a' // Target ABIs
                arguments "-DCMAKE_BUILD_TYPE=Release" // Ensures optimized release build
            }
        }

'''
s = s.replace(native_default, '')
native_top = '''    // ----------------------------------------------------------------------------
    // External Native Build
    // ----------------------------------------------------------------------------
    // Specifies the CMake build script path and version for compiling native code.
    externalNativeBuild {
        cmake {
            version "3.22.1"                                // CMake version used for native build
            path "src/main/jni/CMakeLists.txt"             // Path to the native CMakeLists.txt
        }
    }
'''
s = s.replace(native_top, '')
gradle.write_text(s, encoding="utf-8")

strings = APP / "src/main/res/values/strings.xml"
s = strings.read_text(encoding="utf-8")
s = re.sub(r'<string name="app_name">.*?</string>',
           '<string name="app_name">Greek Live Subtitles</string>', s, count=1)
strings.write_text(s, encoding="utf-8")

# ---------- Language choices ----------
arrays = APP / "src/main/res/values/arrays.xml"
arrays.write_text("""<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string-array name="source_lang_codes">
        <item>auto</item>
        <item>en</item>
        <item>fr</item>
        <item>es</item>
        <item>de</item>
        <item>ru</item>
    </string-array>
    <string-array name="source_lang_names">
        <item>Auto detect</item>
        <item>English</item>
        <item>Français</item>
        <item>Español</item>
        <item>Deutsch</item>
        <item>Русский</item>
    </string-array>
    <string-array name="subtitle_lang_codes">
        <item>el</item>
    </string-array>
    <string-array name="subtitle_lang_names">
        <item>Ελληνικά</item>
    </string-array>
</resources>
""", encoding="utf-8")

settings = APP / "src/main/java/com/example/subtitles/view/screens/SettingsActivity.java"
s = settings.read_text(encoding="utf-8")
s = s.replace('String[] supported = getResources().getStringArray(R.array.lang_codes);',
              'String[] supported = getResources().getStringArray(R.array.subtitle_lang_codes);')
s = s.replace('String def = ok ? deviceLang : "en";',
              'String def = ok ? deviceLang : "el";')
s = s.replace('String subLang = prefs.getString("pref_subtitle_lang", "en");',
              'String subLang = prefs.getString("pref_subtitle_lang", "el");')
s = s.replace('String[] codes = getResources().getStringArray(R.array.lang_codes);\n        String[] names = getResources().getStringArray(R.array.lang_names);',
              'String[] codes = getResources().getStringArray(includeAuto ? R.array.source_lang_codes : R.array.subtitle_lang_codes);\n'
              '        String[] names = getResources().getStringArray(includeAuto ? R.array.source_lang_names : R.array.subtitle_lang_names);')
s = s.replace('String def = includeAuto ? "auto" : "en";',
              'String def = includeAuto ? "auto" : "el";')
settings.write_text(s, encoding="utf-8")

# ---------- Make Greek the target from the very first launch ----------
pipeline = APP / "src/main/java/com/example/subtitles/view_model/MainPipeline.java"
s = pipeline.read_text(encoding="utf-8")
s = s.replace('private String subtitleLang = "en"; // active subtitle/translation target language',
              'private String subtitleLang = "el"; // Greek is the fixed subtitle/translation target')
s = s.replace('prefs.getString("pref_subtitle_lang", "en")',
              'prefs.getString("pref_subtitle_lang", "el")')
s = s.replace('''        sourceLang   = prefs.getString("pref_source_lang",   "auto");
        if(!sourceLang.equals("auto")&&!sourceLang.equals(srcLang)) {
            srcLang = sourceLang;
        }
        if(!subtitleLang.equals(prefs.getString("pref_subtitle_lang", "el"))) {
            if(!setLanguage(prefs.getString("pref_subtitle_lang", "el"))) {
                notifyError("problem changing subtitles lang...");
            }
        }
        transcriber.setParmeters();''',
'''        sourceLang = prefs.getString("pref_source_lang", "auto");
        boolean sourceChanged = false;
        if (!sourceLang.equals("auto") && !sourceLang.equals(srcLang)) {
            srcLang = sourceLang;
            sourceChanged = true;
        }

        String requestedSubtitleLang = prefs.getString("pref_subtitle_lang", "el");
        // Reconfigure ML Kit not only when the target changes, but also whenever
        // the manually selected source changes (e.g. English -> French).
        if (sourceChanged || !subtitleLang.equals(requestedSubtitleLang)) {
            if (!setLanguage(requestedSubtitleLang)) {
                notifyError("problem changing translation language pair...");
            }
        }
        transcriber.setParmeters();''')
pipeline.write_text(s, encoding="utf-8")

# ---------- Harden transcription lifecycle and constrain Auto mode ----------
tm = APP / "src/main/java/com/example/subtitles/view_model/transcriptManager.java"
s = tm.read_text(encoding="utf-8")
s = s.replace('''    private synchronized void checkValidLangBeforeChange(String newLang) {
        if (!running.get() || newLang.equals(srcLang)) return;

        Log.d(TAG, "new lang detected: " + newLang);''',
'''    private synchronized void checkValidLangBeforeChange(String newLang) {
        if (!running.get() || newLang.equals(srcLang)) return;

        // Product scope: Auto mode is deliberately constrained to the five
        // high-quality source models requested for Greek subtitle generation.
        if (!(newLang.equals("en") || newLang.equals("fr") || newLang.equals("es") ||
                newLang.equals("de") || newLang.equals("ru"))) {
            Log.d(TAG, "Auto-detected language outside supported source set: " + newLang);
            return;
        }

        Log.d(TAG, "new lang detected: " + newLang);''')
s = s.replace('''        transcriber.destroy();
        whisperT.close();
        Log.i(TAG, "Pipeline destroyed");''',
'''        transcriber.destroy();
        if (whisperT != null) {
            whisperT.close();
        }
        Log.i(TAG, "Pipeline destroyed");''')
tm.write_text(s, encoding="utf-8")

# ---------- Stable baseline: smart correction off ----------
# Keep the optional Whisper code in the project, but default settings remain off.
# This avoids forcing heavy Whisper inference for ordinary live-subtitle use.

# ---------- Audio capture with automatic microphone fallback ----------
capturer = APP / "src/main/java/com/example/subtitles/model/audio/StreamAudioCapturer.java"
capturer.write_text(r'''package com.example.subtitles.model.audio;

import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioPlaybackConfiguration;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import androidx.annotation.RequiresApi;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Captures Android playback audio using AudioPlaybackCapture and automatically
 * falls back to the microphone when the source app blocks capture or playback
 * capture cannot be initialized.
 *
 * This is intentionally app-agnostic: Filmzie, Stremio and other media apps
 * work when their Android audio capture policy permits it. DRM/capture policy
 * is never bypassed.
 */
public class StreamAudioCapturer {
    public static final int chunkSizeMs = 250;
    private static final String TAG = "StreamAudioCapturer";
    private static StreamAudioCapturer instance;

    public enum CaptureMode { PLAYBACK, MICROPHONE }

    private final Context context;
    private final MediaProjectionManager projectionManager;
    private final AudioManager audioManager;
    private final int sampleRate;
    private final int chunkSize;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private final AtomicBoolean capturing = new AtomicBoolean(false);
    private final AtomicBoolean stoppedMidCapturing = new AtomicBoolean(false);
    private final AtomicBoolean requestMicFallback = new AtomicBoolean(false);

    private MediaProjection projection;
    private AudioRecord recorder;
    private Thread captureThread;
    private OnAudioCaptureListener listener;
    private volatile CaptureMode mode = CaptureMode.PLAYBACK;

    private final AudioManager.AudioPlaybackCallback playbackCallback =
            new AudioManager.AudioPlaybackCallback() {
                @Override
                public void onPlaybackConfigChanged(List<AudioPlaybackConfiguration> configs) {
                    boolean blocked = false;
                    for (AudioPlaybackConfiguration cfg : configs) {
                        int usage = cfg.getAudioAttributes().getUsage();
                        int policy = cfg.getAudioAttributes().getAllowedCapturePolicy();
                        if (isMediaUsage(usage) && policy == AudioAttributes.ALLOW_CAPTURE_BY_NONE) {
                            blocked = true;
                            break;
                        }
                    }
                    if (blocked && mode == CaptureMode.PLAYBACK) {
                        Log.w(TAG, "Playback capture blocked; scheduling microphone fallback.");
                        requestMicFallback.set(true);
                        if (listener != null) listener.onCaptureBlockedDetected();
                    }
                }
            };

    private StreamAudioCapturer(Context context, int sampleRate) {
        this.context = context.getApplicationContext();
        this.projectionManager = context.getSystemService(MediaProjectionManager.class);
        this.audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.sampleRate = sampleRate;
        this.chunkSize = (chunkSizeMs * sampleRate) / 1000;
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    public static StreamAudioCapturer getInstance(Context context, int sampleRate) {
        if (instance == null) {
            synchronized (StreamAudioCapturer.class) {
                if (instance == null) instance = new StreamAudioCapturer(context, sampleRate);
            }
        }
        return instance;
    }

    public static synchronized void destroyInstance() {
        if (instance != null) {
            instance.destroy();
            instance = null;
        }
    }

    public void setOnAudioCaptureListener(OnAudioCaptureListener l) {
        this.listener = l;
    }

    public CaptureMode getCaptureMode() {
        return mode;
    }

    public void onProjectionGranted(int resultCode, Intent data) {
        if (projection != null) return;
        projection = projectionManager.getMediaProjection(resultCode, data);
        if (projection == null) {
            Log.e(TAG, "Failed to obtain MediaProjection.");
            return;
        }
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() {
                Log.w(TAG, "MediaProjection revoked by system.");
                stop(true);
            }
        }, main);
        if (stoppedMidCapturing.get()) start();
    }

    public void onProjectionRevoked() {
        stop(true);
        projection = null;
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    public boolean start() {
        if (capturing.get()) return false;
        synchronized (lock) {
            boolean ok = false;
            if (projection != null) ok = startPlaybackRecorderLocked();
            if (!ok) ok = startMicrophoneRecorderLocked(true);
            if (!ok) return false;

            capturing.set(true);
            try {
                audioManager.registerAudioPlaybackCallback(playbackCallback, main);
            } catch (Exception ignored) {}
            captureThread = new Thread(this::captureLoop, "GreekLiveSubtitleAudio");
            captureThread.start();
            Log.i(TAG, "Audio capture started in mode=" + mode);
            return true;
        }
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    private boolean startPlaybackRecorderLocked() {
        try {
            AudioFormat format = makeFormat();
            int bufSizeBytes = bufferSizeBytes();
            AudioPlaybackCaptureConfiguration.Builder config =
                    new AudioPlaybackCaptureConfiguration.Builder(projection);
            int[] usages = new int[]{
                    AudioAttributes.USAGE_MEDIA,
                    AudioAttributes.USAGE_GAME,
                    AudioAttributes.USAGE_UNKNOWN,
                    AudioAttributes.USAGE_ASSISTANT
            };
            for (int usage : usages) {
                try { config.addMatchingUsage(usage); } catch (IllegalArgumentException ignored) {}
            }
            AudioRecord r = new AudioRecord.Builder()
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(bufSizeBytes)
                    .setAudioPlaybackCaptureConfig(config.build())
                    .build();
            if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                r.release();
                return false;
            }
            r.startRecording();
            recorder = r;
            mode = CaptureMode.PLAYBACK;
            requestMicFallback.set(false);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Playback capture unavailable", e);
            return false;
        }
    }

    private boolean startMicrophoneRecorderLocked(boolean showToast) {
        try {
            AudioRecord r = new AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                    .setAudioFormat(makeFormat())
                    .setBufferSizeInBytes(bufferSizeBytes())
                    .build();
            if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                r.release();
                return false;
            }
            r.startRecording();
            recorder = r;
            mode = CaptureMode.MICROPHONE;
            requestMicFallback.set(false);
            if (showToast) {
                main.post(() -> Toast.makeText(
                        context,
                        "Internal audio unavailable — microphone fallback active",
                        Toast.LENGTH_LONG).show());
            }
            Log.i(TAG, "Microphone fallback active");
            return true;
        } catch (SecurityException e) {
            Log.e(TAG, "Microphone permission missing", e);
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Microphone fallback failed", e);
            return false;
        }
    }

    private AudioFormat makeFormat() {
        return new AudioFormat.Builder()
                .setSampleRate(sampleRate)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build();
    }

    private int bufferSizeBytes() {
        int min = AudioRecord.getMinBufferSize(
                sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        return Math.max(min, chunkSize * 2);
    }

    private static boolean isMediaUsage(int usage) {
        return usage == AudioAttributes.USAGE_MEDIA ||
                usage == AudioAttributes.USAGE_GAME ||
                usage == AudioAttributes.USAGE_UNKNOWN ||
                usage == AudioAttributes.USAGE_ASSISTANT;
    }

    private void captureLoop() {
        short[] buffer = new short[chunkSize];
        int silentChunks = 0;

        while (capturing.get() && !Thread.currentThread().isInterrupted()) {
            if (requestMicFallback.get() && mode == CaptureMode.PLAYBACK) {
                synchronized (lock) {
                    releaseRecorderLocked();
                    if (!startMicrophoneRecorderLocked(true)) {
                        capturing.set(false);
                        break;
                    }
                }
            }

            AudioRecord local = recorder;
            if (local == null) break;
            int read = local.read(buffer, 0, buffer.length);
            if (read < 0) {
                Log.e(TAG, "AudioRecord read error=" + read);
                if (mode == CaptureMode.PLAYBACK) {
                    requestMicFallback.set(true);
                    continue;
                }
                break;
            }
            if (read == 0) continue;

            if (mode == CaptureMode.PLAYBACK) {
                long energy = 0;
                for (int i = 0; i < read; i++) energy += Math.abs((int) buffer[i]);
                if (energy < read * 3L) silentChunks++; else silentChunks = 0;

                // If media is actively playing but the capture stream stays silent
                // for ~3 seconds, treat it as a policy/DRM capture block.
                if (silentChunks >= 12 && hasActiveMediaPlayback() && !hasCapturableAudio()) {
                    requestMicFallback.set(true);
                    if (listener != null) listener.onCaptureBlockedDetected();
                    continue;
                }
            }

            if (listener != null) listener.onAudioChunk(buffer, read);
        }
    }

    public boolean hasCapturableAudio() {
        try {
            for (AudioPlaybackConfiguration cfg : audioManager.getActivePlaybackConfigurations()) {
                int usage = cfg.getAudioAttributes().getUsage();
                int policy = cfg.getAudioAttributes().getAllowedCapturePolicy();
                if (isMediaUsage(usage) && policy != AudioAttributes.ALLOW_CAPTURE_BY_NONE) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private boolean hasActiveMediaPlayback() {
        try {
            for (AudioPlaybackConfiguration cfg : audioManager.getActivePlaybackConfigurations()) {
                if (isMediaUsage(cfg.getAudioAttributes().getUsage())) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    public void stop(boolean midCapturing) {
        if (!capturing.getAndSet(false)) return;
        try { audioManager.unregisterAudioPlaybackCallback(playbackCallback); } catch (Exception ignored) {}
        stoppedMidCapturing.set(midCapturing);
        synchronized (lock) {
            releaseRecorderLocked();
        }
        if (captureThread != null && captureThread != Thread.currentThread()) {
            captureThread.interrupt();
            try { captureThread.join(1500); } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            captureThread = null;
        }
        Log.i(TAG, "Audio capture stopped");
    }

    private void releaseRecorderLocked() {
        if (recorder != null) {
            try { recorder.stop(); } catch (Exception ignored) {}
            try { recorder.release(); } catch (Exception ignored) {}
            recorder = null;
        }
    }

    private void destroy() {
        stop(false);
        synchronized (lock) {
            if (projection != null) {
                try { projection.stop(); } catch (Exception ignored) {}
                projection = null;
            }
        }
    }

    public interface OnAudioCaptureListener {
        void onAudioChunk(short[] pcm, int length);
        default void onCaptureBlockedDetected() {}
    }
}
''', encoding="utf-8")

# ---------- User-facing build metadata ----------
about = APP / "src/main/assets/build_info.txt"
about.write_text(
"""Greek Live Subtitles 0.1.0-alpha
Source languages: Auto, English, French, Spanish, German, Russian
Subtitle language: Greek
Primary capture: Android AudioPlaybackCapture
Fallback: Microphone (VOICE_RECOGNITION)
Targets: Filmzie, Stremio, and other Android media apps
Translation: Google ML Kit on-device
Speech recognition: Vosk on-device
No DRM or Android capture-policy bypass is attempted.
""", encoding="utf-8")

print("Patch complete:", ROOT)
