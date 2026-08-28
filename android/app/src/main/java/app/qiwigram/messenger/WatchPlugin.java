package app.qiwigram.messenger;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Мост между мессенджером и сторожем.
 *
 * Со стороны JavaScript это `window.Capacitor.Plugins.Watch`. Ключей и текста
 * переписки сюда не попадает: сторожу передаются только адрес Supabase,
 * публичный ключ и токены входа — ровно то, чем он спрашивает «есть ли
 * непрочитанное». Расшифровать что-либо этим нельзя.
 */
@CapacitorPlugin(name = "Watch")
public class WatchPlugin extends Plugin {

    private static final String PREFS = "qiwi_watch";

    /** Включён ли сторож по мнению самого человека (а не системы). */
    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences p = prefs();
        JSObject r = new JSObject();
        r.put("enabled", p.getBoolean("enabled", false));
        r.put("declined", p.getBoolean("declined", false));
        r.put("canNotify", canNotify());
        r.put("batteryFree", batteryFree());
        call.resolve(r);
    }

    /**
     * Запустить сторожа. Токены нужны, чтобы он мог спрашивать сервер от имени
     * вошедшего; без них он молча ничего не делает.
     */
    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String key = call.getString("key");
        String access = call.getString("access");
        String refresh = call.getString("refresh");

        if (url == null || key == null || access == null) {
            call.reject("не переданы данные для подключения");
            return;
        }

        prefs().edit()
                .putString("url", url)
                .putString("key", key)
                .putString("access", access)
                .putString("refresh", refresh == null ? "" : refresh)
                .putBoolean("enabled", true)
                .putBoolean("declined", false)
                .apply();

        Intent i = new Intent(getContext(), WatchService.class);
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    /** Обновить токены у уже работающего сторожа, не трогая его самого. */
    @PluginMethod
    public void refreshTokens(PluginCall call) {
        String access = call.getString("access");
        String refresh = call.getString("refresh");
        SharedPreferences.Editor e = prefs().edit();
        if (access != null) e.putString("access", access);
        if (refresh != null) e.putString("refresh", refresh);
        e.apply();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean("enabled", false).apply();
        getContext().stopService(new Intent(getContext(), WatchService.class));
        call.resolve();
    }

    /** Запомнить отказ. Предлагать снова будем, но не в этот раз. */
    @PluginMethod
    public void decline(PluginCall call) {
        prefs().edit().putBoolean("declined", true).putBoolean("enabled", false).apply();
        call.resolve();
    }

    /**
     * Системное окно «разрешить уведомления». До Android 13 разрешение
     * выдавалось само, и спрашивать нечего.
     */
    @PluginMethod
    public void askNotifications(PluginCall call) {
        if (canNotify()) {
            call.resolve();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Activity a = getActivity();
            if (a != null) a.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7411);
        }
        call.resolve();
    }

    /**
     * Системное окно «не экономить батарею на этом приложении». Без него
     * телефон усыпляет сторожа через несколько часов, и уведомления
     * начинают приходить с задержкой в полдня или не приходить вовсе.
     */
    @PluginMethod
    public void askBattery(PluginCall call) {
        if (batteryFree() || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            call.resolve();
            return;
        }
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(i);
        } catch (Exception e) {
            // на части прошивок такого окна нет — не беда, сторож просто
            // будет засыпать чаще
        }
        call.resolve();
    }

    // ------------------------------------------------------------- мелочи

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean canNotify() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean batteryFree() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }
}
