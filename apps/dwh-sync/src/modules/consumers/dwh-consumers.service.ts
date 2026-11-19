// Subscribes every DWH_SUBSCRIPTIONS group on `los:events` and feeds DwhProjector. Never crashes the process:
// the DWH schema is brought up to date first (retried in the background, nothing is read meanwhile); a failed subscribe is retried;
// transient DWH errors (outage) stay pending without consuming a delivery attempt; deterministic ones → DLQ after maxDeliveries (C3).
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { EventBus } from '@los/database';
import { DwhSchemaService } from '../etl/dwh-schema';
import { ConsumerStatusRegistry } from './consumer-status';
import { DWH_SUBSCRIPTIONS } from './decode';
import { DwhProjector } from './dwh-projector';
import { DWH_EVENT_BUS } from './tokens';
import { isTransientDwhError } from './transient-error';

const SUBSCRIBE_RETRY_MS = 5_000;
type Subscription = (typeof DWH_SUBSCRIPTIONS)[number];

/** The bus rejects schema-invalid payloads (incl. unknown `version`) before our handler runs — a poison message, not a consumer fault. */
const isPoisonMessage = (err: unknown) => err instanceof SyntaxError || (err as { name?: string } | null)?.name === 'ZodError';

@Injectable()
export class DwhConsumersService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('DwhConsumers');
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(
    @Inject(DWH_EVENT_BUS) private readonly bus: EventBus | null,
    private readonly projector: DwhProjector,
    private readonly status: ConsumerStatusRegistry,
    private readonly schema: DwhSchemaService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.bus) {
      this.status.markBusDisabled();
      this.log.warn('REDIS_URL not set: dwh-sync consumers disabled, nothing reaches the DWH');
    }
    if (await this.schema.ensure()) await this.subscribeAll();
    else this.later(() => this.retrySchema());
  }

  private async retrySchema(): Promise<void> {
    if (await this.schema.ensure()) await this.subscribeAll();
    else this.later(() => this.retrySchema());
  }

  private async subscribeAll(): Promise<void> {
    if (!this.bus || this.closed) return;
    await Promise.all(DWH_SUBSCRIPTIONS.map(async (s) => { if (!(await this.trySubscribe(s))) this.scheduleRetry(s); }));
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    await this.bus?.close();
  }

  private async trySubscribe(s: Subscription): Promise<boolean> {
    try {
      await this.bus!.subscribe(s.group, [...s.types], async (event) => {
        const outcome = await this.projector.handle(s.group, event);
        this.status.recordSuccess(s.group);
        if (outcome === 'DUPLICATE') this.log.debug(`duplicate ${event.type} ${event.eventId} ignored (${s.group})`);
      }, {
        isTransientError: isTransientDwhError,
        onError: (err, event) => this.onError(s.group, err, event?.eventId),
        onDeadLetter: (err, event) => {
          this.status.recordDeadLetter(s.group);
          this.log.error(JSON.stringify({ msg: 'dwh event dead-lettered (replay: replay-dlq)', group: s.group, eventId: event?.eventId, error: err instanceof Error ? err.name : 'Error' }));
        },
      });
      this.status.markSubscribed(s.group);
      return true;
    } catch (err) {
      this.log.error(`subscribe ${s.group} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private scheduleRetry(s: Subscription): void {
    this.later(async () => { if (!(await this.trySubscribe(s))) this.scheduleRetry(s); });
  }

  private later(fn: () => Promise<void>): void {
    if (this.closed) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) void fn();
    }, SUBSCRIBE_RETRY_MS);
    t.unref();
    this.timers.add(t);
  }

  private onError(group: string, err: unknown, eventId?: string): void {
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
    if (isPoisonMessage(err)) {
      // Unknown version / invalid payload: logged and skipped by us; the bus moves it to `los:events:dlq` after maxDeliveries.
      this.log.warn(JSON.stringify({ msg: 'dwh event rejected by schema (skipped)', group, error: err instanceof Error ? err.name : 'Error' }));
      return;
    }
    if (isTransientDwhError(err)) {
      // DWH outage: the message stays pending and does not consume a delivery attempt; readiness shows it via the `dwh` check.
      this.log.warn(JSON.stringify({ msg: 'dwh unavailable, event left pending', group, eventId, error: message }));
      return;
    }
    this.status.recordFailure(group);
    this.log.error(JSON.stringify({ msg: 'dwh consumer error', group, eventId, error: message }));
  }
}
