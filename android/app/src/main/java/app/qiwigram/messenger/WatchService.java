package app.qiwigram.messenger;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Сторож переписки.
 *
 * Обычные уведомления на Android доставляет сервис Google: он будит нужное
 * приложение, даже когда телефон спит. Пройти регистрацию в Firebase не
 * получилось — она требует подтверждения по номеру телефона, — поэтому
 * приложение сторожит переписку само: висит в фоне и раз в полминуты
 * спрашивает у сервера, не появилось ли непрочитанного.
 *
 * Цена честно видна человеку: Android не позволяет работать в фоне молча
 * и требует показывать постоянное уведомление. Оно же служит выключателем.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ — текста сообщений. Переписка зашифрована
 * ключами, которые живут только в браузерной части приложения; сервер и этот
 * сторож видят лишь то, что сообщение существует, и от кого оно. Поэтому
 * уведомление говорит «новое сообщение», а не пересказывает его.
 */
public class WatchService extends Service {

    private static final String TAG = "QiwiWatch";

    /** Канал для постоянного уведомления о работе — тихий, без звука. */
    private static final String CH_ONGOING = "qiwi_watch";
    /** Канал для собственно сообщений — со звуком. */
    private static final String CH_MESSAGES = "qiwi_messages";

    private static final int ID_ONGOING = 1;

    /* Полминуты — компромисс. Чаще заметно бьёт по батарее, реже
       превращает мессенджер в почту, которую проверяешь раз в час. */
    private static final long POLL_MS = 30_000L;

    private static final String PREFS = "qiwi_watch";

    private volatile boolean running = false;
    private Thread worker = null;

    /** Что уже показывали: чат -> время последнего сообщения в нём. */
    private final Map<String, String> seen = new HashMap<>();

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels();

        /* С Android 14 служба обязана при запуске назвать, чем занимается,
           иначе система гасит её с исключением на месте. */
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID_ONGOING, buildOngoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(ID_ONGOING, buildOngoing());
        }

        if (!running) {
            running = true;
            worker = new Thread(this::loop, "qiwi-watch");
            worker.start();
        }

        /* START_STICKY — если систему прижмёт по памяти и она убьёт сервис,
           пусть поднимет его обратно, когда станет свободнее. */
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ цикл

    private void loop() {
        // Первый заход без показа: он лишь запоминает, что уже есть,
        // иначе включение сторожа выстрелило бы уведомлением по каждому
        // непрочитанному чату разом.
        boolean first = true;

        while (running) {
            try {
                JSONArray chats = fetchOverview();
                if (chats != null) {
                    check(chats, first);
                    first = false;
                }
            } catch (Exception e) {
                Log.w(TAG, "опрос не удался: " + e.getMessage());
            }

            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    private void check(JSONArray chats, boolean silent) {
        for (int i = 0; i < chats.length(); i++) {
            JSONObject c = chats.optJSONObject(i);
            if (c == null) continue;

            String id = c.optString("chat_id", "");
            String at = c.optString("last_at", "");
            int unread = c.optInt("unread", 0);
            if (id.isEmpty() || at.isEmpty()) continue;

            String was = seen.get(id);
            seen.put(id, at);

            // показываем только то, что и ново, и не прочитано
            if (silent || unread <= 0) continue;
            if (was == null || was.equals(at)) continue;

            notifyMessage(c);
        }
    }

    // -------------------------------------------------------------- сеть

    /**
     * Тот же запрос, что делает само приложение, когда обновляет список чатов.
     * Отдаёт непрочитанное по каждому чату — большего сторожу и не надо.
     */
    private JSONArray fetchOverview() throws Exception {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String base = p.getString("url", null);
        String key = p.getString("key", null);
        String token = p.getString("access", null);
        if (base == null || key == null || token == null) return null;

        String body = post(base + "/rest/v1/rpc/chat_overview", key, token, "{}");

        /* Пропуск обычно означает просроченный токен: он живёт около часа,
           а сторож — сутками. Обновляем и пробуем ещё раз, иначе уведомления
           тихо перестанут приходить через час после входа. */
        if (body == null) {
            if (!refresh()) return null;
            token = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("access", null);
            if (token == null) return null;
            body = post(base + "/rest/v1/rpc/chat_overview", key, token, "{}");
            if (body == null) return null;
        }

        return new JSONArray(body);
    }

    /** Возвращает тело ответа, либо null, если сервер отказал. */
    private String post(String url, String key, String token, String payload) {
        HttpURLConnection con = null;
        try {
            con = (HttpURLConnection) new URL(url).openConnection();
            con.setRequestMethod("POST");
            con.setConnectTimeout(15000);
            con.setReadTimeout(20000);
            con.setRequestProperty("apikey", key);
            if (token != null) con.setRequestProperty("Authorization", "Bearer " + token);
            con.setRequestProperty("Content-Type", "application/json");
            con.setDoOutput(true);

            try (OutputStream os = con.getOutputStream()) {
                os.write(payload.getBytes(StandardCharsets.UTF_8));
            }

            int code = con.getResponseCode();
            if (code < 200 || code >= 300) return null;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(con.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        } finally {
            if (con != null) con.disconnect();
        }
    }

    /** Меняет просроченный токен на свежий по refresh-токену. */
    private boolean refresh() {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String base = p.getString("url", null);
        String key = p.getString("key", null);
        String rt = p.getString("refresh", null);
        if (base == null || key == null || rt == null) return false;

        String body = post(base + "/auth/v1/token?grant_type=refresh_token", key, null,
                "{\"refresh_token\":\"" + rt + "\"}");
        if (body == null) return false;

        try {
            JSONObject j = new JSONObject(body);
            String access = j.optString("access_token", "");
            String next = j.optString("refresh_token", "");
            if (access.isEmpty()) return false;

            SharedPreferences.Editor e = p.edit();
            e.putString("access", access);
            if (!next.isEmpty()) e.putString("refresh", next);
            e.apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------ уведомления

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        // именно приведением, а не getSystemService(Class): вариант с классом
        // появился в API 23, а приложение обязано собираться начиная с 22
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

        NotificationChannel ongoing = new NotificationChannel(
                CH_ONGOING, "Работа в фоне", NotificationManager.IMPORTANCE_MIN);
        ongoing.setDescription("Постоянное уведомление, без которого Android не разрешает следить за перепиской");
        ongoing.setShowBadge(false);
        nm.createNotificationChannel(ongoing);

        NotificationChannel messages = new NotificationChannel(
                CH_MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Новые сообщения в переписке");
        nm.createNotificationChannel(messages);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private Notification buildOngoing() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CH_ONGOING)
                : new Notification.Builder(this);

        return b.setContentTitle("Qiwigram следит за перепиской")
                .setContentText("Чтобы приходили уведомления")
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(openApp())
                .setOngoing(true)
                .build();
    }

    private void notifyMessage(JSONObject chat) {
        String title = chat.optString("title", "");
        if (title.isEmpty()) title = chat.optString("peer_name", "");
        if (title.isEmpty()) title = chat.optString("peer_username", "");
        if (title.isEmpty()) title = "Новое сообщение";

        /* Текста тут нет и быть не может: он зашифрован, а ключ лежит
           в другой половине приложения. Пишем честно — «новое сообщение». */
        int n = chat.optInt("unread", 1);
        String text = n > 1 ? ("Новых сообщений: " + n) : "Новое сообщение";

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CH_MESSAGES)
                : new Notification.Builder(this);

        Notification note = b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .build();

        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        // id из чата: сообщения одного чата заменяют друг друга,
        // а не копятся столбиком
        nm.notify(chat.optString("chat_id", "?").hashCode(), note);
    }
}
