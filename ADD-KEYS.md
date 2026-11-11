# 如何添加 Key

网关地址：`https://claude-multi-key-gateway.yunkangchen2017.workers.dev`
Cloudflare Worker 名字：`claude-multi-key-gateway`
项目文件夹（第一台电脑）：`C:\Users\YunkangChen\Desktop\api\claude-cloudflare-gateway\claude-cloudflare-gateway`；换电脑见 [HANDOVER.md](HANDOVER.md)

## 先分清要加哪种 key

| 要加的 | 用途 | 条件 |
|---|---|---|
| **Gateway key** | 给某台设备、某个 app 或某个朋友调用网关用 | 随时可加，不改代码，几秒生效 → 看第一部分 |
| **Anthropic 账号 key** | 网关背后真正花额度的 Max 账号 | 6 个位置已满；可以替换，第 7 个要改代码 → 看第二部分 |

---

## 第一部分：添加 gateway key

### 规则

- **谁能加：**只有能登录你的 Cloudflare 账号的人。网关本身没有"加 key"的功能，这是故意的：能加 key 就能花你的额度。
- **名字：**必须是 `GATEWAY_KEY_<名字>`，例如 `GATEWAY_KEY_TABLET`、`GATEWAY_KEY_FRIEND_A`。
  - 名字只能用英文字母、数字和下划线，建议全大写。
  - 不能用 `MAIN`：`main` 就是原来那个 `GATEWAY_KEY`。
  - 名字会以小写形式（例如 `tablet`）出现在仪表盘和用量记录里，每个 key 的花费分开统计。
- **类型：**必须选 **Secret（加密）**，不要选 Text / 普通变量。普通变量会明文显示，而且下次部署时会被清掉，key 就失效了。
- **值：**一串 32 个字符以上的随机字符，生成方法见下面。首尾的空格和换行会被自动忽略。
- **生效：**保存后几秒内就能用，不用重新部署，也不用改代码。
- **数量：**免费版每个 Worker 最多 64 个变量加 secret，现在用了约 21 个。
- **共用花费上限：**所有 gateway key 加起来，每 24 小时最多花 `DAILY_SPEND_CAP_USD`（现在是 $100）。超过以后网关会返回 429，等较早的花费移出 24 小时窗口后自动恢复。

### 生成一个随机的 key 值

任选一种：
- **密码管理器：**用它的"生成密码"功能，长度 32 以上，最省事，生成后直接存在里面。
- **Mac / Linux 终端：**
  ```bash
  openssl rand -hex 32
  ```
- **Windows PowerShell：**
  ```powershell
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')
  ```

### 方法 A：用网页添加（任何设备都行，包括手机）

1. 打开 https://dash.cloudflare.com 并登录。
2. 左边菜单进入 **Workers & Pages**，点 **claude-multi-key-gateway**。
3. 进入 **Settings → Variables and Secrets**（界面文字可能略有不同）。
4. 点 **Add**：
   - Type 选 **Secret**；
   - Variable name 填 `GATEWAY_KEY_TABLET`（换成你要的名字）；
   - Value 粘贴刚才生成的随机值。
5. 点 **Deploy / Save**。
6. **把这个值存进密码管理器。**Cloudflare 之后不会再显示 secret 的值。

### 方法 B：在另一台电脑上用命令行添加

前提：那台电脑装了 Node.js 20 或更新的版本（https://nodejs.org）。不需要项目文件夹。

```bash
npx wrangler login
npx wrangler secret put GATEWAY_KEY_TABLET --name claude-multi-key-gateway
```

第一条会打开浏览器，让你登录 Cloudflare 账号；第二条运行后，按提示粘贴 key 的值（输入时屏幕上不显示，这是正常的）。

如果那台电脑不是你自己的，用完一定要退出：
```bash
npx wrangler logout
```

### 方法 C：在这台电脑上添加（最省事）

```powershell
cd "C:\Users\YunkangChen\Desktop\api\claude-cloudflare-gateway\claude-cloudflare-gateway"
powershell -ExecutionPolicy Bypass -File .\new-gateway-key.ps1 -Name tablet
```

它会自动生成随机值、上传到 Cloudflare，把 key 显示在屏幕上，并保存到 `gateway-keys\tablet.txt`。

### 确认新 key 能用（不花额度）

`count_tokens` 只计算 token 数量，不收费，适合用来测试 key：

**Mac / Linux：**
```bash
curl https://claude-multi-key-gateway.yunkangchen2017.workers.dev/v1/messages/count_tokens \
  -H "x-api-key: 你的新key" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}'
```

**Windows PowerShell：**
```powershell
Invoke-RestMethod -Method Post -Uri "https://claude-multi-key-gateway.yunkangchen2017.workers.dev/v1/messages/count_tokens" `
  -Headers @{ "x-api-key" = "你的新key"; "anthropic-version" = "2023-06-01" } -ContentType "application/json" `
  -Body '{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}'
```

返回类似 `{"input_tokens": 8}` 就说明成功了；返回 `Invalid gateway key` 的话，看后面的"常见问题"。

在这台电脑上运行 `.\gateway-status.ps1`，可以看到现在所有 gateway key 的名字（只有名字，不显示值）。

### 在设备上使用新 key

用法和官方 Anthropic API 一样：把网关地址当作 base URL，把 gateway key 当作 API key。只支持 Anthropic 原生格式，**不支持 OpenAI 格式**（没有 `/v1/chat/completions`）。

**Python：**
```python
import anthropic

client = anthropic.Anthropic(
    api_key="你的新key",
    base_url="https://claude-multi-key-gateway.yunkangchen2017.workers.dev",
)
msg = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

**TypeScript / JavaScript：**
```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: '你的新key',
  baseURL: 'https://claude-multi-key-gateway.yunkangchen2017.workers.dev',
});
```

**注意：不要把 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 设成整台电脑的全局环境变量。**如果那台设备上用 Claude Code，它会读到这两个变量，改用网关而不是你的 Max 订阅登录。而 Max 送的 API 额度**不能用于 Claude Code**，结果会报 "credit balance too low"。所以 key 写在项目代码或项目自己的配置里就好。

### 停用、更换 key

- **停用：**
  - 网页：在 Variables and Secrets 里删除那个 secret；
  - 命令行：`npx wrangler secret delete GATEWAY_KEY_TABLET --name claude-multi-key-gateway`；
  - 这台电脑：`powershell -ExecutionPolicy Bypass -File .\new-gateway-key.ps1 -Name tablet -Remove`。

  停用后，用这个 key 的设备立刻收到 401，其他 key 不受影响。
- **更换（轮换）：**用同一个名字重新添加一个新值，旧值立刻失效。
- **更换 `main`：**`npx wrangler secret put GATEWAY_KEY`。这台电脑上的同步脚本用的是自己的 `local` key，所以换 `main` 不会影响自动同步。

### 常见问题

| 现象 | 原因和解决方法 |
|---|---|
| `Invalid gateway key`（401） | 名字不是以 `GATEWAY_KEY_` 开头；复制 key 时多了或少了字符；刚加完还没过几秒；这个 key 已经被删除或替换 |
| key 用了一段时间后突然失效 | 添加时类型选成了 Text（普通变量），部署时被清掉了。用 Secret 类型重新加一次 |
| `Gateway spending cap reached`（429） | 24 小时内的总花费到了上限，所有 key 共用。想多花一些，就在 `wrangler.jsonc` 里调高 `DAILY_SPEND_CAP_USD`，然后运行 `npx wrangler deploy` |
| `credit balance too low` | 所有账号的额度都用完了，等到续期日恢复；或者是在 Claude Code 里用了网关（不支持，见上面） |

---

## 第二部分：Anthropic 账号 key

### 准备（每个新账号都要做）

1. **关联额度：**在 claude.ai → Settings → Billing → API credits，把这个 Max 账号关联到一个 Claude Console 组织。新订阅要满 7 天才能领取额度。
2. **创建 key：**在 Console（platform.claude.com）里，**在这个组织下**创建一个 API key。
3. **关掉 Billing 里的 auto-reload（自动充值），不要绑定付款方式。**否则额度用完后会开始扣真钱，网关也不会切到别的号。
4. **记下续期日：**在 Console → Billing → Promotional credits 里记下额度的过期日期（UTC），这就是续期日。

### 替换某个位置的 key（1–6）

一般在 key 被吊销、换了账号或者 key 泄露时才需要。在这台电脑上：

```powershell
cd "C:\Users\YunkangChen\Desktop\api\claude-cloudflare-gateway\claude-cloudflare-gateway"
npx wrangler secret put ANTHROPIC_KEY_4
```

运行后粘贴新的 Anthropic key（以 `sk-ant-` 开头）。

如果新账号的续期日不一样，打开 `wrangler.jsonc`，把 `"CREDIT_EXPIRY_DAY_4"` 改成新的日子（只填几号，例如 `"15"`），保存后运行：

```powershell
npx wrangler deploy
```

**确认：**
- 运行 `.\gateway-status.ps1`，那一行的 `key_status` 应该是 `200`；
- 或者在仪表盘上点 "Check keys now"。

在别的设备上也可以只换 key：网页里把 `ANTHROPIC_KEY_4` 的值替换掉，或者运行 `npx wrangler secret put ANTHROPIC_KEY_4 --name claude-multi-key-gateway`。但**改续期日要在有这份代码的电脑上改 `wrangler.jsonc` 并部署**（先 `git pull`，部署后 `git push`）；在网页上直接改普通变量，下次部署时会被覆盖。

### 加第 7 个及以上的账号

现在代码只支持 6 个位置（`ANTHROPIC_KEY_1` 到 `ANTHROPIC_KEY_6`）。加第 7 个需要改一处代码，并重新部署。

---

## 安全须知

- **Cloudflare 账号要开两步验证（2FA）。**它是整个系统的总钥匙：能登录就能加 key、改代码、动所有 Worker 和数据库。
- **`npx wrangler login` 只在自己的设备上用。**它会在那台设备上留下能管理你整个 Cloudflare 账号的凭证；在别人的设备上用完要 `npx wrangler logout`。
- **gateway key 能花钱，`main` 和 `gateway-keys` 文件夹里的文件都不要发给别人。**想让朋友用，就单独给他加一个 key，不想给了随时删除。
- **仪表盘（网关地址的首页 `/`）现在是公开的。**任何知道地址的人都能看到用量、续期日、gateway key 和 app 的名字、缩短的组织 ID，但看不到任何 key 或对话内容。想改回需要链接才能看，见 README 里的 "Online dashboard"。
- **所有 key 的值都存进密码管理器。**Cloudflare 不会再显示 secret 的值，丢了只能换一个新的。
