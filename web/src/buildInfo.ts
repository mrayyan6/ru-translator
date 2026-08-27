/**
 * The build stamp, rendered in the device's own timezone.
 *
 * `toLocaleString` with no locale argument uses the device's settings, so a
 * phone set to Pakistan Standard Time shows PKT without the app needing to
 * know anything about where it is.
 */
export function buildLabel(): string {
  try {
    return new Date(__BUILD_TIME__).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(__BUILD_TIME__).toISOString();
  }
}

/** Full stamp including the timezone name, for the report. */
export function buildLabelLong(): string {
  try {
    return new Date(__BUILD_TIME__).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZoneName: 'short',
    });
  } catch {
    return new Date(__BUILD_TIME__).toISOString();
  }
}
