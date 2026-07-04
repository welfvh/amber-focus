/**
 * /etc/hosts management — read/write with marker-delimited blocks.
 *
 * Uses atomic writes (write-then-rename) so a crash mid-write
 * doesn't corrupt the hosts file.
 */

import { collectAllDomainsWithVariants } from '../shared/domains.js';
import type { SystemOperations } from './system.js';

const HOSTS_PATH = '/etc/hosts';
const MARKER_START = '# BEGIN AMBER FOCUS BLOCK';
const MARKER_END = '# END AMBER FOCUS BLOCK';

export class HostsManager {
  constructor(private sys: SystemOperations) {}

  /** Update /etc/hosts to block the given domains. Empty array = remove block. */
  async update(domains: string[], shieldActive: boolean): Promise<number> {
    const allDomains = collectAllDomainsWithVariants(domains);
    let content = await this.sys.readFile(HOSTS_PATH);

    // Remove existing block
    const startIdx = content.indexOf(MARKER_START);
    const endIdx = content.indexOf(MARKER_END);
    if (startIdx !== -1 && endIdx !== -1) {
      content = content.slice(0, startIdx) + content.slice(endIdx + MARKER_END.length);
    }
    content = content.trimEnd() + '\n';

    // Add new entries if shield is active
    if (shieldActive && allDomains.length > 0) {
      content += '\n' + MARKER_START + '\n';
      content += `# Generated: ${new Date().toISOString()}\n`;
      content += `# Blocking ${allDomains.length} domains\n`;
      for (const domain of allDomains) {
        content += `0.0.0.0 ${domain}\n`;
        content += `:: ${domain}\n`;
      }
      content += MARKER_END + '\n';
    }

    await this.sys.writeFileAtomic(HOSTS_PATH, content);
    return allDomains.length;
  }
}
