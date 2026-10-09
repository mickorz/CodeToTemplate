/**
 * PresenceStore 协作在线状态存储
 *
 * 协议核心流程:
 *
 * PresenceStore 构造
 *   ├─> 初始化 states/meta Map 与事件监听
 *   ├─> setLocalState({})  初始化本地空状态 (clock=0)
 *   └─> 无定时器, 由外部调 checkTimeout
 *
 * setLocalState(state | null)
 *   ├─> clock = prevClock + 1 (首次 0)
 *   ├─> states.set/delete(clientID)
 *   ├─> meta.set(clientID, {clock, lastUpdated})
 *   ├─> 深比较判断实质变化
 *   ├─> emit 'change' (仅实质变化)
 *   └─> emit 'update' (始终)
 *
 * applyUpdate(update, origin)
 *   ├─> 解码每条 (clientID, clock, state)
 *   ├─> clock 冲突解决: currClock < clock || (==且null且存在)
 *   ├─> 远端 null 删本地有效状态 -> clock++ 反制
 *   ├─> 分类 added/updated/removed
 *   └─> emit 'change' + 'update'
 *
 * checkTimeout()
 *   ├─> 本地 lastUpdated > TIMEOUT/2 -> 续期 (clock++)
 *   └─> 远端 lastUpdated > TIMEOUT -> 删除 (origin=timeout)
 */

export const OUTDATED_TIMEOUT = 30000;

type EventHandler = (
  payload: { added: number[]; updated: number[]; removed: number[] },
  origin?: any
) => void;

interface Meta {
  clock: number;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// varuint 编解码 (LEB128 无符号变长整数)
// ---------------------------------------------------------------------------

function writeVarUint(buf: number[], num: number): void {
  while (num >= 0x80) {
    buf.push((num & 0x7f) | 0x80);
    num >>>= 7;
  }
  buf.push(num & 0xff);
}

function readVarUint(bytes: Uint8Array, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = bytes[pos.i++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result >>> 0;
}

// ---------------------------------------------------------------------------
// varstring 编解码 (长度前缀 + UTF-8)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeVarString(buf: number[], str: string): void {
  const encoded = textEncoder.encode(str);
  writeVarUint(buf, encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    buf.push(encoded[i]);
  }
}

function readVarString(bytes: Uint8Array, pos: { i: number }): string {
  const len = readVarUint(bytes, pos);
  const slice = bytes.subarray(pos.i, pos.i + len);
  pos.i += len;
  return textDecoder.decode(slice);
}

// ---------------------------------------------------------------------------
// 深比较 (用于 change vs update 事件区分)
// ---------------------------------------------------------------------------

function equalityDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalityDeep(a[i], b[i])) return false;
    }
    return true;
  }

  if (Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!equalityDeep(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key]
    )) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// PresenceStore
// ---------------------------------------------------------------------------

export class PresenceStore {
  readonly clientID: number;
  private readonly states: Map<number, object>;
  private readonly meta: Map<number, Meta>;
  private readonly _now: () => number;
  private readonly listeners: Map<string, Set<EventHandler>>;
  private _destroyed: boolean;

  constructor(clientID: number, opts?: { now?: () => number }) {
    this.clientID = clientID;
    this.states = new Map();
    this.meta = new Map();
    this._now = opts?.now ?? Date.now;
    this.listeners = new Map();
    this._destroyed = false;
    this.setLocalState({});
  }

  // -----------------------------------------------------------------------
  // 本地状态
  // -----------------------------------------------------------------------

  getLocalState(): object | null {
    return this.states.get(this.clientID) ?? null;
  }

  setLocalState(state: object | null): void {
    const localMeta = this.meta.get(this.clientID);
    const clock = localMeta === undefined ? 0 : localMeta.clock + 1;
    const prevState = this.states.get(this.clientID) ?? null;

    if (state === null) {
      this.states.delete(this.clientID);
    } else {
      this.states.set(this.clientID, state);
    }
    this.meta.set(this.clientID, { clock, lastUpdated: this._now() });

    // update 事件: 始终在状态操作发生时触发
    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];
    if (state === null) {
      removed.push(this.clientID);
    } else if (prevState === null) {
      added.push(this.clientID);
    } else {
      updated.push(this.clientID);
    }

    // change 事件: 仅实质内容变化时触发
    const fAdded: number[] = [];
    const fUpdated: number[] = [];
    const fRemoved: number[] = [];
    if (state === null) {
      if (prevState !== null) fRemoved.push(this.clientID);
    } else if (prevState === null) {
      fAdded.push(this.clientID);
    } else if (!equalityDeep(prevState, state)) {
      fUpdated.push(this.clientID);
    }

    if (fAdded.length > 0 || fUpdated.length > 0 || fRemoved.length > 0) {
      this._emit('change', { added: fAdded, updated: fUpdated, removed: fRemoved }, undefined);
    }
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this._emit('update', { added, updated, removed }, undefined);
    }
  }

  setLocalStateField(field: string, value: unknown): void {
    const state = this.getLocalState();
    if (state !== null) {
      this.setLocalState({ ...state, [field]: value });
    }
  }

  // -----------------------------------------------------------------------
  // 查询
  // -----------------------------------------------------------------------

  getStates(): Map<number, object> {
    return this.states;
  }

  getMeta(): Map<number, { clock: number; lastUpdated: number }> {
    return this.meta;
  }

  // -----------------------------------------------------------------------
  // 删除状态
  // -----------------------------------------------------------------------

  removeStates(clients: number[], origin?: any): void {
    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];

    for (const cid of clients) {
      if (this.states.has(cid)) {
        this.states.delete(cid);
        removed.push(cid);
      }
      if (cid === this.clientID) {
        // 本地客户端被删除: 递增 clock 而非删除 meta (广播仍在线)
        const m = this.meta.get(this.clientID);
        if (m) {
          this.meta.set(this.clientID, { clock: m.clock + 1, lastUpdated: m.lastUpdated });
        }
      }
    }

    if (removed.length > 0) {
      this._emit('change', { added, updated, removed }, origin);
      this._emit('update', { added, updated, removed }, origin);
    }
  }

  // -----------------------------------------------------------------------
  // 编解码
  // -----------------------------------------------------------------------

  encodeUpdate(clients: number[]): Uint8Array {
    const buf: number[] = [];
    writeVarUint(buf, clients.length);
    for (const cid of clients) {
      const state = this.states.get(cid);
      const m = this.meta.get(cid);
      writeVarUint(buf, cid);
      writeVarUint(buf, m?.clock ?? 0);
      // undefined (已离线/null) -> 空串; null -> "null"; 对象 -> JSON
      writeVarString(buf, state === undefined ? '' : JSON.stringify(state));
    }
    return new Uint8Array(buf);
  }

  applyUpdate(update: Uint8Array, origin?: any): void {
    const pos = { i: 0 };
    const numStates = readVarUint(update, pos);

    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];
    const fAdded: number[] = [];
    const fUpdated: number[] = [];
    const fRemoved: number[] = [];

    for (let i = 0; i < numStates; i++) {
      const cid = readVarUint(update, pos);
      const clock = readVarUint(update, pos);
      const stateStr = readVarString(update, pos);
      const state: object | null = stateStr === '' ? null : JSON.parse(stateStr);

      const currMeta = this.meta.get(cid);
      const currClock = currMeta?.clock ?? 0;

      // clock 冲突解决:
      // 接受条件 — currClock < clock (新消息)
      //   或 currClock === clock && state === null && 已存在 (等 clock 的离线声明)
      if (
        currClock < clock ||
        (currClock === clock && state === null && this.states.has(cid))
      ) {
        // 反制: 远端尝试用 null 删除本地有效状态
        if (cid === this.clientID && state === null && this.getLocalState() != null) {
          const m = this.meta.get(this.clientID);
          if (m) {
            this.meta.set(this.clientID, {
              clock: m.clock + 1,
              lastUpdated: m.lastUpdated,
            });
          }
          continue; // 不删除本地, 以 clock+1 广播仍在线
        }

        const prevState = this.states.get(cid) ?? null;

        if (state === null) {
          this.states.delete(cid);
          removed.push(cid);
          if (prevState !== null) fRemoved.push(cid);
        } else {
          this.states.set(cid, state);
          if (prevState === null) {
            added.push(cid);
            fAdded.push(cid);
          } else {
            updated.push(cid);
            if (!equalityDeep(prevState, state)) fUpdated.push(cid);
          }
        }

        this.meta.set(cid, { clock, lastUpdated: this._now() });
      }
    }

    if (fAdded.length > 0 || fUpdated.length > 0 || fRemoved.length > 0) {
      this._emit('change', { added: fAdded, updated: fUpdated, removed: fRemoved }, origin);
    }
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this._emit('update', { added, updated, removed }, origin);
    }
  }

  // -----------------------------------------------------------------------
  // 超时检查
  // -----------------------------------------------------------------------

  checkTimeout(): void {
    const now = this._now();

    // 本地保活: 超过半程未更新 -> 续期 (clock++, lastUpdated 刷新)
    const localMeta = this.meta.get(this.clientID);
    if (localMeta && this.getLocalState() != null) {
      if (now - localMeta.lastUpdated > OUTDATED_TIMEOUT / 2) {
        this.meta.set(this.clientID, {
          clock: localMeta.clock + 1,
          lastUpdated: now,
        });
      }
    }

    // 远端过期: 超过 OUTDATED_TIMEOUT 未更新 -> 删除
    const expired: number[] = [];
    for (const [cid, m] of this.meta) {
      if (cid !== this.clientID && now - m.lastUpdated > OUTDATED_TIMEOUT) {
        expired.push(cid);
      }
    }
    if (expired.length > 0) {
      this.removeStates(expired, 'timeout');
    }
  }

  // -----------------------------------------------------------------------
  // 事件
  // -----------------------------------------------------------------------

  on(event: 'update' | 'change', handler: EventHandler): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  off(event: 'update' | 'change', handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private _emit(
    event: string,
    payload: { added: number[]; updated: number[]; removed: number[] },
    origin?: any
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const handler of set) {
        handler(payload, origin);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 生命周期
  // -----------------------------------------------------------------------

  destroy(): void {
    this.setLocalState(null);
    this.listeners.clear();
    this._destroyed = true;
  }
}
