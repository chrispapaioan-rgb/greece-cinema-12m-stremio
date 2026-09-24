#!/usr/bin/env python3
from pathlib import Path
import re
import sys

root = Path(sys.argv[1]).resolve()

def p(rel): return root / rel
def read(rel): return p(rel).read_text(encoding="utf-8")
def write(rel, s): p(rel).write_text(s, encoding="utf-8")
def rep(rel, old, new, count=1):
    s = read(rel)
    if old not in s:
        raise RuntimeError(f"anchor not found in {rel}: {old[:120]!r}")
    write(rel, s.replace(old, new, count))

# ---- 10034 identity is enforced by override build.gradle; harden prompt quality here.
rel="android/app/src/main/java/com/xyq/livetranslate/PromptBuilder.kt"
s=read(rel)
s=s.replace(
    "- Translate faithfully. Do not answer, explain, summarize, continue, or invent.",
    "- Translate faithfully into natural, idiomatic Greek. Preserve the exact meaning, tone, names, numbers and relationships; do not answer, explain, summarize, continue, or invent.",
    1,
)
s=s.replace(
    "- SPEAKER TURN PROTOCOL: identify a real speaker change from acoustic identity: timbre, pitch range, vocal formants, cadence, and spectral/voice character.",
    "- SUBTITLE TURN PROTOCOL: emit a new ¶ at every distinct dialogue utterance: whenever the acoustic speaker changes OR a natural spoken turn clearly ends after a real pause. Never merge two separate utterances into the same subtitle.",
    1,
)
s=s.replace(
    "- Prefix EVERY acoustic speaker turn with exactly one ¶ character. The first speaker also starts with ¶.",
    "- Prefix EVERY subtitle utterance with exactly one ¶ character. The first utterance also starts with ¶.",
    1,
)
s=s.replace(
    "- The instant the acoustic voice changes to another person, emit ¶ BEFORE that person's translated words. Never merge different speakers into one turn.",
    "- The instant the speaker changes, or a completed utterance gives way to the next one, emit ¶ BEFORE the next translated words.",
    1,
)
write(rel,s)

# ---- SessionCoordinator: TV uses GreekLive's own app picker, then explicit default-display consent.
rel="android/app/src/main/java/com/xyq/livetranslate/ui/SessionCoordinator.kt"
s=read(rel)
if "import android.media.projection.MediaProjectionConfig" not in s:
    s=s.replace(
        "import android.media.projection.MediaProjectionManager\n",
        "import android.media.projection.MediaProjectionConfig\nimport android.media.projection.MediaProjectionManager\n",
        1,
    )
s=s.replace(
'''    fun launchProjection(intent: Intent)
    fun startForegroundService(intent: Intent)''',
'''    fun launchProjection(intent: Intent)
    fun isTelevision(): Boolean
    fun chooseVideoApp(onSelected: (String) -> Unit, onCancel: () -> Unit)
    fun launchPackage(packageName: String)
    fun startForegroundService(intent: Intent)''',
1)
s=s.replace(
'''    private var pendingSnapshot: PendingSessionSnapshot? = null
    private var sessionContextAccess: SessionContextAccess? = sessionContextAccess''',
'''    private var pendingSnapshot: PendingSessionSnapshot? = null
    private var pendingTvPackage: String? = null
    private var sessionContextAccess: SessionContextAccess? = sessionContextAccess''',
1)
old='''        val startIntent = captureStartIntent(snapshot)
            .putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
            .putExtra(CaptureService.EXTRA_RESULT_DATA, data)
        host.startForegroundService(startIntent)
        consumeStartedSession(snapshot)'''
new='''        val selectedPackage = pendingTvPackage
        val startIntent = captureStartIntent(snapshot)
            .putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
            .putExtra(CaptureService.EXTRA_RESULT_DATA, data)
            .putExtra(CaptureService.EXTRA_TARGET_PACKAGE, selectedPackage)
        host.startForegroundService(startIntent)
        if (!selectedPackage.isNullOrBlank()) host.launchPackage(selectedPackage)
        pendingTvPackage = null
        consumeStartedSession(snapshot)'''
if old not in s: raise RuntimeError("projection result anchor missing")
s=s.replace(old,new,1)

old='''            pendingSnapshot = ready.copy(stage = PendingSessionStage.WAITING_PROJECTION)
            val projectionManager = context.getSystemService(MediaProjectionManager::class.java)
            host.launchProjection(projectionManager.createScreenCaptureIntent())
            return'''
new='''            if (host.isTelevision()) {
                if (pendingTvPackage.isNullOrBlank()) {
                    host.chooseVideoApp(
                        onSelected = { packageName ->
                            pendingTvPackage = packageName
                            launchVideoProjection(ready)
                        },
                        onCancel = {
                            pendingTvPackage = null
                            pendingSnapshot = ready
                        },
                    )
                    return
                }
            }
            launchVideoProjection(ready)
            return'''
if old not in s: raise RuntimeError("continueStart projection anchor missing")
s=s.replace(old,new,1)

anchor='''    /** onResume：悬浮窗权限返回后自动续跑。 */'''
helper='''    private fun launchVideoProjection(snapshot: PendingSessionSnapshot) {
        pendingSnapshot = snapshot.copy(stage = PendingSessionStage.WAITING_PROJECTION)
        val projectionManager = context.getSystemService(MediaProjectionManager::class.java)
        val projectionIntent =
            if (host.isTelevision() && Build.VERSION.SDK_INT >= 34) {
                projectionManager.createScreenCaptureIntent(
                    MediaProjectionConfig.createConfigForDefaultDisplay(),
                )
            } else {
                projectionManager.createScreenCaptureIntent()
            }
        host.launchProjection(projectionIntent)
    }

'''
if anchor not in s: raise RuntimeError("helper anchor missing")
s=s.replace(anchor,helper+anchor,1)
s=s.replace(
'''            pendingSnapshot = snapshot.copy(stage = PendingSessionStage.READY)
            host.toast(context.getString(R.string.rt_toast_projection_permission_denied))''',
'''            pendingSnapshot = snapshot.copy(stage = PendingSessionStage.READY)
            pendingTvPackage = null
            host.toast(context.getString(R.string.rt_toast_projection_permission_denied))''',
1)
write(rel,s)

# ---- CaptureService: low latency for both phone and TV, plus UID-filtered TV playback capture.
rel="android/app/src/main/java/com/xyq/livetranslate/CaptureService.kt"
s=read(rel)
s=s.replace(
'''        const val EXTRA_RESULT_DATA = "resultData"''',
'''        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_TARGET_PACKAGE = "targetPackage"''',
1)
s=s.replace(
'''        val idleMsSnapshot = if (mode == StatusBus.MODE_VIDEO) 1600L else SettingsStore.stabIdleMs(this).toLong()
        val maxCharsSnapshot = if (mode == StatusBus.MODE_VIDEO) 220 else SettingsStore.stabMaxChars(this)''',
'''        val idleMsSnapshot = if (mode == StatusBus.MODE_VIDEO) 800L else SettingsStore.stabIdleMs(this).toLong()
        val maxCharsSnapshot = if (mode == StatusBus.MODE_VIDEO) 360 else SettingsStore.stabMaxChars(this)''',
1)
# If the baseline did not yet contain the video-specific constants, patch upstream form too.
s=s.replace(
'''        val idleMsSnapshot = SettingsStore.stabIdleMs(this).toLong()
        val maxCharsSnapshot = SettingsStore.stabMaxChars(this)''',
'''        val idleMsSnapshot = if (mode == StatusBus.MODE_VIDEO) 800L else SettingsStore.stabIdleMs(this).toLong()
        val maxCharsSnapshot = if (mode == StatusBus.MODE_VIDEO) 360 else SettingsStore.stabMaxChars(this)''',
1)
s=s.replace(
'''            val proj = obtainProjection(intent) ?: return
            createPlaybackAudioRecord(proj)''',
'''            val proj = obtainProjection(intent) ?: return
            createPlaybackAudioRecord(proj, intent.getStringExtra(EXTRA_TARGET_PACKAGE))''',
1)
old='''    private fun createPlaybackAudioRecord(proj: MediaProjection): AudioRecord? {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) return null

        val config = AudioPlaybackCaptureConfiguration.Builder(proj)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()'''
new='''    private fun createPlaybackAudioRecord(
        proj: MediaProjection,
        targetPackage: String?,
    ): AudioRecord? {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) return null

        val configBuilder = AudioPlaybackCaptureConfiguration.Builder(proj)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)

        if (!targetPackage.isNullOrBlank()) {
            val uid = runCatching {
                packageManager.getApplicationInfo(targetPackage, 0).uid
            }.getOrNull()
            if (uid != null) {
                configBuilder.addMatchingUid(uid)
                Log.i(TAG, "Playback capture restricted to $targetPackage uid=$uid")
            } else {
                Log.w(TAG, "Unable to resolve UID for $targetPackage; using projection-wide audio")
            }
        }
        val config = configBuilder.build()'''
if old not in s: raise RuntimeError("playback record anchor missing")
s=s.replace(old,new,1)
write(rel,s)

# ---- Overlay: 1 utterance / 1 transparent box, real 3-line wrapping, larger text, bottom-center slightly raised.
rel="android/app/src/main/java/com/xyq/livetranslate/SubtitleOverlay.kt"
s=read(rel)
if "import android.util.TypedValue" not in s:
    s=s.replace("import android.text.TextUtils\n", "import android.text.TextUtils\nimport android.util.TypedValue\n", 1)
s=s.replace(
'''            setTextColor(Color.WHITE)
            textSize = 18f
            maxLines = 3''',
'''            setTextColor(Color.WHITE)
            textSize = 28f
            maxLines = 3
            gravity = Gravity.CENTER
            setAutoSizeTextTypeUniformWithConfiguration(
                22, 30, 1, TypedValue.COMPLEX_UNIT_SP,
            )''',
1)
s=s.replace(
'''            gravity = Gravity.TOP or Gravity.START
            x = dp(12)
            y = dp(120)''',
'''            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            x = 0
            y = dp(82)''',
1)
s=s.replace("        setControlsVisible(true)\n        renderLines()", "        setControlsVisible(false)\n        renderLines()", 1)
s=s.replace(
'''        val font = SettingsStore.fontSizeSp(context)
        tvCurrent?.textSize = font.toFloat()
        tvCurrent?.maxLines = 3
        tvConfirmed?.textSize = (font - 4).coerceAtLeast(11).toFloat()''',
'''        tvCurrent?.apply {
            maxLines = 3
            ellipsize = null
            gravity = Gravity.CENTER
            setAutoSizeTextTypeUniformWithConfiguration(
                22, 30, 1, TypedValue.COMPLEX_UNIT_SP,
            )
        }
        tvConfirmed?.visibility = View.GONE''',
1)
s=s.replace("            window.accentVisible = true", "            window.accentVisible = false", 1)
# Replace visible rounded panel with fully transparent/no-border surface.
s=re.sub(
r'''            val opacity = SettingsStore\.bgOpacityPct\(context\)\.coerceIn\(20, 100\)\n            window\.background = roundedRect\(\n                fill = Color\.argb\(255 \* opacity / 100, 20, 29, 43\),\n                stroke = Color\.argb\(55, 255, 255, 255\),\n                radius = 22,\n            \)''',
'''            window.background = null''',
s,count=1)
# In case patch.py already changed the width to 84%, promote to 94%.
s=s.replace("val preferred = (displayWidth * 0.84f).roundToInt()", "val preferred = (displayWidth * 0.94f).roundToInt()", 1)
write(rel,s)

print("GreekLive 10034 patch applied")
