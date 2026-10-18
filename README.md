# dsh-queue-withdraw

简体中文 | [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 客户端插件：给输入区
排队中的消息增加 **撤回到输入栏** 操作，而不是只能编辑、删除或插话。

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.2-4D6BFE)
![Version](https://img.shields.io/badge/version-1.2.1-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)
![Checks](https://img.shields.io/badge/checks-19-brightgreen)

## 为什么

DSH 的排队消息行提供编辑、删除和插话三个动作。如果只是想先拿回来改一改，删除会丢失内容，
编辑又不如直接放回输入框自然。

`dsh-queue-withdraw` 在每个排队消息行的**左侧**追加一个撤回按钮（避免与右侧的编辑/删除/插话按钮误触）：

- 点击后把队列里的文本放回输入框
- 通过 `Session.updateQueue(itemId, { kind: 'remove' })` 从队列移除
- 如果输入框已有草稿，会把消息追加到草稿末尾，而不是覆盖
- 移除失败会把草稿恢复到操作前，消息仍在队列里
- **图片附件可撤回**：优先使用临时缓存，缓存不存在时通过 Session 读取图片字节重建
- **文件附件可撤回**：在用户选择文件、Host 上传之前，把浏览器 `File` 临时缓存到 IndexedDB；
  撤回时重新注册为草稿文件附件，让 DSH 自己重新上传

## 文件附件临时缓存

文件内容只存在于浏览器选择文件的那一刻。队列项本身只有
`attachmentId + name + bytes`，所以插件在 `conversation.createDrafts()` 被调用时保存一份临时副本：

1. 用户选择文件，Host 调用草稿注册表；
2. 插件在同一个调用里把 `File` 写入 IndexedDB（当前页面同时保留内存副本）；
3. 消息发送后进入队列，缓存继续保留；
4. 撤回时按 `name + size` 找到缓存，通过 `createDrafts` + `addAttachments` 重新放回输入框；
5. 撤回成功、队列项被发送/删除，或缓存超过 24 小时后清理。

缓存只存在当前浏览器 profile 的 IndexedDB 中，不会上传到 Host，也不会离开本机。它解决的是
“文件在队列里只剩元数据”的问题，不改变 Host 的队列协议。

## 行为

- 只装饰 Host 的 `[data-queue-dock]` 行；本地 pending echo 行不处理
- 队列折叠时按钮随行一起隐藏；展开后自动出现
- 队列本身仍由 DSH 的 QueueDock 管理
- 子智能体会话不可操作队列时，插件也不注入按钮

点击撤回的流程：

1. 读取排队消息的文本块和附件块；
2. 优先从临时缓存取回图片/文件，图片没有缓存时回退到 `session.readAttachment()`；
3. 通过会话草稿附件注册表把附件重新加入草稿，再把文本追加到当前草稿；
4. 调用公开的 `session.updateQueue(itemId, { kind: 'remove' })`；
5. Host 接受后队列行消失，草稿已经能看到内容，因此成功时**不弹持久提示**；失败才恢复原草稿并提示。

## 安装

### Plugin Manager（推荐）

在启用 Creator 预设的会话中执行：

```text
plugin_manager(action="install_bundle", target="<本目录的绝对路径>")
```

`target` 必须是绝对路径；如果当前 profile 之前已经装过同名插件，会返回
`already-installed`，先 `remove_bundle` 再安装即可。

### 手工安装（开发用）

1. 让包能从 profile 目录解析到：

   ```powershell
   $profile = "$env:USERPROFILE\.dsh\profiles\desktop"
   New-Item -ItemType Directory -Force -Path "$profile\node_modules" | Out-Null
   New-Item -ItemType Junction -Path "$profile\node_modules\dsh-queue-withdraw" `
            -Target "<本目录的绝对路径>"
   ```

2. 在 profile 的 `package.json` 中加入 `link:` 依赖，并把包名追加到
   `dsh.profile.bundles`。只改依赖不会触发重组，必须让有序 bundle 列表发生变化。

### 环境要求

- DeepSeek Harness `0.2.1-rc.2`（Web 或 Desktop Web 界面）
- 无需构建、零运行时依赖

## 实现

插件注册在 `conversation.input.dock` 槽位，使用 `useProjection('inbox')` 读取 `next-turn` 队列，
并通过标准 Session 动作完成撤回：

1. 用 MutationObserver 跟踪 `[data-queue-dock]` 的渲染，在每个 Host 队列行的行首追加一个紧凑按钮；
2. 在会话注入阶段装饰 `conversation.createDrafts`，缓存浏览器 `File`；
3. 按钮支持文本、图片和文件附件；文件缓存缺失时不修改队列，并提示需要重新选择文件；
4. 点击时先把附件和文本写入当前草稿，再调用 `updateQueue(remove)`；
5. 队列项离开队列时清理对应缓存；失败时恢复草稿并给出错误提示。

不新增远端接口，不改变 QueueDock 自己的编辑/删除/插话逻辑。

## 已知限制

- **只覆盖本插件加载后选择的文件**：安装前已进入队列的文件没有缓存，撤回会提示本地缓存缺失
- 浏览器清空站点数据、使用隐私模式、IndexedDB 写入失败或缓存超过 24 小时时，文件可能无法恢复
- 缓存按 `name + size` 匹配；同名同大小的多个文件可能匹配到最近一次缓存
- 队列消息长时间保留在队列中时，超过 24 小时的缓存可能在清理时被删除
- 图片撤回依赖会话的草稿附件注册表（`createDrafts` / `addAttachments`），DSH 升级后可能需要适配
- 队列必须在当前会话视图中渲染；折叠时展开队列后才能看到按钮
- 不处理子智能体不可变的队列
- 撤回的是文本；如果草稿已有内容，会追加到末尾
- DSH 客户端 API 仍是 pre-stable，DOM/属性契约随 DSH 升级可能需要适配

## 开发与测试

```sh
node scripts/check.mjs
```

零依赖测试覆盖清单、bundle patch、locale、队列文本提取、撤回成功/失败、草稿恢复、图片附件回填、
文件临时缓存回填、缓存清理、Host 队列行按钮注入和主题样式等 19 项检查。

## 许可证

[MIT](LICENSE)
