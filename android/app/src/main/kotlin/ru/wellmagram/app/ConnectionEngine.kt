package ru.wellmagram.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.dart.DartExecutor

/**
 * Keeps a background Flutter engine alive for the whole process lifetime
 * (ConnectionForegroundService holds the process up; the engine keeps the
 * Dart side — session manager and reconnect loop — running under Doze).
 *
 * The engine is created once and cached under [ENGINE_ID] via
 * FlutterEngineCache, exactly like MainActivity does for the UI engine, so
 * the UI reuses the same engine when the app comes to the foreground.
 */
class ConnectionEngine private constructor(private val appContext: Context) {

    companion object {
        const val ENGINE_ID = "wellmagram_connection"
        private const val TAG = "WlgEngine"

        @Volatile
        private var instance: ConnectionEngine? = null

        fun get(app: Context): ConnectionEngine =
            instance ?: synchronized(this) {
                instance ?: ConnectionEngine(app.applicationContext).also { instance = it }
            }
    }

    val engine: FlutterEngine = FlutterEngine(appContext)

    fun startDart() {
        if (engine.dartExecutor.isExecutingDart) return
        engine.dartExecutor.executeDartEntrypoint(
            DartExecutor.DartEntrypoint.createDefault(),
        )
    }

    /** Reconnect signal from the platform side into the Dart controller. */
    fun signalReconnect() {
        ConnectionChannel.sendReconnect(engine, appContext)
    }

    fun pause() {
        ConnectionChannel.sendPause(engine, appContext)
    }

    /** Exponential backoff for reconnect attempts (per plan-v3 Т-1.9). */
    fun scheduleReconnect(attempt: Int, baseMs: Long, maxMs: Long, runnable: () -> Unit) {
        val delay = backoffDelayMs(attempt, baseMs, maxMs)
        Log.d(TAG, "reconnect attempt=$attempt in ${delay}ms")
        Handler(Looper.getMainLooper()).postDelayed(runnable, delay)
    }

    private fun backoffDelayMs(attempt: Int, baseMs: Long, maxMs: Long): Long {
        if (attempt <= 0) return baseMs
        var delay = baseMs
        repeat(attempt - 1) {
            delay *= 2
            if (delay >= maxMs) return maxMs
        }
        return minOf(delay, maxMs)
    }
}

object ConnectionState {
    @Volatile
    var paused: Boolean = false

    @Volatile
    var accountsConnected: Int = 0
}
