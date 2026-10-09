// PresenceStore：分布式协作在线状态存储（presence/awareness 协议核心）
//
// 协议要点（参考 yjs/y-protocols awareness，做了健壮化调整）：
//
//   setLocalState(state)
//        -> clock = (meta.clock ?? 0) + 1   首次写入即 1
//        -> null  : states.delete + removed
//        -> 非null : states.set + added/updated
//
//   applyUpdate(update, origin)
//        -> 读 (clientID, clock, state)
//        -> 接受条件: currClock < clock
//                    || (currClock === clock && state === null && states.has)
//        -> state === null:
//               本地且仍在线: clock = currClock + 1（反制恶意删除，广播仍在线）
//               否则        : states.delete
//        -> 事件: change 仅实质变化；update 照常
//
//   checkTimeout()
//        -> 本地 lastUpdated 过半程(15s) : setLocalState(localState) 自续期
//        -> 远端 lastUpdated 超全程(30s) : removeStates(origin="timeout")

export type PresenceState = Record<string, any> | null;

export interface PresenceMeta {
  clock: number;
  lastUpdated: number;
}

export interface PresenceChange {
  added: number[];
  updated: number[];
  removed: number[];
}

export type PresenceOrigin = any;

type Listener = (...args: any[]) => void;

// 远端状态超过该毫秒数未更新则视为离线
export const OUTDATED_TIMEOUT = 30000;

// 简易事件发射器（update / change / destroy）
class Emitter {
  private listeners: Map<string, Listener[]> = new Map();

  on(event: string, cb: Listener): void {
    const list = this.listeners.get(event);
    if (list) list.push(cb);
    else this.listeners.set(event, [cb]);
  }

  off(event: string, cb: Listener): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const i = list.indexOf(cb);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) this.listeners.delete(event);
  }

  emit(event: string, ...args: any[]): void {
    const list = this.listeners.get(event);
    if (!list) return;
    // 快照以避免 emit 过程中 off 导致跳项
    const snap = list.slice();
    for (let i = 0; i < snap.length; i++) snap[i](...args);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

// 深度相等比较（用于判断状态是否实质变化）
function equalDeep(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equalDeep(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const k = ak[i];
    if (!equalDeep(a[k], b[k])) return false;
  }
  return true;
}

// LEB128 无符号变长整数写入
function writeVarUint(arr: number[], num: number): void {
  if (num < 0 || !Number.isSafeInteger(num)) {
    throw new Error("writeVarUint: invalid number " + String(num));
  }
  do {
    let byte = num & 0x7f;
    num = Math.floor(num / 128);
    if (num > 0) byte |= 0x80;
    arr.push(byte);
  } while (num > 0);
}

interface Cursor {
  pos: number;
}

// LEB128 无符号变长整数读取
function readVarUint(data: Uint8Array, cur: Cursor): number {
  let num = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = data[cur.pos++];
    num |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return num >>> 0;
}

// 长度前缀 UTF-8 字符串编解码
const te = new TextEncoder();
const td = new TextDecoder();

function writeVarString(arr: number[], str: string): void {
  const bytes = te.encode(str);
  writeVarUint(arr, bytes.length);
  for (let i = 0; i < bytes.length; i++) arr.push(bytes[i]);
}

function readVarString(data: Uint8Array, cur: Cursor): string {
  const len = readVarUint(data, cur);
  const slice = data.subarray(cur.pos, cur.pos + len);
  cur.pos += len;
  return td.decode(slice);
}

export interface PresenceStoreOptions {
  now?: () => number;
}

export class PresenceStore extends Emitter {
  static readonly OUTDATED_TIMEOUT = OUTDATED_TIMEOUT;

  readonly clientID: number;

  // clientID -> 状态（仅存非 null）
  states: Map<number, Record<string, any>> = new Map();
  // clientID -> { clock, lastUpdated }
  meta: Map<number, PresenceMeta> = new Map();

  private readonly _now: () => number;
  private _destroyed = false;

  constructor(clientID: number, opts?: PresenceStoreOptions) {
    super();
    this.clientID = clientID;
    this._now = opts?.now ?? Date.now;
  }

  getLocalState(): Record<string, any> | null {
    return this.states.get(this.clientID) ?? null;
  }

  setLocalState(state: Record<string, any> | null): void {
    const clientID = this.clientID;
    const currMeta = this.meta.get(clientID);
    // 首次写入 clock=1；之后每次 +1
    const clock = (currMeta?.clock ?? 0) + 1;
    const prevState = this.states.get(clientID) ?? null;

    if (state === null) {
      this.states.delete(clientID);
    } else {
      this.states.set(clientID, state);
    }
    this.meta.set(clientID, { clock, lastUpdated: this._now() });

    const added: number[] = [];
    const updated: number[] = [];
    const filteredUpdated: number[] = [];
    const removed: number[] = [];

    if (state === null) {
      removed.push(clientID);
    } else if (prevState == null) {
      added.push(clientID);
    } else {
      updated.push(clientID);
      if (!equalDeep(prevState, state)) {
        filteredUpdated.push(clientID);
      }
    }

    // change 仅在有实质变化时触发
    if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
      this.emit("change", { added, updated: filteredUpdated, removed }, "local");
    }
    // update 照常触发
    this.emit("update", { added, updated, removed }, "local");
  }

  setLocalStateField(field: string, value: any): void {
    const state = this.getLocalState();
    if (state !== null) {
      const next: Record<string, any> = { ...state };
      next[field] = value;
      this.setLocalState(next);
    }
  }

  getStates(): Map<number, Record<string, any>> {
    return this.states;
  }

  getMeta(): Map<number, PresenceMeta> {
    return this.meta;
  }

  removeStates(clients: number[], origin?: PresenceOrigin): void {
    const removed: number[] = [];
    for (let i = 0; i < clients.length; i++) {
      const clientID = clients[i];
      if (this.states.has(clientID)) {
        this.states.delete(clientID);
        // 本地被声明离线时，clock +1 以便广播"我仍在线/已更新"
        if (clientID === this.clientID) {
          const curMeta = this.meta.get(clientID)!;
          this.meta.set(clientID, {
            clock: curMeta.clock + 1,
            lastUpdated: this._now(),
          });
        }
        removed.push(clientID);
      }
    }
    if (removed.length > 0) {
      this.emit("change", { added: [], updated: [], removed }, origin);
      this.emit("update", { added: [], updated: [], removed }, origin);
    }
  }

  encodeUpdate(clients: number[]): Uint8Array {
    const len = clients.length;
    const arr: number[] = [];
    writeVarUint(arr, len);
    for (let i = 0; i < len; i++) {
      const clientID = clients[i];
      const state = this.states.get(clientID) ?? null;
      const clock = this.meta.get(clientID)?.clock ?? 0;
      writeVarUint(arr, clientID);
      writeVarUint(arr, clock);
      writeVarString(arr, JSON.stringify(state));
    }
    return new Uint8Array(arr);
  }

  applyUpdate(update: Uint8Array, origin?: PresenceOrigin): void {
    const cur: Cursor = { pos: 0 };
    const timestamp = this._now();
    const added: number[] = [];
    const updated: number[] = [];
    const filteredUpdated: number[] = [];
    const removed: number[] = [];

    const len = readVarUint(update, cur);
    for (let i = 0; i < len; i++) {
      const clientID = readVarUint(update, cur);
      let clock = readVarUint(update, cur);
      const stateStr = readVarString(update, cur);
      const state = JSON.parse(stateStr);

      const clientMeta = this.meta.get(clientID);
      const prevState = this.states.get(clientID) ?? null;
      const currClock = clientMeta === undefined ? 0 : clientMeta.clock;

      // 接受条件：新 clock 严格更大；
      // 或 clock 相等且这是对该客户端的离线声明（null）且当前在线
      const accept =
        currClock < clock ||
        (currClock === clock && state === null && this.states.has(clientID));

      if (!accept) {
        // 旧消息/乱序/迟到消息：直接丢弃，不生效、无事件
        continue;
      }

      if (state === null) {
        // 永不允许远端删除本地有效状态
        if (clientID === this.clientID && this.getLocalState() != null) {
          // 反制：以 currClock + 1 重声明在线（最小但充分的递增）
          clock = currClock + 1;
        } else {
          this.states.delete(clientID);
        }
      } else {
        this.states.set(clientID, state);
      }

      this.meta.set(clientID, { clock, lastUpdated: timestamp });

      if (clientMeta === undefined && state !== null) {
        added.push(clientID);
      } else if (clientMeta !== undefined && state === null) {
        removed.push(clientID);
      } else if (state !== null) {
        updated.push(clientID);
        if (!equalDeep(state, prevState)) {
          filteredUpdated.push(clientID);
        }
      }
    }

    if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
      this.emit("change", { added, updated: filteredUpdated, removed }, origin);
    }
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.emit("update", { added, updated, removed }, origin);
    }
  }

  checkTimeout(): void {
    const now = this._now();

    // 本地保活：超过半程未续期则重广播本地状态（clock+1、lastUpdated 刷新）
    const localState = this.getLocalState();
    if (localState !== null) {
      const localMeta = this.meta.get(this.clientID);
      if (localMeta !== undefined && OUTDATED_TIMEOUT / 2 <= now - localMeta.lastUpdated) {
        this.setLocalState(localState);
      }
    }

    // 远端过期删除
    const remove: number[] = [];
    this.meta.forEach((meta, clientID) => {
      if (
        clientID !== this.clientID &&
        OUTDATED_TIMEOUT <= now - meta.lastUpdated &&
        this.states.has(clientID)
      ) {
        remove.push(clientID);
      }
    });
    if (remove.length > 0) {
      this.removeStates(remove, "timeout");
    }
  }

  destroy(): void {
    this.emit("destroy", this);
    this.setLocalState(null);
    this.removeAllListeners();
    this._destroyed = true;
  }
}
