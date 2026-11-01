import { listen } from "@tauri-apps/api/event";
import { z } from "zod";

// Keep the custom frame's corners in sync with Windows. Opening the main
// window uses the native show/restore path and never locks App interaction.
export async function installMainWindowState(): Promise<() => void> {
  return listen<unknown>("desktop://main-window-state", ({ payload }) => {
    const decoded = z.object({ maximized: z.boolean() }).safeParse(payload);
    if (decoded.success) document.documentElement.dataset.mainMaximized = String(decoded.data.maximized);
  });
}
