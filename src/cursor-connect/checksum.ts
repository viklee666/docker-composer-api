/**
 * `x-cursor-checksum` 的构造。算法照抄客户端（计划文档 §1.5 的逐字取证：
 * Cursor 桌面端 `workbench.desktop.main.js:AJg` 与 Grok Bot `electron-main/main.cjs:nw` 一致）。
 * 这里只做「按客户端的方式给自己的机器标识签名」，不涉及任何权限判定。
 */

/**
 * 客户端的字节混淆链：`n[t] = (n[t] ^ e) + t % 256; e = n[t]`。
 *
 * 写回 Uint8Array 再读出来是为了与客户端逐字一致：`+` 的结果可能超过 255，
 * 客户端靠 TypedArray 截断。（实测这一步不影响最终结果——用普通数组时多出来的
 * 高位在后面每一轮 XOR 里都原样保留，最后编码成字节时又被掩掉；
 * 20 万个时间戳里 9018 个发生溢出，输出无一不同。照抄而不"简化"是为了不依赖这个巧合。）
 */
function obfuscate(bytes: Uint8Array): Uint8Array {
  let previous = 165;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (bytes[i] ^ previous) + (i % 256);
    previous = bytes[i];
  }
  return bytes;
}

/**
 * 时间戳前缀。
 *
 * 注意 `>> 40` / `>> 32`：JS 的位运算是 32 位的，移位数还会先对 32 取模，
 * 所以这两项实际等价于 `>> 8` 与 `>> 0`。客户端就是这么算的，
 * 网关必须原样复制这个行为，"修正"成 64 位移位会得到与客户端不同的 checksum。
 */
function timestampBytes(nowMs: number): Uint8Array {
  const t = Math.floor(nowMs / 1e6);
  return new Uint8Array([(t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255, (t >> 16) & 255, (t >> 8) & 255, t & 255]);
}

/**
 * base64url 且**不带 padding**（Node 的 `base64url` 本身就不补 `=`）。
 * 用标准 base64 表或补 padding 都与客户端不一致。
 */
export function cursorChecksum(machineId: string, macMachineId?: string, nowMs: number = Date.now()): string {
  const prefix = Buffer.from(obfuscate(timestampBytes(nowMs))).toString("base64url");
  // 客户端只在 macMachineId 存在时才拼 `/`；恒定拼接会得到一个上游没见过的设备标识。
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}
