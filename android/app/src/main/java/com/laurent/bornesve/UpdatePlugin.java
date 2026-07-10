package com.laurent.bornesve;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * MAJ in-app : télécharge l'APK d'une Release GitHub et lance l'installeur
 * Android (comme l'app Flux RSS). Nécessite la permission
 * REQUEST_INSTALL_PACKAGES + un FileProvider (authority ${applicationId}.fileprovider).
 */
@CapacitorPlugin(name = "UpdatePlugin")
public class UpdatePlugin extends Plugin {

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String apkUrl = call.getString("url");
        if (apkUrl == null || apkUrl.isEmpty()) {
            call.reject("URL manquante");
            return;
        }
        final Context ctx = getContext();
        final File apkFile = new File(ctx.getCacheDir(), "bornes-ve-update.apk");
        final String finalUrl = apkUrl;

        new Thread(() -> {
            try {
                downloadFile(finalUrl, apkFile);
                getActivity().runOnUiThread(() -> {
                    installApk(ctx, apkFile);
                    call.resolve();
                });
            } catch (Exception e) {
                call.reject("Erreur de téléchargement : " + e.getMessage());
            }
        }).start();
    }

    private void downloadFile(String urlStr, File dest) throws IOException {
        URL url = new URL(urlStr);
        int maxRedirects = 5;
        HttpURLConnection conn = null;
        while (maxRedirects-- > 0) {
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(90_000);
            conn.connect();
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                url = new URL(location);
            } else {
                break;
            }
        }
        if (conn == null) throw new IOException("Connexion impossible");
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16_384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            conn.disconnect();
        }
    }

    private void installApk(Context ctx, File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            ctx, ctx.getPackageName() + ".fileprovider", apkFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ctx.startActivity(intent);
    }
}
