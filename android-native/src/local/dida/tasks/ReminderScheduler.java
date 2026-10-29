package local.dida.tasks;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class ReminderScheduler {
  static final String CHANNEL = "local-task-reminders";
  static final int MAX_PENDING = 128;

  static boolean canNotify(Context context) {
    return (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
      && context.getSystemService(NotificationManager.class).areNotificationsEnabled();
  }

  static boolean schedule(Context context, JSONObject data) throws Exception {
    AlarmManager alarms = context.getSystemService(AlarmManager.class);
    SharedPreferences preferences = context.getSharedPreferences("reminders", Context.MODE_PRIVATE);
    Set<String> previous = new HashSet<>(preferences.getStringSet("pending", new HashSet<>()));
    for (String requestId : previous) alarms.cancel(pending(context, Integer.parseInt(requestId), "", ""));
    Set<String> next = new HashSet<>();
    preferences.edit().putStringSet("pending", next).apply();
    if (data == null || !data.getJSONObject("settings").optBoolean("notifications", true)) return false;
    JSONArray tasks = data.getJSONArray("tasks");
    List<JSONObject> upcoming = new ArrayList<>();
    SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.ROOT);
    format.setLenient(false);
    for (int index = 0; index < tasks.length(); index++) {
      JSONObject task = tasks.getJSONObject(index);
      String reminder = task.optString("reminder", "none");
      if (!task.isNull("completedAt") || !task.isNull("deletedAt") || "none".equals(reminder) || task.isNull("dueDate")) continue;
      try {
        String time = task.isNull("time") ? "09:00" : task.getString("time");
        Date due = format.parse(task.getString("dueDate") + " " + time);
        long offset = "5m".equals(reminder) ? 300000L : "15m".equals(reminder) ? 900000L : "30m".equals(reminder) ? 1800000L : "1h".equals(reminder) ? 3600000L : "1d".equals(reminder) ? 86400000L : 0;
        long when = due.getTime() - offset;
        if (when <= System.currentTimeMillis()) continue;
        upcoming.add(new JSONObject().put("id", task.getString("id")).put("title", task.getString("title")).put("when", when));
      } catch (java.text.ParseException invalidDate) { /* 非法日期不能进入系统闹钟。 */ }
    }
    upcoming.sort((left, right) -> Long.compare(left.optLong("when"), right.optLong("when")));
    for (int index = 0; index < Math.min(MAX_PENDING, upcoming.size()); index++) {
      JSONObject task = upcoming.get(index);
      int requestId = task.getString("id").hashCode() & 0x7fffffff;
      while (next.contains(String.valueOf(requestId))) requestId = (requestId + 1) & 0x7fffffff;
      // 普通闹钟无需精确闹钟权限；系统省电策略可能推迟投递。
      alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, task.getLong("when"), pending(context, requestId, task.getString("id"), task.getString("title")));
      next.add(String.valueOf(requestId));
    }
    preferences.edit().putStringSet("pending", next).apply();
    return !next.isEmpty();
  }

  private static PendingIntent pending(Context context, int requestId, String taskId, String title) {
    Intent intent = new Intent(context, ReminderReceiver.class).putExtra("taskId", taskId).putExtra("title", title).putExtra("notificationId", requestId);
    return PendingIntent.getBroadcast(context, requestId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  static void notify(Context context, int id, String title, String body) {
    if (!canNotify(context)) throw new SecurityException("系统通知未开启，请在系统设置中允许DitaList发送通知");
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    manager.createNotificationChannel(new NotificationChannel(CHANNEL, "任务与专注提醒", NotificationManager.IMPORTANCE_DEFAULT));
    PendingIntent open = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification notification = new Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.app_icon).setContentTitle(title).setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(open).build();
    manager.notify(id, notification);
  }
}
