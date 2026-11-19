// In-process status of each dwh-sync consumer group. Readiness (/api/health/ready) = can this group process right now: bus enabled and
// subscribed (DWH reachability and schema are separate checks). Dead letters / handler failures are information only (status endpoint).
import { Injectable } from '@nestjs/common';

export interface GroupStatus { readonly subscribed: boolean; readonly deadLettered: number; readonly consecutiveFailures: number }
export interface ConsumersSnapshot { readonly busEnabled: boolean; readonly groups: Readonly<Record<string, GroupStatus>> }
const INITIAL: GroupStatus = { subscribed: false, deadLettered: 0, consecutiveFailures: 0 };

@Injectable()
export class ConsumerStatusRegistry {
  private groups = new Map<string, GroupStatus>();
  private busDisabled = false;

  markBusDisabled(): void { this.busDisabled = true; }
  markSubscribed(group: string): void { this.set(group, { subscribed: true }); }
  recordSuccess(group: string): void { this.set(group, { consecutiveFailures: 0 }); }
  recordFailure(group: string): void { this.set(group, { consecutiveFailures: this.get(group).consecutiveFailures + 1 }); }
  recordDeadLetter(group: string): void { this.set(group, { deadLettered: this.get(group).deadLettered + 1 }); }

  /** Throws (→ health check "down") unless the bus is enabled and the group is subscribed. */
  assertHealthy(group: string): void {
    if (this.busDisabled) throw new Error('event bus disabled (REDIS_URL not set)');
    if (!this.get(group).subscribed) throw new Error(`consumer group ${group} not subscribed`);
  }

  snapshot(): ConsumersSnapshot {
    return { busEnabled: !this.busDisabled, groups: Object.fromEntries([...this.groups].map(([g, s]) => [g, { ...s }])) };
  }

  private get(group: string): GroupStatus { return this.groups.get(group) ?? INITIAL; }
  private set(group: string, patch: Partial<GroupStatus>): void { this.groups.set(group, { ...this.get(group), ...patch }); }
}
