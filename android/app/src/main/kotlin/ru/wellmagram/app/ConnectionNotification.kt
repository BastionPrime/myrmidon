package ru.wellmagram.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

object ConnectionNotification {
    const val CHANNEL_ID = "wellmagram_connection"
    const val NOTIFICATION_ID = 2001
    const val ACTION_PAUSE = "ru.wellmagram.app.PAUSE_CONNECTION"

    fun ensureChannel(ctx: Context) {
        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Соединение",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Статус фонового соединения wellmagram"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    fun build(ctx: Context, accountsConnected: Int): Notification {
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val contentIntent = PendingIntent.getActivity(
            ctx,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val pauseIntent = PendingIntent.getBroadcast(
            ctx,
            1,
            Intent(ctx, PauseReceiver::class.java).setAction(ACTION_PAUSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = if (accountsConnected > 0) {
            "$accountsConnected аккаунт(а) подключено"
        } else {
            "Соединение устанавливается…"
        }
        return Notification.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("wellmagram")
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(
                Notification.Action.Builder(
                    null,
                    "Пауза",
                    pauseIntent,
                ).build(),
            )
            .build()
    }

    fun manager(ctx: Context): NotificationManager =
        ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
}
