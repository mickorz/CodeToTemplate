// PresenceStore: 分布式协作在线状态存储
// 协议核心: 共享用户状态/光标/在线情况, 基于逻辑时钟解决乱序/迟到/恶意删除等问题

export const OUTDATED_TIMEOUT = 30000;

export interface PresenceMeta {
  clock: number;
  lastUpdated: number;
}

export interface PresenceChangePayload {
  added: number[];
  updated: number[];
  removed: number[];
}

type NowFn = () => number;
type EventName = "update" | "change";
type EventHandler = (payload: PresenceChangePayload, origin?: any) => void;

function shallowEqual(a: object, b: object): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if ((a as any)[key] !== (b as any)[key]) return false;
  }
  return true;
}

export class PresenceStore {
  static readonly OUTDATED_TIMEOUT = OUTDATED_TIMEOUT;
  readonly OUTDATED_TIMEOUT = OUTDATED_TIMEOUT;

  private readonly _clientID: number;
  private readonly _now: NowFn;
  private _localState: object | null = null;
  private readonly _states: Map<number, object> = new Map();
  private readonly _meta: Map<number, PresenceMeta> = new Map();
  private readonly _listeners: Map<EventName, Set<EventHandler>> = new Map();

  constructor(clientID: number, opts?: { now?: NowFn }) {
    this._clientID = clientID;
    this._now = opts?.now ?? (() => Date.now());
    this._meta.set(clientID, { clock: 0, lastUpdated: this._now() });
  }

  getLocalState(): object | null {
    return this._localState;
  }

  setLocalState(state: object | null): void {
    const prev = this._localState;
    if (state === null && prev === null) return;

    this._localState = state;
    const meta = this._meta.get(this._clientID)!;
    meta.clock += 1;
    meta.lastUpdated = this._now();

    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];

    if (state === null) {
      this._states.delete(this._clientID);
      removed.push(this._clientID);
    } else {
      this._states.set(this._clientID, state);
      if (prev === null) {
        added.push(this._clientID);
      } else {
        updated.push(this._clientID);
      }
    }

    this._emit("update", { added, updated, removed }, "local");

    const hasChange =
      state === null
        ? removed.length > 0
        : prev === null
          ? added.length > 0
          : !shallowEqual(prev, state);

    if (hasChange) {
      this._emit("change", { added, updated, removed }, "local");
    }
  }

  setLocalStateField(field: string, value: any): void {
    if (this._localState === null) return;
    const prev = this._localState;
    const newState = { ...prev, [field]: value };
    this._localState = newState;
    const meta = this._meta.get(this._clientID)!;
    meta.clock += 1;
    meta.lastUpdated = this._now();
    this._states.set(this._clientID, newState);

    this._emit("update", { added: [], updated: [this._clientID], removed: [] }, "local");
    if (!shallowEqual(prev, newState)) {
      this._emit("change", { added: [], updated: [this._clientID], removed: [] }, "local");
    }
  }

  getStates(): Map<number, object> {
    return this._states;
  }

  getMeta(): Map<number, PresenceMeta> {
    return this._meta;
  }

  removeStates(clients: number[], origin?: any): void {
    const removed: number[] = [];
    for (const clientID of clients) {
      if (this._states.has(clientID)) {
        this._states.delete(clientID);
        removed.push(clientID);
      }
    }
    if (removed.length > 0) {
      this._emit("update", { added: [], updated: [], removed }, origin);
      this._emit("change", { added: [], updated: [], removed }, origin);
    }
  }

  encodeUpdate(clients: number[]): Uint8Array {
    const encoder = new TextEncoder();
    const entries: { clientID: number; clock: number; state: object | null }[] = [];

    for (const clientID of clients) {
      const meta = this._meta.get(clientID);
      if (!meta) continue;
      const state = this._states.get(clientID) ?? null;
      entries.push({ clientID, clock: meta.clock, state });
    }

    const jsonParts: Uint8Array[] = [];
    let size = 4;
    for (let i = 0; i < entries.length; i++) {
      size += 4 + 4 + 1;
      if (entries[i].state !== null) {
        const json = encoder.encode(JSON.stringify(entries[i].state));
        jsonParts.push(json);
        size += 4 + json.length;
      } else {
        jsonParts.push(new Uint8Array(0));
      }
    }

    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let offset = 0;

    view.setUint32(offset, entries.length, true);
    offset += 4;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      view.setUint32(offset, e.clientID, true);
      offset += 4;
      view.setUint32(offset, e.clock, true);
      offset += 4;
      view.setUint8(offset, e.state !== null ? 1 : 0);
      offset += 1;
      if (e.state !== null) {
        const json = jsonParts[i];
        view.setUint32(offset, json.length, true);
        offset += 4;
        buf.set(json, offset);
        offset += json.length;
      }
    }

    return buf;
  }

  applyUpdate(update: Uint8Array, origin?: any): void {
    const decoder = new TextDecoder();
    const view = new DataView(update.buffer, update.byteOffset, update.byteLength);
    let offset = 0;

    const count = view.getUint32(offset, true);
    offset += 4;

    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];
    const changeAdded: number[] = [];
    const changeUpdated: number[] = [];
    const changeRemoved: number[] = [];

    for (let i = 0; i < count; i++) {
      const clientID = view.getUint32(offset, true);
      offset += 4;
      const clock = view.getUint32(offset, true);
      offset += 4;
      const hasState = view.getUint8(offset);
      offset += 1;
      let state: object | null = null;
      if (hasState) {
        const jsonLen = view.getUint32(offset, true);
        offset += 4;
        const jsonBytes = update.subarray(offset, offset + jsonLen);
        offset += jsonLen;
        state = JSON.parse(decoder.decode(jsonBytes));
      }

      const currMeta = this._meta.get(clientID);
      const currClock = currMeta ? currMeta.clock : 0;

      if (clock < currClock) {
        continue;
      }

      if (clock === currClock) {
        if (state === null) {
          if (clientID === this._clientID) {
            if (this._localState !== null) {
              const meta = this._meta.get(this._clientID)!;
              meta.clock = currClock + 1;
              meta.lastUpdated = this._now();
              this._states.set(this._clientID, this._localState);
              updated.push(this._clientID);
            }
          } else {
            if (this._states.has(clientID)) {
              this._states.delete(clientID);
              removed.push(clientID);
              changeRemoved.push(clientID);
              if (currMeta) {
                currMeta.lastUpdated = this._now();
              }
            }
          }
        } else {
          // 等时钟非空消息为重放，丢弃不生效不触发事件
        }
      } else {
        if (state === null) {
          if (clientID === this._clientID) {
            if (this._localState !== null) {
              const meta = this._meta.get(this._clientID)!;
              meta.clock = currClock + 1;
              meta.lastUpdated = this._now();
              this._states.set(this._clientID, this._localState);
              updated.push(this._clientID);
            } else {
              this._meta.set(clientID, { clock, lastUpdated: this._now() });
            }
          } else {
            if (this._states.has(clientID)) {
              this._states.delete(clientID);
              removed.push(clientID);
              changeRemoved.push(clientID);
            }
            this._meta.set(clientID, { clock, lastUpdated: this._now() });
          }
        } else {
          const prevState = this._states.get(clientID);
          this._states.set(clientID, state);
          if (currMeta) {
            currMeta.clock = clock;
            currMeta.lastUpdated = this._now();
          } else {
            this._meta.set(clientID, { clock, lastUpdated: this._now() });
          }
          if (prevState === undefined) {
            added.push(clientID);
            changeAdded.push(clientID);
          } else {
            updated.push(clientID);
            if (!shallowEqual(prevState, state)) {
              changeUpdated.push(clientID);
            }
          }
        }
      }
    }

    if (added.length || updated.length || removed.length) {
      this._emit("update", { added, updated, removed }, origin);
    }
    if (changeAdded.length || changeUpdated.length || changeRemoved.length) {
      this._emit(
        "change",
        { added: changeAdded, updated: changeUpdated, removed: changeRemoved },
        origin
      );
    }
  }

  checkTimeout(): void {
    const now = this._now();
    const updated: number[] = [];
    const removed: number[] = [];
    const changeRemoved: number[] = [];

    if (this._localState !== null) {
      const localMeta = this._meta.get(this._clientID);
      if (localMeta && now - localMeta.lastUpdated > OUTDATED_TIMEOUT / 2) {
        localMeta.clock += 1;
        localMeta.lastUpdated = now;
        updated.push(this._clientID);
      }
    }

    for (const [clientID, meta] of this._meta) {
      if (clientID === this._clientID) continue;
      if (now - meta.lastUpdated > OUTDATED_TIMEOUT) {
        this._states.delete(clientID);
        this._meta.delete(clientID);
        removed.push(clientID);
        changeRemoved.push(clientID);
      }
    }

    if (updated.length || removed.length) {
      this._emit("update", { added: [], updated, removed }, "timeout");
    }
    if (changeRemoved.length > 0) {
      this._emit("change", { added: [], updated: [], removed: changeRemoved }, "timeout");
    }
  }

  on(event: EventName, cb: EventHandler): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb);
  }

  private _emit(event: EventName, payload: PresenceChangePayload, origin?: any): void {
    const set = this._listeners.get(event);
    if (set) {
      for (const cb of set) {
        cb(payload, origin);
      }
    }
  }

  destroy(): void {
    this._listeners.clear();
  }
}
