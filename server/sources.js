// Merges the activity collectors (Claude Code, Codex…) into one source with the collector
// interface the server and the reporter use: 'events' (key, events), 'tick', snapshot(), allEvents().
import { EventEmitter } from 'node:events';

export class Sources extends EventEmitter {
  constructor(collectors) {
    super();
    this.collectors = collectors;
    for (const c of collectors) c.on('events', (key, events) => this.emit('events', key, events));
    // Every collector ticks once a second; one tick is enough to send a fresh snapshot.
    collectors[0]?.on('tick', () => this.emit('tick'));
  }

  start() { for (const c of this.collectors) c.start(); }
  snapshot() { return this.collectors.flatMap((c) => c.snapshot()); }
  allEvents(limit) { return Object.assign({}, ...this.collectors.map((c) => c.allEvents(limit))); }
}
