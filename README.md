# Requesty Connector · SillyTavern 扩展

在 SillyTavern 里直接使用 [Requesty](https://requesty.ai) 的 LLM 路由 API，体验类似内置的 OpenRouter：

- **一键连接**：填好 API Key，点「使用 Requesty 连接」，自动切换到 Custom (OpenAI-compatible) 源，并填好地址、密钥和模型
- **模型浏览器**：列出 Requesty 的全部模型（含托管路由），显示上下文长度、输入/输出价格（美元/百万 token）、推理/识图/缓存/工具调用能力
- 搜索、按厂商/服务商筛选、按价格/上下文/上架时间排序、收藏置顶、隐藏 `@eu` 等区域变体
- 选择模型后**自动调整上下文长度和最大回复长度**，不超过模型上限
- **Requesty 专属请求选项**：推理强度 `reasoning_effort`、自动提示词缓存 `auto_cache`、请求标签 `tags`、按聊天记录的 `trace_id`
- 支持全球 / 欧盟 / 美国 / 亚太四个路由节点
- 支持手动输入任意模型 ID，例如路由策略 `policy/my-fallback`
- 斜杠命令：`/requesty-model <模型ID>`、`/requesty-connect`

> 需要带「多密钥管理」功能的较新版 SillyTavern。已在 1.19.0 (release) 上测试。

## 安装

### 方式一：通过 Git 地址安装（推荐）

1. 把本目录推送到一个 Git 仓库（例如 GitHub）
2. 在 SillyTavern 中打开 **扩展**（积木图标）→ **安装扩展**
3. 粘贴仓库地址，点击安装，然后刷新页面

### 方式二：手动安装

把整个文件夹复制到以下任一位置，然后重启 / 刷新 SillyTavern：

- 当前用户：`SillyTavern/data/<用户名>/extensions/requesty-tavern/`（默认用户名为 `default-user`）
- 所有用户：`SillyTavern/public/scripts/extensions/third-party/requesty-tavern/`

## 使用

1. 打开 **API 连接**（插头图标），API 类型选择 **Chat Completion**
2. 在「Chat Completion Source」下方会出现 **Requesty** 面板，展开它
3. 粘贴你的 Requesty API Key（在 [app.requesty.ai/api-keys](https://app.requesty.ai/api-keys) 获取），点击「保存」
4. 在模型列表里点选一个模型（星标可收藏）
5. 点击「使用 Requesty 连接」

之后在面板里点其他模型即可即时切换。连接状态会显示在面板标题右侧（已启用 / 未启用）。

### 关于密钥

密钥保存在 SillyTavern 自己的密钥库中（Custom 源下，标签为 `Requesty`），不会存放在扩展设置或浏览器里。如果你在 Custom 源里还有其他密钥，连接 Requesty 时会自动切换到这个 Requesty 密钥。

### 与连接配置（Connection Profiles）配合

连接后可以用 SillyTavern 自带的「连接配置」保存当前设置。只要配置里的地址是 Requesty（`router.*.requesty.ai`），扩展的请求选项就会自动生效。

## 请求选项说明

| 选项 | 作用 |
| --- | --- |
| 按模型调整上下文长度 | 推荐「仅在超过上限时下调」；「设为最大」会把上下文直接拉满，长对话会更贵 |
| 推理强度 | 发送 `reasoning_effort`。可选 none / low / medium / high / xhigh / max，或跟随酒馆预设里的「推理强度」 |
| 自动提示词缓存 | 发送 `requesty.auto_cache`。对 Claude 等模型的长对话能明显省钱 |
| 发送应用标识 | 附带 `X-Title: SillyTavern` 和 `HTTP-Referer` 请求头，方便在 Requesty 后台区分来源 |
| trace_id | 用当前聊天文件名作为 `requesty.trace_id`，后台可以按聊天聚合日志（文件名通常包含角色名） |
| tags | 发送 `requesty.tags`，用于后台统计分类 |

这些字段会与 Custom 源里你手写的「Include Body Parameters / Include Request Headers」合并，**你手写的同名字段优先**。只有当前地址是 Requesty 时才会添加，连接到其他 Custom 端点时不受影响。

## 工作原理

SillyTavern 的聊天补全源是写死在服务端的，纯前端扩展不能注册新的源。本扩展借用内置的 **Custom (OpenAI-compatible)** 源（Requesty 本身就是 OpenAI 兼容接口）：

- 模型列表：有密钥时通过 SillyTavern 服务端用你的密钥请求 `GET /v1/models`（只列出该密钥可用的模型）；否则直接读取 Requesty 公开的模型列表。另外合并 `GET /v1/models/managed` 中的托管路由
- 请求参数：监听 `CHAT_COMPLETION_SETTINGS_READY` 事件，在请求发出前往 Custom 源的 Include Body / Headers 中合并 Requesty 字段

## 文件

```
manifest.json   扩展清单
index.js        主逻辑
panel.html      面板界面
style.css       样式
```
