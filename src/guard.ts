/**
 * Request guard: serve local, non-browser clients only.
 *
 * - Host must be the loopback address. This defeats DNS rebinding, where a web
 *   page points its own hostname at 127.0.0.1.
 * - Any request with an Origin header is refused. Browsers attach Origin to
 *   every cross-site fetch and form post; curl, scripts and launchd jobs do not.
 */

import type { Request, Response, NextFunction } from 'express';

const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

export function localClientsOnly(req: Request, res: Response, next: NextFunction): void {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) {
    res.status(403).json({ error: 'local requests only' });
    return;
  }
  if (req.headers.origin !== undefined) {
    res.status(403).json({ error: 'browser requests are refused' });
    return;
  }
  next();
}
