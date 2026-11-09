**简体中文** | [English](README.en.md)

# vite-plugin-auto-cert

由你信任的 CA 签发一张临时证书，并启动启用了 HTTPS 的 Vite 开发服务器。

## 你可能需要这个插件的原因

1. 测试需要 HTTPS 连接的功能
2. 你想为多个项目启动 HTTPS 开发服务器，但又厌倦了一遍又一遍地信任证书
3. 你想在开发过程中与队友共享你的项目

## 插件行为

本插件会重写你 vite 配置中的 `server.https` 部分，并强制启动 HTTPS 服务器

1. 获取本机所有 IPv4 地址
2. 为这些地址和 `localhost` 签发证书
3. 用这些地址和 `localhost` 启动开发服务器

## 用法

### 项目配置文件

在**项目根目录**（传给 Vite 的 `root`，回退到 `process.cwd()`）中创建 `auto-cert.config.yaml`。
如果找不到 `auto-cert.config.yaml`，插件还会尝试 `auto-cert.config.yml`。

```yaml
enabled: true # optional, defaults to true; set false to disable the plugin (no-op)
ca:
  # inline PEM (both cert and key are required)
  cert: |
    -----BEGIN CERTIFICATE-----
    ...
    -----END CERTIFICATE-----
  key: |
    -----BEGIN PRIVATE KEY-----
    ...
    -----END PRIVATE KEY-----
  # or file paths, resolved relative to the directory of this config file:
  # certFile: ./certs/ca.crt
  # keyFile: ./certs/ca.key
```

查看 [`auto-cert.config.example.yaml`](./auto-cert.config.example.yaml) 获取一个安全、不含机密信息的示例。

然后把插件添加到你的 vite 配置中（`vite.config.ts` 中无需 CA 机密信息）：

```typescript
import autoCert from "vite-plugin-auto-cert";

export default defineConfig({
  plugins: [autoCert()],
});
```

你可以通过 `configFile` 选项覆盖配置文件的名称或路径（相对于 `root`）：

```typescript
autoCert({ configFile: "config/auto-cert.yaml" });
```

## 在 monorepo 中使用

插件在 Vite 的 `root`（未设置时回退到 `process.cwd()`）下查找 `auto-cert.config.yaml`。因此：

- 每个包各自在自己目录里启动 Vite（例如 `pnpm --filter <pkg> dev`，或 turbo/nx 在各包目录执行）时，会分别找到本包的配置，互不影响，正常工作。
- 若在仓库根用 `vite --config packages/web/vite.config.ts` 等方式启动，且该包的 Vite 配置未设置 `root`，插件会在仓库根目录查找配置而找不到，从而 no-op（以 HTTP 启动）。

让插件指向正确的包，可用以下任一方式：
1. 在各包目录内启动 Vite（最常见）；
2. 在该包的 Vite 配置里把 `root` 设为其自身目录；
3. 在该包的 Vite 配置里用 `autoCert({ configFile: "packages/web/auto-cert.config.yaml" })` 指定配置路径（相对 Vite root / cwd，或写绝对路径）。

## 行为细节

- **未找到配置文件 → no-op（不做任何操作）。** 插件在 `config` 钩子中返回 `undefined`，不会修改
  `server.https`；Vite 以其原始配置启动。仅打印一行
  `[auto-cert] ... 未找到 ...，插件未启用` 提示信息。
- **找到配置文件 → 由它生成证书并设置 `server.https`。**
- **CA 只来自项目配置文件：** 没有配置文件即 no-op；传入 `autoCert({ ca })` 会抛出错误（见上）。
- **配置文件中的 `enabled: false`** 会被视为 no-op（不报错）。
- **配置文件无效**（YAML 解析错误、缺少 `ca`、`cert`/`key` 不完整，或引用的
  cert/key 文件不存在）会抛出包含文件路径的错误，使 Vite 启动失败，而不是静默回退。

## 安全：让 CA 私钥远离 git

把配置文件和引用的证书目录加入 `.gitignore`，并限制 CA 私钥的权限：

```gitignore
# .gitignore
auto-cert.config.yaml
auto-cert.config.yml
certs/
```

```bash
chmod 600 certs/ca.key
```
