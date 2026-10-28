package local.dida.tasks;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
  private static final String ORIGIN = "https://dida.local/";
  private static final int EXPORT = 31, IMPORT = 32, NOTIFICATIONS = 33;
  private WebView webView;
  private LocalStore store;
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private String fileRequest;
  private String filePayload;

  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    store = new LocalStore(this);
    FrameLayout frame = new FrameLayout(this);
    frame.setFitsSystemWindows(true);
    webView = new WebView(this);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setSupportMultipleWindows(false);
    WebView.setWebContentsDebuggingEnabled(false);
    webView.setBackgroundColor(0xffffffff);
    webView.addJavascriptInterface(new Bridge(), "DidaNative");
    webView.setWebChromeClient(new WebChromeClient());
    webView.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !request.getUrl().toString().startsWith(ORIGIN); }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        try {
          Uri uri = request.getUrl();
          String url = uri.toString();
          String asset = Uri.decode(uri.getPath());
          if (!"GET".equals(request.getMethod()) || !url.startsWith(ORIGIN) || asset.contains("..") || asset.indexOf('\\') >= 0) return response(403, "Forbidden", "text/plain", new byte[0]);
          if ("/".equals(asset)) asset = "/index.html";
          String mime = asset.endsWith(".html") ? "text/html" : asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : asset.endsWith(".svg") ? "image/svg+xml" : asset.endsWith(".png") ? "image/png" : asset.endsWith(".json") ? "application/json" : "application/octet-stream";
          return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers(), getAssets().open("www" + asset));
        } catch (Exception missing) { return response(404, "Not Found", "text/plain", new byte[0]); }
      }
    });
    frame.addView(webView, new FrameLayout.LayoutParams(-1, -1));
    setContentView(frame);
    webView.loadUrl(ORIGIN + "index.html");
  }

  private static HashMap<String, String> headers() {
    HashMap<String, String> headers = new HashMap<>();
    headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'");
    headers.put("Access-Control-Allow-Origin", "https://dida.local");
    return headers;
  }

  private static WebResourceResponse response(int status, String reason, String mime, byte[] body) { return new WebResourceResponse(mime, "UTF-8", status, reason, headers(), new ByteArrayInputStream(body)); }

  private void reply(String id, boolean ok, Object value) {
    String payload = value == null || value == JSONObject.NULL ? "null" : value instanceof String ? JSONObject.quote((String) value) : value instanceof JSONObject || value instanceof Boolean ? value.toString() : "null";
    runOnUiThread(() -> {
      if (!isFinishing() && webView != null) webView.evaluateJavascript("window.__didaNativeReply(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(payload) + ")", null);
    });
  }

  private final class Bridge {
    @JavascriptInterface public void invoke(String id, String method, String payload) {
      if (id == null || id.length() > 100 || method == null || payload == null || payload.length() > LocalStore.MAX_BYTES) return;
      io.execute(() -> {
        try {
          if ("load".equals(method)) {
            JSONObject loaded = store.load();
            if (!loaded.isNull("data")) {
              try { if (ReminderScheduler.schedule(MainActivity.this, loaded.getJSONObject("data"))) requestNotificationPermission(); }
              catch (Exception error) { android.util.Log.w("DidaLocal", "Reminder restore failed: " + error.getClass().getSimpleName()); }
            }
            reply(id, true, loaded); return;
          }
          if ("save".equals(method)) {
            JSONObject data = new JSONObject(payload);
            store.save(data);
            boolean reminders = false;
            try { reminders = ReminderScheduler.schedule(MainActivity.this, data); }
            catch (Exception error) { android.util.Log.w("DidaLocal", "Reminder schedule failed: " + error.getClass().getSimpleName()); }
            if (reminders) requestNotificationPermission();
            reply(id, true, JSONObject.NULL);
            return;
          }
          if ("export".equals(method)) {
            JSONObject data = new JSONObject(payload);
            LocalStore.validate(data);
            String backup = new JSONObject().put("format", "dida-local-backup").put("exportedAt", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT).format(new Date())).put("data", data).toString(2);
            runOnUiThread(() -> pickFile(id, backup, EXPORT));
            return;
          }
          if ("import".equals(method)) { runOnUiThread(() -> pickFile(id, null, IMPORT)); return; }
          if ("reveal".equals(method)) {
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this).setTitle("本地数据").setMessage("任务存储于应用私有目录。请使用导出备份，把数据保存到你选择的位置。卸载应用会删除私有数据。").setPositiveButton("知道了", null).show());
            reply(id, true, JSONObject.NULL); return;
          }
          if ("notify".equals(method)) {
            JSONObject input = new JSONObject(payload);
            String title = input.getString("title"), body = input.getString("body");
            if (title.length() > 200 || body.length() > 2000) throw new IllegalArgumentException("通知内容过长");
            if (!ReminderScheduler.canNotify(MainActivity.this)) { requestNotificationPermission(); throw new SecurityException("请允许系统通知后再使用提醒"); }
            ReminderScheduler.notify(MainActivity.this, 900001, title, body);
            reply(id, true, JSONObject.NULL); return;
          }
          throw new IllegalArgumentException("不支持的本地操作");
        } catch (Exception error) { reply(id, false, error.getMessage() == null ? "本地操作失败" : error.getMessage()); }
      });
    }
  }

  private void pickFile(String id, String data, int request) {
    if (fileRequest != null) { reply(id, false, "请先完成当前文件选择"); return; }
    fileRequest = id; filePayload = data;
    Intent intent;
    if (request == EXPORT) {
      intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "本地清单备份-" + new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date()) + ".json");
    } else {
      intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/json", "text/csv", "text/comma-separated-values", "text/plain", "application/octet-stream" });
    }
    try { startActivityForResult(intent, request); }
    catch (Exception error) { fileRequest = null; filePayload = null; reply(id, false, "系统文件选择器不可用"); }
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent result) {
    super.onActivityResult(requestCode, resultCode, result);
    if (requestCode != IMPORT && requestCode != EXPORT) return;
    String id = fileRequest, contents = filePayload;
    fileRequest = null; filePayload = null;
    if (id == null) return;
    if (resultCode != RESULT_OK || result == null || result.getData() == null) { reply(id, true, requestCode == EXPORT ? false : JSONObject.NULL); return; }
    Uri uri = result.getData();
    io.execute(() -> {
      try {
        if (requestCode == EXPORT) {
          try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
            if (output == null) throw new java.io.IOException("无法写入备份文件");
            output.write(contents.getBytes(StandardCharsets.UTF_8)); output.flush();
          }
          reply(id, true, true);
        } else {
          try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new java.io.IOException("无法读取备份文件");
            reply(id, true, LocalStore.readText(input));
          }
        }
      } catch (Exception error) { reply(id, false, requestCode == EXPORT ? "备份写入失败，请重试并检查文件位置" : "备份读取失败或超过32MB"); }
    });
  }

  private synchronized void requestNotificationPermission() {
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !getPreferences(MODE_PRIVATE).getBoolean("askedNotifications", false)) {
      getPreferences(MODE_PRIVATE).edit().putBoolean("askedNotifications", true).apply();
      runOnUiThread(() -> requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATIONS));
    }
  }

  @Override public void onBackPressed() {
    webView.evaluateJavascript("(function(){var open=!!document.querySelector('.modal-backdrop,.task-detail,.context-menu');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return open;})()", open -> { if (!"true".equals(open)) moveTaskToBack(true); });
  }

  @Override protected void onDestroy() {
    if (webView != null) { webView.removeJavascriptInterface("DidaNative"); webView.destroy(); webView = null; }
    io.shutdown();
    super.onDestroy();
  }
}
