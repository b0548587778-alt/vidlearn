package com.vidlearn.backgroundaudio;

import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.DeliveryMethod;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.VideoStream;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * יוטיוב ישירות מהטלפון, בלי שרת ביניים: NewPipeExtractor (הספרייה של NewPipe) מוצא את קובצי
 * הווידאו והשמע, והם יורדים מהטלפון עצמו (כתובות יוטיוב קשורות לכתובת ה-IP שביקשה אותן).
 * יוטיוב נותן תמונה וקול בקבצים נפרדים — את החיבור עושה YtMux. טהור (בלי Android) — חוץ מהשימוש בו.
 */
final class YtCore {
    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
    private static final int CHUNK = 4 * 1024 * 1024; // הורדה בחלקים — בקשה אחת גדולה מואטת בידי יוטיוב
    private static boolean initialized;

    private YtCore() {}

    static synchronized void init() {
        if (!initialized) {
            NewPipe.init(new Http());
            initialized = true;
        }
    }

    static StreamInfo info(String id) throws Exception {
        init();
        return StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
    }

    /** הקבצים שנבחרו: video == null ← שמע בלבד */
    static final class Pick {
        VideoStream video;
        AudioStream audio;
        long videoLength;
        long audioLength;
    }

    private static boolean direct(org.schabi.newpipe.extractor.stream.Stream s) {
        return s.isUrl() && s.getDeliveryMethod() == DeliveryMethod.PROGRESSIVE_HTTP;
    }

    private static long lengthOf(org.schabi.newpipe.extractor.stream.Stream s) {
        try { return s.getItagItem() != null ? Math.max(0, s.getItagItem().getContentLength()) : 0; } catch (Exception e) { return 0; }
    }

    /** quality: audio (שמע בלבד), low (עד 360p, שמע חסכוני), normal (עד 720p) */
    static Pick pick(StreamInfo info, String quality) throws IOException {
        boolean low = "low".equals(quality);
        List<AudioStream> audio = new ArrayList<>();
        for (AudioStream a : info.getAudioStreams()) if (direct(a) && a.getFormat() == MediaFormat.M4A) audio.add(a);
        if (audio.isEmpty()) throw new IOException("no-file");
        // (בלי Comparator.comparing / List.sort — לא קיימים באנדרואיד 6)
        Collections.sort(audio, new Comparator<AudioStream>() {
            @Override public int compare(AudioStream a, AudioStream b) { return Integer.compare(a.getAverageBitrate(), b.getAverageBitrate()); }
        });
        Pick p = new Pick();
        p.audio = low ? audio.get(0) : audio.get(audio.size() - 1);
        p.audioLength = lengthOf(p.audio);
        if ("audio".equals(quality)) return p;

        // וידאו MP4 (עדיפות ל-H.264 — נתמך בכל טלפון)
        int max = low ? 360 : 720;
        List<VideoStream> videos = new ArrayList<>();
        for (VideoStream v : info.getVideoOnlyStreams()) if (direct(v) && v.getFormat() == MediaFormat.MPEG_4) videos.add(v);
        if (videos.isEmpty()) throw new IOException("no-file");
        Collections.sort(videos, new Comparator<VideoStream>() {
            int rank(VideoStream v) {
                int h = v.getHeight();
                int inCap = h <= max ? 0 : 1;                                        // בתוך התקרה קודם
                int avc = String.valueOf(v.getCodec()).startsWith("avc1") ? 0 : 1;   // H.264 קודם
                int size = h <= max ? 10000 - h : h;                                 // הכי גבוה בתקרה / הכי נמוך מעליה
                return inCap * 100000000 + avc * 1000000 + size;
            }
            @Override public int compare(VideoStream a, VideoStream b) { return Integer.compare(rank(a), rank(b)); }
        });
        p.video = videos.get(0);
        p.videoLength = lengthOf(p.video);
        return p;
    }

    interface Progress { void on(long done); }

    /** הורדה בחלקים (Range), עם שלושה ניסיונות לכל חלק; ממשיכה מהמקום שנעצר */
    static long download(String url, long knownLength, File out, Progress progress) throws IOException {
        long pos = 0;
        long total = knownLength > 0 ? knownLength : -1;
        try (OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            while (total < 0 || pos < total) {
                int attempt = 0;
                boolean whole = false;
                long chunkStart = pos;
                while (true) {
                    HttpURLConnection c = null;
                    try {
                        long end = pos + CHUNK - 1;
                        if (total > 0) end = Math.min(end, total - 1);
                        c = (HttpURLConnection) new URL(url).openConnection();
                        c.setConnectTimeout(20000);
                        c.setReadTimeout(30000);
                        c.setRequestProperty("User-Agent", UA);
                        c.setRequestProperty("Range", "bytes=" + pos + "-" + end);
                        int code = c.getResponseCode();
                        if (code == 416) { total = pos; break; }
                        if (code != 206 && code != 200) throw new IOException("http-" + code);
                        if (code == 200) {
                            if (pos > 0) throw new IOException("no-range"); // השרת התעלם מ-Range באמצע הקובץ
                            whole = true;
                        } else if (total < 0) {
                            String cr = c.getHeaderField("Content-Range"); // bytes 0-99/1234
                            int slash = cr == null ? -1 : cr.lastIndexOf('/');
                            if (slash >= 0) try { total = Long.parseLong(cr.substring(slash + 1).trim()); } catch (NumberFormatException ignored) { }
                        }
                        try (InputStream in = c.getInputStream()) {
                            int n;
                            while ((n = in.read(buf)) > 0) {
                                os.write(buf, 0, n);
                                pos += n;
                                progress.on(pos);
                            }
                        }
                        break;
                    } catch (IOException e) {
                        if (++attempt >= 3) throw e;
                        try { Thread.sleep(1500L * attempt); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); throw e; }
                    } finally {
                        if (c != null) c.disconnect();
                    }
                }
                if (whole) break;                         // כל הקובץ הגיע בבקשה אחת
                if (total < 0 && pos - chunkStart < CHUNK) break; // אורך לא ידוע — חלק קצר הוא הסוף
                if (pos == chunkStart) break;              // לא התקדמנו — לא נסתובב לנצח
            }
        }
        if (pos == 0) throw new IOException("empty");
        return pos;
    }

    /** ה-HTTP של NewPipeExtractor */
    static final class Http extends Downloader {
        @Override
        public Response execute(Request request) throws IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(request.url()).openConnection();
            c.setRequestMethod(request.httpMethod());
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            for (Map.Entry<String, List<String>> h : request.headers().entrySet()) {
                for (String v : h.getValue()) c.addRequestProperty(h.getKey(), v);
            }
            byte[] data = request.dataToSend();
            if (data != null) {
                c.setDoOutput(true);
                try (OutputStream os = c.getOutputStream()) { os.write(data); }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String body = "";
            if (in != null) try (InputStream is = in) { body = new String(readAll(is), StandardCharsets.UTF_8); }
            String latest = c.getURL().toString();
            String message = c.getResponseMessage();
            Map<String, List<String>> headers = c.getHeaderFields();
            c.disconnect();
            return new Response(code, message, headers, body, latest);
        }

        // (InputStream.readAllBytes קיים רק מאנדרואיד 13)
        private static byte[] readAll(InputStream in) throws IOException {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }
}
