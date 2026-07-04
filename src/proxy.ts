/**
 * Path-filtering MITM Proxy for amber-focus.
 * Intercepts HTTPS requests and blocks specific URL paths.
 * Also enforces delay friction for configured domains.
 *
 * Requires: Install the generated CA cert in System Keychain as trusted.
 */

import http from 'http';
import https from 'https';
import tls from 'tls';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  isDomainBlocked,
  isDomainDelayed,
  isInActiveSession,
  getDelaySeconds,
  updateSessionAccess,
  recordDelayAccess,
} from './store.js';

const PROXY_PORT = 8080;
const CERT_DIR = path.join(process.env.HOME || '/tmp', '.config', 'amber-focus', 'certs');
const CA_KEY = path.join(CERT_DIR, 'ca.key');
const CA_CERT = path.join(CERT_DIR, 'ca.crt');

// In-memory cache of generated certs
const certCache: Map<string, { key: string; cert: string }> = new Map();

// Blocked paths: { domain: [path patterns] }
let blockedPaths: Map<string, string[]> = new Map();

function log(msg: string): void {
  console.log(`[proxy] ${msg}`);
}

/**
 * Ensure CA certificate exists, generate if not.
 */
function ensureCACert(): void {
  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
  }

  if (!fs.existsSync(CA_KEY) || !fs.existsSync(CA_CERT)) {
    log('Generating CA certificate...');

    // Generate CA private key
    execSync(`openssl genrsa -out "${CA_KEY}" 2048`, { stdio: 'ignore' });

    // Generate CA certificate
    execSync(`openssl req -x509 -new -nodes -key "${CA_KEY}" -sha256 -days 3650 -out "${CA_CERT}" -subj "/C=US/ST=CA/L=SF/O=amber-focus/CN=amber-focus CA"`, { stdio: 'ignore' });

    log(`CA certificate generated at: ${CA_CERT}`);
    log('To trust it, run:');
    log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CA_CERT}"`);
  }
}

/**
 * Generate a certificate for a specific domain, signed by our CA.
 */
function generateCertForDomain(domain: string): { key: string; cert: string } {
  if (certCache.has(domain)) {
    return certCache.get(domain)!;
  }

  const keyFile = path.join(CERT_DIR, `${domain}.key`);
  const certFile = path.join(CERT_DIR, `${domain}.crt`);
  const csrFile = path.join(CERT_DIR, `${domain}.csr`);
  const extFile = path.join(CERT_DIR, `${domain}.ext`);

  // Generate key
  execSync(`openssl genrsa -out "${keyFile}" 2048`, { stdio: 'ignore' });

  // Generate CSR
  execSync(`openssl req -new -key "${keyFile}" -out "${csrFile}" -subj "/C=US/ST=CA/L=SF/O=amber-focus/CN=${domain}"`, { stdio: 'ignore' });

  // Create extension file for SAN
  fs.writeFileSync(extFile, `
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${domain}
DNS.2 = *.${domain}
`);

  // Sign with CA
  execSync(`openssl x509 -req -in "${csrFile}" -CA "${CA_CERT}" -CAkey "${CA_KEY}" -CAcreateserial -out "${certFile}" -days 365 -sha256 -extfile "${extFile}"`, { stdio: 'ignore' });

  // Clean up temp files
  fs.unlinkSync(csrFile);
  fs.unlinkSync(extFile);

  const result = {
    key: fs.readFileSync(keyFile, 'utf8'),
    cert: fs.readFileSync(certFile, 'utf8'),
  };

  certCache.set(domain, result);
  return result;
}

/**
 * Check if a URL path is blocked.
 */
function isPathBlocked(host: string, urlPath: string): boolean {
  const domain = host.replace(/:\d+$/, '').toLowerCase();

  // Check exact domain
  const patterns = blockedPaths.get(domain);
  if (patterns) {
    for (const pattern of patterns) {
      if (urlPath.toLowerCase().includes(pattern.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Serve a block page.
 */
function serveBlockPage(res: http.ServerResponse, host: string, path: string): void {
  res.writeHead(403, { 'Content-Type': 'text/html' });
  res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Blocked - amber-focus</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a1a; color: #fff; }
    .box { text-align: center; padding: 40px; }
    h1 { font-size: 48px; margin: 0; }
    p { color: #888; margin-top: 20px; }
    code { background: #333; padding: 4px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>🛡️</h1>
    <p>Path blocked by amber-focus</p>
    <p><code>${host}${path}</code></p>
  </div>
</body>
</html>
`);
}

/**
 * Generate delay page HTML with countdown timer.
 * After timer completes, records access and redirects to original URL.
 */
function generateDelayPageHtml(host: string, urlPath: string, delaySeconds: number): string {
  const targetUrl = `https://${host}${urlPath}`;
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Delay - amber-focus</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a1a; color: #fff; }
    .box { text-align: center; padding: 40px; max-width: 400px; }
    h1 { font-size: 72px; margin: 0; font-variant-numeric: tabular-nums; }
    p { color: #888; margin-top: 20px; line-height: 1.6; }
    code { background: #333; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .progress { width: 100%; height: 4px; background: #333; border-radius: 2px; margin-top: 30px; overflow: hidden; }
    .progress-bar { height: 100%; background: #666; transition: width 1s linear; }
    .hint { font-size: 12px; color: #555; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="box">
    <h1 id="timer">${delaySeconds}</h1>
    <p>Taking a moment before accessing</p>
    <p><code>${host}</code></p>
    <div class="progress"><div class="progress-bar" id="progress" style="width: 100%"></div></div>
    <p class="hint">Each access today increases the delay.<br>Delay resets at midnight.</p>
  </div>
  <script>
    const total = ${delaySeconds};
    let remaining = total;
    const timer = document.getElementById('timer');
    const progress = document.getElementById('progress');

    const interval = setInterval(() => {
      remaining--;
      timer.textContent = remaining;
      progress.style.width = (remaining / total * 100) + '%';

      if (remaining <= 0) {
        clearInterval(interval);
        // Record access via API then redirect
        fetch('http://127.0.0.1:8053/api/delay-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: '${host.replace(/'/g, "\\'")}' })
        }).finally(() => {
          window.location.href = '${targetUrl.replace(/'/g, "\\'")}';
        });
      }
    }, 1000);
  </script>
</body>
</html>`;
}

/**
 * Handle HTTPS CONNECT requests (MITM).
 */
function handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
  const [host, port] = (req.url || '').split(':');
  const targetPort = parseInt(port) || 443;

  // Generate cert for this domain
  const { key, cert } = generateCertForDomain(host);
  const caContent = fs.readFileSync(CA_CERT, 'utf8');

  // Tell client we're connected
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Create TLS server for this connection
  const tlsOptions: tls.TlsOptions = {
    key,
    cert,
    ca: caContent,
  };

  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    ...tlsOptions,
  });

  tlsSocket.on('error', (err) => {
    // Ignore client disconnect errors
  });

  // Handle decrypted requests
  let requestData = '';
  tlsSocket.on('data', (data) => {
    requestData += data.toString();

    // Check if we have full headers
    const headerEnd = requestData.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headers = requestData.substring(0, headerEnd);
    const [requestLine] = headers.split('\r\n');
    const [method, urlPath] = requestLine.split(' ');

    // Check if domain is DNS-blocked
    const domain = host.replace(/:\d+$/, '').toLowerCase();
    if (isDomainBlocked(domain)) {
      log(`BLOCKED (DNS): ${host}${urlPath}`);
      const response = `HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n
<!DOCTYPE html>
<html>
<head><title>Blocked</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}.box{text-align:center}h1{font-size:48px;margin:0}p{color:#888}code{background:#333;padding:4px 8px;border-radius:4px}</style>
</head>
<body><div class="box"><h1>🛡️</h1><p>Blocked by amber-focus</p><p><code>${host}</code></p></div></body>
</html>`;
      tlsSocket.write(response);
      tlsSocket.end();
      return;
    }

    // Check if path is blocked
    if (isPathBlocked(host, urlPath)) {
      log(`BLOCKED (path): ${host}${urlPath}`);
      const response = `HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n
<!DOCTYPE html>
<html>
<head><title>Blocked</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}.box{text-align:center}h1{font-size:48px;margin:0}p{color:#888}code{background:#333;padding:4px 8px;border-radius:4px}</style>
</head>
<body><div class="box"><h1>🛡️</h1><p>Path blocked by amber-focus</p><p><code>${host}${urlPath}</code></p></div></body>
</html>`;
      tlsSocket.write(response);
      tlsSocket.end();
      return;
    }

    // Check if domain is delayed
    if (isDomainDelayed(domain)) {
      if (isInActiveSession(domain)) {
        // In active session, update access time and pass through
        updateSessionAccess(domain);
      } else {
        // Show delay page
        const delaySeconds = getDelaySeconds(domain);
        log(`DELAY: ${host}${urlPath} (${delaySeconds}s)`);
        const html = generateDelayPageHtml(host, urlPath, delaySeconds);
        const response = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`;
        tlsSocket.write(response);
        tlsSocket.end();
        return;
      }
    }

    // Forward to actual server
    const reqHeaders: Record<string, string> = {};

    // Parse headers
    const headerLines = headers.split('\r\n').slice(1);
    for (const line of headerLines) {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length) {
        reqHeaders[key.trim()] = valueParts.join(':').trim();
      }
    }

    // Force Connection: close for simpler handling
    reqHeaders['Connection'] = 'close';

    const options: https.RequestOptions = {
      hostname: host,
      port: targetPort,
      path: urlPath,
      method,
      headers: reqHeaders,
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let resHeaders = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        // Skip transfer-encoding for simpler handling
        if (key.toLowerCase() === 'transfer-encoding') continue;
        if (Array.isArray(value)) {
          resHeaders += `${key}: ${value.join(', ')}\r\n`;
        } else if (value) {
          resHeaders += `${key}: ${value}\r\n`;
        }
      }
      resHeaders += 'Connection: close\r\n';
      resHeaders += '\r\n';

      tlsSocket.write(resHeaders);

      proxyRes.on('data', (chunk) => {
        tlsSocket.write(chunk);
      });

      proxyRes.on('end', () => {
        tlsSocket.end();
      });
    });

    proxyReq.on('error', (err) => {
      log(`Proxy error: ${err.message}`);
      tlsSocket.end();
    });

    // Send body if any
    const body = requestData.substring(headerEnd + 4);
    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();

    // Handle subsequent data
    requestData = '';
  });
}

/**
 * Handle HTTP requests.
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const host = req.headers.host || '';
  const urlPath = req.url || '/';
  const domain = host.split(':')[0].toLowerCase();

  // Check if domain is DNS-blocked
  if (isDomainBlocked(domain)) {
    log(`BLOCKED (DNS): ${host}${urlPath}`);
    serveBlockPage(res, host, '/');
    return;
  }

  if (isPathBlocked(host, urlPath)) {
    log(`BLOCKED (path): ${host}${urlPath}`);
    serveBlockPage(res, host, urlPath);
    return;
  }

  // Check if domain is delayed
  if (isDomainDelayed(domain)) {
    if (isInActiveSession(domain)) {
      updateSessionAccess(domain);
    } else {
      const delaySeconds = getDelaySeconds(domain);
      log(`DELAY: ${host}${urlPath} (${delaySeconds}s)`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateDelayPageHtml(host, urlPath, delaySeconds));
      return;
    }
  }

  // Forward request
  const options: http.RequestOptions = {
    hostname: host.split(':')[0],
    port: parseInt(host.split(':')[1]) || 80,
    path: urlPath,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
}

/**
 * Update blocked paths from config.
 */
export function setBlockedPaths(paths: Map<string, string[]>): void {
  blockedPaths = paths;
}

/**
 * Add a blocked path.
 */
export function addBlockedPath(domain: string, pathPattern: string): void {
  const normalized = domain.toLowerCase();
  if (!blockedPaths.has(normalized)) {
    blockedPaths.set(normalized, []);
  }
  const paths = blockedPaths.get(normalized)!;
  if (!paths.includes(pathPattern)) {
    paths.push(pathPattern);
  }
}

/**
 * Remove a blocked path.
 */
export function removeBlockedPath(domain: string, pathPattern: string): void {
  const normalized = domain.toLowerCase();
  const paths = blockedPaths.get(normalized);
  if (paths) {
    const idx = paths.indexOf(pathPattern);
    if (idx !== -1) {
      paths.splice(idx, 1);
    }
    if (paths.length === 0) {
      blockedPaths.delete(normalized);
    }
  }
}

/**
 * Get all blocked paths.
 */
export function getBlockedPaths(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  blockedPaths.forEach((paths, domain) => {
    result[domain] = [...paths];
  });
  return result;
}

/**
 * Get CA cert path for installation.
 */
export function getCACertPath(): string {
  return CA_CERT;
}

/**
 * Start the proxy server.
 */
export function startProxy(): http.Server {
  ensureCACert();

  const server = http.createServer(handleRequest);
  server.on('connect', handleConnect);

  server.listen(PROXY_PORT, '127.0.0.1', () => {
    log(`Proxy running on http://127.0.0.1:${PROXY_PORT}`);
    log(`CA cert: ${CA_CERT}`);
  });

  return server;
}
