# docs 出包分类清单（机器生成 · 勿手改）

> 生成命令：`node scripts/classify-docs-release.mjs`
> 判据见 scripts/classify-docs-release.mjs 件首；词表单一来源 scripts/patent-wordlist.mjs。
> 出包机制：files 显式入包枚举（docs/ 不做目录级白名单）。
> 本清单位于 scripts/（不在 files 白名单）→ 不入包。

| 处置 | 文件 | 判定依据 |
|---|---|---|
| ✅ 入包 | docs/BWM-ARCHITECTURE-BOUNDARY.md | —（产品/协议/规格类，随包） |
| ✅ 入包 | docs/BWM-FRIEND-PRODUCT-SPEC-v1.0.md | —（产品/协议/规格类，随包） |
| ✅ 入包 | docs/BWM-PROTOCOL-v1.md | —（产品/协议/规格类，随包） |
| ✅ 入包 | docs/BWM-SDK-CONTRACT-v0.1.md | —（产品/协议/规格类，随包） |
| ✅ 入包 | docs/BWM-SETTINGS-SCHEMA-v1.md | —（产品/协议/规格类，随包） |
| ⛔ 出包 | docs/EMBEDDED-AUTOSCROLL-FIX-2026-08-26.md | 判据二（内部运维） |
| ⛔ 出包 | docs/HANDOVER-2026-09-03-v0.4.0-release.md | 判据二（交接类） |
| ⛔ 出包 | docs/HANDOVER-2026-09-26-3080-072-sync.md | 判据二（交接类） |
| ⛔ 出包 | docs/RELEASE-HARDENING-2026-09-26.md | 判据二（内部运维） |
| ⛔ 出包 | docs/REVIEW-PROMPT-v0.4.0.md | 判据二（评审口径） |
| ⛔ 出包 | docs/THREAT-MODEL-v1.md | 判据二（威胁模型） |
| ✅ 入包 | docs/screenshots/companion-page-1600x1000-v0.5.0.png | —（产品/协议/规格类，随包） |
| ⛔ 出包 | docs/发布政策_随包内容禁专利字样_v1.0.md | 判据二（内部治理）；判据一（词表 8 处: 行 1,9,11,15,19,25,26,35） |
| ⛔ 出包 | docs/取证报告_2026-11-01_P0_专利核心下沉前置取证_v1.0.md | 判据一（词表 39 处: 行 1,4,18,20,111,117,139,157,170,172） |
| ⛔ 出包 | docs/方案_2026-10-31_专利核心下沉与授权下发_v1.0.md | 判据一（词表 19 处: 行 1,7,8,14,15,35,37,39,42,43） |
| ⛔ 出包 | docs/诊断报告_npm发布包闭源边界_2026-10-14.md | 判据一（词表 2 处: 行 6,132） |

汇总：docs 全量 16 个文件 · 出包 10 · 入包 6

✅ files 显式枚举与两判据分类双向一致（出包不覆盖 · 入包全覆盖）
