#!/usr/bin/env python3
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

repo = Path(sys.argv[1]).resolve()
android = repo / "android"
app = android / "app"

def read(rel):
    return (repo / rel).read_text(encoding="utf-8")

def write(rel, text):
    p = repo / rel
    p.write_text(text, encoding="utf-8")

def replace_once(rel, old, new):
    text = read(rel)
    if old not in text:
        raise RuntimeError(f"pattern not found in {rel}: {old[:100]!r}")
    write(rel, text.replace(old, new, 1))

# ---- Build identity ----
rel = "android/app/build.gradle.kts"
text = read(rel)
text = text.replace('applicationId = "com.xyq.livetranslate"', 'applicationId = "com.greeklive.subtitles"')
text = re.sub(r'versionCode = \d+', 'versionCode = 10011', text, count=1)
text = re.sub(r'versionName = "[^"]+"', 'versionName = "0.1.10"', text, count=1)
write(rel, text)

# ---- English-only UI ----
rel = "android/app/src/main/java/com/xyq/livetranslate/AppLocale.kt"
text = read(rel)
text = re.sub(
    r'fun init\(context: Context\) \{.*?^\s*\}',
    '''fun init(context: Context) {
        applicationContext = context.applicationContext
        AppStrings.init(context)
        save(context, TAG_EN)
        apply(TAG_EN)
    }''',
    text, count=1, flags=re.S | re.M,
)
text = re.sub(
    r'fun normalize\(tag: String\?\): String = when \(tag\) \{.*?^\s*\}',
    'fun normalize(tag: String?): String = TAG_EN',
    text, count=1, flags=re.S | re.M,
)
text = re.sub(
    r'fun current\(context: Context\): String \{.*?^\s*\}',
    'fun current(context: Context): String = TAG_EN',
    text, count=1, flags=re.S | re.M,
)
text = re.sub(
    r'fun save\(context: Context, tag: String\) \{.*?^\s*\}',
    '''fun save(context: Context, tag: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_APP_LANGUAGE, TAG_EN)
            .apply()
    }''',
    text, count=1, flags=re.S | re.M,
)
write(rel, text)

# Hide the now-useless language chooser row.
rel = "android/app/src/main/java/com/xyq/livetranslate/MainActivity.kt"
text = read(rel)
needle = 'val rowLanguage = root.findViewById<View?>(R.id.rowSetLanguage)'
if needle not in text:
    raise RuntimeError("MainActivity language row anchor missing")
text = text.replace(needle, needle + '\n        rowLanguage?.visibility = View.GONE', 1)
write(rel, text)

# ---- Greek as the default translation target ----
rel = "android/app/src/main/java/com/xyq/livetranslate/TranslationPlan.kt"
text = read(rel)
text = text.replace('const val DEFAULT_TARGET_LANGUAGE = "zh"', 'const val DEFAULT_TARGET_LANGUAGE = "el"', 1)
target_anchor = '        TranslationLanguage("ru", "俄语", R.string.rt_lang_ru),\n    )\n\n    fun source'
if target_anchor not in text:
    raise RuntimeError("TranslationLanguageCatalog target anchor missing")
text = text.replace(
    target_anchor,
    '        TranslationLanguage("ru", "俄语", R.string.rt_lang_ru),\n'
    '        TranslationLanguage("el", "希腊语", R.string.rt_lang_el),\n'
    '    )\n\n    fun source',
    1,
)
write(rel, text)

# ---- Speaker-turn protocol ----
rel = "android/app/src/main/java/com/xyq/livetranslate/PromptBuilder.kt"
text = read(rel)
text = re.sub(
    r'private val baseInstruction = """.*?"""\.trimIndent\(\)',
    '''private val baseInstruction = """
        You are a real-time speech translation engine.
        - Translate faithfully. Do not answer, explain, summarize, continue, or invent.
        - Output only the target-language translation plus the special speaker marker ¶ described below.
        - Preserve tone, numbers, proper names, and natural punctuation.
        - SPEAKER TURN PROTOCOL: identify a real speaker change from acoustic identity: timbre, pitch range, vocal formants, cadence, and spectral/voice character.
        - Prefix EVERY acoustic speaker turn with exactly one ¶ character. The first speaker also starts with ¶.
        - The instant the acoustic voice changes to another person, emit ¶ BEFORE that person's translated words. Never merge different speakers into one turn.
        - Do NOT emit a new ¶ for punctuation, sentence endings, short pauses, breathing, music, background noise, emotion, or volume changes by the same person.
        - Keep consecutive speech from the same voice in the same turn, even across several sentences.
        - Do not output speaker names or numbers. Never repeat a previously finalized subtitle.
    """.trimIndent()''',
    text, count=1, flags=re.S,
)
text = text.replace(
    '"输入来自视频或其他应用的连续音频；结合前后文保持字幕连贯。"',
    '"Continuous movie/series audio. Speaker separation is mandatory: emit ¶ exactly when the acoustic speaker identity changes, and keep the same voice in one turn across pauses and sentence endings."',
    1,
)
write(rel, text)

# ---- Stabilizer: whole utterance per speaker, marker => new box ----
stabilizer = r'''package com.xyq.livetranslate

import android.os.Handler

/**
 * GreekLive subtitle stabilizer.
 *
 * Video mode uses an explicit speaker marker (¶) produced by the translation model.
 * A marker finalizes the previous speaker turn immediately, then begins a new box
 * prefixed with "- ". Punctuation alone never splits a video speaker turn.
 */
class SubtitleStabilizer(
    private val handler: Handler,
    private val idleCommitMs: Long = SettingsStore.DEFAULT_STAB_IDLE_MS.toLong(),
    private val maxCurrentChars: Int = SettingsStore.DEFAULT_STAB_MAX_CHARS,
    private val speakerTurnMode: Boolean = false,
    private val onRender: (confirmed: String, current: String) -> Unit,
) {
    companion object {
        private val TERMINATORS = charArrayOf('。', '！', '？', '…', '～', '!', '?')
        private const val SPEAKER_MARKER = '¶'
        private const val DIALOG_PREFIX = "- "
    }

    private val current = StringBuilder()
    private var lastCommitted = ""

    private val idleCommit = Runnable {
        if (speakerTurnMode) {
            commitSpeakerTurn()
        } else {
            commitLegacy(force = true)
        }
        render()
    }

    fun onFragment(t: String) {
        if (t.isEmpty()) return
        if (speakerTurnMode) {
            onSpeakerFragment(t)
        } else {
            appendWithOverlap(t)
            commitLegacy(force = current.length >= maxCurrentChars)
            scheduleIdle()
            render()
        }
    }

    fun reset() {
        handler.removeCallbacks(idleCommit)
        current.setLength(0)
        lastCommitted = ""
    }

    private fun onSpeakerFragment(raw: String) {
        val parts = raw.split(SPEAKER_MARKER)
        if (parts.size == 1) {
            appendWithOverlap(cleanSpeakerText(raw))
        } else {
            val leading = cleanSpeakerText(parts.first())
            if (leading.isNotEmpty()) appendWithOverlap(leading)

            for (i in 1 until parts.size) {
                // A real speaker marker is a hard subtitle boundary.
                if (current.toString().removePrefix(DIALOG_PREFIX).isNotBlank()) {
                    commitSpeakerTurn()
                    // Publish the previous turn to history before starting the next one.
                    render()
                } else {
                    current.setLength(0)
                }

                val piece = cleanSpeakerText(parts[i])
                current.append(DIALOG_PREFIX)
                if (piece.isNotEmpty()) current.append(piece)
            }
        }

        // Safety limit only; normal speaker turns end by marker or silence.
        if (current.length >= maxCurrentChars) {
            commitSpeakerTurn()
        }
        scheduleIdle()
        render()
    }

    private fun cleanSpeakerText(value: String): String {
        var s = value.trimStart()
        while (s.startsWith("-") || s.startsWith("—") || s.startsWith("–")) {
            s = s.drop(1).trimStart()
        }
        return s
    }

    private fun scheduleIdle() {
        handler.removeCallbacks(idleCommit)
        if (current.toString().removePrefix(DIALOG_PREFIX).isNotBlank()) {
            handler.postDelayed(idleCommit, idleCommitMs)
        }
    }

    private fun render() = onRender(lastCommitted, current.toString())

    /** Overlap-merge repeated server fragment tails. */
    private fun appendWithOverlap(frag: String) {
        if (frag.isEmpty()) return
        val tail = current.toString()
        var k = minOf(tail.length, frag.length)
        while (k > 0) {
            if (tail.regionMatches(tail.length - k, frag, 0, k)) break
            k--
        }
        if (k < 2) k = 0
        current.append(frag, k, frag.length)
    }

    private fun commitSpeakerTurn() {
        val sentence = current.toString().trim()
        current.setLength(0)
        if (sentence.isEmpty() || sentence == DIALOG_PREFIX.trim()) return
        if (sentence == lastCommitted || lastCommitted.contains(sentence)) return
        lastCommitted = sentence
    }

    /** Original punctuation-based behavior retained for microphone/live mode. */
    private fun commitLegacy(force: Boolean) {
        val text = current.toString()
        val cut = text.indexOfLast { it in TERMINATORS }
        val done: String
        val rest: String
        when {
            cut >= 0 -> {
                done = text.substring(0, cut + 1)
                rest = text.substring(cut + 1)
            }
            force && text.isNotBlank() -> {
                done = text
                rest = ""
            }
            else -> return
        }
        current.setLength(0)
        current.append(rest)

        val committed = ArrayList<String>()
        for (s in splitSentences(done)) {
            val sentence = s.trim()
            if (sentence.isEmpty()) continue
            if (sentence == lastCommitted || lastCommitted.contains(sentence)) continue
            lastCommitted = sentence
            committed += sentence
        }
        if (committed.isNotEmpty()) lastCommitted = committed.joinToString(separator = "")
    }

    private fun splitSentences(s: String): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        for (ch in s) {
            cur.append(ch)
            if (ch in TERMINATORS) {
                out.add(cur.toString())
                cur.setLength(0)
            }
        }
        if (cur.isNotBlank()) out.add(cur.toString())
        return out
    }
}
'''
write("android/app/src/main/java/com/xyq/livetranslate/SubtitleStabilizer.kt", stabilizer)

# CaptureService: video tuning + speaker-turn mode.
rel = "android/app/src/main/java/com/xyq/livetranslate/CaptureService.kt"
text = read(rel)
text = text.replace(
    'val idleMsSnapshot = SettingsStore.stabIdleMs(this).toLong()\n        val maxCharsSnapshot = SettingsStore.stabMaxChars(this)',
    'val idleMsSnapshot = if (mode == StatusBus.MODE_VIDEO) 1600L else SettingsStore.stabIdleMs(this).toLong()\n'
    '        val maxCharsSnapshot = if (mode == StatusBus.MODE_VIDEO) 220 else SettingsStore.stabMaxChars(this)',
    1,
)
text = text.replace(
    'maxCurrentChars = maxCharsSnapshot,\n        ) { confirmed, current ->',
    'maxCurrentChars = maxCharsSnapshot,\n'
    '            speakerTurnMode = mode == StatusBus.MODE_VIDEO,\n'
    '        ) { confirmed, current ->',
    1,
)
error_map = {
    '"error:会话快照无效"': '"error:invalid session snapshot"',
    '"error:未配置 API Key"': '"error:API key not configured"',
    '"error:前台服务启动失败"': '"error:foreground service failed"',
    '"error:麦克风初始化失败"': '"error:microphone initialization failed"',
    '"error:内录初始化失败"': '"error:playback capture initialization failed"',
    '"error:悬浮窗权限不可用"': '"error:overlay permission unavailable"',
    '"error:屏幕捕获启动失败"': '"error:screen capture failed"',
    '"error:音频采集启动失败"': '"error:audio capture start failed"',
    '"error:音频采集已中断"': '"error:audio capture interrupted"',
    '"error:音频采集异常"': '"error:audio capture error"',
}
for old, new in error_map.items():
    text = text.replace(old, new)
write(rel, text)

# ---- Overlay: 84% width, max 3 lines, no waiting box, auto clear ----
rel = "android/app/src/main/java/com/xyq/livetranslate/SubtitleOverlay.kt"
text = read(rel)
text = text.replace(
    'private var controlsVisible = false',
    '''private var controlsVisible = false

    private val clearRunnable = Runnable {
        latestConfirmed = ""
        latestCurrent = ""
        renderLines()
    }''',
    1,
)
text = text.replace(
    '''            maxLines = 3
            ellipsize = TextUtils.TruncateAt.END
            setLineSpacing''',
    '''            maxLines = 3
            ellipsize = null
            setLineSpacing''',
    1,
)
text = text.replace(
    '            text = context.getString(R.string.rt_overlay_waiting_subtitles)',
    '            text = ""',
    1,
)
text = text.replace(
    '''        applyStyleNow()
        setControlsVisible(true)
        return true''',
    '''        applyStyleNow()
        setControlsVisible(true)
        renderLines()
        return true''',
    1,
)
text = re.sub(
    r'''    fun setLines\(confirmed: String, current: String\) \{.*?^    \}''',
    '''    fun setLines(confirmed: String, current: String) {
        latestConfirmed = confirmed.trim()
        latestCurrent = current.trim()
        root?.removeCallbacks(clearRunnable)
        renderLines()
        if (latestCurrent.isEmpty() && latestConfirmed.isNotEmpty()) {
            val visibleMs = (1600L + latestConfirmed.length * 18L).coerceIn(1800L, 3600L)
            root?.postDelayed(clearRunnable, visibleMs)
        }
    }''',
    text, count=1, flags=re.S | re.M,
)
text = re.sub(
    r'''    private fun renderLines\(\) \{.*?^    \}''',
    '''    private fun renderLines() {
        tvConfirmed?.visibility = View.GONE
        val displayText = when {
            latestCurrent.isNotEmpty() -> latestCurrent
            latestConfirmed.isNotEmpty() -> latestConfirmed
            else -> ""
        }
        val window = root
        val current = tvCurrent
        if (displayText.isEmpty()) {
            current?.text = ""
            current?.visibility = View.GONE
            if (!collapsed) window?.visibility = View.GONE
            return
        }
        window?.visibility = View.VISIBLE
        current?.apply {
            text = displayText
            visibility = View.VISIBLE
        }
    }''',
    text, count=1, flags=re.S | re.M,
)
text = text.replace(
    '        tvCurrent?.maxLines = SettingsStore.overlayMaxLines(context)',
    '        tvCurrent?.maxLines = 3',
    1,
)
text = text.replace(
    '''        val dm = context.resources.displayMetrics
        if (collapsed) {''',
    '''        val dm = context.resources.displayMetrics
        expandedWidth = SubtitleOverlayGeometry.expandedWidth(dm.widthPixels, density)
        if (collapsed) {''',
    1,
)
text = re.sub(
    r'''    fun expandedWidth\(displayWidth: Int, density: Float\): Int \{.*?^    \}''',
    '''    fun expandedWidth(displayWidth: Int, density: Float): Int {
        val margin = (24 * density).roundToInt()
        val available = (displayWidth - margin).coerceAtLeast(1)
        val preferred = (displayWidth * 0.84f).roundToInt()
        val minimum = minOf((240 * density).roundToInt(), available)
        return minOf(preferred, available).coerceAtLeast(minimum)
    }''',
    text, count=1, flags=re.S | re.M,
)
write(rel, text)

# ---- Disable upstream auto-update by default ----
rel = "android/app/src/main/java/com/xyq/livetranslate/SettingsStore.kt"
text = read(rel).replace(
    'prefs(c).getBoolean("autoCheckUpdate", true)',
    'prefs(c).getBoolean("autoCheckUpdate", false)',
    1,
)
write(rel, text)

# ---- Strings: brand, Greek label, media-focused copy ----
def patch_strings(rel, updates, add_el=True):
    p = repo / rel
    tree = ET.parse(p)
    root = tree.getroot()
    by_name = {el.attrib.get("name"): el for el in root.findall("string")}
    for name, value in updates.items():
        if name not in by_name:
            raise RuntimeError(f"missing string {name} in {rel}")
        by_name[name].text = value
    if add_el and "rt_lang_el" not in by_name:
        el = ET.Element("string", {"name": "rt_lang_el"})
        el.text = "Greek / Ελληνικά"
        root.append(el)
    ET.indent(tree, space="    ")
    tree.write(p, encoding="utf-8", xml_declaration=True)

patch_strings(
    "android/app/src/main/res/values-en/strings.xml",
    {
        "app_name": "GreekLive Subtitles",
        "nav_interpretation": "Mic / Live",
        "nav_video": "Media",
        "interp_title": "Mic / Live",
        "interp_sub_status_idle": "Microphone fallback / live interpretation",
        "interp_plan_summary_default": "General · Auto detect → Greek / Ελληνικά",
        "interp_running_meta_default": "Auto detect → Greek / Ελληνικά · General",
        "video_title": "Media · Filmzie / Stremio",
        "video_subtitle": "Creates live Greek subtitles from Filmzie, Stremio and other Android apps that allow playback audio capture.",
        "video_plan_summary_default": "Movies & Series · Auto detect → Greek / Ελληνικά",
        "video_running_meta_default": "Auto detect → Greek / Ελληνικά · Movies & Series",
        "video_sub_status_running": "Other apps' audio · Greek floating subtitles",
        "about_app_slogan": "GreekLive · Live Greek subtitles for media and conversations",
        "about_description": "Real-time Greek translation for Filmzie, Stremio and other Android media apps, with microphone fallback when playback capture is unavailable.",
    },
)
patch_strings(
    "android/app/src/main/res/values/strings.xml",
    {"app_name": "GreekLive Subtitles"},
)

# Scene labels/instructions may live in the same resources. Patch when present.
for rel in [
    "android/app/src/main/res/values-en/strings.xml",
    "android/app/src/main/res/values/strings.xml",
]:
    p = repo / rel
    tree = ET.parse(p)
    root = tree.getroot()
    by_name = {el.attrib.get("name"): el for el in root.findall("string")}
    if "rt_scene_general_video" in by_name:
        by_name["rt_scene_general_video"].text = "Movies & Series"
    if "rt_scene_general_video_instruction" in by_name:
        by_name["rt_scene_general_video_instruction"].text = (
            "For films and series. Translate dialogue naturally into modern Greek. "
            "Preserve names and terminology. Keep one acoustic speaker turn together; "
            "speaker changes are handled by the system speaker-turn marker."
        )
    ET.indent(tree, space="    ")
    tree.write(p, encoding="utf-8", xml_declaration=True)

# ---- Static sanity checks before Gradle ----
assert 'applicationId = "com.greeklive.subtitles"' in read("android/app/build.gradle.kts")
assert 'versionName = "0.1.10"' in read("android/app/build.gradle.kts")
assert 'DEFAULT_TARGET_LANGUAGE = "el"' in read("android/app/src/main/java/com/xyq/livetranslate/TranslationPlan.kt")
assert 'TranslationLanguage("el"' in read("android/app/src/main/java/com/xyq/livetranslate/TranslationPlan.kt")
assert 'speakerTurnMode = mode == StatusBus.MODE_VIDEO' in read("android/app/src/main/java/com/xyq/livetranslate/CaptureService.kt")
assert 'displayWidth * 0.84f' in read("android/app/src/main/java/com/xyq/livetranslate/SubtitleOverlay.kt")
assert 'SPEAKER_MARKER' in read("android/app/src/main/java/com/xyq/livetranslate/SubtitleStabilizer.kt")
print("GreekLive v0.1.10 source patch complete")
