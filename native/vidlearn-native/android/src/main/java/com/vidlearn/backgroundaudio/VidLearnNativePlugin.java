package com.vidlearn.backgroundaudio;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * VidLearn — יכולות אנדרואיד שאין בתוספים הרגילים.
 * ניגון ברקע: כשמנגנים, מפעילים שירות קדמה (התראה "מנגן…") שמונע מאנדרואיד להקפיא
 * את האפליקציה כשהמסך כבוי או כשעוברים לאפליקציה אחרת. כשעוצרים — השירות נעצר.
 */
@CapacitorPlugin(
    name = "VidLearnNative",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class VidLearnNativePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // אנדרואיד 13+: בלי הרשאת התראות השירות עדיין עובד, רק בלי התראה גלויה — מבקשים פעם אחת
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED
                && !getContext().getSharedPreferences("vidlearn", Context.MODE_PRIVATE).getBoolean("askedNotif", false)) {
            getContext().getSharedPreferences("vidlearn", Context.MODE_PRIVATE).edit().putBoolean("askedNotif", true).apply();
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        doStart(call);
    }

    private void doStart(PluginCall call) {
        Intent intent = new Intent(getContext(), PlaybackService.class);
        intent.setAction(PlaybackService.ACTION_START);
        intent.putExtra("title", call.getString("title", ""));
        intent.putExtra("text", call.getString("text", ""));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception e) {
            // למשל: אנדרואיד חוסם שירות קדמה כשהאפליקציה כבר ברקע — לא מפיל את הנגן
            call.reject("start-failed", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), PlaybackService.class);
        getContext().stopService(intent);
        call.resolve();
    }

    /** קובץ שנשמר בתיקייה ציבורית (Download/VidLearn) ← נכנס לאינדקס, ונראה בנגן המוזיקה ובגלריה */
    @PluginMethod
    public void scanFile(PluginCall call) {
        String path = call.getString("path", "");
        if (path.startsWith("file://")) path = android.net.Uri.parse(path).getPath();
        if (path == null || path.isEmpty()) {
            call.reject("no-path");
            return;
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { path }, null, null);
        call.resolve();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }
}
