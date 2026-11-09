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

import org.schabi.newpipe.extractor.stream.StreamInfo;

import java.io.File;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
        // יוטיוב: "הוכחה שאינך רובוט" (poToken) מ-WebView נסתר — בלעדיה יוטיוב חוסם לעיתים גישה בלי חשבון
        try {
            org.schabi.newpipe.extractor.services.youtube.extractors.YoutubeStreamExtractor
                .setPoTokenProvider(new PoTokenWebView.Provider(getContext()));
        } catch (Throwable ignored) { }
        // האפליקציה נפתחה מ"שיתוף" (למשל מיוטיוב) — הקישור נשמר עד שהממשק יבקש אותו
        pendingShare = sharedText(getActivity().getIntent());
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

    // ---------- יוטיוב ישירות מהטלפון (YtCore + YtMux) ----------
    // תהליכונים משלנו: הפעולות ארוכות, ותהליכון התוספים של Capacitor משותף לכל הקריאות
    private final ExecutorService ytInfoPool = Executors.newFixedThreadPool(2);
    private final ExecutorService ytDownloadPool = Executors.newSingleThreadExecutor();

    private static String validId(PluginCall call) {
        String id = call.getString("id", "");
        return id != null && id.matches("[\\w-]{11}") ? id : null;
    }

    private static String errorOf(Throwable e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : (m.length() > 120 ? m.substring(0, 120) : m);
    }

    /** פרטי הסרטון — לסינון לפני ההורדה ולהצגה */
    @PluginMethod
    public void youtubeInfo(PluginCall call) {
        String id = validId(call);
        if (id == null) { call.reject("bad-id"); return; }
        ytInfoPool.execute(() -> {
            try {
                StreamInfo i = YtCore.info(id);
                JSObject r = new JSObject();
                r.put("title", i.getName());
                r.put("description", i.getDescription() != null ? i.getDescription().content() : "");
                r.put("author", i.getUploaderName());
                r.put("duration", i.getDuration());
                r.put("category", i.getCategory());
                r.put("ageLimit", i.getAgeLimit());
                r.put("tags", new org.json.JSONArray(i.getTags()));
                call.resolve(r);
            } catch (Throwable e) { // גם Error (למשל מחלקה חסרה בגרסת אנדרואיד ישנה) — לא מפיל את האפליקציה
                call.reject(errorOf(e));
            }
        });
    }

    /** הורדה לקובץ בתיקיית האפליקציה (Directory.DATA): path יחסי, quality = normal / low / audio.
     *  התקדמות: אירוע "ytProgress" { path, progress 0..1 } */
    @PluginMethod
    public void youtubeDownload(PluginCall call) {
        String id = validId(call);
        String path = call.getString("path", "");
        String quality = call.getString("quality", "normal");
        if (id == null || path == null || path.isEmpty() || path.contains("..") || path.startsWith("/")) { call.reject("bad-args"); return; }
        ytDownloadPool.execute(() -> {
            File out = new File(getContext().getFilesDir(), path);
            File v = null, a = null;
            try {
                File dir = out.getParentFile();
                if (dir != null) dir.mkdirs();
                YtCore.Pick p = YtCore.pick(YtCore.info(id), quality);
                if (p.video == null) {
                    final long total = p.audioLength;
                    YtCore.download(p.audio.getContent(), p.audioLength, out, progress(path, 0, total, total));
                } else {
                    // משקל ההתקדמות לפי הגודל (ידוע מראש ברוב הסרטונים)
                    long total = p.videoLength + p.audioLength;
                    v = new File(getContext().getCacheDir(), "yt-" + id + "-v.mp4");
                    a = new File(getContext().getCacheDir(), "yt-" + id + "-a.m4a");
                    YtCore.download(p.video.getContent(), p.videoLength, v, progress(path, 0, p.videoLength, total));
                    YtCore.download(p.audio.getContent(), p.audioLength, a, progress(path, v.length(), p.audioLength, total));
                    YtMux.mux(v, a, out);
                }
                JSObject r = new JSObject();
                r.put("uri", android.net.Uri.fromFile(out).toString());
                r.put("size", out.length());
                call.resolve(r);
            } catch (Throwable e) { // גם Error (למשל מחלקה חסרה בגרסת אנדרואיד ישנה) — לא מפיל את האפליקציה
                out.delete();
                call.reject(errorOf(e));
            } finally {
                if (v != null) v.delete();
                if (a != null) a.delete();
            }
        });
    }

    // התקדמות: עדכון לכל אחוז, לא לכל חבילה
    private YtCore.Progress progress(String path, long offset, long partLength, long total) {
        final int[] last = { -1 };
        return done -> {
            if (total <= 0) return;
            int pct = (int) Math.min(100, ((offset + done) * 100) / total);
            if (pct == last[0]) return;
            last[0] = pct;
            JSObject ev = new JSObject();
            ev.put("path", path);
            ev.put("progress", pct / 100.0);
            notifyListeners("ytProgress", ev);
        };
    }

    // ---------- "שיתוף" מאפליקציה אחרת ----------
    private String pendingShare;

    private static String sharedText(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        intent.setAction(null); // לא לטפל שוב באותו שיתוף (למשל אחרי סיבוב המסך)
        return text == null || text.trim().isEmpty() ? null : text.trim();
    }

    /** האפליקציה כבר פתוחה וקיבלה שיתוף חדש */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = sharedText(intent);
        if (text == null) return;
        pendingShare = text;
        JSObject ev = new JSObject();
        ev.put("text", text);
        notifyListeners("shareReceived", ev, true);
    }

    /** הקישור ששותף לאפליקציה (פעם אחת) ← { text } */
    @PluginMethod
    public void getSharedText(PluginCall call) {
        JSObject r = new JSObject();
        r.put("text", pendingShare);
        pendingShare = null;
        call.resolve(r);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }
}
