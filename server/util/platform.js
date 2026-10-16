// The computer the floor runs on, for the words in its messages: a Mac or a Windows PC.
export const onWindows = process.platform === 'win32';
export const MACHINE = onWindows ? 'PC' : 'Mac';

// How to load new code into a floor that's still running the old code (after a git pull).
export const RESTART_HINT = onWindows
  ? 'double-click update in the trading-floor folder (it restarts the floor; a floor in its own window: close the window and double-click start)'
  : 'in Terminal, cd ~/trading-floor && npm run service -- restart (or, without the service, Ctrl+C and npm start)';

// Keeps Windows from going to sleep while the floor runs (the display may still turn off): a
// hidden PowerShell holds "system required" until the floor's process ends. The Mac uses
// caffeinate (server/index.js).
export function keepAwakeWindowsArgs(pid) {
  const script = [
    "$k = Add-Type -Name Power -Namespace Floor -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    '[void]$k::SetThreadExecutionState(2147483649)',
    `Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
  ].join('; ');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script];
}
