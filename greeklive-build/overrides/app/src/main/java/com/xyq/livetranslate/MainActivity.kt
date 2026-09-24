package com.xyq.livetranslate

import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.xyq.livetranslate.ui.HistoryController
import com.xyq.livetranslate.ui.HistoryViews
import com.xyq.livetranslate.ui.MainNavigator
import com.xyq.livetranslate.ui.MainNavigatorViews
import com.xyq.livetranslate.ui.ModeHomeController
import com.xyq.livetranslate.ui.ModeHomeViews
import com.xyq.livetranslate.ui.PendingSessionSnapshot
import com.xyq.livetranslate.ui.SceneLibraryController
import com.xyq.livetranslate.ui.SceneLibraryViews
import com.xyq.livetranslate.ui.SessionContextController
import com.xyq.livetranslate.ui.SessionCoordinator
import com.xyq.livetranslate.ui.SessionHost
import com.xyq.livetranslate.ui.SettingsController
import com.xyq.livetranslate.ui.SettingsViews
import com.xyq.livetranslate.ui.UiRuntimeStatus
import com.xyq.livetranslate.ui.UpdateController

class MainActivity : AppCompatActivity() {
    private lateinit var navigator: MainNavigator
    private lateinit var historyController: HistoryController
    private lateinit var sceneLibraryController: SceneLibraryController
    private lateinit var settingsController: SettingsController
    private lateinit var updateController: UpdateController
    private lateinit var sessionContextController: SessionContextController
    private lateinit var sessionCoordinator: SessionCoordinator
    private lateinit var modeHomeControllers: Map<TranslationMode, ModeHomeController>

    private val ui = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            renderStatus()
            ui.postDelayed(this, 300)
        }
    }

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            sessionCoordinator.onAudioPermissionResult()
        }
    private val projLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            sessionCoordinator.onProjectionResult(result.resultCode, result.data)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        TranslationPlanStore.migrateLegacySavedPlans(this)
        setContentView(R.layout.activity_main)
        val root = findViewById<View>(R.id.rootLayout)
        val navigatorViews = MainNavigatorViews.bind(root)

        navigator = MainNavigator(
            views = navigatorViews,
            onMainPageShown = { pageId ->
                if (pageId == R.id.nav_history) historyController.reload()
            },
            onSubPageShown = { pageId ->
                if (pageId == R.id.pageSceneLibrary) sceneLibraryController.reload()
            },
            beforeSubPageClosed = { pageId ->
                if (pageId == R.id.pageSettingsProfileAi || pageId == R.id.pageSettingsTranslate) {
                    settingsController.persistDraftInputs()
                }
            },
        )

        val interpViews = ModeHomeViews.bind(root, TranslationMode.INTERPRETATION)
        val videoViews = ModeHomeViews.bind(root, TranslationMode.VIDEO)
        val homeControllers = mutableMapOf<TranslationMode, ModeHomeController>()

        historyController = HistoryController(
            context = this,
            views = HistoryViews.bind(root),
            openDetailPage = { returnTabId ->
                navigator.openSub(R.id.pageHistoryDetail, returnTabId)
            },
            closeDetailPage = { navigator.closeSub() },
            toast = ::toast,
        )
        sceneLibraryController = SceneLibraryController(
            context = this,
            views = SceneLibraryViews.bind(navigatorViews.pageSceneLibrary),
            openPage = { returnTabId ->
                navigator.openSub(R.id.pageSceneLibrary, returnTabId)
            },
            onSceneChanged = { mode -> homeControllers[mode]?.refreshConfiguration() },
            toast = ::toast,
        )
        sceneLibraryController.restoreState(savedInstanceState)

        updateController = UpdateController(
            activity = this,
            postToUi = { action -> runOnUiThread { action() } },
            isHostActive = { !isFinishing && !isDestroyed },
            launchIntent = ::startActivity,
            toast = ::toast,
        )
        settingsController = SettingsController(
            context = this,
            views = SettingsViews.bind(root),
            openSubPage = { pageId -> navigator.openSub(pageId) },
            openSceneLibrary = { mode -> openSceneLibrary(mode) },
            postToUi = { action -> runOnUiThread { action() } },
            isHostActive = { !isFinishing && !isDestroyed },
            launchIntent = ::startActivity,
            toast = ::toast,
            onCheckUpdate = { updateController.check(manual = true) },
        )
        updateController.onStatusChanged = settingsController::renderUpdateStatus
        sessionContextController = SessionContextController(
            context = this,
            interpretationViews = interpViews,
            videoViews = videoViews,
            persistSecondAiInputs = settingsController::persistSecondAiInputs,
            openAiSettings = ::openAiSettings,
            postToUi = { action -> runOnUiThread { action() } },
            isHostActive = { !isFinishing && !isDestroyed },
            toast = ::toast,
        )
        sessionContextController.restoreState(savedInstanceState)

        sessionCoordinator = SessionCoordinator(
            context = this,
            persistDraftInputs = settingsController::persistDraftInputs,
            host = createSessionHost(),
        ).also { it.restoreState(savedInstanceState) }

        homeControllers[TranslationMode.INTERPRETATION] = ModeHomeController(
            context = this,
            mode = TranslationMode.INTERPRETATION,
            views = interpViews,
            toggleSession = sessionCoordinator::onModeToggle,
            openSceneLibrary = ::openSceneLibrary,
            openOverlaySettings = ::openOverlaySettings,
            openMainTab = { tabId -> navigator.showMain(tabId) },
        )
        homeControllers[TranslationMode.VIDEO] = ModeHomeController(
            context = this,
            mode = TranslationMode.VIDEO,
            views = videoViews,
            toggleSession = sessionCoordinator::onModeToggle,
            openSceneLibrary = ::openSceneLibrary,
            openOverlaySettings = ::openOverlaySettings,
            openMainTab = { tabId -> navigator.showMain(tabId) },
        )
        modeHomeControllers = homeControllers.toMap()
        sessionCoordinator.bindSessionContextAccess(sessionContextController)

        historyController.setup()
        sceneLibraryController.setup()
        settingsController.setup()
        sessionContextController.setup()
        modeHomeControllers.values.forEach(ModeHomeController::setup)

        renderStatus()
        navigator.setup(savedInstanceState)
        if (savedInstanceState == null) applySessionTabIntent(intent)
        bindLanguageSettings(root)
        updateController.autoCheckOnLaunch()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applySessionTabIntent(intent)
    }

    private fun applySessionTabIntent(intent: Intent?) {
        val tabId = when (intent?.getStringExtra(EXTRA_OPEN_SESSION_TAB)) {
            StatusBus.MODE_VIDEO -> R.id.nav_video
            StatusBus.MODE_MIC -> R.id.nav_interp
            else -> return
        }
        navigator.showMain(tabId)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        sessionCoordinator.saveState(outState)
        sessionContextController.saveState(outState)
        navigator.saveState(outState)
        sceneLibraryController.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        if (::sessionCoordinator.isInitialized) sessionCoordinator.onHostResume()
        if (::updateController.isInitialized) updateController.onHostResume()
        if (::modeHomeControllers.isInitialized) {
            modeHomeControllers.values.forEach(ModeHomeController::refreshConfiguration)
        }
        findViewById<View?>(R.id.rootLayout)?.let(::bindLanguageSettings)
        ui.removeCallbacks(refresh)
        ui.post(refresh)
    }

    override fun onPause() {
        if (::settingsController.isInitialized) settingsController.persistDraftInputs()
        super.onPause()
        ui.removeCallbacks(refresh)
    }

    override fun onDestroy() {
        if (::sessionContextController.isInitialized) sessionContextController.destroy()
        super.onDestroy()
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (!navigator.handleBack()) {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    private fun createSessionHost(): SessionHost = object : SessionHost {
        override fun checkPermission(permission: String): Boolean =
            checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED

        override fun requestPermissions(permissions: Array<String>) = permLauncher.launch(permissions)
        override fun canDrawOverlays(): Boolean = Settings.canDrawOverlays(this@MainActivity)
        override fun openOverlaySettings() = this@MainActivity.openOverlaySettings()
        override fun launchProjection(intent: Intent) = projLauncher.launch(intent)
        override fun isTelevision(): Boolean =
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
                (resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK) ==
                Configuration.UI_MODE_TYPE_TELEVISION

        override fun chooseVideoApp(onSelected: (String) -> Unit, onCancel: () -> Unit) {
            val candidates = listOf(
                "Filmzie" to "com.filmzie.platform",
                "Stremio" to "com.stremio.one",
                "Stremio (legacy)" to "com.stremio.mobile",
                "TV Bro" to "com.phlox.tvwebbrowser",
            ).filter { (_, packageName) ->
                packageManager.getLaunchIntentForPackage(packageName) != null
            }

            if (candidates.isEmpty()) {
                toast("Δεν βρέθηκε Filmzie, Stremio ή TV Bro στη συσκευή.")
                onCancel()
                return
            }

            MaterialAlertDialogBuilder(this@MainActivity)
                .setTitle("Επιλογή εφαρμογής")
                .setItems(candidates.map { it.first }.toTypedArray()) { _, which ->
                    onSelected(candidates[which].second)
                }
                .setOnCancelListener { onCancel() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> onCancel() }
                .show()
        }

        override fun launchPackage(packageName: String) {
            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent == null) {
                toast("Η επιλεγμένη εφαρμογή δεν μπορεί να ανοίξει.")
                return
            }
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ui.postDelayed({ startActivity(launchIntent) }, 350L)
        }

        override fun startForegroundService(intent: Intent) {
            this@MainActivity.startForegroundService(intent)
        }
        override fun startService(intent: Intent) {
            this@MainActivity.startService(intent)
        }
        override fun openTranslationSettings() {
            if (navigator.showMain(R.id.nav_settings)) {
                navigator.openSub(R.id.pageSettingsTranslate)
            }
        }
        override fun toast(message: String) = this@MainActivity.toast(message)
    }

    private fun openAiSettings(returnTabId: Int) {
        navigator.openSub(R.id.pageSettingsProfileAi, returnTabId)
    }

    private fun openOverlaySettings() {
        if (Settings.canDrawOverlays(this)) return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.permission_overlay_title)
            .setMessage(R.string.permission_overlay_message)
            .setNegativeButton(R.string.permission_cancel, null)
            .setPositiveButton(R.string.permission_grant) { _, _ ->
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:$packageName"),
                    ),
                )
            }
            .show()
    }

    private fun renderStatus() {
        val status = UiRuntimeStatus.capture(
            overlayAllowed = Settings.canDrawOverlays(this),
        )
        modeHomeControllers.getValue(TranslationMode.INTERPRETATION).render(status)
        modeHomeControllers.getValue(TranslationMode.VIDEO).render(status)
        settingsController.renderDiagnostics(status.toDiagnostics())
    }

    internal fun openSceneLibrary(mode: TranslationMode, returnTabId: Int = R.id.nav_settings) {
        sceneLibraryController.open(mode, returnTabId)
    }

    internal fun renderStatusForTest() = renderStatus()

    internal fun refreshHomeScenesForTest(mode: TranslationMode) {
        modeHomeControllers.getValue(mode).refreshHomeScenesForTest()
    }

    internal fun installPendingSessionForTest(snapshot: PendingSessionSnapshot) {
        sessionCoordinator.installPendingSnapshotForTest(snapshot)
    }

    internal fun captureStartIntentForTest(): Intent = sessionCoordinator.captureStartIntentForTest()

    internal fun prepareSessionSettingsForTest(captureMode: String): Boolean =
        sessionCoordinator.prepareSessionSettingsForTest(captureMode)

    internal fun showLanguageSelectionDialog() {
        val currentTag = AppLocale.current(this)
        val tags = arrayOf(AppLocale.TAG_SYSTEM, AppLocale.TAG_ZH_HANS, AppLocale.TAG_EN)
        val items = arrayOf(
            getString(R.string.locale_option_system),
            getString(R.string.locale_option_zh_hans),
            getString(R.string.locale_option_en),
        )
        val checkedItem = when (currentTag) {
            AppLocale.TAG_ZH_HANS -> 1
            AppLocale.TAG_EN -> 2
            else -> 0
        }

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.locale_dialog_title)
            .setSingleChoiceItems(items, checkedItem) { dialog, which ->
                val selectedTag = tags.getOrElse(which) { AppLocale.TAG_SYSTEM }
                dialog.dismiss()
                if (selectedTag != currentTag) {
                    AppLocale.saveAndApply(this, selectedTag)
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun bindLanguageSettings(root: View) {
        val rowLanguage = root.findViewById<View?>(R.id.rowSetLanguage)
        rowLanguage?.visibility = View.GONE
        val tvValue = root.findViewById<TextView?>(R.id.tvSettingsLanguageValue)
        if (tvValue != null) {
            val label = when (AppLocale.current(this)) {
                AppLocale.TAG_ZH_HANS -> getString(R.string.locale_option_zh_hans)
                AppLocale.TAG_EN -> getString(R.string.locale_option_en)
                else -> getString(R.string.locale_option_system)
            }
            tvValue.text = label
        }
        rowLanguage?.setOnClickListener {
            showLanguageSelectionDialog()
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    companion object {
        const val EXTRA_OPEN_SESSION_TAB = "extraOpenSessionTab"
    }
}
