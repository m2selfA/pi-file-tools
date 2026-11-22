# pi-file-tools

为 Pi Coding Agent 提供 `mkdir`、`copy`、`rename`、`trash`、`backup`、`temp`。支持 Windows 和 Linux，不注册 `delete`。

参考 ryan-griffin/pi-file-tools 的工具行为，独立实现。来源和版本见 [PROVENANCE.md](PROVENANCE.md)。不启动额外服务，不依赖外部 MCP。

## 安装

从 GitHub 安装到 Pi：

```powershell
pi install git:github.com/m2selfA/pi-file-tools
```

随后在 Pi 中执行 `/reload`。

## 本地开发

开发环境 Node.js >=22.19，验证使用 Pi 1.6.0。

```powershell
git clone https://github.com/m2selfA/pi-file-tools.git
cd pi-file-tools
npm ci --ignore-scripts
pi -e ./src/index.ts
```

持久安装到 Pi（需要时执行）：

```powershell
pi install .
```

随后在 Pi 中 `/reload`。本地路径包不会由 Pi 自动安装其依赖，因此首次使用本地包应先运行 npm ci。宿主提供的包只声明为 peerDependencies，开发副本用于测试。加载前应避免同时启用其他注册同名 `copy / rename / mkdir / trash / backup / temp` 的扩展。

## 工具

所有六个工具只操作 Pi 控制器进程可访问的本地文件系统，路径按本地 Pi cwd 解析，不会通过 SSH 访问远端主机。SSH 激活时，远端文件由 `ssh_*` 工具处理；`temp` 和 `backup` 仍只处理控制器本地路径。

| 工具 | 行为 |
|---|---|
| `mkdir` | 创建空目录；默认递归创建父目录；已存在时返回 created:false |
| `copy` | 复制到精确目标路径；目录需 recursive:true；不自动创建父目录 |
| `rename` | 移动到精确目标路径；不自动创建父目录；拒绝跨卷移动 |
| `trash` | put 移入系统回收站；list 分页列出；restore 恢复；empty 永久清理回收站条目 |
| `backup` | 将文件或目录复制到 Pi agent 集中存储；SHA-256 校验；预览/执行清理；恢复和释放 |
| `temp` | 在 Pi agent 集中存储创建临时文件或目录；租约、固定保留、预览/执行清理和释放 |

路径支持绝对路径、相对当前 cwd 的路径及开头的 `@` 标记。Windows 支持正反斜杠、空格和中文；拒绝 ADS、设备路径、盘符相对路径、保留设备名以及结尾点/空格别名。

### 创建目录

```json
{"path":"work/中文目录","recursive":true}
```

### 复制与重命名

```json
{"source":"a.txt","destination":"backup/a.txt"}
```

```json
{"source":"src","destination":"backup/src","recursive":true}
```

`overwrite` 默认 false。显式设为 true 时，旧目标先移入 OS 回收站，结果中 `replacedItem.id` 可用于恢复。新目标提交失败时尝试恢复旧目标；恢复失败会保留条目并在错误中给出 ID。不能以文件替换目录，或反过来。

### 移入回收站

调用 `trash`：

```json
{"action":"put","path":"work/old.txt"}
```

非空目录需要显式授权递归：

```json
{"action":"put","path":"work/old-folder","recursive":true}
```

返回 `item.id`、`originalPath`、完整文件名、删除时间及类型。移入失败不会改用永久删除。文件系统根、用户主目录、当前工作目录以及包含它们的真实目录受保护。

### 列出与恢复

```json
{"action":"list","offset":0,"limit":100}
```

返回 total、items、nextOffset；limit 为 1..200。Windows 列出当前用户系统回收站中的所有条目，包含非本插件产生的条目。ID 为不透明标识，必须原样使用。

```json
{"action":"restore","id":"<put 或 list 返回的精确 ID>"}
```

```json
{"action":"restore","id":"<精确 ID>","destination":"recovered/old.txt"}
```

默认恢复到原路径；目标已存在时拒绝覆盖。父目录必须存在。Windows Shell 极窄并发碰撞会选择不覆盖的替代名字，实际路径通过 destination 返回。

### 清空

只永久清理指定条目：

```json
{"action":"empty","ids":["<精确 ID>"],"confirm":"EMPTY"}
```

清空枚举时快照中的整个回收站：

```json
{"action":"empty","all":true,"confirm":"EMPTY"}
```

**empty 不可恢复。** ids 与 all:true 二选一；不提供范围或确认字符串时拒绝。单次最多 256 项。全量范围超过上限时应分批指定 ID。返回 removed 和 failed，部分失败在 Pi 中明确标记为错误；不会伪装成全部成功。all:true 会影响用户原有条目，只有明确要清空整个系统回收站时才使用。

## 集中备份和临时文件

`backup` 和 `temp` 使用同一个受管存储根目录，默认位于 Pi agent 数据目录下的 `file-tools`。在 Pi agent 目录下的 `file-tools.json` 设置 `storageRoot` 可更改位置，支持绝对路径、`~`、`~/…` 和 `~\…`。环境变量 `PI_FILE_TOOLS_HOME` 优先于文件设置。存储根包含原子 `state.json`、用途和项目元数据、SHA-256 摘要，以及 `backup` 和 `temp` 两个类别目录。首次接管非空目录会拒绝，避免覆盖未知文件。

两个工具都支持 `create`、`list`、`inspect`、`restore`、`release`、`cleanup`、`policy`、`pin`、`touch`。`list` 支持可选 `scope`（`session` / `project` / `all`，默认 `all`）按当前 Pi 对话或本地项目过滤。`cleanup` 默认只返回计划，必须显式 `execute:true` 才会操作。临时项创建后有 15 分钟租约，`touch` 可续租；`pinned:true` 项不会自动释放。

### 链接目录与部分维护

从符号链接或 junction 工作目录运行是允许的。受管存储根、类别目录和每个条目的根仍禁止被链接重定向，插件保留项目逻辑路径，不修改进程的 cwd。

`temp` 内部的链接作为叶子登记，不遍历目标，也不把目标文件计入容量。链接自身的元数据字节会计入条目。目录内的断链和循环链接不会触发目标递归。`backup` 继续严格拒绝源树中的链接和特殊条目。

临时项恢复会重建链接而非物化目标内容。Windows 使用只读 reparse 信息区分 junction、文件符号链接与目录符号链接，保留其类型和原始目标字符串；权限不足或不支持的类型会明确失败，不降级为普通文件或目录。相对目标原样保留，因此它相对于新的恢复位置解析；不会被悄悄改成绝对目标。

扫描异常记录在 `inspectionError`，不将条目改成全局未决的变更状态。`lastVerifiedAt` 和 `linkCount` 是最近一次成功检查的观测值。维护出现单项异常时返回部分完成及 `failed` 列表，跳过问题项并处理健康项。首次维护异常也不会阻止定时器注册。

`plan.usage.complete: false` 表示部分活跃项用量未验证；此时 `activeBytes` 仅为已知项的规划值，不是完整总量，条目原来的缓存字节不会被置零。相关类别的新分配会明确阻止；健康项的显式恢复、续租和释放不再扫描无关条目。配置/清单损坏或原生变更结果不确定仍会阻止危险操作。

原生恢复已确认到登记路径、但内容检查失败时，会保留中央副本并返回 `recoveredToManagedPath: true` 与受阻状态，不假称已导出到请求目标。原生恢复结果本身未确认时，仍保持未决保护，不能自动重试删除或覆盖。

### 预先提示（默认开启）

插件通过 `before_agent_start` 在每次 agent 运行开始前添加 `pi_file_tools` 提示段，提醒先用 `temp` 分配临时路径、在重要覆盖或迁移前用 `backup` 建立恢复点。不改写磁盘上的 `AGENTS.md`，也不会在每一轮自动创建临时项或备份。

顶层布尔项 `preflightPrompt` 默认为 `true`，旧配置省略它也会开启。要关闭，在现有设置中添加或修改 `"preflightPrompt": false`，保留其他字段。加载新版代码后，开关在下一次 agent 运行开始时读取，无需为开关变化再次重启。

关闭只移除新增的独立预先提示；工具仍可使用，原有工具说明和 `promptGuidelines` 保留。固定段名用于去重；已有强制提示或字符串事件使用带标记的追加块，保留其他前后文。插件只删除自己当前的完整提示块，不按宽泛标记删除用户文本。

独立段不依赖原生工具指南是否可见，也适用于自定义提示前缀。其他扩展若在之后全量替换提示，仍可能覆盖它。提示注入是行为引导，不是文件系统拦截；最终提供商请求与真实模型调用顺序需要另行验收。

### 设置文件

默认读取 `~/.pi/agent/file-tools.json`（自定义 `PI_CODING_AGENT_DIR` 时跟随 agent 目录）。随包提供 [file-tools.example.json](./file-tools.example.json)，可复制后编辑；不把用户配置放进数据目录。`PI_FILE_TOOLS_CONFIG` 可指定其他设置文件，路径同样支持 `~`。

```json
{
  "version": 1,
  "storageRoot": "~/.pi/agent/file-tools",
  "preflightPrompt": true,
  "policies": {
    "backup": {
      "ttlHours": "30d",
      "maxItems": 50,
      "maxBytes": "5G",
      "purgeAfterHours": "7d",
      "maxRecycledBytes": "1G"
    },
    "temp": {
      "ttlHours": "24h",
      "maxItems": 100,
      "maxBytes": "2G",
      "purgeAfterHours": "7d",
      "maxRecycledBytes": "1G"
    }
  }
}
```

- `ttlHours`：新建或 `touch` 时使用的默认 TTL，单位小时；不改写已有条目的 `expiresAt`，单项 `ttlHours` 参数仍可覆盖。
- `maxItems`：活跃条目数量上限，正整数，最大 65536（`"64k"`）；`"16k"` 等于 16384。
- `maxBytes`：活跃容量上限，单位字节，最大 1 PiB（`"1P"`）；例如 `"2G"` 或 `"1.5GiB"`。
- `purgeAfterHours`：移入回收站后的最短保留时间；和 TTL 一样接受 1–876000 小时，或 `"7d"`、`"100y"` 等时长。
- `maxRecycledBytes`：受管回收条目的容量预算，最大 1 PiB；接受 `"1G"` 等写法。超预算也不会提前缩短回收站保留期，必要时阻止继续分配。
- `lockWaitMs`（可选）：显式写操作等待存储锁的毫秒上限，整数 100–300000，默认 15000。
- `sweepCooldownMinutes`（可选）：多会话后台维护去重冷却分钟数，0–1440，默认 5；设为 0 关闭冷却。
- `autoReclaimStaleLocks`（可选）：默认 `true`；仅在同主机确认持锁进程已死且 `state.json` 无 `creating`/`recycling`/`purging` 未决状态时安全接管陈旧锁。

数量和容量的 `k/K`、`m/M`、`g/G`、`t/T`、`p/P` 均按 1024 的幂换算；容量也接受 KB、KiB、MB、MiB 等别名，**这里 KB/MB/GB 同样按二进制解释**。无后缀字符串与普通数字含义相同。含单位的值在 JSON 中必须加引号。数量和字节最终必须是精确整数：`"1.5G"` 合法，`"0.1k"` 不会被静默取整。

时长的无后缀值以小时计，支持 `h/d/w/y`（一年按 365 天）、`min`、`s`；最终仍需处于 1 小时至 100 年范围。时长不使用 `m/M` 缩写，请用 `min` 表示分钟。Pi 工具的 `policy` 和单项 `ttlHours` 也使用同一解析规则。保存策略时保留用户填写的单位写法，不把其他类别的可读字符串强制改成数字。

字段可以只填一部分：文件中显式字段优先于该存储已有的策略，其余保留原值；新存储缺失字段使用内置默认。未知字段、负值或无效 JSON 会报错并停止维护，不静默使用默认清理策略。

策略文件在每次工具调用或维护前读取；`policy` 的预览不会改文件，`execute:true` 会在锁内原子保存到设置文件，重新加载后仍有效。多个会话更新不同类别不会覆盖对方的设置。设置文件写入失败时会报错并保留原文件。

修改 `storageRoot` 后需要重新加载 Pi 扩展；不会自动迁移或删除旧目录。环境变量路径覆盖同样在扩展重新加载时生效。Pi 关闭期间没有额外服务代为维护。

默认策略如下。

| 类别 | 过期时间 | 活跃数量 | 活跃容量 | 回收站保留期 |
|---|---:|---:|---:|---:|
| `backup` | 30 天 | 50 | 5 GiB | 7 天 |
| `temp` | 24 小时 | 100 | 2 GiB | 7 天 |

超出数量或活跃容量时，最旧且未固定、未租约保护的项进入清理计划。执行清理先移入操作系统回收站，记录 `trashId`，经过 `purgeAfterHours` 后才允许 `cleanup` 永久清理本工具自己的条目。`physicalBytesFreed` 在永久清理前返回 `null`，不会把移入回收站误报成已释放磁盘空间。

备份从源文件或目录创建快照，拒绝符号链接、junction 和特殊文件，单个目录树最多 100000 个文件/目录条目，容量受策略限制。受管清单最多 262144 条记录、256 MiB；超出字节预算时会在替换原清单之前拒绝写入。上述是校验边界，不承诺在全部上限处的吞吐量或可用磁盘空间。创建和恢复都会校验摘要，源或快照在扫描过程中变化会失败并保留失败记录。恢复不会覆盖现有目标。

示例：

```json
{"action":"create","path":"src","purpose":"before migration"}
```

```json
{"action":"create","kind":"file","name":"scratch.json","content":"{}","purpose":"temporary model output"}
```

```json
{"action":"cleanup"}
```

```json
{"action":"cleanup","execute":true}
```

扩展在 `session_start` 异步触发一次非阻塞维护，并在会话期间每 15 分钟执行一次可取消的 sweep；`session_shutdown` 会中止运行中的维护、注销定时器并清理当前会话心跳。Pi 关闭期间不运行常驻服务。

### 多进程与多对话并发

- **无锁只读与轻量扫描**：`list`、`inspect` 和 `policy` 预览直接读取原子替换的 `state.json`；`temp` 定期扫描只统计元数据与链接，不计算文件内容 SHA-256（`restore` 导出时仍校验完整摘要）。
- **锁外暂存与单条目锁**：`backup create` 先在 `.staging/` 完成复制与摘要校验，再进短锁原子提交；`restore` 导出复制在短锁校验后移出全局锁，由 `.item-locks/` 防止并发回收同一条目。
- **多会话去重与心跳保护**：后台维护通过 `.maintenance.lock` 非阻塞抢占和 `lastSweep` 冷却避免多会话重复全扫；存活会话在 `sessions/` 维护心跳，保护其未过期 `temp` 项不被其他会话配额淘汰，会话退出或进程死亡后自动解除。
- **跨进程回收站互斥与失败隔离**：Windows 回收站后端使用跨进程互斥锁（加锁顺序固定为存储锁先于回收站锁）；历史 `failed` 快照保留现场并持续报告，不再阻塞其他会话的健康操作，只有 `creating`/`recycling`/`purging` 未决状态继续全局阻断。

## 平台实现与边界

### 控制器本地范围与 SSH

- `temp` 返回的路径始终是控制器本地路径；即使 SSH 激活，也不要把它交给 `ssh_write` 或 `ssh_edit` 当作远端路径。
- `backup` 不读取 SSH 远端目录。需要备份远端目录时，先用 `ssh_download` 下载到控制器，再对本地副本创建备份。
- `mkdir`、`copy`、`rename`、`trash` 同样只作用于控制器本地路径；远端删除或移动应使用 `ssh_bash`，其删除语义由远端命令决定，不经过本地回收站。
- 本机挂载的网络盘仍属于控制器可访问范围；具体后端限制不变，例如 Windows `trash` 拒绝 UNC 路径。
- 这是提示和文档边界，不是路径拦截器。若把远端路径字符串传给本地工具，而本地恰好存在同名路径，工具仍可能操作该本地路径。

- **Windows**：使用自带 Windows PowerShell 5.1，按需启动一个短命 STA 子进程，通过 IFileOperation 操作真实系统回收站。C# 源码随包分发，Add-Type 在内存中编译；无二进制下载、后台服务或提权。put 使用回收标志和删除前回调；不允许转为永久删除。恢复使用 System.FileName 而非可能隐藏扩展名的显示名。只接受本地盘符绝对路径进行回收，拒绝 UNC/网络路径。
- **Linux**：使用 Freedesktop home trash（$XDG_DATA_HOME/Trash，默认 ~/.local/share/Trash），要求当前用户所有权和私有目录权限，保存标准 .trashinfo。仅支持同文件系统；其他设备的 put 拒绝执行，不会复制后删除。move 使用 /usr/bin/mv 的 no-clobber 模式；需要 GNU coreutils。暂不枚举其他挂载点的 .Trash-*。
- **macOS**：当前不支持，明确报错。
- copy 保留链接而非递归跟随；Windows 目录链接按 junction 复制，文件 symlink 创建仍受系统权限限制；不承诺 ACL、所有扩展属性或特殊文件等价复制。
- 锁与 Pi 的 withFileMutationQueue 协调进程内文件变更。不是对外部不受信进程的文件系统沙箱；调用期间外部移动目录、替换挂载点仍可能使操作失败。
- 原生调用开始前检查取消；开始后等待 OS 操作结束以保留可靠结果。Helper 有 120 秒超时及 8 MiB 输出上限；超时/通信错误视为结果不确定，先读取源路径和回收站再重试。
- 不需要管理员权限；不修改 Defender 或执行策略。系统回收站不可用、容量不足、权限不足、脚本被策略阻止时返回错误。受管工具的策略保存行为见上方“设置文件”。

## 验证

```powershell
npm run verify
npm run test:host
npm run test:scale
# 可选：已有本地 file-tools.json 时，只读加载当前设置
npm run test:user-settings
powershell -NoProfile -File ./scripts/native-audit.ps1
npm run test:windows
npm run test:links:windows
```

Linux 机器另运行 npm run test:linux。平台专用测试在错误平台会跳过，跳过不构成通过证据。单元测试中的临时 Freedesktop 后端属于逻辑验证，不能替代 Linux 原生结果。

Windows 测试只永久清理新建测试根中的条目，验证原有系统回收站 ID 和数量保持不变。不会测试清空用户整个系统回收站。验证范围见 [VERIFICATION.md](VERIFICATION.md)。原始运行日志保存在本机的 `verification/`，不随公开仓库分发。
