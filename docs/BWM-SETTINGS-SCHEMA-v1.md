# BWM Settings Schema v1（冻结）

> 状态：**v1 冻结（2026-08-24）**——Additive-only：新增字段 = minor；修改/删除 = major
> 归属：`@laikaton/bwm-protocol/schema/settings.json`（JSON Schema draft-07）+ `schema/index.js`（DEFAULT_SETTINGS/validateSettings/normalizeSettings）
> 目的：**三端（桌面 App / DSH 插件 / 手机）设置字段统一**——防继续分裂，为云端同步铺路

## 一、结构

```jsonc
{
  "version": 1,                      // schema 版本（整数，const 1）
  "account": {                       // 账号（token 不落盘，不进入 schema）
    "subject": null,                 // 手机号/主体
    "loggedIn": false
  },
  "avatar": {                        // 数字人形象
    "theme": "甜心女孩",             // 主题/模板名
    "idle": null,                    // 待机视频（文件引用）
    "persona": "",                   // 人格设定（每主题）
    "driver": "video"                // 口型方案: video | image
  },
  "voice": {                         // 语音
    "voice": "冰糖",                 // 音色（MiMo 8 音色 + 克隆）
    "volume": 1                      // 音量 0-1
  },
  "llm": {                           // 语言模型
    "provider": "local",             // local | external
    "baseUrl": "",
    "model": "deepseek-chat"
  },
  "ui": {                            // 界面
    "mode": "work",                  // work | companion | meeting
    "type": "stage",                 // stage | panel
    "chatWidth": 720
  },
  "power": {                         // 电源/性能
    "pauseOnBlur": true,
    "pauseOnBattery": false
  }
}
```

## 二、三端映射

| Schema 字段 | 桌面 App（config.json / localStorage） | DSH 插件（config.json） | 手机（SharedPreferences / 云端） |
|---|---|---|---|
| version | ✅ 1 | ✅ 1（迁移） | ✅ 对应 |
| account | subject_credentials 登录态 | ✅ P0（内存会话，不落盘） | 后端 subject |
| avatar.theme | templateGrid 选中 | ✅ | 模板全局 |
| avatar.persona | personaInput 每模板 | ✅ P0 | 人格设定 |
| avatar.driver | avatarDriver select | 隐藏（固定 video） | —（走生成） |
| voice.voice | voiceSelect | ✅ | 音色+克隆 |
| llm.* | LLM 配置表单 | 隐藏（固定 DeepSeek） | 后端固定 |
| ui.mode/type/chatWidth | layout | ✅（旧 layout→ui 迁移） | 竖屏/横屏 |
| power.* | pauseOnBlur/Battery | ✅ | 设备策略 |

## 三、迁移（旧 config → v1）

`migrateConfig()`（lib/index.js）：
- 旧顶层 `mode` → `ui.mode`
- 旧 `layout: {type, chatWidth}` → `ui.type / ui.chatWidth`
- 缺失子对象补默认（normalize）

## 四、校验

```js
import { validateSettings, normalizeSettings, DEFAULT_SETTINGS } from '@laikaton/bwm-protocol';
validateSettings(cfg)   // → {valid, errors[]}（类型/枚举校验；未知字段忽略=向前兼容）
normalizeSettings(cfg)  // → 与默认合并补齐
```

## 五、纪律

- 新设置项必须先进 schema（三端同步）——禁止任一端私加字段
- token/密钥**永不进 schema**（account 只存 subject/loggedIn）
- 改枚举（mode/driver/provider）= major（破坏性），需评审
