package ru.wellmagram.app

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * ConnectionForegroundService (plan-v3 Т-1.9): keeps MAX sessions (active
 * or parallel) and TDLib clients alive with a background Flutter engine.
 *
 * FGS type remoteMessaging (targetSdk >= 34; dataSync as the fallback for
 * older builds), BOOT_COMPLETED autostart, exponential-backoff reconnect
 * with network-change awareness, notification
 * «wellmagram: N аккаунтов подключено» + «Пауза».
 */
class ConnectionForegroundService : Service() {

    companion object {
        private const val TAG = "WlgService"
        private const val RECONNECT_BASE_MS = 1000L
        private const val RECONNECT_MAX_MS = 60_000L

        fun start(ctx: Context) {
            val intent = Intent(ctx, ConnectionForegroundService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(intent)
                } else {
                    ctx.startService(intent)
                }
            } catch (e: Exception) {
                Log.w(TAG, "service start failed: ${e.message}")
            }
        }

        fun stop(ctx: Context) {
            try {
                ctx.stopService(Intent(ctx, ConnectionForegroundService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "service stop failed: ${e.message}")
            }
        }

        fun refresh(ctx: Context) {
            try {
                ConnectionNotification.manager(ctx)
                    .notify(
                        ConnectionNotification.NOTIFICATION_ID,
                        ConnectionNotification.build(ctx, ConnectionState.accountsConnected),
                    )
            } catch (e: Exception) {
                Log.w(TAG, "notification refresh failed: ${e.message}")
            }
        }
    }

    private var inForeground = false
    private var reconnectAttempt = 0
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ConnectionNotification.ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (ConnectionState.paused) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            inForeground = false
            stopSelf()
            return START_NOT_STICKY
        }
        goForeground()
        val engine = ConnectionEngine.get(applicationContext)
        engine.startDart()
        registerNetworkCallback()
        engine.signalReconnect()
        return START_STICKY
    }

    override fun onDestroy() {
        unregisterNetworkCallback()
        if (inForeground) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            inForeground = false
        }
        super.onDestroy()
    }

    private fun goForeground() {
        val notification =
            ConnectionNotification.build(this, ConnectionState.accountsConnected)
        if (inForeground) {
            ConnectionNotification.manager(this)
                .notify(ConnectionNotification.NOTIFICATION_ID, notification)
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    ConnectionNotification.NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
                )
            } else {
                startForeground(ConnectionNotification.NOTIFICATION_ID, notification)
            }
            inForeground = true
        } catch (e: Exception) {
            Log.w(TAG, "startForeground failed: ${e.message}")
            stopSelf()
        }
    }

    /**
     * Reconnect with exponential backoff (base 1s, cap 60s); the network
     * callback resets the attempt counter when connectivity returns, so a
     * network change is accounted for per plan-v3 Т-1.9.
     */
    fun scheduleReconnect(engine: ConnectionEngine) {
        if (ConnectionState.paused) return
        reconnectAttempt++
        engine.scheduleReconnect(
            reconnectAttempt,
            RECONNECT_BASE_MS,
            RECONNECT_MAX_MS,
        ) {
            if (ConnectionState.paused) return@scheduleReconnect
            engine.signalReconnect()
            refresh(applicationContext)
        }
    }

    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                reconnectAttempt = 0
                ConnectionEngine.get(applicationContext).signalReconnect()
                refresh(applicationContext)
            }

            override fun onLost(network: Network) {
                refresh(applicationContext)
            }

            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) {
                val validated = capabilities.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_VALIDATED,
                )
                if (validated && reconnectAttempt > 0) {
                    reconnectAttempt = 0
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: Exception) {
            Log.w(TAG, "network callback registration failed: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        val callback = networkCallback ?: return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        try {
            cm.unregisterNetworkCallback(callback)
        } catch (e: Exception) {
            Log.w(TAG, "network callback unregister failed: ${e.message}")
        }
        networkCallback = null
    }
}

class ConnectionBootReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val app = ctx.applicationContext
        ConnectionForegroundService.start(app)
    }
}
