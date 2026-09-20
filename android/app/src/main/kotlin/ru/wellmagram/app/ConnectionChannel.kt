package ru.wellmagram.app

import android.content.Context
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Platform ⇄ Dart bridge for the background connection (per plan-v3 Т-1.9):
 * the service pushes reconnect/pause signals and account-count updates;
 * Dart pushes connected-account counts back for the notification.
 */
object ConnectionChannel {
    private const val TAG = "WlgChannel"

    fun sendReconnect(engine: FlutterEngine, app: Context) {
        invoke(engine, app, "reconnect", null)
    }

    fun sendPause(engine: FlutterEngine, app: Context) {
        invoke(engine, app, "pause", null)
    }

    fun sendAccountsConnected(engine: FlutterEngine, app: Context, count: Int) {
        invoke(engine, app, "accountsConnected", count)
    }

    /** Called from the Dart side over the same channel name. */
    const val CHANNEL_NAME = "ru.wellmagram.app/connection"

    private fun invoke(engine: FlutterEngine, app: Context, method: String, arg: Any?) {
        try {
            MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL_NAME)
                .invokeMethod(method, arg)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "invoke $method failed: ${e.message}")
        }
    }
}
