package com.vidlearn.backgroundaudio;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * חיבור קובץ תמונה (MP4) וקובץ קול (M4A) מיוטיוב לקובץ MP4 אחד — בלי קידוד מחדש,
 * רק העתקת הדגימות (MediaExtractor ← MediaMuxer). מהיר, ובלי פגיעה באיכות.
 */
final class YtMux {
    private YtMux() {}

    static void mux(File video, File audio, File out) throws IOException {
        MediaExtractor ve = new MediaExtractor();
        MediaExtractor ae = new MediaExtractor();
        MediaMuxer muxer = null;
        boolean started = false;
        try {
            ve.setDataSource(video.getPath());
            ae.setDataSource(audio.getPath());
            int vIn = selectTrack(ve, "video/");
            int aIn = selectTrack(ae, "audio/");
            if (vIn < 0 || aIn < 0) throw new IOException("mux-no-track");
            MediaFormat vf = ve.getTrackFormat(vIn);
            MediaFormat af = ae.getTrackFormat(aIn);

            muxer = new MediaMuxer(out.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int vOut = muxer.addTrack(vf);
            int aOut = muxer.addTrack(af);
            muxer.start();
            started = true;

            int size = Math.max(maxInput(vf), maxInput(af));
            ByteBuffer buf = ByteBuffer.allocate(Math.max(size, 4 * 1024 * 1024));
            copy(ve, muxer, vOut, buf);
            copy(ae, muxer, aOut, buf);
        } catch (IllegalStateException | IllegalArgumentException e) {
            throw new IOException("mux-failed: " + e.getMessage(), e);
        } finally {
            ve.release();
            ae.release();
            if (muxer != null) {
                try { if (started) muxer.stop(); } catch (IllegalStateException e) { out.delete(); } // בלי דגימות — הקובץ פגום
                muxer.release();
            }
        }
        if (!out.exists() || out.length() == 0) throw new IOException("mux-failed");
    }

    private static int selectTrack(MediaExtractor ex, String prefix) {
        for (int i = 0; i < ex.getTrackCount(); i++) {
            String mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith(prefix)) {
                ex.selectTrack(i);
                return i;
            }
        }
        return -1;
    }

    private static int maxInput(MediaFormat f) {
        return f.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) ? f.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) : 0;
    }

    private static void copy(MediaExtractor ex, MediaMuxer muxer, int track, ByteBuffer buf) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            buf.clear();
            int n = ex.readSampleData(buf, 0);
            if (n < 0) break;
            int flags = (ex.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0 ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
            info.set(0, n, ex.getSampleTime(), flags);
            muxer.writeSampleData(track, buf, info);
            ex.advance();
        }
    }
}
