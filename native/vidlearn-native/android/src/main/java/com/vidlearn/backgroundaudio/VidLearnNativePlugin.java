package com.vidlearn.backgroundaudio;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.media.MediaScannerConnection;
import android.os.Build;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;

import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;

/**
 * VidLearn — יכולות אנדרואיד שאין בתוספים הרגילים.
 * ניגון ברקע: כשמנגנים, מפעילים שירות קדמה (התראה "מנגן…") שמונע מאנדרואיד להקפיא
 * את האפליקציה כשהמסך כבוי או כשעוברים לאפליקציה אחרת. כשעוצרים — השירות נעצר.
 * כניסה עם Google: טוקן גישה (Google Identity — AuthorizationClient) ליוטיוב ולסנכרון ב-Drive.
 */
@CapacitorPlugin(
    name = "VidLearnNative",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class VidLearnNativePlugin extends Plugin {

    // יוטיוב (חיפוש), קובץ הסנכרון בתיקייה הנסתרת של האפליקציה ב-Drive, ושם + מייל להצגה
    private static final List<Scope> GOOGLE_SCOPES = Arrays.asList(
        new Scope("https://www.googleapis.com/auth/youtube.readonly"),
        new Scope("https://www.googleapis.com/auth/drive.appdata"),
        new Scope("https://www.googleapis.com/auth/userinfo.email"),
        new Scope("https://www.googleapis.com/auth/userinfo.profile")
    );

    private ActivityResultLauncher<IntentSenderRequest> authLauncher;
    private PluginCall pendingAuth;

    @Override
    public void load() {
        // מסך ההסכמה של Google חוזר לכאן. הרישום חייב להיות בזמן יצירת המסך — load() נקרא אז
        authLauncher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            PluginCall call = pendingAuth;
            pendingAuth = null;
            if (call == null) return;
            if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
                call.reject("canceled", "canceled");
                return;
            }
            try {
                AuthorizationResult r = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(result.getData());
                resolveAuth(call, r);
            } catch (ApiException e) {
                rejectAuth(call, e);
            }
        });
    }

    /** טוקן גישה. interactive=false — רק אם כבר אושר (בלי מסך); אחרת נדחה ב-"needs-consent" */
    @PluginMethod
    public void googleSignIn(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", true));
        AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(GOOGLE_SCOPES).build();
        Identity.getAuthorizationClient(getActivity()).authorize(req)
            .addOnSuccessListener(r -> {
                if (!r.hasResolution()) {
                    resolveAuth(call, r);
                    return;
                }
                PendingIntent pi = r.getPendingIntent();
                if (!interactive || pi == null) {
                    call.reject("needs-consent", "needs-consent");
                    return;
                }
                if (pendingAuth != null) pendingAuth.reject("canceled", "canceled");
                pendingAuth = call;
                try {
                    authLauncher.launch(new IntentSenderRequest.Builder(pi.getIntentSender()).build());
                } catch (Exception e) {
                    pendingAuth = null;
                    call.reject("failed:launch", "failed", e);
                }
            })
            .addOnFailureListener(e -> {
                if (e instanceof ApiException) rejectAuth(call, (ApiException) e);
                else call.reject("failed:" + e.getMessage(), "failed", e);
            });
    }

    /** טוקן שפג / ניתוק — שהבקשה הבאה תקבל טוקן חדש */
    @PluginMethod
    public void googleClearToken(PluginCall call) {
        String token = call.getString("token", "");
        new Thread(() -> {
            try {
                if (token != null && !token.isEmpty()) GoogleAuthUtil.clearToken(getContext(), token);
            } catch (Exception ignored) {
                // טוקן לא מוכר — אין מה לנקות
            }
            call.resolve();
        }).start();
    }

    /** שם החבילה וטביעת SHA-1 של החתימה — מה שמזינים ב-Google Cloud בלקוח OAuth מסוג Android */
    @PluginMethod
    public void appSignature(PluginCall call) {
        try {
            String pkg = getContext().getPackageName();
            PackageManager pm = getContext().getPackageManager();
            Signature[] sigs;
            if (Build.VERSION.SDK_INT >= 28) {
                PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                sigs = info.signingInfo.getApkContentsSigners();
            } else {
                PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
                sigs = info.signatures;
            }
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(sigs[0].toByteArray());
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < digest.length; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format("%02X", digest[i]));
            }
            JSObject ret = new JSObject();
            ret.put("packageName", pkg);
            ret.put("sha1", sb.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("failed", e);
        }
    }

    private void resolveAuth(PluginCall call, AuthorizationResult r) {
        String token = r.getAccessToken();
        if (token == null || token.isEmpty()) {
            call.reject("failed:no-token", "failed");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("accessToken", token);
        call.resolve(ret);
    }

    private void rejectAuth(PluginCall call, ApiException e) {
        int code = e.getStatusCode();
        String reason;
        if (code == CommonStatusCodes.CANCELED) reason = "canceled";
        else if (code == CommonStatusCodes.DEVELOPER_ERROR) reason = "not-configured"; // אין לקוח OAuth לחבילה ולחתימה הזו
        else if (code == CommonStatusCodes.NETWORK_ERROR || code == CommonStatusCodes.TIMEOUT) reason = "network";
        else reason = "failed:" + code;
        call.reject(reason, reason, e);
    }

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
