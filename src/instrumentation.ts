export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { scanner } = await import('@/lib/services/ScannerService');

  // Restore cached results even when background scanning is disabled, so the site still
  // shows the last known data instead of an empty table.
  await scanner.hydrate().catch(() => 0);

  if (process.env.DISABLE_BACKGROUND_SCAN === 'true') return;
  // Kick off the shared server-side refresh loop once per server process.
  void scanner.startBackground();
}
