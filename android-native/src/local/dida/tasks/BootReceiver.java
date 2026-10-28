package local.dida.tasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
    try { ReminderScheduler.schedule(context, new LocalStore(context).readForReminder()); }
    catch (Exception error) { android.util.Log.w("DidaLocal", "Boot reschedule failed: " + error.getClass().getSimpleName()); }
  }
}
