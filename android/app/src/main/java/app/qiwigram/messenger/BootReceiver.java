package app.qiwigram.messenger;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

/**
 * Возвращает сторожа после перезагрузки телефона.
 *
 * Без этого всё выглядит хуже, чем если бы уведомлений не было вовсе:
 * они работают, человек на них полагается, а после первой же перезагрузки
 * тихо перестают приходить — и понять, почему, нельзя.
 *
 * Поднимаем только если человек сам включал сторожа: непрошено занимать
 * место в шторке после каждой перезагрузки нельзя.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        SharedPreferences p = context.getSharedPreferences("qiwi_watch", Context.MODE_PRIVATE);
        if (!p.getBoolean("enabled", false)) return;
        // без токенов сторожу нечего спрашивать у сервера
        if (p.getString("access", null) == null) return;

        ContextCompat.startForegroundService(context, new Intent(context, WatchService.class));
    }
}
