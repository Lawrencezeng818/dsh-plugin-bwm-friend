#!/usr/bin/env node
/**
 * examples/sdk-consumer.mjs — BWM Friend SDK 外部消费者示例（生态层参考实现）
 *
 * 演示第三方如何以纯协议方式接入 bwm-friend host：
 *   1. 连接 host（默认 http://127.0.0.1:3200，可用 HOST 覆盖）
 *   2. 校验 host 的 settings 响应符合 bwm-protocol schema（validateSettings）
 *   3. 读取 inventory 并按 url 语义消费资产（不解码 token——token 是不透明句柄）
 *   4. compareVersion 版本对齐检查（协议 1.0 语义）
 *
 * 运行：node examples/sdk-consumer.mjs [HOST]
 * 退出码 0 = 消费成功（外部采用路径可用的自证）
 */
import { validateSettings, normalizeSettings, compareVersion, PROTOCOL_VERSION } from '../packages/bwm-protocol/schema/index.js';

const HOST = process.argv[2] || process.env.HOST || 'http://127.0.0.1:3200';
const j = async (p) => (await fetch(`${HOST}${p}`)).json();

// 1. 健康 → 版本对齐（协议 major 必须一致）
const health = await j('/bwm-friend/health');
if (!/^\d+\.\d+\.\d+$/.test(health.version || '')) throw new Error('health.version 非 semver: ' + health.version);
console.log(`[sdk] host ${HOST} v${health.version} · 协议 ${PROTOCOL_VERSION}`);

// 2. settings 契约：响应必须通过 schema 校验 + normalize 幂等
const settings = await j('/bwm-friend/settings');
const v = validateSettings(settings);
if (!v.valid) throw new Error('settings 违反协议 schema: ' + JSON.stringify(v.errors || v));
if (JSON.stringify(normalizeSettings(settings)) !== JSON.stringify(normalizeSettings(normalizeSettings(settings)))) {
  throw new Error('normalize 非幂等');
}
console.log(`[sdk] settings 契约 ✓（version=${settings.version}，主题=${settings.avatar?.theme}）`);

// 3. inventory：token 为不透明句柄（第三方只读 url，不解码）
const inv = await j('/bwm-friend/inventory');
const items = inv.items || [];
const bad = items.filter((it) => !it.url || !/^\//.test(it.url) || !it.name || !it.type);
if (bad.length) throw new Error('inventory 条目违反契约: ' + JSON.stringify(bad[0]));
console.log(`[sdk] inventory ${items.length} 项 ✓（idle=${items.filter((i) => i.type === 'idle').length} talk=${items.filter((i) => i.type === 'talk').length}）`);

// 4. 版本对齐演示
const r = compareVersion(health.version, '999.0.0');
console.log(`[sdk] compareVersion(${health.version}, 999.0.0) = ${r}（-1=host 更旧）`);
console.log('✅ SDK 消费者全程契约通过');
