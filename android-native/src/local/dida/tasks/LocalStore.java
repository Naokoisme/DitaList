package local.dida.tasks;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

final class LocalStore {
  static final int MAX_BYTES = 32 * 1024 * 1024;
  // Activity 与闹钟/重启接收器使用不同实例；AtomicFile 本身不提供并发锁。
  private static final Object IO_LOCK = new Object();
  private final File directory;
  private final File database;
  private final File backup;
  private boolean loaded;

  LocalStore(Context context) {
    directory = new File(context.getFilesDir(), "tasks");
    database = new File(directory, "database.json");
    backup = new File(directory, "database.backup.json");
  }

  JSONObject load() throws Exception {
    synchronized (IO_LOCK) {
    if (!directory.exists() && !directory.mkdirs()) throw new IOException("无法创建本地数据目录");
    JSONObject data = null;
    if (database.exists()) {
      try { data = readDocument(database); }
      catch (Exception broken) {
        if (!backup.exists()) throw new IOException("任务文件无法读取，已停止写入并保留原文件。请勿卸载或清除应用数据，保留应用以便修复。");
        data = readDocument(backup);
        Files.copy(database.toPath(), new File(directory, "database.corrupt-" + System.currentTimeMillis() + "-" + java.util.UUID.randomUUID() + ".json").toPath());
      }
    } else if (backup.exists()) data = readDocument(backup);
    loaded = true;
    JSONObject info = new JSONObject().put("kind", "android").put("path", database.getAbsolutePath()).put("backupPath", backup.getAbsolutePath());
    return new JSONObject().put("data", data == null ? JSONObject.NULL : data).put("info", info);
    }
  }

  void save(JSONObject data) throws Exception {
    synchronized (IO_LOCK) {
    if (!loaded) throw new IOException("读取任务成功后才能保存");
    validate(data);
    if (database.exists()) {
      try { writeAtomic(backup, readDocument(database).toString()); }
      catch (JSONException damaged) { readDocument(backup); }
    }
    writeAtomic(database, data.toString());
    }
  }

  JSONObject readForReminder() throws Exception {
    synchronized (IO_LOCK) {
      return database.exists() ? readDocument(database) : backup.exists() ? readDocument(backup) : null;
    }
  }

  private static JSONObject readDocument(File file) throws Exception {
    JSONObject result;
    try (InputStream input = new AtomicFile(file).openRead()) { result = new JSONObject(readText(input)); }
    validate(result);
    return result;
  }

  static void validate(JSONObject data) throws JSONException {
    if (data.optInt("schemaVersion") != 1) throw new JSONException("不支持的任务数据格式");
    for (String key : new String[] { "tasks", "lists", "folders", "habits", "filters", "focusSessions" }) {
      JSONArray array = data.getJSONArray(key);
      if (array.length() > 200000) throw new JSONException("任务数据超过容量限制");
      for (int index = 0; index < array.length(); index++) {
        JSONObject item = array.getJSONObject(index);
        if (item.getString("id").isEmpty()) throw new JSONException("任务数据缺少 ID");
      }
    }
    data.getJSONObject("settings");
    boolean inbox = false;
    JSONArray lists = data.getJSONArray("lists");
    for (int index = 0; index < lists.length(); index++) inbox |= "inbox".equals(lists.getJSONObject(index).getString("id"));
    if (!inbox || data.toString().getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw new JSONException("任务数据无效或超过32MB");
  }

  static String readText(InputStream input) throws IOException {
    ByteArrayOutputStream result = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int count;
    while ((count = input.read(buffer)) != -1) {
      if (result.size() + count > MAX_BYTES) throw new IOException("备份文件超过32MB");
      result.write(buffer, 0, count);
    }
    return result.toString(StandardCharsets.UTF_8.name());
  }

  private static void writeAtomic(File file, String value) throws IOException {
    AtomicFile atomic = new AtomicFile(file);
    FileOutputStream output = null;
    try {
      output = atomic.startWrite();
      output.write(value.getBytes(StandardCharsets.UTF_8));
      atomic.finishWrite(output);
    } catch (IOException error) {
      if (output != null) atomic.failWrite(output);
      throw error;
    }
    // 部分 Android 实现的 finishWrite 在 rename/fsync 失败时只写系统日志。
    // 只有读回内容与提交内容完全一致，才向 React 返回保存成功。
    try (InputStream input = atomic.openRead()) {
      if (!value.equals(readText(input))) throw new IOException("数据写入核对失败，原备份保持不变，请导出当前任务备份");
    }
  }
}
