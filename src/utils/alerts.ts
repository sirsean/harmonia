/**
 * Discord Alert System
 *
 * Sends alerts to Discord channels when important events occur in the strategy.
 * Uses Discord Bot API to send messages to configured channels.
 */

export interface AlertOptions {
  /** Alert title */
  title: string;
  /** Alert message content */
  message: string;
  /** Alert severity level */
  severity?: "info" | "warning" | "error" | "success";
  /** Additional fields to include in the embed */
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  /** Color for the embed (hex color code) */
  color?: number;
}

/**
 * Send an alert to Discord
 */
export async function sendDiscordAlert(options: AlertOptions): Promise<void> {
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const botToken = process.env.DISCORD_APP_TOKEN;

  // Skip if Discord is not configured
  if (!channelId || !botToken) {
    return;
  }

  // Validate configuration
  if (channelId === "your_discord_channel_id_here" || botToken === "your_discord_bot_token_here") {
    console.warn("Discord alerts not configured - skipping alert");
    return;
  }

  // Determine color based on severity
  const color =
    options.color ??
    (options.severity === "error"
      ? 0xff0000 // Red
      : options.severity === "warning"
        ? 0xffaa00 // Orange
        : options.severity === "success"
          ? 0x00ff00 // Green
          : 0x0099ff); // Blue

  // Build embed
  const embed = {
    title: options.title,
    description: options.message,
    color,
    fields: options.fields || [],
    timestamp: new Date().toISOString(),
  };

  // Send message via Discord API
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${botToken}`,
    },
    body: JSON.stringify({
      embeds: [embed],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to send Discord alert: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
}

/**
 * Send an error alert
 */
export async function sendErrorAlert(
  title: string,
  message: string,
  error?: Error | unknown
): Promise<void> {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  if (error instanceof Error) {
    fields.push({
      name: "Error Details",
      value: `\`\`\`${error.message}\`\`\``,
      inline: false,
    });
    if (error.stack) {
      // Truncate stack trace if too long
      const stackTrace =
        error.stack.length > 1000 ? error.stack.substring(0, 1000) + "..." : error.stack;
      fields.push({
        name: "Stack Trace",
        value: `\`\`\`${stackTrace}\`\`\``,
        inline: false,
      });
    }
  } else if (error) {
    fields.push({
      name: "Error Details",
      value: String(error),
      inline: false,
    });
  }

  await sendDiscordAlert({
    title,
    message,
    severity: "error",
    fields,
  });
}

/**
 * Send a success alert
 */
export async function sendSuccessAlert(
  title: string,
  message: string,
  fields?: Array<{ name: string; value: string; inline?: boolean }>
): Promise<void> {
  await sendDiscordAlert({
    title,
    message,
    severity: "success",
    fields,
  });
}

/**
 * Send a warning alert
 */
export async function sendWarningAlert(
  title: string,
  message: string,
  fields?: Array<{ name: string; value: string; inline?: boolean }>
): Promise<void> {
  await sendDiscordAlert({
    title,
    message,
    severity: "warning",
    fields,
  });
}

/**
 * Send an info alert
 */
export async function sendInfoAlert(
  title: string,
  message: string,
  fields?: Array<{ name: string; value: string; inline?: boolean }>
): Promise<void> {
  await sendDiscordAlert({
    title,
    message,
    severity: "info",
    fields,
  });
}
