/**
 * pf (packet filter) firewall management.
 *
 * Two layers:
 * 1. Static anchor — hardcoded IP ranges for major services (Twitter, Meta, etc.)
 * 2. Dynamic anchor — resolved IPs for priority domains, updated on state changes
 *
 * Uses `block return` for fast TCP RST / ICMP unreachable instead of silent drop.
 * Also blocks UDP 443 (QUIC) to prevent browsers from falling back to it.
 */

import { collectAllDomainsWithVariants, PRIORITY_DOMAINS } from '../shared/domains.js';
import { resolveDomainIPs, resolveDomainWithVariants } from './dns.js';
import type { SystemOperations } from './system.js';
import type { OperationQueue } from './queue.js';

const PF_ANCHOR_PATH = '/etc/pf.anchors/com.welf.amberfocus';
const DYNAMIC_PF_PATH = '/etc/pf.anchors/com.welf.amberfocus.dynamic';
const PF_CONF_PATH = '/etc/pf.conf';

export class PfManager {
  constructor(
    private sys: SystemOperations,
    private queue: OperationQueue,
  ) {}

  /** Ensure pf.conf has both anchors registered. */
  async ensureAnchors(): Promise<void> {
    let pfConf = await this.sys.readFile(PF_CONF_PATH);
    let changed = false;

    // Static anchor
    if (!pfConf.includes('anchor "com.welf.amberfocus"')) {
      pfConf += '\nanchor "com.welf.amberfocus"\nload anchor "com.welf.amberfocus" from "/etc/pf.anchors/com.welf.amberfocus"\n';
      changed = true;
    }

    // Dynamic anchor
    if (!pfConf.includes('com.welf.amberfocus.dynamic')) {
      pfConf += 'anchor "com.welf.amberfocus.dynamic"\nload anchor "com.welf.amberfocus.dynamic" from "/etc/pf.anchors/com.welf.amberfocus.dynamic"\n';
      changed = true;
    }

    if (changed) {
      await this.sys.writeFile(PF_CONF_PATH, pfConf);
    }
  }

  /** Write static pf rules (hardcoded IP ranges) and reload. */
  async updateStaticRules(shieldActive: boolean): Promise<void> {
    await this.queue.enqueue(async () => {
      const rules = shieldActive ? generateStaticRules() : '# amber-focus pf disabled\n';
      await this.sys.writeFile(PF_ANCHOR_PATH, rules);

      if (!await this.sys.fileExists(DYNAMIC_PF_PATH)) {
        await this.sys.writeFile(DYNAMIC_PF_PATH, '# Dynamic pf rules\n');
      }

      await this.ensureAnchors();
      await this.reload();
    });
  }

  /** Resolve priority domains to IPs and write dynamic pf rules. */
  async refreshDynamicRules(blockedDomains: string[], shieldActive: boolean): Promise<void> {
    await this.queue.enqueue(async () => {
      if (!shieldActive) {
        await this.sys.writeFile(DYNAMIC_PF_PATH, '# Dynamic pf rules disabled\n');
        await this.reload();
        return;
      }

      const blockedSet = new Set(blockedDomains.map(d => d.toLowerCase()));
      const priorityToResolve = PRIORITY_DOMAINS.filter(d => blockedSet.has(d));
      const allDomains = collectAllDomainsWithVariants(priorityToResolve);

      // Preserve enforce-tagged rules from blockDomain() calls (only if domain still blocked)
      let preservedEnforceLines: string[] = [];
      try {
        const existing = await this.sys.readFile(DYNAMIC_PF_PATH);
        preservedEnforceLines = existing.split('\n').filter(line => {
          if (!line.includes('# enforce:')) return false;
          const match = line.match(/# enforce:(.+)$/);
          return match && blockedSet.has(match[1]);
        });
      } catch {}

      let rules = `# Dynamic pf rules - generated ${new Date().toISOString()}\n`;
      let ipCount = 0;

      // Resolve all priority domains in parallel
      const resolutions = await Promise.allSettled(
        allDomains.map(async (domain) => {
          const ips = await resolveDomainIPs(domain);
          return { domain, ips };
        })
      );

      for (const r of resolutions) {
        if (r.status === 'fulfilled') {
          for (const ip of r.value.ips) {
            rules += `block return out quick proto tcp to ${ip} # dynamic:${r.value.domain}\n`;
            rules += `block return out quick proto udp to ${ip} port 443 # dynamic:${r.value.domain}\n`;
            ipCount++;
          }
        }
      }

      // Append preserved enforce rules so they survive refresh cycles
      if (preservedEnforceLines.length > 0) {
        rules += preservedEnforceLines.join('\n') + '\n';
      }

      await this.sys.writeFile(DYNAMIC_PF_PATH, rules);
      await this.reload();
    });
  }

  /** Add IP-level blocks for a specific domain (used on enforce/reblock). */
  async blockDomain(domain: string): Promise<string[]> {
    return this.queue.enqueue(async () => {
      const ips = await resolveDomainWithVariants(domain);
      if (ips.length === 0) return [];

      let existing = '';
      try { existing = await this.sys.readFile(DYNAMIC_PF_PATH); } catch {}

      let newRules = existing;
      for (const ip of ips) {
        const tcpRule = `block return out quick proto tcp to ${ip} # enforce:${domain}`;
        if (!newRules.includes(tcpRule)) {
          newRules += tcpRule + '\n';
          newRules += `block return out quick proto udp to ${ip} port 443 # enforce:${domain}\n`;
        }
      }

      await this.sys.writeFile(DYNAMIC_PF_PATH, newRules);
      await this.reload();

      // Kill existing connections to these IPs
      for (const ip of ips) {
        await this.sys.execSilent('/sbin/pfctl', ['-k', '0.0.0.0/0', '-k', ip]);
      }

      return ips;
    });
  }

  /** Remove IP-level blocks for a specific domain (used on grant/unblock). */
  async unblockDomain(domain: string): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        const rules = await this.sys.readFile(DYNAMIC_PF_PATH);
        const lines = rules.split('\n').filter(line =>
          !line.includes(`# enforce:${domain}`) &&
          !line.includes(`# dynamic:${domain}`) &&
          !line.endsWith(`# ${domain}`)  // legacy untagged rules
        );
        await this.sys.writeFile(DYNAMIC_PF_PATH, lines.join('\n') + '\n');
        await this.reload();
      } catch {
        // Ignore if file doesn't exist
      }
    });
  }

  /** Kill existing TCP connections to a domain's resolved IPs. */
  async killConnections(domain: string): Promise<void> {
    const ips = await resolveDomainWithVariants(domain);
    for (const ip of ips) {
      await this.sys.execSilent('/sbin/pfctl', ['-k', '0.0.0.0/0', '-k', ip]);
    }
  }

  private async reload(): Promise<void> {
    await this.sys.execSilent('/sbin/pfctl', ['-f', PF_CONF_PATH]);
  }
}

function generateStaticRules(): string {
  return `# amber-focus pf rules - generated ${new Date().toISOString()}
# Block outgoing connections to blocked service IPs (return = fast failure)

# Twitter/X Corp (AS13414)
block return out quick proto tcp to 104.244.42.0/24
block return out quick proto udp to 104.244.42.0/24 port 443
block return out quick proto tcp to 104.244.43.0/24
block return out quick proto udp to 104.244.43.0/24 port 443
block return out quick proto tcp to 104.244.44.0/24
block return out quick proto udp to 104.244.44.0/24 port 443
block return out quick proto tcp to 104.244.45.0/24
block return out quick proto udp to 104.244.45.0/24 port 443
block return out quick proto tcp to 104.244.46.0/24
block return out quick proto udp to 104.244.46.0/24 port 443
block return out quick proto tcp to 69.195.160.0/24
block return out quick proto udp to 69.195.160.0/24 port 443
block return out quick proto tcp to 192.133.77.0/24
block return out quick proto udp to 192.133.77.0/24 port 443

# Meta/Facebook/Instagram (AS32934)
block return out quick proto tcp to 157.240.0.0/16
block return out quick proto udp to 157.240.0.0/16 port 443
block return out quick proto tcp to 31.13.0.0/16
block return out quick proto udp to 31.13.0.0/16 port 443
# Meta new ranges (2024+)
block return out quick proto tcp to 57.141.0.0/16
block return out quick proto tcp to 57.142.0.0/16
block return out quick proto tcp to 57.143.0.0/16
block return out quick proto tcp to 57.144.0.0/16
block return out quick proto tcp to 57.145.0.0/16
block return out quick proto tcp to 57.146.0.0/16
block return out quick proto tcp to 57.147.0.0/16
block return out quick proto tcp to 57.148.0.0/16
block return out quick proto tcp to 57.149.0.0/16
block return out quick proto tcp to 179.60.192.0/22
block return out quick proto tcp to 185.60.216.0/22
block return out quick proto tcp to 66.220.144.0/20
block return out quick proto tcp to 69.63.176.0/20
block return out quick proto tcp to 69.171.224.0/19
block return out quick proto tcp to 74.119.76.0/22
block return out quick proto tcp to 102.132.96.0/20
block return out quick proto tcp to 103.4.96.0/22
block return out quick proto tcp to 129.134.0.0/16
block return out quick proto tcp to 147.75.208.0/20
block return out quick proto tcp to 173.252.64.0/18
block return out quick proto tcp to 204.15.20.0/22

# TikTok (ByteDance - partial)
block return out quick proto tcp to 161.117.0.0/16
block return out quick proto udp to 161.117.0.0/16 port 443
block return out quick proto tcp to 162.62.0.0/16
block return out quick proto udp to 162.62.0.0/16 port 443

# Netflix (AS2906) - primary ranges
block return out quick proto tcp to 23.246.0.0/18
block return out quick proto tcp to 37.77.184.0/21
block return out quick proto tcp to 45.57.0.0/17
block return out quick proto tcp to 64.120.128.0/17
block return out quick proto tcp to 66.197.128.0/17
block return out quick proto tcp to 108.175.32.0/20
block return out quick proto tcp to 185.2.220.0/22
block return out quick proto tcp to 185.9.188.0/22
block return out quick proto tcp to 192.173.64.0/18
block return out quick proto tcp to 198.38.96.0/19
block return out quick proto tcp to 198.45.48.0/20
block return out quick proto tcp to 208.75.76.0/22
`;
}
