import type { AppConfig } from "./config";

// Placeholder until the star check is ported (GSB-9).
export function handleScheduled(controller: ScheduledController, config: AppConfig): void {
  console.log(
    JSON.stringify({
      message: "Star check placeholder ran",
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
      notifications: config.notifications,
    }),
  );
}
