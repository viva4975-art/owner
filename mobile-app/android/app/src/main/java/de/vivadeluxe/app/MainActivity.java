package de.vivadeluxe.app;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.Toast;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import java.util.HashSet;
import java.util.Set;

public class MainActivity extends BridgeActivity {

    /** Downloads dieser Sitzung – nur diese werden nach dem Laden automatisch geöffnet. */
    private final Set<Long> downloads = new HashSet<>();

    private final BroadcastReceiver onDone = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (!downloads.remove(id)) return;
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            Uri uri = dm.getUriForDownloadedFile(id);
            if (uri == null) {
                Toast.makeText(MainActivity.this, "Download fehlgeschlagen", Toast.LENGTH_LONG).show();
                return;
            }
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, dm.getMimeTypeForDownloadedFile(id));
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(view);
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "Gespeichert – keine App zum Öffnen gefunden", Toast.LENGTH_LONG).show();
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Ab Android 16 (targetSdk 36) zeichnet jede App unter Status- und Navigationsleiste.
        // Die Seite bekommt deshalb einen Rand in Höhe der Leisten (und der Tastatur), die Leisten Bordeaux mit hellen Symbolen.
        View root = findViewById(android.R.id.content);
        root.setBackgroundColor(Color.parseColor("#7D1435"));
        WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightNavigationBars(false);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime()
            );
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        // PDFs (Berichte, Rechnungen, Arbeitsscheine …): Die WebView kann sie nicht anzeigen und meldet einen Download.
        // Laden mit der Anmeldung der App (Cookies), im App-eigenen Ordner speichern (keine Speicher-Berechtigung nötig)
        // und danach mit dem PDF-Programm des Handys öffnen.
        ContextCompat.registerReceiver(
            this, onDone, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED
        );
        bridge.getWebView().setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (!url.startsWith("https://")) return;
            String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) r.addRequestHeader("Cookie", cookie);
            r.addRequestHeader("User-Agent", userAgent);
            r.setMimeType(mimetype);
            r.setTitle(name);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            downloads.add(dm.enqueue(r));
            Toast.makeText(this, "Wird geladen: " + name, Toast.LENGTH_SHORT).show();
        });
    }

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(onDone);
        } catch (IllegalArgumentException ignored) {
            // nicht registriert
        }
        super.onDestroy();
    }
}
