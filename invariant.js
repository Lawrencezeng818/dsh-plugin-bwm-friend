/**
 * Package-owned invariant companion for `dsh-plugin-bwm-friend`（Publish Preparation）
 * @module dsh-plugin-bwm-friend/invariant
 *
 * 遵循 DSH 规范 "Every package owns ./invariant"：注册 manifest 名 + 运行时关系断言。
 * 不变量（真实关系）：host 激活（webServer 注入）时 /bwm-friend/* 路由必须可访问
 * ——由 tests/host-endpoints.test.cjs（15 项：CSRF/Range/穿越/DoS）在运行时证明。
 * 本 install 为空实现（路由关系经 host 测试证明，见 invariant reason）。
 *
 * ⚠️ invariants 是**可选 service**：宿主未加载 dsh-invariants 时不得阻塞插件启动
 * （实测：inject 声明必需 → boot 永远 pending）。按 DSH 规范用 ctx.get() 读取。
 */

const PACKAGE_NAME = 'dsh-plugin-bwm-friend';

/** Cordis companion 插件名。 */
export const name = 'bwm-friend-invariant';
/** 不声明必需注入（invariants 可选——宿主可能未加载 dsh-invariants）。 */
export const inject = [];

/**
 * No runtime invariant（明确原因）：本包的契约是 HTTP 路由/媒体流/嵌入渲染——
 * 由 host 端点测试（tests/host-endpoints.test.cjs）与 E2E（tests/e2e-smoke.cjs）证明；
 * 进程内事件/数据关系由 @laikaton/bwm-runtime-core 的 runtime-contract 测试拥有。
 */
const install = () => {};

/**
 * 注册本包 invariant companion（可选 service：无 invariants 时安全空操作）。
 * @param ctx - Cordis context（ctx.get 读全局 service store）
 * @returns 注册的 disposer；invariants service 缺失时返回空 disposer（不阻断插件）
 */
export const apply = (ctx) => {
  try {
    const reg = ctx.get('invariants'); // optional service（非 inject 声明）
    if (!reg || typeof reg.register !== 'function') return () => {};
    return Promise.resolve(reg.register(PACKAGE_NAME, install));
  } catch {
    return Promise.resolve(() => {});
  }
};
