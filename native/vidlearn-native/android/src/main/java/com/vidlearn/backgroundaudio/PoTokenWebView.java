package com.vidlearn.backgroundaudio;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.services.youtube.InnertubeClientRequestInfo;
import org.schabi.newpipe.extractor.services.youtube.PoTokenProvider;
import org.schabi.newpipe.extractor.services.youtube.PoTokenResult;
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * poToken ליוטיוב — "הוכחה שאינך רובוט". בלעדיו יוטיוב חוסם לעיתים קרובות גישה בלי חשבון
 * ("YouTube probably temporarily blocked anonymous watch access with this IP").
 *
 * WebView נסתר מריץ את BotGuard — הסקריפט של יוטיוב עצמו — ומפיק את האסימון, בדיוק כמו
 * באפליקציה NewPipe. העברה ל-Java (בלי RxJava) של app/src/main/java/org/schabi/newpipe/util/potoken
 * מ-NewPipe (GPLv3, https://github.com/TeamNewPipe/NewPipe). הקובץ assets/po_token.html — משם.
 *
 * כשל כאן לא מפיל את החילוץ: מחזירים null, וספריית NewPipeExtractor מנסה לקוחות אחרים.
 */
final class PoTokenWebView {

    // מפתח ציבורי של BotGuard ומפתח הבקשה — כמו ב-NewPipe
    private static final String GOOGLE_API_KEY = "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw";
    private static final String REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
    private static final String USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.3";
    private static final String JS_INTERFACE = "PoTokenWebView";
    private static final long TIMEOUT_SECONDS = 40;

    // ---------- הספק שנרשם ב-NewPipeExtractor ----------
    static final class Provider implements PoTokenProvider {
        private final Context context;
        private final Object lock = new Object();
        private PoTokenWebView generator;
        private String visitorData;
        private String streamingPot;
        private volatile boolean broken; // WebView ישן מדי — לא מנסים שוב

        Provider(Context context) { this.context = context.getApplicationContext(); }

        @Override
        public PoTokenResult getWebClientPoToken(String videoId) {
            if (broken) return null;
            try {
                return get(videoId, false);
            } catch (BadWebViewException e) {
                broken = true;
                return null;
            } catch (Throwable e) {
                return null; // יוטיוב ינוסה בלי אסימון
            }
        }

        private PoTokenResult get(String videoId, boolean forceRecreate) throws Exception {
            PoTokenWebView gen;
            String vd;
            String spot;
            boolean recreated;
            synchronized (lock) {
                recreated = generator == null || forceRecreate || generator.isExpired();
                if (recreated) {
                    InnertubeClientRequestInfo info = InnertubeClientRequestInfo.ofWebClient();
                    info.clientInfo.clientVersion = YoutubeParsingHelper.getClientVersion();
                    visitorData = YoutubeParsingHelper.getVisitorDataFromInnertube(
                        info, NewPipe.getPreferredLocalization(), NewPipe.getPreferredContentCountry(),
                        YoutubeParsingHelper.getYouTubeHeaders(), YoutubeParsingHelper.YOUTUBEI_V1_URL, null, false);
                    if (generator != null) generator.closeLater();
                    generator = create(context);
                    // אסימון הסטרימינג — פעם אחת, לפני כל אסימון אחר
                    streamingPot = generator.generatePoToken(visitorData);
                }
                gen = generator;
                vd = visitorData;
                spot = streamingPot;
            }
            String playerPot;
            try {
                playerPot = gen.generatePoToken(videoId);
            } catch (Exception e) {
                if (recreated) throw e;
                return get(videoId, true); // למשל: תוכן ה-WebView אבד ברקע — יוצרים מחדש
            }
            return new PoTokenResult(vd, playerPot, spot);
        }
    }

    static final class PoTokenException extends Exception {
        PoTokenException(String m) { super(m); }
    }

    static final class BadWebViewException extends Exception {
        BadWebViewException(String m) { super(m); }
    }

    // ---------- המחולל: WebView אחד, הרבה אסימונים ----------
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CountDownLatch initLatch = new CountDownLatch(1);
    private volatile Throwable initError;
    private volatile long expiresAtMillis;
    private final Map<String, Pending> pending = new HashMap<>();
    private WebView webView; // רק בתהליכון הראשי

    private static final class Pending {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile String result;
        volatile Throwable error;
    }

    private PoTokenWebView() {}

    /** טוען את BotGuard ומקבל integrityToken. חוסם — לא לקרוא מהתהליכון הראשי */
    static PoTokenWebView create(Context context) throws Exception {
        PoTokenWebView g = new PoTokenWebView();
        String html = readAsset(context, "po_token.html");
        if (!g.main.post(() -> g.init(context, html))) throw new PoTokenException("main-thread");
        if (!g.initLatch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            g.closeLater();
            throw new PoTokenException("init-timeout");
        }
        if (g.initError != null) {
            g.closeLater();
            if (g.initError instanceof Exception) throw (Exception) g.initError;
            throw new PoTokenException(String.valueOf(g.initError));
        }
        return g;
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private void init(Context context, String html) {
        try {
            webView = new WebView(context.getApplicationContext());
            webView.getSettings().setJavaScriptEnabled(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) webView.getSettings().setSafeBrowsingEnabled(false);
            webView.getSettings().setUserAgentString(USER_AGENT);
            webView.getSettings().setBlockNetworkLoads(true); // ה-WebView לא צריך רשת — הבקשות מ-Java
            webView.addJavascriptInterface(new Js(), JS_INTERFACE);
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage m) {
                    if (m.message() != null && m.message().contains("Uncaught")) {
                        // שגיאת תחביר — WebView שתומך רק ב-JavaScript ישן
                        BadWebViewException e = new BadWebViewException(m.message() + " (" + m.lineNumber() + ")");
                        failInit(e);
                        failAllPending(e);
                    }
                    return super.onConsoleMessage(m);
                }
            });
            webView.loadDataWithBaseURL("https://www.youtube.com",
                html.replaceFirst("</script>", "\n" + JS_INTERFACE + ".downloadAndRunBotguard()</script>"),
                "text/html", "utf-8", null);
        } catch (Throwable t) {
            failInit(t);
        }
    }

    /** הממשק ש-JavaScript קורא לו (בתהליכון של ה-WebView, לא הראשי) */
    private final class Js {
        @JavascriptInterface
        public void downloadAndRunBotguard() {
            botguardRequest("https://www.youtube.com/api/jnn/v1/Create", "[ \"" + REQUEST_KEY + "\" ]", body -> {
                String challenge = parseChallengeData(body);
                evaluate("try {\n"
                    + "  data = " + challenge + "\n"
                    + "  runBotGuard(data).then(function (result) {\n"
                    + "    this.webPoSignalOutput = result.webPoSignalOutput\n"
                    + "    " + JS_INTERFACE + ".onRunBotguardResult(result.botguardResponse)\n"
                    + "  }, function (error) {\n"
                    + "    " + JS_INTERFACE + ".onJsInitializationError(error + \"\\n\" + error.stack)\n"
                    + "  })\n"
                    + "} catch (error) {\n"
                    + "  " + JS_INTERFACE + ".onJsInitializationError(error + \"\\n\" + error.stack)\n"
                    + "}", null);
            });
        }

        @JavascriptInterface
        public void onJsInitializationError(String error) {
            failInit(jsError(error));
        }

        @JavascriptInterface
        public void onRunBotguardResult(String botguardResponse) {
            botguardRequest("https://www.youtube.com/api/jnn/v1/GenerateIT",
                "[ \"" + REQUEST_KEY + "\", \"" + botguardResponse + "\" ]", body -> {
                    JSONArray data = new JSONArray(body);
                    String integrityToken = base64ToU8(data.getString(0));
                    long seconds = data.getLong(1);
                    expiresAtMillis = System.currentTimeMillis() + (seconds - 600) * 1000L; // עשר דקות מרווח
                    evaluate("this.integrityToken = " + integrityToken, initLatch::countDown);
                });
        }

        @JavascriptInterface
        public void onObtainPoTokenError(String identifier, String error) {
            Pending p = pop(identifier);
            if (p != null) { p.error = jsError(error); p.latch.countDown(); }
        }

        @JavascriptInterface
        public void onObtainPoTokenResult(String identifier, String poTokenU8) {
            Pending p = pop(identifier);
            if (p == null) return;
            try {
                p.result = u8ToBase64(poTokenU8);
            } catch (Throwable t) {
                p.error = t;
            }
            p.latch.countDown();
        }
    }

    boolean isExpired() {
        return System.currentTimeMillis() > expiresAtMillis;
    }

    /** אסימון למזהה (מזהה סרטון / visitorData). חוסם — לא מהתהליכון הראשי */
    String generatePoToken(String identifier) throws Exception {
        Pending p = new Pending();
        synchronized (pending) { pending.put(identifier, p); }
        String u8 = stringToU8(identifier);
        String id = JSONObject.quote(identifier);
        boolean posted = main.post(() -> evaluate("try {\n"
            + "  identifier = " + id + "\n"
            + "  u8Identifier = " + u8 + "\n"
            + "  poTokenU8 = obtainPoToken(webPoSignalOutput, integrityToken, u8Identifier)\n"
            + "  poTokenU8String = \"\"\n"
            + "  for (i = 0; i < poTokenU8.length; i++) {\n"
            + "    if (i != 0) poTokenU8String += \",\"\n"
            + "    poTokenU8String += poTokenU8[i]\n"
            + "  }\n"
            + "  " + JS_INTERFACE + ".onObtainPoTokenResult(identifier, poTokenU8String)\n"
            + "} catch (error) {\n"
            + "  " + JS_INTERFACE + ".onObtainPoTokenError(identifier, error + \"\\n\" + error.stack)\n"
            + "}", null));
        if (!posted) { pop(identifier); throw new PoTokenException("main-thread"); }
        if (!p.latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) { pop(identifier); throw new PoTokenException("token-timeout"); }
        if (p.error != null) {
            if (p.error instanceof Exception) throw (Exception) p.error;
            throw new PoTokenException(String.valueOf(p.error));
        }
        return p.result;
    }

    /** שחרור ה-WebView (בתהליכון הראשי) */
    void closeLater() {
        main.post(() -> {
            if (webView == null) return;
            try {
                webView.loadUrl("about:blank");
                webView.onPause();
                webView.removeAllViews();
                webView.destroy();
            } catch (Throwable ignored) { }
            webView = null;
        });
    }

    // ---------- עזרים ----------
    private interface BodyHandler { void handle(String body) throws Exception; }

    /** בקשת POST לשירות BotGuard ברקע; תשובה ← בתהליכון הראשי */
    private void botguardRequest(String url, String data, BodyHandler handler) {
        new Thread(() -> {
            try {
                Map<String, List<String>> headers = new HashMap<>();
                headers.put("User-Agent", Arrays.asList(USER_AGENT));
                headers.put("Accept", Arrays.asList("application/json"));
                headers.put("Content-Type", Arrays.asList("application/json+protobuf"));
                headers.put("x-goog-api-key", Arrays.asList(GOOGLE_API_KEY));
                headers.put("x-user-agent", Arrays.asList("grpc-web-javascript/0.1"));
                YtCore.init();
                Response r = NewPipe.getDownloader().post(url, headers, data.getBytes(StandardCharsets.UTF_8));
                if (r.responseCode() != 200) throw new PoTokenException("botguard-http-" + r.responseCode());
                String body = r.responseBody();
                main.post(() -> {
                    try { handler.handle(body); } catch (Throwable t) { failInit(t); }
                });
            } catch (Throwable t) {
                failInit(t);
            }
        }, "vidlearn-potoken").start();
    }

    private void evaluate(String js, Runnable after) {
        Runnable run = () -> {
            if (webView == null) { failInit(new PoTokenException("webview-closed")); return; }
            webView.evaluateJavascript(js, value -> { if (after != null) after.run(); });
        };
        if (Looper.myLooper() == Looper.getMainLooper()) run.run(); else main.post(run);
    }

    private void failInit(Throwable t) {
        if (initLatch.getCount() > 0) {
            initError = t;
            initLatch.countDown();
        }
    }

    private void failAllPending(Throwable t) {
        List<Pending> all;
        synchronized (pending) { all = new ArrayList<>(pending.values()); pending.clear(); }
        for (Pending p : all) { p.error = t; p.latch.countDown(); }
    }

    private Pending pop(String identifier) {
        synchronized (pending) { return pending.remove(identifier); }
    }

    private static Exception jsError(String error) {
        return error != null && error.contains("SyntaxError") ? new BadWebViewException(error) : new PoTokenException(String.valueOf(error));
    }

    private static String readAsset(Context context, String name) throws IOException {
        try (InputStream in = context.getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** נתוני האתגר מ-Create ← אובייקט JavaScript */
    static String parseChallengeData(String raw) throws Exception {
        JSONArray scrambled = new JSONArray(raw);
        JSONArray challenge;
        if (scrambled.length() > 1 && scrambled.opt(1) instanceof String) {
            byte[] bytes = base64Decode(scrambled.getString(1));
            for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (bytes[i] + 97);
            challenge = new JSONArray(new String(bytes, StandardCharsets.UTF_8));
        } else {
            challenge = scrambled.getJSONArray(0);
        }
        JSONObject interpreter = new JSONObject();
        interpreter.put("privateDoNotAccessOrElseSafeScriptWrappedValue", firstString(challenge.optJSONArray(1)));
        interpreter.put("privateDoNotAccessOrElseTrustedResourceUrlWrappedValue", firstString(challenge.optJSONArray(2)));
        JSONObject out = new JSONObject();
        out.put("messageId", challenge.getString(0));
        out.put("interpreterJavascript", interpreter);
        out.put("interpreterHash", challenge.getString(3));
        out.put("program", challenge.getString(4));
        out.put("globalName", challenge.getString(5));
        out.put("clientExperimentsStateBlob", challenge.getString(7));
        return out.toString();
    }

    private static Object firstString(JSONArray a) {
        if (a == null) return JSONObject.NULL;
        for (int i = 0; i < a.length(); i++) if (a.opt(i) instanceof String) return a.opt(i);
        return JSONObject.NULL;
    }

    private static byte[] base64Decode(String s) throws PoTokenException {
        try {
            return Base64.decode(s.replace('-', '+').replace('_', '/').replace('.', '='), Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            throw new PoTokenException("Cannot base64 decode");
        }
    }

    private static String newUint8Array(byte[] bytes) {
        StringBuilder sb = new StringBuilder("new Uint8Array([");
        for (int i = 0; i < bytes.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(bytes[i] & 0xff);
        }
        return sb.append("])").toString();
    }

    static String base64ToU8(String base64) throws PoTokenException {
        return newUint8Array(base64Decode(base64));
    }

    static String stringToU8(String s) {
        return newUint8Array(s.getBytes(StandardCharsets.UTF_8));
    }

    /** "97,98,99" (Uint8Array בטקסט) ← base64 בצורה של יוטיוב */
    static String u8ToBase64(String u8) {
        String[] parts = u8.split(",");
        byte[] bytes = new byte[parts.length];
        for (int i = 0; i < parts.length; i++) bytes[i] = (byte) Integer.parseInt(parts[i].trim());
        return Base64.encodeToString(bytes, Base64.NO_WRAP).replace('+', '-').replace('/', '_');
    }
}
