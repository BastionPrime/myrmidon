package ru.wellmagram.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class PauseReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != ConnectionNotification.ACTION_PAUSE) return
        val app = ctx.applicationContext
        ConnectionState.paused = true
        ConnectionEngine.get(app).pause()
        ConnectionForegroundService.refresh(app)
    }
}
