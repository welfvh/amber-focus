/**
 * macOS notification banner. Title and body go to the script as arguments,
 * never into its source.
 */

import { execFile } from 'child_process';

const SCRIPT = `function run(argv) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayNotification(argv[1], { withTitle: argv[0] });
}`;

export function notify(title: string, body: string): void {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, title, body.slice(0, 300)], (err) => {
    if (err) console.error('[notify] failed:', err.message.split('\n')[0]);
  });
}
