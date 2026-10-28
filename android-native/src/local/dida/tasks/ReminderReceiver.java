package local.dida.tasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class ReminderReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    String title = intent.getStringExtra("title");
    if (title == null) return;
    try { ReminderScheduler.notify(context, intent.getIntExtra("notificationId", 1), title, "任务提醒"); }
    catch (SecurityException denied) { /* 由用户控制系统通知权限，不能将拒绝当成发送成功。 */ }
    try { ReminderScheduler.schedule(context, new LocalStore(context).readForReminder()); }
    catch (Exception error) { android.util.Log.w("DidaLocal", "Reminder refresh failed: " + error.getClass().getSimpleName()); }
  }
}
